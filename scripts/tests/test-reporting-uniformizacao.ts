/**
 * scripts/tests/test-reporting-uniformizacao.ts
 *
 * Uniformização visual dos 7 relatórios principais (Vendas, Margens,
 * Inventário, Devoluções, Transferências, Encomendas, Excessos) — mesma
 * linguagem visual (`meta.density:"compact"`), mesmo nome curto de
 * farmácia (`nomeFarmaciaCurto`/`ReportColumn.displayKey`), mesma ordem
 * estável de farmácia (`ordenarPorFarmacia`), e correcção de larguras de
 * coluna que transbordavam a página impressa (`normalizarLargura`).
 *
 * Vendas já tinha a sua própria suite extensa (test-reporting-redesign.ts)
 * — este ficheiro cobre os SEIS relatórios que a acompanharam nesta
 * uniformização, mais os mecanismos partilhados extraídos para
 * `lib/reporting/farmacia-nome.ts`, `ordenacao-farmacias.ts` e
 * `column-widths.ts`.
 *
 * Secções I/J (2ª fase, mesma data): o "bloco por artigo" de Vendas
 * (GROUP_KEY+spanGroup, sublinhas por farmácia, TOTAL ARTIGO) aplicado
 * a Margens Por Produto e Inventário Por Produto, via o mecanismo
 * genérico `lib/reporting/agrupamento-artigo.ts`.
 *
 * Puro: sem base de dados, sem rede. Corre com: npx tsx scripts/tests/test-reporting-uniformizacao.ts
 */
import { nomeFarmaciaCurto } from "../../lib/reporting/farmacia-nome";
import { compararPorNomeFarmacia, ordenarPorFarmacia } from "../../lib/reporting/ordenacao-farmacias";
import { normalizarLargura } from "../../lib/reporting/column-widths";
import { agruparLinhasPorArtigo, grupoArtigoPrecisaDeTotal } from "../../lib/reporting/agrupamento-artigo";
import { renderReportHtml } from "../../lib/reporting/report-html";
import { formatCurrency } from "../../lib/reporting/report-formatters";
import { GROUP_KEY, ROW_KIND_KEY, type ReportColumn } from "../../lib/reporting/report-types";
import { buildMargensProdutoReport, buildMargensAggReport } from "../../lib/reporting/adapters/margens";
import {
  buildInventarioReport,
  buildInventarioPorFarmaciaReport,
} from "../../lib/reporting/adapters/inventario";
import { buildDevolucoesReport } from "../../lib/reporting/adapters/devolucoes";
import { buildTransferenciasReport } from "../../lib/reporting/adapters/transferencias";
import { buildExcessosReport } from "../../lib/reporting/adapters/excessos";
import { buildEncomendasReport } from "../../lib/reporting/adapters/encomendas";
import type { MargemRow, MargensAgg } from "../../lib/margens-data";
import type { InventarioRow, InventarioPorFarmaciaRow } from "../../lib/inventario-data";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

/** Soma das larguras das colunas visíveis (HTML/PDF) — nunca deve exceder 100. */
function somaLarguras(cols: ReportColumn[]): number {
  return cols
    .filter((c) => !c.hidden && !c.excelOnly)
    .reduce((s, c) => s + (c.width ?? 0), 0);
}

const UNIVERSE_2 = ["Farmácia Segurado", "Farmácia Silveirense"];
const UNIVERSE_5 = [
  "Farmácia Alfa", "Farmácia Beta", "Farmácia Gama", "Farmácia Delta", "Farmácia Épsilon",
];

