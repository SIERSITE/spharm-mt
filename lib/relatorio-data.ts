/**
 * lib/relatorio-data.ts
 *
 * A data de HOJE no fuso da aplicação (Europe/Lisbon), como `YYYY-MM-DD`. Usada na «Vista relatório» de Excessos e
 * Transferências para mostrar a data de geração. Puro e client-safe; não faz parte de nenhum cálculo.
 */
export function hojeIsoLisboa(agora: Date = new Date()): string {
  // `en-CA` dá `YYYY-MM-DD`; o `timeZone` faz a conversão de fuso sem aritmética nossa.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);
}
