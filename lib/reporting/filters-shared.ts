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
  /**
   * Lista de CNP importada por ficheiro. Ver
   * `lib/produtos/lista-codigos-tipos.ts`.
   *
   * A semântica é diferente de TODOS os outros multi-selects deste tipo,
   * e a diferença é deliberada:
   *
   *   · `undefined` → sem restrição (não foi importada lista nenhuma)
   *   · `[]`        → NENHUM produto
   *   · não-vazio   → exactamente estes CNP
   *
   * Nos outros campos, vazio significa "todos", porque vazio é o estado
   * inicial de um multi-select. Aqui não: um array vazio só existe
   * depois de alguém ter importado um ficheiro de que nenhum código
   * existe no catálogo, e devolver-lhe o catálogo inteiro seria o oposto
   * do que pediu. Quem não tem lista manda `undefined`.
   *
   * Combina-se com os restantes filtros por E lógico, como qualquer
   * outro eixo.
   */
  cnps?: number[];
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
  /**
   * Só produtos de CATÁLOGO sem nível 1.
   *
   * Exclui os códigos internos do ERP: um artigo que nunca poderia ter
   * classificação não é um problema de classificação. Ver
   * `restringirSemClassificacao` em lib/reporting/catalog-prefilter.ts.
   *
   * NÃO exclui as classificações provisórias: essas têm nível 1 e nível 2
   * utilizáveis, portanto não estão por classificar.
   */
  apenasSemClassif?: boolean;
  /**
   * Alarga o universo do relatório de Vendas para incluir também
   * produtos SEM vendas no período mas com stock actual > 0 — uma
   * UNIÃO, nunca um filtro por cima do universo de vendas.
   *
   * Semântica ao ligar: `vendasNoPeriodo > 0 OR stockAtual > 0`, nunca
   * `AND`. Um produto que entra só por ter stock aparece com
   * meses/total de vendas a ZERO (nunca inventados) e o
   * stock/PVP/custo/fabricante reais, como qualquer outra linha. Ver
   * `lib/vendas-data.ts::getVendasData`.
   *
   * Desligado (default/omisso): comportamento inalterado — só produtos
   * com vendas no período, exactamente como antes desta opção existir.
   *
   * Específico de Vendas (como `apenasSemClassif` — ver comentário no
   * topo deste ficheiro sobre loaders estenderem o tipo partilhado).
   */
  apenasComStock?: boolean;
  /**
   * Soma, ao ledger real, as quantidades já persistidas em Manutenção
   * de Vendas (`VendaManutencaoCelula`, só manutenções `estado:"ATIVA"`)
   * — uma UNIÃO ADITIVA, nunca uma reconstrução: a distribuição
   * artigo×farmácia×mês já foi calculada e gravada na criação/recálculo
   * da manutenção (ver lib/vendas-manutencao-data.ts), este filtro só
   * decide se ela entra ou não na soma do mapa.
   *
   * Desligado (default/omisso): comportamento inalterado — só o ledger
   * real, exactamente como antes desta opção existir.
   *
   * O valor bruto da manutenção usa sempre o PVP de REFERÊNCIA
   * capturado na criação da manutenção — nunca o `ProdutoFarmacia.pvp`
   * de hoje. A coluna PVP do relatório continua a mostrar o PVP actual,
   * como sempre — este filtro não muda essa semântica.
   *
   * Específico de Vendas (como `apenasComStock`).
   */
  incluirManutencao?: boolean;
};

/**
 * A linha de cabeçalho que anuncia a lista importada.
 *
 * Vive aqui e não em cada adaptador porque um relatório que foi
 * restringido por um ficheiro e não o diz é um relatório que ninguém
 * consegue reproduzir dois dias depois — a folha mostra 437 artigos e
 * nada explica porque não são 30 000.
 *
 * Deriva do MESMO array que o loader usou. Não recebe o nome do
 * ficheiro nem as contagens do parse de propósito: esses vivem no
 * cliente e podiam ficar dessincronizados do filtro que realmente
 * correu. Isto não pode.
 */
export function filtroListaImportada(
  cnps: number[] | undefined | null,
): { label: string; value: string } | null {
  if (!Array.isArray(cnps)) return null;
  return {
    label: "Lista importada",
    value:
      cnps.length === 0
        ? "0 produtos (nenhum código do ficheiro existe no catálogo)"
        : `${cnps.length.toLocaleString("pt-PT")} produto${cnps.length === 1 ? "" : "s"}`,
  };
}

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
