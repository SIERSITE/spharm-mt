/**
 * lib/db-providers/neon.ts
 *
 * Provider que cria DBs por tenant via Neon API (REST). Em modo
 * automático, basta NEON_API_KEY + NEON_PROJECT_ID no .env do operador
 * e o workflow `tenant:create` deixa de precisar do dashboard Neon
 * para onboarding de novos clientes.
 *
 * Fluxo de `createDatabase`:
 *   1. POST /projects/{pid}/branches/{bid}/roles      ← gera role + password
 *   2. POST /projects/{pid}/branches/{bid}/databases  ← cria DB owner=role
 *   3. GET  /projects/{pid}/connection_uri            ← obtém URL pooled
 *   4. SELECT 1 via PrismaPg                          ← smoke connectivity
 *
 * Rollback em qualquer um dos passos 2-4 desfaz os passos anteriores
 * (DROP DATABASE + DROP ROLE) por chamadas DELETE à API. Se a chamada
 * de cleanup falhar, surge na mensagem de erro para o caller decidir.
 *
 * Branch resolution: o primeiro `default`/`primary` é cacheado para
 * todas as operações desta instância. Cada Neon project tem pelo menos
 * uma branch (`main` em projectos novos).
 *
 * HTTP 423 (Locked) → retry com exponential backoff:
 *   Neon devolve 423 quando há outra operação a correr no mesmo
 *   project (autoscaling, criação concorrente de role/db). É
 *   tipicamente transitório (segundos a um minuto). O provider
 *   re-tenta automaticamente cada operação afectada com backoff
 *   exponencial + jitter, até `retryMaxAttempts` (default 5) ou
 *   `retryMaxTotalMs` por op (default 90s). Esgotado o orçamento,
 *   atira mensagem accionável. DELETEs em cleanup não fazem retry
 *   (são best-effort).
 *
 * Auth: header `Authorization: Bearer <NEON_API_KEY>`.
 *
 * Documentação API: https://api-docs.neon.tech/reference/getting-started
 */

import { URL } from "node:url";
import type { ConnectionTargets, DatabaseProvider } from "./types";
import { slugToDbNames } from "../../scripts/tenancy/_shared";
import { testTenantDbReachable } from "./connectivity";

/**
 * Tipo do `fetch` global injectável. Permite testes com mock fetcher
 * sem precisar de polyfill ou monkeypatch.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Sleep injectável — tests passam função instantânea. */
export type SleepLike = (ms: number) => Promise<void>;

export type NeonRetryInfo = {
  /** Label do step que falhou (ex: "createRole", "createDatabase"). */
  label: string;
  /** 1-based; o número da próxima tentativa (já feita falhou). */
  attempt: number;
  maxAttempts: number;
  nextDelayMs: number;
  totalElapsedMs: number;
  lastError: string;
};

/** Info por tentativa do retry do SELECT 1 (eventual consistency). */
export type NeonSmokeRetryInfo = {
  attempt: number;            // 1-based, tentativa que acabou de falhar
  maxAttempts: number;
  nextDelayMs: number;
  totalElapsedMs: number;
  lastError: string;
  /** Código sqlstate se conhecido (3D000 = undefined_database). */
  sqlState?: string;
};

