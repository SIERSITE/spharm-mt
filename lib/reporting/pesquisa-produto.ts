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
import { termosDePesquisa } from "@/lib/reporting/pesquisa-termos";

/**
 * Opções do predicado. `colunasExtra` são expressões SQL de TEXTO (já
 * seguras — nunca construídas a partir de input do utilizador) em que cada
 * termo também pode casar, além da designação: o picker de encomendas
 * procura também no nome do fabricante; a página de Stock, em DCI e ATC.
 */
export type OpcoesPesquisa = {
  colunasExtra?: Prisma.Sql[];
};

/**
 * O predicado (SEM o "AND" inicial) da pesquisa por artigo, ou `null` se o
 * texto não tem termos. Pura, testável sem BD.
 *
 * REGRA (ver `pesquisa-termos.ts`): o texto parte-se em termos (sem caixa,
 * sem acentos, pontuação e espaços como separadores); TODOS os termos são
 * obrigatórios (AND) e cada um procura-se separadamente, como subcadeia, na
 * designação — "parace ciclum", "ciclum parace" e "PARÁCE   cíclum"
 * encontram "PARACETAMOL CICLUM 650 MG 20 COMP.". Um termo só de dígitos
 * também pode casar com parte do CNP (`cnp::text LIKE`, texto e não
 * igualdade numérica, para "58800" encontrar "5880034").
 *
 * A designação compara-se via `unaccent_immutable(...)` dos DOIS lados
 * (migration 20260915140000_pesquisa_unaccent) — há um índice GIN trigram
 * funcional que mantém cada termo rápido; nunca se carrega nada para JS.
 *
 * Assume um `Produto` aliasado `p` (`p."cnp"`, `p."designacao"`).
 */
export function construirPredicadoPesquisa(
  pesquisa: string | undefined | null,
  opcoes: OpcoesPesquisa = {},
): Prisma.Sql | null {
  const termos = termosDePesquisa(pesquisa);
  if (termos.length === 0) return null;
  const extras = opcoes.colunasExtra ?? [];

  const porTermo = termos.map((termo) => {
    const padrao = `%${termo}%`;
    const textuais: Prisma.Sql[] = [
      Prisma.sql`unaccent_immutable(p."designacao") ILIKE unaccent_immutable(${padrao})`,
      ...extras.map((col) => Prisma.sql`unaccent_immutable(${col}) ILIKE unaccent_immutable(${padrao})`),
    ];
    // Só faz sentido procurar no CNP quando o termo são mesmo dígitos.
    // "depuralina" contra `cnp::text` nunca casa e só custa tempo.
    //
    // Num pedido com VÁRIOS termos, um número curto é quase sempre parte do
    // nome ("omega 3", "ciclum 650") e não um pedaço de CNP — "3" apareceria
    // no CNP de metade do catálogo. Por isso, com mais de um termo, só um
    // número de 4+ dígitos também casa o CNP ("8500 ciclum"). Um pedido de um
    // só termo numérico continua a comparar o CNP, qualquer que seja o
    // comprimento (o comportamento de sempre).
    const podeSerCnp = /^\d+$/.test(termo) && (termos.length === 1 || termo.length >= 4);
    if (podeSerCnp) {
      return Prisma.sql`(p."cnp"::text LIKE ${padrao} OR ${Prisma.join(textuais, " OR ")})`;
    }
    return textuais.length === 1 ? textuais[0] : Prisma.sql`(${Prisma.join(textuais, " OR ")})`;
  });

  return Prisma.join(porTermo, " AND ");
}

/**
 * A condição SQL da pesquisa por artigo, com o "AND" inicial — pronta a
 * inserir depois de um `WHERE 1 = 1`. `Prisma.empty` para termo vazio: sem
 * pesquisa, sem condição. Ver `construirPredicadoPesquisa` para a regra.
 */
export function construirCondicaoPesquisa(
  pesquisa: string | undefined | null,
  opcoes: OpcoesPesquisa = {},
): Prisma.Sql {
  const predicado = construirPredicadoPesquisa(pesquisa, opcoes);
  return predicado ? Prisma.sql`AND ${predicado}` : Prisma.empty;
}
