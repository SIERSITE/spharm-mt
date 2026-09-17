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

/**
 * Secção 6 do pedido: nunca confirmar uma manutenção com uma farmácia
 * que tem quantidade atribuída mas nenhum PVP de referência válido —
 * isso gravaria, silenciosamente, um valor bruto `null`/inventado.
 *
 * Devolve os IDs das farmácias em falta, na ordem em que apareceram —
 * a UI usa isto para apontar exactamente onde falta o preço, nunca só
 * "há um problema".
 */
export function validarPvpReferencia(
  celulas: readonly { farmaciaId: string; quantidade: number }[],
  farmaciasPvp: readonly { farmaciaId: string; pvpReferencia: number | null }[],
): { ok: boolean; farmaciasSemPvp: string[] } {
  const pvpPorFarmacia = new Map(farmaciasPvp.map((f) => [f.farmaciaId, f.pvpReferencia]));
  const totalPorFarmacia = new Map<string, number>();
  for (const c of celulas) {
    totalPorFarmacia.set(c.farmaciaId, (totalPorFarmacia.get(c.farmaciaId) ?? 0) + c.quantidade);
  }

  const farmaciasSemPvp: string[] = [];
  for (const [farmaciaId, total] of totalPorFarmacia) {
    if (total <= 0) continue;
    const pvp = pvpPorFarmacia.get(farmaciaId) ?? null;
    if (pvp === null) farmaciasSemPvp.push(farmaciaId);
  }
  return { ok: farmaciasSemPvp.length === 0, farmaciasSemPvp };
}
