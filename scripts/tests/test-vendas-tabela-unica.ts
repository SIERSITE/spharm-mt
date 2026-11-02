/**
 * Mapa de Vendas numa SÓ tabela contínua, em A4 HORIZONTAL SEMPRE (2026-11, segundo desenho — o A3 automático foi rejeitado).
 *
 * Requisito do utilizador, provado aqui sobre PDFs REAIS (Chromium → PDF → PyMuPDF), sobre a geometria das colunas no DOM e sobre a impressão:
 *   1 formato A4 horizontal (841,9 × 595,3 pt) · 2 corpo da tabela (meses incluídos) ≥ 8 pt, CNP e Descrição ≥ meses, cabeçalhos ≥ 8 pt a negrito ·
 *   3 colunas: CNP, Descrição, Farmácia, PVP*, Custo unit.*, N meses «Out/25», Total unid., Stock — 14 meses na MESMA página ·
 *   4 «Custo total est.» e «Valor Vendas (s/IVA)» fora da tabela: resumo financeiro no fim, uma só vez, conforme as opções de preços ·
 *   5 cada artigo uma só vez, TOTAL ARTIGO só com > 1 farmácia (sem PVP/custo) · 6 paginação só na vertical, artigo nunca dividido, TOTAL GERAL
 *   e resumo no fim com o último artigo · 7 período que não cabe em A4 ≥ 8 pt: mensagem em vez de PDF/impressão/pré-visualização truncados
 *   (HTTP 422), Excel e ecrã sem limite · 8 Excel idêntico ao de a012428.
 *
 * Secções: A capacidadeA4 (pura) · B estrutura do relatório/HTML · C PDFs reais por cenário · D impressão = PDF = pré-visualização ·
 *          E Excel idêntico a a012428 · F excesso (24/27 meses) · G rotas HTTP (422) · H outros relatórios intactos · I controlo negativo.
 *
 * Corre com:  npx tsx scripts/tests/test-vendas-tabela-unica.ts            (≈ 8-12 min: ~40 PDFs reais)
 *             TABELA_UNICA_RAPIDO=1 npx tsx …                              (subconjunto de cenários)
 * Variáveis: A012428_ROOT = worktree em a012428 (para o Excel e os outros relatórios); sem ele usa o caminho por omissão e, se não existir, salta E/H.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { buildReportWorkbook } from "../../lib/reporting/report-excel-buffer";
import { renderReportHtml } from "../../lib/reporting/report-html";
import { aplicarPrivacidade } from "../../lib/reporting/privacidade";
import { capacidadeA4, DESCRICAO_MIN_MM, FOLGA_MM, FONTE_PT, LARGURA_UTIL_MM, LIMITES, MARGEM_LATERAL_VENDAS_MM, MESES_GARANTIDOS, orcamentoPiorCaso, PAD_GARANTIA_PX, PADDINGS_PX, mensagemExcesso, type Maximos, type TextosDasColunas } from "../../lib/reporting/layout-largura";
import { bloqueadoPorA4, capacidadeDoRelatorio, colunasVisiveis } from "../../lib/reporting/layout-vendas";
import { opcoesPdfDoRelatorio } from "../../lib/reporting/pdf-opcoes";
import { analisar } from "./_analise-tabela-unica";
import { abrirBrowser, apagarPasta, dados, FARMACIAS_CLIENTE, lerPdf, medirDom, novaPasta, pdfDe, pdfImpressao, relatorio, relatorioCliente, relatorioLinhas } from "./_tabela-unica";
import { dadosPiorCaso, dadosRealMult, FARMACIAS_3 } from "./_cliente-real";
import { medirMeses } from "./_verticais-meses";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { passed++; console.log(`  [OK]    ${label}`); }
  else { failed++; console.log(`  [FALHA] ${label}${detalhe ? `  → ${detalhe}` : ""}`); }
};
const RAPIDO = process.env.TABELA_UNICA_RAPIDO === "1";
const src = (p: string) => readFileSync(p, "utf8");
const A012428 = process.env.A012428_ROOT ?? "C:/projetos/spharm-mt-worktrees/spharm-mt-worktrees/garantia-fase";
const corpoDe = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "");
const COMBOS = [[true, true], [true, false], [false, true], [false, false]] as const;
const nomeCombo = (v: boolean, c: boolean) => `venda=${v ? "sim" : "não"} compra=${c ? "sim" : "não"}`;

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A. capacidadeA4: LIMITES numéricos fixos ⇒ 14 meses cabem SEMPRE (função pura, determinística)
// ───────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n=== A. capacidadeA4: limites fixos garantem os 14 meses em A4 horizontal ≥ 8 pt (função pura) ===");

const fmtInt = (v: number) => new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0 }).format(v);
const fmtMoeda = (v: number) => new Intl.NumberFormat("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
/** Textos (como a tabela os desenha) de um conjunto de valores: PVP/custo sem «€» (o símbolo está no cabeçalho), inteiros com separador de milhares. */
function textosDeValores(v: { pvp: number; custo: number; mes: number; total: number; stock: number }): { textos: TextosDasColunas; maximos: Maximos } {
  return {
    textos: {
      codigo: ["5880034"], farmacia: ["Silveirense", "TOTAL ARTIGO"], pvp: [fmtMoeda(v.pvp)], custoUnitario: [fmtMoeda(v.custo)],
      totalUnid: [fmtInt(v.total), fmtInt(-v.total)], stock: [fmtInt(v.stock), fmtInt(-v.stock)], mes: ["·", fmtInt(v.mes), fmtInt(-v.mes)], rotulosMes: ["Out/25", "Nov/26", "Mai/26", "Ago/26"],
    },
    maximos: { pvp: v.pvp, custoUnitario: v.custo, mes: v.mes, totalUnid: v.total, stock: v.stock },
  };
}
const NOS_LIMITES = textosDeValores({ pvp: LIMITES.preco, custo: LIMITES.preco, mes: LIMITES.mes, total: LIMITES.total, stock: LIMITES.stock });
const capL = (n: number, v: boolean, c: boolean, d = NOS_LIMITES) => capacidadeA4({ nMeses: n, textos: d.textos, maximos: d.maximos }, { incluirVenda: v, incluirCompra: c });
/** Dados moderados para a capacidade ACIMA de 14 meses (depende dos dados): totais mensais até 4 dígitos, PVP ≤ 91,80 €. */
const MODERADO = textosDeValores({ pvp: 91.8, custo: 48.18, mes: 1077, total: 14350, stock: 1492 });
const TABELA: Record<string, number> = {};
{
  ok(`área útil: A4 horizontal 297 − 2×${MARGEM_LATERAL_VENDAS_MM} = ${LARGURA_UTIL_MM} mm; margens laterais ≥ 5 mm (impressoras)`, LARGURA_UTIL_MM === 297 - 2 * MARGEM_LATERAL_VENDAS_MM && MARGEM_LATERAL_VENDAS_MM >= 5 && MARGEM_LATERAL_VENDAS_MM <= 7);
  ok("limites documentados: PVP/custo 9 999,99 €; mensal 99 999; Total unid. e Stock 999 999; Descrição ≥ 45 mm; 14 meses", LIMITES.preco === 9999.99 && LIMITES.mes === 99999 && LIMITES.total === 999999 && LIMITES.stock === 999999 && DESCRICAO_MIN_MM >= 45 && MESES_GARANTIDOS === 14);
  ok("determinística: a mesma entrada dá exatamente a mesma decisão", JSON.stringify(capL(14, true, true)) === JSON.stringify(capL(14, true, true)));
  ok("padding horizontal só desce (5 → 1,5 px) — a letra nunca (10,7 px = 8,025 pt)", PADDINGS_PX[0] === 5 && PADDINGS_PX[PADDINGS_PX.length - 1] === PAD_GARANTIA_PX && PADDINGS_PX.every((p, i) => i === 0 || p < PADDINGS_PX[i - 1]) && FONTE_PT >= 8);

  // ORÇAMENTO DE LARGURA DO PIOR CASO (mm), coluna a coluna, com 14 meses, ao padding da garantia — impresso para as notas
  console.log("\n  — Orçamento de largura do pior caso (mm; 14 meses; padding 1,5 px; útil 285 mm) —");
  console.log("  | venda | compra | CNP | Farmácia | PVP € | Custo € | Total unid. | Stock | 14 × mês | fixos+meses | sobra p/ Descrição |");
  for (const [v, c] of COMBOS) {
    const o = orcamentoPiorCaso({ incluirVenda: v, incluirCompra: c });
    const k = o.colunas;
    console.log(`  | ${v ? "sim" : "não"} | ${c ? "sim" : "não"} | ${k.codigo.toFixed(1)} | ${k.farmacia.toFixed(1)} | ${k.pvp.toFixed(1)} | ${k.custoUnitario.toFixed(1)} | ${k.totalUnid.toFixed(1)} | ${k.stock.toFixed(1)} | ${o.meses.toFixed(1)} (${k.mes.toFixed(2)}/mês) | ${o.total.toFixed(1)} | ${o.sobraDescricao.toFixed(1)} |`);
    ok(`PROVA POR CÁLCULO (${nomeCombo(v, c)}): no pior caso simultâneo, 14 meses + colunas fixas deixam ${o.sobraDescricao.toFixed(1)} mm ≥ ${DESCRICAO_MIN_MM} mm (+ ${FOLGA_MM} mm de folga) para a Descrição`, o.sobraDescricao >= DESCRICAO_MIN_MM + FOLGA_MM);
  }

  // 14 meses (e menos) dentro dos limites: SEMPRE cabem — varrimento de uma grelha de combinações (nunca 422)
  const PRECOS = [9.99, 99.99, 999.99, 9999.99], MESES_V = [0, 9, 99, 999, 9999, 99999], TOTAIS = [9, 99999, 999999];
  let n = 0, falhas = 0, minDesc = Infinity;
  for (const [v, c] of COMBOS) for (const pvp of PRECOS) for (const custo of PRECOS) for (const mes of MESES_V) for (const tot of TOTAIS) for (const stk of TOTAIS) for (const nm of [1, 3, 12, 14]) {
    const d = textosDeValores({ pvp, custo, mes, total: tot, stock: stk });
    const r = capL(nm, v, c, d);
    n++;
    if (!r.cabe || r.mensagem || r.excessos.length > 0 || r.descricaoMm < DESCRICAO_MIN_MM - 1e-6) falhas++;
    minDesc = Math.min(minDesc, r.descricaoMm);
  }
  ok(`GRELHA: ${n} combinações (PVP × custo × mensal × total × stock × 4 combinações de preços × 1/3/12/14 meses) dentro dos limites ⇒ SEMPRE «cabe», sem mensagem, Descrição ≥ ${DESCRICAO_MIN_MM} mm (mín. ${minDesc.toFixed(1)} mm)`, falhas === 0, `${falhas} falhas`);
  for (const [v, c] of COMBOS) {
    const seq = Array.from({ length: 14 }, (_, i) => capL(i + 1, v, c));
    ok(`pior caso simultâneo (${nomeCombo(v, c)}): 1…14 meses cabem; larguras somam 100 %; Descrição ≥ ${DESCRICAO_MIN_MM} mm; padding só diminui com os meses`, seq.every((d, i, a) => {
      const p = d.pct;
      const soma = p.codigo + p.farmacia + p.pvp + p.custoUnitario + p.totalUnid + p.stock + p.descricao + p.mes * d.nMeses;
      return d.cabe && Math.abs(soma - 100) < 1e-6 && d.descricaoMm >= DESCRICAO_MIN_MM - 1e-6 && (i === 0 || d.padPx <= a[i - 1].padPx) && (v || d.pct.pvp === 0) && (c || d.pct.custoUnitario === 0);
    }));
    ok(`pior caso (${nomeCombo(v, c)}): mesesMax ≥ 14`, capL(14, v, c).mesesMax >= 14);
  }

  // Limites ultrapassados: mensagem com o limite concreto (e só aí se recusa 14 meses)
  const exc = (o: Partial<{ pvp: number; custo: number; mes: number; total: number; stock: number }>) => capL(14, true, true, textosDeValores({ pvp: 100, custo: 100, mes: 100, total: 100, stock: 100, ...o }));
  const casos: [string, ReturnType<typeof exc>, RegExp][] = [
    ["PVP 12 345,67 €", exc({ pvp: 12345.67 }), /^PVP de 12 345,67 € excede o limite de 9 999,99 € do PDF A4 legível\./],
    ["custo 10 000,00 €", exc({ custo: 10000 }), /^Custo unitário de 10 000,00 € excede o limite de 9 999,99 € do PDF A4 legível\./],
    ["mensal 100 000", exc({ mes: 100000 }), /^Valor mensal de 100 000 unidades excede o limite de 99 999 do PDF A4 legível\./],
    ["total 1 000 000", exc({ total: 1000000 }), /^Total de unidades de 1 000 000 excede o limite de 999 999 do PDF A4 legível\./],
    ["stock 1 234 567", exc({ stock: 1234567 }), /^Stock de 1 234 567 excede o limite de 999 999 do PDF A4 legível\./],
  ];
  for (const [nome, r, re] of casos) {
    const msg = (r.mensagem ?? "").replace(/ /g, " ");
    ok(`acima do limite (${nome}): não cabe e a mensagem diz o limite concreto — «${msg.slice(0, 80)}…»`, !r.cabe && re.test(msg) && /Reduza a seleção, retire preços ou use o Excel\.$/.test(msg));
  }
  ok("exatamente NO limite (9 999,99 €; 99 999; 999 999) cabe; um passo acima não", capL(14, true, true).cabe && !exc({ pvp: 10000 }).cabe && !exc({ mes: 100000 }).cabe);
  ok("PVP acima do limite com «Incluir preços de venda» desligado NÃO recusa (a coluna não existe)", capacidadeA4({ nMeses: 14, ...textosDeValores({ pvp: 50000, custo: 5, mes: 5, total: 5, stock: 5 }) }, { incluirVenda: false, incluirCompra: true }).cabe);

  // ACIMA de 14 meses a capacidade depende dos dados (documentada)
  for (const [nome, d] of [["moderados", MODERADO], ["limites (pior caso)", NOS_LIMITES]] as const) {
    for (const [v, c] of COMBOS) {
      const max = capL(15, v, c, d).mesesMax;
      TABELA[`${nome}|${v}|${c}`] = max;
      const seq = Array.from({ length: 40 }, (_, i) => capL(i + 15, v, c, d));
      ok(`${nome} · ${nomeCombo(v, c)}: acima de 14 meses cabe ⇔ n ≤ mesesMax (${max})`, seq.every((r, i) => r.cabe === (i + 15 <= max)) && max >= 14);
      ok(`${nome} · ${nomeCombo(v, c)}: 24 e 27 meses NÃO cabem`, !capL(24, v, c, d).cabe && !capL(27, v, c, d).cabe);
    }
  }
  const d24 = capL(24, true, true, MODERADO);
  ok("mensagem de excesso de meses exata (24 meses, todos os preços)", d24.mensagem === `O período de 24 meses não cabe numa página A4 legível (máximo ${d24.mesesMax} meses com estas opções). Reduza o período, retire preços ou use o Excel.` && d24.mensagem === mensagemExcesso(24, d24.mesesMax));
  console.log("\n  — Capacidade acima de 14 meses (nº máximo de meses; depende dos dados) —");
  console.log("  | venda | compra | dados moderados (≤ 1 077 por mês; PVP ≤ 91,80 €) | pior caso dos limites |");
  for (const [v, c] of COMBOS) console.log(`  | ${v ? "sim" : "não"} | ${c ? "sim" : "não"} | ${TABELA[`moderados|${v}|${c}`]} | ${TABELA[`limites (pior caso)|${v}|${c}`]} |`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// B. estrutura do relatório e do HTML
// ───────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n=== B. estrutura: colunas, resumo financeiro, TOTAL ARTIGO, Excel ===");
const rel14 = relatorioCliente({ meses: 14 });
{
  const chaves = colunasVisiveis(rel14).map((c) => c.key);
  const meses = chaves.filter((k) => k.startsWith("m_"));
  ok("colunas do HTML/PDF: CNP, Descrição, Farmácia, PVP, Custo unit., 14 meses, Total unid., Stock — por esta ordem", chaves.join(",") === ["codigo", "descricao", "farmacia", "pvp", "custoUnitarioEstimado", ...meses, "totalVendas", "existencia"].join(",") && meses.length === 14);
  ok("«Custo total est.» e «Valor Vendas (s/IVA)» são só Excel (excelOnly): não são colunas da tabela", rel14.columns.filter((c) => c.excelOnly).map((c) => c.key).join(",") === "custoEstimado,valorBruto,tipoLinha");
  const htmlTotal = renderReportHtml(rel14);
  const html = corpoDe(htmlTotal); // sem o <style> (os comentários do CSS falam de «TOTAL GERAL», «TOTAL ARTIGO»…)
  const thead = (html.match(/<thead>[\s\S]*?<\/thead>/) ?? [""])[0];
  ok("cabeçalho HTML: meses «Out/25»…«Nov/26» numa linha; «Total unid.»; sem «Custo total», «Valor Vendas», «Parte», «bloco», «Período:»", /Out\/25/.test(thead) && /Nov\/26/.test(thead) && /Total<br\/>unid\./.test(thead) && !/Custo total|Valor Vendas|Parte|bloco|Período:/.test(thead));
  const corpoTabela = html.slice(html.indexOf('<tbody class="row-group'), html.indexOf('<tbody class="totals-tbody"'));
  ok("PVP e custo unitário: «€» só no cabeçalho («PVP €», «Custo unit. €»); as células mostram «9999,99» sem símbolo (o Excel mantém o formato monetário)", /PVP €/.test(thead) && /Custo<br\/>unit\. €/.test(thead) && !/\d(\s|&nbsp;| )€/.test(corpoTabela) && !/€/.test(corpoTabela));
  ok("HTML: uma tabela, um <thead>, um TOTAL GERAL, um resumo financeiro, sem «Parte i de n»/«bloco»", (html.match(/<table/g) ?? []).length === 1 && (html.match(/<thead>/g) ?? []).length === 1 && (html.match(/TOTAL GERAL/g) ?? []).length === 1 && (html.match(/data-testid="resumo-financeiro"/g) ?? []).length === 1 && !/Parte \d+ de|bloco-temporal|Total unid\. do bloco/.test(html));
  ok("HTML: @page A4 horizontal com margem lateral de 6 mm; nunca A3", /@page \{ size: A4 landscape; margin: 10mm 6mm; \}/.test(htmlTotal) && !/A3/.test(htmlTotal.replace(/\/\*[\s\S]*?\*\//g, "")));
  ok("HTML: corpo e cabeçalhos da tabela a 10,7 px (8,025 pt) e Arial/Liberation Sans", /hierarchy-clean table \{ font-size: 10\.7px; \}/.test(htmlTotal) && /hierarchy-clean thead th \{[^}]*font-size: 10\.7px/.test(htmlTotal) && /hierarchy-clean tbody td \{ font-size: 10\.7px/.test(htmlTotal) && /font-family: Arial, "Liberation Sans"/.test(htmlTotal));
  // TOTAL ARTIGO: só com > 1 farmácia; PVP/custo vazios no HTML
  const sub = rel14.rows.filter((r) => r.tipoLinha === "Total artigo");
  let okSub = sub.length > 0;
  for (const s of sub) okSub = okSub && rel14.rows.filter((r) => r.codigo === s.codigo && r.tipoLinha === "Detalhe").length >= 2;
  const artigos1 = new Set(rel14.rows.filter((r) => r.tipoLinha === "Detalhe").map((r) => r.codigo));
  const comSub = new Set(sub.map((s) => s.codigo));
  ok(`TOTAL ARTIGO só nos artigos com ≥ 2 farmácias (${sub.length} de ${artigos1.size} artigos), nunca com uma só`, okSub && [...artigos1].every((c) => (rel14.rows.filter((r) => r.codigo === c && r.tipoLinha === "Detalhe").length > 1) === comSub.has(c)));
  const linhasSub = (html.match(/<tr class="subtotal-row">[\s\S]*?<\/tr>/g) ?? []);
  ok("HTML: a linha TOTAL ARTIGO tem as células de PVP e custo unitário VAZIAS (sem «—»)", linhasSub.length === sub.length && linhasSub.every((l) => (l.match(/<td[^>]*><\/td>/g) ?? []).length >= 2 && !/—/.test(l)));
  ok("Excel: a linha TOTAL ARTIGO mantém o PVP/custo da linha como estava (a célula do Report não muda; só o HTML as esconde)", sub.every((s) => s.pvp === null && s.custoUnitarioEstimado === null && s.custoEstimado !== undefined));
  // resumo financeiro
  const rows = dadosSomas();
  const rf = rel14.meta?.resumoFinal ?? [];
  const val = (l: string) => rf.find((i) => i.label === l)?.value;
  ok("resumo financeiro: unidades, stock, custo total estimado e valor de vendas s/IVA = somas do detalhe (as do TOTAL GERAL do Excel)", val("Unidades vendidas") === rows.unid && val("Stock total") === rows.stock && Math.abs(Number(val("Custo total estimado")) - rows.custo) < 0.01 && Math.abs(Number(val("Valor total de vendas (s/IVA)")) - rows.valor) < 0.01, JSON.stringify([val("Unidades vendidas"), rows.unid, val("Custo total estimado"), rows.custo]));
  for (const [v, c] of COMBOS) {
    const r = relatorioCliente({ meses: 6, artigos: 30, venda: v, compra: c });
    const h = corpoDe(renderReportHtml(r));
    const bloco = (h.match(/<div class="resumo-final"[\s\S]*?<\/div><\/div><\/td>/) ?? [""])[0];
    const titulo = (bloco.match(/<div class="rf-titulo">(.*?)<\/div>/) ?? [])[1];
    ok(`resumo financeiro (${nomeCombo(v, c)}): unidades+stock sempre; custo só com compra; valor de vendas só com venda; título «${titulo}»`, /Unidades vendidas/.test(bloco) && /Stock total/.test(bloco) && /Custo total estimado/.test(bloco) === c && /Valor total de vendas/.test(bloco) === v && titulo === (v || c ? "Resumo financeiro" : "Resumo"));
    ok(`privacidade (${nomeCombo(v, c)}): nada de PVP/custo/valor em HTML nem no Excel quando a classe está desligada`, (v || !/PVP|Valor total de vendas|Valor de vendas/.test(h)) && (c || !/Custo/.test(h)) && wbHeaders(r).includes("Tipo de linha") && (v === wbHeaders(r).includes("PVP")) && (c === wbHeaders(r).includes("Custo unit. est.")));
  }
  // custo parcial: linha sem custo → nota PARCIAL no resumo
  const rParc = relatorioCliente({ meses: 3, artigos: 20 });
  const rowsP = dados({ artigos: 20, meses: 3, nFarm: 2 });
  rowsP[0].custoUnitarioEstimado = null; rowsP[0].custoEstimado = null;
  const rP = relatorio(rowsP, 3, 2, true, true);
  const hP = renderReportHtml(rP);
  ok("custo em falta: o resumo mostra o custo como PARCIAL com o nº de linhas sem custo (lógica atual do adapter)", /PARCIAL: 1 linha\(s\) sem custo conhecido ficam fora do total/.test(hP) && !/PARCIAL/.test(renderReportHtml(rParc).replace(/Stock total PARCIAL/g, "")));
  const rStk = dados({ artigos: 10, meses: 3, nFarm: 2 });
  (rStk[0] as { existenciaConhecida?: boolean }).existenciaConhecida = false;
  ok("stock desconhecido: o resumo indica PARCIAL com o nº de linhas sem stock conhecido", /PARCIAL: 1 linha\(s\) sem stock conhecido/.test(renderReportHtml(relatorio(rStk, 3, 2, true, true))));
  // 1 farmácia: nunca TOTAL ARTIGO
  const r1 = relatorio(dados({ artigos: 30, meses: 6, nFarm: 1 }), 6, 1);
  ok("uma só farmácia no universo: nenhum TOTAL ARTIGO (nem no HTML nem nas linhas)", !r1.rows.some((r) => r.tipoLinha === "Total artigo") && !/TOTAL ARTIGO/.test(corpoDe(renderReportHtml(r1))));
  // opções de PDF
  const op = opcoesPdfDoRelatorio(rel14);
  ok("opções do PDF do endpoint: format A4, horizontal, margens 10 mm / 6 mm, cabeçalho de página «Pág. X / Y»", op.format === "A4" && op.landscape === true && op.margin.left === "6mm" && op.margin.right === "6mm" && op.margin.top === "10mm" && /pageNumber/.test(op.headerTemplate));
  // Excel: os cabeçalhos e o TOTAL GERAL
  const hdr = wbHeaders(rel14);
  ok("Excel: continua com «Custo total est.», «Valor Vendas (s/IVA)» e «Tipo de linha» (as mesmas colunas)", hdr.some((h) => /custo total/i.test(h)) && hdr.some((h) => /valor\s*vendas/i.test(h)) && hdr.includes("Tipo de linha"));
}
function dadosSomas() {
  const rows = (rel14.meta?.resumoFinal ?? []).length ? relatorioDados() : null;
  return rows!;
}
function relatorioDados() {
  // somas independentes, sobre as linhas de detalhe do Report
  const det = rel14.rows.filter((r) => r.tipoLinha === "Detalhe");
  return {
    unid: det.reduce((a, r) => a + Number(r.totalVendas), 0),
    stock: det.reduce((a, r) => a + (typeof r.existencia === "number" ? r.existencia : 0), 0),
    custo: det.reduce((a, r) => a + (typeof r.custoEstimado === "number" ? r.custoEstimado : 0), 0),
    valor: det.reduce((a, r) => a + Number(r.valorBruto ?? 0), 0),
  };
}
function wbHeaders(r: ReturnType<typeof relatorioCliente>): string[] {
  const wb = buildReportWorkbook(r);
  const ws = wb.Sheets["Relatório"];
  const linhas = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
  const i = linhas.findIndex((l) => l[0] === "CNP");
  return (linhas[i] as string[]).map((h) => String(h).replace(/\s+/g, " "));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// C-D. PDFs reais, impressão, pré-visualização
// ───────────────────────────────────────────────────────────────────────────────────────────────
type MetricasLinha = { nome: string; paginas: number; fonteMin: number; fonteMes: number; cnp: number; desc: number };
const resumoMetricas: MetricasLinha[] = [];

async function main() {
  const dir = novaPasta("vendas-a4-");
  const browser = await abrirBrowser();
  try {
    const cenario = async (nome: string, rel: ReturnType<typeof relatorioCliente>, o: { venda: boolean; compra: boolean; nMeses: number; esperaVarias?: boolean }) => {
      const f = path.join(dir, `${nome.replace(/[^a-z0-9]+/gi, "_")}.pdf`);
      await pdfDe(browser, rel, f);
      const dom = await medirDom(browser, rel);
      const pag = lerPdf(f);
      const r = analisar(pag, dom, rel, o);
      ok(`${nome}: A4 horizontal, ${r.metricas.paginas} pág., ${r.metricas.artigos} artigos, ${r.metricas.linhasDados} linhas; letra mín. ${r.metricas.fonteMinTabelaPt.toFixed(2)} pt; nada cortado; um TOTAL GERAL e um resumo no fim`, r.falhas.length === 0, r.falhas.slice(0, 4).join(" | "));
      resumoMetricas.push({ nome, paginas: r.metricas.paginas, fonteMin: r.metricas.fonteMinTabelaPt, fonteMes: r.metricas.fonteMedianaMesPt, cnp: r.metricas.fonteMedianaCnpPt, desc: r.metricas.fonteMedianaDescPt });
      return { f, pag, dom, r };
    };

    console.log("\n=== C. PDFs reais (Chromium com as opções do endpoint) ===");
    // C1. o caso do cliente: 326 artigos, 2 farmácias, 14 meses Out/25…Nov/26, preços de venda e de compra
    console.log("\n  — C1. PDF do cliente: 2025-10-01 a 2026-11-02, 326 artigos, Segurado + Silveirense —");
    const real = await cenario("cliente 14m 326 artigos (venda+compra)", rel14, { venda: true, compra: true, nMeses: 14, esperaVarias: true });
    ok("cliente: 14 meses na MESMA tabela e MESMA página (cada página tem os 14 rótulos Out/25…Nov/26 uma vez) — sem blocos", real.pag.length >= 15 && real.pag.every((p) => ["Out/25", "Nov/26"].every((m) => p.tokens.filter((t) => t[5] === m).length === 1)));
    ok(`cliente: ${real.r.metricas.paginas} páginas (o PDF de a012428 tinha 57 com blocos temporais)`, real.r.metricas.paginas > 1 && real.r.metricas.paginas < 57);
    ok("cliente: cada artigo/farmácia numa só linha — nº de linhas de dados do PDF = nº de linhas do relatório", real.r.metricas.linhasDados === rel14.rows.length);
    const ultimo = real.pag[real.pag.length - 1];
    ok("cliente: TOTAL GERAL e resumo financeiro na última página, com o fim do último artigo (nunca órfãos)", ultimo.tokens.some((t) => t[5] === "GERAL") && ultimo.tokens.some((t) => t[5] === "FINANCEIRO") && ultimo.tokens.some((t) => /^(Segurado|Silveirense)$/.test(t[5])));
    const txtTodo = real.pag.flatMap((p) => p.tokens.map((t) => t[5])).join(" ");
    ok("cliente: TOTAL GERAL = 980…15 por mês, 13 613 unidades, stock 1492; custo total e valor de vendas só no resumo", /980 1077 1040/.test(txtTodo) && /13.613/.test(txtTodo) && /1492/.test(txtTodo) && /221.362,54/.test(txtTodo) && /402.879,57/.test(txtTodo));

    for (const [v, c] of COMBOS.slice(1)) {
      if (RAPIDO) break;
      await cenario(`cliente 14m 326 artigos (${nomeCombo(v, c)})`, relatorioCliente({ meses: 14, venda: v, compra: c }), { venda: v, compra: c, nMeses: 14, esperaVarias: true });
    }

    // C2. 1, 3, 6, 12, 13, 14 meses
    console.log("\n  — C2. 1 / 3 / 6 / 12 / 13 meses, duas farmácias, as 4 combinações de preços —");
    for (const n of [1, 3, 6, 12, 13]) {
      for (const [v, c] of COMBOS) {
        if (RAPIDO && !(v && c) && n !== 13) continue;
        if (!(v && c) && ![3, 13].includes(n)) continue; // 4 combinações em 3 e 13 meses; nos restantes só «todos»
        await cenario(`${n} meses 70 artigos (${nomeCombo(v, c)})`, relatorioCliente({ meses: n, artigos: 70, venda: v, compra: c }), { venda: v, compra: c, nMeses: n, esperaVarias: true });
      }
    }

    // C3. capacidade máxima por combinação (dados do cliente) e uma a mais → mensagem
    console.log("\n  — C3. capacidade máxima (dados do cliente) por combinação de preços —");
    const capMax: Record<string, number> = {};
    for (const [v, c] of COMBOS) {
      const M = capacidadeDoRelatorio(relatorioCliente({ meses: 14, artigos: 70, venda: v, compra: c })).mesesMax;
      capMax[`${v}|${c}`] = M;
      const rM = relatorioCliente({ meses: M, artigos: 70, venda: v, compra: c });
      ok(`${nomeCombo(v, c)}: ${M} meses (o máximo) cabem; ${M + 1} não → mensagem`, bloqueadoPorA4(rM) === null && bloqueadoPorA4(relatorioCliente({ meses: M + 1, artigos: 70, venda: v, compra: c })) !== null);
      if (RAPIDO && !(v && c)) continue;
      await cenario(`${M} meses (máx.) 70 artigos (${nomeCombo(v, c)})`, rM, { venda: v, compra: c, nMeses: M, esperaVarias: true });
    }
    console.log(`  capacidade máxima com os dados do cliente: ${JSON.stringify(capMax)}`);

    // C4. uma farmácia, três farmácias, valores elevados e negativos
    console.log("\n  — C4. 1 e 3 farmácias; 123 456 unidades, −12 345 e 12 345,67 € —");
    await cenario("1 farmácia 14m 60 artigos", relatorio(dados({ artigos: 60, meses: 14, nFarm: 1 }), 14, 1), { venda: true, compra: true, nMeses: 14, esperaVarias: true });
    await cenario("3 farmácias 12m 60 artigos", relatorio(dados({ artigos: 60, meses: 12, nFarm: 3 }), 12, 3), { venda: true, compra: true, nMeses: 12, esperaVarias: true });
    // C6. LIMITES: o PDF real ×1 e ×10, as grandezas de PVP/custo/mensal/total/stock e o PIOR CASO SIMULTÂNEO — sempre 14 meses numa só tabela A4
    console.log("\n  — C6. 14 meses dentro dos LIMITES: «PDF real ×1/×10», PVP/custo, valores mensais, totais, stock, pior caso (2 e 3 farmácias) —");
    for (const mult of RAPIDO ? [10] : [1, 10]) {
      const rows = dadosRealMult(mult);
      const r = relatorioLinhas(rows, 14, FARMACIAS_CLIENTE);
      const x = await cenario(`PDF real ×${mult}: 326 artigos, 2 farmácias, 14 meses, descrições até 100 caracteres`, r, { venda: true, compra: true, nMeses: 14, esperaVarias: true });
      const cnps = x.pag.flatMap((p) => p.tokens.filter((t) => /^\d{7}$/.test(t[5]) && t[0] < p.w * 0.12).map((t) => t[5]));
      ok(`PDF real ×${mult}: 326 CNP distintos = 326 ocorrências na coluna CNP (nenhum repetido por divisão temporal)`, new Set(cnps).size === 326 && cnps.length === 326, `${new Set(cnps).size} distintos / ${cnps.length}`);
      ok(`PDF real ×${mult}: 1 TOTAL GERAL, 1 resumo financeiro, 14 cabeçalhos de mês em CADA página`, x.pag.flatMap((p) => p.tokens).filter((t) => t[5] === "GERAL").length === 1 && x.pag.flatMap((p) => p.tokens).filter((t) => t[5] === "RESUMO").length === 1 && x.pag.every((p) => p.tokens.filter((t) => /^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)\/\d\d$/.test(t[5])).length === 14));
    }
    for (const preco of RAPIDO ? [9999.99] : [9.99, 99.99, 999.99, 9999.99]) {
      await cenario(`PVP e custo unitário ${fmtMoeda(preco)} €: 14 meses, 2 farmácias`, relatorioLinhas(dadosPiorCaso({ pvp: preco, custo: preco }), 14, FARMACIAS_CLIENTE), { venda: true, compra: true, nMeses: 14, esperaVarias: true });
    }
    for (const mes of RAPIDO ? [99999] : [9, 99, 999, 9999, 99999]) {
      await cenario(`valor mensal +${fmtInt(mes)} e −${fmtInt(mes)}: 14 meses, 3 farmácias`, relatorioLinhas(dadosPiorCaso({ nFarm: 3, mesGrande: mes }), 14, FARMACIAS_3), { venda: true, compra: true, nMeses: 14, esperaVarias: true });
    }
    for (const tot of RAPIDO ? [999000] : [99999, 999000]) {
      await cenario(`Total unid. e Stock até ${fmtInt(tot)} (positivos e negativos): 14 meses, 2 farmácias`, relatorioLinhas(dadosPiorCaso({ total: tot, stock: tot }), 14, FARMACIAS_CLIENTE), { venda: true, compra: true, nMeses: 14, esperaVarias: true });
    }
    for (const nf of [2, 3] as const) for (const [v, c] of COMBOS) {
      if (RAPIDO && !(v && c)) continue;
      const farms = nf === 3 ? FARMACIAS_3 : FARMACIAS_CLIENTE;
      const r = relatorioLinhas(dadosPiorCaso({ nFarm: nf, mesGrande: 99999, total: 999000, stock: 999000 }), 14, farms, v, c);
      const x = await cenario(`PIOR CASO simultâneo, ${nf} farmácias, ${nomeCombo(v, c)}: 9 999,99 € · ±99 999 · 999 000 · nome de farmácia de 32 caracteres · descrições de 100 caracteres`, r, { venda: v, compra: c, nMeses: 14, esperaVarias: true });
      const t = x.pag.flatMap((p) => p.tokens.map((q) => q[5])).join(" ");
      ok(`pior caso (${nf} farmácias, ${nomeCombo(v, c)}): 99 999 e −99 999 mensais e ±899 100 aparecem inteiros no PDF${v ? " (PVP 9999,99)" : ""}`, /99 ?999/.test(t) && /-99 ?999/.test(t) && /899 ?100/.test(t) && (!v || /9999,99/.test(t)));
    }
    // 14 meses dentro dos limites NUNCA são recusados (grelha de relatórios completos) e acima dos limites a mensagem diz o limite concreto
    {
      let n = 0, recusados = 0;
      for (const nf of [2, 3] as const) for (const [v, c] of COMBOS) for (const preco of [9.99, 99.99, 999.99, 9999.99]) for (const mes of [9, 999, 99999]) {
        const r = relatorioLinhas(dadosPiorCaso({ nFarm: nf, pvp: preco, custo: preco, mesGrande: mes, artigos: 6 }), 14, nf === 3 ? FARMACIAS_3 : FARMACIAS_CLIENTE, v, c);
        n++;
        if (bloqueadoPorA4(r) !== null) recusados++;
      }
      ok(`GRELHA de relatórios completos: ${n} combinações de 14 meses dentro dos limites ⇒ ${recusados} recusas (nunca 422)`, recusados === 0);
      const re = relatorioLinhas(dadosPiorCaso({ pvp: 12345.67, custo: 20, artigos: 6 }), 14, FARMACIAS_CLIENTE);
      ok("PVP de 12 345,67 € (14 meses) é recusado com o limite concreto na mensagem", (bloqueadoPorA4(re)?.mensagem ?? "").replace(/ /g, " ") === "PVP de 12 345,67 € excede o limite de 9 999,99 € do PDF A4 legível. Reduza a seleção, retire preços ou use o Excel.", bloqueadoPorA4(re)?.mensagem);
      const html = renderReportHtml(re);
      ok("…e a pré-visualização/PDF mostram essa mensagem (nunca uma tabela truncada)", !/<table/.test(html) && html.replace(/ /g, " ").includes("excede o limite de 9 999,99 €"));
      const rv = relatorioLinhas(dadosPiorCaso({ pvp: 12345.67, custo: 20, artigos: 6 }), 14, FARMACIAS_CLIENTE, false, true);
      ok("o mesmo PVP com «Incluir preços de venda» desligado já não é recusado (a coluna não existe)", bloqueadoPorA4(rv) === null);
    }

    // C5. paginação: varrimento do nº de artigos (o fim do último artigo ao lado do TOTAL GERAL e do resumo, nunca órfãos)
    console.log("\n  — C5. paginação: varrimento de 12 a 56 artigos (TOTAL GERAL/resumo nunca sozinhos; artigo nunca dividido) —");
    for (const nArt of RAPIDO ? [24, 40] : [12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56]) {
      const r = relatorioCliente({ meses: 14, artigos: nArt });
      const f = path.join(dir, `varre_${nArt}.pdf`);
      await pdfDe(browser, r, f);
      const dom = await medirDom(browser, r);
      const a = analisar(lerPdf(f), dom, r, { venda: true, compra: true, nMeses: 14 });
      ok(`${nArt} artigos (${a.metricas.paginas} pág.): sem falhas de paginação (TOTAL GERAL+resumo com artigos; artigos inteiros; cabeçalho em todas)`, a.falhas.length === 0, a.falhas.slice(0, 3).join(" | "));
    }

    // D. impressão = PDF = pré-visualização = PDF do email
    console.log("\n=== D. impressão, pré-visualização e PDF do email: a mesma estrutura ===");
    {
      const fImp = path.join(dir, "impressao.pdf");
      await pdfImpressao(browser, rel14, fImp);
      const imp = lerPdf(fImp);
      const domI = await medirDom(browser, rel14);
      const rI = analisar(imp, domI, rel14, { venda: true, compra: true, nMeses: 14, esperaVarias: true });
      ok(`impressão (iframe, @page): ${rI.metricas.paginas} páginas A4 horizontal, mesmas verificações do PDF`, rI.falhas.length === 0, rI.falhas.slice(0, 3).join(" | "));
      const sig = (ps: typeof imp) => ps.map((p) => p.tokens.filter((t) => t[4] >= 7.5).map((t) => t[5]).join("|")).join("\n#\n");
      ok("impressão = PDF do endpoint: o mesmo texto, página a página (só o contador «Pág. X / Y» do servidor difere)", sig(imp) === sig(real.pag));
      // pré-visualização = o MESMO HTML (renderReportHtml); email/endpoint recebem o Report serializado e reidratado
      const viaJson = JSON.parse(JSON.stringify(rel14));
      viaJson.generatedAt = new Date(viaJson.generatedAt);
      ok("pré-visualização = impressão = PDF = PDF do email: renderReportHtml dá exatamente o mesmo HTML ao Report original e ao Report que viaja em JSON para o servidor", renderReportHtml(rel14) === renderReportHtml(viaJson) && renderReportHtml(aplicarPrivacidade(viaJson)) === renderReportHtml(rel14));
      const html = renderReportHtml(rel14);
      ok("pré-visualização (ecrã): largura mínima de 297 mm (área útil do A4 + padding) com scroll — nunca colunas espremidas", /@media screen \{ \.page \{ min-width: 297mm; \} \}/.test(html));
      // separadores verticais dos meses e filete de 2 px entre artigos (PDF A4 real)
      const med = medirMeses(real.f, () => 14);
      ok(`separadores verticais dos meses: 15 filetes por página (14 meses), contínuos do cabeçalho ao fim, em todas as ${med.nPaginas} páginas`, med.falhas.length === 0 && med.nLimites.every((n) => n === 15), med.falhas.slice(0, 2).join(" | "));
    }

    // I. controlo negativo: a análise TEM de falhar com letra de 7 pt e com uma coluna cortada
    console.log("\n=== I. controlo negativo: a análise deteta defeitos ===");
    {
      const rNeg = relatorioCliente({ meses: 14, artigos: 8 });
      const page = await browser.newPage();
      try {
        await page.emulateMediaType("print");
        const h7 = renderReportHtml(rNeg).replace(/font-size: 10\.7px/g, "font-size: 7pt");
        await page.setContent(h7, { waitUntil: "networkidle0" });
        const f7 = path.join(dir, "neg7.pdf");
        writeFileSync(f7, await page.pdf(opcoesPdfDoRelatorio(rNeg)));
        const dom = await medirDom(browser, rNeg);
        const a7 = analisar(lerPdf(f7), dom, rNeg, { venda: true, compra: true, nMeses: 14 });
        ok("a análise acusa letra de 7 pt (< 8 pt)", a7.falhas.some((x) => /< 8 pt/.test(x)), a7.falhas.slice(0, 2).join(" | "));
        // colunas com largura insuficiente (cortam números)
        const hs = renderReportHtml(rNeg).replace(/<col style="width:[\d.]+%" \/>/g, '<col style="width:2%" />');
        await page.setContent(hs, { waitUntil: "load", timeout: 120000 });
        const fs2 = path.join(dir, "negcol.pdf");
        writeFileSync(fs2, await page.pdf(opcoesPdfDoRelatorio(rNeg)));
        const aS = analisar(lerPdf(fs2), dom, rNeg, { venda: true, compra: true, nMeses: 14 });
        ok("a análise acusa colunas desalinhadas/cortadas quando as larguras não são as calculadas", aS.falhas.length > 0);
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
    apagarPasta(dir);
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// E. Excel idêntico ao de a012428
// ───────────────────────────────────────────────────────────────────────────────────────────────
function excelIdentico() {
  console.log("\n=== E. Excel idêntico ao de a012428 (todas as células, tipos, formatos, larguras, fusões, filtro) ===");
  if (!existsSync(A012428)) { console.log(`  [SALTADO] worktree a012428 não encontrado em ${A012428} (defina A012428_ROOT)`); return; }
  const tmp = path.join(tmpdir(), `excel-${process.pid}`);
  const dump = (root: string, out: string) => spawnSync("npx", ["tsx", path.resolve("scripts/tests/_excel-dump.ts")], { cwd: root, env: { ...process.env, ROOT: root, OUT: out, DADOS: path.resolve("scripts/tests/_cliente-real.ts") }, encoding: "utf8", shell: true });
  const a = dump(A012428, `${tmp}-antes.json`), b = dump(process.cwd(), `${tmp}-depois.json`);
  if (a.status !== 0 || b.status !== 0) { ok("Excel: despejo das duas árvores", false, `${a.stderr}${b.stderr}`.slice(0, 300)); return; }
  const antes = JSON.parse(readFileSync(`${tmp}-antes.json`, "utf8")), depois = JSON.parse(readFileSync(`${tmp}-depois.json`, "utf8"));
  for (const nome of Object.keys(antes)) {
    const ca = antes[nome], cb = depois[nome];
    const difs = [...new Set([...Object.keys(ca.celulas), ...Object.keys(cb.celulas)])].filter((k) => JSON.stringify(ca.celulas[k]) !== JSON.stringify(cb.celulas[k]));
    const outros = ["ref", "cols", "merges", "autofilter", "folhas"].filter((k) => JSON.stringify(ca[k]) !== JSON.stringify(cb[k]));
    ok(`Excel «${nome}»: ${Object.keys(ca.celulas).length} células idênticas (valores, tipos, formatos, TOTAL GERAL), larguras, fusões e filtro`, difs.length === 0 && outros.length === 0, `${difs.length} células ≠ (${difs.slice(0, 3).map((k) => `${k}: ${JSON.stringify(ca.celulas[k])} → ${JSON.stringify(cb.celulas[k])}`).join("; ")}); campos ≠: ${outros.join(",")}`);
  }
  for (const f of readdirSync(tmpdir()).filter((x) => x.startsWith(`excel-${process.pid}`))) { try { statSync(path.join(tmpdir(), f)); writeFileSync(path.join(tmpdir(), f), ""); } catch { /* ignora */ } }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// F. período que não cabe em A4 legível: mensagem, nunca PDF truncado; Excel completo
// ───────────────────────────────────────────────────────────────────────────────────────────────
function excesso() {
  console.log("\n=== F. 24 e 27 meses: mensagem em vez de PDF/impressão/pré-visualização; Excel completo ===");
  for (const n of [24, 27]) {
    for (const [v, c] of COMBOS) {
      const r = relatorioCliente({ meses: n, artigos: 40, venda: v, compra: c });
      const cp = capacidadeDoRelatorio(r);
      const esperado = `O período de ${n} meses não cabe numa página A4 legível (máximo ${cp.mesesMax} meses com estas opções). Reduza o período, retire preços ou use o Excel.`;
      const b = bloqueadoPorA4(r);
      const html = corpoDe(renderReportHtml(r));
      ok(`${n} meses (${nomeCombo(v, c)}): bloqueado com a mensagem «${esperado.slice(0, 60)}…» (máx. ${cp.mesesMax})`, !cp.cabe && b !== null && b.mensagem === esperado && cp.mesesMax < n);
      ok(`${n} meses (${nomeCombo(v, c)}): a pré-visualização/impressão/PDF mostram só a mensagem — sem tabela truncada`, html.includes(esperado) && !/<table/.test(html) && /data-testid="relatorio-nao-cabe-a4"/.test(html));
      // Excel completo e inalterado
      const wb = buildReportWorkbook(r);
      const linhas = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets["Relatório"], { header: 1 });
      const iH = linhas.findIndex((l) => l[0] === "CNP");
      const cab = (linhas[iH] as string[]).map((h) => String(h).replace(/\s+/g, " "));
      const mesesCab = cab.filter((h) => /^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez) \d\d$/.test(h));
      const totalRow = linhas[linhas.length - 1] as (string | number)[];
      const iTot = cab.findIndex((h) => /Total unid\./.test(h));
      const somaDet = r.rows.filter((x) => x.tipoLinha === "Detalhe").reduce((a, x) => a + Number(x.totalVendas), 0);
      ok(`${n} meses (${nomeCombo(v, c)}): o Excel tem os ${n} meses, os preços conforme as opções e o TOTAL GERAL (${somaDet} unidades)`, mesesCab.length === n && totalRow[0] === "TOTAL GERAL" && Number(totalRow[iTot]) === somaDet && (v === cab.includes("PVP")) && (c === cab.includes("Custo unit. est.")));
    }
  }
  // o limite coincide entre capacidade, relatório e mensagem; 14 meses nunca é bloqueado
  ok("14 meses nunca são bloqueados (todas as combinações, dados do cliente)", COMBOS.every(([v, c]) => bloqueadoPorA4(relatorioCliente({ meses: 14, artigos: 60, venda: v, compra: c })) === null));
  // relatórios que não pedem legibilidade A4 nunca são bloqueados
  const outro = { ...relatorioCliente({ meses: 27, artigos: 5 }) };
  outro.meta = { ...outro.meta, legibilidadeA4: false };
  ok("só os relatórios que declaram `legibilidadeA4` são verificados (os outros nunca são bloqueados)", bloqueadoPorA4(outro) === null);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// G. rotas HTTP reais (POST /api/reports/pdf e /api/reports/email → 422)
// ───────────────────────────────────────────────────────────────────────────────────────────────
function rotas() {
  console.log("\n=== G. rotas HTTP: 422 com a mesma mensagem; PDF A4 quando cabe ===");
  const r = spawnSync("npx", ["tsx", path.resolve("scripts/tests/_rotas-pdf.ts")], { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024, timeout: 240000 });
  const linhas = (r.stdout ?? "").split("\n").filter((l) => l.startsWith("ROTA "));
  if (r.status !== 0 && linhas.length === 0) { ok("rotas HTTP executadas", false, `${r.stderr}`.slice(0, 400)); return; }
  for (const l of linhas) { const [, estado, ...resto] = l.split("|"); ok(resto.join("|").trim(), estado === "OK"); }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// H. outros relatórios (Margens, genérico) com o HTML idêntico ao de a012428; J. código sem A3/blocos
// ───────────────────────────────────────────────────────────────────────────────────────────────
function outrosRelatorios() {
  console.log("\n=== H. outros relatórios: o HTML não mudou ===");
  if (!existsSync(A012428)) { console.log("  [SALTADO] worktree a012428 não encontrado"); return; }
  const tmp = path.join(tmpdir(), `html-${process.pid}`);
  const dump = (root: string, out: string) => spawnSync("npx", ["tsx", path.resolve("scripts/tests/_html-dump.ts")], { cwd: root, env: { ...process.env, ROOT: root, OUT: out }, encoding: "utf8", shell: true });
  const a = dump(A012428, `${tmp}-a.json`), b = dump(process.cwd(), `${tmp}-b.json`);
  if (a.status !== 0 || b.status !== 0) { ok("HTML dos outros relatórios: despejo", false, `${a.stderr}${b.stderr}`.slice(0, 300)); return; }
  const A = JSON.parse(readFileSync(`${tmp}-a.json`, "utf8")), B = JSON.parse(readFileSync(`${tmp}-b.json`, "utf8"));
  for (const k of Object.keys(A)) {
    ok(`HTML «${k}»: o corpo do documento (${A[k].corpo.length} caracteres) é byte a byte igual ao de a012428`, A[k].corpo === B[k].corpo);
    ok(`HTML «${k}»: as regras de CSS que não são do Mapa de Vendas (${A[k].css.split("\n").length} regras) são exatamente as de a012428`, A[k].css === B[k].css);
  }
}

function codigo() {
  console.log("\n=== J. código: sem A3, sem blocos, sem escala ===");
  const ficheiros = ["lib/reporting/layout-largura.ts", "lib/reporting/layout-vendas.ts", "lib/reporting/pdf-opcoes.ts", "lib/reporting/report-html.ts", "lib/reporting/report-types.ts", "lib/reporting/report-print.ts", "lib/reporting/adapters/vendas.ts", "lib/reporting/report-pdf-server.ts"];
  const todo = ficheiros.map((f) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n"); // sem comentários
  ok("sem papel A3, `paperSize`, `contentZoom`, `compactMonths`, `columnBlocks`, `decidirLayout`, `repartirMeses` no código", !/A3|paperSize|contentZoom|compactMonths|columnBlocks|decidirLayout|repartirMeses|bloco-temporal/.test(todo));
  ok("o relatório de Vendas não usa `zoom` nem reduz a letra (sem font-size < 8pt na tabela limpa)", !/hierarchy-clean[^{]*\{[^}]*font-size: (7|6)(\.\d+)?(px|pt)/.test(todo));
}

(async () => {
  await main();
  excelIdentico();
  excesso();
  rotas();
  outrosRelatorios();
  codigo();
  console.log("\n=== Resumo das medidas (pt) ===");
  for (const m of resumoMetricas) console.log(`  ${m.nome}: ${m.paginas} pág.; letra mín. ${m.fonteMin.toFixed(2)}; meses ${m.fonteMes.toFixed(2)}; CNP ${m.cnp.toFixed(2)}; Descrição ${m.desc.toFixed(2)}`);
  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
