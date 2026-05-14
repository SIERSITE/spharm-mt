/**
 * lib/data/operational-intelligence.ts
 *
 * Loader **server-only** dedicado a `/analise-operacional` — a página
 * accionável v1. Combina `VendaMensal` (consumo) com `ProdutoFarmacia`
 * (stock corrente + preços) para produzir 9 datasets que ajudam o
 * operador a decidir: o que repor, o que abrandar, onde está parado o
 * dinheiro.
 *
 * Princípios:
 *   · Read-only. Nunca escreve.
 *   · Isolado de `lib/data/vendas-mensais-report.ts` (zero share),
 *     porque a semântica é diferente: aqui é prioritização operacional,
 *     ali é reporting plano. Algumas queries são parecidas mas a
 *     duplicação é proposital.
 *   · Heurísticas explícitas, não opinativas. Documentadas em cada
 *     função: limiares (7 dias, 90 dias, ratio 0.5), fallbacks PUC→PMC
 *     para valor parado, COALESCE para campos legados Excel.
 *   · Sem dependência de IPF, forecasts ou indicadores derivados —
 *     usa apenas o que está em VendaMensal + ProdutoFarmacia.
 *
 * Limiares (constantes, ajustáveis):
 *   · COVERAGE_RUPTURA_DAYS  =  7   — coverage < 7d → candidato a ruptura
 *   · COVERAGE_EXCESSO_DAYS  = 90   — coverage > 90d → candidato a excesso
 *   · RUPTURA_RATIO          = 0.5  — stockAtual < qtdMensal × 0.5 → ruptura
 *   · LIMIT_DEFAULT          = 30   — limites razoáveis para listas
 */

import "server-only";
import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

const COVERAGE_RUPTURA_DAYS = 7;
const COVERAGE_EXCESSO_DAYS = 90;
const RUPTURA_RATIO = 0.5;
const LIMIT_DEFAULT = 30;

/* ---------- Tipos públicos ---------- */

export type MonthOption = { ano: number; mes: number; label: string };

export type OperationalProductRow = {
  produtoId: string;
  cnp: number | null;
  designacao: string;
  /** Consumo líquido do mês (VENDA − DEVOLUCAO). Sinal preservado. */
  quantidadeMensal: number;
  valorBruto: number;
  valorPagoUtente: number;
  /** stockAtual corrente em ProdutoFarmacia (snapshot — pode ter avançado depois do mês). */
  stockAtual: number | null;
  stockMinimo: number | null;
  stockMaximo: number | null;
  pvp: number | null;
  pmc: number | null;
  puc: number | null;
  /** Cobertura aproximada em dias: stockAtual / (qtdMensal / 30). NULL se qtd ≤ 0. */
  coverageDays: number | null;
  /** stockAtual × COALESCE(puc, pmc) — valor parado em prateleira. NULL se ambos forem null. */
  valorParado: number | null;
  /** Margem aproximada % = (pvp − puc) / pvp × 100. NULL se faltam dados. */
  margemPercent: number | null;
};

export type AnomalyProductRow = {
  produtoId: string;
  cnp: number | null;
  designacao: string;
  stockAtual: number | null;
  stockMinimo: number | null;
  stockMaximo: number | null;
  quantidadeMensal: number;
  valorBruto: number;
};

export type TotalsSnapshot = {
  produtosVendidos: number;
  quantidadeLiquidaSum: number;
  valorBrutoSum: number;
  valorPagoUtenteSum: number;
  produtosRuptura: number;
  produtosExcesso: number;
  valorParadoTotal: number;
};

export type OperationalIntelligenceData = {
  totals: TotalsSnapshot;
  ruptura: OperationalProductRow[];
  excesso: OperationalProductRow[];
  cobertura: OperationalProductRow[];
  topByValor: OperationalProductRow[];
  topByQty: OperationalProductRow[];
  margemTop: OperationalProductRow[];
  devolucoes: OperationalProductRow[];
  /** anomalias agrupadas: stock=0, stock<0, sem bounds. Cada uma com sample */
  semStock: AnomalyProductRow[];
  stockNegativo: AnomalyProductRow[];
  semBounds: AnomalyProductRow[];
};

/* ---------- Helpers ---------- */

const MESES_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

function monthLabel(ano: number, mes: number): string {
  return `${MESES_PT[mes - 1] ?? mes} ${ano}`;
}

