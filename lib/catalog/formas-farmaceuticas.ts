/**
 * lib/catalog/formas-farmaceuticas.ts
 *
 * O vocabulário FECHADO de formas farmacêuticas.
 *
 * ── De onde veio esta lista ──────────────────────────────────────────
 *
 * NÃO foi inventada. Saiu do que já está gravado no catálogo global, a
 * 2026-09-03:
 *
 *     select valor, count(*) from "CatalogoGlobalClinica"
 *      where campo = 'FORMA_FARMACEUTICA' group by 1 order by 2 desc
 *
 *     2 777 valores · 141 distintos
 *     os 66 com 3+ ocorrências cobrem 96,6%
 *
 * A cauda são variantes de escrita da mesma coisa («solução injetável em
 * seringa pré-enchida»), composições raras («pó e veículo para suspensão
 * injetável de libertação prolongada») e ruído. Uma lista fechada que a
 * abraçasse toda deixaria de ser vocabulário e passaria a ser inventário.
 *
 * ── Porque é fechada ─────────────────────────────────────────────────
 *
 * Pela mesma razão que a taxonomia de categorias é fechada: um valor
 * fora da lista é DESCARTADO, não corrigido. Duas grafias da mesma forma
 * — «comprimido revestido» e «comprimido revestido, oral» — não são um
 * problema estético: são dois valores num campo que a jusante se lê como
 * facto, e que ninguém volta a reconciliar.
 *
 * O `normalizarForma` faz UMA coisa antes de decidir: aparar, minúsculas
 * e resolver um punhado de sinónimos MEDIDOS (não hipotéticos, cada um
 * observado na tabela acima). Tudo o resto que não esteja na lista sai
 * `null`, e `null` não se escreve.
 */

/**
 * As formas canónicas. Ordem alfabética por família para se ler; o
 * conjunto é o que decide.
 *
 * Acrescentar uma forma aqui é uma decisão, não um remendo: passa a ser
 * escrevível em todos os tenants e a valer como facto sobre o produto
 * nacional. O critério para entrar é o mesmo que produziu a lista —
 * aparecer no catálogo, medida, e não «fazer sentido».
 */
export const FORMAS_CANONICAS: readonly string[] = [
  // ── orais sólidas ──────────────────────────────────────────────
  "comprimido",
  "comprimido revestido",
  "comprimido revestido por película",
  "comprimido de libertação prolongada",
  "comprimido de libertação modificada",
  "comprimido gastrorresistente",
  "comprimido orodispersível",
  "comprimido efervescente",
  "comprimido dispersível",
  "comprimido mastigável",
  "comprimido sublingual",
  "comprimido vaginal",
  "comprimido para chupar",
  "cápsula",
  "cápsula mole",
  "cápsula gastrorresistente",
  "cápsula de libertação prolongada",
  "cápsula de libertação modificada",
  "cápsula para inalação",
  "pastilha",
  "liofilizado oral",
  // ── granulados e pós ───────────────────────────────────────────
  "granulado",
  "granulado para solução oral",
  "granulado para suspensão oral",
  "pó",
  "pó cutâneo",
  "pó para solução oral",
  "pó para suspensão oral",
  "pó para inalação",
  "pó para solução injetável",
  "pó e solvente para solução injetável",
  "pó e veículo para suspensão injetável",
  // ── líquidas orais ─────────────────────────────────────────────
  "solução oral",
  "suspensão oral",
  "xarope",
  "gotas orais",
  "tintura",
  // ── injetáveis ─────────────────────────────────────────────────
  "solução injetável",
  "solução injetável em caneta pré-cheia",
  "solução injetável em seringa pré-cheia",
  "suspensão injetável",
  "suspensão injetável de libertação prolongada",
  "solução para perfusão",
  // ── inalação e pulverização ────────────────────────────────────
  "solução para inalação",
  "suspensão pressurizada para inalação",
  "aerossol para inalação",
  "solução para pulverização nasal",
  "solução para pulverização cutânea",
  "solução para pulverização bucal",
  // ── cutâneas e mucosas ─────────────────────────────────────────
  "creme",
  "creme vaginal",
  "gel",
  "gel vaginal",
  "gel oral",
  "pomada",
  "pomada oftálmica",
  "solução cutânea",
  "emulsão cutânea",
  "espuma cutânea",
  "colírio",
  "supositório",
  "adesivo transdérmico",
  "sistema transdérmico",
  "emplastro medicamentoso",
  // ── dispositivos ───────────────────────────────────────────────
  "dispositivo intrauterino",
  "sistema de libertação vaginal",
];

const CANONICAS = new Set(FORMAS_CANONICAS);

/**
 * Sinónimos MEDIDOS. Cada entrada foi observada no catálogo com a
 * contagem ao lado — não são grafias imaginadas.
 *
 * A regra para entrar aqui é estreita: as duas grafias têm de designar
 * exactamente a mesma forma. «comprimido dispersível/mastigável» NÃO
 * entra — são duas formas, e escolher uma delas seria inventar metade
 * da resposta.
 */
const SINONIMOS: Readonly<Record<string, string>> = {
  "comprimido para mastigar": "comprimido mastigável", // 7 ocorrências
  "solução oral em gotas": "gotas orais", //                3
  "pó para solução oral (saqueta)": "pó para solução oral", // 3
  "solução injetável em seringa pré-enchida": "solução injetável em seringa pré-cheia", // 1
  "cápsulas de libertação prolongada": "cápsula de libertação prolongada", //             1
};

/**
 * O valor canónico de uma forma, ou `null`.
 *
 * `null` é uma resposta legítima e frequente — significa «isto não é uma
 * forma que este catálogo reconheça», e o que se faz a seguir é não
 * escrever. Nunca devolve um palpite aproximado: não há distância de
 * edição nem prefixo, porque «solução oral» e «solução cutânea»
 * distam duas letras e não têm nada a ver uma com a outra.
 */
export function normalizarForma(bruto: string | null | undefined): string | null {
  if (typeof bruto !== "string") return null;
  const limpo = bruto
    .trim()
    .toLowerCase()
    // Espaços repetidos e pontuação final: o modelo devolve «comprimido.»
    // com a mesma facilidade com que devolve «comprimido».
    .replace(/\s+/g, " ")
    .replace(/[.;,]+$/, "")
    .trim();
  if (!limpo) return null;
  const resolvido = SINONIMOS[limpo] ?? limpo;
  return CANONICAS.has(resolvido) ? resolvido : null;
}

/** `true` se o valor já é canónico. Para o gate, que não normaliza. */
export function ehFormaCanonica(valor: string | null | undefined): boolean {
  return typeof valor === "string" && CANONICAS.has(valor);
}

/**
 * O vocabulário como texto, para o prompt.
 *
 * Uma forma por linha, sem numeração nem comentários: é a lista que o
 * modelo tem de copiar à letra, e cada caractere a mais é um caractere
 * que ele pode devolver por engano.
 */
export function construirVocabularioFormas(): string {
  return FORMAS_CANONICAS.join("\n");
}