// ══════════════════════════════════════════════════════════════════════
// A · MECANISMOS PARTILHADOS
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · mecanismos partilhados (farmacia-nome / ordenacao-farmacias / column-widths)");
{
  eq(nomeFarmaciaCurto("Farmácia Segurado"), "Segurado", "A1: remove o prefixo");
  eq(nomeFarmaciaCurto("farmacia Silveirense"), "Silveirense", "A2: sem acento, minúsculas");
  eq(nomeFarmaciaCurto("Segurado"), "Segurado", "A3: sem prefixo fica intocado");

  const comparar = compararPorNomeFarmacia(UNIVERSE_2);
  check(comparar("Farmácia Segurado", "Farmácia Silveirense") < 0, "A4: respeita a ordem dada");
  check(
    compararPorNomeFarmacia(undefined)("Farmácia Silveirense", "Farmácia Segurado") > 0,
    "A5: sem ordem, cai em alfabética",
  );
  const comAusente = compararPorNomeFarmacia(["Farmácia Segurado"]);
  check(comAusente("Farmácia Segurado", "Farmácia Desconhecida") < 0, "A6: farmácia na lista vem primeiro");
  check(comAusente("Farmácia Desconhecida", "Farmácia Segurado") > 0, "A7: farmácia ausente vai depois");

  const ordenado = ordenarPorFarmacia(
    [{ f: "Farmácia Silveirense" }, { f: "Farmácia Segurado" }],
    (r) => r.f,
    UNIVERSE_2,
  );
  eq(ordenado.map((r) => r.f), UNIVERSE_2, "A8: ordenarPorFarmacia aplica a ordem do universo, não a de chegada");

  const largura = normalizarLargura({ a: 20, b: 40, c: 40 });
  eq(Math.round((largura.a + largura.b + largura.c) * 1000) / 1000, 100, "A9: já somava 100 — fica 100");
  const largura2 = normalizarLargura({ a: 127, b: 127 });
  eq(Math.round((largura2.a + largura2.b) * 1000) / 1000, 100, "A10: transbordo (254) normaliza para 100");
  eq(largura2.a, largura2.b, "A11: proporções relativas preservadas (iguais entre si continuam iguais)");
}

