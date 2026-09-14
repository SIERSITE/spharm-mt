/**
 * lib/tabela/ordenacao.ts
 *
 * O motor ÚNICO de ordenação das tabelas da aplicação.
 *
 * ── Porque é que isto existe ─────────────────────────────────────────
 *
 * Porque, até aqui, UMA tabela em toda a aplicação era ordenável pelo
 * cabeçalho — a proposta de encomenda — e tinha a sua própria cópia do
 * ciclo asc/desc, do comparador e do indicador. Todas as outras não
 * tinham nenhuma.
 *
 * A alternativa a este módulo era escrever esse mesmo par
 * `sortCol`/`sortDir` em mais oito clientes. Oito comparadores é oito
 * decisões separadas sobre onde vão os nulos, e a que se compara um
 * texto com acentos — que é como se acaba com «Água» depois de «Zinco»
 * numa página e antes noutra.
 *
 * ── OS DOIS REGIMES ──────────────────────────────────────────────────
 *
 * A distinção não é cosmética e é a razão de o módulo ter duas metades.
 *
 *   MEMÓRIA — o cliente tem o dataset todo (excessos, transferências,
 *   vendas, margens, inventário, encomendas). Ordenar em JS ordena tudo,
 *   e está certo.
 *
 *   SERVIDOR — o cliente tem UMA PÁGINA de um universo maior. É o caso
 *   de `/stock` (`LIMIT/OFFSET`) e de `/catalogo` (`skip`/`take`), e nos
 *   dois o `ORDER BY` está fixo em `designacao ASC`. Ordenar em JS aí
 *   ordenaria 50 linhas de 5 000 e mostraria o resultado como se fosse o
 *   ranking — a linha mais cara do universo continuaria na página 40,
 *   invisível, com o ecrã a dizer que a mais cara é outra.
 *
 * Por isso a chave de ordenação do regime servidor VIAJA para o loader e
 * entra no `ORDER BY`. E por isso existe `resolverOrdenacaoSql`: a chave
 * vem do cliente, e uma chave de cliente nunca pode chegar a SQL sem
 * passar por uma lista fechada.
 *
 * Módulo PURO: sem React, sem Prisma, sem `server-only`.
 */

export type DirecaoOrdenacao = "asc" | "desc";

/** Coluna activa e direcção. `null` = ordem natural da fonte. */
export type EstadoOrdenacao<K extends string = string> = {
  coluna: K;
  direcao: DirecaoOrdenacao;
} | null;

/**
 * O que um clique no cabeçalho faz.
 *
 * O requisito é explícito: primeiro clique ascendente, segundo
 * descendente. O terceiro volta a ascendente — e não a «sem ordenação»,
 * de propósito: um terceiro estado invisível deixa o utilizador a clicar
 * à procura de perceber o que mudou, e a ordem natural de uma tabela já
 * ordenada não significa nada para quem a está a ler.
 *
 * Mudar de coluna começa sempre em ascendente. Herdar a direcção da
 * coluna anterior faz o primeiro clique numa coluna nova produzir
 * descendente sem ninguém o ter pedido.
 */
export function proximaOrdenacao<K extends string>(
  actual: EstadoOrdenacao<K>,
  coluna: K,
): EstadoOrdenacao<K> {
  if (actual && actual.coluna === coluna) {
    return { coluna, direcao: actual.direcao === "asc" ? "desc" : "asc" };
  }
  return { coluna, direcao: "asc" };
}

/**
 * Um valor ordenável. `null`/`undefined` = ausência, e é tratada à
 * parte — ver `comparar`.
 */
export type ValorOrdenavel = string | number | boolean | Date | null | undefined;

/** Extrai de uma linha o valor pelo qual se ordena aquela coluna. */
export type Acessor<T, K extends string> = (linha: T, coluna: K) => ValorOrdenavel;

/**
 * Comparador com acentuação portuguesa.
 *
 * `localeCompare` com `pt-PT` e não `<`: em ordenação binária «Ácido»
 * vem depois de «Zinco», porque `Á` tem um code point mais alto que
 * qualquer letra ASCII. Numa lista de medicamentos isso não é um
 * pormenor tipográfico — é o artigo procurado a não estar onde o
 * utilizador olha.
 *
 * `numeric: true` faz «Item 2» vir antes de «Item 10», que é o que
 * qualquer pessoa espera de designações com dosagens.
 */
const colactor = new Intl.Collator("pt-PT", { numeric: true, sensitivity: "base" });

/**
 * Compara dois valores. Devolve <0, 0 ou >0.
 *
 * REGRA DOS NULOS: a ausência vai sempre para o FIM, nas duas direcções.
 * Não é simetria — é deliberado. Quem ordena uma coluna de dinheiro por
 * descendente quer ver o maior valor no topo; quem a ordena por
 * ascendente quer ver o menor. Em nenhum dos casos quer 34 traços a
 * ocupar o primeiro ecrã. A ausência não é «o menor valor», é a falta de
 * valor, e não compete no ranking.
 */
export function ehVazio(v: ValorOrdenavel): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "number") return !Number.isFinite(v);
  // Uma string vazia é ausência tanto como um null: a célula está em
  // branco no ecrã, e agrupá-la com os brancos é o que o utilizador vê.
  if (typeof v === "string") return v.trim().length === 0;
  return false;
}

