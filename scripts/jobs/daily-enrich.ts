/**
 * scripts/jobs/daily-enrich.ts
 *
 * Job diário de enriquecimento do catálogo SPharm.MT.
 *
 * Critérios de selecção (modo lote):
 *   - verificationStatus = PENDING (nunca verificado)
 *   - OU lastVerifiedAt IS NULL
 *   - OU produtos criados nas últimas 24h (configurável com --hours)
 *
 * Modo CNP (diagnóstico de um produto específico):
 *   --cnp=<n>          Enriquece SÓ este CNP. Útil para reproduzir um caso.
 *   --verbose          Imprime, passo a passo: queries, URLs candidatas,
 *                       extracções (rawBrand/rawCategory/rawProductName),
 *                       matchedBy/confidence e a decisão final.
 *
 * Uso:
 *   npx tsx scripts/jobs/daily-enrich.ts
 *   npx tsx scripts/jobs/daily-enrich.ts --limit=200
 *   npx tsx scripts/jobs/daily-enrich.ts --cnp=7488585 --verbose
 *   npx tsx scripts/jobs/daily-enrich.ts --hours=48
 *   npx tsx scripts/jobs/daily-enrich.ts --dry-run
 */

import "dotenv/config";
import {
  enrichPendingProducts,
  enrichProductByCnp,
  type EnrichmentSummary,
} from "../../lib/catalog-enrichment";
import { legacyPrisma as prisma } from "../../lib/prisma";
import type { EnrichmentTracer, TraceEvent } from "../../lib/catalog-types";

// ─── Argumentos ───────────────────────────────────────────────────────────────

type Args = {
  limit: number;
  hours: number;
  dryRun: boolean;
  cnp: number | null;
  verbose: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let limit = 100;
  let hours = 24;
  let dryRun = false;
  let cnp: number | null = null;
  let verbose = false;

  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) limit = n;
    } else if (arg.startsWith("--hours=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) hours = n;
    } else if (arg.startsWith("--cnp=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) cnp = n;
      else console.warn(`[aviso] CNP inválido: ${arg}`);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else {
      console.warn(`[aviso] Argumento desconhecido: ${arg}`);
    }
  }

  return { limit, hours, dryRun, cnp, verbose };
}

// ─── Tracer verboso (stdout) ─────────────────────────────────────────────────

const SEP = "─".repeat(70);

function fmtTrace(e: TraceEvent): string {
  switch (e.kind) {
    case "stage":
      return `\n[${e.connector}] STAGE ${e.stage}\n  query: ${e.query}`;
    case "search_results":
      return (
        `[${e.connector}] ${e.via} → ${e.urls.length} URL(s)` +
        (e.urls.length > 0 ? "\n  - " + e.urls.join("\n  - ") : "")
      );
    case "candidate":
      return `[${e.connector}] FETCH ${e.httpOk ? "OK " : "FAIL"} ${e.url}${
        e.reason ? ` (${e.reason})` : ""
      }`;
    case "match":
      return (
        `[${e.connector}] MATCH ${e.url}\n` +
        `    cnpInUrl=${e.cnpInUrl}  cnpInPage=${e.cnpInPage}  ` +
        `sim=${e.similarity.toFixed(2)}  matchedBy=${e.matchedBy}  ` +
        `conf=${e.confidence.toFixed(2)}  partial=${e.partial}\n` +
        `    rawBrand=${JSON.stringify(e.rawBrand)}\n` +
        `    rawCategory=${JSON.stringify(e.rawCategory)}\n` +
        `    rawProductName=${JSON.stringify(e.rawProductName)}`
      );
    case "skipped":
      return `[${e.connector}] SKIP ${e.url}\n    reason: ${e.reason}`;
    case "result":
      return `[${e.connector}] RESULT ${e.status}${
        e.reason ? ` — ${e.reason}` : ""
      }`;
  }
}

const verboseTracer: EnrichmentTracer = (event) => {
  console.log(fmtTrace(event));
};

// ─── Relatório ────────────────────────────────────────────────────────────────

function printSummary(summary: EnrichmentSummary, dryRun: boolean): void {
  const label = dryRun ? " [DRY-RUN]" : "";
  console.log(`\n${SEP}`);
  console.log(`Job Diário — Enriquecimento${label}`);
  console.log(SEP);
  console.log(`  Total processados : ${summary.total}`);
  console.log(`  Verificados       : ${summary.success}`);
  console.log(`  Verificados parc. : ${summary.partial}`);
  console.log(`  Sem dados         : ${summary.failed}`);
  console.log(`  Enviados revisão  : ${summary.queued}`);
  console.log(SEP);
  if (dryRun) console.log("\n  Modo dry-run — nenhuma alteração foi gravada.");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { limit, hours, dryRun, cnp, verbose } = parseArgs();

  console.log(SEP);
  console.log("SPharm.MT — Enriquecimento de catálogo");
  console.log(SEP);
  if (dryRun) console.log("Modo: DRY-RUN");
  if (verbose) console.log("Modo: VERBOSE (trace de conectores activado)");

  // ─── Modo single-CNP ────────────────────────────────────────────────────
  if (cnp != null) {
    console.log(`Alvo: CNP ${cnp}`);
    console.log();
    const result = await enrichProductByCnp(cnp, {
      dryRun,
      trace: verbose ? verboseTracer : undefined,
    });
    if (!result) {
      console.error(`[erro] Nenhum Produto encontrado com cnp=${cnp}.`);
      await prisma.$disconnect();
      process.exit(1);
    }
    console.log(`\n${SEP}`);
    console.log("DECISÃO FINAL");
    console.log(SEP);
    console.log(`  productId           : ${result.productId}`);
    console.log(`  cnp                 : ${result.cnp}`);
    console.log(`  productType         : ${result.productType}`);
    console.log(
      `  productTypeConf     : ${(result.productTypeConfidence * 100).toFixed(0)}%`
    );
    console.log(`  verificationStatus  : ${result.verificationStatus}`);
    console.log(`  fieldsUpdated       : ${
      result.fieldsUpdated.length > 0 ? result.fieldsUpdated.join(", ") : "—"
    }`);
    console.log(`  status              : ${result.status}`);
    console.log(`  enviado p/ revisão  : ${result.queued}`);
    console.log(SEP);
    await prisma.$disconnect();
    return;
  }

  // ─── Modo lote ──────────────────────────────────────────────────────────
  console.log(`Limite: ${limit} | Janela: últimas ${hours}h`);
  console.log();
  const summary = await enrichPendingProducts({ limit, dryRun });
  printSummary(summary, dryRun);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
