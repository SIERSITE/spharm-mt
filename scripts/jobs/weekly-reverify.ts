/**
 * scripts/jobs/weekly-reverify.ts
 *
 * Job semanal de reverificação do catálogo SPharm.MT.
 *
 * Critérios de selecção (qualquer condição):
 *   - Não verificado há mais de --days dias (default: 30)
 *   - OU classificado como OUTRO (tipo inconclusivo — pode melhorar)
 *   - OU productTypeConfidence < --min-confidence (default: 0.75)
 *   - OU imagemUrl em falta
 *   - OU classificationVersion diferente da versão actual das regras
 *
 * Uso:
 *   npx tsx scripts/jobs/weekly-reverify.ts
 *   npx tsx scripts/jobs/weekly-reverify.ts --limit=1000
 *   npx tsx scripts/jobs/weekly-reverify.ts --days=14
 *   npx tsx scripts/jobs/weekly-reverify.ts --min-confidence=0.80
 *   npx tsx scripts/jobs/weekly-reverify.ts --dry-run
 *
 * Opções:
 *   --limit=N              Máximo de produtos a processar (default: 500)
 *   --days=N               Produtos não verificados há mais de N dias (default: 30)
 *   --min-confidence=F     Reclassificar produtos com confiança < F (default: 0.75)
 *   --skip-version-check   Não incluir produtos com versão de classificação antiga
 *   --dry-run              Simular sem gravar na BD
 */

import "dotenv/config";
import { reverifyProducts, type EnrichmentSummary } from "../../lib/catalog-enrichment";
import { legacyPrisma as prisma } from "../../lib/prisma";

// ─── Argumentos ───────────────────────────────────────────────────────────────

function parseArgs(): {
  limit: number;
  days: number;
  minConfidence: number;
  skipVersionCheck: boolean;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let limit = 500;
  let days = 30;
  let minConfidence = 0.75;
  let skipVersionCheck = false;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) limit = n;
    } else if (arg.startsWith("--days=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) days = n;
    } else if (arg.startsWith("--min-confidence=")) {
      const f = parseFloat(arg.split("=")[1]);
      if (!isNaN(f) && f > 0 && f <= 1) minConfidence = f;
    } else if (arg === "--skip-version-check") {
      skipVersionCheck = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      console.warn(`[aviso] Argumento desconhecido: ${arg}`);
    }
  }

  return { limit, days, minConfidence, skipVersionCheck, dryRun };
}

// ─── Relatório ────────────────────────────────────────────────────────────────

function printSummary(summary: EnrichmentSummary, dryRun: boolean, params: {
  days: number; minConfidence: number; skipVersionCheck: boolean
}): void {
  const label = dryRun ? " [DRY-RUN]" : "";
  const sep = "─".repeat(60);
  console.log(`\n${sep}`);
  console.log(`Job Semanal — Reverificação${label}`);
  console.log(sep);
  console.log(`  Critérios activos:`);
  console.log(`    Não verificados há > ${params.days} dias`);
  console.log(`    Tipo OUTRO`);
  console.log(`    Confiança < ${(params.minConfidence * 100).toFixed(0)}%`);
  console.log(`    Sem imagem`);
  if (!params.skipVersionCheck) console.log(`    Versão de classificação desactualizada`);
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
  const { limit, days, minConfidence, skipVersionCheck, dryRun } = parseArgs();

  console.log("─".repeat(60));
  console.log("SPharm.MT — Job Semanal de Reverificação");
  console.log("─".repeat(60));
  if (dryRun) console.log("Modo: DRY-RUN");
  console.log(`Limite: ${limit} | Cutoff: ${days} dias | Min. confiança: ${(minConfidence * 100).toFixed(0)}%`);
  console.log();

  const summary = await reverifyProducts({
    criteria: {
      notVerifiedDays: days,
      lowConfidenceThreshold: minConfidence,
      includeOutdatedVersion: !skipVersionCheck,
      limit,
    },
    dryRun,
  });

  printSummary(summary, dryRun, { days, minConfidence, skipVersionCheck });

  await prisma.$disconnect();
}

main().catch(err => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
