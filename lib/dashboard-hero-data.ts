import "server-only";
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import {
  getTransferenciasData,
  loadPfAndSales,
  type Priority,
} from "@/lib/transferencias-data";

/**
 * Data loader para a secção DashboardHero.
 *
 * Tudo o que é mostrado no hero vem daqui — sem valores hardcoded. Quando
 * uma métrica não pode ser calculada com fiabilidade, o tipo permite null
 * (ou contagem 0) e a UI escolhe entre mostrar "Sem dados suficientes" ou
 * esconder o badge correspondente.
 *
 * Reutiliza:
 *   · getTransferenciasData() para lista canónica de sugestões
 *   · loadPfAndSales() para a métrica de cobertura
 *
 * O conjunto de farmácias considerado é o mesmo das outras páginas
 * operacionais: estado=ATIVO e nome != "Farmácia Teste".
 */

const ACTIVE_FARMACIA_FILTER = {
  estado: "ATIVO" as const,
  nome: { not: "Farmácia Teste" },
};

const LOW_COVERAGE_THRESHOLD_DAYS = 7;
const VARIANCE_RATIO_THRESHOLD = 2.5;
const WEEKLY_CHART_DAYS = 7;

export type DashboardHeroTopSuggestion = {
  cnp: string;
  produto: string;
  farmaciaOrigem: string;
  farmaciaDestino: string;
  quantidadeSugerida: number;
  prioridade: Priority;
};

export type DashboardHeroDayBucket = {
  /** Inicial PT (D/S/T/Q/Q/S/S) — ordem do mais antigo para o mais recente */
  dayLabel: string;
  /** ISO YYYY-MM-DD para tooltip / sort estável */
  date: string;
  /** Total de unidades vendidas no dia, todas as farmácias activas */
  value: number;
};

export type DashboardHeroData = {
  pharmaciesCount: number;
  transferSuggestionsTotal: number;
  topTransferSuggestions: DashboardHeroTopSuggestion[];
  /** % MoM (mês actual vs anterior); null quando não há baseline */
  salesTrendPct: number | null;
  /** Cobertura média em dias (média sobre pares produto×farmácia com vendas) */
  coverageAvgDays: number | null;
  /** Produtos com cobertura < 7 dias em pelo menos uma farmácia */
  lowCoverageCount: number;
  /** Produtos com max/min cobertura > 2.5x entre farmácias */
  highVarianceCount: number;
  /** 7 dias de unidades vendidas; null quando não há nenhum dado no período */
  weeklyChart: DashboardHeroDayBucket[] | null;
};

const DAY_LABELS_PT = ["D", "S", "T", "Q", "Q", "S", "S"]; // Domingo..Sábado

function dayLabel(d: Date): string {
  return DAY_LABELS_PT[d.getDay()] ?? "?";
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getDashboardHeroData(): Promise<DashboardHeroData> {
  const prisma = await getPrisma();

  // 1. Active pharmacies
  const farmacias = await prisma.farmacia.findMany({
    where: ACTIVE_FARMACIA_FILTER,
    select: { id: true },
  });
  const pharmaciesCount = farmacias.length;
  const farmaciaIds = farmacias.map((f) => f.id);

  // 2. Suggestions (canonical loader). Nota: também corre loadPfAndSales
  // internamente; o custo da segunda passagem (mais à frente) é uma
  // ida única por carregamento da dashboard e mantém a lógica de
  // emparelhamento no único sítio em que vive.
  const allSuggestions = await getTransferenciasData();
  const topTransferSuggestions: DashboardHeroTopSuggestion[] = allSuggestions
    .slice(0, 3)
    .map((s) => ({
      cnp: s.cnp,
      produto: s.produto,
      farmaciaOrigem: s.farmaciaOrigem,
      farmaciaDestino: s.farmaciaDestino,
      quantidadeSugerida: s.quantidadeSugerida,
      prioridade: s.prioridade,
    }));

  // 3. Coverage stats
  let coverageAvgDays: number | null = null;
  let lowCoverageCount = 0;
  let highVarianceCount = 0;
  if (farmaciaIds.length > 0) {
    const { pfRows, salesMap } = await loadPfAndSales(farmaciaIds);
    type Entry = { coverage: number; farmaciaId: string };
    const byProduto = new Map<string, Entry[]>();
    const allCoverages: number[] = [];

    for (const row of pfRows) {
      const qty3m = salesMap.get(`${row.produtoId}:${row.farmaciaId}`) ?? 0;
      const avgDaily = qty3m / 90;
      if (avgDaily <= 0) continue; // sem demanda mensurável → coverage indefinida
      const coverage = toNum(row.stockAtual) / avgDaily;
      if (!Number.isFinite(coverage)) continue;
      allCoverages.push(coverage);
      const existing = byProduto.get(row.produtoId);
      if (existing) existing.push({ coverage, farmaciaId: row.farmaciaId });
      else byProduto.set(row.produtoId, [{ coverage, farmaciaId: row.farmaciaId }]);
    }

    if (allCoverages.length > 0) {
      coverageAvgDays =
        allCoverages.reduce((a, b) => a + b, 0) / allCoverages.length;
    }

    for (const [, entries] of byProduto) {
      if (entries.some((e) => e.coverage < LOW_COVERAGE_THRESHOLD_DAYS)) {
        lowCoverageCount++;
      }
      if (entries.length >= 2) {
        const max = Math.max(...entries.map((e) => e.coverage));
        const min = Math.min(...entries.map((e) => e.coverage));
        if (min > 0 && max / min > VARIANCE_RATIO_THRESHOLD) {
          highVarianceCount++;
        }
      }
    }
  }

  // 4. MoM sales trend (€)
  const now = new Date();
  const anoAtual = now.getFullYear();
  const mesAtual = now.getMonth() + 1;
  const anoPrev = mesAtual === 1 ? anoAtual - 1 : anoAtual;
  const mesPrev = mesAtual === 1 ? 12 : mesAtual - 1;

  const [vmAtual, vmPrev] = await Promise.all([
    prisma.vendaMensal.aggregate({
      where: { ano: anoAtual, mes: mesAtual },
      _sum: { valorTotal: true },
    }),
    prisma.vendaMensal.aggregate({
      where: { ano: anoPrev, mes: mesPrev },
      _sum: { valorTotal: true },
    }),
  ]);
  const totalSales = toNum(vmAtual._sum.valorTotal);
  const totalSalesPrev = toNum(vmPrev._sum.valorTotal);
  const salesTrendPct =
    totalSalesPrev > 0
      ? ((totalSales - totalSalesPrev) / totalSalesPrev) * 100
      : null;

  // 5. Weekly chart — últimos 7 dias de unidades vendidas, sobre Venda diária.
  let weeklyChart: DashboardHeroDayBucket[] | null = null;
  if (farmaciaIds.length > 0) {
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
    const buckets: DashboardHeroDayBucket[] = [];
    for (let i = 0; i < WEEKLY_CHART_DAYS; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      buckets.push({
        dayLabel: dayLabel(d),
        date: isoDate(d),
        value: dailyMap.get(isoDate(d)) ?? 0,
      });
    }
    weeklyChart = buckets.every((b) => b.value === 0) ? null : buckets;
  }

  return {
    pharmaciesCount,
    transferSuggestionsTotal: allSuggestions.length,
    topTransferSuggestions,
    salesTrendPct,
    coverageAvgDays,
    lowCoverageCount,
    highVarianceCount,
    weeklyChart,
  };
}
