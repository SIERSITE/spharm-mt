/**
 * scripts/tenancy/migrate-all-tenants.ts
 *
 * Aplica `prisma migrate deploy` da schema tenant (prisma/schema.prisma)
 * a todos os tenants ACTIVE. Paralelo com concurrency limit.
 *
 * Uso:
 *   npm run tenancy:migrate-all
 *   npm run tenancy:migrate-all -- --parallel 5
 *   npm run tenancy:migrate-all -- --only farmacias-braga,farmacias-porto
 *   npm run tenancy:migrate-all -- --dry-run     (corre migrate status)
 *
 * Política de falha:
 *   Não aborta o batch no primeiro erro. Tenta todos, reporta no fim,
 *   exit code ≠ 0 se algum falhou. Cada falha regista "migration_failed"
 *   em TenantEvent.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  buildTenantConnectionString,
  logTenantEvent,
  listTenants,
  type TenantRecord,
} from "@/lib/control-plane";
import { requireControlEnv, runPrismaForTenant, getLatestMigrationName } from "./_shared";

type Outcome = {
  slug: string;
  status: "ok" | "error" | "skipped";
  detail?: string;
};

async function migrateOne(tenant: TenantRecord, dryRun: boolean): Promise<Outcome> {
  const url = buildTenantConnectionString(tenant);
  const args = dryRun
    ? ["migrate", "status", "--schema", "prisma/schema.prisma"]
    : ["migrate", "deploy", "--schema", "prisma/schema.prisma"];

  const r = runPrismaForTenant(args, url);

  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").slice(-400).trim();
    if (!dryRun) {
      await logTenantEvent({
        tenantId: tenant.id,
        action: "migration_failed",
        meta: { exitCode: r.status, stderr: detail },
      });
    }
    return { slug: tenant.slug, status: "error", detail };
  }

  if (!dryRun) {
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: {
        lastMigratedAt: new Date(),
        schemaVersion: getLatestMigrationName(),
      },
    });
    await logTenantEvent({
      tenantId: tenant.id,
      action: "migrated",
      meta: { schemaVersion: getLatestMigrationName() },
    });
  }

  return { slug: tenant.slug, status: "ok" };
}

/** Pool de concorrência mínimo, sem deps. */
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
    options: {
      only: { type: "string" },
      parallel: { type: "string", default: "3" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });

  const parallel = Math.max(1, Number(values.parallel) || 3);
  const dryRun = values["dry-run"] ?? false;
  const onlySlugs = values.only ? values.only.split(",").map((s) => s.trim()).filter(Boolean) : null;

  let tenants = await listTenants({ estado: "ACTIVE" });
  if (onlySlugs) {
    tenants = tenants.filter((t) => onlySlugs.includes(t.slug));
  }
  if (tenants.length === 0) {
    console.log("Sem tenants ACTIVE (ou --only não bateu). Nada a fazer.");
    await controlPrisma.$disconnect();
    return;
  }

  console.log(
    `▶ A ${dryRun ? "verificar status" : "migrar"} ${tenants.length} tenant(s) com parallel=${parallel}…`
  );

  const results = await runWithLimit(tenants, parallel, (t) => migrateOne(t, dryRun));

  console.log("\n── Resultados ──");
  console.table(
    results.map((r) => ({
      slug: r.slug,
      status: r.status,
      detail: r.detail?.slice(0, 80) ?? "",
    }))
  );

  const errors = results.filter((r) => r.status === "error");
  await controlPrisma.$disconnect();
  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} tenant(s) falharam.`);
    process.exit(1);
  }
  console.log(`\n✓ ${results.length} tenant(s) processados com sucesso.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
