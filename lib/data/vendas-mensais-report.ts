/**
 * lib/data/vendas-mensais-report.ts
 *
 * Loader **server-only** dedicado para `/relatorios/vendas-mensais`.
 * Lê `VendaMensal` + `ProdutoFarmacia` + `Produto` para produzir o
 * relatório operacional v1. Isolado de qualquer loader legado para
 * evitar regressão no dashboard existente.
 *
 * Fontes:
 *   · `VendaMensal`   — produzido por `scripts/aggregate-vendamensal.ts`
 *                       (origem='agent-bootstrap-staging') ou por loaders
 *                       Excel históricos (origem=null). Os campos legados
 *                       `quantidade`/`valorTotal` estão sempre populados;
 *                       os campos novos (quantidadeLiquida, valorBruto,
 *                       valorPagoUtente, …) só existem para rows agregadas
 *                       pelo script. Para máxima compatibilidade, este
 *                       loader usa COALESCE para preferir os novos campos
 *                       quando existem.
 *   · `ProdutoFarmacia` — snapshot corrente de stock (não histórico). Os
 *                       reports de stock-vs-venda são "vendeu este mês mas
 *                       hoje não tem stock". É a leitura operacional
 *                       pedida: identificar produtos a repor.
 *   · `Produto`       — catálogo central (cnp, designacao) para link.
 *
 * Não toca em:
 *   · `Venda` (linha-a-linha diária) — não usado por este relatório.
 *   · `IngestVendaLinhaRaw` (staging) — usado só pelo aggregator script.
 *   · `IndicadoresProdutoFarmacia` — KPIs derivados; não pretendemos
 *     duplicar/substituir.
 *
 * Todos os queries são scoped por farmacia + (ano,mes) e devolvem listas
 * pequenas (≤ 20–50 rows). Sem paginação por enquanto.
 */

import "server-only";
import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

/** ---------- Tipos públicos ---------- */

export type MonthOption = {
  ano: number;
  mes: number;
  label: string;
};

export type FarmaciaOption = {
  id: string;
  nome: string;
};

export type MonthlyTotals = {
  produtosDistinctos: number;
  quantidadeLiquida: number;
  valorBruto: number;
  valorPagoUtente: number;
  valorComparticipado: number;
  linhasVenda: number;
  atendimentos: number;
  /** Produtos cuja quantidadeLiquida ficou < 0 no mês (devoluções > vendas). */
  produtosComDevolucaoLiquida: number;
};

export type TopProductRow = {
  produtoId: string;
  cnp: number | null;
  designacao: string;
  quantidadeLiquida: number;
  valorBruto: number;
  valorPagoUtente: number;
  valorComparticipado: number;
  linhasVenda: number;
  atendimentos: number;
  // Snapshot stock + preços para enriquecer tabela quando disponíveis.
  stockAtual: number | null;
  stockMinimo: number | null;
  stockMaximo: number | null;
  pvp: number | null;
  pmc: number | null;
  puc: number | null;
};

export type StockAnomalyRow = {
  produtoId: string;
  cnp: number | null;
  designacao: string;
  stockAtual: number | null;
  stockMinimo: number | null;
  stockMaximo: number | null;
  quantidadeLiquida: number;
  valorBruto: number;
};

export type MarginRow = TopProductRow & {
  /** (pvp − puc) / pvp × 100, calculado server-side. Null quando faltam pvp/puc. */
  margemPercent: number | null;
  /** margem × quantidadeLiquida — “valor de margem” aproximado do mês. */
  margemValor: number | null;
};

export type ReportData = {
  totals: MonthlyTotals;
  topByValor: TopProductRow[];
  topByQty: TopProductRow[];
  devolucoesLiquidas: TopProductRow[];
  soldWithoutStock: StockAnomalyRow[];
  negativeStock: StockAnomalyRow[];
  soldWithoutStockBounds: StockAnomalyRow[];
  marginRanking: MarginRow[];
};

/** ---------- Helpers ---------- */

const MESES_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

function monthLabel(ano: number, mes: number): string {
  const name = MESES_PT[mes - 1] ?? String(mes).padStart(2, "0");
  return `${name} ${ano}`;
}

