/**
 * agent/src/http-client.ts
 *
 * Cliente HTTP para a API SaaS SPharm.MT. Usa o `fetch` nativo (Node
 * ≥ 20). Centraliza:
 *  · Headers de auth: `Authorization: Bearer <key>` + `X-Tenant-Slug`
 *  · Tratamento de errors HTTP com status code preservado
 *  · Timeout explícito por pedido (por tentativa; default da política, 30 s)
 *  · User-Agent identificável para logs server-side
 *  · RETENTATIVAS centralizadas (rev98) — ver `politica-retry.ts`: tentativa
 *    original + 4 retentativas (≈ 5/15/30/60 s + jitter), `Retry-After`
 *    respeitado, só para falhas transitórias (fetch failed, timeout, reset da
 *    ligação, DNS temporário, HTTP 408/425/429/502/503/504). 400/401/403/404/
 *    409/422 e erros de validação NUNCA se repetem.
 *
 * Idempotência: uma retentativa reenvia EXATAMENTE o mesmo corpo (a string
 * JSON é serializada uma só vez) — as mesmas chaves naturais/`idempotencyKey`/
 * `ingestRunId`. Todos os endpoints do pipeline diário são idempotentes
 * (auditoria em `agent/docs/resiliencia.md`). Os endpoints de CLAIM/ACK do
 * outbox (orders, sync-requests) NÃO usam retry: um claim cuja resposta se
 * perdeu não se repete às cegas.
 *
 * Os logs nunca incluem o token, os headers nem o corpo dos pedidos.
 */

import type { AgentConfig } from "./config.js";
import { verificarGuardaEscrita } from "./guarda-escrita.js";
import { fimExclusivoDoDia } from "./janela.js";
import {
  calcularEspera,
  classificarErroDeRede,
  classificarStatus,
  marcarFalhaTransitoriaDefinitiva,
  mesclarPolitica,
  parseRetryAfter,
  politicaDoAmbiente,
  redigir,
  type ClasseFalha,
  type PoliticaRetry,
} from "./politica-retry.js";

export class SaasApiError extends Error {
  /** Nº de tentativas HTTP feitas até esta resposta (1 = sem retentativas). */
  public tentativas = 1;
  /** `true` quando era uma resposta retentável (408/425/429/502/503/504) e as retentativas esgotaram-se. */
  public transitoria = false;
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

/**
 * Falha de rede (sem resposta utilizável). A mensagem mantém o prefixo histórico
 * `SaaS <método> <path> — falha de rede: …` (há código que a reconhece por texto).
 */
export class SaasNetworkError extends Error {
  public readonly transitoria: boolean;
  constructor(
    message: string,
    public readonly classe: ClasseFalha,
    public readonly path: string,
    public readonly method: string,
    public readonly tentativas: number,
  ) {
    super(message);
    this.name = "SaasNetworkError";
    this.transitoria = classe.retentavel;
  }
}

/** Contexto de log (nunca dados de negócio): onde estamos no pipeline. */
export type ContextoLog = { dia?: string; etapa?: string };

export type OpcoesPedido = {
  body?: unknown;
  timeoutMs?: number;
  expectJson?: boolean;
  /** `false` desliga as retentativas; objeto parcial sobrepõe a política do cliente. */
  retry?: false | Partial<PoliticaRetry>;
  /** Nº do lote (só para o log). */
  lote?: number;
  /**
   * Não verifica a propriedade do lock antes deste pedido. Só para o registo do resultado (`PipelineRun`) — que uma execução
   * que perdeu o lock ainda deve poder reportar — nunca para escritas de dados.
   */
  semGuarda?: boolean;
  /** HTTP 500 com `acquire_lock` no corpo = lock de agregação ocupado (o pedido original ainda corre): repete. */
  repetirLockOcupado?: boolean;
  /**
   * Depois de uma retentativa de um pedido cuja primeira tentativa foi AMBÍGUA, uma resposta 200 com
   * `errors[]` (conflitos de unicidade com o pedido original ainda a correr) é repetida mais uma vez.
   */
  repetirSeErrosAposAmbigua?: boolean;
  /**
   * Resposta já resolvida quando, DEPOIS de uma retentativa, o servidor responde que o trabalho já está feito
   * (ex.: `finalize` → 409 sem_corrida_aberta). Devolve `undefined` para seguir o fluxo normal.
   */
  aceitarComoFeito?: (status: number, corpo: string) => unknown | undefined;
};

export type OpcoesCliente = {
  politica?: PoliticaRetry;
  /** Para testes: espera injetável. */
  dormir?: (ms: number) => Promise<void>;
  aleatorio?: () => number;
  agora?: () => number;
  log?: (linha: string) => void;
  /** `fetch` injetável (testes). */
  fetchImpl?: typeof fetch;
};

export type EstatisticasHttp = {
  pedidos: number;
  /** Pedidos que só tiveram sucesso depois de uma ou mais retentativas. */
  recuperadosPorRetentativa: number;
  /** Destes, quantos tiveram uma tentativa anterior AMBÍGUA (o servidor pode já ter escrito). */
  recuperadosAposAmbigua: number;
  retentativas: number;
  falhasDefinitivas: number;
};

export class SaasClient {
  private readonly endpoint: string;
  private readonly tenantSlug: string;
  private readonly ingestKey: string;
  private readonly agentVersion: string;
  private readonly politica: PoliticaRetry;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly aleatorio: () => number;
  private readonly agora: () => number;
  private readonly logFn: (linha: string) => void;
  private readonly fetchImpl: typeof fetch;
  private contexto: ContextoLog = {};
  private readonly stats: EstatisticasHttp = {
    pedidos: 0,
    recuperadosPorRetentativa: 0,
    recuperadosAposAmbigua: 0,
    retentativas: 0,
    falhasDefinitivas: 0,
  };

