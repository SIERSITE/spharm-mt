/**
 * lib/ordenacao-artigos.ts
 *
 * A ORDEM POR OMISSÃO das linhas de artigos em todos os mapas, relatórios e
 * ecrãs de preparação de encomendas:
 *
 *   1. designação do artigo, A–Z, sem distinguir maiúsculas/minúsculas nem acentos;
 *   2. CNP (desempate estável);
 *   3. farmácia (desempate, quando o mesmo artigo tem várias linhas).
 *
 * Aplica-se SÓ a linhas de artigos. A listagem histórica de documentos/encomendas
 * continua cronológica. Uma ordenação escolhida explicitamente pelo utilizador
 * (cabeçalho clicável) prevalece: esta é o estado inicial e o resultado de
 * «Limpar filtros».
 *
 * Onde há paginação a ordem tem de vir do servidor (`ORDER BY` com
 * `SQL_ORDEM_ARTIGOS`) — ordenar só a página atual seria errado. No cliente e
 * nos adaptadores de relatório usa-se `compararArtigos` (mesmo critério).
 */

/** Comparação por «base»: ignora maiúsculas e acentos (á = a, Á = a). Pontuação/espaços contam. */
const colator = new Intl.Collator("pt", { sensitivity: "base", usage: "sort" });

export function compararTexto(a: string | null | undefined, b: string | null | undefined): number {
  return colator.compare((a ?? "").trim(), (b ?? "").trim());
}

export type ChaveArtigo = {
  designacao: string | null | undefined;
  cnp: number | string | null | undefined;
  farmacia?: string | null;
};

const cnpNum = (c: ChaveArtigo["cnp"]) => {
  const n = Number(c);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

export function compararArtigos(a: ChaveArtigo, b: ChaveArtigo): number {
  return (
    compararTexto(a.designacao, b.designacao) ||
    cnpNum(a.cnp) - cnpNum(b.cnp) ||
    compararTexto(a.farmacia, b.farmacia)
  );
}

/** Devolve uma cópia ordenada (estável). */
export function ordenarArtigos<T>(linhas: readonly T[], chave: (l: T) => ChaveArtigo): T[] {
  return [...linhas].sort((x, y) => compararArtigos(chave(x), chave(y)));
}

/**
 * Para `ORDER BY` em SQL (PostgreSQL com `unaccent_immutable`, já usado pela
 * pesquisa). Usar com o alias do produto (`p`) e da farmácia (`fa`).
 * Nota: o SQL ordena por código de caracter depois de tirar acentos e
 * minúsculas; o `Intl.Collator` do cliente pode diferir apenas na colocação
 * de pontuação — a ordem por letras é a mesma.
 */
export const SQL_ORDEM_ARTIGOS =
  `lower(unaccent_immutable(p."designacao")) ASC, p."cnp" ASC, lower(unaccent_immutable(COALESCE(fa."nome", ''))) ASC`;
