/**
 * scripts/jobs/daily-enrich.ts
 *
 * Job diário de enriquecimento do catálogo SPharm.MT.
 *
 * Critérios de selecção:
 *   - verificationStatus = PENDING (nunca verificado)
 *   - OU lastVerifiedAt IS NULL
 *   - OU produtos criados nas últimas 24h (configurável com --hours)
 *
 * Uso:
 *   npx tsx scripts/jobs/daily-enrich.ts
 *   npx tsx scripts/jobs/daily-enrich.ts --limit=200
 *   npx tsx scripts/jobs/daily-enrich.ts --hours=48
 *   npx tsx scripts/jobs/daily-enrich.ts --dry-run
 *
 * Opções:
 *   --limit=N    Número máximo de produtos a processar (default: 100)
 *   --hours=N    Janela de produtos recentes em horas (default: 24)
 *   --dry-run    Simular sem gravar na BD
 */

import "dotenv/config";
import { enrichPendingProducts, type EnrichmentSummary } from "../../lib/catalog-enrichment";
import { legacyPrisma as prisma } from "../../lib/prisma";

// ─── Argumentos ───────────────────────────────────────────────────────────────

function parseArgs(): { limit: number; hours: number; dryRun: boolean } {
  const args = process.argv.slice(2);
  let limit = 100;
  let hours = 24;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) limit = n;
    } else if (arg.startsWith("--hours=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) hours = n;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      console.warn(`[aviso] Argumento desconhecido: ${arg}`);
    }
  }

  return { limit, hours, dryRun };
}

// ─── Relatório ────────────────────────────────────────────────────────────────

function printSummary(summary: EnrichmentSummary, dryRun: boolean): void {
  const label = dryRun ? " [DRY-RUN]" : "";
  const sep = "─".repeat(60);
  console.log(`\n${sep}`);
  console.log(`Job Diário — Enriquecimento${label}`);
  console.log(sep);
  console.log(`  Total processados : ${summary.total}`);
  console.log(`  Verificados       : ${summary.success}`);
  console.log(`  Verificados parc. : ${summary.partial}`);
  console.log(`  Sem dados         : ${summary.failed}`);
  console.log(`  Enviados revisão  : ${summary.queued}`);
  console.log(sep);
  if (dryRun) console.log("\n  Modo dry-run — nenhuma alteração foi gravada.");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { limit, hours, dryRun } = parseArgs();

  console.log("─".repeat(60));
  console.log("SPharm.MT — Job Diário de Enriquecimento");
  console.log("─".repeat(60));
  if (dryRun) console.log("Modo: DRY-RUN");
  console.log(`Limite: ${limit} | Janela: últimas ${hours}h`);
  console.log();

  const summary = await enrichPendingProducts({ limit, dryRun });
  printSummary(summary, dryRun);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