  constructor(
    cfg: Pick<AgentConfig, "saasEndpoint" | "tenantSlug" | "ingestKey" | "agentVersion"> & { politicaRetry?: PoliticaRetry },
    opts: OpcoesCliente = {},
  ) {
    this.endpoint = cfg.saasEndpoint.replace(/\/+$/, "");
    this.tenantSlug = cfg.tenantSlug;
    this.ingestKey = cfg.ingestKey;
    this.agentVersion = cfg.agentVersion;
    this.politica = opts.politica ?? cfg.politicaRetry ?? politicaDoAmbiente();
    this.dormir = opts.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.aleatorio = opts.aleatorio ?? Math.random;
    this.agora = opts.agora ?? Date.now;
    this.logFn = opts.log ?? ((l) => console.log(l));
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    // Subprocessos do daily-pipeline herdam o dia/etapa só para o log (nunca dados de negócio).
    this.contexto = { dia: process.env.SPHARMMT_CTX_DIA || undefined, etapa: process.env.SPHARMMT_CTX_ETAPA || undefined };
  }

  /** Dia de referência e etapa do pipeline, só para os logs (nunca dados de negócio). */
  definirContexto(ctx: ContextoLog): void {
    this.contexto = { ...ctx };
  }

  /** Contadores acumulados deste cliente (para o resumo final do pipeline). */
  estatisticas(): EstatisticasHttp {
    return { ...this.stats };
  }

  /** Política efetiva (para diagnóstico). */
  politicaEfetiva(): PoliticaRetry {
    return { ...this.politica, esperasMs: [...this.politica.esperasMs] };
  }

  private log(linha: string): void {
    // Última barreira: nenhum segredo chega ao log, aconteça o que acontecer à mensagem original.
    this.logFn(redigir(linha, [this.ingestKey]));
  }

  private prefixoLog(method: string, path: string, lote?: number): string {
    const partes = [`[http] ${method} ${path.split("?")[0]}`];
    if (this.contexto.dia) partes.push(`dia=${this.contexto.dia}`);
    if (this.contexto.etapa) partes.push(`etapa=${this.contexto.etapa}`);
    if (lote !== undefined) partes.push(`lote=${lote}`);
    return partes.join(" ");
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: OpcoesPedido = {}
  ): Promise<T> {
    return this.executar<T>(method, path, {}, opts);
  }

  /**
   * Núcleo único: tentativa original + retentativas da política. O corpo é serializado UMA vez e
   * reenviado byte a byte (mesmas chaves de idempotência). Só se avança com uma resposta válida.
   */
  private async executar<T>(
    method: "GET" | "POST",
    path: string,
    extraHeaders: Record<string, string>,
    opts: OpcoesPedido = {}
  ): Promise<T> {
    const url = `${this.endpoint}${path.startsWith("/") ? path : "/" + path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.ingestKey}`,
      "X-Tenant-Slug": this.tenantSlug,
      Accept: "application/json",
      "User-Agent": `spharmmt-agent/${this.agentVersion}`,
      ...extraHeaders,
    };
    const corpo = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    if (corpo !== undefined) headers["Content-Type"] = "application/json";

