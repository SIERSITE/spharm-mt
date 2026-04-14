/**
 * lib/reporting/adapters/vendas.ts
 *
 * Converte os dados da página Vendas para o formato Report comum.
 * Esta é a ÚNICA peça específica de Vendas na camada de reporting.
 * Toda a lógica de HTML/PDF/Excel/Email vive em lib/reporting/*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISÕES DE CONTEÚDO
 *
 *  Jan/Fev/Mar/Abr e "Total Unidades" são UNIDADES (quantidade vendida
 *  em cada mês), não valor monetário. Vêm directamente de
 *  VendaMensal.quantidade em lib/vendas-data.ts. Estavam erradamente
 *  formatados como currency na versão anterior — agora usam `number`.
 *
 *  PVP é o único valor monetário verdadeiramente fiável: vem de
 *  ProdutoFarmacia.pvp. Mantido como currency.
 *
 *  Colunas removidas nesta versão executiva do relatório:
 *    - Fabricante → estava a mostrar fornecedorOrigem (grossista). A
 *      correcção real é no pipeline de enriquecimento. Até lá, não
 *      mostrar é melhor que mostrar algo errado.
 *    - Fornecedor → vem de familiaOrigem que é ambíguo; inconsistente
 *      entre ficheiros de origem.
 *    - Categoria → mistura de taxonomias das farmácias, ainda não
 *      canónica. O worker de enriquecimento vai resolver; enquanto não
 *      resolver, fica fora do relatório executivo.
 *
 *  Colunas mantidas:
 *    Código, Descrição, PVP, Jan, Fev, Mar, Abr, Total Unidades, Stock,
 *    Farmácia — suficiente para leitura operacional.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  Report,
  ReportColumn,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";

// Shape das linhas agregadas da página Vendas.
// Mantemos um tipo mínimo — o componente só precisa destes campos.
export type VendasAdapterRow = {
  codigo: string;
  descricao: string;
  pvp: number;
  jan: number;
  fev: number;
  mar: number;
  abr: number;
  totalVendas: number;      // unidades totais (jan+fev+mar+abr)
  existencia: number;
  unidadesVendidas: number; // alias de totalVendas; mantido para retrocompat
  fornecedor: string;
  fabricante: string;
  categoria: string;
  farmacia: string;
  grupo: string;
};

export type VendasAdapterFilters = {
  ambito?: string;
  farmaciasSelecionadas?: string[];
  fornecedoresSelecionados?: string[];
  fabricantesSelecionados?: string[];
  categoriasSelecionadas?: string[];
  artigo?: string;
  dataInicio?: string;
  dataFim?: string;
  agruparPor?: string;
  ordenarPor?: string;
  apenasComVendas?: boolean;
  apenasComStock?: boolean;
};

/**
 * Larguras em percentagem do total da tabela (landscape A4, ~277mm úteis).
 * Usadas pelo renderer HTML via <colgroup>. Soma = 100%.
 *
 *   Código       7%   Descrição    28%   PVP          7%
 *   Jan          6%   Fev           6%   Mar          6%   Abr          6%
 *   Total Unid.  9%   Stock         7%   Farmácia    18%
 *                                                    = 100%
 */
const VENDAS_COLUMNS: ReportColumn[] = [
  { key: "codigo",      label: "Código",        format: "text",     width: 7 },
  { key: "descricao",   label: "Descrição",     format: "text",     width: 28 },
  { key: "pvp",         label: "PVP",           format: "currency", width: 7 },
  { key: "jan",         label: "Jan",           format: "integer",  width: 6, showTotal: true },
  { key: "fev",         label: "Fev",           format: "integer",  width: 6, showTotal: true },
  { key: "mar",         label: "Mar",           format: "integer",  width: 6, showTotal: true },
  { key: "abr",         label: "Abr",           format: "integer",  width: 6, showTotal: true },
  { key: "totalVendas", label: "Total Unid.",   format: "integer",  width: 9, showTotal: true },
  { key: "existencia",  label: "Stock",         format: "integer",  width: 7 },
  { key: "farmacia",    label: "Farmácia",      format: "text",     width: 18 },
];

