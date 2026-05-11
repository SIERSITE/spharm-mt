/**
 * scripts/jobs/refresh-ipf.ts
 *
 * Scheduler-ready wrapper para o populate de
 * `IndicadoresProdutoFarmacia`. Foi desenhado para ser chamado por
 * um scheduler externo (Vercel Cron, Railway worker, etc.) sem
 * acoplamento — actualmente sem cron real.
 *
 * Política:
 *   · Sem `--all-tenants` ou `--tenant=<slug>`: corre o populate
 *     contra a BD legacy (a mesma que `DATABASE_URL` aponta).
 *   · Com `--tenant=<slug>`: passa o slug ao populate para resolução
 *     via control plane (precisa de CONTROL_DATABASE_URL).
 *   · Com `--all-tenants`: itera todos os tenants ACTIVE do control
 *     plane (precisa de CONTROL_DATABASE_URL); falha rápido se a
 *     env não estiver definida.
 *   · `--record-sync-run` propaga-se para o populate.
 *   · `--dry-run` propaga-se para o populate.
 *
 * Não duplica lógica de cálculo. Spawn do
 * `populate-indicadores-produto-farmacia.ts` como child process
 * (mesma sandbox, output streamed).
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
import { spawn } from "node:child_process";
import * as path from "node:path";

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

const POPULATE_SCRIPT = path.resolve("scripts/populate-indicadores-produto-farmacia.ts");

function buildPopulateArgs(args: Args, overrideTenantSlug?: string): string[] {
  const out: string[] = [];
  if (args.dryRun) out.push("--dry-run");
  if (args.recordSyncRun) out.push("--record-sync-run");
  if (args.farmaciaId) out.push(`--farmacia=${args.farmaciaId}`);
  if (args.paradoThresholdDays !== null) out.push(`--parado-threshold=${args.paradoThresholdDays}`);
  const slug = overrideTenantSlug ?? args.tenantSlug;
  if (slug) out.push(`--tenant=${slug}`);
  return out;
}

type PopulateResult = { exitCode: number; elapsedMs: number };

function runPopulate(populateArgs: string[]): Promise<PopulateResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", POPULATE_SCRIPT, ...populateArgs], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, elapsedMs: Date.now() - t0 });
    });
  });
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
    const summary = await forEachActiveTenant(
      async ({ tenant }) => {
        console.log(`\n──── tenant=${tenant.slug} (${tenant.nome}) ────`);
        const res = await runPopulate(buildPopulateArgs(args, tenant.slug));
        if (res.exitCode !== 0) {
          throw new Error(
            `populate exit code ${res.exitCode} para tenant ${tenant.slug} ` +
              `(elapsed ${(res.elapsedMs / 1000).toFixed(1)}s)`,
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
  const res = await runPopulate(buildPopulateArgs(args));
  const elapsedTotal = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "─".repeat(78));
  console.log(`refresh-ipf concluído. exitCode=${res.exitCode} elapsed=${elapsedTotal}s`);
  if (res.exitCode !== 0) process.exit(res.exitCode);
}

main().catch((e) => {
  console.error("[fatal]", e instanceof Error ? e.message : e);
  process.exit(1);
});
