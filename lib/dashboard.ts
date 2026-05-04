/**
 * lib/dashboard.ts
 *
 * Loader único da dashboard. A dashboard agrupa o estado operacional do
 * grupo em cinco secções accionáveis. Para cada KPI:
 *
 *   · A contagem é calculada a partir de loaders partilhados com a
 *     página operacional de destino (NUNCA duplicada). Isto garante que
 *     o número da dashboard coincide exactamente com o que o utilizador
 *     vê quando segue o link.
 *   · Quando uma métrica não pode ser calculada com fiabilidade,
 *     devolve null. A UI mostra "Sem dados suficientes" — nunca um
 *     valor placeholder.
 *
 * Loaders partilhados:
 *   · loadStockEnriched / matchStockFilter (lib/stock-data) — alimentam
 *     todos os KPIs de stock. /stock?filter=<key> mostra o mesmo
 *     conjunto.
 *   · getTransferenciasData / getExcessosData (lib/transferencias-data)
 *     — alimentam Optimization. /transferencias e /excessos?days=60 são
 *     os destinos.
 *
 * Out of scope: o KPI de "estimated order value" usa apenas campos do
 * schema (`stockMinimo`, `stockAtual`, custo). NÃO duplica a lógica de
 * /encomendas/nova (que é user-driven). A secção é rotulada como
 * "Stock mínimo & reposição" com CTA para /encomendas/nova, onde a
 * proposta real é gerada com input do utilizador.
 */
import "server-only";
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import {
  loadStockEnriched,
  matchStockFilter,
  type StockRowEnriched,
} from "@/lib/stock-data";
import {
  getTransferenciasData,
  getExcessosData,
  type Priority,
} from "@/lib/transferencias-data";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type ActionableProduct = {
  cnp: string;
  designacao: string;
  farmaciaNome: string;
  /** Detalhe específico da secção (ex: "stock 0", "cobertura 4d", "−12 un."). */
  detail: string;
};

export type DashboardTopSuggestion = {
  cnp: string;
  produto: string;
  farmaciaOrigem: string;
  farmaciaDestino: string;
  quantidadeSugerida: number;
  prioridade: Priority;
  valorUnlocked: number;
};

export type DashboardWeeklyDay = {
  dayLabel: string;
  date: string;
  value: number;
};

export type PerPharmacyData = {
  id: string;
  name: string;
  sales: number;
  salesPrev: number;
  margin: number;
  marginPrev: number;
  stoppedStockValue: number;
  stoppedStockCount: number;
  alerts: number;
};

