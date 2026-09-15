/**
 * lib/reporting/pesquisa-produto.ts
 *
 * A condição de pesquisa por artigo, partilhada por TODOS os relatórios
 * operacionais que a usam sobre SQL bruto com `Produto` aliasado `p`.
 *
 * Extraída de `lib/margens-data.ts` (2026-09) — Margens já tinha
 * corrigido aqui um problema que Vendas ainda tinha: o CNP era
 * comparado por igualdade numérica (`cnp = 58800`), portanto parte de
 * um código nunca encontrava nada. `lib/vendas-data.ts` reimplementava
 * a mesma pesquisa (CNP exacto ou designação parcial) com essa mesma
 * limitação — duas cópias da mesma ideia, uma delas pior. Movida para
 * aqui e reutilizada pelos dois, para nunca mais haver um segundo
 * mecanismo de pesquisa a divergir do primeiro.
 */
import { Prisma } from "@/generated/prisma/client";

/**
 * A condição SQL da pesquisa por artigo. Pura, testável sem BD.
 *
 * Três formas, e as três no MESMO campo:
 *   · CNP exacto         "5880034"
 *   · parte do CNP       "58800"
 *   · designação parcial "depuralina", sem distinguir maiúsculas NEM
 *     acentos — "avene" tem de encontrar "Avène"
 *
 * O CNP compara-se em TEXTO (`cnp::text LIKE`) e não por igualdade
 * numérica. A igualdade exacta continua coberta — é o caso particular em
 * que o padrão é o código inteiro — mas `= 58800` não encontrava nada
 * quando se escrevia metade do código.
 *
 * A designação compara-se via `unaccent_immutable(...)` dos DOIS lados
 * (migration 20260915140000_pesquisa_unaccent) — um `ILIKE` simples não
 * ignora acentos, "è"/"é"/"e" são codepoints diferentes e a collation
 * não os funde por omissão. `unaccent_immutable` é o wrapper IMMUTABLE
 * sobre a extensão `unaccent` (STABLE, não usável directamente num
 * índice); há um índice GIN trigram funcional sobre
 * `unaccent_immutable(designacao)` que mantém isto rápido mesmo com o
 * catálogo a crescer — nunca carrega tudo para JS para filtrar.
 *
 * Devolve `Prisma.empty` para termo vazio: sem pesquisa, sem condição.
 *
 * Assume um `Produto` aliasado `p` na query onde é inserida (`p."cnp"`,
 * `p."designacao"`) — é o alias usado por `margens-data.ts` e
 * `vendas-data.ts`.
 */
export function construirCondicaoPesquisa(pesquisa: string | undefined | null): Prisma.Sql {
  const q = (pesquisa ?? "").trim();
  if (!q) return Prisma.empty;
  const padrao = `%${q}%`;
  const designacaoCond = Prisma.sql`unaccent_immutable(p."designacao") ILIKE unaccent_immutable(${padrao})`;
  // Só faz sentido procurar no CNP quando o termo são mesmo dígitos.
  // "depuralina" contra `cnp::text` nunca casa e só custa tempo.
  if (/^\d+$/.test(q)) {
    return Prisma.sql`AND (p."cnp"::text LIKE ${padrao} OR ${designacaoCond})`;
  }
  return Prisma.sql`AND ${designacaoCond}`;
}
