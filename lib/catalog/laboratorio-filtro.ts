/**
 * lib/catalog/laboratorio-filtro.ts
 *
 * Lógica PURA do filtro unificado de laboratório — usada pelo Catálogo E
 * (2026-09-24) pelos três relatórios (Vendas/Margens/Inventário) no
 * tenant garantia. Extraída de `lib/catalogo-data.ts` porque esse
 * ficheiro importa `"server-only"`, que resolve para no-op no bundler
 * Next.js mas falha com MODULE_NOT_FOUND sob `tsx` (Node puro) —
 * exactamente a mesma razão documentada em `lib/tenant-context.ts`. Nunca
 * testável directamente se ficasse lá; aqui é um módulo puro normal, sem
 * nenhuma dependência de runtime Next.js nem de Prisma.
 *
 * ── Correcção de UX de 2026-09-24 ─────────────────────────────────────
 * Até aqui, um fabricante integralmente associado a um grupo (ex.:
 * "Mylan") era EXCLUÍDO da lista — só o grupo ("Viatris") aparecia,
 * escondendo que "Mylan" é uma entidade legal real e pesquisável à
 * parte. Isto obrigava o cliente a já saber que "Mylan pertence à
 * Viatris" antes de poder ver os produtos SÓ da Mylan. Corrigido: TODOS
 * os fabricantes reais aparecem sempre como opções `{tipo:"fabricante"}`
 * própria — o grupo aparece ADICIONALMENTE, nunca em vez do fabricante.
 * `lib/catalogo-data.ts::carregarLaboratoriosGarantia` já não exclui
 * fabricantes integrais da lista — só deixa de os repetir a old forma
 * (antes, a exclusão SUBSTITUÍA a opção do fabricante pela do grupo).
 */
import type { Prisma } from "@/generated/prisma/client";

/**
 * UMA lista unificada — nunca duas listas concorrentes ("grupo" e
 * "fabricante" lado a lado seriam dois filtros a disputar a mesma
 * pergunta). Cada entrada sabe o que é; a UI desenha secções distintas
 * ("Grupos relacionados" / "Fabricantes") quando ambos os tipos
 * aparecem nos resultados de uma pesquisa, nunca duas listas separadas
 * geridas independentemente.
 *
 * `termosBusca` (só em grupos) inclui: aliases do próprio grupo (ex.:
 * "Mylan", "Upjohn" para "Viatris"), MAIS os nomes normalizados de TODOS
 * os fabricantes integralmente associados, MAIS os aliases desses
 * fabricantes (`FabricanteAlias`) — assim, pesquisar por QUALQUER nome
 * ou alias de um fabricante integral também encontra o grupo. Usados SÓ
 * para filtrar a pesquisa (`pesquisarLaboratorios`), NUNCA mostrados
 * como opção própria.
 *
 * `resumoAlcance` (só em grupos) é a lista de nomes a mostrar em "inclui
 * X, Y e Z" — o nome do próprio grupo e os seus aliases curados (não
 * TODOS os nomes de fabricantes reais, que podem ser dezenas de
 * variantes de grafia — os aliases são a forma curta e reconhecível).
 *
 * `produtos` é a contagem agregada (uma única query, nunca uma por
 * opção — ver `carregarLaboratoriosGarantia`).
 */
export type CatalogoFilterOptionLaboratorio =
  | { tipo: "grupo"; id: string; nome: string; termosBusca: string[]; resumoAlcance: string[]; produtos: number }
  | { tipo: "fabricante"; id: string; nomeNormalizado: string; produtos: number };

export function nomeDeLaboratorio(o: CatalogoFilterOptionLaboratorio): string {
  return o.tipo === "grupo" ? o.nome : o.nomeNormalizado;
}

/** "Fabricante" ou "Grupo" — rótulo de tipo mostrado em cada opção e no filtro activo. */
export function rotuloTipoLaboratorio(o: CatalogoFilterOptionLaboratorio): "Fabricante" | "Grupo" {
  return o.tipo === "grupo" ? "Grupo" : "Fabricante";
}

/**
 * Descrição curta do alcance de uma opção, para mostrar por baixo do
 * nome: "Fabricante · 604 produtos" ou "Grupo · inclui Mylan, Upjohn e
 * Viatris · 808 produtos". Junção "X, Y e Z" (nunca "X, Y, e Z").
 */
