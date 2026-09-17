/**
 * lib/reporting/ordenacao-farmacias.ts
 *
 * Ordem ESTÁVEL de farmácias — partilhada por todos os adapters de
 * reporting. Nasceu em `vendas-agrupamento.ts` (para os sub-grupos por
 * farmácia dentro de cada artigo de Vendas) e foi extraída para aqui na
 * uniformização (2026-09), quando o mesmo problema — a ordem das
 * farmácias a depender da ordem incidental da query/agregação, em vez de
 * ser sempre a mesma — apareceu também em Margens Por Farmácia e
 * Inventário Por Farmácia.
 *
 * Regra: quando existe uma ordem definida pelo universo do relatório
 * (`ordemFarmacias` — tipicamente `input.universe.farmacias`, já
 * alfabética e deduplicada pelos `*-client.tsx`), essa é a ordem
 * AUTORITATIVA. Sem ela (ou para uma farmácia ausente dela — não devia
 * acontecer, mas nunca se assume que não pode), cai em ordenação
 * alfabética directa (`localeCompare("pt-PT")`) — nunca na ordem de
 * chegada.
 */
export function compararPorNomeFarmacia(
  ordemFarmacias: readonly string[] | undefined,
): (a: string, b: string) => number {
  const indice = new Map((ordemFarmacias ?? []).map((nome, i) => [nome, i]));
  return (a, b) => {
    const ia = indice.get(a);
    const ib = indice.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a.localeCompare(b, "pt-PT");
  };
}

/**
 * Ordena `rows` por farmácia, de forma estável — `getFarmacia` extrai o
 * nome de cada linha (o campo muda de relatório para relatório: `farmacia`,
 * `label`, `farmaciaOrigem`, ...). Nunca muta `rows`.
 */
export function ordenarPorFarmacia<T>(
  rows: readonly T[],
  getFarmacia: (row: T) => string,
  ordemFarmacias?: readonly string[],
): T[] {
  const comparar = compararPorNomeFarmacia(ordemFarmacias);
  return [...rows].sort((a, b) => comparar(getFarmacia(a), getFarmacia(b)));
}
