"use server";

/**
 * Server Action única para Devoluções. A página não pré-carrega
 * Devolucao — só corre via este trigger quando o utilizador clica em
 * "Gerar". Mesmo padrão de app/vendas/actions.ts.
 */

import { getDevolucoesData, type DevolucaoRow } from "@/lib/devolucoes-data";

export async function runDevolucoesReport(args: {
  /** ISO date string yyyy-mm-dd. Se ausente: últimos 90 dias. */
  from?: string;
  to?: string;
  /** Nomes de farmácia a incluir (subset do universo activo). */
  farmaciaNomes?: string[];
}): Promise<DevolucaoRow[]> {
  const period =
    args.from && args.to
      ? { from: new Date(args.from), to: new Date(args.to) }
      : undefined;
  // O filtro por farmaciaNomes é aplicado no cliente após o fetch, igual
  // a como já era — `getDevolucoesData` aceita só o período. Manter o
  // contrato pequeno; alargar quando houver utilidade real.
  void args.farmaciaNomes;
  return getDevolucoesData(period);
}