    const politica =
      opts.retry === false
        ? { ...this.politica, esperasMs: [] as number[] }
        : opts.retry
          ? mesclarPolitica(opts.retry, this.politica)
          : this.politica;
    const timeoutMs = opts.timeoutMs ?? politica.timeoutMs;
    const total = politica.esperasMs.length + 1;
    const pref = this.prefixoLog(method, path, opts.lote);
    this.stats.pedidos++;

    let houveAmbigua = false;
    let ultimaFalhaLog = "";
    let jaRepetiuPorErros = false;

    for (let tentativa = 1; tentativa <= total; tentativa++) {
      // Perdi o lock? Então NÃO escrevo (nem repito uma escrita): aborta antes de enviar. Leituras (GET) não são escritas.
      if (method !== "GET" && !opts.semGuarda) verificarGuardaEscrita();
      const t0 = this.agora();
      const ultima = tentativa === total;
      let classe: ClasseFalha | null = null;
      let detalheFalha = "";
      let retryAfterMs: number | null = null;
      let res: Response | undefined;

      // ── 1) enviar ──────────────────────────────────────────────
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        res = await this.fetchImpl(url, { method, headers, body: corpo, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        classe = classificarErroDeRede(err);
        detalheFalha = redigir(err instanceof Error ? err.message : String(err), [this.ingestKey]);
        if (classe.codigo) detalheFalha += ` [${classe.codigo}]`;
      }

      // ── 2) ler a resposta (o corpo também pode perder-se a meio) ──
      let textoCorpo = "";
      let jsonCorpo: unknown;
      let corpoLido = false;
      if (res) {
        try {
          if (!res.ok) {
            textoCorpo = (await res.text()).slice(0, 500);
          } else if (opts.expectJson !== false) {
            jsonCorpo = await res.json();
          }
          corpoLido = true;
        } catch (err) {
          classe = classificarErroDeRede(err, { faseCorpo: true });
          detalheFalha = `resposta incompleta: ${redigir(err instanceof Error ? err.message : String(err), [this.ingestKey])}`;
        } finally {
          clearTimeout(timer);
        }
      }

      const dur = this.agora() - t0;

      // ── 3) sucesso ─────────────────────────────────────────────
      if (res && res.ok && corpoLido) {
        // Uma retentativa que apanhou 200 com errors[] por conflito com o pedido original ainda a correr.
        const errosNaResposta =
          jsonCorpo && typeof jsonCorpo === "object" && Array.isArray((jsonCorpo as { errors?: unknown }).errors)
            ? (jsonCorpo as { errors: unknown[] }).errors.length
            : 0;
        if (opts.repetirSeErrosAposAmbigua && houveAmbigua && errosNaResposta > 0 && !ultima && !jaRepetiuPorErros) {
          jaRepetiuPorErros = true;
          const espera = calcularEspera(tentativa, politica, null, this.aleatorio);
          this.log(
            `${pref} tentativa ${tentativa}/${total}: HTTP ${res.status} com ${errosNaResposta} erro(s) por item após falha ambígua ` +
              `(conflito com o pedido original?) — nova tentativa em ${(espera / 1000).toFixed(1)}s`,
          );
          this.stats.retentativas++;
          await this.dormir(espera);
          continue;
        }
        if (tentativa > 1) {
          this.stats.recuperadosPorRetentativa++;
          if (houveAmbigua) this.stats.recuperadosAposAmbigua++;
          this.log(
            `${pref} ✓ concluído na tentativa ${tentativa}/${total} em ${dur}ms` +
              (houveAmbigua ? " (houve tentativa ambígua — pedido idempotente repetido com o mesmo corpo)" : "") +
              (ultimaFalhaLog ? ` | última falha: ${ultimaFalhaLog}` : ""),
          );
        }
        if (opts.expectJson === false) return undefined as T;
        return jsonCorpo as T;
      }

      // ── 4) resposta HTTP de erro ──────────────────────────────
      if (res && !res.ok && corpoLido) {
        const status = res.status;
        const snippet = redigir(textoCorpo, [this.ingestKey]);
        // «já está feito»: depois de uma retentativa o servidor diz que o trabalho existe.
        if (tentativa > 1 && opts.aceitarComoFeito) {
          const r = opts.aceitarComoFeito(status, snippet);
          if (r !== undefined) {
            this.stats.recuperadosPorRetentativa++;
            if (houveAmbigua) this.stats.recuperadosAposAmbigua++;
            this.log(
              `${pref} ✓ tentativa ${tentativa}/${total}: HTTP ${status} após falha ambígua — o servidor já tinha concluído o pedido anterior; aceite como sucesso idempotente`,
            );
            return r as T;
          }
        }
        let c = classificarStatus(status);
        // 500 `acquire_lock`: o servidor está a processar o pedido original (ou outro igual) — espera e repete.
        if (!c.retentavel && status === 500 && opts.repetirLockOcupado && /acquire_lock/i.test(snippet)) {
          c = { tipo: "http_retentavel", retentavel: true, ambigua: false, statusCode: status };
        }
        classe = c;
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.agora());
        detalheFalha = `HTTP ${status}`;

        if (!c.retentavel || ultima) {
          if (status === 401) this.diagnostico401(method, url, snippet);
          this.stats.falhasDefinitivas++;
          if (c.retentavel) {
            marcarFalhaTransitoriaDefinitiva();
            this.log(
              `${pref} ✗ FALHA DEFINITIVA após ${tentativa}/${total} tentativas: HTTP ${status} (${c.tipo}${houveAmbigua ? ", houve tentativa ambígua" : ""}) em ${dur}ms`,
            );
          } else {
            this.log(`${pref} ✗ HTTP ${status} (${c.tipo}) — não se repete (tentativa ${tentativa}/${total}, ${dur}ms)`);
          }
          const err = new SaasApiError(
            `SaaS ${method} ${path} → HTTP ${status}: ${snippet || "(corpo vazio)"}`,
            status,
            path,
            method,
            snippet
          );
          err.tentativas = tentativa;
          err.transitoria = c.retentavel;
          throw err;
        }
      } else if (classe) {
        // ── 5) falha de rede / timeout / corpo incompleto ───────────
        if (!classe.retentavel || ultima) {
          this.stats.falhasDefinitivas++;
          if (classe.retentavel) marcarFalhaTransitoriaDefinitiva();
          this.log(
            `${pref} ✗ ${classe.retentavel ? `FALHA DEFINITIVA após ${tentativa}/${total} tentativas` : "falha não retentável"}: ${classe.tipo}` +
              `${classe.ambigua ? " (resultado ambíguo: o servidor pode ter processado o pedido)" : ""} — ${detalheFalha} (${dur}ms)`,
          );
          throw new SaasNetworkError(
            `SaaS ${method} ${path} — falha de rede: ${detalheFalha}` + (tentativa > 1 ? ` (após ${tentativa} tentativas)` : ""),
            classe,
            path,
            method,
            tentativa,
          );
        }
      }

      // ── 6) preparar a retentativa ─────────────────────────────
      const c = classe as ClasseFalha;
      if (c.ambigua) houveAmbigua = true;
      ultimaFalhaLog = `${c.tipo}${c.statusCode ? ` ${c.statusCode}` : ""}${c.codigo ? ` ${c.codigo}` : ""}`;
      // O lock de agregação ocupado e os timeouts ambíguos precisam de MAIS tempo: o pedido original pode
      // ainda estar a correr no servidor (a janela de retry do lock no servidor é de ~1 s).
      let espera = calcularEspera(tentativa, politica, retryAfterMs, this.aleatorio);
      if (opts.repetirLockOcupado && (c.ambigua || c.statusCode === 500)) espera = Math.max(espera, 30_000);
      this.stats.retentativas++;
      this.log(
        `${pref} tentativa ${tentativa}/${total} falhou: ${c.tipo}${c.statusCode ? ` (HTTP ${c.statusCode})` : ""}` +
          `${c.codigo ? ` [${c.codigo}]` : ""} em ${dur}ms — ` +
          `${c.ambigua ? "AMBÍGUA (o servidor pode já ter processado; repete-se o mesmo pedido idempotente)" : "o servidor não chegou a processar"}` +
          `${retryAfterMs !== null ? `; Retry-After=${Math.round(retryAfterMs / 1000)}s` : ""} — nova tentativa em ${(espera / 1000).toFixed(1)}s`,
      );
      await this.dormir(espera);
    }
    // inalcançável: o ciclo termina sempre com return ou throw
    throw new SaasNetworkError(
      `SaaS ${method} ${path} — falha de rede: esgotadas as tentativas`,
      { tipo: "outro", retentavel: false, ambigua: false },
      path,
      method,
      total,
    );
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
  /**
   * GET /api/ingest/v1/bootstrap/products/designacoes?farmaciaId=…
   * Esta farmácia é a autoritativa para a designação? (SÓ tenant silveira;
   * em qualquer outro caso `autoritativa:false`.)
   */
  async designacoesEstado(
    farmaciaId: string,
    timeoutMs?: number
  ): Promise<{ ok: boolean; aplica: boolean; autoritativa: boolean; modo: string; erroConfiguracao?: { codigo: string; mensagem: string } }> {
    return this.request("GET", `/api/ingest/v1/bootstrap/products/designacoes?farmaciaId=${encodeURIComponent(farmaciaId)}`, { timeoutMs });
  }

