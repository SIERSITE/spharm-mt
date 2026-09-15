import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { withIntegrationAuthParams } from "@/lib/integracao/auth";
import { podeReceberAckOuFail, parseSyncResultado } from "@/lib/sync-request/estado";
import { PIPELINE_KIND, PIPELINE_STATUS, type SyncNowDetails } from "@/lib/pipeline/types";

/**
 * POST /api/outbox/v1/sync-requests/{syncRequestId}/ack
 *
 * Body: { resultado: { stockAtualizado, produtosAtualizados, fabricantesAlterados } }
 *
 * Transita EM_CURSO → CONCLUIDO. Só aceita se a row estiver em
 * EM_CURSO (defesa contra races e contra um ack tardio de um pedido já
 * expirado/reaproveitado — mesmo padrão de `/orders/{id}/ack`).
 *
 * Reaproveita `PipelineRun` para o registo de execução (ver AGENTS
 * Bloco E, "Auditoria"): grava/upsert por `idempotencyKey` uma row
 * kind="sync-now", status="OK", triggeredBy="operator" — foi um humano
 * que pediu, mesmo a execução sendo do agent. É esta row (ou, na sua
 * ausência, o próprio `SyncRequest.finishedAt`) que alimenta "hora da
 * última sincronização" na UI — ver `lib/sync-request-data.ts`.
 */
type RouteCtx = { params: Promise<{ syncRequestId: string }> };

export const POST = withIntegrationAuthParams<RouteCtx>(async (ctx, req: NextRequest, routeCtx) => {
  const { syncRequestId } = await routeCtx.params;
  let body: { resultado?: unknown };
  try {
    body = (await req.json()) as { resultado?: unknown };
  } catch {
    body = {};
  }
  const resultado = parseSyncResultado(body.resultado);
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
        estado: "CONCLUIDO",
        finishedAt: now,
        resultado: resultado as unknown as Prisma.InputJsonValue,
        erro: null,
      },
    });

    const details: SyncNowDetails = { syncRequestId, ...resultado };
    await tx.pipelineRun.upsert({
      where: { idempotencyKey: `sync-now:${syncRequestId}` },
      create: {
        farmaciaId: row.farmaciaId,
        kind: PIPELINE_KIND.SYNC_NOW,
        status: PIPELINE_STATUS.OK,
        startedAt: row.startedAt ?? row.leasedAt ?? row.requestedAt,
        finishedAt: now,
        durationMs: now.getTime() - (row.startedAt ?? row.leasedAt ?? row.requestedAt).getTime(),
        triggeredBy: "operator",
        idempotencyKey: `sync-now:${syncRequestId}`,
        details: details as unknown as Prisma.InputJsonValue,
      },
      update: {
        status: PIPELINE_STATUS.OK,
        finishedAt: now,
        details: details as unknown as Prisma.InputJsonValue,
      },
    });

    return { ok: true as const, resultado };
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
  return NextResponse.json({ ok: true, resultado: result.resultado });
});
