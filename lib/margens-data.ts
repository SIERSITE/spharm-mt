/**
 * lib/margens-data.ts
 *
 * Read-model do relatório operacional de Margens.
 *
 * IVA — regra dura (introduzida 2026-06-01, escala corrigida 2026-06-01):
 *   · PVP/valorVendido vem da venda BRUTA (com IVA).
 *   · PMC/PUC em `ProdutoFarmacia` são SEM IVA.
 *   · Calcular `margem = (valorVendido / (1 + taxa/100)) − custo` para
 *     ficar no mesmo plano fiscal (ambos sem IVA).
 *   · Taxa vem de `StagingCompraRawLine.iva` (LATERAL JOIN à última
 *     compra) e é normalizada em {6, 13, 23} via `normalizeIva()`. O
 *     campo na staging está em fracção (0.06/0.13/0.23) — confirmado
 *     2026-06-01 em grupo-silveira (136 817 linhas).
 *   · Valores fora de {6,13,23} (incluindo 0.00 da staging) → taxa
 *     null, estado IVA_POR_APURAR (não inventamos taxa).
 *
 * Três níveis alimentados pelo MESMO universo agregado (produto×farm):
 *   1. Por produto   → 1 linha por (CNP × farmácia × período inteiro)
 *   2. Por categoria → agrega o Por Produto por categoria canónica
 *   3. Por farmácia  → agrega o Por Produto por farmácia
 *   4. Por grupo     → agrega o Por Produto por grupo homogéneo
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
 *   de linhas com custo conhecido E IVA conhecido.
 *
 * Regras duras (per spec):
 *   · Não inventar custo. PMC/PUC ausente → linha entra mas margem
 *     fica null e estado = SEM_CUSTO.
 *   · Não inventar IVA. Taxa ausente ou fora de {6,13,23} → margem €/%
 *     nulas e estado = IVA_POR_APURAR.
 *   · Margem % suprimida em estados PARCIAL, SEM_CUSTO e IVA_POR_APURAR.
 *   · Produtos sem custo/IVA aparecem como linha (não excluídos).
 */

import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolveCategoria } from "@/lib/categoria-resolver";
import { normalizeIva, type TaxaIvaCanonica } from "@/lib/iva";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

export type EstadoMargem = "FIAVEL" | "PARCIAL" | "SEM_CUSTO" | "IVA_POR_APURAR";

export type MargemRow = {
  cnp: number;
  designacao: string;
  categoria: string | null;
  grupo: string | null;
  farmaciaId: string;
  farmacia: string;
  qtdVendida: number;
  /** PVP × qty, com IVA (como vem do ERP). */
  valorVendido: number;
  /** PVP × qty / (1 + taxa/100). null quando taxa IVA desconhecida. */
  valorVendidoSemIva: number | null;
  /** Taxa IVA canónica de farmácia: 6 | 13 | 23 | null. */
  taxaIva: TaxaIvaCanonica | null;
  custoUnitarioBase: number | null; // PMC ou PUC snapshot actual, sem IVA
  custoEstimado: number | null;     // qty × custoUnitarioBase; null sem custo
  /** valorVendidoSemIva − custoEstimado. null se IVA ou custo ausente. */
  margemEur: number | null;
  margemPct: number | null;         // null fora de FIAVEL
  coberturaCusto: number;           // 0..1 — pondera por unidades vendidas
  estado: EstadoMargem;
};

