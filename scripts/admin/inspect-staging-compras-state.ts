/**
 * scripts/admin/inspect-staging-compras-state.ts
 *
 * Pré-validação operacional para o dry-run aggregate-compras:
 *   · count em StagingCompraRawLine para farmácia + janela
 *   · per-header reconciliação SUM(qt × valorEurUnit) vs headerTotalIncidenciaEur
 *     com tolerância 0.02€ (mesma do endpoint bootstrap/compras), para
 *     localizar os warnings reportados pelo agent
 *   · contagem de produtos não-mapeados (orphans) via NOT EXISTS
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

const RECONCILIATION_TOLERANCE_EUR = 0.02;

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
  const farmaciaId = values["farmacia-id"];
  const fromStr = values.from;
  const toStr = values.to;
  if (!farmaciaId || !fromStr || !toStr) {
    console.error(
      "Usage: --slug=demo-neon --farmacia-id=<id> --from=YYYY-MM-DD --to=YYYY-MM-DD"
    );
    process.exit(1);
  }
  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T00:00:00.000Z`);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`tenant ${slug} not found`);
  const tp = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  // 1. Count + breakdown por dia
  const total = await tp.stagingCompraRawLine.count({
    where: { farmaciaId, dataRecepcao: { gte: from, lt: to } },
  });
  console.log(`StagingCompraRawLine rows in window [${fromStr}, ${toStr}): ${total}`);

  if (total === 0) {
    console.log("(janela vazia — abortar dry-run)");
    await tp.$disconnect();
    await controlPrisma.$disconnect();
    return;
  }

  const byDay = await tp.$queryRaw<Array<{ d: Date; rows: bigint; receptions: bigint }>>`
    SELECT DATE("dataRecepcao") AS d,
           COUNT(*)::bigint AS rows,
           COUNT(DISTINCT "externalReceptionId")::bigint AS receptions
    FROM "StagingCompraRawLine"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "dataRecepcao" >= ${from}
      AND "dataRecepcao" <  ${to}
    GROUP BY DATE("dataRecepcao")
    ORDER BY d
  `;
  console.log("per dia:");
  for (const d of byDay) {
    console.log(`  ${d.d.toISOString().slice(0, 10)}  linhas=${d.rows}  recepções=${d.receptions}`);
  }

  // 2. ingestBatchId(s) que tocaram esta janela
  const batches = await tp.$queryRaw<Array<{ batch: string; n: bigint }>>`
    SELECT "ingestBatchId" AS batch, COUNT(*)::bigint AS n
    FROM "StagingCompraRawLine"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "dataRecepcao" >= ${from}
      AND "dataRecepcao" <  ${to}
    GROUP BY "ingestBatchId"
    ORDER BY n DESC
  `;
  console.log("ingestBatchIds:");
  for (const b of batches) console.log(`  ${b.batch}  rows=${b.n}`);

  // 3. Reconciliação per recepção: SUM(qt × valorEurUnit) vs headerTotalIncidenciaEur
  const recon = await tp.$queryRaw<
    Array<{
      recId: number;
      expected: string;
      computed: string;
      diff: string;
      lines: bigint;
    }>
  >`
    SELECT "externalReceptionId" AS "recId",
           MAX("headerTotalIncidenciaEur")::text AS expected,
           SUM("quantidade" * "valorEurUnit")::numeric(14,2)::text AS computed,
           (SUM("quantidade" * "valorEurUnit") - MAX("headerTotalIncidenciaEur"))::numeric(14,2)::text AS diff,
           COUNT(*)::bigint AS lines
    FROM "StagingCompraRawLine"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "dataRecepcao" >= ${from}
      AND "dataRecepcao" <  ${to}
    GROUP BY "externalReceptionId"
    HAVING ABS(SUM("quantidade" * "valorEurUnit") - MAX("headerTotalIncidenciaEur")) > ${RECONCILIATION_TOLERANCE_EUR}
    ORDER BY ABS(SUM("quantidade" * "valorEurUnit") - MAX("headerTotalIncidenciaEur")) DESC
    LIMIT 20
  `;
  console.log(`reconciliation outliers (>${RECONCILIATION_TOLERANCE_EUR}€): ${recon.length}`);
  for (const r of recon) {
    console.log(
      `  recId=${r.recId} expected=${r.expected}€ computed=${r.computed}€ diff=${r.diff}€ lines=${r.lines}`
    );
  }

  // 4. Orphans de produto: externalCodigoId no staging sem ProdutoFarmacia
  const orphProds = await tp.$queryRaw<Array<{ externalCodigoId: number; n: bigint }>>`
    SELECT s."externalCodigoId", COUNT(*)::bigint AS n
    FROM "StagingCompraRawLine" s
    WHERE s."farmaciaId" = ${farmaciaId}
      AND s."dataRecepcao" >= ${from}
      AND s."dataRecepcao" <  ${to}
      AND NOT EXISTS (
        SELECT 1 FROM "ProdutoFarmacia" pf
        WHERE pf."farmaciaId" = s."farmaciaId"
          AND pf."externalProductId" = s."externalCodigoId"
      )
    GROUP BY s."externalCodigoId"
    ORDER BY n DESC
    LIMIT 10
  `;
  console.log(`orphan products (top 10): ${orphProds.length}`);
  for (const o of orphProds) console.log(`  codigoId=${o.externalCodigoId}  rows=${o.n}`);

  // 5. Orphans de fornecedor: externalFornecedorId sem FornecedorErpRef
  const orphForn = await tp.$queryRaw<Array<{ externalFornecedorId: number; n: bigint }>>`
    SELECT s."externalFornecedorId", COUNT(*)::bigint AS n
    FROM "StagingCompraRawLine" s
    WHERE s."farmaciaId" = ${farmaciaId}
      AND s."dataRecepcao" >= ${from}
      AND s."dataRecepcao" <  ${to}
      AND NOT EXISTS (
        SELECT 1 FROM "FornecedorErpRef" r
        WHERE r."farmaciaId" = s."farmaciaId"
          AND r."externalFornecedorId" = s."externalFornecedorId"
      )
    GROUP BY s."externalFornecedorId"
    ORDER BY n DESC
    LIMIT 10
  `;
  console.log(`orphan fornecedores (top 10): ${orphForn.length}`);
  for (const o of orphForn) console.log(`  fornecedorId=${o.externalFornecedorId}  rows=${o.n}`);

  await tp.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
