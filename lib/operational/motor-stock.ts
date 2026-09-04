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
  /** Acima desta cobertura há excesso. Default do chamador (180). */
  thresholdDays: number;
  /** Cobertura-alvo: o que sobra acima disto é o excesso. Default 30. */
  targetDays: number;
  /**
   * Excessos abaixo disto são ruído e contam como 0.
   *
   * Existia como `if (excessQty < 5) continue` dentro dos Excessos.
   * Passa a ser um parâmetro para os testes o poderem anular e medirem
   * a matemática sem o corte comercial pelo meio.
   */
  excessoMinimo?: number;
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

  return {
    ...linha,
    avgDaily,
    coberturaDias,
    excesso,
    // A mesma função que a escolha de destino usa. Um sítio só.
    necessidade: necessidadeAte({ avgDaily, coberturaDias }, params.targetDays),
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
export function emparelhar<T extends LinhaStock>(
  origem: EstadoStock<T>,
  grupo: readonly EstadoStock<T>[],
): Emparelhamento<T> {
  const candidatos = grupo
    .filter((c) => c.farmaciaId !== origem.farmaciaId)
    .filter((c) => c.necessidade > 0)
    .sort(
      (a, b) =>
        b.necessidade - a.necessidade ||
        a.farmaciaNome.localeCompare(b.farmaciaNome, "pt-PT"),
    );

  const destino = candidatos[0] ?? null;
  if (!destino) {
    return { origem, destino: null, necessidadeDestino: 0, quantidadeSugerida: 0 };
  }

  return {
    origem,
    destino,
    necessidadeDestino: destino.necessidade,
    quantidadeSugerida: quantidadeSegura(
      origem.excesso,
      destino.necessidade,
      origem.stockAtual,
    ),
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
