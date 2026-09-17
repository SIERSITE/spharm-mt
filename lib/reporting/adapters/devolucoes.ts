/**
 * lib/reporting/adapters/devolucoes.ts
 *
 * Converte as linhas da página Devoluções para o formato Report comum.
 * Tal como o adapter de Vendas, este é o único ponto onde a estrutura
 * concreta da página toca a camada de reporting.
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

// Shape alinhado com lib/devolucoes-data.ts. Campos derivados de origens
// não fiáveis (stock no momento da devolução, validade, observações
// auto-geradas) foram removidos: a tabela Devolucao não os garante e
// não os queremos hardcoded — coerência com a passagem de Vendas.
export type DevolucoesAdapterRow = {
  data: string;        // yyyy-mm-dd
  cnp: string;
  produto: string;
  farmacia: string;
  fornecedor: string;  // fornecedorDestino (grossista)
  fabricante: string;  // canónico (Produto.fabricante)
  categoria: string;
  quantidade: number;
  valor: number;
  motivo: string;
};

export type DevolucoesAdapterFilters = {
  search?: string;
  selectedPharmacies?: string[];
  selectedSuppliers?: string[];
  selectedManufacturers?: string[];
  selectedCategories?: string[];
  dateFrom?: string;
  dateTo?: string;
};

// Larguras editoriais — normalizadas para 100 (ver column-widths.ts) para
// sobrar espaço à coluna "Motivo" acrescentada na uniformização (2026-09,
// ver nota abaixo).
const DEVOLUCOES_BASE_WIDTHS = {
  data: 9, fornecedor: 13, cnp: 8, produto: 21, fabricante: 11,
  categoria: 11, farmacia: 11, quantidade: 4, valor: 4, motivo: 8,
};
const DW = normalizarLargura(DEVOLUCOES_BASE_WIDTHS);

const DEVOLUCOES_COLUMNS: ReportColumn[] = [
  { key: "data",       label: "Data",        format: "text",     width: DW.data },
  { key: "fornecedor", label: "Fornecedor",  format: "text",     width: DW.fornecedor },
  { key: "cnp",        label: "CNP",         format: "text",     width: DW.cnp },
  { key: "produto",    label: "Produto",     format: "text",     width: DW.produto },
  { key: "fabricante", label: "Fabricante",  format: "text",     width: DW.fabricante },
  { key: "categoria",  label: "Categoria",   format: "text",     width: DW.categoria },
  {
    key: "farmacia",   label: "Farmácia",    format: "text",     width: DW.farmacia,
    displayKey: "farmaciaCurta",
  },
  { key: "quantidade", label: "Qtd.",        format: "integer",  width: DW.quantidade, showTotal: true },
  { key: "valor",      label: "Valor",       format: "currency", width: DW.valor, showTotal: true },
  // Correcção (2026-09, uniformização): `DevolucoesAdapterRow.motivo` já
  // existia — populado de `Devolucao.motivo` (lib/devolucoes-data.ts) e
  // passado pelo client — mas nenhuma coluna o desenhava. Mesmo defeito
  // já corrigido em Vendas (`custoUnitarioEstimado`, 2026-09): um campo
  // declarado no tipo e alimentado com dados reais, silenciosamente
  // invisível.
  { key: "motivo",     label: "Motivo",      format: "text",     width: DW.motivo },
];

function joinList(list: string[] | undefined, total: number, labelTodas = "Todas"): string {
  if (!list || list.length === 0) return labelTodas;
  if (list.length === total) return labelTodas;
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} (+${list.length - 3})`;
}

function buildFilters(
  f: DevolucoesAdapterFilters,
  universe: {
    pharmacies: string[];
    suppliers: string[];
    manufacturers: string[];
    categories: string[];
  }
): ReportFilter[] {
  const out: ReportFilter[] = [];
  if (f.dateFrom || f.dateTo) {
    out.push({ label: "Período", value: `${f.dateFrom || "—"} a ${f.dateTo || "—"}` });
  }
  out.push({
    label: "Farmácias",
    value: joinList(f.selectedPharmacies, universe.pharmacies.length),
  });
  if (f.selectedSuppliers && f.selectedSuppliers.length > 0) {
    out.push({
      label: "Fornecedores",
      value: joinList(f.selectedSuppliers, universe.suppliers.length, "Todos"),
    });
  }
  if (f.selectedManufacturers && f.selectedManufacturers.length > 0) {
    out.push({
      label: "Fabricantes",
      value: joinList(f.selectedManufacturers, universe.manufacturers.length, "Todos"),
    });
  }
  if (f.selectedCategories && f.selectedCategories.length > 0) {
    out.push({
      label: "Categorias",
      value: joinList(f.selectedCategories, universe.categories.length),
    });
  }
  if (f.search && f.search.trim()) {
    out.push({ label: "Pesquisa", value: f.search.trim() });
  }
  return out;
}

function buildSummary(rows: DevolucoesAdapterRow[]): ReportSummaryItem[] {
  const suppliers = new Set(rows.map((r) => r.fornecedor).filter(Boolean));
  const totalQty = rows.reduce((s, r) => s + (r.quantidade ?? 0), 0);
  const totalValue = rows.reduce((s, r) => s + (r.valor ?? 0), 0);
  return [
    { label: "Linhas",         value: rows.length,    format: "integer" },
    { label: "Fornecedores",   value: suppliers.size, format: "integer" },
    { label: "Unidades",       value: totalQty,       format: "integer" },
    { label: "Valor",          value: totalValue,     format: "currency" },
  ];
}

export function buildDevolucoesReport(input: {
  rows: DevolucoesAdapterRow[];
  filters: DevolucoesAdapterFilters;
  universe: {
    pharmacies: string[];
    suppliers: string[];
    manufacturers: string[];
    categories: string[];
  };
  organization: string;
}): Report {
  const subtitle =
    input.filters.dateFrom && input.filters.dateTo
      ? `Período ${input.filters.dateFrom} a ${input.filters.dateTo}`
      : undefined;

  return {
    title: "Relatório de Devoluções",
    subtitle,
    generatedAt: new Date(),
    filtersApplied: buildFilters(input.filters, input.universe),
    summary: buildSummary(input.rows),
    columns: DEVOLUCOES_COLUMNS,
    rows: input.rows.map((r) => ({
      ...r,
      farmaciaCurta: nomeFarmaciaCurto(r.farmacia),
    })) as ReportRow[],
    meta: {
      slug: "devolucoes",
      orientation: "landscape",
      organization: input.organization,
      density: "compact",
      footer: "SPharm.MT · Uso interno",
    },
  };
}
