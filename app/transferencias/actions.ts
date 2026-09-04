"use server";

import {
  getTransferenciasData,
  type OpcoesOperacionais,
} from "@/lib/transferencias-data";

/**
 * As datas do ecrã passam a chegar ao cálculo.
 *
 * Antes esta acção não recebia nada: a página tinha
 * `useState("2026-04-01")` / `useState("2026-04-10")` — duas datas
 * escritas à mão que nunca saíam do browser — e o servidor calculava
 * sempre sobre os últimos 3 meses. O período no cabeçalho do relatório
 * era decorativo, e não coincidia com o dos Excessos.
 */
export async function runTransferenciasReport(options?: OpcoesOperacionais) {
  return getTransferenciasData(options);
}
