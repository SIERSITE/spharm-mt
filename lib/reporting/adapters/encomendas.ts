/**
 * lib/reporting/adapters/encomendas.ts
 *
 * Relatório consolidado da proposta de encomenda agregada por produto
 * (GroupEncomendaRow — uma linha por CNP com stock, sugestão e valor
 * somados entre farmácias do grupo).
 *
 * Limitações conhecidas (documentadas abaixo no resumo do entregável):
 *   - A página Encomendas tem 3 vistas aninhadas (movimentos 6M,
 *     últimas compras, condições de fornecedor) que não cabem num
 *     formato tabular plano. O relatório actual exporta SÓ a vista
 *     agregada por produto. Anexos detalhados por produto ficam para
 *     uma fase posterior, quando o modelo Report suportar secções
 *     hierárquicas.
 */

import type {
  Report,
  ReportColumn,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";

export type EncomendasAdapterRow = {
  cnp: string;
  produto: string;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  stockGrupo: number;
  sugestaoGrupo: number;
  encomendarGrupo: number;
  valorEstimado: number;
  prioridade: string;
};

export type EncomendasAdapterFilters = {
  farmaciasSelecionadas?: string[];
  fornecedoresSelecionados?: string[];
  fabricantesSelecionados?: string[];
  categoriasSelecionadas?: string[];
  periodoAnalise?: number;
  coberturaAlvoDias?: number;
  apenasComSugestao?: boolean;
  apenasCriticos?: boolean;
};

const ENCOMENDAS_COLUMNS: ReportColumn[] = [
  { key: "cnp",             label: "CNP",             format: "text",     width: 12 },
  { key: "produto",         label: "Produto",         format: "text",     width: 40 },
  { key: "fornecedor",      label: "Fornecedor",      format: "text",     width: 22 },
  { key: "fabricante",      label: "Fabricante",      format: "text",     width: 20 },
  { key: "categoria",       label: "Categoria",       format: "text",     width: 20 },
  { key: "stockGrupo",      label: "Stock Grupo",     format: "integer",  width: 12 },
  { key: "sugestaoGrupo",   label: "Sugestão",        format: "integer",  width: 12, showTotal: true },
  { key: "encomendarGrupo", label: "A Encomendar",    format: "integer",  width: 14, showTotal: true },
  { key: "valorEstimado",   label: "Valor Estimado",  format: "currency", width: 14, showTotal: true },
  { key: "prioridade",      label: "Prioridade",      format: "text",     width: 12 },
];

function joinList(list: string[] | undefined, total: number, labelTodas = "Todas"): string {
  if (!list || list.length === 0) return labelTodas;
  if (list.length === total) return labelTodas;
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} (+${list.length - 3})`;
}

function buildFilters(
  f: EncomendasAdapterFilters,
  universe: {
    farmacias: string[];
    fornecedores: string[];
    fabricantes: string[];
    categorias: string[];
  }
): ReportFilter[] {
  const out: ReportFilter[] = [];
  if (f.periodoAnalise) {
    out.push({ label: "Período análise", value: `${f.periodoAnalise} dias` });
  }
  if (f.coberturaAlvoDias) {
    out.push({ label: "Cobertura alvo", value: `${f.coberturaAlvoDias} dias` });
  }
  out.push({
    label: "Farmácias",
    value: joinList(f.farmaciasSelecionadas, universe.farmacias.length),
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
      value: joinList(f.categoriasSelecionadas, universe.categorias.length),
    });
  }
  if (f.apenasComSugestao) out.push({ label: "Apenas com sugestão", value: "Sim" });
  if (f.apenasCriticos)    out.push({ label: "Apenas críticos",     value: "Sim" });
  return out;
}

function buildSummary(rows: EncomendasAdapterRow[]): ReportSummaryItem[] {
  const referencias = rows.length;
  const fornecedores = new Set(rows.map((r) => r.fornecedor)).size;
  const totalSugestao = rows.reduce((s, r) => s + (r.sugestaoGrupo ?? 0), 0);
  const totalEncomendar = rows.reduce((s, r) => s + (r.encomendarGrupo ?? 0), 0);
  const totalValor = rows.reduce((s, r) => s + (r.valorEstimado ?? 0), 0);
  const criticos = rows.filter((r) => r.prioridade === "Crítica").length;
  return [
    { label: "Referências",   value: referencias,     format: "integer" },
    { label: "Fornecedores",  value: fornecedores,    format: "integer" },
    { label: "Críticos",      value: criticos,        format: "integer" },
    { label: "Sugestão",      value: totalSugestao,   format: "integer" },
    { label: "A Encomendar",  value: totalEncomendar, format: "integer" },
    { label: "Valor Estimado", value: totalValor,     format: "currency" },
  ];
}

export function buildEncomendasReport(input: {
  rows: EncomendasAdapterRow[];
  filters: EncomendasAdapterFilters;
  universe: {
    farmacias: string[];
    fornecedores: string[];
    fabricantes: string[];
    categorias: string[];
  };
  organization: string;
}): Report {
  return {
    title: "Proposta de Encomenda — Consolidado",
    subtitle: "Agregação por produto, necessidade do grupo",
    generatedAt: new Date(),
    filtersApplied: buildFilters(input.filters, input.universe),
    summary: buildSummary(input.rows),
    columns: ENCOMENDAS_COLUMNS,
    rows: input.rows.map((r) => ({ ...r })) as ReportRow[],
    meta: {
      slug: "encomendas",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Uso interno",
    },
  };
}
