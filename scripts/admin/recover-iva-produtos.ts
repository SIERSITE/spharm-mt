/**
 * scripts/admin/recover-iva-produtos.ts
 *
 * Executa o pipeline de recuperação da taxa IVA por ProdutoFarmacia
 * num tenant. Imprime cobertura antes/depois, distribuição por
 * taxa, cobertura por farmácia, fonte usada e linhas actualizadas.
 *
 * Idempotente. Por defeito é DRY-RUN — não toca na BD. Aplica com
 * `--apply`.
 *
 * Usage:
 *   # dry-run (default):
 *   npx tsx scripts/admin/recover-iva-produtos.ts --slug=grupo-silveira
 *
 *   # apply (escreve em ProdutoFarmacia):
 *   npx tsx scripts/admin/recover-iva-produtos.ts --slug=grupo-silveira --apply
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import {
  getTenantBySlug,
  buildTenantConnectionString,
  controlPrisma,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  recoverIvaForTenant,
  TAXA_IVA_SOURCE_LABELS,
  type TaxaIvaSource,
} from "@/lib/iva-recovery";

function pct(n: number, total: number): string {
  if (total === 0) return "0,0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      apply: { type: "boolean" },
    },
  });
  const slug = values.slug;
  const apply = values.apply ?? false;
  if (!slug) {
    console.error("Usage: --slug=<tenant-slug> [--apply]");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`tenant ${slug} not found`);
    process.exit(1);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  console.log(
    `\n=== Recuperação IVA — tenant=${slug} · modo=${apply ? "APPLY" : "DRY-RUN"} ===\n`,
  );

  // Cobertura ANTES (snapshot pré-pipeline)
  const before = await prisma.$queryRawUnsafe<
    Array<{ resolvidas: bigint; total: bigint }>
  >(`
    SELECT
      COUNT(*) FILTER (WHERE "taxaIvaPercent" IS NOT NULL)::bigint AS resolvidas,
      COUNT(*)::bigint AS total
    FROM "ProdutoFarmacia"
    WHERE "flagRetirado" = false
  `);
  const beforeRes = Number(before[0].resolvidas);
  const beforeTot = Number(before[0].total);
  console.log(
    `Cobertura ANTES: ${beforeRes}/${beforeTot} = ${pct(beforeRes, beforeTot)}\n`,
  );

  // Pipeline
  const result = await recoverIvaForTenant(prisma, { apply });

  // ── Distribuição ─────────────────────────────────────────────
  console.log("Distribuição por taxa:");
  for (const d of result.distribuicao) {
    const label = d.taxa === null ? "IVA por apurar" : `IVA ${d.taxa}%`;
    console.log(
      `  ${label.padEnd(18)} ${String(d.n).padStart(6)}  (${pct(d.n, result.universo)})`,
    );
  }

  // ── Por fonte ─────────────────────────────────────────────────
  console.log("\nResolução por fonte (prioridade decrescente):");
  for (const f of result.porFonte) {
    const label = TAXA_IVA_SOURCE_LABELS[f.source];
    console.log(
      `  ${label.padEnd(22)} ${String(f.n).padStart(6)}  (${pct(f.n, result.universo)})`,
    );
  }
  const naoResolvidas = result.universo - result.resolvidas;
  console.log(
    `  ${"(IVA por apurar)".padEnd(22)} ${String(naoResolvidas).padStart(6)}  (${pct(naoResolvidas, result.universo)})`,
  );

  // ── Por farmácia ──────────────────────────────────────────────
  console.log("\nCobertura por farmácia:");
  console.log("  farmácia                       total  resolv.  por apurar  %");
  for (const f of result.porFarmacia) {
    console.log(
      `  ${f.farmacia.padEnd(30)} ${String(f.total).padStart(5)}  ${String(f.resolvidas).padStart(7)}  ${String(f.porApurar).padStart(10)}  ${String(f.pct).padStart(5)}%`,
    );
  }

  // ── Resumo final ──────────────────────────────────────────────
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(
    `Cobertura FINAL: ${result.resolvidas}/${result.universo} = ${pct(result.resolvidas, result.universo)}`,
  );
  console.log(`Ganho vs antes:  +${result.resolvidas - beforeRes} linhas`);
  if (apply) {
    console.log(`Linhas actualizadas em BD: ${result.rowsUpdated}`);
  } else {
    console.log(
      `(DRY-RUN: nada foi escrito. Use --apply para persistir.)`,
    );
  }
  console.log("──────────────────────────────────────────────────────────\n");

  await prisma.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Tipo re-exportado só para tooling externo, se quiser referir os tokens.
export type { TaxaIvaSource };
