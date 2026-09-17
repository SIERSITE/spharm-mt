/**
 * lib/vendas-manutencao/validacao.ts
 *
 * A validação obrigatória de uma matriz farmácia × mês antes de gravar
 * (secção 1.5 do pedido): a soma de TODAS as células tem de bater
 * exactamente com a quantidade total definida. Nunca gravar enquanto
 * houver diferença.
 *
 * `EPSILON` cobre só o erro de representação de ponto flutuante do
 * `number` do JS (ex.: 0.1 + 0.2), nunca uma diferença real de
 * arredondamento de unidades — essas já não acontecem se a matriz saiu
 * de `distribuicao.ts`, mas esta função tem de validar também matrizes
 * editadas à mão, onde uma diferença real É o caso normal a apanhar.
 */
const EPSILON = 1e-6;

export function somaQuantidades(celulas: readonly { quantidade: number }[]): number {
  return celulas.reduce((s, c) => s + c.quantidade, 0);
}

export type ResultadoValidacaoSoma = {
  ok: boolean;
  soma: number;
  quantidadeTotal: number;
  /** `soma - quantidadeTotal`. Positivo = a mais; negativo = a menos. */
  diferenca: number;
};

/** A validação central: `Σ células === quantidadeTotal`, sem excepção. */
export function validarSomaTotal(
  celulas: readonly { quantidade: number }[],
  quantidadeTotal: number,
): ResultadoValidacaoSoma {
  const soma = somaQuantidades(celulas);
  const diferenca = Math.round((soma - quantidadeTotal) * 1000) / 1000;
  return { ok: Math.abs(diferenca) < EPSILON, soma, quantidadeTotal, diferenca };
}
