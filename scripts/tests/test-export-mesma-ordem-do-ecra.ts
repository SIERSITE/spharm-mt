/**
 * scripts/tests/test-export-mesma-ordem-do-ecra.ts
 *
 * Regressão: a exportação (PDF/impressão/Excel/email) tem de receber
 * EXACTAMENTE as mesmas linhas que a tabela mostra, na mesma sequência —
 * depois de filtros, agrupamento, ordenação do selector e ordenação por
 * cabeçalho. Bug encontrado e corrigido nesta revisão: em Vendas,
 * Transferências, Excessos, Devoluções e Inventário (vista Produto,
 * "Agrupar por: Farmácia"), o ecrã e a exportação liam de arrays
 * DIFERENTES — a exportação usava sempre uma fase anterior do pipeline
 * (antes do clique no cabeçalho, ou mesmo antes de qualquer ordenação).
 * Margens já estava correcto; mantido aqui como guarda de regressão.
 *
 * Dois ângulos, complementares:
 *   A/C/D — os adapters (buildXReport) NUNCA reordenam o que recebem —
 *     provado dando-lhes uma sequência deliberadamente fora de ordem
 *     natural e comparando a sequência de CNPs/códigos devolvida.
 *   B — verificação estática dos 6 componentes de ecrã: confirma que o
 *     `<ReportActions report={...}>` de cada um referencia a MESMA
 *     variável que a tabela renderiza, e não a variável de uma fase
 *     anterior do pipeline (a classe exacta de bug corrigida aqui).
 *
 * Puro: sem base de dados, sem rede.
 * Corre com: npx tsx scripts/tests/test-export-mesma-ordem-do-ecra.ts
 */
import { readFileSync } from "node:fs";
import { buildVendasReport, type VendasAdapterRow } from "../../lib/reporting/adapters/vendas";
import { buildTransferenciasReport } from "../../lib/reporting/adapters/transferencias";
import { buildExcessosReport } from "../../lib/reporting/adapters/excessos";
import { buildDevolucoesReport } from "../../lib/reporting/adapters/devolucoes";
import { buildMargensProdutoReport } from "../../lib/reporting/adapters/margens";
import { buildInventarioReport, buildInventarioPorFarmaciaReport } from "../../lib/reporting/adapters/inventario";
import type { MargemRow } from "../../lib/margens-data";
import type { InventarioRow, InventarioPorFarmaciaRow } from "../../lib/inventario-data";
import { ordenarLinhas, type EstadoOrdenacao } from "../../lib/tabela/ordenacao";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

const UNIVERSE_3 = ["Farmácia Alfa", "Farmácia Beta", "Farmácia Gama"];

console.log("A · Vendas — o adapter preserva a sequência recebida (detalhe, sem agrupar por artigo)");
{
  const linha = (over: Partial<VendasAdapterRow>): VendasAdapterRow => ({
    codigo: "0000000", descricao: "Produto", pvp: 5, meses: [], totalVendas: 10,
    existencia: 3, fornecedor: "F", fabricante: "Fab", categoria: "Cat",
    farmacia: "Farmácia Alfa", grupo: "G", ...over,
  });
  // Sequência deliberadamente FORA de ordem alfabética/numérica — se o
  // adapter reordenasse (por código, por valor, por qualquer critério),
  // esta sequência exacta não sobreviveria.
  const rows = [
    linha({ codigo: "3000003", descricao: "Zebra", totalVendas: 5 }),
    linha({ codigo: "1000001", descricao: "Abelha", totalVendas: 99 }),
    linha({ codigo: "2000002", descricao: "Meio", totalVendas: 1 }),
  ];
  const rel = buildVendasReport({
    rows, buckets: [],
    filters: { agruparPor: "artigo" as never }, // "artigo" mas com 1 farmácia só por código → sem duplicar em subtotais visíveis na sequência de detalhe
    universe: { farmacias: UNIVERSE_3, fornecedores: [], fabricantes: [], laboratorios: [], categorias: [] },
    organization: "Grupo",
  });
  eq(rel.rows.map((r) => r.codigo), ["3000003", "1000001", "2000002"], "A1: sequência de códigos preservada, na ordem de entrada");
}

