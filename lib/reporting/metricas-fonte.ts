/**
 * lib/reporting/metricas-fonte.ts
 *
 * Larguras REAIS de glifo (em milésimos de em) da Arial / Helvetica, normal e negrito. O Mapa de Vendas fixa o tipo de letra
 * `Arial, "Liberation Sans", Helvetica` (report-html.ts): a Liberation Sans (a que o Chromium do contentor usa, pacote
 * fonts-liberation) é métrica-compatível com a Arial, por isso estas larguras valem no Windows, no macOS e no Linux e a largura
 * das colunas pode ser calculada a partir dos DADOS (nº de dígitos do maior valor, sinal, separador de milhares) em vez de uma
 * estimativa por excesso. Função PURA, sem DOM.
 *
 * Fonte dos valores: tabelas AFM da Helvetica / Helvetica-Bold (idênticas às da Arial / Arial Bold). As letras acentuadas têm a
 * largura da letra base; o espaço (incluindo o de milhares U+00A0 / U+202F) mede 278; «€» mede 556; «·» (ponto médio) 278.
 */

const NORMAL: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191, "(": 333, ")": 333, "*": 389, "+": 584, ",": 278,
  "-": 333, ".": 278, "/": 278, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556, "@": 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667,
  Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  "[": 278, "\\": 278, "]": 278, "^": 469, "_": 556, "`": 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556,
  q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, "{": 334, "|": 260, "}": 334, "~": 584,
};

const NEGRITO: Record<string, number> = {
  " ": 278, "!": 333, '"': 474, "#": 556, "$": 556, "%": 889, "&": 722, "'": 238, "(": 333, ")": 333, "*": 389, "+": 584, ",": 278,
  "-": 333, ".": 278, "/": 278, ":": 333, ";": 333, "<": 584, "=": 584, ">": 584, "?": 611, "@": 975,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667,
  Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  "[": 333, "\\": 278, "]": 333, "^": 584, "_": 556, "`": 333,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889, n: 611, o: 611, p: 611,
  q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500, "{": 389, "|": 280, "}": 389, "~": 584,
};

for (const d of "0123456789") { NORMAL[d] = 556; NEGRITO[d] = 556; }

const ESPACOS = /[\s  ]/;

/** Largura (em milésimos de em) de um carácter; o que não está na tabela conta como uma maiúscula larga (por excesso). */
function larguraGlifo(ch: string, negrito: boolean): number {
  const t = negrito ? NEGRITO : NORMAL;
  if (ESPACOS.test(ch)) return 278;
  if (ch === "€") return 556;
  if (ch === "·" || ch === "•") return 278;
  if (ch === "–" || ch === "−") return 556; // travessão/sinal de menos: 556
  if (ch === "—") return 1000;
  const direto = t[ch];
  if (direto !== undefined) return direto;
  // letra acentuada: a largura da letra base
  const base = ch.normalize("NFD").charAt(0);
  const viaBase = t[base];
  if (viaBase !== undefined) return viaBase;
  return 778;
}

/** Largura em px CSS de um texto numa só linha, a `fontPx` px, normal ou em negrito. Exata para Arial/Liberation Sans. */
export function larguraTextoPx(texto: string, fontPx: number, negrito = false): number {
  let milesimos = 0;
  for (const ch of texto) milesimos += larguraGlifo(ch, negrito);
  return (milesimos / 1000) * fontPx;
}
