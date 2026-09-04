/**
 * lib/operational/motor-stock.ts
 *
 * O motor único de Excessos e Transferências.
 *
 * ── Porque existe ────────────────────────────────────────────────────
 *
 * Havia dois motores matemáticos independentes para a mesma pergunta.
 *
 *   /excessos       consumo da janela escolhida · cobertura · excesso
 *   /transferencias IPF de 90 dias · heurística de rácio de cobertura
 *                   (`origem.coverage < 20`, `destino.coverage > 20`,
 *                   `origem/destino < 2.5`)
 *
 * Dois números diferentes para o mesmo artigo, no mesmo dia, sem que
 * nenhum dos ecrãs dissesse porquê. E como as janelas também eram
 * diferentes (12 meses num, 3 meses no outro), nem sequer era possível
 * comparar.
 *
 * ── A separação que este módulo torna explícita ───────────────────────
 *
 * EXCESSO é uma propriedade da FARMÁCIA ORIGEM, e de mais nada:
 *
 *     excesso = stock acima do objectivo de cobertura
 *
 * Existe quer alguém precise do artigo, quer não. Um armazém com stock
 * a mais continua a ter stock a mais quando o resto do grupo também
 * tem — aliás, é precisamente aí que o problema é maior.
 *
 * NECESSIDADE é uma propriedade da FARMÁCIA DESTINO, e de mais nada.
 *
 * SUGESTÃO é o cruzamento das duas, e só existe quando as duas existem.
 *
 * Daí a regra funcional que este módulo garante e que os dois relatórios
 * herdam:
 *
 *   /excessos        filtra  excesso > 0                    (diagnóstico)
 *   /transferencias  filtra  excesso > 0 E sugestão > 0     (operação)
 *
 * Transferências é um SUBCONJUNTO de Excessos. Nunca o contrário, e
 * nunca um conjunto disjunto.
 */

import { necessidadeAte, quantidadeSegura } from "./sugestao-transferencia";

/** Cobertura em dias, ou `null` quando não há consumo mensurável. */
export function coberturaDe(stockAtual: number, avgDaily: number): number | null {
  const s = Number(stockAtual);
  const a = Number(avgDaily);
  if (!Number.isFinite(s) || !Number.isFinite(a) || a <= 0) return null;
  return s / a;
}

/** Média diária sobre a janela. Nunca divide por zero. */
export function mediaDiaria(quantidadeJanela: number, diasJanela: number): number {
  const q = Number(quantidadeJanela);
  const d = Number(diasJanela);
  if (!Number.isFinite(q) || !Number.isFinite(d) || d <= 0 || q <= 0) return 0;
  return q / d;
}

export type ParametrosMotor = {
  /** Denominador da média diária. Vem de `diasDaJanela`. */
  diasJanela: number;
  /** Acima desta cobertura há excesso. Default do chamador (120). */
  thresholdDays: number;
  /** Cobertura-alvo: o que sobra acima disto é o excesso. Default 45. */
  targetDays: number;
  /**
   * Excessos abaixo disto são ruído e contam como 0.
   *
   * Existia como `if (excessQty < 5) continue` dentro dos Excessos.
   * Passa a ser um parâmetro para os testes o poderem anular e medirem
   * a matemática sem o corte comercial pelo meio.
   */
  excessoMinimo?: number;
  /**
   * Dias de cobertura que a ORIGEM tem de conservar. A quantidade
   * transferível passa a ser limitada também por
   * `floor(stock − reservaDias × média)`.
   *
   * Omitir é o mesmo que 0 — mas nenhum relatório oficial o omite; ver
   * RESERVA_ORIGEM_DIAS em metrics-shared.
   */
  reservaDias?: number;
};

/** Uma linha (produto × farmácia) antes de ser avaliada. */
export type LinhaStock = {
  farmaciaId: string;
  farmaciaNome: string;
  stockAtual: number;
  /** Unidades vendidas DENTRO da janela. */
  vendasJanela: number;
};

export type EstadoStock<T extends LinhaStock = LinhaStock> = T & {
  avgDaily: number;
  coberturaDias: number | null;
  /** Unidades acima do objectivo. 0 quando não há excesso. */
  excesso: number;
  /** Unidades em falta para chegar ao objectivo. 0 quando não faltam. */
  necessidade: number;
  /**
   * Tecto do que esta linha pode ceder sem violar a reserva:
   * `floor(stock − reservaDias × média)`.
   *
   * Vive aqui, e não é recalculado no emparelhamento, porque depende
   * apenas da linha. Sem reserva é o stock inteiro, que era o
   * comportamento anterior.
   */
  transferivel: number;
};

/**
 * Avalia uma linha: consumo → cobertura → excesso E necessidade.
 *
 * As duas últimas são calculadas SEMPRE, para a mesma linha. Uma
 * farmácia é candidata a origem e a destino ao mesmo tempo, e é o
 * relatório que decide qual dos papéis lhe interessa. Calcular só um
 * deles aqui obrigava cada chamador a recalcular o outro — que foi
 * exactamente como os dois motores divergiram.
 */
