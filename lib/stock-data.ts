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
import { Prisma } from "@/generated/prisma/client";
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

type PeerCoverageMap = Map<
  string,
  Array<{ farmaciaId: string; nome: string; coverage: number }>
>;

/**
 * Cascade canónica de estado + sugestão para uma linha de stock. ÚNICA
 * implementação — partilhada por `toLegacyRow` (display) e pelo cálculo
 * de métricas em `getStockData` (contagens), para garantir que os
 * cartões-resumo e as badges das linhas usam exactamente a mesma lógica.
 *
 * Prioridade: Parado > Baixa cobertura > Transferência sugerida > Estável.
 */
function computeStatusAndSuggestion(
  row: Pick<
    StockRowEnriched,
    "produtoId" | "farmaciaId" | "stockAtual" | "stockMinimo" | "coverage" | "avgDaily90d" | "salesQty90d"
  >,
  peerCoverageMap: PeerCoverageMap,
): { status: StockRow["status"]; suggestion: string } {
  const { stockAtual, coverage, avgDaily90d, salesQty90d, stockMinimo } = row;
  const belowMin =
    stockMinimo != null && stockMinimo > 0 && stockAtual <= stockMinimo;

  if (salesQty90d <= 0) {
    return { status: "Parado", suggestion: "Avaliar rotação" };
  }
  if (belowMin || (coverage !== null && coverage < 7)) {
    return { status: "Baixa cobertura", suggestion: "Reforçar stock" };
  }
  if (coverage != null) {
    const peers = (peerCoverageMap.get(row.produtoId) ?? []).filter(
      (p) => p.farmaciaId !== row.farmaciaId,
    );
    for (const peer of peers) {
      if (coverage > 30 && peer.coverage < 14 && Number.isFinite(peer.coverage)) {
        const qty = Math.max(
          1,
          Math.round((coverage - peer.coverage) * avgDaily90d * 0.4),
        );
        return {
          status: "Transferência sugerida",
          suggestion: `${qty} un. → ${peer.nome}`,
        };
      }
    }
  }
  return { status: "Estável", suggestion: "—" };
}

/** Constrói o mapa de cobertura por farmácia (peers) para um conjunto. */
function buildPeerCoverageMap(
  rows: Array<{ produtoId: string; farmaciaId: string; farmaciaNome: string; coverage: number | null }>,
): PeerCoverageMap {
  const m: PeerCoverageMap = new Map();
  for (const r of rows) {
    const list = m.get(r.produtoId) ?? [];
    list.push({
      farmaciaId: r.farmaciaId,
      nome: r.farmaciaNome,
      coverage: r.coverage ?? Infinity,
    });
    m.set(r.produtoId, list);
  }
  return m;
}