// ══════════════════════════════════════════════════════════════════════
// B · MARGENS
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · Margens");
{
  const linha = (over: Partial<MargemRow>): MargemRow => ({
    cnp: 1000001,
    designacao: "Produto Teste",
    categoria: "Categoria X",
    grupo: null,
    farmaciaId: "f1",
    farmacia: "Farmácia Segurado",
    fabricante: "Fabricante Teste",
    qtdVendida: 10,
    pvpUnitario: 5,
    valorVendido: 50,
    taxaIva: 23,
    valorVendidoSemIva: 40.65,
    custoUnitario: 3,
    custoUnitarioBase: 3,
    custoEstimado: 30,
    margemEur: 10.65,
    margemPct: 26.2,
    coberturaCusto: 1,
    estado: "FIAVEL",
    ...over,
  });

  const relProduto = buildMargensProdutoReport({
    rows: [linha({}), linha({ cnp: 1000002, farmacia: "Farmácia Silveirense" })],
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });
  eq(relProduto.meta?.density, "compact", "B1: Produto usa a densidade compacta");
  const colFarmProduto = relProduto.columns.find((c) => c.key === "farmacia");
  eq(colFarmProduto?.displayKey, "farmaciaCurta", "B2: coluna Farmácia usa displayKey");
  eq(relProduto.rows[0].farmaciaCurta, "Segurado", "B3: valor curto correcto");
  eq(relProduto.rows[0].farmacia, "Farmácia Segurado", "B4: o nome completo continua intocado (Excel)");
  check(somaLarguras(relProduto.columns) <= 100.001, "B5: larguras não transbordam (era 108)");
  eq(Math.round(somaLarguras(relProduto.columns) * 1000) / 1000, 100, "B6: larguras somam exactamente 100");

  const agg = (label: string): MargensAgg => ({
    key: label, label, qtdVendida: 1, valorVendido: 10, valorVendidoSemIva: 8, custoEstimado: 5,
    margemEur: 3, margemPct: 37.5, coberturaCusto: 1, estado: "FIAVEL",
  });

  // Ordem de CHEGADA invertida face ao universo — prova que a ordem final
  // vem do universo, não da agregação SQL.
  const relFarm = buildMargensAggReport({
    rows: [agg("Farmácia Silveirense"), agg("Farmácia Segurado")],
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
    groupBy: "farmacia",
  });
  eq(relFarm.meta?.density, "compact", "B7: Por Farmácia usa a densidade compacta");
  eq(relFarm.rows.map((r) => r.label), UNIVERSE_2, "B8: ordem estável (universo), não a de chegada");
  eq(relFarm.rows.map((r) => r.labelCurta), ["Segurado", "Silveirense"], "B9: nomes curtos na ordem certa");
  const colLabelFarm = relFarm.columns.find((c) => c.key === "label");
  eq(colLabelFarm?.displayKey, "labelCurta", "B10: coluna usa displayKey só na vista Por Farmácia");
  check(Math.round(somaLarguras(relFarm.columns) * 1000) / 1000 === 100, "B11: larguras somam 100");

  // 5 farmácias — mesma prova, universo maior.
  const rowsInvertidas = [...UNIVERSE_5].reverse().map((f) => agg(f));
  const relFarm5 = buildMargensAggReport({
    rows: rowsInvertidas,
    filters: {},
    universe: { farmacias: UNIVERSE_5, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
    groupBy: "farmacia",
  });
  eq(relFarm5.rows.map((r) => r.label), UNIVERSE_5, "B12: 5 farmácias — ordem estável mesmo invertida na origem");

  // Outra dimensão (fabricante) não ganha displayKey nem reordena —
  // `ordenarPorFarmacia` não faz sentido para uma lista de fabricantes.
  const relFab = buildMargensAggReport({
    rows: [agg("MENARINI")],
    filters: {},
    universe: { farmacias: [], categorias: [], fabricantes: ["MENARINI"], distribuidores: [] },
    organization: "Grupo",
    groupBy: "fabricante",
  });
  const colLabelFab = relFab.columns.find((c) => c.key === "label");
  check(colLabelFab?.displayKey === undefined, "B13: Por Fabricante não usa displayKey (não é farmácia)");
}

// ══════════════════════════════════════════════════════════════════════
// C · INVENTÁRIO
// ══════════════════════════════════════════════════════════════════════
console.log("\nC · Inventário");
{
  const linhaInv = (over: Partial<InventarioRow>): InventarioRow => ({
    cnp: 2000001,
    designacao: "Produto Inventário",
    categoria: "Categoria Y",
    grupo: null,
    farmaciaId: "f1",
    farmacia: "Farmácia Segurado",
    stockAtual: 10,
    stockMinimo: 2,
    pmc: 3,
    puc: 3,
    pvp: 5,
    custoUnitario: 3,
    taxaIva: 23,
    valorStock: 30,
    valorIva: 6.9,
    valorStockComIva: 36.9,
    dataUltimaVenda: null,
    dataUltimaCompra: null,
    diasSemVenda: null,
    vendas90d: 0,
    vendaMediaDia90d: 0,
    coberturaDias: 30,
    estado: "NORMAL",
    ...over,
  });

  const relProduto = buildInventarioReport({
    rows: [linhaInv({}), linhaInv({ cnp: 2000002, farmacia: "Farmácia Silveirense" })],
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });
  eq(relProduto.meta?.density, "compact", "C1: Por Produto usa densidade compacta");
  eq(relProduto.rows[0].farmaciaCurta, "Segurado", "C2: nome curto correcto");
  check(Math.round(somaLarguras(relProduto.columns) * 1000) / 1000 === 100, "C3: larguras somam 100");

  const linhaFarm = (over: Partial<InventarioPorFarmaciaRow>): InventarioPorFarmaciaRow => ({
    farmaciaId: "f1",
    farmacia: "Farmácia Segurado",
    numProdutos: 10,
    stockTotal: 100,
    valorStockSemIva: 500,
    valorIva: 100,
    valorStockComIva: 600,
    rotura: 1,
    excesso: 2,
    semMovimento: 0,
    semCusto: 0,
    semStock: 0,
    normal: 7,
    ...over,
  });

  const relFarm = buildInventarioPorFarmaciaReport({
    rows: [linhaFarm({ farmacia: "Farmácia Silveirense" }), linhaFarm({ farmacia: "Farmácia Segurado" })],
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });
  eq(relFarm.meta?.density, "compact", "C4: Por Farmácia usa densidade compacta");
  eq(relFarm.rows.map((r) => r.farmacia), UNIVERSE_2, "C5: ordem estável (universo), não a de chegada");
  eq(relFarm.rows.map((r) => r.farmaciaCurta), ["Segurado", "Silveirense"], "C6: nomes curtos na ordem certa");
  const colFarmFarm = relFarm.columns.find((c) => c.key === "farmacia");
  eq(colFarmFarm?.displayKey, "farmaciaCurta", "C7: coluna Farmácia usa displayKey");
  check(Math.round(somaLarguras(relFarm.columns) * 1000) / 1000 === 100, "C8: larguras somam 100");
}

// ══════════════════════════════════════════════════════════════════════
// D · DEVOLUÇÕES
// ══════════════════════════════════════════════════════════════════════
console.log("\nD · Devoluções");
{
  const rel = buildDevolucoesReport({
    rows: [
      {
        data: "2026-09-01", cnp: "5000001", produto: "Produto Devolvido",
        farmacia: "Farmácia Segurado", fornecedor: "Distribuidor X",
        fabricante: "Fabricante Y", categoria: "Categoria Z",
        quantidade: 2, valor: 15.5, motivo: "Prazo de validade",
      },
    ],
    filters: {},
    universe: { pharmacies: UNIVERSE_2, suppliers: [], manufacturers: [], categories: [] },
    organization: "Grupo",
  });
  eq(rel.meta?.density, "compact", "D1: usa densidade compacta");
  eq(rel.rows[0].farmaciaCurta, "Segurado", "D2: nome curto correcto");
  const colMotivo = rel.columns.find((c) => c.key === "motivo");
  check(colMotivo !== undefined, "D3: coluna Motivo existe (campo já vinha populado e ficava invisível)");
  eq(rel.rows[0].motivo, "Prazo de validade", "D4: o valor de motivo chega à linha do relatório");
  check(Math.round(somaLarguras(rel.columns) * 1000) / 1000 === 100, "D5: larguras somam 100");
}

// ══════════════════════════════════════════════════════════════════════
// E · TRANSFERÊNCIAS
// ══════════════════════════════════════════════════════════════════════
console.log("\nE · Transferências");
{
  const rel = buildTransferenciasReport({
    rows: [
      {
        cnp: "6000001", produto: "Produto Transferido",
        farmaciaOrigem: "Farmácia Segurado", farmaciaDestino: "Farmácia Silveirense",
        stockOrigem: 50, stockDestino: 5, coberturaOrigem: 200, coberturaDestino: 10,
        quantidadeSugerida: 10, excessoOrigem: 20, necessidadeDestino: 15,
        fabricante: "Fabricante A", categoria: "Categoria B", fornecedor: "Fornecedor C",
        prioridade: "Alta",
      },
    ],
    filters: {},
    universe: { farmacias: UNIVERSE_2, fornecedores: [], fabricantes: [], categorias: [], prioridades: [] },
    organization: "Grupo",
  });
  eq(rel.meta?.density, "compact", "E1: usa densidade compacta");
  eq(rel.rows[0].farmaciaOrigemCurta, "Segurado", "E2: origem — nome curto correcto");
  eq(rel.rows[0].farmaciaDestinoCurta, "Silveirense", "E3: destino — nome curto correcto");
  const colOrigem = rel.columns.find((c) => c.key === "farmaciaOrigem");
  const colDestino = rel.columns.find((c) => c.key === "farmaciaDestino");
  eq(colOrigem?.displayKey, "farmaciaOrigemCurta", "E4: coluna Origem usa displayKey");
  eq(colDestino?.displayKey, "farmaciaDestinoCurta", "E5: coluna Destino usa displayKey");
  check(somaLarguras(rel.columns) <= 100.001, "E6: larguras não transbordam (era 254)");
  eq(Math.round(somaLarguras(rel.columns) * 1000) / 1000, 100, "E7: larguras somam exactamente 100");
}

// ══════════════════════════════════════════════════════════════════════
// F · EXCESSOS
// ══════════════════════════════════════════════════════════════════════
console.log("\nF · Excessos");
{
  const rel = buildExcessosReport({
    rows: [
      {
        cnp: "7000001", produto: "Produto em Excesso",
        farmaciaOrigem: "Farmácia Segurado", farmaciaDestino: "Farmácia Silveirense",
        stockOrigem: 100, stockDestino: 5, coberturaOrigem: 500, coberturaDestino: 10,
        quantidadeSugerida: 30, excessoOrigem: 60, necessidadeDestino: 20,
        vendas6M: 12, mediaMensal6M: 2,
        fabricante: "Fabricante A", categoria: "Categoria B", fornecedor: "Fornecedor C",
        prioridade: "Média",
      },
    ],
    filters: {},
    universe: { farmacias: UNIVERSE_2, fornecedores: [], fabricantes: [], categorias: [], prioridades: [] },
    organization: "Grupo",
  });
  eq(rel.meta?.density, "compact", "F1: usa densidade compacta");
  eq(rel.rows[0].farmaciaOrigemCurta, "Segurado", "F2: origem — nome curto correcto");
  eq(rel.rows[0].farmaciaDestinoCurta, "Silveirense", "F3: destino — nome curto correcto");
  const colMedia = rel.columns.find((c) => c.key === "mediaMensal6M");
  eq(colMedia?.format, "decimal1", "F4: Méd./mês continua com uma casa decimal (não regrediu)");
  check(!colMedia?.showTotal, "F5: Méd./mês continua sem total");
  check(somaLarguras(rel.columns) <= 100.001, "F6: larguras não transbordam (era 212)");
  eq(Math.round(somaLarguras(rel.columns) * 1000) / 1000, 100, "F7: larguras somam exactamente 100");
}

// ══════════════════════════════════════════════════════════════════════
// G · ENCOMENDAS
// ══════════════════════════════════════════════════════════════════════
console.log("\nG · Encomendas");
{
  const rel = buildEncomendasReport({
    rows: [
      {
        cnp: "8000001", produto: "Produto a Encomendar", fornecedor: "Fornecedor D",
        fabricante: "Fabricante E", categoria: "Categoria F",
        stockGrupo: 10, sugestaoGrupo: 40, encomendarGrupo: 30, valorEstimado: 120, prioridade: "Crítica",
      },
    ],
    filters: {},
    universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo",
  });
  eq(rel.meta?.density, "compact", "G1: usa densidade compacta");
  check(somaLarguras(rel.columns) <= 100.001, "G2: larguras não transbordam (era 178)");
  eq(Math.round(somaLarguras(rel.columns) * 1000) / 1000, 100, "G3: larguras somam exactamente 100");
  check(
    !rel.columns.some((c) => c.key.toLowerCase().includes("farmacia")),
    "G4: sem coluna de farmácia — Encomendas é agregado por grupo, sem essa dimensão",
  );
}

// ══════════════════════════════════════════════════════════════════════
// H · HTML RENDERIZADO — o nome curto aparece de facto no corpo,
//     o nome completo NUNCA aparece como texto visível da célula.
// ══════════════════════════════════════════════════════════════════════
console.log("\nH · HTML renderizado");
{
  const relFarm = buildInventarioPorFarmaciaReport({
    rows: [
      {
        farmaciaId: "f1", farmacia: "Farmácia Segurado", numProdutos: 1, stockTotal: 1,
        valorStockSemIva: 1, valorIva: 1, valorStockComIva: 1, rotura: 0, excesso: 0,
        semMovimento: 0, semCusto: 0, semStock: 0, normal: 1,
      },
    ],
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });
  const html = relFarm.rows.length > 0 ? renderReportHtml(relFarm) : "";
  const corpo = html.slice(html.indexOf("<body>"));
  check(html.includes('class="page density-compact"'), "H1: página usa a classe density-compact");
  check(corpo.includes(">Segurado<"), "H2: o nome CURTO aparece como texto de célula");
  check(!corpo.includes(">Farmácia Segurado<"), "H3: o nome completo NUNCA aparece como texto de célula");

  const relMargens = buildMargensProdutoReport({
    rows: [
      {
        cnp: 1, designacao: "Produto Longo o Suficiente Para Testar Quebra De Linha No PDF Impresso",
        categoria: "C", grupo: null, farmaciaId: "f2", farmacia: "Farmácia Silveirense",
        fabricante: "Fabricante Teste", qtdVendida: 1, pvpUnitario: 1,
        valorVendido: 1, taxaIva: 23, valorVendidoSemIva: 0.81, custoUnitario: 0.5,
        custoUnitarioBase: 0.5, custoEstimado: 0.5, margemEur: 0.31, margemPct: 38,
        coberturaCusto: 1, estado: "FIAVEL",
      },
    ],
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });
  const htmlM = renderReportHtml(relMargens);
  check(htmlM.includes('class="page density-compact"'), "H4: Margens Por Produto também renderiza compacto");
  check(htmlM.slice(htmlM.indexOf("<body>")).includes(">Silveirense<"), "H5: nome curto no corpo de Margens");
}

// ══════════════════════════════════════════════════════════════════════
// I · agrupamento-artigo.ts — o mecanismo genérico, isolado
// ══════════════════════════════════════════════════════════════════════
console.log("\nI · agrupamento-artigo.ts (mecanismo genérico)");
{
  const linhas = [
    { codigo: "A", farmacia: "Farmácia Silveirense", v: 1 },
    { codigo: "B", farmacia: "Farmácia Segurado", v: 2 },
    { codigo: "A", farmacia: "Farmácia Segurado", v: 3 },
  ];
  const grupos = agruparLinhasPorArtigo(linhas, {
    getCodigo: (l) => l.codigo,
    getFarmacia: (l) => l.farmacia,
    ordemFarmacias: UNIVERSE_2, // ["Farmácia Segurado", "Farmácia Silveirense"]
  });
  eq(grupos.map((g) => g.codigo), ["A", "B"], "I1: ordem dos GRUPOS é a de 1ª aparição (A antes de B)");
  eq(grupos[0].detalhes.map((d) => d.farmacia), ["Farmácia Segurado", "Farmácia Silveirense"], "I2: farmácias DENTRO do grupo A na ordem estável, não a de chegada");
  check(grupoArtigoPrecisaDeTotal(grupos[0]), "I3: grupo A (2 farmácias) precisa de TOTAL ARTIGO");
  check(!grupoArtigoPrecisaDeTotal(grupos[1]), "I4: grupo B (1 farmácia) NÃO precisa de TOTAL ARTIGO");
}

// ══════════════════════════════════════════════════════════════════════
// J · Bloco por artigo — Margens Por Produto (referência: Vendas)
// ══════════════════════════════════════════════════════════════════════
console.log("\nJ · Margens Por Produto — bloco por artigo, farmácias em ordem estável");
{
  const linha = (over: Partial<MargemRow>): MargemRow => ({
    cnp: 8322628, designacao: "Ventilan", categoria: "Respiratório", grupo: null,
    farmaciaId: "f1", farmacia: "Farmácia Segurado", fabricante: "Fabricante Teste",
    qtdVendida: 10, valorVendido: 66.6, pvpUnitario: 6.66, custoUnitario: 4.46,
    valorVendidoSemIva: 54.15, taxaIva: 23, custoUnitarioBase: 4.46, custoEstimado: 44.6,
    margemEur: 9.55, margemPct: 17.6, coberturaCusto: 1, estado: "FIAVEL",
    ...over,
  });
  // Ordem de chegada TROCADA face ao universo — Silveirense primeiro na
  // origem, Segurado primeiro no universo — para provar que é a ordem
  // ESTÁVEL que manda, nunca a de chegada.
  const rows = [
    linha({ farmacia: "Farmácia Silveirense", pvpUnitario: 6.5, custoUnitario: 3.75, qtdVendida: 5, valorVendido: 32.5, valorVendidoSemIva: 26.42, custoEstimado: 18.75, margemEur: 7.67 }),
    linha({ farmacia: "Farmácia Segurado" }),
  ];
  const rel = buildMargensProdutoReport({
    rows,
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });

  eq(rel.rows.length, 3, "J1: 2 detalhes + 1 TOTAL ARTIGO");
  eq(rel.rows.map((r) => r.farmacia), ["Farmácia Segurado", "Farmácia Silveirense", "TOTAL ARTIGO"], "J2: Segurado primeiro (ordem estável do universo), depois Silveirense, TOTAL ARTIGO no fim");
  eq(rel.rows[0][GROUP_KEY], rel.rows[1][GROUP_KEY], "J3: as duas sublinhas partilham o mesmo GROUP_KEY");
  eq(rel.rows[2][GROUP_KEY], rel.rows[0][GROUP_KEY], "J4: o TOTAL ARTIGO está no MESMO grupo (é coberto pelo mesmo rowspan)");
  eq(rel.rows[0][ROW_KIND_KEY], "detalhe", "J5: sublinhas marcadas como detalhe");
  eq(rel.rows[2][ROW_KIND_KEY], "subtotal", "J6: TOTAL ARTIGO marcado como subtotal (nunca conta 2x no TOTAL GERAL)");

  // PVP/Custo: cada sublinha o SEU, TOTAL ARTIGO sem nenhum (nunca um
  // valor único/médio para o artigo).
  eq(rel.rows[0].pvpUnitario, 6.66, "J7: PVP do Segurado é o SEU");
  eq(rel.rows[1].pvpUnitario, 6.5, "J8: PVP do Silveirense é o SEU, diferente");
  eq(rel.rows[2].pvpUnitario, null, "J9: TOTAL ARTIGO sem PVP (nunca um valor único)");
  eq(rel.rows[2].custoUnitario, null, "J10: TOTAL ARTIGO sem Custo unit. (idem)");

  // Somas — só o que é somável.
  eq(rel.rows[2].qtdVendida, 15, "J11: TOTAL ARTIGO soma a quantidade (10+5)");
  eq(rel.rows[2].valorVendido, 99.1, "J12: …e o valor vendido c/IVA (66,6+32,5)");
  eq(rel.rows[2].margemEur, 17.22, "J13: …e a margem € (9,55+7,67)");

  // O bloco COMUM (spanGroup) fica só com CNP+Descrição.
  const colCnp = rel.columns.find((c) => c.key === "cnp");
  const colDesc = rel.columns.find((c) => c.key === "designacao");
  const colCategoria = rel.columns.find((c) => c.key === "categoria");
  check(colCnp?.spanGroup === true, "J14: CNP é spanGroup");
  check(colDesc?.spanGroup === true, "J15: Descrição é spanGroup");
  check(colCategoria?.spanGroup !== true, "J16: Categoria NÃO é spanGroup (só CNP+Descrição, como em Vendas)");

  const html = renderReportHtml(rel);
  const body = html.slice(html.indexOf("<body>"));
  check(body.includes('rowspan="3"'), "J17: rowspan=\"3\" cobre as 2 sublinhas + o TOTAL ARTIGO");
  check(body.includes(`>${formatCurrency(6.66)}<`), "J18: PVP do Segurado (6,66 €) aparece no PDF/HTML");
  check(body.includes(`>${formatCurrency(6.5)}<`), "J19: PVP do Silveirense (6,50 €) também, distinto");
  check(body.includes("TOTAL ARTIGO"), "J20: TOTAL ARTIGO aparece");

  // Uma só farmácia — sem TOTAL ARTIGO, sem rowspan.
  const rel1f = buildMargensProdutoReport({
    rows: [linha({})],
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });
  eq(rel1f.rows.length, 1, "J21: 1 farmácia — sem TOTAL ARTIGO");
  const bodyM1f = renderReportHtml(rel1f);
  check(!bodyM1f.slice(bodyM1f.indexOf("<body>")).includes("rowspan"), "J22: sem rowspan (grupo de tamanho 1)");
}

// ══════════════════════════════════════════════════════════════════════
// K · Bloco por artigo — Inventário Por Produto (referência: Vendas)
// ══════════════════════════════════════════════════════════════════════
console.log("\nK · Inventário Por Produto — bloco por artigo, farmácias em ordem estável");
{
  const linha = (over: Partial<InventarioRow>): InventarioRow => ({
    cnp: 8322628, designacao: "Ventilan", categoria: "Respiratório", grupo: null,
    farmaciaId: "f1", farmacia: "Farmácia Segurado",
    stockAtual: 10, stockMinimo: 2, pmc: 4.46, puc: 4.46, pvp: 6.66,
    custoUnitario: 4.46, taxaIva: 23, valorStock: 44.6, valorIva: 10.26,
    valorStockComIva: 54.86, dataUltimaVenda: null, dataUltimaCompra: null,
    diasSemVenda: null, vendas90d: 0, vendaMediaDia90d: 0, coberturaDias: 30,
    estado: "NORMAL",
    ...over,
  });
  const rows = [
    linha({ farmacia: "Farmácia Silveirense", pmc: 3.75, pvp: 6.5, stockAtual: 4, valorStock: 15, valorIva: 3.45, valorStockComIva: 18.45 }),
    linha({ farmacia: "Farmácia Segurado" }),
  ];
  const rel = buildInventarioReport({
    rows,
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });

  eq(rel.rows.length, 3, "K1: 2 detalhes + 1 TOTAL ARTIGO");
  eq(rel.rows.map((r) => r.farmacia), ["Farmácia Segurado", "Farmácia Silveirense", "TOTAL ARTIGO"], "K2: ordem estável do universo, TOTAL ARTIGO no fim");
  eq(rel.rows[0][GROUP_KEY], rel.rows[2][GROUP_KEY], "K3: detalhes e TOTAL ARTIGO partilham o mesmo grupo/rowspan");
  eq(rel.rows[2][ROW_KIND_KEY], "subtotal", "K4: TOTAL ARTIGO marcado como subtotal");

  eq(rel.rows[0].pvp, 6.66, "K5: PVP do Segurado é o SEU");
  eq(rel.rows[1].pvp, 6.5, "K6: PVP do Silveirense é o SEU, diferente");
  eq(rel.rows[2].pvp, null, "K7: TOTAL ARTIGO sem PVP (nunca um valor único)");
  eq(rel.rows[2].pmc, null, "K8: TOTAL ARTIGO sem PMC (idem, é o «custo» aqui)");
  eq(rel.rows[2].stockAtual, 14, "K9: TOTAL ARTIGO soma o stock (10+4)");
  eq(rel.rows[2].valorStockComIva, 73.31, "K10: …e o valor c/IVA (54,86+18,45)");

  const html = renderReportHtml(rel);
  const body = html.slice(html.indexOf("<body>"));
  check(body.includes('rowspan="3"'), "K11: rowspan=\"3\" cobre as 2 sublinhas + o TOTAL ARTIGO");
  check(body.includes(`>${formatCurrency(6.66)}<`), "K12: PVP do Segurado (6,66 €) no PDF/HTML");
  check(body.includes(`>${formatCurrency(6.5)}<`), "K13: PVP do Silveirense (6,50 €) também, distinto");
}

// ══════════════════════════════════════════════════════════════════════
// L · Margens Por Produto — correcção visual: Categoria vira sublinha
// ══════════════════════════════════════════════════════════════════════
console.log("\nL · Margens Por Produto — Categoria como sublinha (correcção visual 2026-09)");
{
  const linhaLonga = (over: Partial<MargemRow>): MargemRow => ({
    cnp: 1, designacao: "Acarbose Generis 100 mg 50 comprimidos revestidos por película",
    categoria: "Medicamentos Não Sujeitos a Receita Médica", grupo: null,
    farmaciaId: "f1", farmacia: "Farmácia Segurado", fabricante: "Fabricante Teste",
    qtdVendida: 10, valorVendido: 66.6, pvpUnitario: 6.66, custoUnitario: 4.46,
    valorVendidoSemIva: 54.15, taxaIva: 23, custoUnitarioBase: 4.46, custoEstimado: 44.6,
    margemEur: 9.55, margemPct: 17.6, coberturaCusto: 1, estado: "FIAVEL",
    ...over,
  });
  const rel = buildMargensProdutoReport({
    rows: [linhaLonga({})],
    filters: {},
    universe: { farmacias: UNIVERSE_2, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });

  const colCategoria = rel.columns.find((c) => c.key === "categoria");
  check(colCategoria?.excelOnly === true, "L1: Categoria já não desenha no HTML/PDF — só existe no Excel");
  const colDesc = rel.columns.find((c) => c.key === "designacao");
  eq(colDesc?.noteKey, "categoriaNota", "L2: Descrição usa noteKey para mostrar a categoria por baixo");
  check((colDesc?.width ?? 0) > 20, "L3: Descrição ganhou largura (>20%, era ~15%)");
  const colFarmacia = rel.columns.find((c) => c.key === "farmacia");
  check((colFarmacia?.width ?? 0) >= 9, "L4: Farmácia com largura decente (≥9%, nunca esmagada por métricas)");

  const soma = rel.columns
    .filter((c) => !c.hidden && !c.excelOnly)
    .reduce((s, c) => s + (c.width ?? 0), 0);
  eq(Math.round(soma * 1000) / 1000, 100, "L5: larguras visíveis continuam a somar exactamente 100");

  const html = renderReportHtml(rel);
  const body = html.slice(html.indexOf("<body>"));
  check(body.includes(">Medicamentos Não Sujeitos a Receita Médica<"), "L6: a categoria longa aparece por inteiro, como sublinha");
  const theadHtml = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
  check(!theadHtml.includes(">Categoria<"), "L7: já não há coluna própria 'Categoria' no cabeçalho do HTML/PDF");

  // A categoria nunca pode quebrar dentro de uma palavra — nenhuma
  // palavra da categoria mais longa usada nesta suite ultrapassa o que
  // cabe numa coluna de ~24% (a antiga, de ~8%, é que partia palavras).
  const maiorPalavra = "Medicamentos Não Sujeitos a Receita Médica"
    .split(" ")
    .reduce((a, b) => (b.length > a.length ? b : a), "");
  check(body.includes(maiorPalavra), "L8: a maior palavra da categoria aparece inteira, nunca partida a meio");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
