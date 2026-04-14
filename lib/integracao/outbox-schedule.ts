import "server-only";

/**
 * Backoff schedule para retries de exportação de ordens.
 *
 * attemptCount é incrementado ANTES de chamarmos nextDelayMs. Portanto:
 *   attempt 1 falhou → nextDelayMs(1) = 1 min  (próxima tentativa)
 *   attempt 2 falhou → nextDelayMs(2) = 5 min
 *   attempt 3 falhou → nextDelayMs(3) = 30 min
 *   attempt 4 falhou → nextDelayMs(4) = 2 h
 *   attempt 5 falhou → nextDelayMs(5) = 8 h
 *   attempt 6 falhou → MAX — transita para FALHADO, sem nova tentativa
 *
 * Ajustável via env var `OUTBOX_MAX_ATTEMPTS` em testes/staging.
 */

const SCHEDULE_MS = [
  60_000, //       1 min
  5 * 60_000, //   5 min
  30 * 60_000, //  30 min
  2 * 60 * 60_000, //  2 h
  8 * 60 * 60_000, //  8 h
];

export const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 6);

export function nextDelayMs(attemptsMade: number): number | null {
  if (attemptsMade >= MAX_ATTEMPTS) return null;
  const idx = Math.min(attemptsMade - 1, SCHEDULE_MS.length - 1);
  return SCHEDULE_MS[Math.max(0, idx)];
}

export function computeNextAttemptAt(attemptsMade: number): Date | null {
  const d = nextDelayMs(attemptsMade);
  return d === null ? null : new Date(Date.now() + d);
}
