import { NextResponse, type NextRequest } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";

/**
 * POST /api/outbox/v1/orders/{outboxId}/ack
 *
 * Body: { spharmDocumentId: string, attempt: number }
 *
 * Transita EM_EXPORTACAO → EXPORTADO. Também actualiza a
 * ListaEncomenda.estadoExport + estado para EXPORTADA.
 *
 * Só aceita se a row estiver em EM_EXPORTACAO (defensa contra races).
 */
type RouteCtx = { params: Promise<{ outboxId: string }> };

export const POST = withIntegrationAuth<RouteCtx>(async (ctx, req, routeCtx) => {
  const { outboxId } = await routeCtx.params;
  const body = (await req.json()) as {
    spharmDocumentId?: string;
    attempt?: number;
  };

  if (!body.spharmDocumentId || typeof body.spharmDocumentId !== "string") {
    return NextResponse.json(
      { error: "invalid_body", message: "spharmDocumentId required" },
      { status: 400 }
    );
  }

  const now = new Date();
  const updated = await ctx.prisma.$transaction(async (tx) => {
    const row = await tx.orderOutbox.findUnique({ where: { id: outboxId } });
    if (!row) return { notFound: true as const };
    if (row.state !== "EM_EXPORTACAO") {
      return { invalidState: row.state };
    }

    await tx.orderOutbox.update({
      where: { id: outboxId },
      data: {
        state: "EXPORTADO",
        spharmDocumentId: body.spharmDocumentId,
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
        attempt: row.attemptCount,
        status: "SUCCESS",
        message: `spharmDocumentId=${body.spharmDocumentId}`,
      },
    });

    return { ok: true as const, spharmDocumentId: body.spharmDocumentId };
  });

  if ("notFound" in updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if ("invalidState" in updated) {
    return NextResponse.json(
      {
        error: "invalid_state",
        message: `outbox row está em ${updated.invalidState}, não EM_EXPORTACAO`,
      },
      { status: 409 }
    );
  }

  return NextResponse.json(updated);
});
