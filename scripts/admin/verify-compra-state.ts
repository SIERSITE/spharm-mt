/**
 * scripts/admin/verify-compra-state.ts
 *
 * Verificação SaaS-side pós aggregate-compras --write:
 *   · COUNT total de Compra para a janela e farmácia
 *   · DISTINCT ingestBatchId (esperado 1 — o mais recente)
 *   · MIN/MAX aggregatedAt (esperado próximo de NOW())
 *   · Sample de rows (primeira por valorTotal desc)
 *   · Sanidade Σ valorTotal e Σ quantidade vs preview do dry-run
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

  const total = await tp.compra.count({
    where: { farmaciaId, data: { gte: from, lt: to } },
  });
  console.log(`Compra count in window: ${total}`);

  const batches = await tp.$queryRaw<Array<{ batch: string | null; n: bigint; minAgg: Date | null; maxAgg: Date | null }>>`
    SELECT "ingestBatchId" AS batch,
           COUNT(*)::bigint AS n,
           MIN("aggregatedAt") AS "minAgg",
           MAX("aggregatedAt") AS "maxAgg"
    FROM "Compra"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "data" >= ${from}
      AND "data" <  ${to}
    GROUP BY "ingestBatchId"
    ORDER BY n DESC
  `;
  console.log(`distinct ingestBatchId: ${batches.length}`);
  for (const b of batches) {
    console.log(
      `  batch=${b.batch}  rows=${b.n}  aggregatedAt=${b.minAgg?.toISOString()}..${b.maxAgg?.toISOString()}`
    );
  }

  const sums = await tp.$queryRaw<Array<{ sumValor: string | null; sumQt: string | null }>>`
    SELECT SUM("valorTotal")::text AS "sumValor",
           SUM("quantidade")::text AS "sumQt"
    FROM "Compra"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "data" >= ${from}
      AND "data" <  ${to}
  `;
  console.log(`Σ valorTotal: ${sums[0].sumValor}€   Σ quantidade: ${sums[0].sumQt}`);

  // Sanity: 1 row per (farmaciaId, produtoId, fornecedorId, data) — sem duplicados
  const dupes = await tp.$queryRaw<Array<{ produtoId: string; fornecedorId: string | null; data: Date; n: bigint }>>`
    SELECT "produtoId", "fornecedorId", "data", COUNT(*)::bigint AS n
    FROM "Compra"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "data" >= ${from}
      AND "data" <  ${to}
    GROUP BY "produtoId", "fornecedorId", "data"
    HAVING COUNT(*) > 1
    LIMIT 5
  `;
  console.log(`duplicates on aggregation key: ${dupes.length}`);

  // Top 5 rows by valorTotal
  const top = await tp.$queryRaw<Array<{ produtoId: string; data: Date; quantidade: string; valorTotal: string; precoUnitario: string | null; ingestBatchId: string | null }>>`
    SELECT "produtoId",
           "data",
           "quantidade"::text   AS quantidade,
           "valorTotal"::text   AS "valorTotal",
           "precoUnitario"::text AS "precoUnitario",
           "ingestBatchId"
    FROM "Compra"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "data" >= ${from}
      AND "data" <  ${to}
    ORDER BY "valorTotal" DESC
    LIMIT 5
  `;
  console.log("Top 5 rows by valorTotal:");
  for (const r of top) {
    console.log(
      `  produtoId=${r.produtoId.slice(0, 20)}...  data=${r.data.toISOString().slice(0, 10)}  qt=${r.quantidade}  valor=${r.valorTotal}€  pUnit=${r.precoUnitario}  batch=${r.ingestBatchId}`
    );
  }

  await tp.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
