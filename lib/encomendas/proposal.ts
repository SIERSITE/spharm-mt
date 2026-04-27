import "server-only";
import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolveCategoria } from "@/lib/categoria-resolver";

/**
 * lib/encomendas/proposal.ts
 *
 * Gera a proposta de encomenda a partir de vendas reais num período
 * manualmente definido pelo utilizador. ÚNICA fonte da regra de cálculo
 * — sempre que a UI precisa de "qtd sugerida com base em vendas",
 * passa por aqui. As linhas vão depois para `createEncomendaWithOutbox`
 * em lib/ingest/orders.ts (via server action), mantendo o invariante de
 * que `prisma.listaEncomenda.create` directo está fora do runtime.
 *
 * Inputs do utilizador:
 *   farmaciaId           — qual farmácia (single para v1; group é TODO).
 *   startDate, endDate   — janela inclusiva de vendas analisadas.
 *   considerStock        — se true, subtrai stock + pending da target.
 *   targetCoverageDays   — usado quando baseRule = "coverage".
 *   baseRule             — "total" (= total de vendas) ou
 *                          "coverage" (= média diária × cobertura).
 *   filtros              — fabricantes, fornecedores, categorias,
 *                          productTypes (todos opcionais).
 *
 * Pending qty: soma das `LinhaEncomenda.quantidadeAjustada ?? Sugerida`
 * para listas da farmácia onde `estadoExport ∈ {PENDENTE, EM_EXPORTACAO}`
 * — ou seja, em fila de exportação ou já em curso, mas ainda não
 * confirmadas. Listas em RASCUNHO não contam (ainda podem ser
 * canceladas).
 */

export type ProposalBaseRule = "total" | "coverage";

export type ProposalFilters = {
  fabricantes?: string[];
  fornecedores?: string[];
  categorias?: string[];
  productTypes?: string[];
};

export type ProposalInput = {
  farmaciaId: string;
  startDate: Date;
  endDate: Date;
  considerStock: boolean;
  baseRule: ProposalBaseRule;
  targetCoverageDays: number;
  filters?: ProposalFilters;
};

export type ProposalRow = {
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  categoria: string;
  productType: string | null;
  salesQty: number;
  avgDailySales: number;
  currentStock: number | null;
  pendingQty: number;
  targetQty: number;
  suggestedQty: number;
};

export type ProposalResult = {
  rows: ProposalRow[];
  meta: {
    numDays: number;
    farmaciaId: string;
    startDate: string;
    endDate: string;
    considerStock: boolean;
    baseRule: ProposalBaseRule;
    targetCoverageDays: number;
    filtered: number;
    totalProductsWithSales: number;
  };
};

const MAX_ROWS = 500;

function diffDaysInclusive(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, days);
}

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type RawRow = {
  produtoId: string;
  cnp: number;
  designacao: string;
  productType: string | null;
  fabricante: string | null;
  stockAtual: number | null;
  fornecedorOrigem: string | null;
  categoriaOrigem: string | null;
  subcategoriaOrigem: string | null;
  canonN1: string | null;
  canonN2: string | null;
  salesQty: number;
  pendingQty: number;
};

