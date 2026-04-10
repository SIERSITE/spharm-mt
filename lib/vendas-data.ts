/**
 * lib/vendas-data.ts
 * Server-side data fetching for the vendas page.
 * Loads top 300 products by total sales in the last 4 available months
 * (jan–abr 2026), one row per product+farmacia.
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

/** Matches the SalesReportRow type used by the vendas client component. */
export type SalesReportRow = {
  codigo: string;
  descricao: string;
  pvp: number;
  /** Vendas de Janeiro (2026) */
  jan: number;
  /** Vendas de Fevereiro (2026) */
  fev: number;
  /** Vendas de Março (2026) */
  mar: number;
  /** Vendas de Abril (2026) */
  abr: number;
  totalVendas: number;
  existencia: number;
  unidadesVendidas: number;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  farmacia: string;
  grupo: string;
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getVendasData(): Promise<SalesReportRow[]> {
  // Active pharmacies (excluding test)
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  const farmaciaNameById = new Map(farmacias.map((f) => [f.id, f.nome]));
  if (farmaciaIds.length === 0) return [];

  // Fixed column months: jan–abr 2026
  const COLS = [
    { ano: 2026, mes: 1 },
    { ano: 2026, mes: 2 },
    { ano: 2026, mes: 3 },
    { ano: 2026, mes: 4 },
  ];

  // Raw query: pivot VendaMensal into jan/fev/mar/abr per produto+farmacia
  type PivotRow = {
    produtoId: string;
    farmaciaId: string;
    jan: number;
    fev: number;
    mar: number;
    abr: number;
    total: number;
  };

  const pivotRows = await prisma.$queryRaw<PivotRow[]>(Prisma.sql`
    SELECT
      vm."produtoId",
      vm."farmaciaId",
      SUM(CASE WHEN vm.ano = 2026 AND vm.mes = 1 THEN vm.quantidade ELSE 0 END)::float AS jan,
      SUM(CASE WHEN vm.ano = 2026 AND vm.mes = 2 THEN vm.quantidade ELSE 0 END)::float AS fev,
      SUM(CASE WHEN vm.ano = 2026 AND vm.mes = 3 THEN vm.quantidade ELSE 0 END)::float AS mar,
      SUM(CASE WHEN vm.ano = 2026 AND vm.mes = 4 THEN vm.quantidade ELSE 0 END)::float AS abr,
      SUM(CASE WHEN vm.ano = 2026 AND vm.mes IN (1,2,3,4) THEN vm.quantidade ELSE 0 END)::float AS total
    FROM "VendaMensal" vm
    WHERE
      vm."farmaciaId" = ANY(${farmaciaIds})
      AND vm.ano = 2026
      AND vm.mes IN (1,2,3,4)
    GROUP BY vm."produtoId", vm."farmaciaId"
    HAVING SUM(CASE WHEN vm.ano = 2026 AND vm.mes IN (1,2,3,4) THEN vm.quantidade ELSE 0 END) > 0
    ORDER BY total DESC
    LIMIT 300
  `);

  if (pivotRows.length === 0) return [];

  // Fetch product metadata
  const produtoIds = [...new Set(pivotRows.map((r) => r.produtoId))];
  const produtos = await prisma.produto.findMany({
    where: { id: { in: produtoIds } },
    select: { id: true, cnp: true, designacao: true },
  });
  const produtoById = new Map(produtos.map((p) => [p.id, p]));

  // Fetch ProdutoFarmacia for stock + pvp + categoriaOrigem
  const pfRecords = await prisma.produtoFarmacia.findMany({
    where: {
      produtoId: { in: produtoIds },
      farmaciaId: { in: farmaciaIds },
    },
    select: {
      produtoId: true,
      farmaciaId: true,
      stockAtual: true,
      pvp: true,
      pmc: true,
      categoriaOrigem: true,
      subcategoriaOrigem: true,
      fabricanteOrigem: true,
      familiaOrigem: true,
    },
  });
  const pfByKey = new Map(pfRecords.map((r) => [`${r.produtoId}:${r.farmaciaId}`, r]));

  const rows: SalesReportRow[] = [];
  for (const pr of pivotRows) {
    const produto = produtoById.get(pr.produtoId);
    if (!produto) continue;
    const pf = pfByKey.get(`${pr.produtoId}:${pr.farmaciaId}`);
    const farmaciaNome = farmaciaNameById.get(pr.farmaciaId) ?? "—";

    const jan = Math.round(toF(pr.jan));
    const fev = Math.round(toF(pr.fev));
    const mar = Math.round(toF(pr.mar));
    const abr = Math.round(toF(pr.abr));
    const total = jan + fev + mar + abr;

    // pvp: from ProdutoFarmacia, fallback from pmc
    const pvp = toF(pf?.pvp ?? pf?.pmc ?? 0);
    const existencia = Math.round(toF(pf?.stockAtual ?? 0));

    // Metadata: use categoriaOrigem from ProdutoFarmacia (populated when importer saves it)
    const categoria = pf?.categoriaOrigem ?? "";
    const grupo = pf?.subcategoriaOrigem ?? categoria;
    // familiaOrigem stores the fornecedor name (set by updated importer)
    const fornecedor = pf?.familiaOrigem ?? "";
    const fabricante = pf?.fabricanteOrigem ?? "";

    rows.push({
      codigo: String(produto.cnp),
      descricao: produto.designacao,
      pvp,
      jan,
      fev,
      mar,
      abr,
      totalVendas: total,
      existencia,
      unidadesVendidas: total,
      fornecedor,
      fabricante,
      categoria,
      farmacia: farmaciaNome,
      grupo,
    });
  }

  return rows;
}

/** Ignored by eslint — col definitions kept for reference */
export const _cols = [
  { label: "Jan", ano: 2026, mes: 1 },
  { label: "Fev", ano: 2026, mes: 2 },
  { label: "Mar", ano: 2026, mes: 3 },
  { label: "Abr", ano: 2026, mes: 4 },
];
