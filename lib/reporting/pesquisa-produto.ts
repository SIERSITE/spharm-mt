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
 *   · designação parcial "depuralina", sem distinguir maiúsculas
 *
 * O CNP compara-se em TEXTO (`cnp::text LIKE`) e não por igualdade
 * numérica. A igualdade exacta continua coberta — é o caso particular em
 * que o padrão é o código inteiro — mas `= 58800` não encontrava nada
 * quando se escrevia metade do código.
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
  // Só faz sentido procurar no CNP quando o termo são mesmo dígitos.
  // "depuralina" contra `cnp::text` nunca casa e só custa tempo.
  if (/^\d+$/.test(q)) {
    return Prisma.sql`AND (p."cnp"::text LIKE ${padrao} OR p."designacao" ILIKE ${padrao})`;
  }
  return Prisma.sql`AND p."designacao" ILIKE ${padrao}`;
}
