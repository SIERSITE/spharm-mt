/**
 * app/api/jobs/refresh-ipf/route.ts
 *
 * Entry-point HTTP do scheduler para refresh do read-model
 * `IndicadoresProdutoFarmacia`. Invocado pelo scheduler (Vercel Cron ou
 * o worker local, ver `scripts/workers/scheduler.mjs`); também pode ser
 * disparado manualmente.
 *
 * Autenticação:
 *   · `Authorization: Bearer <CRON_SECRET>` (é o que o scheduler envia).
 *   · Em alternativa, query `?secret=<CRON_SECRET>` para testes
 *     manuais via browser / curl.
 *   · Se `CRON_SECRET` não estiver definido em env, o endpoint recusa
 *     **sempre** — defesa contra deploys mal-configurados.
 *
 * MULTI-TENANT (mudou): esta rota corria contra `legacyPrisma`, isto é,
 * contra a base apontada por `DATABASE_URL`, ignorando o control plane.
 * Num alojamento onde `DATABASE_URL` é a base legacy e os clientes reais
 * vivem cada um na sua, isso recalculava indicadores da base errada e
 * não recalculava nenhum dos tenants. Passa a iterar os tenants ACTIVE,
 * como `enrich-catalog` e `enrich-retail` já faziam.
 *
 * Ledger e lock: cada tenant tem a sua linha `SyncRun` com heartbeat, e
 * um tick que encontre outro em curso para o mesmo (tenant, source)
 * devolve `already_running` em vez de duplicar o trabalho. Sem isto, um
 * populate lento sobreposto ao tick seguinte reescrevia as mesmas linhas
 * e a duração média deixava de significar alguma coisa.
 *
 * Estado HTTP: 200 quando todos os tenants correram e ficaram healthy;
 * 207 quando houve falhas parciais; 503 quando correu mas pelo menos um
 * read-model continua unhealthy (accionável, mas não é erro de servidor).
 *
 * Não escreve UI nova. Não toca em encomendas. Sem writes noutras
 * tabelas — só upsert idempotente sobre `IndicadoresProdutoFarmacia`.
 *
 * Manual test:
 *   curl -i "http://localhost:3000/api/jobs/refresh-ipf?secret=$CRON_SECRET&dry=1"
 *   curl -i "http://localhost:3000/api/jobs/refresh-ipf?secret=$CRON_SECRET&onlySlugs=grupo-silveira"
 */

import { NextResponse, type NextRequest } from "next/server";
import { runIpfPopulate } from "@/lib/operational/ipf-populate";
import { getIpfFreshness } from "@/lib/operational/ipf-freshness";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { forEachActiveTenant, type TenantIterSummary } from "@/lib/tenancy/for-each-tenant";
import {
  startSyncRun,
  completeSyncRun,
  failSyncRun,
  heartbeatSyncRun,
  isSyncRunAlreadyRunning,
} from "@/lib/sync/sync-run";

const JOB_SOURCE = "refresh-ipf";

// Cron jobs precisam de runtime Node + execução não cacheada.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Permite até 5 minutos — o populate demora <15s por tenant, mas abre
// folga para arranque a frio da base + connection pool.
export const maxDuration = 300;

type TenantHealth = {
  coverage: number;
  ageHours: number | null;
  totalIpfRows: number;
  isStale: boolean;
  isLowCoverage: boolean;
  healthy: boolean;
  reasons: string[];
};

type TenantResult =
  | {
      ok: true;
      slug: string;
      nome: string;
      populate: {
        dryRun: boolean;
        farmacias: number;
        produtoFarmacia: number;
        rowsCalculated: number;
        rowsUpserted: number;
        rowsFailed: number;
        batches: number;
      };
      health: TenantHealth;
    }
  | { ok: false; slug: string; nome: string; error: string };

type SuccessPayload = {
  ok: true;
  status: "healthy" | "unhealthy";
  invokedAt: string;
  durationMs: number;
  tenants: TenantResult[];
  rollup: {
    totalTenants: number;
    succeededTenants: number;
    failedTenants: number;
    unhealthyTenants: number;
    totalRowsUpserted: number;
    totalRowsFailed: number;
  };
  iterator: Omit<TenantIterSummary, "failures">;
};

type ErrorPayload = {
  ok: false;
  error: string;
  message?: string;
};

function parseOptions(req: NextRequest): {
  dryRun: boolean;
  onlySlugs: string[] | undefined;
} {
  const url = req.nextUrl;
  const onlySlugsRaw = url.searchParams.get("onlySlugs");
  return {
    dryRun: url.searchParams.get("dry") === "1",
    onlySlugs: onlySlugsRaw
      ? onlySlugsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined,
  };
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

  const { dryRun, onlySlugs } = parseOptions(req);

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
          meta: { dryRun },
        });
        // O populate é uma sequência longa de batches sem pontos de
        // paragem naturais; sem heartbeat periódico, o lock do tick
        // seguinte considera este run morto e corre por cima.
        const hb = setInterval(() => heartbeatSyncRun(run.id), 30_000);
        try {
          await heartbeatSyncRun(run.id);
          const result = await runIpfPopulate(prisma, { dryRun });
          const fresh = await getIpfFreshness(prisma);
          await completeSyncRun(run.id, {
            recordsRead: result.rowsCalculated,
            recordsUpdated: result.rowsUpserted,
            recordsFailed: result.rowsFailed,
          });
          tenants.push({
            ok: true,
            slug: tenant.slug,
            nome: tenant.nome,
            populate: {
              dryRun: result.dryRun,
              farmacias: result.farmaciasCount,
              produtoFarmacia: result.pfRowsCount,
              rowsCalculated: result.rowsCalculated,
              rowsUpserted: result.rowsUpserted,
              rowsFailed: result.rowsFailed,
              batches: result.batches,
            },
            health: {
              coverage: Number(fresh.coverage.toFixed(4)),
              ageHours: fresh.ageHours === null ? null : Number(fresh.ageHours.toFixed(2)),
              totalIpfRows: fresh.totalIpfRows,
              isStale: fresh.isStale,
              isLowCoverage: fresh.isLowCoverage,
              healthy: fresh.healthy && result.rowsFailed === 0,
              reasons: fresh.reasons,
            },
          });
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
    // forEachActiveTenant não atira por defeito; só chegamos aqui se a
    // listagem de tenants falhar (control plane em baixo).
    console.error("[api/jobs/refresh-ipf] fatal iterator error", err);
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
        acc.totalRowsUpserted += t.populate.rowsUpserted;
        acc.totalRowsFailed += t.populate.rowsFailed;
        if (!t.health.healthy) acc.unhealthyTenants += 1;
      }
      return acc;
    },
    { totalRowsUpserted: 0, totalRowsFailed: 0, unhealthyTenants: 0 },
  );

  const payload: SuccessPayload = {
    ok: true,
    status: rollup.unhealthyTenants === 0 ? "healthy" : "unhealthy",
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

  // 207 = alguns tenants falharam; 503 = correram todos mas pelo menos
  // um read-model está unhealthy (inclui o caso dry-run, que nunca
  // actualiza o dataCalculo e por isso aparece sempre stale).
  let status = 200;
  if (iteratorSummary.failed > 0) status = 207;
  else if (rollup.unhealthyTenants > 0) status = 503;
  return NextResponse.json(payload, { status });
}

// O scheduler dispara GET; manual pode usar POST. Aceitamos ambos.
export const GET = handle;
export const POST = handle;
