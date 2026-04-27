/**
 * lib/categoria-resolver.ts
 *
 * Fonte ÚNICA de verdade para resolver a categoria/subcategoria de um
 * produto em toda a aplicação.
 *
 * REGRA ACTUALIZADA (post-audit, abril 2026):
 *
 *   SPharmMT é a fonte de verdade da classificação. SPharm/ERP fornece
 *   apenas CNP/designação/movimentos — os campos `ProdutoFarmacia.categoriaOrigem`
 *   e `subcategoriaOrigem` são texto livre não-fiável e NUNCA devem
 *   propagar como classificação canónica para a UI/relatórios/filtros.
 *
 * Resolução:
 *   1. `Produto.classificacaoNivel2.nome` → grupo (subcategoria canónica)
 *   2. `Produto.classificacaoNivel1.nome` → categoria (canónica)
 *   3. Sem canónico → categoria/grupo = "Por Classificar"
 *      e `needsClassification = true` para a UI sinalizar revisão.
 *
 * Os campos `categoriaOrigem` / `subcategoriaOrigem` continuam aceites
 * no input por compatibilidade — mas são IGNORADOS. Manter os campos
 * no `CategoriaSources` evita refactor em cascata em todos os call-sites
 * que ainda passam estes valores. O classifier interno
 * (lib/catalog-classifier.ts) continua a usar estes sinais como reforço
 * fraco para escolher `productType`, mas NUNCA como categoria persistida.
 */

export type ClassificacaoRef = { nome: string } | null | undefined;

export type CategoriaSources = {
  classificacaoNivel1?: ClassificacaoRef;
  classificacaoNivel2?: ClassificacaoRef;
  /** @deprecated Não usado na resolução — só aceite por compatibilidade. */
  categoriaOrigem?: string | null;
  /** @deprecated Não usado na resolução — só aceite por compatibilidade. */
  subcategoriaOrigem?: string | null;
};

export type ResolvedCategoria = {
  /** Nível pai canónico ou `POR_CLASSIFICAR` quando ausente. */
  categoria: string;
  /** Nível específico canónico ou `POR_CLASSIFICAR` quando ausente. */
  grupo: string;
  /** True quando não há classificação canónica — a UI deve sugerir revisão. */
  needsClassification: boolean;
};

export const POR_CLASSIFICAR = "Por Classificar";

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

export function resolveCategoria(src: CategoriaSources): ResolvedCategoria {
  const canonN1 = clean(src.classificacaoNivel1?.nome);
  const canonN2 = clean(src.classificacaoNivel2?.nome);

  if (!canonN1 && !canonN2) {
    return {
      categoria: POR_CLASSIFICAR,
      grupo: POR_CLASSIFICAR,
      needsClassification: true,
    };
  }

  return {
    // Categoria (pai): preferir canon N1; se só houver N2, devolve-o como categoria.
    categoria: canonN1 || canonN2,
    // Grupo (específico): preferir canon N2; se só houver N1, devolve-o como grupo.
    grupo: canonN2 || canonN1,
    needsClassification: false,
  };
}
