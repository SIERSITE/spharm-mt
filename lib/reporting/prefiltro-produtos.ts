/**
 * lib/reporting/prefiltro-produtos.ts
 *
 * Pré-filtro de PRODUTO partilhado pelos filtros de Vendas — extraído, sem
 * alterar semântica, do loader `getVendasData` (lib/vendas-data.ts) para que
 * a Manutenção em massa do catálogo aplique EXACTAMENTE as mesmas regras
 * (categorias, sem classificação, fabricantes, lista de CNP, subcategorias,
 * utilizações, pesquisa) e devolva o mesmo universo de produtos para os
 * mesmos valores. Nenhum dos dois reimplementa isto.
 *
 * Devolve:
 *   · `null`  — sem restrição de produto;
 *   · `[]`    — nenhum produto corresponde (quem chama devolve vazio);
 *   · `[...]` — ids de `Produto` que cumprem TODOS os filtros (AND).
 *
 * A ordem das restrições é a de sempre (categorias → sem classificação →
 * fabricantes → catálogo → pesquisa); cada uma intersecta a anterior.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { temFiltroCatalogo, restringirPorCatalogo, restringirSemClassificacao } from "@/lib/reporting/catalog-prefilter";
import { construirCondicaoPesquisa } from "@/lib/reporting/pesquisa-produto";
import { resolverProdutoIdsPorLaboratoriosSelecionados } from "@/lib/reporting/resolver-laboratorio-selecionado";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

export type FiltrosPrefiltroProdutos = Pick<
  SharedReportFilters,
  "categorias" | "apenasSemClassif" | "fabricantes" | "subcategorias" | "utilizacoes" | "cnps" | "pesquisa"
>;

export async function resolverPrefiltroProdutos(
  prisma: PrismaClient,
  filters: FiltrosPrefiltroProdutos
): Promise<string[] | null> {
  let produtoIdFilter: string[] | null = null;
  if (filters.categorias && filters.categorias.length > 0) {
    const classifs = await prisma.classificacao.findMany({
      where: { tipo: "NIVEL_1", estado: "ATIVO", nome: { in: filters.categorias } },
      select: { id: true },
    });
    const classifIds = classifs.map((c) => c.id);
    if (classifIds.length === 0) return [];
    const produtos = await prisma.produto.findMany({
      where: { classificacaoNivel1Id: { in: classifIds } },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return [];
  }
  if (filters.apenasSemClassif) {
    produtoIdFilter = await restringirSemClassificacao(prisma, produtoIdFilter);
    if (produtoIdFilter.length === 0) return [];
  }
  if (filters.fabricantes && filters.fabricantes.length > 0) {
    const idsLaboratorio = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, filters.fabricantes);
    if (idsLaboratorio.length === 0) return [];
    if (produtoIdFilter) {
      const idsLaboratorioSet = new Set(idsLaboratorio);
      produtoIdFilter = produtoIdFilter.filter((id) => idsLaboratorioSet.has(id));
    } else {
      produtoIdFilter = idsLaboratorio;
    }
    if (produtoIdFilter.length === 0) return [];
  }
  if (temFiltroCatalogo(filters)) {
    produtoIdFilter = await restringirPorCatalogo(prisma, filters, produtoIdFilter);
    if (produtoIdFilter && produtoIdFilter.length === 0) return [];
  }
  if (filters.pesquisa && filters.pesquisa.trim()) {
    const pesquisaCond = construirCondicaoPesquisa(filters.pesquisa);
    const produtos = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT p.id FROM "Produto" p
      WHERE 1 = 1
        ${pesquisaCond}
        ${produtoIdFilter ? Prisma.sql`AND p.id = ANY(${produtoIdFilter})` : Prisma.empty}
    `);
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return [];
  }
  return produtoIdFilter;
}
