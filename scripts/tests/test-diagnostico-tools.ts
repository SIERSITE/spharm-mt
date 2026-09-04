/**
 * scripts/tests/test-diagnostico-tools.ts
 *
 * Os scripts de `scripts/diagnostics/` correm na imagem `migrate`, que é
 * Node puro. Um `import "server-only"` em qualquer ponto do grafo de
 * imports mata-os antes da primeira linha:
 *
 *     Error: Cannot find module 'server-only'
 *
 * `server-only` é um módulo que só existe dentro do build do Next; não
 * está no `package.json` nem em `node_modules`. `lib/control-plane.ts`
 * documenta a mesma convenção no seu cabeçalho — é a regra da casa para
 * tudo o que é consumido por scripts.
 *
 * Duas verificações, e a segunda existe porque a primeira sozinha seria
 * uma opinião sobre o código em vez de um facto sobre a execução:
 *
 *   A · percorre o grafo de imports de cada diagnóstico e falha se
 *       algum módulo — a qualquer profundidade — trouxer `server-only`;
 *   B · corre mesmo `npx tsx <diagnóstico>` — TODOS eles — e confirma
 *       que o processo passa da fase de carregamento de módulos.
 *
 * Corre com:  npm run test:diagnostico-tools
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`,
  );

const RAIZ = process.cwd();

/** Módulos do Next que não existem fora do build dele. */
const PROIBIDOS = ["server-only", "client-only", "next/headers", "next/navigation"];

/**
 * Resolve um especificador para um ficheiro do repositório.
 *
 * Devolve `null` para pacotes de node_modules — esses ou existem no
 * `package.json` (e então estão na imagem) ou rebentariam em qualquer
 * lado, não só nos diagnósticos.
 */
function resolverFicheiro(spec: string, deQuem: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(RAIZ, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(deQuem), spec);
  else return null;

  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(cand) && !cand.endsWith("/")) {
      try {
        if (readFileSync(cand, "utf8") !== undefined) return cand;
      } catch {
        /* directório */
      }
    }
  }
  return null;
}

/**
 * Todos os `import ... from "x"` e `import "x"` de um ficheiro.
 *
 * A classe do meio e' `[^"';]` e nao `[\s\S]` de proposito. Com
 * `[\s\S]*?`, um `import "server-only";` era engolido: o grupo lazy
 * atravessava a linha inteira ate' encontrar o ` from ` do import
 * SEGUINTE, e o efeito era o detector nao ver justamente aquilo que
 * existe para detectar. Proibir aspas e `;` no meio impede-o de sair da
 * declaracao onde comecou.
 */
function importesDe(ficheiro: string): string[] {
  const fonte = readFileSync(ficheiro, "utf8");
  const specs: string[] = [];
  const re = /^\s*import\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fonte)) !== null) specs.push(m[1]);
  return specs;
}

/**
 * Percorre o grafo e devolve os caminhos que chegam a um módulo proibido.
 * Cada caminho é a cadeia completa, para o erro dizer POR ONDE entrou.
 */
function caminhosProibidos(entrada: string): string[][] {
  const problemas: string[][] = [];
  const visitados = new Set<string>();

  const andar = (ficheiro: string, cadeia: string[]) => {
    if (visitados.has(ficheiro)) return;
    visitados.add(ficheiro);

    for (const spec of importesDe(ficheiro)) {
      if (PROIBIDOS.includes(spec)) {
        problemas.push([...cadeia, ficheiro, spec]);
        continue;
      }
      const alvo = resolverFicheiro(spec, ficheiro);
      if (alvo) andar(alvo, [...cadeia, ficheiro]);
    }
  };

  andar(entrada, []);
  return problemas;
}

// ══════════════════════════════════════════════════════════════════════
// A · O grafo de imports
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · grafo de imports dos diagnósticos");

const DIR = "scripts/diagnostics";
const diagnosticos = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(DIR, f));

check(diagnosticos.length > 0, `há diagnósticos para verificar (${diagnosticos.length})`);

for (const d of diagnosticos) {
  const problemas = caminhosProibidos(d);
  check(
    problemas.length === 0,
    `${d}: nenhum módulo do Next no grafo`,
    problemas
      .map((c) => c.map((p) => p.replace(`${RAIZ}\\`, "").replace(`${RAIZ}/`, "")).join("\n              → "))
      .join("\n            "),
  );
}

// O detector tem de detectar. Sem isto, a secção A passaria na mesma se
// `caminhosProibidos` tivesse um bug e nunca encontrasse nada.
{
  const problemas = caminhosProibidos("lib/operational/ipf-reader.ts");
  check(
    problemas.length > 0,
    "o detector encontra `server-only` num módulo que o tem (não é vacuoso)",
  );
  check(
    problemas.some((c) => c[c.length - 1] === "server-only"),
    "…e diz qual é o módulo proibido",
  );
}

// A regra da casa, escrita onde se pode ler.
{
  const controlPlane = readFileSync("lib/control-plane.ts", "utf8");
  check(
    controlPlane.includes('Sem `import "server-only"`'),
    "lib/control-plane.ts documenta a convenção para scripts",
  );
}

// ══════════════════════════════════════════════════════════════════════
// B · Execução real com tsx, sem Next
//
// O diagnóstico imprime uma linha de identificação ANTES de tocar na
// base de dados. Se essa linha aparecer, o grafo de imports carregou
// inteiro — que é exactamente o que falhava em produção.
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · execução com tsx (sem Next)");

// Cada diagnostico imprime uma linha de identificacao ANTES de tocar na
// base de dados, e recusa-se a correr sem `--tenant`. Se essa linha sair
// e o codigo de saida for 2, o grafo de imports carregou inteiro — que e'
// exactamente o que falhava em producao.
//
// Corre-se TODOS e nao um: um diagnostico novo com um import proibido
// so' era apanhado pela analise estatica, e a analise estatica nao ve'
// um `require` dinamico nem um pacote que falta no package.json.
for (const alvo of diagnosticos) {
  let stdout = "";
  let stderr = "";
  let status = 0;
  try {
    stdout = execFileSync("npx", ["tsx", alvo], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      // Destino inexistente de proposito: nenhum diagnostico deve
      // chegar a abrir ligacao sem `--tenant`.
      env: { ...process.env, DATABASE_URL: "postgresql://x:x@127.0.0.1:1/x" },
      shell: process.platform === "win32",
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    status = err.status ?? -1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }

  const saida = `${stdout}\n${stderr}`;
  const nome = alvo.replace(/\\/g, "/");

  check(
    !/Cannot find module/.test(saida),
    `${nome}: nenhum módulo em falta`,
    saida.slice(0, 400),
  );
  check(
    /SPharm\.MT/.test(saida),
    `${nome}: chegou a correr — a linha de arranque saiu`,
    saida.slice(0, 400),
  );
  eq(status, 2, `${nome}: saiu com 2 — falta \`--tenant\`, não um erro de carregamento`);
  check(/--tenant/.test(saida), `${nome}: diz que o destino tem de ser identificado`);
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
