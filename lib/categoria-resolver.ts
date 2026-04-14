/**
 * lib/categoria-resolver.ts
 *
 * Fonte ÚNICA de verdade para resolver a categoria/subcategoria de um
 * produto em toda a aplicação. Motivação: a ficha do artigo lia
 * exclusivamente de `Produto.classificacaoNivel1/2` (canónico, muitas
 * vezes vazio) enquanto Vendas lia de `ProdutoFarmacia.categoriaOrigem`
 * (texto bruto por farmácia, populado pelo importer). O mesmo CNP podia
 * mostrar "—" numa página e "SEXUALIDADE" noutra.
 *
 * Regra de resolução (da mais canónica para a mais solta):
 *   1. `Produto.classificacaoNivel2.nome`  — canónico, subcategoria
 *   2. `Produto.classificacaoNivel1.nome`  — canónico, categoria
 *   3. `ProdutoFarmacia.subcategoriaOrigem` — importer, subcategoria
 *   4. `ProdutoFarmacia.categoriaOrigem`    — importer, categoria
 *
 * Retorna `{ categoria, grupo }` onde `grupo` é a versão mais específica
 * disponível (subcategoria quando existe) e `categoria` é o pai. Se a
 * resolução só encontrar um nível, usamos o mesmo valor em ambos.
 *
 * A função é pura e client-safe. Chamar a partir de lib/vendas-data.ts,
 * app/stock/artigo/[cnp]/page.tsx, adapters de reporting, etc.
 */

export type ClassificacaoRef = { nome: string } | null | undefined;

export type CategoriaSources = {
  classificacaoNivel1?: ClassificacaoRef;
  classificacaoNivel2?: ClassificacaoRef;
  /** `ProdutoFarmacia.categoriaOrigem` — pode ser null/empty. */
  categoriaOrigem?: string | null;
  /** `ProdutoFarmacia.subcategoriaOrigem` — pode ser null/empty. */
  subcategoriaOrigem?: string | null;
};

export type ResolvedCategoria = {
  /** Nível mais alto disponível — sempre uma string (pode ser ""). */
  categoria: string;
  /** Nível mais específico disponível (subcategoria ou fallback). */
  grupo: string;
};

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

export function resolveCategoria(src: CategoriaSources): ResolvedCategoria {
  const canonN1 = clean(src.classificacaoNivel1?.nome);
  const canonN2 = clean(src.classificacaoNivel2?.nome);
  const origemCat = clean(src.categoriaOrigem);
  const origemSub = clean(src.subcategoriaOrigem);

  // Categoria (nível pai): prefere canónico N1, depois origem cat.
  const categoria = canonN1 || origemCat || canonN2 || origemSub;
  // Grupo (nível específico): prefere canónico N2, depois origem sub,
  // depois cai para a categoria (garante que nunca é mais vazio do que
  // o pai).
  const grupo = canonN2 || origemSub || canonN1 || origemCat;

  return { categoria, grupo };
}
