import "server-only";
import { controlPrisma, listTenants, type TenantRecord } from "@/lib/control-plane";
import { getTenantPrismaForAdmin } from "@/lib/admin/tenant-client";

/**
 * lib/admin/tenant-data.ts
 *
 * Loaders read-only para o admin console. Toda a leitura cross-tenant
 * passa por aqui — facilita auditoria do que é lido onde.
 */

export type TenantOverviewRow = {
  id: string;
  slug: string;
  nome: string;
  estado: TenantRecord["estado"];
  dbHost: string;
  dbName: string;
  schemaVersion: string | null;
  lastHealthCheckAt: Date | null;
  lastHealthStatus: string | null;
  ingestKeyConfigured: boolean;
  ingestApiKeyIssuedAt: Date | null;
  lastAgentHeartbeatAt: Date | null;
  heartbeatMinutesAgo: number | null;
  heartbeatHealthy: boolean;
  createdAt: Date;
};

const HEARTBEAT_HEALTHY_WINDOW_MIN = 30;

function decorateRow(t: TenantRecord): TenantOverviewRow {
  let minutesAgo: number | null = null;
  let healthy = false;
  if (t.lastAgentHeartbeatAt) {
    minutesAgo = Math.floor(
      (Date.now() - t.lastAgentHeartbeatAt.getTime()) / 60_000
    );
    healthy = minutesAgo < HEARTBEAT_HEALTHY_WINDOW_MIN;
  }
  return {
    id: t.id,
    slug: t.slug,
    nome: t.nome,
    estado: t.estado,
    dbHost: t.dbHost,
    dbName: t.dbName,
    schemaVersion: t.schemaVersion,
    lastHealthCheckAt: t.lastHealthCheckAt,
    lastHealthStatus: t.lastHealthStatus,
    ingestKeyConfigured: !!t.ingestApiKeyHash,
    ingestApiKeyIssuedAt: t.ingestApiKeyIssuedAt,
    lastAgentHeartbeatAt: t.lastAgentHeartbeatAt,
    heartbeatMinutesAgo: minutesAgo,
    heartbeatHealthy: healthy,
    createdAt: t.createdAt,
  };
}

export async function listTenantOverviews(): Promise<TenantOverviewRow[]> {
  const tenants = await listTenants();
  return tenants.map(decorateRow);
}

export async function getTenantOverviewById(
  id: string
): Promise<{ tenant: TenantRecord; overview: TenantOverviewRow } | null> {
  const tenant = await controlPrisma.tenant.findUnique({ where: { id } });
  if (!tenant) return null;
  return { tenant, overview: decorateRow(tenant) };
}

// ─────────────────────────────────────────────────────────────
// Cross-tenant: farmácias dentro do tenant alvo
// ─────────────────────────────────────────────────────────────

export type TenantFarmaciaRow = {
  id: string;
  nome: string;
  codigoANF: string | null;
  morada: string | null;
  contacto: string | null;
  estado: "ATIVO" | "INATIVO";
  dataCriacao: Date;
};

