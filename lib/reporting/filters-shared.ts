/**
 * lib/reporting/filters-shared.ts
 *
 * Tipo canónico dos filtros que TODOS os relatórios operacionais
 * partilham. Vive aqui (e não em cada loader) para que módulos novos
 * (Inventário, Margens) e — quando refactor — os existentes
 * (Vendas, Devoluções, Excessos, Transferências, Encomendas) consumam
 * a mesma shape sem divergir.
 *
 * Convenções:
 *   · `farmaciaNomes` em vez de ids — é o que o client conhece a
 *     partir de `getFarmaciasInfo()`. Loaders resolvem para ids.
 *   · Períodos em ISO yyyy-mm-dd (string) — o client usa <input type=date>.
 *   · Multi-selects são string[] (nunca null/undefined dentro do array).
 *   · `pesquisa` é único campo que pode incluir CNP ou descrição —
 *     o loader decide se faz match exacto ou ILIKE.
 *   · `apenasSemClassif` honra a flag `semClassificacao` de
 *     `getReportingFilterOptions()` (workflow state, não categoria).
 *
 * Loaders específicos podem ESTENDER este tipo com campos adicionais
 * (ex: granularidade, agrupamento server-side) — mas NUNCA renomear
 * campos partilhados.
 */
export type SharedReportFilters = {
  /** Lista de NOMES de farmácia. Vazio/omitido = todas as activas. */
  farmaciaNomes?: string[];
  /** Início inclusivo do período (ISO yyyy-mm-dd). */
  from?: string;
  /** Fim inclusivo do período (ISO yyyy-mm-dd). */
  to?: string;
  /** Categorias canónicas (NÍVEL 1) seleccionadas. Vazio = todas. */
  categorias?: string[];
  /**
   * Subcategorias canónicas (NÍVEL 2) seleccionadas. Vazio = todas.
   *
   * Independente de `categorias`: escolher "Cardiovascular" sem escolher
   * "MEDICAMENTOS" é legítimo. Quando as duas vêm preenchidas, aplicam-se
   * as duas (E lógico) — é o que a UI mostra.
   */
  subcategorias?: string[];
  /**
   * Utilizações clínicas por SLUG. Vazio = todas.
   *
   * Um produto com várias utilizações entra se corresponder a QUALQUER
   * uma (OU lógico) — "mostra-me o que serve para tosse" não deve excluir
   * um xarope que também serve para constipação.
   */
  utilizacoes?: string[];
  /** Fabricantes canónicos seleccionados. Vazio = todos. */
  fabricantes?: string[];
  /** Distribuidores / grossistas seleccionados. Vazio = todos. */
  distribuidores?: string[];
  /** Texto livre para CNP ou descrição (loader trata como ILIKE). */
  pesquisa?: string;
  /**
   * Incluir vendas a crédito. **Default ON.**
   *
   * É a configuração do relatório oficial do SPharm que usamos como
   * referência: "Incluir Vendas a Crédito = Sim".
   */
  incluirCredito?: boolean;
  /**
   * Incluir guias de transferência entre farmácias. **Default OFF.**
   *
   * Também por paridade com o relatório oficial. Na Silveirense 2026 a
   * diferença não é cosmética — Julho passa de 14 120 para 18 737
   * unidades quando se ligam as transferências.
   */
  incluirTransferencias?: boolean;
  /** Se true, restringe a produtos sem classificação canónica. */
  apenasSemClassif?: boolean;
};

/** Universo de opções carregado server-side, vindo do tenant. */
export type ReportFilterOptions = {
  farmacias: string[];        // nomes
  categorias: string[];
  subcategorias: Array<{ nome: string; categoria: string }>;
  utilizacoes: Array<{ slug: string; nome: string }>;
  fabricantes: string[];
  distribuidores: string[];
  semClassificacao: boolean;  // existem produtos sem classif. canónica?
};

/**
 * A parte de catálogo de uma linha de relatório. Qualquer loader que
 * queira ser filtrável por classificação devolve isto.
 */
export type LinhaClassificavel = {
  /** Nível 1, ou o rótulo "Por Classificar". */
  categoria: string;
  /** Nível 2, ou "" quando não há um distinto. */
  subcategoria: string;
  /** Slugs das utilizações do produto. */
  utilizacoes: string[];
};

/**
 * O predicado ÚNICO de catálogo, partilhado por todos os módulos.
 *
 * Vive aqui e não em cada cliente porque a versão duplicada foi
 * exactamente o que deixou três módulos a comparar nível 2 contra uma
 * lista de nível 1 durante meses, cada um com a sua cópia da linha.
 *
 * Selecção vazia = não filtra. Categoria e subcategoria são E; as
 * utilizações são OU entre si.
 */
export function passaFiltroCatalogo(
  /**
   * NÃO é `Partial<>`, de propósito. Enquanto era, um cliente cuja linha
   * não trouxesse `subcategoria` ou `utilizacoes` compilava na mesma — e
   * o filtro passava a excluir tudo, em silêncio. Vários clientes têm
   * cópias locais do tipo da linha; exigir os três campos aqui é o que
   * obriga essas cópias a acompanhar o loader.
   */
  linha: LinhaClassificavel,
  filtros: Pick<SharedReportFilters, "categorias" | "subcategorias" | "utilizacoes">,
): boolean {
  const { categorias, subcategorias, utilizacoes } = filtros;

  if (categorias && categorias.length > 0 && !categorias.includes(linha.categoria)) {
    return false;
  }
  if (subcategorias && subcategorias.length > 0 && !subcategorias.includes(linha.subcategoria)) {
    return false;
  }
  if (utilizacoes && utilizacoes.length > 0) {
    if (!linha.utilizacoes.some((s) => utilizacoes.includes(s))) return false;
  }
  return true;
}
