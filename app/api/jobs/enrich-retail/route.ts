/**
 * app/api/jobs/enrich-retail/route.ts
 *
 * Cron diário do pipeline D (retail enrichment para NÃO-MEDICAMENTO).
 * Itera todos os tenants ACTIVE e, para cada um, corre `runRetailTick`
 * que processa até N produtos não-medicamento com lacunas, tentando
 * Open Beauty Facts / Open Food Facts em sequência.
 *
 * Cadência recomendada: **05:00 UTC daily** (depois do regulatory tick).
 *
 * Anti-contaminação:
 *   · NUNCA toca em productType=MEDICAMENTO (filtro explícito no worker).
 *   · NUNCA escreve fabricante via tier=RETAIL (apenas log audit).
 *   · NUNCA substitui imagem existente.
 *
 * Auth: idêntica a `enrich-catalog`.
 *
 * Manual test:
 *   curl -i "https://<host>/api/jobs/enrich-retail?secret=$CRON_SECRET&onlySlugs=grupo-silveira&maxProducts=5"
 */

import { NextResponse, type NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { forEachActiveTenant, type TenantIterSummary } from "@/lib/tenancy/for-each-tenant";
import { runRetailTick, type RetailTickSummary } from "@/lib/jobs/retail-enrichment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type TenantResult =
  | { ok: true; slug: string; nome: string; summary: RetailTickSummary }
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
    totalFieldsWritten: number;
    totalImagensFilled: number;
    totalReviewEnqueued: number;
  };
  iterator: Omit<TenantIterSummary, "failures">;
};

type ErrorPayload = {
  ok: false;
  error: string;
  message?: string;
};

function parseLimits(req: NextRequest): {
  maxProducts: number;
  maxDurationMsPerTenant: number;
  onlySlugs: string[] | undefined;
} {
  const url = req.nextUrl;
  const parseIntInRange = (raw: string | null, fb: number, min: number, max: number): number => {
    if (!raw) return fb;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min || n > max) return fb;
    return n;
  };
  const maxProducts = parseIntInRange(url.searchParams.get("maxProducts"), 50, 1, 1000);
  const maxDurationMsPerTenant =
    parseIntInRange(url.searchParams.get("maxDurationSecondsPerTenant"), 240, 10, 280) * 1000;
  const onlySlugsRaw = url.searchParams.get("onlySlugs");
  const onlySlugs = onlySlugsRaw
    ? onlySlugsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  return { maxProducts, maxDurationMsPerTenant, onlySlugs };
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

  const { maxProducts, maxDurationMsPerTenant, onlySlugs } = parseLimits(req);

  const tenants: TenantResult[] = [];
  let iteratorSummary: TenantIterSummary;
  try {
    iteratorSummary = await forEachActiveTenant(
      async ({ tenant, prisma }) => {
        try {
          const summary = await runRetailTick({
            prisma,
            maxProducts,
            maxDurationMs: maxDurationMsPerTenant,
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
    console.error("[api/jobs/enrich-retail] fatal iterator error", err);
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
        acc.totalFieldsWritten += t.summary.outcomes.fieldsWritten;
        acc.totalImagensFilled += t.summary.outcomes.imagemFilled;
        acc.totalReviewEnqueued += t.summary.outcomes.enqueuedReview;
      }
      return acc;
    },
    {
      totalProcessed: 0,
      totalFieldsWritten: 0,
      totalImagensFilled: 0,
      totalReviewEnqueued: 0,
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
