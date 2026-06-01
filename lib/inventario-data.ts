/**
 * lib/inventario-data.ts
 *
 * Read-model do relatório operacional de Inventário.
 *
 * IVA — regra dura (2026-06-01):
 *   · PMC/PUC em ProdutoFarmacia são SEM IVA. Logo valorStock (qty×PMC)
 *     é SEM IVA por construção.
 *   · Para exibir o valor "com IVA" precisamos da taxa real. Vem da
 *     última linha de StagingCompraRawLine por (farmaciaId, externalProductId).
 *   · Sem taxa conhecida → valorIva = null, valorStockComIva = null
 *     (NÃO inventamos taxa). A linha entra em "IVA desconhecido" na
 *     vista Por taxa IVA.
 *
 * Vistas (mesmo universo, alimentadas server-side):
 *   1. Por produto    → 1 linha por (CNP × farmácia)
 *   2. Por farmácia   → KPIs executivos por farmácia
 *   3. Por grupo      → KPIs executivos por grupo homogéneo
 *   4. Por taxa IVA   → bucket {6, 13, 23, desconhecido} (computado server-side)
 *
 * Fontes:
 *   · ProdutoFarmacia       (stockAtual, stockMinimo, pmc, puc, pvp, datas)
 *   · Produto               (cnp, designacao, classificacao*)
 *   · VendaMensal           (agregado últimos 90 dias para cobertura)
 *   · StagingCompraRawLine  (taxa IVA mais recente por produto)
 *
 * Estado canónico: NORMAL / ROTURA / EXCESSO / SEM_MOVIMENTO /
 *                   SEM_CUSTO / SEM_STOCK.
 *
 * Regras duras:
 *   · stockAtual=null  ≠  stockAtual=0
 *   · custo desconhecido  → valorStock null, estado SEM_CUSTO
 *   · taxa IVA desconhecida → valorIva null, valorStockComIva null
 *   · margem só em /relatorios/margens
 */

import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolveCategoria } from "@/lib/categoria-resolver";
import { normalizeIva, TAXA_IVA_BUCKETS, type TaxaIvaCanonica } from "@/lib/iva";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

export type EstadoInventario =
  | "NORMAL"
  | "ROTURA"
  | "EXCESSO"
  | "SEM_MOVIMENTO"
  | "SEM_CUSTO"
  | "SEM_STOCK";

export type InventarioRow = {
  cnp: number;
  designacao: string;
  categoria: string | null;
  grupo: string | null;
  farmaciaId: string;
  farmacia: string;
  /** null = ERP nunca enviou stock para este produto/farmácia. Distinto de 0. */
  stockAtual: number | null;
  stockMinimo: number | null;
  pmc: number | null;
  puc: number | null;
  pvp: number | null;
  /** PMC quando existe, PUC fallback. null se ambos faltarem. SEM IVA. */
  custoUnitario: number | null;
  /** Taxa IVA canónica de farmácia: 6 | 13 | 23 | null (IVA por apurar). */
  taxaIva: TaxaIvaCanonica | null;
  /** stockAtual × custoUnitario, SEM IVA. null se uma das peças faltar. */
  valorStock: number | null;
  /** valorStock × (taxa/100). null se valorStock ou taxa faltarem. */
  valorIva: number | null;
  /** valorStock + valorIva. null se taxa ou custo desconhecidos. */
  valorStockComIva: number | null;
  dataUltimaVenda: string | null;
  dataUltimaCompra: string | null;
  diasSemVenda: number | null;
  /** Total de unidades vendidas nos últimos 90 dias (per produto×farm). */
  vendas90d: number;
  /** vendas90d / 90 — média diária. 0 quando sem vendas. */
  vendaMediaDia90d: number;
  /** stockAtual / vendaMediaDia90d, em dias. null sem stock ou sem média. */
  coberturaDias: number | null;
  estado: EstadoInventario;
};

export type InventarioPorFarmaciaRow = {
  farmaciaId: string;
  farmacia: string;
  numProdutos: number;
  /** Soma stockAtual ignorando null. */
  stockTotal: number;
  /** Soma valorStock (s/ IVA) ignorando null. */
  valorStockSemIva: number;
  /** Soma valorIva ignorando null. */
  valorIva: number;
  /** Soma valorStockComIva ignorando null. */
  valorStockComIva: number;
  /** Contagens por estado canónico. */
  rotura: number;
  excesso: number;
  semMovimento: number;
  semCusto: number;
  semStock: number;
  normal: number;
};