function decToNum(
  v: Prisma.Decimal | number | string | null | undefined
): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  const n = (v as Prisma.Decimal).toNumber?.();
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}
function decToNumOrNull(
  v: Prisma.Decimal | number | string | null | undefined
): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const n = (v as Prisma.Decimal).toNumber?.();
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/* ---------- Filter options (reusa o padrão do report) ---------- */

export async function getAvailableMonths(farmaciaId: string): Promise<MonthOption[]> {
  const prisma = await getPrisma();
  const rows = await prisma.vendaMensal.findMany({
    where: { farmaciaId },
    select: { ano: true, mes: true },
    distinct: ["ano", "mes"],
    orderBy: [{ ano: "desc" }, { mes: "desc" }],
    take: 60,
  });
  return rows.map((r) => ({
    ano: r.ano,
    mes: r.mes,
    label: monthLabel(r.ano, r.mes),
  }));
}

/* ---------- Row mapping ---------- */

type RowDb = {
  produtoId: string;
  designacao: string;
  cnp: number | null;
  quantidadeMensal: Prisma.Decimal | string | null;
  valorBruto: Prisma.Decimal | string | null;
  valorPagoUtente: Prisma.Decimal | string | null;
  stockAtual: Prisma.Decimal | null;
  stockMinimo: Prisma.Decimal | null;
  stockMaximo: Prisma.Decimal | null;
  pvp: Prisma.Decimal | null;
  pmc: Prisma.Decimal | null;
  puc: Prisma.Decimal | null;
  /** dias = (stockAtual / quantidadeMensal) × 30. SQL calcula. */
  coverageDays: Prisma.Decimal | string | null;
};

function mapOperationalRow(r: RowDb): OperationalProductRow {
  const stockAtual = decToNumOrNull(r.stockAtual);
  const pvp = decToNumOrNull(r.pvp);
  const pmc = decToNumOrNull(r.pmc);
  const puc = decToNumOrNull(r.puc);
  const qtd = decToNum(r.quantidadeMensal);
  const valorBruto = decToNum(r.valorBruto);
  const valorPagoUtente = decToNum(r.valorPagoUtente);

  // Coverage: já calculada SQL-side; null quando qtd ≤ 0.
  const coverageDaysRaw = decToNumOrNull(r.coverageDays);
  const coverageDays =
    coverageDaysRaw !== null && Number.isFinite(coverageDaysRaw) && qtd > 0
      ? coverageDaysRaw
      : null;

  // Valor parado: stockAtual × COALESCE(puc, pmc). NULL se ambos faltam.
  let valorParado: number | null = null;
  const unitCost = puc ?? pmc;
  if (stockAtual !== null && unitCost !== null) {
    valorParado = stockAtual * unitCost;
  }

  // Margem: (pvp − puc) / pvp × 100
  let margemPercent: number | null = null;
  if (pvp !== null && pvp > 0 && puc !== null) {
    margemPercent = ((pvp - puc) / pvp) * 100;
  }

  return {
    produtoId: r.produtoId,
    cnp: r.cnp,
    designacao: r.designacao ?? "(sem designação)",
    quantidadeMensal: qtd,
    valorBruto,
    valorPagoUtente,
    stockAtual,
    stockMinimo: decToNumOrNull(r.stockMinimo),
    stockMaximo: decToNumOrNull(r.stockMaximo),
    pvp,
    pmc,
    puc,
    coverageDays,
    valorParado,
    margemPercent,
  };
}

/* ---------- SQL fragments ---------- */

/**
 * Coverage em dias. quantidadeMensal pode vir do agg novo (Decimal) ou
 * legado (Decimal). Sempre que ≤ 0 ou stockAtual IS NULL, devolvemos NULL.
 *
 * Numerador é stockAtual em unidades; denominador é (qtd/30) — consumo
 * médio diário do mês. Resultado: dias de stock corrente.
 */
const COVERAGE_EXPR = Prisma.sql`
  CASE
    WHEN pf."stockAtual" IS NULL THEN NULL
    WHEN COALESCE(vm."quantidadeLiquida", vm."quantidade") <= 0 THEN NULL
    ELSE (pf."stockAtual" / (COALESCE(vm."quantidadeLiquida", vm."quantidade") / 30.0))
  END
`;

