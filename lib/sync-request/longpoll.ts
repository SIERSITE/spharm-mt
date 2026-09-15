/**
 * lib/sync-request/longpoll.ts
 *
 * Núcleo PURO do long-poll de `GET .../sync-requests/pending` — sem
 * Prisma, sem `NextRequest`, para ser testável sem BD (ver
 * `scripts/tests/test-sync-on-demand.ts`).
 *
 * O problema que isto resolve: o botão "Sincronizar agora" em /stock
 * dependia, até aqui, de o agent fazer POLL curto (1-2 min) — a
 * latência efectiva era o intervalo entre polls, não o tempo de
 * trabalho. Este módulo permite ao endpoint MANTER o pedido do agent
 * em espera (o servidor "segura" a resposta) até aparecer algo
 * reclamável ou até `waitSeconds` esgotar — o mesmo padrão de
 * long-polling clássico, sem inventar WebSocket/SSE/tabela nova.
 *
 * O claim em si (a query `FOR UPDATE SKIP LOCKED`) continua a viver na
 * rota — este módulo só decide QUANDO repetir a tentativa.
 */

/** Tecto de segurança: nenhum caller pode pedir mais do que isto. */
export const LONGPOLL_MAX_WAIT_SECONDS = 25;

/** Intervalo entre tentativas internas de claim, enquanto se espera. */
export const LONGPOLL_POLL_INTERVAL_MS = 1200;

/**
 * Lê e valida o parâmetro `waitSeconds` da query string.
 *
 * `null`/ausente/inválido/`<= 0` → `0`, que é o comportamento actual
 * (resposta imediata) — nenhum chamador existente que não passe
 * `waitSeconds` muda de comportamento. Qualquer valor acima do tecto é
 * cortado para o tecto, nunca rejeitado (um agent com um valor
 * ligeiramente disparatado continua a funcionar, só sem o mínimo
 * benefício do exagero).
 */
export function clampWaitSeconds(
  raw: string | null,
  max: number = LONGPOLL_MAX_WAIT_SECONDS,
): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, max);
}

export type LongPollOptions = {
  waitSeconds: number;
  pollIntervalMs?: number;
  /** Injectável nos testes — evita esperar `waitSeconds` a sério. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectável nos testes — relógio determinístico. */
  now?: () => number;
};

/**
 * Repete `attemptClaim()` até devolver um array não-vazio, ou até
 * `waitSeconds` esgotar — o que vier primeiro.
 *
 * `waitSeconds <= 0` faz UMA tentativa e devolve de imediato, seja ela
 * vazia ou não — exactamente o comportamento de antes desta mudança,
 * para quem não pedir long-poll.
 *
 * Uma tentativa que já vem com algo NUNCA espera — é o caso "já havia
 * um pedido pendente no primeiro SELECT" do requisito.
 */
export async function longPollClaim<T>(
  attemptClaim: () => Promise<T[]>,
  options: LongPollOptions,
): Promise<T[]> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? LONGPOLL_POLL_INTERVAL_MS;

  let claimed = await attemptClaim();
  if (claimed.length > 0 || options.waitSeconds <= 0) {
    return claimed;
  }

  const deadline = now() + options.waitSeconds * 1000;
  while (claimed.length === 0 && now() < deadline) {
    const remaining = deadline - now();
    await sleep(Math.min(pollIntervalMs, Math.max(0, remaining)));
    claimed = await attemptClaim();
  }
  return claimed;
}
