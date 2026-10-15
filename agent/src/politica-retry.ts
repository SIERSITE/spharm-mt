/**
 * agent/src/politica-retry.ts
 *
 * Política CENTRALIZADA de retentativas dos pedidos HTTP do agent ao SaaS.
 * Puro (sem rede, sem relógio, sem I/O): tudo o que decide «repete-se ou não»
 * e «quanto se espera» vive aqui e é testável de forma determinística.
 *
 * ── Porquê ──────────────────────────────────────────────────────────
 *
 * Em 15/10/2026 o pipeline diário da Silveirense morreu com
 * `SaaS POST /api/ingest/v1/bootstrap/products — falha de rede: fetch failed`
 * ao 6.º lote — e o servidor JÁ tinha processado esse lote (HTTP 200,
 * upserted=50, errors=0): a RESPOSTA perdeu-se. O cliente não repetia nada, o
 * agent abortou o pipeline inteiro, e a recuperação ficou dependente do
 * `RestartOnFailure` do Agendador do Windows (que não reexecutou).
 *
 * ── Resposta perdida ≠ pedido perdido ───────────────────────────────
 *
 * Quando o pedido falha, nem sempre se sabe se o servidor chegou a recebê-lo.
 * `ambigua` marca os casos em que o servidor PODE já ter escrito (a ligação
 * caiu/expirou depois de o pedido ser enviado, ou o servidor respondeu 5xx).
 * Repetir um pedido ambíguo só é seguro porque cada endpoint do pipeline é
 * idempotente — ver `agent/docs/resiliencia.md` (auditoria por endpoint). Nunca
 * se avança nenhum cursor local com base numa tentativa de resultado desconhecido:
 * o chamador só avança quando recebe uma resposta válida.
 */

export type PoliticaRetry = {
  /**
   * Esperas ANTES de cada retentativa, em ms. O número de retentativas é o
   * comprimento da lista (tentativa original + N retentativas). Vazia = sem retry.
   */
  esperasMs: number[];
  /** Fração de jitter (0..1) somada à espera: espera × (1 + U[0, jitter]). */
  jitter: number;
  /** `Retry-After` acima disto é ignorado (usa-se a espera da política). */
  retryAfterMaxMs: number;
  /** Timeout por pedido (por tentativa). */
  timeoutMs: number;
};

/** Política segura por omissão: original + 4 retentativas (≈ 5, 15, 30 e 60 s). */
export const POLITICA_PADRAO: Readonly<PoliticaRetry> = Object.freeze({
  esperasMs: [5_000, 15_000, 30_000, 60_000],
  jitter: 0.2,
  retryAfterMaxMs: 120_000,
  timeoutMs: 30_000,
});

/** HTTP que se repetem: pedido não aceite agora (408/425/429) ou proxy/servidor indisponível (502/503/504). */
export const STATUS_RETENTAVEIS: ReadonlySet<number> = new Set([408, 425, 429, 502, 503, 504]);

/**
 * HTTP que NUNCA se repetem sozinhos: o servidor respondeu e decidiu (validação, auth,
 * configuração, conflito de negócio). Repetir daria a mesma resposta, mais devagar.
 * (Lista informativa; qualquer status fora de `STATUS_RETENTAVEIS` não é repetido.)
 */
export const STATUS_PERMANENTES: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 422]);

export type TipoFalha =
  | "rede" // fetch failed sem causa mais específica
  | "timeout"
  | "ligacao_reiniciada" // ECONNRESET / socket fechado / UND_ERR_SOCKET
  | "dns_temporario"
  | "ligacao_recusada"
  | "resposta_truncada" // o corpo da resposta não chegou inteiro / não é JSON
  | "http_retentavel"
  | "http_permanente"
  | "configuracao"
  | "outro";

export type ClasseFalha = {
  tipo: TipoFalha;
  retentavel: boolean;
  /**
   * `true` quando o servidor PODE já ter processado o pedido (ligação caiu/expirou depois
   * de enviar, resposta truncada, 5xx). `false` quando é seguro afirmar que não chegou a escrever
   * (DNS, ligação recusada, 429/408/425).
   */
  ambigua: boolean;
  statusCode?: number;
  /** Código técnico (ECONNRESET, ENOTFOUND, UND_ERR_...) quando existe. */
  codigo?: string;
};

type ComCausa = { name?: string; message?: string; code?: unknown; cause?: unknown };

/** Percorre `err.cause` (undici esconde o motivo real aí) e devolve o primeiro `code` string. */
export function codigoDaCausa(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const c = cur as ComCausa;
    if (typeof c.code === "string" && c.code) return c.code;
    cur = c.cause;
  }
  return undefined;
}

