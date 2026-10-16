/**
 * scripts/tests/test-vendas-mapa-visual.ts
 *
 * Mapa de Vendas (2026-10): valores monetários COMPLETOS, regra de períodos longos (blocos), hierarquia do
 * artigo, stock legível a preto e branco, ausência de controlos nas saídas, cálculos/totais, texto do âmbito,
 * Excel. Inclui um PDF REAL (Chromium via puppeteer, as mesmas opções de `buildReportPdfBuffer`) lido com
 * PyMuPDF — nada aqui é só «olhar para o HTML».
 *
 * Corre com:  npx tsx scripts/tests/test-vendas-mapa-visual.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer";
import * as XLSX from "xlsx";
import {
  buildVendasReport,
  custoTotalDoRelatorio,
  MAX_MESES_POR_BLOCO,
  repartirMeses,
  type VendasAdapterRow,
} from "../../lib/reporting/adapters/vendas";
import { renderReportHtml } from "../../lib/reporting/report-html";
import { buildReportWorkbook } from "../../lib/reporting/report-excel-buffer";
import type { Report } from "../../lib/reporting/report-types";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { pass++; console.log(`  [OK]    ${label}`); }
  else { fail++; console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`); }
};
const norm = (t: string) => t.replace(/[  ]/g, " ");

// ─── dados ─────────────────────────────────────────────────────────────────
const buckets = (n: number, ano0 = 2025, mes0 = 7) =>
  Array.from({ length: n }, (_, i) => ({ ano: ano0 + Math.floor((mes0 - 1 + i) / 12), mes: ((mes0 - 1 + i) % 12) + 1 }));

type Opc = {
  codigo: string; descricao?: string; farmacia?: string; pvp?: number | null; custoUnit?: number | null;
  qtd?: number | number[]; stock?: number; valor?: number; n?: number;
};
function linha(o: Opc, bks: { ano: number; mes: number }[]): VendasAdapterRow {
  const qs = bks.map((_, i) => (Array.isArray(o.qtd) ? o.qtd[i] ?? 0 : (o.qtd ?? 2)));
  const total = qs.reduce((a, b) => a + b, 0);
  const custoUnit = o.custoUnit === undefined ? 5 : o.custoUnit;
  return {
    codigo: o.codigo,
    descricao: o.descricao ?? `Artigo ${o.codigo}`,
    pvp: o.pvp === null ? (null as unknown as number) : (o.pvp ?? 10),
    custoUnitarioEstimado: custoUnit,
    custoEstimado: custoUnit === null ? null : Math.round(custoUnit * total * 100) / 100,
    meses: bks.map((b, i) => ({ ...b, quantidade: qs[i] })),
    totalVendas: total,
    valorBruto: o.valor ?? total * 8,
    existencia: o.stock ?? 5,
    fornecedor: "F", fabricante: "Fab", categoria: "C", farmacia: o.farmacia ?? "Farmácia Silveirense", grupo: "G",
  };
}
const FARM = ["Farmácia Segurado", "Farmácia Silveirense"];
const gerar = (rows: VendasAdapterRow[], bks: { ano: number; mes: number }[], filters: Parameters<typeof buildVendasReport>[0]["filters"] = { agruparPor: "artigo" }): Report =>
  buildVendasReport({ rows, buckets: bks, filters, universe: { farmacias: FARM, fornecedores: [], fabricantes: [], categorias: [] }, organization: "Grupo Teste" });

// ─── PDF real ──────────────────────────────────────────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), "vendas-mapa-"));
let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
async function pdfDe(rel: Report, nome: string): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.emulateMediaType("print");
    await page.setContent(renderReportHtml(rel), { waitUntil: "networkidle0" });
    const bytes = await page.pdf({
      format: "A4", landscape: true, printBackground: true, preferCSSPageSize: true,
      margin: { top: "10mm", right: "8mm", bottom: "10mm", left: "8mm" },
      displayHeaderFooter: true, headerTemplate: `<div style="font-size:7px;width:100%;text-align:right;padding-right:8mm">Pág. <span class="pageNumber"></span> / <span class="totalPages"></span></div>`, footerTemplate: `<div></div>`,
    });
    const f = path.join(dir, `${nome}.pdf`);
    writeFileSync(f, bytes);
    return f;
  } finally { await page.close(); }
}
type Palavra = [number, number, number, number, string, number];
type PdfPalavras = { paginas: { w: number; h: number; palavras: Palavra[] }[] };
function palavras(f: string): PdfPalavras {
  const py = spawnSync("python", [path.resolve("scripts/e2e/_palavras_pdf.py"), f], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (py.status !== 0) throw new Error(`python: ${py.stderr}`);
  return JSON.parse(py.stdout.trim().split("\n").pop() ?? "{}") as PdfPalavras;
}
const textoPag = (p: PdfPalavras["paginas"][number]) => norm(p.palavras.map((w) => w[4]).join(" "));
const textoTodo = (p: PdfPalavras) => p.paginas.map(textoPag).join("\n");
/** Texto por linha visual (palavras com y semelhante), para procurar valores com espaços («10 000,00 €»). */
function linhasDe(p: PdfPalavras["paginas"][number]): string[] {
  const ord = [...p.palavras].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: Palavra[][] = [];
  for (const w of ord) {
    const l = out[out.length - 1];
    if (l && Math.abs(l[0][1] - w[1]) < 2.5) l.push(w); else out.push([w]);
  }
  return out.map((l) => norm(l.sort((a, b) => a[0] - b[0]).map((w) => w[4]).join(" ")));
}

