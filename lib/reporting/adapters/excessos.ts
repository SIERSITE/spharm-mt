/**
 * lib/reporting/adapters/excessos.ts
 *
 * Relatório de excessos de stock por farmácia.
 * A página partilha a mesma estrutura de dados das Transferências
 * (ambas trabalham com TransferSuggestionRow), mas o ângulo editorial
 * é diferente: aqui o foco é o stock em excesso, não a movimentação
 * entre farmácias. Mantemos um adapter separado para que as colunas
 * e os labels divirjam sem conflito se a página evoluir.
 */

import type {
  Report,
  ReportColumn,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";

export type ExcessosAdapterRow = {
  cnp: string;
  produto: string;
  farmaciaOrigem: string;
  farmaciaDestino: string;
  stockOrigem: number;
  stockDestino: number;
  coberturaOrigem: number;
  coberturaDestino: number;
  quantidadeSugerida: number;
  excessoOrigem: number;
  necessidadeDestino: number;
  /** Unidades vendidas nesta farmácia nos 6 meses completos até à data-fim. */
  vendas6M: number;
  /** `vendas6M / 6`, uma casa decimal. */
  mediaMensal6M: number;
  fabricante: string;
  categoria: string;
  fornecedor: string;
  prioridade: string;
  observacao?: string;
};

export type ExcessosAdapterFilters = {
  farmaciasOrigemSelecionadas?: string[];
  farmaciasDestinoSelecionadas?: string[];
  fornecedoresSelecionados?: string[];
  fabricantesSelecionados?: string[];
  categoriasSelecionadas?: string[];
  prioridadesSelecionadas?: string[];
  artigo?: string;
  dataInicio?: string;
  dataFim?: string;
  ordenarPor?: string;
  apenasComNecessidade?: boolean;
  apenasComExcesso?: boolean;
  apenasAltaPrioridade?: boolean;
  quantidadeMinima?: string;
};

// Ordem de leitura: o que a ORIGEM tem e vende, depois o que sobra,
// depois para onde poderia ir. "Vendas 6M" e "Méd./mês" entram logo a
// seguir ao stock porque a pergunta que respondem — isto está parado ou
// só tem stock a mais? — vem antes de qualquer decisão de escoamento.
//
// `Méd./mês` NÃO leva `showTotal`: somar médias mensais de artigos
// diferentes dá um número sem significado. `Vendas 6M` leva, porque a
// soma de unidades vendidas é uma quantidade real.
const EXCESSOS_COLUMNS: ReportColumn[] = [
  { key: "cnp",                label: "CNP",           format: "text",    width: 11 },
  { key: "produto",            label: "Produto",       format: "text",    width: 30 },
  { key: "farmaciaOrigem",     label: "Farmácia",      format: "text",    width: 16 },
  { key: "stockOrigem",        label: "St. O.",        format: "integer", width: 8 },
  { key: "vendas6M",           label: "Vendas 6M",     format: "integer", width: 10, showTotal: true },
  { key: "mediaMensal6M",      label: "Méd./mês",      format: "decimal1", width: 9 },
  { key: "coberturaOrigem",    label: "Cob. O. (d)",   format: "integer", width: 11 },
  { key: "excessoOrigem",      label: "Excesso",       format: "integer", width: 9,  showTotal: true },
  { key: "farmaciaDestino",    label: "Destino poss.", format: "text",    width: 16 },
  { key: "stockDestino",       label: "St. D.",        format: "integer", width: 8 },
  { key: "coberturaDestino",   label: "Cob. D. (d)",   format: "integer", width: 11 },
  { key: "necessidadeDestino", label: "Necess.",       format: "integer", width: 9 },
  { key: "quantidadeSugerida", label: "Sug.",          format: "integer", width: 8,  showTotal: true },
  { key: "prioridade",         label: "Prioridade",    format: "text",    width: 11 },
  { key: "fornecedor",         label: "Fornecedor",    format: "text",    width: 15 },
  { key: "fabricante",         label: "Fabricante",    format: "text",    width: 15 },
  { key: "categoria",          label: "Categoria",     format: "text",    width: 15 },
];

function joinList(list: string[] | undefined, total: number, labelTodas = "Todas"): string {
  if (!list || list.length === 0) return labelTodas;
  if (list.length === total) return labelTodas;
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} (+${list.length - 3})`;
}

function buildFilters(
  f: ExcessosAdapterFilters,
  universe: {
    farmacias: string[];
    fornecedores: string[];
    fabricantes: string[];
    categorias: string[];
    prioridades: string[];
  }
): ReportFilter[] {
  const out: ReportFilter[] = [];
  if (f.dataInicio && f.dataFim) {
    out.push({ label: "Período", value: `${f.dataInicio} a ${f.dataFim}` });
  }
  out.push({
    label: "Farmácias",
    value: joinList(f.farmaciasOrigemSelecionadas, universe.farmacias.length),
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
  if (f.prioridadesSelecionadas && f.prioridadesSelecionadas.length > 0) {
    out.push({
      label: "Prioridades",
      value: joinList(f.prioridadesSelecionadas, universe.prioridades.length),
    });
  }
  if (f.artigo && f.artigo.trim()) {
    out.push({ label: "Pesquisa", value: f.artigo.trim() });
  }
  if (f.ordenarPor) out.push({ label: "Ordenar por", value: f.ordenarPor });
  if (f.apenasComExcesso) out.push({ label: "Apenas com excesso", value: "Sim" });
  if (f.apenasAltaPrioridade) out.push({ label: "Apenas alta prioridade", value: "Sim" });
  if (f.quantidadeMinima && Number(f.quantidadeMinima) > 0) {
    out.push({ label: "Qtd. mínima", value: f.quantidadeMinima });
  }
  return out;
}

function buildSummary(rows: ExcessosAdapterRow[]): ReportSummaryItem[] {
  const totalExcesso = rows.reduce((s, r) => s + (r.excessoOrigem ?? 0), 0);
  const totalSugerido = rows.reduce((s, r) => s + (r.quantidadeSugerida ?? 0), 0);
  const referencias = new Set(rows.map((r) => r.cnp)).size;
  const farmacias = new Set(rows.map((r) => r.farmaciaOrigem)).size;
  return [
    { label: "Linhas",            value: rows.length,     format: "integer" },
    { label: "Referências",       value: referencias,     format: "integer" },
    { label: "Farmácias",         value: farmacias,       format: "integer" },
    { label: "Total em excesso",  value: totalExcesso,    format: "integer" },
    { label: "Unidades a escoar", value: totalSugerido,   format: "integer" },
  ];
}

export function buildExcessosReport(input: {
  rows: ExcessosAdapterRow[];
  filters: ExcessosAdapterFilters;
  universe: {
    farmacias: string[];
    fornecedores: string[];
    fabricantes: string[];
    categorias: string[];
    prioridades: string[];
  };
  organization: string;
}): Report {
  const subtitle =
    input.filters.dataInicio && input.filters.dataFim
      ? `Período ${input.filters.dataInicio} a ${input.filters.dataFim}`
      : "Stock em excesso por farmácia";

  return {
    title: "Relatório de Excessos",
    subtitle,
    generatedAt: new Date(),
    filtersApplied: buildFilters(input.filters, input.universe),
    summary: buildSummary(input.rows),
    columns: EXCESSOS_COLUMNS,
    rows: input.rows.map((r) => ({ ...r })) as ReportRow[],
    meta: {
      slug: "excessos",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Uso interno",
    },
  };
}
