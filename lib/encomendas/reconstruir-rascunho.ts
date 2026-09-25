/**
 * lib/encomendas/reconstruir-rascunho.ts
 *
 * Ao retomar um rascunho eager de `/encomendas/nova` (reload, ou o
 * mesmo link noutro computador), as colunas DECIDIDAS (quantidade
 * final, notas, origem) vêm sempre, sem excepção, do que está
 * persistido em `LinhaEncomenda` — nunca recalculadas, nunca
 * sobrepostas. As colunas INFORMATIVAS (vendas médias, stock actual,
 * cobertura, estado, motivo) SÃO recalculadas a partir de uma proposta
 * fresca, porque são dados de contexto que envelhecem (stock muda todos
 * os dias) e mostrar um número congelado do momento em que a linha
 * nasceu seria pior do que mostrar o valor actual.
 *
 * A fronteira entre os dois grupos é a regra central deste módulo, e é
 * deliberadamente DIFERENTE de `fundirComProposta`
 * (lib/encomendas/origem-linha.ts): aquela função serve "recalcular a
 * proposta" — um gesto EXPLÍCITO do utilizador que aceita substituir
 * linhas PROPOSTA pelas novas (com um aviso antes). Esta função serve
 * "reabrir o que já lá estava" — nunca deve, por si só, mudar uma
 * quantidade ou apagar uma linha. Confundir as duas foi exactamente o
 * erro da revisão anterior (chamar "reconstrução total" a um restauro
 * que na prática usava `fundirComProposta` e arriscava sobrescrever
 * quantidades editadas em linhas ainda PROPOSTA).
 */
import type { ExcessoInfo, ProposalEstado, ProposalRow } from "./proposal";

/** Os campos informativos que este módulo actualiza — e nada mais. */
export type LinhaEnriquecivel = {
  produtoId: string;
  salesQty: number | null;
  avgDailySales: number | null;
  currentStock: number | null;
  coberturaAtualDias: number | null;
  pendingQty: number | null;
  estado: ProposalEstado | null;
  motivo: string | null;
  excessoFonte: ExcessoInfo[];
  semVendasNoPeriodo: boolean;
  /**
   * `true` enquanto os campos informativos acima não reflectirem um
   * cálculo fresco — nasce `true` ao reconstruir do zero (ver
   * `buildLineFromRascunho`), e só passa a `false` quando este módulo
   * encontra o produto no universo recém-calculado. NUNCA remove a
   * linha quando fica `true` — é um aviso visual para o utilizador
   * decidir (o produto pode ter sido descontinuado, retirado dos
   * filtros actuais, etc.), nunca uma remoção silenciosa.
   */
  dadosDesactualizados: boolean;
};

/**
 * Sobrepõe campos informativos frescos por produtoId. Tudo o resto de
 * `T` (quantidade final, notas, origem, farmácia, decisão de grupo,
 * chave React, ...) atravessa intocado — a assinatura genérica é o que
 * garante isso ao nível do tipo: só os campos de `LinhaEnriquecivel`
 * podem ser escritos aqui.
 *
 * Nunca adiciona nem remove linhas — o array de saída tem exactamente
 * as mesmas entradas (mesma ordem) que `persistidas`.
 */
export function enriquecerLinhasRascunho<T extends LinhaEnriquecivel>(
  persistidas: readonly T[],
  frescas: readonly ProposalRow[]
): T[] {
  const porProduto = new Map(frescas.map((r) => [r.produtoId, r]));
  return persistidas.map((linha) => {
    const fresca = porProduto.get(linha.produtoId);
    if (!fresca) {
      // Produto não voltou no recálculo (descontinuado, saiu do
      // catálogo, filtros do contexto já não o cobrem...). A linha
      // fica — decidida continua a ser decidida — só o aviso muda.
      return { ...linha, dadosDesactualizados: true };
    }
    return {
      ...linha,
      salesQty: fresca.salesQty,
      avgDailySales: fresca.avgDailySales,
      currentStock: fresca.currentStock,
      coberturaAtualDias: fresca.coberturaAtualDias,
      pendingQty: fresca.pendingQty,
      estado: fresca.estado,
      motivo: fresca.motivo,
      excessoFonte: fresca.excessoFonte,
      semVendasNoPeriodo: fresca.semVendasNoPeriodo,
      dadosDesactualizados: false,
    };
  });
}
