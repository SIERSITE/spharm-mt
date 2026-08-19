// deploy/docker/audit-tools-entrypoints.mjs
//
// Corre DENTRO do build da imagem `migrator`, depois dos COPY. Para cada
// comando listado em tools-scripts.txt, resolve o ficheiro de entrada no
// package.json e confirma que ele existe na imagem.
//
// Falhar aqui custa um build. Não falhar aqui custa descobrir na VPS, no
// momento de criar o primeiro cliente, que o comando oficial aponta para
// um ficheiro que a imagem não tem:
//
//   ERR_MODULE_NOT_FOUND: /app/scripts/admin/create-client.ts
//
// Node puro, sem dependências: corre num estágio onde só há o que o
// `npm ci` instalou, e não depende de nada que possa faltar.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const manifestPath = resolve(here, "tools-scripts.txt");

function fail(msg) {
  console.error(`\n[audit-tools] ${msg}\n`);
  process.exit(1);
}

if (!existsSync(manifestPath)) fail(`manifesto não encontrado: ${manifestPath}`);

const pkgPath = resolve(root, "package.json");
if (!existsSync(pkgPath)) fail(`package.json não encontrado em ${root}`);
const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};

const wanted = readFileSync(manifestPath, "utf8")
  .split("\n")
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean);

if (wanted.length === 0) fail("manifesto vazio — a auditoria não verificaria nada");

// Extrai o ficheiro de entrada de um comando npm. `tsx x/y.ts`,
// `node a/b.mjs`, `tsx pasta/cli.ts sub-comando` — todos dão o mesmo.
// Comandos sem ficheiro (o CLI do Prisma, PowerShell) devolvem null e
// são contados como presentes: o que se audita é o que a imagem tem de
// conter em FICHEIROS.
function entrypointOf(cmd) {
  const token = cmd
    .split(/\s+/)
    .find((t) => /\.(ts|tsx|mjs|cjs|js)$/.test(t) && !t.startsWith("-"));
  return token ?? null;
}

// ── Fecho transitivo dos imports ─────────────────────────────────────
//
// Verificar só o entrypoint não chega. `create-client.ts` importa
// `../tenancy/_shared` e `@/lib/admin/create-client-workflow`; se um
// desses faltar, o comando morre com o MESMO ERR_MODULE_NOT_FOUND, e um
// teste que olhasse apenas para o ficheiro de entrada teria dado verde.
//
// Resolve imports relativos e o alias `@/` (raiz do projecto, ver
// tsconfig.json). Especificadores de pacote (`pg`, `node:util`) são
// ignorados: vêm do npm ci e não deste COPY.
const IMPORT_RE =
  /(?:^|\s)(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const EXTS = [".ts", ".tsx", ".mts", ".mjs", ".cjs", ".js"];

function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = resolve(root, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // pacote npm ou builtin

  // O TypeScript permite escrever `./x.js` para `./x.ts`; aceita-se.
  const candidates = [base, ...EXTS.map((e) => base + e)];
  const stripped = base.replace(/\.(js|mjs|cjs)$/, "");
  if (stripped !== base) candidates.push(...EXTS.map((e) => stripped + e));
  candidates.push(...EXTS.map((e) => resolve(base, "index" + e)));

  for (const c of candidates) {
    if (existsSync(c) && !c.endsWith("/")) {
      try {
        if (readFileSync(c) !== null) return c;
      } catch {
        /* directório: continua */
      }
    }
  }
  return null;
}

const missingScript = [];
const missingFile = [];
const missingImport = [];
const visited = new Set();
let checked = 0;

function walk(file, chain) {
  if (visited.has(file)) return;
  visited.add(file);
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return;
  }
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1] ?? m[2];
    if (!spec || (!spec.startsWith(".") && !spec.startsWith("@/"))) continue;
    const target = resolveSpecifier(spec, file);
    if (target === null) {
      missingImport.push(`${chain} → ${spec}  (importado por ${rel(file)})`);
    } else {
      walk(target, chain);
    }
  }
}

function rel(p) {
  return p.startsWith(root) ? p.slice(root.length + 1).replace(/\\/g, "/") : p;
}

for (const name of wanted) {
  const cmd = scripts[name];
  if (!cmd) {
    // O comando saiu do package.json mas ficou no manifesto. É um erro:
    // a lista deixaria de descrever o que a imagem serve.
    missingScript.push(name);
    continue;
  }
  const entry = entrypointOf(cmd);
  if (entry === null) continue;
  checked += 1;
  const abs = resolve(root, entry);
  if (!existsSync(abs)) {
    missingFile.push(`${name} → ${entry}`);
    continue;
  }
  walk(abs, name);
}

if (missingImport.length > 0) {
  console.error("\n[audit-tools] imports que não resolvem dentro da imagem:");
  for (const m of missingImport) console.error(`  · ${m}`);
}

if (missingScript.length > 0) {
  console.error("\n[audit-tools] comandos no manifesto que já não existem no package.json:");
  for (const n of missingScript) console.error(`  · ${n}`);
}

if (missingFile.length > 0) {
  console.error("\n[audit-tools] entrypoints EM FALTA na imagem:");
  for (const m of missingFile) console.error(`  · ${m}`);
  console.error(
    "\nAcrescentar o COPY correspondente ao estágio `migrator` do Dockerfile,\n" +
      "ou retirar o comando de deploy/docker/tools-scripts.txt se não for operacional."
  );
}

if (missingScript.length > 0 || missingFile.length > 0 || missingImport.length > 0) {
  process.exit(1);
}

