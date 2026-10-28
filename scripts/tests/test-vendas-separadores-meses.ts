/**
 * Separadores verticais entre as colunas dos MESES do mapa de Vendas (hierarquia limpa) — para ler em papel.
 *
 * Mede PIXÉIS do PDF real (Chromium → PDF → PyMuPDF), gerado SEM fundos (simula «Imprimir gráficos de fundo» desligado: o que sobra
 * são só bordas e texto) e, para 3 e 13 meses, também COM fundos. Verifica, por página:
 *   · nº de filetes verticais no intervalo dos meses = meses do bloco + 1 (um entre cada par + o limite de cada lado);
 *   · cada filete é UMA linha contínua do topo do cabeçalho até ao fim da tabela (inclui «TOTAL ARTIGO» e «TOTAL GERAL»);
 *   · cada mês do cabeçalho fica entre dois filetes consecutivos, e nenhum valor/palavra é cortado por um filete;
 *   · espessura ≤ 1 px CSS (0,75pt), claramente mais fina do que o separador entre artigos (2px); cinzento claro mas visível;
 *   · nada à esquerda do 1.º mês (CNP, Descrição, Farmácia, PVP, custos) nem à direita de «Total unid.» (Stock, Valor Vendas);
 *   · blocos (14 e 27 meses): cada bloco tem os seus limites; «Total unid. do bloco» não parece um mês; sem filete duplicado.
 * Casos: 1, 3, 6, 13, 14 e 27 meses; as 4 combinações de preços; documento de várias páginas (3 e 13 meses).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import { buildVendasReport, type VendasAdapterRow } from "../../lib/reporting/adapters/vendas";
import { renderReportHtml } from "../../lib/reporting/report-html";
import type { Report } from "../../lib/reporting/report-types";
import { medirMeses, mediana, verticaisDe } from "./_verticais-meses";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { passed++; console.log(`  [OK]    ${label}`); }
  else { failed++; console.log(`  [FALHA] ${label}${detalhe ? `  → ${detalhe}` : ""}`); }
};

const FARM = ["Farmácia Segurado", "Farmácia Silveirense"];
const [F1, F2] = FARM;
const buckets = (n: number) => Array.from({ length: n }, (_, i) => ({ ano: 2025 + Math.floor((6 + i) / 12), mes: ((6 + i) % 12) + 1 }));
function linha(codigo: string, desc: string, farm: string, q: number[], stock: number, pvp = 10): VendasAdapterRow {
  const t = q.reduce((a, b) => a + b, 0);
  const bks = buckets(q.length);
  return { codigo, descricao: desc, pvp, custoUnitarioEstimado: 5, custoEstimado: 5 * t, meses: q.map((x, i) => ({ ...bks[i], quantidade: x })), totalVendas: t, valorBruto: t * pvp, existencia: stock, fornecedor: "F", fabricante: "Fab", categoria: "C", farmacia: farm, grupo: "G" };
}
function demo(n: number): VendasAdapterRow[] {
  const q = (k: number) => Array.from({ length: n }, (_, i) => ((i + k) % 4) * (i % 5 === 0 ? 11 : 1));
  return [
    linha("5000001", "Artigo numa só farmácia UM", F2, q(1), 5), linha("5000002", "Artigo numa só farmácia DOIS", F2, q(2), 0),
    linha("5000003", "Artigo em duas farmácias", F1, q(1), 3), linha("5000003", "Artigo em duas farmácias", F2, q(2), 7),
    linha("5000004", "Artigo numa só farmácia QUATRO", F1, q(3), -2),
    linha("5000005", "Artigo com designação muito longa que ocupa duas ou três linhas na coluna da descrição do mapa de vendas SPharm", F2, q(0), 4),
    linha("5000006", "Artigo com PVP divergente", F1, q(1), 2, 9.99), linha("5000006", "Artigo com PVP divergente", F2, q(2), 1, 10.5),
    linha("5000007", "Último artigo numa só farmácia", F2, q(3), 6),
  ];
}
function longo(n: number): VendasAdapterRow[] {
  const out: VendasAdapterRow[] = [];
  for (let i = 0; i < 48; i++) {
    const cod = String(5100001 + i);
    out.push(linha(cod, `Artigo comprido número ${i + 1}`, i % 3 === 1 ? F1 : F2, Array.from({ length: n }, (_, k) => (i + k) % 5), (i % 7) - 1));
    if (i % 3 === 1) out.push(linha(cod, `Artigo comprido número ${i + 1}`, F2, Array.from({ length: n }, (_, k) => (i + k + 1) % 4), i % 5));
  }
  return out;
}
const gerar = (rows: VendasAdapterRow[], n: number, venda = true, compra = true): Report =>
  buildVendasReport({ rows, buckets: buckets(n), filters: { agruparPor: "artigo" }, universe: { farmacias: FARM, fornecedores: [], fabricantes: [], categorias: [] }, organization: "Grupo Teste", incluirPrecosVenda: venda, incluirPrecosCompra: compra });

const dir = mkdtempSync(path.join(tmpdir(), "vendas-meses-"));
let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
const SEM_FUNDOS = "*{print-color-adjust:economy !important;-webkit-print-color-adjust:economy !important}";
async function pdfDe(rel: Report, nome: string, fundos: boolean): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.emulateMediaType("print");
    await page.setContent(renderReportHtml(rel), { waitUntil: "networkidle0" });
    if (!fundos) await page.addStyleTag({ content: SEM_FUNDOS });
    const bytes = await page.pdf({
      format: "A4", landscape: true, printBackground: fundos, preferCSSPageSize: true, margin: { top: "10mm", right: "8mm", bottom: "10mm", left: "8mm" },
      displayHeaderFooter: true, headerTemplate: `<div style="font-size:7px;width:100%;text-align:right;padding-right:8mm">Pág. <span class="pageNumber"></span> / <span class="totalPages"></span></div>`, footerTemplate: `<div></div>`,
    });
    const f = path.join(dir, `${nome}.pdf`);
    writeFileSync(f, bytes);
    return f;
  } finally { await page.close(); }
}

/** Meses esperados por página: um documento sem blocos tem todos em cada página; com blocos, cada página (bloco) os seus. */
function mesesPorPagina(rel: Report, nPaginas: number): number[] {
  const meses = rel.columns.filter((c) => c.monthAlt).map((c) => c.key);
  const blocos = rel.meta?.columnBlocks;
  if (blocos && blocos.length > 1) return blocos.map((b) => meses.filter((k) => !b.omitir.includes(k)).length);
  return Array.from({ length: nPaginas }, () => meses.length);
}

