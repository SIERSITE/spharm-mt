/**
 * Despeja (JSON) as células do Excel do Mapa de Vendas para vários cenários, a partir do código de UMA árvore (ROOT), para comparar
 * árvores: o Excel da tabela única em A4 tem de ser IDÊNTICO ao de a012428 (antes da tabela única).
 *
 *   ROOT=<árvore> OUT=<ficheiro.json> npx tsx scripts/tests/_excel-dump.ts      (cwd = ROOT)
 *
 * Os dados vêm de `_cliente-real.ts` desta árvore (só tipos importados do adapter). `generatedAt` é fixado para o «Gerado em»
 * não diferir. Cada cenário: {nome, meses, venda, compra, agrupar, extremos}.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.ROOT ?? process.cwd();
const OUT = process.env.OUT ?? "excel.json";
const imp = (rel: string) => import(pathToFileURL(path.join(ROOT, rel)).href);
const DADOS = process.env.DADOS ?? path.resolve("scripts/tests/_cliente-real.ts");

type Cenario = { nome: string; meses: number; venda: boolean; compra: boolean; agrupar: string; extremos?: boolean; artigos?: number };
const CENARIOS: Cenario[] = [
  { nome: "14m-todos", meses: 14, venda: true, compra: true, agrupar: "artigo" },
  { nome: "14m-so-venda", meses: 14, venda: true, compra: false, agrupar: "artigo" },
  { nome: "14m-so-compra", meses: 14, venda: false, compra: true, agrupar: "artigo" },
  { nome: "14m-nenhum", meses: 14, venda: false, compra: false, agrupar: "artigo" },
  { nome: "1m", meses: 1, venda: true, compra: true, agrupar: "artigo" },
  { nome: "3m", meses: 3, venda: true, compra: true, agrupar: "artigo", artigos: 40 },
  { nome: "6m-agrupar-farmacia", meses: 6, venda: true, compra: true, agrupar: "farmacia", artigos: 40 },
  { nome: "12m", meses: 12, venda: true, compra: true, agrupar: "artigo", artigos: 60 },
  { nome: "13m", meses: 13, venda: true, compra: true, agrupar: "artigo", artigos: 60 },
  { nome: "14m-extremos", meses: 14, venda: true, compra: true, agrupar: "artigo", extremos: true, artigos: 60 },
  { nome: "24m", meses: 24, venda: true, compra: true, agrupar: "artigo", artigos: 60 },
  { nome: "27m", meses: 27, venda: true, compra: true, agrupar: "artigo", artigos: 60 },
];

(async () => {
  const { dadosClienteReal, bucketsCliente, FARMACIAS_CLIENTE } = await import(pathToFileURL(DADOS).href);
  const { buildVendasReport } = await imp("lib/reporting/adapters/vendas.ts");
  const { buildReportWorkbook } = await imp("lib/reporting/report-excel-buffer.ts");
  const saida: Record<string, unknown> = {};
  for (const c of CENARIOS) {
    const rows = dadosClienteReal({ meses: c.meses, artigos: c.artigos });
    if (c.extremos) {
      rows[1].meses[0].quantidade = 123456; rows[1].totalVendas = rows[1].meses.reduce((a: number, m: { quantidade: number }) => a + m.quantidade, 0);
      rows[3].meses[c.meses - 1].quantidade = -12345; rows[3].totalVendas = rows[3].meses.reduce((a: number, m: { quantidade: number }) => a + m.quantidade, 0);
      rows[1].pvp = 12345.67; rows[1].valorBruto = 12345.67 * rows[1].totalVendas;
    }
    // sem custo conhecido numa linha (custo parcial)
    rows[2].custoUnitarioEstimado = null; rows[2].custoEstimado = null;
    const rel = buildVendasReport({
      rows, buckets: bucketsCliente(c.meses), filters: { agruparPor: c.agrupar, dataInicio: "2025-10-01", dataFim: "2026-11-02" },
      universe: { farmacias: FARMACIAS_CLIENTE, fornecedores: [], fabricantes: [], categorias: [] }, organization: "Grupo Teste",
      incluirPrecosVenda: c.venda, incluirPrecosCompra: c.compra,
    });
    rel.generatedAt = new Date("2026-11-02T14:00:00Z");
    const wb = buildReportWorkbook(rel);
    const ws = wb.Sheets["Relatório"];
    const celulas: Record<string, unknown> = {};
    for (const k of Object.keys(ws)) {
      if (k.startsWith("!")) continue;
      const cel = ws[k] as { t: string; v: unknown; z?: string };
      celulas[k] = { t: cel.t, v: cel.v, z: cel.z };
    }
    saida[c.nome] = { celulas, ref: ws["!ref"], cols: ws["!cols"], merges: ws["!merges"], autofilter: ws["!autofilter"], folhas: wb.SheetNames };
  }
  writeFileSync(OUT, JSON.stringify(saida));
  console.log(`${OUT}: ${Object.keys(saida).length} cenários`);
})().catch((e) => { console.error(e); process.exit(1); });