// `--list` imprime o fecho transitivo. É como se descobre que COPY
// acrescentar ao Dockerfile sem adivinhar — e como se confirma que a
// imagem não está a levar ficheiros a mais.
if (process.argv.includes("--list")) {
  for (const f of [...visited].map(rel).sort()) console.log(f);
}

// ── Modo `--dockerfile`: a mesma auditoria, SEM Docker ───────────────
//
// O `RUN` no fim do estágio `migrator` só corre quando alguém constrói a
// imagem. Se o daemon estiver em baixo, ou se ninguém construir antes de
// fazer deploy, o erro reaparece na VPS — que é exactamente como o
// `classify-tipodoc` chegou lá.
//
// Este modo lê os `COPY` do estágio `migrator`, calcula que caminhos vão
// existir na imagem, e confirma que cada ficheiro do fecho transitivo
// está coberto por um deles. Não substitui o build: prova a COBERTURA
// dos COPY, que é a parte que falha em silêncio.
const dfIdx = process.argv.indexOf("--dockerfile");
if (dfIdx !== -1) {
  const dfPath = process.argv[dfIdx + 1];
  if (!dfPath) fail("--dockerfile precisa do caminho do Dockerfile");
  if (!existsSync(dfPath)) fail(`Dockerfile não encontrado: ${dfPath}`);
  // `indexOf` devolve -1 quando a flag não está, e `argv[-1 + 1]` é o
  // caminho do node — que passaria por nome de estágio e daria
  // "nenhum COPY encontrado" em vez do default.
  const iEstagio = process.argv.indexOf("--estagio");
  const estagio = iEstagio === -1 ? "migrator" : (process.argv[iEstagio + 1] ?? "migrator");

  // Junta continuações de linha antes de interpretar seja o que for.
  const linhas = readFileSync(dfPath, "utf8")
    .replace(/\\\r?\n\s*/g, " ")
    .split("\n");

  let dentro = false;
  const copies = [];
  for (const raw of linhas) {
    const l = raw.trim();
    if (/^FROM\s+/i.test(l)) {
      dentro = new RegExp(`\\bAS\\s+${estagio}\\s*$`, "i").test(l);
      continue;
    }
    if (!dentro || !/^COPY\s+/i.test(l)) continue;
    const toks = l.slice(4).trim().split(/\s+/);
    const flags = toks.filter((t) => t.startsWith("--"));
    const args = toks.filter((t) => !t.startsWith("--"));
    if (args.length < 2) continue;
    copies.push({
      // `--from=<estágio>` traz ficheiros de outro estágio: existem na
      // imagem na mesma, e é isso que interessa para a cobertura.
      deOutroEstagio: flags.some((f) => f.startsWith("--from=")),
      fontes: args.slice(0, -1),
      destino: args[args.length - 1],
    });
  }
  if (copies.length === 0) fail(`nenhum COPY encontrado no estágio "${estagio}"`);

  const norm = (p) => p.replace(/^\.\//, "").replace(/\/+$/, "").replace(/\\/g, "/");
  const ficheiros = new Set();
  const directorios = new Set();

  for (const c of copies) {
    const destino = norm(c.destino);
    const destinoEDir =
      c.destino.endsWith("/") || c.fontes.length > 1 || destino === "" || destino === ".";
    for (const fonte of c.fontes) {
      const nome = basename(norm(fonte));
      const alvo = destinoEDir ? (destino ? `${destino}/${nome}` : nome) : destino;
      // Vindo de outro estágio não há como saber pelo contexto se é
      // ficheiro ou pasta; trata-se como pasta, que é o caso real
      // (`/app/generated`) e o mais permissivo.
      if (c.deOutroEstagio) {
        directorios.add(alvo);
        continue;
      }
      const abs = resolve(root, norm(fonte));
      let eDir = false;
      try {
        eDir = statSync(abs).isDirectory();
      } catch {
        // Fonte que não existe é problema do test-dockerfile-copy.sh,
        // que verifica isso contra HEAD. Aqui não se inventa cobertura.
        continue;
      }
      if (eDir) directorios.add(alvo);
      else ficheiros.add(alvo);
    }
  }

  const coberto = (p) =>
    ficheiros.has(p) || [...directorios].some((d) => p === d || p.startsWith(`${d}/`));

  const descobertos = [...visited]
    .map((f) => relative(root, f).replace(/\\/g, "/"))
    .filter((p) => !p.startsWith(".."))
    .filter((p) => !coberto(p))
    .sort();

  if (descobertos.length > 0) {
    console.error(`\n[audit-tools] ficheiros que o estágio "${estagio}" NÃO copia:`);
    for (const p of descobertos) console.error(`  · ${p}`);
    console.error(
      `\nAcrescentar ao estágio \`${estagio}\` do Dockerfile, por exemplo:\n` +
        descobertos.map((p) => `  COPY ${p} ./${p}`).join("\n") +
        "\n\nOu retirar o comando de deploy/docker/tools-scripts.txt se não for\n" +
        "operacional. Este teste corre sem Docker de propósito: o RUN de\n" +
        "auditoria dentro do build só protege quem constrói a imagem."
    );
    process.exit(1);
  }
  console.log(
    `[audit-tools] estágio "${estagio}": ${copies.length} COPY cobrem os ` +
      `${visited.size} módulos operacionais`
  );
}

console.log(
  `[audit-tools] ${checked} entrypoints e ${visited.size} módulos verificados, todos presentes`
);
