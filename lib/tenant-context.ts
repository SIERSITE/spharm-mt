/**
 * Resolução do tenant corrente a partir do contexto de request Next.js.
 *
 * Nota: NÃO importamos `server-only` aqui porque `lib/prisma.ts` importa
 * este módulo, e os scripts CLI (worker, jobs/daily-enrich, seeds) puxam
 * `lib/prisma.ts` para obter `legacyPrisma`. Em Next.js bundler o
 * `server-only` resolve para no-op via export `react-server`; em `tsx`
 * (Node puro) ou falha em MODULE_NOT_FOUND ou throw. A função abaixo já
 * trata o caso "fora de request" via try/catch — o marker era cosmético.
 * Single source of truth — qualquer sítio que precise de saber o slug
 * activo deve chamar `resolveCurrentTenantSlug()` e não ler headers
 * directamente.
 *
 * Importante: usa `headers()` de `next/headers`, que em Next 16 é
 * ASYNC. Isto obriga a que esta função seja async; é a razão pela
 * qual o `getPrisma()` também tem de ser async.
 *
 * Fora de contexto de request (scripts, cron), `headers()` atira. O
 * try/catch captura e devolve null — o caller cai no legacy fallback.
 */

/**
 * Tenant onde "Sincronizar agora" está desligado (2026-09) — garantia está
 * a meio de uma classificação cuidada de fabricantes/grupos laboratoriais,
 * e uma sincronização automática do ERP podia reescrever essa curadoria
 * por cima. Vive aqui (módulo simples, sem "use server") em vez de em
 * `app/stock/sync-actions.ts` porque um ficheiro `"use server"` só pode
 * exportar funções — uma constante lá dentro rebentava o build. Usado por
 * `app/stock/sync-actions.ts` (recusa no servidor) e `app/stock/page.tsx`
 * (esconde o widget) — as DUAS camadas lêem a mesma fonte.
 */
export const TENANT_SYNC_BLOQUEADO = "garantia";

/**
 * Tenant onde o filtro de fabricante do catálogo passa a trabalhar sobre
 * o grupo laboratorial pesquisável (ver lib/catalog/resolver-grupo-laboratorial.ts)
 * em vez de só `Fabricante`. Mesmo valor que `TENANT_SYNC_BLOQUEADO` hoje,
 * mas é uma decisão DISTINTA — vive numa constante própria para as duas
 * poderem divergir sem confusão sobre "qual delas isto verifica".
 */
export const TENANT_GRUPOS_LABORATORIAIS = "garantia";

export async function resolveCurrentTenantSlug(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const slug = h.get("x-tenant-slug");
    return slug && slug.length > 0 ? slug : null;
  } catch {
    // Não estamos num request — ex: script CLI, seed, cron.
    return null;
  }
}
