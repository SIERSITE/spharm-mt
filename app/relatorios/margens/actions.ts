"use server";

/**
 * app/relatorios/margens/actions.ts
 *
 * Server actions do relatório de Margens. `runMargensReport` devolve as
 * vistas + KPIs globais, calculados a partir de UMA agregação SQL sobre
 * VendaMensal × ProdutoFarmacia. `runMargensComparacaoCnpem` reutiliza o
 * MESMO motor para os artigos do mesmo CNPEM (só leitura).
 */
import {
  getMargensComparacaoCnpem,
  getMargensData,
  type ComparacaoCnpem,
  type MargensResult,
} from "@/lib/margens-data";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

export async function runMargensReport(
  filters: SharedReportFilters,
): Promise<MargensResult> {
  return getMargensData(filters);
}

export async function runMargensComparacaoCnpem(
  filters: SharedReportFilters,
  cnp: number,
  mostrarTodos = false,
): Promise<ComparacaoCnpem> {
  return getMargensComparacaoCnpem(filters, Number(cnp), { mostrarTodos: mostrarTodos === true });
}
