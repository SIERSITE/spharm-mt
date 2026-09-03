"use server";

import {
  getExcessosData,
  type ExcessosOptions,
} from "@/lib/transferencias-data";

/**
 * `options.dataInicio`/`dataFim` passaram a ser MESMO usadas.
 *
 * Antes, as duas datas do ecrã viviam só no snapshot de apresentação: a
 * UI mostrava um período e o cálculo usava sempre os últimos 3 meses.
 * O período do cabeçalho do PDF era decorativo.
 */
export async function runExcessosReport(options?: ExcessosOptions) {
  return getExcessosData(options);
}
