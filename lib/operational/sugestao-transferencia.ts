/**
 * lib/operational/sugestao-transferencia.ts
 *
 * A regra de segurança das sugestões de transferência, e a escolha do
 * destino. Puro: sem I/O, sem Prisma, testável sozinho.
 *
 * ── O QUE ESTAVA ERRADO ──────────────────────────────────────────────
 *
 * Em `getExcessosData` o destino era literalmente o primeiro elemento da
 * lista das outras farmácias:
 *
 *     const others = entries.filter((e) => e.farmaciaId !== entry.farmaciaId);
 *     const destino = others.length > 0 ? others[0] : null;
 *
 * …e a quantidade sugerida nunca olhava para a necessidade dele:
 *
 *     const finalQty = Math.min(excessQty, stockOrigem);
 *
 * Daí sair, em produção, o que não faz sentido nenhum:
 *
 *   Nasalmer Spray Nasal 135ML   origem stock 25, cobertura 2250
 *                                destino stock 6, cobertura 270
 *                                excesso 25 · sugestão 25 · necessidade 0
 *
 *   Vitorange 360 Comp Eferv X20 origem stock 25 · destino stock 26
 *                                excesso 25 · sugestão 25 · necessidade 0
 *
 * O destino tinha MAIS cobertura do que precisava e recebia à mesma a
 * sugestão inteira. Não era um erro de apresentação: o número enviado
 * ao ecrã já vinha assim.
 *
 * ── A REGRA ──────────────────────────────────────────────────────────
 *
 *     sugestao = max(0, min(excessoOrigem, necessidadeDestino, stockOrigem))
 *
 * As três parcelas são independentes e nenhuma é redundante:
 *   · `excessoOrigem`     — não se transfere o que não sobra;
 *   · `necessidadeDestino`— não se entrega o que não é preciso;
 *   · `stockOrigem`       — não se transfere o que não existe na prateleira.
 *
 * Consequência directa, e é a que o operador pediu: necessidade 0 ⇒
 * sugestão 0. Excesso não implica transferência.
 */

/** Uma farmácia candidata a receber, já com as métricas calculadas. */
export type CandidatoDestino = {
  farmaciaId: string;
  farmaciaNome: string;
  stockAtual: number;
  /** Média diária de consumo na janela. 0 = sem consumo mensurável. */
  avgDaily: number;
  /**
   * Cobertura em dias, ou `null` quando não há consumo mensurável.
   *
   * `null` e não `Infinity`: um produto sem vendas não tem "cobertura
   * infinita" — não tem cobertura definida. Foi a mistura das duas
   * coisas que produziu os 2250 dias do Nasalmer, um número que é
   * aritmeticamente verdadeiro e operacionalmente inútil.
   */
  coberturaDias: number | null;
};

export type EscolhaDestino = {
  /** `null` quando nenhuma farmácia do grupo precisa deste artigo. */
  destino: CandidatoDestino | null;
  /** Necessidade do destino escolhido. 0 quando não há destino. */
  necessidadeDestino: number;
  /** A sugestão final, já com a regra de segurança aplicada. */
  quantidadeSugerida: number;
};

/**
 * Quanto é que esta farmácia precisa para chegar à cobertura-alvo.
 *
 * Zero em três casos, e cada um por uma razão diferente:
 *   · sem consumo mensurável (`avgDaily <= 0`) — não se inventa procura
 *     para justificar uma transferência. Um artigo que não vende não
 *     precisa de mais unidades, por muito baixo que seja o stock;
 *   · cobertura indefinida (`coberturaDias === null`) — mesma coisa,
 *     dita pelo outro lado;
 *   · cobertura já acima do alvo — está servido.
 */
export function necessidadeAte(
  destino: Pick<CandidatoDestino, "avgDaily" | "coberturaDias">,
  coberturaAlvoDias: number,
): number {
  const ad = Number(destino.avgDaily);
  if (!Number.isFinite(ad) || ad <= 0) return 0;
  const cob = destino.coberturaDias;
  if (cob === null || !Number.isFinite(cob)) return 0;
  if (cob >= coberturaAlvoDias) return 0;
  const falta = (coberturaAlvoDias - cob) * ad;
  if (!Number.isFinite(falta) || falta <= 0) return 0;
  return Math.round(falta);
}

/**
 * A regra de segurança. Nunca devolve mais do que qualquer uma das três
 * fronteiras, e nunca devolve negativo nem NaN.
 */
export function quantidadeSegura(
  excessoOrigem: number,
  necessidadeDestino: number,
  stockOrigem: number,
): number {
  const vals = [excessoOrigem, necessidadeDestino, stockOrigem].map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });
  return Math.max(0, Math.floor(Math.min(...vals)));
}

/**
 * Escolhe o destino pela NECESSIDADE REAL, e não pela ordem da lista.
 *
 * Critério, por esta ordem:
 *   1. só entram candidatos com necessidade > 0 — os outros não são
 *      destinos, são farmácias que por acaso têm o artigo;
 *   2. ganha a maior necessidade — é onde a transferência resolve mais;
 *   3. empate desfeito pelo nome, para a sugestão ser estável entre
 *      corridas (um destino que muda de dia para dia sem nada ter
 *      mudado destrói a confiança no relatório).
 *
 * Devolve `destino: null` quando ninguém precisa. Nesse caso a sugestão
 * é 0 e a UI não deve inventar uma farmácia.
 */
export function escolherDestino(
  candidatos: readonly CandidatoDestino[],
  opts: {
    excessoOrigem: number;
    stockOrigem: number;
    coberturaAlvoDias: number;
    /** Exclui a própria origem. */
    origemFarmaciaId?: string;
  },
): EscolhaDestino {
  const elegiveis = candidatos
    .filter((c) => c.farmaciaId !== opts.origemFarmaciaId)
    .map((c) => ({ candidato: c, necessidade: necessidadeAte(c, opts.coberturaAlvoDias) }))
    .filter((x) => x.necessidade > 0)
    .sort(
      (a, b) =>
        b.necessidade - a.necessidade ||
        a.candidato.farmaciaNome.localeCompare(b.candidato.farmaciaNome, "pt-PT"),
    );

  const melhor = elegiveis[0];
  if (!melhor) {
    return { destino: null, necessidadeDestino: 0, quantidadeSugerida: 0 };
  }
  return {
    destino: melhor.candidato,
    necessidadeDestino: melhor.necessidade,
    quantidadeSugerida: quantidadeSegura(
      opts.excessoOrigem,
      melhor.necessidade,
      opts.stockOrigem,
    ),
  };
}
