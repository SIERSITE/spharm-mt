"use server";

import { getEncomendasData } from "@/lib/encomendas-data";
import { requirePermission, canAccessFarmaciaSync } from "@/lib/permissions";
import {
  getHistoricoProduto12Meses,
  getHistoricoProdutosEmLote,
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

// ─── Histórico de 12 meses — LOTE (N produtos de uma vez) ──────────────────────

export type GetHistoricoProdutosLoteResult =
  | { ok: true; data: Record<string, HistoricoProduto12MesesResult> }
  | { ok: false; error: string };

/**
 * A mesma coisa que `getHistoricoProdutoAction`, mas para vários produtos
 * de uma vez — a `order-create-client.tsx` chama isto UMA vez (ou
 * paginado por chunk) para todos os produtos visíveis da proposta, nunca
 * um pedido por linha. Ver `getHistoricoProdutosEmLote`
 * (`lib/encomendas/historico-produto.ts`).
 *
 * MESMA gate de auth de `getHistoricoProdutoAction`:
 * `requirePermission("reports.write")` + `canAccessFarmaciaSync` por
 * farmácia pedida.
 *
 * Devolve um `Record` (não um `Map`) porque isto atravessa a fronteira
 * cliente/servidor de uma server action — o `Map` fica só do lado do
 * loader (ver `getHistoricoProdutosEmLote`); o cliente reconstrói o `Map`
 * a partir de `Object.entries(data)` se precisar.
 */
export async function getHistoricoProdutosLoteAction(input: {
  produtoIds: string[];
  farmaciaIds: string[];
}): Promise<GetHistoricoProdutosLoteResult> {
  const session = await requirePermission("reports.write");

  const produtoIds = [...new Set(input.produtoIds)].filter((id) => id.trim().length > 0);
  if (produtoIds.length === 0) return { ok: false, error: "Sem produtos." };

  const farmaciaIdsPermitidos = [...new Set(input.farmaciaIds)].filter((id) =>
    canAccessFarmaciaSync(session, id)
  );
  if (farmaciaIdsPermitidos.length === 0) {
    return { ok: false, error: "Sem acesso a nenhuma das farmácias pedidas." };
  }

  try {
    const mapa = await getHistoricoProdutosEmLote({
      produtoIds,
      farmaciaIds: farmaciaIdsPermitidos,
    });
    return { ok: true, data: Object.fromEntries(mapa) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