export type DashboardData = {
  // Header context
  pharmaciesCount: number;

  // Section 1 — Critical operational alerts
  criticalAlerts: {
    outOfStockCount: number;
    outOfStockSample: ActionableProduct[];
    atRiskCount: number;
    atRiskSample: ActionableProduct[];
    deadStockValueEur: number;
    deadStockCount: number;
  };

  // Section 2 — Stock efficiency
  stockEfficiency: {
    coverageAvgDays: number | null;
    excessStockCount: number;
    excessStockSample: ActionableProduct[];
    /** % of products with stockAtual > 0 with no sales in last 90 days. */
    catalogWithoutMovementPct: number | null;
    catalogWithoutMovementCount: number;
    catalogWithStockCount: number;
  };

  // Section 3 — Optimization opportunities
  optimization: {
    transferSuggestionsTotal: number;
    estimatedValueUnlockedEur: number;
    topTransferSuggestions: DashboardTopSuggestion[];
  };

  // Section 4 — Stock mínimo & reposição (NOT a proposal preview)
  reposicao: {
    belowMinCount: number;
    belowMinSample: ActionableProduct[];
    /** Sum of (stockMinimo − stockAtual) × cost across below-min products. */
    estimatedValueToRestoreEur: number;
  };

  // Section 5 — Trend (secondary)
  trend: {
    salesTrendPct: number | null;
    weeklyChart: DashboardWeeklyDay[] | null;
  };

  // Detalhe por farmácia (collapsible)
  perPharmacy: PerPharmacyData[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const DAY_LABELS_PT = ["D", "S", "T", "Q", "Q", "S", "S"]; // Domingo..Sábado
const WEEKLY_CHART_DAYS = 7;
const DEAD_STOCK_DAYS = 60;
const NO_MOVEMENT_DAYS = 90;
const EXCESS_THRESHOLD_DAYS = 60;
const SAMPLE_SIZE = 5;
const TRANSFER_SAMPLE_SIZE = 3;

function dayLabel(d: Date): string {
  return DAY_LABELS_PT[d.getDay()] ?? "?";
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function unitCost(row: StockRowEnriched): number {
  return row.puc ?? row.pmc ?? 0;
}

function detailFor(filter: "out-of-stock" | "at-risk" | "excess" | "below-min", row: StockRowEnriched): string {
  switch (filter) {
    case "out-of-stock":
      return `stock 0 · vendia ${(row.avgDaily90d * 30).toFixed(1)} un./mês`;
    case "at-risk":
      return row.coverage != null
        ? `cobertura ${row.coverage.toFixed(1)} dias · stock ${Math.round(row.stockAtual)} un.`
        : `stock ${Math.round(row.stockAtual)} un.`;
    case "excess":
      return row.coverage != null
        ? `cobertura ${Math.round(row.coverage)} dias · stock ${Math.round(row.stockAtual)} un.`
        : `stock ${Math.round(row.stockAtual)} un.`;
    case "below-min": {
      const need = Math.max(
        0,
        (row.stockMinimo ?? 0) - row.stockAtual,
      );
      return `${Math.round(row.stockAtual)}/${row.stockMinimo ?? 0} · faltam ${Math.round(need)} un.`;
    }
  }
}

function toActionable(
  row: StockRowEnriched,
  detailKind: "out-of-stock" | "at-risk" | "excess" | "below-min",
): ActionableProduct {
  return {
    cnp: row.cnp,
    designacao: row.designacao,
    farmaciaNome: row.farmaciaNome,
    detail: detailFor(detailKind, row),
  };
}

// ─── Per-pharmacy aggregator (existing logic, preserved) ─────────────────────

async function loadPerPharmacy(): Promise<{
  perPharmacy: PerPharmacyData[];
  totalSales: number;
  totalSalesPrev: number;
}> {
  const prisma = await getPrisma();
  const now = new Date();
  const anoAtual = now.getFullYear();
  const mesAtual = now.getMonth() + 1;
  const anoPrev = mesAtual === 1 ? anoAtual - 1 : anoAtual;
  const mesPrev = mesAtual === 1 ? 12 : mesAtual - 1;

  const periodoAtual = anoAtual * 12 + mesAtual;
  const periodoStopThreshold = periodoAtual - 3;

  const [
    farmacias,
    vendasAtualGrupo,
    vendasPrevGrupo,
    margemAtual,
    margemPrev,
    stockParadoGrupo,
    alertasMinRaw,
  ] = await Promise.all([
    prisma.farmacia.findMany({
      where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    }),

    prisma.vendaMensal.groupBy({
      by: ["farmaciaId"],
      where: { ano: anoAtual, mes: mesAtual },
      _sum: { valorTotal: true },
    }),

    prisma.vendaMensal.groupBy({
      by: ["farmaciaId"],
      where: { ano: anoPrev, mes: mesPrev },
      _sum: { valorTotal: true },
    }),

    prisma.$queryRaw<
      Array<{ farmaciaId: string; totalVendas: string; totalCusto: string }>
    >(Prisma.sql`
      SELECT
        vm."farmaciaId",
        SUM(vm."valorTotal")::text                                              AS "totalVendas",
        SUM(vm."quantidade" * COALESCE(pf."pmc", pf."puc", 0))::text           AS "totalCusto"
      FROM "VendaMensal" vm
      LEFT JOIN "ProdutoFarmacia" pf
        ON pf."produtoId" = vm."produtoId"
       AND pf."farmaciaId" = vm."farmaciaId"
      WHERE vm."ano" = ${anoAtual} AND vm."mes" = ${mesAtual}
      GROUP BY vm."farmaciaId"
    `),

    prisma.$queryRaw<
      Array<{ farmaciaId: string; totalVendas: string; totalCusto: string }>
    >(Prisma.sql`
      SELECT
        vm."farmaciaId",
        SUM(vm."valorTotal")::text                                              AS "totalVendas",
        SUM(vm."quantidade" * COALESCE(pf."pmc", pf."puc", 0))::text           AS "totalCusto"
      FROM "VendaMensal" vm
      LEFT JOIN "ProdutoFarmacia" pf
        ON pf."produtoId" = vm."produtoId"
       AND pf."farmaciaId" = vm."farmaciaId"
      WHERE vm."ano" = ${anoPrev} AND vm."mes" = ${mesPrev}
      GROUP BY vm."farmaciaId"
    `),

    prisma.$queryRaw<
      Array<{ farmaciaId: string; valorParado: string; countParado: string }>
    >(Prisma.sql`
      SELECT
        pf."farmaciaId",
        SUM(pf."stockAtual" * COALESCE(pf."puc", pf."pmc", 0))::text  AS "valorParado",
        COUNT(*)::text                                                  AS "countParado"
      FROM "ProdutoFarmacia" pf
      WHERE
        pf."stockAtual" IS NOT NULL
        AND pf."stockAtual" > 0
        AND pf."flagRetirado" = false
        AND NOT EXISTS (
          SELECT 1
          FROM "VendaMensal" vm
          WHERE vm."produtoId" = pf."produtoId"
            AND vm."farmaciaId" = pf."farmaciaId"
            AND (vm."ano" * 12 + vm."mes") >= ${periodoStopThreshold}
            AND vm."quantidade" > 0
        )
      GROUP BY pf."farmaciaId"
    `),

    prisma.$queryRaw<Array<{ farmaciaId: string; count: string }>>(Prisma.sql`
      SELECT "farmaciaId", COUNT(*)::text AS count
      FROM "ProdutoFarmacia"
      WHERE
        "stockMinimo" IS NOT NULL AND "stockMinimo" > 0
        AND "stockAtual" IS NOT NULL
        AND "stockAtual" <= "stockMinimo"
        AND "flagRetirado" = false
      GROUP BY "farmaciaId"
    `),
  ]);

  const vendasAtualMap = new Map(
    vendasAtualGrupo.map((v) => [v.farmaciaId, toNum(v._sum.valorTotal)]),
  );
  const vendasPrevMap = new Map(
    vendasPrevGrupo.map((v) => [v.farmaciaId, toNum(v._sum.valorTotal)]),
  );
  const margemAtualMap = new Map(
    margemAtual.map((m) => [
      m.farmaciaId,
      { tv: toNum(m.totalVendas), tc: toNum(m.totalCusto) },
    ]),
  );
  const margemPrevMap = new Map(
    margemPrev.map((m) => [
      m.farmaciaId,
      { tv: toNum(m.totalVendas), tc: toNum(m.totalCusto) },
    ]),
  );
  const stockParadoMap = new Map(
    stockParadoGrupo.map((s) => [
      s.farmaciaId,
      { value: toNum(s.valorParado), count: toNum(s.countParado) },
    ]),
  );
  const alertasMinMap = new Map(
    alertasMinRaw.map((a) => [a.farmaciaId, toNum(a.count)]),
  );

  const calcMargem = (tv: number, tc: number): number =>
    tv > 0 ? ((tv - tc) / tv) * 100 : 0;

  const perPharmacy: PerPharmacyData[] = farmacias.map((f) => {
    const sales = vendasAtualMap.get(f.id) ?? 0;
    const salesPrev = vendasPrevMap.get(f.id) ?? 0;
    const ma = margemAtualMap.get(f.id) ?? { tv: 0, tc: 0 };
    const mp = margemPrevMap.get(f.id) ?? { tv: 0, tc: 0 };
    const stopped = stockParadoMap.get(f.id) ?? { value: 0, count: 0 };
    return {
      id: f.id,
      name: f.nome,
      sales,
      salesPrev,
      margin: calcMargem(ma.tv, ma.tc),
      marginPrev: calcMargem(mp.tv, mp.tc),
      stoppedStockValue: stopped.value,
      stoppedStockCount: Math.round(stopped.count),
      alerts: Math.round(alertasMinMap.get(f.id) ?? 0),
    };
  });

  const totalSales = perPharmacy.reduce((s, p) => s + p.sales, 0);
  const totalSalesPrev = perPharmacy.reduce((s, p) => s + p.salesPrev, 0);
  return { perPharmacy, totalSales, totalSalesPrev };
}

// ─── Weekly chart (Venda daily) ──────────────────────────────────────────────

async function loadWeeklyChart(farmaciaIds: string[]): Promise<DashboardWeeklyDay[] | null> {
  if (farmaciaIds.length === 0) return null;
  const prisma = await getPrisma();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - (WEEKLY_CHART_DAYS - 1));

  const dailyRows = await prisma.$queryRaw<
    Array<{ day: string; total: string }>
  >(Prisma.sql`
    SELECT
      TO_CHAR(DATE("data"), 'YYYY-MM-DD') AS "day",
      SUM("quantidade")::text             AS "total"
    FROM "Venda"
    WHERE "data" >= ${startDate}
      AND "farmaciaId" = ANY(${farmaciaIds})
    GROUP BY DATE("data")
    ORDER BY DATE("data") ASC
  `);

  const dailyMap = new Map(dailyRows.map((r) => [r.day, toNum(r.total)]));
  const buckets: DashboardWeeklyDay[] = [];
  for (let i = 0; i < WEEKLY_CHART_DAYS; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    buckets.push({
      dayLabel: dayLabel(d),
      date: isoDate(d),
      value: dailyMap.get(isoDate(d)) ?? 0,
    });
  }
  return buckets.every((b) => b.value === 0) ? null : buckets;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function getDashboardData(): Promise<DashboardData> {
  // Run independent loaders in parallel.
  const [stockRows, allTransfers, perPharmacyData] = await Promise.all([
    loadStockEnriched({ includeOutOfStock: true }),
    getTransferenciasData(),
    loadPerPharmacy(),
  ]);

  const farmaciaIds = Array.from(
    new Set(stockRows.map((r) => r.farmaciaId)),
  );

  // Section 5 chart depends on the same farmacia set.
  const weeklyChart = await loadWeeklyChart(
    perPharmacyData.perPharmacy.map((p) => p.id),
  );

  // ── Section 1: Critical operational alerts ────────────────────────────
  const outOfStockRows = stockRows.filter((r) => matchStockFilter(r, "out-of-stock"));
  const atRiskRows = stockRows.filter((r) => matchStockFilter(r, "at-risk"));

  // Dead stock (60-day window). Reuses loadStockEnriched but applies a
  // date-based predicate on dataUltimaVenda — distinct from the 90-day
  // "no movement" filter in matchStockFilter.
  const deadStockCutoff = new Date(Date.now() - DEAD_STOCK_DAYS * 86_400_000);
  const deadStockRows = stockRows.filter((r) => {
    if (r.stockAtual <= 0) return false;
    if (r.dataUltimaVenda == null) return true;
    return new Date(r.dataUltimaVenda) < deadStockCutoff;
  });
  const deadStockValueEur = deadStockRows.reduce(
    (sum, r) => sum + r.stockAtual * unitCost(r),
    0,
  );

  // ── Section 2: Stock efficiency ───────────────────────────────────────
  const measurableCoverages = stockRows
    .filter((r) => r.coverage != null)
    .map((r) => r.coverage as number);
  const coverageAvgDays =
    measurableCoverages.length > 0
      ? measurableCoverages.reduce((a, b) => a + b, 0) / measurableCoverages.length
      : null;

  const excessRows = stockRows.filter((r) => matchStockFilter(r, "excess-stock-60d"));

  const withStock = stockRows.filter((r) => r.stockAtual > 0);
  const noMovementRows = stockRows.filter((r) => matchStockFilter(r, "no-movement-3m"));
  const catalogWithoutMovementPct =
    withStock.length > 0
      ? (noMovementRows.length / withStock.length) * 100
      : null;

  // ── Section 3: Optimization ───────────────────────────────────────────
  const estimatedValueUnlockedEur = allTransfers.reduce(
    (sum, t) => sum + (t.valorUnlocked ?? 0),
    0,
  );
  const topTransferSuggestions: DashboardTopSuggestion[] = allTransfers
    .slice(0, TRANSFER_SAMPLE_SIZE)
    .map((t) => ({
      cnp: t.cnp,
      produto: t.produto,
      farmaciaOrigem: t.farmaciaOrigem,
      farmaciaDestino: t.farmaciaDestino,
      quantidadeSugerida: t.quantidadeSugerida,
      prioridade: t.prioridade,
      valorUnlocked: t.valorUnlocked ?? 0,
    }));

  // ── Section 4: Stock mínimo & reposição ───────────────────────────────
  // Schema-direct heuristic. NOT a proposal — /encomendas/nova does that.
  const belowMinRows = stockRows.filter((r) => matchStockFilter(r, "below-min"));
  const estimatedValueToRestoreEur = belowMinRows.reduce((sum, r) => {
    const need = Math.max(0, (r.stockMinimo ?? 0) - r.stockAtual);
    return sum + need * unitCost(r);
  }, 0);

  // ── Section 5: Trend ──────────────────────────────────────────────────
  const salesTrendPct =
    perPharmacyData.totalSalesPrev > 0
      ? ((perPharmacyData.totalSales - perPharmacyData.totalSalesPrev) /
          perPharmacyData.totalSalesPrev) *
        100
      : null;

  // Order samples by signal strength.
  const sortBySalesQty90dDesc = (a: StockRowEnriched, b: StockRowEnriched) =>
    b.salesQty90d - a.salesQty90d;
  const sortByCoverageAsc = (a: StockRowEnriched, b: StockRowEnriched) =>
    (a.coverage ?? Infinity) - (b.coverage ?? Infinity);
  const sortByCoverageDesc = (a: StockRowEnriched, b: StockRowEnriched) =>
    (b.coverage ?? 0) - (a.coverage ?? 0);
  const sortByDeficitDesc = (a: StockRowEnriched, b: StockRowEnriched) => {
    const ad = (a.stockMinimo ?? 0) - a.stockAtual;
    const bd = (b.stockMinimo ?? 0) - b.stockAtual;
    return bd - ad;
  };

  return {
    pharmaciesCount: farmaciaIds.length,

    criticalAlerts: {
      outOfStockCount: outOfStockRows.length,
      outOfStockSample: outOfStockRows
        .slice()
        .sort(sortBySalesQty90dDesc)
        .slice(0, SAMPLE_SIZE)
        .map((r) => toActionable(r, "out-of-stock")),
      atRiskCount: atRiskRows.length,
      atRiskSample: atRiskRows
        .slice()
        .sort(sortByCoverageAsc)
        .slice(0, SAMPLE_SIZE)
        .map((r) => toActionable(r, "at-risk")),
      deadStockValueEur,
      deadStockCount: deadStockRows.length,
    },

    stockEfficiency: {
      coverageAvgDays,
      excessStockCount: excessRows.length,
      excessStockSample: excessRows
        .slice()
        .sort(sortByCoverageDesc)
        .slice(0, SAMPLE_SIZE)
        .map((r) => toActionable(r, "excess")),
      catalogWithoutMovementPct,
      catalogWithoutMovementCount: noMovementRows.length,
      catalogWithStockCount: withStock.length,
    },

    optimization: {
      transferSuggestionsTotal: allTransfers.length,
      estimatedValueUnlockedEur,
      topTransferSuggestions,
    },

    reposicao: {
      belowMinCount: belowMinRows.length,
      belowMinSample: belowMinRows
        .slice()
        .sort(sortByDeficitDesc)
        .slice(0, SAMPLE_SIZE)
        .map((r) => toActionable(r, "below-min")),
      estimatedValueToRestoreEur,
    },

    trend: {
      salesTrendPct,
      weeklyChart,
    },

    perPharmacy: perPharmacyData.perPharmacy,
  };
}

// Re-export the pharmacy data type for the perPharmacyData object literal
// callers that previously imported PharmacyData (legacy import path).
export type PharmacyData = PerPharmacyData;

// Re-export legacy thresholds used by the dashboard for documentation
// purposes (not used elsewhere).
export const DEAD_STOCK_THRESHOLD_DAYS = DEAD_STOCK_DAYS;
export const NO_MOVEMENT_THRESHOLD_DAYS = NO_MOVEMENT_DAYS;
export const EXCESS_THRESHOLD_DAYS_DASHBOARD = EXCESS_THRESHOLD_DAYS;
// Note: `getExcessosData()` itself is parameterizable via thresholdDays.
void getExcessosData; // keep import alive in case future sections wire it directly.
