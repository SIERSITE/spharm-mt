/**
 * app/api/jobs/enqueue-regulatory/route.ts
 *
 * Cron diário (`vercel.json`) de enqueue do regulatory acquisition pipeline.
 * Itera todos os tenants ACTIVE e, para cada um, marca como PENDENTE
 * todos os CNPs MEDICAMENTO que precisam de aquisição regulatória
 * (campos clínicos ou imagem em falta), até `maxNewJobs` por tenant.
 *
 * Cadência recomendada: **02:00 UTC daily** (antes do worker das 02:30).
 *
 * Multi-tenant via `forEachActiveTenant`. Sequencial. Cada tenant tem o
 * seu próprio Neon DB. Idempotente — só cria jobs novos para CNPs que
 * ainda não têm job DONE/BLOCKED nem PENDING aberto.
 *
 * Auth: idêntica a `enrich-catalog` (`authorizeCronRequest` com Bearer
 * ou query `?secret=`).
 *
 * Manual test:
 *   curl -i "https://<host>/api/jobs/enqueue-regulatory?secret=$CRON_SECRET&onlySlugs=grupo-silveira&maxNewJobs=10"
 */

import { NextResponse, type NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { forEachActiveTenant, type TenantIterSummary } from "@/lib/tenancy/for-each-tenant";
import { runEnqueueRegulatory, type EnqueueSummary } from "@/lib/jobs/enqueue-regulatory";
import {
  startSyncRun,
  completeSyncRun,
  failSyncRun,
  heartbeatSyncRun,
  isSyncRunAlreadyRunning,
} from "@/lib/sync/sync-run";

const JOB_SOURCE = "enqueue-regulatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type TenantResult =
  | { ok: true; slug: string; nome: string; summary: EnqueueSummary }
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
    totalJobsCreated: number;
    totalAlreadyOpen: number;
  };
  iterator: Omit<TenantIterSummary, "failures">;
};

type ErrorPayload = {
  ok: false;
  error: string;
  message?: string;
};

function parseLimits(req: NextRequest): {
  maxNewJobs: number;
  onlySlugs: string[] | undefined;
} {
  const url = req.nextUrl;
  const raw = url.searchParams.get("maxNewJobs");
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const maxNewJobs =
    Number.isFinite(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : 1000;
  const onlySlugsRaw = url.searchParams.get("onlySlugs");
  const onlySlugs = onlySlugsRaw
    ? onlySlugsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  return { maxNewJobs, onlySlugs };
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

  const { maxNewJobs, onlySlugs } = parseLimits(req);

  const tenants: TenantResult[] = [];
  let iteratorSummary: TenantIterSummary;
  try {
    iteratorSummary = await forEachActiveTenant(
      async ({ tenant, prisma }) => {
        // Lock cooperativo — evita dois runs para o mesmo (tenant, source)
        // quando o cron dispara em cima duma execução manual.
        if (await isSyncRunAlreadyRunning(tenant.slug, JOB_SOURCE)) {
          tenants.push({
            ok: false,
            slug: tenant.slug,
            nome: tenant.nome,
            error: "already_running",
          });
          return; // não conta como falha do iterador, apenas skip
        }
        const run = await startSyncRun({
          tenantSlug: tenant.slug,
          source: JOB_SOURCE,
          triggerType: "CRON",
          meta: { maxNewJobs },
        });
        // heartbeat a cada 30s enquanto o run corre
        const hb = setInterval(() => heartbeatSyncRun(run.id), 30_000);
        try {
          await heartbeatSyncRun(run.id);
          const summary = await runEnqueueRegulatory({ prisma, maxNewJobs });
          await completeSyncRun(run.id, {
            recordsRead: summary.candidatesFound,
            recordsInserted: summary.jobsCreated,
            recordsUpdated: summary.jobsAlreadyOpen,
          });
          tenants.push({ ok: true, slug: tenant.slug, nome: tenant.nome, summary });
        } catch (err) {
          await failSyncRun(run.id, err);
          tenants.push({
            ok: false,
            slug: tenant.slug,
            nome: tenant.nome,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          clearInterval(hb);
        }
      },
      { onlySlugs },
    );
  } catch (err) {
    console.error("[api/jobs/enqueue-regulatory] fatal iterator error", err);
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
        acc.totalJobsCreated += t.summary.jobsCreated;
        acc.totalAlreadyOpen += t.summary.jobsAlreadyOpen;
      }
      return acc;
    },
    { totalJobsCreated: 0, totalAlreadyOpen: 0 },
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
