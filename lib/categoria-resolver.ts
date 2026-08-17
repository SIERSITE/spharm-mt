/**
 * lib/categoria-resolver.ts
 *
 * Fonte ÚNICA de verdade para resolver a categoria/subcategoria de um
 * produto em toda a aplicação.
 *
 * REGRA (post-cleanup, abril 2026):
 *
 *   SPharmMT é a fonte de verdade da classificação. SPharm/ERP fornece
 *   apenas CNP/designação/movimentos — os campos `ProdutoFarmacia.categoriaOrigem`
 *   e `subcategoriaOrigem` são texto livre não-fiável e NUNCA devem
 *   propagar como classificação canónica para a UI/relatórios/filtros.
 *
 * Resolução:
 *   1. `Produto.classificacaoNivel2.nome` → grupo (subcategoria canónica)
 *   2. `Produto.classificacaoNivel1.nome` → categoria (canónica)
 *   3. Sem canónico → categoria/grupo = `SEM_CLASSIFICACAO_LABEL`
 *      ("Por Classificar") usado APENAS como rótulo de UI.
 *      Não é uma categoria — é um indicador visual de produto sem
 *      classificação. O estado real está em
 *      `Produto.verificationStatus` / `Produto.needsManualReview`.
 *      Este rótulo NÃO deve aparecer em filtros nem ser persistido.
 *
 * Os campos `categoriaOrigem` / `subcategoriaOrigem` continuam aceites
 * no input por compatibilidade — mas são IGNORADOS. O classifier interno
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
  /** Nível pai canónico ou `SEM_CLASSIFICACAO_LABEL` quando ausente. */
  categoria: string;
  /** Nível específico canónico ou `SEM_CLASSIFICACAO_LABEL` quando ausente. */
  grupo: string;
  /** True quando não há classificação canónica — a UI deve sugerir revisão. */
  needsClassification: boolean;
};

/**
 * Rótulo de UI para produtos sem classificação canónica. NÃO é uma
 * categoria — é apenas o texto a apresentar quando os campos
 * `classificacaoNivel*Id` estão `null`. Não deve ser persistido em
 * `Classificacao.nome` nem incluído em filtros de categoria.
 */
export const SEM_CLASSIFICACAO_LABEL = "Por Classificar";

/** @deprecated Use `SEM_CLASSIFICACAO_LABEL`. Mantido só por compatibilidade. */
export const POR_CLASSIFICAR = SEM_CLASSIFICACAO_LABEL;

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/**
 * Par (categoria, subcategoria) para relatórios operacionais.
 *
 * `resolveCategoria` devolve `categoria`/`grupo`, e `grupo` cai para o N1
 * quando não há N2 — o que é certo para agrupar, e errado para uma coluna
 * chamada "subcategoria". Pior: três módulos punham o `grupo` num campo
 * chamado `categoria` e depois comparavam-no com um dropdown de nomes de
 * NÍVEL 1. O filtro só acertava em produtos SEM nível 2, e o
 * enriquecimento — que existe justamente para preencher o nível 2 — ia
 * tornando o filtro cada vez mais vazio.
 *
 * Aqui os dois níveis são o que dizem ser:
 *   · `categoria`    — nível 1, ou "Por Classificar";
 *   · `subcategoria` — nível 2, ou "" quando não há um distinto.
 *
 * String vazia e não o rótulo: "Por Classificar" numa subcategoria seria
 * uma opção de filtro que não corresponde a classificação nenhuma.
 */
export type ParClassificacao = {
  categoria: string;
  subcategoria: string;
};

export function resolverPar(src: CategoriaSources): ParClassificacao {
  const r = resolveCategoria(src);
  return {
    categoria: r.categoria,
    subcategoria: r.grupo && r.grupo !== r.categoria ? r.grupo : "",
  };
}

export function resolveCategoria(src: CategoriaSources): ResolvedCategoria {
  const canonN1 = clean(src.classificacaoNivel1?.nome);
  const canonN2 = clean(src.classificacaoNivel2?.nome);

  if (!canonN1 && !canonN2) {
    return {
      categoria: SEM_CLASSIFICACAO_LABEL,
      grupo: SEM_CLASSIFICACAO_LABEL,
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
