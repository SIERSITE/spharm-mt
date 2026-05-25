/**
 * app/api/admin/pipeline/aggregate-devolucoes/route.ts
 *
 * POST /api/admin/pipeline/aggregate-devolucoes
 *
 * Thin wrapper sobre `lib/aggregate/devolucoes.ts` (agregação HARDENED
 * set-based + chunk mensal + ON CONFLICT por (farmaciaId, externalLineId) +
 * resolução canónica). quantidade = quantidadeRecebida (só recebida>0).
 *
 * Body: { farmaciaId, from: "YYYY-MM-DD", to: "YYYY-MM-DD", write?: boolean }
 * Auth: withIntegrationAuth. Feature flag: ENABLE_AGENT_BOOTSTRAP.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import { assertBootstrapEnabled, assertFarmaciaInTenant } from "@/lib/ingest/bootstrap";
import { aggregateDevolucoes } from "@/lib/aggregate/devolucoes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function parseDateOnly(s: unknown): Date | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function genBatchId(): string {
  return `agg-devol-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();
  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return NextResponse.json({ ok: false, error: "invalid_json", message: String(err) }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const obj = body as Record<string, unknown>;
  const farmaciaId = typeof obj.farmaciaId === "string" ? obj.farmaciaId : "";
  if (!farmaciaId) return NextResponse.json({ ok: false, error: "missing_farmacia_id" }, { status: 400 });
  const from = parseDateOnly(obj.from);
  const to = parseDateOnly(obj.to);
  if (!from || !to || from.getTime() >= to.getTime()) {
    return NextResponse.json(
      { ok: false, error: "invalid_window", message: "from/to YYYY-MM-DD; from < to." },
      { status: 400 },
    );
  }
  const write = obj.write === true;
  const batchId = write ? genBatchId() : null;

  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[pipeline/aggregate-devolucoes] start ${JSON.stringify({ tenant: ctx.tenant.slug, farmaciaId, from: toIsoDay(from), to: toIsoDay(to), write, batchId })}`,
  );

  try {
    const r = await aggregateDevolucoes(ctx.prisma, { farmaciaId, from, to, write, batchId });
    const durationMs = Date.now() - t0;
    console.log(
      `[pipeline/aggregate-devolucoes] done ${JSON.stringify({ tenant: ctx.tenant.slug, farmaciaId, write, rawLinesRead: r.rawLinesRead, candidateLines: r.candidateLines, created: r.created, updated: r.updated, chunks: r.chunks, durationMs })}`,
    );
    return NextResponse.json({
      ok: true,
      dryRun: !write,
      aggregationBatchId: batchId,
      window: { from: toIsoDay(from), to: toIsoDay(to) },
      quantityField: r.quantityField,
      rawLinesRead: r.rawLinesRead,
      excludedLineCount: { total: r.excludedByRecebida, byEstado: r.estadoDistribution },
      candidateLines: r.candidateLines,
      orphanProducts: r.orphanProducts,
      orphanFornecedores: r.orphanFornecedores,
      projectedValor: r.projectedValor,
      projectedQuantidade: r.projectedQuantidadeRecebida,
      projectedQuantidadeRecebida: r.projectedQuantidadeRecebida,
      projectedQuantidadeEnviada: r.projectedQuantidadeEnviada,
      estadoDistribution: r.estadoDistribution,
      chunks: r.chunks,
      ...(write ? { created: r.created, updated: r.updated, aggregated: r.created + r.updated } : {}),
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline/aggregate-devolucoes] error ${JSON.stringify({ tenant: ctx.tenant.slug, farmaciaId, write, msg, durationMs })}`);
    return NextResponse.json({ ok: false, error: "internal", message: msg, durationMs }, { status: 500 });
  }
});
