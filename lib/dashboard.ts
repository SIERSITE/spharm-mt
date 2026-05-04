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

export type DashboardMonthlyTrend = {
  ano: number;
  /** Mês 1..12 */
  mes: number;
  /** Label PT abreviado: "Jan", "Fev", … */
  label: string;
  /** Vendas em € (VendaMensal.valorTotal). No agregado de grupo, soma todas
   *  as farmácias activas; numa série por-farmácia, é o valor dessa farmácia. */
  valorTotal: number;
};

export type DashboardPharmacyTrend = {
  farmaciaId: string;
  farmaciaNome: string;
  monthlyTrend: DashboardMonthlyTrend[];
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

  // Tendência (top da página) — vendas mensais nos últimos 12 meses.
  trend: {
    /** Agregado de grupo: 12 buckets, mais antigo→mais recente.
     *  null quando todas as farmácias têm zero em todo o intervalo. */
    monthlyTrend: DashboardMonthlyTrend[] | null;
    /** Série por farmácia (uma entrada por farmácia activa, sempre 12
     *  buckets — contém zeros se a farmácia não tem dados no período).
     *  Permite ao card de tendência filtrar sem nova query. */
    byPharmacy: DashboardPharmacyTrend[];
    /** Total do mês actual em € (grupo). null quando não há dados. */
    currentMonthTotalEur: number | null;
    /** % MoM (mês actual vs anterior, agregado de grupo). null sem baseline. */
    salesTrendPct: number | null;
  };

  // Alertas críticos
  criticalAlerts: {
    outOfStockCount: number;
    outOfStockSample: ActionableProduct[];
    atRiskCount: number;
    atRiskSample: ActionableProduct[];
  };

  // Transferências sugeridas
  optimization: {
    transferSuggestionsTotal: number;
    estimatedValueUnlockedEur: number;
    topTransferSuggestions: DashboardTopSuggestion[];
  };

  // Excessos / stock parado — o destino operacional é /excessos?days=60.
  excess: {
    /** Σ stockAtual × custo para produtos com cobertura > 60 dias. */
    excessStockValueEur: number;
    /** Número de produtos com cobertura > 60 dias. */
    excessStockCount: number;
    /** Número de produtos com stockAtual > 0 e sem vendas em 90 dias. */
    noMovementCount: number;
    /** Top excessos por valor de stock (para detalhe). */
    excessSample: ActionableProduct[];
  };

  // Detalhe por farmácia (collapsed by default na UI)
  perPharmacy: PerPharmacyData[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const MONTH_LABELS_PT = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];
const TREND_MONTHS = 12;
const SAMPLE_SIZE = 5;
const TRANSFER_SAMPLE_SIZE = 3;

function monthLabel(mes: number): string {
  return MONTH_LABELS_PT[mes - 1] ?? "?";
}

function unitCost(row: StockRowEnriched): number {
  return row.puc ?? row.pmc ?? 0;
}

function detailFor(filter: "out-of-stock" | "at-risk" | "excess", row: StockRowEnriched): string {
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
  }
}

