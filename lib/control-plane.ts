import "server-only";
import { PrismaClient } from "@/generated/prisma-control/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { decryptTenantSecret } from "@/lib/tenant-crypto";

/**
 * Singleton do PrismaClient do CONTROL PLANE.
 *
 * Este cliente vive em paralelo com o `lib/prisma.ts` existente (que é
 * o cliente do tenant actual). São duas DBs diferentes, dois clientes
 * diferentes, cada um com o seu URL:
 *
 *   · lib/prisma.ts          → process.env.DATABASE_URL         (tenant)
 *   · lib/control-plane.ts   → process.env.CONTROL_DATABASE_URL (registo)
 *
 * Todos os scripts de provisionamento / gestão + o resolver de
 * tenants em runtime consomem este cliente via `controlPrisma`.
 */

const globalForControl = global as unknown as {
  controlPrisma: PrismaClient | undefined;
};

function buildClient(): PrismaClient {
  const url = process.env.CONTROL_DATABASE_URL;
  if (!url) {
    throw new Error(
      "CONTROL_DATABASE_URL em falta. Define no .env apontando para a BD spharmmt_control."
    );
  }
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

export const controlPrisma: PrismaClient =
  globalForControl.controlPrisma ?? buildClient();

if (process.env.NODE_ENV !== "production") {
  globalForControl.controlPrisma = controlPrisma;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

export type TenantRecord = {
  id: string;
  slug: string;
  nome: string;
  estado: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED" | "FAILED";
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassEncrypted: string;
  dbRegion: string | null;
  schemaVersion: string | null;
  provisionedAt: Date | null;
  lastMigratedAt: Date | null;
  lastHealthCheckAt: Date | null;
  lastHealthStatus: string | null;
  lastBackupAt: Date | null;
  ingestApiKeyHash: string | null;
  ingestApiKeyIssuedAt: Date | null;
  lastAgentHeartbeatAt: Date | null;
  lastAgentIp: string | null;
  lastAgentVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Lê um tenant por slug. Não descifra a password. */
export async function getTenantBySlug(slug: string): Promise<TenantRecord | null> {
  return controlPrisma.tenant.findUnique({ where: { slug } });
}

/** Lê um tenant por id. */
export async function getTenantById(id: string): Promise<TenantRecord | null> {
  return controlPrisma.tenant.findUnique({ where: { id } });
}

/** Lista todos os tenants — para scripts de gestão e health checks. */
export async function listTenants(filter?: {
  estado?: TenantRecord["estado"];
}): Promise<TenantRecord[]> {
  return controlPrisma.tenant.findMany({
    where: filter?.estado ? { estado: filter.estado } : undefined,
    orderBy: [{ estado: "asc" }, { slug: "asc" }],
  });
}

/**
 * Constrói a connection string DB de um tenant descifrando a password
 * com `decryptTenantSecret`. Usado pelo resolver em runtime e pelos
 * scripts de migrate-all / backup / health-check.
 */
export function buildTenantConnectionString(tenant: TenantRecord): string {
  const password = decryptTenantSecret(tenant.dbPassEncrypted);
  const user = encodeURIComponent(tenant.dbUser);
  const pass = encodeURIComponent(password);
  return `postgresql://${user}:${pass}@${tenant.dbHost}:${tenant.dbPort}/${tenant.dbName}`;
}

/**
 * Regista um heartbeat do agent de sincronização para o tenant dado.
 * Chamado pelo endpoint POST /api/outbox/v1/heartbeat. Actualiza três
 * campos: timestamp, IP, versão. Qualquer um pode ser null.
 */
export async function recordAgentHeartbeat(input: {
  tenantId: string;
  ip: string | null;
  version: string | null;
}): Promise<void> {
  await controlPrisma.tenant.update({
    where: { id: input.tenantId },
    data: {
      lastAgentHeartbeatAt: new Date(),
      lastAgentIp: input.ip,
      lastAgentVersion: input.version,
    },
  });
}

/** Escreve um TenantEvent. Helper de conveniência para audit trail. */
export async function logTenantEvent(input: {
  tenantId: string;
  action: string;
  actorId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await controlPrisma.tenantEvent.create({
    data: {
      tenantId: input.tenantId,
      action: input.action,
      actorId: input.actorId ?? null,
      metaJson: input.meta ? JSON.stringify(input.meta) : null,
    },
  });
}
