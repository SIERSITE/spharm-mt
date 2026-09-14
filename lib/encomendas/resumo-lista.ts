/**
 * lib/encomendas/resumo-lista.ts
 *
 * A contabilidade de uma lista de CNP importada face ao que a proposta
 * de encomenda devolveu.
 *
 * ── Porque vive à parte de `proposal.ts` ─────────────────────────────
 *
 * `proposal.ts` tem `import "server-only"`, e esse módulo não existe
 * fora do build do Next: qualquer script Node que o alcance morre em
 * `Cannot find module 'server-only'` — é o que
 * `scripts/tests/test-diagnostico-tools.ts` existe para detectar.
 *
 * Esta função é aritmética sobre dois arrays. Não toca na base de dados,
 * não precisa de sessão, e é exactamente o tipo de regra que tem de ser
 * testável por comportamento e não por inspecção do código que a chama.
 * Ficar dentro do módulo com `server-only` tornava-a intestável.
 *
 * ── Porque estes números têm de fechar ───────────────────────────────
 *
 * Um resumo que não some é pior do que nenhum: o utilizador vê «1 210
 * encontrados» e «940 na proposta» e fica a pensar onde foram os 270.
 * As duas identidades abaixo são o contrato desta função, e o teste
 * verifica-as:
 *
 *     encontrados = comVendas + semVendas + semRegistoNaFarmacia
 *     listaSemVendas.length === semVendas
 */

/**
 * O que aconteceu a cada CNP da lista. As três categorias são
 * mutuamente exclusivas e esgotam a lista.
 */
export type ResumoListaImportada = {
  /** CNP que a lista trouxe e que existem no catálogo. */
  cnpsNaLista: number;
  /** Entraram no cálculo com vendas > 0 no período. */
  comVendas: number;
  /** Existem na farmácia mas não venderam no período. Entram com 0. */
  semVendas: number;
  /**
   * Existem no catálogo mas não produziram linha nesta proposta.
   *
   * Na esmagadora maioria dos casos é o que o nome diz: o artigo nunca
   * teve registo NESTA farmácia — sem stock, sem preço, sem movimento.
   *
   * Há duas outras formas de lá cair, e é honesto dizê-las: um artigo
   * marcado `flagRetirado` nessa farmácia, e um artigo excluído por
   * outro filtro activo ao mesmo tempo que a lista (fabricante,
   * categoria, utilização). Distingui-los exigiria uma segunda consulta
   * por farmácia; o valor não paga o round-trip, e a acção do
   * utilizador é a mesma nos três casos — o artigo não entra nesta
   * encomenda e tem de ser adicionado à mão.
   *
   * É uma categoria à parte de `semVendas` porque a resposta
   * operacional é outra: um artigo que a farmácia nunca teve não se
   * ajusta, adiciona-se. Fundir os dois escondia isso.
   */
  semRegistoNaFarmacia: number;
  /** Os CNP de `semVendas`, para o utilizador consultar. */
  listaSemVendas: number[];
  /** Os CNP de `semRegistoNaFarmacia`. */
  listaSemRegisto: number[];
};

/** O mínimo que esta função precisa de saber sobre uma linha. */
export type LinhaParaResumo = {
  cnp: number;
  salesQty: number;
};

export function resumirListaImportada(
  cnps: readonly number[],
  linhas: readonly LinhaParaResumo[],
): ResumoListaImportada {
  const comVendas = new Set<number>();
  const semVendas = new Set<number>();
  for (const l of linhas) {
    if (l.salesQty > 0) comVendas.add(l.cnp);
    else semVendas.add(l.cnp);
  }
  // Em modo grupo o mesmo CNP aparece uma vez POR FARMÁCIA. Vender numa
  // basta para não ser «sem vendas»: o artigo roda no grupo, e contá-lo
  // nas duas colunas faria o resumo somar mais do que a lista tem.
  for (const c of comVendas) semVendas.delete(c);

  // Só os CNP da LISTA. Uma linha cujo CNP não venha da lista (não
  // deveria acontecer, mas a consulta é que garante isso, não esta
  // função) não inventa uma categoria.
  const naLista = new Set(cnps);
  for (const c of [...comVendas]) if (!naLista.has(c)) comVendas.delete(c);
  for (const c of [...semVendas]) if (!naLista.has(c)) semVendas.delete(c);

  const listaSemRegisto = cnps.filter((c) => !comVendas.has(c) && !semVendas.has(c));

  return {
    cnpsNaLista: cnps.length,
    comVendas: comVendas.size,
    semVendas: semVendas.size,
    semRegistoNaFarmacia: listaSemRegisto.length,
    // A ordem é a da LISTA, não a da iteração dos Sets: é assim que o
    // utilizador consegue percorrer o ecrã com o ficheiro ao lado.
    listaSemVendas: cnps.filter((c) => semVendas.has(c)),
    listaSemRegisto,
  };
}