function toActionable(
  row: StockRowEnriched,
  detailKind: "out-of-stock" | "at-risk" | "excess",
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

// ─── 12-month trend (VendaMensal monthly) ────────────────────────────────────

async function loadMonthlyTrend(
  farmacias: Array<{ id: string; nome: string }>,
): Promise<{
  monthlyTrend: DashboardMonthlyTrend[] | null;
  byPharmacy: DashboardPharmacyTrend[];
}> {
  if (farmacias.length === 0) {
    return { monthlyTrend: null, byPharmacy: [] };
  }
  const prisma = await getPrisma();

  const now = new Date();
  const currentAno = now.getFullYear();
  const currentMes = now.getMonth() + 1;
  const currentPeriod = currentAno * 12 + currentMes;
  const startPeriod = currentPeriod - (TREND_MONTHS - 1);

  const farmaciaIds = farmacias.map((f) => f.id);

  // Aggregate VendaMensal.valorTotal by (ano, mes, farmaciaId). One pass over
  // VendaMensal feeds both the group total (sum across farmácias) and the
  // per-pharmacy series consumed by the trend card filter — no extra queries.
  const monthlyRows = await prisma.$queryRaw<
    Array<{ ano: number; mes: number; farmaciaId: string; total: string }>
  >(Prisma.sql`
    SELECT
      vm."ano"          AS "ano",
      vm."mes"          AS "mes",
      vm."farmaciaId"   AS "farmaciaId",
      SUM(vm."valorTotal")::text AS "total"
    FROM "VendaMensal" vm
    WHERE (vm."ano" * 12 + vm."mes") >= ${startPeriod}
      AND (vm."ano" * 12 + vm."mes") <= ${currentPeriod}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."ano", vm."mes", vm."farmaciaId"
    ORDER BY vm."ano", vm."mes", vm."farmaciaId"
  `);

  const buildBuckets = (lookup: Map<number, number>): DashboardMonthlyTrend[] => {
    const buckets: DashboardMonthlyTrend[] = [];
    for (let i = 0; i < TREND_MONTHS; i++) {
      const period = startPeriod + i;
      const ano = Math.floor((period - 1) / 12);
      const mes = ((period - 1) % 12) + 1;
      buckets.push({
        ano,
        mes,
        label: monthLabel(mes),
        valorTotal: lookup.get(period) ?? 0,
      });
    }
    return buckets;
  };

  // Group: sum across farmácias by period.
  const groupByPeriod = new Map<number, number>();
  for (const r of monthlyRows) {
    const period = r.ano * 12 + r.mes;
    groupByPeriod.set(
      period,
      (groupByPeriod.get(period) ?? 0) + toNum(r.total),
    );
  }
  const groupSeries = buildBuckets(groupByPeriod);
  const groupHasData = groupSeries.some((b) => b.valorTotal > 0);

  // Per-pharmacy: one series per farmácia (always 12 buckets, zeros included).
  const byFarmaciaPeriod = new Map<string, Map<number, number>>();
  for (const f of farmacias) byFarmaciaPeriod.set(f.id, new Map());
  for (const r of monthlyRows) {
    const m = byFarmaciaPeriod.get(r.farmaciaId);
    if (m) m.set(r.ano * 12 + r.mes, toNum(r.total));
  }
  const byPharmacy: DashboardPharmacyTrend[] = farmacias.map((f) => ({
    farmaciaId: f.id,
    farmaciaNome: f.nome,
    monthlyTrend: buildBuckets(byFarmaciaPeriod.get(f.id) ?? new Map()),
  }));

  return {
    monthlyTrend: groupHasData ? groupSeries : null,
    byPharmacy,
  };
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

  // 12-month trend (top da página). Devolve grupo + série por farmácia.
  const trendData = await loadMonthlyTrend(
    perPharmacyData.perPharmacy.map((p) => ({ id: p.id, nome: p.name })),
  );
  const monthlyTrend = trendData.monthlyTrend;

  // ── Alertas críticos ──────────────────────────────────────────────────
  const outOfStockRows = stockRows.filter((r) => matchStockFilter(r, "out-of-stock"));
  const atRiskRows = stockRows.filter((r) => matchStockFilter(r, "at-risk"));

  // ── Excessos / stock parado ───────────────────────────────────────────
  const excessRows = stockRows.filter((r) => matchStockFilter(r, "excess-stock-60d"));
  const excessStockValueEur = excessRows.reduce(
    (sum, r) => sum + r.stockAtual * unitCost(r),
    0,
  );
  const noMovementRows = stockRows.filter((r) => matchStockFilter(r, "no-movement-3m"));

  // ── Optimization ──────────────────────────────────────────────────────
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

  // ── Tendência: derivada da série mensal real ──────────────────────────
  const currentMonthTotalEur =
    monthlyTrend && monthlyTrend.length > 0
      ? monthlyTrend[monthlyTrend.length - 1].valorTotal
      : null;
  const prevMonthTotal =
    monthlyTrend && monthlyTrend.length >= 2
      ? monthlyTrend[monthlyTrend.length - 2].valorTotal
      : null;
  const salesTrendPct =
    currentMonthTotalEur !== null && prevMonthTotal !== null && prevMonthTotal > 0
      ? ((currentMonthTotalEur - prevMonthTotal) / prevMonthTotal) * 100
      : null;

  // Ordenadores das amostras por força do sinal.
  const sortBySalesQty90dDesc = (a: StockRowEnriched, b: StockRowEnriched) =>
    b.salesQty90d - a.salesQty90d;
  const sortByCoverageAsc = (a: StockRowEnriched, b: StockRowEnriched) =>
    (a.coverage ?? Infinity) - (b.coverage ?? Infinity);
  const sortByExcessValueDesc = (a: StockRowEnriched, b: StockRowEnriched) =>
    b.stockAtual * unitCost(b) - a.stockAtual * unitCost(a);

  return {
    pharmaciesCount: farmaciaIds.length,

    trend: {
      monthlyTrend,
      byPharmacy: trendData.byPharmacy,
      currentMonthTotalEur,
      salesTrendPct,
    },

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
    },

    optimization: {
      transferSuggestionsTotal: allTransfers.length,
      estimatedValueUnlockedEur,
      topTransferSuggestions,
    },

    excess: {
      excessStockValueEur,
      excessStockCount: excessRows.length,
      noMovementCount: noMovementRows.length,
      excessSample: excessRows
        .slice()
        .sort(sortByExcessValueDesc)
        .slice(0, SAMPLE_SIZE)
        .map((r) => toActionable(r, "excess")),
    },

    perPharmacy: perPharmacyData.perPharmacy,
  };
}

// Alias para callers legacy que importavam `PharmacyData`.
export type PharmacyData = PerPharmacyData;