console.log("\nB · verificação estática — cada ecrã exporta a MESMA variável que a tabela renderiza");
{
  const ler = (caminho: string) => readFileSync(new URL(`../../${caminho}`, import.meta.url), "utf8");

  const vendas = ler("components/vendas/vendas-client.tsx");
  check(/rows:\s*ambito === "comparativo" \? comparativoRows : rowsOrdenadas,/.test(vendas), "B1 (Vendas): exporta rowsOrdenadas (ou comparativoRows em comparativo) — não orderedRows");
  check(!/report={\(\) =>\s*\n\s*buildVendasReport\(\{\s*\n\s*rows: orderedRows,/.test(vendas), "B2 (Vendas): já não exporta orderedRows directamente");

  const transferencias = ler("components/transferencias/transferencias-client.tsx");
  check(/buildTransferenciasReport\(\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*rows: rowsVisiveis,/.test(transferencias), "B3 (Transferências): exporta rowsVisiveis");
  check(!/buildTransferenciasReport\(\{\s*\n\s*rows: rowsForReport,/.test(transferencias), "B4 (Transferências): já não exporta rowsForReport directamente");

  const excessos = ler("components/excessos/excessos-client.tsx");
  check(/buildExcessosReport\(\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*rows: rowsVisiveis,/.test(excessos), "B5 (Excessos): exporta rowsVisiveis");
  check(!/buildExcessosReport\(\{\s*\n\s*rows: rowsForReport,/.test(excessos), "B6 (Excessos): já não exporta rowsForReport directamente");

  const devolucoes = ler("components/devolucoes/devolucoes-client.tsx");
  check(/const rowsParaExportacao = groupedBySupplier\.flatMap\(\(g\) => g\.rows\);/.test(devolucoes), "B7 (Devoluções): deriva rowsParaExportacao do MESMO agrupamento+ordenação que a tabela usa (groupedBySupplier)");
  check(/rows: rowsParaExportacao\.map/.test(devolucoes), "B8 (Devoluções): exporta rowsParaExportacao, não filteredRows directamente");
  check(!/rows: filteredRows\.map/.test(devolucoes), "B9 (Devoluções): já não exporta filteredRows (plano, sem agrupamento) directamente");

  const inventario = ler("components/inventario/inventario-client.tsx");
  check(/agrupamento === "farmacia" && aggregated\)/.test(inventario), "B10 (Inventário): buildReport() verifica agrupamento==='farmacia' antes do fallback");
  check(/buildInventarioPorFarmaciaReport\(\{\s*\n\s*rows: aggregated\.map/.test(inventario), "B11 (Inventário): quando agrupado por farmácia, exporta a partir de `aggregated` (o que a tabela mostra), não do detalhe por produto");

  const margens = ler("components/margens/margens-client.tsx");
  check(/rowsOrdenadasProduto/.test(margens) && /linhasAgregadas\(result, nivel\)/.test(margens), "B12 (Margens — regressão): continua a usar rowsOrdenadasProduto/linhasAgregadas, tal como a tabela (nada mudou, guarda de regressão)");
}

console.log("\nC · Transferências/Excessos/Devoluções/Margens/Inventário — adapters preservam sequência fora de ordem natural");
{
  const relT = buildTransferenciasReport({
    rows: [
      { cnp: "3000003", produto: "Zebra", farmaciaOrigem: "Farmácia Alfa", farmaciaDestino: "Farmácia Beta", stockOrigem: 1, stockDestino: 1, coberturaOrigem: 1, coberturaDestino: 1, quantidadeSugerida: 1, excessoOrigem: 1, necessidadeDestino: 1, fabricante: "F", categoria: "C", fornecedor: "Forn", prioridade: "Alta" },
      { cnp: "1000001", produto: "Abelha", farmaciaOrigem: "Farmácia Alfa", farmaciaDestino: "Farmácia Beta", stockOrigem: 1, stockDestino: 1, coberturaOrigem: 1, coberturaDestino: 1, quantidadeSugerida: 1, excessoOrigem: 1, necessidadeDestino: 1, fabricante: "F", categoria: "C", fornecedor: "Forn", prioridade: "Alta" },
      { cnp: "2000002", produto: "Meio", farmaciaOrigem: "Farmácia Alfa", farmaciaDestino: "Farmácia Beta", stockOrigem: 1, stockDestino: 1, coberturaOrigem: 1, coberturaDestino: 1, quantidadeSugerida: 1, excessoOrigem: 1, necessidadeDestino: 1, fabricante: "F", categoria: "C", fornecedor: "Forn", prioridade: "Alta" },
    ],
    filters: {},
    universe: { farmacias: UNIVERSE_3, fornecedores: [], fabricantes: [], categorias: [], prioridades: [] },
    organization: "Grupo",
  });
  eq(relT.rows.map((r) => r.cnp), ["3000003", "1000001", "2000002"], "C1 (Transferências): sequência preservada");

  const relE = buildExcessosReport({
    rows: [
      { cnp: "3000003", produto: "Zebra", farmaciaOrigem: "Farmácia Alfa", farmaciaDestino: "Farmácia Beta", stockOrigem: 1, stockDestino: 1, coberturaOrigem: 1, coberturaDestino: 1, quantidadeSugerida: 1, excessoOrigem: 1, necessidadeDestino: 1, vendas6M: 1, mediaMensal6M: 1, fabricante: "F", categoria: "C", fornecedor: "Forn", prioridade: "Alta" },
      { cnp: "1000001", produto: "Abelha", farmaciaOrigem: "Farmácia Alfa", farmaciaDestino: "Farmácia Beta", stockOrigem: 1, stockDestino: 1, coberturaOrigem: 1, coberturaDestino: 1, quantidadeSugerida: 1, excessoOrigem: 1, necessidadeDestino: 1, vendas6M: 1, mediaMensal6M: 1, fabricante: "F", categoria: "C", fornecedor: "Forn", prioridade: "Alta" },
      { cnp: "2000002", produto: "Meio", farmaciaOrigem: "Farmácia Alfa", farmaciaDestino: "Farmácia Beta", stockOrigem: 1, stockDestino: 1, coberturaOrigem: 1, coberturaDestino: 1, quantidadeSugerida: 1, excessoOrigem: 1, necessidadeDestino: 1, vendas6M: 1, mediaMensal6M: 1, fabricante: "F", categoria: "C", fornecedor: "Forn", prioridade: "Alta" },
    ],
    filters: {},
    universe: { farmacias: UNIVERSE_3, fornecedores: [], fabricantes: [], categorias: [], prioridades: [] },
    organization: "Grupo",
  });
  eq(relE.rows.map((r) => r.cnp), ["3000003", "1000001", "2000002"], "C2 (Excessos): sequência preservada");

  const relD = buildDevolucoesReport({
    rows: [
      { data: "2026-09-01", cnp: "3000003", produto: "Zebra", farmacia: "Farmácia Alfa", fornecedor: "X", fabricante: "F", categoria: "C", quantidade: 1, valor: 1, motivo: "M" },
      { data: "2026-09-01", cnp: "1000001", produto: "Abelha", farmacia: "Farmácia Alfa", fornecedor: "X", fabricante: "F", categoria: "C", quantidade: 1, valor: 1, motivo: "M" },
      { data: "2026-09-01", cnp: "2000002", produto: "Meio", farmacia: "Farmácia Alfa", fornecedor: "X", fabricante: "F", categoria: "C", quantidade: 1, valor: 1, motivo: "M" },
    ],
    filters: {},
    universe: { pharmacies: UNIVERSE_3, suppliers: [], manufacturers: [], categories: [] },
    organization: "Grupo",
  });
  eq(relD.rows.map((r) => r.cnp), ["3000003", "1000001", "2000002"], "C3 (Devoluções): sequência preservada — confirma que buildDevolucoesReport, por si, nunca reordena (a responsabilidade de agrupar/ordenar é do ecrã, ver bloco B)");

  const margemLinha = (over: Partial<MargemRow>): MargemRow => ({
    cnp: 1000001, designacao: "P", categoria: "C", grupo: null, farmaciaId: "f1", farmacia: "Farmácia Alfa",
    fabricante: "F", qtdVendida: 1, pvpUnitario: 1, valorVendido: 1, taxaIva: 23, valorVendidoSemIva: 0.81,
    custoUnitario: 1, custoUnitarioBase: 1, custoEstimado: 1, margemEur: 0, margemPct: 0, coberturaCusto: 1,
    estado: "FIAVEL", ...over,
  });
  const relM = buildMargensProdutoReport({
    rows: [
      margemLinha({ cnp: 3000003, designacao: "Zebra" }),
      margemLinha({ cnp: 1000001, designacao: "Abelha" }),
      margemLinha({ cnp: 2000002, designacao: "Meio" }),
    ],
    filters: {},
    universe: { farmacias: UNIVERSE_3, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });
  eq(relM.rows.map((r) => String(r.cnp)), ["3000003", "1000001", "2000002"], "C4 (Margens): sequência preservada");

  const invLinha = (over: Partial<InventarioRow>): InventarioRow => ({
    cnp: 1000001, designacao: "P", categoria: "C", grupo: null, farmaciaId: "f1", farmacia: "Farmácia Alfa",
    stockAtual: 1, stockMinimo: 1, pmc: 1, puc: 1, pvp: 1, custoUnitario: 1, taxaIva: 23,
    valorStock: 1, valorIva: 0.23, valorStockComIva: 1.23, dataUltimaVenda: null, dataUltimaCompra: null,
    diasSemVenda: null, vendas90d: 0, vendaMediaDia90d: 0, coberturaDias: 1, estado: "NORMAL", ...over,
  });
  const relI = buildInventarioReport({
    rows: [
      invLinha({ cnp: 3000003, designacao: "Zebra" }),
      invLinha({ cnp: 1000001, designacao: "Abelha" }),
      invLinha({ cnp: 2000002, designacao: "Meio" }),
    ],
    filters: {},
    universe: { farmacias: UNIVERSE_3, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });
  eq(relI.rows.map((r) => String(r.cnp)), ["3000003", "1000001", "2000002"], "C5 (Inventário, detalhe por produto): sequência preservada");

  // buildInventarioPorFarmaciaReport reordena DELIBERADAMENTE por
  // ordenarPorFarmacia (comentário no próprio adapter) — não é o bug
  // desta revisão (é a MESMA ordem estável que a vista "Por Farmácia" já
  // usa). Prova-se aqui só que aceita as linhas agregadas do ecrã
  // (`aggregated`, ver bloco B) sem rebentar e sem perder nenhuma.
  const farmLinha = (over: Partial<InventarioPorFarmaciaRow>): InventarioPorFarmaciaRow => ({
    farmaciaId: "fX", farmacia: "Farmácia Alfa", numProdutos: 1, stockTotal: 1, valorStockSemIva: 1,
    valorIva: 1, valorStockComIva: 1, rotura: 0, excesso: 0, semMovimento: 0, semCusto: 0, semStock: 0, normal: 1,
    ...over,
  });
  const relIF = buildInventarioPorFarmaciaReport({
    rows: [farmLinha({ farmacia: "Farmácia Beta" }), farmLinha({ farmacia: "Farmácia Alfa" }), farmLinha({ farmacia: "Farmácia Gama" })],
    filters: {},
    universe: { farmacias: UNIVERSE_3, categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });
  eq(relIF.rows.length, 3, "C6 (Inventário, agrupado por farmácia): as 3 linhas agregadas chegam ao relatório, nenhuma perdida");
  eq(relIF.rows.map((r) => r.farmacia), UNIVERSE_3, "C7 (Inventário, agrupado por farmácia): ordem estável do universo (comportamento intencional e pré-existente, não afectado por esta correcção)");
}

console.log("\nD · A→Z, Z→A, numérico asc/desc — ordenarLinhas + adapter, sequência ponta-a-ponta");
{
  type Col = "descricao" | "totalVendas";
  const linha = (codigo: string, descricao: string, totalVendas: number): VendasAdapterRow => ({
    codigo, descricao, pvp: 1, meses: [], totalVendas, existencia: 1,
    fornecedor: "F", fabricante: "Fab", categoria: "Cat", farmacia: "Farmácia Alfa", grupo: "G",
  });
  const rows = [linha("2", "Meio", 20), linha("1", "Abelha", 5), linha("3", "Zebra", 99)];
  const acessor = (r: VendasAdapterRow, col: Col) => (col === "descricao" ? r.descricao : r.totalVendas);

  const testarSequencia = (estado: EstadoOrdenacao<Col>, esperado: string[], label: string) => {
    const ordenadas = ordenarLinhas(rows, estado, acessor);
    const rel = buildVendasReport({
      rows: ordenadas, buckets: [], filters: {},
      universe: { farmacias: UNIVERSE_3, fornecedores: [], fabricantes: [], laboratorios: [], categorias: [] },
      organization: "Grupo",
    });
    eq(rel.rows.map((r) => r.codigo), esperado, label);
  };

  testarSequencia({ coluna: "descricao", direcao: "asc" }, ["1", "2", "3"], "D1: Artigo A→Z — Abelha, Meio, Zebra");
  testarSequencia({ coluna: "descricao", direcao: "desc" }, ["3", "2", "1"], "D2: Artigo Z→A — Zebra, Meio, Abelha");
  testarSequencia({ coluna: "totalVendas", direcao: "asc" }, ["1", "2", "3"], "D3: coluna numérica ascendente");
  testarSequencia({ coluna: "totalVendas", direcao: "desc" }, ["3", "2", "1"], "D4: coluna numérica descendente");

  // CNP asc/desc — mesmo mecanismo, coluna "codigo".
  type ColCnp = "codigo";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- assinatura obrigatória de Acessor<T,K>
  const acessorCnp = (r: VendasAdapterRow, _col: ColCnp): string => r.codigo;
  const ordAsc = ordenarLinhas(rows, { coluna: "codigo", direcao: "asc" } as EstadoOrdenacao<ColCnp>, acessorCnp);
  eq(ordAsc.map((r) => r.codigo), ["1", "2", "3"], "D5: CNP ascendente");
  const ordDesc = ordenarLinhas(rows, { coluna: "codigo", direcao: "desc" } as EstadoOrdenacao<ColCnp>, acessorCnp);
  eq(ordDesc.map((r) => r.codigo), ["3", "2", "1"], "D6: CNP descendente");
}

console.log("\nE · totais/subtotais não dependem da ordem das linhas");
{
  const linha = (codigo: string, totalVendas: number, valorBruto: number): VendasAdapterRow => ({
    codigo, descricao: "P", pvp: 1, meses: [], totalVendas, valorBruto, existencia: 1,
    fornecedor: "F", fabricante: "Fab", categoria: "Cat", farmacia: "Farmácia Alfa", grupo: "G",
  });
  const base = [linha("1", 10, 100), linha("2", 20, 200), linha("3", 30, 300)];
  const baralhada = [base[2]!, base[0]!, base[1]!];

  const relBase = buildVendasReport({ rows: base, buckets: [], filters: {}, universe: { farmacias: UNIVERSE_3, fornecedores: [], fabricantes: [], laboratorios: [], categorias: [] }, organization: "G" });
  const relBaralhada = buildVendasReport({ rows: baralhada, buckets: [], filters: {}, universe: { farmacias: UNIVERSE_3, fornecedores: [], fabricantes: [], laboratorios: [], categorias: [] }, organization: "G" });

  eq(relBase.summary, relBaralhada.summary, "E1: summary (totais) idêntico independentemente da ordem de entrada");
  check(relBase.rows.map((r) => r.codigo).join(",") !== relBaralhada.rows.map((r) => r.codigo).join(","), "E2: as SEQUÊNCIAS de linhas são diferentes entre si (confirma que o teste está mesmo a comparar ordens distintas)");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
