"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { LEGACY_TENANT } from "@/lib/auth";
import { finalizeAndQueueOrder } from "@/lib/ingest/orders";
import { logAudit } from "@/lib/audit";

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
    revalidatePath("/encomendas/lista");
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
    revalidatePath("/encomendas/lista");
    revalidatePath("/configuracoes/integracao");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Simula NACK do agent — transita PENDENTE → FALHADO (non-retryable).
 * Para testes manuais.
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
    revalidatePath("/encomendas/lista");
    revalidatePath("/configuracoes/integracao");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
