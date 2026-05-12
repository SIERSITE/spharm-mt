/**
 * lib/db-providers/connectivity.ts
 *
 * Smoke connectivity helper — utilitário independente do provider. Faz
 * `SELECT 1` contra uma URL Postgres para validar que credenciais,
 * host, porta e sslmode estão correctos antes de registar o tenant no
 * control plane e tentar correr migrations.
 *
 * Usa o adapter PrismaPg + PrismaClient legado do tenant — mesma stack
 * que será usada por migrations/seed depois. Garante que se isto
 * passa, o resto da pipeline tem boas hipóteses de passar também.
 */

import { PrismaClient as TenantPrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Lança com a mensagem nativa do driver/DB se a conexão falhar. Caller
 * mostra `err.message` ao operador — diagnósticos comuns: sslmode
 * em falta, password errada, role/DB inexistente, network/firewall.
 */
export async function testTenantDbReachable(connectionUrl: string): Promise<void> {
  const adapter = new PrismaPg({ connectionString: connectionUrl });
  const db = new TenantPrismaClient({ adapter });
  try {
    await db.$queryRaw`SELECT 1`;
  } finally {
    await db.$disconnect();
  }
}
