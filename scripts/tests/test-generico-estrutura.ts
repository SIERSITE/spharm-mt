/**
 * scripts/tests/test-generico-estrutura.ts
 *
 * O filtro «Genérico» NÃO mexe no que não devia: sem migrations, sem alterações ao agent (rev99), ao ingest/sincronização nem ao schema;
 * sem `genericoErp`; a regra é única (um só módulo) e todos os ecrãs a usam.
 *
 *   npx tsx scripts/tests/test-generico-estrutura.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE = "3b1fbdf86e2051b1568bb3c92d07cee7e8b0fa56";
let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const raiz = path.resolve(__dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(raiz, f), "utf8").replace(/\r\n/g, "\n");
const git = (...a: string[]) => spawnSync("git", a, { cwd: raiz, encoding: "utf8" });

const temBase = git("cat-file", "-e", `${BASE}^{commit}`).status === 0;
if (temBase) {
  const nomes = git("diff", "--name-only", BASE, "HEAD").stdout.split("\n").filter(Boolean);
  check(!nomes.some((n) => n.startsWith("agent/")), "nenhum ficheiro de agent/ alterado (a rev99 fica intacta)", nomes.filter((n) => n.startsWith("agent/")).join(","));
  check(!nomes.some((n) => n.startsWith("prisma/")), "nenhuma migration nem alteração ao schema Prisma");
  check(!nomes.some((n) => n.startsWith("generated/")), "o cliente Prisma gerado não mudou");
  const proibidos = ["app/api/ingest/", "lib/ingest/", "lib/classificacao/", "lib/jobs/"];
  check(!nomes.some((n) => proibidos.some((p) => n.startsWith(p))), "ingest/sincronização e classificação Ético/NETT não foram tocados", nomes.filter((n) => proibidos.some((p) => n.startsWith(p))).join(","));
  const calculos = ["lib/margens/", "lib/operational/", "lib/vendas/", "lib/reporting/calculos"];
  check(!nomes.some((n) => calculos.some((p) => n.startsWith(p))), "nenhum módulo de cálculo alterado");
} else {
  console.log("  [AVISO] SHA base não disponível neste clone: verificações de diff saltadas");
}

const schema = src("prisma/schema.prisma");
check(/flagGenerico\s+Boolean\s+@default\(false\)/.test(schema), "flagGenerico continua Boolean @default(false) (NOT NULL)");
check(!/genericoErp/i.test(schema) && !fs.readdirSync(path.join(raiz, "prisma/migrations")).some((d) => /generico/i.test(d)), "sem genericoErp e sem migration de genérico");

// uma regra, usada em todo o lado
const consumidores: Array<[string, RegExp]> = [
  ["lib/reporting/catalog-prefilter.ts", /idsProdutosPorGenerico/],
  ["lib/catalogo-data.ts", /wherePrismaPorGenerico/],
  ["lib/transferencias-data.ts", /sqlFiltroGenerico/],
  ["lib/encomendas/proposal.ts", /flagGenerico/],
  ["lib/encomendas/orders-data.ts", /flagGenerico/],
  ["lib/reporting/adapters/vendas.ts", /filtroGenericoLinha/],
  ["lib/reporting/adapters/margens.ts", /filtroGenericoLinha/],
  ["lib/reporting/adapters/inventario.ts", /filtroGenericoLinha/],
];
for (const [f, re] of consumidores) check(re.test(src(f)), `${f} usa a regra comum`);
for (const f of ["lib/reporting/adapters/excessos.ts", "lib/reporting/adapters/transferencias.ts"]) {
  check(/Genérico/.test(src(f)) || /filtroGenericoLinha/.test(src(f)), `${f} acrescenta a linha «Genérico»`);
}
// o filtro não é feito no cliente para os mapas paginados/limitados
for (const f of ["components/vendas/vendas-client.tsx", "components/stock/stock-client.tsx", "components/catalogo/catalogo-list-client.tsx", "components/margens/margens-client.tsx", "components/inventario/inventario-client.tsx"]) {
  check(!/passaFiltroGenerico/.test(src(f)), `${f} NÃO filtra o genérico no cliente (servidor)`);
}
check(/lerValorGenerico/.test(src("lib/catalog/generico-filtro.ts")) && !/from "@\/generated/.test(src("lib/catalog/generico-filtro.ts")), "o módulo da regra é puro (sem Prisma)");

console.log(`\n${ok} OK, ${ko} FALHA(S)`);
process.exit(ko === 0 ? 0 : 1);
