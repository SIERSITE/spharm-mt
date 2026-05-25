/**
 * scripts/reprocess-ingest-produto-mapping.ts
 *
 * Re-resolve `IngestVendaLinhaRaw.produtoId` a partir do mapeamento
 * CORRECTO por-farmácia em `ProdutoFarmacia(farmaciaId, externalProductId)`.
 *
 * Contexto: o /sales-lines (e /stock) antigos resolviam o produtoId pelo
 * `Produto.externalProductId` GLOBAL (last-writer). Como o CodigoID é um
 * namespace por-farmácia, as vendas da farmácia cujo CodigoID não era o
 * guardado ficaram ORFÃS (produtoId NULL) ou MIS-ATRIBUÍDAS (produtoId do
 * produto errado). Este script corrige as linhas JÁ ingeridas — não é
 * preciso re-enviar do agent (o raw está guardado).
 *
 * Faz duas passagens idempotentes:
 *   1. SET produtoId = PF.produtoId  onde existe PF(farmacia, extId) e difere.
 *      (resolve orfãs + corrige mis-atribuições)
 *   2. SET produtoId = NULL  onde NÃO existe PF(farmacia, extId) mas está set.
 *      (remove atribuições falsas de produtos fora do catálogo da farmácia)
 *
 * Depois é preciso RE-AGREGAR a VendaMensal dos meses afectados:
 *   npx tsx scripts/aggregate-vendamensal.ts --tenant <slug> --month YYYY-MM --write --allow-unknowns --allow-orphans
 *
 * Uso:
 *   npx tsx scripts/reprocess-ingest-produto-mapping.ts --tenant grupo-silveira --dry-run
 *   npx tsx scripts/reprocess-ingest-produto-mapping.ts --tenant grupo-silveira
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolvedPfCteAll } from "@/lib/aggregate/resolve-produto";

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }
  const dryRun = values["dry-run"] ?? false;

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe no control plane.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant "${values.tenant}" em estado ${tenant.estado}.`);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  try {
    console.log(`─ tenant: ${tenant.slug} (${dryRun ? "DRY-RUN" : "WRITE"})`);

    const before = await prisma.ingestVendaLinhaRaw.count();
    const orphanBefore = await prisma.ingestVendaLinhaRaw.count({ where: { produtoId: null } });
    console.log(`  raw lines: ${before}  produtoId NULL (antes): ${orphanBefore}`);

    // Quantas linhas mudariam na passagem 1 (resolve/corrige via PF)?
    const willFix = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      WITH ${resolvedPfCteAll()}
      SELECT COUNT(*) AS n
      FROM "IngestVendaLinhaRaw" r
      JOIN resolved_pf pf
        ON pf."farmaciaId" = r."farmaciaId" AND pf."externalProductId" = r."externalProductId"
      WHERE r."produtoId" IS DISTINCT FROM pf."produtoId"`);
    // Quantas seriam des-atribuídas na passagem 2 (sem PF na farmácia)?
    const willNull = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS n
      FROM "IngestVendaLinhaRaw" r
      WHERE r."produtoId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ProdutoFarmacia" pf
          WHERE pf."farmaciaId" = r."farmaciaId" AND pf."externalProductId" = r."externalProductId"
        )`);
    console.log(`  passagem 1 (resolve/corrige via PF): ${Number(willFix[0].n)} linhas`);
    console.log(`  passagem 2 (des-atribui sem PF)     : ${Number(willNull[0].n)} linhas`);

    if (dryRun) {
      console.log("\nDRY-RUN — nada escrito. Re-corre sem --dry-run para aplicar.");
      return;
    }

    const r1 = await prisma.$executeRaw(Prisma.sql`
      WITH ${resolvedPfCteAll()}
      UPDATE "IngestVendaLinhaRaw" r
      SET "produtoId" = pf."produtoId"
      FROM resolved_pf pf
      WHERE pf."farmaciaId" = r."farmaciaId" AND pf."externalProductId" = r."externalProductId"
        AND r."produtoId" IS DISTINCT FROM pf."produtoId"`);
    console.log(`  ✓ passagem 1: ${r1} linhas resolvidas/corrigidas`);

    const r2 = await prisma.$executeRaw(Prisma.sql`
      UPDATE "IngestVendaLinhaRaw" r
      SET "produtoId" = NULL
      WHERE r."produtoId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ProdutoFarmacia" pf
          WHERE pf."farmaciaId" = r."farmaciaId" AND pf."externalProductId" = r."externalProductId"
        )`);
    console.log(`  ✓ passagem 2: ${r2} linhas des-atribuídas (orphan correcto)`);

    const orphanAfter = await prisma.ingestVendaLinhaRaw.count({ where: { produtoId: null } });
    console.log(`\n  produtoId NULL (depois): ${orphanAfter}  (antes: ${orphanBefore})`);
    console.log("\nPróximo passo OBRIGATÓRIO: re-agregar VendaMensal dos meses afectados,");
    console.log("  ex (loop 2024-01..2026-05):");
    console.log(`    npx tsx scripts/aggregate-vendamensal.ts --tenant ${tenant.slug} --month YYYY-MM --write --allow-unknowns --allow-orphans`);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
