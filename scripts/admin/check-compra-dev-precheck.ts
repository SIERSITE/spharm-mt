/**
 * scripts/admin/check-compra-dev-precheck.ts
 *
 * Pre-flight para migration 1c.1: confirma que demo-neon não tem rows
 * em Compra/Devolucao que conflitam com as novas uniques.
 *
 * Uso: npx tsx scripts/admin/check-compra-dev-precheck.ts demo-neon
 *
 * Saída esperada para luz verde:
 *   · Compra dupes on aggregation key = 0
 *   · Devolucao count irrelevante para externalLineId (todas a NULL)
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
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: npx tsx scripts/admin/check-compra-dev-precheck.ts <slug>");
    process.exit(1);
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`tenant ${slug} not found`);

  const url = buildTenantConnectionString(tenant);
  const tp = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  const compraCount = await tp.compra.count();
  const devCount = await tp.devolucao.count();
  console.log(`tenant=${slug}`);
  console.log(`Compra count   : ${compraCount}`);
  console.log(`Devolucao count: ${devCount}`);

  if (compraCount > 0) {
    const dupes = await tp.$queryRaw<
      Array<{
        farmaciaId: string;
        produtoId: string;
        fornecedorId: string | null;
        data: Date;
        n: bigint;
      }>
    >`
      SELECT "farmaciaId", "produtoId", "fornecedorId", "data", COUNT(*)::bigint AS n
      FROM "Compra"
      GROUP BY "farmaciaId", "produtoId", "fornecedorId", "data"
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 5
    `;
    console.log(`Compra dupes on (farmaciaId,produtoId,fornecedorId,data): ${dupes.length}`);
    if (dupes.length > 0) {
      console.log(JSON.stringify(dupes.map((d) => ({ ...d, n: Number(d.n) })), null, 2));
    }
  }

  await tp.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
