/**
 * lib/encomendas/limites.ts
 *
 * Os tectos da proposta de encomenda.
 *
 * ── Porque não vivem em `proposal.ts` ────────────────────────────────
 *
 * Porque o cliente precisa deles para escrever a mensagem de truncagem,
 * e `proposal.ts` tem `import "server-only"`. Um `import type` daí é
 * inofensivo — apaga-se na compilação — mas importar um VALOR arrasta o
 * módulo inteiro para o bundle do browser e o build morre em
 * `Module not found: 'server-only'`.
 *
 * O `tsc` não apanha isto: para ele `server-only` resolve. Só o bundler
 * é que sabe, e só no `next build`. Foi assim que apareceu.
 *
 * Módulo PURO: sem Prisma, sem React, sem `server-only`.
 */

/**
 * Tecto TÉCNICO de linhas por farmácia numa proposta.
 *
 * ── Porque deixou de ser 500 ─────────────────────────────────────────
 *
 * 500 era um limite FUNCIONAL disfarçado de técnico: com
 * `ORDER BY qty DESC`, a proposta era «os 500 artigos que mais vendem»,
 * e quem pedia uma análise de 2 000 recebia 500 sem o saber. Uma lista
 * importada torna isso indefensável — o utilizador nomeou os artigos um
 * a um.
 *
 * ── Porque 5 000, e não «sem limite» ─────────────────────────────────
 *
 * Porque um limite tem de existir e é melhor ser explícito do que
 * descobrir-se em produção. O número vem de três restrições reais:
 *
 *   · a tabela da proposta renderiza TODAS as linhas no DOM (não há
 *     virtualização); 5 000 linhas × ~15 células são ~75 000 nós, que o
 *     browser aguenta e 50 000 linhas não;
 *
 *   · a resposta da Server Action transporta as linhas em JSON, a ~400
 *     bytes cada — 5 000 dão ~2 MB;
 *
 *   · em modo grupo a proposta corre uma vez POR FARMÁCIA e concatena.
 *     Com cinco farmácias, 5 000 por farmácia são 25 000 linhas no
 *     cliente. É o tecto real da página.
 *
 * 5 000 é 10× o anterior e está acima de qualquer lista realista por
 * farmácia: `MAX_CODIGOS` da importação é 25 000, mas essa é a lista do
 * GRUPO, e um artigo só produz linha nas farmácias onde existe.
 *
 * ── E quando for atingido ────────────────────────────────────────────
 *
 * Nunca em silêncio. `meta.truncated` fica `true`, a UI mostra-o, e o
 * utilizador sabe que está a ver uma parte.
 */
export const MAX_LINHAS_PROPOSTA = 5_000;
