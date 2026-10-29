/**
 * scripts/tests/test-margens-pdf-modos.ts
 *
 * PDF e IMPRESSÃO de Margens nos 5 modos (Produto, Categoria, Farmácia, Grupo, Fabricante), com 1 e 3 farmácias e
 * stock positivo, zero, negativo e desconhecido. Gera o PDF real (Chromium → PDF, as mesmas opções de
 * lib/reporting/report-pdf-server.ts) e a impressão (o HTML do iframe de report-print.ts, `@page` sem cabeçalho nem
 * fundos) e lê o resultado com PyMuPDF (palavras + geometria). Afirma, por texto e por geometria:
 *   · a coluna «Stock» existe, UMA vez por página (cabeçalho repetido por página, nunca duplicado);
 *   · os valores da coluna Stock (linhas, TOTAL ARTIGO, TOTAL GERAL) são exatamente os esperados (calculados aqui,
 *     de forma independente do adapter);
 *   · todos os cabeçalhos aparecem inteiros (sem «…»), a cada página, e nenhuma palavra passa a margem direita;
 *   · nenhuma palavra se sobrepõe a outra (nada impresso duas vezes por cima);
 *   · «TOTAL GERAL» uma só vez (e «TOTAL ARTIGO» uma vez por artigo com 2+ farmácias);
 *   · a faixa de resumo («Unidades vendidas: N  Stock total: N …») está uma só vez, na 1.ª página, acima da tabela,
 *     com os valores certos e SEPARAÇÃO entre itens (não cola «42Stock total»);
 *   · o modo Produto: a faixa é o ÚNICO acréscimo ao HTML (isolada num bloco) e o CSS dela é o mesmo de Vendas (clean),
 *     escopado à hierarquia (nunca global); a regra de cabeçalhos a duas linhas só existe em hierarchy-strong.
 *
 * Opcional: MARGENS_PDF_MODOS_DIR=<pasta> guarda os PDFs gerados (para renderizar evidência). Corre com:
 *   npx tsx scripts/tests/test-margens-pdf-modos.ts
 */
import Module from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);

type Palavra = { x0: number; y0: number; x1: number; y1: number; t: string };
type Pagina = { w: number; h: number; ws: Palavra[] };
const MARGEM_PT = (8 / 25.4) * 72; // @page margin lateral: 8 mm
const sinal = (t: string) => t.replace(/[−–]/g, "-");