function comparar(a: ValorOrdenavel, b: ValorOrdenavel): number {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : Number(a);
    const tb = b instanceof Date ? b.getTime() : Number(b);
    return ta - tb;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  return colactor.compare(String(a), String(b));
}

/**
 * Ordena uma cópia das linhas. NÃO muta o array recebido — o array do
 * `useMemo` de um cliente React é a fonte de outros cálculos, e ordená-lo
 * no sítio muda-os sem eles saberem.
 *
 * Estável: `Array.prototype.sort` é estável desde a ES2019, portanto
 * linhas com o mesmo valor mantêm a ordem que a fonte lhes deu. É isso
 * que faz uma tabela ordenada por «Farmácia» manter a ordem por produto
 * dentro de cada farmácia, sem ninguém ter de pedir um segundo critério.
 */
export function ordenarLinhas<T, K extends string>(
  linhas: readonly T[],
  estado: EstadoOrdenacao<K>,
  acessor: Acessor<T, K>,
): T[] {
  if (!estado) return [...linhas];
  const { coluna, direcao } = estado;
  const sinal = direcao === "asc" ? 1 : -1;
  return [...linhas].sort((x, y) => {
    const a = acessor(x, coluna);
    const b = acessor(y, coluna);
    const aVazio = ehVazio(a);
    const bVazio = ehVazio(b);
    // A ausência vai para o fim NAS DUAS DIRECÇÕES, portanto este
    // resultado não leva o sinal. É o único ramo em que isso acontece.
    if (aVazio !== bVazio) return aVazio ? 1 : -1;
    if (aVazio && bVazio) return 0;
    return comparar(a, b) * sinal;
  });
}

// ─── Regime servidor ─────────────────────────────────────────────────

/**
 * O mapa fechado `chave do cliente → fragmento SQL`.
 *
 * O valor é um fragmento de `ORDER BY` SEM direcção — a direcção é
 * acrescentada por `resolverOrdenacaoSql`, que é o único sítio onde ela
 * pode tomar um dos dois valores literais.
 *
 * É uma lista fechada e não um `Prisma.raw(coluna)` porque a chave chega
 * do browser. Uma tabela server-side que aceite o nome da coluna vindo
 * do cliente e o cole no SQL é injecção, por muito improvável que a
 * string pareça.
 */
export type MapaOrdenacaoSql<K extends string> = Readonly<Record<K, string>>;

export type OrdenacaoSql = {
  /** Fragmento pronto para interpolar depois de `ORDER BY `. */
  sql: string;
  coluna: string;
  direcao: DirecaoOrdenacao;
};

/**
 * Traduz a ordenação pedida pelo cliente num `ORDER BY` seguro.
 *
 * Chave desconhecida ou ausente → o fallback. Nunca atira: uma chave
 * inválida é um bookmark antigo ou um URL editado à mão, e a resposta
 * certa é a tabela na ordem por omissão, não um erro 500.
 *
 * O `desempate` é acrescentado sempre. Sem ele, duas páginas consecutivas
 * de um `LIMIT/OFFSET` sobre uma coluna com repetidos podem mostrar a
 * mesma linha duas vezes e esconder outra — o Postgres não promete ordem
 * estável entre execuções, e a paginação assume que promete.
 */
export function resolverOrdenacaoSql<K extends string>(
  pedida: EstadoOrdenacao<string>,
  mapa: MapaOrdenacaoSql<K>,
  fallback: { coluna: K; direcao: DirecaoOrdenacao },
  desempate: string,
): OrdenacaoSql {
  const chave =
    pedida && Object.prototype.hasOwnProperty.call(mapa, pedida.coluna)
      ? (pedida.coluna as K)
      : fallback.coluna;
  const direcao: DirecaoOrdenacao =
    pedida && chave === pedida.coluna ? pedida.direcao : fallback.direcao;

  const dir = direcao === "asc" ? "ASC" : "DESC";
  // NULLS LAST nas duas direcções, pela mesma razão do comparador em
  // memória: a ausência não compete no ranking. O Postgres faz o
  // contrário por omissão em DESC, portanto é explícito.
  return {
    sql: `${mapa[chave]} ${dir} NULLS LAST, ${desempate}`,
    coluna: chave,
    direcao,
  };
}

/**
 * Lê uma ordenação de query-string (`?ord=valorCusto&dir=desc`).
 *
 * Existe para as tabelas server-side, onde o estado tem de sobreviver a
 * uma navegação de página e a um refresh — é o mesmo sítio onde já vivem
 * a página e os filtros dessas tabelas.
 */
export function lerOrdenacaoDeParams(
  params: { ord?: string | null; dir?: string | null } | URLSearchParams,
): EstadoOrdenacao<string> {
  const get = (k: string): string | null =>
    params instanceof URLSearchParams
      ? params.get(k)
      : ((params as Record<string, string | null | undefined>)[k] ?? null);

  const ord = (get("ord") ?? "").trim();
  if (!ord) return null;
  const dir = (get("dir") ?? "").trim().toLowerCase();
  return { coluna: ord, direcao: dir === "desc" ? "desc" : "asc" };
}
