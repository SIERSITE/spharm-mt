"use server";

/**
 * app/relatorios/inventario/actions.ts
 *
 * Server action única para o relatório de Inventário. A página entra
 * leve (só carrega `filterOptions` + `farmaciasInfo`) e o cliente
 * dispara esta action ao clicar em "Gerar" — mesmo padrão das Vendas.
 *
 * Devolve as DUAS vistas (Por Produto + Por Farmácia) calculadas a
 * partir do mesmo dataset — uma única round-trip à BD.
 */
import { getInventarioData, type InventarioResult } from "@/lib/inventario-data";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

export async function runInventarioReport(
  filters: SharedReportFilters,
): Promise<InventarioResult> {
  return getInventarioData(filters);
}