function joinList(list: string[] | undefined, total: number, labelTodas: string): string {
  if (!list || list.length === 0) return labelTodas;
  if (list.length === total) return labelTodas;
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} (+${list.length - 3})`;
}

function buildFilters(
  f: VendasAdapterFilters,
  universe: {
    farmacias: string[];
    fornecedores: string[];
    fabricantes: string[];
    categorias: string[];
  }
): ReportFilter[] {
  const out: ReportFilter[] = [];

  if (f.dataInicio && f.dataFim) {
    out.push({ label: "Período", value: `${f.dataInicio} a ${f.dataFim}` });
  }
  if (f.ambito) {
    out.push({ label: "Âmbito", value: f.ambito });
  }
  out.push({
    label: "Farmácias",
    value: joinList(f.farmaciasSelecionadas, universe.farmacias.length, "Todas"),
  });
  if (f.fornecedoresSelecionados && f.fornecedoresSelecionados.length > 0) {
    out.push({
      label: "Fornecedores",
      value: joinList(f.fornecedoresSelecionados, universe.fornecedores.length, "Todos"),
    });
  }
  if (f.fabricantesSelecionados && f.fabricantesSelecionados.length > 0) {
    out.push({
      label: "Fabricantes",
      value: joinList(f.fabricantesSelecionados, universe.fabricantes.length, "Todos"),
    });
  }
  if (f.categoriasSelecionadas && f.categoriasSelecionadas.length > 0) {
    out.push({
      label: "Categorias",
      value: joinList(f.categoriasSelecionadas, universe.categorias.length, "Todas"),
    });
  }
  if (f.artigo && f.artigo.trim()) {
    out.push({ label: "Pesquisa", value: f.artigo.trim() });
  }
  if (f.agruparPor) out.push({ label: "Agrupar por", value: f.agruparPor });
  if (f.ordenarPor) out.push({ label: "Ordenar por", value: f.ordenarPor });
  if (f.apenasComVendas) out.push({ label: "Apenas com vendas", value: "Sim" });
  if (f.apenasComStock)  out.push({ label: "Apenas com stock",  value: "Sim" });

  return out;
}

function buildSummary(rows: VendasAdapterRow[]): ReportSummaryItem[] {
  let totalUnidades = 0;
  let valorEstimadoPvp = 0;
  for (const r of rows) {
    totalUnidades += r.totalVendas ?? 0;
    valorEstimadoPvp += (r.totalVendas ?? 0) * (r.pvp ?? 0);
  }
  const referencias = new Set(rows.map((r) => r.codigo)).size;
  return [
    { label: "Linhas",             value: rows.length,       format: "integer" },
    { label: "Referências únicas", value: referencias,       format: "integer" },
    { label: "Unidades vendidas",  value: totalUnidades,     format: "integer" },
    { label: "Valor PVP estimado", value: valorEstimadoPvp,  format: "currency" },
  ];
}

export function buildVendasReport(input: {
  rows: VendasAdapterRow[];
  filters: VendasAdapterFilters;
  universe: {
    farmacias: string[];
    fornecedores: string[];
    fabricantes: string[];
    categorias: string[];
  };
  /**
   * Texto do cabeçalho (nome da farmácia + ANF quando há só uma,
   * ou descrição do grupo quando há várias). Vindo de
   * lib/farmacias-header.ts → formatFarmaciaHeader(), nunca hardcoded.
   */
  organization: string;
}): Report {
  const rowsForReport: ReportRow[] = input.rows.map((r) => ({
    codigo: r.codigo,
    descricao: r.descricao,
    pvp: r.pvp,
    jan: r.jan,
    fev: r.fev,
    mar: r.mar,
    abr: r.abr,
    totalVendas: r.totalVendas,
    existencia: r.existencia,
    farmacia: r.farmacia,
  }));

  const subtitle =
    input.filters.dataInicio && input.filters.dataFim
      ? `Período ${input.filters.dataInicio} a ${input.filters.dataFim}`
      : undefined;

  return {
    title: "Relatório de Vendas",
    subtitle,
    generatedAt: new Date(),
    filtersApplied: buildFilters(input.filters, input.universe),
    summary: buildSummary(input.rows),
    columns: VENDAS_COLUMNS,
    rows: rowsForReport,
    meta: {
      slug: "vendas",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Uso interno",
    },
  };
}
