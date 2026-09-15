import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { withIntegrationAuthParams } from "@/lib/integracao/auth";
import { podeReceberAckOuFail, resultadoVazio } from "@/lib/sync-request/estado";
import { PIPELINE_KIND, PIPELINE_STATUS, type SyncNowDetails } from "@/lib/pipeline/types";

/**
 * POST /api/outbox/v1/sync-requests/{syncRequestId}/fail
 *
 * Body: { error: string }
 *
 * Transita EM_CURSO → FALHOU. Ao contrário de `/orders/{id}/nack`, não
 * há re-agendamento: um "Sincronizar agora" que falhe é terminal — o
 * utilizador vê o erro e decide se carrega no botão outra vez (o mutex
 * já permite um novo pedido assim que este deixa de estar activo). Não
 * existe aqui o cenário de exportação para um ERP externo que
 * `computeNextAttemptAt` resolve para as encomendas.
 *
 * Também grava a `PipelineRun` (kind="sync-now", status="ERROR") pela
 * mesma razão do `.../ack` — um registo de execução, mesmo falhado.
 */
type RouteCtx = { params: Promise<{ syncRequestId: string }> };

export const POST = withIntegrationAuthParams<RouteCtx>(async (ctx, req: NextRequest, routeCtx) => {
  const { syncRequestId } = await routeCtx.params;
  let body: { error?: unknown };
  try {
    body = (await req.json()) as { error?: unknown };
  } catch {
    body = {};
  }
  const errorMessage =
    typeof body.error === "string" && body.error.trim() !== ""
      ? body.error.trim().slice(0, 2000)
      : "Falha não especificada pelo agent.";
  const now = new Date();

  const result = await ctx.prisma.$transaction(async (tx) => {
    const row = await tx.syncRequest.findUnique({ where: { id: syncRequestId } });
    if (!row) return { notFound: true as const };
    if (!podeReceberAckOuFail(row.estado)) {
      return { invalidState: row.estado };
    }

    await tx.syncRequest.update({
      where: { id: syncRequestId },
      data: {
        estado: "FALHOU",
        finishedAt: now,
        erro: errorMessage,
      },
    });

    const details: SyncNowDetails = { syncRequestId, ...resultadoVazio() };
    await tx.pipelineRun.upsert({
      where: { idempotencyKey: `sync-now:${syncRequestId}` },
      create: {
        farmaciaId: row.farmaciaId,
        kind: PIPELINE_KIND.SYNC_NOW,
        status: PIPELINE_STATUS.ERROR,
        startedAt: row.startedAt ?? row.leasedAt ?? row.requestedAt,
        finishedAt: now,
        durationMs: now.getTime() - (row.startedAt ?? row.leasedAt ?? row.requestedAt).getTime(),
        errorMessage,
        triggeredBy: "operator",
        idempotencyKey: `sync-now:${syncRequestId}`,
        details: details as unknown as Prisma.InputJsonValue,
      },
      update: {
        status: PIPELINE_STATUS.ERROR,
        finishedAt: now,
        errorMessage,
        details: details as unknown as Prisma.InputJsonValue,
      },
    });

    return { ok: true as const };
  });

  if ("notFound" in result) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if ("invalidState" in result) {
    return NextResponse.json(
      {
        error: "invalid_state",
        message: `sync request está em ${result.invalidState}, não EM_CURSO`,
      },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
});
