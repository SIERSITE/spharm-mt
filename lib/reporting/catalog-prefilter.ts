/**
 * lib/reporting/catalog-prefilter.ts
 *
 * Pré-filtro server-side por subcategoria (nível 2) e utilização.
 *
 * Existe para os relatórios que já encolhem o universo de produtos ANTES
 * do trabalho pesado — Inventário e Margens fazem-no para categoria,
 * fabricante e "sem classificação". Estes dois eixos seguem o mesmo
 * padrão, no mesmo sítio, em vez de cada loader inventar o seu.
 *
 * Devolve sempre uma lista de ids ou `null` (= sem restrição). Uma lista
 * VAZIA significa "nenhum produto corresponde" — quem chama deve
 * devolver resultado vazio, e não ignorar a restrição.
 *
 * Uma consulta por eixo, nunca uma por produto.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { SharedReportFilters } from "./filters-shared";

export type FiltrosCatalogo = Pick<SharedReportFilters, "subcategorias" | "utilizacoes">;

/** Há alguma restrição destas para aplicar? */
export function temFiltroCatalogo(f: FiltrosCatalogo): boolean {
  return (f.subcategorias?.length ?? 0) > 0 || (f.utilizacoes?.length ?? 0) > 0;
}

export async function restringirPorCatalogo(
  prisma: PrismaClient,
  filtros: FiltrosCatalogo,
  actual: string[] | null,
): Promise<string[] | null> {
  let ids = actual;

  if (filtros.subcategorias && filtros.subcategorias.length > 0) {
    // Por NOME e não por id: é o nome que a UI conhece e o que a lista de
    // opções devolve. Homónimos entre categorias diferentes resolvem-se
    // combinando com o filtro de categoria, que corre à parte.
    const n2 = await prisma.classificacao.findMany({
      where: { tipo: "NIVEL_2", estado: "ATIVO", nome: { in: filtros.subcategorias } },
      select: { id: true },
    });
    if (n2.length === 0) return [];
    const produtos = await prisma.produto.findMany({
      where: {
        classificacaoNivel2Id: { in: n2.map((c) => c.id) },
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: { id: true },
    });
    ids = produtos.map((p) => p.id);
    if (ids.length === 0) return [];
  }

  if (filtros.utilizacoes && filtros.utilizacoes.length > 0) {
    // QUALQUER uma das utilizações escolhidas — `some` e não `every`. Um
    // xarope que serve para tosse e para constipação tem de aparecer em
    // ambas as pesquisas.
    const produtos = await prisma.produto.findMany({
      where: {
        utilizacoes: {
          some: { utilizacao: { slug: { in: filtros.utilizacoes }, estado: "ATIVO" } },
        },
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: { id: true },
    });
    ids = produtos.map((p) => p.id);
    if (ids.length === 0) return [];
  }

  return ids;
}
