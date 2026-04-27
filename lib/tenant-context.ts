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
