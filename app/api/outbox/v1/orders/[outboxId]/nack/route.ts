import { NextResponse, type NextRequest } from "next/server";
import { withIntegrationAuthParams } from "@/lib/integracao/auth";
import { computeNextAttemptAt, MAX_ATTEMPTS } from "@/lib/integracao/outbox-schedule";

/**
 * POST /api/outbox/v1/orders/{outboxId}/nack
 *
 * Body: {
 *   error: string,          // mensagem legível
 *   attempt: number,         // contador reportado pelo agent (log only)
 *   retryable: boolean,      // false = erro de negócio (NAO re-tentar)
 *   sqlError?: string        // optional: mensagem técnica SQL para auditoria
 *   httpStatus?: number
 * }
 *
 * Fluxo:
 *   retryable && attempts < MAX → schedule next attempt, state = PENDENTE
 *   retryable && attempts >= MAX → GAVE_UP, state = FALHADO
 *   !retryable                   → state = FALHADO imediatamente
 *
 * Só aceita se state == EM_EXPORTACAO.
 */
type RouteCtx = { params: Promise<{ outboxId: string }> };

export const POST = withIntegrationAuthParams<RouteCtx>(async (ctx, req, routeCtx) => {
  const { outboxId } = await routeCtx.params;
  const body = (await req.json()) as {
    error?: string;
    attempt?: number;
    retryable?: boolean;
    sqlError?: string;
    httpStatus?: number;
  };
  const errorMessage = (body.error ?? "").toString().slice(0, 4000) || "unspecified";
  const retryable = body.retryable === true;

  const result = await ctx.prisma.$transaction(async (tx) => {
    const row = await tx.orderOutbox.findUnique({ where: { id: outboxId } });
    if (!row) return { notFound: true as const };
    if (row.state !== "EM_EXPORTACAO") {
      return { invalidState: row.state };
    }

    const exhausted = row.attemptCount >= MAX_ATTEMPTS;
    const terminal = !retryable || exhausted;

    if (terminal) {
      await tx.orderOutbox.update({
        where: { id: outboxId },
        data: {
          state: "FALHADO",
          leasedBy: null,
          leasedUntil: null,
          lastError: errorMessage,
        },
      });
      await tx.listaEncomenda.update({
        where: { id: row.listaEncomendaId },
        data: { estadoExport: "FALHADO" },
      });
      await tx.orderExportAudit.create({
        data: {
          outboxId,
          attempt: row.attemptCount,
          status: exhausted ? "GAVE_UP" : "FAILURE",
          message: errorMessage,
          httpStatus: body.httpStatus ?? null,
          spharmSqlError: body.sqlError ?? null,
        },
      });
      return {
        ok: true as const,
        state: "FALHADO" as const,
        attempt: row.attemptCount,
      };
    }

    // Retryable + quota disponível. Reagenda.
    const nextAttemptAt = computeNextAttemptAt(row.attemptCount);
    await tx.orderOutbox.update({
      where: { id: outboxId },
      data: {
        state: "PENDENTE",
        leasedBy: null,
        leasedUntil: null,
        lastError: errorMessage,
        nextAttemptAt: nextAttemptAt ?? new Date(),
      },
    });
    await tx.orderExportAudit.create({
      data: {
        outboxId,
        attempt: row.attemptCount,
        status: "RETRY_SCHEDULED",
        message: errorMessage,
        httpStatus: body.httpStatus ?? null,
        spharmSqlError: body.sqlError ?? null,
      },
    });
    return {
      ok: true as const,
      state: "PENDENTE" as const,
      attempt: row.attemptCount,
      nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
    };
  });

  if ("notFound" in result) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if ("invalidState" in result) {
    return NextResponse.json(
      {
        error: "invalid_state",
        message: `outbox row está em ${result.invalidState}, não EM_EXPORTACAO`,
      },
      { status: 409 }
    );
  }
  return NextResponse.json(result);
});
