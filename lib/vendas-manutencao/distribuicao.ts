/**
 * lib/vendas-manutencao/distribuicao.ts
 *
 * Repartição determinística de uma quantidade INTEIRA por várias
 * "partes" (farmácias, ou meses) segundo pesos — nunca perde nem
 * acrescenta unidade nenhuma por arredondamento (regra 1.6 do pedido).
 *
 * Quantidades são `Int` (ver `VendaManutencao.quantidadeTotal` no
 * schema — decisão alinhada com o comportamento EFECTIVO do loader do
 * mapa de Vendas, que já arredonda tudo a inteiro antes de somar), por
 * isso este módulo trabalha directamente em UNIDADES inteiras — sem a
 * conversão para milésimos que uma quantidade fraccionária exigiria.
 *
 * ── O método: maior resto (Hamilton) ─────────────────────────────────
 *
 * 1. Cada parte recebe `floor(total × peso / Σpeso)`.
 * 2. O que sobra (sempre um inteiro, nunca mais que o número de partes)
 *    vai, uma unidade de cada vez, para as partes com a MAIOR parte
 *    fraccionária perdida no passo 1 — empate desfeito pela ordem de
 *    entrada, nunca pela sorte do algoritmo de ordenação.
 *
 * Puro — sem Prisma, sem `server-only`, sem React. Testável com arrays.
 */

export type ParteComPeso<T> = { chave: T; peso: number };
export type ParteDistribuida<T> = { chave: T; quantidade: number };

/**
 * Reparte `totalUnidades` (inteiro) pelas `partes`, proporcionalmente
 * ao `peso` de cada uma. Pesos não precisam de somar 1 — são
 * normalizados aqui.
 *
 * Se NENHUMA parte tiver peso > 0 (soma de pesos = 0), reparte-se em
 * partes IGUAIS — nunca "ninguém recebe nada só porque ninguém tinha
 * histórico". Quem decide se isso é aceitável ou se deve pedir
 * distribuição manual é o chamador (ver `peso.ts::calcularPesosFarmacia`,
 * que sinaliza explicitamente "sem histórico" para essa decisão).
 */
export function distribuirPorMaiorResto<T>(
  totalUnidades: number,
  partes: readonly ParteComPeso<T>[],
): ParteDistribuida<T>[] {
  if (partes.length === 0) return [];

  const somaPesos = partes.reduce((s, p) => s + Math.max(0, p.peso), 0);
  if (somaPesos <= 0) {
    return distribuirPorMaiorResto(totalUnidades, partes.map((p) => ({ ...p, peso: 1 })));
  }

  const total = Math.round(totalUnidades);
  const brutos = partes.map((p) => (total * Math.max(0, p.peso)) / somaPesos);
  const bases = brutos.map((b) => Math.floor(b));
  const somaBases = bases.reduce((s, b) => s + b, 0);
  let restoAAtribuir = total - somaBases;

  const fraccoes = brutos.map((b, i) => b - bases[i]);
  const ordemPorFraccao = partes
    .map((_, i) => i)
    .sort((a, b) => fraccoes[b] - fraccoes[a] || a - b);

  const resultado = [...bases];
  for (let i = 0; i < ordemPorFraccao.length && restoAAtribuir > 0; i++) {
    resultado[ordemPorFraccao[i]] += 1;
    restoAAtribuir--;
  }

  return partes.map((p, i) => ({ chave: p.chave, quantidade: resultado[i] }));
}

/** Um mês civil — `{ ano, mes: 1..12 }`. */
export type MesCivil = { ano: number; mes: number };

/** `numMeses` meses consecutivos a partir de `(anoInicial, mesInicial)`, inclusive. */
export function gerarMesesConsecutivos(
  anoInicial: number,
  mesInicial: number,
  numMeses: number,
): MesCivil[] {
  const out: MesCivil[] = [];
  let ano = anoInicial;
  let mes = mesInicial;
  for (let i = 0; i < numMeses; i++) {
    out.push({ ano, mes });
    mes++;
    if (mes > 12) {
      mes = 1;
      ano++;
    }
  }
  return out;
}

/**
 * Reparte a quantidade de UMA farmácia pelos `numMeses` a partir do mês
 * inicial — sempre em partes IGUAIS entre meses (ver secção 1.3 do
 * pedido: "depois de determinada a parte de cada farmácia, essa
 * quantidade deve ser distribuída pelo número de meses indicado" — sem
 * peso nenhum entre meses, ao contrário da distribuição por farmácia).
 */
export function distribuirPorMeses(
  quantidade: number,
  anoInicial: number,
  mesInicial: number,
  numMeses: number,
): (MesCivil & { quantidade: number })[] {
  const meses = gerarMesesConsecutivos(anoInicial, mesInicial, numMeses);
  const distribuido = distribuirPorMaiorResto(
    quantidade,
    meses.map((_, i) => ({ chave: i, peso: 1 })),
  );
  return meses.map((m, i) => ({ ...m, quantidade: distribuido[i].quantidade }));
}
