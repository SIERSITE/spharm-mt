/**
 * app/api/admin/pipeline/record/route.ts
 *
 * POST /api/admin/pipeline/record
 *
 * Recebe um summary de pipeline run do agent on-prem e grava em
 * `PipelineRun` (single-shot — o agent só chama no fim, com o status
 * final). Não é uma máquina de estados — o agent envia uma row
 * completa, e cada chamada é uma INSERT.
 *
 * Auth: withIntegrationAuth (mesma key que /api/ingest/v1/*).
 *
 * Body:
 *   {
 *     farmaciaId: string,
 *     kind: "daily-pipeline" | "daily-sync" | "aggregate-month",
 *     status: "OK" | "ERROR" | "ABORTED",
 *     startedAt: ISO string,
 *     finishedAt: ISO string,
 *     dateRef?: string,             // YYYY-MM-DD ou YYYY-MM
 *     durationMs?: number,
 *     errorMessage?: string,
 *     details?: object,
 *     triggeredBy?: string,
 *   }
 *
 * Response:
 *   { ok: true, pipelineRunId: string }
 */

import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import { assertFarmaciaInTenant } from "@/lib/ingest/bootstrap";
import { isPipelineKind, isPipelineStatus } from "@/lib/pipeline/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function parseIsoOrNull(v: unknown): Date | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const obj = body as Record<string, unknown>;

  const farmaciaId = typeof obj.farmaciaId === "string" ? obj.farmaciaId : "";
  if (!farmaciaId) {
    return NextResponse.json({ ok: false, error: "missing_farmacia_id" }, { status: 400 });
  }
  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  const kind = typeof obj.kind === "string" ? obj.kind : "";
  if (!isPipelineKind(kind)) {
    return NextResponse.json(
      { ok: false, error: "invalid_kind", message: `kind="${kind}" não é suportado.` },
      { status: 400 }
    );
  }

  const status = typeof obj.status === "string" ? obj.status : "";
  // Aceitamos apenas estados FINAIS — o pipeline-record é um single-shot
  // no fim do run. O start não é gravado server-side.
  if (status !== "OK" && status !== "ERROR" && status !== "ABORTED") {
    return NextResponse.json(
      { ok: false, error: "invalid_status", message: `status="${status}" não é OK|ERROR|ABORTED.` },
      { status: 400 }
    );
  }
  if (!isPipelineStatus(status)) {
    return NextResponse.json({ ok: false, error: "invalid_status" }, { status: 400 });
  }

  const startedAt = parseIsoOrNull(obj.startedAt) ?? new Date();
  const finishedAt = parseIsoOrNull(obj.finishedAt) ?? new Date();
  const durationMs =
    typeof obj.durationMs === "number" && Number.isFinite(obj.durationMs)
      ? Math.max(0, Math.trunc(obj.durationMs))
      : Math.max(0, finishedAt.getTime() - startedAt.getTime());

  const dateRef = typeof obj.dateRef === "string" ? obj.dateRef : null;
  const errorMessage = typeof obj.errorMessage === "string" ? obj.errorMessage.slice(0, 1000) : null;
  const triggeredBy = typeof obj.triggeredBy === "string" ? obj.triggeredBy : "agent";
  const detailsRaw = typeof obj.details === "object" && obj.details !== null ? obj.details : {};
  const idempotencyKey =
    typeof obj.idempotencyKey === "string" && obj.idempotencyKey.trim() !== ""
      ? obj.idempotencyKey.trim().slice(0, 200)
      : null;

  // Quando o agent envia `idempotencyKey`, fazemos upsert por essa key —
  // retries da mesma execução não duplicam audit rows. Sem key cai no
  // path antigo (create) para back-compat com agents pré-rev14.
  const data = {
    farmaciaId,
    kind,
    status,
    startedAt,
    finishedAt,
    durationMs,
    dateRef,
    errorMessage,
    triggeredBy,
    idempotencyKey,
    details: detailsRaw as Prisma.InputJsonValue,
  };
  const result = idempotencyKey
    ? await ctx.prisma.pipelineRun.upsert({
        where: { idempotencyKey },
        create: data,
        update: {
          // Em retry: actualizamos o estado final (status/errorMessage/...
          // podem ter mudado entre tentativas). Não tocamos `idempotencyKey`
          // nem `createdAt`.
          status,
          finishedAt,
          durationMs,
          errorMessage,
          details: data.details,
        },
        select: { id: true, createdAt: true, updatedAt: true },
      })
    : await ctx.prisma.pipelineRun.create({
        data,
        select: { id: true, createdAt: true, updatedAt: true },
      });
  const deduped = idempotencyKey
    ? result.updatedAt.getTime() !== result.createdAt.getTime()
    : false;

  console.log(
    `[pipeline/record] ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      kind,
      status,
      dateRef,
      durationMs,
      idempotencyKey,
      deduped,
      pipelineRunId: result.id,
    })}`
  );

  return NextResponse.json({ ok: true, pipelineRunId: result.id, deduped });
});
