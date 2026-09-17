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
 * Puro: sem base de dados, sem rede. Corre com: npx tsx scripts/tests/test-reporting-uniformizacao.ts
 */
import { nomeFarmaciaCurto } from "../../lib/reporting/farmacia-nome";
import { compararPorNomeFarmacia, ordenarPorFarmacia } from "../../lib/reporting/ordenacao-farmacias";
import { normalizarLargura } from "../../lib/reporting/column-widths";
import { renderReportHtml } from "../../lib/reporting/report-html";
import type { ReportColumn } from "../../lib/reporting/report-types";
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

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
