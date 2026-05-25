/**
 * lib/aggregate/chunk-util.ts
 *
 * Utilitários partilhados pela agregação hardened (compras/devoluções):
 * chunking temporal por mês, retry seguro de operações idempotentes.
 * Pure-ish (sem Prisma) → importável de rotas e de scripts.
 */

/**
 * Divide [from, to) em janelas mensais alinhadas ao dia (UTC). Como a
 * agregação agrupa por `date_trunc('day', ...)`, nenhum grupo-dia
 * atravessa a fronteira de um mês → cada chunk é independente e pode
 * fazer commit isolado sem partir somas.
 */
export function monthChunks(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = [];
  let cur = new Date(from);
  let guard = 0;
  while (cur < to && guard++ < 1200) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const end = next < to ? next : to;
    out.push({ from: new Date(cur), to: new Date(end) });
    cur = next;
  }
  return out;
}

/** Erros transientes onde re-tentar é seguro (operação é idempotente). */
export function isRetryable(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("could not serialize") ||
    msg.includes("deadlock") ||
    msg.includes("lock_not_available") ||
    msg.includes("55p03") ||
    msg.includes("40001") ||
    msg.includes("40p01") ||
    msg.includes("acquire_lock") ||
    msg.includes("connection terminated") ||
    msg.includes("connection closed") ||
    msg.includes("timeout")
  );
}

/**
 * Retry com backoff exponencial. Só re-tenta erros transientes
 * (`isRetryable`); o resto propaga imediatamente. O caller garante que
 * `fn` é idempotente (UPSERT ON CONFLICT).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; baseMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 4;
  const baseMs = opts?.baseMs ?? 200;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts - 1 || !isRetryable(e)) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}
