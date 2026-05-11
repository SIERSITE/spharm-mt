/**
 * scripts/jobs/refresh-ipf.ts
 *
 * Scheduler-ready wrapper para o populate de
 * `IndicadoresProdutoFarmacia`. Pode ser invocado por:
 *   · CLI (`npx tsx scripts/jobs/refresh-ipf.ts`)
 *   · scheduler externo (Railway worker, container cron, etc.)
 *
 * O endpoint serverless `/api/jobs/refresh-ipf` é o entry-point para
 * Vercel Cron — chama directamente `runIpfPopulate` da lib, não passa
 * por aqui. Ambos partilham a mesma orquestração canónica.
 *
 * Política:
 *   · Sem `--all-tenants` ou `--tenant=<slug>`: corre o populate
 *     contra a BD legacy (a mesma que `DATABASE_URL` aponta).
 *   · Com `--tenant=<slug>`: resolve via control plane (precisa de
 *     CONTROL_DATABASE_URL).
 *   · Com `--all-tenants`: itera todos os tenants ACTIVE do control
 *     plane (precisa de CONTROL_DATABASE_URL); falha rápido se a env
 *     não estiver definida.
 *   · `--record-sync-run` escreve uma linha por execução em SyncRun.
 *   · `--dry-run` calcula tudo mas não escreve.
 *   · Após o populate (modo single), corre health check e devolve
 *     exit-code != 0 se o read-model continuar unhealthy.
 *
 * Não duplica lógica de cálculo — invoca in-process
 * `runIpfPopulate(prisma, opts)` da lib.
 *
 * Uso:
 *   # Legacy (uma BD)
 *   npx tsx scripts/jobs/refresh-ipf.ts
 *
 *   # Dry-run
 *   npx tsx scripts/jobs/refresh-ipf.ts --dry-run
 *
 *   # Um tenant específico
 *   npx tsx scripts/jobs/refresh-ipf.ts --tenant=demo --record-sync-run
 *
 *   # Todos os tenants ACTIVE (requer CONTROL_DATABASE_URL)
 *   npx tsx scripts/jobs/refresh-ipf.ts --all-tenants --record-sync-run
 */

import "dotenv/config";
import { legacyPrisma } from "../../lib/prisma";
import type { PrismaClient } from "../../generated/prisma/client";
import { runIpfPopulate, type IpfPopulateResult } from "../../lib/operational/ipf-populate";
import { getIpfFreshness } from "../../lib/operational/ipf-freshness";

type Args = {
  dryRun: boolean;
  tenantSlug: string | null;
  allTenants: boolean;
  recordSyncRun: boolean;
  paradoThresholdDays: number | null;
  farmaciaId: string | null;
};

