/**
 * lib/stock-data.ts
 *
 * Single source of truth for "stock filters". Both the dashboard's
 * critical-alerts/efficiency sections and the /stock page consume the
 * same predicate (`matchStockFilter`) and the same enriched dataset
 * (`loadStockEnriched`) — so the count shown in the dashboard always
 * equals the count visible in /stock under the same filter.
 *
 * Public surface:
 *   · `loadStockEnriched()` — full dataset, one row per
 *     (produto × farmacia), with coverage / avgDaily90d /
 *     dataUltimaVenda computed. Includes stockAtual <= 0 by default.
 *   · `matchStockFilter(row, filter)` — pure predicate.
 *   · `getStockData(filter?)` — backwards-compatible loader for the
 *     existing /stock client. Without a filter, preserves the
 *     historical "top 300 by stock value" behaviour. With a filter,
 *     drops the cap so the visible count matches the dashboard count.
 */
import "server-only";
import { loadPfAndSales } from "@/lib/transferencias-data";
import { getPrisma } from "@/lib/prisma";

// ─── Filtros (canónicos) ─────────────────────────────────────────────────────

export type StockFilter =
  | "out-of-stock"
  | "at-risk"
  | "excess-stock-60d"
  | "no-movement-3m"
  | "below-min";

export const STOCK_FILTER_LABELS: Record<StockFilter, string> = {
  "out-of-stock": "Em rotura (com vendas recentes)",
  "at-risk": "Em risco (cobertura < 7 dias)",
  "excess-stock-60d": "Excesso de stock (cobertura > 60 dias)",
  "no-movement-3m": "Sem movimento (90 dias)",
  "below-min": "Abaixo do stock mínimo",
};

export function isStockFilter(v: unknown): v is StockFilter {
  return (
    v === "out-of-stock" ||
    v === "at-risk" ||
    v === "excess-stock-60d" ||
    v === "no-movement-3m" ||
    v === "below-min"
  );
}

// ─── Linha enriquecida (consumida por dashboard + /stock) ────────────────────

export type StockRowEnriched = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  cnp: string;
  designacao: string;
  stockAtual: number;
  stockMinimo: number | null;
  pvp: number | null;
  puc: number | null;
  pmc: number | null;
  dataUltimaVenda: Date | null;
  /** Quantidade vendida nos últimos 3 meses (VendaMensal). */
  salesQty90d: number;
  /** salesQty90d / 90. */
  avgDaily90d: number;
  /** stockAtual / avgDaily90d. null quando avgDaily=0 (sem demanda mensurável). */
  coverage: number | null;
};

// ─── Predicado partilhado ────────────────────────────────────────────────────

export function matchStockFilter(row: StockRowEnriched, filter: StockFilter): boolean {
  switch (filter) {
    case "out-of-stock":
      return row.stockAtual <= 0 && row.salesQty90d > 0;
    case "at-risk":
      return row.stockAtual > 0 && row.coverage != null && row.coverage < 7;
    case "excess-stock-60d":
      return row.coverage != null && row.coverage > 60;
    case "no-movement-3m":
      return row.stockAtual > 0 && row.salesQty90d <= 0;
    case "below-min":
      return (
        row.stockMinimo != null &&
        row.stockMinimo > 0 &&
        row.stockAtual <= row.stockMinimo
      );
  }
}

// ─── Loader (full dataset) ───────────────────────────────────────────────────

const DAYS_90 = 90;

async function getActiveFarmaciaIds(): Promise<string[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true },
  });
  return farmacias.map((f) => f.id);
}

export async function loadStockEnriched(
  options?: { includeOutOfStock?: boolean },
): Promise<StockRowEnriched[]> {
  const farmaciaIds = await getActiveFarmaciaIds();
  if (farmaciaIds.length === 0) return [];

  const { pfRows, salesMap } = await loadPfAndSales(farmaciaIds, {
    // Default: include stock=0 rows so the "out-of-stock" filter works.
    // /transferencias still passes the default (excludes stock=0).
    includeOutOfStock: options?.includeOutOfStock ?? true,
  });

  return pfRows.map((p) => {
    const salesQty90d = salesMap.get(`${p.produtoId}:${p.farmaciaId}`) ?? 0;
    const avgDaily90d = salesQty90d / DAYS_90;
    const coverage = avgDaily90d > 0 ? Number(p.stockAtual) / avgDaily90d : null;
    return {
      produtoId: p.produtoId,
      farmaciaId: p.farmaciaId,
      farmaciaNome: p.farmaciaNome,
      cnp: p.cnp,
      designacao: p.designacao,
      stockAtual: Number(p.stockAtual),
      stockMinimo: p.stockMinimo,
      pvp: p.pvp,
      puc: p.puc,
      pmc: p.pmc,
      dataUltimaVenda: p.dataUltimaVenda,
      salesQty90d,
      avgDaily90d,
      coverage,
    };
  });
}

