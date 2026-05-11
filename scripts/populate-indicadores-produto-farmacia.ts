/**
 * scripts/populate-indicadores-produto-farmacia.ts
 *
 * Thin-wrap CLI sobre `runIpfPopulate` (lib/operational/ipf-populate.ts).
 * A orquestração — queries, cálculo via calculator, upsert via raw SQL,
 * summary — vive na lib. Este script parseia argv, resolve o cliente
 * Prisma (legacy ou tenant), instrumenta SyncRun e escreve em stdout.
 *
 * LIVE upsert idempotente — re-executar sobre a mesma BD não dobra
 * dados. `dataCalculo = NOW()` em cada upsert. Bulk de 500 com
 * INSERT ... ON CONFLICT.
 *
 * Uso:
 *   # Dry-run (mostra plano, não escreve):
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts --dry-run
 *
 *   # Live (escreve):
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts
 *
 *   # Live + observabilidade:
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts --record-sync-run
 *
 *   # Tenant-aware:
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts --tenant=castelo
 *
 *   # Filtrar a uma farmácia:
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts --farmacia=<id>
 */

import "dotenv/config";
import { legacyPrisma } from "../lib/prisma";
import type { PrismaClient } from "../generated/prisma/client";
import { runIpfPopulate, type IpfPopulateResult } from "../lib/operational/ipf-populate";

let prisma: PrismaClient = legacyPrisma;
let runId: string | null = null;

type Args = {
  dryRun: boolean;
  tenantSlug: string | null;
  recordSyncRun: boolean;
  farmaciaId: string | null;
  paradoThresholdDays: number;
};

function parseArgs(): Args {
  const out: Args = {
    dryRun: false,
    tenantSlug: null,
    recordSyncRun: false,
    farmaciaId: null,
    paradoThresholdDays: 90,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
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

function printSummary(res: IpfPopulateResult): void {
  console.log(`\n  Campos populáveis (não-null):`);
  for (const [campo, n] of Object.entries(res.summary.populaveis)) {
    const pct = res.rowsCalculated > 0 ? (n / res.rowsCalculated) * 100 : 0;
    console.log(`    ${campo.padEnd(28)} ${String(n).padStart(6)}  (${pct.toFixed(1)}%)`);
  }
  const abc = res.summary.classificacaoABC;
  console.log(`\n  classificacaoABC: A=${abc.A}  B=${abc.B}  C=${abc.C}  NAO_CLASSIFICADO=${abc.NAO_CLASSIFICADO}`);
  const rot = res.summary.classificacaoRotacao;
  console.log(`  classificacaoRotacao: NORMAL=${rot.NORMAL}  ATENCAO=${rot.ATENCAO}  SEM_ROTACAO=${rot.SEM_ROTACAO}`);
  console.log(`  valorStockParado total: ${res.summary.valorStockParadoTotalEur.toFixed(2)} € em ${res.summary.valorStockParadoCount} produtos`);
}

async function main() {
  const args = parseArgs();
  const t0 = Date.now();

  if (args.tenantSlug) {
    const { getTenantPrismaOrLegacy } = await import("../lib/tenant-registry");
    prisma = await getTenantPrismaOrLegacy(args.tenantSlug);
  }
  const slugForLedger = args.tenantSlug ?? "legacy";

  if (args.recordSyncRun) {
    const { startSyncRun } = await import("../lib/sync/sync-run");
    const handle = await startSyncRun({
      tenantSlug: slugForLedger,
      source: "ipf-populate",
      meta: {
        dryRun: args.dryRun,
        farmaciaId: args.farmaciaId,
        paradoThresholdDays: args.paradoThresholdDays,
      },
    });
    runId = handle.id;
  }

  console.log("─".repeat(78));
  console.log(`Populate IndicadoresProdutoFarmacia (${args.dryRun ? "DRY-RUN" : "LIVE"})`);
  console.log("─".repeat(78));
  console.log(`  tenant:               ${args.tenantSlug ?? "(legacy)"}`);
  console.log(`  farmacia:             ${args.farmaciaId ?? "(todas activas)"}`);
  console.log(`  paradoThresholdDays:  ${args.paradoThresholdDays}`);
  if (runId) console.log(`  syncRunId:            ${runId}`);

  const res = await runIpfPopulate(
    prisma,
    {
      dryRun: args.dryRun,
      farmaciaId: args.farmaciaId,
      paradoThresholdDays: args.paradoThresholdDays,
    },
    (msg) => console.log(msg),
  );

  printSummary(res);

  if (runId) {
    const { completeSyncRun } = await import("../lib/sync/sync-run");
    await completeSyncRun(runId, {
      recordsRead: res.pfRowsCount,
      recordsInserted: res.rowsUpserted,
      recordsFailed: res.rowsFailed,
    });
  }

  console.log(`\n[end] ${args.dryRun ? "DRY-RUN" : "LIVE"} concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  if (res.rowsFailed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error("[fatal]", err);
    if (runId) {
      try {
        const { failSyncRun } = await import("../lib/sync/sync-run");
        await failSyncRun(runId, err);
      } catch (closeErr) {
        console.error("[fatal] failSyncRun também falhou:", closeErr);
      }
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