/**
 * Vista executiva por Grupo Homogéneo (resolveCategoria → grupo).
 * Linhas sem grupo resolvido vão para "(sem grupo)".
 */
export type InventarioPorGrupoRow = {
  key: string;
  grupo: string;
  numProdutos: number;
  stockTotal: number;
  valorStockSemIva: number;
  valorIva: number;
  valorStockComIva: number;
  rotura: number;
  excesso: number;
  semMovimento: number;
  semCusto: number;
  semStock: number;
  normal: number;
};

/**
 * Vista executiva por taxa IVA. Buckets canónicos PT (farmácia):
 * 6, 13, 23 e "IVA por apurar". Não há "Isento", "Outras taxas" ou
 * "Desconhecido" — produtos sem taxa canónica capturada vão todos
 * para "IVA por apurar". Não inventamos taxa.
 */
export type InventarioPorIvaRow = {
  key: "6" | "13" | "23" | "APURAR";
  label: string;          // "IVA 6%" | "IVA 13%" | "IVA 23%" | "IVA por apurar"
  numProdutos: number;
  stockTotal: number;
  valorStockSemIva: number;
  valorIva: number;
  valorStockComIva: number;
};

export type InventarioResult = {
  porProduto: InventarioRow[];
  porFarmacia: InventarioPorFarmaciaRow[];
  porGrupo: InventarioPorGrupoRow[];
  porIva: InventarioPorIvaRow[];
};

