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

// ─── Backwards-compat legacy shape para /stock client ────────────────────────

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

  const sorted = filtered.slice().sort((a, b) => {
    const av = a.stockAtual * (a.puc ?? a.pmc ?? 0);
    const bv = b.stockAtual * (b.puc ?? b.pmc ?? 0);
    return bv - av;
  });

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
