/**
 * scripts/tests/test-export-cabecalho-laboratorio.ts
 *
 * Testa a tradução dos valores "grupo:<id>"/"fabricante:<id>" para
 * etiquetas legíveis nos cabeçalhos/resumos de export (PDF/Excel/Email —
 * todos consomem o MESMO `Report.filtersApplied`, construído uma única
 * vez por `buildXxxReport`, nunca por formato — ver
 * components/reporting/report-actions.tsx) de Vendas, Margens e
 * Inventário. Corrigido em 2026-09-25: antes desta correcção, um id
 * interno como "grupo:cke1..." podia chegar a um PDF entregue ao
 * cliente.
 *
 * Corre com: npx tsx scripts/tests/test-export-cabecalho-laboratorio.ts
 */
import {
  rotuloLaboratorioParaExport,
  traduzirLaboratoriosParaExport,
  type CatalogoFilterOptionLaboratorio,
} from "../../lib/catalog/laboratorio-filtro";
import { buildMargensProdutoReport } from "../../lib/reporting/adapters/margens";
import { buildInventarioReport } from "../../lib/reporting/adapters/inventario";
import { buildVendasReport } from "../../lib/reporting/adapters/vendas";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

const LABORATORIOS: CatalogoFilterOptionLaboratorio[] = [
  { tipo: "grupo", id: "gViatris", nome: "VIATRIS", termosBusca: ["Mylan", "Upjohn"], resumoAlcance: ["Viatris", "Mylan", "Upjohn"], produtos: 808 },
  { tipo: "fabricante", id: "fMylanLda", nomeNormalizado: "MYLAN LDA", produtos: 604 },
  { tipo: "fabricante", id: "fUpjohn", nomeNormalizado: "UPJOHN EESV", produtos: 45 },
];

console.log("A · rotuloLaboratorioParaExport — traduz id para etiqueta legível");
{
  eq(rotuloLaboratorioParaExport("grupo:gViatris", LABORATORIOS), "Grupo: VIATRIS", "A1: grupo:<id> → 'Grupo: VIATRIS'");
  eq(rotuloLaboratorioParaExport("fabricante:fMylanLda", LABORATORIOS), "Fabricante: MYLAN LDA", "A2: fabricante:<id> → 'Fabricante: MYLAN LDA'");
}

console.log("\nB · valor tipado cujo id já não existe na lista actual — 'Seleção indisponível', NUNCA o id");
{
  const rotulo = rotuloLaboratorioParaExport("grupo:gApagado", LABORATORIOS);
  eq(rotulo, "Seleção indisponível", "B1: id desconhecido → 'Seleção indisponível'");
  check(!rotulo.includes("gApagado"), "B2: o id NUNCA aparece no rótulo, mesmo no caso de falha");
  const rotulo2 = rotuloLaboratorioParaExport("fabricante:fApagado", LABORATORIOS);
  eq(rotulo2, "Seleção indisponível", "B3: mesmo para fabricante:<id> desconhecido");
}

console.log("\nC · valor SEM prefixo (outros tenants, ou link antigo) — devolvido tal e qual, já é legível");
{
  eq(rotuloLaboratorioParaExport("Bayer Portugal, Lda.", LABORATORIOS), "Bayer Portugal, Lda.", "C1: nome solto passa inalterado");
  eq(rotuloLaboratorioParaExport("Bial", undefined), "Bial", "C2: mesmo sem lista de laboratórios (outros tenants)");
}

console.log("\nD · traduzirLaboratoriosParaExport — selecção MISTA (grupo + fabricante) devolve as DUAS etiquetas, deduplicadas e ordenadas deterministicamente");
{
  const resultado = traduzirLaboratoriosParaExport(["grupo:gViatris", "fabricante:fMylanLda"], LABORATORIOS);
  eq(resultado, ["Fabricante: MYLAN LDA", "Grupo: VIATRIS"], "D1: as duas etiquetas presentes, ordem alfabética determinística");

  // Ordem de selecção INVERTIDA — o resultado tem de ser IGUAL (determinismo).
  const resultadoInvertido = traduzirLaboratoriosParaExport(["fabricante:fMylanLda", "grupo:gViatris"], LABORATORIOS);
  eq(resultadoInvertido, resultado, "D2: mesma saída independentemente da ordem em que foram seleccionados");
}

console.log("\nE · traduzirLaboratoriosParaExport — deduplica etiquetas repetidas");
{
  const resultado = traduzirLaboratoriosParaExport(["grupo:gViatris", "grupo:gViatris"], LABORATORIOS);
  eq(resultado, ["Grupo: VIATRIS"], "E1: 'grupo:gViatris' duas vezes → 1 única etiqueta");
}

console.log("\nF · fora de garantia (laboratorios=undefined) — devolve a lista TAL E QUAL, sem ordenar nem deduplicar (comportamento anterior, inalterado)");
{
  const resultado = traduzirLaboratoriosParaExport(["Zeta", "Alfa", "Alfa"], undefined);
  eq(resultado, ["Zeta", "Alfa", "Alfa"], "F1: ordem de selecção preservada, duplicados preservados — zero alteração para outros tenants");
}

console.log("\nG · nenhuma string 'grupo:' ou 'fabricante:' pode sobreviver à tradução");
{
  for (const valor of ["grupo:gViatris", "fabricante:fMylanLda", "grupo:gApagado", "fabricante:fApagado"]) {
    const rotulo = rotuloLaboratorioParaExport(valor, LABORATORIOS);
    check(!/^(grupo|fabricante):/.test(rotulo), `G1 (${valor}): rótulo final "${rotulo}" não começa por 'grupo:'/'fabricante:'`);
  }
}

