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
 * ─────────────────────────────────────────────────────────────────────
 * DOIS FLUXOS, escolhidos por REFRESH_IPF_MULTI_TENANT_ENABLED
 * ─────────────────────────────────────────────────────────────────────
 *
 *   ausente ou falso (DEFAULT)  → fluxo LEGACY, single-DB, contra
 *     `legacyPrisma` (isto é, `DATABASE_URL`). É EXACTAMENTE o
 *     comportamento que está em produção na Vercel, incluindo o formato
 *     da resposta e os códigos HTTP. Não itera tenants, não escreve no
 *     ledger `SyncRun` e não usa lock.
 *
 *   verdadeiro                  → fluxo MULTI-TENANT: itera os tenants
 *     ACTIVE do control plane, cada um com a sua linha `SyncRun`, com
 *     heartbeat e lock cooperativo.
 *
 * Porque é que o default é o legacy: o mesmo commit que introduziu o
 * fluxo multi-tenant é implantado na Vercel, onde o cron continua
 * agendado (`vercel.json`). Sem esta guarda, o disparo seguinte mudava
 * de comportamento sozinho — passava a escrever nas bases dos tenants
 * em vez da base actual, sem ninguém ter decidido isso. Uma alteração
 * de comportamento em produção tem de ser um acto explícito.
 *
 * Ausência da variável é tratada como falso, deliberadamente: a
 * configuração que falta nunca pode ser a que muda o comportamento.
 *
 * Condições para ligar (todas, por esta ordem): catálogo instalado,
 * tenants reais criados, jobs validados manualmente com `--once`,
 * scheduler da VPS activo, e o cron equivalente da Vercel desligado.
 * Ligar antes de o cron da Vercel estar desligado põe dois schedulers a
 * escrever nas mesmas bases.
 *
 * O que o fluxo multi-tenant corrige, quando for ligado: o legacy corre
 * contra `DATABASE_URL`, que num alojamento multi-tenant é a base
 * legacy — recalcula indicadores da base errada e de nenhum tenant.
 *
 * Não escreve UI nova. Não toca em encomendas. Sem writes noutras
 * tabelas — só upsert idempotente sobre `IndicadoresProdutoFarmacia`.
 *
 * Manual test:
 *   curl -i "http://localhost:3000/api/jobs/refresh-ipf?secret=$CRON_SECRET&dry=1"
 *   REFRESH_IPF_MULTI_TENANT_ENABLED=1 curl -i "...&onlySlugs=grupo-silveira"
 */

import { NextResponse, type NextRequest } from "next/server";
import { legacyPrisma } from "@/lib/prisma";
import { runIpfPopulate } from "@/lib/operational/ipf-populate";
import { getIpfFreshness } from "@/lib/operational/ipf-freshness";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { refreshIpfMultiTenantEnabled } from "@/lib/runtime-config";
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

type PopulateSummary = {
  dryRun: boolean;
  farmacias: number;
  produtoFarmacia: number;
  rowsCalculated: number;
  rowsUpserted: number;
  rowsFailed: number;
  batches: number;
};

type HealthSummary = {
  coverage: number;
  ageHours: number | null;
  totalIpfRows: number;
  isStale: boolean;
  isLowCoverage: boolean;
  reasons: string[];
};

type ErrorPayload = {
  ok: false;
  error: string;
  message?: string;
};

// ─────────────────────────────────────────────────────────────────────
// Fluxo LEGACY (default) — single-DB, formato de resposta preservado
// ─────────────────────────────────────────────────────────────────────

type LegacyPayload = {
  ok: true;
  /** "legacy" | "multi-tenant" — permite confirmar o fluxo sem entrar no servidor. */
  mode: "legacy";
  status: "healthy" | "unhealthy";
  invokedAt: string;
  durationMs: number;
  populate: PopulateSummary;
  health: HealthSummary;
};

async function handleLegacy(t0: number, dryRun: boolean): Promise<Response> {
  try {
    const result = await runIpfPopulate(legacyPrisma, { dryRun });
    const fresh = await getIpfFreshness(legacyPrisma);

    const payload: LegacyPayload = {
      ok: true,
      mode: "legacy",
      status: fresh.healthy ? "healthy" : "unhealthy",
      invokedAt: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
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
        reasons: fresh.reasons,
      },
    };
    // 200 quando healthy, 503 quando populate correu mas o read-model
    // continua unhealthy (dry-run nunca actualiza o dataCalculo →
    // ageHours fica alto; trata-se 503 também, accionável manual).
    const status = fresh.healthy && result.rowsFailed === 0 ? 200 : 503;
    return NextResponse.json(payload, { status });
  } catch (err) {
    console.error("[api/jobs/refresh-ipf] fatal", err);
    const payload: ErrorPayload = {
      ok: false,
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    };
    return NextResponse.json(payload, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Fluxo MULTI-TENANT — atrás da guarda
// ─────────────────────────────────────────────────────────────────────

type TenantResult =
  | {
      ok: true;
      slug: string;
      nome: string;
      populate: PopulateSummary;
      health: HealthSummary & { healthy: boolean };
    }
  | { ok: false; slug: string; nome: string; error: string };

type MultiTenantPayload = {
  ok: true;
  mode: "multi-tenant";
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

async function handleMultiTenant(
  t0: number,
  dryRun: boolean,
  onlySlugs: string[] | undefined,
): Promise<Response> {
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
              reasons: fresh.reasons,
              healthy: fresh.healthy && result.rowsFailed === 0,
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

  const payload: MultiTenantPayload = {
    ok: true,
    mode: "multi-tenant",
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

// ─────────────────────────────────────────────────────────────────────

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

  // A guarda é lida por invocação, não fixada no arranque: permite
  // ligar e desligar sem reconstruir a imagem, e um pedido em curso
  // nunca muda de fluxo a meio.
  if (!refreshIpfMultiTenantEnabled()) {
    // `onlySlugs` só faz sentido no fluxo multi-tenant. Aceitá-lo em
    // silêncio aqui deixaria quem o passou convencido de que filtrou
    // alguma coisa.
    if (onlySlugs && onlySlugs.length > 0) {
      console.warn(
        "[api/jobs/refresh-ipf] onlySlugs ignorado: o fluxo multi-tenant está desligado " +
          "(REFRESH_IPF_MULTI_TENANT_ENABLED)",
      );
    }
    return handleLegacy(t0, dryRun);
  }

  return handleMultiTenant(t0, dryRun, onlySlugs);
}

// O scheduler dispara GET; manual pode usar POST. Aceitamos ambos.
export const GET = handle;
export const POST = handle;
