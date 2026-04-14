import "server-only";
import { getPrisma } from "@/lib/prisma";
import { controlPrisma } from "@/lib/control-plane";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";

/**
 * Data loader para o admin panel /configuracoes/integracao (Outbox tab).
 * Read-only — transições de estado são feitas via server actions em
 * app/configuracoes/integracao/actions.ts.
 */

export type OutboxCounters = {
  pendente: number;
  emExportacao: number;
  exportado: number;
  falhado: number;
  cancelado: number;
};

export type OutboxFailedRow = {
  id: string;
  listaEncomendaId: string;
  listaNome: string;
  farmaciaNome: string;
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
};

export type AgentHeartbeat = {
  lastAt: Date | null;
  minutesAgo: number | null;
  ip: string | null;
  version: string | null;
  healthy: boolean;
};

export type OutboxTabData = {
  counters: OutboxCounters;
  failedRows: OutboxFailedRow[];
  pendingRows: OutboxFailedRow[];
  heartbeat: AgentHeartbeat;
};

const HEARTBEAT_HEALTHY_WINDOW_MIN = 30;

export async function loadOutboxTabData(): Promise<OutboxTabData> {
  const prisma = await getPrisma();

  // Contadores por estado (uma query agregada).
  const rawCounts = await prisma.orderOutbox.groupBy({
    by: ["state"],
    _count: { _all: true },
  });
  const counters: OutboxCounters = {
    pendente: 0,
    emExportacao: 0,
    exportado: 0,
    falhado: 0,
    cancelado: 0,
  };
  for (const r of rawCounts) {
    switch (r.state) {
      case "PENDENTE": counters.pendente = r._count._all; break;
      case "EM_EXPORTACAO": counters.emExportacao = r._count._all; break;
      case "EXPORTADO": counters.exportado = r._count._all; break;
      case "FALHADO": counters.falhado = r._count._all; break;
      case "CANCELADO": counters.cancelado = r._count._all; break;
    }
  }

  // Lista de FALHADO para triagem (top 50).
  const falhados = await prisma.orderOutbox.findMany({
    where: { state: "FALHADO" },
    orderBy: { updatedAt: "desc" },
    take: 50,
    include: {
      listaEncomenda: {
        select: { nome: true, farmacia: { select: { nome: true } } },
      },
    },
  });
  const failedRows: OutboxFailedRow[] = falhados.map((r) => ({
    id: r.id,
    listaEncomendaId: r.listaEncomendaId,
    listaNome: r.listaEncomenda.nome,
    farmaciaNome: r.listaEncomenda.farmacia.nome,
    attemptCount: r.attemptCount,
    lastError: r.lastError,
    lastAttemptAt: r.lastAttemptAt,
    createdAt: r.createdAt,
  }));

  // Lista de PENDENTE (visibilidade ao operador: "há isto em fila").
  const pendentes = await prisma.orderOutbox.findMany({
    where: { state: "PENDENTE" },
    orderBy: { nextAttemptAt: "asc" },
    take: 50,
    include: {
      listaEncomenda: {
        select: { nome: true, farmacia: { select: { nome: true } } },
      },
    },
  });
  const pendingRows: OutboxFailedRow[] = pendentes.map((r) => ({
    id: r.id,
    listaEncomendaId: r.listaEncomendaId,
    listaNome: r.listaEncomenda.nome,
    farmaciaNome: r.listaEncomenda.farmacia.nome,
    attemptCount: r.attemptCount,
    lastError: r.lastError,
    lastAttemptAt: r.lastAttemptAt,
    createdAt: r.createdAt,
  }));

  // Heartbeat — vem do control plane, só se estivermos em modo tenant.
  let heartbeat: AgentHeartbeat = {
    lastAt: null,
    minutesAgo: null,
    ip: null,
    version: null,
    healthy: false,
  };
  const slug = await resolveCurrentTenantSlug();
  if (slug) {
    try {
      const tenant = await controlPrisma.tenant.findUnique({
        where: { slug },
        select: {
          lastAgentHeartbeatAt: true,
          lastAgentIp: true,
          lastAgentVersion: true,
        },
      });
      if (tenant?.lastAgentHeartbeatAt) {
        const minutes = Math.floor(
          (Date.now() - tenant.lastAgentHeartbeatAt.getTime()) / 60_000
        );
        heartbeat = {
          lastAt: tenant.lastAgentHeartbeatAt,
          minutesAgo: minutes,
          ip: tenant.lastAgentIp,
          version: tenant.lastAgentVersion,
          healthy: minutes < HEARTBEAT_HEALTHY_WINDOW_MIN,
        };
      }
    } catch {
      // Control plane indisponível — heartbeat fica null, UI mostra "—".
    }
  }

  return { counters, failedRows, pendingRows, heartbeat };
}
