/**
 * scripts/release-metrics.ts
 *
 * Snapshot read-only do estado do catálogo após uma corrida de
 * enriquecimento/reverificação. Usar entre lotes para confirmar tendência
 * (especialmente: redução de NEEDS_REVIEW e FilaRevisao PENDENTE).
 *
 * Não escreve nada na BD.
 *
 * Saída:
 *   · Total não-INATIVO + total cataloguable (cnp > 2.000.000) + internos excluídos
 *   · Breakdown por verificationStatus no universo cataloguable
 *   · FilaRevisao por estado + check de duplicados PENDENTE
 *
 * Uso:
 *   npx tsx scripts/release-metrics.ts
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import { MIN_CATALOGUABLE_CNP } from "../lib/catalog-enrichment";

function pct(part: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const sep = "─".repeat(70);
  console.log(sep);
  console.log("Release metrics — snapshot do catálogo");
  console.log(`MIN_CATALOGUABLE_CNP = ${MIN_CATALOGUABLE_CNP.toLocaleString("pt-PT")}`);
  console.log(sep);

  const cataloguableWhere = {
    estado: { not: "INATIVO" as const },
    cnp: { gt: MIN_CATALOGUABLE_CNP },
  };
  const allActiveWhere = { estado: { not: "INATIVO" as const } };

  const [totalAll, totalCataloguable, byStatus, filaByEstado, dupCheck] =
    await Promise.all([
      prisma.produto.count({ where: allActiveWhere }),
      prisma.produto.count({ where: cataloguableWhere }),
      prisma.produto.groupBy({
        by: ["verificationStatus"],
        where: cataloguableWhere,
        _count: { _all: true },
      }),
      prisma.filaRevisao.groupBy({
        by: ["estado"],
        _count: { _all: true },
      }),
      prisma.filaRevisao.groupBy({
        by: ["produtoId"],
        where: { estado: "PENDENTE" },
        _count: { _all: true },
        having: { produtoId: { _count: { gt: 1 } } },
      }),
    ]);

  const internalExcluded = totalAll - totalCataloguable;

  console.log(`Produtos activos (estado != INATIVO) : ${totalAll.toLocaleString("pt-PT")}`);
  console.log(`  cataloguable (cnp > limite)        : ${totalCataloguable.toLocaleString("pt-PT")}`);
  console.log(`  internos / ERP (excluídos)         : ${internalExcluded.toLocaleString("pt-PT")}`);
  console.log();

  console.log("Verificação no universo cataloguable:");
  const sortedStatuses = ["PENDING", "VERIFIED", "PARTIALLY_VERIFIED", "NEEDS_REVIEW", "FAILED"];
  const statusMap = new Map<string, number>();
  for (const row of byStatus) {
    statusMap.set(String(row.verificationStatus), row._count._all);
  }
  for (const status of sortedStatuses) {
    const n = statusMap.get(status) ?? 0;
    console.log(`  ${status.padEnd(20)} : ${String(n).padStart(7)}  (${pct(n, totalCataloguable)})`);
  }
  // Qualquer status não previsto.
  for (const [status, n] of statusMap) {
    if (!sortedStatuses.includes(status)) {
      console.log(`  ${status.padEnd(20)} : ${String(n).padStart(7)}  (${pct(n, totalCataloguable)})`);
    }
  }
  console.log();

  console.log("FilaRevisao por estado:");
  for (const row of filaByEstado) {
    console.log(`  ${String(row.estado).padEnd(20)} : ${String(row._count._all).padStart(7)}`);
  }
  console.log();

  console.log(`Produtos com PENDENTE duplicado em FilaRevisao: ${dupCheck.length}`);
  if (dupCheck.length > 0) {
    console.warn("  [aviso] dedup ainda não foi aplicado ou regrediu");
  }

  console.log(sep);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
