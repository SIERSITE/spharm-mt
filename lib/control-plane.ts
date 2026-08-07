// Sem `import "server-only"` — este módulo é consumido por scripts
// CLI (`scripts/tenancy/*` e `scripts/jobs/*`) corridos via tsx, fora
// do bundler Next que resolveria o marker. Ver nota equivalente em
// `lib/tenant-registry.ts` e `lib/tenant-context.ts`.
// Continua a ser server-only por design — nunca importar de Client
// Components. Verificação por code review.
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

function resolveControlPrisma(): PrismaClient {
  if (!globalForControl.controlPrisma) {
    globalForControl.controlPrisma = buildClient();
  }
  return globalForControl.controlPrisma;
}

/**
 * Cliente do control plane, construído na PRIMEIRA UTILIZAÇÃO.
 *
 * Era construído no carregamento do módulo, e isso tornava
 * `CONTROL_DATABASE_URL` uma dependência de BUILD: o `next build` avalia
 * os módulos das rotas para recolher metadados, este atirava, e a imagem
 * não se conseguia construir sem uma base de dados à mão. Uma imagem que
 * precisa da produção para ser compilada não pode ser promovida entre
 * ambientes nem reconstruída num servidor novo.
 *
 * O Proxy mantém a API: quem escreve `controlPrisma.tenant.findMany()`
 * não muda nada; a construção acontece no primeiro acesso a uma
 * propriedade, já em runtime, e a mensagem de erro continua a mesma.
 */
export const controlPrisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = resolveControlPrisma();
    const value = Reflect.get(client as object, prop, receiver);
    // Os métodos de topo ($connect, $queryRaw, ...) perdem o `this` se
    // forem devolvidos em bruto através do Proxy. Os delegates de modelo
    // são objectos e passam intactos.
    return typeof value === "function" ? value.bind(client) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(resolveControlPrisma() as object, prop, value);
  },
  has(_target, prop) {
    return Reflect.has(resolveControlPrisma() as object, prop);
  },
});

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
 *
 * SSL — `TENANT_DB_SSLMODE` decide, e é o caminho a usar em qualquer
 * alojamento novo. Valores típicos: `require` (Neon, RDS, qualquer
 * fornecedor gerido) e `disable` (Postgres na mesma rede Docker privada,
 * onde o tráfego não sai do host e não há certificado a gerir).
 *
 * Sem essa variável mantém-se a heurística histórica: hosts não-locais
 * levam `sslmode=require`, hosts locais (localhost/127.x/loopback IPv6)
 * ficam sem. A heurística estava errada precisamente no caso
 * self-hosted — `postgres` é um nome de serviço Docker, não casa com o
 * padrão de "local", e a ligação a TODOS os tenants falhava a negociar
 * TLS contra um servidor que não o tem.
 */
const LOCAL_HOST_REGEX = /^(localhost|127(?:\.\d+){3}|::1|\[::1\])$/i;

export function buildTenantConnectionString(tenant: TenantRecord): string {
  const password = decryptTenantSecret(tenant.dbPassEncrypted);
  const user = encodeURIComponent(tenant.dbUser);
  const pass = encodeURIComponent(password);
  const base = `postgresql://${user}:${pass}@${tenant.dbHost}:${tenant.dbPort}/${tenant.dbName}`;

  const configured = process.env.TENANT_DB_SSLMODE?.trim();
  if (configured) {
    return `${base}?sslmode=${encodeURIComponent(configured)}`;
  }
  return LOCAL_HOST_REGEX.test(tenant.dbHost) ? base : `${base}?sslmode=require`;
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
