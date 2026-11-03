/**
 * lib/classificacao/etico-nett-sql.ts
 *
 * O lado SQL/servidor da classificação Ético/NETT: consolidação por produto, ids para filtrar (ANTES de paginação,
 * cortes e totais), contagens das opções e leitura por produto para a ficha.
 *
 * Consolidação (a mesma de `consolidarEticoNett`, em SQL): entre as farmácias EM ÂMBITO com informação —
 *   0 -> SEM · 1 categoria (mesmo que em várias farmácias) -> essa · 2 categorias -> DIVERGENTE.
 * Nunca «a última farmácia a sincronizar ganha». Sem `farmaciaIds` o âmbito é o tenant inteiro (cada tenant tem a
 * sua base — o `prisma` recebido já é o dele).
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  consolidarEticoNett,
  lerValoresFiltroEticoNett,
  type CategoriaEticoNett,
  type EstadoConsolidado,
  type ValorFiltroEticoNett,
} from "@/lib/classificacao/etico-nett";

function sqlAgregado(farmaciaIds: readonly string[] | null | undefined): Prisma.Sql {
  const ambito = farmaciaIds && farmaciaIds.length > 0 ? Prisma.sql`AND pf."farmaciaId" = ANY(${[...farmaciaIds]}::text[])` : Prisma.empty;
  return Prisma.sql`SELECT pf."produtoId", count(DISTINCT pf."eticoNett") AS n, min(pf."eticoNett"::text) AS c
      FROM "ProdutoFarmacia" pf
     WHERE pf."eticoNett" IS NOT NULL ${ambito}
     GROUP BY pf."produtoId"`;
}

/**
 * Ids de produto cujo estado consolidado pertence a `valores` (opcionalmente dentro de `dentroDe`). UMA consulta.
 * Sem valores -> `dentroDe` inalterado (sem restrição). Lista vazia = nenhum produto.
 */
export async function idsProdutosPorEticoNett(
  prisma: PrismaClient,
  valores: readonly string[] | undefined | null,
  dentroDe: string[] | null,
  farmaciaIds?: readonly string[] | null,
): Promise<string[] | null> {
  const lista = lerValoresFiltroEticoNett(valores ?? []);
  if (lista.length === 0) return dentroDe;
  if (dentroDe && dentroDe.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT p.id
      FROM "Produto" p
      LEFT JOIN (${sqlAgregado(farmaciaIds)}) a ON a."produtoId" = p.id
     WHERE (CASE WHEN a.n IS NULL THEN 'SEM' WHEN a.n > 1 THEN 'DIVERGENTE' ELSE a.c END) = ANY(${lista}::text[])
       ${dentroDe ? Prisma.sql`AND p.id = ANY(${dentroDe}::text[])` : Prisma.empty}
  `);
  return rows.map((r) => r.id);
}

/**
 * Para consumidores que filtram com o query builder do Prisma (Catálogo): `{ id: { in } }` ou `null` (= sem restrição).
 */
export async function wherePrismaPorEticoNett(
  prisma: PrismaClient,
  valores: readonly string[] | undefined | null,
  farmaciaIds?: readonly string[] | null,
): Promise<Prisma.ProdutoWhereInput | null> {
  const ids = await idsProdutosPorEticoNett(prisma, valores, null, farmaciaIds);
  // Sem selecção -> `ids` é `null`; com selecção -> lista (possivelmente vazia).
  if (lerValoresFiltroEticoNett(valores ?? []).length === 0) return null;
  return { id: { in: ids ?? [] } };
}

export type OpcaoEticoNett = { valor: ValorFiltroEticoNett; count: number };

/** Contagens por estado consolidado sobre produtos ACTIVOS (as 4 opções do filtro, mesmo a zero). */
export async function carregarOpcoesEticoNett(
  prisma: PrismaClient,
  farmaciaIds?: readonly string[] | null,
): Promise<OpcaoEticoNett[]> {
  const rows = await prisma.$queryRaw<Array<{ estado: string; n: bigint | number }>>(Prisma.sql`
    SELECT (CASE WHEN a.n IS NULL THEN 'SEM' WHEN a.n > 1 THEN 'DIVERGENTE' ELSE a.c END) AS estado, count(*) AS n
      FROM "Produto" p
      LEFT JOIN (${sqlAgregado(farmaciaIds)}) a ON a."produtoId" = p.id
     WHERE p.estado <> 'INATIVO'
     GROUP BY 1
  `);
  const por = new Map(rows.map((r) => [r.estado, Number(r.n)]));
  return (["ETICO", "NETT", "SEM", "DIVERGENTE"] as const).map((valor) => ({ valor, count: por.get(valor) ?? 0 }));
}

export type EticoNettDoProduto = {
  consolidado: EstadoConsolidado;
  porFarmacia: Array<{
    farmaciaId: string;
    farmaciaNome: string;
    categoria: CategoriaEticoNett;
    codigoErp: number | null;
    descricaoErp: string | null;
    observadoEm: Date | null;
    manual: boolean;
  }>;
};

/** Classificação de UM produto, por farmácia + consolidada (ficha do artigo). */
export async function carregarEticoNettDoProduto(prisma: PrismaClient, produtoId: string): Promise<EticoNettDoProduto> {
  const rows = await prisma.produtoFarmacia.findMany({
    where: { produtoId, eticoNett: { not: null } },
    select: {
      farmaciaId: true,
      eticoNett: true,
      eticoNettCodigoErp: true,
      eticoNettDescricaoErp: true,
      eticoNettObservadoEm: true,
      eticoNettManual: true,
      farmacia: { select: { nome: true } },
    },
    orderBy: { farmacia: { nome: "asc" } },
  });
  const porFarmacia = rows.map((r) => ({
    farmaciaId: r.farmaciaId,
    farmaciaNome: r.farmacia.nome,
    categoria: r.eticoNett as CategoriaEticoNett,
    codigoErp: r.eticoNettCodigoErp,
    descricaoErp: r.eticoNettDescricaoErp,
    observadoEm: r.eticoNettObservadoEm,
    manual: r.eticoNettManual,
  }));
  return { consolidado: consolidarEticoNett(porFarmacia.map((p) => p.categoria)), porFarmacia };
}
