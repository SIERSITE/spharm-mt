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
import { resolverPar } from "@/lib/categoria-resolver";
import { restringirPorCatalogo, temFiltroCatalogo } from "@/lib/reporting/catalog-prefilter";
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

// ─── Recorrencia: meses distintos com venda ──────────────────────────────────
//
// Janela de DOZE meses, e nao os tres da procura activa. Sao medidas
// diferentes: a recorrencia precisa de horizonte para distinguir o
// artigo que vende todos os meses do que vendeu num acaso; a procura
// activa precisa de recencia. Usar a mesma janela para as duas era
// perguntar duas vezes a mesma coisa.
//
// `VendaMensal` e' mensal — "dias distintos com venda" nao e' calculavel
// sem ir as linhas de venda. O mais fino aqui e' o numero de MESES com
// quantidade > 0, e dize-lo e' melhor do que fingir precisao.
const MESES_RECORRENCIA = 12;

/** Índices [inicio, fimExclusivo) da janela de 12 meses completos. */
function janelaRecorrencia(agora: Date = new Date()): { inicio: number; fim: number } {
  // O mês corrente está incompleto e não conta — o mesmo critério das
  // janelas operacionais (ver lib/operational/janela-meses.ts).
  const fim = agora.getFullYear() * 12 + agora.getMonth() + 1;
  return { inicio: fim - MESES_RECORRENCIA, fim };
}

