/**
 * lib/stock-data.ts
 *
 * Server-only. Loaders Prisma para a página /stock e para a dashboard.
 * Os tipos/labels/predicados (que precisam de viver tanto no servidor
 * como no cliente) ficam em `lib/stock-shared.ts` — re-exportados aqui
 * para conveniência dos callers do servidor.
 *
 * IMPORTANTE: NUNCA importar este ficheiro a partir de um Client
 * Component. Use `@/lib/stock-shared` em vez disso.
 */
import "server-only";
import { loadPfAndSales } from "@/lib/transferencias-data";
import { getPrisma } from "@/lib/prisma";
import {
  avgDaily,
  coverageDays,
  rotationClass,
  WINDOW_90D,
} from "@/lib/operational/metrics-shared";
import { loadIpfBatch, resolveAvgDaily90d } from "@/lib/operational/ipf-reader";
import {
  matchStockFilter,
  type StockFilter,
  type StockMetrics,
  type StockRow,
  type StockRowEnriched,
} from "@/lib/stock-shared";

// Re-exports para callers server-side que esperam a superfície completa.
export {
  STOCK_FILTER_LABELS,
  isStockFilter,
  matchStockFilter,
} from "@/lib/stock-shared";
export type {
  StockFilter,
  StockMetrics,
  StockRow,
  StockRowEnriched,
} from "@/lib/stock-shared";

// ─── Loader (full dataset) ───────────────────────────────────────────────────

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

  // Dual-read: IPF + sales em paralelo. Quando IPF tem linha para o
  // par (produto, farmacia), o avgDaily90d vem do indicador pré-
  // calculado. Caso contrário, computa-se live a partir de salesMap.
  // Output numérico idêntico (drift 0.0000 confirmado em dry-run).
  const [{ pfRows, salesMap }, ipfMap] = await Promise.all([
    loadPfAndSales(farmaciaIds, {
      // Default: include stock=0 rows so the "out-of-stock" filter works.
      // /transferencias still passes the default (excludes stock=0).
      includeOutOfStock: options?.includeOutOfStock ?? true,
    }),
    loadIpfBatch(farmaciaIds),
  ]);

  return pfRows.map((p) => {
    const key = `${p.produtoId}:${p.farmaciaId}`;
    const salesQty90d = salesMap.get(key) ?? 0;
    const liveAd = avgDaily(salesQty90d, WINDOW_90D);
    const { value: avgDaily90d } = resolveAvgDaily90d(ipfMap.get(key), liveAd);
    const coverage = coverageDays(Number(p.stockAtual), avgDaily90d);
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
      dci: p.dci,
      codigoATC: p.codigoATC,
    };
  });
}

// ─── Backwards-compat legacy shape para /stock client ────────────────────────

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
  const rotClass = rotationClass(avgDaily90d, null);
  const rotationStr = rotClass === "alta" ? "Alta" : rotClass === "media" ? "Média" : "Baixa";

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
    dci: row.dci,
    codigoATC: row.codigoATC,
  };
}

// ─── Search params + paginação server-side ──────────────────────────────────

export const STOCK_COVERAGE_BUCKETS = ["0-5 dias", "6-15 dias", "16+ dias"] as const;
export type StockCoverageBucket = (typeof STOCK_COVERAGE_BUCKETS)[number];

export const STOCK_STATUS_VALUES: StockRow["status"][] = [
  "Estável",
  "Baixa cobertura",
  "Parado",
  "Transferência sugerida",
];

export const STOCK_DEFAULT_PAGE_SIZE = 50;
export const STOCK_MAX_PAGE_SIZE = 200;

export type StockSearchParams = {
  q?: string;
  pharmacies?: string[];
  coverageBuckets?: StockCoverageBucket[];
  statusBuckets?: StockRow["status"][];
  filter?: StockFilter;
  page: number;
  pageSize: number;
};

export type StockPageData = {
  rows: StockRow[];
  totalRows: number;
  page: number;
  pageSize: number;
  pharmacyNames: string[];
  metrics: StockMetrics;
  filter: StockFilter | null;
  params: StockSearchParams;
};

function getCoverageBucket(coverageStr: string): StockCoverageBucket | null {
  const days = parseInt(coverageStr, 10);
  if (Number.isNaN(days)) return null;
  if (days <= 5) return "0-5 dias";
  if (days <= 15) return "6-15 dias";
  return "16+ dias";
}

export function clampStockPage(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export function clampStockPageSize(n: number): number {
  if (!Number.isFinite(n) || n < 1) return STOCK_DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), STOCK_MAX_PAGE_SIZE);
}

export function isStockCoverageBucket(v: string): v is StockCoverageBucket {
  return (STOCK_COVERAGE_BUCKETS as readonly string[]).includes(v);
}

export function isStockStatus(v: string): v is StockRow["status"] {
  return (STOCK_STATUS_VALUES as string[]).includes(v);
}

export async function getStockData(params: StockSearchParams): Promise<StockPageData> {
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
      totalRows: 0,
      page: params.page,
      pageSize: params.pageSize,
      pharmacyNames,
      metrics: { referencias: 0, baixaCobertura: 0, stockParado: 0, transferencias: 0 },
      filter: params.filter ?? null,
      params,
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

  const legacyAll: StockRow[] = enriched.map((r) => toLegacyRow(r, peerCoverageMap));

  const normalizedQ = params.q?.trim().toLowerCase() ?? "";
  const pharmaciesSet = new Set(params.pharmacies ?? []);
  const coverageSet = new Set(params.coverageBuckets ?? []);
  const statusSet = new Set(params.statusBuckets ?? []);

  const filtered = legacyAll.filter((row, idx) => {
    const enrichedRow = enriched[idx];
    if (params.filter && !matchStockFilter(enrichedRow, params.filter)) return false;
    if (normalizedQ.length > 0) {
      const hay = `${row.product} ${row.cnp} ${row.pharmacy} ${row.dci ?? ""} ${row.codigoATC ?? ""}`.toLowerCase();
      if (!hay.includes(normalizedQ)) return false;
    }
    if (pharmaciesSet.size > 0 && !pharmaciesSet.has(row.pharmacy)) return false;
    if (coverageSet.size > 0) {
      const bucket = getCoverageBucket(row.coverage);
      if (!bucket || !coverageSet.has(bucket)) return false;
    }
    if (statusSet.size > 0 && !statusSet.has(row.status)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    // Stable, deterministic order: by product asc, then pharmacy asc.
    if (a.product < b.product) return -1;
    if (a.product > b.product) return 1;
    if (a.pharmacy < b.pharmacy) return -1;
    if (a.pharmacy > b.pharmacy) return 1;
    return 0;
  });

  const totalRows = filtered.length;
  const page = clampStockPage(params.page);
  const pageSize = clampStockPageSize(params.pageSize);
  const start = (page - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);

  // Metrics from the FULL filtered set (not just current page).
  const metrics: StockMetrics = {
    referencias: totalRows,
    baixaCobertura: filtered.filter((r) => r.status === "Baixa cobertura").length,
    stockParado: filtered.filter((r) => r.status === "Parado").length,
    transferencias: filtered.filter((r) => r.status === "Transferência sugerida").length,
  };

  return {
    rows: visible,
    totalRows,
    page,
    pageSize,
    pharmacyNames,
    metrics,
    filter: params.filter ?? null,
    params: { ...params, page, pageSize },
  };
}
