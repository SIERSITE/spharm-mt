/**
 * lib/iva.ts
 *
 * Normalização canónica da taxa IVA em produtos de farmácia.
 *
 * Regra de negócio (PT): taxas válidas em produtos de farmácia são
 * apenas {6, 13, 23}. Tudo o resto (0.00 da staging, valores residuais,
 * 5.99 por arredondamento, etc.) cai em "IVA por apurar" — NÃO há um
 * bucket "Outras taxas" sem prova regulatória.
 *
 * O campo `StagingCompraRawLine.iva` foi auditado a 2026-06-01 no
 * tenant `grupo-silveira` (136 817 linhas):
 *   · 0.00 ×    37 (0.03%, anomalia/bónus)
 *   · 0.06 × 107103 (78%)
 *   · 0.13 ×     7 (rare)
 *   · 0.23 × 29670 (22%)
 * → escala é FRACÇÃO (0..1). Multiplicar por 100 para obter %.
 *
 * Esta função aceita ambas as escalas (defensiva), porque outros
 * tenants podem ter ingestões legacy diferentes. Mas o output é sempre
 * `6 | 13 | 23 | null` — nunca 5.99 nem 0.
 */

export type TaxaIvaCanonica = 6 | 13 | 23;

/**
 * Normaliza um valor cru de IVA para a taxa canónica de farmácia.
 *
 * - `null`/`NaN`/`undefined` → `null` ("por apurar")
 * - `0`/`0.00` → `null` (anomalia, nunca um bucket válido)
 * - `0.06` ou `5.5`–`6.5` → `6`
 * - `0.13` ou `12.5`–`13.5` → `13`
 * - `0.23` ou `22.5`–`23.5` → `23`
 * - resto → `null`
 *
 * A janela ±0.5 absorve arredondamentos do ERP (`5.9999`, `6.00`, etc.)
 * sem aceitar taxas inválidas (`10%`, `21%`).
 */
export function normalizeIva(raw: number | null | undefined): TaxaIvaCanonica | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
  if (raw === 0) return null;
  // Escala: fracção (0..1) → multiplicar; senão assumimos já em %.
  const pct = Math.abs(raw) <= 1 ? raw * 100 : raw;
  if (pct >= 5.5 && pct <= 6.5) return 6;
  if (pct >= 12.5 && pct <= 13.5) return 13;
  if (pct >= 22.5 && pct <= 23.5) return 23;
  return null;
}

/** Label para UI: "6%", "13%", "23%" ou "IVA por apurar". */
export function formatTaxaIva(taxa: TaxaIvaCanonica | null): string {
  return taxa === null ? "IVA por apurar" : `${taxa}%`;
}

/** Buckets canónicos para a vista executiva "Por taxa IVA". */
export const TAXA_IVA_BUCKETS: ReadonlyArray<{
  key: "6" | "13" | "23" | "APURAR";
  taxa: TaxaIvaCanonica | null;
  label: string;
}> = [
  { key: "6", taxa: 6, label: "IVA 6%" },
  { key: "13", taxa: 13, label: "IVA 13%" },
  { key: "23", taxa: 23, label: "IVA 23%" },
  { key: "APURAR", taxa: null, label: "IVA por apurar" },
];
