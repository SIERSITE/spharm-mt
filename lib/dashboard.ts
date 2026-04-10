/**
 * lib/dashboard.ts
 *
 * Dados para o dashboard, lidos exclusivamente da base de dados via Prisma.
 * Nunca lê ficheiros Excel directamente — os dados devem estar importados
 * previamente através de lib/importer.ts.
 *
 * Fonte dos valores:
 *
 * Vendas (€)  → VendaMensal.valorTotal  (= quantidade × pvp, populado no import)
 * Margem (%)  → (valorTotal − custo) / valorTotal
 *               custo = quantidade × COALESCE(pmc, puc, 0)  (join com ProdutoFarmacia)
 * Stock parado → ProdutoFarmacia com stockAtual > 0 e sem VendaMensal com
 *               quantidade > 0 nos últimos MESES_PARADO meses
 * Alertas     → ProdutoFarmacia onde stockAtual ≤ stockMinimo
 */

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Produtos sem vendas neste número de meses são considerados stock parado */
const MESES_PARADO = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PharmacyData = {
  id: string;
  name: string;
  /** Receita em € no mês actual (VendaMensal.valorTotal) */
  sales: number;
  /** Receita em € no mês anterior (para calcular tendência) */
  salesPrev: number;
  /** Margem bruta em % (0–100) */
  margin: number;
  /** Margem do mês anterior em % */
  marginPrev: number;
  /** Valor do stock parado em € */
  stoppedStockValue: number;
  /** Nº de produtos com stock parado */
  stoppedStockCount: number;
  /** Nº de produtos abaixo do stock mínimo */
  alerts: number;
};

export type TopProduto = {
  produtoId: string;
  designacao: string;
  /** Unidades vendidas no mês actual */
  quantidade: number;
};

export type Alerta = {
  tipo: "STOCK_MINIMO" | "STOCK_PARADO" | "DIFERENCA_STOCK";
  farmaciaId?: string;
  farmaciaNome?: string;
  produtoId?: string;
  descricao: string;
};

export type DashboardSummary = {
  totalSales: number;
  totalSalesPrev: number;
  /** Margem ponderada pelo volume de vendas de cada farmácia */
  totalMargin: number;
  totalMarginPrev: number;
  totalStoppedStockValue: number;
  totalAlerts: number;
};

