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
      if (res.status === 401) this.diagnostico401(method, url, snippet);
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
   * POST /api/ingest/v1/bootstrap/products/finalize
   *
   * Sweep pós-`products-upload`. Marca como `flagRetirado=true` todas as
   * `ProdutoFarmacia(farmaciaId=X)` não tocadas nesta corrida — i.e.,
   * produtos que existiam em corridas passadas mas que o ERP já não
   * envia (filtro `Retirado=0 AND Processa_Stocks<>0` no agent).
   *
   * Chamado UMA vez por farmácia no fim da corrida, com o `runStartedAt`
   * capturado **antes** do primeiro batch. Idempotente.
   *
   * NÃO toca em `Produto.estado` (decisão arquitectural 2026-06).
   */
  async bootstrapProductsFinalize(
    body: { farmaciaId: string; runStartedAt: string },
    timeoutMs?: number,
  ): Promise<{
    ok: true;
    farmaciaId: string;
    runStartedAt: string;
    retiredCount: number;
    durationMs: number;
  }> {
    return this.request("POST", "/api/ingest/v1/bootstrap/products/finalize", {
      body,
      timeoutMs,
    });
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

  /**
   * POST /api/ingest/v1/bootstrap/fornecedores
   * Upsert per-farmacia de fornecedores derivados de dbo.Fornecedores.
   * Body: { farmaciaId, items: FornecedorPayload[] }. Idempotente via
   * `(farmaciaId, externalFornecedorId)`. Fase 1a do pipeline compras
   * — pré-requisito antes de qualquer ingestão de compras/devoluções.
   */
  async bootstrapFornecedores(
    body: { farmaciaId: string; items: unknown[] },
    timeoutMs?: number
  ): Promise<
    BootstrapBatchResponse & {
      fornecedoresCreated: number;
      fornecedoresUpdated: number;
      refsCreated: number;
      refsUpdated: number;
      aliasesAdded: number;
    }
  > {
    return this.request("POST", "/api/ingest/v1/bootstrap/fornecedores", {
      body,
      timeoutMs,
    });
  }

  /**
   * POST /api/ingest/v1/bootstrap/compras
   * UPSERT idempotente de linhas de compra em StagingCompraRawLine.
   * Body: { farmaciaId, items: CompraLinePayload[] } (max 500).
   * Idempotente via `(farmaciaId, externalLineId)`. Fase 1b.2 —
   * STAGING-ONLY (Compra final aggregation acontece em Fase 1c+).
   */
  async bootstrapCompras(
    body: { farmaciaId: string; items: unknown[] },
    timeoutMs?: number
  ): Promise<
    BootstrapBatchResponse & {
      created: number;
      updated: number;
      reconciliationWarnings: number;
    }
  > {
    return this.request("POST", "/api/ingest/v1/bootstrap/compras", {
      body,
      timeoutMs,
    });
  }

  /**
   * POST /api/ingest/v1/movimentos
   * Block A3 — UPSERT canónico de StocksMov em MovimentoArtigo.
   * Body: { farmaciaId, ingestRunId, items[] } (max 500).
   * Idempotente via `(farmaciaId, externalMovId)`. Re-run produz UPDATE.
   * Resposta inclui `byTipo` (contagem por TipoMovimentoArtigo),
   * `desconhecidos` e `orphanProducts` para reporting do agent.
   */
  async ingestMovimentos(
    body: { farmaciaId: string; ingestRunId: string; items: unknown[] },
    timeoutMs?: number,
  ): Promise<
    BootstrapBatchResponse & {
      created: number;
      updated: number;
      desconhecidos: number;
      orphanProducts: number;
      byTipo: Record<string, number>;
    }
  > {
    return this.request("POST", "/api/ingest/v1/movimentos", {
      body,
      timeoutMs,
    });
  }

  /**
   * POST /api/ingest/v1/bootstrap/devolucoes-fornecedor
   * UPSERT idempotente de linhas de devolução AO fornecedor em
   * StagingDevolucaoFornecedorRawLine. Body: { farmaciaId, items[] }
   * (max 500). Idempotente via `(farmaciaId, externalLineId)`. Fase 1b.3.
   * STAGING-ONLY. Transição P→R capturada via UPDATE.
   */
  async bootstrapDevolucoesFornecedor(
    body: { farmaciaId: string; items: unknown[] },
    timeoutMs?: number
  ): Promise<
    BootstrapBatchResponse & {
      created: number;
      updated: number;
      reconciliationWarnings: number;
      byEstado: { P: number; E: number; R: number; X: number };
    }
  > {
    return this.request("POST", "/api/ingest/v1/bootstrap/devolucoes-fornecedor", {
      body,
      timeoutMs,
    });
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
    body: {
      month: string;
      write?: boolean;
      allowOrphans?: boolean;
      allowNegativeTotals?: boolean;
      allowUnknowns?: boolean;
    },
    timeoutMs?: number
  ): Promise<PipelineAggregateResponse> {
    return this.request("POST", "/api/admin/pipeline/aggregate-month", {
      body,
      timeoutMs: timeoutMs ?? 60_000,
    });
  }

  /**
   * POST /api/admin/pipeline/aggregate-compras
   * Agrega `StagingCompraRawLine [from,to)` → `Compra` (UPSERT por
   * `(farmaciaId, produtoId, fornecedorId, data)`). `write=false` (default
   * server-side) = dry-run preview; `write=true` escreve. Resolve produtos
   * via ProdutoFarmacia + fornecedores via FornecedorErpRef. Idempotente.
   */
  async pipelineAggregateCompras(
    body: { farmaciaId: string; from: string; to: string; write?: boolean },
    timeoutMs?: number
  ): Promise<PipelineAggregateComprasResponse> {
    return this.request("POST", "/api/admin/pipeline/aggregate-compras", {
      body,
      timeoutMs: timeoutMs ?? 90_000,
    });
  }

  /**
   * POST /api/admin/pipeline/aggregate-devolucoes
   * Agrega `StagingDevolucaoFornecedorRawLine [from,to)` → `Devolucao`
   * (UPSERT por linha em `(farmaciaId, externalLineId)`, quantidade =
   * quantidadeRecebida). `write=false` = dry-run; `write=true` escreve.
   * Pode devolver 404 `not_implemented` se o endpoint não existir no SaaS
   * (deploy mais antigo) — o full-sync trata isso como NOT_IMPLEMENTED.
   */
  async pipelineAggregateDevolucoes(
    body: { farmaciaId: string; from: string; to: string; write?: boolean },
    timeoutMs?: number
  ): Promise<PipelineAggregateDevolucoesResponse> {
    return this.request("POST", "/api/admin/pipeline/aggregate-devolucoes", {
      body,
      timeoutMs: timeoutMs ?? 90_000,
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

  /**
   * GET /api/ingest/v1/pipeline/dias-concluidos
   *
   * Que dias o pipeline diário já concluiu com sucesso nesta farmácia.
   * Fonte de verdade do catch-up: um dia só conta como feito se o
   * registo dele chegou ao SaaS.
   *
   * Sob `/api/ingest/` e não `/api/admin/` de propósito — ver o
   * cabeçalho da rota. O prefixo já está allowlisted no proxy, portanto
   * esta chamada não depende de um deploy de configuração do nginx.
   */
  async pipelineDiasConcluidos(
    params: { farmaciaId: string; from: string; to: string },
    timeoutMs?: number
  ): Promise<{ ok: true; farmaciaId: string; from: string; to: string; dias: string[] }> {
    const qs = new URLSearchParams({
      farmaciaId: params.farmaciaId,
      from: params.from,
      to: params.to,
    });
    return this.request("GET", `/api/ingest/v1/pipeline/dias-concluidos?${qs.toString()}`, {
      timeoutMs,
    });
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
  /**
   * Diagnostico de credenciais, impresso quando o SaaS responde 401.
   *
   * Nunca revela a chave: so diz se o cabecalho foi construido com
   * conteudo. Existe porque um 401 tem duas causas indistinguiveis do
   * lado de fora — "o agent nao enviou" e "o proxy apagou" — e a
   * mensagem do servidor distingue-as:
   *
   *   missing_credentials  falta um dos dois cabecalhos A CHEGADA
   *   invalid credentials  chegaram os dois, a chave e que nao serve
   *
   * Se o agent diz hasTenantSlug=true e o servidor responde
   * missing_credentials, o cabecalho perdeu-se no caminho — e o caminho
   * e o URL que esta impresso aqui.
   */
  private diagnostico401(method: string, url: string, corpo: string): void {
    console.error("");
    console.error("  ── 401: diagnostico de credenciais (sem revelar a chave) ──");
    console.error(`     endpoint          : ${this.endpoint}`);
    console.error(`     url completo      : ${method} ${url}`);
    console.error(`     hasAuthorization  : ${this.ingestKey.length > 0}`);
    console.error(`     hasTenantSlug     : ${this.tenantSlug.length > 0}`);
    console.error(`     tenantSlug        : ${this.tenantSlug || "(vazio)"}`);
    console.error(`     ingestKey (chars) : ${this.ingestKey.length}`);
    console.error(`     resposta          : ${corpo.slice(0, 200)}`);
    if (/missing_credentials/.test(corpo) && this.ingestKey.length > 0 && this.tenantSlug.length > 0) {
      console.error("     >> O agent ENVIOU os dois cabecalhos e o servidor diz que faltam.");
      console.error("        Perderam-se entre o agent e a aplicacao — verificar o proxy");
      console.error("        para ESTE url, e nao para outro dominio.");
    }
    console.error("");
  }

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
      if (res.status === 401) this.diagnostico401(method, url, snippet);
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

export type PipelineAggregateComprasResponse = {
  ok: true;
  dryRun: boolean;
  aggregationBatchId?: string | null;
  window: { from: string; to: string };
  rawLinesRead: number;
  excludedLineCount: {
    total: number;
    byTipoDocumentoId: Array<{ externalTipoDocumentoId: number; count: number }>;
  };
  candidateGroups: number;
  orphanProducts: { count: number; sampleExternalCodigoIds: number[] };
  orphanFornecedores: { count: number; sampleExternalFornecedorIds: number[] };
  projectedValorTotal: number;
  projectedQuantidade: number;
  topSuppliers: Array<{
    fornecedorId: string;
    fornecedorNome: string;
    valorTotal: number;
    quantidade: number;
    groupCount: number;
  }>;
  /** Presente só em write mode. */
  created?: number;
  updated?: number;
  aggregated?: number;
  durationMs: number;
};

export type PipelineAggregateDevolucoesResponse = {
  ok: true;
  dryRun: boolean;
  aggregationBatchId?: string | null;
  window: { from: string; to: string };
  /** Campo de quantidade usado para o UPSERT (decisão: quantidadeRecebida). */
  quantityField: "quantidadeRecebida" | "quantidadeEnviada";
  rawLinesRead: number;
  excludedLineCount: { total: number; byEstado: Array<{ estado: string; count: number }> };
  /** Linhas que resolvem produto+fornecedor e entram no UPSERT. */
  candidateLines: number;
  orphanProducts: { count: number; sampleExternalCodigoIds: number[] };
  orphanFornecedores: { count: number; sampleExternalFornecedorIds: number[] };
  projectedValor: number;
  /** Soma do campo escolhido (recebida). */
  projectedQuantidade: number;
  /** Ambas reportadas para comparação/auditoria. */
  projectedQuantidadeRecebida: number;
  projectedQuantidadeEnviada: number;
  estadoDistribution: Array<{ estado: string; count: number }>;
  created?: number;
  updated?: number;
  aggregated?: number;
  durationMs: number;
};

export type BootstrapBatchResponse = {
  ok: true;
  accepted: number;
  upserted: number;
  skipped: Array<{ index: number; reason: string; externalId?: number }>;
  errors: Array<{ index: number; reason: string; externalId?: number; message: string }>;
  durationMs: number;
  /** rev46 — produtos que não existiam no catálogo central antes deste lote. */
  produtosNovos?: number;
  /** rev46 — produtos que já existiam e foram actualizados. */
  produtosAtualizados?: number;
  /**
   * rev46 — contagens do enriquecimento do catálogo central a partir do
   * ERP (Fabricante, DCI, ATC, Grupo Homogéneo, ProductType). Opcional:
   * só vem de servidores rev46+, e só quando houve candidatos.
   */
  catalogoErp?: {
    candidatos: number;
    preenchidos: Record<string, number>;
    substituidos: Record<string, number>;
    preservados: Record<string, number>;
  };
};
