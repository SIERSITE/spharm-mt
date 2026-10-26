/**
 * scripts/tests/test-vendas-precos-pvp-stock.ts
 *
 * Mapa de Vendas (2026-10, 2.ª entrega):
 *   A · «Incluir preços de venda» / «Incluir preços de compra» — as 4 combinações em Report, HTML (Relatório/impressão/PDF/email),
 *       XLSX REAL (lido com zip: partes, folhas ocultas, colunas ocultas, strings partilhadas) — com valores-sentinela únicos;
 *   B · privacidade validada no servidor: relatório adulterado/incompleto continua a sair sem a informação retirada (falha-seguro);
 *   C · Total unid. destacado + Stock por artigo / Stock total (negativo, zero, desconhecido, sem dupla contagem);
 *   D · filtro «PVP diferente entre farmácias» (regra pura) e a frase nos filtros das saídas.
 *
 * Corre com:  npx tsx scripts/tests/test-vendas-precos-pvp-stock.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as XLSX from "xlsx";
import {
  buildVendasReport,
  ROTULO_FILTRO_PVP_DIFERENTE,
  stockTotalDoRelatorio,
  type VendasAdapterRow,
} from "../../lib/reporting/adapters/vendas";
import { renderReportHtml } from "../../lib/reporting/report-html";
import { buildReportExcelBuffer, buildReportWorkbook } from "../../lib/reporting/report-excel-buffer";
import { aplicarPrivacidade, descreverPrivacidade, lerPrivacidade } from "../../lib/reporting/privacidade";
import {
  artigoTemPvpDiferente,
  codigosComPvpDiferente,
  filtroPvpAplicavel,
  pvpEscalado,
  pvpsPorCodigo,
} from "../../lib/reporting/vendas-pvp-diferente";
import type { Report } from "../../lib/reporting/report-types";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { pass++; console.log(`  [OK]    ${label}`); }
  else { fail++; console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`); }
};
const norm = (t: string) => t.replace(/[  ]/g, " ");

const FARM = ["Farmácia Segurado", "Farmácia Silveirense"];
const buckets = (n: number, ano0 = 2026, mes0 = 1) =>
  Array.from({ length: n }, (_, i) => ({ ano: ano0 + Math.floor((mes0 - 1 + i) / 12), mes: ((mes0 - 1 + i) % 12) + 1 }));

type Opc = { codigo: string; farmacia?: string; qtd?: number[]; pvp?: number; custoUnit?: number | null; valor?: number; stock?: number; stockConhecido?: boolean; descricao?: string };
function linha(o: Opc, bks: { ano: number; mes: number }[]): VendasAdapterRow {
  const qs = bks.map((_, i) => o.qtd?.[i] ?? 0);
  const total = qs.reduce((a, b) => a + b, 0);
  const custoUnit = o.custoUnit === undefined ? 1 : o.custoUnit;
  return {
    codigo: o.codigo,
    descricao: o.descricao ?? `Artigo ${o.codigo}`,
    pvp: o.pvp ?? 1,
    custoUnitarioEstimado: custoUnit,
    custoEstimado: custoUnit === null ? null : Math.round(custoUnit * total * 100) / 100,
    meses: bks.map((b, i) => ({ ...b, quantidade: qs[i] })),
    totalVendas: total,
    valorBruto: o.valor ?? 0,
    existencia: o.stock ?? 5,
    ...(o.stockConhecido === false ? { existenciaConhecida: false } : {}),
    fornecedor: "F", fabricante: "Fab", categoria: "C", farmacia: o.farmacia ?? FARM[1], grupo: "G",
  };
}
const universo = { farmacias: FARM, fornecedores: [], fabricantes: [], categorias: [] };
const gerar = (rows: VendasAdapterRow[], bks: { ano: number; mes: number }[], opc: { venda?: boolean; compra?: boolean; filters?: Parameters<typeof buildVendasReport>[0]["filters"] } = {}): Report =>
  buildVendasReport({
    rows, buckets: bks, filters: opc.filters ?? { agruparPor: "artigo" }, universe: universo, organization: "Grupo Teste",
    incluirPrecosVenda: opc.venda, incluirPrecosCompra: opc.compra,
  });

const dir = mkdtempSync(path.join(tmpdir(), "vendas-precos-"));
function dumpXlsx(report: Report, nome: string) {
  const f = path.join(dir, `${nome}.xlsx`);
  writeFileSync(f, buildReportExcelBuffer(report).buffer);
  const py = spawnSync("python", [path.resolve("scripts/e2e/_xlsx_texto.py"), f], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (py.status !== 0) throw new Error(`python: ${py.stderr}`);
  return { ficheiro: f, ...(JSON.parse(py.stdout.trim().split("\n").pop() ?? "{}") as { partes: string[]; folhas: Array<{ nome: string; estado: string }>; texto: string }) };
}

// Valores-sentinela ÚNICOS por classe (nenhum coincide com outro nem com um total derivado do outro).
//   venda : PVP 11111.11 · valor de vendas 33333.33 · PVP estimado (Σ qtd×pvp) 22222.22 · total do valor 66666.66
//   compra: custo unitário 44444.44 (= custo total, qtd 1) · total do custo 88888.88
const VENDA_RAW = ["11111.11", "22222.22", "33333.33", "66666.66"];
const VENDA_FMT = ["11 111,11", "22 222,22", "33 333,33", "66 666,66"];
const COMPRA_RAW = ["44444.44", "88888.88"];
const COMPRA_FMT = ["44 444,44", "88 888,88"];
const temAlgum = (texto: string, lista: string[]) => lista.some((s) => texto.includes(s));

function linhasSentinela(bks: { ano: number; mes: number }[]): VendasAdapterRow[] {
  return [
    linha({ codigo: "7000001", qtd: [1, 0, 0], pvp: 11111.11, custoUnit: 44444.44, valor: 33333.33, descricao: "Produto Sentinela A", stock: 3 }, bks),
    linha({ codigo: "7000002", qtd: [1, 0, 0], pvp: 11111.11, custoUnit: 44444.44, valor: 33333.33, descricao: "Produto Sentinela B", stock: 4 }, bks),
  ];
}
const corpoHtml = (r: Report) => {
  const html = renderReportHtml(r);
  return norm(html.slice(html.indexOf("<body")).replace(/<style[\s\S]*?<\/style>/g, ""));
};

console.log("\n=== A. Quatro combinações de preços: Report, HTML e XLSX real ===");
{
  const bks = buckets(3);
  for (const [venda, compra] of [[true, true], [true, false], [false, true], [false, false]] as const) {
    const tag = `venda=${venda ? "sim" : "não"} · compra=${compra ? "sim" : "não"}`;
    const rel = gerar(linhasSentinela(bks), bks, { venda, compra });
    const json = JSON.stringify(rel);
    const cols = rel.columns.map((c) => c.key);
    ok(`${tag}: colunas — PVP/valor ${venda ? "presentes" : "AUSENTES"}, custos ${compra ? "presentes" : "AUSENTES"}, nunca vazias`,
      cols.includes("pvp") === venda && cols.includes("valorBruto") === venda && cols.includes("custoUnitarioEstimado") === compra && cols.includes("custoEstimado") === compra);
    ok(`${tag}: o Report que viaja (JSON do PDF/email) ${venda ? "leva" : "NÃO leva"} valores de venda e ${compra ? "leva" : "NÃO leva"} valores de compra`,
      temAlgum(json, VENDA_RAW) === venda && temAlgum(json, COMPRA_RAW) === compra, json.match(/(11111|22222|33333|44444|66666|88888)\.\d\d/)?.[0]);
    ok(`${tag}: resumo — monetários só das classes incluídas; unidades e stock total sempre`,
      (rel.summary ?? []).some((s) => s.label === "Valor PVP estimado") === venda && (rel.summary ?? []).some((s) => s.label === "Custo total estimado") === compra &&
      ["Unidades vendidas", "Stock total"].every((l) => (rel.summary ?? []).some((s) => s.label === l)));

    // HTML (Relatório / impressão / PDF / email)
    const corpo = corpoHtml(rel);
    ok(`${tag}: HTML — valores de venda ${venda ? "presentes" : "AUSENTES"} (formatados e crus)`, temAlgum(corpo, VENDA_FMT) === venda && temAlgum(corpo, VENDA_RAW) === false || (venda && temAlgum(corpo, VENDA_FMT)));
    ok(`${tag}: HTML — valores de compra ${compra ? "presentes" : "AUSENTES"}`, temAlgum(corpo, COMPRA_FMT) === compra);
    const ths = [...corpo.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<br\/>/g, " ").trim());
    ok(`${tag}: HTML — cabeçalhos: PVP/Valor Vendas ${venda ? "sim" : "não"}, Custo ${compra ? "sim" : "não"}, nenhum vazio`,
      ths.some((t) => /PVP/.test(t)) === venda && ths.some((t) => /Valor Vendas/.test(t)) === venda && ths.some((t) => /Custo/.test(t)) === compra && ths.every((t) => t.length > 0));
    ok(`${tag}: HTML — símbolo «€» ${venda || compra ? "presente" : "AUSENTE"}`, corpo.includes("€") === (venda || compra));
    const notas = rel.meta?.footer ?? "";
    ok(`${tag}: rodapé — fala de custos só com compra (${compra}), de valor de vendas só com venda (${venda})`, /Custo unit\. est\./.test(notas) === compra && /Valor de vendas/.test(notas) === venda);
    ok(`${tag}: a faixa de resumo (unidades · stock total) aparece sempre`, /data-testid="resumo-faixa"/.test(corpo) && /Stock total:/.test(corpo) && /Unidades vendidas:/.test(corpo));

    // XLSX real
    const x = dumpXlsx(rel, `mat-${venda ? 1 : 0}${compra ? 1 : 0}`);
    ok(`${tag}: XLSX — uma só folha, visível; sem folhas ocultas`, x.folhas.length === 1 && x.folhas[0].estado === "visible");
    // O único nome definido admitido é o interno do filtro automático (`_xlnm._FilterDatabase`, só referência de células).
    const nomesDefinidos = [...x.texto.matchAll(/<definedName[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    ok(`${tag}: XLSX — sem colunas ocultas, sem nomes definidos (além do filtro automático) nem comentários`, !/<col[^>]*hidden="1"/.test(x.texto) && nomesDefinidos.every((n) => n === "_xlnm._FilterDatabase") && !x.partes.some((n) => /comments|vmlDrawing/i.test(n)));
    ok(`${tag}: XLSX — TODAS as partes do ficheiro ${venda ? "levam" : "NÃO levam"} valores de venda e ${compra ? "levam" : "NÃO levam"} de compra`,
      temAlgum(x.texto, VENDA_RAW) === venda && temAlgum(x.texto, COMPRA_RAW) === compra);
    const g = XLSX.utils.sheet_to_json<unknown[]>(buildReportWorkbook(rel).Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][];
    const cab = ((g.find((r) => r[0] === "CNP") ?? []) as string[]).map(String);
    ok(`${tag}: XLSX — cabeçalhos coerentes com as opções, sem colunas vazias`,
      cab.some((h) => /PVP/.test(h)) === venda && cab.some((h) => /Valor/.test(h)) === venda && cab.some((h) => /Custo/.test(h)) === compra && cab.every((h) => h.length > 0));
    const linhasDados = g.filter((r) => String(r[0]).startsWith("70000"));
    ok(`${tag}: XLSX — as linhas de dados mantêm CNP, descrição, farmácia, meses, total e stock`,
      linhasDados.length >= 2 && ["Produto Sentinela A", "Farmácia Silveirense"].every((t) => linhasDados[0].includes(t)) && cab.includes("Stock"));
    const totalRow = g.find((r) => String(r[0]) === "TOTAL GERAL");
    ok(`${tag}: XLSX — linha de totais presente (unidades e stock) e sem totais monetários retirados`,
      !!totalRow && temAlgum(JSON.stringify(totalRow), VENDA_RAW) === venda && temAlgum(JSON.stringify(totalRow), COMPRA_RAW) === compra);
    ok(`${tag}: diálogo de envio descreve exatamente o que os anexos levam`,
      JSON.stringify(descreverPrivacidade(rel)) === JSON.stringify([`Preços de venda: ${venda ? "incluídos" : "NÃO incluídos"}`, `Preços de compra (custos): ${compra ? "incluídos" : "NÃO incluídos"}`]));
  }

  // Avisos de custo parcial só com compra
  const bks2 = buckets(3);
  const comLacuna = [...linhasSentinela(bks2), linha({ codigo: "7000003", qtd: [2, 0, 0], custoUnit: null, valor: 1, descricao: "Produto sem ficha de preco" }, bks2)];
  const rc = gerar(comLacuna, bks2, { venda: true, compra: true });
  const sc = gerar(comLacuna, bks2, { venda: true, compra: false });
  ok("custos em falta: com compra há «PARCIAL» e a contagem; sem compra não há nada disso (rodapé, resumo, HTML)",
    /PARCIAL/.test(rc.meta?.footer ?? "") && (rc.summary ?? []).some((s) => /sem custo/i.test(s.label)) &&
    !/PARCIAL|sem custo/i.test(sc.meta?.footer ?? "") && !(sc.summary ?? []).some((s) => /custo/i.test(s.label)) && !/PARCIAL|sem custo/i.test(corpoHtml(sc)));
}

console.log("\n=== B. Privacidade validada no servidor (falha-seguro) ===");
{
  const bks = buckets(3);
  const completo = gerar(linhasSentinela(bks), bks, { venda: true, compra: true });
  // Um cliente que reencaminha o relatório completo mas pede «sem preços» na meta (ou um payload adulterado):
  const adulterado = (p: unknown): Report => ({ ...completo, meta: { ...completo.meta!, privacidade: p as never } });
  const semVenda = aplicarPrivacidade(adulterado({ precosVenda: false, precosCompra: true, chavesVenda: ["pvp", "valorBruto"], chavesCompra: [] }));
  ok("relatório completo + meta «sem venda»: o servidor retira colunas, linhas e resumo de venda — e só esses",
    !semVenda.columns.some((c) => c.sensivel === "venda") && semVenda.columns.some((c) => c.key === "custoEstimado") &&
    !temAlgum(JSON.stringify(semVenda), ["11111.11", "33333.33"]) && temAlgum(JSON.stringify(semVenda), COMPRA_RAW));
  ok("…HTML e XLSX gerados a partir do relatório adulterado também saem sem venda",
    !temAlgum(corpoHtml(adulterado({ precosVenda: false, precosCompra: true })), VENDA_FMT) && !temAlgum(dumpXlsx(adulterado({ precosVenda: false, precosCompra: true }), "forjado-venda").texto, VENDA_RAW));
  const tudoFora = [{}, { precosVenda: "true", precosCompra: 1 }, { precosVenda: null }, { precosCompra: true }];
  ok("meta incompleta ou com tipos errados (não estritamente `true`) retira a classe — nunca a divulga",
    tudoFora.every((p) => {
      const l = lerPrivacidade(p)!;
      const r = aplicarPrivacidade(adulterado(p));
      return (l.precosVenda === false) && !r.columns.some((c) => c.sensivel === "venda") && (l.precosCompra === true || !r.columns.some((c) => c.sensivel === "compra"));
    }));
  ok("sem `meta.privacidade` (relatórios sem informação sensível) nada é retirado", aplicarPrivacidade({ ...completo, meta: { ...completo.meta!, privacidade: undefined } }) .columns.length === completo.columns.length);
  const duas = aplicarPrivacidade(adulterado({ precosVenda: false, precosCompra: false, chavesVenda: ["pvp", "valorBruto"], chavesCompra: ["custoUnitarioEstimado", "custoEstimado"] }));
  ok("idempotente: aplicar duas vezes dá o mesmo", JSON.stringify(aplicarPrivacidade(duas)) === JSON.stringify(duas));
  ok("sem as duas classes, as linhas já não têm NENHUM dos campos monetários (nem em `displayKey`/`noteKey`)",
    duas.rows.every((r) => !("pvp" in r) && !("valorBruto" in r) && !("custoEstimado" in r) && !("custoUnitarioEstimado" in r)));
  ok("descreverPrivacidade devolve null para relatórios sem meta (o diálogo não mostra o aviso)", descreverPrivacidade({ ...completo, meta: undefined }) === null);
}

console.log("\n=== C. Total unid. destacado · Stock por artigo e Stock total ===");
{
  const bks = buckets(3);
  // A: 2 farmácias (4 + 7 = 11); B: negativo (−3); C: zero; D: stock desconhecido; E: sem vendas e com stock 9
  const rows: VendasAdapterRow[] = [
    linha({ codigo: "8000001", farmacia: FARM[0], qtd: [3, 0, 1], stock: 4 }, bks),
    linha({ codigo: "8000001", farmacia: FARM[1], qtd: [1, 1, 1], stock: 7 }, bks),
    linha({ codigo: "8000002", farmacia: FARM[1], qtd: [2, 0, 0], stock: -3 }, bks),
    linha({ codigo: "8000003", farmacia: FARM[1], qtd: [1, 0, 0], stock: 0 }, bks),
    linha({ codigo: "8000004", farmacia: FARM[1], qtd: [1, 0, 0], stock: 0, stockConhecido: false }, bks),
    linha({ codigo: "8000005", farmacia: FARM[1], qtd: [0, 0, 0], stock: 9 }, bks),
  ];
  const st = stockTotalDoRelatorio(rows);
  ok("Stock total = 4 + 7 − 3 + 0 + 9 = 17; o desconhecido fica fora e conta-se à parte (1)", st.total === 17 && st.desconhecidas === 1);
  const rel = gerar(rows, bks);
  const subtotalA = rel.rows.find((r) => r.codigo === "8000001" && r.tipoLinha === "Total artigo");
  ok("TOTAL ARTIGO: a coluna Stock mostra a SOMA das farmácias (4 + 7 = 11), não o stock de uma só", subtotalA?.existencia === 11);
  const unico = rel.rows.find((r) => r.codigo === "8000002" && r.tipoLinha === "Detalhe");
  ok("stock negativo entra com sinal (−3); zero é zero", unico?.existencia === -3 && rel.rows.find((r) => r.codigo === "8000003")?.existencia === 0);
  const desconhecido = rel.rows.find((r) => r.codigo === "8000004");
  ok("stock desconhecido NÃO é convertido em zero: a célula é nula («—»)", desconhecido?.existencia === null);
  const stockSummary = (rel.summary ?? []).find((s) => s.label === "Stock total");
  ok("resumo: «Stock total» = 17 e «Linhas sem stock conhecido» = 1", stockSummary?.value === 17 && (rel.summary ?? []).find((s) => /sem stock conhecido/.test(s.label))?.value === 1);
  ok("o rodapé declara o total PARCIAL e quantas linhas ficaram de fora", /Stock total PARCIAL: 1 linha/.test(rel.meta?.footer ?? ""));
  const html = renderReportHtml(rel);
  const corpo = norm(html.slice(html.indexOf("<body")).replace(/<style[\s\S]*?<\/style>/g, ""));
  const totalGeral = norm(html.match(/<tbody class="totals-tbody">[\s\S]*?<\/tbody>/)?.[0] ?? "");
  ok("TOTAL GERAL (HTML) tem o Stock total (17)", /<strong>17<\/strong>/.test(totalGeral), totalGeral.slice(0, 300));
  ok("faixa de resumo: «Stock total: 17» e a linha dos desconhecidos", /Stock total:<\/span> <strong>17<\/strong>/.test(corpo) && /sem stock conhecido[^<]*:<\/span> <strong>1<\/strong>/.test(corpo));
  const xl = XLSX.utils.sheet_to_json<unknown[]>(buildReportWorkbook(rel).Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][];
  const cab = (xl.find((r) => r[0] === "CNP") ?? []) as string[];
  const iStock = cab.findIndex((h) => /^Stock/.test(h));
  const linhaTotal = xl.find((r) => r[0] === "TOTAL GERAL");
  ok("Excel: linha de totais com o Stock total (17) na coluna Stock", iStock >= 0 && Number(linhaTotal?.[iStock]) === 17);
  ok("Excel: o stock desconhecido não vai como 0 (célula vazia)", ((xl.find((r) => r[0] === "8000004") ?? [])[iStock] ?? "") === "");

  // Sem dupla contagem: o stock não depende do nº de meses (3 vs 13 vs 27)
  const totais = [3, 13, 27].map((n) => {
    const b = buckets(n);
    const rs = [
      linha({ codigo: "8100001", farmacia: FARM[0], qtd: [1], stock: 4 }, b),
      linha({ codigo: "8100001", farmacia: FARM[1], qtd: [1], stock: 7 }, b),
    ];
    return (gerar(rs, b).summary ?? []).find((s) => s.label === "Stock total")?.value;
  });
  ok("o Stock total não se multiplica pelos meses (3, 13 e 27 meses → 11)", totais.every((t) => t === 11), JSON.stringify(totais));

  // Coluna «Total unid.» destacada (HTML)
  const ths = [...html.matchAll(/<th\b([^>]*)>(.*?)<\/th>/g)].map((m) => ({ attrs: m[1], texto: m[2] }));
  const tintTh = ths.filter((t) => /tint-total/.test(t.attrs));
  ok("só o cabeçalho «Total Unid.» leva o destaque", tintTh.length === 1 && /Total<br\/>Unid\./.test(tintTh[0].texto));
  const nTd = (html.match(/<td[^>]*class="[^"]*tint-total[^"]*"/g) ?? []).length;
  ok("todas as células da coluna (linhas, subtotais e TOTAL GERAL) levam o destaque", nTd === rel.rows.length + 1, `${nTd} vs ${rel.rows.length + 1}`);
  ok("o destaque não existe no Excel (sem estilos) e a coluna mantém o nome", !/tint/.test(JSON.stringify(buildReportWorkbook(rel).Sheets["Relatório"])) && cab.some((h) => /Total\s*Unid/.test(h)));
  // blocos temporais: «Total unid. do bloco» e «Período: Total unid.» também destacados
  const rel27 = gerar([linha({ codigo: "8200001", qtd: [1, 2, 3], stock: 2 }, buckets(27))], buckets(27));
  const ths27 = [...renderReportHtml(rel27).matchAll(/<th\b([^>]*)>(.*?)<\/th>/g)].filter((t) => /tint-total/.test(t[1])).map((t) => t[2].replace(/<br\/>/g, " "));
  ok("27 meses: «Total unid. do bloco» e «Período: Total unid.» têm o mesmo destaque", ths27.some((t) => /do bloco/.test(t)) && ths27.some((t) => /Período:/.test(t)), JSON.stringify(ths27));
  const ordem = rel27.columns.filter((c) => !c.excelOnly).map((c) => c.key);
  ok("27 meses: sequência meses → total do bloco → total do período → stock", ordem.indexOf("totalVendas") > ordem.indexOf("tb_2") && ordem.indexOf("existencia") === ordem.indexOf("totalVendas") + 1);
}

console.log("\n=== D. Filtro «PVP diferente entre farmácias» (regra pura) ===");
{
  const A = FARM[0], B = FARM[1], C = "Farmácia Terceira";
  const sel2 = [A, B];
  const t = (pvps: Record<string, number | null>, sel = sel2) => artigoTemPvpDiferente(pvps, sel);
  ok("10,00 / 10,00 → NÃO", t({ [A]: 10, [B]: 10 }) === false);
  ok("10,00 / 10,01 → SIM", t({ [A]: 10, [B]: 10.01 }) === true);
  ok("10,00 / 12,00 → SIM", t({ [A]: 10, [B]: 12 }) === true);
  ok("10,00 / vazio → NÃO (só um PVP conhecido)", t({ [A]: 10, [B]: null }) === false);
  ok("vazio / vazio → NÃO", t({ [A]: null, [B]: null }) === false);
  ok("apenas uma farmácia associada → NÃO", t({ [A]: 10 }) === false);
  ok("PVP 0 ou negativo não é PVP conhecido", t({ [A]: 0, [B]: 12 }) === false && t({ [A]: -1, [B]: 12 }) === false && pvpEscalado(0) === null);
  ok("compara à precisão da base (4 casas): 10,0000 vs 10,0001 → SIM; 10,00004 arredonda para igual → NÃO", t({ [A]: 10, [B]: 10.0001 }) === true && t({ [A]: 10, [B]: 10.00004 }) === false);
  ok("sem erros de vírgula flutuante: 0,1+0,2 vs 0,3 → iguais", t({ [A]: 0.1 + 0.2, [B]: 0.3 }) === false);
  ok("três farmácias: só A e B selecionadas — o preço de C não conta", t({ [A]: 10, [B]: 10, [C]: 20 }, [A, B]) === false && t({ [A]: 10, [B]: 10, [C]: 20 }, [A, B, C]) === true);
  ok("três farmácias, um PVP em falta: dois iguais + um vazio → NÃO; dois diferentes + um vazio → SIM", t({ [A]: 10, [B]: 10, [C]: null }, [A, B, C]) === false && t({ [A]: 10, [B]: 11, [C]: null }, [A, B, C]) === true);
  ok("com uma só farmácia efetiva o filtro não é aplicável", filtroPvpAplicavel(1) === false && filtroPvpAplicavel(2) === true);

  const bks = buckets(1);
  const l = (codigo: string, farmacia: string, pvpConhecido: number | null, pvpPorFarmacia?: Record<string, number | null>): VendasAdapterRow & { pvpConhecido: number | null; pvpPorFarmacia?: Record<string, number | null> } =>
    ({ ...linha({ codigo, farmacia, qtd: [1] }, bks), pvpConhecido, ...(pvpPorFarmacia ? { pvpPorFarmacia } : {}) });
  const linhas = [
    l("1", A, 10, { [A]: 10, [B]: 10.5 }), // só A vendeu, mas B tem PVP diferente → entra (via pvpPorFarmacia)
    l("2", A, 10), l("2", B, 10),           // iguais → fora
    l("3", A, 10), l("3", B, null),         // um PVP → fora
    l("4", A, 9.99), l("4", B, 10),         // diferença de 1 cêntimo → dentro
  ];
  const cods = codigosComPvpDiferente(linhas, sel2);
  ok("sobre linhas: entra o artigo cuja outra farmácia (sem linha de vendas) tem PVP diferente", cods.has("1"));
  ok("sobre linhas: 2 (iguais) e 3 (um PVP) ficam fora; 4 (1 cêntimo) entra", !cods.has("2") && !cods.has("3") && cods.has("4"), JSON.stringify([...cods]));
  ok("sem `pvpPorFarmacia` (linhas antigas) a regra usa o PVP da própria linha", pvpsPorCodigo([l("9", A, 5), l("9", B, 6)]).get("9")?.[B] === 6);

  // frase nos filtros das saídas — com e sem preços de venda
  const rel = gerar(linhasSentinela(buckets(3)), buckets(3), { venda: false, compra: false, filters: { agruparPor: "artigo", pvpDiferente: true } });
  ok("filtro ativo: a frase «Apenas artigos com PVP diferente entre farmácias» consta dos filtros das saídas",
    (rel.filtersApplied ?? []).some((f) => f.label === ROTULO_FILTRO_PVP_DIFERENTE && f.value === "Sim") && corpoHtml(rel).includes(ROTULO_FILTRO_PVP_DIFERENTE));
  const relSem = gerar(linhasSentinela(buckets(3)), buckets(3), { filters: { agruparPor: "artigo" } });
  ok("filtro inativo: a frase não aparece", !(relSem.filtersApplied ?? []).some((f) => f.label === ROTULO_FILTRO_PVP_DIFERENTE));
  const thsSem = [...corpoHtml(rel).matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
  ok("filtro ativo + preços de venda desligados: continua sem coluna PVP (a frase é o único «PVP» do documento)", !thsSem.some((x) => /PVP/.test(x)));
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
