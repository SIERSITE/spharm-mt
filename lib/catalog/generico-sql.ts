/**
 * lib/catalog/generico-sql.ts
 *
 * O lado servidor do filtro «Genérico» (regra em `generico-filtro.ts`): ids para filtrar, `where` do Prisma e contagens das opções.
 * Lê só `Produto.flagGenerico` (NOT NULL). Sem migration, sem coluna nova. Cada tenant tem a sua base — o `prisma` recebido já é o dele.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { flagDoFiltroGenerico } from "@/lib/catalog/generico-filtro";

/**
 * Ids de produto que passam o filtro (opcionalmente dentro de `dentroDe`). UMA consulta.
 * Sem filtro (Todos) -> `dentroDe` inalterado (sem restrição). Lista vazia = nenhum produto.
 */
export async function idsProdutosPorGenerico(
  prisma: PrismaClient,
  valor: unknown,
  dentroDe: string[] | null,
): Promise<string[] | null> {
  const flag = flagDoFiltroGenerico(valor);
  if (flag === undefined) return dentroDe;
  if (dentroDe && dentroDe.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT p.id FROM "Produto" p
     WHERE p."flagGenerico" = ${flag}
       ${dentroDe ? Prisma.sql`AND p.id = ANY(${dentroDe}::text[])` : Prisma.empty}
  `);
  return rows.map((r) => r.id);
}

/** Para consumidores que filtram com o query builder do Prisma (Catálogo): `{ flagGenerico }` ou `null` (= sem restrição). */
export function wherePrismaPorGenerico(valor: unknown): Prisma.ProdutoWhereInput | null {
  const flag = flagDoFiltroGenerico(valor);
  return flag === undefined ? null : { flagGenerico: flag };
}

/** Fragmento SQL `AND p."flagGenerico" = …` (alias `p` = "Produto"), ou vazio. Para SQL que já junta `Produto`. */
export function sqlFiltroGenerico(valor: unknown, coluna: string = 'p."flagGenerico"'): Prisma.Sql {
  const flag = flagDoFiltroGenerico(valor);
  return flag === undefined ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(coluna)} = ${flag}`;
}

export type OpcoesGenerico = { genericos: number; naoGenericos: number };

/** Contagens sobre produtos ACTIVOS (as duas opções com contagem; «Todos» = a soma). */
export async function carregarOpcoesGenerico(prisma: PrismaClient): Promise<OpcoesGenerico> {
  const rows = await prisma.$queryRaw<Array<{ g: boolean; n: bigint | number }>>(Prisma.sql`
    SELECT p."flagGenerico" AS g, count(*) AS n FROM "Produto" p WHERE p.estado <> 'INATIVO' GROUP BY 1
  `);
  const por = new Map(rows.map((r) => [r.g, Number(r.n)]));
  return { genericos: por.get(true) ?? 0, naoGenericos: por.get(false) ?? 0 };
}