const CODIGOS_DNS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME"]);
const CODIGOS_RECUSADA = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN"]);
const CODIGOS_RESET = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_RESPONSE_STATUS_CODE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
const CODIGOS_TIMEOUT = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ESOCKETTIMEDOUT",
]);

/** Erros de configuração/validação local: nunca se repetem. */
export class ErroDeConfiguracao extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErroDeConfiguracao";
  }
}

/**
 * Classifica uma exceção lançada por `fetch` (ou ao ler o corpo da resposta).
 * `faseCorpo = true` quando o erro surgiu ao LER a resposta (o servidor chegou a responder).
 */
export function classificarErroDeRede(err: unknown, opts: { faseCorpo?: boolean } = {}): ClasseFalha {
  if (err instanceof ErroDeConfiguracao) return { tipo: "configuracao", retentavel: false, ambigua: false };
  const e = (err ?? {}) as ComCausa;
  const nome = String(e.name ?? "");
  const msg = String(e.message ?? err ?? "").toLowerCase();
  const codigo = codigoDaCausa(err);

  if (nome === "AbortError" || nome === "TimeoutError" || /\babort(ed)?\b/.test(msg) || /timed? ?out/.test(msg)) {
    return { tipo: "timeout", retentavel: true, ambigua: true, codigo };
  }
  if (opts.faseCorpo) {
    return { tipo: "resposta_truncada", retentavel: true, ambigua: true, codigo };
  }
  if (codigo && CODIGOS_DNS.has(codigo)) return { tipo: "dns_temporario", retentavel: true, ambigua: false, codigo };
  if (codigo && CODIGOS_RECUSADA.has(codigo)) return { tipo: "ligacao_recusada", retentavel: true, ambigua: false, codigo };
  if (codigo && CODIGOS_RESET.has(codigo)) return { tipo: "ligacao_reiniciada", retentavel: true, ambigua: true, codigo };
  if (codigo && CODIGOS_TIMEOUT.has(codigo)) return { tipo: "timeout", retentavel: true, ambigua: true, codigo };
  if (/socket hang up|premature close|other side closed|terminated|connection (was )?(reset|closed)/.test(msg)) {
    return { tipo: "ligacao_reiniciada", retentavel: true, ambigua: true, codigo };
  }
  if (/enotfound|eai_again/.test(msg)) return { tipo: "dns_temporario", retentavel: true, ambigua: false, codigo };
  if (/econnrefused/.test(msg)) return { tipo: "ligacao_recusada", retentavel: true, ambigua: false, codigo };
  if (/fetch failed|network|econnreset|etimedout/.test(msg)) {
    // `fetch failed` sem causa identificável: não se sabe se o pedido chegou a ser enviado.
    return { tipo: "rede", retentavel: true, ambigua: true, codigo };
  }
  return { tipo: "outro", retentavel: false, ambigua: false, codigo };
}

/** Classifica um HTTP já recebido. */
export function classificarStatus(status: number): ClasseFalha {
  if (STATUS_RETENTAVEIS.has(status)) {
    // 408 (o servidor desistiu de esperar pelo pedido) e 5xx de proxy: o pedido pode ter chegado
    // à aplicação. 425/429: rejeitado antes de processar.
    const ambigua = status === 408 || status === 502 || status === 503 || status === 504;
    return { tipo: "http_retentavel", retentavel: true, ambigua, statusCode: status };
  }
  return { tipo: "http_permanente", retentavel: false, ambigua: false, statusCode: status };
}

/**
 * `Retry-After`: segundos (inteiro) ou data HTTP. Devolve ms, ou `null` se ausente/ilegível.
 */
export function parseRetryAfter(valor: string | null | undefined, agoraMs: number): number | null {
  if (!valor) return null;
  const t = valor.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const data = Date.parse(t);
  if (Number.isFinite(data)) return Math.max(0, data - agoraMs);
  return null;
}

/**
 * Espera antes da retentativa nº `retentativa` (1 = primeira retentativa).
 * `Retry-After` razoável (≤ `retryAfterMaxMs`) manda, sem nunca ser inferior à espera da política;
 * o jitter é sempre somado (nunca subtraído) para não encurtar uma espera pedida pelo servidor.
 * `aleatorio` ∈ [0,1) injetável para testes.
 */
export function calcularEspera(
  retentativa: number,
  politica: PoliticaRetry,
  retryAfterMs: number | null,
  aleatorio: () => number = Math.random,
): number {
  const base = politica.esperasMs[Math.min(Math.max(retentativa, 1), politica.esperasMs.length) - 1] ?? 0;
  const pedido = retryAfterMs !== null && retryAfterMs <= politica.retryAfterMaxMs ? retryAfterMs : null;
  const escolhida = pedido !== null ? Math.max(base, pedido) : base;
  return Math.round(escolhida * (1 + Math.max(0, politica.jitter) * aleatorio()));
}

