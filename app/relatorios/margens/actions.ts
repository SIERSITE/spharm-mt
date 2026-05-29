"use server";

/**
 * app/relatorios/margens/actions.ts
 *
 * Server action única para o relatório de Margens. Devolve as TRÊS
 * vistas + KPIs globais, calculados a partir de UMA agregação SQL
 * sobre VendaMensal × ProdutoFarmacia.
 */
import { getMargensData, type MargensResult } from "@/lib/margens-data";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

export async function runMargensReport(
  filters: SharedReportFilters,
): Promise<MargensResult> {
  return getMargensData(filters);
}
