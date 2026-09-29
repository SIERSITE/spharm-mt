/**
 * lib/catalog/similaridade-nomes-fabricante.ts
 *
 * Correspondência textual APROXIMADA entre nomes JÁ normalizados por
 * `normalizarTitularAimGarantia` — motor GERAL, sem nenhum nome de
 * entidade concreta (Ferring/Labialfarma são só os casos reais que
 * expuseram a falta disto; o algoritmo tem de funcionar para qualquer
 * titular). Usado por `resolver-fabricante-por-cnp.ts` (regra 4-bis, ver
 * lá) para nunca propor criar um Fabricante novo sem primeiro procurar,
 * de forma robusta, se já existe uma variante textual do MESMO nome —
 * abreviaturas ("PORTUG"/"PORTUGUESA", "PROD"/"PRODUTOS"), iniciais
 * ("P F" por "Produtos Farmacêuticos"), sufixos legais, e pontuação/
 * hífen já tratados pela normalização partilhada.
 *
 * Puro, sem I/O, sem Prisma — testável com strings.
 */

/**
 * `normalizarTitularAimGarantia` mantém `-` e `&` como caracteres
 * literais (ver esse ficheiro) — aqui tratam-se como SEPARADORES de
 * token, nunca como parte de uma palavra (uma empresa "A-B" e uma
 * "A B" são a mesma sequência de tokens).
 */
export function tokenizarNomeFabricante(nomeNormalizado: string): string[] {
  return nomeNormalizado
    .split(/[\s\-&]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Comprimento mínimo do token mais curto para uma equivalência por abreviatura (prefixo) contar — evita que uma única letra capture qualquer palavra. */
const LIMIAR_PREFIXO_TOKEN = 2;

/**
 * Dois tokens são "a mesma palavra, abreviada": iguais, ou um é
 * prefixo exacto do outro com o mais curto a ter pelo menos
 * `LIMIAR_PREFIXO_TOKEN` caracteres (cobre PORTUG→PORTUGUESA,
 * PROD→PRODUTOS, FARM→FARMACEUTICOS, UN→UNIPESSOAL, SOC→SOCIEDADE).
 */
export function tokensEquivalentes(a: string, b: string): boolean {
  if (a === b) return true;
  const curto = a.length <= b.length ? a : b;
  const longo = a.length <= b.length ? b : a;
  return curto.length >= LIMIAR_PREFIXO_TOKEN && longo.startsWith(curto);
}

/**
 * Casamento bipartido guloso entre duas listas de tokens, em três
 * passagens (cada uma só usa tokens ainda por casar):
 *   1. igualdade exacta;
 *   2. abreviatura por prefixo (`tokensEquivalentes`);
 *   3. INICIAIS — um token de 1 carácter (ex.: "P", "F") casa com um
 *      token mais longo (>=3) ainda por casar que comece pela MESMA
 *      letra ("P" com "PRODUTOS", "F" com "FARMACEUTICOS"). Cobre o
 *      padrão real "P.F." para "Produtos Farmacêuticos" — sem isto,
 *      "FERRING PORTUG. - P.F. SOC. UN" (5 produtos reais) ficava
 *      abaixo do limiar só por causa de duas iniciais, apesar de ser
 *      claramente a mesma entidade.
 *
 * Devolve o NÚMERO de pares casados — nunca reutiliza um token dos
 * dois lados mais de uma vez.
 */
function contarParesCasados(tokensA: readonly string[], tokensB: readonly string[]): number {
  const usadosA = new Array(tokensA.length).fill(false);
  const usadosB = new Array(tokensB.length).fill(false);
  let pares = 0;

  const casar = (predicado: (a: string, b: string) => boolean) => {
    for (let i = 0; i < tokensA.length; i++) {
      if (usadosA[i]) continue;
      for (let j = 0; j < tokensB.length; j++) {
        if (usadosB[j]) continue;
        if (predicado(tokensA[i]!, tokensB[j]!)) {
          usadosA[i] = true;
          usadosB[j] = true;
          pares++;
          break;
        }
      }
    }
  };

  casar((a, b) => a === b);
  casar((a, b) => tokensEquivalentes(a, b));
  casar((a, b) => (a.length === 1 && b.length >= 3 && b[0] === a) || (b.length === 1 && a.length >= 3 && a[0] === b));

  return pares;
}

/**
 * Score de 0 a 1 — pares casados a dividir pelo MAIOR número de tokens
 * dos dois nomes (nunca a média/menor: um nome com palavras extra que o
 * outro não tem em NADA deve pesar contra a pontuação, não ser ignorado).
 *
 * Porta de entrada obrigatória: o PRIMEIRO token de cada nome (a marca/
 * identificador, por convenção o que vem primeiro numa denominação
 * social) tem de ser equivalente — sem isto, dois nomes CURTOS e
 * genéricos que só diferem na marca ("ACME PORTUGUESA LDA" vs "BETA
 * PORTUGUESA LDA") pontuavam alto só por partilharem palavras comuns
 * (PORTUGUESA, LDA), um falso positivo genuíno encontrado nos testes.
 * Duas entidades com a MESMA marca mas de países/formas legais
 * diferentes (ex.: Ferring Dinamarca vs Ferring Portugal) continuam a
 * passar esta porta — é o resto da pontuação, não isto, que as separa.
 */
export function calcularSimilaridadeNomes(nomeA: string, nomeB: string): number {
  const tokensA = tokenizarNomeFabricante(nomeA);
  const tokensB = tokenizarNomeFabricante(nomeB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  if (!tokensEquivalentes(tokensA[0]!, tokensB[0]!)) return 0;
  const pares = contarParesCasados(tokensA, tokensB);
  return pares / Math.max(tokensA.length, tokensB.length);
}
