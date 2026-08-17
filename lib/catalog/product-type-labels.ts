/**
 * lib/catalog/product-type-labels.ts
 *
 * Rótulos de apresentação dos `ProductType`. Um sítio só — havia três
 * cópias desta tabela, e uma ficha que mostrasse "MEDICAMENTO" enquanto
 * outra mostra "Medicamento" é uma inconsistência que ninguém reporta e
 * toda a gente nota.
 *
 * Isto é APRESENTAÇÃO. O vocabulário está em `lib/catalog-types.ts` e é
 * quem manda; um tipo sem rótulo aqui aparece com o seu próprio código,
 * não desaparece.
 */
export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  MEDICAMENTO: "Medicamento",
  SUPLEMENTO: "Suplemento alimentar",
  DERMOCOSMETICA: "Dermocosmética",
  DISPOSITIVO_MEDICO: "Dispositivo médico",
  HIGIENE_CUIDADO: "Higiene & cuidado",
  ORTOPEDIA: "Ortopedia",
  PUERICULTURA: "Puericultura",
  VETERINARIA: "Veterinária",
  OUTRO: "Outro / não classificado",
};

/** Rótulo, ou o próprio código quando não há um. Nunca vazio. */
export function rotuloProductType(t: string | null | undefined, ausente = "—"): string {
  if (!t) return ausente;
  return PRODUCT_TYPE_LABELS[t] ?? t;
}
