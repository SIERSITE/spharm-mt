import "server-only";
import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolveCategoria } from "@/lib/categoria-resolver";
import { avgDaily } from "@/lib/operational/metrics-shared";

/**
 * Factor aplicado à cobertura alvo para calcular excedente transferível.
 * excedente = stockActual − avgDaily × coverageDays × EXCESSO_FACTOR
 * Centralizado aqui para parametrização futura.
 */
export const EXCESSO_FACTOR = 1.2;

export type ProposalBaseRule = "total" | "coverage";

export type ProposalFilters = {
  fabricantes?: string[];
  fornecedores?: string[];
  /** Nível 1 canónico. */
  categorias?: string[];
  /** Nível 2 canónico — nível DIFERENTE, não uma versão fina do nível 1. */
  subcategorias?: string[];
  /** Utilizações por SLUG. Produto entra se corresponder a QUALQUER uma. */
  utilizacoes?: string[];
  productTypes?: string[];
};

export type ProposalInput = {
  farmaciaId: string;
  farmaciaNome?: string;
  startDate: Date;
  endDate: Date;
  considerStock: boolean;
  baseRule: ProposalBaseRule;
  targetCoverageDays: number;
  filters?: ProposalFilters;
};

export type GroupProposalInput = {
  farmaciaIds: string[];
  farmaciaNames: Record<string, string>;
  startDate: Date;
  endDate: Date;
  considerStock: boolean;
  baseRule: ProposalBaseRule;
  targetCoverageDays: number;
  filters?: ProposalFilters;
};

// ─── Estado e Motivo ─────────────────────────────────────────────────────────

export type ProposalEstado = "TRANSFERÊNCIA" | "COMPRAR" | "AGUARDAR" | "ADEQUADO";

export type ExcessoInfo = {
  farmaciaId: string;
  farmaciaNome: string;
  disponivelUnidades: number;
};

export type ProposalStats = {
  total: number;
  transferencia: number;
  comprar: number;
  aguardar: number;
  adequado: number;
};

export type ProposalRow = {
  farmaciaId: string;
  farmaciaNome: string;
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
  coberturaAtualDias: number | null;
  pendingQty: number;
  targetQty: number;
  suggestedQty: number;
  transferirQty: number;
  estado: ProposalEstado;
  motivo: string;
  excessoFonte: ExcessoInfo[];
};

