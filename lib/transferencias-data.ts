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
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

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
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type PfBase = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  cnp: string;
  designacao: string;
  stockAtual: number;
  puc: number | null;
  pmc: number | null;
  categoriaOrigem: string | null;
  fabricanteOrigem: string | null;
  familiaOrigem: string | null;
};

async function loadPfAndSales(farmaciaIds: string[]): Promise<{
  pfRows: PfBase[];
  salesMap: Map<string, number>;
}> {
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const periodStart = periodEnd - 3; // last 3 months

  const pfRows = await prisma.$queryRaw<PfBase[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome            AS "farmaciaNome",
      p.cnp::text       AS cnp,
      p.designacao,
      pf."stockAtual"::float           AS "stockAtual",
      pf.puc::float                    AS puc,
      pf.pmc::float                    AS pmc,
      pf."categoriaOrigem",
      pf."fabricanteOrigem",
      pf."familiaOrigem"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto"  p ON p.id  = pf."produtoId"
    JOIN "Farmacia" f ON f.id  = pf."farmaciaId"
    WHERE
      pf."stockAtual" IS NOT NULL
      AND pf."stockAtual" > 0
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
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length < 2) return [];

  const { pfRows, salesMap } = await loadPfAndSales(farmaciaIds);

  // Group by produtoId
  type Entry = PfBase & { avgDaily: number; coverage: number };
  const byProduto = new Map<string, Entry[]>();
  for (const row of pfRows) {
    const qty3m = salesMap.get(`${row.produtoId}:${row.farmaciaId}`) ?? 0;
    const avgDaily = qty3m / 90;
    const coverage = avgDaily > 0 ? toF(row.stockAtual) / avgDaily : Infinity;
    if (!byProduto.has(row.produtoId)) byProduto.set(row.produtoId, []);
    byProduto.get(row.produtoId)!.push({ ...row, avgDaily, coverage });
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

        result.push({
          cnp: origem.cnp,
          produto: origem.designacao,
          farmaciaOrigem: origem.farmaciaNome,
          farmaciaDestino: destino.farmaciaNome,
          stockOrigem: Math.round(toF(origem.stockAtual)),
          stockDestino: Math.round(toF(destino.stockAtual)),
          coberturaOrigem: Math.round(origem.coverage),
          coberturaDestino: Math.round(destino.coverage),
          quantidadeSugerida: Math.min(qtyToTransfer, Math.round(toF(origem.stockAtual))),
          excessoOrigem: Math.max(0, excessoOrigem),
          necessidadeDestino: Math.max(0, necessidadeDestino),
          fabricante: origem.fabricanteOrigem ?? "",
          categoria: origem.categoriaOrigem ?? "",
          fornecedor: origem.familiaOrigem ?? "",
          prioridade,
          observacao:
            prioridade === "alta"
              ? "Rutura previsível no destino, excesso confortável na origem."
              : prioridade === "media"
                ? "Transferência recomendada antes de reposição externa."
                : "Afinação opcional de cobertura.",
        });
      }
    }
  }

  // Sort by priority then by deficit severity
  const rank: Record<Priority, number> = { alta: 3, media: 2, baixa: 1 };
  result.sort((a, b) => rank[b.prioridade] - rank[a.prioridade] || a.coberturaDestino - b.coberturaDestino);

  return result.slice(0, 200);
}

/**
 * Excess stock identification: products where coverage > 90 days.
 * farmaciaDestino shows the other pharmacy if it could absorb some of the excess.
 */
export async function getExcessosData(): Promise<TransferSuggestionRow[]> {
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length === 0) return [];

  const { pfRows, salesMap } = await loadPfAndSales(farmaciaIds);

  // Build per-product map
  type Entry = PfBase & { avgDaily: number; coverage: number };
  const byProduto = new Map<string, Entry[]>();
  for (const row of pfRows) {
    const qty3m = salesMap.get(`${row.produtoId}:${row.farmaciaId}`) ?? 0;
    const avgDaily = qty3m / 90;
    const coverage = avgDaily > 0 ? toF(row.stockAtual) / avgDaily : Infinity;
    if (!byProduto.has(row.produtoId)) byProduto.set(row.produtoId, []);
    byProduto.get(row.produtoId)!.push({ ...row, avgDaily, coverage });
  }

  const result: TransferSuggestionRow[] = [];
  const EXCESS_THRESHOLD_DAYS = 90;
  const TARGET_DAYS = 30;

  for (const [, entries] of byProduto) {
    for (const entry of entries) {
      if (entry.coverage === Infinity || entry.coverage <= EXCESS_THRESHOLD_DAYS) continue;
      if (entry.avgDaily <= 0) continue;

      const excessQty = Math.round((entry.coverage - TARGET_DAYS) * entry.avgDaily);
      if (excessQty < 5) continue; // Only meaningful excesses

      // Check if there's another pharmacy that could use the excess
      const others = entries.filter((e) => e.farmaciaId !== entry.farmaciaId);
      const destino = others.length > 0 ? others[0] : null;
      const destinoNome = destino?.farmaciaNome ?? "—";
      const destCoverage = destino?.coverage !== undefined && destino.coverage !== Infinity ? Math.round(destino.coverage) : 0;
      const destStock = destino ? Math.round(toF(destino.stockAtual)) : 0;
      const destNecessidade = destino && destCoverage < TARGET_DAYS ? Math.round((TARGET_DAYS - destCoverage) * (destino.avgDaily || 0)) : 0;

      const prioridade: Priority =
        entry.coverage > 180 ? "alta" : entry.coverage > 120 ? "media" : "baixa";

      result.push({
        cnp: entry.cnp,
        produto: entry.designacao,
        farmaciaOrigem: entry.farmaciaNome,
        farmaciaDestino: destinoNome,
        stockOrigem: Math.round(toF(entry.stockAtual)),
        stockDestino: destStock,
        coberturaOrigem: Math.round(entry.coverage),
        coberturaDestino: destCoverage,
        quantidadeSugerida: Math.min(excessQty, Math.round(toF(entry.stockAtual))),
        excessoOrigem: excessQty,
        necessidadeDestino: Math.max(0, destNecessidade),
        fabricante: entry.fabricanteOrigem ?? "",
        categoria: entry.categoriaOrigem ?? "",
        fornecedor: entry.familiaOrigem ?? "",
        prioridade,
        observacao: `Excesso de ${Math.round(entry.coverage)} dias de cobertura.`,
      });
    }
  }

  result.sort((a, b) => b.coberturaOrigem - a.coberturaOrigem);
  return result.slice(0, 200);
}
