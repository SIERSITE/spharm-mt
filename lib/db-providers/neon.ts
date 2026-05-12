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

export type NeonProviderConfig = {
  apiKey: string;
  projectId: string;
  /** Apenas informativo — Neon escolhe região do projecto, não da DB. */
  defaultRegion?: string;
  /** Default `https://console.neon.tech/api/v2`. Override para testes. */
  apiBaseUrl?: string;
  /** Override do `fetch` global — usado em testes. */
  fetcher?: FetchLike;
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

export class NeonProvider implements DatabaseProvider {
  readonly name = "neon";

  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly apiBaseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly defaultRegion: string;

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
      // Merge user-supplied headers (mais defensivo: aceita Headers/array/Record)
      const userHeaders = init.headers as Record<string, string>;
      Object.assign(headers, userHeaders);
    }
    const res = await this.fetcher(url, { ...init, headers });
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {}
      throw new Error(
        `Neon API ${init?.method ?? "GET"} ${path} → HTTP ${res.status}: ${body.slice(0, 500)}`
      );
    }
    if (init?.expectJson === false) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  // ── Branch resolution ────────────────────────────────────────────────

  private async getDefaultBranchId(): Promise<string> {
    if (this.cachedBranchId) return this.cachedBranchId;
    const resp = await this.request<NeonBranchListResponse>(
      `/projects/${encodeURIComponent(this.projectId)}/branches`
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
    const resp = await this.request<NeonRoleResponse>(
      `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/roles`,
      {
        method: "POST",
        body: JSON.stringify({ role: { name: roleName } }),
      }
    );
    if (!resp.role || !resp.role.password) {
      // Em algumas versões/responses Neon devolve sem password no create.
      // Tentar reveal_password como fallback.
      const reveal = await this.request<{ password: string }>(
        `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/roles/${encodeURIComponent(roleName)}/reveal_password`
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
    await this.request<{ database: unknown }>(
      `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/databases`,
      {
        method: "POST",
        body: JSON.stringify({
          database: { name: dbName, owner_name: ownerRoleName },
        }),
      }
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
    const resp = await this.request<NeonConnectionUriResponse>(path);
    if (!resp.uri) throw new Error("Neon: connection_uri vazio na resposta");
    return resp.uri;
  }

  private async deleteRoleSafe(branchId: string, roleName: string): Promise<void> {
    try {
      await this.request(
        `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/roles/${encodeURIComponent(roleName)}`,
        { method: "DELETE", expectJson: false }
      );
    } catch {
      // best-effort
    }
  }

  private async deleteDatabaseSafe(branchId: string, dbName: string): Promise<void> {
    try {
      await this.request(
        `/projects/${encodeURIComponent(this.projectId)}/branches/${encodeURIComponent(branchId)}/databases/${encodeURIComponent(dbName)}`,
        { method: "DELETE", expectJson: false }
      );
    } catch {
      // best-effort
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
      throw new Error(
        `Neon: createRole(${dbUser}) falhou — ${err instanceof Error ? err.message : err}`
      );
    }

    try {
      await this.createDatabaseOnNeon(branchId, dbName, dbUser);
    } catch (err) {
      await this.deleteRoleSafe(branchId, dbUser);
      throw new Error(
        `Neon: createDatabase(${dbName}) falhou — ${err instanceof Error ? err.message : err}`
      );
    }

    let connectionUrl: string;
    try {
      connectionUrl = await this.getConnectionUri(branchId, dbName, dbUser);
    } catch (err) {
      await this.deleteDatabaseSafe(branchId, dbName);
      await this.deleteRoleSafe(branchId, dbUser);
      throw new Error(
        `Neon: connection_uri falhou — ${err instanceof Error ? err.message : err}`
      );
    }

    // Smoke connectivity — falha aqui significa que a URL não funciona,
    // não vale a pena registar no control plane.
    try {
      await testTenantDbReachable(connectionUrl);
    } catch (err) {
      await this.deleteDatabaseSafe(branchId, dbName);
      await this.deleteRoleSafe(branchId, dbUser);
      throw new Error(
        `Neon: DB criada mas SELECT 1 falhou — ${err instanceof Error ? err.message : err}`
      );
    }

    // Parse URL para campos discretos. Connection URI Neon inclui o
    // pooler hostname + sslmode=require + channel_binding.
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
