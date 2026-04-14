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

const DEVOLUCOES_COLUMNS: ReportColumn[] = [
  { key: "data",       label: "Data",        format: "text",     width: 9 },
  { key: "fornecedor", label: "Fornecedor",  format: "text",     width: 14 },
  { key: "cnp",        label: "CNP",         format: "text",     width: 9 },
  { key: "produto",    label: "Produto",     format: "text",     width: 24 },
  { key: "fabricante", label: "Fabricante",  format: "text",     width: 12 },
  { key: "categoria",  label: "Categoria",   format: "text",     width: 12 },
  { key: "farmacia",   label: "Farmácia",    format: "text",     width: 12 },
  { key: "quantidade", label: "Qtd.",        format: "integer",  width: 4, showTotal: true },
  { key: "valor",      label: "Valor",       format: "currency", width: 4, showTotal: true },
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
    rows: input.rows.map((r) => ({ ...r })) as ReportRow[],
    meta: {
      slug: "devolucoes",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Uso interno",
    },
  };
}
