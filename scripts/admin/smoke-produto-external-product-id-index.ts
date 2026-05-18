/**
 * scripts/admin/smoke-produto-external-product-id-index.ts
 *
 * Smoke pós-migration drop_produto_external_product_id_unique:
 *   · Confirma que `Produto_externalProductId_key` foi removido
 *   · Confirma que `Produto_externalProductId_idx` existe (não-unique)
 *   · Confirma que `Produto.cnp_key` continua intacto
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

  const idx = await tp.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname='public'
      AND tablename='Produto'
      AND indexname IN ('Produto_externalProductId_key', 'Produto_externalProductId_idx', 'Produto_cnp_key')
    ORDER BY indexname
  `;

  console.log("indexes on Produto:");
  for (const i of idx) console.log(`  ${i.indexname}\n    ${i.indexdef}`);

  const oldKey = idx.find((i) => i.indexname === "Produto_externalProductId_key");
  const newIdx = idx.find((i) => i.indexname === "Produto_externalProductId_idx");
  const cnpKey = idx.find((i) => i.indexname === "Produto_cnp_key");
  if (oldKey) throw new Error("FAIL: Produto_externalProductId_key ainda existe");
  if (!newIdx) throw new Error("FAIL: Produto_externalProductId_idx em falta");
  if (!cnpKey) throw new Error("FAIL: Produto_cnp_key em falta (regression!)");
  if (/UNIQUE/i.test(newIdx.indexdef)) throw new Error("FAIL: Produto_externalProductId_idx ainda é UNIQUE");

  // Sanity: catálogo continua intacto
  const total = await tp.produto.count();
  const distinctExt = await tp.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(DISTINCT "externalProductId")::bigint AS n
    FROM "Produto" WHERE "externalProductId" IS NOT NULL
  `;
  console.log(`Produto total=${total}  distinct externalProductId (non-null)=${distinctExt[0].n}`);
  console.log("OK");

  await tp.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