/** Mescla parcial sobre a política padrão, ignorando valores inválidos. */
export function mesclarPolitica(parcial?: Partial<PoliticaRetry> | null, base: PoliticaRetry = POLITICA_PADRAO): PoliticaRetry {
  const p = parcial ?? {};
  const esperas =
    Array.isArray(p.esperasMs) && p.esperasMs.every((n) => Number.isFinite(n) && n >= 0)
      ? p.esperasMs.map((n) => Math.floor(n))
      : base.esperasMs;
  const jitter = typeof p.jitter === "number" && p.jitter >= 0 && p.jitter <= 1 ? p.jitter : base.jitter;
  const ra = typeof p.retryAfterMaxMs === "number" && p.retryAfterMaxMs >= 0 ? p.retryAfterMaxMs : base.retryAfterMaxMs;
  const to = typeof p.timeoutMs === "number" && p.timeoutMs >= 1_000 ? Math.floor(p.timeoutMs) : base.timeoutMs;
  return { esperasMs: [...esperas], jitter, retryAfterMaxMs: ra, timeoutMs: to };
}

/**
 * Política a partir do ambiente (preenchido por `agent.config.json → options.*` ou diretamente).
 * Sem nenhuma variável: a política padrão. Valores inválidos são ignorados (nunca partem o agent).
 *   SPHARMMT_HTTP_RETRY_ESPERAS_MS   "5000,15000,30000,60000"   ("" ou "0" desliga o retry)
 *   SPHARMMT_HTTP_RETRY_JITTER       0.2
 *   SPHARMMT_HTTP_TIMEOUT_MS         30000
 *   SPHARMMT_HTTP_RETRY_AFTER_MAX_MS 120000
 */
export function politicaDoAmbiente(env: Record<string, string | undefined> = process.env): PoliticaRetry {
  const parcial: Partial<PoliticaRetry> = {};
  const esp = env.SPHARMMT_HTTP_RETRY_ESPERAS_MS;
  if (esp !== undefined) {
    const t = esp.trim();
    if (t === "" || t === "0") parcial.esperasMs = [];
    else {
      const nums = t.split(",").map((x) => Number(x.trim()));
      if (nums.every((n) => Number.isFinite(n) && n >= 0)) parcial.esperasMs = nums;
    }
  }
  const j = env.SPHARMMT_HTTP_RETRY_JITTER;
  if (j !== undefined && j.trim() !== "" && Number.isFinite(Number(j))) parcial.jitter = Number(j);
  const to = env.SPHARMMT_HTTP_TIMEOUT_MS;
  if (to !== undefined && to.trim() !== "" && Number.isFinite(Number(to))) parcial.timeoutMs = Number(to);
  const ra = env.SPHARMMT_HTTP_RETRY_AFTER_MAX_MS;
  if (ra !== undefined && ra.trim() !== "" && Number.isFinite(Number(ra))) parcial.retryAfterMaxMs = Number(ra);
  return mesclarPolitica(parcial);
}

// ── Sinalização de falha transitória definitiva (para o orquestrador) ──────

/**
 * Código de saída de um comando cujo pedido ao SaaS falhou por causa TRANSITÓRIA mesmo depois de
 * esgotadas as retentativas HTTP (convenção BSD `EX_TEMPFAIL`). O `daily-pipeline` usa-o para
 * distinguir «vale a pena esperar e repetir» de «falha permanente».
 */
export const EXIT_TRANSITORIO = 75;

let falhaTransitoriaDefinitiva = false;
/** Chamado pelo cliente HTTP quando esgota as retentativas de uma falha retentável. */
export function marcarFalhaTransitoriaDefinitiva(): void {
  falhaTransitoriaDefinitiva = true;
}
export function houveFalhaTransitoriaDefinitiva(): boolean {
  return falhaTransitoriaDefinitiva;
}
/** Só para testes. */
export function repor(): void {
  falhaTransitoriaDefinitiva = false;
}

/** Uma exceção do cliente HTTP representa uma falha que valeria a pena repetir mais tarde? */
export function eFalhaTransitoria(err: unknown): boolean {
  const e = err as { transitoria?: unknown } | null;
  return !!e && typeof e === "object" && e.transitoria === true;
}

// ── Redação de segredos nos logs ────────────────────────────────────

/** Remove segredos conhecidos e padrões de credenciais de um texto antes de o registar. */
export function redigir(texto: string, segredos: ReadonlyArray<string | undefined> = []): string {
  let out = texto;
  for (const s of segredos) {
    if (s && s.length >= 6) out = out.split(s).join("[REDIGIDO]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [REDIGIDO]");
  out = out.replace(/("?(?:ingestKey|password|sqlPassword|authorization|api[-_]?key)"?\s*[:=]\s*)"?[^"\s,}]+"?/gi, "$1[REDIGIDO]");
  return out;
}
