import { NextResponse, type NextRequest } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";

/**
 * POST /api/outbox/v1/orders/{outboxId}/release
 *
 * Liberta voluntariamente a lease. Usado quando o agent está a sair
 * em shutdown limpo e quer devolver a row à fila imediatamente em vez
 * de esperar pelo TTL de 5 min. A row volta a PENDENTE com
 * nextAttemptAt = now.
 *
 * Só aceita se state == EM_EXPORTACAO.
 */
type RouteCtx = { params: Promise<{ outboxId: string }> };

export const POST = withIntegrationAuth<RouteCtx>(async (ctx, req, routeCtx) => {
  const { outboxId } = await routeCtx.params;

  const result = await ctx.prisma.$transaction(async (tx) => {
    const row = await tx.orderOutbox.findUnique({ where: { id: outboxId } });
    if (!row) return { notFound: true as const };
    if (row.state !== "EM_EXPORTACAO") {
      return { invalidState: row.state };
    }
    await tx.orderOutbox.update({
      where: { id: outboxId },
      data: {
        state: "PENDENTE",
        leasedBy: null,
        leasedUntil: null,
        nextAttemptAt: new Date(),
      },
    });
    await tx.orderExportAudit.create({
      data: {
        outboxId,
        attempt: row.attemptCount,
        status: "LEASE_RELEASED",
      },
    });
    return { ok: true as const };
  });

  if ("notFound" in result) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if ("invalidState" in result) {
    return NextResponse.json(
      { error: "invalid_state", message: `row está em ${result.invalidState}` },
      { status: 409 }
    );
  }
  return NextResponse.json(result);
});