  /**
   * POST /api/ingest/v1/bootstrap/products/designacoes
   * Passo leve da farmácia autoritativa: só (cnp, designação). 409 se esta
   * farmácia não for a autoritativa (nada é escrito).
   */
  async bootstrapProductsDesignacoes(
    body: { farmaciaId: string; items: Array<{ cnp: number; designacao: string | null }> },
    timeoutMs?: number
  ): Promise<{
    ok: true;
    recebidas: number;
    semCnp: number;
    verificadas: number;
    alteradas: number;
    jaIguais: number;
    ignoradasVazias: number;
    ignoradasManual: number;
    semProduto: number;
    durationMs: number;
  }> {
    return this.request("POST", "/api/ingest/v1/bootstrap/products/designacoes", { body, timeoutMs });
  }

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
    timeoutMs?: number,
    extra: { lote?: number } = {}
  ): Promise<BootstrapBatchResponse> {
    return this.request("POST", "/api/ingest/v1/bootstrap/products", { body, timeoutMs, lote: extra.lote });
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
      // Se a 1.ª tentativa chegou ao servidor (resposta perdida), o sweep já foi feito e a corrida fechada:
      // a repetição devolve 409 sem_corrida_aberta. SÓ depois de uma retentativa isso significa «já está feito».
      aceitarComoFeito: (status, corpo) =>
        status === 409 && /sem_corrida_aberta/.test(corpo)
          ? { ok: true as const, farmaciaId: body.farmaciaId, runStartedAt: body.runStartedAt, retiredCount: 0, durationMs: 0, jaFinalizado: true }
          : undefined,
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
    timeoutMs?: number,
    extra: { lote?: number } = {}
  ): Promise<BootstrapBatchResponse & { aggregated?: number }> {
    return this.request("POST", "/api/ingest/v1/bootstrap/stock", { body, timeoutMs, lote: extra.lote });
  }

