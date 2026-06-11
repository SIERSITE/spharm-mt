/**
 * app/api/jobs/acquire-regulatory/route.ts
 *
 * Cron de processamento do regulatory acquisition pipeline. Para cada
 * tenant ACTIVE, corre `runAcquisitionTick` que:
 *   1. GC dos jobs IN_PROGRESS pendurados (>30min)
 *   2. Claim de jobs PENDING/PARTIAL prontos (FOR UPDATE SKIP LOCKED)
 *   3. Tenta INFARMED snapshot (DB-only) + INFOMED HTTP por job
 *   4. Faz UPSERT em RegulatoryRecord (preserve-non-null) e sincroniza
 *      a Produto (preserve-non-null + ignora validadoManualmente)
 *   5. Aplica outcome ao job (DONE / PARTIAL / retry / FAILED / BLOCKED)
 *   6. Para outcome=ambiguous, enqueue em FilaRevisao
 *
 * Cadência recomendada: **02:30 UTC daily** (30min depois do enqueue
 * para garantir que há trabalho na queue) e/ou hourly se houver volume.
 *
 * maxDuration=300s (limite Hobby). Cada tenant: até 100 jobs OU 240s
 * (deixa folga ao iterador). Em N tenants, o run total pode aproximar-se
 * de 300s — operador ajusta `maxJobsPerTenant` baixando se necessário.
 *
 * Auth: idêntica a `enrich-catalog`.
 *
 * Manual test:
 *   curl -i "https://<host>/api/jobs/acquire-regulatory?secret=$CRON_SECRET&onlySlugs=grupo-silveira&maxJobsPerTenant=5"
 *   curl -i "https://<host>/api/jobs/acquire-regulatory?secret=$CRON_SECRET&skipHttp=1"   # só snapshot
 */

import { NextResponse, type NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { forEachActiveTenant, type TenantIterSummary } from "@/lib/tenancy/for-each-tenant";
import {
  runAcquisitionTick,
  type AcquisitionTickSummary,
} from "@/lib/jobs/regulatory-acquisition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Max do plano Hobby. Cada tenant pega numa fatia do orçamento via
// maxDurationMs interno do tick.
export const maxDuration = 300;

type TenantResult =
  | { ok: true; slug: string; nome: string; summary: AcquisitionTickSummary }
  | { ok: false; slug: string; nome: string; error: string };

type SuccessPayload = {
  ok: true;
  invokedAt: string;
  durationMs: number;
  tenants: TenantResult[];
  rollup: {
    totalTenants: number;
    succeededTenants: number;
    failedTenants: number;
    totalProcessed: number;
    totalDone: number;
    totalPartial: number;
    totalRetry: number;
    totalFailed: number;
    totalBlocked: number;
    totalRrUpserts: number;
    totalProdutoFieldsFilled: number;
    totalImagensFilled: number;
  };
  iterator: Omit<TenantIterSummary, "failures">;
};

type ErrorPayload = {
  ok: false;
  error: string;
  message?: string;
};

function parseLimits(req: NextRequest): {
  maxJobsPerTenant: number;
  maxDurationMsPerTenant: number;
  skipInfomedHttp: boolean;
  onlySlugs: string[] | undefined;
} {
  const url = req.nextUrl;
  const parseIntInRange = (
    raw: string | null,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min || n > max) return fallback;
    return n;
  };
  const maxJobsPerTenant = parseIntInRange(
    url.searchParams.get("maxJobsPerTenant"),
    100,
    1,
    2000,
  );
  // Por tenant — deixa folga ao iterador para fechar limpo dentro do
  // maxDuration=300s do plano. Default 240s. Operador pode baixar.
  const maxDurationMsPerTenant = parseIntInRange(
    url.searchParams.get("maxDurationSecondsPerTenant"),
    240,
    10,
    280,
  ) * 1000;
  const skipInfomedHttp = url.searchParams.get("skipHttp") === "1";
  const onlySlugsRaw = url.searchParams.get("onlySlugs");
  const onlySlugs = onlySlugsRaw
    ? onlySlugsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  return { maxJobsPerTenant, maxDurationMsPerTenant, skipInfomedHttp, onlySlugs };
}

async function handle(req: NextRequest): Promise<Response> {
  const t0 = Date.now();
  const auth = authorizeCronRequest(req);
  if (!auth.ok) {
    const payload: ErrorPayload =
      auth.reason === "missing_env"
        ? { ok: false, error: "server_misconfigured", message: "CRON_SECRET not configured" }
        : { ok: false, error: "unauthorized" };
    const status = auth.reason === "missing_env" ? 503 : 401;
    return NextResponse.json(payload, { status });
  }

  const { maxJobsPerTenant, maxDurationMsPerTenant, skipInfomedHttp, onlySlugs } = parseLimits(req);

  const tenants: TenantResult[] = [];
  let iteratorSummary: TenantIterSummary;
  try {
    iteratorSummary = await forEachActiveTenant(
      async ({ tenant, prisma }) => {
        try {
          const summary = await runAcquisitionTick({
            prisma,
            maxJobs: maxJobsPerTenant,
            maxDurationMs: maxDurationMsPerTenant,
            skipInfomedHttp,
          });
          tenants.push({ ok: true, slug: tenant.slug, nome: tenant.nome, summary });
        } catch (err) {
          tenants.push({
            ok: false,
            slug: tenant.slug,
            nome: tenant.nome,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
      { onlySlugs },
    );
  } catch (err) {
    console.error("[api/jobs/acquire-regulatory] fatal iterator error", err);
    const payload: ErrorPayload = {
      ok: false,
      error: "iterator_failed",
      message: err instanceof Error ? err.message : String(err),
    };
    return NextResponse.json(payload, { status: 500 });
  }

  const rollup = tenants.reduce(
    (acc, t) => {
      if (t.ok) {
        acc.totalProcessed += t.summary.processed;
        acc.totalDone += t.summary.outcomes.done;
        acc.totalPartial += t.summary.outcomes.partial;
        acc.totalRetry += t.summary.outcomes.retry;
        acc.totalFailed += t.summary.outcomes.failed;
        acc.totalBlocked += t.summary.outcomes.blocked;
        acc.totalRrUpserts += t.summary.regulatoryRecordUpserts;
        acc.totalProdutoFieldsFilled += t.summary.produtoUpdates.fieldsFilled;
        acc.totalImagensFilled += t.summary.produtoUpdates.imagemUrlFilled;
      }
      return acc;
    },
    {
      totalProcessed: 0,
      totalDone: 0,
      totalPartial: 0,
      totalRetry: 0,
      totalFailed: 0,
      totalBlocked: 0,
      totalRrUpserts: 0,
      totalProdutoFieldsFilled: 0,
      totalImagensFilled: 0,
    },
  );

  const payload: SuccessPayload = {
    ok: true,
    invokedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    tenants,
    rollup: {
      totalTenants: iteratorSummary.total,
      succeededTenants: iteratorSummary.succeeded,
      failedTenants: iteratorSummary.failed,
      ...rollup,
    },
    iterator: {
      total: iteratorSummary.total,
      succeeded: iteratorSummary.succeeded,
      failed: iteratorSummary.failed,
      durationMs: iteratorSummary.durationMs,
    },
  };
  const status = iteratorSummary.failed === 0 ? 200 : 207;
  return NextResponse.json(payload, { status });
}

export const GET = handle;
export const POST = handle;