function toLegacyRow(
  row: StockRowEnriched,
  peerCoverageMap: PeerCoverageMap,
): StockRow {
  const { stockAtual, coverage, avgDaily90d, salesQty90d, dataUltimaVenda } = row;
  const { status, suggestion } = computeStatusAndSuggestion(row, peerCoverageMap);

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

// ─── SQL push-down: query dedicada de /stock ─────────────────────────────────
//
// Substitui o `loadStockEnriched` (full dataset) DENTRO de getStockData por
// uma query que empurra `q` + farmácia para o DB e — quando não há filtros
// computados — pagina em SQL. NUNCA materializa o catálogo inteiro só para
// mostrar uma página. `loadStockEnriched` mantém-se intacto para a dashboard.
//
// Junta apenas o necessário para um StockRow (pf→Produto→Farmacia) + LEFT
// JOIN da agregação VendaMensal (vendas 3m) + LEFT JOIN IPF — replicando
// exactamente o dual-read de `loadStockEnriched`/`resolveAvgDaily90d`
// (IPF presente → usa IPF; senão live = salesQty90d/90). Drop dos 3 joins
// (Fabricante/Classificacao×2) que o /stock não usa.

type StockSqlLean = {
  produtoId: string;
  farmaciaId: string;
  stockAtual: number;
  stockMinimo: number | null;
  salesQty90d: number;
  ipfAvg90d: number | null;
  hasIpf: boolean;
};

type StockSqlFull = StockSqlLean & {
  farmaciaNome: string;
  cnp: string;
  designacao: string;
  pvp: number | null;
  puc: number | null;
  pmc: number | null;
  dataUltimaVenda: Date | null;
  dci: string | null;
  codigoATC: string | null;
};

/** FROM + WHERE partilhado (q + farmácia empurrados para SQL). */
function stockFromWhere(
  effFarmaciaIds: string[],
  q: string | undefined,
  periodStart: number,
  periodEnd: number,
): Prisma.Sql {
  const conds: Prisma.Sql[] = [
    Prisma.sql`pf."stockAtual" IS NOT NULL`,
    Prisma.sql`pf."flagRetirado" = false`,
    Prisma.sql`pf."farmaciaId" = ANY(${effFarmaciaIds})`,
  ];
  if (q && q.length > 0) {
    const like = `%${q}%`;
    conds.push(Prisma.sql`(
      p.designacao ILIKE ${like}
      OR p.cnp::text ILIKE ${like}
      OR f.nome ILIKE ${like}
      OR COALESCE(p.dci, '') ILIKE ${like}
      OR COALESCE(p."codigoATC", '') ILIKE ${like}
    )`);
  }
  return Prisma.sql`
    FROM "ProdutoFarmacia" pf
    JOIN "Produto"  p ON p.id = pf."produtoId"
    JOIN "Farmacia" f ON f.id = pf."farmaciaId"
    LEFT JOIN (
      SELECT "produtoId", "farmaciaId", SUM("quantidade")::float AS "salesQty90d"
      FROM "VendaMensal"
      WHERE ("ano" * 12 + "mes") >= ${periodStart}
        AND ("ano" * 12 + "mes") <  ${periodEnd}
        AND "farmaciaId" = ANY(${effFarmaciaIds})
      GROUP BY "produtoId", "farmaciaId"
    ) vm ON vm."produtoId" = pf."produtoId" AND vm."farmaciaId" = pf."farmaciaId"
    LEFT JOIN "IndicadoresProdutoFarmacia" i
      ON i."produtoId" = pf."produtoId" AND i."farmaciaId" = pf."farmaciaId"
    WHERE ${Prisma.join(conds, " AND ")}
  `;
}

const STOCK_LEAN_SELECT = Prisma.sql`
  SELECT
    pf."produtoId", pf."farmaciaId",
    pf."stockAtual"::float  AS "stockAtual",
    pf."stockMinimo"::float AS "stockMinimo",
    COALESCE(vm."salesQty90d", 0)::float AS "salesQty90d",
    i."mediaVendasDiarias90d"::float AS "ipfAvg90d",
    (i."produtoId" IS NOT NULL) AS "hasIpf"
`;

const STOCK_FULL_SELECT = Prisma.sql`
  SELECT
    pf."produtoId", pf."farmaciaId",
    f.nome AS "farmaciaNome",
    p.cnp::text AS cnp,
    p.designacao,
    pf."stockAtual"::float  AS "stockAtual",
    pf."stockMinimo"::float AS "stockMinimo",
    pf.pvp::float AS pvp,
    pf.puc::float AS puc,
    pf.pmc::float AS pmc,
    pf."dataUltimaVenda" AS "dataUltimaVenda",
    p.dci AS dci,
    p."codigoATC" AS "codigoATC",
    COALESCE(vm."salesQty90d", 0)::float AS "salesQty90d",
    i."mediaVendasDiarias90d"::float AS "ipfAvg90d",
    (i."produtoId" IS NOT NULL) AS "hasIpf"
`;

/** avgDaily90d com a MESMA política de `resolveAvgDaily90d` (IPF > live). */
function resolveAvg(salesQty90d: number, hasIpf: boolean, ipfAvg90d: number | null): number {
  if (hasIpf) return ipfAvg90d ?? 0;
  return avgDaily(salesQty90d, WINDOW_90D);
}

function enrichFull(b: StockSqlFull): StockRowEnriched {
  const avgDaily90d = resolveAvg(b.salesQty90d, b.hasIpf, b.ipfAvg90d);
  return {
    produtoId: b.produtoId,
    farmaciaId: b.farmaciaId,
    farmaciaNome: b.farmaciaNome,
    cnp: b.cnp,
    designacao: b.designacao,
    stockAtual: b.stockAtual,
    stockMinimo: b.stockMinimo,
    pvp: b.pvp,
    puc: b.puc,
    pmc: b.pmc,
    dataUltimaVenda: b.dataUltimaVenda,
    salesQty90d: b.salesQty90d,
    avgDaily90d,
    coverage: coverageDays(b.stockAtual, avgDaily90d),
    dci: b.dci,
    codigoATC: b.codigoATC,
  };
}

type StockLite = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  stockAtual: number;
  stockMinimo: number | null;
  salesQty90d: number;
  avgDaily90d: number;
  coverage: number | null;
};

function enrichLean(b: StockSqlLean, nomeById: Map<string, string>): StockLite {
  const avgDaily90d = resolveAvg(b.salesQty90d, b.hasIpf, b.ipfAvg90d);
  return {
    produtoId: b.produtoId,
    farmaciaId: b.farmaciaId,
    farmaciaNome: nomeById.get(b.farmaciaId) ?? "—",
    stockAtual: b.stockAtual,
    stockMinimo: b.stockMinimo,
    salesQty90d: b.salesQty90d,
    avgDaily90d,
    coverage: coverageDays(b.stockAtual, avgDaily90d),
  };
}