function verificar(tag: string, rel: Report, f: string, opc: { blocos?: boolean; fundos?: boolean }) {
  const nPag = verticaisDe(f).length;
  const porPag = mesesPorPagina(rel, nPag);
  const m = medirMeses(f, (pi) => porPag[opc.blocos ? pi : 0]);
  ok(`${tag}: n.º de filetes = meses do bloco + 1 em cada página (${m.nLimites.join("/")} em ${m.nPaginas} pág.), contínuos do cabeçalho ao TOTAL GERAL (incl. TOTAL ARTIGO), cada mês entre dois filetes, nada cortado, nada fora das colunas dos meses`, m.falhas.length === 0 && m.nLimites.length === m.nPaginas, m.falhas.slice(0, 4).join(" | "));
  ok(`${tag}: espessura real ${m.minLargura.toFixed(2)}–${m.maxLargura.toFixed(2)}pt (1px CSS = 0,75pt; alvo 0,5–0,95) e mais fina do que o separador entre artigos (${Number.isFinite(m.minHorizontal) ? m.minHorizontal.toFixed(2) : "—"}pt medidos)`, m.maxLargura > 0 && m.minLargura >= 0.5 && m.maxLargura <= 0.95 && (!Number.isFinite(m.minHorizontal) || m.maxLargura < m.minHorizontal));
  if (!opc.fundos) {
    ok(`${tag}: sem fundos continua legível — filetes de mês cinzento claro mas visível (mediana ${mediana(m.cinzMes)}/255), limites um pouco mais escuros (${mediana(m.cinzLimite)}/255)`, (m.cinzMes.length === 0 || (mediana(m.cinzMes) >= 150 && mediana(m.cinzMes) <= 215 && mediana(m.cinzLimite) <= mediana(m.cinzMes))) && m.cinzLimite.length > 0 && mediana(m.cinzLimite) >= 120 && mediana(m.cinzLimite) <= 215);
  }
}

async function main() {
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    console.log("\n=== Separadores verticais dos meses — PDF real SEM fundos (simula «gráficos de fundo» desligado: printBackground=false + print-color-adjust:economy, para que o relatório — que pede «exact» — também perca os fundos) ===");
    for (const n of [1, 3, 6, 13, 14, 27]) {
      const rel = gerar(demo(n), n);
      const f = await pdfDe(rel, `m${n}-sf`, false);
      verificar(`${n} ${n === 1 ? "mês" : "meses"}${n > 13 ? " (blocos)" : ""}`, rel, f, { blocos: n > 13 });
    }
    console.log("\n=== Quatro combinações de preços (larguras recalculadas, filetes alinhados, nada cortado) ===");
    for (const n of [3, 13]) for (const [v, c] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      const rel = gerar(demo(n), n, v, c);
      const f = await pdfDe(rel, `p${n}-${v ? 1 : 0}${c ? 1 : 0}`, false);
      verificar(`${n} meses · venda=${v ? "sim" : "não"} · compra=${c ? "sim" : "não"}`, rel, f, {});
    }
    console.log("\n=== Documento de várias páginas (cabeçalho repetido e filetes alinhados em todas) ===");
    for (const n of [3, 13]) {
      const rel = gerar(longo(n), n);
      const f = await pdfDe(rel, `longo${n}`, false);
      const nPag = verticaisDe(f).length;
      ok(`${n} meses: documento com várias páginas (${nPag})`, nPag >= 2);
      verificar(`${n} meses · várias páginas`, rel, f, {});
    }
    console.log("\n=== Com fundos (impressão normal): os mesmos filetes, sem duplicar nem sumir ===");
    for (const n of [3, 13]) {
      const rel = gerar(demo(n), n);
      const f = await pdfDe(rel, `m${n}-cf`, true);
      verificar(`${n} meses COM fundos`, rel, f, { fundos: true });
    }
  } finally { await browser.close(); }
  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
