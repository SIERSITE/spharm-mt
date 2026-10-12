/**
 * scripts/tests/test-vendas-impressao-hierarquia.ts
 *
 * Hierarquia visual do Relatório de Vendas impresso/PDF (2026-10).
 *
 * Defeito: linhas de farmácia, blocos de artigo, "TOTAL ARTIGO" e o início do
 * artigo seguinte distinguiam-se só por azuis/cinzentos muito próximos — em
 * papel/preto e branco a separação desaparecia.
 *
 * Provas aqui (estruturais; a prova visual está em
 * docs/validacao-visual/2026-10-vendas-impressao/):
 *   A  "Imprimir" e "PDF" partilham o MESMO HTML/CSS (renderReportHtml);
 *   B  a hierarquia forte é opt-in (meta.hierarchy) — Vendas pede-a, os
 *      restantes relatórios ficam byte-a-byte iguais;
 *   C  o CSS não depende só da cor: bordas, peso tipográfico e espaçamento;
 *   D  não altera dados, ordem, nº de linhas nem agrupamento;
 *   E  o Excel não é tocado.
 *
 * Corre com:  npx tsx scripts/tests/test-vendas-impressao-hierarquia.ts
 */
import { readFileSync } from "node:fs";
import { buildVendasReport } from "../../lib/reporting/adapters/vendas";
import { renderReportHtml } from "../../lib/reporting/report-html";
import type { SalesReportRow } from "../../lib/vendas-data";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`);
  }
};
const src = (p: string) => readFileSync(p, "utf8");

function linha(codigo: string, farmacia: string, total: number): SalesReportRow {
  return {
    produtoId: `p-${codigo}`,
    codigo,
    descricao: `ARTIGO ${codigo}`,
    farmaciaId: farmacia,
    farmacia,
    pvp: 5,
    custoUnitarioEstimado: 2,
    custoEstimado: 2,
    fabricante: "F",
    fornecedor: "D",
    meses: [{ ano: 2026, mes: 9, quantidade: total }],
    totalVendas: total,
    valorBruto: total * 5,
    quantidadeManutencao: 0,
    valorBrutoManutencao: 0,
    existencia: 3,
    semVendasNoPeriodo: total === 0,
  } as SalesReportRow;
}

const rows = [
  linha("1", "Farmácia A", 4), linha("1", "Farmácia B", 0),
  linha("2", "Farmácia A", 7), linha("2", "Farmácia B", 1),
  linha("3", "Farmácia A", 2),
];
const report = buildVendasReport({
  rows,
  buckets: [{ ano: 2026, mes: 9 }],
  filters: { agruparPor: "artigo" },
  universe: { farmacias: ["Farmácia A", "Farmácia B"], fornecedores: [], fabricantes: [], categorias: [] },
  organization: "Grupo",
});
const html = renderReportHtml(report);

console.log("\n=== A. Imprimir e PDF partilham o mesmo HTML/CSS ===");
{
  ok("report-print.ts usa renderReportHtml", /renderReportHtml\(report\)/.test(src("lib/reporting/report-print.ts")));
  ok("report-pdf-server.ts usa renderReportHtml", /renderReportHtml\(report\)/.test(src("lib/reporting/report-pdf-server.ts")));
  ok("nenhum dos dois define CSS próprio de tabela", !/subtotal-row/.test(src("lib/reporting/report-print.ts")) && !/subtotal-row/.test(src("lib/reporting/report-pdf-server.ts")));
}

console.log("\n=== B. Opt-in: só Vendas pede a hierarquia forte ===");
{
  ok("o relatório de Vendas declara meta.hierarchy = strong", report.meta?.hierarchy === "strong");
  ok("a página de Vendas leva a classe hierarchy-strong", /class="page density-compact hierarchy-strong"/.test(html));
  const semOptIn = renderReportHtml({ ...report, meta: { ...report.meta!, hierarchy: undefined } });
  ok("sem meta.hierarchy a classe não aparece", /class="page density-compact"/.test(semOptIn) && !/class="page density-compact hierarchy-strong"/.test(semOptIn));
  const outros = ["devolucoes", "encomendas", "excessos", "inventario", "margens"].map((n) => `lib/reporting/adapters/${n}.ts`);
  ok("nenhum outro adapter pede a hierarquia forte", outros.every((f) => !/hierarchy:/.test(src(f))));
}

console.log("\n=== C. Não depende só da cor ===");
{
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const bloco = css.slice(css.indexOf("HIERARQUIA FORTE"));
  ok("cabeçalho da tabela: fundo escuro + texto branco + bold", /hierarchy-strong thead th \{[^}]*background: #1f2937[^}]*color: #ffffff[^}]*font-weight: 700/s.test(bloco));
  ok("início de cada artigo: borda superior de 2px", /tbody\.row-group > tr:first-child > td \{\s*border-top: 2px solid/.test(bloco));
  ok("blocos alternados com tons distintos (branco ↔ #e5e7eb)", /tbody\.row-group td \{ background: #ffffff/.test(bloco) && /row-group-alt td \{ background: #e5e7eb/.test(bloco));
  const sub = bloco.slice(bloco.indexOf("tr.subtotal-row td {"));
  ok("TOTAL ARTIGO: bold, fundo mais escuro, bordas superior E inferior de 2px", /font-weight: 700/.test(sub) && /background: #b9c4d0/.test(sub) && /border-top: 2px solid/.test(sub) && /border-bottom: 2px solid/.test(sub));
  ok("linhas da farmácia subordinadas: separador ponteado, texto mais suave", /border-bottom: 1px dotted/.test(bloco) && /color: #374151/.test(bloco));
  ok("nenhum fundo mais escuro que o cabeçalho e o total geral (tinta contida)", !/background: #(0|1)[0-9a-f]{5}/i.test(bloco.replace(/#1f2937/g, "")));
  ok("TOTAL ARTIGO nunca fica separado do seu artigo (impressão)", /tr\.subtotal-row \{ break-before: avoid/.test(css));
  ok("o artigo inteiro não parte entre páginas (row-group)", /tbody\.row-group \{\s*break-inside: avoid/.test(css));
  ok("o cabeçalho repete nas páginas seguintes", /thead \{ display: table-header-group; \}/.test(css));
  ok("valores zero/stock/alertas mantêm tons próprios por cima do bloco", /td\.cell-tone-danger/.test(bloco) && /td\.cell-tone-success/.test(bloco));
}

console.log("\n=== D. Dados, ordem e agrupamento inalterados ===");
{
  const semHier = buildVendasReport({
    rows,
    buckets: [{ ano: 2026, mes: 9 }],
    filters: { agruparPor: "artigo" },
    universe: { farmacias: ["Farmácia A", "Farmácia B"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo",
  });
  ok("mesmas linhas", JSON.stringify(report.rows) === JSON.stringify(semHier.rows));
  ok("5 linhas de detalhe + 2 TOTAL ARTIGO (o artigo 3 só tem 1 farmácia)", report.rows.length === 7);
  ok("3 grupos <tbody class=row-group>", (html.match(/<tbody class="row-group/g) ?? []).length === 3);
  ok("2 linhas subtotal-row no HTML", (html.match(/<tr class="subtotal-row">/g) ?? []).length === 2);
}

console.log("\n=== E. Excel não é alterado ===");
{
  ok("report-excel não lê meta.hierarchy", !/hierarchy/.test(src("lib/reporting/report-excel.ts")));
  ok("report-excel-buffer não lê meta.hierarchy", !/hierarchy/.test(src("lib/reporting/report-excel-buffer.ts")));
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
