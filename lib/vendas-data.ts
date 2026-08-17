/**
 * lib/vendas-data.ts
 * Server-side data fetching para a página Vendas.
 *
 * ─── FECHO 2026-06: período dinâmico ─────────────────────────────────────────
 *
 * Removido o pivot fixo Jan/Fev/Mar/Abr 2026. A query agora pivota dinamicamente
 * sobre a janela `[from, to]` recebida nos filtros (mesmo padrão de
 * `lib/margens-data.ts`). A saída inclui um array `meses` por linha, com tantos
 * elementos quantos meses houver no período — a UI renderiza N colunas.
 *
 * Filtros suportados (canónicos via `SharedReportFilters`):
 *   farmaciaNomes, from, to, categorias, fabricantes, distribuidores, pesquisa,
 *   apenasSemClassif.
 *
 * Default temporal: início do ano corrente → mês corrente (igual a Margens).
 *
 * Pré-filtros de produto (categorias / fabricantes / distribuidores / pesquisa /
 * semClassif) correm SQL-side antes do pivot — mesma estratégia de Margens
 * para não puxar produtos que vão ser descartados a seguir.
 */
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { resolverPar } from "@/lib/categoria-resolver";
import { restringirPorCatalogo, temFiltroCatalogo } from "@/lib/reporting/catalog-prefilter";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

/** Linha por (CNP × farmácia) com vendas decompostas por mês no período. */
export type SalesMonthBucket = {
  /** Ano calendário (ex: 2026). */
  ano: number;
  /** Mês 1-12. */
  mes: number;
  /** Unidades vendidas no mês (já arredondado a inteiro). */
  quantidade: number;
};

export type SalesReportRow = {
  codigo: string;
  descricao: string;
  pvp: number;
  /** Buckets mês-a-mês na ordem cronológica do período seleccionado. */
  meses: SalesMonthBucket[];
  /** Soma das `meses[].quantidade`. */
  totalVendas: number;
  existencia: number;
  /** Alias legado de totalVendas — preservado para callers existentes. */
  unidadesVendidas: number;
  fornecedor: string;
  fabricante: string;
  /** Nível 1 canónico, ou "Por Classificar". */
  categoria: string;
  /** Nível 2 canónico estrito, ou "" — é o que o filtro usa. */
  subcategoria: string;
  /** Slugs das utilizações do produto. */
  utilizacoes: string[];
  farmacia: string;
  /**
   * Chave de agregação "Agrupar por: grupo". N2 com queda para N1 —
   * semântica antiga, preservada de propósito. Para FILTRAR use
   * `subcategoria`.
   */
  grupo: string;
};

/**
 * Header do período devolvido junto com as linhas — permite à UI e ao
 * adapter de exportação saberem **quais** meses esperar em cada `row.meses`,
 * sem precisarem de inferir a partir das datas.
 */
export type SalesPeriodHeader = {
  /** Início efectivo aplicado (ISO yyyy-mm-dd). */
  from: string;
  /** Fim efectivo aplicado (ISO yyyy-mm-dd, último dia do mês `toMes`). */
  to: string;
  /** Lista de buckets na mesma ordem que aparece em `row.meses`. */
  buckets: { ano: number; mes: number }[];
};

