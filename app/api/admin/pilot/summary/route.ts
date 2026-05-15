/**
 * app/api/admin/pilot/summary/route.ts
 *
 * GET /api/admin/pilot/summary
 *
 * Endpoint read-only platform admin — produz um snapshot consolidado
 * do estado do piloto em todos os tenants activos:
 *
 *   · tenants activos + farmácias activas
 *   · última pipeline run por tenant (kind)
 *   · OrderOutbox: counts por state (24h e 7d)
 *   · feature flags actuais
 *   · build info do SaaS
 *
 * Auth: platform admin (sessão ADMINISTRADOR + email em
 * PLATFORM_ADMIN_EMAILS + contexto LEGACY_TENANT).
 *
 * Performance: itera todos os tenants ACTIVE. Para escala piloto
 * (< 10 tenants), é aceitável (~1-3s). Cache 30s no client se chamado
 * por dashboard. Erros por-tenant são isolados — uma BD lenta/offline
 * marca esse tenant como "error" mas não derruba o resto da resposta.
 *
 * Não invocar de páginas tenant-scoped — este endpoint é estritamente
 * cross-tenant e deve ser usado no /admin console.
 */

import { NextResponse } from "next/server";
import { listTenants, type TenantRecord } from "@/lib/control-plane";
import { getTenantPrismaForAdmin } from "@/lib/admin/tenant-client";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { snapshotFeatureFlags } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

type TenantSummary = {
  slug: string;
  nome: string;
  estado: string;
  dbHost: string;
  // farmacias
  farmaciasAtivas: number | null;
  // pipeline runs (most recent per kind)
  lastDailyPipeline: PipelineSummary | null;
  lastDailySync: PipelineSummary | null;
  lastAggregate: PipelineSummary | null;
  // outbox (orders)
  outbox24h: OutboxBuckets;
  outbox7d: OutboxBuckets;
  // staging health
  unknownTipoDocs: number | null;
  operationalOrphans: number | null;
  // erros
  error: string | null;
};

type PipelineSummary = {
  status: string;
  startedAt: string;
  durationMs: number | null;
  errorMessage: string | null;
};

type OutboxBuckets = {
  pendente: number;
  emExportacao: number;
  exportado: number;
  falhado: number;
  cancelado: number;
  // derivados
  retryable: number; // PENDENTE com attemptCount>=1 — re-entregas
  poison: number;    // FALHADO (retryable=false marcou)
};

