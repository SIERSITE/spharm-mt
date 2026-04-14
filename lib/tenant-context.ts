import "server-only";

/**
 * Resolução do tenant corrente a partir do contexto de request Next.js.
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
