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

  // ── Bootstrap (1ª ingestão controlada, feature-flag gated) ────────

  /**
   * POST /api/ingest/v1/bootstrap/products
   * Batch upsert de produtos (catálogo + ProdutoFarmacia per-farmacia).
   * Body: { farmaciaId, items: ProductPayload[] }. Idempotente.
   */
  async bootstrapProducts(
    body: { farmaciaId: string; items: unknown[] },
    timeoutMs?: number
  ): Promise<BootstrapBatchResponse> {
    return this.request("POST", "/api/ingest/v1/bootstrap/products", { body, timeoutMs });
  }

  /**
   * POST /api/ingest/v1/bootstrap/stock
   * Batch upsert de stock (per-armazém → agregado server-side por
   * externalProductId). Body: { farmaciaId, items: StockPayload[] }.
   * Idempotente.
   */
  async bootstrapStock(
    body: { farmaciaId: string; items: unknown[] },
    timeoutMs?: number
  ): Promise<BootstrapBatchResponse & { aggregated?: number }> {
    return this.request("POST", "/api/ingest/v1/bootstrap/stock", { body, timeoutMs });
  }

  /**
   * POST /api/ingest/v1/bootstrap/sales-lines
   * Insert/update das linhas de venda raw em staging
   * `IngestVendaLinhaRaw`. Body: { farmaciaId, items: SaleLinePayload[] }.
   * Idempotente via (farmaciaId, externalSaleLineId).
   */
  async bootstrapSalesLines(
    body: { farmaciaId: string; items: unknown[] },
    timeoutMs?: number
  ): Promise<BootstrapBatchResponse & { orphanProductLines?: number; nonStockServiceLines?: number; operationalOrphans?: number }> {
    return this.request("POST", "/api/ingest/v1/bootstrap/sales-lines", { body, timeoutMs });
  }

  // ── Pipeline (autonomous daily pipeline endpoints) ─────────────────

  /**
   * POST /api/admin/pipeline/aggregate-month
   * Trigger server-side da agregação `IngestVendaLinhaRaw → VendaMensal`
   * para o mês dado. Cria um PipelineRun no SaaS com status final.
   * Devolve o pipelineRunId + counts para o agent agregar no resumo
   * do daily-pipeline.
   */
  async pipelineAggregateMonth(
    body: { month: string; write?: boolean; allowOrphans?: boolean; allowNegativeTotals?: boolean },
    timeoutMs?: number
  ): Promise<PipelineAggregateResponse> {
    return this.request("POST", "/api/admin/pipeline/aggregate-month", {
      body,
      timeoutMs: timeoutMs ?? 60_000,
    });
  }

  /**
   * POST /api/admin/pipeline/record
   * Cria uma PipelineRun no SaaS com status final (OK/ERROR/ABORTED).
   * Usado pelo agent para registar o orquestrador daily-pipeline.
   */
  async pipelineRecord(
    body: PipelineRecordBody,
    timeoutMs?: number
  ): Promise<{ ok: true; pipelineRunId: string }> {
    return this.request("POST", "/api/admin/pipeline/record", { body, timeoutMs });
  }

  // ── Outbox (export agent: SaaS → SPharm local) ─────────────────────

  /**
   * GET /api/outbox/v1/orders/pending?limit=N
   *
   * Reclama atomicamente até N orders PENDENTE como EM_EXPORTACAO
   * (lease 5min). O agent deve fazer ack/nack dentro da TTL ou perder
   * o lease (próximo poll reclama de novo).
   *
   * O `payload` é o payloadJson congelado; `enrichment.linhas` traz CNP
   * + designação por produtoId, resolvidos server-side a partir do
   * catálogo SaaS para o agent não ter de fazer round-trips.
   */
  async pullPendingOrders(
    options: { limit?: number; agentInstance?: string; timeoutMs?: number } = {}
  ): Promise<PendingOrdersResponse> {
    const limit = options.limit ?? 50;
    const headers: Record<string, string> = {};
    if (options.agentInstance) headers["x-agent-instance"] = options.agentInstance;
    const url = `/api/outbox/v1/orders/pending?limit=${encodeURIComponent(String(limit))}`;
    return this.requestWithHeaders<PendingOrdersResponse>(
      "GET",
      url,
      headers,
      { timeoutMs: options.timeoutMs }
    );
  }

  /**
   * POST /api/outbox/v1/orders/{outboxId}/ack
   *
   * Confirma exportação com sucesso. `spharmDocumentId` é o identificador
   * que o ERP atribuiu ao documento criado, guardado para reconciliação.
   */
  async ackOrder(
    outboxId: string,
    body: { spharmDocumentId: string; durationMs?: number; details?: Record<string, unknown> },
    timeoutMs?: number
  ): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/outbox/v1/orders/${encodeURIComponent(outboxId)}/ack`,
      { body, timeoutMs }
    );
  }

  /**
   * POST /api/outbox/v1/orders/{outboxId}/nack
   *
   * Reporta falha. `retryable=true` recoloca em PENDENTE para nova
   * tentativa após backoff; `retryable=false` marca FALHADO para
   * triagem humana.
   */
  async nackOrder(
    outboxId: string,
    body: {
      retryable: boolean;
      error: string;
      sqlError?: { code?: string; number?: number; message?: string };
      details?: Record<string, unknown>;
    },
    timeoutMs?: number
  ): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/outbox/v1/orders/${encodeURIComponent(outboxId)}/nack`,
      { body, timeoutMs }
    );
  }

  /**
   * Wrapper interno que permite passar headers extra (ex: x-agent-instance).
   * Mantido privado para evitar exposição directa do fetch.
   */
  private async requestWithHeaders<T>(
    method: "GET" | "POST",
    path: string,
    extraHeaders: Record<string, string>,
    opts: { body?: unknown; timeoutMs?: number } = {}
  ): Promise<T> {
    const url = `${this.endpoint}${path.startsWith("/") ? path : "/" + path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.ingestKey}`,
      "X-Tenant-Slug": this.tenantSlug,
      Accept: "application/json",
      "User-Agent": `spharmmt-agent/${this.agentVersion}`,
      ...extraHeaders,
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
    return (await res.json()) as T;
  }
}

