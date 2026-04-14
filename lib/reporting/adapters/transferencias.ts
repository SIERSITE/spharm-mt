/**
 * lib/reporting/adapters/transferencias.ts
 *
 * Converte sugestões de transferência entre farmácias para o formato
 * Report comum.
 */

import type {
  Report,
  ReportColumn,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";

export type TransferenciasAdapterRow = {
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
  fabricante: string;
  categoria: string;
  fornecedor: string;
  prioridade: string;
  observacao?: string;
};

export type TransferenciasAdapterFilters = {
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

const TRANSFERENCIAS_COLUMNS: ReportColumn[] = [
  { key: "cnp",                label: "CNP",            format: "text",    width: 12 },
  { key: "produto",            label: "Produto",        format: "text",    width: 36 },
  { key: "farmaciaOrigem",     label: "Origem",         format: "text",    width: 20 },
  { key: "farmaciaDestino",    label: "Destino",        format: "text",    width: 20 },
  { key: "stockOrigem",        label: "Stock Origem",   format: "integer", width: 10 },
  { key: "stockDestino",       label: "Stock Destino",  format: "integer", width: 10 },
  { key: "coberturaOrigem",    label: "Cob. Origem",    format: "integer", width: 10 },
  { key: "coberturaDestino",   label: "Cob. Destino",   format: "integer", width: 10 },
  { key: "excessoOrigem",      label: "Excesso",        format: "integer", width: 10, showTotal: true },
  { key: "necessidadeDestino", label: "Necessidade",    format: "integer", width: 10, showTotal: true },
  { key: "quantidadeSugerida", label: "Qtd. Sugerida",  format: "integer", width: 12, showTotal: true },
  { key: "prioridade",         label: "Prioridade",     format: "text",    width: 12 },
  { key: "fornecedor",         label: "Fornecedor",     format: "text",    width: 18 },
  { key: "fabricante",         label: "Fabricante",     format: "text",    width: 18 },
  { key: "categoria",          label: "Categoria",      format: "text",    width: 18 },
  { key: "observacao",         label: "Observação",     format: "text",    width: 28 },
];

function joinList(list: string[] | undefined, total: number, labelTodas = "Todas"): string {
  if (!list || list.length === 0) return labelTodas;
  if (list.length === total) return labelTodas;
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} (+${list.length - 3})`;
}

function buildFilters(
  f: TransferenciasAdapterFilters,
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
    label: "Farmácias origem",
    value: joinList(f.farmaciasOrigemSelecionadas, universe.farmacias.length),
  });
  out.push({
    label: "Farmácias destino",
    value: joinList(f.farmaciasDestinoSelecionadas, universe.farmacias.length),
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
  if (f.apenasComNecessidade) out.push({ label: "Apenas com necessidade", value: "Sim" });
  if (f.apenasComExcesso)     out.push({ label: "Apenas com excesso",     value: "Sim" });
  if (f.apenasAltaPrioridade) out.push({ label: "Apenas alta prioridade", value: "Sim" });
  if (f.quantidadeMinima && Number(f.quantidadeMinima) > 0) {
    out.push({ label: "Qtd. mínima", value: f.quantidadeMinima });
  }
  return out;
}

function buildSummary(rows: TransferenciasAdapterRow[]): ReportSummaryItem[] {
  const totalUnid = rows.reduce((s, r) => s + (r.quantidadeSugerida ?? 0), 0);
  const referencias = new Set(rows.map((r) => r.cnp)).size;
  const origens = new Set(rows.map((r) => r.farmaciaOrigem)).size;
  const destinos = new Set(rows.map((r) => r.farmaciaDestino)).size;
  return [
    { label: "Sugestões",          value: rows.length,  format: "integer" },
    { label: "Referências",        value: referencias,  format: "integer" },
    { label: "Unidades a mover",   value: totalUnid,    format: "integer" },
    { label: "Farmácias (O / D)",  value: `${origens} / ${destinos}` },
  ];
}

export function buildTransferenciasReport(input: {
  rows: TransferenciasAdapterRow[];
  filters: TransferenciasAdapterFilters;
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
      : "Sugestões de transferência entre farmácias";

  return {
    title: "Relatório de Transferências",
    subtitle,
    generatedAt: new Date(),
    filtersApplied: buildFilters(input.filters, input.universe),
    summary: buildSummary(input.rows),
    columns: TRANSFERENCIAS_COLUMNS,
    rows: input.rows.map((r) => ({ ...r })) as ReportRow[],
    meta: {
      slug: "transferencias",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Uso interno",
    },
  };
}