const SEM_MOV_DAYS = 180;
const EXCESSO_DAYS = 180;
const VENDAS_WINDOW_DAYS = 90;

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function classifyEstado(args: {
  custoUnitario: number | null;
  stockAtual: number | null;
  stockMinimo: number | null;
  diasSemVenda: number | null;
  coberturaDias: number | null;
}): EstadoInventario {
  const { custoUnitario, stockAtual, stockMinimo, diasSemVenda, coberturaDias } = args;
  // Ordem importa — ver comment block no topo.
  if (custoUnitario === null) return "SEM_CUSTO";
  if (stockAtual === 0) return "SEM_STOCK";
  if (stockAtual === null) return "SEM_MOVIMENTO";
  if (stockMinimo !== null && stockMinimo > 0 && stockAtual <= stockMinimo) return "ROTURA";
  if (diasSemVenda !== null && diasSemVenda > SEM_MOV_DAYS) return "SEM_MOVIMENTO";
  if (coberturaDias !== null && coberturaDias > EXCESSO_DAYS) return "EXCESSO";
  return "NORMAL";
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
 * Carrega o universo de Inventário e produz as duas vistas. Os filtros
 * canónicos (categorias/fabricantes/distribuidores/pesquisa/apenasSemClassif)
 * são aplicados no SQL/Prisma para não trazer linhas inúteis em payload.
 */
export async function getInventarioData(
  filters: SharedReportFilters = {},
): Promise<InventarioResult> {
  const prisma = await getPrisma();
  const { ids: farmaciaIds, nomeById } = await resolveFarmacias(prisma, filters.farmaciaNomes);
  if (farmaciaIds.length === 0) {
    return { porProduto: [], porFarmacia: [], porGrupo: [], porIva: [] };
  }

  // ── Filtro de produto via categoria canónica (NIVEL_1) ──────────
  // Quando o utilizador escolhe categorias, restringimos cedo via
  // produtoId IN (...) para encolher o universo Recepcao/ProdutoFarmacia.
  let produtoIdFilter: string[] | null = null;
  if (filters.categorias && filters.categorias.length > 0) {
    const classifs = await prisma.classificacao.findMany({
      where: { tipo: "NIVEL_1", estado: "ATIVO", nome: { in: filters.categorias } },
      select: { id: true },
    });
    const classifIds = classifs.map((c) => c.id);
    if (classifIds.length === 0) return { porProduto: [], porFarmacia: [], porGrupo: [], porIva: [] };
    const produtos = await prisma.produto.findMany({
      where: { classificacaoNivel1Id: { in: classifIds } },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return { porProduto: [], porFarmacia: [], porGrupo: [], porIva: [] };
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
    if (produtoIdFilter.length === 0) return { porProduto: [], porFarmacia: [], porGrupo: [], porIva: [] };
  }
  if (filters.fabricantes && filters.fabricantes.length > 0) {
    const fabs = await prisma.fabricante.findMany({
      where: { nomeNormalizado: { in: filters.fabricantes }, estado: "ATIVO" },
      select: { id: true },
    });
    const fabIds = fabs.map((f) => f.id);
    if (fabIds.length === 0) return { porProduto: [], porFarmacia: [], porGrupo: [], porIva: [] };
    const produtos = await prisma.produto.findMany({
      where: {
        fabricanteId: { in: fabIds },
        ...(produtoIdFilter ? { id: { in: produtoIdFilter } } : {}),
      },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return { porProduto: [], porFarmacia: [], porGrupo: [], porIva: [] };
  }

  // ── CTE de vendas dos últimos 90 dias agrupada por produto×farm ──
  // VendaMensal é (ano,mes) — convertemos a janela de 90d para "últimos
  // 3 meses calendar" via comparação (ano*12 + mes) >= now − 3.
  const now = new Date();
  const monthIdx = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);
  const minMonthIdx = monthIdx - 3;

  // ── Query principal: ProdutoFarmacia + Produto + vendas 90d ──
  //
  // Filtro de distribuidor é aplicado directamente em pf.fornecedorOrigem
  // porque é texto livre do ERP (não há lookup table).
  const distrCond =
    filters.distribuidores && filters.distribuidores.length > 0
      ? Prisma.sql`AND pf."fornecedorOrigem" = ANY(${filters.distribuidores})`
      : Prisma.empty;
  const prodIdCond = produtoIdFilter
    ? Prisma.sql`AND pf."produtoId" = ANY(${produtoIdFilter})`
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
      stockAtual: string | null;
      stockMinimo: string | null;
      pmc: string | null;
      puc: string | null;
      pvp: string | null;
      dataUltimaVenda: Date | null;
      dataUltimaCompra: Date | null;
      qty90d: string;
      taxaIvaPercent: number | null;
    }>
  >(Prisma.sql`
    WITH vendas_90d AS (
      SELECT
        vm."produtoId",
        vm."farmaciaId",
        SUM(vm."quantidade")::numeric AS qty_90d
      FROM "VendaMensal" vm
      WHERE vm."farmaciaId" = ANY(${farmaciaIds})
        AND (vm."ano" * 12 + vm."mes") >= ${minMonthIdx}
      GROUP BY 1, 2
    )
    SELECT
      p."cnp"                 AS cnp,
      p."designacao"          AS designacao,
      p."classificacaoNivel1Id",
      p."classificacaoNivel2Id",
      pf."farmaciaId"         AS "farmaciaId",
      pf."categoriaOrigem",
      pf."subcategoriaOrigem",
      pf."stockAtual"::text   AS "stockAtual",
      pf."stockMinimo"::text  AS "stockMinimo",
      pf."pmc"::text          AS pmc,
      pf."puc"::text          AS puc,
      pf."pvp"::text          AS pvp,
      pf."dataUltimaVenda",
      pf."dataUltimaCompra",
      COALESCE(v.qty_90d, 0)::text AS "qty90d",
      pf."taxaIvaPercent"          AS "taxaIvaPercent"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto" p ON p.id = pf."produtoId"
    LEFT JOIN vendas_90d v
      ON v."produtoId" = pf."produtoId" AND v."farmaciaId" = pf."farmaciaId"
    WHERE pf."flagRetirado" = false
      AND pf."farmaciaId" = ANY(${farmaciaIds})
      ${distrCond}
      ${prodIdCond}
      ${pesquisaCond}
    ORDER BY p."designacao" ASC
  `);

  // ── Pre-load das classificações para resolveCategoria ───────────
  // Evita N queries — buscamos só os ids únicos encontrados.
  const classifIdSet = new Set<string>();
  for (const r of rows) {
    if (r.classificacaoNivel1Id) classifIdSet.add(r.classificacaoNivel1Id);
    if (r.classificacaoNivel2Id) classifIdSet.add(r.classificacaoNivel2Id);
  }
  const classifMap = new Map<string, string>();
  if (classifIdSet.size > 0) {
    const classifs = await prisma.classificacao.findMany({
      where: { id: { in: Array.from(classifIdSet) } },
      select: { id: true, nome: true },
    });
    for (const c of classifs) classifMap.set(c.id, c.nome);
  }

  // ── Compor as linhas finais + classificar estado ────────────────
  const porProduto: InventarioRow[] = rows.map((r) => {
    const stockAtual = numOrNull(r.stockAtual);
    const stockMinimo = numOrNull(r.stockMinimo);
    const pmc = numOrNull(r.pmc);
    const puc = numOrNull(r.puc);
    const pvp = numOrNull(r.pvp);
    const custoUnitario = pmc !== null && pmc > 0 ? pmc : puc !== null && puc > 0 ? puc : null;
    const valorStock =
      custoUnitario !== null && stockAtual !== null
        ? Math.round(stockAtual * custoUnitario * 100) / 100
        : null;

    // Taxa IVA persistida em ProdutoFarmacia.taxaIvaPercent (já
    // normalizada para {6,13,23} pelo recuperador / endpoint products).
    // Fora deste conjunto vai como null e a linha vira "IVA por apurar".
    const taxaIva = normalizeIva(r.taxaIvaPercent);
    const valorIva =
      valorStock !== null && taxaIva !== null
        ? Math.round(valorStock * (taxaIva / 100) * 100) / 100
        : null;
    const valorStockComIva =
      valorStock !== null && valorIva !== null
        ? Math.round((valorStock + valorIva) * 100) / 100
        : null;

    const qty90d = toF(r.qty90d);
    const vendaMediaDia90d = qty90d / VENDAS_WINDOW_DAYS;
    const coberturaDias =
      stockAtual !== null && vendaMediaDia90d > 0
        ? Math.round(stockAtual / vendaMediaDia90d)
        : null;
    const diasSemVenda = r.dataUltimaVenda
      ? Math.floor((Date.now() - r.dataUltimaVenda.getTime()) / 86_400_000)
      : null;

    const estado = classifyEstado({
      custoUnitario,
      stockAtual,
      stockMinimo,
      diasSemVenda,
      coberturaDias,
    });

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
      stockAtual,
      stockMinimo,
      pmc,
      puc,
      pvp,
      custoUnitario,
      taxaIva,
      valorStock,
      valorIva,
      valorStockComIva,
      dataUltimaVenda: r.dataUltimaVenda ? r.dataUltimaVenda.toISOString() : null,
      dataUltimaCompra: r.dataUltimaCompra ? r.dataUltimaCompra.toISOString() : null,
      diasSemVenda,
      vendas90d: qty90d,
      vendaMediaDia90d,
      coberturaDias,
      estado,
    };
  });

  // ── Vista executiva: KPIs por farmácia, sobre o MESMO dataset ──
  const byFarm = new Map<string, InventarioPorFarmaciaRow>();
  for (const id of farmaciaIds) {
    byFarm.set(id, {
      farmaciaId: id,
      farmacia: nomeById.get(id) ?? "—",
      numProdutos: 0,
      stockTotal: 0,
      valorStockSemIva: 0,
      valorIva: 0,
      valorStockComIva: 0,
      rotura: 0,
      excesso: 0,
      semMovimento: 0,
      semCusto: 0,
      semStock: 0,
      normal: 0,
    });
  }
  for (const r of porProduto) {
    const k = byFarm.get(r.farmaciaId);
    if (!k) continue;
    k.numProdutos++;
    if (r.stockAtual !== null) k.stockTotal += r.stockAtual;
    if (r.valorStock !== null) k.valorStockSemIva += r.valorStock;
    if (r.valorIva !== null) k.valorIva += r.valorIva;
    if (r.valorStockComIva !== null) k.valorStockComIva += r.valorStockComIva;
    switch (r.estado) {
      case "ROTURA":
        k.rotura++;
        break;
      case "EXCESSO":
        k.excesso++;
        break;
      case "SEM_MOVIMENTO":
        k.semMovimento++;
        break;
      case "SEM_CUSTO":
        k.semCusto++;
        break;
      case "SEM_STOCK":
        k.semStock++;
        break;
      case "NORMAL":
        k.normal++;
        break;
    }
  }
  const porFarmacia = Array.from(byFarm.values())
    .map((k) => ({
      ...k,
      stockTotal: Math.round(k.stockTotal),
      valorStockSemIva: Math.round(k.valorStockSemIva * 100) / 100,
      valorIva: Math.round(k.valorIva * 100) / 100,
      valorStockComIva: Math.round(k.valorStockComIva * 100) / 100,
    }))
    .sort((a, b) => a.farmacia.localeCompare(b.farmacia, "pt-PT"));

  // ── Vista executiva por Grupo Homogéneo ─────────────────────────
  const byGrupo = new Map<string, InventarioPorGrupoRow>();
  for (const r of porProduto) {
    const key = r.grupo ?? "(sem grupo)";
    if (!byGrupo.has(key)) {
      byGrupo.set(key, {
        key,
        grupo: key,
        numProdutos: 0,
        stockTotal: 0,
        valorStockSemIva: 0,
        valorIva: 0,
        valorStockComIva: 0,
        rotura: 0,
        excesso: 0,
        semMovimento: 0,
        semCusto: 0,
        semStock: 0,
        normal: 0,
      });
    }
    const g = byGrupo.get(key)!;
    g.numProdutos++;
    if (r.stockAtual !== null) g.stockTotal += r.stockAtual;
    if (r.valorStock !== null) g.valorStockSemIva += r.valorStock;
    if (r.valorIva !== null) g.valorIva += r.valorIva;
    if (r.valorStockComIva !== null) g.valorStockComIva += r.valorStockComIva;
    switch (r.estado) {
      case "ROTURA": g.rotura++; break;
      case "EXCESSO": g.excesso++; break;
      case "SEM_MOVIMENTO": g.semMovimento++; break;
      case "SEM_CUSTO": g.semCusto++; break;
      case "SEM_STOCK": g.semStock++; break;
      case "NORMAL": g.normal++; break;
    }
  }
  const porGrupo = Array.from(byGrupo.values())
    .map((g) => ({
      ...g,
      stockTotal: Math.round(g.stockTotal),
      valorStockSemIva: Math.round(g.valorStockSemIva * 100) / 100,
      valorIva: Math.round(g.valorIva * 100) / 100,
      valorStockComIva: Math.round(g.valorStockComIva * 100) / 100,
    }))
    .sort((a, b) => a.grupo.localeCompare(b.grupo, "pt-PT"));

  // ── Vista executiva por taxa IVA ─────────────────────────────────
  const porIva = aggregatePorIva(porProduto);

  return { porProduto, porFarmacia, porGrupo, porIva };
}

/**
 * Agrega rows nos 4 buckets canónicos de farmácia: 6, 13, 23 e
 * "IVA por apurar". `r.taxaIva` já vem normalizado de normalizeIva()
 * em `{6 | 13 | 23 | null}`, logo aqui é só dispatch directo.
 */
function aggregatePorIva(rows: InventarioRow[]): InventarioPorIvaRow[] {
  const buckets: Record<"6" | "13" | "23" | "APURAR", InventarioPorIvaRow> = {
    "6": emptyIvaBucket("6", "IVA 6%"),
    "13": emptyIvaBucket("13", "IVA 13%"),
    "23": emptyIvaBucket("23", "IVA 23%"),
    APURAR: emptyIvaBucket("APURAR", "IVA por apurar"),
  };
  for (const r of rows) {
    const k: "6" | "13" | "23" | "APURAR" =
      r.taxaIva === 6
        ? "6"
        : r.taxaIva === 13
          ? "13"
          : r.taxaIva === 23
            ? "23"
            : "APURAR";
    const b = buckets[k];
    b.numProdutos++;
    if (r.stockAtual !== null) b.stockTotal += r.stockAtual;
    if (r.valorStock !== null) b.valorStockSemIva += r.valorStock;
    if (r.valorIva !== null) b.valorIva += r.valorIva;
    if (r.valorStockComIva !== null) b.valorStockComIva += r.valorStockComIva;
  }
  // Mantém a ordem canónica de TAXA_IVA_BUCKETS e omite buckets vazios
  // para não poluir relatórios de tenants que só usam 6%+23%.
  return TAXA_IVA_BUCKETS
    .map((meta) => buckets[meta.key])
    .filter((b) => b.numProdutos > 0)
    .map((b) => ({
      ...b,
      stockTotal: Math.round(b.stockTotal),
      valorStockSemIva: Math.round(b.valorStockSemIva * 100) / 100,
      valorIva: Math.round(b.valorIva * 100) / 100,
      valorStockComIva: Math.round(b.valorStockComIva * 100) / 100,
    }));
}

function emptyIvaBucket(
  key: "6" | "13" | "23" | "APURAR",
  label: string,
): InventarioPorIvaRow {
  return {
    key,
    label,
    numProdutos: 0,
    stockTotal: 0,
    valorStockSemIva: 0,
    valorIva: 0,
    valorStockComIva: 0,
  };
}

export const ESTADO_LABELS: Record<EstadoInventario, string> = {
  NORMAL: "Normal",
  ROTURA: "Rotura",
  EXCESSO: "Excesso",
  SEM_MOVIMENTO: "Sem movimento",
  SEM_CUSTO: "Sem custo",
  SEM_STOCK: "Sem stock",
};
