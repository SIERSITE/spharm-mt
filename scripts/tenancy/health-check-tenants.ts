/**
 * scripts/tenancy/health-check-tenants.ts
 *
 * Faz `SELECT 1` em cada tenant ACTIVE e actualiza `lastHealthCheckAt`
 * + `lastHealthStatus` no control plane. Em erro, escreve TenantEvent
 * "health_check_failed" para o audit trail.
 *
 * Pensado para correr num cron periódico (ex: cada 5 min).
 *
 * Uso:
 *   npm run tenancy:health
 *   npm run tenancy:health -- --parallel 10
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import pg from "pg";
import {
  controlPrisma,
  buildTenantConnectionString,
  logTenantEvent,
  listTenants,
  type TenantRecord,
} from "@/lib/control-plane";
import { requireControlEnv } from "./_shared";

type Outcome = { slug: string; ok: boolean; error?: string };

async function pingOne(tenant: TenantRecord): Promise<Outcome> {
  const url = buildTenantConnectionString(tenant);
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: { lastHealthCheckAt: new Date(), lastHealthStatus: "ok" },
    });
    return { slug: tenant.slug, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await client.end();
    } catch {}
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: {
        lastHealthCheckAt: new Date(),
        lastHealthStatus: `error: ${msg.slice(0, 200)}`,
      },
    });
    await logTenantEvent({
      tenantId: tenant.id,
      action: "health_check_failed",
      meta: { error: msg },
    });
    return { slug: tenant.slug, ok: false, error: msg };
  }
}

async function runWithLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<Outcome>
): Promise<Outcome[]> {
  const results: Outcome[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  requireControlEnv();

  const { values } = parseArgs({
    options: { parallel: { type: "string", default: "5" } },
    strict: true,
  });
  const parallel = Math.max(1, Number(values.parallel) || 5);

  const tenants = await listTenants({ estado: "ACTIVE" });
  if (tenants.length === 0) {
    console.log("Sem tenants ACTIVE.");
    await controlPrisma.$disconnect();
    return;
  }

  const results = await runWithLimit(tenants, parallel, pingOne);

  console.table(
    results.map((r) => ({
      slug: r.slug,
      status: r.ok ? "ok" : "error",
      error: r.error?.slice(0, 80) ?? "",
    }))
  );

  const failures = results.filter((r) => !r.ok);
  await controlPrisma.$disconnect();
  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length}/${results.length} tenant(s) com falha.`);
    process.exit(1);
  }
  console.log(`\n✓ ${results.length} tenant(s) saudáveis.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
