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
import { nomeFarmaciaCurto } from "../farmacia-nome";
import { normalizarLargura } from "../column-widths";

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

// Larguras editoriais somavam 254 antes da uniformização (2026-09) —
// transbordava severamente a página impressa (`table-layout:fixed` não
// encolhe colunas cuja soma excede 100%, ver column-widths.ts).
// `normalizarLargura` corrige a soma para 100 preservando as proporções
// relativas escolhidas originalmente (Produto/Observação continuam as
// colunas mais largas, CNP/Prioridade as mais estreitas).
const TRANSFERENCIAS_BASE_WIDTHS = {
  cnp: 12, produto: 36, farmaciaOrigem: 20, farmaciaDestino: 20,
  stockOrigem: 10, stockDestino: 10, coberturaOrigem: 10, coberturaDestino: 10,
  excessoOrigem: 10, necessidadeDestino: 10, quantidadeSugerida: 12,
  prioridade: 12, fornecedor: 18, fabricante: 18, categoria: 18, observacao: 28,
};
const TW = normalizarLargura(TRANSFERENCIAS_BASE_WIDTHS);

const TRANSFERENCIAS_COLUMNS: ReportColumn[] = [
  { key: "cnp",                label: "CNP",            format: "text",    width: TW.cnp },
  { key: "produto",            label: "Produto",        format: "text",    width: TW.produto },
  {
    key: "farmaciaOrigem",     label: "Origem",         format: "text",    width: TW.farmaciaOrigem,
    displayKey: "farmaciaOrigemCurta",
  },
  {
    key: "farmaciaDestino",    label: "Destino",        format: "text",    width: TW.farmaciaDestino,
    displayKey: "farmaciaDestinoCurta",
  },
  { key: "stockOrigem",        label: "Stock Origem",   format: "integer", width: TW.stockOrigem },
  { key: "stockDestino",       label: "Stock Destino",  format: "integer", width: TW.stockDestino },
  { key: "coberturaOrigem",    label: "Cob. Origem",    format: "integer", width: TW.coberturaOrigem },
  { key: "coberturaDestino",   label: "Cob. Destino",   format: "integer", width: TW.coberturaDestino },
  { key: "excessoOrigem",      label: "Excesso",        format: "integer", width: TW.excessoOrigem, showTotal: true },
  { key: "necessidadeDestino", label: "Necessidade",    format: "integer", width: TW.necessidadeDestino, showTotal: true },
  { key: "quantidadeSugerida", label: "Qtd. Sugerida",  format: "integer", width: TW.quantidadeSugerida, showTotal: true },
  { key: "prioridade",         label: "Prioridade",     format: "text",    width: TW.prioridade },
  { key: "fornecedor",         label: "Fornecedor",     format: "text",    width: TW.fornecedor },
  { key: "fabricante",         label: "Fabricante",     format: "text",    width: TW.fabricante },
  { key: "categoria",          label: "Categoria",      format: "text",    width: TW.categoria },
  { key: "observacao",         label: "Observação",     format: "text",    width: TW.observacao },
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
    rows: input.rows.map((r) => ({
      ...r,
      farmaciaOrigemCurta: nomeFarmaciaCurto(r.farmaciaOrigem),
      farmaciaDestinoCurta: nomeFarmaciaCurto(r.farmaciaDestino),
    })) as ReportRow[],
    meta: {
      slug: "transferencias",
      orientation: "landscape",
      organization: input.organization,
      density: "compact",
      footer: "SPharm.MT · Uso interno",
    },
  };
}