export function descricaoAlcanceLaboratorio(o: CatalogoFilterOptionLaboratorio): string {
  const produtosTexto = `${o.produtos.toLocaleString("pt-PT")} produto${o.produtos === 1 ? "" : "s"}`;
  if (o.tipo === "fabricante") return `Fabricante · ${produtosTexto}`;
  const nomes = o.resumoAlcance;
  if (nomes.length === 0) return `Grupo · ${produtosTexto}`;
  const juncao = nomes.length === 1 ? nomes[0]! : `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
  return `Grupo · inclui ${juncao} · ${produtosTexto}`;
}

/** "fabricante:<id>" / "grupo:<id>" — o valor interno de uma opção. Nunca o nome. */
export function valorDeLaboratorio(o: CatalogoFilterOptionLaboratorio): string {
  return o.tipo === "grupo" ? `grupo:${o.id}` : `fabricante:${o.id}`;
}

/**
 * Interpreta um valor "grupo:<id>" / "fabricante:<id>" — NUNCA infere o
 * tipo a partir do texto apresentado, só do prefixo explícito. `null`
 * para qualquer coisa sem o prefixo esperado (ver `resolverFiltroLaboratorioWhere`
 * para o que acontece a um valor legado sem prefixo).
 */
export function parseValorLaboratorio(valor: string): { tipo: "grupo" | "fabricante"; id: string } | null {
  if (valor.startsWith("grupo:")) {
    const id = valor.slice("grupo:".length);
    return id ? { tipo: "grupo", id } : null;
  }
  if (valor.startsWith("fabricante:")) {
    const id = valor.slice("fabricante:".length);
    return id ? { tipo: "fabricante", id } : null;
  }
  return null;
}

function normalizarTermoBusca(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();
}

/**
 * Filtra E ordena a lista unificada por texto — pura, testável sem DOM.
 * Compara contra o nome visível E os `termosBusca` (aliases + nomes/
 * aliases dos fabricantes integrais) de cada grupo — mas o resultado
 * inclui SEMPRE a própria opção do fabricante também, quando exista e
 * bata: encontrar o grupo através de um fabricante nunca esconde a
 * opção do fabricante (ver o doc comment do tipo, acima).
 *
 * ── Ordenação ──────────────────────────────────────────────────────────
 * Quando a pesquisa bate EXACTAMENTE com o nome de um grupo (ex.:
 * "Viatris", "Alfasigma") — esse grupo aparece primeiro, fabricantes
 * a seguir. Caso contrário (a pesquisa bateu por alias, por nome de
 * fabricante, ou é uma substring parcial) — fabricantes aparecem
 * primeiro, grupo(s) relacionado(s) a seguir. Dentro de cada bloco,
 * ordem alfabética.
 */
export function pesquisarLaboratorios(
  opcoes: readonly CatalogoFilterOptionLaboratorio[],
  query: string,
): CatalogoFilterOptionLaboratorio[] {
  const q = normalizarTermoBusca(query);
  if (!q) return [...opcoes].sort((a, b) => nomeDeLaboratorio(a).localeCompare(nomeDeLaboratorio(b), "pt-PT"));

  const encontrados = opcoes.filter((o) => {
    if (nomeDeLaboratorio(o).toUpperCase().includes(q)) return true;
    if (o.tipo === "grupo") return o.termosBusca.some((t) => normalizarTermoBusca(t).includes(q));
    return false;
  });

  // Bate EXACTAMENTE com o nome de algum grupo (nos resultados OU não —
  // um grupo cujo nome bate exactamente está sempre nos resultados,
  // dado o `.includes(q)` acima quando q é o nome inteiro).
  const grupoExacto = encontrados.some((o) => o.tipo === "grupo" && normalizarTermoBusca(o.nome) === q);

  const grupos = encontrados.filter((o): o is Extract<CatalogoFilterOptionLaboratorio, { tipo: "grupo" }> => o.tipo === "grupo");
  const fabricantes = encontrados.filter((o): o is Extract<CatalogoFilterOptionLaboratorio, { tipo: "fabricante" }> => o.tipo === "fabricante");
  grupos.sort((a, b) => a.nome.localeCompare(b.nome, "pt-PT"));
  fabricantes.sort((a, b) => a.nomeNormalizado.localeCompare(b.nomeNormalizado, "pt-PT"));

  return grupoExacto ? [...grupos, ...fabricantes] : [...fabricantes, ...grupos];
}

/**
 * Traduz o valor do filtro (`"grupo:<id>"` / `"fabricante:<id>"`) para o
 * `where` do Prisma — a ÚNICA função que decide isto, para a lista e o
 * filtro nunca poderem divergir. `null` quando o valor está vazio ou
 * malformado (filtro ignorado, não um erro).
 *
 * Grupo: filtra pela RELAÇÃO `ProdutoGrupoLaboratorial` existir para
 * este grupo — só produtos DEFINITIVAMENTE associados (fabricante
 * inequívoco, regra por CNP validada, alias inequívoco, ou mantido
 * manual) têm essa linha; uma proposta pendente NUNCA escreve lá (ver
 * `TIPOS_APLICAVEIS_AUTOMATICAMENTE` em
 * scripts/classificar-grupos-laboratoriais-garantia.ts), por isso este
 * filtro já exclui propostas pendentes só por construção.
 *
 * Fabricante: filtra exclusivamente por `fabricanteId` — nunca inclui
 * outros fabricantes do mesmo grupo nem regras por CNP de outros
 * fabricantes, porque nunca olha para `ProdutoGrupoLaboratorial`.
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
