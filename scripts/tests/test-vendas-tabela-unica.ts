/**
 * Mapa de Vendas numa SÓ tabela contínua (2026-11) — sem blocos temporais, papel A4/A3 automático.
 *
 * Requisito do utilizador, provado aqui sobre PDFs REAIS (Chromium → PDF → PyMuPDF) e sobre a impressão:
 *   1 uma tabela contínua · 2 todos os meses lado a lado · 3 nunca blocos temporais · 4 cada artigo UMA vez · 5 cada farmácia uma
 *   linha por artigo · 6 «TOTAL ARTIGO» uma vez e só com > 1 farmácia · 7 uma só coluna «Total unid.» (período completo) · 8 uma só
 *   «Stock» · 9 PVP/custos/vendas sem repetição · 10 um só TOTAL GERAL, no fim · 11 sem «Parte i de n», «Total unid. do bloco»,
 *   explicações de divisão · 12 paginação só na vertical · 13 artigo nunca dividido entre páginas · 14 cabeçalho completo repetido
 *   em cada página · 15 opções de preços mantêm-se · 16 fórmulas/Excel/email intactos.
 *
 * Secções: A função de largura/papel (pura) · B estrutura do relatório e do código (sem blocos) · C PDFs reais por cenário ·
 *          D impressão (HTML do iframe, mídia print) · E pré-visualização «Relatório» · F Excel · G e-mail/endpoint · H separadores
 *          (meses verticais + 2px entre artigos) em PDFs A4 e A3.
 *
 * Corre com:  npx tsx scripts/tests/test-vendas-tabela-unica.ts            (≈ 15-25 min numa máquina carregada: ~45 PDFs reais; o Python do PyMuPDF é lento em A3)
 *             TABELA_UNICA_RAPIDO=1 npx tsx …                              (subconjunto de cenários)
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import * as XLSX from "xlsx";
import { buildReportWorkbook } from "../../lib/reporting/report-excel-buffer";
import { renderReportHtml } from "../../lib/reporting/report-html";
import { aplicarPrivacidade } from "../../lib/reporting/privacidade";
import {
  decidirLayout, FOLGA_MM, MARGEM_LATERAL_DEGRADADA_MM, MARGEM_LATERAL_MM, PAPEL_HORIZONTAL_MM, maximoMesesSemDegradar,
  type TextosDasColunas,
} from "../../lib/reporting/layout-largura";
import { opcoesPdfDoRelatorio } from "../../lib/reporting/pdf-opcoes";
import { analisar } from "./_analise-tabela-unica";
import { abrirBrowser, apagarPasta, dados, lerPdf, novaPasta, pdfDe, pdfImpressao, relatorio } from "./_tabela-unica";
import { medirMeses, separadoresDe } from "./_verticais-meses";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { passed++; console.log(`  [OK]    ${label}`); }
  else { failed++; console.log(`  [FALHA] ${label}${detalhe ? `  → ${detalhe}` : ""}`); }
};
const RAPIDO = process.env.TABELA_UNICA_RAPIDO === "1";
const src = (p: string) => readFileSync(p, "utf8");

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A. A função de largura/papel (pura, determinística)
// ───────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n=== A. decidirLayout: regra de largura e papel (função pura) ===");

/** Textos «moderados» (artigo corrente, totais mensais até 4 dígitos) e «extremos» (123 456 unidades, 12 345,67 €, negativos). */
const MODERADO: TextosDasColunas = { codigo: ["5880034"], farmacia: ["Silveirense", "TOTAL ARTIGO"], pvp: ["6,66 €"], custoUnitario: ["3,74 €"], custoTotal: ["1 234,56 €"], valor: ["12 345,67 €"], totalUnid: ["1 234"], stock: ["123"], mes: ["12", "1 234"] };
const EXTREMO: TextosDasColunas = { codigo: ["5880034"], farmacia: ["Silveirense", "TOTAL ARTIGO"], pvp: ["12 345,67 €"], custoUnitario: ["12 345,67 €"], custoTotal: ["1 234 567,89 €"], valor: ["1 234 567,89 €"], totalUnid: ["123 456"], stock: ["12 345"], mes: ["-12 345", "123 456"] };
const COMBOS = [[true, true], [true, false], [false, true], [false, false]] as const;
const nomeCombo = (v: boolean, c: boolean) => `venda=${v ? "sim" : "não"} compra=${c ? "sim" : "não"}`;
const lay = (n: number, v: boolean, c: boolean, t: TextosDasColunas = MODERADO) => decidirLayout({ nMeses: n, incluirVenda: v, incluirCompra: c, textos: t });

