/**
 * lib/catalog/laboratorio-filtro.ts
 *
 * Lógica PURA do filtro unificado de laboratório do catálogo — extraída
 * de `lib/catalogo-data.ts` para aqui porque esse ficheiro importa
 * `"server-only"`, que resolve para no-op no bundler Next.js mas falha
 * com MODULE_NOT_FOUND sob `tsx` (Node puro) — exactamente a mesma razão
 * documentada em `lib/tenant-context.ts`. Nunca testável directamente se
 * ficasse lá; aqui é uma função pura normal, sem nenhuma dependência de
 * runtime Next.js.
 *
 * `lib/catalogo-data.ts` importa e reexporta tudo daqui — nenhuma lógica
 * duplicada, só a localização mudou.
 */
import type { Prisma } from "@/generated/prisma/client";

/**
 * UMA lista unificada — nunca duas listas concorrentes ("grupo" e
 * "fabricante" lado a lado seriam dois filtros a disputar a mesma
 * pergunta). Cada entrada sabe o que é; a UI desenha uma única lista
 * ordenada, sem secções nem distinção visual forçada.
 *
 * `termosBusca` (só em grupos) são os aliases do grupo (ex.: "Mylan",
 * "Upjohn" para o grupo "Viatris") — usados SÓ para filtrar a pesquisa
 * (`pesquisarLaboratorios`), NUNCA mostrados como opção própria. É assim
 * que escrever "Mylan" devolve a ÚNICA opção "Viatris", em vez de as duas
 * aparecerem lado a lado como concorrentes.
 */
export type CatalogoFilterOptionLaboratorio =
  | { tipo: "grupo"; id: string; nome: string; termosBusca: string[] }
  | { tipo: "fabricante"; id: string; nomeNormalizado: string };

export function nomeDeLaboratorio(o: CatalogoFilterOptionLaboratorio): string {
  return o.tipo === "grupo" ? o.nome : o.nomeNormalizado;
}

function normalizarTermoBusca(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();
}

/**
 * Filtra a lista unificada por texto — pura, testável sem DOM. Compara
 * contra o nome visível E os `termosBusca` (aliases) de cada grupo, mas
 * o resultado é sempre a PRÓPRIA opção (grupo ou fabricante), nunca um
 * alias à parte: por isso "Mylan" devolve só "Viatris", nunca as duas.
 */
export function pesquisarLaboratorios(
  opcoes: readonly CatalogoFilterOptionLaboratorio[],
  query: string,
): CatalogoFilterOptionLaboratorio[] {
  const q = normalizarTermoBusca(query);
  if (!q) return [...opcoes];
  return opcoes.filter((o) => {
    if (nomeDeLaboratorio(o).toUpperCase().includes(q)) return true;
    if (o.tipo === "grupo") return o.termosBusca.some((t) => normalizarTermoBusca(t).includes(q));
    return false;
  });
}

/**
 * Traduz o valor do filtro (`"grupo:<id>"` / `"fabricante:<id>"`) para o
 * `where` do Prisma — a ÚNICA função que decide isto, para a lista e o
 * filtro nunca poderem divergir. `null` quando o valor está vazio ou
 * malformado (filtro ignorado, não um erro).
 */
export function resolverFiltroLaboratorioWhere(valor: string | undefined): Prisma.ProdutoWhereInput | null {
  if (!valor) return null;
  if (valor.startsWith("grupo:")) {
    const grupoLaboratorialId = valor.slice("grupo:".length);
    if (!grupoLaboratorialId) return null;
    return { grupoLaboratorial: { grupoLaboratorialId } };
  }
  if (valor.startsWith("fabricante:")) {
    const fabricanteId = valor.slice("fabricante:".length);
    if (!fabricanteId) return null;
    return { fabricanteId };
  }
  // Sem prefixo — um link antigo (?fabricante=<id>, de antes desta mudança)
  // continua a funcionar tal e qual, tratado como fabricanteId directo.
  return { fabricanteId: valor };
}