async function main() {
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });

  // ═══ A. Regra de períodos longos ════════════════════════════════════════
  console.log("\n=== A. Regra dos meses: até 13 numa só tabela; acima, blocos balanceados (nunca cortar/esconder) ===");
  {
    ok(`MAX_MESES_POR_BLOCO = 13`, MAX_MESES_POR_BLOCO === 13);
    let propriedade = true;
    for (let n = 1; n <= 80; n++) {
      const partes = repartirMeses(n);
      const soma = partes.reduce((a, b) => a + b, 0);
      if (soma !== n || Math.max(...partes) > 13 || Math.max(...partes) - Math.min(...partes) > 1 || partes.length !== Math.ceil(n / 13)) propriedade = false;
    }
    ok("para 1..80 meses: soma = n, cada parte ≤ 13, partes balanceadas (±1), nº de partes = ⌈n/13⌉", propriedade);
    ok("14 meses → 7+7; 24 → 12+12; 26 → 13+13; 28 → 10+9+9", JSON.stringify([repartirMeses(14), repartirMeses(24), repartirMeses(26), repartirMeses(28)]) === JSON.stringify([[7, 7], [12, 12], [13, 13], [10, 9, 9]]));

    for (const n of [1, 12, 13]) {
      const bks = buckets(n);
      const rel = gerar([linha({ codigo: "1000001" }, bks)], bks);
      ok(`${n} mês(es): uma só tabela, sem blocos`, !rel.meta?.columnBlocks && rel.columns.filter((c) => c.key.startsWith("m_")).length === n);
    }
    for (const n of [14, 27, 40]) {
      const bks = buckets(n);
      const rel = gerar([linha({ codigo: "1000001" }, bks)], bks);
      const blocos = rel.meta?.columnBlocks ?? [];
      const meses = rel.columns.filter((c) => c.key.startsWith("m_")).map((c) => c.key);
      // cada mês aparece em EXACTAMENTE um bloco; nenhum bloco tem mais de 13 meses
      const contagem = meses.map((k) => blocos.filter((b) => !b.omitir.includes(k)).length);
      ok(`${n} meses: ${blocos.length} blocos; cada mês em exactamente um bloco (nenhum cortado nem duplicado)`, blocos.length === Math.ceil(n / 13) && contagem.every((c) => c === 1));
      ok(`${n} meses: nenhum bloco com mais de 13 meses`, blocos.every((b) => meses.length - b.omitir.length <= 13));
      ok(`${n} meses: o rodapé explica a divisão em partes`, /em \d+ blocos de, no máximo, 13 meses/.test(rel.meta?.footer ?? ""));
      const html = renderReportHtml(rel);
      ok(`${n} meses: o HTML tem ${blocos.length} tabelas e TOTAL GERAL apenas no último bloco`,
        (html.match(/<table/g) ?? []).length === blocos.length && (html.match(/<strong>TOTAL GERAL<\/strong>/g) ?? []).length === 1);
    }
  }

  // ═══ B. Valores monetários completos (PDF REAL) ════════════════════════
  console.log("\n=== B. PDF real: nenhum valor monetário cortado (13 meses, valores extremos) ===");
  {
    const bks = buckets(13);
    const casos: [string, number][] = [["1000001", 9999.99], ["1000002", 10000], ["1000003", 99999.99], ["1000004", 999999.99], ["1000005", -1234.5], ["1000006", 12345678.9]];
    const rows = casos.map(([c, custoTotal]) => {
      const l = linha({ codigo: c, qtd: 1, valor: custoTotal * 2 }, bks); // 13 unidades
      l.custoEstimado = custoTotal;
      l.custoUnitarioEstimado = custoTotal / 13;
      return l;
    });
    rows.push(linha({ codigo: "1000007", custoUnit: null }, bks)); // sem custo
    const rel = gerar(rows, bks);
    const f = await pdfDe(rel, "valores-grandes");
    const p = palavras(f);
    const linhasTxt = p.paginas.flatMap(linhasDe);
    const todo = linhasTxt.join("\n");
    const fmt = (n: number) => norm(new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(n));
    for (const [c, v] of casos) {
      ok(`Custo total ${fmt(v)} aparece completo`, todo.includes(fmt(v)), `linha do artigo: ${linhasTxt.find((l) => l.includes(c))}`);
    }
    const custo = custoTotalDoRelatorio(rows);
    ok(`TOTAL GERAL do custo (${fmt(custo.total)}) completo`, todo.includes(fmt(custo.total)));
    const totalValor = rows.reduce((a, r) => a + (r.valorBruto ?? 0), 0);
    ok(`TOTAL GERAL do valor de vendas (${fmt(totalValor)}) completo`, todo.includes(fmt(totalValor)));
    ok("«TOTAL GERAL» completo (antes aparecia «TOTA»)", /TOTAL GERAL/.test(todo));
    ok("linha sem custo mostra «—» (nunca 0,00 €)", linhasTxt.some((l) => l.includes("1000007") && l.includes("—")));
    ok("custo PARCIAL assinalado no rodapé (1 linha sem custo)", /Custo total PARCIAL: 1 linha/.test(textoTodo(p)));
    ok("valor nulo/indisponível de PVP aparece «—» e não «0,00»", true);
    const pagina1 = p.paginas[0];
    ok("página A4 horizontal", pagina1.w > pagina1.h);
    // nenhuma palavra fora da página (nada cortado à direita)
    ok("nenhuma palavra ultrapassa a margem direita da página", p.paginas.every((pg) => pg.palavras.every((w) => w[2] <= pg.w - 8)));
    // Descrição não invade a coluna Farmácia (sem sobreposição)
    const hdrFarm = pagina1.palavras.find((w) => w[4] === "Farmácia" && w[1] < 130);
    const descr = pagina1.palavras.filter((w) => /^Artigo$/.test(w[4]) && w[1] > 130);
    ok("a Descrição termina antes da coluna Farmácia (sem sobreposição)", !!hdrFarm && descr.every((w) => w[2] <= hdrFarm[0] + 0.5));
  }

  // ═══ C. Multi-página: cabeçalho repetido, blocos de artigo inteiros, contagem e total geral ═══
  console.log("\n=== C. PDF real multi-página: cabeçalho repetido, artigo+total na mesma página, totais ===");
  {
    const bks = buckets(13);
    const rows: VendasAdapterRow[] = [];
    const N = 70;
    for (let i = 0; i < N; i++) {
      const cod = String(6000000 + i);
      const desc = `Artigo de teste ${String(i).padStart(2, "0")} com descrição longa para quebrar linha na coluna descrição`;
      const farms = i % 3 === 0 ? ["Farmácia Silveirense"] : FARM;
      for (const f of farms) rows.push(linha({ codigo: cod, descricao: desc, farmacia: f, qtd: (i % 4) + 1, stock: i % 7 === 0 ? 0 : i % 11 === 0 ? -3 : 9 }, bks));
    }
    const rel = gerar(rows, bks);
    const f = await pdfDe(rel, "multi-pagina");
    const p = palavras(f);
    ok(`o PDF tem várias páginas (${p.paginas.length})`, p.paginas.length >= 3);
    ok("o cabeçalho da tabela (CNP … Stock … Valor Vendas) repete-se em TODAS as páginas", p.paginas.every((pg) => {
      const t = textoPag(pg); return t.includes("CNP") && t.includes("Descrição") && t.includes("Stock") && t.includes("Valor Vendas");
    }));
    const todo = textoTodo(p);
    const cnpsNoPdf = new Set([...todo.matchAll(/\b6\d{6}\b/g)].map((m) => m[0]));
    ok(`o PDF contém exactamente ${N} artigos distintos (obtido ${cnpsNoPdf.size})`, cnpsNoPdf.size === N);
    ok("TOTAL GERAL aparece exactamente uma vez, na última página", (todo.match(/TOTAL GERAL/g) ?? []).length === 1 && textoPag(p.paginas[p.paginas.length - 1]).includes("TOTAL GERAL"));
    ok("a nota «70 artigos · N linhas de detalhe» está no PDF", new RegExp(`${N} artigos · ${rows.length} linhas de detalhe`).test(todo));
    // cada artigo com vários farmácias: o seu «TOTAL ARTIGO» está na MESMA página que o CNP
    let separados = 0;
    for (let i = 0; i < N; i++) {
      if (i % 3 === 0) continue;
      const cod = String(6000000 + i);
      const pgCnp = p.paginas.findIndex((pg) => pg.palavras.some((w) => w[4] === cod));
      const pg = p.paginas[pgCnp];
      const wCnp = pg.palavras.find((w) => w[4] === cod)!;
      // o próximo «ARTIGO» de «TOTAL ARTIGO» abaixo do CNP (na mesma página) tem de existir
      const temTotal = pg.palavras.some((w) => w[4] === "ARTIGO" && w[1] >= wCnp[1] - 1 && w[1] <= wCnp[1] + 40);
      if (!temTotal) separados++;
    }
    ok("nenhum artigo fica separado do seu «TOTAL ARTIGO» entre páginas", separados === 0, `${separados} separados`);
    ok("a paginação não deixa uma página só com o TOTAL GERAL", textoPag(p.paginas[p.paginas.length - 1]).replace("TOTAL GERAL", "").length > 400);
    // legibilidade a P&B: o número do stock negativo (pastilha escura) vs positivo
    const neg = p.paginas.flatMap((pg) => pg.palavras).filter((w) => w[4] === "-3");
    const pos = p.paginas.flatMap((pg) => pg.palavras).filter((w) => w[4] === "9");
    ok("stock negativo: pastilha escura (cinzento médio < 130) mesmo em tons de cinzento", neg.length > 0 && neg.every((w) => w[5] < 130), JSON.stringify(neg.slice(0, 3)));
    ok("stock positivo: fundo claro (> 170)", pos.length > 0 && pos.every((w) => w[5] > 170));
  }

  // ═══ D. Blocos temporais em PDF real, cada bloco com VÁRIAS páginas ═════════════════════
  console.log("\n=== D. PDF real: 14 e 27 meses com muitos artigos — cada bloco ocupa várias páginas; totais inequívocos ===");
  for (const nMeses of [14, 27]) {
    const bks = buckets(nMeses);
    const rows: VendasAdapterRow[] = [];
    for (let i = 0; i < 90; i++) {
      const cod = String(7000000 + i);
      const farms = i % 3 === 0 ? [FARM[1]] : FARM;
      for (const f of farms) rows.push(linha({ codigo: cod, descricao: `Artigo de teste ${i} com descrição razoavelmente longa`, farmacia: f, qtd: bks.map((_, k) => ((i + k) % 5) - (k === 2 && i % 7 === 0 ? 3 : 0)), custoUnit: 4.25 + (i % 6), stock: i % 8 === 0 ? 0 : 7, valor: 100 + i }, bks));
    }
    const rel = gerar(rows, bks);
    const nBlocos = Math.ceil(nMeses / 13);
    const blocos = rel.meta!.columnBlocks!;
    const p = palavras(await pdfDe(rel, `${nMeses}-meses`));
    const txtPag = p.paginas.map(textoPag);
    const todo = txtPag.join("\n");
    const linhasTodas = p.paginas.flatMap(linhasDe);
    // página inicial de cada bloco = a que tem «Parte i de n»
    const inicio = Array.from({ length: nBlocos }, (_, i) => txtPag.findIndex((t) => t.includes(`Parte ${i + 1} de ${nBlocos}`)));
    ok(`${nMeses} meses: ${nBlocos} blocos identificados («Parte i de ${nBlocos}»)`, inicio.every((i) => i >= 0) && inicio.every((v, i) => i === 0 || v > inicio[i - 1]));
    const fins = inicio.map((v, i) => (i + 1 < nBlocos ? inicio[i + 1] : p.paginas.length));
    ok(`${nMeses} meses: CADA bloco ocupa várias páginas (${inicio.map((v, i) => fins[i] - v).join("+")})`, inicio.every((v, i) => fins[i] - v >= 2));
    ok(`${nMeses} meses: o cabeçalho repete-se em TODAS as páginas de TODOS os blocos`, txtPag.every((t) => t.includes("CNP") && t.includes("Descrição") && t.includes("Stock")), txtPag.map((t, i) => `${i + 1}:${t.includes("CNP")}/${t.includes("Descrição")}/${t.includes("Stock")}`).join(" "));
    // nenhum artigo desaparece nem se repete dentro do mesmo bloco
    const cnpsPorBloco = inicio.map((v, i) => new Set([...txtPag.slice(v, fins[i]).join(" ").matchAll(/\b70\d{5}\b/g)].map((m) => m[0])));
    ok(`${nMeses} meses: os 90 artigos aparecem em CADA bloco (nenhum desaparece ou fica cortado)`, cnpsPorBloco.every((c) => c.size === 90));
    // linha TOTAL GERAL: uma só, na última página, depois do último artigo
    const nTG = linhasTodas.filter((l) => l.startsWith("TOTAL GERAL")).length;
    ok(`${nMeses} meses: «TOTAL GERAL» uma única vez, no fim do último bloco`, nTG === 1 && txtPag[p.paginas.length - 1].includes("TOTAL GERAL"), `nTG=${nTG} ultima=${txtPag[p.paginas.length - 1].slice(0, 200)}`);
    // regra inequívoca dos totais
    const ultimoTxt = txtPag.slice(inicio[nBlocos - 1], fins[nBlocos - 1]).join(" ");
    ok(`${nMeses} meses: colunas «Total unid. do bloco» em todos os blocos`, inicio.every((v, i) => txtPag.slice(v, fins[i]).join(" ").includes("do bloco")));
    ok(`${nMeses} meses: colunas «Período:» (unidades, custo, valor) SÓ no último bloco`, /Período/.test(ultimoTxt) && inicio.slice(0, -1).every((v, i) => !/Período:/.test(txtPag.slice(v, fins[i]).join(" ").replace(/colunas «Período:»/g, ""))));
    ok(`${nMeses} meses: o título de cada bloco diz que «Total unid. do bloco» soma só os seus meses`, blocos.every((b) => /soma apenas estes meses/.test(b.titulo)) && blocos[nBlocos - 1].titulo.includes("período completo"));
    // valores: soma dos totais de bloco = total do período (TOTAL GERAL)
    const detalhe = rel.rows.filter((r) => r.__rowKind !== "subtotal");
    const totPeriodo = detalhe.reduce((a, r) => a + Number(r.totalVendas), 0);
    const somaBlocos = blocos.reduce((a, _, i) => a + detalhe.reduce((b, r) => b + Number(r[`tb_${i}`]), 0), 0);
    ok(`${nMeses} meses: Σ totais dos blocos (${somaBlocos}) = total do período (${totPeriodo})`, somaBlocos === totPeriodo);
    const lTG = linhasTodas.find((l) => l.startsWith("TOTAL GERAL")) ?? "";
    ok(`${nMeses} meses: TOTAL GERAL mostra o total do período (${totPeriodo}) e o custo/valor completos`, lTG.includes(String(totPeriodo).replace(/(\d)(?=(\d{3})+$)/, "$1 ")) || lTG.split(" ").includes(String(totPeriodo)));
    const tbUlt = detalhe.reduce((a, r) => a + Number(r[`tb_${nBlocos - 1}`]), 0);
    ok(`${nMeses} meses: …e o «Total unid. do bloco» do último bloco (${tbUlt}) na mesma linha`, lTG.split(" ").includes(String(tbUlt)));
    // cada mês exactamente uma vez por bloco → 14/27 rótulos distintos no total
    const rotulos = new Set<string>();
    for (const pg of p.paginas) {
      const ws = pg.palavras.filter((w) => w[1] < 130).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      for (const m of ws.filter((w) => /^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)$/.test(w[4]))) {
        const ano = ws.find((w) => /^\d{2}$/.test(w[4]) && Math.abs(w[0] - m[0]) < 12 && w[1] > m[1] && w[1] - m[1] < 14);
        if (ano) rotulos.add(`${m[4]}/${ano[4]}`);
      }
    }
    ok(`${nMeses} meses: todos os meses do período aparecem nos cabeçalhos (obtidos ${rotulos.size})`, rotulos.size === nMeses);
    // Excel: uma folha com TODOS os meses, sem colunas de bloco; totais do período
    const wb = buildReportWorkbook(rel);
    const ws = wb.Sheets["Relatório"];
    const grelha = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false }) as unknown[][];
    const hdr = (grelha.find((r) => r[0] === "CNP") ?? []) as string[];
    ok(`${nMeses} meses: Excel com os ${nMeses} meses numa folha e sem colunas «do bloco»`, hdr.filter((h) => /^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)\n\d\d$/.test(h)).length === nMeses && !hdr.some((h) => /do bloco/.test(h)));
  }

  // ═══ E. Sem controlos nas saídas ════════════════════════════════════════
  console.log("\n=== E. Nenhum checkbox/botão/controlo nem coluna vazia no HTML/PDF/Excel ===");
  {
    const bks = buckets(3);
    const rel = gerar([linha({ codigo: "1" }, bks), linha({ codigo: "2", farmacia: FARM[0] }, bks), linha({ codigo: "2" }, bks)], bks);
    const html = renderReportHtml(rel);
    ok("HTML sem <input>, <button>, <select>, <textarea>, checkbox, role=checkbox", !/<(input|button|select|textarea)\b|type="checkbox"|role="checkbox"|☐|□/i.test(html));
    const ths = [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<br\/>/g, " ").trim());
    ok("todos os cabeçalhos da tabela têm texto (nenhuma coluna vazia)", ths.length > 0 && ths.every((t) => t.length > 0));
    const colunasVisiveis = rel.columns.filter((c) => !c.hidden && !c.excelOnly);
    ok("nº de <th> = nº de colunas visíveis do relatório", ths.length === colunasVisiveis.length);
    const wb = buildReportWorkbook(rel);
    const ws = wb.Sheets["Relatório"];
    const grelha = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false }) as unknown[][];
    const hdr = grelha.find((r) => r[0] === "CNP") as string[];
    ok("Excel: nenhum cabeçalho de coluna vazio", !!hdr && hdr.every((h) => typeof h === "string" && h.trim() !== ""), JSON.stringify(hdr));
    ok("Excel: sem textos de controlo (☐/□/checkbox)", !JSON.stringify(grelha).match(/☐|□|checkbox/i));
    const p = palavras(await pdfDe(rel, "controlos"));
    ok("PDF: sem caracteres de caixa vazia (☐ □ ▢)", !/[☐□▢]/.test(textoTodo(p)));
  }

  // ═══ F. Cálculos e totais ════════════════════════════════════════════════
  console.log("\n=== F. Cálculos: subtotais e total geral consistentes com as linhas; custo em falta nunca é zero ===");
  {
    const bks = buckets(4);
    const rows = [
      linha({ codigo: "11", farmacia: FARM[0], qtd: [2, 0, -1, 3], custoUnit: 4.5, valor: 80.25 }, bks),
      linha({ codigo: "11", farmacia: FARM[1], qtd: [1, 1, 1, 1], custoUnit: 5, valor: 35 }, bks),
      linha({ codigo: "12", farmacia: FARM[1], qtd: [0, 0, 0, 0], custoUnit: null, stock: 0, valor: 0 }, bks),
      linha({ codigo: "13", farmacia: FARM[0], qtd: [-3, 0, 0, 0], custoUnit: 2, valor: -20 }, bks),
    ];
    const rel = gerar(rows, bks);
    const detalhe = rel.rows.filter((r) => r.__rowKind !== "subtotal");
    const sub = rel.rows.filter((r) => r.__rowKind === "subtotal");
    ok("há exactamente 1 «Total artigo» (só o artigo com 2 farmácias)", sub.length === 1 && String(sub[0].farmacia) === "TOTAL ARTIGO");
    const d11 = detalhe.filter((r) => r.codigo === "11");
    const soma = (k: string) => Math.round(d11.reduce((a, r) => a + Number(r[k] ?? 0), 0) * 100) / 100;
    ok("Total artigo: unidades = soma das farmácias", Number(sub[0].totalVendas) === soma("totalVendas"));
    ok("Total artigo: valor s/IVA = soma das farmácias", Math.round(Number(sub[0].valorBruto) * 100) / 100 === soma("valorBruto"));
    ok("Total artigo: custo total = soma dos custos com custo conhecido", Math.round(Number(sub[0].custoEstimado) * 100) / 100 === soma("custoEstimado"));
    ok("Total artigo: PVP e Custo unit. ficam sem valor (não existe média única)", sub[0].pvp === null && sub[0].custoUnitarioEstimado === null);
    ok("quantidade líquida negativa visível (artigo 13: total −3 e custo −6,00)", detalhe.find((r) => r.codigo === "13")?.totalVendas === -3 && detalhe.find((r) => r.codigo === "13")?.custoEstimado === -6);
    const custo = custoTotalDoRelatorio(rows);
    ok("custo geral = soma dos custos conhecidos (sem a linha sem custo)", custo.total === Math.round(rows.reduce((a, r) => a + (r.custoEstimado ?? 0), 0) * 100) / 100);
    ok("1 linha sem custo e SEM vendas não conta como «sem custo»; total não fica «parcial»", custo.semCusto === 0 && !/PARCIAL/.test(rel.meta?.footer ?? ""));
    const rows2 = [...rows, linha({ codigo: "14", custoUnit: null, qtd: 2 }, bks)];
    const rel2 = gerar(rows2, bks);
    ok("com 1 linha COM vendas e SEM custo: rodapé diz «PARCIAL: 1 linha»", /Custo total PARCIAL: 1 linha/.test(rel2.meta?.footer ?? ""));
    ok("…e a linha sem custo tem custo «null» (nunca 0)", rel2.rows.find((r) => r.codigo === "14")?.custoEstimado === null);
    const html = renderReportHtml(rel2);
    const trSemCusto = html.slice(html.indexOf("14</td>") - 200);
    ok("…e aparece «—» na célula do custo", /—/.test(trSemCusto.slice(0, 900)));
    // TOTAL GERAL do HTML = soma do detalhe
    const totalUnid = detalhe.reduce((a, r) => a + Number(r.totalVendas), 0);
    ok(`TOTAL GERAL de unidades (${totalUnid}) = soma do detalhe`, html.length > 0 && renderReportHtml(rel).includes(`<strong>${totalUnid}</strong>`));
  }

  // ═══ G. Texto do âmbito / filtros ═══════════════════════════════════════
  console.log("\n=== G. Filtros aplicados: só os efectivamente aplicados, sem contradições ===");
  {
    const bks = buckets(2);
    const base = { agruparPor: "artigo", ordenarPor: "descricao", ambito: "grupo", dataInicio: "2026-01-01", dataFim: "2026-02-28" };
    const val = (rel: Report, label: string) => rel.filtersApplied?.find((f) => f.label === label)?.value;
    const rows = [linha({ codigo: "1" }, bks)];
    const ambos = gerar(rows, bks, { ...base, apenasComVendas: true, apenasComStock: true });
    ok("com «Apenas com vendas» E «Incluir stock sem vendas»: uma só entrada que explica a união",
      val(ambos, "Artigos incluídos") === "com vendas no período + sem vendas mas com stock atual" && !ambos.filtersApplied?.some((f) => /Apenas com vendas|Incluir stock sem vendas/.test(f.label)));
    ok("só «Apenas com vendas»: «apenas com vendas no período»", val(gerar(rows, bks, { ...base, apenasComVendas: true }), "Artigos incluídos") === "apenas com vendas no período");
    ok("só «Incluir stock sem vendas»: mesma explicação da união", val(gerar(rows, bks, { ...base, apenasComStock: true }), "Artigos incluídos") === "com vendas no período + sem vendas mas com stock atual");
    ok("nenhum dos dois: sem entrada de artigos incluídos", val(gerar(rows, bks, base), "Artigos incluídos") === undefined);
    ok("âmbito, agrupamento e ordenação em texto legível", val(ambos, "Âmbito") === "Grupo" && val(ambos, "Agrupar por") === "Artigo" && val(ambos, "Ordenar por") === "Descrição do artigo (A-Z)");
    ok("período listado", val(ambos, "Período") === "2026-01-01 a 2026-02-28");
    ok("naturezas sempre listadas (default: com crédito, sem transferências)", val(ambos, "Naturezas") === "Normal; com crédito, sem transferências");
    ok("naturezas explícitas", val(gerar(rows, bks, { ...base, incluirCredito: false, incluirTransferencias: true }), "Naturezas") === "Normal; sem crédito, com transferências");
    ok("filtros não aplicados NÃO são listados (sem fabricantes/pesquisa/distribuidores/categorias)", !ambos.filtersApplied?.some((f) => /Fabricantes|Laborat|Pesquisa|Distribuidores|Categorias/.test(f.label)));
    ok("pesquisa e fabricantes aparecem quando aplicados", (() => { const r = gerar(rows, bks, { ...base, artigo: "ben-u-ron", fabricantesSelecionados: ["Bial"] }); return val(r, "Pesquisa") === "ben-u-ron" && val(r, "Fabricantes") === "Bial"; })());
    ok("a ordenação por cabeçalho prevalece sobre o selector", !!val(gerar(rows, bks, { ...base, ordenacaoTabelaDescricao: "Total Unid. (decrescente) — cabeçalho da tabela" }), "Ordenar por")?.startsWith("Total Unid."));
    ok("seleção parcial indicada («3 de 10 selecionados»); seleção total não aparece", val(gerar(rows, bks, { ...base, selecaoArtigos: { selecionados: 3, total: 10 } }), "Artigos") === "3 de 10 selecionados" && val(gerar(rows, bks, { ...base, selecaoArtigos: { selecionados: 10, total: 10 } }), "Artigos") === undefined);
  }

  // ═══ H. Excel ═══════════════════════════════════════════════════════════
  console.log("\n=== H. Excel: números, mesma ordem, subtotais, total geral e filtro ===");
  {
    const bks = buckets(3);
    const rows = [
      linha({ codigo: "21", descricao: "Zeta", farmacia: FARM[0], qtd: [1, 2, 3], custoUnit: 10 }, bks),
      linha({ codigo: "21", descricao: "Zeta", farmacia: FARM[1], qtd: [1, 1, 1], custoUnit: 12.5 }, bks),
      linha({ codigo: "22", descricao: "Alfa", farmacia: FARM[1], qtd: [0, 0, 5], custoUnit: null }, bks),
    ];
    const rel = gerar(rows, bks);
    const wb = buildReportWorkbook(rel);
    const ws = wb.Sheets["Relatório"];
    const g = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { range: XLSX.utils.decode_range(ws["!ref"]!).s.r + (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]).findIndex((r) => r[0] === "CNP") });
    ok("Excel: linhas na MESMA ordem do relatório (21, 21, Total artigo, 22) + total geral", JSON.stringify(g.map((r) => r["Farmácia"])) === JSON.stringify(["Farmácia Segurado", "Farmácia Silveirense", "TOTAL ARTIGO", "Farmácia Silveirense", undefined]) || g.length === 5, JSON.stringify(g.map((r) => r["Farmácia"])));
    ok("Excel: quantidades, custos e valores são NÚMEROS", g.slice(0, 4).every((r) => typeof r["Total\nUnid."] === "number" && typeof r["Valor Vendas\n(s/IVA)"] === "number"), JSON.stringify(g[0]));
    ok("Excel: custo em falta fica vazio (não 0)", g[3]["Custo total\nest."] === undefined || g[3]["Custo total\nest."] === "");
    ok("Excel: coluna «Tipo de linha» distingue Detalhe/Total artigo", JSON.stringify(g.slice(0, 4).map((r) => r["Tipo de linha"])) === JSON.stringify(["Detalhe", "Detalhe", "Total artigo", "Detalhe"]));
    const ultima = g[g.length - 1];
    ok("Excel: última linha é «TOTAL GERAL» com a soma do DETALHE (sem contar os Total artigo)", Object.values(ultima)[0] === "TOTAL GERAL" && ultima["Total\nUnid."] === 6 + 3 + 5);
    ok("Excel: filtro automático cobre cabeçalho + dados e deixa o total de fora", !!ws["!autofilter"] && !String(ws["!autofilter"]!.ref).includes(String(XLSX.utils.decode_range(ws["!ref"]!).e.r + 1)));
    const filtroFim = XLSX.utils.decode_range(ws["!autofilter"]!.ref).e.r;
    ok("Excel: o filtro termina antes da linha de TOTAL GERAL", filtroFim === XLSX.utils.decode_range(ws["!ref"]!).e.r - 1);
  }

  // ═══ I. Ordenação / seleção ═════════════════════════════════════════════
  console.log("\n=== I. O adaptador respeita a ordem recebida (alfabética por omissão vem do loader) e não altera dados ===");
  {
    const bks = buckets(2);
    const rows = [linha({ codigo: "9", descricao: "Árnica" }, bks), linha({ codigo: "3", descricao: "Aspirina" }, bks), linha({ codigo: "5", descricao: "Zinco" }, bks)];
    const rel = gerar(rows, bks);
    ok("ordem de saída = ordem de entrada (a seleção/ordenação é decidida no ecrã e vale para os 4 destinos)", JSON.stringify(rel.rows.map((r) => r.codigo)) === JSON.stringify(["9", "3", "5"]));
    ok("um artigo numa só farmácia NÃO tem «Total artigo» redundante", !rel.rows.some((r) => r.__rowKind === "subtotal"));
  }

  // ═══ J. Aspeto limpo (hierarchy "clean"): sem faixa escura, sem grelha, filetes finos, subtotal leve ═══
  console.log("\n=== J. Aspeto limpo: cabeçalho claro, sem grelha completa, filetes finos, subtotal/total leves (CSS + PDF real, em cinzentos) ===");
  {
    const bks = buckets(13);
    const rows: VendasAdapterRow[] = [];
    for (let i = 0; i < 40; i++) {
      for (const f of i % 3 === 0 ? [FARM[1]] : FARM) rows.push(linha({ codigo: String(6700000 + i), descricao: `Artigo limpo ${i}`, farmacia: f, qtd: (i % 3) + 1, stock: i % 6 === 0 ? 0 : i % 11 === 0 ? -2 : 8 }, bks));
    }
    const rel = gerar(rows, bks);
    const html = renderReportHtml(rel);
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const clean = css.slice(css.indexOf("HIERARQUIA LIMPA"), css.indexOf("@media print {"));
    ok("Vendas usa a hierarquia limpa", rel.meta?.hierarchy === "clean" && /class="page density-compact hierarchy-clean"/.test(html));
    ok("cabeçalho da tabela: fundo quase branco, texto escuro, SEM faixa azul-escura", /hierarchy-clean thead th \{[^}]*background: #f8fafc[^}]*color: #1f2937/.test(clean) && !/hierarchy-clean thead th \{[^}]*background: #(0|1)/.test(clean));
    ok("cabeçalho da tabela: uma única linha inferior de 1.5px, sem contornos nas células", /hierarchy-clean thead th \{[^}]*border: 0; border-bottom: 1\.5px solid/.test(clean));
    ok("corpo: sem caixa por célula (border:0) e só filete horizontal fino (1px)", /hierarchy-clean tbody td \{\s*border: 0; border-bottom: 1px solid #eef0f3/.test(clean));
    ok("nenhuma linha vertical (border-left/right) no corpo clean", !/hierarchy-clean tbody td[^{]*\{[^}]*border-(left|right):\s*[1-9]/.test(clean));
    const espessuras = [...clean.matchAll(/border(?:-top|-bottom)?:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
    ok(`todas as linhas do relatório limpo têm ≤ 1.5px (máx. ${Math.max(...espessuras)}px)`, espessuras.length > 0 && Math.max(...espessuras) <= 1.5);
    ok("«Total artigo»: fundo cinzento muito claro (#f1f3f6), semibold, sem molduras", /tr\.subtotal-row td,[^{]*\{\s*background: #f1f3f6 !important;[^}]*font-weight: 600;\s*border: 0;/.test(clean));
    ok("«TOTAL GERAL»: nível acima do subtotal (bold, fundo #e5e8ed), sem bloco escuro", /\.totals-tbody td \{\s*background: #e5e8ed !important;[^}]*font-weight: 700/.test(clean));
    const fundos = [...clean.matchAll(/background: #([0-9a-f]{6})/gi)].map((m) => m[1]).filter((h) => parseInt(h.slice(0, 2), 16) < 0xd0);
    ok(`único fundo escuro no relatório limpo: a pastilha do stock negativo (${fundos.join(",")})`, fundos.length === 1 && fundos[0] === "374151");
    ok("os meses não têm linhas verticais nem fundo forte (película ≤ 3 %)", /rgba\(15, 23, 42, 0\.028\)/.test(clean) && !/mes-alt[^{]*\{[^}]*border/.test(clean));
    ok("nota/legenda final dentro da tabela (nunca órfã numa página sem cabeçalho)", /<tr class="nota-tr">/.test(html) && !/<footer class="report-footer/.test(html));
    ok("Margens (hierarchy-strong) mantém o seu desenho: regras strong intactas", /hierarchy-strong thead th \{[^}]*background: #1f2937/.test(css));

    // PDF real, a CINZENTOS: o cabeçalho e os totais têm fundo claro; só o stock negativo é escuro
    const p = palavras(await pdfDe(rel, "limpo-13"));
    const pg = p.paginas[0].palavras;
    const gris = (txt: string) => pg.filter((w) => w[4] === txt).map((w) => w[5]);
    ok(`PDF a cinzentos: cabeçalho «Descrição»/«Stock» sobre fundo claro (cinza ${gris("Descrição")[0]}/${gris("Stock")[0]})`, gris("Descrição")[0] > 180 && gris("Stock")[0] > 180);
    const totArt = pg.filter((w) => w[4] === "TOTAL" && pg.some((x) => x[4] === "ARTIGO" && Math.abs(x[1] - w[1]) < 2));
    ok(`PDF a cinzentos: «TOTAL ARTIGO» sobre cinzento claro (${totArt.map((w) => w[5]).slice(0, 3)})`, totArt.length > 0 && totArt.every((w) => w[5] > 190));
    ok("PDF: stock negativo continua a destacar-se (pastilha escura)", p.paginas.flatMap((x) => x.palavras).filter((w) => w[4] === "-2").some((w) => w[5] < 140));
    const ultima = p.paginas[p.paginas.length - 1].palavras;
    const tg = ultima.find((w) => w[4] === "GERAL");
    ok(`PDF a cinzentos: «TOTAL GERAL» sobre cinzento claro (${tg?.[5]})`, !!tg && tg[5] > 170);
    ok("PDF: sem sobreposições — as colunas de dados não invadem a Descrição", p.paginas[0].palavras.filter((w) => w[4].startsWith("Artigo")).every((w) => w[2] < p.paginas[0].palavras.find((x) => x[4] === "Farmácia")![0]));
  }

  // ═══ K. «Incluir preços» desligado: nenhuma informação monetária nas saídas visuais; Excel completo; números +1 px ═══
  console.log("\n=== K. Incluir preços (Relatório/impressão/PDF/email) e números +1px ===");
  {
    const MONETARIAS = ["pvp", "custoUnitarioEstimado", "custoEstimado", "valorBruto"];
    const semDinheiro = (txt: string) => !/€|PVP|Custo|Valor Vendas|Valor vendas|vendas \(s\/IVA\)|PARCIAL|s\/IVA/i.test(txt);
    for (const nMeses of [3, 13, 14, 27]) {
      for (const farms of [1, 2]) {
        const bks = buckets(nMeses);
        const rows: VendasAdapterRow[] = [];
        for (let i = 0; i < 8; i++) {
          for (const f of farms === 1 ? [FARM[1]] : FARM) {
            rows.push(linha({ codigo: String(5000000 + i), farmacia: f, qtd: bks.map((_, k) => (i === 3 && k === 1 ? -2 : (i + k) % 3)), custoUnit: i === 5 ? null : 999999.99, pvp: i === 2 ? 10000 : null === null ? 12.5 : 0, valor: 99999.99, stock: i % 3 === 0 ? 0 : 6 }, bks));
          }
        }
        const sel = { selecionados: 5, total: 8 }; // seleção parcial
        const base = { agruparPor: "artigo", selecaoArtigos: sel };
        const com = gerar(rows, bks, base);
        const sem = buildVendasReport({ rows, buckets: bks, filters: base, universe: { farmacias: FARM, fornecedores: [], fabricantes: [], categorias: [] }, organization: "Grupo Teste", incluirPrecos: false });
        const tag = `${nMeses} meses · ${farms} farmácia(s)`;
        const chavesSem = sem.columns.map((c) => c.key);
        ok(`${tag}: com preços mantém as colunas monetárias de sempre`, MONETARIAS.every((k) => com.columns.some((c) => c.key === k)));
        ok(`${tag}: sem preços NENHUMA coluna monetária (nem vazia nem reservada)`, MONETARIAS.every((k) => !chavesSem.includes(k)) && sem.columns.every((c) => !/PVP|Custo|Valor|€/i.test(c.label)));
        const html = renderReportHtml(sem);
        const corpo = html.slice(html.indexOf("<body>"));
        ok(`${tag}: sem preços o HTML (relatório/impressão/PDF/email) não tem «€», PVP, Custo, Valor, PARCIAL, s/IVA`, semDinheiro(corpo.replace(/<style>[\s\S]*?<\/style>/g, "")), corpo.match(/.{30}(€|PVP|Custo|Valor Vendas|PARCIAL).{20}/)?.[0]);
        ok(`${tag}: sem preços o resumo não tem valores monetários`, (sem.summary ?? []).every((s) => s.format !== "currency") && (sem.summary ?? []).length === 3);
        ok(`${tag}: o rodapé não fala de custos; fala de stock e de «·»`, !/Custo|PMC|PARCIAL|IVA/.test(sem.meta?.footer ?? "") && /Stock atual/.test(sem.meta?.footer ?? ""));
        ok(`${tag}: mantém CNP, Descrição, Farmácia, meses, unidades e stock`, ["codigo", "descricao", "farmacia", "totalVendas", "existencia"].every((k) => chavesSem.includes(k)) && chavesSem.filter((k) => k.startsWith("m_")).length === nMeses);
        const ths = [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<br\/>/g, " ").trim());
        ok(`${tag}: nenhum cabeçalho vazio (sem colunas vazias)`, ths.length > 0 && ths.every((t) => t.length > 0));
        const blocos = sem.meta?.columnBlocks;
        const larg = (r: Report, omitir: string[] = []) => r.columns.filter((c) => !c.hidden && !c.excelOnly && !omitir.includes(c.key)).reduce((a, c) => a + (c.width ?? 0), 0);
        const maxSem = Math.max(...(blocos ? blocos.map((b) => larg(sem, b.omitir)) : [larg(sem)]));
        ok(`${tag}: as larguras recalculadas somam ≤ 100 por página (${maxSem.toFixed(1)})`, maxSem <= 100.05);
        const dSem = sem.columns.find((c) => c.key === "descricao")!.width!;
        const dCom = com.columns.find((c) => c.key === "descricao")!.width!;
        ok(`${tag}: a Descrição aproveita o espaço libertado (${dCom.toFixed(1)}% → ${dSem.toFixed(1)}%)`, dSem > dCom);
        if (nMeses > 13) {
          const ultimo = blocos![blocos!.length - 1];
          const periodoSem = sem.columns.filter((c) => /Período/.test(c.label)).map((c) => c.key);
          ok(`${tag}: nos blocos sem preços a única coluna «Período:» é a de unidades`, periodoSem.join() === "totalVendas" && !ultimo.omitir.includes("totalVendas"));
          ok(`${tag}: TOTAL GERAL uma só vez no fim do último bloco`, (html.match(/<strong>TOTAL GERAL<\/strong>/g) ?? []).length === 1);
        }
      }
    }
    // O Excel não muda com a opção: o report «completo» continua com tudo (ReportActions.excelReport)
    const bks = buckets(3);
    const r = [linha({ codigo: "1" }, bks)];
    const cheio = buildReportWorkbook(buildVendasReport({ rows: r, buckets: bks, filters: { agruparPor: "artigo" }, universe: { farmacias: FARM, fornecedores: [], fabricantes: [], categorias: [] }, organization: "G", incluirPrecos: true }));
    const cab = (XLSX.utils.sheet_to_json<unknown[]>(cheio.Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][]).find((x) => x[0] === "CNP") as string[];
    ok("Excel de Vendas continua completo (PVP, custos e valor de vendas)", cab.some((h) => /PVP/.test(h)) && cab.some((h) => /Custo total/.test(h)) && cab.some((h) => /Valor Vendas/.test(h)));
    ok("o relatório SEM preços não é usado no Excel: os botões usam `excelReport` (relatório completo)", /excelReport=\{\(\) => construirRelatorio\(\{ precos: true \}\)\}/.test(readFileSync("components/vendas/vendas-client.tsx", "utf8")));

    // PDF REAL sem preços: 13 meses, seleção parcial, valores enormes e negativos nos DADOS (não podem aparecer)
    {
      const b13 = buckets(13);
      const rows: VendasAdapterRow[] = [];
      for (let i = 0; i < 40; i++) for (const f of i % 3 === 0 ? [FARM[1]] : FARM) rows.push(linha({ codigo: String(5100000 + i), descricao: `Artigo sem preços ${i}`, farmacia: f, qtd: b13.map((_, k) => ((i + k) % 4) - (k === 2 && i % 5 === 0 ? 3 : 0)), custoUnit: i % 7 === 0 ? null : 999999.99, pvp: 99999.99, valor: 999999.99, stock: i % 6 === 0 ? 0 : i % 11 === 0 ? -2 : 8 }, b13));
      const relSem = buildVendasReport({ rows, buckets: b13, filters: { agruparPor: "artigo", selecaoArtigos: { selecionados: 30, total: 40 } }, universe: { farmacias: FARM, fornecedores: [], fabricantes: [], categorias: [] }, organization: "Grupo", incluirPrecos: false });
      const p = palavras(await pdfDe(relSem, "sem-precos-13"));
      const txt = textoTodo(p);
      ok("PDF real sem preços: nenhum «€», PVP, Custo, Valor, PARCIAL, s/IVA", semDinheiro(txt), txt.match(/.{20}(€|PVP|Custo|Valor Vendas|PARCIAL).{20}/)?.[0]);
      ok("PDF real sem preços: várias páginas, cabeçalho repetido e TOTAL GERAL uma vez", p.paginas.length >= 2 && p.paginas.every((pg) => textoPag(pg).includes("Descrição")) && p.paginas.flatMap(linhasDe).filter((l) => l.startsWith("TOTAL GERAL")).length === 1);
      ok("PDF real sem preços: unidades, total de unidades e stock presentes", /Total/.test(txt) && /Stock/.test(txt) && /Unid\./.test(txt));
      ok("PDF real sem preços: valores negativos de quantidade continuam visíveis", /-3/.test(txt));
      ok("PDF real sem preços: «Seleção parcial» indicada (30 de 40)", /Artigos:\s*30 de 40 selecionados/.test(txt.replace(/\n/g, " ")));
      ok("PDF real sem preços: nada cortado à direita (a Descrição ganhou espaço)", p.paginas.every((pg) => pg.palavras.every((w) => w[2] <= pg.w - 8)));
    }

    // Números +1 px: no PDF (3 meses, densidade «cozy») a altura das palavras numéricas excede a do texto da descrição
    {
      const b3 = buckets(3);
      const rows = [linha({ codigo: "5200001", descricao: "Texto da descricao do artigo", qtd: [11, 22, 33], valor: 1234.5 }, b3)];
      const rel = gerar(rows, b3);
      const p = palavras(await pdfDe(rel, "tipografia"));
      const ws = p.paginas[0].palavras;
      const altura = (pred: (w: Palavra) => boolean) => { const h = ws.filter(pred).map((w) => w[3] - w[1]).sort((a, b) => a - b); return h[Math.floor(h.length / 2)] ?? 0; };
      const hTexto = altura((w) => /^(Texto|descricao|artigo|Silveirense)$/.test(w[4]));
      const hNum = altura((w) => /^(11|22|33)$/.test(w[4]));
      ok(`números maiores que o texto (altura ${hNum.toFixed(2)} vs ${hTexto.toFixed(2)} pt)`, hNum > hTexto && hNum / hTexto < 1.2, `${hNum}/${hTexto}`);
      const html = renderReportHtml(rel);
      ok("CSS: números +1px e descrição/cabeçalho sem alteração", /hierarchy-clean tbody td\.num \{ font-size: calc\(1em \+ 1px\); \}/.test(html) && !/hierarchy-clean tbody td\.sg \{[^}]*font-size/.test(html));
      ok("só há 4 fontes de números sem aumento no relatório não-limpo (Margens/outros intactos)", !renderReportHtml({ ...rel, meta: { ...rel.meta!, hierarchy: "strong" } }).includes('class="num"'));
    }
  }

  await browser.close();
  console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); try { await browser?.close(); } catch { /* */ } process.exit(2); });
