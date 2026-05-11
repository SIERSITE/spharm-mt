/**
 * scripts/ipf-stats.ts
 *
 * Read-out das métricas de `IndicadoresProdutoFarmacia` + micro-
 * benchmark do path IPF vs cálculo live. Sem writes.
 *
 * Mostra:
 *   1. Snapshot da tabela: rows, freshness, breakdown ABC/Rotacao,
 *      valor parado total, top 20 por categoria operacional.
 *   2. Cobertura: rows IPF vs ProdutoFarmacia.
 *   3. Micro-benchmark: medir tempo da query IPF batch (read-out
 *      indexado) vs tempo equivalente do cálculo live (VendaMensal
 *      aggregation 3m). Várias iterações.
 *
 * Uso:
 *   npx tsx scripts/ipf-stats.ts
 *   npx tsx scripts/ipf-stats.ts --bench-iterations=10
 *   npx tsx scripts/ipf-stats.ts --top=30
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";

type Args = { topN: number; iterations: number };
function parseArgs(): Args {
  const out: Args = { topN: 20, iterations: 5 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--top=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 200) out.topN = n;
    } else if (a.startsWith("--bench-iterations=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 50) out.iterations = n;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const t0 = Date.now();

  console.log("─".repeat(78));
  console.log("IPF Stats — read-out + micro-benchmark");
  console.log("─".repeat(78));

  // ── 1. Snapshot da tabela ──────────────────────────────────────────────
  const ipfCount = await prisma.indicadoresProdutoFarmacia.count();
  console.log(`\n[1] IPF rows totais: ${ipfCount}`);

  if (ipfCount === 0) {
    console.log("\n  IPF está vazia. Correr primeiro:");
    console.log("    npx tsx scripts/populate-indicadores-produto-farmacia.ts");
    return;
  }

  type CoverageRow = { farmaciaId: string; nome: string; pfCount: number; ipfCount: number };
  const coverage = await prisma.$queryRawUnsafe<CoverageRow[]>(`
    SELECT
      f.id AS "farmaciaId",
      f.nome AS nome,
      (SELECT COUNT(*)::int FROM "ProdutoFarmacia" pf
        WHERE pf."farmaciaId" = f.id AND pf."flagRetirado" = false) AS "pfCount",
      (SELECT COUNT(*)::int FROM "IndicadoresProdutoFarmacia" ipf
        WHERE ipf."farmaciaId" = f.id) AS "ipfCount"
    FROM "Farmacia" f
    WHERE f.estado = 'ATIVO' AND f.nome <> 'Farmácia Teste'
    ORDER BY f.nome
  `);
  console.log(`\n  Cobertura por farmácia:`);
  for (const c of coverage) {
    const pct = c.pfCount > 0 ? (c.ipfCount / c.pfCount) * 100 : 0;
    console.log(`    ${c.nome.padEnd(28)} PF=${String(c.pfCount).padStart(6)}  IPF=${String(c.ipfCount).padStart(6)}  (${pct.toFixed(1)}%)`);
  }

  // Freshness
  type Fresh = { minCalc: Date; maxCalc: Date; medianMin: number };
  const fresh = await prisma.$queryRawUnsafe<Fresh[]>(`
    SELECT
      MIN("dataCalculo") AS "minCalc",
      MAX("dataCalculo") AS "maxCalc",
      EXTRACT(EPOCH FROM (NOW() - MIN("dataCalculo"))) / 60 AS "medianMin"
    FROM "IndicadoresProdutoFarmacia"
  `);
  if (fresh[0]) {
    const ageMin = Number(fresh[0].medianMin);
    console.log(`\n  Freshness:`);
    console.log(`    dataCalculo mais antigo:  ${new Date(fresh[0].minCalc).toISOString()}  (${ageMin.toFixed(0)} min atrás)`);
    console.log(`    dataCalculo mais recente: ${new Date(fresh[0].maxCalc).toISOString()}`);
  }

  // Breakdown ABC
  type AbcRow = { classificacaoABC: string; n: number };
  const abc = await prisma.$queryRawUnsafe<AbcRow[]>(`
    SELECT "classificacaoABC", COUNT(*)::int AS n
    FROM "IndicadoresProdutoFarmacia"
    GROUP BY "classificacaoABC"
    ORDER BY "classificacaoABC"
  `);
  console.log(`\n  classificacaoABC:`);
  for (const r of abc) console.log(`    ${r.classificacaoABC.padEnd(20)} ${String(r.n).padStart(6)}`);

  // Breakdown Rotacao
  type RotRow = { classificacaoRotacao: string; n: number };
  const rot = await prisma.$queryRawUnsafe<RotRow[]>(`
    SELECT "classificacaoRotacao", COUNT(*)::int AS n
    FROM "IndicadoresProdutoFarmacia"
    GROUP BY "classificacaoRotacao"
    ORDER BY "classificacaoRotacao"
  `);
  console.log(`\n  classificacaoRotacao:`);
  for (const r of rot) console.log(`    ${r.classificacaoRotacao.padEnd(20)} ${String(r.n).padStart(6)}`);

  // valorStockParado total
  type Parado = { total: number; n: number };
  const parado = await prisma.$queryRawUnsafe<Parado[]>(`
    SELECT
      COALESCE(SUM("valorStockParado"), 0)::float AS total,
      COUNT(*) FILTER (WHERE "valorStockParado" > 0)::int AS n
    FROM "IndicadoresProdutoFarmacia"
  `);
  if (parado[0]) {
    console.log(`\n  valorStockParado total: ${parado[0].total.toFixed(2)} € em ${parado[0].n} produtos`);
  }

  // ── 2. Top 20 por categoria ────────────────────────────────────────────
  type TopRow = {
    cnp: string;
    designacao: string;
    farmaciaNome: string;
    stockAtual: number;
    valor: number | null;
    avgDaily90d: number | null;
    diasStock: number | null;
    classificacaoABC: string;
    classificacaoRotacao: string;
  };

  console.log(`\n  Top ${args.topN} CAPITAL PARADO:`);
  const topParado = await prisma.$queryRawUnsafe<TopRow[]>(
    `
    SELECT
      p.cnp::text AS cnp,
      LEFT(p.designacao, 45) AS designacao,
      f.nome AS "farmaciaNome",
      pf."stockAtual"::float AS "stockAtual",
      ipf."valorStockParado"::float AS valor,
      ipf."mediaVendasDiarias90d"::float AS "avgDaily90d",
      ipf."diasStockRestante"::float AS "diasStock",
      ipf."classificacaoABC"::text AS "classificacaoABC",
      ipf."classificacaoRotacao"::text AS "classificacaoRotacao"
    FROM "IndicadoresProdutoFarmacia" ipf
    JOIN "Produto" p ON p.id = ipf."produtoId"
    JOIN "Farmacia" f ON f.id = ipf."farmaciaId"
    JOIN "ProdutoFarmacia" pf ON pf."produtoId" = ipf."produtoId" AND pf."farmaciaId" = ipf."farmaciaId"
    WHERE ipf."valorStockParado" IS NOT NULL AND ipf."valorStockParado" > 0
    ORDER BY ipf."valorStockParado" DESC NULLS LAST
    LIMIT $1
    `,
    args.topN,
  );
  for (const r of topParado) {
    console.log(
      `    ${String(r.valor?.toFixed(2) ?? "—").padStart(8)} €  CNP=${r.cnp}  ` +
        `stock=${String(r.stockAtual).padStart(4)}  rot=${r.classificacaoRotacao.padEnd(12)}  ` +
        `"${r.designacao}"  (${r.farmaciaNome})`,
    );
  }

  console.log(`\n  Top ${args.topN} STOCK EXCESSIVO (> 60d, sem rotura):`);
  const topExcesso = await prisma.$queryRawUnsafe<TopRow[]>(
    `
    SELECT
      p.cnp::text AS cnp,
      LEFT(p.designacao, 45) AS designacao,
      f.nome AS "farmaciaNome",
      pf."stockAtual"::float AS "stockAtual",
      ipf."valorStockParado"::float AS valor,
      ipf."mediaVendasDiarias90d"::float AS "avgDaily90d",
      ipf."diasStockRestante"::float AS "diasStock",
      ipf."classificacaoABC"::text AS "classificacaoABC",
      ipf."classificacaoRotacao"::text AS "classificacaoRotacao"
    FROM "IndicadoresProdutoFarmacia" ipf
    JOIN "Produto" p ON p.id = ipf."produtoId"
    JOIN "Farmacia" f ON f.id = ipf."farmaciaId"
    JOIN "ProdutoFarmacia" pf ON pf."produtoId" = ipf."produtoId" AND pf."farmaciaId" = ipf."farmaciaId"
    WHERE ipf."diasStockRestante" > 60
      AND ipf."mediaVendasDiarias90d" > 0.05
      AND ipf."classificacaoRotacao" <> 'SEM_ROTACAO'
    ORDER BY ipf."diasStockRestante" DESC
    LIMIT $1
    `,
    args.topN,
  );
  for (const r of topExcesso) {
    console.log(
      `    ${String(r.diasStock?.toFixed(0) ?? "—").padStart(4)}d  CNP=${r.cnp}  ` +
        `stock=${String(r.stockAtual).padStart(4)}  ABC=${r.classificacaoABC}  ` +
        `vel=${r.avgDaily90d?.toFixed(2) ?? "—"}/dia  "${r.designacao}"  (${r.farmaciaNome})`,
    );
  }

  console.log(`\n  Top ${args.topN} RUPTURA IMINENTE (< 7d, com vendas):`);
  const topRuptura = await prisma.$queryRawUnsafe<TopRow[]>(
    `
    SELECT
      p.cnp::text AS cnp,
      LEFT(p.designacao, 45) AS designacao,
      f.nome AS "farmaciaNome",
      pf."stockAtual"::float AS "stockAtual",
      ipf."valorStockParado"::float AS valor,
      ipf."mediaVendasDiarias90d"::float AS "avgDaily90d",
      ipf."diasStockRestante"::float AS "diasStock",
      ipf."classificacaoABC"::text AS "classificacaoABC",
      ipf."classificacaoRotacao"::text AS "classificacaoRotacao"
    FROM "IndicadoresProdutoFarmacia" ipf
    JOIN "Produto" p ON p.id = ipf."produtoId"
    JOIN "Farmacia" f ON f.id = ipf."farmaciaId"
    JOIN "ProdutoFarmacia" pf ON pf."produtoId" = ipf."produtoId" AND pf."farmaciaId" = ipf."farmaciaId"
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
      `    ${String(r.diasStock?.toFixed(1) ?? "—").padStart(4)}d  CNP=${r.cnp}  ` +
        `stock=${String(r.stockAtual).padStart(4)}  ABC=${r.classificacaoABC}  ` +
        `vel=${r.avgDaily90d?.toFixed(2) ?? "—"}/dia  "${r.designacao}"  (${r.farmaciaNome})`,
    );
  }

  // ── 3. Micro-benchmark: IPF vs live ────────────────────────────────────
  console.log(`\n[bench] Micro-benchmark IPF vs cálculo live (${args.iterations} iterações)`);

  type FarmRow = { id: string };
  const farms = await prisma.$queryRawUnsafe<FarmRow[]>(
    `SELECT id FROM "Farmacia" WHERE estado='ATIVO' AND nome <> 'Farmácia Teste'`,
  );
  const farmIds = farms.map((f) => f.id);

  // Path 1: IPF batch read (read-out indexado)
  const ipfTimes: number[] = [];
  for (let i = 0; i < args.iterations; i++) {
    const t1 = Date.now();
    await prisma.$queryRawUnsafe(
      `
      SELECT "produtoId", "farmaciaId",
             "mediaVendasDiarias90d"::float AS "ad90",
             "diasStockRestante"::float AS "cov",
             "classificacaoABC"::text AS "abc",
             "classificacaoRotacao"::text AS "rot",
             "valorStockParado"::float AS "parado"
      FROM "IndicadoresProdutoFarmacia"
      WHERE "farmaciaId" = ANY($1)
      `,
      farmIds,
    );
    ipfTimes.push(Date.now() - t1);
  }

  // Path 2: equivalent live computation (VendaMensal 3m aggregate)
  // Reproduz o que loadPfAndSales faz para a janela 3m (mesma fonte que
  // lib/stock-data.ts:63 usa para avgDaily90d).
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const period3m = periodEnd - 3;
  const liveTimes: number[] = [];
  for (let i = 0; i < args.iterations; i++) {
    const t1 = Date.now();
    await prisma.$queryRawUnsafe(
      `
      SELECT pf."produtoId", pf."farmaciaId",
             pf."stockAtual"::float AS "stockAtual",
             (COALESCE(s.qty, 0)::float / 90.0) AS "ad90",
             CASE WHEN s.qty > 0 THEN pf."stockAtual"::float / (s.qty::float / 90.0) ELSE NULL END AS "cov"
      FROM "ProdutoFarmacia" pf
      LEFT JOIN (
        SELECT vm."produtoId", vm."farmaciaId", SUM(vm.quantidade) AS qty
        FROM "VendaMensal" vm
        WHERE (vm.ano * 12 + vm.mes) >= $1 AND (vm.ano * 12 + vm.mes) < $2
          AND vm."farmaciaId" = ANY($3)
        GROUP BY vm."produtoId", vm."farmaciaId"
      ) s ON s."produtoId" = pf."produtoId" AND s."farmaciaId" = pf."farmaciaId"
      WHERE pf."flagRetirado" = false AND pf."farmaciaId" = ANY($3)
      `,
      period3m,
      periodEnd,
      farmIds,
    );
    liveTimes.push(Date.now() - t1);
  }

  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
  };
  const ipfAvg = avg(ipfTimes);
  const liveAvg = avg(liveTimes);
  const speedup = liveAvg / Math.max(1, ipfAvg);
  console.log(`  IPF query (indexed read):`);
  console.log(`    avg=${ipfAvg.toFixed(0)}ms  median=${median(ipfTimes).toFixed(0)}ms  min=${Math.min(...ipfTimes)}ms  max=${Math.max(...ipfTimes)}ms`);
  console.log(`  Live query (VendaMensal 3m aggregation — mesma fonte que stock-data legacy):`);
  console.log(`    avg=${liveAvg.toFixed(0)}ms  median=${median(liveTimes).toFixed(0)}ms  min=${Math.min(...liveTimes)}ms  max=${Math.max(...liveTimes)}ms`);
  console.log(`  Speedup IPF vs live: ${speedup.toFixed(2)}×`);

  console.log("\n" + "─".repeat(78));
  console.log(`Concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s. Read-only.`);
  console.log("─".repeat(78));
}

main()
  .catch((e) => {
    console.error("[fatal]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
