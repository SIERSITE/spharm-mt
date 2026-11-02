/**
 * Gera a evidência ANTES/DEPOIS do Mapa de Vendas numa só tabela (PDFs reais, dados sintéticos, 2 farmácias, ARTIGOS=326 por omissão; MESES=14,27).
 *
 * Corre-se com o cwd na árvore a medir (o código dessa árvore é importado dinamicamente a partir de ROOT):
 *   ANTES : cd <worktree garantia-fase @ a012428>  &&  ROOT=$PWD OUT=<pasta> ETIQ=antes  npx tsx <este ficheiro>
 *   DEPOIS: cd <worktree vendas-tabela-unica>      &&  ROOT=$PWD OUT=<pasta> ETIQ=depois npx tsx <este ficheiro>
 * Escreve <OUT>/<ETIQ>-vendas-<N>m.pdf (14 e 27 meses) e imprime o nº de páginas, o papel e a nota de rodapé.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const ROOT = process.env.ROOT ?? process.cwd();
const OUT = process.env.OUT ?? "out";
const ETIQ = process.env.ETIQ ?? "x";
const ARTIGOS = Number(process.env.ARTIGOS ?? 326);
const MESES = (process.env.MESES ?? "14,27").split(",").map(Number);
const imp = (rel: string) => import(pathToFileURL(path.join(ROOT, rel)).href);

const FARM = ["Farmácia Segurado", "Farmácia Silveirense"];
const buckets = (n: number) => Array.from({ length: n }, (_, i) => ({ ano: 2025 + Math.floor((9 + i) / 12), mes: ((9 + i) % 12) + 1 }));

function dados(artigos: number, meses: number) {
  const bks = buckets(meses);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < artigos; i++) {
    const nf = i % 3 === 0 ? 1 : 2; // 1/3 dos artigos numa só farmácia
    for (let f = 0; f < nf; f++) {
      // farmácia de volume médio: totais mensais do mapa na ordem dos milhares (4 dígitos), como no PDF do cliente
      const q = bks.map((_, k) => (((i * 7 + f * 3 + k * 5) % 11 === 0 ? 0 : ((i + k + f) % 6) + (k % 4 === 0 ? 3 : 0) + (i % 29 === 0 ? 12 : 0)) * (1 + (i % 4))));
      const total = q.reduce((a, b) => a + b, 0);
      const pvp = 3.5 + ((i * 13 + f) % 40) / 2, custoU = 1.2 + ((i * 7 + f) % 30) / 3;
      out.push({
        codigo: String(5100000 + i * 7), descricao: i % 17 === 5 ? `Artigo ${i + 1} com designação muito comprida que ocupa duas ou três linhas na coluna da descrição do mapa` : `Artigo ${i + 1} dosagem ${(i % 9) + 1} mg`,
        pvp, custoUnitarioEstimado: custoU, custoEstimado: custoU * total, meses: q.map((x, k) => ({ ...bks[k], quantidade: x })),
        totalVendas: total, valorBruto: pvp * total, existencia: ((i * 5 + f) % 9) - (i % 23 === 0 ? 1 : 0),
        fornecedor: "Forn", fabricante: "Fab", categoria: "Cat", farmacia: FARM[(i + f) % 2], grupo: "G",
      });
    }
  }
  return out;
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const { buildVendasReport } = await imp("lib/reporting/adapters/vendas.ts");
  const { renderReportHtml } = await imp("lib/reporting/report-html.ts");
  type Rel = { meta?: { paperSize?: string; columnBlocks?: unknown[] }; rows: unknown[] };
  let opcoes: ((r: Rel) => Record<string, unknown>) | null = null;
  try { opcoes = (await imp("lib/reporting/pdf-opcoes.ts")).opcoesPdfDoRelatorio; } catch { /* árvore ANTES: opções fixas A4 do report-pdf-server.ts */ }
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  for (const meses of MESES) {
    const rel = buildVendasReport({
      rows: dados(ARTIGOS, meses), buckets: buckets(meses), filters: { agruparPor: "artigo", dataInicio: "2025-10-01", dataFim: "2026-11-02" },
      universe: { farmacias: FARM, fornecedores: [], fabricantes: [], categorias: [] }, organization: "Grupo Teste (dados sintéticos)",
    });
    const page = await browser.newPage();
    await page.emulateMediaType("print");
    await page.setContent(renderReportHtml(rel), { waitUntil: "networkidle0" });
    const opts = opcoes ? opcoes(rel) : {
      format: "A4", landscape: true, printBackground: true, preferCSSPageSize: true, margin: { top: "10mm", right: "8mm", bottom: "10mm", left: "8mm" },
      displayHeaderFooter: true, headerTemplate: `<div style="width:100%; font-size:7px; color:#94a3b8; padding:2mm 8mm 0 8mm; display:flex; justify-content:flex-end;">Pág. <span class="pageNumber"></span> / <span class="totalPages"></span></div>`, footerTemplate: `<div></div>`,
    };
    const f = path.join(OUT, `${ETIQ}-vendas-${meses}m.pdf`);
    writeFileSync(f, await page.pdf(opts));
    await page.close();
    console.log(JSON.stringify({ f, meses, papel: rel.meta?.paperSize ?? "A4 (sem regra)", blocos: rel.meta?.columnBlocks?.length ?? 1, linhas: rel.rows.length }));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