export type ProposalResult = {
  rows: ProposalRow[];
  meta: {
    numDays: number;
    farmaciaIds: string[];
    startDate: string;
    endDate: string;
    considerStock: boolean;
    baseRule: ProposalBaseRule;
    targetCoverageDays: number;
    filtered: number;
    totalProductsWithSales: number;
    stats: ProposalStats;
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_ROWS = 500;

function diffDaysInclusive(start: Date, end: Date): number {
  return Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1);
}

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function computeStats(rows: ProposalRow[]): ProposalStats {
  const s: ProposalStats = { total: rows.length, transferencia: 0, comprar: 0, aguardar: 0, adequado: 0 };
  for (const r of rows) {
    if (r.estado === "TRANSFERÊNCIA") s.transferencia++;
    else if (r.estado === "COMPRAR") s.comprar++;
    else if (r.estado === "AGUARDAR") s.aguardar++;
    else s.adequado++;
  }
  return s;
}

function computeEstado(suggestedQty: number, pendingQty: number, considerStock: boolean): ProposalEstado {
  if (!considerStock) return suggestedQty > 0 ? "COMPRAR" : "ADEQUADO";
  if (suggestedQty <= 0 && pendingQty > 0) return "AGUARDAR";
  if (suggestedQty <= 0) return "ADEQUADO";
  return "COMPRAR";
}

function buildMotivo(
  estado: ProposalEstado,
  p: {
    currentStock: number | null;
    coberturaAtualDias: number | null;
    pendingQty: number;
    suggestedQty: number;
    transferirQty: number;
    excessoFonte: ExcessoInfo[];
    targetCoverageDays: number;
  }
): string {
  const stock = p.currentStock ?? 0;
  const cobStr = p.coberturaAtualDias != null ? `${p.coberturaAtualDias.toFixed(1)}d` : "—";

  switch (estado) {
    case "ADEQUADO":
      return `Stock: ${stock} und (${cobStr}) · acima do alvo de ${p.targetCoverageDays}d`;

    case "AGUARDAR":
      return `Encomenda pendente: ${p.pendingQty} und · cobre a necessidade`;

    case "COMPRAR": {
      const base = `Stock: ${stock} und (${cobStr}) · alvo ${p.targetCoverageDays}d`;
      if (p.excessoFonte.length > 0) {
        const excTotal = Math.round(p.excessoFonte.reduce((s, e) => s + e.disponivelUnidades, 0));
        const names = p.excessoFonte.map((e) => e.farmaciaNome).join(", ");
        return `${base} · excedente parcial em ${names} (${excTotal} und) · comprar ${p.suggestedQty}`;
      }
      return `${base} · sugerido: ${p.suggestedQty} und`;
    }

    case "TRANSFERÊNCIA": {
      const total = Math.round(p.excessoFonte.reduce((s, e) => s + e.disponivelUnidades, 0));
      const names = p.excessoFonte.map((e) => e.farmaciaNome).join(", ");
      return `Excedente em ${names}: ${total} und disponíveis · não é necessário comprar`;
    }
  }
}

// ─── RawRow do SQL ────────────────────────────────────────────────────────────

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

// ─── Proposta por farmácia ────────────────────────────────────────────────────

export async function generateOrderProposal(
  input: ProposalInput,
  client?: PrismaClient
): Promise<ProposalResult> {
  if (input.endDate < input.startDate) {
    throw new Error("Data fim anterior à data início.");
  }

  const prisma = client ?? (await getPrisma());
  const numDays = diffDaysInclusive(input.startDate, input.endDate);
  const farmaciaNome = input.farmaciaNome ?? input.farmaciaId;

  const fabFilter = input.filters?.fabricantes?.length ? input.filters.fabricantes : null;
  const fornFilter = input.filters?.fornecedores?.length ? input.filters.fornecedores : null;
  const catFilter = input.filters?.categorias?.length ? input.filters.categorias : null;
  const subcatFilter = input.filters?.subcategorias?.length ? input.filters.subcategorias : null;
  const utilFilter = input.filters?.utilizacoes?.length ? input.filters.utilizacoes : null;
  const typeFilter = input.filters?.productTypes?.length ? input.filters.productTypes : null;

  const conds: Prisma.Sql[] = [];
  if (fabFilter) conds.push(Prisma.sql`fab."nomeNormalizado" = ANY(${fabFilter})`);
  if (fornFilter) conds.push(Prisma.sql`pf."fornecedorOrigem" = ANY(${fornFilter})`);
  if (typeFilter) conds.push(Prisma.sql`p."productType" = ANY(${typeFilter})`);
  if (catFilter) {
    conds.push(Prisma.sql`(c1.nome = ANY(${catFilter}) OR pf."categoriaOrigem" = ANY(${catFilter}))`);
  }
  // Nível 2 só pelo canónico. `subcategoriaOrigem` é texto livre do ERP e
  // não é classificação — ver lib/categoria-resolver.ts.
  if (subcatFilter) conds.push(Prisma.sql`c2.nome = ANY(${subcatFilter})`);
  // EXISTS correlacionado: continua a ser UMA consulta, não uma por
  // produto. `= ANY` dá o OU entre as utilizações escolhidas.
  if (utilFilter) {
    conds.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ProdutoUtilizacao" pu
        JOIN "Utilizacao" u ON u.id = pu."utilizacaoId"
       WHERE pu."produtoId" = p.id AND u.estado = 'ATIVO' AND u.slug = ANY(${utilFilter})
    )`);
  }
  const whereExtra =
    conds.length > 0 ? Prisma.sql`AND ${Prisma.join(conds, " AND ")}` : Prisma.empty;

  const startYM = input.startDate.getFullYear() * 100 + (input.startDate.getMonth() + 1);
  const endYM = input.endDate.getFullYear() * 100 + (input.endDate.getMonth() + 1);

  const rawRows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    WITH vendas AS (
      SELECT vm."produtoId",
             GREATEST(SUM(COALESCE(vm."quantidadeLiquida", vm.quantidade)), 0) AS qty
      FROM "VendaMensal" vm
      WHERE vm."farmaciaId" = ${input.farmaciaId}
        AND (vm.ano * 100 + vm.mes) >= ${startYM}
        AND (vm.ano * 100 + vm.mes) <= ${endYM}
      GROUP BY vm."produtoId"
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
      AND (pf."flagRetirado" IS NOT TRUE)
      ${whereExtra}
    ORDER BY v.qty DESC
    LIMIT ${MAX_ROWS}
  `);

  const rows: ProposalRow[] = [];
  for (const r of rawRows) {
    const salesQty = toF(r.salesQty);
    const avgDailySales = avgDaily(salesQty, numDays);
    const target =
      input.baseRule === "total"
        ? salesQty
        : avgDailySales * Math.max(1, input.targetCoverageDays);

    const stock = r.stockAtual == null ? null : toF(r.stockAtual);
    const pending = toF(r.pendingQty);

    const suggestedRaw = input.considerStock ? target - (stock ?? 0) - pending : target;
    const suggestedQty = Math.max(0, Math.ceil(suggestedRaw));

    const coberturaAtualDias =
      stock != null && avgDailySales > 0
        ? Math.round((stock / avgDailySales) * 10) / 10
        : null;

    const { categoria } = resolveCategoria({
      classificacaoNivel1: r.canonN1 ? { nome: r.canonN1 } : null,
      classificacaoNivel2: r.canonN2 ? { nome: r.canonN2 } : null,
      categoriaOrigem: r.categoriaOrigem,
      subcategoriaOrigem: r.subcategoriaOrigem,
    });

    const estado = computeEstado(suggestedQty, pending, input.considerStock);
    const excessoFonte: ExcessoInfo[] = [];

    rows.push({
      farmaciaId: input.farmaciaId,
      farmaciaNome,
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
      coberturaAtualDias,
      pendingQty: pending,
      targetQty: Math.round(target * 100) / 100,
      suggestedQty,
      transferirQty: 0,
      estado,
      motivo: buildMotivo(estado, {
        currentStock: stock,
        coberturaAtualDias,
        pendingQty: pending,
        suggestedQty,
        transferirQty: 0,
        excessoFonte,
        targetCoverageDays: input.targetCoverageDays,
      }),
      excessoFonte,
    });
  }

  return {
    rows,
    meta: {
      numDays,
      farmaciaIds: [input.farmaciaId],
      startDate: input.startDate.toISOString(),
      endDate: input.endDate.toISOString(),
      considerStock: input.considerStock,
      baseRule: input.baseRule,
      targetCoverageDays: input.targetCoverageDays,
      filtered: rows.length,
      totalProductsWithSales: rawRows.length,
      stats: computeStats(rows),
    },
  };
}

