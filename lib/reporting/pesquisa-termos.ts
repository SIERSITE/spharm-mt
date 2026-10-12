/**
 * lib/reporting/pesquisa-termos.ts
 *
 * A regra de pesquisa textual de produtos — PURA e segura para componentes
 * client (sem Prisma, sem Node). É o único sítio onde se decide como um texto
 * escrito pelo utilizador vira "termos"; tanto o predicado SQL
 * (`lib/reporting/pesquisa-produto.ts`) como os refinamentos client-side
 * (`components/vendas/vendas-client.tsx`) partem daqui, para nunca voltarem a
 * divergir.
 *
 * ── Regra ────────────────────────────────────────────────────────────
 *
 *   1. normaliza: minúsculas, sem acentos (NFD, marcas combinantes
 *      U+0300..U+036F removidas);
 *   2. tudo o que não é letra nem dígito (pontuação, barras, hífens, espaços
 *      múltiplos, NBSP, tabs) separa termos;
 *   3. cada termo é obrigatório (lógica AND) e procura-se separadamente na
 *      designação, como subcadeia — "parace" encontra "PARACETAMOL";
 *   4. a ordem dos termos é irrelevante.
 *
 * Defeito que isto corrige: "parace ciclum" era procurado como a expressão
 * contígua `%parace ciclum%`, que nunca existe dentro de "PARACETAMOL CICLUM".
 */

import type { Prisma } from "@/generated/prisma/client";

/** Minúsculas e sem acentos — a forma comparável de um texto (NÃO mexe na pontuação). */
export function normalizarSemAcentos(texto: string): string {
  // \p{M} = marcas combinantes (U+0300..U+036F e afins) que o NFD separa da
  // letra base. Propriedade Unicode e não um intervalo de caracteres literais:
  // um combining char em cru no código-fonte é invisível.
  return texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Os termos de uma pesquisa: normalizados, únicos, sem vazios. `[]` para
 * texto vazio ou só pontuação.
 */
export function termosDePesquisa(pesquisa: string | null | undefined): string[] {
  const norm = normalizarSemAcentos(pesquisa ?? "");
  const termos = norm.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  return [...new Set(termos)];
}

/**
 * `true` se TODOS os termos da pesquisa aparecem em `texto` (comparação sem
 * caixa e sem acentos, subcadeia por termo). Pesquisa sem termos aceita tudo.
 *
 * É o espelho client-side do predicado SQL: compara contra o texto
 * normalizado MAS com a pontuação intacta — exactamente o que
 * `unaccent_immutable(p."designacao") ILIKE '%termo%'` faz no servidor.
 */
export function correspondeAPesquisa(texto: string, pesquisa: string | null | undefined): boolean {
  const termos = termosDePesquisa(pesquisa);
  if (termos.length === 0) return true;
  const alvo = normalizarSemAcentos(texto);
  return termos.every((t) => alvo.includes(t));
}

/**
 * Termos para pesquisas feitas por `where` do Prisma (`contains` +
 * `mode: "insensitive"`), onde NÃO há `unaccent`: separam-se pela mesma
 * regra (pontuação/espaços; únicos; sem vazios) mas MANTÊM-SE os acentos, em
 * minúsculas — o `ILIKE` do Prisma não os funde, e tirá-los faria
 * "Avène" deixar de ser encontrado por "avène". É o único sítio com
 * esta variante; o resto usa `termosDePesquisa`.
 */
export function termosDePesquisaComAcentos(pesquisa: string | null | undefined): string[] {
  const termos = (pesquisa ?? "")
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t.length > 0);
  return [...new Set(termos)];
}

/**
 * A pesquisa por termos como lista de condições `AND` de um
 * `Prisma.ProdutoWhereInput` (para os ecrãs que listam com `findMany`):
 * cada termo tem de aparecer em ALGUM dos `campos` (sem caixa); um termo só
 * de dígitos também casa com o CNP exacto. Lista vazia ⇒ sem restrição.
 * Ver `termosDePesquisaComAcentos` para a razão de manter os acentos.
 */
export function condicoesPrismaPesquisa(
  pesquisa: string | null | undefined,
  campos: ReadonlyArray<"designacao" | "dci" | "codigoATC">,
): Prisma.ProdutoWhereInput[] {
  return termosDePesquisaComAcentos(pesquisa).map((termo): Prisma.ProdutoWhereInput => {
    const ors: Prisma.ProdutoWhereInput[] = campos.map(
      (campo) => ({ [campo]: { contains: termo, mode: "insensitive" } }) as Prisma.ProdutoWhereInput,
    );
    // `Produto.cnp` é Int de 32 bits: acima disto o termo não pode ser um CNP.
    if (/^\d+$/.test(termo) && Number(termo) <= 2147483647) ors.push({ cnp: Number(termo) });
    return { OR: ors };
  });
}
