/**
 * lib/reporting/filtro-laboratorio-linhas.ts
 *
 * Filtro "Laboratório ou grupo" aplicado, no CLIENTE, às linhas de Excessos / Transferências / Devoluções / Encomendas.
 *
 * Porquê existe: em garantia o filtro de fabricante oferece GRUPOS (`grupo:<id>`) e fabricantes (`fabricante:<id>`),
 * mas a linha só traz o nome legal do fabricante — comparar um com o outro nunca devolvia linhas. Aqui a decisão é por
 * CNP: o servidor resolve a selecção (o MESMO resolvedor de Vendas/Margens/Inventário) para o conjunto de CNP e a
 * linha passa se o seu CNP estiver nele. Nos outros tenants (`modoGrupos=false`) a comparação por nome é EXACTAMENTE a
 * de sempre. Pura (sem React/Prisma), testável com `tsx`.
 */

export type EstadoFiltroLaboratorio = {
  /** true só quando o tenant tem grupos laboratoriais (`options.laboratorios` povoado). */
  modoGrupos: boolean;
  /** CNP resolvidos para a selecção actual; `null` enquanto o servidor ainda não respondeu. */
  cnps: ReadonlySet<string> | null;
};

export function passaFiltroLaboratorioLinha(
  linha: { cnp: string | number; fabricante: string },
  selecionados: readonly string[],
  estado: EstadoFiltroLaboratorio,
): boolean {
  if (selecionados.length === 0) return true;
  if (!estado.modoGrupos) return selecionados.includes(linha.fabricante);
  // Selecção feita mas resolução ainda em curso: não mostra linhas "erradas" entretanto.
  if (estado.cnps === null) return false;
  return estado.cnps.has(String(linha.cnp));
}
