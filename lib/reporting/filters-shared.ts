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
  /** Categorias canónicas seleccionadas. Vazio = todas. */
  categorias?: string[];
  /** Fabricantes canónicos seleccionados. Vazio = todos. */
  fabricantes?: string[];
  /** Distribuidores / grossistas seleccionados. Vazio = todos. */
  distribuidores?: string[];
  /** Texto livre para CNP ou descrição (loader trata como ILIKE). */
  pesquisa?: string;
  /** Se true, restringe a produtos sem classificação canónica. */
  apenasSemClassif?: boolean;
};

/** Universo de opções carregado server-side, vindo do tenant. */
export type ReportFilterOptions = {
  farmacias: string[];        // nomes
  categorias: string[];
  fabricantes: string[];
  distribuidores: string[];
  semClassificacao: boolean;  // existem produtos sem classif. canónica?
};
