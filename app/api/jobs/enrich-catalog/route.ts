/**
 * app/api/jobs/enrich-catalog/route.ts
 *
 * Cron diário (`vercel.json: 0 4 * * *`) de enriquecimento incremental
 * do catálogo. Para cada tenant ACTIVE no control plane, corre 2 fases
 * idempotentes:
 *
 *   1. SYNC: hidrata `Produto.<codigoATC, dci, formaFarmaceutica, dosagem,
 *      embalagem>` a partir do cache `RegulatoryRecord` quando o campo
 *      está NULL. Não sobrescreve. Ignora `validadoManualmente=true`.
 *
 *   2. RECLASSIFY: recalcula `classificacaoNivel1Id` /
 *      `classificacaoNivel2Id` para MEDICAMENTOS em "Outros Medicamentos"
 *      ou sem N2, usando `mapToCanonical()` com base nos sinais agora
 *      presentes em Produto. Não invoca HTTP.
 *
 * **Escopo deliberado:**
 *   · NÃO faz crawl INFOMED (não cabe em maxDuration=300s; tem rate-limit
 *     1.5 s/CNP + cooldown 30 s; ver `notes/catalog-enrichment-progress.md`).
 *     Crawl continua a ser job manual (`scripts/crawl-infomed-search.ts`).
 *   · NÃO sincroniza imagens (pipeline separado, ainda por desenhar).
 *   · NÃO recolhe sinais de `categoriaOrigem` / breadcrumb retail
 *     (esses só estão presentes durante o ingest inicial).
 *
 * Multi-tenant: itera via `forEachActiveTenant` com `parallelLimit=1`
 * (sequencial). Cada tenant tem o seu próprio Neon DB; o tempo agregado
 * cresce linearmente com o nº de tenants. Default `syncLimit=1000` +
 * `reclassifyLimit=500` por tenant deixa folga em planos Hobby.
 *
 * Autenticação: idêntica a `refresh-ipf` (`authorizeCronRequest`).
 *
 * Manual test:
 *   curl -i "https://<host>/api/jobs/enrich-catalog?secret=$CRON_SECRET&onlySlugs=silveira"
 *   curl -i "https://<host>/api/jobs/enrich-catalog?secret=$CRON_SECRET&syncLimit=50&reclassifyLimit=20"
 */