  /**
   * POST /api/ingest/v1/bootstrap/sales-lines
   * Insert/update das linhas de venda raw em staging
   * `IngestVendaLinhaRaw`. Body: { farmaciaId, items: SaleLinePayload[] }.
   * Idempotente via (farmaciaId, externalSaleLineId).
   */
  async bootstrapSalesLines(
    body: { farmaciaId: string; items: unknown[] },
    timeoutMs?: number,
    extra: { lote?: number } = {}
  ): Promise<BootstrapBatchResponse & { orphanProductLines?: number; nonStockServiceLines?: number; operationalOrphans?: number }> {
    return this.request("POST", "/api/ingest/v1/bootstrap/sales-lines", { body, timeoutMs, lote: extra.lote });
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
      repetirSeErrosAposAmbigua: true,
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
      repetirSeErrosAposAmbigua: true,
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
      repetirSeErrosAposAmbigua: true,
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
      repetirLockOcupado: true,
    });
  }

  /**
   * POST /api/admin/pipeline/aggregate-compras
   * Agrega `StagingCompraRawLine` → `Compra` (UPSERT por
   * `(farmaciaId, produtoId, fornecedorId, data)`). `write=false` (default
   * server-side) = dry-run preview; `write=true` escreve. Resolve produtos
   * via ProdutoFarmacia + fornecedores via FornecedorErpRef. Idempotente.
   *
   * `to` é INCLUSIVO aqui — o último dia que se quer agregar, como em
   * todo o agent. A conversão para o `to` exclusivo que o endpoint
   * espera é feita neste método, via `fimExclusivoDoDia`. Quem chama
   * passa a mesma janela que passou à ingestão e não tem de saber que
   * os dois lados a exprimem de forma diferente.
   */
  async pipelineAggregateCompras(
    body: { farmaciaId: string; from: string; to: string; write?: boolean },
    timeoutMs?: number
  ): Promise<PipelineAggregateComprasResponse> {
    return this.request("POST", "/api/admin/pipeline/aggregate-compras", {
      body: { ...body, to: fimExclusivoDoDia(body.to) },
      timeoutMs: timeoutMs ?? 90_000,
      repetirLockOcupado: true,
    });
  }

  /**
   * POST /api/admin/pipeline/aggregate-devolucoes
   * Agrega `StagingDevolucaoFornecedorRawLine` → `Devolucao`
   * (UPSERT por linha em `(farmaciaId, externalLineId)`, quantidade =
   * quantidadeRecebida). `write=false` = dry-run; `write=true` escreve.
   * Pode devolver 404 `not_implemented` se o endpoint não existir no SaaS
   * (deploy mais antigo) — o full-sync trata isso como NOT_IMPLEMENTED.
   *
   * `to` é INCLUSIVO aqui — o último dia que se quer agregar, como em
   * todo o agent. A conversão para o `to` exclusivo que o endpoint
   * espera é feita neste método, via `fimExclusivoDoDia`. Quem chama
   * passa a mesma janela que passou à ingestão e não tem de saber que
   * os dois lados a exprimem de forma diferente.
   */
  async pipelineAggregateDevolucoes(
    body: { farmaciaId: string; from: string; to: string; write?: boolean },
    timeoutMs?: number
  ): Promise<PipelineAggregateDevolucoesResponse> {
    return this.request("POST", "/api/admin/pipeline/aggregate-devolucoes", {
      body: { ...body, to: fimExclusivoDoDia(body.to) },
      timeoutMs: timeoutMs ?? 90_000,
      repetirLockOcupado: true,
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
    return this.request("POST", "/api/admin/pipeline/record", { body, timeoutMs, semGuarda: true });
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
      { timeoutMs: options.timeoutMs, retry: false } // claim: não se repete às cegas
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
      { body, timeoutMs, retry: false }
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
      { body, timeoutMs, retry: false }
    );
  }

  // ── Outbox (sync-now: botão "Sincronizar agora" em /stock, Bloco E) ──
  //
  // Direcção invertida face aos orders acima: aqui quem depositou o
  // pedido foi um humano no browser, e o agent consome-o. Cada
  // instalação do agent está ligada a UMA farmácia (`SPHARMMT_FARMACIA`)
  // — por isso `farmaciaId` vai sempre explícito no pedido, ao
  // contrário de `pullPendingOrders`.

  /**
   * GET /api/outbox/v1/sync-requests/pending?farmaciaId=<id>&waitSeconds=<N>
   *
   * Reclama atomicamente (se existir) o pedido PENDENTE desta farmácia
   * — no máximo 1, garantido pelo mutex server-side. Sem TTL de lease
   * a reclamar: o comando `sync-now` corre o trabalho de forma síncrona
   * logo a seguir, dentro da mesma invocação.
   *
   * `waitSeconds` > 0 pede LONG-POLL ao servidor: o pedido HTTP fica
   * pendurado até `waitSeconds` (tecto server-side de 25s, ver
   * `lib/sync-request/longpoll.ts`) ou até aparecer algo reclamável — o
   * que vier primeiro. `sync-now.ts` chama isto várias vezes em
   * sequência (`runLongPollCycles`) para cobrir mais tempo do que um
   * único hold, sem processo persistente.
   *
   * O timeout do CLIENTE (`timeoutMs`) tem de exceder `waitSeconds` —
   * senão o `fetch` aborta antes do servidor responder. Por omissão
   * (sem `options.timeoutMs` explícito) é calculado por
   * `syncNowLongPollTimeoutMs`; passar `timeoutMs` explicitamente
   * ignora esse cálculo.
   */
  async pullPendingSyncRequests(
    farmaciaId: string,
    options: { agentInstance?: string; waitSeconds?: number; timeoutMs?: number } = {}
  ): Promise<PendingSyncRequestsResponse> {
    const headers: Record<string, string> = {};
    if (options.agentInstance) headers["x-agent-instance"] = options.agentInstance;
    const waitSeconds = options.waitSeconds ?? 0;
    const qs = new URLSearchParams({ farmaciaId });
    if (waitSeconds > 0) qs.set("waitSeconds", String(waitSeconds));
    const url = `/api/outbox/v1/sync-requests/pending?${qs.toString()}`;
    const timeoutMs =
      options.timeoutMs ?? (waitSeconds > 0 ? syncNowLongPollTimeoutMs(waitSeconds) : undefined);
    return this.requestWithHeaders<PendingSyncRequestsResponse>("GET", url, headers, {
      timeoutMs,
      retry: false, // long-poll com claim: o ciclo seguinte do poll é a «retentativa»
    });
  }

  /**
   * POST /api/outbox/v1/sync-requests/{syncRequestId}/ack
   *
   * Confirma sincronização concluída com os três contadores que o
   * botão mostra: stock actualizado, produtos actualizados, fabricantes
   * alterados.
   */
  async ackSyncRequest(
    syncRequestId: string,
    resultado: SyncNowResultado,
    timeoutMs?: number
  ): Promise<{ ok: true; resultado: SyncNowResultado }> {
    return this.request(
      "POST",
      `/api/outbox/v1/sync-requests/${encodeURIComponent(syncRequestId)}/ack`,
      { body: { resultado }, timeoutMs, retry: false }
    );
  }

  /**
   * POST /api/outbox/v1/sync-requests/{syncRequestId}/fail
   *
   * Reporta falha TERMINAL — ao contrário de `/orders/{id}/nack`, não
   * há re-agendamento: o utilizador vê o erro e decide se carrega no
   * botão outra vez.
   */
  async failSyncRequest(
    syncRequestId: string,
    error: string,
    timeoutMs?: number
  ): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/outbox/v1/sync-requests/${encodeURIComponent(syncRequestId)}/fail`,
      { body: { error }, timeoutMs, retry: false }
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
    opts: OpcoesPedido = {}
  ): Promise<T> {
    return this.executar<T>(method, path, extraHeaders, opts);
  }
}

// ── Sync-now (Bloco E) ──────────────────────────────────────────────

/**
 * Timeout do cliente para uma chamada de long-poll a `.../pending`.
 *
 * Tem de ser MAIOR que `waitSeconds` — o servidor pode legitimamente
 * demorar até `waitSeconds` a responder (mesmo com `count: 0`), e um
 * timeout de cliente igual ou menor abortaria a chamada antes disso,
 * transformando um "nada pendente" normal num falso erro de rede.
 * +10s de folga cobre round-trip/TLS/fila do servidor. Extraída como
 * função pura (sem `fetch`, sem `AbortController`) para ser testável
 * sem rede — ver `scripts/tests/test-sync-on-demand.ts`.
 */
export function syncNowLongPollTimeoutMs(waitSeconds: number): number {
  return Math.max(0, waitSeconds) * 1000 + 10_000;
}

export type PendingSyncRequest = {
  syncRequestId: string;
  farmaciaId: string;
  requestedAt: string;
  timeoutAt: string;
};

export type PendingSyncRequestsResponse = {
  count: number;
  syncRequests: PendingSyncRequest[];
};

/** Os três contadores que o botão "Sincronizar agora" mostra ao concluir. */
export type SyncNowResultado = {
  stockAtualizado: number;
  produtosAtualizados: number;
  fabricantesAlterados: number;
  /**
   * Só farmácia autoritativa da designação (tenant silveira). Omitido nas
   * restantes — o SaaS e a UI tratam a ausência como "não se aplica".
   */
  designacoesAlteradas?: number;
  designacoesVerificadas?: number;
};

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
  /**
   * PARTIAL: o núcleo passou mas um passo obrigatório falhou. NÃO conta
   * como dia concluído — o catch-up volta a propô-lo. Ver
   * `lib/pipeline/types.ts` no SaaS.
   */
  status: "OK" | "PARTIAL" | "ERROR" | "ABORTED";
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
  /**
   * Designações de produto (SÓ tenant silveira — ver lib/ingest/
   * designacao-silveira.ts no SaaS). Ausente nos outros tenants.
   */
  designacoes?: {
    modo: "AUTORITATIVA" | "SO_CRIACAO";
    criadas: number;
    verificadas: number;
    alteradas: number;
    jaIguais: number;
    ignoradasOrigemNaoAutoritativa: number;
    ignoradasVazias: number;
    ignoradasManual: number;
    erros: number;
    erroConfiguracao?: { codigo: string; mensagem: string };
  };
};
