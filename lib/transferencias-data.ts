/**
 * lib/transferencias-data.ts
 * Server-side data for the transferencias and excessos pages.
 *
 * Transfer suggestions: products existing in BOTH pharmacies where one has
 * significant excess coverage and the other has a deficit.
 *
 * Excess identification: products with coverage >> threshold in any pharmacy,
 * regardless of whether the other pharmacy needs them.
 */
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { resolveCategoria } from "@/lib/categoria-resolver";
import {
  avgDaily,
  coverageDays,
  EXCESSO_COVERAGE_DAYS,
  WINDOW_90D,
} from "@/lib/operational/metrics-shared";
import { loadIpfBatch, resolveAvgDaily90d } from "@/lib/operational/ipf-reader";
import {
  findInternalSubstitutions,
  type InternalSubstitution,
  type SubstitutionOptions,
} from "@/lib/transfers/internal-substitution";

export type Priority = "alta" | "media" | "baixa";

export type TransferSuggestionRow = {
  cnp: string;
  produto: string;
  farmaciaOrigem: string;
  farmaciaDestino: string;
  stockOrigem: number;
  stockDestino: number;
  coberturaOrigem: number;
  coberturaDestino: number;
  quantidadeSugerida: number;
  excessoOrigem: number;
  necessidadeDestino: number;
  fabricante: string;
  categoria: string;
  fornecedor: string;
  prioridade: Priority;
  observacao?: string;
  /**
   * Valor estimado em € que fica disponível ao executar a transferência:
   * `quantidadeSugerida × pvp` na farmácia de origem. 0 quando não há pvp
   * registado.
   */
  valorUnlocked: number;
  // Enriquecimento clínico — surfaced em tooltip na UI.
  dci: string | null;
  codigoATC: string | null;
  // IDs internos — necessários ao CTA "Criar transferência".
  produtoId: string;
  farmaciaOrigemId: string;
  farmaciaDestinoId: string;
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type PfBase = {
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
  categoriaOrigem: string | null;
  subcategoriaOrigem: string | null;
  canonN1: string | null;
  canonN2: string | null;
  fornecedorOrigem: string | null;
  fabricanteCanonico: string | null;
  // Enriquecimento clínico — usado por tooltips na UI (item 3) e pelo
  // detector DCI-equivalente (lib/transfers/dci-equivalent-substitution).
  dci: string | null;
  codigoATC: string | null;
};

export type LoadPfAndSalesOptions = {
  /**
   * Por defeito (false) `loadPfAndSales` só devolve linhas com
   * stockAtual > 0 — preserva o comportamento original usado pela
   * página /transferencias e /excessos. Para a página /stock e o
   * dashboard, que precisam de ver produtos em rotura, passar `true`.
   */
  includeOutOfStock?: boolean;
};

export async function loadPfAndSales(
  farmaciaIds: string[],
  options?: LoadPfAndSalesOptions,
): Promise<{
  pfRows: PfBase[];
  salesMap: Map<string, number>;
}> {
  const prisma = await getPrisma();
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const periodStart = periodEnd - 3; // last 3 months

  const includeOutOfStock = options?.includeOutOfStock ?? false;
  const stockClause = includeOutOfStock
    ? Prisma.sql`pf."stockAtual" IS NOT NULL`
    : Prisma.sql`pf."stockAtual" IS NOT NULL AND pf."stockAtual" > 0`;

  const pfRows = await prisma.$queryRaw<PfBase[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome            AS "farmaciaNome",
      p.cnp::text       AS cnp,
      p.designacao,
      pf."stockAtual"::float           AS "stockAtual",
      pf."stockMinimo"::float          AS "stockMinimo",
      pf.pvp::float                    AS pvp,
      pf.puc::float                    AS puc,
      pf.pmc::float                    AS pmc,
      pf."dataUltimaVenda"             AS "dataUltimaVenda",
      pf."categoriaOrigem",
      pf."subcategoriaOrigem",
      c1.nome                          AS "canonN1",
      c2.nome                          AS "canonN2",
      pf."fornecedorOrigem",
      fab."nomeNormalizado"            AS "fabricanteCanonico",
      p.dci                            AS dci,
      p."codigoATC"                    AS "codigoATC"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto"  p ON p.id  = pf."produtoId"
    JOIN "Farmacia" f ON f.id  = pf."farmaciaId"
    LEFT JOIN "Fabricante"    fab ON fab.id = p."fabricanteId"
    LEFT JOIN "Classificacao" c1  ON c1.id  = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao" c2  ON c2.id  = p."classificacaoNivel2Id"
    WHERE
      ${stockClause}
      AND pf."flagRetirado" = false
      AND f.id = ANY(${farmaciaIds})
  `);

  type SalesAgg = { produtoId: string; farmaciaId: string; totalQty: number };
  const salesRows = await prisma.$queryRaw<SalesAgg[]>(Prisma.sql`
    SELECT
      vm."produtoId",
      vm."farmaciaId",
      SUM(vm.quantidade)::float AS "totalQty"
    FROM "VendaMensal" vm
    WHERE
      (vm.ano * 12 + vm.mes) >= ${periodStart}
      AND (vm.ano * 12 + vm.mes) < ${periodEnd}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."produtoId", vm."farmaciaId"
  `);

  const salesMap = new Map<string, number>();
  for (const s of salesRows) salesMap.set(`${s.produtoId}:${s.farmaciaId}`, toF(s.totalQty));

  return { pfRows, salesMap };
}

/** Transfer suggestions: products with coverage imbalance between the two pharmacies. */
export async function getTransferenciasData(): Promise<TransferSuggestionRow[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length < 2) return [];

  // Dual-read: IPF + sales em paralelo. Quando IPF tem linha, usa
  // mediaVendasDiarias90d (pré-calculado, drift 0 vs live); cai para
  // VendaMensal × 90d quando IPF ausente.
  const [{ pfRows, salesMap }, ipfMap] = await Promise.all([
    loadPfAndSales(farmaciaIds),
    loadIpfBatch(farmaciaIds),
  ]);

  // Group by produtoId
  type Entry = PfBase & { avgDaily: number; coverage: number };
  const byProduto = new Map<string, Entry[]>();
  for (const row of pfRows) {
    const key = `${row.produtoId}:${row.farmaciaId}`;
    const qty3m = salesMap.get(key) ?? 0;
    const liveAd = avgDaily(qty3m, WINDOW_90D);
    const { value: ad } = resolveAvgDaily90d(ipfMap.get(key), liveAd);
    const cov = coverageDays(toF(row.stockAtual), ad);
    const coverage = cov === null ? Infinity : cov;
    if (!byProduto.has(row.produtoId)) byProduto.set(row.produtoId, []);
    byProduto.get(row.produtoId)!.push({ ...row, avgDaily: ad, coverage });
  }

  const result: TransferSuggestionRow[] = [];

  for (const [, entries] of byProduto) {
    if (entries.length < 2) continue; // must exist in both pharmacies

    // Find pairs with coverage imbalance
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a.coverage === Infinity || b.coverage === Infinity) continue;

        // Determine origin (excess) and destination (deficit)
        let origem = a;
        let destino = b;
        if (b.coverage > a.coverage) { origem = b; destino = a; }

        // Only suggest if ratio >= 2.5:1 and destination has < 20 days
        if (origem.coverage < 20 || destino.coverage > 20) continue;
        if (origem.coverage / Math.max(destino.coverage, 1) < 2.5) continue;

        // Equalize to ~20 days each
        const avgDaily = (origem.avgDaily + destino.avgDaily) / 2;
        const targetDays = 20;
        const qtyToTransfer = Math.max(1, Math.round((origem.coverage - targetDays) * origem.avgDaily * 0.5));
        if (qtyToTransfer < 1) continue;

        const excessoOrigem = Math.round((origem.coverage - targetDays) * origem.avgDaily);
        const necessidadeDestino = Math.round((targetDays - destino.coverage) * destino.avgDaily);

        const prioridade: Priority =
          destino.coverage < 7 ? "alta" : destino.coverage < 14 ? "media" : "baixa";

        const finalQty = Math.min(qtyToTransfer, Math.round(toF(origem.stockAtual)));
        const valorUnlocked =
          origem.pvp != null && origem.pvp > 0 ? finalQty * origem.pvp : 0;

        result.push({
          cnp: origem.cnp,
          produto: origem.designacao,
          farmaciaOrigem: origem.farmaciaNome,
          farmaciaDestino: destino.farmaciaNome,
          stockOrigem: Math.round(toF(origem.stockAtual)),
          stockDestino: Math.round(toF(destino.stockAtual)),
          coberturaOrigem: Math.round(origem.coverage),
          coberturaDestino: Math.round(destino.coverage),
          quantidadeSugerida: finalQty,
          excessoOrigem: Math.max(0, excessoOrigem),
          necessidadeDestino: Math.max(0, necessidadeDestino),
          // Fabricante CANÓNICO via Produto.fabricante; fornecedor é o
          // grossista habitual (ProdutoFarmacia.fornecedorOrigem).
          fabricante: origem.fabricanteCanonico ?? "",
          categoria: resolveCategoria({
            classificacaoNivel1: origem.canonN1 ? { nome: origem.canonN1 } : null,
            classificacaoNivel2: origem.canonN2 ? { nome: origem.canonN2 } : null,
            categoriaOrigem: origem.categoriaOrigem,
            subcategoriaOrigem: origem.subcategoriaOrigem,
          }).grupo,
          fornecedor: origem.fornecedorOrigem ?? "",
          prioridade,
          observacao:
            prioridade === "alta"
              ? "Rutura previsível no destino, excesso confortável na origem."
              : prioridade === "media"
                ? "Transferência recomendada antes de reposição externa."
                : "Afinação opcional de cobertura.",
          valorUnlocked,
          dci: origem.dci,
          codigoATC: origem.codigoATC,
          produtoId: origem.produtoId,
          farmaciaOrigemId: origem.farmaciaId,
          farmaciaDestinoId: destino.farmaciaId,
        });
      }
    }
  }

  // Sort by priority then by deficit severity
  const rank: Record<Priority, number> = { alta: 3, media: 2, baixa: 1 };
  result.sort((a, b) => rank[b.prioridade] - rank[a.prioridade] || a.coberturaDestino - b.coberturaDestino);

  return result.slice(0, 200);
}

export type ExcessosOptions = {
  /**
   * Coverage threshold in days; products with coverage > thresholdDays are
   * excess. Default = `EXCESSO_COVERAGE_DAYS` (180), partilhado com
   * Inventário e Dashboard via `lib/operational/metrics-shared.ts`.
   */
  thresholdDays?: number;
  /** Target coverage in days for the "excess quantity" calculation. Default 30. */
  targetDays?: number;
};

/**
 * Excess stock identification: products where coverage > thresholdDays.
 *
 * Default `thresholdDays = EXCESSO_COVERAGE_DAYS` (180) — mesma regra usada
 * por Inventário (`classifyEstado→EXCESSO`) e pelo Dashboard (filtro
 * `excess-stock-canonical`). Single source of truth em
 * `lib/operational/metrics-shared.ts`.
 *
 * `farmaciaDestino` mostra a outra farmácia se puder absorver parte do
 * excesso. As prioridades alta/média/baixa são relativas ao threshold base.
 */
export async function getExcessosData(
  options?: ExcessosOptions,
): Promise<TransferSuggestionRow[]> {
  const thresholdDays = options?.thresholdDays ?? EXCESSO_COVERAGE_DAYS;
  const targetDays = options?.targetDays ?? 30;

  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length === 0) return [];

  // Dual-read também em /excessos (mesma política de stock-data /
  // transferencias).
  const [{ pfRows, salesMap }, ipfMap] = await Promise.all([
    loadPfAndSales(farmaciaIds),
    loadIpfBatch(farmaciaIds),
  ]);

  // Build per-product map
  type Entry = PfBase & { avgDaily: number; coverage: number };
  const byProduto = new Map<string, Entry[]>();
  for (const row of pfRows) {
    const key = `${row.produtoId}:${row.farmaciaId}`;
    const qty3m = salesMap.get(key) ?? 0;
    const liveAd = avgDaily(qty3m, WINDOW_90D);
    const { value: ad } = resolveAvgDaily90d(ipfMap.get(key), liveAd);
    const cov = coverageDays(toF(row.stockAtual), ad);
    const coverage = cov === null ? Infinity : cov;
    if (!byProduto.has(row.produtoId)) byProduto.set(row.produtoId, []);
    byProduto.get(row.produtoId)!.push({ ...row, avgDaily: ad, coverage });
  }

  const result: TransferSuggestionRow[] = [];

  for (const [, entries] of byProduto) {
    for (const entry of entries) {
      if (entry.coverage === Infinity || entry.coverage <= thresholdDays) continue;
      if (entry.avgDaily <= 0) continue;

      const excessQty = Math.round((entry.coverage - targetDays) * entry.avgDaily);
      if (excessQty < 5) continue; // Only meaningful excesses

      // Check if there's another pharmacy that could use the excess
      const others = entries.filter((e) => e.farmaciaId !== entry.farmaciaId);
      const destino = others.length > 0 ? others[0] : null;
      const destinoNome = destino?.farmaciaNome ?? "—";
      const destCoverage = destino?.coverage !== undefined && destino.coverage !== Infinity ? Math.round(destino.coverage) : 0;
      const destStock = destino ? Math.round(toF(destino.stockAtual)) : 0;
      const destNecessidade = destino && destCoverage < targetDays ? Math.round((targetDays - destCoverage) * (destino.avgDaily || 0)) : 0;

      // Prioridade relativa ao threshold base — mantém a ordenação útil
      // qualquer que seja `thresholdDays` (default 180 ⇒ alta>360, media>270).
      const prioridade: Priority =
        entry.coverage > thresholdDays * 2
          ? "alta"
          : entry.coverage > thresholdDays * 1.5
            ? "media"
            : "baixa";

      const finalQty = Math.min(excessQty, Math.round(toF(entry.stockAtual)));
      const valorUnlocked =
        entry.pvp != null && entry.pvp > 0 ? finalQty * entry.pvp : 0;

      result.push({
        cnp: entry.cnp,
        produto: entry.designacao,
        farmaciaOrigem: entry.farmaciaNome,
        farmaciaDestino: destinoNome,
        stockOrigem: Math.round(toF(entry.stockAtual)),
        stockDestino: destStock,
        coberturaOrigem: Math.round(entry.coverage),
        coberturaDestino: destCoverage,
        quantidadeSugerida: finalQty,
        excessoOrigem: excessQty,
        necessidadeDestino: Math.max(0, destNecessidade),
        fabricante: entry.fabricanteCanonico ?? "",
        categoria: resolveCategoria({
          classificacaoNivel1: entry.canonN1 ? { nome: entry.canonN1 } : null,
          classificacaoNivel2: entry.canonN2 ? { nome: entry.canonN2 } : null,
          categoriaOrigem: entry.categoriaOrigem,
          subcategoriaOrigem: entry.subcategoriaOrigem,
        }).grupo,
        fornecedor: entry.fornecedorOrigem ?? "",
        prioridade,
        observacao: `Excesso de ${Math.round(entry.coverage)} dias de cobertura.`,
        valorUnlocked,
        dci: entry.dci,
        codigoATC: entry.codigoATC,
        produtoId: entry.produtoId,
        farmaciaOrigemId: entry.farmaciaId,
        farmaciaDestinoId: destino?.farmaciaId ?? "",
      });
    }
  }

  result.sort((a, b) => b.coberturaOrigem - a.coberturaOrigem);
  return result.slice(0, 200);
}

/**
 * Substituição operacional interna (WS-C Fase 1): para produtos em
 * ruptura iminente, encontra **mesmo CNP** com excesso noutra
 * farmácia do grupo. Mais agressivo do que `getTransferenciasData`
 * — destinos com `coverage < 7d` e origens com `coverage > 30d`.
 *
 * NÃO substitui `getTransferenciasData` — é um path adicional focado
 * em "encomendas evitáveis hoje". Para o relatório de transferência
 * tradicional (rebalancing entre farmácias com ratio 2.5:1), continua
 * a usar `getTransferenciasData`.
 *
 * Output: linhas `InternalSubstitution` com `suggestedSourceFarmaciaId`,
 * `stockCoverageOrigin`, `stockCoverageDestination`,
 * `avoidedPurchaseEstimate`. Ordenado por € poupados desc.
 */
export async function getInternalSubstitutionsData(
  options?: SubstitutionOptions,
): Promise<InternalSubstitution[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length < 2) return [];

  // includeOutOfStock=true porque o destino em ruptura pode ter
  // stockAtual=0. A origem precisa de ter stock para ser candidata —
  // o filtro final acontece em findInternalSubstitutions.
  const { pfRows, salesMap } = await loadPfAndSales(farmaciaIds, {
    includeOutOfStock: true,
  });

  const input = pfRows.map((p) => ({
    produtoId: p.produtoId,
    farmaciaId: p.farmaciaId,
    farmaciaNome: p.farmaciaNome,
    cnp: p.cnp,
    designacao: p.designacao,
    stockAtual: Number(p.stockAtual),
    puc: p.puc,
    salesQty: salesMap.get(`${p.produtoId}:${p.farmaciaId}`) ?? 0,
  }));

  return findInternalSubstitutions(input, options);
}