export type DashboardData = {
  summary: DashboardSummary;
  pharmacies: PharmacyData[];
  topProdutos: TopProduto[];
  alertas: Alerta[];
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function calcMargem(totalVendas: number, totalCusto: number): number {
  return totalVendas > 0 ? ((totalVendas - totalCusto) / totalVendas) * 100 : 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function getDashboardData(): Promise<DashboardData> {
  const now = new Date();
  const anoAtual = now.getFullYear();
  const mesAtual = now.getMonth() + 1;

  const anoPrev = mesAtual === 1 ? anoAtual - 1 : anoAtual;
  const mesPrev = mesAtual === 1 ? 12 : mesAtual - 1;

  // Período linear (ano×12 + mes) — simplifica comparações entre meses no SQL
  const periodoAtual = anoAtual * 12 + mesAtual;
  const periodoStopThreshold = periodoAtual - MESES_PARADO;

  const [
    farmacias,
    vendasAtualGrupo,
    vendasPrevGrupo,
    // Margem mês actual: JOIN VendaMensal com ProdutoFarmacia para obter custo
    // custo = quantidade × pmc (custo médio de compra do ficheiro de vendas)
    // fallback: puc (custo do ficheiro de stock), depois 0
    margemAtual,
    margemPrev,
    // Stock parado: stockAtual > 0 e sem vendas nos últimos MESES_PARADO meses
    // Valor = stockAtual × COALESCE(puc, pmc, 0)
    stockParadoGrupo,
    // Alertas: stockAtual ≤ stockMinimo (comparação de dois campos — requer raw)
    alertasMinRaw,
    // Top 10 produtos do mês actual por quantidade
    topProdutosRaw,
    // Lista de produtos com stock parado para a secção de alertas
    alertasStockParadoRaw,
  ] = await Promise.all([
    prisma.farmacia.findMany({
      where: { estado: "ATIVO" },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    }),

    prisma.vendaMensal.groupBy({
      by: ["farmaciaId"],
      where: { ano: anoAtual, mes: mesAtual },
      _sum: { valorTotal: true },
    }),

    prisma.vendaMensal.groupBy({
      by: ["farmaciaId"],
      where: { ano: anoPrev, mes: mesPrev },
      _sum: { valorTotal: true },
    }),

    // Margem mês actual
    // Nota: pmc aqui é o custo médio de compra (do ficheiro de vendas),
    // não o Preço Máximo ao Consumidor — o nome vem do schema existente.
    prisma.$queryRaw<
      Array<{ farmaciaId: string; totalVendas: string; totalCusto: string }>
    >(Prisma.sql`
      SELECT
        vm."farmaciaId",
        SUM(vm."valorTotal")::text                                              AS "totalVendas",
        SUM(vm."quantidade" * COALESCE(pf."pmc", pf."puc", 0))::text           AS "totalCusto"
      FROM "VendaMensal" vm
      LEFT JOIN "ProdutoFarmacia" pf
        ON pf."produtoId" = vm."produtoId"
       AND pf."farmaciaId" = vm."farmaciaId"
      WHERE vm."ano" = ${anoAtual} AND vm."mes" = ${mesAtual}
      GROUP BY vm."farmaciaId"
    `),

    // Margem mês anterior
    prisma.$queryRaw<
      Array<{ farmaciaId: string; totalVendas: string; totalCusto: string }>
    >(Prisma.sql`
      SELECT
        vm."farmaciaId",
        SUM(vm."valorTotal")::text                                              AS "totalVendas",
        SUM(vm."quantidade" * COALESCE(pf."pmc", pf."puc", 0))::text           AS "totalCusto"
      FROM "VendaMensal" vm
      LEFT JOIN "ProdutoFarmacia" pf
        ON pf."produtoId" = vm."produtoId"
       AND pf."farmaciaId" = vm."farmaciaId"
      WHERE vm."ano" = ${anoPrev} AND vm."mes" = ${mesPrev}
      GROUP BY vm."farmaciaId"
    `),

    // Stock parado por farmácia
    prisma.$queryRaw<
      Array<{ farmaciaId: string; valorParado: string; countParado: string }>
    >(Prisma.sql`
      SELECT
        pf."farmaciaId",
        SUM(pf."stockAtual" * COALESCE(pf."puc", pf."pmc", 0))::text  AS "valorParado",
        COUNT(*)::text                                                  AS "countParado"
      FROM "ProdutoFarmacia" pf
      WHERE
        pf."stockAtual" IS NOT NULL
        AND pf."stockAtual" > 0
        AND pf."flagRetirado" = false
        AND NOT EXISTS (
          SELECT 1
          FROM "VendaMensal" vm
          WHERE vm."produtoId" = pf."produtoId"
            AND vm."farmaciaId" = pf."farmaciaId"
            AND (vm."ano" * 12 + vm."mes") >= ${periodoStopThreshold}
            AND vm."quantidade" > 0
        )
      GROUP BY pf."farmaciaId"
    `),

    // Alertas de stock mínimo (stockAtual ≤ stockMinimo — comparação entre campos)
    prisma.$queryRaw<Array<{ farmaciaId: string; count: string }>>(Prisma.sql`
      SELECT "farmaciaId", COUNT(*)::text AS count
      FROM "ProdutoFarmacia"
      WHERE
        "stockMinimo" IS NOT NULL AND "stockMinimo" > 0
        AND "stockAtual" IS NOT NULL
        AND "stockAtual" <= "stockMinimo"
        AND "flagRetirado" = false
      GROUP BY "farmaciaId"
    `),

    // Top 10 produtos por quantidade vendida no mês actual
    prisma.vendaMensal.groupBy({
      by: ["produtoId"],
      where: { ano: anoAtual, mes: mesAtual },
      _sum: { quantidade: true },
      orderBy: { _sum: { quantidade: "desc" } },
      take: 10,
    }),

    // Top 10 produtos com stock parado (para lista de alertas)
    prisma.$queryRaw<
      Array<{
        farmaciaId: string;
        farmaciaNome: string;
        produtoId: string;
        designacao: string;
        valorParado: string;
      }>
    >(Prisma.sql`
      SELECT
        pf."farmaciaId",
        fa."nome"            AS "farmaciaNome",
        pf."produtoId",
        p."designacao",
        (pf."stockAtual" * COALESCE(pf."puc", pf."pmc", 0))::text AS "valorParado"
      FROM "ProdutoFarmacia" pf
      JOIN "Farmacia" fa ON fa."id" = pf."farmaciaId"
      JOIN "Produto"  p  ON p."id"  = pf."produtoId"
      WHERE
        pf."stockAtual" IS NOT NULL
        AND pf."stockAtual" > 0
        AND pf."flagRetirado" = false
        AND NOT EXISTS (
          SELECT 1
          FROM "VendaMensal" vm
          WHERE vm."produtoId" = pf."produtoId"
            AND vm."farmaciaId" = pf."farmaciaId"
            AND (vm."ano" * 12 + vm."mes") >= ${periodoStopThreshold}
            AND vm."quantidade" > 0
        )
      ORDER BY (pf."stockAtual" * COALESCE(pf."puc", pf."pmc", 0)) DESC
      LIMIT 10
    `),
  ]);

  // ── Enrich top produtos com designação ──────────────────────────────────────
  const topIds = topProdutosRaw.map((t) => t.produtoId);
  const produtosMap =
    topIds.length > 0
      ? new Map(
          (
            await prisma.produto.findMany({
              where: { id: { in: topIds } },
              select: { id: true, designacao: true },
            })
          ).map((p) => [p.id, p.designacao])
        )
      : new Map<string, string>();

  // ── Lookup maps ─────────────────────────────────────────────────────────────

  const vendasAtualMap = new Map(
    vendasAtualGrupo.map((v) => [v.farmaciaId, toNum(v._sum.valorTotal)])
  );
  const vendasPrevMap = new Map(
    vendasPrevGrupo.map((v) => [v.farmaciaId, toNum(v._sum.valorTotal)])
  );
  const margemAtualMap = new Map(
    margemAtual.map((m) => [
      m.farmaciaId,
      { tv: toNum(m.totalVendas), tc: toNum(m.totalCusto) },
    ])
  );
  const margemPrevMap = new Map(
    margemPrev.map((m) => [
      m.farmaciaId,
      { tv: toNum(m.totalVendas), tc: toNum(m.totalCusto) },
    ])
  );
  const stockParadoMap = new Map(
    stockParadoGrupo.map((s) => [
      s.farmaciaId,
      { value: toNum(s.valorParado), count: toNum(s.countParado) },
    ])
  );
  const alertasMinMap = new Map(
    alertasMinRaw.map((a) => [a.farmaciaId, toNum(a.count)])
  );

  // ── Per-pharmacy ─────────────────────────────────────────────────────────────

  const pharmacies: PharmacyData[] = farmacias.map((f) => {
    const sales = vendasAtualMap.get(f.id) ?? 0;
    const salesPrev = vendasPrevMap.get(f.id) ?? 0;
    const ma = margemAtualMap.get(f.id) ?? { tv: 0, tc: 0 };
    const mp = margemPrevMap.get(f.id) ?? { tv: 0, tc: 0 };
    const stopped = stockParadoMap.get(f.id) ?? { value: 0, count: 0 };

    return {
      id: f.id,
      name: f.nome,
      sales,
      salesPrev,
      margin: calcMargem(ma.tv, ma.tc),
      marginPrev: calcMargem(mp.tv, mp.tc),
      stoppedStockValue: stopped.value,
      stoppedStockCount: Math.round(stopped.count),
      alerts: Math.round(alertasMinMap.get(f.id) ?? 0),
    };
  });

  // ── Summary ──────────────────────────────────────────────────────────────────

  const totalSales = pharmacies.reduce((s, p) => s + p.sales, 0);
  const totalSalesPrev = pharmacies.reduce((s, p) => s + p.salesPrev, 0);
  const totalStoppedStockValue = pharmacies.reduce(
    (s, p) => s + p.stoppedStockValue,
    0
  );
  const totalAlerts = pharmacies.reduce((s, p) => s + p.alerts, 0);

  // Margem ponderada pelo volume de vendas
  const totalMargin =
    totalSales > 0
      ? pharmacies.reduce((s, p) => s + p.margin * p.sales, 0) / totalSales
      : 0;
  const totalMarginPrev =
    totalSalesPrev > 0
      ? pharmacies.reduce((s, p) => s + p.marginPrev * p.salesPrev, 0) /
        totalSalesPrev
      : 0;

  // ── Top produtos ─────────────────────────────────────────────────────────────

  const topProdutos: TopProduto[] = topProdutosRaw.map((t) => ({
    produtoId: t.produtoId,
    designacao: produtosMap.get(t.produtoId) ?? "—",
    quantidade: toNum(t._sum.quantidade),
  }));

  // ── Alertas ──────────────────────────────────────────────────────────────────

  const alertas: Alerta[] = [];

  // 1. Stock mínimo por farmácia
  for (const f of farmacias) {
    const count = Math.round(alertasMinMap.get(f.id) ?? 0);
    if (count > 0) {
      alertas.push({
        tipo: "STOCK_MINIMO",
        farmaciaId: f.id,
        farmaciaNome: f.nome,
        descricao: `${count} produto(s) abaixo do stock mínimo em ${f.nome}`,
      });
    }
  }

  // 2. Stock parado (top 10 por valor)
  for (const sp of alertasStockParadoRaw) {
    alertas.push({
      tipo: "STOCK_PARADO",
      farmaciaId: sp.farmaciaId,
      farmaciaNome: sp.farmaciaNome,
      produtoId: sp.produtoId,
      descricao: `${sp.designacao} – sem vendas há +${MESES_PARADO} meses (${sp.farmaciaNome})`,
    });
  }

  // 3. Diferença de stock parado entre farmácias > 25%
  if (pharmacies.length === 2) {
    const [fa, fb] = pharmacies;
    const avg = (fa.stoppedStockValue + fb.stoppedStockValue) / 2;
    if (avg > 0) {
      const difPct =
        Math.abs(fa.stoppedStockValue - fb.stoppedStockValue) / avg;
      if (difPct > 0.25) {
        const maior =
          fa.stoppedStockValue > fb.stoppedStockValue ? fa.name : fb.name;
        alertas.push({
          tipo: "DIFERENCA_STOCK",
          descricao: `Diferença de stock parado de ${Math.round(difPct * 100)}% entre farmácias (${maior} acima da média)`,
        });
      }
    }
  }

  return {
    summary: {
      totalSales,
      totalSalesPrev,
      totalMargin,
      totalMarginPrev,
      totalStoppedStockValue,
      totalAlerts,
    },
    pharmacies,
    topProdutos,
    alertas,
  };
}
