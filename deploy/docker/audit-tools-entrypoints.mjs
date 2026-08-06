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

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
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

console.log(
  `[audit-tools] ${checked} entrypoints e ${visited.size} módulos verificados, todos presentes`
);
