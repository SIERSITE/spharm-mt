"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { LEGACY_TENANT } from "@/lib/auth";
import { finalizeAndQueueOrder } from "@/lib/ingest/orders";
import { logAudit } from "@/lib/audit";
import { podeEliminarListaEncomenda } from "@/lib/encomendas/eliminacao";

type ActionResult =
  | { ok: true; outboxId?: string }
  | { ok: false; error: string };

/**
 * Finaliza um rascunho existente — cria o OrderOutbox na mesma transacção.
 */
export async function finalizeOrderAction(listaEncomendaId: string): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  try {
    const result = await finalizeAndQueueOrder(prisma, tenantSlug, listaEncomendaId);
    await logAudit({
      actorId: session.sub,
      action: "order.finalized",
      entity: "ListaEncomenda",
      entityId: listaEncomendaId,
      meta: { outboxId: result.outboxId },
    });
    revalidatePath("/encomendas");
    revalidatePath("/configuracoes/integracao");
    return { ok: true, outboxId: result.outboxId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Simula ACK do agent — transita EM_EXPORTACAO → EXPORTADO.
 * Para testes manuais: primeiro faz a lease (PENDENTE → EM_EXPORTACAO)
 * e depois o ACK, tudo numa transacção.
 */
export async function simulateAckAction(outboxId: string): Promise<ActionResult> {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.orderOutbox.findUnique({ where: { id: outboxId } });
      if (!row) throw new Error("Outbox row não encontrada");

      // Se está PENDENTE, simular a lease primeiro
      if (row.state === "PENDENTE") {
        await tx.orderOutbox.update({
          where: { id: outboxId },
          data: {
            state: "EM_EXPORTACAO",
            attemptCount: row.attemptCount + 1,
            leasedBy: "simulate-ui",
            leasedUntil: new Date(Date.now() + 5 * 60_000),
            lastAttemptAt: new Date(),
          },
        });
        await tx.listaEncomenda.update({
          where: { id: row.listaEncomendaId },
          data: { estadoExport: "EM_EXPORTACAO" },
        });
      } else if (row.state !== "EM_EXPORTACAO") {
        throw new Error(`Estado ${row.state} não permite ACK (esperado PENDENTE ou EM_EXPORTACAO)`);
      }

      const fakeDocId = `SIM-${Date.now()}`;
      const now = new Date();

      await tx.orderOutbox.update({
        where: { id: outboxId },
        data: {
          state: "EXPORTADO",
          spharmDocumentId: fakeDocId,
          exportedAt: now,
          leasedBy: null,
          leasedUntil: null,
          lastError: null,
        },
      });
      await tx.listaEncomenda.update({
        where: { id: row.listaEncomendaId },
        data: { estadoExport: "EXPORTADO", estado: "EXPORTADA" },
      });
      await tx.orderExportAudit.create({
        data: {
          outboxId,
          attempt: row.attemptCount + 1,
          status: "SUCCESS",
          message: `[SIMULADO] spharmDocumentId=${fakeDocId}`,
          actorId: session.sub,
        },
      });

      return { fakeDocId };
    });

    await logAudit({
      actorId: session.sub,
      action: "outbox.simulate_ack",
      entity: "OrderOutbox",
      entityId: outboxId,
    });
    revalidatePath("/encomendas");
    revalidatePath("/configuracoes/integracao");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Simula NACK do agent — transita PENDENTE → FALHADO (non-retryable).
 * Para testes manuais.
 *
 * Nota (2026-09): o bloco "Ferramentas de teste" que expunha esta acção
 * (e `simulateAckAction`) na UI de `/encomendas` foi removido —
 * `components/encomendas/order-list-client.tsx` já não a chama. Ficou
 * órfã DE PROPÓSITO em vez de ser apagada: é útil para testar o fluxo
 * de exportação manualmente (chamada directa em ambiente de
 * desenvolvimento) sem estar ligada a um agent real, e apagá-la
 * arriscava perder essa capacidade sem ganho nenhum — a acção em si
 * nunca foi o problema (já exigia `settings.global`); o problema era o
 * botão estar visível a perfis sem essa permissão (`reports.write`
 * bastava para ver a página) e falhar sem aviso claro ao clicar.
 */
export async function simulateNackAction(outboxId: string): Promise<ActionResult> {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();

  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.orderOutbox.findUnique({ where: { id: outboxId } });
      if (!row) throw new Error("Outbox row não encontrada");

      // Se está PENDENTE, simular a lease primeiro
      if (row.state === "PENDENTE") {
        await tx.orderOutbox.update({
          where: { id: outboxId },
          data: {
            state: "EM_EXPORTACAO",
            attemptCount: row.attemptCount + 1,
            leasedBy: "simulate-ui",
            leasedUntil: new Date(Date.now() + 5 * 60_000),
            lastAttemptAt: new Date(),
          },
        });
      } else if (row.state !== "EM_EXPORTACAO") {
        throw new Error(`Estado ${row.state} não permite NACK (esperado PENDENTE ou EM_EXPORTACAO)`);
      }

      const errorMsg = "[SIMULADO] Falha de exportação simulada via UI";

      await tx.orderOutbox.update({
        where: { id: outboxId },
        data: {
          state: "FALHADO",
          leasedBy: null,
          leasedUntil: null,
          lastError: errorMsg,
        },
      });
      await tx.listaEncomenda.update({
        where: { id: row.listaEncomendaId },
        data: { estadoExport: "FALHADO" },
      });
      await tx.orderExportAudit.create({
        data: {
          outboxId,
          attempt: row.attemptCount + 1,
          status: "FAILURE",
          message: errorMsg,
          actorId: session.sub,
        },
      });
    });

    await logAudit({
      actorId: session.sub,
      action: "outbox.simulate_nack",
      entity: "OrderOutbox",
      entityId: outboxId,
    });
    revalidatePath("/encomendas");
    revalidatePath("/configuracoes/integracao");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