const QTD_EXPR = Prisma.sql`COALESCE(vm."quantidadeLiquida", vm."quantidade")`;
const VB_EXPR = Prisma.sql`COALESCE(vm."valorBruto", vm."valorTotal")`;
const VU_EXPR = Prisma.sql`COALESCE(vm."valorPagoUtente", vm."valorTotal")`;

const SELECT_COLS = Prisma.sql`
  vm."produtoId"                    AS "produtoId",
  p."designacao"                    AS "designacao",
  p."cnp"                           AS "cnp",
  ${QTD_EXPR}                       AS "quantidadeMensal",
  ${VB_EXPR}                        AS "valorBruto",
  ${VU_EXPR}                        AS "valorPagoUtente",
  pf."stockAtual"                   AS "stockAtual",
  pf."stockMinimo"                  AS "stockMinimo",
  pf."stockMaximo"                  AS "stockMaximo",
  pf."pvp"                          AS "pvp",
  pf."pmc"                          AS "pmc",
  pf."puc"                          AS "puc",
  ${COVERAGE_EXPR}                  AS "coverageDays"
`;

/* ---------- Queries ---------- */

async function fetchByOrder(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number,
  order: Prisma.Sql,
  extraWhere: Prisma.Sql,
  limit: number,
  joinPF: "inner" | "left"
): Promise<RowDb[]> {
  const join =
    joinPF === "inner"
      ? Prisma.sql`JOIN "ProdutoFarmacia" pf
                     ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"`
      : Prisma.sql`LEFT JOIN "ProdutoFarmacia" pf
                     ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"`;
  return prisma.$queryRaw<RowDb[]>`
    SELECT ${SELECT_COLS}
    FROM "VendaMensal" vm
    JOIN "Produto" p ON p."id" = vm."produtoId"
    ${join}
    WHERE vm."farmaciaId" = ${farmaciaId}
      AND vm."ano" = ${ano}
      AND vm."mes" = ${mes}
    ${extraWhere}
    ORDER BY ${order}
    LIMIT ${limit}
  `;
}

/* ---------- Top-level API ---------- */

