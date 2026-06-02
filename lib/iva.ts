/**
 * lib/iva.ts
 *
 * Normalização canónica da taxa IVA em produtos de farmácia.
 *
 * Regra de negócio (PT — actualizada 2026-06-02): taxas válidas em
 * produtos de farmácia são apenas **{0, 6, 13, 23}**. Tudo o resto
 * (taxas históricas 5/7/8/12/16/17/19/21, valores residuais, ruído)
 * cai em "IVA por apurar" — NÃO há um bucket "Outras taxas".
 *
 * 0% é taxa válida (isento), distinto de "por apurar" (taxa desconhecida).
 * O recuperador, o JOIN dbo.IVA do agent e os relatórios tratam todos
 * o 0 como bucket próprio.
 *
 * Escala defensiva: aceita fracção (0..1) ou percentagem (0..100). O
 * output é sempre `0 | 6 | 13 | 23 | null` — nunca 5.99, 7 nem 21.
 */

export type TaxaIvaCanonica = 0 | 6 | 13 | 23;

/**
 * Normaliza um valor cru de IVA para a taxa canónica de farmácia.
 *
 * - `null`/`NaN`/`undefined` → `null` ("por apurar")
 * - `0`/`0.00` → `0` (isento, taxa válida)
 * - `0.06` ou `5.5`–`6.5` → `6`
 * - `0.13` ou `12.5`–`13.5` → `13`
 * - `0.23` ou `22.5`–`23.5` → `23`
 * - resto (incluindo 5, 7, 8, 12, 16, 17, 19, 21) → `null`
 *
 * A janela ±0.5 absorve arredondamentos do ERP (`5.9999`, `6.00`, etc.)
 * sem aceitar taxas históricas / regionais fora do conjunto canónico.
 */
export function normalizeIva(raw: number | null | undefined): TaxaIvaCanonica | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
  // 0 é taxa válida (isento), tratada explicitamente antes da escala.
  if (raw === 0) return 0;
  // Escala: fracção (0..1) → multiplicar; senão assumimos já em %.
  const pct = Math.abs(raw) <= 1 ? raw * 100 : raw;
  if (pct >= 5.5 && pct <= 6.5) return 6;
  if (pct >= 12.5 && pct <= 13.5) return 13;
  if (pct >= 22.5 && pct <= 23.5) return 23;
  return null;
}

/** Label para UI: "0%", "6%", "13%", "23%" ou "IVA por apurar". */
export function formatTaxaIva(taxa: TaxaIvaCanonica | null): string {
  return taxa === null ? "IVA por apurar" : `${taxa}%`;
}

/** Buckets canónicos para a vista executiva "Por taxa IVA". */
export const TAXA_IVA_BUCKETS: ReadonlyArray<{
  key: "0" | "6" | "13" | "23" | "APURAR";
  taxa: TaxaIvaCanonica | null;
  label: string;
}> = [
  { key: "0", taxa: 0, label: "IVA 0%" },
  { key: "6", taxa: 6, label: "IVA 6%" },
  { key: "13", taxa: 13, label: "IVA 13%" },
  { key: "23", taxa: 23, label: "IVA 23%" },
  { key: "APURAR", taxa: null, label: "IVA por apurar" },
];

/**
 * Conjunto canónico das taxas aceites em PT/farmácia. Usado para
 * validação em qualquer ponto que receba uma taxa já normalizada
 * (paranoia DB → código vs schema migration).
 */
export const TAXAS_IVA_VALIDAS: ReadonlyArray<TaxaIvaCanonica> = [0, 6, 13, 23];

/**
 * Devolve true se a taxa é uma das 4 canónicas. Útil para os
 * relatórios decidirem se a margem pode ser calculada com confiança.
 */
export function isTaxaIvaCanonica(t: number | null | undefined): t is TaxaIvaCanonica {
  return t === 0 || t === 6 || t === 13 || t === 23;
}
