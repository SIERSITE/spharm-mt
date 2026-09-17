/**
 * lib/reporting/farmacia-nome.ts
 *
 * Apresentação CURTA do nome de farmácia — "Farmácia Segurado" → "Segurado"
 * — partilhada por TODOS os adapters de reporting. Nunca altera o nome
 * real em base de dados: é puramente uma questão de apresentação em
 * HTML/PDF/print, via `ReportColumn.displayKey` (ver report-types.ts). O
 * nome completo continua a viver em `key` — Excel, ordenação, agrupamento
 * usam sempre esse, intocado.
 *
 * Nasceu no redesenho de Vendas (2026-09): "Farmácia Segurado" quebrava em
 * duas linhas numa coluna estreita alinhada à esquerda, engordando a linha
 * inteira. Extraído para aqui na uniformização (2026-09) quando o mesmo
 * problema apareceu em Margens/Inventário/Devoluções/Transferências/
 * Excessos — um sítio só, em vez de cinco cópias do mesmo regex.
 */
const PREFIXO_FARMACIA = /^Farm[aá]cia\s+/i;

/**
 * "Farmácia Segurado" → "Segurado". Uma farmácia sem o prefixo (ex.:
 * fixtures de teste "Farmácia A" à parte — mas também qualquer nome que já
 * não o tenha) fica intocada.
 */
export function nomeFarmaciaCurto(nome: string): string {
  return nome.replace(PREFIXO_FARMACIA, "");
}
