import "server-only";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  buildTenantConnectionString,
  type TenantRecord,
} from "@/lib/control-plane";

/**
 * lib/admin/tenant-client.ts
 *
 * Constrói (e cacheia em-processo) um PrismaClient por tenant,
 * usado pelo /admin console para ler/escrever cross-tenant. A
 * cache vive enquanto o processo Node estiver vivo — em serverless
 * é por instance, o que é aceitável (cada cold start re-constrói).
 *
 * Mesma estratégia que `lib/integracao/auth.ts` já usa para
 * autenticação do agent, agora promovida a helper partilhado.
 *
 * Importante: este caminho NUNCA passa pelo middleware de browsing
 * nem pelo `resolveCurrentTenantSlug()`. Quem invoca tem de já ter
 * verificado a permissão (`requirePlatformAdmin`) e tem de saber
 * exactamente qual `TenantRecord` quer abrir. Nada de inferência
 * a partir do request.
 */

const cache = new Map<string, PrismaClient>();

export function getTenantPrismaForAdmin(tenant: TenantRecord): PrismaClient {
  const cached = cache.get(tenant.id);
  if (cached) return cached;
  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const client = new PrismaClient({ adapter });
  cache.set(tenant.id, client);
  return client;
}

/**
 * Limpa o cache (útil em testes ou após rotação de credenciais
 * em CLI scripts). Não exposto na UI.
 */
export function __resetAdminTenantClientCache(): void {
  for (const c of cache.values()) {
    c.$disconnect().catch(() => {});
  }
  cache.clear();
}
