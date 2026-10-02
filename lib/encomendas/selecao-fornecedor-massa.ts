/**
 * lib/encomendas/selecao-fornecedor-massa.ts
 *
 * Regras PURAS (sem React, sem BD) da selecção e da atribuição COLECTIVA de
 * fornecedor nas linhas de uma encomenda — usadas por
 * `components/encomendas/barra-fornecedor-massa.tsx` nos três ecrãs (farmácia,
 * grupo e consolidação). Testáveis fora do browser.
 *
 * ── Âmbitos de selecção ─────────────────────────────────────────────────
 *   · primeiras N linhas visíveis (20, 30 ou N à escolha);
 *   · a página actual;
 *   · todas as linhas filtradas (as visíveis);
 *   · todas as linhas de UMA farmácia (em toda a encomenda);
 *   · todas as linhas sem fornecedor (em toda a encomenda);
 *   · toda a encomenda.
 * Cada âmbito devolve um conjunto de `key` de linha. A selecção nunca é
 * calculada em silêncio: a barra mostra sempre quantas linhas tem.
 *
 * ── O que a atribuição faz ─────────────────────────────────────────────
 * Decide o `fornecedorSugeridoId` DAS LINHAS DESTA ENCOMENDA (a escolha final,
 * persistida pelo autosave). Nunca toca em `ProdutoFarmacia.fornecedorHabitualId`
 * — o habitual só se mantém pela manutenção do catálogo.
 */

export type LinhaSelecionavel = {
  key: number;
  produtoId: string;
  farmaciaId: string | null;
  farmaciaNome: string | null;
  fornecedorSugeridoId: string | null;
};

export type ResumoAtribuicao = {
  linhas: number;
  produtosDistintos: number;
  farmacias: Array<{ farmaciaId: string | null; farmaciaNome: string; linhas: number }>;
  /** Linhas seleccionadas que hoje não têm fornecedor. */
  semFornecedor: number;
  /** Linhas que já têm o fornecedor de destino (não serão alteradas). */
  jaComDestino: number;
  /** Linhas que mudam de facto (para atribuir: ≠ destino; para limpar: as que têm fornecedor). */
  aAlterar: number;
};

export function selecionarPrimeiras(visiveis: readonly LinhaSelecionavel[], n: number): Set<number> {
  const k = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
  return new Set(visiveis.slice(0, k).map((l) => l.key));
}

export function selecionarTodas(linhas: readonly LinhaSelecionavel[]): Set<number> {
  return new Set(linhas.map((l) => l.key));
}

export function selecionarSemFornecedor(linhas: readonly LinhaSelecionavel[]): Set<number> {
  return new Set(linhas.filter((l) => l.fornecedorSugeridoId == null).map((l) => l.key));
}

export function selecionarDaFarmacia(linhas: readonly LinhaSelecionavel[], farmaciaId: string): Set<number> {
  return new Set(linhas.filter((l) => l.farmaciaId === farmaciaId).map((l) => l.key));
}

/** Alterna a página: se TODAS as linhas da página já estão seleccionadas, desselecciona-as; senão selecciona-as (mantendo o resto). */
export function alternarPagina(
  atual: ReadonlySet<number>,
  pagina: readonly LinhaSelecionavel[]
): Set<number> {
  const next = new Set(atual);
  const todas = pagina.length > 0 && pagina.every((l) => next.has(l.key));
  for (const l of pagina) {
    if (todas) next.delete(l.key);
    else next.add(l.key);
  }
  return next;
}

/** Só as linhas realmente existentes (uma linha removida deixa de contar na selecção). */
export function selecaoValida(sel: ReadonlySet<number>, linhas: readonly LinhaSelecionavel[]): LinhaSelecionavel[] {
  return linhas.filter((l) => sel.has(l.key));
}

/**
 * Resumo mostrado ANTES de aplicar. `fornecedorDestinoId === null` descreve a
 * operação «limpar fornecedor».
 */
export function resumirAtribuicao(
  selecionadas: readonly LinhaSelecionavel[],
  fornecedorDestinoId: string | null
): ResumoAtribuicao {
  const porFarmacia = new Map<string | null, { farmaciaNome: string; linhas: number }>();
  for (const l of selecionadas) {
    const g = porFarmacia.get(l.farmaciaId) ?? { farmaciaNome: l.farmaciaNome ?? "—", linhas: 0 };
    g.linhas++;
    porFarmacia.set(l.farmaciaId, g);
  }
  const semFornecedor = selecionadas.filter((l) => l.fornecedorSugeridoId == null).length;
  const jaComDestino = fornecedorDestinoId === null ? semFornecedor : selecionadas.filter((l) => l.fornecedorSugeridoId === fornecedorDestinoId).length;
  return {
    linhas: selecionadas.length,
    produtosDistintos: new Set(selecionadas.map((l) => l.produtoId)).size,
    farmacias: [...porFarmacia.entries()]
      .map(([farmaciaId, g]) => ({ farmaciaId, ...g }))
      .sort((a, b) => a.farmaciaNome.localeCompare(b.farmaciaNome)),
    semFornecedor,
    jaComDestino,
    aAlterar: selecionadas.length - jaComDestino,
  };
}

/** Quantas páginas, e a fatia de uma página (1-based). `tamanho <= 0` = tudo numa página. */
export function paginar<T>(itens: readonly T[], pagina: number, tamanho: number): { fatia: T[]; totalPaginas: number; pagina: number } {
  if (tamanho <= 0) return { fatia: [...itens], totalPaginas: 1, pagina: 1 };
  const totalPaginas = Math.max(1, Math.ceil(itens.length / tamanho));
  const p = Math.min(Math.max(1, Math.floor(pagina)), totalPaginas);
  return { fatia: itens.slice((p - 1) * tamanho, p * tamanho), totalPaginas, pagina: p };
}
