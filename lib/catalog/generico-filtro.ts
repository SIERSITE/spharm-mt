/**
 * lib/catalog/generico-filtro.ts
 *
 * Filtro «Genérico» — módulo ÚNICO (puro, sem Prisma, importável no browser).
 *
 * ── Semântica de `Produto.flagGenerico` (confirmada no código) ────────────────────────────────────────────
 *
 * · `Boolean @default(false)` — NOT NULL. Não existem valores nulos na base.
 * · Origem: `dbo.Stocks.Generico` do ERP, lido pelo agent como `boolOrNull` e escrito pelo `/bootstrap/products` com
 *   `asBoolOrFalse`: um valor ausente/nulo no ERP (ou um agent que não envie o campo) fica `false`.
 *   Logo «não genérico» NÃO distingue «o ERP disse que não» de «o ERP não disse nada». Distinguir exigiria uma 2.ª coluna,
 *   que esta entrega NÃO cria (decisão explícita: Não genéricos inclui os artigos sem informação).
 * · A reconciliação INFARMED e a ficha manual (`camposManuais`) também a escrevem; o filtro lê o valor final.
 *
 * ── O filtro ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Uma escolha única com 3 estados: Todos (omissão = `undefined`, sem restrição) · `GENERICO` · `NAO_GENERICO`.
 * Aplica-se NO SERVIDOR (`restringirPorCatalogo` / `wherePrismaPorGenerico`), antes de seleção, cálculos, totais, paginação e
 * cortes, e combina por E lógico com os restantes eixos.
 */

export const VALORES_GENERICO = ["GENERICO", "NAO_GENERICO"] as const;
export type ValorGenerico = (typeof VALORES_GENERICO)[number];

export const ROTULO_GENERICO_TODOS = "Todos";
export const ROTULO_GENERICO: Record<ValorGenerico, string> = {
  GENERICO: "Apenas genéricos",
  NAO_GENERICO: "Apenas não genéricos",
};

/** Lê o valor do filtro (estado, URL, input de Server Action): só `GENERICO`/`NAO_GENERICO`; qualquer outra coisa = Todos. */
export function lerValorGenerico(entrada: unknown): ValorGenerico | undefined {
  if (Array.isArray(entrada)) entrada = entrada[0];
  return typeof entrada === "string" && (VALORES_GENERICO as readonly string[]).includes(entrada) ? (entrada as ValorGenerico) : undefined;
}

/** O valor booleano de `flagGenerico` que o filtro seleciona (`undefined` = sem restrição). */
export function flagDoFiltroGenerico(valor: unknown): boolean | undefined {
  const v = lerValorGenerico(valor);
  return v === undefined ? undefined : v === "GENERICO";
}

/** Predicado puro (listas já carregadas): `true` se o artigo passa o filtro. */
export function passaFiltroGenerico(flagGenerico: boolean | null | undefined, valor: unknown): boolean {
  const f = flagDoFiltroGenerico(valor);
  return f === undefined ? true : (flagGenerico === true) === f;
}

/** Texto do chip: «Genérico: Apenas genéricos». */
export function rotuloChipGenerico(valor: ValorGenerico): string {
  return `Genérico: ${ROTULO_GENERICO[valor]}`;
}

/** A linha «Genérico: …» dos filtros aplicados nos documentos exportados (PDF/impressão/Excel/email); `null` = Todos. */
export function filtroGenericoLinha(valor: unknown): { label: string; value: string } | null {
  const v = lerValorGenerico(valor);
  return v ? { label: "Genérico", value: ROTULO_GENERICO[v] } : null;
}