export async function listFarmaciasOfTenant(
  tenant: TenantRecord
): Promise<TenantFarmaciaRow[]> {
  const prisma = getTenantPrismaForAdmin(tenant);
  const rows = await prisma.farmacia.findMany({
    select: {
      id: true,
      nome: true,
      codigoANF: true,
      morada: true,
      contacto: true,
      estado: true,
      dataCriacao: true,
    },
    orderBy: [{ estado: "asc" }, { nome: "asc" }],
  });
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Cross-tenant: outbox counters por tenant
// ─────────────────────────────────────────────────────────────

export type TenantOutboxCounters = {
  pendente: number;
  emExportacao: number;
  exportado: number;
  falhado: number;
  cancelado: number;
};

export async function getOutboxCountersForTenant(
  tenant: TenantRecord
): Promise<TenantOutboxCounters> {
  try {
    const prisma = getTenantPrismaForAdmin(tenant);
    const groups = await prisma.orderOutbox.groupBy({
      by: ["state"],
      _count: { _all: true },
    });
    const counters: TenantOutboxCounters = {
      pendente: 0,
      emExportacao: 0,
      exportado: 0,
      falhado: 0,
      cancelado: 0,
    };
    for (const g of groups) {
      switch (g.state) {
        case "PENDENTE": counters.pendente = g._count._all; break;
        case "EM_EXPORTACAO": counters.emExportacao = g._count._all; break;
        case "EXPORTADO": counters.exportado = g._count._all; break;
        case "FALHADO": counters.falhado = g._count._all; break;
        case "CANCELADO": counters.cancelado = g._count._all; break;
      }
    }
    return counters;
  } catch {
    // Tenant DB indisponível → contadores a 0. UI mostra estado de erro
    // separadamente via a flag de health-check do tenant record.
    return { pendente: 0, emExportacao: 0, exportado: 0, falhado: 0, cancelado: 0 };
  }
}

export type TenantFailedOrderRow = {
  outboxId: string;
  listaEncomendaId: string;
  listaNome: string;
  farmaciaNome: string;
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
};

export async function listFailedOrdersOfTenant(
  tenant: TenantRecord,
  limit = 25
): Promise<TenantFailedOrderRow[]> {
  try {
    const prisma = getTenantPrismaForAdmin(tenant);
    const rows = await prisma.orderOutbox.findMany({
      where: { state: "FALHADO" },
      orderBy: { updatedAt: "desc" },
      take: limit,
      include: {
        listaEncomenda: {
          select: { nome: true, farmacia: { select: { nome: true } } },
        },
      },
    });
    return rows.map((r) => ({
      outboxId: r.id,
      listaEncomendaId: r.listaEncomendaId,
      listaNome: r.listaEncomenda.nome,
      farmaciaNome: r.listaEncomenda.farmacia.nome,
      attemptCount: r.attemptCount,
      lastError: r.lastError,
      lastAttemptAt: r.lastAttemptAt,
      createdAt: r.createdAt,
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Sumário global (overview do /admin)
// ─────────────────────────────────────────────────────────────

export type AdminOverviewSummary = {
  totalTenants: number;
  activeTenants: number;
  suspendedTenants: number;
  failedTenants: number;
  withoutIngestKey: number;
  agentSilent: number; // sem heartbeat há > 30min ou nunca
  controlPlaneOk: boolean;
  controlPlaneError: string | null;
};

export async function loadAdminOverviewSummary(): Promise<AdminOverviewSummary> {
  try {
    const tenants = await listTenants();
    let active = 0;
    let suspended = 0;
    let failed = 0;
    let noKey = 0;
    let silent = 0;
    for (const t of tenants) {
      if (t.estado === "ACTIVE") active++;
      if (t.estado === "SUSPENDED") suspended++;
      if (t.estado === "FAILED") failed++;
      if (!t.ingestApiKeyHash) noKey++;
      if (
        !t.lastAgentHeartbeatAt ||
        Date.now() - t.lastAgentHeartbeatAt.getTime() > HEARTBEAT_HEALTHY_WINDOW_MIN * 60_000
      ) {
        silent++;
      }
    }
    return {
      totalTenants: tenants.length,
      activeTenants: active,
      suspendedTenants: suspended,
      failedTenants: failed,
      withoutIngestKey: noKey,
      agentSilent: silent,
      controlPlaneOk: true,
      controlPlaneError: null,
    };
  } catch (err) {
    return {
      totalTenants: 0,
      activeTenants: 0,
      suspendedTenants: 0,
      failedTenants: 0,
      withoutIngestKey: 0,
      agentSilent: 0,
      controlPlaneOk: false,
      controlPlaneError: err instanceof Error ? err.message : String(err),
    };
  }
}