console.log("\nH · integração real — buildMargensProdutoReport com selecção tipada: cabeçalho traduzido, ZERO string 'grupo:'/'fabricante:' em todo o Report");
{
  const relatorio = buildMargensProdutoReport({
    rows: [],
    filters: { fabricantes: ["grupo:gViatris"] },
    universe: { farmacias: [], categorias: [], fabricantes: [], laboratorios: LABORATORIOS, distribuidores: [] },
    organization: "Grupo",
  });
  const entrada = relatorio.filtersApplied?.find((f) => f.label === "Laboratório/grupo");
  check(!!entrada, "H1: entrada 'Laboratório/grupo' presente (singular — só 1 seleccionado)");
  eq(entrada?.value, "Grupo: VIATRIS", "H2: valor traduzido correctamente");
  const jsonCompleto = JSON.stringify(relatorio);
  check(!jsonCompleto.includes("grupo:g") && !jsonCompleto.includes("fabricante:f"), "H3: NENHUM id interno sobra em qualquer parte do Report (PDF/Excel/Email leem exactamente este objecto)");
}

console.log("\nI · integração real — buildInventarioReport com selecção MISTA: rótulo plural, ambas etiquetas, separadas por '; '");
{
  const relatorio = buildInventarioReport({
    rows: [],
    filters: { fabricantes: ["grupo:gViatris", "fabricante:fUpjohn"] },
    universe: { farmacias: [], categorias: [], fabricantes: [], laboratorios: LABORATORIOS, distribuidores: [] },
    organization: "Grupo",
  });
  const entrada = relatorio.filtersApplied?.find((f) => f.label === "Laboratórios/grupos");
  check(!!entrada, "I1: entrada 'Laboratórios/grupos' presente (plural — 2 seleccionados)");
  eq(entrada?.value, "Fabricante: UPJOHN EESV; Grupo: VIATRIS", "I2: as duas etiquetas, separadas por '; ', ordem alfabética");
}

console.log("\nJ · integração real — buildVendasReport com selecção tipada cujo id já não existe: 'Seleção indisponível' no PDF, nunca o id");
{
  const relatorio = buildVendasReport({
    rows: [],
    buckets: [],
    filters: { fabricantesSelecionados: ["grupo:gApagadoEntretanto"] },
    universe: { farmacias: [], fornecedores: [], fabricantes: [], laboratorios: LABORATORIOS, categorias: [] },
    organization: "Grupo",
  });
  const entrada = relatorio.filtersApplied?.find((f) => f.label === "Laboratório/grupo");
  eq(entrada?.value, "Seleção indisponível", "J1: id apagado/inexistente → 'Seleção indisponível'");
  const jsonCompleto = JSON.stringify(relatorio);
  check(!jsonCompleto.includes("gApagadoEntretanto"), "J2: o id NUNCA aparece em nenhuma parte do Report exportado");
}

console.log("\nK · outro tenant (universe.laboratorios AUSENTE) — rótulo 'Fabricantes', valor tal e qual, comportamento 100% inalterado");
{
  const relatorio = buildMargensProdutoReport({
    rows: [],
    filters: { fabricantes: ["Bayer Portugal, Lda.", "Bial"] },
    universe: { farmacias: [], categorias: [], fabricantes: ["Bayer Portugal, Lda.", "Bial", "Outro"], distribuidores: [] },
    organization: "Grupo",
  });
  const entrada = relatorio.filtersApplied?.find((f) => f.label === "Fabricantes");
  check(!!entrada, "K1: rótulo continua 'Fabricantes' (sem universe.laboratorios)");
  eq(entrada?.value, "Bayer Portugal, Lda., Bial", "K2: valores tal e qual, separados por ', ' (vírgula) como sempre foi — nunca '; '");
  check(!relatorio.filtersApplied?.some((f) => f.label === "Laboratório/grupo" || f.label === "Laboratórios/grupos"), "K3: nunca aparece o rótulo novo fora de garantia");
}

console.log("\nL · a tradução do cabeçalho NUNCA altera resultados/totais — mesmas rows, mesmas colunas, independentemente do valor de filters.fabricantes");
{
  const rowsIguais = [{
    cnp: 2000001, designacao: "Produto X", grupo: null, farmaciaId: "f1", farmacia: "Silveirense",
    fabricante: "MYLAN LDA", qtdVendida: 10, valorVendido: 100, pvpUnitario: 10, custoUnitario: 8,
    valorVendidoSemIva: 94.3, taxaIva: 6, custoUnitarioBase: 8, custoEstimado: 80, margemEur: 14.3,
    margemPct: 15.2, coberturaCusto: 1, estado: "FIAVEL" as const,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }] as any;
  const relatorioTipado = buildMargensProdutoReport({
    rows: rowsIguais,
    filters: { fabricantes: ["grupo:gViatris"] },
    universe: { farmacias: [], categorias: [], fabricantes: [], laboratorios: LABORATORIOS, distribuidores: [] },
    organization: "Grupo",
  });
  const relatorioSemFiltroTipo = buildMargensProdutoReport({
    rows: rowsIguais,
    filters: {},
    universe: { farmacias: [], categorias: [], fabricantes: [], laboratorios: LABORATORIOS, distribuidores: [] },
    organization: "Grupo",
  });
  eq(relatorioTipado.rows, relatorioSemFiltroTipo.rows, "L1: as rows do relatório são idênticas — só o texto do CABEÇALHO muda, nunca os dados (a filtragem real já aconteceu antes, no servidor)");
  eq(relatorioTipado.columns, relatorioSemFiltroTipo.columns, "L2: colunas idênticas");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