function parseArgs(): Args {
  const out: Args = {
    dryRun: false,
    tenantSlug: null,
    allTenants: false,
    recordSyncRun: false,
    paradoThresholdDays: null,
    farmaciaId: null,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--all-tenants") out.allTenants = true;
    else if (a === "--record-sync-run") out.recordSyncRun = true;
    else if (a.startsWith("--tenant=")) out.tenantSlug = a.split("=")[1] ?? null;
    else if (a.startsWith("--farmacia=")) out.farmaciaId = a.split("=")[1] ?? null;
    else if (a.startsWith("--parado-threshold=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0) out.paradoThresholdDays = n;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

/**
 * Corre populate + health check para um único PrismaClient
 * (legacy/tenant). Devolve `{ ok, result }` para o caller decidir
 * exit code / agregação multi-tenant.
 */
async function runForPrisma(
  prisma: PrismaClient,
  args: Args,
  tenantSlugForLedger: string,
): Promise<{ ok: boolean; result: IpfPopulateResult }> {
  let runId: string | null = null;
  if (args.recordSyncRun) {
    const { startSyncRun } = await import("../../lib/sync/sync-run");
    const handle = await startSyncRun({
      tenantSlug: tenantSlugForLedger,
      source: "ipf-populate",
      meta: {
        dryRun: args.dryRun,
        farmaciaId: args.farmaciaId,
        paradoThresholdDays: args.paradoThresholdDays ?? 90,
        invokedBy: "refresh-ipf-wrapper",
      },
    });
    runId = handle.id;
    console.log(`  syncRunId: ${runId}`);
  }

  let result: IpfPopulateResult;
  try {
    result = await runIpfPopulate(
      prisma,
      {
        dryRun: args.dryRun,
        farmaciaId: args.farmaciaId,
        paradoThresholdDays: args.paradoThresholdDays ?? 90,
      },
      (msg) => console.log(msg),
    );
  } catch (err) {
    if (runId) {
      const { failSyncRun } = await import("../../lib/sync/sync-run");
      await failSyncRun(runId, err);
    }
    throw err;
  }

  if (runId) {
    const { completeSyncRun } = await import("../../lib/sync/sync-run");
    await completeSyncRun(runId, {
      recordsRead: result.pfRowsCount,
      recordsInserted: result.rowsUpserted,
      recordsFailed: result.rowsFailed,
    });
  }

  // Health post-check (não corre em dry-run — dataCalculo não foi tocado).
  if (!args.dryRun) {
    const fresh = await getIpfFreshness(prisma);
    console.log(
      `  health: coverage=${(fresh.coverage * 100).toFixed(2)}% age=${fresh.ageHours?.toFixed(1) ?? "—"}h ` +
        `healthy=${fresh.healthy}`,
    );
    if (!fresh.healthy) {
      for (const r of fresh.reasons) console.log(`    · ${r}`);
      return { ok: false, result };
    }
  }
  return { ok: result.rowsFailed === 0, result };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const t0 = Date.now();

  console.log("─".repeat(78));
  console.log(`refresh-ipf wrapper (${args.dryRun ? "DRY-RUN" : "LIVE"})`);
  console.log("─".repeat(78));
  console.log(`  mode:             ${args.allTenants ? "all-tenants" : args.tenantSlug ? `tenant=${args.tenantSlug}` : "legacy"}`);
  console.log(`  dryRun:           ${args.dryRun}`);
  console.log(`  recordSyncRun:    ${args.recordSyncRun}`);
  if (args.farmaciaId) console.log(`  farmacia:         ${args.farmaciaId}`);
  if (args.paradoThresholdDays !== null) console.log(`  paradoThreshold:  ${args.paradoThresholdDays}d`);

  // ── Path 1: --all-tenants ──────────────────────────────────────────────
  if (args.allTenants) {
    if (!process.env.CONTROL_DATABASE_URL) {
      console.error(
        "\n[fatal] --all-tenants requer CONTROL_DATABASE_URL configurado. " +
          "Define no .env ou usa --tenant=<slug> / sem flag (legacy).",
      );
      process.exit(2);
    }

    const { forEachActiveTenant } = await import("../../lib/tenancy/for-each-tenant");
    const { getTenantPrismaOrLegacy } = await import("../../lib/tenant-registry");
    const summary = await forEachActiveTenant(
      async ({ tenant }) => {
        console.log(`\n──── tenant=${tenant.slug} (${tenant.nome}) ────`);
        const tenantPrisma = await getTenantPrismaOrLegacy(tenant.slug);
        const { ok, result } = await runForPrisma(tenantPrisma, args, tenant.slug);
        if (!ok) {
          throw new Error(
            `populate/health falhou para tenant ${tenant.slug} ` +
              `(upserted=${result.rowsUpserted} failed=${result.rowsFailed})`,
          );
        }
      },
      { onProgress: (msg) => console.log(`[for-each-tenant] ${msg}`) },
    );

    console.log("\n" + "─".repeat(78));
    console.log(`refresh-ipf concluído. total=${summary.total} succeeded=${summary.succeeded} failed=${summary.failed} elapsed=${(summary.durationMs / 1000).toFixed(1)}s`);
    if (summary.failed > 0) {
      console.error(`\n[erro] ${summary.failed} tenants falharam:`);
      for (const f of summary.failures) console.error(`  - ${f.slug}: ${f.error}`);
      process.exit(1);
    }
    return;
  }

  // ── Path 2: single tenant ou legacy ────────────────────────────────────
  let prisma: PrismaClient = legacyPrisma;
  let slugForLedger = "legacy";
  if (args.tenantSlug) {
    const { getTenantPrismaOrLegacy } = await import("../../lib/tenant-registry");
    prisma = await getTenantPrismaOrLegacy(args.tenantSlug);
    slugForLedger = args.tenantSlug;
  }

  try {
    const { ok, result } = await runForPrisma(prisma, args, slugForLedger);
    const elapsedTotal = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("\n" + "─".repeat(78));
    console.log(
      `refresh-ipf concluído. upserted=${result.rowsUpserted} failed=${result.rowsFailed} ok=${ok} elapsed=${elapsedTotal}s`,
    );
    if (!ok) process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[fatal]", e instanceof Error ? e.message : e);
  process.exit(1);
});
