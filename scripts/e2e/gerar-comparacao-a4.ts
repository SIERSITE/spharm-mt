/**
 * Gera o PDF do Mapa de Vendas com os MESMOS dados sintéticos (scripts/tests/_cliente-real.ts: 326 artigos, Segurado + Silveirense,
 * 14 meses Out/25…Nov/26, preços de venda e de compra) a partir do código de UMA árvore — para a comparação visual à mesma escala
 * física entre:
 *   A) a012428  (PDF atual do cliente: blocos temporais, 57 páginas A4)
 *   B) 4d4ef19  (a solução A3 automática rejeitada)
 *   C) HEAD     (A4 horizontal, tabela única, 8 pt)
 *
 *   cd <árvore> && ROOT=$PWD OUT=<pasta> ETIQ=A DADOS=<_cliente-real.ts> npx tsx <este ficheiro>
 *
 * Usa as opções do endpoint de cada árvore (`opcoesPdfDoRelatorio` se existir; senão as fixas A4 de a012428). Imprime JSON com o nº de
 * páginas. O Python (`_comparar_a4.py`) faz a montagem e as medidas.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const ROOT = process.env.ROOT ?? process.cwd();
const OUT = process.env.OUT ?? "out";
const ETIQ = process.env.ETIQ ?? "x";
const MESES = Number(process.env.MESES ?? 14);
const DADOS = process.env.DADOS ?? path.resolve("scripts/tests/_cliente-real.ts");
const imp = (rel: string) => import(pathToFileURL(path.join(ROOT, rel)).href);

(async () => {
  mkdirSync(OUT, { recursive: true });
  const { dadosClienteReal, bucketsCliente, FARMACIAS_CLIENTE } = await import(pathToFileURL(DADOS).href);
  const { buildVendasReport } = await imp("lib/reporting/adapters/vendas.ts");
  const { renderReportHtml } = await imp("lib/reporting/report-html.ts");
  let opcoes: ((r: unknown) => Record<string, unknown>) | null = null;
  try { opcoes = (await imp("lib/reporting/pdf-opcoes.ts")).opcoesPdfDoRelatorio; } catch { /* a012428: opções fixas do report-pdf-server.ts */ }
  const rel = buildVendasReport({
    rows: dadosClienteReal({ meses: MESES }), buckets: bucketsCliente(MESES), filters: { agruparPor: "artigo", dataInicio: "2025-10-01", dataFim: "2026-11-02" },
    universe: { farmacias: FARMACIAS_CLIENTE, fornecedores: [], fabricantes: [], categorias: [] }, organization: "Grupo Teste (dados sintéticos)",
    incluirPrecosVenda: true, incluirPrecosCompra: true,
  });
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.emulateMediaType("print");
  await page.setContent(renderReportHtml(rel), { waitUntil: "networkidle0", timeout: 120000 });
  const opts = opcoes ? opcoes(rel) : {
    format: "A4", landscape: true, printBackground: true, preferCSSPageSize: true, margin: { top: "10mm", right: "8mm", bottom: "10mm", left: "8mm" },
    displayHeaderFooter: true, headerTemplate: `<div style="width:100%; font-size:7px; color:#94a3b8; padding:2mm 8mm 0 8mm; display:flex; justify-content:flex-end;">Pág. <span class="pageNumber"></span> / <span class="totalPages"></span></div>`, footerTemplate: `<div></div>`,
  };
  const f = path.join(OUT, `${ETIQ}.pdf`);
  writeFileSync(f, await page.pdf(opts as never));
  await browser.close();
  console.log(JSON.stringify({ f, etiqueta: ETIQ, rows: rel.rows.length, paper: (rel.meta as { paperSize?: string } | undefined)?.paperSize ?? "A4" }));
})().catch((e) => { console.error(e); process.exit(1); });
