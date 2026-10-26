/**
 * lib/reporting/vendas-pvp-diferente.ts
 *
 * Filtro «Apenas artigos com PVP diferente entre farmácias» do mapa de Vendas — regra pura, partilhada pela tabela, pelo
 * Relatório, pela impressão, pelo PDF, pelo Excel e pelo email (todos derivam das mesmas linhas já filtradas).
 *
 * Um artigo entra quando, considerando APENAS as farmácias selecionadas:
 *   1. está associado a pelo menos duas delas (existe ficha `ProdutoFarmacia` em ≥ 2);
 *   2. existem pelo menos dois PVP CONHECIDOS (PVP em falta — nulo ou ≤ 0 — não conta nem se compara);
 *   3. existem pelo menos dois valores diferentes.
 *
 * O PVP comparado é o ATUAL de cada farmácia (`ProdutoFarmacia.pvp`), nunca o histórico das vendas (`valorBruto`) nem a cascata
 * para o PMC. Compara-se à precisão com que a base guarda o preço (Decimal(12,4)): 4 casas decimais, em inteiros (sem erros de
 * vírgula flutuante). O PVP nunca é alterado nem «corrigido»: não se escolhe um preço «certo».
 */

/** Escala do PVP na base (Decimal(12,4)). */
const ESCALA = 10_000;

/** O mínimo que uma linha de vendas tem de ter para entrar na comparação. */
export type LinhaParaPvp = {
  codigo: string;
  farmacia: string;
  pvpConhecido?: number | null;
  pvpPorFarmacia?: Record<string, number | null>;
};

/** PVP como inteiro na escala da base — `null` se desconhecido (nulo, ≤ 0 ou não numérico). */
export function pvpEscalado(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * ESCALA);
}

/**
 * A regra para UM artigo: `pvps` = PVP por farmácia (a chave presente com `null` = associado mas sem PVP); `selecionadas` = as
 * farmácias que contam.
 */
export function artigoTemPvpDiferente(pvps: Readonly<Record<string, number | null>>, selecionadas: readonly string[]): boolean {
  const conjunto = new Set(selecionadas);
  let associadas = 0;
  const conhecidos = new Set<number>();
  let nConhecidos = 0;
  for (const [farmacia, valor] of Object.entries(pvps)) {
    if (!conjunto.has(farmacia)) continue;
    associadas += 1;
    const e = pvpEscalado(valor);
    if (e !== null) {
      nConhecidos += 1;
      conhecidos.add(e);
    }
  }
  return associadas >= 2 && nConhecidos >= 2 && conhecidos.size >= 2;
}

/** Junta, por CNP, o PVP de cada farmácia vindo de `pvpPorFarmacia` e do `pvpConhecido` da própria linha. */
export function pvpsPorCodigo(linhas: readonly LinhaParaPvp[]): Map<string, Record<string, number | null>> {
  const porCodigo = new Map<string, Record<string, number | null>>();
  for (const l of linhas) {
    const mapa = porCodigo.get(l.codigo) ?? {};
    if (l.pvpPorFarmacia) for (const [f, v] of Object.entries(l.pvpPorFarmacia)) if (!(f in mapa) || mapa[f] === null) mapa[f] = v;
    if (l.pvpConhecido !== undefined && (!(l.farmacia in mapa) || mapa[l.farmacia] === null)) mapa[l.farmacia] = l.pvpConhecido;
    porCodigo.set(l.codigo, mapa);
  }
  return porCodigo;
}

/** Os CNP que passam o filtro, para as farmácias selecionadas. Calculado sobre as linhas CRUAS (antes de qualquer outro filtro). */
export function codigosComPvpDiferente(linhas: readonly LinhaParaPvp[], selecionadas: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const [codigo, pvps] of pvpsPorCodigo(linhas)) if (artigoTemPvpDiferente(pvps, selecionadas)) out.add(codigo);
  return out;
}

/** O filtro só se aplica com pelo menos duas farmácias selecionadas (com uma só não há com quem comparar). */
export function filtroPvpAplicavel(nFarmaciasEfetivas: number): boolean {
  return nFarmaciasEfetivas >= 2;
}
