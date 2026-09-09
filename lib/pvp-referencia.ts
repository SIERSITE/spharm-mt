/**
 * lib/pvp-referencia.ts
 *
 * O PVP de referência de um artigo: o preço que a maioria das farmácias
 * pratica.
 *
 * ── PORQUE NÃO É «O PRIMEIRO» ────────────────────────────────────────
 *
 * Era. A ficha de stock escolhia a referência com
 * `pfsActive.find((pf) => pf.pvp !== null)` — a primeira linha de
 * `ProdutoFarmacia` com preço, numa consulta **sem `orderBy`**. A ordem
 * vinha do Postgres sem garantia nenhuma, portanto a farmácia que servia
 * de referência podia mudar entre dois carregamentos da mesma página.
 *
 * Enquanto o valor era só um número no cabeçalho, isso passava
 * despercebido. Deixou de passar quando a tabela por farmácia ganhou o
 * desvio face à referência: com uma baseline instável, os desvios mudam
 * de valor e de sinal sozinhos, sem nada ter mudado nos dados. Uma
 * diferença de preço que aparece e desaparece é pior do que nenhuma —
 * ensina a não confiar no ecrã.
 *
 * ── A REGRA ──────────────────────────────────────────────────────────
 *
 * A moda: o preço partilhado pelo maior número de farmácias. Empate
 * resolvido pelo mais baixo, para ser determinístico e não arbitrário.
 *
 * É a baseline que responde à pergunta que a coluna faz — «quem é que
 * destoa do grupo». Contra o mínimo, todos os desvios seriam positivos e
 * a farmácia mais barata definiria a norma sozinha; contra uma farmácia
 * fixa, a norma seria a dessa farmácia e não a do grupo.
 *
 * Nota: `/catalogo/artigo/[cnp]` mostra «PVP min.», que é outra regra
 * para o mesmo artigo. Não foi tocado — fica registado que as duas
 * páginas divergem de propósito e não por acidente.
 *
 * ── PRECISÃO ─────────────────────────────────────────────────────────
 *
 * `ProdutoFarmacia.pvp` é `Decimal(12,4)`. Agrupar por `number` em
 * vírgula flutuante juntaria ou separaria preços por acidente de
 * representação, portanto a chave do agrupamento é a string com quatro
 * casas — a mesma precisão que a coluna guarda.
 */

/** Uma farmácia e o preço que pratica. `null` = sem preço conhecido. */
export type PrecoDeFarmacia = {
  pvp: number | null;
};

export type PvpReferencia = {
  /** O preço de referência, ou `null` se nenhuma farmácia tem preço. */
  valor: number | null;
  /** Quantas farmácias praticam esse preço. */
  farmaciasComEsseValor: number;
  /** Quantas farmácias têm preço conhecido (o denominador). */
  farmaciasComPreco: number;
  /** `true` quando todas as farmácias com preço praticam o mesmo. */
  unanime: boolean;
};

const CASAS = 4;

/** A chave de agrupamento: a precisão da coluna, não a do float. */
const chave = (v: number): string => v.toFixed(CASAS);

export function calcularPvpReferencia(
  linhas: ReadonlyArray<PrecoDeFarmacia>,
): PvpReferencia {
  const precos = linhas
    .map((l) => l.pvp)
    .filter((v): v is number => v !== null && Number.isFinite(v));

  if (precos.length === 0) {
    return { valor: null, farmaciasComEsseValor: 0, farmaciasComPreco: 0, unanime: false };
  }

  const contagem = new Map<string, { valor: number; n: number }>();
  for (const p of precos) {
    const k = chave(p);
    const acc = contagem.get(k);
    if (acc) acc.n += 1;
    else contagem.set(k, { valor: p, n: 1 });
  }

  // Mais frequente primeiro; empate pelo mais baixo. Sem o desempate, a
  // ordem de inserção do Map decidia — que é a ordem das linhas, que é
  // exactamente o que esta função existe para não usar.
  const vencedor = [...contagem.values()].sort(
    (a, b) => b.n - a.n || a.valor - b.valor,
  )[0]!;

  return {
    valor: vencedor.valor,
    farmaciasComEsseValor: vencedor.n,
    farmaciasComPreco: precos.length,
    unanime: contagem.size === 1,
  };
}

/**
 * O texto que acompanha o valor no cabeçalho.
 *
 * Uma farmácia só não é uma maioria, e «praticado por 1 de 1» leria como
 * consenso quando é apenas o único dado que há.
 */
export function descreverPvpReferencia(r: PvpReferencia): string {
  if (r.valor === null) return "sem registo";
  if (r.farmaciasComPreco === 1) return "única farmácia com preço";
  if (r.unanime) return `igual nas ${r.farmaciasComPreco} farmácias`;
  return `praticado por ${r.farmaciasComEsseValor} de ${r.farmaciasComPreco} farmácias`;
}

/**
 * O desvio de uma farmácia face à referência, ou `null` quando não há
 * nada a evidenciar — sem preço, sem referência, ou preço igual.
 *
 * A comparação é feita na precisão da coluna: `4.2500` e `4.25` são o
 * mesmo preço e não devem produzir um desvio de zero visível.
 */
export function desvioFaceAReferencia(
  pvp: number | null,
  referencia: number | null,
): number | null {
  if (pvp === null || referencia === null) return null;
  if (chave(pvp) === chave(referencia)) return null;
  return pvp - referencia;
}
