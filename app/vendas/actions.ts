"use server";

/**
 * app/vendas/actions.ts
 *
 * Server Actions usadas pela página Vendas. A página inicial NÃO chama
 * `getVendasData` — só corre o fetch quando o utilizador clica em
 * "Gerar". Tudo o que envolve IO de Vendas passa por aqui.
 *
 * Razão: ao abrir a página estávamos a carregar ~20k linhas do universo
 * VendaMensal, mesmo sem o utilizador ter pedido. Esta action é o
 * trigger explícito que substitui o eager load.
 */

import { getVendasData, type VendasFilters, type SalesReportRow } from "@/lib/vendas-data";

export async function runVendasReport(
  filters: VendasFilters
): Promise<SalesReportRow[]> {
  return getVendasData(filters);
}