import { NextResponse, type NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { forEachActiveTenant, type TenantIterSummary } from "@/lib/tenancy/for-each-tenant";
import { runEnrichCycle, type EnrichCycleSummary } from "@/lib/jobs/enrich-catalog";
import {
  startSyncRun,
  completeSyncRun,
  failSyncRun,
  heartbeatSyncRun,
  isSyncRunAlreadyRunning,
} from "@/lib/sync/sync-run";

const JOB_SOURCE = "enrich-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 5 min é o teto Hobby. Em Pro pode subir-se para 900s, mas o cron actual
// foi dimensionado para caber em 300s mesmo com 5 tenants. Se o operador
// fizer crescer o nº de tenants, baixar `syncLimit`/`reclassifyLimit`.
export const maxDuration = 300;

type TenantResult =
  | {
      ok: true;
      slug: string;
      nome: string;
      summary: EnrichCycleSummary;
    }
  | {
      ok: false;
      slug: string;
      nome: string;
      error: string;
    };

type SuccessPayload = {
  ok: true;
  invokedAt: string;
  durationMs: number;
  tenants: TenantResult[];
  rollup: {
    totalTenants: number;
    succeededTenants: number;
    failedTenants: number;
    totalSyncUpdated: number;
    totalReclassifyUpdated: number;
    totalErrors: number;
  };
  iterator: Omit<TenantIterSummary, "failures">;
};

type ErrorPayload = {
  ok: false;
  error: string;
  message?: string;
};

/**
 * Lê limites configuráveis da query string. Default conservador para
 * caber em <60s/tenant. Manual runs podem subir `syncLimit` para
 * absorver backlog mais depressa (cuidado com `maxDuration`).
 */
function parseLimits(req: NextRequest): {
  syncLimit: number;
  reclassifyLimit: number;
  knowledgeLimit: number;
  knowledgeCapUsd: number;
  onlySlugs: string[] | undefined;
} {
  const url = req.nextUrl;
  const parsePositiveInt = (raw: string | null, fallback: number, max: number): number => {
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
  };
  const syncLimit = parsePositiveInt(url.searchParams.get("syncLimit"), 1000, 5000);
  const reclassifyLimit = parsePositiveInt(url.searchParams.get("reclassifyLimit"), 500, 2000);
  // Fase 3 desligada por omissão (0). Custa dinheiro por produto: quem
  // opera o cron tem de a pedir, e o tecto de custo por tenant existe
  // para que um catálogo grande nao gere uma fatura surpresa.
  const knowledgeLimit = parsePositiveInt(url.searchParams.get("knowledgeLimit"), 0, 2000);
  const knowledgeCapUsd = parsePositiveInt(url.searchParams.get("knowledgeCapUsd"), 5, 100);
  const onlySlugsRaw = url.searchParams.get("onlySlugs");
  const onlySlugs = onlySlugsRaw
    ? onlySlugsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  return { syncLimit, reclassifyLimit, knowledgeLimit, knowledgeCapUsd, onlySlugs };
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

  const { syncLimit, reclassifyLimit, knowledgeLimit, knowledgeCapUsd, onlySlugs } = parseLimits(req);

  const tenants: TenantResult[] = [];
  let iteratorSummary: TenantIterSummary;
  try {
    iteratorSummary = await forEachActiveTenant(
      async ({ tenant, prisma }) => {
        if (await isSyncRunAlreadyRunning(tenant.slug, JOB_SOURCE)) {
          tenants.push({
            ok: false,
            slug: tenant.slug,
            nome: tenant.nome,
            error: "already_running",
          });
          return;
        }
        const run = await startSyncRun({
          tenantSlug: tenant.slug,
          source: JOB_SOURCE,
          triggerType: "CRON",
          meta: { syncLimit, reclassifyLimit },
        });
        const hb = setInterval(() => heartbeatSyncRun(run.id), 30_000);
        try {
          await heartbeatSyncRun(run.id);
          const summary = await runEnrichCycle({
            prisma, syncLimit, reclassifyLimit, knowledgeLimit, knowledgeCapUsd,
            // Fase 5 (promoção ao catálogo global) só corre com slug: o
            // global regista de que tenant veio cada conclusão.
            tenantSlug: tenant.slug,
          });
          await completeSyncRun(run.id, {
            recordsUpdated: summary.sync.updated + summary.reclassify.updated,
            recordsFailed: summary.sync.errors + summary.reclassify.errors,
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
      { onlySlugs }
    );
  } catch (err) {
    // forEachActiveTenant não atira por defeito; só chegamos aqui se
    // listActiveTenants falhar (DB control plane down).
    console.error("[api/jobs/enrich-catalog] fatal iterator error", err);
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
        acc.totalSyncUpdated += t.summary.sync.updated;
        acc.totalReclassifyUpdated += t.summary.reclassify.updated;
        acc.totalErrors += t.summary.sync.errors + t.summary.reclassify.errors;
      }
      return acc;
    },
    { totalSyncUpdated: 0, totalReclassifyUpdated: 0, totalErrors: 0 }
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
  // 200 quando todos os tenants correram OK; 207 quando houve falhas
  // parciais (operador alertado mas o cron não retry o run inteiro).
  const status = iteratorSummary.failed === 0 ? 200 : 207;
  return NextResponse.json(payload, { status });
}

// Vercel Cron dispara GET; aceitamos POST para invocação manual.
export const GET = handle;
export const POST = handle;
