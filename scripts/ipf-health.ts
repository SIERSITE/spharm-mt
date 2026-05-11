/**
 * scripts/ipf-health.ts
 *
 * Read-model health check para `IndicadoresProdutoFarmacia`. Sem
 * writes. Devolve exit code != 0 quando o read-model está stale
 * (`ageHours > 26`) ou subcoberto (`coverage < 98%`). Pronto a usar
 * em monitoring / cron / CI.
 *
 * Output:
 *   1. Sumário freshness (idade, cobertura, missing)
 *   2. Top 20 capital parado
 *   3. Top 20 ruptura iminente
 *   4. Linha final HEALTHY / UNHEALTHY com razões
 *
 * Exit codes:
 *   0 — healthy
 *   1 — stale OU low coverage (verifica `reasons` do output)
 *   2 — erro técnico (falha a aceder à BD, exception)
 *
 * Uso:
 *   npx tsx scripts/ipf-health.ts
 *   npx tsx scripts/ipf-health.ts --top=30
 *   npx tsx scripts/ipf-health.ts --threshold-hours=12 --threshold-coverage=0.99
 *   npx tsx scripts/ipf-health.ts --quiet   # só linha final + exit code
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import { getIpfFreshness } from "../lib/operational/ipf-freshness";

type Args = {
  topN: number;
  thresholdHours: number;
  thresholdCoverage: number;
  quiet: boolean;
};

function parseArgs(): Args {
  const out: Args = { topN: 20, thresholdHours: 26, thresholdCoverage: 0.98, quiet: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--quiet") out.quiet = true;
    else if (a.startsWith("--top=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 100) out.topN = n;
    } else if (a.startsWith("--threshold-hours=")) {
      const n = parseFloat(a.split("=")[1] ?? "");
      if (Number.isFinite(n) && n > 0) out.thresholdHours = n;
    } else if (a.startsWith("--threshold-coverage=")) {
      const n = parseFloat(a.split("=")[1] ?? "");
      if (Number.isFinite(n) && n > 0 && n <= 1) out.thresholdCoverage = n;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs();
  const t0 = Date.now();

  if (!args.quiet) {
    console.log("─".repeat(78));
    console.log("IPF Health Check");
    console.log("─".repeat(78));
    console.log(`  thresholdHours:    ${args.thresholdHours}`);
    console.log(`  thresholdCoverage: ${(args.thresholdCoverage * 100).toFixed(1)}%`);
  }

  // ── 1. Freshness ─────────────────────────────────────────────────────
  const fresh = await getIpfFreshness(prisma, {
    thresholdHours: args.thresholdHours,
    thresholdCoverage: args.thresholdCoverage,
  });

  if (!args.quiet) {
    console.log(`\n[1] Freshness:`);
    console.log(`    IPF rows:              ${fresh.totalIpfRows.toLocaleString("pt-PT")}`);
    console.log(`    ProdutoFarmacia rows:  ${fresh.totalPfRows.toLocaleString("pt-PT")}`);
    console.log(`    coverage:              ${(fresh.coverage * 100).toFixed(2)}%`);
    console.log(`    missing rows:          ${fresh.missingRows.toLocaleString("pt-PT")}`);
    if (fresh.maxDataCalculo) {
      console.log(`    dataCalculo (max):     ${fresh.maxDataCalculo.toISOString()}`);
      console.log(`    dataCalculo (min):     ${fresh.minDataCalculo?.toISOString() ?? "—"}`);
      console.log(`    ageHours (max):        ${fresh.ageHours?.toFixed(2)}h`);
    } else {
      console.log(`    dataCalculo:           (sem rows)`);
    }
    console.log(`    isStale:               ${fresh.isStale}`);
    console.log(`    isLowCoverage:         ${fresh.isLowCoverage}`);
  }

  // ── 2. Top 20 capital parado + ruptura iminente ──────────────────────
  if (!args.quiet && fresh.totalIpfRows > 0) {
    type TopRow = {
      cnp: string;
      designacao: string;
      farmaciaNome: string;
      stockAtual: number;
      valor: number | null;
      avgDaily90d: number | null;
      diasStock: number | null;
      classificacaoABC: string;
    };

    console.log(`\n[2] Top ${args.topN} CAPITAL PARADO:`);
    const topParado = await prisma.$queryRawUnsafe<TopRow[]>(
      `
      SELECT
        p.cnp::text AS cnp,
        LEFT(p.designacao, 42) AS designacao,
        f.nome AS "farmaciaNome",
        pf."stockAtual"::float AS "stockAtual",
        ipf."valorStockParado"::float AS valor,
        ipf."mediaVendasDiarias90d"::float AS "avgDaily90d",
        ipf."diasStockRestante"::float AS "diasStock",
        ipf."classificacaoABC"::text AS "classificacaoABC"
      FROM "IndicadoresProdutoFarmacia" ipf
      JOIN "Produto" p ON p.id = ipf."produtoId"
      JOIN "Farmacia" f ON f.id = ipf."farmaciaId"
      JOIN "ProdutoFarmacia" pf
        ON pf."produtoId" = ipf."produtoId" AND pf."farmaciaId" = ipf."farmaciaId"
      WHERE ipf."valorStockParado" IS NOT NULL AND ipf."valorStockParado" > 0
      ORDER BY ipf."valorStockParado" DESC
      LIMIT $1
      `,
      args.topN,
    );
    for (const r of topParado) {
      console.log(
        `    ${String(r.valor?.toFixed(2) ?? "—").padStart(8)} €  ` +
          `CNP=${r.cnp}  stock=${String(r.stockAtual).padStart(4)}  ` +
          `ABC=${r.classificacaoABC.padEnd(20)} "${r.designacao}" (${r.farmaciaNome})`,
      );
    }

    console.log(`\n[3] Top ${args.topN} RUPTURA IMINENTE (cov<7d, vendas>0.05/dia):`);
    const topRuptura = await prisma.$queryRawUnsafe<TopRow[]>(
      `
      SELECT
        p.cnp::text AS cnp,
        LEFT(p.designacao, 42) AS designacao,
        f.nome AS "farmaciaNome",
        pf."stockAtual"::float AS "stockAtual",
        ipf."valorStockParado"::float AS valor,
        ipf."mediaVendasDiarias90d"::float AS "avgDaily90d",
        ipf."diasStockRestante"::float AS "diasStock",
        ipf."classificacaoABC"::text AS "classificacaoABC"
      FROM "IndicadoresProdutoFarmacia" ipf
      JOIN "Produto" p ON p.id = ipf."produtoId"
      JOIN "Farmacia" f ON f.id = ipf."farmaciaId"
      JOIN "ProdutoFarmacia" pf
        ON pf."produtoId" = ipf."produtoId" AND pf."farmaciaId" = ipf."farmaciaId"
      WHERE ipf."diasStockRestante" < 7
        AND ipf."mediaVendasDiarias90d" > 0.05
        AND pf."stockAtual" > 0
      ORDER BY ipf."diasStockRestante" ASC, ipf."mediaVendasDiarias90d" DESC
      LIMIT $1
      `,
      args.topN,
    );
    for (const r of topRuptura) {
      console.log(
        `    ${String(r.diasStock?.toFixed(1) ?? "—").padStart(4)}d  ` +
          `CNP=${r.cnp}  stock=${String(r.stockAtual).padStart(4)}  ` +
          `vel=${r.avgDaily90d?.toFixed(2) ?? "—"}/d  ABC=${r.classificacaoABC} ` +
          `"${r.designacao}" (${r.farmaciaNome})`,
      );
    }
  }

  // ── 4. Veredicto final ───────────────────────────────────────────────
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "─".repeat(78));
  if (fresh.healthy) {
    console.log(`✅ HEALTHY · ${fresh.totalIpfRows.toLocaleString("pt-PT")} rows · coverage ${(fresh.coverage * 100).toFixed(2)}% · age ${fresh.ageHours?.toFixed(1) ?? "—"}h · elapsed ${elapsed}s`);
    return 0;
  } else {
    console.log(`❌ UNHEALTHY · elapsed ${elapsed}s`);
    for (const r of fresh.reasons) console.log(`     · ${r}`);
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("[fatal]", err instanceof Error ? err.message : err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
