/**
 * scripts/admin/inspect-rev39-upload-state.ts
 *
 * Diagnostica se o products-upload rev39 chegou ao SaaS e se trouxe
 * (ou não) o campo `taxaIva`. Não confio nos logs do agent — verifico
 * o estado real da BD:
 *
 *   1. Quando foi a última `dataAtualizacao` por farmácia?
 *      Se for de hoje → products-upload correu.
 *      Se for antiga → user ainda não correu rev39.
 *
 *   2. Quantas linhas têm `taxaIvaSource = 'STOCKS_MESTRE'`?
 *      Se 0 → rev39 enviou `taxaIva=null` em todas as linhas →
 *      `discoverStocksIvaColumn()` não encontrou a coluna.
 *
 *   3. Sample 5 linhas tocadas hoje → mostra que campos foram
 *      actualizados (pmc/puc/datas) e que `taxaIvaPercent` ficou
 *      como o recuperador legacy o deixou.
 *
 * Read-only.
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

  console.log(`\n=== Estado pós-rev39 (tenant=${slug}) ===\n`);

  // 1. Última dataAtualizacao por farmácia
  const lastUpdates = await prisma.$queryRawUnsafe<
    Array<{
      farmacia: string;
      max_atualizacao: Date;
      total: bigint;
      atualizadas_hoje: bigint;
      atualizadas_6h: bigint;
    }>
  >(`
    SELECT
      f.nome AS farmacia,
      MAX(pf."dataAtualizacao") AS max_atualizacao,
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE pf."dataAtualizacao" >= now()::date)::bigint AS atualizadas_hoje,
      COUNT(*) FILTER (WHERE pf."dataAtualizacao" >= now() - interval '6 hours')::bigint AS atualizadas_6h
    FROM "ProdutoFarmacia" pf
    JOIN "Farmacia" f ON f.id = pf."farmaciaId"
    GROUP BY f.nome
    ORDER BY f.nome
  `);

  console.log("1. dataAtualizacao em ProdutoFarmacia (proxy de products-upload):");
  console.log(
    "   farmácia                       total   hoje    6h     última atualização",
  );
  for (const r of lastUpdates) {
    console.log(
      `   ${r.farmacia.padEnd(30)} ${String(r.total).padStart(5)}  ${String(r.atualizadas_hoje).padStart(5)}  ${String(r.atualizadas_6h).padStart(5)}   ${r.max_atualizacao.toISOString()}`,
    );
  }

  // 2. Distribuição por source
  const bySrc = await prisma.$queryRawUnsafe<
    Array<{ source: string | null; n: bigint }>
  >(`
    SELECT "taxaIvaSource" AS source, COUNT(*)::bigint AS n
    FROM "ProdutoFarmacia"
    WHERE "flagRetirado" = false
    GROUP BY "taxaIvaSource"
    ORDER BY n DESC
  `);

  console.log("\n2. ProdutoFarmacia.taxaIvaSource distribuição:");
  for (const r of bySrc) {
    console.log(`   ${(r.source ?? "(null)").padEnd(22)} × ${r.n}`);
  }

  // 3. Sample linhas tocadas hoje
  const sample = await prisma.$queryRawUnsafe<
    Array<{
      cnp: number;
      designacao: string;
      pmc: string | null;
      taxaIvaPercent: number | null;
      taxaIvaSource: string | null;
      taxaIvaUpdatedAt: Date | null;
      dataAtualizacao: Date;
    }>
  >(`
    SELECT
      p.cnp,
      p.designacao,
      pf.pmc::text AS pmc,
      pf."taxaIvaPercent",
      pf."taxaIvaSource",
      pf."taxaIvaUpdatedAt",
      pf."dataAtualizacao"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto" p ON p.id = pf."produtoId"
    WHERE pf."dataAtualizacao" >= now() - interval '6 hours'
    ORDER BY pf."dataAtualizacao" DESC
    LIMIT 5
  `);

  console.log("\n3. Sample 5 linhas tocadas nas últimas 6h:");
  if (sample.length === 0) {
    console.log("   (nenhuma — products-upload pode não ter sido corrido ainda)");
  } else {
    for (const r of sample) {
      console.log(`   CNP ${r.cnp} · ${r.designacao}`);
      console.log(
        `     pmc=${r.pmc ?? "—"}  taxaIvaPercent=${r.taxaIvaPercent ?? "—"}  source=${r.taxaIvaSource ?? "—"}`,
      );
      console.log(
        `     taxaIvaUpdatedAt=${r.taxaIvaUpdatedAt?.toISOString() ?? "—"}  dataAtualizacao=${r.dataAtualizacao.toISOString()}`,
      );
    }
  }

  // 4. Diagnóstico
  console.log("\n──────────────────────────────────────────────────────────");
  const totalUpdatedToday = lastUpdates.reduce(
    (s, r) => s + Number(r.atualizadas_6h),
    0,
  );
  const totalStocksMestre = Number(
    bySrc.find((r) => r.source === "STOCKS_MESTRE")?.n ?? 0,
  );

  console.log("Diagnóstico:");
  if (totalUpdatedToday === 0) {
    console.log("  ✗ Nenhuma linha ProdutoFarmacia tocada nas últimas 6h.");
    console.log("    → products-upload rev39 NÃO chegou ao SaaS.");
    console.log("    → Verificar logs do BAT no PC da farmácia.");
  } else if (totalStocksMestre === 0) {
    console.log(
      `  ✓ ${totalUpdatedToday} linhas tocadas nas últimas 6h — products-upload correu.`,
    );
    console.log(
      "  ✗ 0 linhas com source='STOCKS_MESTRE' — rev39 enviou taxaIva=null.",
    );
    console.log(
      "    → discoverStocksIvaColumn() NÃO detectou a coluna em dbo.Stocks.",
    );
    console.log(
      "    → Próximo passo: rev40 com regex alargada + dump das colunas.",
    );
  } else {
    console.log(
      `  ✓ ${totalUpdatedToday} linhas tocadas nas últimas 6h, ${totalStocksMestre} via STOCKS_MESTRE.`,
    );
    console.log("    → rev39 detectou e enviou a taxa. Sem acção necessária.");
  }

  await prisma.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
