/**
 * scripts/admin/smoke-compra-dev-aggregation-cols.ts
 *
 * Smoke pós-migration 1c.1: confirma que as colunas + uniques + índices
 * existem em demo-neon. Não escreve dados.
 */
import "dotenv/config";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const slug = process.argv[2] ?? "demo-neon";
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`tenant ${slug} not found`);

  const tp = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  const cols = await tp.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        (table_name = 'Compra'    AND column_name IN ('ingestBatchId','aggregatedAt')) OR
        (table_name = 'Devolucao' AND column_name IN ('externalLineId','ingestBatchId','aggregatedAt'))
      )
    ORDER BY table_name, column_name
  `;
  console.log("columns:");
  for (const c of cols) console.log(`  ${c.table_name}.${c.column_name}`);

  const idx = await tp.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname='public'
      AND indexname IN (
        'Compra_aggregation_key',
        'Devolucao_farmaciaId_externalLineId_key',
        'Compra_ingestBatchId_idx',
        'Compra_aggregatedAt_idx',
        'Devolucao_ingestBatchId_idx',
        'Devolucao_aggregatedAt_idx'
      )
    ORDER BY indexname
  `;
  console.log("indexes:");
  for (const i of idx) console.log(`  ${i.indexname}`);

  if (cols.length !== 5) throw new Error(`expected 5 new columns, got ${cols.length}`);
  if (idx.length !== 6) throw new Error(`expected 6 new indexes, got ${idx.length}`);
  console.log("OK");

  await tp.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
