/**
 * lib/catalog/cnp-catalogavel.ts
 *
 * A regra ÚNICA de "este CNP é um produto de catálogo, ou é um código
 * interno do ERP?".
 *
 * Porque é que isto passou a ter módulo próprio: a mesma regra estava
 * escrita em dois sítios, com o mesmo valor e operadores diferentes.
 *
 *   lib/catalog-enrichment.ts        MIN_CATALOGUABLE_CNP  cnp >  2 000 000
 *   lib/catalog/knowledge-enrichment-runner.ts  MIN_CNP    cnp >= 2 000 000
 *
 * Um produto com CNP exactamente 2 000 000 era não-cataloguável por um
 * caminho e elegível para enriquecimento pelo outro. A discrepância nunca
 * deu erro — deu duas contagens diferentes da mesma população, que é pior,
 * porque não se anuncia.
 *
 * QUAL DAS DUAS É A CERTA — pela intenção escrita, não pela votação:
 * o comentário que acompanha `MIN_CATALOGUABLE_CNP` desde o início diz
 * «os códigos com CNP <= 2.000.000 são internos do ERP», e `enrichProduct`
 * recusa-se a correr sobre eles com essa mesma fronteira. A intenção
 * documentada é que 2 000 000 seja INTERNO. O `>=` do runner é o desvio,
 * e é ele que se corrige.
 *
 * Consequência prática: nenhuma. Um CNP de exactamente 2 000 000 é um
 * valor de fronteira que não corresponde a nenhum código real do INFARMED
 * (os CNP nacionais têm 7 dígitos e começam bem acima). O que se ganha é
 * que as duas contagens passam a poder ser comparadas.
 *
 * Módulo PURO de propósito: sem Prisma, sem `server-only`, sem rede. É
 * importado pelo runner, pelos KPI, pelos diagnósticos e pelos testes —
 * qualquer dependência pesada aqui arrastava metade da app para dentro
 * de um script de diagnóstico.
 */

/**
 * Fronteira entre código interno do ERP e produto de catálogo.
 *
 * Abaixo ou igual a este valor estão taxas, serviços, atos clínicos e
 * artigos de stock interno. Não têm CNP nacional, não existem em fontes
 * externas, e não há classificação nenhuma a atribuir-lhes.
 */
export const MIN_CNP_CATALOGAVEL = 2_000_000;

/**
 * O produto entra no catálogo regulamentar?
 *
 * `null`/`undefined` lê-se como NÃO — um produto sem CNP não é
 * cataloguável, e devolver `true` por omissão punha códigos sem
 * identidade dentro do universo classificável.
 */
export function ehCnpCatalogavel(cnp: number | null | undefined): boolean {
  return typeof cnp === "number" && Number.isFinite(cnp) && cnp > MIN_CNP_CATALOGAVEL;
}

/**
 * O predicado em SQL, com o nome da tabela por parâmetro.
 *
 * Devolve texto e não `Prisma.sql` de propósito: metade dos chamadores
 * são `$queryRawUnsafe`/`$executeRawUnsafe` com SQL montado à mão, e um
 * fragmento tipado obrigaria a duas versões da mesma regra — que é
 * exactamente o problema que este módulo existe para resolver.
 *
 * O valor é interpolado directamente porque é uma CONSTANTE deste
 * ficheiro, nunca input. Não há aqui superfície de injecção.
 */
export function sqlCnpCatalogavel(alias = "p"): string {
  return `${alias}.cnp > ${MIN_CNP_CATALOGAVEL}`;
}

/** O complemento — os códigos internos, para os contar em separado. */
export function sqlCnpInterno(alias = "p"): string {
  return `${alias}.cnp <= ${MIN_CNP_CATALOGAVEL}`;
}

/**
 * Filtro Prisma equivalente, para os chamadores que usam o query builder.
 *
 * Devolvido por função e não como constante: um objecto partilhado que
 * alguém espalhe com `...WHERE_CATALOGAVEL` e depois mute corrompe todos
 * os outros chamadores em silêncio. É o mesmo erro que a `POLICY_DEFAULT`
 * já apanhou uma vez.
 */
export function whereCnpCatalogavel(): { gt: number } {
  return { gt: MIN_CNP_CATALOGAVEL };
}

/** Idem, para contar o que fica de fora. */
export function whereCnpInterno(): { lte: number } {
  return { lte: MIN_CNP_CATALOGAVEL };
}