export type NeonProviderConfig = {
  apiKey: string;
  projectId: string;
  /** Apenas informativo — Neon escolhe região do projecto, não da DB. */
  defaultRegion?: string;
  /** Default `https://console.neon.tech/api/v2`. Override para testes. */
  apiBaseUrl?: string;
  /** Override do `fetch` global — usado em testes. */
  fetcher?: FetchLike;

  // ── Retry config (todos opcionais, defaults sensatos abaixo) ────
  /** Máximo de tentativas por operação. Default 5. */
  retryMaxAttempts?: number;
  /** Delay base do backoff exponencial em ms. Default 1500. */
  retryBaseDelayMs?: number;
  /** Cap por delay individual. Default 15000. */
  retryMaxDelayMs?: number;
  /** Cap total por operação. Default 90000 (90s). */
  retryMaxTotalMs?: number;
  /**
   * Hook chamado antes de cada delay. Default = console.warn com
   * mensagem accionável. Passa `() => {}` para silenciar em tests.
   */
  onRetry?: (info: NeonRetryInfo) => void;
  /** Sleep injectável. Default = setTimeout. Tests passam async () => {}. */
  sleep?: SleepLike;

  // ── Smoke (SELECT 1) retry — eventual consistency Neon ─────────
  /**
   * Sequência de delays entre tentativas do SELECT 1 contra a DB
   * recém-criada. Length = (maxAttempts - 1) porque a primeira tentativa
   * é imediata. Default: [1000, 2000, 3000, 5000, 8000, 8000, 8000, 8000,
   * 8000] → 10 tentativas, ≤ 51s total.
   *
   * Motivo: a API Neon devolve OK ao CREATE DATABASE mas o pooler
   * endpoint demora alguns segundos a ter routing para a nova DB; até
   * lá, SELECT 1 falha com sqlstate 3D000 ("database does not exist").
   */
  smokeRetryDelaysMs?: number[];
  /** Hook por tentativa. Default = console.warn com mensagem. */
  onSmokeRetry?: (info: NeonSmokeRetryInfo) => void;
  /**
   * Helper de connectivity injectável. Default = testTenantDbReachable.
   * Útil para tests simularem falhas/transient na sequência.
   */
  smokeReachable?: (connectionUrl: string) => Promise<void>;
};

type NeonRoleResponse = {
  role: {
    name: string;
    password?: string;
    branch_id?: string;
    created_at?: string;
  };
};

type NeonBranchListResponse = {
  branches: Array<{
    id: string;
    name: string;
    default?: boolean;
    primary?: boolean;
  }>;
};

type NeonConnectionUriResponse = {
  uri: string;
};

const DEFAULT_API_BASE_URL = "https://console.neon.tech/api/v2";
const DEFAULT_RETRY_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 1500;
const DEFAULT_RETRY_MAX_DELAY_MS = 15000;
const DEFAULT_RETRY_MAX_TOTAL_MS = 90_000;

// 10 tentativas, ≤ 51s total. Cobre janela típica de propagação Neon
// (5-15s) com folga; primeira tentativa imediata, depois 1+2+3+5+8+8+8+8+8s.
const DEFAULT_SMOKE_RETRY_DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 8000, 8000, 8000, 8000];

/** sqlstate 3D000 = undefined_database (Postgres). */
const SQLSTATE_UNDEFINED_DATABASE = "3D000";

/**
 * Decide se um erro de smoke connectivity merece retry — i.e. se é
 * transiente (eventual consistency, ECONNRESET, etc.) e não um problema
 * permanente (auth errada, sslmode em falta, host indevidamente formado).
 *
 * Retryable:
 *   · sqlstate 3D000 (database does not exist) — DB ainda não propagou
 *     ao pooler/serverless endpoint
 *   · ECONNRESET, ETIMEDOUT, ECONNREFUSED, ENOTFOUND, EPIPE — network
 *     blips comuns durante warm-up Neon
 *   · "Connection terminated unexpectedly" — Neon serverless a inicializar
 *
 * Não retryable: auth (28P01), sslmode (28000), permission (42501),
 * sintaxe de URL inválida.
 */