export async function generateOrderProposal(
  input: ProposalInput,
  client?: PrismaClient
): Promise<ProposalResult> {
  if (input.endDate < input.startDate) {
    throw new Error("Data fim anterior à data início.");
  }

  const prisma = client ?? (await getPrisma());
  const numDays = diffDaysInclusive(input.startDate, input.endDate);

  const fabFilter =
    input.filters?.fabricantes && input.filters.fabricantes.length > 0
      ? input.filters.fabricantes
      : null;
  const fornFilter =
    input.filters?.fornecedores && input.filters.fornecedores.length > 0
      ? input.filters.fornecedores
      : null;
  const catFilter =
    input.filters?.categorias && input.filters.categorias.length > 0
      ? input.filters.categorias
      : null;
  const typeFilter =
    input.filters?.productTypes && input.filters.productTypes.length > 0
      ? input.filters.productTypes
      : null;

  // Construímos o WHERE dinamicamente. Prisma.sql lida com bindings.
  const conds: Prisma.Sql[] = [];
  if (fabFilter) {
    conds.push(Prisma.sql`fab."nomeNormalizado" = ANY(${fabFilter})`);
  }
  if (fornFilter) {
    conds.push(Prisma.sql`pf."fornecedorOrigem" = ANY(${fornFilter})`);
  }
  if (typeFilter) {
    conds.push(Prisma.sql`p."productType" = ANY(${typeFilter})`);
  }
  if (catFilter) {
    // Categorias matcham contra canonN1 OU categoriaOrigem — alinhado
    // com a precedência de resolveCategoria (canonN1 > origemCat).
    conds.push(
      Prisma.sql`(c1.nome = ANY(${catFilter}) OR pf."categoriaOrigem" = ANY(${catFilter}))`
    );
  }
  const whereExtra =
    conds.length > 0 ? Prisma.sql`AND ${Prisma.join(conds, " AND ")}` : Prisma.empty;

  const rawRows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    WITH vendas AS (
      SELECT v."produtoId", SUM(v.quantidade) AS qty
      FROM "Venda" v
      WHERE v."farmaciaId" = ${input.farmaciaId}
        AND v.data >= ${input.startDate}
        AND v.data <= ${input.endDate}
      GROUP BY v."produtoId"
    ),
    pending AS (
      SELECT le."produtoId",
             SUM(COALESCE(le."quantidadeAjustada", le."quantidadeSugerida", 0)) AS qty
      FROM "LinhaEncomenda" le
      JOIN "ListaEncomenda" l ON l.id = le."listaEncomendaId"
      WHERE l."farmaciaId" = ${input.farmaciaId}
        AND l."estadoExport" IN ('PENDENTE', 'EM_EXPORTACAO')
      GROUP BY le."produtoId"
    )
    SELECT
      v."produtoId"                               AS "produtoId",
      p.cnp                                       AS cnp,
      p.designacao                                AS designacao,
      p."productType"                             AS "productType",
      fab."nomeNormalizado"                       AS fabricante,
      pf."stockAtual"::float                      AS "stockAtual",
      pf."fornecedorOrigem"                       AS "fornecedorOrigem",
      pf."categoriaOrigem"                        AS "categoriaOrigem",
      pf."subcategoriaOrigem"                     AS "subcategoriaOrigem",
      c1.nome                                     AS "canonN1",
      c2.nome                                     AS "canonN2",
      v.qty::float                                AS "salesQty",
      COALESCE(pending.qty::float, 0)             AS "pendingQty"
    FROM vendas v
    JOIN "Produto"             p   ON p.id  = v."produtoId"
    LEFT JOIN "Fabricante"     fab ON fab.id = p."fabricanteId"
    LEFT JOIN "Classificacao"  c1  ON c1.id  = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao"  c2  ON c2.id  = p."classificacaoNivel2Id"
    LEFT JOIN "ProdutoFarmacia" pf ON pf."produtoId" = v."produtoId"
                                  AND pf."farmaciaId" = ${input.farmaciaId}
    LEFT JOIN pending              ON pending."produtoId" = v."produtoId"
    WHERE v.qty > 0
      ${whereExtra}
    ORDER BY v.qty DESC
    LIMIT ${MAX_ROWS}
  `);

  const rows: ProposalRow[] = [];
  for (const r of rawRows) {
    const salesQty = toF(r.salesQty);
    const avgDailySales = salesQty / numDays;
    const target =
      input.baseRule === "total"
        ? salesQty
        : avgDailySales * Math.max(1, input.targetCoverageDays);

    const stock = r.stockAtual == null ? null : toF(r.stockAtual);
    const pending = toF(r.pendingQty);

    const suggestedRaw = input.considerStock
      ? target - (stock ?? 0) - pending
      : target;
    const suggestedQty = Math.max(0, Math.ceil(suggestedRaw));

    const { categoria } = resolveCategoria({
      classificacaoNivel1: r.canonN1 ? { nome: r.canonN1 } : null,
      classificacaoNivel2: r.canonN2 ? { nome: r.canonN2 } : null,
      categoriaOrigem: r.categoriaOrigem,
      subcategoriaOrigem: r.subcategoriaOrigem,
    });

    rows.push({
      produtoId: r.produtoId,
      cnp: Number(r.cnp),
      designacao: r.designacao,
      fabricante: r.fabricante,
      fornecedor: r.fornecedorOrigem,
      categoria,
      productType: r.productType,
      salesQty: Math.round(salesQty * 1000) / 1000,
      avgDailySales: Math.round(avgDailySales * 100) / 100,
      currentStock: stock,
      pendingQty: pending,
      targetQty: Math.round(target * 100) / 100,
      suggestedQty,
    });
  }

  return {
    rows,
    meta: {
      numDays,
      farmaciaId: input.farmaciaId,
      startDate: input.startDate.toISOString(),
      endDate: input.endDate.toISOString(),
      considerStock: input.considerStock,
      baseRule: input.baseRule,
      targetCoverageDays: input.targetCoverageDays,
      filtered: rows.length,
      totalProductsWithSales: rawRows.length,
    },
  };
}
