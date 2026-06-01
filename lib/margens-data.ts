/**
 * lib/margens-data.ts
 *
 * Read-model do relatório operacional de Margens.
 *
 * Três níveis alimentados pelo MESMO universo agregado (produto×farm):
 *   1. Por produto   → 1 linha por (CNP × farmácia × período inteiro)
 *   2. Por categoria → agrega o Por Produto por categoria canónica
 *   3. Por farmácia  → agrega o Por Produto por farmácia
 *
 * Cobertura de custo:
 *   Estimamos o custo das vendas usando o `pmc` (preferido) ou `puc`
 *   (fallback) ACTUAL do `ProdutoFarmacia`. Não temos histórico de
 *   custos por mês — esta é uma aproximação. A UI exibe um aviso
 *   permanente sobre snapshot.
 *
 *   Para uma linha (produto×farm) com `pmc/puc>0` definimos
 *   `coberturaCusto = 1`; senão `0`. Numa agregação (categoria ou
 *   farmácia) a cobertura é a fracção PONDERADA POR UNIDADES VENDIDAS
 *   de linhas com custo conhecido.
 *
 * Regras duras (per spec):
 *   · Não inventar custo. PMC/PUC ausente → linha entra mas margem
 *     fica null e estado = SEM_CUSTO.
 *   · Margem % suprimida em estados PARCIAL e SEM_CUSTO.
 *   · Produtos sem custo aparecem como vendas sem custo (não excluídos).
 */

import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolveCategoria } from "@/lib/categoria-resolver";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

export type EstadoMargem = "FIAVEL" | "PARCIAL" | "SEM_CUSTO";

export type MargemRow = {
  cnp: number;
  designacao: string;
  categoria: string | null;
  grupo: string | null;
  farmaciaId: string;
  farmacia: string;
  qtdVendida: number;
  valorVendido: number;            // bruto (€)
  custoUnitarioBase: number | null; // PMC ou PUC snapshot actual
  custoEstimado: number | null;    // qty × custoUnitarioBase; null sem custo
  margemEur: number | null;
  margemPct: number | null;        // null se estado != FIAVEL
  coberturaCusto: number;          // 0..1 — pondera por unidades vendidas
  estado: EstadoMargem;
};

export type MargensAgg = {
  key: string;
  label: string;
  qtdVendida: number;
  valorVendido: number;
  custoEstimado: number;
  margemEur: number;
  margemPct: number | null;
  coberturaCusto: number;
  estado: EstadoMargem;
};

export type MargensResult = {
  porProduto: MargemRow[];
  porCategoria: MargensAgg[];
  porFarmacia: MargensAgg[];
  /** Agregado por Grupo Homogéneo (Produto.grupoHomogeneo / categoriaResolver). */
  porGrupo: MargensAgg[];
  /** KPIs globais sobre todas as linhas com custo conhecido. */
  totals: {
    qtdVendida: number;
    valorVendido: number;
    custoEstimado: number;
    margemEur: number;
    margemPct: number | null;
    coberturaCusto: number;
    estado: EstadoMargem;
  };
};

const FIAVEL_THRESHOLD = 0.95;
const PARCIAL_THRESHOLD = 0.5;

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function classifyMargem(cobertura: number): EstadoMargem {
  if (cobertura >= FIAVEL_THRESHOLD) return "FIAVEL";
  if (cobertura >= PARCIAL_THRESHOLD) return "PARCIAL";
  return "SEM_CUSTO";
}

function rounded2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function resolveFarmacias(
  prisma: PrismaClient,
  farmaciaNomes: string[] | undefined,
): Promise<{ ids: string[]; nomeById: Map<string, string> }> {
  const rows = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: {
        not: "Farmácia Teste",
        ...(farmaciaNomes && farmaciaNomes.length > 0 ? { in: farmaciaNomes } : {}),
      },
    },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  return {
    ids: rows.map((r) => r.id),
    nomeById: new Map(rows.map((r) => [r.id, r.nome])),
  };
}

/**
 * Converte um ISO yyyy-mm-dd para um índice de mês relativo
 * (ano*12 + mes). Usado para o WHERE em VendaMensal.
 */
