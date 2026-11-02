/**
 * Infra partilhada pelos testes da TABELA ÚNICA do Mapa de Vendas (sem blocos temporais): geradores de dados sintéticos,
 * geração do PDF real (puppeteer, com as MESMAS opções do endpoint — lib/reporting/pdf-opcoes.ts) e da impressão
 * (HTML do iframe + emulateMediaType print), e a análise do PDF por PyMuPDF (tokens de texto com o tamanho real da fonte).
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import puppeteer, { type Browser } from "puppeteer";
import { buildVendasReport, type VendasAdapterRow } from "../../lib/reporting/adapters/vendas";
import { renderReportHtml } from "../../lib/reporting/report-html";
import { opcoesPdfDoRelatorio } from "../../lib/reporting/pdf-opcoes";
import type { Report } from "../../lib/reporting/report-types";

export const FARMACIAS = ["Farmácia Norte", "Farmácia Segurado", "Farmácia Silveirense"];
export const buckets = (n: number, anoIni = 2025, mesIni = 10) =>
  Array.from({ length: n }, (_, i) => ({ ano: anoIni + Math.floor((mesIni - 1 + i) / 12), mes: ((mesIni - 1 + i) % 12) + 1 }));

export type OpcoesDados = {
  /** Nº de artigos (cada um com 1..nFarm farmácias, por padrão determinístico). */
  artigos: number;
  meses: number;
  /** Farmácias do universo (1, 2 ou 3). */
  nFarm: number;
  /** Valores elevados e negativos em alguns artigos/meses. */
  extremos?: boolean;
};

/** Gerador determinístico (sem Math.random): sempre os mesmos dados. */
export function dados(o: OpcoesDados): VendasAdapterRow[] {
  const bks = buckets(o.meses);
  const out: VendasAdapterRow[] = [];
  for (let i = 0; i < o.artigos; i++) {
    const cnp = String(5100000 + i);
    // 1 farmácia em 1/3 dos artigos; 2 ou 3 nos restantes (se o universo o permitir)
    const nf = o.nFarm === 1 ? 1 : i % 3 === 0 ? 1 : i % 3 === 1 ? Math.min(2, o.nFarm) : o.nFarm;
    for (let f = 0; f < nf; f++) {
      const farm = FARMACIAS[(i + f) % o.nFarm]; // nf ≤ nFarm: farmácias distintas dentro do artigo
      const q = bks.map((_, k) => {
        let v = ((i * 7 + f * 3 + k * 5) % 11 === 0 ? 0 : ((i + k + f) % 6) + (k % 4 === 0 ? 3 : 0));
        if (o.extremos) {
          if (i === 1 && k === 0) v = 123456; // 6 dígitos, com separador de milhares
          if (i === 2 && k === o.meses - 1) v = -12345;
          if (i === 4 && k === 1) v = -987;
        }
        return v;
      });
      const total = q.reduce((a, b) => a + b, 0);
      const pvp = o.extremos && i === 1 ? 12345.67 : 3.5 + ((i * 13 + f) % 40) / 2;
      const custoU = o.extremos && i === 1 ? 12345.67 : 1.2 + ((i * 7 + f) % 30) / 3;
      out.push({
        codigo: cnp,
        descricao: i % 17 === 5 ? `Artigo ${i + 1} com designação muito comprida que ocupa duas ou três linhas na coluna da descrição do mapa` : `Artigo ${i + 1} dosagem ${(i % 9) + 1} mg`,
        pvp, custoUnitarioEstimado: custoU, custoEstimado: custoU * total,
        meses: q.map((x, k) => ({ ...bks[k], quantidade: x })),
        totalVendas: total, valorBruto: pvp * total,
        existencia: o.extremos && i === 1 ? 12345 : ((i * 5 + f) % 9) - (i % 23 === 0 ? 1 : 0),
        fornecedor: "Forn", fabricante: "Fab", categoria: "Cat", farmacia: farm, grupo: "G",
      });
    }
  }
  return out;
}

export function relatorio(rows: VendasAdapterRow[], meses: number, nFarm: number, venda = true, compra = true, extra: Record<string, unknown> = {}): Report {
  return buildVendasReport({
    rows, buckets: buckets(meses), filters: { agruparPor: "artigo", dataInicio: "2025-10-01", dataFim: "2026-11-02" },
    universe: { farmacias: FARMACIAS.slice(0, nFarm), fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste", incluirPrecosVenda: venda, incluirPrecosCompra: compra, ...extra,
  });
}

export const novaPasta = (prefixo: string) => mkdtempSync(path.join(tmpdir(), prefixo));
export const apagarPasta = (d: string) => { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignora */ } };

export async function abrirBrowser(): Promise<Browser> {
  return puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
}

/** PDF do endpoint real (mesmas opções) — `pdf-opcoes.ts`. */
export async function pdfDe(browser: Browser, rel: Report, ficheiro: string): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.emulateMediaType("print");
    await page.setContent(renderReportHtml(rel), { waitUntil: "networkidle0" });
    writeFileSync(ficheiro, await page.pdf(opcoesPdfDoRelatorio(rel)));
    return ficheiro;
  } finally { await page.close(); }
}

/** Impressão: o HTML do iframe de `printReport` (papel do @page, sem as opções de PDF do servidor), em mídia print. */
export async function pdfImpressao(browser: Browser, rel: Report, ficheiro: string): Promise<string> {
  const page = await browser.newPage();
  try {
    const dim = rel.meta?.paperSize === "A3" ? { w: 420, h: 297 } : { w: 297, h: 210 };
    // o iframe de report-print.ts tem o tamanho real do papel; a viewport reproduz-o
    await page.setViewport({ width: Math.round(dim.w * 96 / 25.4), height: Math.round(dim.h * 96 / 25.4) });
    await page.emulateMediaType("print");
    await page.setContent(renderReportHtml(rel), { waitUntil: "networkidle0" });
    // a impressão do browser respeita o @page (preferCSSPageSize), sem margens nem cabeçalhos do servidor
    writeFileSync(ficheiro, await page.pdf({ printBackground: true, preferCSSPageSize: true }));
    return ficheiro;
  } finally { await page.close(); }
}

/** [x0, y0, x1, y1, tamanho_pt, texto] — texto de uma célula/palavra (números com o espaço de milhares U+00A0 dentro). */
export type Tok = [number, number, number, number, number, string];
export type PaginaPdf = { w: number; h: number; tokens: Tok[] };
export function lerPdf(f: string): PaginaPdf[] {
  const r = spawnSync("python", [path.resolve("scripts/e2e/_tabela_unica_pdf.py"), f], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python _tabela_unica_pdf.py: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}").paginas;
}