export type PendingOrderLine = {
  produtoId: string;
  quantidadeSugerida: string | null;
  quantidadeAjustada: string | null;
  fornecedorSugeridoId: string | null;
  notas: string | null;
};

export type PendingOrderPayload = {
  version: 1;
  tenantSlug: string;
  listaEncomendaId: string;
  farmaciaId: string;
  nome: string;
  criadoPorId: string;
  criadoEm: string;
  linhas: PendingOrderLine[];
};

export type PendingOrderEnrichmentLine = {
  produtoId: string;
  cnp: string | null;
  designacao: string | null;
};

export type PendingOrder = {
  outboxId: string;
  listaEncomendaId: string;
  farmaciaId: string;
  idempotencyKey: string;
  payloadHash: string;
  attempt: number;
  payload: PendingOrderPayload;
  enrichment: { linhas: PendingOrderEnrichmentLine[] };
};

export type PendingOrdersResponse = {
  leasedUntil: string;
  count: number;
  orders: PendingOrder[];
};

export type PipelineRecordBody = {
  farmaciaId: string;
  kind: "daily-pipeline" | "daily-sync" | "aggregate-month";
  status: "OK" | "ERROR" | "ABORTED";
  startedAt: string;
  finishedAt: string;
  dateRef?: string;
  durationMs?: number;
  errorMessage?: string;
  details?: Record<string, unknown>;
  triggeredBy?: string;
  /// Chave determinística para dedup. Quando presente, o servidor faz
  /// upsert em vez de create — retries da mesma execução não duplicam.
  /// Convenção: `${kind}:${farmaciaId}:${dateRef ?? "_"}:${startedAt}`.
  idempotencyKey?: string;
};

export type PipelineAggregateResponse = {
  ok: true;
  pipelineRunId: string;
  preflight: {
    rawLines: number;
    produtosDistinct: number;
    atendimentosDistinct: number;
    farmaciasDistinct: number;
    byClass: Record<string, number>;
    orphans: number;
    nonStockServices: number;
    operationalOrphans: number;
    unknowns: number;
  };
  totals: {
    quantidadeLiquida: number;
    valorBruto: number;
    valorPagoUtente: number;
    valorComparticipado: number;
    linhasVenda: number;
    atendimentos: number;
  };
  rowsInserted: number;
  rowsDeleted: number;
  rowCount: number;
  durationMs: number;
};

export type BootstrapBatchResponse = {
  ok: true;
  accepted: number;
  upserted: number;
  skipped: Array<{ index: number; reason: string; externalId?: number }>;
  errors: Array<{ index: number; reason: string; externalId?: number; message: string }>;
  durationMs: number;
};
