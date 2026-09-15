"use server";

import { getEncomendasData } from "@/lib/encomendas-data";
import { requirePermission, canAccessFarmaciaSync } from "@/lib/permissions";
import {
  getHistoricoProduto12Meses,
  type HistoricoProduto12MesesResult,
} from "@/lib/encomendas/historico-produto";

export async function runEncomendasReport() {
  return getEncomendasData();
}

// ─── Histórico de 12 meses por produto (lazy, por linha) ──────────────────────

export type GetHistoricoProdutoResult =
  | { ok: true; data: HistoricoProduto12MesesResult }
  | { ok: false; error: string };

/**
 * Histórico de 12 meses (compras/vendas líquidas, stock, média) de UM
 * produto — chamado só quando o utilizador pede o histórico de UMA
 * linha da encomenda (nunca em massa, nunca ao gerar a proposta). Ver
 * `lib/encomendas/historico-produto.ts`.
 *
 * Mesmo padrão de auth das outras acções de encomendas
 * (`app/encomendas/nova/actions.ts` / `app/encomendas/[id]/actions.ts`):
 * `requirePermission("reports.write")` + `canAccessFarmaciaSync` por
 * farmácia pedida — um GESTOR_FARMACIA/OPERADOR só vê a sua própria
 * farmácia mesmo que a UI (ou um pedido forjado) peça outras.
 */
export async function getHistoricoProdutoAction(input: {
  produtoId: string;
  farmaciaIds: string[];
}): Promise<GetHistoricoProdutoResult> {
  const session = await requirePermission("reports.write");

  if (!input.produtoId) return { ok: false, error: "Produto em falta." };

  const farmaciaIdsPermitidos = [...new Set(input.farmaciaIds)].filter((id) =>
    canAccessFarmaciaSync(session, id)
  );
  if (farmaciaIdsPermitidos.length === 0) {
    return { ok: false, error: "Sem acesso a nenhuma das farmácias pedidas." };
  }

  try {
    const data = await getHistoricoProduto12Meses({
      produtoId: input.produtoId,
      farmaciaIds: farmaciaIdsPermitidos,
    });
    if (!data) return { ok: false, error: "Produto não encontrado." };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
