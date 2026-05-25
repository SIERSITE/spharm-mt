/**
 * scripts/cleanup-noncanonical-stock.ts
 *
 * Zera o stock "stale" atribuído a ProdutoFarmacia NÃO-canónicas de códigos
 * colidentes (externalProductId reciclado entre CNPs). Antes da regra
 * canónica, a resolução last-wins podia gravar o stock de um CodigoID no
 * produto errado; este cleanup remove essa atribuição errada, deixando o
 * stock só na PF canónica (a regra de lib/aggregate/resolve-produto.ts).
 *
 * O VALOR correcto do stock vem do ERP via `stock-upload` (que passa a
 * resolver pelo canónico) — este script só LIMPA o errado; correr o
 * stock-upload a seguir repõe o stock na PF canónica.
 *
 * Determinístico + idempotente (re-correr não muda nada). Dry-run default.
 *
 *   npx tsx scripts/cleanup-noncanonical-stock.ts --tenant grupo-silveira --dry-run
 *   npx tsx scripts/cleanup-noncanonical-stock.ts --tenant grupo-silveira          # aplica
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
    options: { tenant: { type: "string" }, "dry-run": { type: "boolean" } },
    strict: true,
  });
  if (!values.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }
  const dryRun = values["dry-run"] ?? false;

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant em estado ${tenant.estado}.`);
    process.exit(1);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  // Predicado: PF não-canónica de um código colidente, com stock atribuído.
  const targetWhere = Prisma.sql`
    pf."produtoId" <> r."produtoId"
    AND pf."stockAtual" IS NOT NULL
    AND coll."farmaciaId" = pf."farmaciaId" AND coll."externalProductId" = pf."externalProductId"
    AND r."farmaciaId" = pf."farmaciaId" AND r."externalProductId" = pf."externalProductId"`;
  const collCte = Prisma.sql`
    coll AS (
      SELECT "farmaciaId","externalProductId" FROM "ProdutoFarmacia"
      WHERE "externalProductId" IS NOT NULL
      GROUP BY 1,2 HAVING COUNT(DISTINCT "produtoId") > 1
    )`;

  try {
    console.log(`─ tenant: ${tenant.slug} (${dryRun ? "DRY-RUN" : "WRITE"})`);

    const [pre] = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      WITH ${resolvedPfCteAll()}, ${collCte}
      SELECT COUNT(*)::bigint n
      FROM "ProdutoFarmacia" pf, resolved_pf r, coll
      WHERE ${targetWhere}`);
    console.log(`  PF não-canónicas com stock>NULL a limpar: ${Number(pre.n).toLocaleString("pt-PT")}`);

    if (dryRun) {
      console.log("\nDRY-RUN — nada escrito. Re-corre sem --dry-run para aplicar.");
      return;
    }

    const updated = await prisma.$executeRaw(Prisma.sql`
      WITH ${resolvedPfCteAll()}, ${collCte}
      UPDATE "ProdutoFarmacia" pf
      SET "stockAtual" = NULL, "stockRaw" = NULL, "stockMinimo" = NULL,
          "stockMaximo" = NULL, "stockEncomenda" = NULL, "stockReserva" = NULL
      FROM resolved_pf r, coll
      WHERE ${targetWhere}`);
    console.log(`  ✓ ${updated} ProdutoFarmacia limpas (stock removido do produto não-canónico).`);

    const [post] = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      WITH ${resolvedPfCteAll()}, ${collCte}
      SELECT COUNT(*)::bigint n
      FROM "ProdutoFarmacia" pf, resolved_pf r, coll
      WHERE ${targetWhere}`);
    console.log(`  residual após cleanup (deve ser 0): ${Number(post.n)}`);
    console.log("\nPróximo passo: re-correr stock-upload (agent) para repor o stock na PF canónica.");
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