export function avaliarLinha<T extends LinhaStock>(
  linha: T,
  params: ParametrosMotor,
): EstadoStock<T> {
  const avgDaily = mediaDiaria(linha.vendasJanela, params.diasJanela);
  const coberturaDias = coberturaDe(linha.stockAtual, avgDaily);
  const minimo = params.excessoMinimo ?? 0;

  let excesso = 0;
  if (coberturaDias !== null && coberturaDias > params.thresholdDays && avgDaily > 0) {
    const bruto = Math.round((coberturaDias - params.targetDays) * avgDaily);
    excesso = bruto >= minimo && bruto > 0 ? bruto : 0;
  }

  // `floor`, nunca `round`: arredondar para cima aqui devolveria à
  // origem exactamente a meia unidade que a reserva existe para
  // proteger. Sem reserva o tecto é o stock, como sempre foi.
  const reserva = params.reservaDias ?? 0;
  const transferivel =
    reserva > 0
      ? Math.max(0, Math.floor(linha.stockAtual - reserva * avgDaily))
      : linha.stockAtual;

  return {
    ...linha,
    avgDaily,
    coberturaDias,
    excesso,
    // A mesma função que a escolha de destino usa. Um sítio só.
    necessidade: necessidadeAte({ avgDaily, coberturaDias }, params.targetDays),
    transferivel,
  };
}

/** `avaliarLinha` sobre um grupo (todas as farmácias de um produto). */
export function avaliarGrupo<T extends LinhaStock>(
  linhas: readonly T[],
  params: ParametrosMotor,
): EstadoStock<T>[] {
  return linhas.map((l) => avaliarLinha(l, params));
}

/** As linhas que entram no relatório de EXCESSOS: excesso > 0, e nada mais. */
export function apenasComExcesso<T extends LinhaStock>(
  estados: readonly EstadoStock<T>[],
): EstadoStock<T>[] {
  return estados.filter((e) => e.excesso > 0);
}

export type Emparelhamento<T extends LinhaStock> = {
  origem: EstadoStock<T>;
  /** `null` quando nenhuma farmácia do grupo precisa deste artigo. */
  destino: EstadoStock<T> | null;
  necessidadeDestino: number;
  quantidadeSugerida: number;
};

/**
 * Cruza uma origem com o melhor destino possível dentro do mesmo grupo.
 *
 * Critério do destino, por esta ordem: maior necessidade; empate
 * desfeito pelo nome, para a sugestão não mudar entre duas corridas sem
 * nada ter mudado nos dados.
 *
 * Devolve sempre um emparelhamento — mesmo sem destino. É o chamador que
 * decide o que fazer com `destino: null`:
 *
 *   Excessos       mostra a linha, com destino vazio e sugestão 0
 *   Transferências descarta a linha
 *
 * É esta a única diferença entre os dois relatórios.
 */
export function ehDestinoElegivel<T extends LinhaStock>(c: EstadoStock<T>): boolean {
  return c.avgDaily > 0 && c.necessidade > 0;
}

export function emparelhar<T extends LinhaStock>(
  origem: EstadoStock<T>,
  grupo: readonly EstadoStock<T>[],
): Emparelhamento<T> {
  // ── Elegibilidade de destino ─────────────────────────────────────
  //
  // As duas condicoes, e as duas explicitas:
  //
  //   avgDaily > 0     a farmacia CONSOME o artigo
  //   necessidade > 0  e consome mais do que aquilo que tem
  //
  // A segunda ja' implica a primeira hoje (`necessidadeAte` devolve 0
  // sem consumo mensuravel), mas escrever so' uma delas fazia a regra
  // depender de um detalhe de outra funcao. Stock 0 NAO e' necessidade:
  // uma farmacia que nunca vendeu o artigo continua a nao precisar dele,
  // por muito vazia que a prateleira esteja.
  const candidatos = grupo
    .filter((c) => c.farmaciaId !== origem.farmaciaId)
    .filter(ehDestinoElegivel)
    .sort(
      (a, b) =>
        b.necessidade - a.necessidade ||
        a.farmaciaNome.localeCompare(b.farmaciaNome, "pt-PT"),
    );

  const semDestino: Emparelhamento<T> = {
    origem,
    destino: null,
    necessidadeDestino: 0,
    quantidadeSugerida: 0,
  };

  const destino = candidatos[0] ?? null;
  if (!destino) return semDestino;

  // A terceira fronteira era `origem.stockAtual`. Passa a ser o tecto
  // que já desconta a reserva — a mudança está toda em `avaliarLinha`,
  // e esta função continua a não saber o que é uma reserva.
  const quantidadeSugerida = quantidadeSegura(
    origem.excesso,
    destino.necessidade,
    origem.transferivel,
  );

  // ── Sugestao 0 ⇒ destino null ────────────────────────────────────
  //
  // Chega-se aqui quando ha' necessidade real mas a regra de seguranca
  // corta a quantidade a zero — na pratica, quando o stock da origem
  // arredonda para 0. Mostrar uma farmacia na coluna "Destino poss."
  // ao lado de uma sugestao de 0 unidades e' anunciar uma transferencia
  // que nao existe.
  if (quantidadeSugerida <= 0) return semDestino;

  return {
    origem,
    destino,
    necessidadeDestino: destino.necessidade,
    quantidadeSugerida,
  };
}

/**
 * O relatório de TRANSFERÊNCIAS: as linhas accionáveis.
 *
 * As três condições são conjuntas e nenhuma é redundante — há excesso
 * sem necessidade (o caso comum), e há necessidade que a regra de
 * segurança corta a 0 por falta de stock na origem.
 */
export function ehAccionavel<T extends LinhaStock>(p: Emparelhamento<T>): boolean {
  return p.origem.excesso > 0 && p.necessidadeDestino > 0 && p.quantidadeSugerida > 0;
}
