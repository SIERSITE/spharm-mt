"use server";

import { revalidatePath } from "next/cache";
import {
  getTransferenciasData,
  type OpcoesOperacionais,
} from "@/lib/transferencias-data";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

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

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Soft-delete de uma `Transferencia` real (Bloco D / botão "Criar
 * transferência"). Ao contrário de `ListaEncomenda`, uma `Transferencia`
 * nunca teve circuito de exportação ao ERP — ver o comentário no modelo
 * em `prisma/schema.prisma` — por isso elimina-se sempre livremente,
 * sem o aviso de dupla confirmação que `deleteListaEncomendaAction`
 * exige para encomendas já exportadas de facto.
 *
 * Mesma gate de permissão que as acções destrutivas equivalentes do
 * módulo de encomendas (`cancelOutboxAction`, `deleteListaEncomendaAction`).
 */
export async function deleteTransferenciaAction(transferenciaId: string): Promise<ActionResult> {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();

  try {
    const transferencia = await prisma.transferencia.findUnique({
      where: { id: transferenciaId },
      select: { id: true, estado: true },
    });
    if (!transferencia) return { ok: false, error: "Transferência não encontrada." };
    if (transferencia.estado === "ELIMINADA") {
      return { ok: false, error: "Esta transferência já foi eliminada." };
    }

    await prisma.transferencia.update({
      where: { id: transferenciaId },
      data: { estado: "ELIMINADA" },
    });

    await logAudit({
      actorId: session.sub,
      action: "transferencia.deleted",
      entity: "Transferencia",
      entityId: transferenciaId,
    });

    revalidatePath("/transferencias");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
