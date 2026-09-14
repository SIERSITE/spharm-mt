/**
 * scripts/tests/test-fronteira-cliente-servidor.ts
 *
 * Nenhum componente `"use client"` pode alcançar `server-only` por um
 * import de VALOR.
 *
 * ── O erro que isto existe para apanhar ──────────────────────────────
 *
 * Aconteceu, e vale a pena registar como: um client component passou a
 * importar uma CONSTANTE de `lib/encomendas/proposal.ts` — um número,
 * o tecto de linhas da proposta — para escrever a mensagem de
 * truncagem. `proposal.ts` tem `import "server-only"` e importa
 * `@/lib/prisma`.
 *
 * O `tsc --noEmit` passou. O `eslint` passou. Os testes passaram. Só o
 * `next build`, três minutos depois, é que disse:
 *
 *     Module not found: Can't resolve 'dns'
 *     Import trace: Client Component Browser:
 *       ./node_modules/pg/lib/connection-parameters.js
 *
 * O bundler tinha arrastado o driver do Postgres para o bundle do
 * browser, e o erro que se lê não menciona o ficheiro que o causou.
 *
 * ── Porque este teste é de INSPECÇÃO e não de comportamento ──────────
 *
 * Porque o comportamento em causa é o de um bundler, e não há forma
 * barata de o exercitar sem o correr. O que este teste faz é o que o
 * `next build` faria: percorre o grafo de imports. A diferença é que
 * demora milissegundos e diz o nome do ficheiro.
 *
 * ── `import type` não conta, e é esse o ponto ────────────────────────
 *
 * `import type { X } from "@/lib/...server-only"` é APAGADO na
 * compilação: não gera import nenhum em runtime e é perfeitamente
 * seguro. Metade dos clientes desta aplicação depende disso para ter
 * os tipos dos loaders. Um detector que os sinalizasse seria ruído e
 * seria desligado na primeira semana.
 *
 * Corre com:  npm run test:fronteira
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n${detalhe}` : ""}`);
  }
};

const RAIZ = process.cwd();

/** Módulos que só existem dentro do build do servidor do Next. */
const PROIBIDOS_NO_CLIENTE = ["server-only", "next/headers"];

/** Pastas com código da aplicação. `node_modules` nunca. */
const PASTAS = ["app", "components", "lib", "middleware.ts"];

function ficheirosDe(caminho: string): string[] {
  const abs = join(RAIZ, caminho);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return /\.tsx?$/.test(abs) ? [abs] : [];

  const out: string[] = [];
  for (const nome of readdirSync(abs)) {
    if (nome === "node_modules" || nome.startsWith(".")) continue;
    out.push(...ficheirosDe(join(caminho, nome)));
  }
  return out;
}

function resolverFicheiro(spec: string, deQuem: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(RAIZ, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(deQuem), spec);
  else return null; // pacote de node_modules

  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* continua */
    }
  }
  return null;
}

/**
 * Os imports de VALOR de um ficheiro.
 *
 * Exclui `import type ... from`, que o compilador apaga. Inclui
 * `import "x"` (efeito lateral) porque esse é precisamente o `server-only`.
 */
function importesDeValor(ficheiro: string): string[] {
  const fonte = readFileSync(ficheiro, "utf8");
  const specs: string[] = [];
  // `[^"';]*?` e não `[\s\S]*?`: sem isso o `.*?` atravessava a linha
  // até ao ` from ` do import SEGUINTE e o detector saltava declarações.
  const re = /^\s*import\s+(type\s+)?(?:([^"';]*?)\sfrom\s+)?["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fonte)) !== null) {
    const ehTypeOnly = Boolean(m[1]);
    if (ehTypeOnly) continue;
    specs.push(m[3]);
  }
  return specs;
}

const ehCliente = (f: string): boolean =>
  /^\s*["']use client["']/m.test(readFileSync(f, "utf8"));

/**
 * Um ficheiro `"use server"` é uma FRONTEIRA, não uma dependência.
 *
 * Quando um client component importa uma Server Action, o bundler NÃO
 * empacota a action: substitui-a por um stub que faz um POST. O corpo
 * fica no servidor, com o `server-only`, o Prisma e tudo o resto — que
 * é o objectivo do mecanismo.
 *
 * Sem esta regra o detector acusava os três clientes que importam
 * `app/*\/actions.ts`, que é o padrão correcto e recomendado. Um
 * detector que sinaliza o uso correcto é desligado na primeira semana,
 * e deixa de apanhar o erro para que foi escrito.
 */
const ehServerAction = (f: string): boolean =>
  /^\s*["']use server["']/m.test(readFileSync(f, "utf8"));

/** A cadeia até ao módulo proibido, ou `null`. */
function cadeiaAteProibido(entrada: string): string[] | null {
  const visitados = new Set<string>();
  let resultado: string[] | null = null;

  const andar = (ficheiro: string, cadeia: string[]) => {
    if (resultado || visitados.has(ficheiro)) return;
    visitados.add(ficheiro);

    for (const spec of importesDeValor(ficheiro)) {
      if (PROIBIDOS_NO_CLIENTE.includes(spec)) {
        resultado = [...cadeia, relative(RAIZ, ficheiro), spec];
        return;
      }
      const alvo = resolverFicheiro(spec, ficheiro);
      // Pára na fronteira RPC: o corpo da action não vai para o browser.
      if (alvo && !ehServerAction(alvo)) {
        andar(alvo, [...cadeia, relative(RAIZ, ficheiro)]);
      }
    }
  };

  andar(entrada, []);
  return resultado;
}

console.log("\nFronteira cliente/servidor\n");

const todos = PASTAS.flatMap(ficheirosDe);
const clientes = todos.filter(ehCliente);

check(clientes.length > 10, `${clientes.length} componentes "use client" encontrados (o detector não é vácuo)`);

const maus: Array<{ ficheiro: string; cadeia: string[] }> = [];
for (const c of clientes) {
  const cadeia = cadeiaAteProibido(c);
  if (cadeia) maus.push({ ficheiro: relative(RAIZ, c), cadeia });
}

check(
  maus.length === 0,
  "nenhum client component alcança server-only por import de valor",
  maus
    .map(
      (m) =>
        `            ${m.ficheiro}\n              ${m.cadeia.join("\n                → ")}`,
    )
    .join("\n"),
);

// ── O detector funciona mesmo? ───────────────────────────────────────
//
// Um teste que só diz «não encontrei nada» é indistinguível de um teste
// partido. Este prova que encontra, com um ficheiro que sabemos ter
// `server-only`.
{
  const alvo = join(RAIZ, "lib/encomendas/proposal.ts");
  const cadeia = cadeiaAteProibido(alvo);
  check(cadeia !== null, "o detector ENCONTRA server-only em lib/encomendas/proposal.ts");
}
{
  // E prova que a regra da fronteira não o cegou: uma action continua a
  // ser detectada quando é ELA o ponto de partida.
  const action = join(RAIZ, "app/encomendas/nova/actions.ts");
  check(
    cadeiaAteProibido(action) !== null,
    "…e continua a ver server-only dentro da própria Server Action",
  );
}
{
  // E prova que ignora `import type` — senão sinalizaria metade da app.
  const puro = join(RAIZ, "lib/encomendas/limites.ts");
  check(cadeiaAteProibido(puro) === null, "…e não sinaliza um módulo puro");
}

console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