// ─── Eliminar (soft-delete) ──────────────────────────────────────────────────

export type DeleteListaEncomendaResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; requerConfirmacaoExportada: true; aviso: string };

/**
 * Soft-delete de uma `ListaEncomenda` — transita `estado` para
 * `ELIMINADA`. Nunca apaga a row nem as `LinhaEncomenda` (ver o
 * comentário no enum `EstadoListaEncomenda`, em `prisma/schema.prisma`).
 *
 * Duas variantes, decididas por `podeEliminarListaEncomenda`
 * (`lib/encomendas/eliminacao.ts`):
 *
 *   · Ainda não foi exportada de facto (sem `OrderOutbox` em
 *     `EXPORTADO` real — distinto de um ACK simulado) — elimina
 *     directamente, só com a confirmação normal do lado do cliente.
 *
 *   · Já foi exportada de facto — devolve `requerConfirmacaoExportada`
 *     em vez de eliminar. O cliente mostra o aviso e só volta a chamar
 *     esta acção com `confirmarExportadaMesmoAssim: true` depois de o
 *     utilizador confirmar explicitamente esse segundo passo. Mesmo
 *     assim NUNCA desfaz a exportação — só o registo interno no SaaS.
 *
 * Mesma gate de permissão que `cancelOutboxAction`/`retryOutboxAction`
 * (`settings.global`) — a mesma família de acções destrutivas sobre
 * encomendas já finalizadas/exportadas.
 */
export async function deleteListaEncomendaAction(
  listaEncomendaId: string,
  confirmarExportadaMesmoAssim: boolean = false
): Promise<DeleteListaEncomendaResult> {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();

  try {
    const lista = await prisma.listaEncomenda.findUnique({
      where: { id: listaEncomendaId },
      select: {
        id: true,
        estado: true,
        outbox: { select: { state: true, spharmDocumentId: true } },
      },
    });
    if (!lista) return { ok: false, error: "Encomenda não encontrada." };
    if (lista.estado === "ELIMINADA") {
      return { ok: false, error: "Esta encomenda já foi eliminada." };
    }

    const decisao = podeEliminarListaEncomenda(lista.outbox);
    if (!decisao.podeEliminarDirectamente && !confirmarExportadaMesmoAssim) {
      return { ok: false, requerConfirmacaoExportada: true, aviso: decisao.aviso };
    }

    await prisma.listaEncomenda.update({
      where: { id: listaEncomendaId },
      data: { estado: "ELIMINADA" },
    });

    await logAudit({
      actorId: session.sub,
      action: "order.deleted",
      entity: "ListaEncomenda",
      entityId: listaEncomendaId,
      meta: { jaExportadaDeFacto: !decisao.podeEliminarDirectamente },
    });

    revalidatePath("/encomendas");
    revalidatePath(`/encomendas/${listaEncomendaId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