export async function getStockData(params: StockSearchParams): Promise<StockPageData> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const pharmacyNames = farmacias.map((f) => f.nome);
  const nomeById = new Map(farmacias.map((f) => [f.id, f.nome]));
  const page = clampStockPage(params.page);
  const pageSize = clampStockPageSize(params.pageSize);

  const empty = (): StockPageData => ({
    rows: [],
    totalRows: 0,
    page,
    pageSize,
    pharmacyNames,
    metrics: { referencias: 0, baixaCobertura: 0, stockParado: 0, transferencias: 0 },
    filter: params.filter ?? null,
    params: { ...params, page, pageSize },
  });

  if (farmacias.length === 0) return empty();

  // Filtro de farmácia (por nome) → ids. Empurrado para SQL.
  const selectedNames = new Set(params.pharmacies ?? []);
  const effFarmaciaIds =
    selectedNames.size > 0
      ? farmacias.filter((f) => selectedNames.has(f.nome)).map((f) => f.id)
      : farmacias.map((f) => f.id);
  if (effFarmaciaIds.length === 0) return empty();

  const q = params.q?.trim() || undefined;
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const periodStart = periodEnd - 3; // últimos 3 meses (igual a loadPfAndSales)
  const fromWhere = stockFromWhere(effFarmaciaIds, q, periodStart, periodEnd);

  const coverageSet = new Set(params.coverageBuckets ?? []);
  const statusSet = new Set(params.statusBuckets ?? []);
  const hasComputedFilter =
    !!params.filter || coverageSet.size > 0 || statusSet.size > 0;

  // ── FAST PATH ──────────────────────────────────────────────────────────
  // Sem filtros computados (browse + pesquisa texto/farmácia): métricas via
  // query LEAN O(N) (estado calculado em JS com a math canónica) e a PÁGINA
  // via SQL LIMIT/OFFSET (só ≤pageSize linhas pesadas materializadas).
  if (!hasComputedFilter) {
    const leanRows = await prisma.$queryRaw<StockSqlLean[]>(
      Prisma.sql`${STOCK_LEAN_SELECT} ${fromWhere}`,
    );
    const lite = leanRows.map((r) => enrichLean(r, nomeById));
    const peerMap = buildPeerCoverageMap(lite);

    let baixaCobertura = 0;
    let stockParado = 0;
    let transferencias = 0;
    for (const r of lite) {
      const { status } = computeStatusAndSuggestion(r, peerMap);
      if (status === "Baixa cobertura") baixaCobertura++;
      else if (status === "Parado") stockParado++;
      else if (status === "Transferência sugerida") transferencias++;
    }
    const totalRows = lite.length;
    const offset = (page - 1) * pageSize;

    const pageRows = await prisma.$queryRaw<StockSqlFull[]>(
      Prisma.sql`${STOCK_FULL_SELECT} ${fromWhere}
        ORDER BY p.designacao ASC, f.nome ASC
        LIMIT ${pageSize} OFFSET ${offset}`,
    );
    const rows = pageRows.map((b) => toLegacyRow(enrichFull(b), peerMap));

    return {
      rows,
      totalRows,
      page,
      pageSize,
      pharmacyNames,
      metrics: { referencias: totalRows, baixaCobertura, stockParado, transferencias },
      filter: params.filter ?? null,
      params: { ...params, page, pageSize },
    };
  }

  // ── FALLBACK PATH ──────────────────────────────────────────────────────
  // Filtros computados activos (estado/cobertura/filter): precisam de estado
  // por linha sobre o conjunto inteiro → carrega o set (já reduzido por
  // q/farmácia em SQL), enriquece, filtra/ordena/pagina/conta em JS (lógica
  // idêntica à anterior).
  const allRows = await prisma.$queryRaw<StockSqlFull[]>(
    Prisma.sql`${STOCK_FULL_SELECT} ${fromWhere}`,
  );
  const enriched = allRows.map(enrichFull);
  const peerMap = buildPeerCoverageMap(enriched);
  const legacyAll: StockRow[] = enriched.map((r) => toLegacyRow(r, peerMap));

  const filtered = legacyAll.filter((row, idx) => {
    const e = enriched[idx];
    if (params.filter && !matchStockFilter(e, params.filter)) return false;
    if (coverageSet.size > 0) {
      const bucket = getCoverageBucket(row.coverage);
      if (!bucket || !coverageSet.has(bucket)) return false;
    }
    if (statusSet.size > 0 && !statusSet.has(row.status)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (a.product < b.product) return -1;
    if (a.product > b.product) return 1;
    if (a.pharmacy < b.pharmacy) return -1;
    if (a.pharmacy > b.pharmacy) return 1;
    return 0;
  });

  const totalRows = filtered.length;
  const start = (page - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);

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
