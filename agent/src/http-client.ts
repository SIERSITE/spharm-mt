/**
 * agent/src/http-client.ts
 *
 * Cliente HTTP para a API SaaS SPharm.MT. Usa o `fetch` nativo (Node
 * ≥ 20). Centraliza:
 *  · Headers de auth: `Authorization: Bearer <key>` + `X-Tenant-Slug`
 *  · Tratamento de errors HTTP com status code preservado
 *  · Timeout configurável por chamada (default 30s)
 *  · User-Agent identificável para logs server-side
 *
 * Não faz retry interno — caller decide se quer retry baseado no
 * statusCode. Para o piloto, falhas transientes são reportadas e o
 * operador retry manualmente.
 */

import type { AgentConfig } from "./config.js";

export class SaasApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly path: string,
    public readonly method: string,
    public readonly bodySnippet?: string
  ) {
    super(message);
    this.name = "SaasApiError";
  }
}

export class SaasClient {
  private readonly endpoint: string;
  private readonly tenantSlug: string;
  private readonly ingestKey: string;
  private readonly agentVersion: string;

  constructor(cfg: Pick<AgentConfig, "saasEndpoint" | "tenantSlug" | "ingestKey" | "agentVersion">) {
    this.endpoint = cfg.saasEndpoint.replace(/\/+$/, "");
    this.tenantSlug = cfg.tenantSlug;
    this.ingestKey = cfg.ingestKey;
    this.agentVersion = cfg.agentVersion;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; timeoutMs?: number; expectJson?: boolean } = {}
  ): Promise<T> {
    const url = `${this.endpoint}${path.startsWith("/") ? path : "/" + path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.ingestKey}`,
      "X-Tenant-Slug": this.tenantSlug,
      Accept: "application/json",
      "User-Agent": `spharmmt-agent/${this.agentVersion}`,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`SaaS ${method} ${path} — falha de rede: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {}
      const snippet = body.slice(0, 500);
      throw new SaasApiError(
        `SaaS ${method} ${path} → HTTP ${res.status}: ${snippet || "(corpo vazio)"}`,
        res.status,
        path,
        method,
        snippet
      );
    }

    if (opts.expectJson === false) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  // ── Endpoints concretos ─────────────────────────────────────────

  /**
   * GET /api/outbox/v1/heartbeat (smoke test): confirma que tenant+key
   * são válidos. Não escreve nada server-side excepto regista
   * `lastAgentHeartbeatAt` no control plane. Idempotente.
   */
  async heartbeat(timeoutMs?: number): Promise<{ ok: boolean; serverTime: string; tenantSlug: string }> {
    return this.request("POST", "/api/outbox/v1/heartbeat", { body: {}, timeoutMs });
  }

  /**
   * GET /api/ingest/v1/farmacias: lista farmácias do tenant. Útil
   * para o agent resolver `--farmacia <nome>` → cuid antes do
   * primeiro upload.
   */
  async listFarmacias(timeoutMs?: number): Promise<{
    ok: boolean;
    tenantSlug: string;
    farmacias: Array<{ id: string; nome: string; estado: string }>;
  }> {
    return this.request("GET", "/api/ingest/v1/farmacias", { timeoutMs });
  }
}
