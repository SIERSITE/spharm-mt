/**
 * scripts/admin/inspect-iva-distribution.ts
 *
 * Audita os valores reais de StagingCompraRawLine.iva em produção para
 * confirmar a ESCALA do campo:
 *   · vem como percentagem (6, 13, 23)?
 *   · ou como fracção (0.06, 0.13, 0.23)?
 *   · ou outra coisa (valor em €, código, basis points)?
 *
 * Read-only. Imprime:
 *   1. DISTINCT iva ORDER BY iva — todos os valores únicos com count
 *   2. min/max/avg
 *   3. Sample 5 linhas com headerTotalIvaEur + headerTotalIncidenciaEur
 *      para podermos reconciliar: se iva fosse 23, headerIVA/headerIncidência
 *      deveria estar à volta de 0.23 (ou 23/100). Se iva já é 0.23, a razão
 *      bate certinha. Distingue fracção de percentagem sem dúvida.
 *
 * Usage:
 *   npx tsx scripts/admin/inspect-iva-distribution.ts --slug=silveirense
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import {
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
    },
  });
  const slug = values.slug ?? "silveirense";

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`tenant ${slug} not found`);
    process.exit(1);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  console.log(`\n=== Tenant: ${slug} ===\n`);

  // 1. DISTINCT iva
  const distinct = await prisma.$queryRawUnsafe<
    Array<{ iva: string; count: bigint }>
  >(`
    SELECT iva::text AS iva, COUNT(*)::bigint AS count
    FROM "StagingCompraRawLine"
    GROUP BY iva
    ORDER BY iva ASC
  `);
  console.log("DISTINCT iva (valor × ocorrências):");
  for (const r of distinct) {
    console.log(`  ${String(r.iva).padStart(10)} × ${r.count}`);
  }

  // 2. Estatísticas
  const stats = await prisma.$queryRawUnsafe<
    Array<{ min: string; max: string; avg: string; total: bigint }>
  >(`
    SELECT
      MIN(iva)::text AS min,
      MAX(iva)::text AS max,
      AVG(iva)::text AS avg,
      COUNT(*)::bigint AS total
    FROM "StagingCompraRawLine"
  `);
  const s = stats[0];
  console.log(`\nStats: min=${s.min} max=${s.max} avg=${s.avg} total=${s.total}`);

  // 3. Sample com reconciliação header — vamos comparar a razão IVA/Incidência
  //    do header com o valor `iva` da linha. Se a razão ≈ valor_linha → linha
  //    é percentagem (23 = "0.23 ratio"); se ≈ valor_linha/100 → linha é
  //    em décimas; se ≈ valor_linha → linha é fracção pura.
  const sample = await prisma.$queryRawUnsafe<
    Array<{
      iva: string;
      qty: string;
      valor_unit: string;
      header_iva: string;
      header_incid: string;
      ratio: string;
    }>
  >(`
    SELECT
      iva::text                              AS iva,
      "quantidade"::text                     AS qty,
      "valorEurUnit"::text                   AS valor_unit,
      "headerTotalIvaEur"::text              AS header_iva,
      "headerTotalIncidenciaEur"::text       AS header_incid,
      CASE
        WHEN "headerTotalIncidenciaEur" > 0
          THEN ("headerTotalIvaEur" / "headerTotalIncidenciaEur")::text
        ELSE NULL
      END                                    AS ratio
    FROM "StagingCompraRawLine"
    WHERE "headerTotalIncidenciaEur" > 0
    ORDER BY "externalLineId" DESC
    LIMIT 8
  `);
  console.log("\nSample 8 linhas (header IVA/Incidência ratio vs valor linha):");
  console.log("  iva       qty   valorUnit  headerIVA  headerIncid  ratio");
  for (const r of sample) {
    console.log(
      `  ${r.iva.padStart(8)}  ${r.qty.padStart(4)}  ${r.valor_unit.padStart(8)}  ${r.header_iva.padStart(8)}  ${r.header_incid.padStart(10)}  ${r.ratio ?? "—"}`,
    );
  }

  // 4. Conclusão automática
  const max = Number(s.max);
  console.log("\nDiagnóstico:");
  if (max <= 1) {
    console.log("  → escala FRACÇÃO (0..1). 0.06 / 0.13 / 0.23 são as taxas.");
    console.log("  → multiplicar por 100 para obter %");
  } else if (max <= 30) {
    console.log("  → escala PERCENTAGEM (0..30). 6 / 13 / 23 são as taxas.");
    console.log("  → valores já estão em %");
  } else {
    console.log("  → escala anómala — investigar. Possivelmente € de IVA, não taxa.");
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
