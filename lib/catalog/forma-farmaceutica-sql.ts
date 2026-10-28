/**
 * lib/catalog/forma-farmaceutica-sql.ts
 *
 * O lado SQL do filtro de forma farmacêutica — a MESMA regra de `forma-farmaceutica-filtro.ts` (aparar, colapsar
 * espaços, minúsculas, sem acentos), sem extensões (`unaccent`) nem dependência do locale da base.
 *
 * Tudo parametrizado: a coluna vem de um identificador FIXO (constante deste repo, nunca input) e as chaves
 * seleccionadas vão como parâmetro (`= ANY($n)`), nunca interpoladas.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  ACENTOS_DESTINO,
  ACENTOS_ORIGEM,
  SEM_FORMA,
  lerChavesForma,
  opcoesFormaFarmaceutica,
  type OpcaoFormaFarmaceutica,
} from "@/lib/catalog/forma-farmaceutica-filtro";
import { MIN_CNP_CATALOGAVEL } from "@/lib/catalog/cnp-catalogavel";

/**
 * Expressão SQL da chave de uma coluna (ex.: `p."formaFarmaceutica"`). `coluna` é um identificador interno
 * (`Prisma.raw`) — chamar SEMPRE com literais deste repositório, nunca com input.
 */
export function sqlChaveForma(coluna: string = 'p."formaFarmaceutica"'): Prisma.Sql {
  const col = Prisma.raw(coluna);
  return Prisma.sql`COALESCE(NULLIF(lower(translate(btrim(regexp_replace(${col}, '[ \t\r\n\f\v]+', ' ', 'g')), ${ACENTOS_ORIGEM}, ${ACENTOS_DESTINO})), ''), ${SEM_FORMA})`;
}

/**
 * A CONDIÇÃO «a forma de `coluna` pertence às `chaves`» (sem `AND` à frente) — `null` sem selecção.
 *
 * ── Porque não é só `chave(coluna) = ANY(chaves)` ─────────────────────
 *
 * Isso corre 8 funções de texto POR LINHA (regexp_replace + btrim + translate + lower): medido, 405 ms para 50 000
 * produtos. Em vez disso, a chave calcula-se UMA vez por valor cru DISTINTO (centenas, não dezenas de milhares) numa
 * subconsulta não correlacionada — o Postgres materializa-a como um conjunto em hash — e a coluna compara-se por
 * igualdade com esse conjunto. Mesmo resultado, sem índice nem migração. As chaves vão como parâmetro.
 *
 * `OFFSET 0` é uma barreira de optimização: sem ela o planificador empurra o filtro de chave para DENTRO do DISTINCT e
 * volta a calculá-la por linha (medido: 421 ms em vez de ~25 ms).
 *
 * O valor NULL não pertence a `IN`: «sem forma» trata-o à parte (`IS NULL`); um valor só de espaços entra pela chave.
 */
export function sqlCondicaoForma(
  chaves: readonly string[] | undefined | null,
  coluna: string = 'p."formaFarmaceutica"',
): Prisma.Sql | null {
  const lista = lerChavesForma(chaves ?? []);
  if (lista.length === 0) return null;
  const col = Prisma.raw(coluna);
  const semForma = lista.includes(SEM_FORMA);
  return Prisma.sql`(${col} IN (
      SELECT v.forma FROM (SELECT DISTINCT "formaFarmaceutica" AS forma FROM "Produto" OFFSET 0) v
       WHERE v.forma IS NOT NULL AND ${sqlChaveForma("v.forma")} = ANY(${lista}::text[])
    ) OR (${col} IS NULL AND ${semForma}::boolean))`;
}

/** `AND <condição>` — `Prisma.empty` sem selecção (comportamento anterior). */
export function sqlFiltroForma(
  chaves: readonly string[] | undefined | null,
  coluna: string = 'p."formaFarmaceutica"',
): Prisma.Sql {
  const cond = sqlCondicaoForma(chaves, coluna);
  return cond ? Prisma.sql`AND ${cond}` : Prisma.empty;
}

/**
 * Ids de produto cuja forma pertence às `chaves` (opcionalmente dentro de `dentroDe`). UMA consulta.
 * Sem chaves -> `dentroDe` inalterado (sem restrição).
 */
export async function idsProdutosPorFormas(
  prisma: PrismaClient,
  chaves: readonly string[] | undefined | null,
  dentroDe: string[] | null,
): Promise<string[] | null> {
  const cond = sqlCondicaoForma(chaves);
  if (!cond) return dentroDe;
  if (dentroDe && dentroDe.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT p.id FROM "Produto" p
     WHERE ${cond}
       ${dentroDe ? Prisma.sql`AND p.id = ANY(${dentroDe})` : Prisma.empty}
  `);
  return rows.map((r) => r.id);
}

/**
 * As opções do filtro: UMA agregação (sem N+1) sobre os produtos ACTIVOS e CATALOGÁVEIS da base do tenant (cada
 * tenant tem a sua base — o `prisma` recebido já é o dele; nada é partilhado). Agrupa por valor cru e junta por
 * chave em memória (centenas de linhas), para poder escolher o rótulo da variante mais frequente.
 */
export async function carregarOpcoesFormaFarmaceutica(prisma: PrismaClient): Promise<OpcaoFormaFarmaceutica[]> {
  const rows = await prisma.$queryRaw<Array<{ valor: string | null; n: bigint | number }>>(Prisma.sql`
    SELECT p."formaFarmaceutica" AS valor, count(*) AS n
      FROM "Produto" p
     WHERE p.estado <> 'INATIVO' AND p.cnp > ${MIN_CNP_CATALOGAVEL}
     GROUP BY p."formaFarmaceutica"
  `);
  return opcoesFormaFarmaceutica(rows.map((r) => ({ valor: r.valor, count: Number(r.n) })));
}

/**
 * Para consumidores que filtram com o query builder do Prisma (Catálogo): os VALORES CRUS distintos cuja chave está
 * em `chaves` (uma consulta pequena sobre `DISTINCT`, não sobre ids de produto) -> `{ formaFarmaceutica: { in } }`.
 * Evita listas de dezenas de milhares de ids num `IN` (limite de parâmetros) e mantém o filtro exacto.
 * Sem chaves devolve `null` (= sem restrição).
 */
export async function wherePrismaPorFormas(
  prisma: PrismaClient,
  chaves: readonly string[] | undefined | null,
): Promise<Prisma.ProdutoWhereInput | null> {
  const lista = lerChavesForma(chaves ?? []);
  if (lista.length === 0) return null;
  // DISTINCT primeiro, chave depois: a chave só se calcula nos valores distintos (ver `sqlCondicaoForma`).
  const rows = await prisma.$queryRaw<Array<{ valor: string | null }>>(Prisma.sql`
    SELECT v.valor FROM (SELECT DISTINCT "formaFarmaceutica" AS valor FROM "Produto" OFFSET 0) v
     WHERE ${sqlChaveForma("v.valor")} = ANY(${lista}::text[])
  `);
  const valores = rows.map((r) => r.valor).filter((v): v is string => v !== null);
  const incluiNulo = rows.some((r) => r.valor === null);
  const ramos: Prisma.ProdutoWhereInput[] = [];
  if (valores.length > 0) ramos.push({ formaFarmaceutica: { in: valores } });
  if (incluiNulo) ramos.push({ formaFarmaceutica: null });
  if (ramos.length === 0) return { id: { in: [] } };
  return ramos.length === 1 ? ramos[0] : { OR: ramos };
}
