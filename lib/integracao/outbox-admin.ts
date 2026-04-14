import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Helpers partilhados de administração do outbox.
 *
 * Mesmos helpers são consumidos por dois entry points:
 *   · API route ingest-auth'd    → o agent CLI pode invocar
 *   · Server actions session-auth'd → a admin UI web invoca
 *
 * A lógica de transição vive só aqui. As diferenças ficam no
 * auth/acesso: o API route usa a key do tenant, as server actions
 * usam a sessão do utilizador com `users.manage` / `settings.global`.
 */

export type AdminActionResult =
  | { ok: true; state: string }
  | { ok: false; error: string; code: "not_found" | "invalid_state" };

/**
 * Manual retry a partir de FALHADO. Reset: attemptCount=0, state=PENDENTE,
 * nextAttemptAt=now, error limpo. Regista audit MANUAL_RETRY.
 */
export async function retryOutboxRow(
  prisma: PrismaClient,
  outboxId: string,
  actorId: string | null
): Promise<AdminActionResult> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.orderOutbox.findUnique({ where: { id: outboxId } });
    if (!row) return { ok: false, error: "outbox row not found", code: "not_found" } as const;
    if (row.state !== "FALHADO") {
      return {
        ok: false,
        error: `state é ${row.state}, retry só permitido a partir de FALHADO`,
        code: "invalid_state",
      } as const;
    }

    await tx.orderOutbox.update({
      where: { id: outboxId },
      data: {
        state: "PENDENTE",
        attemptCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        leasedBy: null,
        leasedUntil: null,
      },
    });
    await tx.listaEncomenda.update({
      where: { id: row.listaEncomendaId },
      data: { estadoExport: "PENDENTE" },
    });
    await tx.orderExportAudit.create({
      data: {
        outboxId,
        attempt: 0,
        status: "MANUAL_RETRY",
        actorId,
      },
    });
    return { ok: true, state: "PENDENTE" } as const;
  });
}

/**
 * Manual cancel. Permitido a partir de PENDENTE ou FALHADO — nunca
 * a partir de EM_EXPORTACAO (para não racejar com o agent em pleno
 * INSERT) nem a partir de EXPORTADO/CANCELADO (terminais).
 */
export async function cancelOutboxRow(
  prisma: PrismaClient,
  outboxId: string,
  actorId: string | null,
  reason: string | null
): Promise<AdminActionResult> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.orderOutbox.findUnique({ where: { id: outboxId } });
    if (!row) return { ok: false, error: "not found", code: "not_found" } as const;
    if (row.state !== "PENDENTE" && row.state !== "FALHADO") {
      return {
        ok: false,
        error: `state é ${row.state}, cancel só permitido a partir de PENDENTE ou FALHADO`,
        code: "invalid_state",
      } as const;
    }

    await tx.orderOutbox.update({
      where: { id: outboxId },
      data: {
        state: "CANCELADO",
        leasedBy: null,
        leasedUntil: null,
      },
    });
    await tx.listaEncomenda.update({
      where: { id: row.listaEncomendaId },
      data: { estadoExport: "CANCELADO" },
    });
    await tx.orderExportAudit.create({
      data: {
        outboxId,
        attempt: row.attemptCount,
        status: "MANUAL_CANCEL",
        message: reason ?? null,
        actorId,
      },
    });
    return { ok: true, state: "CANCELADO" } as const;
  });
}