// ─── Backwards-compat legacy shape ───────────────────────────────────────────
//
// O cliente /stock existente (StockClient) consome StockRow + StockMetrics.
// Mantemos esse contrato; a única diferença é que `getStockData(filter)` agora
// pré-filtra o universo via matchStockFilter antes de produzir as linhas, e
// quando há filtro deixa cair o LIMIT histórico de 300 (para a contagem da
// dashboard bater certo com a contagem do /stock).

export type StockRow = {
  product: string;
  cnp: string;
  pharmacy: string;
  stock: number;
  coverage: string;
  rotation: string;
  lastMovement: string;
  status: "Estável" | "Baixa cobertura" | "Parado" | "Transferência sugerida";
  suggestion?: string;
};

export type StockMetrics = {
  referencias: number;
  baixaCobertura: number;
  stockParado: number;
  transferencias: number;
};

const LEGACY_ROW_LIMIT = 300;

function toLegacyRow(
  row: StockRowEnriched,
  peerCoverageMap: Map<
    string,
    Array<{ farmaciaId: string; nome: string; coverage: number }>
  >,
): StockRow {
  const { stockAtual, coverage, avgDaily90d, salesQty90d, stockMinimo, dataUltimaVenda } = row;
  const belowMin =
    stockMinimo != null && stockMinimo > 0 && stockAtual <= stockMinimo;

  let status: StockRow["status"] = "Estável";
  let suggestion = "—";

  if (salesQty90d <= 0) {
    status = "Parado";
    suggestion = "Avaliar rotação";
  } else if (belowMin || (coverage !== null && coverage < 7)) {
    status = "Baixa cobertura";
    suggestion = "Reforçar stock";
  } else if (coverage != null) {
    const peers = (peerCoverageMap.get(row.produtoId) ?? []).filter(
      (p) => p.farmaciaId !== row.farmaciaId,
    );
    for (const peer of peers) {
      if (coverage > 30 && peer.coverage < 14 && Number.isFinite(peer.coverage)) {
        const qty = Math.max(
          1,
          Math.round((coverage - peer.coverage) * avgDaily90d * 0.4),
        );
        status = "Transferência sugerida";
        suggestion = `${qty} un. → ${peer.nome}`;
        break;
      }
    }
  }

  const coverageStr = coverage === null ? "∞" : `${Math.round(coverage)} dias`;
  const rotationStr =
    avgDaily90d > 0.5 ? "Alta" : avgDaily90d > 0.1 ? "Média" : "Baixa";

  let lastMovement = "—";
  if (dataUltimaVenda) {
    const days = Math.floor(
      (Date.now() - new Date(dataUltimaVenda).getTime()) / 86_400_000,
    );
    lastMovement = days === 0 ? "Hoje" : days === 1 ? "Ontem" : `Há ${days} dias`;
  } else if (salesQty90d > 0) {
    lastMovement = "Recente";
  }

  return {
    product: row.designacao,
    cnp: row.cnp,
    pharmacy: row.farmaciaNome,
    stock: Math.round(stockAtual),
    coverage: coverageStr,
    rotation: rotationStr,
    lastMovement,
    status,
    suggestion,
  };
}

export async function getStockData(
  filter?: StockFilter,
): Promise<{
  rows: StockRow[];
  pharmacyNames: string[];
  metrics: StockMetrics;
  filter: StockFilter | null;
}> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const pharmacyNames = farmacias.map((f) => f.nome);
  if (farmacias.length === 0) {
    return {
      rows: [],
      pharmacyNames,
      metrics: { referencias: 0, baixaCobertura: 0, stockParado: 0, transferencias: 0 },
      filter: filter ?? null,
    };
  }

  const enriched = await loadStockEnriched({ includeOutOfStock: true });

  const peerCoverageMap = new Map<
    string,
    Array<{ farmaciaId: string; nome: string; coverage: number }>
  >();
  for (const r of enriched) {
    const cov = r.coverage ?? Infinity;
    const list = peerCoverageMap.get(r.produtoId) ?? [];
    list.push({ farmaciaId: r.farmaciaId, nome: r.farmaciaNome, coverage: cov });
    peerCoverageMap.set(r.produtoId, list);
  }

  const filtered = filter
    ? enriched.filter((r) => matchStockFilter(r, filter))
    : enriched;

  // Order by stock value desc (matches the existing default).
  const sorted = filtered.slice().sort((a, b) => {
    const av = a.stockAtual * (a.puc ?? a.pmc ?? 0);
    const bv = b.stockAtual * (b.puc ?? b.pmc ?? 0);
    return bv - av;
  });

  // Sem filtro: top 300 por valor de stock (histórico). Com filtro: tudo
  // (para que a contagem visível coincida com a contagem da dashboard).
  const visible = filter ? sorted : sorted.slice(0, LEGACY_ROW_LIMIT);
  const rows = visible.map((r) => toLegacyRow(r, peerCoverageMap));

  const metrics: StockMetrics = {
    referencias: rows.length,
    baixaCobertura: rows.filter((r) => r.status === "Baixa cobertura").length,
    stockParado: rows.filter((r) => r.status === "Parado").length,
    transferencias: rows.filter((r) => r.status === "Transferência sugerida").length,
  };

  return { rows, pharmacyNames, metrics, filter: filter ?? null };
}
