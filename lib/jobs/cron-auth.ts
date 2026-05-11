/**
 * lib/jobs/cron-auth.ts
 *
 * Verificação de credencial para endpoints de scheduler. Vercel Cron
 * envia automaticamente `Authorization: Bearer ${CRON_SECRET}` ao
 * disparar um cron job; o nosso job é também invocável manualmente
 * para testes/debug, daí o duplo path: header OU query `?secret=`.
 *
 * Política:
 *   · Se `CRON_SECRET` não estiver definido em env, recusa SEMPRE
 *     (defesa contra deploys mal-configurados que ficariam abertos).
 *   · Compara em timing-safe via `crypto.timingSafeEqual` quando o
 *     comprimento bate; senão recusa imediatamente.
 *
 * Não tem `import "server-only"` para permitir testes via tsx CLI.
 */

import { timingSafeEqual } from "node:crypto";

export type CronAuthResult =
  | { ok: true }
  | { ok: false; reason: "missing_env" | "missing_credential" | "invalid_credential" };

/**
 * Pure: dado o secret esperado e o secret recebido, devolve ok/reason.
 * Não toca em headers nem em env — facilita testes determinísticos.
 */
export function verifyCronSecret(expected: string | null | undefined, received: string | null | undefined): CronAuthResult {
  if (!expected || expected.length === 0) return { ok: false, reason: "missing_env" };
  if (!received || received.length === 0) return { ok: false, reason: "missing_credential" };
  if (expected.length !== received.length) return { ok: false, reason: "invalid_credential" };
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "invalid_credential" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "invalid_credential" };
}

/**
 * Extrai a credencial recebida pelos canais aceites:
 *   1. `Authorization: Bearer <secret>` (Vercel Cron envia este)
 *   2. `?secret=<secret>` na query string (manual / curl)
 *
 * Retorna null se nenhum dos canais trouxer valor.
 */
export function extractCronCredential(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("secret");
    if (q && q.length > 0) return q;
  } catch {
    // URL inválida — ignora
  }
  return null;
}

/**
 * Entrada única para route handlers: valida com base no `CRON_SECRET`
 * de env e devolve ok/reason. Não escreve resposta — caller decide
 * status code e payload.
 */
export function authorizeCronRequest(req: Request): CronAuthResult {
  const expected = process.env.CRON_SECRET ?? null;
  const received = extractCronCredential(req);
  return verifyCronSecret(expected, received);
}
