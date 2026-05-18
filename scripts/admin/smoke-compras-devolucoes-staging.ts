/**
 * scripts/admin/smoke-compras-devolucoes-staging.ts
 *
 * Fase 1b.1 smoke: confirma que a migration
 * 20260518150000_add_compras_devolucoes_staging foi aplicada a um
 * tenant e que as duas staging tables estão acessíveis via Prisma client.
 *
 * Esperado pós-migration (e antes de qualquer upload):
 *   StagingCompraRawLine count                  = 0
 *   StagingDevolucaoFornecedorRawLine count     = 0
 *
 * Uso:
 *   npx tsx scripts/admin/smoke-compras-devolucoes-staging.ts <slug>
 *
 * Read-only. Não escreve nada em qualquer tenant.
 */

import "dotenv/config";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

type IndexRow = { indexname: string; indexdef: string };
type ConstraintRow = { conname: string; contype: string };

async function listIndexes(prisma: PrismaClient, tableName: string): Promise<IndexRow[]> {
  return prisma.$queryRawUnsafe<IndexRow[]>(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = $1
     ORDER BY indexname`,
    tableName
  );
}

async function listConstraints(prisma: PrismaClient, tableName: string): Promise<ConstraintRow[]> {
  return prisma.$queryRawUnsafe<ConstraintRow[]>(
    `SELECT con.conname,
            CASE con.contype
              WHEN 'p' THEN 'PRIMARY KEY'
              WHEN 'u' THEN 'UNIQUE'
              WHEN 'f' THEN 'FOREIGN KEY'
              WHEN 'c' THEN 'CHECK'
              ELSE con.contype::text
            END AS contype
     FROM pg_constraint con
     JOIN pg_class cls ON cls.oid = con.conrelid
     JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = 'public' AND cls.relname = $1
     ORDER BY con.contype, con.conname`,
    tableName
  );
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Uso: npx tsx scripts/admin/smoke-compras-devolucoes-staging.ts <slug>");
    process.exit(1);
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`tenant ${slug} não encontrado`);
    process.exit(1);
  }
  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  let ok = true;
  try {
    // ── Counts (confirma que o modelo Prisma resolve a tabela física) ──
    const compraCount = await prisma.stagingCompraRawLine.count();
    const devCount = await prisma.stagingDevolucaoFornecedorRawLine.count();

    console.log(`[${slug}] StagingCompraRawLine              count = ${compraCount}`);
    console.log(`[${slug}] StagingDevolucaoFornecedorRawLine count = ${devCount}`);

    if (compraCount !== 0 || devCount !== 0) {
      console.warn(
        `[${slug}] AVISO: contagens não-zero pós-migration. Esperado 0/0 para Fase 1b.1.`
      );
    }

    // ── Constraints (PK + UNIQUE + FK) ────────────────────────────────
    console.log("");
    console.log(`[${slug}] StagingCompraRawLine constraints:`);
    for (const c of await listConstraints(prisma, "StagingCompraRawLine")) {
      console.log(`  · ${c.contype.padEnd(12)} ${c.conname}`);
    }
    console.log(`[${slug}] StagingDevolucaoFornecedorRawLine constraints:`);
    for (const c of await listConstraints(prisma, "StagingDevolucaoFornecedorRawLine")) {
      console.log(`  · ${c.contype.padEnd(12)} ${c.conname}`);
    }

    // ── Indexes ───────────────────────────────────────────────────────
    console.log("");
    console.log(`[${slug}] StagingCompraRawLine indexes:`);
    for (const ix of await listIndexes(prisma, "StagingCompraRawLine")) {
      console.log(`  · ${ix.indexname}`);
    }
    console.log(`[${slug}] StagingDevolucaoFornecedorRawLine indexes:`);
    for (const ix of await listIndexes(prisma, "StagingDevolucaoFornecedorRawLine")) {
      console.log(`  · ${ix.indexname}`);
    }
  } catch (err) {
    console.error(
      `[${slug}] FALHA — schema staging não acessível: ${err instanceof Error ? err.message : String(err)}`
    );
    ok = false;
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }

  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
