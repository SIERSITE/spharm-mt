/**
 * lib/reporting/adapters/vendas.ts
 *
 * Converte os dados da página Vendas para o formato Report comum.
 * Esta é a ÚNICA peça específica de Vendas na camada de reporting.
 * Toda a lógica de HTML/PDF/Excel/Email vive em lib/reporting/*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FECHO 2026-06: colunas mensais dinâmicas
 *
 *  As colunas Jan/Fev/Mar/Abr fixas foram removidas. O caller passa
 *  `buckets: { ano, mes }[]` — exactamente o mesmo array devolvido pelo
 *  loader em `SalesPeriodHeader.buckets` — e o adapter gera dinamicamente
 *  N colunas com chaves estáveis `m_YYYYMM` e labels "Mmm/YY". Os rows
 *  recebem o mesmo número de campos `m_YYYYMM`.
 *
 *  PVP é o único valor monetário verdadeiramente fiável: vem de
 *  ProdutoFarmacia.pvp. Mantido como currency.
 *
 *  Colunas mantidas:
 *    Código, Descrição, PVP, N × mês (dinâmico), Total Unidades, Stock,
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

const MONTH_LABELS_PT = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

function bucketColumnKey(b: { ano: number; mes: number }): string {
  // Chave estável "m_YYYYMM" — segura como property name e ordenável.
  return `m_${b.ano}${String(b.mes).padStart(2, "0")}`;
}

function bucketColumnLabel(b: { ano: number; mes: number }): string {
  const yy = String(b.ano).slice(-2);
  return `${MONTH_LABELS_PT[b.mes - 1]}/${yy}`;
}

/** Bucket mensal — mesma shape que `SalesMonthBucket` no loader. */
export type VendasAdapterMonthBucket = {
  ano: number;
  mes: number;
  quantidade: number;
};

export type VendasAdapterRow = {
  codigo: string;
  descricao: string;
  pvp: number;
  /** Buckets na mesma ordem que `buckets` passado a `buildVendasReport`. */
  meses: VendasAdapterMonthBucket[];
  totalVendas: number;
  existencia: number;
  /** Alias legado — pode estar ausente, recomputamos a partir de `totalVendas`. */
  unidadesVendidas?: number;
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
  /** ISO yyyy-mm-dd — refletido no subtitle e na lista de filtros. */
  dataInicio?: string;
  dataFim?: string;
  agruparPor?: string;
  ordenarPor?: string;
  apenasComVendas?: boolean;
  apenasComStock?: boolean;
};

/**
 * Larguras-base (sem buckets). As N colunas mensais distribuem o espaço
 * restante uniformemente — calculado em `buildColumns`.
 */
const BASE_WIDTH_FIXED_COLS = {
  codigo: 7,
  descricao: 28,
  pvp: 7,
  totalVendas: 9,
  existencia: 7,
  farmacia: 18,
};

function buildColumns(
  buckets: { ano: number; mes: number }[],
): ReportColumn[] {
  // Espaço total restante para os meses = 100 - somatório das colunas fixas
  const fixedTotal =
    BASE_WIDTH_FIXED_COLS.codigo +
    BASE_WIDTH_FIXED_COLS.descricao +
    BASE_WIDTH_FIXED_COLS.pvp +
    BASE_WIDTH_FIXED_COLS.totalVendas +
    BASE_WIDTH_FIXED_COLS.existencia +
    BASE_WIDTH_FIXED_COLS.farmacia;
  const remaining = Math.max(6, 100 - fixedTotal);
  const perMonth = buckets.length > 0
    ? Math.max(3, Math.floor(remaining / buckets.length))
    : 6;

  const monthColumns: ReportColumn[] = buckets.map((b) => ({
    key: bucketColumnKey(b),
    label: bucketColumnLabel(b),
    format: "integer" as const,
    width: perMonth,
    showTotal: true,
  }));

  return [
    { key: "codigo",      label: "Código",      format: "text",     width: BASE_WIDTH_FIXED_COLS.codigo },
    { key: "descricao",   label: "Descrição",   format: "text",     width: BASE_WIDTH_FIXED_COLS.descricao },
    { key: "pvp",         label: "PVP",         format: "currency", width: BASE_WIDTH_FIXED_COLS.pvp },
    ...monthColumns,
    { key: "totalVendas", label: "Total Unid.", format: "integer",  width: BASE_WIDTH_FIXED_COLS.totalVendas, showTotal: true },
    { key: "existencia",  label: "Stock",       format: "integer",  width: BASE_WIDTH_FIXED_COLS.existencia },
    { key: "farmacia",    label: "Farmácia",    format: "text",     width: BASE_WIDTH_FIXED_COLS.farmacia },
  ];
}

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
      label: "Distribuidores",
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
  /**
   * Mesma lista de buckets devolvida pelo loader em
   * `SalesPeriodHeader.buckets`. Determina (a) as colunas mensais
   * geradas e (b) a ordem dos valores em cada `row.meses`.
   */
  buckets: { ano: number; mes: number }[];
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
  // Mapeia cada row para o formato dinâmico de ReportRow (chaves m_YYYYMM
  // alinhadas com as colunas geradas em `buildColumns`).
  const rowsForReport: ReportRow[] = input.rows.map((r) => {
    const base: ReportRow = {
      codigo: r.codigo,
      descricao: r.descricao,
      pvp: r.pvp,
      totalVendas: r.totalVendas,
      existencia: r.existencia,
      farmacia: r.farmacia,
    };
    // Indexação por posição (segura porque o loader devolve `meses` na
    // mesma ordem de `buckets`); fallback por (ano,mes) match se faltar.
    input.buckets.forEach((b, i) => {
      const fromPos = r.meses[i];
      const matched =
        fromPos && fromPos.ano === b.ano && fromPos.mes === b.mes
          ? fromPos
          : r.meses.find((m) => m.ano === b.ano && m.mes === b.mes);
      base[bucketColumnKey(b)] = matched?.quantidade ?? 0;
    });
    return base;
  });

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
    columns: buildColumns(input.buckets),
    rows: rowsForReport,
    meta: {
      slug: "vendas",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Uso interno",
    },
  };
}