{
  ok(`áreas úteis: A4 horizontal = 297 − 2×${MARGEM_LATERAL_MM} = ${297 - 2 * MARGEM_LATERAL_MM} mm; A3 = 420 − 2×${MARGEM_LATERAL_MM} = ${420 - 2 * MARGEM_LATERAL_MM} mm`, PAPEL_HORIZONTAL_MM.A4.largura - 2 * MARGEM_LATERAL_MM === 281 && PAPEL_HORIZONTAL_MM.A3.largura - 2 * MARGEM_LATERAL_MM === 404);
  ok("determinística: a mesma entrada dá exatamente a mesma decisão", JSON.stringify(lay(14, true, true)) === JSON.stringify(lay(14, true, true)));

  for (const [nome, t] of [["moderados", MODERADO], ["extremos", EXTREMO]] as const) {
    for (const [v, c] of COMBOS) {
      // o papel nunca volta atrás de A3 para A4 ao acrescentar meses; a largura mínima nunca diminui dentro do mesmo papel/densidade
      const seq = Array.from({ length: 40 }, (_, i) => lay(i + 1, v, c, t));
      const primeiroA3 = seq.findIndex((d) => d.papel === "A3");
      ok(`${nome} · ${nomeCombo(v, c)}: papel monótono (A4 até ${primeiroA3 < 0 ? "≥ 40" : primeiroA3} meses, A3 daí em diante)`, primeiroA3 < 0 || seq.slice(primeiroA3).every((d) => d.papel === "A3"));
      ok(`${nome} · ${nomeCombo(v, c)}: A4 ⇔ as colunas cabem em A4 com folga (${FOLGA_MM} mm); A3 ⇔ não cabem`, seq.every((d) => (d.papel === "A4") === d.cabeEmA4 && (d.papel !== "A4" || d.larguraMinimaMm + FOLGA_MM <= d.larguraUtilMm + 1e-9)));
      ok(`${nome} · ${nomeCombo(v, c)}: ponto de transição exato — no último nº de meses em A4 cabe, no seguinte o A4 forçado já não cabe`, primeiroA3 <= 0 || (() => {
        const ant = seq[primeiroA3 - 1], seg = decidirLayout({ nMeses: primeiroA3 + 1, incluirVenda: v, incluirCompra: c, textos: t, papelForcado: "A4" });
        return ant.papel === "A4" && ant.cabeEmA4 && (seg.degradado || seg.excedeLimite);
      })());
      ok(`${nome} · ${nomeCombo(v, c)}: as larguras (%) somam 100 e nenhuma é negativa, para 1…40 meses`, seq.every((d) => {
        const p = d.pct;
        // PVP/custos/valor só existem se a classe está incluída; os meses repetem-se n vezes (a soma exata é testada no adapter)
        return Object.values(p).every((x) => x >= 0) && Math.abs(p.codigo + p.farmacia + p.pvp + p.custoUnitario + p.custoTotal + p.totalUnid + p.stock + p.valor + p.descricao + p.mes * (seq.indexOf(d) + 1) - 100) < 1e-6;
      }));
    }
  }

  console.log("\n  — 12 / 13 / 14 meses, cada combinação de preços (textos moderados | extremos) —");
  for (const [v, c] of COMBOS) {
    const linha = [12, 13, 14].map((n) => { const m = lay(n, v, c), e = lay(n, v, c, EXTREMO); return `${n}: ${m.papel}/${m.densidade} (${m.larguraMinimaMm.toFixed(0)} mm) | ${e.papel}/${e.densidade}${e.degradado ? "+deg" : ""} (${e.larguraMinimaMm.toFixed(0)} mm)`; });
    console.log(`  ${nomeCombo(v, c)} ⇒ ${linha.join(" ; ")}`);
  }
  // casos-limite fixos (documentados): sem preços de venda nem de compra cabem 14 meses em A4; com todos os preços já não cabem 12
  ok("14 meses sem preços de venda nem de compra (textos moderados) → A4", lay(14, false, false).papel === "A4");
  ok("14 meses com todos os preços (textos moderados) → A3 (não cabe em A4)", lay(14, true, true).papel === "A3");
  ok("12 meses com todos os preços (textos moderados) → A3; 12 meses sem preços de compra → A4", lay(12, true, true).papel === "A3" && lay(12, true, false).papel === "A4");
  ok("1 e 3 meses, qualquer combinação (textos moderados) → A4, tipografia arejada (cozy)", COMBOS.every(([v, c]) => [1, 3].every((n) => lay(n, v, c).papel === "A4" && lay(n, v, c).densidade === "cozy")));
  ok("valores muito longos (123 456 unidades, 12 345,67 €, 1 234 567,89 €) alargam as colunas: o mínimo cresce e 1 mês com todos os preços ainda cabe em A4", lay(1, true, true, EXTREMO).larguraMinimaMm > lay(1, true, true).larguraMinimaMm && lay(1, true, true, EXTREMO).papel === "A4");
  ok("valores muito longos com 12 meses e todos os preços → A3", lay(12, true, true, EXTREMO).papel === "A3");
  const comprido: TextosDasColunas = { ...EXTREMO, totalUnid: ["12 345 678 901"], valor: ["99 999 999 999,99 €"], mes: ["-1 234 567"] };
  ok("textos ainda mais longos nunca encolhem uma coluna abaixo do seu texto (largura mínima só cresce)", lay(6, true, true, comprido).minimos.totalUnid > lay(6, true, true, EXTREMO).minimos.totalUnid && lay(6, true, true, comprido).minimos.mes > lay(6, true, true, EXTREMO).minimos.mes);
  ok("a coluna de mês nunca fica abaixo do mínimo documentado (7,5 mm) nem a Descrição abaixo de 31 mm (degradação) / 34 mm (normal)", [1, 6, 14, 27].every((n) => { const d = lay(n, true, true), a = d.pct.descricao * (d.excedeLimite ? d.larguraMinimaMm : d.larguraUtilMm) / 100; return d.minimos.mes >= (d.mesesAbreviados ? 6.5 : 7.5) - 1e-9 && a >= (d.degradado ? 31 : 34) - 0.01; }));

  console.log("\n  — degradação controlada (nunca blocos) —");
  const d27 = lay(27, true, true);
  ok(`27 meses, todos os preços, textos moderados: A3 sem escala (${d27.papel}, ${d27.densidade}${d27.degradado ? ", degradado" : ""}${d27.excedeLimite ? ", excede" : ""})`, d27.papel === "A3" && !d27.excedeLimite);
  ok("…meses abreviados («J\\n26»), margens de 6 mm e células de mês compactas só na degradação", d27.degradado ? d27.mesesAbreviados && d27.margemLateralMm === MARGEM_LATERAL_DEGRADADA_MM : d27.margemLateralMm === MARGEM_LATERAL_MM && !d27.mesesAbreviados);
  const d60 = lay(60, true, true);
  ok(`60 meses (acima do limite do A3): ${d60.papel}, escala ${(d60.zoom * 100).toFixed(0)} % com aviso — nunca blocos`, d60.papel === "A3" && d60.excedeLimite && d60.zoom < 1 && d60.zoom > 0.3 && !!d60.aviso && Math.abs(d60.zoom * d60.larguraMinimaMm - d60.larguraUtilMm) < 0.01, JSON.stringify({ z: d60.zoom, aviso: d60.aviso }));
  const maxMod = COMBOS.map(([v, c]) => `${nomeCombo(v, c)}: ${maximoMesesSemDegradar({ incluirVenda: v, incluirCompra: c, textos: MODERADO })}`);
  const maxExt = COMBOS.map(([v, c]) => `${nomeCombo(v, c)}: ${maximoMesesSemDegradar({ incluirVenda: v, incluirCompra: c, textos: EXTREMO })}`);
  console.log(`  máx. de meses SEM degradar (A3, tipografia normal) — textos moderados: ${maxMod.join(" | ")}`);
  console.log(`  máx. de meses SEM degradar — textos extremos: ${maxExt.join(" | ")}`);
  ok("o máximo sem degradar (moderado, todos os preços) é ≥ 18 meses; o mapa suporta sempre mais (a degradação e a escala nunca cortam)", maximoMesesSemDegradar({ incluirVenda: true, incluirCompra: true, textos: MODERADO }) >= 18);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// B. Estrutura do relatório e do código — sem blocos em lado nenhum
// ───────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n=== B. Sem blocos temporais no adapter, tipos, HTML, privacidade e restantes relatórios ===");
{
  for (const f of ["lib/reporting/adapters/vendas.ts", "lib/reporting/report-types.ts", "lib/reporting/report-html.ts", "lib/reporting/privacidade.ts", "lib/reporting/report-pdf-server.ts", "lib/reporting/report-print.ts", "lib/reporting/layout-largura.ts"]) {
    const s = src(f);
    ok(`${f}: sem columnBlocks / repartirMeses / MAX_MESES_POR_BLOCO / chaveTotalBloco / bloco-temporal`, !/columnBlocks|repartirMeses|MAX_MESES_POR_BLOCO|chaveTotalBloco|bloco-temporal|bloco-novo|bloco-titulo/.test(s));
  }
  const todos = spawnSync("git", ["grep", "-l", "-E", "columnBlocks|repartirMeses|chaveTotalBloco", "--", "lib", "app", "components"], { encoding: "utf8" }).stdout.trim();
  ok("nenhum outro adapter/componente/rota usa blocos (git grep em lib/, app/, components/)", todos === "", todos);
  const textoRelatorio = src("lib/reporting/adapters/vendas.ts") + src("lib/reporting/report-html.ts");
  ok("o código já não contém os textos «Parte … de …», «Total unid. do bloco», «Período: custo/valor/Total unid.»", !/Parte \$\{|[Uu]nid\. do bloco|unid\.\\ndo bloco|Período: custo|Período: valor|Período:\\nTotal/.test(textoRelatorio));

  for (const n of [1, 3, 14, 27, 36]) {
    const rows = dados({ artigos: 20, meses: n, nFarm: 2 });
    const rel = relatorio(rows, n, 2);
    const cols = rel.columns.filter((c) => !c.excelOnly);
    const meses = rel.columns.filter((c) => c.monthAlt);
    ok(`${n} meses: UMA tabela — ${meses.length} colunas de mês, 1× «Total Unid.», 1× «Stock», 1× «Custo total est.», 1× «Valor Vendas», 1× PVP, 1× «Custo unit. est.»`, meses.length === n && ["totalVendas", "existencia", "custoEstimado", "valorBruto", "pvp", "custoUnitarioEstimado"].every((k) => cols.filter((c) => c.key === k).length === 1));
    ok(`${n} meses: nenhuma coluna só-HTML de «total do bloco»; a ordem é CNP, Descrição, Farmácia, PVP, Custo unit., Custo total, meses…, Total Unid., Stock, Valor Vendas`, !rel.columns.some((c) => c.htmlOnly) && cols.map((c) => c.key).filter((k) => !k.startsWith("m_")).join(",") === "codigo,descricao,farmacia,pvp,custoUnitarioEstimado,custoEstimado,totalVendas,existencia,valorBruto");
    const html = renderReportHtml(rel);
    ok(`${n} meses: HTML com uma só <table>, um só <thead>, um só «TOTAL GERAL» e sem «Parte»/«bloco»`, (html.match(/<table/g) ?? []).length === 1 && (html.match(/<thead>/g) ?? []).length === 1 && (html.match(/<strong>TOTAL GERAL<\/strong>/g) ?? []).length === 1 && !/Parte \d|[Uu]nid\.(<br\/>)? do bloco|do bloco<|Período:<br|bloco-(temporal|novo|titulo)/.test(html.slice(html.indexOf("<body>"))));
    ok(`${n} meses: o rodapé não explica divisões temporais (sem «blocos», «Parte», «último bloco»)`, !/bloco|Parte \d/i.test(rel.meta?.footer ?? ""), rel.meta?.footer);
    ok(`${n} meses: soma das larguras = 100 e a Descrição nunca abaixo do mínimo`, Math.abs(cols.reduce((s, c) => s + (c.width ?? 0), 0) - 100) < 1e-6 && (cols.find((c) => c.key === "descricao")?.width ?? 0) > 5);
    ok(`${n} meses: meta.paperSize = ${rel.meta?.paperSize} e @page do HTML diz o mesmo (${rel.meta?.paperSize} landscape)`, !!rel.meta?.paperSize && html.includes(`size: ${rel.meta.paperSize} landscape`));
  }
  // rótulos dos meses: normais com duas linhas de 3+2 caracteres; abreviados («J\n26») só na degradação
  const r27 = relatorio(dados({ artigos: 5, meses: 27, nFarm: 2 }), 27, 2);
  const m27 = r27.columns.filter((c) => c.monthAlt).map((c) => c.label);
  ok(`27 meses: ${r27.meta?.compactMonths ? "meses abreviados «J\\n25»…" : "meses normais"} — cada rótulo tem 2 linhas e as inicais batem com o calendário`, m27.every((l) => /^[A-Za-zÀ-ü]{1,3}\n\d{2}$/.test(l)) && (r27.meta?.compactMonths ? m27.every((l) => l.split("\n")[0].length === 1) : m27.every((l) => l.split("\n")[0].length === 3)), JSON.stringify(m27.slice(0, 4)));
  const r3 = relatorio(dados({ artigos: 5, meses: 3, nFarm: 2 }), 3, 2);
  ok("3 meses: rótulos «Out\\n25», «Nov\\n25», «Dez\\n25» (como sempre)", JSON.stringify(r3.columns.filter((c) => c.monthAlt).map((c) => c.label)) === JSON.stringify(["Out\n25", "Nov\n25", "Dez\n25"]));

  // privacidade: reaplicar não reintroduz nada nem altera o papel
  const rp = relatorio(dados({ artigos: 10, meses: 14, nFarm: 2 }), 14, 2, false, false);
  const rp2 = aplicarPrivacidade(rp);
  ok("sem preços: aplicarPrivacidade é idempotente e preserva o papel", rp2.columns.length === rp.columns.length && rp2.meta?.paperSize === rp.meta?.paperSize && !rp2.columns.some((c) => ["pvp", "custoUnitarioEstimado", "custoEstimado", "valorBruto"].includes(c.key)));
  // as larguras recalculam-se por combinação: sem custos a Descrição ganha espaço
  const w = (v: boolean, c: boolean) => relatorio(dados({ artigos: 20, meses: 14, nFarm: 2 }), 14, 2, v, c).columns.find((x) => x.key === "descricao")?.width ?? 0;
  ok(`14 meses: a Descrição cresce quando se retiram preços (todos ${w(true, true).toFixed(1)}% ≤ só venda ${w(true, false).toFixed(1)}% < nenhum ${w(false, false).toFixed(1)}%)`, w(true, true) <= w(true, false) + 1e-9 && w(true, false) < w(false, false));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// C-H. PDFs reais
// ───────────────────────────────────────────────────────────────────────────────────────────────
type Cenario = { tag: string; meses: number; nFarm: number; artigos: number; venda: boolean; compra: boolean; extremos?: boolean; impressao?: boolean; profundo?: boolean };

async function main() {
  const browser = await abrirBrowser();
  const dir = novaPasta("vendas-tabela-unica-");
  const cenarios: Cenario[] = [];
  const add = (c: Omit<Cenario, "tag">) => cenarios.push({ ...c, tag: `${c.meses}m · ${c.nFarm}f · ${c.artigos}art · ${c.venda ? "V" : "-"}${c.compra ? "C" : "-"}${c.extremos ? " · extremos" : ""}` });

  const MESES = RAPIDO ? [1, 14, 27] : [1, 3, 6, 12, 13, 14, 24, 27, 36];
  // 1) meses × todos os preços (2 farmácias); as outras 3 combinações de preços nos meses 1, 3, 14 e 27 (o Python do PyMuPDF é lento em A3)
  for (const m of MESES) add({ meses: m, nFarm: 2, artigos: 30, venda: true, compra: true, profundo: [1, 14, 27].includes(m) });
  for (const m of RAPIDO ? [14] : [1, 3, 14, 27]) for (const [v, c] of COMBOS.slice(1)) add({ meses: m, nFarm: 2, artigos: 30, venda: v, compra: c });
  // 2) uma e três farmácias
  for (const m of RAPIDO ? [14] : [1, 14, 27]) for (const nf of [1, 3]) add({ meses: m, nFarm: nf, artigos: 30, venda: true, compra: true });
  // 3) valores elevados e negativos (123 456 unidades, 12 345,67 €, -12 345)
  for (const m of RAPIDO ? [14] : [1, 6, 12, 14, 24]) add({ meses: m, nFarm: 2, artigos: 24, venda: true, compra: true, extremos: true });
  if (!RAPIDO) for (const [v, c] of COMBOS.slice(1)) add({ meses: 14, nFarm: 2, artigos: 24, venda: v, compra: c, extremos: true });
  // 4) várias páginas (≥ 150 artigos), 2 e 3 farmácias
  for (const m of RAPIDO ? [14] : [3, 14, 27]) add({ meses: m, nFarm: 2, artigos: 150, venda: true, compra: true, impressao: true, profundo: m === 14 });
  add({ meses: 14, nFarm: 3, artigos: 150, venda: true, compra: true });
  if (!RAPIDO) add({ meses: 14, nFarm: 2, artigos: 150, venda: false, compra: false });

  console.log(`\n=== C. PDFs reais (endpoint: lib/reporting/pdf-opcoes.ts): ${cenarios.length} cenários — contagens, valores, paginação, papel, cortes, tipografia ===`);
  const resumo: string[] = [];
  const falhasPorCenario: string[] = [];
  const profundos: { tag: string; pdf: string; rel: ReturnType<typeof relatorio>; n: number }[] = [];
  for (const cn of cenarios) {
    const rows = dados({ artigos: cn.artigos, meses: cn.meses, nFarm: cn.nFarm, extremos: cn.extremos });
    const rel = relatorio(rows, cn.meses, cn.nFarm, cn.venda, cn.compra);
    const f = await pdfDe(browser, rel, path.join(dir, `c${profundos.length}-${resumo.length}.pdf`));
    const pag = lerPdf(f);
    const meta = rel.meta!;
    const opc = { nMeses: cn.meses, venda: cn.venda, compra: cn.compra, papel: meta.paperSize as "A4" | "A3", margemMm: meta.pageMarginMm ?? MARGEM_LATERAL_MM, compacto: !!meta.compactMonths, zoom: (meta.contentZoom ?? 1) < 1 };
    const r = analisar(pag, rel, rows, opc);
    const nArtigos = new Set(rows.map((x) => x.codigo)).size;
    // o papel respeita a regra: A4 ⇔ cabe em A4
    const regra = (meta.paperSize === "A4") === !!meta.layoutFitsA4 && (meta.paperSize !== "A4" || (meta.layoutMinWidthMm ?? 1e9) + FOLGA_MM <= 281 + 1e-9);
    const extra: string[] = [];
    if (!regra) extra.push(`papel ${meta.paperSize} incoerente com a regra (mín ${meta.layoutMinWidthMm} mm)`);
    if (r.m.artigos !== nArtigos) extra.push(`${r.m.artigos} artigos no PDF, esperados ${nArtigos}`);
    const multi = cn.artigos >= 150;
    if (multi && r.m.paginas < 2) extra.push(`relatório de ${cn.artigos} artigos num só página`);
    const falhas = [...r.falhas, ...extra];
    ok(`${cn.tag}: ${meta.paperSize}${meta.compactMonths ? "+compacto" : ""}${opc.zoom ? "+escala" : ""} · ${r.m.paginas} pág. · ${r.m.artigos} artigos/${r.m.linhas} linhas conferidos · fonte mín. número ${r.m.tamanhoMinNumeroPt.toFixed(2)} pt, texto ${r.m.tamanhoMinTextoPt.toFixed(2)} pt, cabeçalho ${r.m.tamanhoMinCabecalhoPt.toFixed(2)} pt`, falhas.length === 0, falhas.slice(0, 4).join(" | "));
    resumo.push(`${cn.tag} → ${meta.paperSize} ${r.m.paginas}p`);
    if (falhas.length) falhasPorCenario.push(`${cn.tag}: ${falhas.slice(0, 2).join(" / ")}`);
    if (cn.profundo && !RAPIDO) profundos.push({ tag: cn.tag, pdf: f, rel, n: cn.meses });
    if (cn.profundo && RAPIDO) profundos.push({ tag: cn.tag, pdf: f, rel, n: cn.meses });

    // D. impressão (HTML do iframe, mídia print): mesma estrutura, mesmo papel
    if (cn.impressao) {
      const fi = await pdfImpressao(browser, rel, path.join(dir, `imp${resumo.length}.pdf`));
      const pi = lerPdf(fi);
      const ri = analisar(pi, rel, rows, opc);
      ok(`  impressão · ${cn.tag}: mesmo papel (${opc.papel}), ${ri.m.paginas} pág., todas as verificações iguais às do PDF`, ri.falhas.length === 0, ri.falhas.slice(0, 3).join(" | "));
      ok(`  impressão · ${cn.tag}: conteúdo idêntico ao do PDF (mesmas colunas, ordem, valores e linhas)`, ri.assinatura === r.assinatura);
    }
  }
  if (falhasPorCenario.length) console.log(`\n  Cenários com falhas (${falhasPorCenario.length}):\n   - ${falhasPorCenario.join("\n   - ")}`);

  // ── Regra de papel nos PDFs: A4 até onde coube, A3 acima (tabela observada) ──
  console.log("\n  Papel observado por cenário (resumo):");
  const porMeses = new Map<string, string[]>();
  for (const s of resumo) { const [k, v] = s.split(" → "); const m = k.split(" · ")[0] + (k.includes("extremos") ? " ext" : "") + " " + k.split(" · ").slice(-1)[0].replace(" extremos", ""); porMeses.set(m, [...(porMeses.get(m) ?? []), v]); }
  console.log("  " + [...porMeses.entries()].slice(0, 60).map(([k, v]) => `${k}: ${v.join("/")}`).join(" ; "));

  // ── E. pré-visualização «Relatório» (iframe de ecrã): mesma largura, scroll horizontal, nunca corta ──
  console.log("\n=== E. Pré-visualização «Relatório» (ecrã, iframe) — largura do papel, scroll horizontal, sem cortes ===");
  for (const [m, nf] of (RAPIDO ? [[14, 2]] : [[3, 2], [14, 2], [27, 2]]) as [number, number][]) {
    const rows = dados({ artigos: 30, meses: m, nFarm: nf });
    const rel = relatorio(rows, m, nf);
    const html = renderReportHtml(rel);
    const util = (rel.meta!.paperSize === "A3" ? 420 : 297) - 2 * (rel.meta!.pageMarginMm ?? 8);
    for (const vw of [1366, 1920]) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: vw, height: 800 });
        await page.setContent(html, { waitUntil: "networkidle0" });
        const medidas = await page.evaluate(() => {
          const tabela = document.querySelector("table")!.getBoundingClientRect();
          const ths = [...document.querySelectorAll("thead th")] as HTMLElement[];
          const cortados = ths.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent);
          const tds = [...document.querySelectorAll("tbody td.nc, tbody td.num")] as HTMLElement[];
          const cortadosTd = tds.filter((t) => t.scrollWidth > t.clientWidth + 1).length;
          return { tw: tabela.width, sw: document.documentElement.scrollWidth, cortados, cortadosTd };
        });
        const esperadoPx = (util / 25.4) * 96;
        // a tabela nunca é mais estreita do que o papel (largura útil); com janela larga estica (as colunas escalam em %); com janela
        // estreita aparece scroll horizontal (scrollWidth ≥ largura do papel) — nunca colunas espremidas nem texto cortado
        ok(`${m} meses · ecrã ${vw}px · papel ${rel.meta!.paperSize}: a tabela tem pelo menos a largura do papel (${medidas.tw.toFixed(0)} px ≥ ${esperadoPx.toFixed(0)} px), scroll horizontal se a janela é mais estreita (${medidas.sw.toFixed(0)} px) e nenhum cabeçalho/célula cortada`, medidas.tw >= esperadoPx - 2 && medidas.sw >= Math.min(vw, esperadoPx) - 2 && medidas.cortados.length === 0 && medidas.cortadosTd === 0, JSON.stringify(medidas));
      } finally { await page.close(); }
    }
  }

  // ── F. Excel intacto ──
  console.log("\n=== F. Excel (buildReportWorkbook): todos os meses e valores corretos, uma folha, uma linha por artigo/farmácia ===");
  for (const m of RAPIDO ? [14] : [3, 14, 27]) {
    const rows = dados({ artigos: 24, meses: m, nFarm: 2 });
    const rel = relatorio(rows, m, 2);
    const wb = buildReportWorkbook(rel);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const mat = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null }) as unknown[][];
    const linhaCab = mat.findIndex((l) => l.includes("CNP"));
    const cab = (mat[linhaCab] as string[]).map((c) => String(c ?? "").replace(/\n/g, " "));
    const iMes = cab.map((c, i) => (/^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez) \d{2}$/.test(c) || /^[JFMASOND] \d{2}$/.test(c) ? i : -1)).filter((i) => i >= 0);
    const corpo = mat.slice(linhaCab + 1).filter((l) => l[cab.indexOf("CNP")] != null && /^\d{7}$/.test(String(l[cab.indexOf("CNP")])));
    const det = corpo.filter((l) => l[cab.indexOf("Tipo de linha")] === "Detalhe");
    const tot = corpo.filter((l) => l[cab.indexOf("Tipo de linha")] === "Total artigo");
    const iTotal = cab.findIndex((c) => /^Total/.test(c) && /Unid/.test(c));
    const somaMeses = det.every((l) => iMes.reduce((a, i) => a + Number(l[i] ?? 0), 0) === Number(l[iTotal]));
    ok(`${m} meses: Excel tem ${iMes.length} colunas de mês (todos, com rótulos completos), ${det.length} linhas de detalhe (=${rows.length}), ${tot.length} «Total artigo» e um só «Total Unid.»`, iMes.length === m && det.length === rows.length && cab.filter((c) => /Unid/.test(c)).length === 1 && cab.filter((c) => c === "Stock").length === 1 && !cab.some((c) => /bloco|Parte/i.test(c)), cab.join("|"));
    ok(`${m} meses: Excel — valores por linha batem com os dados (soma dos meses = Total Unid.)`, somaMeses);
  }

  // ── G. e-mail e endpoint: o mesmo pipeline ──
  console.log("\n=== G. PDF do e-mail e do endpoint: o mesmo gerador (papel A3 incluído) ===");
  {
    const email = src("app/api/reports/email/route.ts"), pdfRoute = src("app/api/reports/pdf/route.ts"), servidor = src("lib/reporting/report-pdf-server.ts"), imp = src("lib/reporting/report-print.ts");
    ok("o e-mail anexa o PDF de buildReportPdfBuffer (o mesmo do endpoint /api/reports/pdf)", /buildReportPdfBuffer\(report\)/.test(email) && /buildReportPdfBuffer\(/.test(pdfRoute));
    ok("buildReportPdfBuffer usa as opções de pdf-opcoes.ts (formato A4/A3 de meta.paperSize, margens, preferCSSPageSize)", /opcoesPdfDoRelatorio\(report\)/.test(servidor));
    const rel = relatorio(dados({ artigos: 5, meses: 14, nFarm: 2 }), 14, 2);
    const o = opcoesPdfDoRelatorio(rel);
    ok(`pdf-opcoes: formato ${o.format}, landscape, preferCSSPageSize, margens ${o.margin.left}/${o.margin.top}`, o.format === rel.meta!.paperSize && o.landscape && o.preferCSSPageSize && o.margin.left === `${rel.meta!.pageMarginMm}mm`);
    ok("a impressão do browser: o iframe tem o tamanho do papel do relatório (A3 → 420×297 mm) e o @page pede o mesmo papel", /PAPEL_HORIZONTAL_MM\[papel\]/.test(imp) && /width:\$\{dim\.largura\}mm/.test(imp));
    const rel2 = relatorio(dados({ artigos: 5, meses: 3, nFarm: 2 }), 3, 2);
    ok("outros relatórios sem paperSize continuam A4 (o PDF/impressão de Margens, Inventário… não mudam)", opcoesPdfDoRelatorio({ ...rel2, meta: { ...rel2.meta!, paperSize: undefined, pageMarginMm: undefined } }).format === "A4" && !/size: A3/.test(renderReportHtml({ ...rel2, meta: { ...rel2.meta!, paperSize: undefined } })));
  }

  // ── H. separadores: meses (verticais) e 2px entre artigos, em A4 e A3 (1.ª e última página) ──
  console.log("\n=== H. Separadores verticais dos meses e filete de 2px entre artigos (PDFs A4 e A3; 1.ª e última páginas) ===");
  for (const p of profundos) {
    const f2 = path.join(dir, `rec-${path.basename(p.pdf)}`);
    spawnSync("python", [path.resolve("scripts/e2e/_recortar_pdf.py"), p.pdf, f2, "1", "-1"], { encoding: "utf8" });
    // em A3 o Python puro é lento: renderiza-se a 100 dpi (o filete de 0,75 pt continua a ver-se; a espessura mede-se por integral de escuridão)
    const dpi = p.rel.meta!.paperSize === "A3" ? 100 : undefined;
    const m = medirMeses(f2, () => p.n, dpi);
    ok(`${p.tag} (${p.rel.meta!.paperSize}): ${p.n + 1} filetes de mês contínuos do cabeçalho ao fim, cada mês entre dois filetes, nada cortado (${m.nLimites.join("/")} em ${m.nPaginas} pág.)`, m.falhas.length === 0 && m.nLimites.length === m.nPaginas, m.falhas.slice(0, 3).join(" | "));
    ok(`${p.tag}: filete de mês ${m.minLargura.toFixed(2)}–${m.maxLargura.toFixed(2)} pt (≤ 0,95, o de 1px CSS) e mais fino do que o separador de 2px entre artigos`, m.maxLargura > 0 && m.minLargura >= 0.45 && m.maxLargura <= 0.95);
    const seps = separadoresDe(f2, dpi);
    const grossos = seps.flatMap((s) => s.separadores.filter((x) => x.espessura >= 1.2 && x.cinzento >= 110 && x.cinzento <= 180));
    ok(`${p.tag}: separador de 2px entre artigos presente (${grossos.length} nas 2 páginas medidas, espessura ${grossos.length ? Math.min(...grossos.map((x) => x.espessura)).toFixed(2) : "—"}–${grossos.length ? Math.max(...grossos.map((x) => x.espessura)).toFixed(2) : "—"} pt ≈ 1,5)`, grossos.length >= 3 && grossos.every((x) => x.espessura >= 1.2 && x.espessura <= 2.4));
  }

  await browser.close();
  apagarPasta(dir);
  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
