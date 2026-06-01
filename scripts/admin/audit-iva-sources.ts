/**
 * scripts/admin/audit-iva-sources.ts
 *
 * Audita TODAS as fontes IVA disponíveis num tenant SaaS, para decidir
 * a hierarquia do recuperador:
 *
 *   1. StagingCompraRawLine.iva           — compras (já usado)
 *   2. StagingDevolucaoFornecedorRawLine.iva — devoluções a fornecedor
 *   3. IngestVendaLinhaRaw.{ivaValor, valorLinha} — derivar taxa por venda
 *   4. (planeado) staging master de Stocks com IVA — exige novo rev agent
 *
 * Para cada fonte mede:
 *   · n produtos×farmácia cobertos
 *   · distribuição das taxas derivadas (count por taxa canónica)
 *   · concordância entre fontes (quando duas fontes dão a mesma taxa)
 *
 * Read-only. Não escreve.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import {
  getTenantBySlug,
  buildTenantConnectionString,
  controlPrisma,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalizeIva } from "@/lib/iva";

async function main() {
  const { values } = parseArgs({
    options: { slug: { type: "string" } },
  });
  const slug = values.slug ?? "grupo-silveira";

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`tenant ${slug} not found`);
    process.exit(1);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  console.log(`\n=== Auditoria IVA — fontes (tenant=${slug}) ===\n`);

  // ── 0. universo: ProdutoFarmacia activo ─────────────────────────
  const universoRows = await prisma.$queryRawUnsafe<
    Array<{ farmacia: string; n: bigint }>
  >(`
    SELECT f.nome AS farmacia, COUNT(*)::bigint AS n
    FROM "ProdutoFarmacia" pf
    JOIN "Farmacia" f ON f.id = pf."farmaciaId"
    WHERE pf."flagRetirado" = false
    GROUP BY f.nome
    ORDER BY f.nome
  `);
  const universoTotal = universoRows.reduce((s, r) => s + Number(r.n), 0);
  console.log(`Universo activo (ProdutoFarmacia, flagRetirado=false):`);
  for (const r of universoRows) console.log(`  ${r.farmacia.padEnd(30)} ${r.n}`);
  console.log(`  ${"TOTAL".padEnd(30)} ${universoTotal}`);

  // ── 1. StagingCompraRawLine ─────────────────────────────────────
  const compras = await prisma.$queryRawUnsafe<
    Array<{ taxa: string; n: bigint }>
  >(`
    WITH compras_per_pf AS (
      SELECT DISTINCT ON (pf.id) pf.id, scrl.iva::text AS taxa
      FROM "ProdutoFarmacia" pf
      JOIN "StagingCompraRawLine" scrl
        ON scrl."farmaciaId" = pf."farmaciaId"
       AND scrl."externalCodigoId" = pf."externalProductId"
      WHERE pf."flagRetirado" = false
      ORDER BY pf.id, scrl."externalLineId" DESC
    )
    SELECT taxa, COUNT(*)::bigint AS n
    FROM compras_per_pf
    GROUP BY taxa
    ORDER BY taxa
  `);
  const comprasN = compras.reduce((s, r) => s + Number(r.n), 0);
  console.log(`\nFonte 1 — StagingCompraRawLine (taxa última compra):`);
  for (const r of compras) {
    const norm = normalizeIva(Number(r.taxa));
    console.log(`  taxa=${r.taxa.padStart(8)} → ${norm === null ? "APURAR" : `${norm}%`}  × ${r.n}`);
  }
  console.log(
    `  Cobertura: ${comprasN}/${universoTotal} = ${((comprasN / universoTotal) * 100).toFixed(1)}%`,
  );

  // ── 2. StagingDevolucaoFornecedorRawLine ────────────────────────
  const devs = await prisma.$queryRawUnsafe<
    Array<{ taxa: string; n: bigint }>
  >(`
    WITH devs_per_pf AS (
      SELECT DISTINCT ON (pf.id) pf.id, sd.iva::text AS taxa
      FROM "ProdutoFarmacia" pf
      JOIN "StagingDevolucaoFornecedorRawLine" sd
        ON sd."farmaciaId" = pf."farmaciaId"
       AND sd."externalCodigoId" = pf."externalProductId"
      WHERE pf."flagRetirado" = false
      ORDER BY pf.id, sd."externalLineId" DESC
    )
    SELECT taxa, COUNT(*)::bigint AS n
    FROM devs_per_pf
    GROUP BY taxa
    ORDER BY taxa
  `);
  const devsN = devs.reduce((s, r) => s + Number(r.n), 0);
  console.log(`\nFonte 2 — StagingDevolucaoFornecedorRawLine (taxa devolução):`);
  if (devs.length === 0) console.log("  (sem dados)");
  else
    for (const r of devs) {
      const norm = normalizeIva(Number(r.taxa));
      console.log(`  taxa=${r.taxa.padStart(8)} → ${norm === null ? "APURAR" : `${norm}%`}  × ${r.n}`);
    }
  console.log(
    `  Cobertura: ${devsN}/${universoTotal} = ${((devsN / universoTotal) * 100).toFixed(1)}%`,
  );

  // ── 3. IngestVendaLinhaRaw — derivar taxa por linha ─────────────
  // valorLinha = total da linha (com IVA, na venda a retalho)
  // ivaValor = IVA da linha
  // base = valorLinha − ivaValor
  // taxa = ivaValor / base × 100
  //
  // Tomamos a moda das taxas observadas por produto×farmácia (linha
  // mais recente como proxy: produto pode ter mudado IVA, mas raro).
  console.log(`\nFonte 3 — IngestVendaLinhaRaw (taxa derivada de ivaValor/base):`);
  console.log(`  Sample 5 linhas para validar fórmula:`);
  const sampleVendas = await prisma.$queryRawUnsafe<
    Array<{
      produtoId: string;
      valorLinha: string;
      ivaValor: string;
      taxa_derivada: string;
    }>
  >(`
    SELECT
      "produtoId",
      "valorLinha"::text AS "valorLinha",
      "ivaValor"::text AS "ivaValor",
      CASE
        WHEN "valorLinha" - "ivaValor" > 0
        THEN ROUND(("ivaValor" / ("valorLinha" - "ivaValor") * 100)::numeric, 2)::text
        ELSE NULL
      END AS taxa_derivada
    FROM "IngestVendaLinhaRaw"
    WHERE "ivaValor" > 0 AND "valorLinha" > 0
    ORDER BY "id" DESC
    LIMIT 5
  `);
  for (const r of sampleVendas) {
    console.log(
      `    produtoId=${r.produtoId.slice(0, 12)}… valorLinha=${r.valorLinha} IVA=${r.ivaValor} → ${r.taxa_derivada}%`,
    );
  }

  const vendasCoverage = await prisma.$queryRawUnsafe<
    Array<{ cobertos: bigint; com_iva: bigint; sem_iva: bigint }>
  >(`
    WITH per_pf AS (
      SELECT
        ivlr."produtoId",
        ivlr."farmaciaId",
        SUM(CASE WHEN ivlr."ivaValor" > 0 AND ivlr."valorLinha" > ivlr."ivaValor"
                 THEN 1 ELSE 0 END) AS com_iva_lines,
        SUM(CASE WHEN ivlr."ivaValor" = 0 THEN 1 ELSE 0 END) AS sem_iva_lines
      FROM "IngestVendaLinhaRaw" ivlr
      WHERE ivlr."produtoId" IS NOT NULL
        AND ivlr."isNonStockService" = false
      GROUP BY 1, 2
    )
    SELECT
      COUNT(*)::bigint AS cobertos,
      SUM(CASE WHEN com_iva_lines > 0 THEN 1 ELSE 0 END)::bigint AS com_iva,
      SUM(CASE WHEN com_iva_lines = 0 THEN 1 ELSE 0 END)::bigint AS sem_iva
    FROM per_pf
    JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = per_pf."produtoId" AND pf."farmaciaId" = per_pf."farmaciaId"
    WHERE pf."flagRetirado" = false
  `);
  const v = vendasCoverage[0];
  console.log(
    `  Cobertura: ${v.cobertos}/${universoTotal} = ${((Number(v.cobertos) / universoTotal) * 100).toFixed(1)}% (com IVA capturado: ${v.com_iva})`,
  );

  // Distribuição das taxas derivadas das vendas (taxa moda por produto)
  const vendasDist = await prisma.$queryRawUnsafe<
    Array<{ taxa: number; n: bigint }>
  >(`
    WITH last_per_pf AS (
      SELECT DISTINCT ON (ivlr."produtoId", ivlr."farmaciaId")
        ivlr."produtoId",
        ivlr."farmaciaId",
        ROUND(("ivaValor" / ("valorLinha" - "ivaValor") * 100)::numeric, 0) AS taxa
      FROM "IngestVendaLinhaRaw" ivlr
      WHERE ivlr."ivaValor" > 0
        AND ivlr."valorLinha" > ivlr."ivaValor"
        AND ivlr."produtoId" IS NOT NULL
      ORDER BY ivlr."produtoId", ivlr."farmaciaId", ivlr."dataVenda" DESC
    )
    SELECT taxa::int AS taxa, COUNT(*)::bigint AS n
    FROM last_per_pf
    GROUP BY taxa
    ORDER BY n DESC
  `);
  console.log(`\n  Distribuição taxa derivada (última venda por produto×farm):`);
  for (const r of vendasDist) {
    const norm = normalizeIva(r.taxa);
    console.log(`    ${String(r.taxa).padStart(4)}%  ${norm === null ? "→ APURAR" : `→ ${norm}%`}  × ${r.n}`);
  }

  // ── 4. União: cobertura combinada compras + vendas ──────────────
  const unionCov = await prisma.$queryRawUnsafe<
    Array<{ n: bigint }>
  >(`
    WITH cov_compras AS (
      SELECT DISTINCT pf.id
      FROM "ProdutoFarmacia" pf
      JOIN "StagingCompraRawLine" scrl
        ON scrl."farmaciaId" = pf."farmaciaId"
       AND scrl."externalCodigoId" = pf."externalProductId"
      WHERE pf."flagRetirado" = false AND scrl.iva > 0
    ),
    cov_vendas AS (
      SELECT DISTINCT pf.id
      FROM "ProdutoFarmacia" pf
      JOIN "IngestVendaLinhaRaw" ivlr
        ON ivlr."produtoId" = pf."produtoId"
       AND ivlr."farmaciaId" = pf."farmaciaId"
      WHERE pf."flagRetirado" = false
        AND ivlr."ivaValor" > 0
        AND ivlr."valorLinha" > ivlr."ivaValor"
    )
    SELECT COUNT(DISTINCT id)::bigint AS n
    FROM (
      SELECT id FROM cov_compras
      UNION
      SELECT id FROM cov_vendas
    ) u
  `);
  const unionN = Number(unionCov[0].n);
  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(`COBERTURA COMBINADA (compras ∪ vendas com IVA>0):`);
  console.log(
    `  ${unionN}/${universoTotal} = ${((unionN / universoTotal) * 100).toFixed(1)}%`,
  );

  // ── 5. Concordância entre compras e vendas (sanity check) ───────
  const concord = await prisma.$queryRawUnsafe<
    Array<{
      compras_taxa: string;
      vendas_taxa: string;
      n: bigint;
    }>
  >(`
    WITH compras AS (
      SELECT DISTINCT ON (pf.id) pf.id, scrl.iva::numeric AS taxa
      FROM "ProdutoFarmacia" pf
      JOIN "StagingCompraRawLine" scrl
        ON scrl."farmaciaId" = pf."farmaciaId"
       AND scrl."externalCodigoId" = pf."externalProductId"
      WHERE pf."flagRetirado" = false AND scrl.iva > 0
      ORDER BY pf.id, scrl."externalLineId" DESC
    ),
    vendas AS (
      SELECT DISTINCT ON (pf.id) pf.id,
        ROUND(("ivaValor" / ("valorLinha" - "ivaValor") * 100)::numeric, 0) AS taxa
      FROM "ProdutoFarmacia" pf
      JOIN "IngestVendaLinhaRaw" ivlr
        ON ivlr."produtoId" = pf."produtoId"
       AND ivlr."farmaciaId" = pf."farmaciaId"
      WHERE pf."flagRetirado" = false
        AND ivlr."ivaValor" > 0
        AND ivlr."valorLinha" > ivlr."ivaValor"
      ORDER BY pf.id, ivlr."dataVenda" DESC
    )
    SELECT
      compras.taxa::text AS compras_taxa,
      vendas.taxa::text AS vendas_taxa,
      COUNT(*)::bigint AS n
    FROM compras
    JOIN vendas ON vendas.id = compras.id
    GROUP BY compras.taxa, vendas.taxa
    ORDER BY n DESC
    LIMIT 10
  `);
  console.log(`\nConcordância taxa (compras×vendas) — TOP 10:`);
  console.log(`  compras  → vendas    n`);
  for (const r of concord) {
    const cn = normalizeIva(Number(r.compras_taxa));
    const vn = normalizeIva(Number(r.vendas_taxa));
    const flag = cn !== null && vn !== null && cn === vn ? "✓" : cn === null || vn === null ? "?" : "✗";
    console.log(
      `  ${r.compras_taxa.padStart(7)} (${cn ?? "?"})  → ${r.vendas_taxa.padStart(6)} (${vn ?? "?"})  ${flag}  × ${r.n}`,
    );
  }

  await prisma.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
