"use server";

import {
  getMovimentosProduto,
  type MovimentoRow,
  type MovimentosFilters,
} from "@/lib/movimentos-data";

export async function runExtratoMovimentos(
  cnp: number,
  filters: MovimentosFilters
): Promise<MovimentoRow[]> {
  return getMovimentosProduto(cnp, filters);
}
