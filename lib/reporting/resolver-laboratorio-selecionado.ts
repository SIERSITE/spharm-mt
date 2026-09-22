/**
 * lib/reporting/resolver-laboratorio-selecionado.ts
 *
 * Resolve os nomes seleccionados no filtro "Fabricante" (Vendas,
 * Margens, Inventário — `SearchableMultiSelect`, `components/reporting/filter-panel.tsx`)
 * para os `Produto.id` correspondentes — o MESMO resolvedor usado pelos
 * três relatórios, para nunca poderem divergir entre si nem face ao
 * catálogo (`lib/catalogo-data.ts`).
 *
 * `SearchableMultiSelect` trabalha só sobre `string[]` simples (o texto É
 * o valor E a etiqueta) — por isso, ao contrário do filtro do catálogo
 * (que usa valores com prefixo `grupo:`/`fabricante:`), aqui um nome
 * seleccionado é resolvido PRIMEIRO contra `GrupoLaboratorial.nome`
 * (exacto) e só depois, se não bater nenhum grupo, contra
 * `Fabricante.nomeNormalizado` — exactamente como
 * `lib/catalogo-data.ts::loadCatalogoFilterOptions` já garante que um
 * fabricante integralmente num grupo nunca aparece como opção separada,
 * pelo que não há ambiguidade de nomes na prática.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveCurrentTenantSlug, TENANT_GRUPOS_LABORATORIAIS } from "@/lib/tenant-context";

type PrismaParaResolucao = Pick<PrismaClient, "grupoLaboratorial" | "produtoGrupoLaboratorial" | "fabricante" | "produto">;

export async function resolverProdutoIdsPorLaboratoriosSelecionados(
  prisma: PrismaParaResolucao,
  nomesSelecionados: readonly string[],
): Promise<string[]> {
  if (nomesSelecionados.length === 0) return [];

  // GrupoLaboratorial/ProdutoGrupoLaboratorial só têm sentido — e só têm
  // GARANTIA de existir como tabelas reais — no tenant garantia. Nos
  // restantes tenants (e em qualquer ambiente onde a migration ainda não
  // tenha corrido, incluindo garantia antes de aplicada) esta consulta
  // NUNCA corre: `getReportingFilterOptions` só devolve nomes de grupo
  // para garantia, portanto fora daí `nomesSelecionados` só pode conter
  // nomes de Fabricante — o caminho antigo, inalterado.
  const tenantSlug = await resolveCurrentTenantSlug();
  const gruposPodemExistir = tenantSlug === TENANT_GRUPOS_LABORATORIAIS;

  const grupos = gruposPodemExistir
    ? await prisma.grupoLaboratorial.findMany({ where: { nome: { in: [...nomesSelecionados] } }, select: { id: true, nome: true } })
    : [];
  const nomesDeGrupo = new Set(grupos.map((g) => g.nome));
  const nomesFabricante = nomesSelecionados.filter((n) => !nomesDeGrupo.has(n));

  const conjuntos: string[][] = [];

  if (grupos.length > 0) {
    const rows = await prisma.produtoGrupoLaboratorial.findMany({
      where: { grupoLaboratorialId: { in: grupos.map((g) => g.id) } },
      select: { produtoId: true },
    });
    conjuntos.push(rows.map((r) => r.produtoId));
  }

  if (nomesFabricante.length > 0) {
    const fabs = await prisma.fabricante.findMany({
      where: { nomeNormalizado: { in: nomesFabricante }, estado: "ATIVO" },
      select: { id: true },
    });
    if (fabs.length > 0) {
      const produtos = await prisma.produto.findMany({
        where: { fabricanteId: { in: fabs.map((f) => f.id) } },
        select: { id: true },
      });
      conjuntos.push(produtos.map((p) => p.id));
    }
  }

  // União (OR) entre grupos e fabricantes seleccionados — mesmo
  // comportamento multi-selecção que já existia só com fabricantes.
  const uniao = new Set<string>();
  for (const conjunto of conjuntos) for (const id of conjunto) uniao.add(id);
  return [...uniao];
}