async function loadTenantSummary(tenant: TenantRecord): Promise<TenantSummary> {
  const baseSummary: TenantSummary = {
    slug: tenant.slug,
    nome: tenant.nome,
    estado: tenant.estado,
    dbHost: tenant.dbHost,
    farmaciasAtivas: null,
    lastDailyPipeline: null,
    lastDailySync: null,
    lastAggregate: null,
    outbox24h: emptyBuckets(),
    outbox7d: emptyBuckets(),
    unknownTipoDocs: null,
    operationalOrphans: null,
    error: null,
  };
  if (tenant.estado !== "ACTIVE") return baseSummary;

  try {
    const prisma = getTenantPrismaForAdmin(tenant);
    const now = new Date();
    const since24h = new Date(now.getTime() - DAY_MS);
    const since7d = new Date(now.getTime() - 7 * DAY_MS);

    // Farmácias activas
    const farmaciasAtivas = await prisma.farmacia.count({
      where: { estado: "ATIVO" },
    });

    // Última PipelineRun por kind. Cada chamada é uma findFirst leve
    // (index em startedAt DESC).
    const [lastDp, lastDs, lastAg] = await Promise.all([
      prisma.pipelineRun.findFirst({
        where: { kind: "daily-pipeline" },
        orderBy: { startedAt: "desc" },
        select: { status: true, startedAt: true, durationMs: true, errorMessage: true },
      }),
      prisma.pipelineRun.findFirst({
        where: { kind: "daily-sync" },
        orderBy: { startedAt: "desc" },
        select: { status: true, startedAt: true, durationMs: true, errorMessage: true },
      }),
      prisma.pipelineRun.findFirst({
        where: { kind: "aggregate-month" },
        orderBy: { startedAt: "desc" },
        select: { status: true, startedAt: true, durationMs: true, errorMessage: true },
      }),
    ]);

    // Outbox buckets. Uma GROUP BY por janela.
    const [counts24h, counts7d] = await Promise.all([
      prisma.orderOutbox.groupBy({
        by: ["state"],
        where: { updatedAt: { gte: since24h } },
        _count: { _all: true },
      }),
      prisma.orderOutbox.groupBy({
        by: ["state"],
        where: { updatedAt: { gte: since7d } },
        _count: { _all: true },
      }),
    ]);

    // Retryable + poison são derivados:
    //   retryable = PENDENTE com attemptCount > 0 (já tentou e voltou)
    //   poison    = FALHADO (lastError set por nack retryable=false)
    const [retryable24h, poison24h, retryable7d, poison7d] = await Promise.all([
      prisma.orderOutbox.count({
        where: { state: "PENDENTE", attemptCount: { gt: 0 }, updatedAt: { gte: since24h } },
      }),
      prisma.orderOutbox.count({
        where: { state: "FALHADO", updatedAt: { gte: since24h } },
      }),
      prisma.orderOutbox.count({
        where: { state: "PENDENTE", attemptCount: { gt: 0 }, updatedAt: { gte: since7d } },
      }),
      prisma.orderOutbox.count({
        where: { state: "FALHADO", updatedAt: { gte: since7d } },
      }),
    ]);

    return {
      ...baseSummary,
      farmaciasAtivas,
      lastDailyPipeline: toPipelineSummary(lastDp),
      lastDailySync: toPipelineSummary(lastDs),
      lastAggregate: toPipelineSummary(lastAg),
      outbox24h: toBuckets(counts24h, retryable24h, poison24h),
      outbox7d: toBuckets(counts7d, retryable7d, poison7d),
      // unknownTipoDocs / operationalOrphans: reservado para enriquecimento
      // futuro a partir de tabelas de staging. Mantidos null no piloto v1
      // para evitar queries adicionais até modelo estabilizar.
      unknownTipoDocs: null,
      operationalOrphans: null,
    };
  } catch (err) {
    return {
      ...baseSummary,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
}

function emptyBuckets(): OutboxBuckets {
  return {
    pendente: 0,
    emExportacao: 0,
    exportado: 0,
    falhado: 0,
    cancelado: 0,
    retryable: 0,
    poison: 0,
  };
}

function toBuckets(
  groups: Array<{ state: string; _count: { _all: number } }>,
  retryable: number,
  poison: number
): OutboxBuckets {
  const b = emptyBuckets();
  for (const g of groups) {
    const cnt = g._count._all;
    switch (g.state) {
      case "PENDENTE": b.pendente = cnt; break;
      case "EM_EXPORTACAO": b.emExportacao = cnt; break;
      case "EXPORTADO": b.exportado = cnt; break;
      case "FALHADO": b.falhado = cnt; break;
      case "CANCELADO": b.cancelado = cnt; break;
    }
  }
  b.retryable = retryable;
  b.poison = poison;
  return b;
}

function toPipelineSummary(
  run: { status: string; startedAt: Date; durationMs: number | null; errorMessage: string | null } | null
): PipelineSummary | null {
  if (!run) return null;
  return {
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    durationMs: run.durationMs,
    errorMessage: run.errorMessage ? run.errorMessage.slice(0, 200) : null,
  };
}

function buildInfo() {
  return {
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.SAAS_GIT_COMMIT?.slice(0, 7) ?? "dev",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? process.env.SAAS_GIT_BRANCH ?? "dev",
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "dev",
    nodeVersion: process.version,
  };
}

export async function GET(): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const startedAt = Date.now();
  const allTenants = await listTenants();
  const activeTenants = allTenants.filter((t) => t.estado === "ACTIVE");

  // Sequencial: evita criar N pools em paralelo + facilita debug.
  // Para escala piloto (< 10 tenants), latência ~1-2s total.
  const tenantSummaries: TenantSummary[] = [];
  for (const t of activeTenants) {
    tenantSummaries.push(await loadTenantSummary(t));
  }

  // Agregados globais (soma das janelas 24h dos tenants OK)
  const globalOutbox24h = emptyBuckets();
  for (const s of tenantSummaries) {
    if (s.error) continue;
    globalOutbox24h.pendente += s.outbox24h.pendente;
    globalOutbox24h.emExportacao += s.outbox24h.emExportacao;
    globalOutbox24h.exportado += s.outbox24h.exportado;
    globalOutbox24h.falhado += s.outbox24h.falhado;
    globalOutbox24h.cancelado += s.outbox24h.cancelado;
    globalOutbox24h.retryable += s.outbox24h.retryable;
    globalOutbox24h.poison += s.outbox24h.poison;
  }

  return NextResponse.json({
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    build: buildInfo(),
    featureFlags: snapshotFeatureFlags(),
    tenants: {
      total: allTenants.length,
      active: activeTenants.length,
      withErrors: tenantSummaries.filter((s) => !!s.error).length,
    },
    global: {
      outbox24h: globalOutbox24h,
    },
    perTenant: tenantSummaries,
  });
}
