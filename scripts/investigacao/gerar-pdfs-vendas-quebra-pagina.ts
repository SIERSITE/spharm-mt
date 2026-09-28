/**
 * scripts/investigacao/gerar-pdfs-vendas-quebra-pagina.ts
 *
 * Gera PDFs REAIS (via `buildReportPdfBuffer`, Puppeteer) de fixtures no
 * formato exacto que `adapters/vendas.ts` produz (density:"compact",
 * GROUP_KEY por artigo, subtotal-row), para inspeccionar visualmente o
 * comportamento de paginação (Ponto 6). Não faz parte da suite de
 * testes — é uma ferramenta de investigação, corrida manualmente.
 */
import Module from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { GROUP_KEY, ROW_KIND_KEY, type Report, type ReportColumn, type ReportRow } from "../../lib/reporting/report-types";

// `server-only` só existe no build do Next — stub antes de carregar
// `report-pdf-server.ts` (mesmo truque usado nos scripts de teste).
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

const OUT_DIR = process.argv[2] ?? "scratchpad";
mkdirSync(OUT_DIR, { recursive: true });

const COLUMNS: ReportColumn[] = [
  { key: "cnp", label: "CNP", width: 10, spanGroup: true },
  { key: "descricao", label: "Descrição", width: 26, spanGroup: true },
  { key: "farmacia", label: "Farmácia", width: 16 },
  { key: "qtd", label: "Qtd.", format: "integer", align: "right", width: 10, showTotal: true },
  { key: "valor", label: "Valor", format: "currency", align: "right", width: 14, showTotal: true },
  { key: "m1", label: "Jan", format: "integer", align: "right", width: 8 },
  { key: "m2", label: "Fev", format: "integer", align: "right", width: 8 },
  { key: "m3", label: "Mar", format: "integer", align: "right", width: 8 },
];

function artigo(n: number, nFarmacias: number): ReportRow[] {
  const cnp = String(5000000 + n);
  const desc = `ARTIGO DE TESTE Nº ${n} — DESCRIÇÃO LONGA PARA OCUPAR ESPAÇO REAL`;
  const farmacias = ["Silveirense", "Segurado", "Garantia", "Central", "Norte"].slice(0, nFarmacias);
  const rows: ReportRow[] = farmacias.map((f, i) => ({
    [GROUP_KEY]: cnp,
    cnp,
    descricao: desc,
    farmacia: f,
    qtd: 10 + i,
    valor: (10 + i) * 12.5,
    m1: 3 + i, m2: 4 + i, m3: 2 + i,
  }));
  if (farmacias.length > 1) {
    rows.push({
      [GROUP_KEY]: cnp,
      [ROW_KIND_KEY]: "subtotal",
      cnp,
      descricao: desc,
      farmacia: `TOTAL ARTIGO`,
      qtd: rows.reduce((s, r) => s + (r.qtd as number), 0),
      valor: rows.reduce((s, r) => s + (r.valor as number), 0),
      m1: "", m2: "", m3: "",
    });
  }
  return rows;
}

function buildReport(title: string, especificacoes: number[]): Report {
  const rows: ReportRow[] = [];
  especificacoes.forEach((nFarmacias, i) => rows.push(...artigo(i + 1, nFarmacias)));
  return {
    title: `Relatório de Vendas — ${title}`,
    subtitle: "Investigação Ponto 6 — quebra de página",
    generatedAt: new Date(),
    summary: [
      { label: "Artigos", value: especificacoes.length, format: "integer" },
      { label: "Linhas", value: rows.length, format: "integer" },
    ],
    columns: COLUMNS,
    rows,
    meta: { slug: "vendas-quebra-pagina", orientation: "landscape", organization: "SPharm.MT", density: "compact", footer: "SPharm.MT · Investigação" },
  };
}

async function gerar(nome: string, report: Report) {
  const { buildReportPdfBuffer } = await import("../../lib/reporting/report-pdf-server");
  const { buffer } = await buildReportPdfBuffer(report);
  const path = `${OUT_DIR}/${nome}.pdf`;
  writeFileSync(path, buffer);
  console.log(`gerado: ${path} (${buffer.length} bytes, ${report.rows.length} linhas)`);
}

async function main() {
  // 1 farmácia, poucos artigos
  await gerar("1-uma-farmacia", buildReport("1 farmácia", Array(15).fill(1)));
  // 2 farmácias por artigo
  await gerar("2-duas-farmacias", buildReport("2 farmácias", Array(15).fill(2)));
  // 5 farmácias por artigo (grupos grandes — mais chance de quebra a meio)
  await gerar("3-cinco-farmacias", buildReport("5 farmácias", Array(10).fill(5)));
  // Muitos artigos, mistura de tamanhos de grupo (cenário realista)
  const mix = Array.from({ length: 60 }, (_, i) => [1, 2, 3, 5][i % 4]);
  await gerar("4-muitos-artigos-mix", buildReport("muitos artigos", mix));
  // Construído para ter um grupo de 5 farmácias a cavalo do fim de uma página
  // A4 landscape compact: ~26-30 linhas de detalhe cabem por página com este
  // nº de colunas — enche a página quase toda com grupos de 1, depois um de 5.
  const quaseQuebra = [...Array(24).fill(1), 5, ...Array(5).fill(1)];
  await gerar("5-artigo-a-cavalo-da-quebra", buildReport("artigo a cavalo da quebra", quaseQuebra));
}

main().catch((e) => { console.error(e); process.exit(1); });