function decimalToNumber(v: Prisma.Decimal | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  // Prisma.Decimal expõe toNumber()
  const n = (v as Prisma.Decimal).toNumber?.();
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function nullableDecimalToNumber(
  v: Prisma.Decimal | number | null | undefined
): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = (v as Prisma.Decimal).toNumber?.();
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** ---------- Filter options ---------- */

/**
 * Lista de meses disponíveis em VendaMensal para a farmácia. Devolve
 * mais recentes primeiro. Inclui qualquer origem (Excel legado +
 * agent-bootstrap-staging) — operador pode comparar épocas.
 */
export async function getAvailableMonths(farmaciaId: string): Promise<MonthOption[]> {
  const prisma = await getPrisma();
  const rows = await prisma.vendaMensal.findMany({
    where: { farmaciaId },
    select: { ano: true, mes: true },
    distinct: ["ano", "mes"],
    orderBy: [{ ano: "desc" }, { mes: "desc" }],
    take: 60, // 5 anos
  });
  return rows.map((r) => ({
    ano: r.ano,
    mes: r.mes,
    label: monthLabel(r.ano, r.mes),
  }));
}

/** ---------- Report queries ---------- */

type RawSummaryRow = {
  produtos: bigint | number;
  qtd: string | number | null;
  vb: string | number | null;
  vu: string | number | null;
  vc: string | number | null;
  linhas: bigint | number | null;
  atend: bigint | number | null;
  produtosNegativos: bigint | number;
};

async function fetchTotals(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number
): Promise<MonthlyTotals> {
  // COALESCE prefere os campos novos da agregação; cai para os legados
  // (quantidade, valorTotal) quando agregação ainda não correu para esse
  // mês — para preservar visibilidade dos meses históricos importados
  // por Excel.
  const rows = await prisma.$queryRaw<RawSummaryRow[]>`
    SELECT
      COUNT(*)::bigint                                          AS "produtos",
      SUM(COALESCE("quantidadeLiquida", "quantidade"))::numeric AS "qtd",
      SUM(COALESCE("valorBruto", "valorTotal"))::numeric        AS "vb",
      SUM(COALESCE("valorPagoUtente", "valorTotal"))::numeric   AS "vu",
      SUM(COALESCE("valorComparticipado", 0))::numeric          AS "vc",
      SUM(COALESCE("linhasVenda", 0))::bigint                   AS "linhas",
      SUM(COALESCE("atendimentos", 0))::bigint                  AS "atend",
      SUM(
        CASE WHEN COALESCE("quantidadeLiquida", "quantidade") < 0
             THEN 1 ELSE 0 END
      )::bigint                                                 AS "produtosNegativos"
    FROM "VendaMensal"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "ano" = ${ano}
      AND "mes" = ${mes}
  `;
  const r = rows[0];
  if (!r) {
    return {
      produtosDistinctos: 0,
      quantidadeLiquida: 0,
      valorBruto: 0,
      valorPagoUtente: 0,
      valorComparticipado: 0,
      linhasVenda: 0,
      atendimentos: 0,
      produtosComDevolucaoLiquida: 0,
    };
  }
  return {
    produtosDistinctos: Number(r.produtos),
    quantidadeLiquida: Number(r.qtd ?? 0),
    valorBruto: Number(r.vb ?? 0),
    valorPagoUtente: Number(r.vu ?? 0),
    valorComparticipado: Number(r.vc ?? 0),
    linhasVenda: Number(r.linhas ?? 0),
    atendimentos: Number(r.atend ?? 0),
    produtosComDevolucaoLiquida: Number(r.produtosNegativos ?? 0),
  };
}

type TopProductDb = {
  produtoId: string;
  designacao: string;
  cnp: number | null;
  quantidadeLiquida: Prisma.Decimal | null;
  valorBruto: Prisma.Decimal | null;
  valorPagoUtente: Prisma.Decimal | null;
  valorComparticipado: Prisma.Decimal | null;
  linhasVenda: number | null;
  atendimentos: number | null;
  pvp: Prisma.Decimal | null;
  pmc: Prisma.Decimal | null;
  puc: Prisma.Decimal | null;
  stockAtual: Prisma.Decimal | null;
  stockMinimo: Prisma.Decimal | null;
  stockMaximo: Prisma.Decimal | null;
};

async function fetchTopByValor(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number,
  limit: number
): Promise<TopProductRow[]> {
  return fetchProductsOrdered(prisma, farmaciaId, ano, mes, "valorBruto DESC", limit, "any");
}

async function fetchTopByQty(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number,
  limit: number
): Promise<TopProductRow[]> {
  return fetchProductsOrdered(prisma, farmaciaId, ano, mes, "quantidadeLiquida DESC", limit, "any");
}

async function fetchDevolucoesLiquidas(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number,
  limit: number
): Promise<TopProductRow[]> {
  return fetchProductsOrdered(prisma, farmaciaId, ano, mes, "quantidadeLiquida ASC", limit, "negativeOnly");
}

/**
 * Helper que suporta os três top-lists (valor desc, qtd desc, devoluções
 * asc). Filtro de "negativeOnly" aplicado quando devoluções líquidas.
 */
async function fetchProductsOrdered(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number,
  order: "valorBruto DESC" | "quantidadeLiquida DESC" | "quantidadeLiquida ASC",
  limit: number,
  filter: "any" | "negativeOnly"
): Promise<TopProductRow[]> {
  // Ordem composta como string literal — segurança garantida pelo tipo.
  // (Prisma.sql não suporta dynamic ORDER BY noutra coluna além de
  // literal text.) Whitelist enforced pelo TypeScript: o tipo `order` é
  // união literal, logo não há injection possível aqui.
  const filterClause = filter === "negativeOnly"
    ? Prisma.sql`AND COALESCE(vm."quantidadeLiquida", vm."quantidade") < 0`
    : Prisma.empty;
  const orderClause = order === "valorBruto DESC"
    ? Prisma.sql`COALESCE(vm."valorBruto", vm."valorTotal") DESC`
    : order === "quantidadeLiquida DESC"
      ? Prisma.sql`COALESCE(vm."quantidadeLiquida", vm."quantidade") DESC`
      : Prisma.sql`COALESCE(vm."quantidadeLiquida", vm."quantidade") ASC`;

  const rows = await prisma.$queryRaw<TopProductDb[]>`
    SELECT
      vm."produtoId"                                  AS "produtoId",
      p."designacao"                                  AS "designacao",
      p."cnp"                                         AS "cnp",
      COALESCE(vm."quantidadeLiquida", vm."quantidade") AS "quantidadeLiquida",
      COALESCE(vm."valorBruto", vm."valorTotal")      AS "valorBruto",
      COALESCE(vm."valorPagoUtente", vm."valorTotal") AS "valorPagoUtente",
      COALESCE(vm."valorComparticipado", 0)           AS "valorComparticipado",
      COALESCE(vm."linhasVenda", 0)                   AS "linhasVenda",
      COALESCE(vm."atendimentos", 0)                  AS "atendimentos",
      pf."pvp"                                        AS "pvp",
      pf."pmc"                                        AS "pmc",
      pf."puc"                                        AS "puc",
      pf."stockAtual"                                 AS "stockAtual",
      pf."stockMinimo"                                AS "stockMinimo",
      pf."stockMaximo"                                AS "stockMaximo"
    FROM "VendaMensal" vm
    JOIN "Produto" p ON p."id" = vm."produtoId"
    LEFT JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
    WHERE vm."farmaciaId" = ${farmaciaId}
      AND vm."ano" = ${ano}
      AND vm."mes" = ${mes}
    ${filterClause}
    ORDER BY ${orderClause}
    LIMIT ${limit}
  `;
  return rows.map(mapTopProduct);
}

function mapTopProduct(r: TopProductDb): TopProductRow {
  return {
    produtoId: r.produtoId,
    cnp: r.cnp,
    designacao: r.designacao ?? "(sem designação)",
    quantidadeLiquida: decimalToNumber(r.quantidadeLiquida),
    valorBruto: decimalToNumber(r.valorBruto),
    valorPagoUtente: decimalToNumber(r.valorPagoUtente),
    valorComparticipado: decimalToNumber(r.valorComparticipado),
    linhasVenda: Number(r.linhasVenda ?? 0),
    atendimentos: Number(r.atendimentos ?? 0),
    pvp: nullableDecimalToNumber(r.pvp),
    pmc: nullableDecimalToNumber(r.pmc),
    puc: nullableDecimalToNumber(r.puc),
    stockAtual: nullableDecimalToNumber(r.stockAtual),
    stockMinimo: nullableDecimalToNumber(r.stockMinimo),
    stockMaximo: nullableDecimalToNumber(r.stockMaximo),
  };
}

type AnomalyDb = {
  produtoId: string;
  designacao: string;
  cnp: number | null;
  stockAtual: Prisma.Decimal | null;
  stockMinimo: Prisma.Decimal | null;
  stockMaximo: Prisma.Decimal | null;
  quantidadeLiquida: Prisma.Decimal | null;
  valorBruto: Prisma.Decimal | null;
};

function mapAnomaly(r: AnomalyDb): StockAnomalyRow {
  return {
    produtoId: r.produtoId,
    cnp: r.cnp,
    designacao: r.designacao ?? "(sem designação)",
    stockAtual: nullableDecimalToNumber(r.stockAtual),
    stockMinimo: nullableDecimalToNumber(r.stockMinimo),
    stockMaximo: nullableDecimalToNumber(r.stockMaximo),
    quantidadeLiquida: decimalToNumber(r.quantidadeLiquida),
    valorBruto: decimalToNumber(r.valorBruto),
  };
}

async function fetchSoldWithoutStock(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number,
  limit: number
): Promise<StockAnomalyRow[]> {
  // Produto vendeu no mês mas hoje stockAtual=0 ou IS NULL.
  // Ordena pelos que mais valor moveram — repor estes primeiro.
  const rows = await prisma.$queryRaw<AnomalyDb[]>`
    SELECT
      vm."produtoId"                                    AS "produtoId",
      p."designacao"                                    AS "designacao",
      p."cnp"                                           AS "cnp",
      pf."stockAtual"                                   AS "stockAtual",
      pf."stockMinimo"                                  AS "stockMinimo",
      pf."stockMaximo"                                  AS "stockMaximo",
      COALESCE(vm."quantidadeLiquida", vm."quantidade") AS "quantidadeLiquida",
      COALESCE(vm."valorBruto", vm."valorTotal")        AS "valorBruto"
    FROM "VendaMensal" vm
    JOIN "Produto" p ON p."id" = vm."produtoId"
    LEFT JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
    WHERE vm."farmaciaId" = ${farmaciaId}
      AND vm."ano" = ${ano}
      AND vm."mes" = ${mes}
      AND COALESCE(vm."quantidadeLiquida", vm."quantidade") > 0
      AND (pf."stockAtual" IS NULL OR pf."stockAtual" = 0)
    ORDER BY COALESCE(vm."valorBruto", vm."valorTotal") DESC
    LIMIT ${limit}
  `;
  return rows.map(mapAnomaly);
}

async function fetchNegativeStock(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number,
  limit: number
): Promise<StockAnomalyRow[]> {
  // Stock negativo é uma anomalia operacional independente de mês —
  // mas o operador quer ver no contexto do mês a quantidadeLiquida
  // correspondente para entender se houve venda no período.
  const rows = await prisma.$queryRaw<AnomalyDb[]>`
    SELECT
      pf."produtoId"                                    AS "produtoId",
      p."designacao"                                    AS "designacao",
      p."cnp"                                           AS "cnp",
      pf."stockAtual"                                   AS "stockAtual",
      pf."stockMinimo"                                  AS "stockMinimo",
      pf."stockMaximo"                                  AS "stockMaximo",
      COALESCE(vm."quantidadeLiquida", vm."quantidade", 0) AS "quantidadeLiquida",
      COALESCE(vm."valorBruto", vm."valorTotal", 0)        AS "valorBruto"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto" p ON p."id" = pf."produtoId"
    LEFT JOIN "VendaMensal" vm
      ON vm."produtoId" = pf."produtoId"
     AND vm."farmaciaId" = pf."farmaciaId"
     AND vm."ano" = ${ano} AND vm."mes" = ${mes}
    WHERE pf."farmaciaId" = ${farmaciaId}
      AND pf."stockAtual" IS NOT NULL
      AND pf."stockAtual" < 0
    ORDER BY pf."stockAtual" ASC
    LIMIT ${limit}
  `;
  return rows.map(mapAnomaly);
}

async function fetchSoldWithoutStockBounds(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number,
  limit: number
): Promise<StockAnomalyRow[]> {
  // Produto teve venda mas não tem min/max definidos → impossível
  // sugerir reposição automática. Útil para identificar gaps no setup.
  const rows = await prisma.$queryRaw<AnomalyDb[]>`
    SELECT
      vm."produtoId"                                    AS "produtoId",
      p."designacao"                                    AS "designacao",
      p."cnp"                                           AS "cnp",
      pf."stockAtual"                                   AS "stockAtual",
      pf."stockMinimo"                                  AS "stockMinimo",
      pf."stockMaximo"                                  AS "stockMaximo",
      COALESCE(vm."quantidadeLiquida", vm."quantidade") AS "quantidadeLiquida",
      COALESCE(vm."valorBruto", vm."valorTotal")        AS "valorBruto"
    FROM "VendaMensal" vm
    JOIN "Produto" p ON p."id" = vm."produtoId"
    LEFT JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
    WHERE vm."farmaciaId" = ${farmaciaId}
      AND vm."ano" = ${ano}
      AND vm."mes" = ${mes}
      AND COALESCE(vm."quantidadeLiquida", vm."quantidade") > 0
      AND (pf."stockMinimo" IS NULL OR pf."stockMaximo" IS NULL)
    ORDER BY COALESCE(vm."valorBruto", vm."valorTotal") DESC
    LIMIT ${limit}
  `;
  return rows.map(mapAnomaly);
}

async function fetchMarginRanking(
  prisma: PrismaClient,
  farmaciaId: string,
  ano: number,
  mes: number,
  limit: number
): Promise<MarginRow[]> {
  // Margem aproximada: (pvp − puc) / pvp × 100. Restringe a produtos com
  // pvp e puc populados E pvp > 0 (evita division-by-zero). Ordena por
  // (margem% × qtd) DESC — o "valor de margem" do mês, não margem isolada
  // sem volume.
  const rows = await prisma.$queryRaw<TopProductDb[]>`
    SELECT
      vm."produtoId"                                    AS "produtoId",
      p."designacao"                                    AS "designacao",
      p."cnp"                                           AS "cnp",
      COALESCE(vm."quantidadeLiquida", vm."quantidade") AS "quantidadeLiquida",
      COALESCE(vm."valorBruto", vm."valorTotal")        AS "valorBruto",
      COALESCE(vm."valorPagoUtente", vm."valorTotal")   AS "valorPagoUtente",
      COALESCE(vm."valorComparticipado", 0)             AS "valorComparticipado",
      COALESCE(vm."linhasVenda", 0)                     AS "linhasVenda",
      COALESCE(vm."atendimentos", 0)                    AS "atendimentos",
      pf."pvp"                                          AS "pvp",
      pf."pmc"                                          AS "pmc",
      pf."puc"                                          AS "puc",
      pf."stockAtual"                                   AS "stockAtual",
      pf."stockMinimo"                                  AS "stockMinimo",
      pf."stockMaximo"                                  AS "stockMaximo"
    FROM "VendaMensal" vm
    JOIN "Produto" p ON p."id" = vm."produtoId"
    JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
    WHERE vm."farmaciaId" = ${farmaciaId}
      AND vm."ano" = ${ano}
      AND vm."mes" = ${mes}
      AND pf."pvp" IS NOT NULL AND pf."pvp" > 0
      AND pf."puc" IS NOT NULL
      AND COALESCE(vm."quantidadeLiquida", vm."quantidade") > 0
    ORDER BY
      ((pf."pvp" - pf."puc") / pf."pvp")
      * COALESCE(vm."quantidadeLiquida", vm."quantidade") DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => {
    const base = mapTopProduct(r);
    let margemPercent: number | null = null;
    let margemValor: number | null = null;
    if (base.pvp !== null && base.pvp > 0 && base.puc !== null) {
      const m = (base.pvp - base.puc) / base.pvp;
      margemPercent = m * 100;
      margemValor = m * base.quantidadeLiquida * base.pvp;
    }
    return { ...base, margemPercent, margemValor };
  });
}

/** ---------- API principal ---------- */

/**
 * Carrega todos os datasets necessários para o relatório mensal de
 * uma farmácia. Limites configuráveis por dataset — defaults são
 * conservadores (20 rows).
 */
export async function getMonthlyReport(
  farmaciaId: string,
  ano: number,
  mes: number,
  opts: { limit?: number } = {}
): Promise<ReportData> {
  const limit = opts.limit ?? 20;
  const prisma = await getPrisma();

  const [
    totals,
    topByValor,
    topByQty,
    devolucoesLiquidas,
    soldWithoutStock,
    negativeStock,
    soldWithoutStockBounds,
    marginRanking,
  ] = await Promise.all([
    fetchTotals(prisma, farmaciaId, ano, mes),
    fetchTopByValor(prisma, farmaciaId, ano, mes, limit),
    fetchTopByQty(prisma, farmaciaId, ano, mes, limit),
    fetchDevolucoesLiquidas(prisma, farmaciaId, ano, mes, limit),
    fetchSoldWithoutStock(prisma, farmaciaId, ano, mes, limit),
    fetchNegativeStock(prisma, farmaciaId, ano, mes, limit),
    fetchSoldWithoutStockBounds(prisma, farmaciaId, ano, mes, limit),
    fetchMarginRanking(prisma, farmaciaId, ano, mes, limit),
  ]);

  return {
    totals,
    topByValor,
    topByQty,
    devolucoesLiquidas,
    soldWithoutStock,
    negativeStock,
    soldWithoutStockBounds,
    marginRanking,
  };
}

export { monthLabel };
