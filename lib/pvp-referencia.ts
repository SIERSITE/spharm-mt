/**
 * lib/pvp-referencia.ts
 *
 * O PVP de referência de um artigo: o preço que a maioria das farmácias
 * pratica.
 *
 * ── ESTE MÓDULO PASSOU A SER UMA FACHADA ─────────────────────────────
 *
 * A regra vive agora em `lib/produtos/preco-referencia.ts`, porque não
 * tem nada de específico do PVP: é «qual é a norma do grupo e quem
 * destoa dela», e a ficha do produto passou a fazer a mesma pergunta ao
 * preço de CUSTO. Duas cópias da mesma moda — uma por coluna —
 * divergiriam no primeiro ajuste a uma delas.
 *
 * O que fica aqui são os nomes que a aplicação já usava, com a
 * terminologia do PVP. Os chamadores e o `test:pvp-referencia` não
 * mudaram; o motor por baixo é o mesmo dos restantes preços.
 *
 * Nota que se mantém: `/catalogo/artigo/[cnp]` mostra «PVP min.», que é
 * outra regra para o mesmo artigo. Não foi tocado — fica registado que
 * as duas páginas divergem de propósito e não por acidente.
 */
import {
  calcularPrecoReferencia,
  descreverPrecoReferencia,
  desvioFaceAReferencia as desvioGenerico,
  type PrecoReferencia,
} from "@/lib/produtos/preco-referencia";

/** Uma farmácia e o preço que pratica. `null` = sem preço conhecido. */
export type PrecoDeFarmacia = {
  pvp: number | null;
};

export type PvpReferencia = PrecoReferencia;

export function calcularPvpReferencia(
  linhas: ReadonlyArray<PrecoDeFarmacia>,
): PvpReferencia {
  return calcularPrecoReferencia(linhas.map((l) => l.pvp));
}

export function descreverPvpReferencia(r: PvpReferencia): string {
  // "única farmácia com preço" e não "com valor": o texto do PVP é
  // anterior ao módulo genérico e é o que o teste fixa.
  if (r.valor !== null && r.farmaciasComPreco === 1) return "única farmácia com preço";
  return descreverPrecoReferencia(r, "praticado");
}

export const desvioFaceAReferencia = desvioGenerico;