function ymToIndex(iso: string | undefined, fallback: { y: number; m: number }): number {
  if (iso) {
    const m = /^(\d{4})-(\d{2})/.exec(iso);
    if (m) return parseInt(m[1], 10) * 12 + parseInt(m[2], 10);
  }
  return fallback.y * 12 + fallback.m;
}

export async function getMargensData(
  filters: SharedReportFilters = {},
): Promise<MargensResult> {
  const prisma = await getPrisma();
  const { ids: farmaciaIds, nomeById } = await resolveFarmacias(prisma, filters.farmaciaNomes);
  if (farmaciaIds.length === 0) {
    return emptyResult();
  }

  // ── Período (default: início do ano corrente → mês corrente) ────
  const now = new Date();
  const defFrom = { y: now.getUTCFullYear(), m: 1 };
  const defTo = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 };
  const minIdx = ymToIndex(filters.from, defFrom);
  const maxIdx = ymToIndex(filters.to, defTo);
  if (maxIdx < minIdx) return emptyResult();

  // ── Pre-filter de produtos (categorias/fabricantes/semClassif) ──
  // Mesma estratégia do Inventário: encolher cedo via produtoId IN (...).
  let produtoIdFilter: string[] | null = null;
  if (filters.categorias && filters.categorias.length > 0) {
    const classifs = await prisma.classificacao.findMany({
      where: { tipo: "NIVEL_1", estado: "ATIVO", nome: { in: filters.categorias } },
      select: { id: true },
    });
    const classifIds = classifs.map((c) => c.id);
    if (classifIds.length === 0) return emptyResult();
    const produtos = await prisma.produto.findMany({
      where: { classificacaoNivel1Id: { in: classifIds } },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return emptyResult();
  }
  if (filters.apenasSemClassif) {
    const produtos = await prisma.produto.findMany({
      where: {
        classificacaoNivel1Id: null,
        estado: { not: "INATIVO" },
        ...(produtoIdFilter ? { id: { in: produtoIdFilter } } : {}),
      },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return emptyResult();
  }
  if (filters.fabricantes && filters.fabricantes.length > 0) {
    const fabs = await prisma.fabricante.findMany({
      where: { nomeNormalizado: { in: filters.fabricantes }, estado: "ATIVO" },
      select: { id: true },
    });
    const fabIds = fabs.map((f) => f.id);
    if (fabIds.length === 0) return emptyResult();
    const produtos = await prisma.produto.findMany({
      where: {
        fabricanteId: { in: fabIds },
        ...(produtoIdFilter ? { id: { in: produtoIdFilter } } : {}),
      },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return emptyResult();
  }

  // ── Query principal: VendaMensal agg + ProdutoFarmacia + Produto ──
  // Distribuidor (pf.fornecedorOrigem) actua via filtro pf.
  const distrCond =
    filters.distribuidores && filters.distribuidores.length > 0
      ? Prisma.sql`AND pf."fornecedorOrigem" = ANY(${filters.distribuidores})`
      : Prisma.empty;
  const prodIdCond = produtoIdFilter
    ? Prisma.sql`AND p.id = ANY(${produtoIdFilter})`
    : Prisma.empty;
  const pesquisaCond =
    filters.pesquisa && filters.pesquisa.trim()
      ? (() => {
          const q = filters.pesquisa!.trim();
          const asNumber = Number(q);
          if (Number.isFinite(asNumber) && Number.isInteger(asNumber)) {
            return Prisma.sql`AND (p."cnp" = ${asNumber} OR p."designacao" ILIKE ${"%" + q + "%"})`;
          }
          return Prisma.sql`AND p."designacao" ILIKE ${"%" + q + "%"}`;
        })()
      : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{
      cnp: number;
      designacao: string;
      classificacaoNivel1Id: string | null;
      classificacaoNivel2Id: string | null;
      farmaciaId: string;
      categoriaOrigem: string | null;
      subcategoriaOrigem: string | null;
      qty: string;
      valor_bruto: string;
      pmc: string | null;
      puc: string | null;
    }>
  >(Prisma.sql`
    WITH agg AS (
      SELECT
        vm."produtoId",
        vm."farmaciaId",
        SUM(vm."quantidade")::numeric AS qty,
        SUM(COALESCE(vm."valorBruto", vm."valorTotal"))::numeric AS valor_bruto
      FROM "VendaMensal" vm
      WHERE vm."farmaciaId" = ANY(${farmaciaIds})
        AND (vm."ano" * 12 + vm."mes") BETWEEN ${minIdx} AND ${maxIdx}
      GROUP BY 1, 2
    )
    SELECT
      p."cnp"                       AS cnp,
      p."designacao"                AS designacao,
      p."classificacaoNivel1Id",
      p."classificacaoNivel2Id",
      agg."farmaciaId"              AS "farmaciaId",
      pf."categoriaOrigem",
      pf."subcategoriaOrigem",
      agg.qty::text                 AS qty,
      agg.valor_bruto::text         AS valor_bruto,
      pf."pmc"::text                AS pmc,
      pf."puc"::text                AS puc
    FROM agg
    JOIN "Produto" p ON p.id = agg."produtoId"
    LEFT JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = agg."produtoId" AND pf."farmaciaId" = agg."farmaciaId"
    WHERE 1 = 1
      ${distrCond}
      ${prodIdCond}
      ${pesquisaCond}
    ORDER BY p."designacao" ASC
  `);

  // ── Classificações em batch para resolveCategoria ───────────────
  const classifIdSet = new Set<string>();
  for (const r of rows) {
    if (r.classificacaoNivel1Id) classifIdSet.add(r.classificacaoNivel1Id);
    if (r.classificacaoNivel2Id) classifIdSet.add(r.classificacaoNivel2Id);
  }
  const classifMap = new Map<string, string>();
  if (classifIdSet.size > 0) {
    const cs = await prisma.classificacao.findMany({
      where: { id: { in: Array.from(classifIdSet) } },
      select: { id: true, nome: true },
    });
    for (const c of cs) classifMap.set(c.id, c.nome);
  }

  // ── Compor linhas Por Produto ───────────────────────────────────
  const porProduto: MargemRow[] = rows.map((r) => {
    const qty = toF(r.qty);
    const valorVendido = rounded2(toF(r.valor_bruto));
    const pmc = numOrNull(r.pmc);
    const puc = numOrNull(r.puc);
    const custoUnitarioBase =
      pmc !== null && pmc > 0 ? pmc : puc !== null && puc > 0 ? puc : null;
    const cobertura = custoUnitarioBase !== null ? 1 : 0;
    const custoEstimado =
      custoUnitarioBase !== null ? rounded2(qty * custoUnitarioBase) : null;
    const margemEur = custoEstimado !== null ? rounded2(valorVendido - custoEstimado) : null;
    const estado = classifyMargem(cobertura);
    const margemPct =
      estado === "FIAVEL" && valorVendido > 0 && margemEur !== null
        ? Math.round((margemEur / valorVendido) * 10000) / 100
        : null;

    const n1Nome = r.classificacaoNivel1Id ? classifMap.get(r.classificacaoNivel1Id) : null;
    const n2Nome = r.classificacaoNivel2Id ? classifMap.get(r.classificacaoNivel2Id) : null;
    const cat = resolveCategoria({
      classificacaoNivel1: n1Nome ? { nome: n1Nome } : null,
      classificacaoNivel2: n2Nome ? { nome: n2Nome } : null,
      categoriaOrigem: r.categoriaOrigem,
      subcategoriaOrigem: r.subcategoriaOrigem,
    });

    return {
      cnp: r.cnp,
      designacao: r.designacao,
      categoria: cat.categoria,
      grupo: cat.grupo,
      farmaciaId: r.farmaciaId,
      farmacia: nomeById.get(r.farmaciaId) ?? "—",
      qtdVendida: qty,
      valorVendido,
      custoUnitarioBase,
      custoEstimado,
      margemEur,
      margemPct,
      coberturaCusto: cobertura,
      estado,
    };
  });

  // ── Agregações (Por Categoria, Por Farmácia, Por Grupo, Total) ──
  const porCategoria = aggregate(porProduto, (r) => r.categoria ?? "(sem categoria)");
  const porFarmacia = aggregate(porProduto, (r) => r.farmacia);
  const porGrupo = aggregate(porProduto, (r) => r.grupo ?? "(sem grupo)");
  const totals = aggregate(porProduto, () => "TOTAL");
  const totalRow = totals[0] ?? {
    key: "TOTAL",
    label: "TOTAL",
    qtdVendida: 0,
    valorVendido: 0,
    custoEstimado: 0,
    margemEur: 0,
    margemPct: null,
    coberturaCusto: 0,
    estado: "SEM_CUSTO" as EstadoMargem,
  };

  return {
    porProduto,
    porCategoria,
    porFarmacia,
    porGrupo,
    totals: {
      qtdVendida: totalRow.qtdVendida,
      valorVendido: totalRow.valorVendido,
      custoEstimado: totalRow.custoEstimado,
      margemEur: totalRow.margemEur,
      margemPct: totalRow.margemPct,
      coberturaCusto: totalRow.coberturaCusto,
      estado: totalRow.estado,
    },
  };
}

function emptyResult(): MargensResult {
  return {
    porProduto: [],
    porCategoria: [],
    porFarmacia: [],
    porGrupo: [],
    totals: {
      qtdVendida: 0,
      valorVendido: 0,
      custoEstimado: 0,
      margemEur: 0,
      margemPct: null,
      coberturaCusto: 0,
      estado: "SEM_CUSTO",
    },
  };
}

/**
 * Agregação ponderada por UNIDADES VENDIDAS:
 *   · cobertura = Σ(qty × cobertura) / Σ(qty)
 *   · margem €  = Σ(margem €) sobre as linhas com custo conhecido
 *   · margem %  = margem € / Σ(valor vendido das linhas com custo)
 *                 — só exibida se estado=FIAVEL no nível agregado
 */
function aggregate(
  rows: MargemRow[],
  keyOf: (r: MargemRow) => string,
): MargensAgg[] {
  type Acc = {
    key: string;
    qtdTotal: number;
    qtdComCusto: number;
    valorVendidoTotal: number;
    valorVendidoComCusto: number;
    custoEstimadoTotal: number;
    margemEurTotal: number;
  };
  const map = new Map<string, Acc>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!map.has(k)) {
      map.set(k, {
        key: k,
        qtdTotal: 0,
        qtdComCusto: 0,
        valorVendidoTotal: 0,
        valorVendidoComCusto: 0,
        custoEstimadoTotal: 0,
        margemEurTotal: 0,
      });
    }
    const acc = map.get(k)!;
    acc.qtdTotal += r.qtdVendida;
    acc.valorVendidoTotal += r.valorVendido;
    if (r.custoEstimado !== null && r.margemEur !== null) {
      acc.qtdComCusto += r.qtdVendida;
      acc.valorVendidoComCusto += r.valorVendido;
      acc.custoEstimadoTotal += r.custoEstimado;
      acc.margemEurTotal += r.margemEur;
    }
  }
  return Array.from(map.values()).map((acc) => {
    const cobertura = acc.qtdTotal > 0 ? acc.qtdComCusto / acc.qtdTotal : 0;
    const estado = classifyMargem(cobertura);
    const margemPct =
      estado === "FIAVEL" && acc.valorVendidoComCusto > 0
        ? Math.round((acc.margemEurTotal / acc.valorVendidoComCusto) * 10000) / 100
        : null;
    return {
      key: acc.key,
      label: acc.key,
      qtdVendida: Math.round(acc.qtdTotal),
      valorVendido: rounded2(acc.valorVendidoTotal),
      custoEstimado: rounded2(acc.custoEstimadoTotal),
      margemEur: rounded2(acc.margemEurTotal),
      margemPct,
      coberturaCusto: Math.round(cobertura * 10000) / 10000,
      estado,
    };
  }).sort((a, b) => a.label.localeCompare(b.label, "pt-PT"));
}

export const MARGEM_LABELS: Record<EstadoMargem, string> = {
  FIAVEL: "Fiável",
  PARCIAL: "Parcial",
  SEM_CUSTO: "Sem custo",
};
