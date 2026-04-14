/**
 * scripts/enrich-products.ts
 *
 * Script executável para enriquecimento do catálogo central.
 *
 * Uso:
 *   npx tsx scripts/enrich-products.ts
 *   npx tsx scripts/enrich-products.ts --limit=100
 *   npx tsx scripts/enrich-products.ts --productId=<id>
 *   npx tsx scripts/enrich-products.ts --dry-run
 *   npx tsx scripts/enrich-products.ts --limit=20 --dry-run
 *
 * Opções:
 *   --limit=N       Número máximo de produtos a processar (default: 50)
 *   --productId=X   Processar apenas o produto com este ID
 *   --dry-run       Simular sem gravar nada na BD
 *
 * Requer DATABASE_URL no ambiente (via .env ou variável de shell).
 */

import "dotenv/config";
import {
  enrichProduct,
  enrichPendingProducts,
  type EnrichmentSummary,
} from "../lib/catalog-enrichment";
import { legacyPrisma as prisma } from "../lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// PARSING DE ARGUMENTOS
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(): {
  limit: number;
  productId: string | undefined;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let limit = 50;
  let productId: string | undefined;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) limit = n;
    } else if (arg.startsWith("--productId=")) {
      productId = arg.split("=")[1];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      console.warn(`[aviso] Argumento desconhecido: ${arg}`);
    }
  }

  return { limit, productId, dryRun };
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMATAÇÃO DO RELATÓRIO FINAL
// ─────────────────────────────────────────────────────────────────────────────

function printSummary(summary: EnrichmentSummary, dryRun: boolean): void {
  const label = dryRun ? " [DRY-RUN]" : "";
  console.log(
    `\n${"─".repeat(60)}`
  );
  console.log(`Resumo do enriquecimento${label}`);
  console.log("─".repeat(60));
  console.log(`  Total processados : ${summary.total}`);
  console.log(`  Sucesso completo  : ${summary.success}`);
  console.log(`  Parcial           : ${summary.partial}`);
  console.log(`  Falhou            : ${summary.failed}`);
  console.log(`  Enviados revisão  : ${summary.queued}`);
  console.log("─".repeat(60));

  if (dryRun) {
    console.log("\n⚠  Modo dry-run activo — nenhuma alteração foi gravada.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { limit, productId, dryRun } = parseArgs();

  console.log("─".repeat(60));
  console.log("Pipeline de Enriquecimento do Catálogo Central");
  console.log("─".repeat(60));
  if (dryRun) console.log("Modo: DRY-RUN (sem escrita na BD)");
  if (productId) console.log(`Produto específico: ${productId}`);
  else console.log(`Limite: ${limit} produto(s)`);
  console.log();

  let summary: EnrichmentSummary;

  if (productId) {
    // Processar produto específico
    console.log(`Enriquecendo produto ${productId}...`);
    const result = await enrichProduct(productId, { dryRun });

    summary = {
      total: 1,
      success: result.status === "success" ? 1 : 0,
      partial: result.status === "partial" ? 1 : 0,
      failed: result.status === "failed" ? 1 : 0,
      queued: result.queued ? 1 : 0,
    };

    if (result.fieldsUpdated.length > 0) {
      console.log(`  Campos actualizados: ${result.fieldsUpdated.join(", ")}`);
    }
  } else {
    // Processar lote de produtos pendentes
    summary = await enrichPendingProducts({ limit, dryRun });
  }

  printSummary(summary, dryRun);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