export function isRetryableSmokeError(err: unknown): { retryable: boolean; sqlState?: string } {
  if (!err) return { retryable: false };
  const msg = err instanceof Error ? err.message : String(err);

  // Extrair sqlstate. Formatos vistos em produção:
  //   · pg raw:    "code: '3D000'" / "code: \"3D000\""
  //   · Prisma:    "Code: `3D000`"            ← com backticks (PrismaClientKnownRequestError)
  //   · genérico:  "Code 3D000" / "sqlstate 3D000"
  //
  // O regex cobre os três: separador `:` opcional, qualquer delimitador
  // antes do código (', ", `, espaço, sem nada), 5 hex/digits.
  const codeMatch =
    msg.match(/\b(?:Code|sqlstate)[:\s]+[`'"]?([0-9A-Z]{5})[`'"]?/i) ??
    msg.match(/\bcode:\s*[`'"]?([0-9A-Z]{5})[`'"]?/i);
  const sqlState = codeMatch ? codeMatch[1].toUpperCase() : undefined;

  if (sqlState === SQLSTATE_UNDEFINED_DATABASE) return { retryable: true, sqlState };

  // "database X does not exist" — fallback caso o sqlstate não venha
  // por algum motivo (mensagem em PT, wrapper externo, etc.).
  if (/database\s+["`']?[^"`'\s]+["`']?\s+does not exist/i.test(msg)) {
    return { retryable: true, sqlState: sqlState ?? "3D000" };
  }

  // Network errors — match-case relativamente conservadores
  const lower = msg.toLowerCase();
  const networkSignals = [
    "econnreset",
    "etimedout",
    "econnrefused",
    "enotfound",
    "epipe",
    "connection terminated unexpectedly",
    "connection terminated",
    "socket hang up",
    "timeout expired",
    "read econn",
  ];
  if (networkSignals.some((s) => lower.includes(s))) {
    return { retryable: true, sqlState };
  }

  return { retryable: false, sqlState };
}

/** Erro tipado da API Neon — caller pode discriminar via statusCode. */
export class NeonApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly path: string,
    public readonly method: string
  ) {
    super(message);
    this.name = "NeonApiError";
  }
}

function defaultOnRetry(info: NeonRetryInfo): void {
  console.warn(
    `[neon] ${info.label}: HTTP 423 (operação concorrente no project), ` +
      `retry ${info.attempt}/${info.maxAttempts} em ${info.nextDelayMs}ms ` +
      `(elapsed ${Math.floor(info.totalElapsedMs / 1000)}s)`
  );
}

function defaultOnSmokeRetry(info: NeonSmokeRetryInfo): void {
  const sqlBit = info.sqlState ? ` sqlstate=${info.sqlState}` : "";
  // Prefixo `[neon smoke]` consistente — permite grep no log do wizard.
  console.warn(
    `[neon smoke] attempt ${info.attempt}/${info.maxAttempts} falhou${sqlBit} ` +
      `apos ${Math.floor(info.totalElapsedMs / 1000)}s, sleep ${info.nextDelayMs}ms ` +
      `antes da proxima -- ${info.lastError.slice(0, 160)}`
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recompõe mensagem de erro para o caller de createDatabase. Se o
 * erro veio do retry esgotado (`Neon <label>: ...`), passa-through;
 * caso contrário, prefixa com label do step para diagnóstico.
 *
 * Distingue retry-exhausted ("Neon createRole: ...") de
 * NeonApiError raw ("Neon API POST /... → HTTP X: ..."), evitando
 * passar-through este último (perderia o label do step de alto nível).
 */
function reraseNeonError(err: unknown, label: string, subject: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Retry-exhausted: "Neon <label>: ..." onde <label> tem só letras
  if (/^Neon [A-Za-z]+: /.test(msg) && !msg.startsWith("Neon API ")) {
    return msg;
  }
  return `Neon: ${label}(${subject}) falhou — ${msg}`;
}

export class NeonProvider implements DatabaseProvider {
  readonly name = "neon";

  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly apiBaseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly defaultRegion: string;

  // Retry config (HTTP 423)
  private readonly retryMaxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryMaxTotalMs: number;
  private readonly onRetry: (info: NeonRetryInfo) => void;
  private readonly sleep: SleepLike;

  // Smoke (SELECT 1) retry config
  private readonly smokeRetryDelaysMs: number[];
  private readonly onSmokeRetry: (info: NeonSmokeRetryInfo) => void;
  private readonly smokeReachable: (connectionUrl: string) => Promise<void>;

  private cachedBranchId: string | null = null;

  constructor(cfg: NeonProviderConfig) {
    if (!cfg.apiKey || !cfg.apiKey.trim()) {
      throw new Error("NeonProvider: apiKey obrigatória");
    }
    if (!cfg.projectId || !cfg.projectId.trim()) {
      throw new Error("NeonProvider: projectId obrigatório");
    }
    this.apiKey = cfg.apiKey;
    this.projectId = cfg.projectId;
    this.apiBaseUrl = (cfg.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.defaultRegion = cfg.defaultRegion ?? "eu-west-2";
    this.fetcher = cfg.fetcher ?? ((input, init) => fetch(input, init));

    this.retryMaxAttempts = cfg.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
    this.retryBaseDelayMs = cfg.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = cfg.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryMaxTotalMs = cfg.retryMaxTotalMs ?? DEFAULT_RETRY_MAX_TOTAL_MS;
    this.onRetry = cfg.onRetry ?? defaultOnRetry;
    this.sleep = cfg.sleep ?? defaultSleep;

    this.smokeRetryDelaysMs = cfg.smokeRetryDelaysMs ?? DEFAULT_SMOKE_RETRY_DELAYS_MS;
    this.onSmokeRetry = cfg.onSmokeRetry ?? defaultOnSmokeRetry;
    this.smokeReachable = cfg.smokeReachable ?? testTenantDbReachable;
  }

  /**
   * Espera que o project Neon não tenha operações activas. Cobre o caso
   * em que a API devolve OK ao CREATE DATABASE mas a operação async
   * subjacente continua a correr — ROLES/DBs ainda não propagaram ao
   * pooler, DELETE seguinte apanha 423. Poll a `/projects/{id}/operations`
   * filtrando status=running|scheduling até estar vazio ou timeout.
   *
   * Best-effort: se o endpoint não responder ou falhar, retorna sem
   * throw — a falha aqui não bloqueia o fluxo principal, apenas
   * remove o benefício de "esperar pelo settling".
   */
  private async waitForProjectQuiet(maxMs: number, label: string): Promise<void> {
    const start = Date.now();
    const pollIntervalMs = 2000;
    let lastReport = -1;
    while (Date.now() - start < maxMs) {
      try {
        const resp = await this.fetcher(
          `${this.apiBaseUrl}/projects/${encodeURIComponent(this.projectId)}/operations?limit=50`,
          { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" } }
        );
        if (!resp.ok) return; // endpoint indisponível; abdica do wait
        const body = (await resp.json()) as { operations?: Array<{ status?: string }> };
        const running = (body.operations ?? []).filter(
          (o) => o.status === "running" || o.status === "scheduling"
        );
        const elapsed = Math.floor((Date.now() - start) / 1000);
        if (running.length === 0) {
          if (elapsed > 0) {
            console.warn(`[neon ${label}] project quiet apos ${elapsed}s`);
          }
          return;
        }
        // Log cada 4s para nao spammar
        if (elapsed - lastReport >= 4 || lastReport < 0) {
          console.warn(
            `[neon ${label}] aguardando project quiet: ${running.length} op(s) activa(s) ` +
              `(elapsed ${elapsed}s/${Math.floor(maxMs / 1000)}s)`
          );
          lastReport = elapsed;
        }
      } catch {
        return; // best-effort
      }
      await this.sleep(pollIntervalMs);
    }
    console.warn(
      `[neon ${label}] timeout aguardando quiet apos ${Math.floor(maxMs / 1000)}s -- prossigo`
    );
  }

  /**
   * SELECT 1 com retry para a janela de propagação Neon (eventual
   * consistency entre o control plane API e o pooler endpoint).
   *
   * Estratégia: primeiro espera o project ficar quiet (operações
   * async terminadas); depois primeira tentativa imediata; em caso
   * de erro retryable (3D000 / network), espera `smokeRetryDelaysMs[i]`
   * antes da próxima. Total = 1 + len(delays) tentativas após o quiet.
   *
   * Não-retryable (auth, sslmode, syntax) → throw imediato.
   */
  private async smokeConnectivityWithRetry(connectionUrl: string): Promise<void> {
    const maxAttempts = this.smokeRetryDelaysMs.length + 1;
    const start = Date.now();
    let lastErr: unknown = null;

    // Phase 0: esperar que o project esteja quiet. Tipicamente 0-15s
    // depois de createDatabase. Max 60s — após isso, mesmo se ainda houver
    // ops activas, prosseguimos para o retry SELECT 1 (que tem o seu próprio
    // backoff). Total worst-case = 60s wait + 51s retry = 111s.
    await this.waitForProjectQuiet(60_000, "smoke");

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Log de tentativa visível (stderr, via console.warn) -- pode ser
      // grep'd no log do wizard com prefixo [neon smoke].
      console.warn(`[neon smoke] attempt ${attempt}/${maxAttempts} -- SELECT 1 ${connectionUrl.replace(/:[^@]+@/, ":***@").slice(0, 100)}`);
      try {
        await this.smokeReachable(connectionUrl);
        const elapsed = Math.floor((Date.now() - start) / 1000);
        console.warn(`[neon smoke] OK na attempt ${attempt} (total ${elapsed}s)`);
        return;
      } catch (err) {
        lastErr = err;
        const { retryable, sqlState } = isRetryableSmokeError(err);
        if (!retryable) {
          console.warn(`[neon smoke] erro NAO-retryable na attempt ${attempt}: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
          throw err;
        }
        if (attempt >= maxAttempts) break;

        const nextDelayMs = this.smokeRetryDelaysMs[attempt - 1];
        this.onSmokeRetry({
          attempt,
          maxAttempts,
          nextDelayMs,
          totalElapsedMs: Date.now() - start,
          lastError: err instanceof Error ? err.message : String(err),
          sqlState,
        });
        await this.sleep(nextDelayMs);
      }
    }

    const totalSec = Math.floor((Date.now() - start) / 1000);
    const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(
      `Neon: DB criada mas SELECT 1 falhou apos ${maxAttempts} tentativas em ${totalSec}s. ` +
        `Ultimo erro: ${lastMsg}`
    );
  }

  /**
   * Cleanup robusto após smoke falhar: DELETE database com retry 423,
   * poll até a DB sumir, depois DELETE role com retry 423. Ordem
   * obrigatória (Neon rejeita DROP ROLE enquanto a role for owner).
   *
   * Não throws — devolve relatório estruturado para o caller compor
   * a mensagem accionável.
   */
  private async cleanupAfterSmokeFailure(
    branchId: string,
    dbName: string,
    roleName: string
  ): Promise<{ dbOk: boolean; dbError?: string; roleOk: boolean; roleError?: string }> {
    // 1. Aguardar quiet antes de tentar (evita 423 imediato após createDatabase)
    await this.waitForProjectQuiet(60_000, "cleanup");

    // 2. DELETE database with 423 retry, até ~60s
    let dbOk = false;
    let dbError: string | undefined;
    const deleteDelays = [3000, 5000, 10000, 15000, 20000];
    for (let attempt = 1; attempt <= deleteDelays.length + 1; attempt++) {
      try {
        await this.request(
          `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/databases/${encodeURIComponent(dbName)}`,
          { method: "DELETE", expectJson: false }
        );
        dbOk = true;
        console.warn(`[neon cleanup] DELETE DB ${dbName}: OK na attempt ${attempt}`);
        break;
      } catch (err) {
        const is423 = err instanceof NeonApiError && err.statusCode === 423;
        const is404 = err instanceof NeonApiError && err.statusCode === 404;
        if (is404) { dbOk = true; break; } // já não existe
        const msg = err instanceof Error ? err.message : String(err);
        if (!is423 || attempt > deleteDelays.length) {
          dbError = msg;
          break;
        }
        const d = deleteDelays[attempt - 1];
        console.warn(`[neon cleanup] DELETE DB ${dbName} attempt ${attempt}: 423, sleep ${d}ms`);
        await this.sleep(d);
      }
    }

    // 3. Poll até DB sumir da listagem (Neon API é eventually-consistent
    //    aqui também). Necessário antes do DROP ROLE.
    if (dbOk) {
      const pollStart = Date.now();
      const pollMax = 60_000;
      while (Date.now() - pollStart < pollMax) {
        try {
          const resp = await this.fetcher(
            `${this.apiBaseUrl}/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/databases`,
            { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" } }
          );
          if (resp.ok) {
            const body = (await resp.json()) as { databases?: Array<{ name: string }> };
            const stillThere = (body.databases ?? []).some((d) => d.name === dbName);
            if (!stillThere) {
              console.warn(`[neon cleanup] DB ${dbName} sumiu da listagem apos ${Math.floor((Date.now() - pollStart) / 1000)}s`);
              break;
            }
          }
        } catch {}
        await this.sleep(3000);
      }
    }

    // 4. DELETE role with 423 retry (só depois da DB confirmada removida).
    let roleOk = false;
    let roleError: string | undefined;
    if (!dbOk) {
      roleError = "skipped — DB ainda nao removida (role-owns-objects garantido)";
    } else {
      // Aguardar quiet antes — o DROP DATABASE pode ter aberto uma op assíncrona.
      await this.waitForProjectQuiet(60_000, "cleanup");
      for (let attempt = 1; attempt <= deleteDelays.length + 1; attempt++) {
        try {
          await this.request(
            `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/roles/${encodeURIComponent(roleName)}`,
            { method: "DELETE", expectJson: false }
          );
          roleOk = true;
          console.warn(`[neon cleanup] DELETE role ${roleName}: OK na attempt ${attempt}`);
          break;
        } catch (err) {
          const is423 = err instanceof NeonApiError && err.statusCode === 423;
          const is404 = err instanceof NeonApiError && err.statusCode === 404;
          if (is404) { roleOk = true; break; }
          const msg = err instanceof Error ? err.message : String(err);
          if (!is423 || attempt > deleteDelays.length) {
            roleError = msg;
            break;
          }
          const d = deleteDelays[attempt - 1];
          console.warn(`[neon cleanup] DELETE role ${roleName} attempt ${attempt}: 423, sleep ${d}ms`);
          await this.sleep(d);
        }
      }
    }

    return { dbOk, dbError, roleOk, roleError };
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────

  private async request<T>(
    path: string,
    init?: RequestInit & { expectJson?: boolean }
  ): Promise<T> {
    const url = `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (init?.body) headers["Content-Type"] = "application/json";
    if (init?.headers) {
      const userHeaders = init.headers as Record<string, string>;
      Object.assign(headers, userHeaders);
    }
    const res = await this.fetcher(url, { ...init, headers });
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {}
      throw new NeonApiError(
        `Neon API ${init?.method ?? "GET"} ${path} → HTTP ${res.status}: ${body.slice(0, 500)}`,
        res.status,
        path,
        init?.method ?? "GET"
      );
    }
    if (init?.expectJson === false) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  /**
   * Encapsula uma operação Neon que pode receber HTTP 423 (project
   * com operação concorrente). Re-tenta com backoff exponencial +
   * jitter até `retryMaxAttempts` ou `retryMaxTotalMs`. Outros
   * erros propagam imediatamente sem retry.
   */
  private async withRetryOn423<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    let attempt = 0;
    let lastError: NeonApiError | Error | null = null;

    while (true) {
      attempt++;
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const is423 = err instanceof NeonApiError && err.statusCode === 423;
        if (!is423) {
          // Erro permanente — não fazer retry, propagar.
          throw lastError;
        }
        if (attempt >= this.retryMaxAttempts) {
          throw new Error(
            `Neon ${label}: operação concorrente persistente (HTTP 423) após ${attempt} tentativas em ${Math.floor((Date.now() - start) / 1000)}s. ` +
              `Verifica operations pendentes no dashboard Neon ou tenta dentro de alguns minutos. ` +
              `Último erro: ${lastError.message}`
          );
        }
        // Calcula próximo delay (exponential + jitter ≤ 30%)
        const exponential = Math.min(
          this.retryBaseDelayMs * Math.pow(2, attempt - 1),
          this.retryMaxDelayMs
        );
        const jitter = Math.random() * exponential * 0.3;
        const nextDelayMs = Math.floor(exponential + jitter);

        // Cap total: se o delay vai exceder o budget, não vale a pena
        // dormir — atira já.
        const elapsed = Date.now() - start;
        if (elapsed + nextDelayMs > this.retryMaxTotalMs) {
          throw new Error(
            `Neon ${label}: HTTP 423 persistente; orçamento de retry esgotado ` +
              `(${Math.floor(elapsed / 1000)}s, próximo delay ${nextDelayMs}ms excederia ${Math.floor(this.retryMaxTotalMs / 1000)}s). ` +
              `Tenta dentro de alguns minutos. Último erro: ${lastError.message}`
          );
        }

        this.onRetry({
          label,
          attempt,
          maxAttempts: this.retryMaxAttempts,
          nextDelayMs,
          totalElapsedMs: elapsed,
          lastError: lastError.message,
        });

        await this.sleep(nextDelayMs);
      }
    }
  }

  // ── Branch resolution ────────────────────────────────────────────────

  private async getDefaultBranchId(): Promise<string> {
    if (this.cachedBranchId) return this.cachedBranchId;
    const resp = await this.withRetryOn423("listBranches", () =>
      this.request<NeonBranchListResponse>(
        `/projects/${encodeURIComponent(this.projectId)}/branches`
      )
    );
    if (!resp.branches || resp.branches.length === 0) {
      throw new Error(`Neon: project ${this.projectId} sem branches — projecto inválido?`);
    }
    const def =
      resp.branches.find((b) => b.default) ??
      resp.branches.find((b) => b.primary) ??
      resp.branches[0];
    this.cachedBranchId = def.id;
    return def.id;
  }

  // ── Resource ops ─────────────────────────────────────────────────────

  private async createRole(branchId: string, roleName: string): Promise<string> {
    const resp = await this.withRetryOn423("createRole", () =>
      this.request<NeonRoleResponse>(
        `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/roles`,
        {
          method: "POST",
          body: JSON.stringify({ role: { name: roleName } }),
        }
      )
    );
    if (!resp.role || !resp.role.password) {
      // Em algumas versões/responses Neon devolve sem password no create.
      // Tentar reveal_password como fallback (também sujeito a 423).
      const reveal = await this.withRetryOn423("revealPassword", () =>
        this.request<{ password: string }>(
          `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/roles/${encodeURIComponent(roleName)}/reveal_password`
        )
      );
      if (!reveal.password) {
        throw new Error("Neon: role criada mas password não devolvida (reveal_password vazio)");
      }
      return reveal.password;
    }
    return resp.role.password;
  }

  private async createDatabaseOnNeon(
    branchId: string,
    dbName: string,
    ownerRoleName: string
  ): Promise<void> {
    await this.withRetryOn423("createDatabase", () =>
      this.request<{ database: unknown }>(
        `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/databases`,
        {
          method: "POST",
          body: JSON.stringify({
            database: { name: dbName, owner_name: ownerRoleName },
          }),
        }
      )
    );
  }

  private async getConnectionUri(
    branchId: string,
    dbName: string,
    roleName: string
  ): Promise<string> {
    const path =
      `/projects/${encodeURIComponent(this.projectId)}/connection_uri` +
      `?branch_id=${encodeURIComponent(branchId)}` +
      `&database_name=${encodeURIComponent(dbName)}` +
      `&role_name=${encodeURIComponent(roleName)}` +
      `&pooled=true`;
    const resp = await this.withRetryOn423("connectionUri", () =>
      this.request<NeonConnectionUriResponse>(path)
    );
    if (!resp.uri) throw new Error("Neon: connection_uri vazio na resposta");
    return resp.uri;
  }

  /**
   * DELETE best-effort sem retry — quando estamos em rollback queremos
   * tentar e seguir. Devolve `{ ok, error? }` para que o caller possa
   * compor mensagem accionável: se o cleanup falhar e o tenant não
   * existir no control plane, o operador precisa de saber que tem de
   * remover manualmente no dashboard Neon.
   */
  private async deleteRoleSafe(
    branchId: string,
    roleName: string
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request(
        `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/roles/${encodeURIComponent(roleName)}`,
        { method: "DELETE", expectJson: false }
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async deleteDatabaseSafe(
    branchId: string,
    dbName: string
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request(
        `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/databases/${encodeURIComponent(dbName)}`,
        { method: "DELETE", expectJson: false }
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── DatabaseProvider interface ───────────────────────────────────────

  async createDatabase({ slug }: { slug: string; region?: string }): Promise<ConnectionTargets> {
    const { dbUser, dbName } = slugToDbNames(slug);
    const branchId = await this.getDefaultBranchId();

    let dbPassword: string;
    try {
      dbPassword = await this.createRole(branchId, dbUser);
    } catch (err) {
      // Erro propagado já tem o label "createRole" ou veio do retry
      // exhausted. Não há cleanup — não criámos nada confirmado.
      // Erro de retry esgotado já vem com label embutido (ex:
      // "Neon createRole: operação concorrente persistente..."). Não
      // duplicar wrap para esses; para tudo o resto (NeonApiError raw,
      // network errors), incluir o label do step.
      throw new Error(reraseNeonError(err, "createRole", dbUser));
    }

    try {
      await this.createDatabaseOnNeon(branchId, dbName, dbUser);
    } catch (err) {
      await this.deleteRoleSafe(branchId, dbUser);
      throw new Error(reraseNeonError(err, "createDatabase", dbName));
    }

    let connectionUrl: string;
    try {
      connectionUrl = await this.getConnectionUri(branchId, dbName, dbUser);
    } catch (err) {
      await this.deleteDatabaseSafe(branchId, dbName);
      await this.deleteRoleSafe(branchId, dbUser);
      throw new Error(reraseNeonError(err, "connection_uri", `${dbName}@${dbUser}`));
    }

    // Smoke connectivity — retry para a janela de propagação Neon
    // (eventual consistency entre control plane API e pooler endpoint).
    // Erros permanentes (auth, sslmode, syntax) lançam imediatamente
    // via isRetryableSmokeError.
    try {
      await this.smokeConnectivityWithRetry(connectionUrl);
    } catch (err) {
      // Cleanup robusto: DELETE DB com retry 423 + poll-until-gone +
      // DELETE role só depois. Não dá throw — devolve estado para a
      // mensagem final.
      const cleanup = await this.cleanupAfterSmokeFailure(branchId, dbName, dbUser);

      const parts: string[] = [];
      parts.push(err instanceof Error ? err.message : String(err));
      parts.push("");
      parts.push(`Cleanup automatico:`);
      parts.push(`  DB    ${dbName}: ${cleanup.dbOk ? "removida" : "FALHOU (" + (cleanup.dbError ?? "?") + ")"}`);
      parts.push(`  role  ${dbUser}: ${cleanup.roleOk ? "removida" : "FALHOU (" + (cleanup.roleError ?? "?") + ")"}`);
      if (!cleanup.dbOk || !cleanup.roleOk) {
        parts.push("");
        parts.push(
          `AVISO: recursos Neon podem ter ficado ghost -- remove manualmente no ` +
            `dashboard https://console.neon.tech/ -> projecto -> Databases/Roles ` +
            `antes de re-tentar criar tenant "${slug}".`
        );
      }
      parts.push("");
      parts.push(
        `Para limpar control plane se ficou registo PROVISIONING/FAILED: ` +
          `npm run tenancy:cleanup-failed -- --slug ${slug} --confirm`
      );

      throw new Error(parts.join("\n"));
    }

    const parsed = new URL(connectionUrl);
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 5432;

    return {
      host,
      port,
      dbName,
      dbUser,
      dbPassword,
      connectionUrl,
    };
  }

  async destroyDatabase({
    dbName,
    dbUser,
  }: {
    dbName: string;
    dbUser: string;
  }): Promise<void> {
    const branchId = await this.getDefaultBranchId();
    // Reusa o cleanup ordenado (espera quiet, DELETE DB com retry 423,
    // poll até sumir, depois DELETE role). Garantia: DROP ROLE nunca
    // tenta antes de DROP DATABASE confirmado.
    const r = await this.cleanupAfterSmokeFailure(branchId, dbName, dbUser);
    const errors: string[] = [];
    if (!r.dbOk) errors.push(`DB ${dbName}: ${r.dbError ?? "?"}`);
    if (!r.roleOk) errors.push(`role ${dbUser}: ${r.roleError ?? "?"}`);
    if (errors.length > 0) {
      throw new Error(`Neon destroy parcial: ${errors.join("; ")}`);
    }
  }
}
