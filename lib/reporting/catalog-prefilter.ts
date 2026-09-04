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
import { whereCnpCatalogavel } from "@/lib/catalog/cnp-catalogavel";
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

/**
 * Os produtos SEM classificação — o que o toggle dos relatórios devolve.
 *
 * Estava escrito três vezes, com o mesmo `where`, em `inventario-data`,
 * `vendas-data` e `margens-data`. Passa a estar aqui, e a diferença não é
 * cosmética: faltava-lhe uma condição, e faltava-lhe nas três.
 *
 * ── A condição que faltava ───────────────────────────────────────────
 *
 * `classificacaoNivel1Id IS NULL` apanha também os códigos internos do
 * ERP — taxas, serviços, atos clínicos. Não têm CNP nacional, não existem
 * em fonte externa nenhuma, e não há classificação para lhes dar: estão
 * sem nível 1 porque nunca poderiam ter um.
 *
 * Medido na Silveira: das 3 097 linhas que o Inventário mostrava com o
 * toggle ligado, 1 647 eram de códigos internos — 1 122 dos 2 105 CNP
 * distintos. Mais de metade dos CNP que o filtro devolvia não eram um
 * problema de classificação; eram o sistema a funcionar como projectado.
 *
 * O toggle pergunta «que produtos do catálogo estão por classificar?».
 * A resposta não pode incluir o que não é catálogo.
 *
 * ── O que isto NÃO faz ───────────────────────────────────────────────
 *
 * Não esconde os códigos internos do Inventário. Sem o toggle, continuam
 * a aparecer, a contar para o stock e para o valor — são artigos reais da
 * farmácia. A exclusão vale SÓ para esta pergunta.
 *
 * ── Porque não filtra por `classificacaoEstado` ──────────────────────
 *
 * Porque a pergunta é sobre a COLUNA, não sobre a proveniência. Uma
 * classificação provisória tem nível 1 e nível 2 utilizáveis, e por isso
 * o produto não está por classificar — está classificado com menos
 * autoridade, que é outra pergunta e merece outro filtro. Filtrar aqui
 * por `AUSENTE` daria o mesmo resultado hoje e divergiria no dia em que
 * um caminho escrevesse N1 sem actualizar o enum — e há cinco caminhos
 * que o fazem.
 */
export async function restringirSemClassificacao(
  prisma: PrismaClient,
  actual: string[] | null,
): Promise<string[]> {
  const produtos = await prisma.produto.findMany({
    where: {
      classificacaoNivel1Id: null,
      estado: { not: "INATIVO" },
      cnp: whereCnpCatalogavel(),
      ...(actual ? { id: { in: actual } } : {}),
    },
    select: { id: true },
  });
  return produtos.map((p) => p.id);
}
