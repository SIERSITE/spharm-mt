/**
 * app/api/admin/pipeline/aggregate-month/route.ts
 *
 * POST /api/admin/pipeline/aggregate-month
 *
 * Trigger server-side de `aggregateMonth()` (lib/aggregate/vendamensal.ts).
 * Chamado pelo agent on-prem (Windows Task Scheduler) no fim do
 * daily-pipeline. Reusa o core que a CLI `aggregate:vendamensal`
 * também usa — idempotente, sem perda de paridade.
 *
 * Auth: withIntegrationAuth (mesma key que /api/ingest/v1/*).
 * Feature flag: ENABLE_AGENT_BOOTSTRAP (igual ao bootstrap; o
 * pipeline é o passo seguinte do mesmo fluxo agente).
 *
 * Body:
 *   {
 *     month: "YYYY-MM",
 *     write?: boolean,         // default true (idempotente)
 *     allowOrphans?: boolean,  // default false
 *     allowNegativeTotals?: boolean,  // default false
 *   }
 *
 * Response (sucesso):
 *   {
 *     ok: true,
 *     pipelineRunId: string,
 *     preflight: PreflightStats,
 *     totals: { ... },
 *     rowsInserted: number,
 *     rowsDeleted: number,
 *     durationMs: number
 *   }
 *
 * Response (abort):
 *   { ok: false, error: "abort", code: "...", message: "...", details: {...} }
 *
 * Cada chamada cria UMA row em `PipelineRun` com kind="aggregate-month",
 * status final OK/ERROR/ABORTED. Não cobre o orquestrador completo —
 * o agent grava o `daily-pipeline` separadamente via /pipeline/record.
 */

import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import {
  AggregateAbortError,
  aggregateMonth,
  parseMonth,
} from "@/lib/aggregate/vendamensal";
import { assertBootstrapEnabled } from "@/lib/ingest/bootstrap";
import { PIPELINE_KIND, PIPELINE_STATUS } from "@/lib/pipeline/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();
  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

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

  const monthArg = typeof obj.month === "string" ? obj.month : "";
  if (!monthArg) {
    return NextResponse.json({ ok: false, error: "missing_month" }, { status: 400 });
  }
  let range;
  try {
    range = parseMonth(monthArg);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "invalid_month", message: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }

  const write = obj.write !== false; // default true
  const allowOrphans = obj.allowOrphans === true;
  const allowNegativeTotals = obj.allowNegativeTotals === true;

  // Resolve farmaciaId — quando o tenant tem só uma farmácia activa,
  // a row PipelineRun fica associada a ela. Aggregate cobre todas as
  // farmácias do tenant (que é o comportamento da CLI hoje), por isso
  // farmaciaId é só metadata da run.
  const farmacias = await ctx.prisma.farmacia.findMany({
    where: { estado: "ATIVO" },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  if (farmacias.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_active_farmacia", message: "Tenant sem farmácias activas." },
      { status: 409 }
    );
  }
  const farmaciaIdForRun = farmacias[0].id;

  console.log(
    `[pipeline/aggregate-month] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      month: monthArg,
      write,
      allowOrphans,
      allowNegativeTotals,
    })}`
  );

  const startedAt = new Date();
  let outcome;
  try {
    outcome = await aggregateMonth(ctx.prisma, {
      range,
      write,
      allowOrphans,
      allowNegativeTotals,
    });
  } catch (err) {
    if (err instanceof AggregateAbortError) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const run = await ctx.prisma.pipelineRun.create({
        data: {
          farmaciaId: farmaciaIdForRun,
          kind: PIPELINE_KIND.AGGREGATE,
          status: PIPELINE_STATUS.ABORTED,
          startedAt,
          finishedAt,
          durationMs,
          dateRef: monthArg,
          errorMessage: err.message,
          triggeredBy: "agent",
          details: {
            ano: range.ano,
            mes: range.mes,
            abortCode: err.code,
            abortDetails: err.details,
          } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      console.warn(
        `[pipeline/aggregate-month] abort ${JSON.stringify({
          tenant: ctx.tenant.slug,
          code: err.code,
          details: err.details,
          pipelineRunId: run.id,
        })}`
      );
      return NextResponse.json(
        {
          ok: false,
          error: "abort",
          code: err.code,
          message: err.message,
          details: err.details,
          pipelineRunId: run.id,
        },
        { status: 409 }
      );
    }
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const msg = err instanceof Error ? err.message : String(err);
    const run = await ctx.prisma.pipelineRun.create({
      data: {
        farmaciaId: farmaciaIdForRun,
        kind: PIPELINE_KIND.AGGREGATE,
        status: PIPELINE_STATUS.ERROR,
        startedAt,
        finishedAt,
        durationMs,
        dateRef: monthArg,
        errorMessage: msg.slice(0, 1000),
        triggeredBy: "agent",
        details: { ano: range.ano, mes: range.mes } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    console.error(
      `[pipeline/aggregate-month] error ${JSON.stringify({ tenant: ctx.tenant.slug, msg, pipelineRunId: run.id })}`
    );
    return NextResponse.json(
      { ok: false, error: "internal", message: msg, pipelineRunId: run.id },
      { status: 500 }
    );
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const run = await ctx.prisma.pipelineRun.create({
    data: {
      farmaciaId: farmaciaIdForRun,
      kind: PIPELINE_KIND.AGGREGATE,
      status: PIPELINE_STATUS.OK,
      startedAt,
      finishedAt,
      durationMs,
      dateRef: monthArg,
      triggeredBy: "agent",
      details: {
        ano: range.ano,
        mes: range.mes,
        rawLines: outcome.preflight.rawLines,
        produtosDistinct: outcome.preflight.produtosDistinct,
        atendimentosDistinct: outcome.preflight.atendimentosDistinct,
        byClass: outcome.preflight.byClass,
        unknowns: outcome.preflight.unknowns,
        nonStockServices: outcome.preflight.nonStockServices,
        operationalOrphans: outcome.preflight.operationalOrphans,
        rowsInserted: outcome.inserted,
        rowsDeleted: outcome.deleted,
        valorBrutoSum: outcome.totals.valorBruto,
        quantidadeLiquidaSum: outcome.totals.quantidadeLiquida,
        linhasVendaSum: outcome.totals.linhasVenda,
        atendimentosSum: outcome.totals.atendimentos,
        write,
        allowOrphans,
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  const httpDurationMs = Date.now() - t0;
  console.log(
    `[pipeline/aggregate-month] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      pipelineRunId: run.id,
      inserted: outcome.inserted,
      deleted: outcome.deleted,
      valorBruto: outcome.totals.valorBruto,
      durationMs,
      httpDurationMs,
    })}`
  );

  return NextResponse.json({
    ok: true,
    pipelineRunId: run.id,
    preflight: outcome.preflight,
    totals: outcome.totals,
    rowsInserted: outcome.inserted,
    rowsDeleted: outcome.deleted,
    rowCount: outcome.aggRows.length,
    durationMs,
  });
});