async function loadMesesComVenda(
  farmaciaIds: string[],
): Promise<Map<string, number>> {
  const prisma = await getPrisma();
  const { inicio, fim } = janelaRecorrencia();
  const linhas = await prisma.$queryRaw<
    Array<{ produtoId: string; farmaciaId: string; meses: bigint }>
  >(Prisma.sql`
    SELECT vm."produtoId", vm."farmaciaId", COUNT(*)::bigint AS meses
    FROM "VendaMensal" vm
    WHERE vm."farmaciaId" = ANY(${farmaciaIds})
      AND vm.quantidade > 0
      AND (vm.ano * 12 + vm.mes) >= ${inicio}
      AND (vm.ano * 12 + vm.mes) <  ${fim}
    GROUP BY 1, 2
  `);
  const mapa = new Map<string, number>();
  for (const l of linhas) mapa.set(`${l.produtoId}:${l.farmaciaId}`, Number(l.meses));
  return mapa;
}

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
  const [{ pfRows, salesMap }, ipfMap, mesesMap] = await Promise.all([
    loadPfAndSales(farmaciaIds, {
      // Default: include stock=0 rows so the "out-of-stock" filter works.
      // /transferencias still passes the default (excludes stock=0).
      includeOutOfStock: options?.includeOutOfStock ?? true,
    }),
    loadIpfBatch(farmaciaIds),
    // Terceira query, em paralelo com as outras duas: nao acrescenta
    // round-trip nenhum ao tempo de resposta.
    loadMesesComVenda(farmaciaIds),
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
      mesesComVenda12M: mesesMap.get(key) ?? 0,
      avgDaily90d,
      coverage,
      dci: p.dci,
      codigoATC: p.codigoATC,
      ...resolverPar({
        classificacaoNivel1: p.canonN1 ? { nome: p.canonN1 } : null,
        classificacaoNivel2: p.canonN2 ? { nome: p.canonN2 } : null,
      }),
      productType: p.productType,
      utilizacoes: p.utilizacoes ?? [],
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
    categoria: row.categoria,
    subcategoria: row.subcategoria,
    productType: row.productType,
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
  /** Categorias canónicas (NÍVEL 1). */
  categorias?: string[];
  /** Subcategorias canónicas (NÍVEL 2). */
  subcategorias?: string[];
  /** Utilizações por SLUG. Produto entra se corresponder a qualquer uma. */
  utilizacoes?: string[];
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
  /**
   * Universo dos filtros de catálogo. Carregado no servidor — o cliente
   * nunca vê Prisma.
   */
  filterOptions: {
    categorias: string[];
    subcategorias: Array<{ nome: string; categoria: string }>;
    utilizacoes: Array<{ slug: string; nome: string }>;
  };
  params: StockSearchParams;
  /**
   * `false` no estado inicial (sem pesquisa nem filtro operacional): a
   * tabela NÃO é carregada — só os KPIs. O cliente mostra um prompt a
   * pedir pesquisa/filtro em vez da lista. `true` quando há `q` ou um
   * filtro computado e a página de artigos foi efectivamente carregada.
   */
  tableLoaded: boolean;
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
  mesesComVenda12M: number;
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
  productType: string | null;
  canonN1: string | null;
  canonN2: string | null;
};

/** FROM + WHERE partilhado (q + farmácia empurrados para SQL). */
function stockFromWhere(
  effFarmaciaIds: string[],
  q: string | undefined,
  periodStart: number,
  periodEnd: number,
  /**
   * Restrição de catálogo (categoria/subcategoria/utilização), já
   * resolvida para ids por `restringirPorCatalogo`. `null` = sem
   * restrição; uma lista vazia nunca chega aqui — quem chama devolve
   * resultado vazio antes.
   */
  produtoIds?: string[] | null,
): Prisma.Sql {
  const conds: Prisma.Sql[] = [
    Prisma.sql`pf."stockAtual" IS NOT NULL`,
    Prisma.sql`pf."flagRetirado" = false`,
    Prisma.sql`pf."farmaciaId" = ANY(${effFarmaciaIds})`,
  ];
  if (produtoIds) {
    conds.push(Prisma.sql`pf."produtoId" = ANY(${produtoIds})`);
  }
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
  const recorrencia = janelaRecorrencia();
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
    LEFT JOIN (
      SELECT "produtoId", "farmaciaId", COUNT(*)::int AS "mesesComVenda12M"
      FROM "VendaMensal"
      WHERE "quantidade" > 0
        AND ("ano" * 12 + "mes") >= ${recorrencia.inicio}
        AND ("ano" * 12 + "mes") <  ${recorrencia.fim}
        AND "farmaciaId" = ANY(${effFarmaciaIds})
      GROUP BY "produtoId", "farmaciaId"
    ) rec ON rec."produtoId" = pf."produtoId" AND rec."farmaciaId" = pf."farmaciaId"
    LEFT JOIN "IndicadoresProdutoFarmacia" i
      ON i."produtoId" = pf."produtoId" AND i."farmaciaId" = pf."farmaciaId"
    LEFT JOIN "Classificacao" c1 ON c1.id = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao" c2 ON c2.id = p."classificacaoNivel2Id"
    WHERE ${Prisma.join(conds, " AND ")}
  `;
}

const STOCK_LEAN_SELECT = Prisma.sql`
  SELECT
    pf."produtoId", pf."farmaciaId",
    pf."stockAtual"::float  AS "stockAtual",
    pf."stockMinimo"::float AS "stockMinimo",
    COALESCE(vm."salesQty90d", 0)::float AS "salesQty90d",
    COALESCE(rec."mesesComVenda12M", 0)::int AS "mesesComVenda12M",
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
    p."productType" AS "productType",
    c1.nome AS "canonN1",
    c2.nome AS "canonN2",
    COALESCE(vm."salesQty90d", 0)::float AS "salesQty90d",
    COALESCE(rec."mesesComVenda12M", 0)::int AS "mesesComVenda12M",
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
    mesesComVenda12M: b.mesesComVenda12M,
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
    ...resolverPar({
      classificacaoNivel1: b.canonN1 ? { nome: b.canonN1 } : null,
      classificacaoNivel2: b.canonN2 ? { nome: b.canonN2 } : null,
    }),
    productType: b.productType,
    // A listagem não mostra utilizações por linha; o filtro corre em SQL
    // (`restringirPorCatalogo`) e traria uma agregação por produto sem
    // ninguém a lê-la. A ficha do artigo mostra-as.
    utilizacoes: [],
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

/**
 * KPIs do /stock via agregação SQL pura (COUNT + FILTER + window function),
 * SEM materializar o catálogo inteiro em JS. Replica EXACTAMENTE a cascata
 * de `computeStatusAndSuggestion` + `coverageDays`/`resolveAvg`:
 *
 *   ad  = hasIpf ? max(ipfAvg90d,0) : (sales>0 ? sales/90 : 0)
 *   cov = stock<=0 ? 0 : ad=0 ? NULL : stock/ad
 *   Parado      ⟸ sales<=0
 *   Baixa cob.  ⟸ (smin>0 e stock<=smin) OU (cov<7)            [só se sales>0]
 *   Transfer.   ⟸ cov>30 E existe peer (mesmo produto) com cov<14 finita
 *   Estável     ⟸ resto
 *
 * O peer-check usa MIN(cov) OVER (PARTITION BY produtoId): como a própria
 * linha tem cov>30, nunca é o mínimo <14, logo MIN<14 ⟺ existe OUTRA
 * farmácia com cobertura finita <14 — idêntico ao loop JS (null→Infinity,
 * ignorado por MIN). Usado APENAS no estado inicial (sem q/filtro); as
 * rotas com tabela carregada mantêm o cálculo JS canónico intacto.
 */
async function computeStockMetricsSql(
  prisma: Awaited<ReturnType<typeof getPrisma>>,
  effFarmaciaIds: string[],
  periodStart: number,
  periodEnd: number,
): Promise<StockMetrics> {
  const fromWhere = stockFromWhere(effFarmaciaIds, undefined, periodStart, periodEnd);
  const rows = await prisma.$queryRaw<
    Array<{
      referencias: number;
      baixaCobertura: number;
      stockParado: number;
      transferencias: number;
    }>
  >(Prisma.sql`
    WITH base AS (
      SELECT
        pf."produtoId" AS "produtoId",
        pf."stockAtual"::float  AS stock,
        pf."stockMinimo"::float AS smin,
        COALESCE(vm."salesQty90d", 0)::float AS sales,
        GREATEST(
          CASE
            WHEN i."produtoId" IS NOT NULL THEN COALESCE(i."mediaVendasDiarias90d", 0)::float
            WHEN COALESCE(vm."salesQty90d", 0) > 0 THEN COALESCE(vm."salesQty90d", 0)::float / 90.0
            ELSE 0
          END,
          0
        ) AS ad
      ${fromWhere}
    ),
    cov AS (
      SELECT base.*,
        CASE WHEN stock <= 0 THEN 0 WHEN ad = 0 THEN NULL ELSE stock / ad END AS coverage
      FROM base
    ),
    peer AS (
      SELECT cov.*,
        MIN(coverage) OVER (PARTITION BY "produtoId") AS min_peer_cov
      FROM cov
    ),
    classified AS (
      SELECT
        CASE
          WHEN sales <= 0 THEN 'parado'
          WHEN (smin IS NOT NULL AND smin > 0 AND stock <= smin)
               OR (coverage IS NOT NULL AND coverage < 7) THEN 'baixa'
          WHEN coverage IS NOT NULL AND coverage > 30
               AND min_peer_cov IS NOT NULL AND min_peer_cov < 14 THEN 'transfer'
          ELSE 'estavel'
        END AS status
      FROM peer
    )
    SELECT
      COUNT(*)::int                                      AS "referencias",
      COUNT(*) FILTER (WHERE status = 'baixa')::int      AS "baixaCobertura",
      COUNT(*) FILTER (WHERE status = 'parado')::int     AS "stockParado",
      COUNT(*) FILTER (WHERE status = 'transfer')::int   AS "transferencias"
    FROM classified
  `);
  const r = rows[0];
  return {
    referencias: Number(r?.referencias ?? 0),
    baixaCobertura: Number(r?.baixaCobertura ?? 0),
    stockParado: Number(r?.stockParado ?? 0),
    transferencias: Number(r?.transferencias ?? 0),
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

  // Universo dos filtros de catálogo. Três consultas leves ao vocabulário
  // — não ao catálogo — e ficam disponíveis mesmo no estado vazio, senão
  // o utilizador não tinha por onde começar.
  const [n1, n2, utils] = await Promise.all([
    prisma.classificacao.findMany({
      where: { tipo: "NIVEL_1", estado: "ATIVO" },
      select: { nome: true },
      orderBy: { nome: "asc" },
    }),
    prisma.classificacao.findMany({
      where: { tipo: "NIVEL_2", estado: "ATIVO" },
      select: { nome: true, classificacaoPai: { select: { nome: true } } },
      orderBy: { nome: "asc" },
    }),
    prisma.$queryRaw<Array<{ slug: string; nome: string }>>(Prisma.sql`
      SELECT DISTINCT u.slug, u.nome
        FROM "Utilizacao" u
        JOIN "ProdutoUtilizacao" pu ON pu."utilizacaoId" = u.id
       WHERE u.estado = 'ATIVO'
       ORDER BY u.nome
    `),
  ]);
  const opcoesCatalogo = {
    categorias: n1.map((c) => c.nome),
    subcategorias: n2.map((c) => ({ nome: c.nome, categoria: c.classificacaoPai?.nome ?? "" })),
    utilizacoes: utils,
  };
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
    filterOptions: opcoesCatalogo,
    params: { ...params, page, pageSize },
    tableLoaded: false,
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

  // Catálogo: categoria (N1) é uma restrição de produto como as outras;
  // subcategoria e utilização passam pelo helper partilhado. Tudo
  // resolvido para ids e empurrado para o WHERE — nunca filtrado em JS
  // depois de materializar o catálogo inteiro.
  const filtrosCatalogo = {
    categorias: params.categorias,
    subcategorias: params.subcategorias,
    utilizacoes: params.utilizacoes,
  };
  let produtoIds: string[] | null = null;
  if (filtrosCatalogo.categorias && filtrosCatalogo.categorias.length > 0) {
    const n1 = await prisma.classificacao.findMany({
      where: { tipo: "NIVEL_1", estado: "ATIVO", nome: { in: filtrosCatalogo.categorias } },
      select: { id: true },
    });
    if (n1.length === 0) return empty();
    const produtos = await prisma.produto.findMany({
      where: { classificacaoNivel1Id: { in: n1.map((c) => c.id) } },
      select: { id: true },
    });
    produtoIds = produtos.map((p) => p.id);
    if (produtoIds.length === 0) return empty();
  }
  if (temFiltroCatalogo(filtrosCatalogo)) {
    produtoIds = await restringirPorCatalogo(prisma, filtrosCatalogo, produtoIds);
    if (produtoIds && produtoIds.length === 0) return empty();
  }
  const temFiltroDeCatalogo = produtoIds !== null;

  const fromWhere = stockFromWhere(effFarmaciaIds, q, periodStart, periodEnd, produtoIds);

  const coverageSet = new Set(params.coverageBuckets ?? []);
  const statusSet = new Set(params.statusBuckets ?? []);
  const hasComputedFilter =
    !!params.filter || coverageSet.size > 0 || statusSet.size > 0;

  // ── EMPTY STATE ────────────────────────────────────────────────────────
  // Sem pesquisa (`q`) e sem filtro operacional: NÃO carregar a tabela. O
  // catálogo pode ter dezenas de milhares de linhas — materializá-lo só para
  // mostrar a primeira página é o que tornava o /stock lento ao abrir. Aqui
  // só calculamos os KPIs (agregação SQL, sem trazer linhas para JS) e o
  // cliente mostra um prompt a pedir pesquisa/filtro em vez da listagem.
  // Um filtro de catálogo é um pedido explícito tanto como uma pesquisa:
  // quem escolhe "Diabetes" quer ver a lista, não o prompt.
  const shouldLoadTable = !!q || hasComputedFilter || temFiltroDeCatalogo;
  if (!shouldLoadTable) {
    const metrics = await computeStockMetricsSql(
      prisma,
      effFarmaciaIds,
      periodStart,
      periodEnd,
    );
    return {
      rows: [],
      totalRows: metrics.referencias,
      page,
      pageSize,
      pharmacyNames,
      metrics,
      filter: null,
      filterOptions: opcoesCatalogo,
      params: { ...params, page, pageSize },
      tableLoaded: false,
    };
  }

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
        ORDER BY p.designacao ASC, f.nome ASC, pf."produtoId" ASC
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
      filterOptions: opcoesCatalogo,
      params: { ...params, page, pageSize },
      tableLoaded: true,
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
    filterOptions: opcoesCatalogo,
    params: { ...params, page, pageSize },
    tableLoaded: true,
  };
}