export async function getOperationalIntelligence(
  farmaciaId: string,
  ano: number,
  mes: number,
  opts: { limit?: number } = {}
): Promise<OperationalIntelligenceData> {
  const prisma = await getPrisma();
  const limit = opts.limit ?? LIMIT_DEFAULT;

  const [
    rupturaRows,
    excessoRows,
    coberturaRows,
    topValorRows,
    topQtyRows,
    margemRows,
    devolucoesRows,
    semStockRows,
    stockNegativoRows,
    semBoundsRows,
    totalsRow,
    rupturaCount,
    excessoCount,
  ] = await Promise.all([
    // 1) Candidatos a ruptura — vendeu E (stock < min OU coverage < 7)
    fetchByOrder(
      prisma,
      farmaciaId,
      ano,
      mes,
      Prisma.sql`${VB_EXPR} DESC`,
      Prisma.sql`AND ${QTD_EXPR} > 0
                 AND pf."stockAtual" IS NOT NULL
                 AND (
                   (pf."stockMinimo" IS NOT NULL AND pf."stockAtual" < pf."stockMinimo")
                   OR pf."stockAtual" < ${QTD_EXPR} * ${RUPTURA_RATIO}
                   OR (${COVERAGE_EXPR}) < ${COVERAGE_RUPTURA_DAYS}
                 )`,
      limit,
      "inner"
    ),

    // 2) Candidatos a excesso — stock alto vs consumo
    fetchByOrder(
      prisma,
      farmaciaId,
      ano,
      mes,
      Prisma.sql`(pf."stockAtual" * COALESCE(pf."puc", pf."pmc", 0)) DESC`,
      Prisma.sql`AND pf."stockAtual" IS NOT NULL AND pf."stockAtual" > 0
                 AND (
                   (pf."stockMaximo" IS NOT NULL AND pf."stockAtual" > pf."stockMaximo")
                   OR (${COVERAGE_EXPR}) > ${COVERAGE_EXCESSO_DAYS}
                 )`,
      limit,
      "inner"
    ),

    // 3) Cobertura ordenada (asc = mais urgente). Filtra ruído: qtd > 0
    //    e cobertura calculável. Inclui produtos que NÃO estão em ruptura,
    //    para dar visão geral.
    fetchByOrder(
      prisma,
      farmaciaId,
      ano,
      mes,
      Prisma.sql`(${COVERAGE_EXPR}) ASC NULLS LAST`,
      Prisma.sql`AND ${QTD_EXPR} > 0
                 AND pf."stockAtual" IS NOT NULL`,
      limit,
      "inner"
    ),

    // 4) Top por valor bruto (volume bruto)
    fetchByOrder(
      prisma,
      farmaciaId,
      ano,
      mes,
      Prisma.sql`${VB_EXPR} DESC`,
      Prisma.empty,
      limit,
      "left"
    ),

    // 5) Top por quantidade líquida
    fetchByOrder(
      prisma,
      farmaciaId,
      ano,
      mes,
      Prisma.sql`${QTD_EXPR} DESC`,
      Prisma.empty,
      limit,
      "left"
    ),

    // 6) Margem aproximada — ordenada por valor de margem do mês
    fetchByOrder(
      prisma,
      farmaciaId,
      ano,
      mes,
      Prisma.sql`((pf."pvp" - pf."puc") / pf."pvp") * ${QTD_EXPR} DESC`,
      Prisma.sql`AND pf."pvp" IS NOT NULL AND pf."pvp" > 0
                 AND pf."puc" IS NOT NULL
                 AND ${QTD_EXPR} > 0`,
      limit,
      "inner"
    ),

    // 7) Devoluções líquidas (qtd < 0)
    fetchByOrder(
      prisma,
      farmaciaId,
      ano,
      mes,
      Prisma.sql`${QTD_EXPR} ASC`,
      Prisma.sql`AND ${QTD_EXPR} < 0`,
      limit,
      "left"
    ),

    // 8) Sem stock corrente (qtd > 0 mas stockAtual=0 ou null)
    fetchByOrder(
      prisma,
      farmaciaId,
      ano,
      mes,
      Prisma.sql`${VB_EXPR} DESC`,
      Prisma.sql`AND ${QTD_EXPR} > 0
                 AND (pf."stockAtual" IS NULL OR pf."stockAtual" = 0)`,
      limit,
      "left"
    ),

    // 9) Stock negativo (anomalia ERP) — base é ProdutoFarmacia.
    prisma.$queryRaw<RowDb[]>`
      SELECT
        pf."produtoId"                                    AS "produtoId",
        p."designacao"                                    AS "designacao",
        p."cnp"                                           AS "cnp",
        COALESCE(vm."quantidadeLiquida", vm."quantidade", 0) AS "quantidadeMensal",
        COALESCE(vm."valorBruto", vm."valorTotal", 0)        AS "valorBruto",
        COALESCE(vm."valorPagoUtente", vm."valorTotal", 0)   AS "valorPagoUtente",
        pf."stockAtual"                                   AS "stockAtual",
        pf."stockMinimo"                                  AS "stockMinimo",
        pf."stockMaximo"                                  AS "stockMaximo",
        pf."pvp"                                          AS "pvp",
        pf."pmc"                                          AS "pmc",
        pf."puc"                                          AS "puc",
        NULL::numeric                                     AS "coverageDays"
      FROM "ProdutoFarmacia" pf
      JOIN "Produto" p ON p."id" = pf."produtoId"
      LEFT JOIN "VendaMensal" vm
        ON vm."produtoId" = pf."produtoId" AND vm."farmaciaId" = pf."farmaciaId"
       AND vm."ano" = ${ano} AND vm."mes" = ${mes}
      WHERE pf."farmaciaId" = ${farmaciaId}
        AND pf."stockAtual" IS NOT NULL AND pf."stockAtual" < 0
      ORDER BY pf."stockAtual" ASC
      LIMIT ${limit}
    `,

    // 10) Vendeu mas sem stockMin/Max
    fetchByOrder(
      prisma,
      farmaciaId,
      ano,
      mes,
      Prisma.sql`${VB_EXPR} DESC`,
      Prisma.sql`AND ${QTD_EXPR} > 0
                 AND (pf."stockMinimo" IS NULL OR pf."stockMaximo" IS NULL)`,
      limit,
      "left"
    ),

    // 11) Totals — incluímos produtos distintos vendidos + sums
    prisma.$queryRaw<
      Array<{
        produtos: bigint | number;
        qtd: string | number | null;
        vb: string | number | null;
        vu: string | number | null;
        vp: string | number | null;
      }>
    >`
      SELECT
        COUNT(*)::bigint                                          AS "produtos",
        SUM(COALESCE(vm."quantidadeLiquida", vm."quantidade"))::numeric AS "qtd",
        SUM(COALESCE(vm."valorBruto", vm."valorTotal"))::numeric        AS "vb",
        SUM(COALESCE(vm."valorPagoUtente", vm."valorTotal"))::numeric   AS "vu",
        SUM(
          COALESCE(pf."stockAtual", 0) * COALESCE(pf."puc", pf."pmc", 0)
        )::numeric AS "vp"
      FROM "VendaMensal" vm
      LEFT JOIN "ProdutoFarmacia" pf
        ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
      WHERE vm."farmaciaId" = ${farmaciaId}
        AND vm."ano" = ${ano} AND vm."mes" = ${mes}
    `,

    // 12) Count de candidatos a ruptura (para summary)
    prisma.$queryRaw<Array<{ n: bigint | number }>>`
      SELECT COUNT(*)::bigint AS "n"
      FROM "VendaMensal" vm
      JOIN "ProdutoFarmacia" pf
        ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
      WHERE vm."farmaciaId" = ${farmaciaId}
        AND vm."ano" = ${ano} AND vm."mes" = ${mes}
        AND ${QTD_EXPR} > 0
        AND pf."stockAtual" IS NOT NULL
        AND (
          (pf."stockMinimo" IS NOT NULL AND pf."stockAtual" < pf."stockMinimo")
          OR pf."stockAtual" < ${QTD_EXPR} * ${RUPTURA_RATIO}
          OR (${COVERAGE_EXPR}) < ${COVERAGE_RUPTURA_DAYS}
        )
    `,

    // 13) Count de candidatos a excesso
    prisma.$queryRaw<Array<{ n: bigint | number }>>`
      SELECT COUNT(*)::bigint AS "n"
      FROM "VendaMensal" vm
      JOIN "ProdutoFarmacia" pf
        ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
      WHERE vm."farmaciaId" = ${farmaciaId}
        AND vm."ano" = ${ano} AND vm."mes" = ${mes}
        AND pf."stockAtual" IS NOT NULL AND pf."stockAtual" > 0
        AND (
          (pf."stockMaximo" IS NOT NULL AND pf."stockAtual" > pf."stockMaximo")
          OR (${COVERAGE_EXPR}) > ${COVERAGE_EXCESSO_DAYS}
        )
    `,
  ]);

  const totalsT = totalsRow[0] ?? { produtos: 0, qtd: 0, vb: 0, vu: 0, vp: 0 };

  const toAnomaly = (r: RowDb): AnomalyProductRow => ({
    produtoId: r.produtoId,
    cnp: r.cnp,
    designacao: r.designacao ?? "(sem designação)",
    stockAtual: decToNumOrNull(r.stockAtual),
    stockMinimo: decToNumOrNull(r.stockMinimo),
    stockMaximo: decToNumOrNull(r.stockMaximo),
    quantidadeMensal: decToNum(r.quantidadeMensal),
    valorBruto: decToNum(r.valorBruto),
  });

  return {
    totals: {
      produtosVendidos: Number(totalsT.produtos),
      quantidadeLiquidaSum: Number(totalsT.qtd ?? 0),
      valorBrutoSum: Number(totalsT.vb ?? 0),
      valorPagoUtenteSum: Number(totalsT.vu ?? 0),
      produtosRuptura: Number(rupturaCount[0]?.n ?? 0),
      produtosExcesso: Number(excessoCount[0]?.n ?? 0),
      valorParadoTotal: Number(totalsT.vp ?? 0),
    },
    ruptura: rupturaRows.map(mapOperationalRow),
    excesso: excessoRows.map(mapOperationalRow),
    cobertura: coberturaRows.map(mapOperationalRow),
    topByValor: topValorRows.map(mapOperationalRow),
    topByQty: topQtyRows.map(mapOperationalRow),
    margemTop: margemRows.map(mapOperationalRow),
    devolucoes: devolucoesRows.map(mapOperationalRow),
    semStock: semStockRows.map(toAnomaly),
    stockNegativo: stockNegativoRows.map(toAnomaly),
    semBounds: semBoundsRows.map(toAnomaly),
  };
}

export {
  COVERAGE_RUPTURA_DAYS,
  COVERAGE_EXCESSO_DAYS,
  RUPTURA_RATIO,
  monthLabel,
};
