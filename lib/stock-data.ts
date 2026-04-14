/**
 * lib/stock-data.ts
 * Server-side data fetching for the stock page.
 * Loads top 300 ProdutoFarmacia rows by stock value, enriched with coverage,
 * rotation and transfer suggestions derived from VendaMensal.
 */
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

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

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getStockData(): Promise<{
  rows: StockRow[];
  pharmacyNames: string[];
  metrics: StockMetrics;
}> {
  const prisma = await getPrisma();
  const now = new Date();
  const ano = now.getFullYear();
  const mes = now.getMonth() + 1;
  // Last 3 complete months (excluding current)
  const periodEnd = ano * 12 + mes;
  const periodStart = periodEnd - 3;

  // 1. Active pharmacies (excluding any test pharmacy)
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const pharmacyNames = farmacias.map((f) => f.nome);
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length === 0) {
    return { rows: [], pharmacyNames: [], metrics: { referencias: 0, baixaCobertura: 0, stockParado: 0, transferencias: 0 } };
  }

  // 2. Top 300 ProdutoFarmacia rows by stock value
  type PfRow = {
    produtoId: string;
    farmaciaId: string;
    farmaciaNome: string;
    cnp: string;
    designacao: string;
    stockAtual: number;
    stockMinimo: number | null;
    dataUltimaVenda: Date | null;
  };

  const pfRows = await prisma.$queryRaw<PfRow[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome                           AS "farmaciaNome",
      p.cnp::text                      AS cnp,
      p.designacao,
      pf."stockAtual"::float           AS "stockAtual",
      pf."stockMinimo"::float          AS "stockMinimo",
      pf."dataUltimaVenda"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto"  p  ON p.id  = pf."produtoId"
    JOIN "Farmacia" f  ON f.id  = pf."farmaciaId"
    WHERE
      pf."stockAtual" IS NOT NULL
      AND pf."stockAtual" > 0
      AND f.id = ANY(${farmaciaIds})
      AND pf."flagRetirado" = false
    ORDER BY pf."stockAtual" * COALESCE(pf.puc, pf.pmc, 0) DESC
    LIMIT 300
  `);

  if (pfRows.length === 0) {
    return { rows: [], pharmacyNames, metrics: { referencias: 0, baixaCobertura: 0, stockParado: 0, transferencias: 0 } };
  }

  // 3. VendaMensal sums for last 3 months
  type SalesRow = { produtoId: string; farmaciaId: string; totalQty: number };
  const salesRows = await prisma.$queryRaw<SalesRow[]>(Prisma.sql`
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

  // 4. Build product→pharmacies map for transfer detection
  type PharmacyEntry = { farmaciaId: string; nome: string; stockAtual: number; coverage: number };
  const productMap = new Map<string, PharmacyEntry[]>();
  for (const row of pfRows) {
    const qty3m = salesMap.get(`${row.produtoId}:${row.farmaciaId}`) ?? 0;
    const avgDaily = qty3m / 90;
    const coverage = avgDaily > 0 ? toF(row.stockAtual) / avgDaily : Infinity;
    if (!productMap.has(row.produtoId)) productMap.set(row.produtoId, []);
    productMap.get(row.produtoId)!.push({ farmaciaId: row.farmaciaId, nome: row.farmaciaNome, stockAtual: toF(row.stockAtual), coverage });
  }

  // 5. Build result rows
  const rows: StockRow[] = [];
  for (const row of pfRows) {
    const qty3m = salesMap.get(`${row.produtoId}:${row.farmaciaId}`) ?? 0;
    const avgDaily = qty3m / 90;
    const coverage = avgDaily > 0 ? toF(row.stockAtual) / avgDaily : null;
    const belowMin = row.stockMinimo !== null && row.stockMinimo > 0 && toF(row.stockAtual) <= row.stockMinimo;

    let status: StockRow["status"] = "Estável";
    let suggestion = "—";

    if (qty3m === 0) {
      status = "Parado";
      suggestion = "Avaliar rotação";
    } else if (belowMin || (coverage !== null && coverage < 7)) {
      status = "Baixa cobertura";
      suggestion = "Reforçar stock";
    } else {
      // Check transfer opportunity: I have excess, another pharmacy has deficit
      const peers = (productMap.get(row.produtoId) ?? []).filter((p) => p.farmaciaId !== row.farmaciaId);
      const myCoverage = coverage ?? 999;
      for (const peer of peers) {
        if (myCoverage > 30 && peer.coverage < 14 && peer.coverage !== Infinity) {
          const qty = Math.max(1, Math.round((myCoverage - peer.coverage) * avgDaily * 0.4));
          status = "Transferência sugerida";
          suggestion = `${qty} un. → ${peer.nome}`;
          break;
        }
      }
    }

    const coverageStr = coverage === null ? "∞" : `${Math.round(coverage)} dias`;
    const rotationStr = avgDaily > 0.5 ? "Alta" : avgDaily > 0.1 ? "Média" : "Baixa";

    let lastMovement = "—";
    if (row.dataUltimaVenda) {
      const days = Math.floor((Date.now() - new Date(row.dataUltimaVenda).getTime()) / 86_400_000);
      lastMovement = days === 0 ? "Hoje" : days === 1 ? "Ontem" : `Há ${days} dias`;
    } else if (qty3m > 0) {
      lastMovement = "Recente";
    }

    rows.push({
      product: row.designacao,
      cnp: row.cnp,
      pharmacy: row.farmaciaNome,
      stock: Math.round(toF(row.stockAtual)),
      coverage: coverageStr,
      rotation: rotationStr,
      lastMovement,
      status,
      suggestion,
    });
  }

  const metrics: StockMetrics = {
    referencias: rows.length,
    baixaCobertura: rows.filter((r) => r.status === "Baixa cobertura").length,
    stockParado: rows.filter((r) => r.status === "Parado").length,
    transferencias: rows.filter((r) => r.status === "Transferência sugerida").length,
  };

  return { rows, pharmacyNames, metrics };
}