export type SalesReportResult = {
  period: SalesPeriodHeader;
  rows: SalesReportRow[];
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Converte ISO yyyy-mm-dd para índice `ano*12 + mes` (mesma fórmula que
 * `lib/margens-data.ts:ymToIndex` — mantida em paralelo para evitar acoplar
 * Vendas a um helper específico de Margens).
 */
function ymToIndex(iso: string | undefined, fallback: { y: number; m: number }): number {
  if (iso) {
    const m = /^(\d{4})-(\d{2})/.exec(iso);
    if (m) return parseInt(m[1], 10) * 12 + parseInt(m[2], 10);
  }
  return fallback.y * 12 + fallback.m;
}

function indexToYM(idx: number): { ano: number; mes: number } {
  const ano = Math.floor((idx - 1) / 12);
  const mes = ((idx - 1) % 12) + 1;
  return { ano, mes };
}

function lastDayOfMonthIso(ano: number, mes: number): string {
  // Dia 0 do mês seguinte = último dia do mês actual. UTC para evitar TZ.
  const d = new Date(Date.UTC(ano, mes, 0));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export async function getVendasData(
  filters: SharedReportFilters = {}
): Promise<SalesReportResult> {
  const prisma = await getPrisma();

  // ── Período: default = início do ano corrente → mês corrente ────────
  const now = new Date();
  const defFrom = { y: now.getUTCFullYear(), m: 1 };
  const defTo = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 };
  const minIdx = ymToIndex(filters.from, defFrom);
  const maxIdx = ymToIndex(filters.to, defTo);

  // Lista canónica de buckets mês-a-mês — fonte única para UI + adapter.
  const buckets: { ano: number; mes: number }[] = [];
  if (maxIdx >= minIdx) {
    for (let i = minIdx; i <= maxIdx; i++) {
      buckets.push(indexToYM(i));
    }
  }
  const periodFrom = buckets[0]
    ? `${buckets[0].ano}-${String(buckets[0].mes).padStart(2, "0")}-01`
    : `${defFrom.y}-01-01`;
  const periodTo = buckets[buckets.length - 1]
    ? lastDayOfMonthIso(
        buckets[buckets.length - 1].ano,
        buckets[buckets.length - 1].mes,
      )
    : lastDayOfMonthIso(defTo.y, defTo.m);
  const period: SalesPeriodHeader = { from: periodFrom, to: periodTo, buckets };

  if (buckets.length === 0) {
    return { period, rows: [] };
  }

  // ── Farmácias activas (filtradas cedo pelos nomes pedidos) ──────────
  const farmacias = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: {
        not: "Farmácia Teste",
        ...(filters.farmaciaNomes && filters.farmaciaNomes.length > 0
          ? { in: filters.farmaciaNomes }
          : {}),
      },
    },
    select: { id: true, nome: true },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  const farmaciaNameById = new Map(farmacias.map((f) => [f.id, f.nome]));
  if (farmaciaIds.length === 0) return { period, rows: [] };

  // ── Pré-filtros de produto (categorias / fabricantes / semClassif /
  //    pesquisa). Mesmo padrão de lib/margens-data.ts:189-232. Encolhe
  //    o universo antes do pivot pesado em VendaMensal.
  let produtoIdFilter: string[] | null = null;
  if (filters.categorias && filters.categorias.length > 0) {
    const classifs = await prisma.classificacao.findMany({
      where: { tipo: "NIVEL_1", estado: "ATIVO", nome: { in: filters.categorias } },
      select: { id: true },
    });
    const classifIds = classifs.map((c) => c.id);
    if (classifIds.length === 0) return { period, rows: [] };
    const produtos = await prisma.produto.findMany({
      where: { classificacaoNivel1Id: { in: classifIds } },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return { period, rows: [] };
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
    if (produtoIdFilter.length === 0) return { period, rows: [] };
  }
  if (filters.fabricantes && filters.fabricantes.length > 0) {
    const fabs = await prisma.fabricante.findMany({
      where: { nomeNormalizado: { in: filters.fabricantes }, estado: "ATIVO" },
      select: { id: true },
    });
    const fabIds = fabs.map((f) => f.id);
    if (fabIds.length === 0) return { period, rows: [] };
    const produtos = await prisma.produto.findMany({
      where: {
        fabricanteId: { in: fabIds },
        ...(produtoIdFilter ? { id: { in: produtoIdFilter } } : {}),
      },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return { period, rows: [] };
  }
  // Subcategoria (N2) e utilização — mesmo padrão, helper partilhado.
  if (temFiltroCatalogo(filters)) {
    produtoIdFilter = await restringirPorCatalogo(prisma, filters, produtoIdFilter);
    if (produtoIdFilter && produtoIdFilter.length === 0) return { period, rows: [] };
  }
  // Pesquisa (CNP exacto ou ILIKE designação) também pré-filtra o universo.
  if (filters.pesquisa && filters.pesquisa.trim()) {
    const q = filters.pesquisa.trim();
    const asNumber = Number(q);
    const produtos = await prisma.produto.findMany({
      where: {
        ...(Number.isFinite(asNumber) && Number.isInteger(asNumber)
          ? { OR: [{ cnp: asNumber }, { designacao: { contains: q, mode: "insensitive" } }] }
          : { designacao: { contains: q, mode: "insensitive" } }),
        ...(produtoIdFilter ? { id: { in: produtoIdFilter } } : {}),
      },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return { period, rows: [] };
  }
  // Distribuidor (fornecedorOrigem em PF) — corre via filtro em PF mais
  // abaixo (não pré-encolhe Produto, porque mesmo produto pode ter
  // distribuidor diferente por farmácia).

  // ── Query principal: SUM dinâmico por (produtoId, farmaciaId, ano, mes)
  //    no período `[minIdx, maxIdx]`. O pivot final é feito em memória —
  //    `buckets` define a ordem das colunas no output. SQL devolve só as
  //    linhas com pelo menos 1 venda no período (filtra noise).
  type AggRow = {
    produtoId: string;
    farmaciaId: string;
    ano: number;
    mes: number;
    quantidade: number;
  };
  const prodIdCond = produtoIdFilter
    ? Prisma.sql`AND vm."produtoId" = ANY(${produtoIdFilter})`
    : Prisma.empty;
  const aggRows = await prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      vm."produtoId",
      vm."farmaciaId",
      vm.ano,
      vm.mes,
      SUM(vm.quantidade)::float AS quantidade
    FROM "VendaMensal" vm
    WHERE
      vm."farmaciaId" = ANY(${farmaciaIds})
      AND (vm.ano * 12 + vm.mes) BETWEEN ${minIdx} AND ${maxIdx}
      ${prodIdCond}
    GROUP BY vm."produtoId", vm."farmaciaId", vm.ano, vm.mes
    HAVING SUM(vm.quantidade) > 0
  `);

  if (aggRows.length === 0) return { period, rows: [] };

  // ── Agrupa por (produtoId, farmaciaId) e indexa cada mês ──────────
  type Acc = {
    produtoId: string;
    farmaciaId: string;
    byBucket: Map<string, number>;
    total: number;
  };
  const bucketKey = (ano: number, mes: number) => `${ano}-${mes}`;
  const accByKey = new Map<string, Acc>();
  for (const r of aggRows) {
    const key = `${r.produtoId}:${r.farmaciaId}`;
    let acc = accByKey.get(key);
    if (!acc) {
      acc = {
        produtoId: r.produtoId,
        farmaciaId: r.farmaciaId,
        byBucket: new Map(),
        total: 0,
      };
      accByKey.set(key, acc);
    }
    const q = Math.round(toF(r.quantidade));
    acc.byBucket.set(bucketKey(r.ano, r.mes), q);
    acc.total += q;
  }

  // ── Metadata do produto (canónica) + ProdutoFarmacia (PVP/stock/origem)
  const produtoIds = [...new Set(Array.from(accByKey.values()).map((a) => a.produtoId))];
  const produtos = await prisma.produto.findMany({
    where: { id: { in: produtoIds } },
    select: {
      id: true,
      cnp: true,
      designacao: true,
      fabricante: { select: { nomeNormalizado: true } },
      classificacaoNivel1: { select: { nome: true } },
      classificacaoNivel2: { select: { nome: true } },
      // Uma ida à base para os produtos todos — não uma por produto.
      utilizacoes: { select: { utilizacao: { select: { slug: true } } } },
    },
  });
  const produtoById = new Map(produtos.map((p) => [p.id, p]));

  const pfWhere: Prisma.ProdutoFarmaciaWhereInput = {
    produtoId: { in: produtoIds },
    farmaciaId: { in: farmaciaIds },
  };
  if (filters.distribuidores && filters.distribuidores.length > 0) {
    pfWhere.fornecedorOrigem = { in: filters.distribuidores };
  }
  const pfRecords = await prisma.produtoFarmacia.findMany({
    where: pfWhere,
    select: {
      produtoId: true,
      farmaciaId: true,
      stockAtual: true,
      pvp: true,
      pmc: true,
      categoriaOrigem: true,
      subcategoriaOrigem: true,
      fornecedorOrigem: true,
    },
  });
  const pfByKey = new Map(pfRecords.map((r) => [`${r.produtoId}:${r.farmaciaId}`, r]));

  // Quando há filtro de distribuidor, descarta acc cujos pares
  // (produto, farmácia) não estão em pfByKey (i.e., não correspondem ao
  // distribuidor seleccionado naquela farmácia).
  const distribuidorFilterActive =
    !!filters.distribuidores && filters.distribuidores.length > 0;

  const rows: SalesReportRow[] = [];
  for (const acc of accByKey.values()) {
    const produto = produtoById.get(acc.produtoId);
    if (!produto) continue;
    const pf = pfByKey.get(`${acc.produtoId}:${acc.farmaciaId}`);
    if (distribuidorFilterActive && !pf) continue;
    const farmaciaNome = farmaciaNameById.get(acc.farmaciaId) ?? "—";

    const meses: SalesMonthBucket[] = buckets.map((b) => ({
      ano: b.ano,
      mes: b.mes,
      quantidade: acc.byBucket.get(bucketKey(b.ano, b.mes)) ?? 0,
    }));
    const totalVendas = meses.reduce((s, m) => s + m.quantidade, 0);

    const pvp = toF(pf?.pvp ?? pf?.pmc ?? 0);
    const existencia = Math.round(toF(pf?.stockAtual ?? 0));

    const { categoria, subcategoria } = resolverPar({
      classificacaoNivel1: produto.classificacaoNivel1,
      classificacaoNivel2: produto.classificacaoNivel2,
    });
    // `grupo` mantém a semântica antiga (N2 com queda para N1) porque é a
    // chave de agregação "Agrupar por: grupo" — mudá-la mudava relatórios
    // que já circulam. `subcategoria` é o nível 2 estrito, para filtrar.
    const grupo = subcategoria || categoria;
    const fornecedor = pf?.fornecedorOrigem ?? "";
    const fabricante = produto.fabricante?.nomeNormalizado ?? "";

    rows.push({
      codigo: String(produto.cnp),
      descricao: produto.designacao,
      pvp,
      meses,
      totalVendas,
      existencia,
      unidadesVendidas: totalVendas,
      fornecedor,
      fabricante,
      categoria,
      subcategoria,
      utilizacoes: produto.utilizacoes.map((u) => u.utilizacao.slug),
      farmacia: farmaciaNome,
      grupo,
    });
  }

  // Ordenação default: mais vendidos primeiro. UI pode reordenar.
  rows.sort((a, b) => b.totalVendas - a.totalVendas);
  return { period, rows };
}
