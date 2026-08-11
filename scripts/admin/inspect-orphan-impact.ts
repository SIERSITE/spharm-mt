/**
 * scripts/admin/inspect-orphan-impact.ts
 *
 * Quantifica o impacto dos orphans no dry-run: quantas LINHAS de staging
 * caíram no orphanProducts/orphanFornecedores, vs quantas contribuíram
 * efectivamente para os candidateGroups.
 *
 * Read-only. Não escreve.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      "farmacia-id": { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
    },
  });
  const slug = values.slug ?? "demo-neon";
  const farmaciaId = values["farmacia-id"]!;
  const from = new Date(`${values.from}T00:00:00.000Z`);
  const to = new Date(`${values.to}T00:00:00.000Z`);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`tenant ${slug} not found`);
  const tp = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  const total = await tp.stagingCompraRawLine.count({
    where: { farmaciaId, dataRecepcao: { gte: from, lt: to } },
  });

  const orphanLines = await tp.$queryRaw<Array<{ n: bigint; distinctCodigos: bigint }>>`
    SELECT COUNT(*)::bigint AS n,
           COUNT(DISTINCT "externalCodigoId")::bigint AS "distinctCodigos"
    FROM "StagingCompraRawLine" s
    WHERE s."farmaciaId" = ${farmaciaId}
      AND s."dataRecepcao" >= ${from}
      AND s."dataRecepcao" <  ${to}
      AND NOT EXISTS (
        SELECT 1 FROM "ProdutoFarmacia" pf
        WHERE pf."farmaciaId" = s."farmaciaId"
          AND pf."externalProductId" = s."externalCodigoId"
      )
  `;

  const orphanFornLines = await tp.$queryRaw<Array<{ n: bigint; distinctIds: bigint }>>`
    SELECT COUNT(*)::bigint AS n,
           COUNT(DISTINCT "externalFornecedorId")::bigint AS "distinctIds"
    FROM "StagingCompraRawLine" s
    WHERE s."farmaciaId" = ${farmaciaId}
      AND s."dataRecepcao" >= ${from}
      AND s."dataRecepcao" <  ${to}
      AND NOT EXISTS (
        SELECT 1 FROM "FornecedorErpRef" r
        WHERE r."farmaciaId" = s."farmaciaId"
          AND r."externalFornecedorId" = s."externalFornecedorId"
      )
  `;

  // Bootstrap state — quantos produtos a farmácia tem em ProdutoFarmacia
  const pfCount = await tp.produtoFarmacia.count({ where: { farmaciaId } });
  const pfWithExternal = await tp.produtoFarmacia.count({
    where: { farmaciaId, externalProductId: { not: null } },
  });

  console.log(`window total lines: ${total}`);
  console.log(
    `orphan-product lines: ${orphanLines[0].n} (distinct codigos=${orphanLines[0].distinctCodigos})`
  );
  console.log(
    `orphan-fornecedor lines: ${orphanFornLines[0].n} (distinct ids=${orphanFornLines[0].distinctIds})`
  );
  console.log(`ProdutoFarmacia coverage: total=${pfCount} withExternalProductId=${pfWithExternal}`);

  await tp.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
