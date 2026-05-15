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

  // Extrair sqlstate quando presente (Prisma/pg costuma incluir "code: 3D000")
  const codeMatch = msg.match(/\bCode\s+([0-9A-Z]{5})\b/i) ?? msg.match(/\bcode:\s*['"]?([0-9A-Z]{5})['"]?/i);
  const sqlState = codeMatch ? codeMatch[1].toUpperCase() : undefined;

  if (sqlState === SQLSTATE_UNDEFINED_DATABASE) return { retryable: true, sqlState };

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
  console.warn(
    `[neon] smoke SELECT 1 falhou${sqlBit}, retry ${info.attempt}/${info.maxAttempts} ` +
      `em ${info.nextDelayMs}ms (elapsed ${Math.floor(info.totalElapsedMs / 1000)}s) — ` +
      `${info.lastError.slice(0, 160)}`
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
   * SELECT 1 com retry para a janela de propagação Neon (eventual
   * consistency entre o control plane API e o pooler endpoint).
   *
   * Estratégia: primeira tentativa imediata; em caso de erro retryable
   * (3D000 / network), espera `smokeRetryDelaysMs[i]` antes da próxima.
   * Total = 1 + len(delays) tentativas.
   *
   * Não-retryable (auth, sslmode, syntax) → throw imediato.
   */
  private async smokeConnectivityWithRetry(connectionUrl: string): Promise<void> {
    const maxAttempts = this.smokeRetryDelaysMs.length + 1;
    const start = Date.now();
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.smokeReachable(connectionUrl);
        return;
      } catch (err) {
        lastErr = err;
        const { retryable, sqlState } = isRetryableSmokeError(err);
        if (!retryable) throw err;
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
      `Neon: DB criada mas SELECT 1 falhou após ${maxAttempts} tentativas em ${totalSec}s. ` +
        `Último erro: ${lastMsg}`
    );
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
      const dbCleanup = await this.deleteDatabaseSafe(branchId, dbName);
      const roleCleanup = await this.deleteRoleSafe(branchId, dbUser);

      const parts: string[] = [];
      parts.push(err instanceof Error ? err.message : String(err));
      parts.push("");
      parts.push(`Cleanup automático:`);
      parts.push(`  DB    ${dbName}: ${dbCleanup.ok ? "removida" : "FALHOU (" + (dbCleanup.error ?? "?") + ")"}`);
      parts.push(`  role  ${dbUser}: ${roleCleanup.ok ? "removida" : "FALHOU (" + (roleCleanup.error ?? "?") + ")"}`);
      if (!dbCleanup.ok || !roleCleanup.ok) {
        parts.push("");
        parts.push(
          `AVISO: recursos Neon podem ter ficado ghost — remove manualmente no ` +
            `dashboard https://console.neon.tech/ → projecto → Databases/Roles ` +
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
    const errors: string[] = [];
    try {
      await this.request(
        `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/databases/${encodeURIComponent(dbName)}`,
        { method: "DELETE", expectJson: false }
      );
    } catch (err) {
      errors.push(`DB ${dbName}: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await this.request(
        `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/roles/${encodeURIComponent(dbUser)}`,
        { method: "DELETE", expectJson: false }
      );
    } catch (err) {
      errors.push(`role ${dbUser}: ${err instanceof Error ? err.message : err}`);
    }
    if (errors.length > 0) {
      throw new Error(`Neon destroy parcial: ${errors.join("; ")}`);
    }
  }
}