export type MargensAgg = {
  key: string;
  label: string;
  qtdVendida: number;
  /** Soma valor vendido COM IVA. */
  valorVendido: number;
  /** Soma valor vendido SEM IVA (apenas linhas com IVA conhecido). */
  valorVendidoSemIva: number;
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
  /** KPIs globais sobre todas as linhas com custo + IVA conhecidos. */
  totals: {
    qtdVendida: number;
    valorVendido: number;        // com IVA
    valorVendidoSemIva: number;  // só linhas com IVA conhecido
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

/**
 * Cobertura aqui é "fracção das unidades vendidas com custo E IVA
 * conhecidos". SEM_IVA / SEM_CUSTO são estados extremos onde a margem
 * é matematicamente impossível de calcular sem inventar dados.
 */
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
      taxaIvaPercent: number | null;
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
      pf."puc"::text                AS puc,
      pf."taxaIvaPercent"           AS "taxaIvaPercent"
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
    const valorVendido = rounded2(toF(r.valor_bruto)); // com IVA
    const pmc = numOrNull(r.pmc);
    const puc = numOrNull(r.puc);
    const custoUnitarioBase =
      pmc !== null && pmc > 0 ? pmc : puc !== null && puc > 0 ? puc : null;
    // Taxa IVA persistida em ProdutoFarmacia.taxaIvaPercent pelo
    // pipeline de recuperação (lib/iva-recovery.ts). Valor já em
    // {6,13,23,null} — `normalizeIva()` aqui é defensivo contra
    // qualquer valor legacy fora do conjunto.
    const taxaIva = normalizeIva(r.taxaIvaPercent);
    const ivaOk = taxaIva !== null;
    const custoOk = custoUnitarioBase !== null;

    // Venda sem IVA — só faz sentido com taxa real.
    const valorVendidoSemIva = ivaOk
      ? rounded2(valorVendido / (1 + (taxaIva as number) / 100))
      : null;

    const custoEstimado = custoOk ? rounded2(qty * (custoUnitarioBase as number)) : null;

    // Margem só quando temos AMBOS: IVA conhecido (para descontar) +
    // custo conhecido. Caso contrário é não fiável — null e estado SEM_*.
    const margemEur =
      ivaOk && custoOk
        ? rounded2((valorVendidoSemIva as number) - (custoEstimado as number))
        : null;

    // Cobertura = mass-fracção de unidades onde podemos calcular. Aqui é
    // binária por linha; agregada vira fracção ponderada por unidades.
    const cobertura = ivaOk && custoOk ? 1 : 0;

    // Estado: IVA_POR_APURAR tem precedência. Depois SEM_CUSTO. Depois
    // cobertura (FIAVEL/PARCIAL/SEM_CUSTO).
    let estado: EstadoMargem;
    if (!ivaOk) estado = "IVA_POR_APURAR";
    else if (!custoOk) estado = "SEM_CUSTO";
    else estado = classifyMargem(cobertura);

    const margemPct =
      estado === "FIAVEL" &&
      valorVendidoSemIva !== null &&
      valorVendidoSemIva > 0 &&
      margemEur !== null
        ? Math.round((margemEur / valorVendidoSemIva) * 10000) / 100
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
      valorVendidoSemIva,
      taxaIva,
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
    valorVendidoSemIva: 0,
    custoEstimado: 0,
    margemEur: 0,
    margemPct: null,
    coberturaCusto: 0,
    estado: "IVA_POR_APURAR" as EstadoMargem,
  };

  return {
    porProduto,
    porCategoria,
    porFarmacia,
    porGrupo,
    totals: {
      qtdVendida: totalRow.qtdVendida,
      valorVendido: totalRow.valorVendido,
      valorVendidoSemIva: totalRow.valorVendidoSemIva,
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
      valorVendidoSemIva: 0,
      custoEstimado: 0,
      margemEur: 0,
      margemPct: null,
      coberturaCusto: 0,
      estado: "IVA_POR_APURAR",
    },
  };
}

/**
 * Agregação ponderada por UNIDADES VENDIDAS:
 *   · cobertura = Σ(qty fiável) / Σ(qty total)
 *   · margem €  = Σ(margem €) sobre linhas fiáveis (IVA + custo)
 *   · margem %  = margem € / Σ(valorSemIva fiável) — só se FIAVEL agregado
 *
 * Linha fiável = IVA conhecido AND custo conhecido. Linhas SEM_IVA ou
 * SEM_CUSTO entram no qty total (impactam cobertura) mas não no numerador
 * da margem (não inventamos).
 */
function aggregate(
  rows: MargemRow[],
  keyOf: (r: MargemRow) => string,
): MargensAgg[] {
  type Acc = {
    key: string;
    qtdTotal: number;
    qtdFiavel: number;
    valorVendidoTotal: number;        // com IVA (inclui linhas sem IVA)
    valorVendidoSemIvaTotal: number;  // só linhas com IVA conhecido
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
        qtdFiavel: 0,
        valorVendidoTotal: 0,
        valorVendidoSemIvaTotal: 0,
        custoEstimadoTotal: 0,
        margemEurTotal: 0,
      });
    }
    const acc = map.get(k)!;
    acc.qtdTotal += r.qtdVendida;
    acc.valorVendidoTotal += r.valorVendido;
    if (r.margemEur !== null && r.custoEstimado !== null && r.valorVendidoSemIva !== null) {
      acc.qtdFiavel += r.qtdVendida;
      acc.valorVendidoSemIvaTotal += r.valorVendidoSemIva;
      acc.custoEstimadoTotal += r.custoEstimado;
      acc.margemEurTotal += r.margemEur;
    }
  }
  return Array.from(map.values()).map((acc) => {
    const cobertura = acc.qtdTotal > 0 ? acc.qtdFiavel / acc.qtdTotal : 0;
    const estado: EstadoMargem =
      acc.qtdFiavel === 0
        ? // Sem qualquer linha fiável — pode ser falta de IVA, custo, ou
          // ambos. Usamos SEM_CUSTO como fallback executivo (cobre o caso
          // dominante quando o tenant ainda não tem stagging de compras).
          "SEM_CUSTO"
        : classifyMargem(cobertura);
    const margemPct =
      estado === "FIAVEL" && acc.valorVendidoSemIvaTotal > 0
        ? Math.round((acc.margemEurTotal / acc.valorVendidoSemIvaTotal) * 10000) / 100
        : null;
    return {
      key: acc.key,
      label: acc.key,
      qtdVendida: Math.round(acc.qtdTotal),
      valorVendido: rounded2(acc.valorVendidoTotal),
      valorVendidoSemIva: rounded2(acc.valorVendidoSemIvaTotal),
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
  IVA_POR_APURAR: "IVA por apurar",
};