function palavrasDe(pdf: string): Pagina[] {
  const r = spawnSync("python", [path.resolve("scripts/tests/_palavras_pdf.py"), pdf], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python: ${r.stderr}`);
  const j = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { paginas: Array<{ w: number; h: number; palavras: Array<[number, number, number, number, string]> }> };
  return j.paginas.map((p) => ({ w: p.w, h: p.h, ws: p.palavras.map(([x0, y0, x1, y1, t]) => ({ x0, y0, x1, y1, t })) }));
}

async function main() {
  const { aggregate } = await import("../../lib/margens-data");
  const { buildMargensProdutoReport, buildMargensAggReport, stockDaLinhaAgregada, stockTotalDosAgregados } = await import("../../lib/reporting/adapters/margens");
  const { renderReportHtml } = await import("../../lib/reporting/report-html");
  type MargemRow = import("../../lib/margens-data").MargemRow;
  type Report = import("../../lib/reporting/report-types").Report;

  const TODAS = ["Farmácia Segurado", "Farmácia Silveirense", "Farmácia Terceira"];
  const CATS = ["Medicamentos", "Dermocosmética", "Higiene", "Nutrição"];
  const GRUPOS = ["Grupo A", "Grupo B", "Grupo C"];
  const FABS = ["Fab Um", "Fab Dois", "Fab Três", "Fab Quatro", "Fab Cinco"];
  const CICLO: Array<number | null> = [5, 0, -3, null, 12, 7, 0, 21, -1, 3];

  // ── dados sintéticos: artigo i em 3, 2 ou 1 farmácias; stock em ciclo (positivo, zero, negativo, desconhecido) ──
  type Esp = { rows: MargemRow[]; artigos: Array<{ stocks: Array<number | null> }>; uni: string[] };
  function dados(nArtigos: number, uni: string[]): Esp {
    const rows: MargemRow[] = [];
    const artigos: Esp["artigos"] = [];
    for (let i = 0; i < nArtigos; i++) {
      const nf = Math.min(uni.length, i % 3 === 0 ? 3 : i % 3 === 1 ? 2 : 1);
      const stocks: Array<number | null> = [];
      for (let f = 0; f < nf; f++) {
        const stock = CICLO[(i * 3 + f) % CICLO.length];
        stocks.push(stock);
        const qtd = 3 + ((i + f) % 7);
        const pvp = 5 + (i % 4);
        const valor = qtd * pvp;
        const semIva = Math.round((valor / 1.23) * 100) / 100;
        rows.push({
          produtoId: `p${i}`, cnp: 5000100 + i, designacao: `Artigo ${String(i + 1).padStart(2, "0")}`, categoria: CATS[i % CATS.length], grupo: GRUPOS[i % GRUPOS.length],
          farmaciaId: `f${f}`, farmacia: uni[f], fabricante: FABS[i % FABS.length],
          qtdVendida: qtd, pvpUnitario: pvp, valorVendido: valor, taxaIva: 23, valorVendidoSemIva: semIva,
          custoUnitario: 3, custoUnitarioBase: 3, custoEstimado: 3 * qtd, margemEur: Math.round((semIva - 3 * qtd) * 100) / 100, margemPct: 20,
          coberturaCusto: 1, estado: "FIAVEL", margemUnitaria: 1.1, cnpem: null,
          precoUtenteGeral: null, precoUtenteEspecial: null, semVendasNoPeriodo: false, retirado: false,
          stockAtual: stock,
        });
      }
      artigos.push({ stocks });
    }
    return { rows, artigos, uni };
  }
  const somaConhecida = (v: Array<number | null>): number | null => (v.every((x) => x === null) ? null : v.reduce<number>((s, x) => s + (x ?? 0), 0));
  const txt = (n: number | null) => (n === null ? "—" : String(n));

  type Modo = "produto" | "categoria" | "farmacia" | "grupo" | "fabricante";
  const MODOS: Modo[] = ["produto", "categoria", "farmacia", "grupo", "fabricante"];
  const chaveDe: Record<Exclude<Modo, "produto">, (r: MargemRow) => string> = {
    categoria: (r) => r.categoria ?? "?", farmacia: (r) => r.farmacia, grupo: (r) => r.grupo ?? "?", fabricante: (r) => r.fabricante,
  };

  type Caso = { report: Report; stockLinhas: string[]; totaisArtigo: string[]; totalGeral: string; unidades: number; stockTotal: number; desconhecidas: number };
  function montar(modo: Modo, e: Esp): Caso {
    const universe = { farmacias: e.uni, categorias: [], fabricantes: [], distribuidores: [] };
    const unidades = e.rows.reduce((s, r) => s + r.qtdVendida, 0);
    const conhecidos = e.rows.filter((r) => r.stockAtual !== null);
    const stockTotal = conhecidos.reduce((s, r) => s + (r.stockAtual ?? 0), 0);
    const desconhecidas = e.rows.length - conhecidos.length;
    if (modo === "produto") {
      const report = buildMargensProdutoReport({ rows: e.rows, filters: {}, universe, organization: "Grupo Teste" });
      const stockLinhas = e.artigos.flatMap((a) => a.stocks.map(txt));
      const totaisArtigo = e.artigos.filter((a) => a.stocks.length >= 2).map((a) => txt(somaConhecida(a.stocks)));
      return { report, stockLinhas, totaisArtigo, totalGeral: String(stockTotal), unidades, stockTotal, desconhecidas };
    }
    const agg = aggregate(e.rows, chaveDe[modo]);
    const report = buildMargensAggReport({ rows: agg, filters: {}, universe, organization: "Grupo Teste", groupBy: modo });
    const esperado = stockTotalDosAgregados(agg);
    if (esperado.total !== stockTotal) throw new Error("incoerência do teste: stock total agregado != soma das linhas");
    const stockLinhas = agg.map((a) => txt(stockDaLinhaAgregada(a)));
    return { report, stockLinhas, totaisArtigo: [], totalGeral: String(stockTotal), unidades, stockTotal, desconhecidas };
  }

  // ── PDF / impressão ──────────────────────────────────────────────────
  const dirKeep = process.env.MARGENS_PDF_MODOS_DIR;
  const dir = dirKeep ?? mkdtempSync(path.join(tmpdir(), "margens-modos-"));
  mkdirSync(dir, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  async function pdfDe(report: Report, nome: string, saida: "pdf" | "impressao"): Promise<string> {
    const page = await browser.newPage();
    try {
      await page.emulateMediaType("print");
      await page.setContent(renderReportHtml(report), { waitUntil: "networkidle0" });
      const landscape = report.meta?.orientation === "landscape";
      const bytes = saida === "pdf"
        // As opções reais do endpoint (lib/reporting/report-pdf-server.ts).
        ? await page.pdf({
            format: "A4", landscape, printBackground: true, preferCSSPageSize: true, margin: { top: "10mm", right: "8mm", bottom: "10mm", left: "8mm" },
            displayHeaderFooter: true,
            headerTemplate: `<div style="width:100%; font-size:7px; color:#94a3b8; padding:2mm 8mm 0 8mm; display:flex; justify-content:flex-end;">Pág. <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
            footerTemplate: `<div></div>`,
          })
        // Impressão: o diálogo usa o @page do próprio HTML (10mm 8mm), sem cabeçalho do Chromium; fundos desligados por omissão.
        : await page.pdf({ format: "A4", landscape, printBackground: false, preferCSSPageSize: true });
      const f = path.join(dir, `${nome}.pdf`);
      writeFileSync(f, bytes);
      return f;
    } finally { await page.close(); }
  }

  const sobrepoe = (a: Palavra, b: Palavra) => {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ox <= 0.8 || oy <= 0.8) return false;
    const menor = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
    return (ox * oy) / Math.max(menor, 0.01) > 0.3;
  };
  const mesmaLinha = (a: Palavra, b: Palavra, tol = 2.5) => Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) <= tol;

  function verificar(tag: string, modo: Modo, caso: Caso, pdf: string, minPaginas: number) {
    const paginas = palavrasDe(pdf);
    const n = paginas.length;
    check(n >= minPaginas, `${tag}: ${n} página(s) (esperado ≥ ${minPaginas})`);
    const todas = paginas.flatMap((p, i) => p.ws.map((w) => ({ ...w, p: i })));
    const colunas = caso.report.columns.filter((c) => !c.hidden && !c.excelOnly);

    // 1. nada passa a margem direita nem a esquerda; nada cortado com «…»
    const fora = todas.filter((w) => w.x1 > paginas[w.p].w - MARGEM_PT + 1 || w.x0 < MARGEM_PT - 1);
    check(fora.length === 0, `${tag}: nenhuma palavra fora das margens laterais (8 mm)`, fora.slice(0, 3).map((w) => `${w.t}@${w.x0.toFixed(0)}-${w.x1.toFixed(0)}`).join(", "));
    const reticencias = todas.filter((w) => w.t.includes("…"));
    check(reticencias.length === 0, `${tag}: nenhum texto cortado com «…»`, reticencias.slice(0, 3).map((w) => w.t).join(", "));

    // 2. nada sobreposto (nada impresso duas vezes por cima)
    let sobrepostas = 0;
    let exemplo = "";
    for (const p of paginas) {
      for (let i = 0; i < p.ws.length; i++) for (let j = i + 1; j < p.ws.length; j++) {
        if (sobrepoe(p.ws[i], p.ws[j])) { sobrepostas++; exemplo ||= `${p.ws[i].t}/${p.ws[j].t}`; }
      }
    }
    check(sobrepostas === 0, `${tag}: nenhuma palavra sobreposta a outra`, exemplo);

    // 3. cabeçalho da tabela: «Qtd» uma vez por página; cada rótulo completo uma vez por página
    const qtd = todas.filter((w) => w.t === "Qtd");
    check(qtd.length === n && paginas.every((_, i) => qtd.filter((w) => w.p === i).length === 1), `${tag}: cabeçalho «Qtd» exatamente 1× por página (${qtd.length}/${n})`);
    const esperadoTokens = new Map<string, number>();
    for (const c of colunas) for (const t of c.label.split(/\s+/).filter((x) => x && x !== "€")) esperadoTokens.set(t.toLowerCase(), (esperadoTokens.get(t.toLowerCase()) ?? 0) + 1);
    let cabOk = true;
    let cabDet = "";
    paginas.forEach((p, i) => {
      const q = qtd.find((w) => w.p === i);
      if (!q) { cabOk = false; return; }
      const banda = p.ws.filter((w) => w.y0 >= q.y0 - 9 && w.y1 <= q.y1 + 9 && w.t !== "€");
      const obtido = new Map<string, number>();
      for (const w of banda) obtido.set(w.t.toLowerCase(), (obtido.get(w.t.toLowerCase()) ?? 0) + 1);
      for (const [t, c] of esperadoTokens) if ((obtido.get(t) ?? 0) !== c) { cabOk = false; cabDet ||= `pág ${i + 1}: «${t}» esperado ${c}, veio ${obtido.get(t) ?? 0}`; }
    });
    check(cabOk, `${tag}: os ${colunas.length} cabeçalhos inteiros e sem duplicar em cada página`, cabDet);

    // 4. coluna Stock: 1 cabeçalho por página; valores exatos (linhas + TOTAL ARTIGO + TOTAL GERAL)
    const stockHdr = todas.filter((w) => w.t === "Stock" && qtd.some((q) => q.p === w.p && mesmaLinha(q, w, 4)));
    check(stockHdr.length === n, `${tag}: coluna «Stock» presente 1× por página (${stockHdr.length}/${n})`);
    const obtidoStock: string[] = [];
    const porLinhaTotalArtigo: string[] = [];
    let totalGeralObtido: string | null = null;
    for (const h of stockHdr) {
      const q = qtd.find((w) => w.p === h.p)!;
      const colu = todas.filter((w) => w.p === h.p && w.y0 > q.y1 + 6 && Math.abs(w.x1 - h.x1) <= 6 && /^[-−]?\d+$|^—$/.test(w.t));
      for (const w of colu) {
        const ehTotalArtigo = todas.some((o) => o.p === w.p && o.t === "ARTIGO" && mesmaLinha(o, w) && todas.some((t0) => t0.p === w.p && t0.t === "TOTAL" && mesmaLinha(t0, w)));
        const ehTotalGeral = todas.some((o) => o.p === w.p && o.t === "GERAL" && mesmaLinha(o, w));
        const v = sinal(w.t);
        obtidoStock.push(v);
        if (ehTotalArtigo) porLinhaTotalArtigo.push(v);
        if (ehTotalGeral) totalGeralObtido = v;
      }
    }
    const esperadoStock = [...caso.stockLinhas, ...caso.totaisArtigo, caso.totalGeral].sort();
    check(JSON.stringify([...obtidoStock].sort()) === JSON.stringify(esperadoStock), `${tag}: valores da coluna Stock = esperados (${esperadoStock.length} células, sem duplicar)`, `obtido ${obtidoStock.length}: ${[...obtidoStock].sort().join(",")} | esperado: ${esperadoStock.join(",")}`);
    check(totalGeralObtido === caso.totalGeral, `${tag}: Stock do TOTAL GERAL = ${caso.totalGeral}`, `veio ${totalGeralObtido}`);
    if (modo === "produto") {
      const ordenados = porLinhaTotalArtigo; // já em ordem de página/linha
      check(JSON.stringify(ordenados) === JSON.stringify(caso.totaisArtigo), `${tag}: Stock de cada TOTAL ARTIGO (${caso.totaisArtigo.length}) na ordem dos artigos`, `veio ${ordenados.join(",")} | esperado ${caso.totaisArtigo.join(",")}`);
    }

    // 5. totais únicos
    const conta = (a: string, b: string) => todas.filter((w, i) => w.t === a && todas[i + 1]?.t === b && todas[i + 1].p === w.p).length;
    check(conta("TOTAL", "GERAL") === 1, `${tag}: «TOTAL GERAL» uma só vez`);
    if (modo === "produto") check(conta("TOTAL", "ARTIGO") === caso.totaisArtigo.length, `${tag}: «TOTAL ARTIGO» ${caso.totaisArtigo.length}× (artigos com 2+ farmácias)`, `veio ${conta("TOTAL", "ARTIGO")}`);

    // 6. faixa de resumo: 1.ª página, 1×, valores certos, separação entre itens, acima da tabela
    const p1 = paginas[0].ws;
    const idxU = p1.findIndex((w, i) => w.t === "Unidades" && p1[i + 1]?.t === "vendidas:");
    const idxS = p1.findIndex((w, i) => w.t === "Stock" && p1[i + 1]?.t === "total:");
    check(idxU >= 0 && idxS >= 0, `${tag}: faixa de resumo na 1.ª página («Unidades vendidas», «Stock total»)`);
    check(todas.filter((w, i) => w.t === "Unidades" && todas[i + 1]?.t === "vendidas:").length === 1 && todas.filter((w, i) => w.t === "Stock" && todas[i + 1]?.t === "total:").length === 1, `${tag}: faixa uma só vez no documento`);
    if (idxU >= 0 && idxS >= 0) {
      const vU = p1[idxU + 2];
      const vS = p1[idxS + 2];
      check(sinal(vU.t) === String(caso.unidades), `${tag}: faixa «Unidades vendidas: ${caso.unidades}»`, `veio ${vU.t}`);
      check(sinal(vS.t) === String(caso.stockTotal), `${tag}: faixa «Stock total: ${caso.stockTotal}»`, `veio ${vS.t}`);
      const lbS = p1[idxS];
      check(mesmaLinha(vU, lbS) && lbS.x0 - vU.x1 >= 9, `${tag}: itens da faixa separados (folga ${(lbS.x0 - vU.x1).toFixed(1)} pt ≥ 9, mesma linha)`);
      if (caso.desconhecidas > 0) {
        const idxL = p1.findIndex((w, i) => w.t === "Linhas" && p1[i + 1]?.t === "sem");
        check(idxL >= 0 && mesmaLinha(vS, p1[idxL]) && p1[idxL].x0 - vS.x1 >= 9, `${tag}: item «Linhas sem stock conhecido» separado do anterior`);
        const fim = p1.findIndex((w, i) => i > idxL && w.t === "total):");
        const vL = fim >= 0 ? p1[fim + 1] : undefined;
        check(!!vL && sinal(vL.t) === String(caso.desconhecidas), `${tag}: «Linhas sem stock conhecido: ${caso.desconhecidas}»`, `veio ${vL?.t}`);
      } else {
        check(!p1.some((w, i) => w.t === "Linhas" && p1[i + 1]?.t === "sem"), `${tag}: sem desconhecidas, sem o item «Linhas sem stock conhecido»`);
      }
      const q1 = qtd.find((w) => w.p === 0)!;
      check(lbS.y1 < q1.y0 - 2, `${tag}: faixa acima da tabela (não a desloca nem a cobre)`);
    }
  }

  // ── cenários ─────────────────────────────────────────────────────────
  const cenarios: Array<{ nome: string; e: Esp; minProduto: number }> = [
    { nome: "3 farmácias", e: dados(40, TODAS), minProduto: 2 },
    { nome: "1 farmácia", e: dados(12, [TODAS[0]]), minProduto: 1 },
  ];
  try {
    for (const { nome, e, minProduto } of cenarios) {
      for (const modo of MODOS) {
        for (const saida of ["pdf", "impressao"] as const) {
          const tag = `[${modo} · ${nome} · ${saida}]`;
          secao(tag);
          const caso = montar(modo, e);
          const f = await pdfDe(caso.report, `margens-${saida}-modo-${modo}-${nome.startsWith("3") ? "3farm" : "1farm"}`, saida);
          verificar(tag, modo, caso, f, modo === "produto" ? minProduto : 1);
        }
      }
    }

    // ── isolamento do CSS / do HTML (a faixa é o único acréscimo no modo Produto) ──
    secao("Isolamento: a faixa é um bloco único; o CSS está escopado à hierarquia");
    const e3 = dados(40, TODAS);
    for (const modo of MODOS) {
      const { report } = montar(modo, e3);
      const comFaixa = renderReportHtml(report);
      const semFaixa = renderReportHtml({ ...report, meta: { ...report.meta!, resumoFaixa: undefined } });
      const bloco = comFaixa.match(/<div class="resumo-faixa" data-testid="resumo-faixa">[\s\S]*?<\/span><\/div>/)?.[0] ?? "";
      check(bloco.length > 0 && comFaixa.replace(bloco, "") === semFaixa, `${modo}: o HTML só difere do HTML sem faixa pelo bloco da faixa (tabela, totais e cabeçalhos intactos)`);
      check(/<\/span> <span class="resumo-item">|<\/span><span class="resumo-item">/.test(bloco) && (bloco.match(/class="resumo-item"/g) ?? []).length >= 2, `${modo}: itens da faixa são elementos separados (o espaçamento vem do CSS flex gap)`);
    }
    const css = renderReportHtml(montar("produto", e3).report).match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const cssLF = css.replace(/\r\n/g, "\n");
    const decl = "font-size: 9.5px; color: #374151; margin: 3px 0 0 0; display: flex; flex-wrap: wrap; gap: 4px 16px;";
    check(cssLF.includes(`.page.density-compact.hierarchy-clean .resumo-faixa { ${decl} }`), "CSS: a regra da faixa de Vendas (clean) mantém-se EXATAMENTE como era");
    check(cssLF.includes(`.page.density-compact:not(.hierarchy-clean) .resumo-faixa { ${decl} }`), "CSS: a faixa de Margens (strong e agregados) usa as MESMAS declarações da de Vendas — coerência");
    check(!/(^|\n)\s*\.resumo-faixa\b/.test(cssLF) && !/(^|\n)\s*\.page\s+\.resumo-faixa/.test(cssLF), "CSS: nenhuma regra global de .resumo-faixa (só em relatórios compactos)");
    const regraCab = cssLF.match(/[^\n]*table\.table-density-tight thead th \{ white-space: normal[^\n]*/g) ?? [];
    check(regraCab.length === 1 && regraCab[0].includes("hierarchy-strong"), "CSS: cabeçalhos a duas linhas só em hierarchy-strong (Vendas/clean não muda)");
  } finally {
    await browser.close();
    if (!dirKeep) rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