// ─── Proposta de grupo ────────────────────────────────────────────────────────

export async function generateGroupProposal(
  input: GroupProposalInput,
  client?: PrismaClient
): Promise<ProposalResult> {
  if (input.farmaciaIds.length === 0) throw new Error("Nenhuma farmácia especificada.");
  if (input.endDate < input.startDate) throw new Error("Data fim anterior à data início.");

  const prisma = client ?? (await getPrisma());
  const numDays = diffDaysInclusive(input.startDate, input.endDate);
  const startYM = input.startDate.getFullYear() * 100 + (input.startDate.getMonth() + 1);
  const endYM = input.endDate.getFullYear() * 100 + (input.endDate.getMonth() + 1);

  // ── 1. Proposta individual por farmácia ──────────────────────────────────
  const perFarmacia = await Promise.all(
    input.farmaciaIds.map((fId) =>
      generateOrderProposal(
        {
          farmaciaId: fId,
          farmaciaNome: input.farmaciaNames[fId] ?? fId,
          startDate: input.startDate,
          endDate: input.endDate,
          considerStock: input.considerStock,
          baseRule: input.baseRule,
          targetCoverageDays: input.targetCoverageDays,
          filters: input.filters,
        },
        prisma
      ).then((r) => r.rows)
    )
  );

  const allRows: ProposalRow[] = perFarmacia.flat();

  if (allRows.length === 0) {
    const emptyStats: ProposalStats = { total: 0, transferencia: 0, comprar: 0, aguardar: 0, adequado: 0 };
    return {
      rows: [],
      meta: {
        numDays, farmaciaIds: input.farmaciaIds,
        startDate: input.startDate.toISOString(), endDate: input.endDate.toISOString(),
        considerStock: input.considerStock, baseRule: input.baseRule,
        targetCoverageDays: input.targetCoverageDays,
        filtered: 0, totalProductsWithSales: 0, stats: emptyStats,
      },
    };
  }

  // ── 2. Identificar produtos que necessitam compra ────────────────────────
  const productIds = [
    ...new Set(allRows.filter((r) => r.estado === "COMPRAR").map((r) => r.produtoId)),
  ];

  // ── 3. Stock cross-farmácia para esses produtos ──────────────────────────
  type CrossRow = {
    produtoId: string;
    farmaciaId: string;
    farmaciaNome: string;
    stockAtual: number | null;
    avgDailySales: number;
  };

  const crossRows = productIds.length > 0
    ? await prisma.$queryRaw<CrossRow[]>(Prisma.sql`
        WITH vendas_agg AS (
          SELECT vm."produtoId", vm."farmaciaId",
                 GREATEST(SUM(COALESCE(vm."quantidadeLiquida", vm.quantidade)), 0)::float AS "totalQty"
          FROM "VendaMensal" vm
          WHERE vm."produtoId" = ANY(${productIds})
            AND vm."farmaciaId" = ANY(${input.farmaciaIds})
            AND (vm.ano * 100 + vm.mes) >= ${startYM}
            AND (vm.ano * 100 + vm.mes) <= ${endYM}
          GROUP BY vm."produtoId", vm."farmaciaId"
        )
        SELECT
          pf."produtoId",
          pf."farmaciaId",
          f.nome                                          AS "farmaciaNome",
          pf."stockAtual"::float                          AS "stockAtual",
          COALESCE(va."totalQty", 0) / ${numDays}::float AS "avgDailySales"
        FROM "ProdutoFarmacia" pf
        JOIN "Farmacia" f ON f.id = pf."farmaciaId"
        LEFT JOIN vendas_agg va ON va."produtoId" = pf."produtoId"
                                AND va."farmaciaId" = pf."farmaciaId"
        WHERE pf."produtoId" = ANY(${productIds})
          AND pf."farmaciaId" = ANY(${input.farmaciaIds})
          AND (pf."flagRetirado" IS NOT TRUE)
      `)
    : [];

  // ── 4. Mapa de excedentes: produtoId → [ExcessoInfo] ────────────────────
  const excessByProduct = new Map<string, ExcessoInfo[]>();

  for (const cs of crossRows) {
    const stock = toF(cs.stockAtual);
    if (stock <= 0) continue;
    const avgD = toF(cs.avgDailySales);
    const excedente = stock - avgD * input.targetCoverageDays * EXCESSO_FACTOR;
    if (excedente <= 0) continue;
    if (!excessByProduct.has(cs.produtoId)) excessByProduct.set(cs.produtoId, []);
    excessByProduct.get(cs.produtoId)!.push({
      farmaciaId: cs.farmaciaId,
      farmaciaNome: cs.farmaciaNome,
      disponivelUnidades: excedente,
    });
  }

  // ── 5. Re-avaliar COMPRAR rows com excedente de outras farmácias ─────────
  const finalRows: ProposalRow[] = [];

  for (const row of allRows) {
    if (row.estado !== "COMPRAR") {
      finalRows.push(row);
      continue;
    }

    const fontes = (excessByProduct.get(row.produtoId) ?? [])
      .filter((e) => e.farmaciaId !== row.farmaciaId);

    if (fontes.length === 0) {
      finalRows.push(row);
      continue;
    }

    const totalExcesso = fontes.reduce((s, e) => s + e.disponivelUnidades, 0);
    const needed = row.suggestedQty;

    if (totalExcesso >= needed) {
      // Transferência total — não é necessário comprar
      const transferirQty = needed;
      finalRows.push({
        ...row,
        suggestedQty: 0,
        transferirQty,
        estado: "TRANSFERÊNCIA",
        excessoFonte: fontes,
        motivo: buildMotivo("TRANSFERÊNCIA", {
          currentStock: row.currentStock,
          coberturaAtualDias: row.coberturaAtualDias,
          pendingQty: row.pendingQty,
          suggestedQty: 0,
          transferirQty,
          excessoFonte: fontes,
          targetCoverageDays: input.targetCoverageDays,
        }),
      });
    } else {
      // Transferência parcial — reduz quantidade a comprar
      const comprar = Math.ceil(needed - totalExcesso);
      const transferirQty = Math.floor(totalExcesso);
      finalRows.push({
        ...row,
        suggestedQty: comprar,
        transferirQty,
        excessoFonte: fontes,
        motivo: buildMotivo("COMPRAR", {
          currentStock: row.currentStock,
          coberturaAtualDias: row.coberturaAtualDias,
          pendingQty: row.pendingQty,
          suggestedQty: comprar,
          transferirQty,
          excessoFonte: fontes,
          targetCoverageDays: input.targetCoverageDays,
        }),
      });
    }
  }

  return {
    rows: finalRows,
    meta: {
      numDays,
      farmaciaIds: input.farmaciaIds,
      startDate: input.startDate.toISOString(),
      endDate: input.endDate.toISOString(),
      considerStock: input.considerStock,
      baseRule: input.baseRule,
      targetCoverageDays: input.targetCoverageDays,
      filtered: finalRows.length,
      totalProductsWithSales: allRows.length,
      stats: computeStats(finalRows),
    },
  };
}
