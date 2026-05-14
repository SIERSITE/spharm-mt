/**
 * agent/src/spharm-orders-writer.ts
 *
 * Camada responsável por escrever uma encomenda finalizada (vinda do
 * outbox SaaS) no SPharm ERP local.
 *
 * Modos de operação (controlado por `cfg.ordersWriteMode`):
 *
 *   · stub  — modo default. NÃO escreve no SPharm. Persiste o payload
 *     + enriquecimento (CNP por linha) num ficheiro JSON dentro de
 *     `outputDir/orders-export/YYYY-MM-DD/<outboxId>.json` e devolve
 *     um `spharmDocumentId` sintético prefixado com `STUB-`. Permite
 *     testar o pipeline end-to-end (lease → "write" → ack) sem ter o
 *     schema do SPharm consolidado.
 *
 *   · insert — modo real. INSERT directo nas tabelas SPharm. Falha
 *     deliberadamente até o schema-alvo estar mapeado (tabelas,
 *     colunas, lookup de CodigoArtigo por CNP). Não fingimos sucesso
 *     em produção.
 *
 * Mapeamento de produto: SaaS conhece `produtoId` (cuid SaaS) e
 * `enrichment.linhas[].cnp`. O write precisa de resolver CNP → CodigoArtigo
 * no SPharm — query parameterizada em modo insert. Em stub não é
 * necessário (logamos o que terias resolvido).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PendingOrder,
  PendingOrderLine,
  PendingOrderEnrichmentLine,
} from "./http-client.js";
import type { AgentConfig } from "./config.js";
import type { SqlPool } from "./sql-client.js";

export type OrdersWriteMode = "stub" | "insert";

export type WriteOrderResult = {
  spharmDocumentId: string;
  durationMs: number;
  details: Record<string, unknown>;
};

export class WriteOrderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly sqlError?: { code?: string; number?: number; message?: string }
  ) {
    super(message);
    this.name = "WriteOrderError";
  }
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function mergeLines(
  payloadLines: PendingOrderLine[],
  enrichmentLines: PendingOrderEnrichmentLine[]
): Array<PendingOrderLine & { cnp: string | null; designacao: string | null }> {
  const byId = new Map(enrichmentLines.map((e) => [e.produtoId, e]));
  return payloadLines.map((l) => {
    const e = byId.get(l.produtoId);
    return {
      ...l,
      cnp: e?.cnp ?? null,
      designacao: e?.designacao ?? null,
    };
  });
}

async function writeStub(
  order: PendingOrder,
  cfg: AgentConfig
): Promise<WriteOrderResult> {
  const startedAt = Date.now();
  const now = new Date();
  const dir = path.resolve(cfg.outputDir, "orders-export", ymd(now));
  fs.mkdirSync(dir, { recursive: true });

  const merged = mergeLines(order.payload.linhas, order.enrichment.linhas);
  const missingCnp = merged.filter((l) => !l.cnp).map((l) => l.produtoId);

  const out = {
    capturedAt: now.toISOString(),
    mode: "stub" as const,
    outboxId: order.outboxId,
    listaEncomendaId: order.listaEncomendaId,
    farmaciaId: order.farmaciaId,
    idempotencyKey: order.idempotencyKey,
    payloadHash: order.payloadHash,
    attempt: order.attempt,
    payload: order.payload,
    enrichment: order.enrichment,
    resolvedLines: merged,
    warnings: missingCnp.length > 0
      ? [`${missingCnp.length} produto(s) sem CNP resolvido — CodigoArtigo seria impossível de mapear em modo insert.`]
      : [],
  };
  const file = path.resolve(dir, `${order.outboxId}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");

  return {
    spharmDocumentId: `STUB-${order.outboxId.slice(0, 8)}-${now.getTime()}`,
    durationMs: Date.now() - startedAt,
    details: {
      mode: "stub",
      capturedAt: now.toISOString(),
      outputFile: file,
      lineCount: merged.length,
      missingCnpCount: missingCnp.length,
    },
  };
}

/**
 * Modo real — INSERT no SPharm. Bloqueado até o schema-alvo estar
 * consolidado (tabelas mestre de encomendas + linhas + lookup
 * CodigoArtigo por CNP). Ao consolidar:
 *   1) BEGIN TRANSACTION
 *   2) INSERT na tabela "header" da encomenda
 *   3) Para cada linha: SELECT TOP 1 CodigoArtigo FROM <tab> WHERE CNP = @cnp
 *      → INSERT linha. Falhar se CNP não tiver match.
 *   4) COMMIT, devolver o ID atribuído pelo ERP como spharmDocumentId
 */
async function writeInsert(
  _order: PendingOrder,
  _cfg: AgentConfig,
  _pool: SqlPool
): Promise<WriteOrderResult> {
  throw new WriteOrderError(
    "ordersWriteMode=insert ainda não está implementado — o schema-alvo do SPharm (tabelas de encomenda + colunas + lookup CNP→CodigoArtigo) ainda não foi consolidado. Usa SPHARMMT_ORDERS_WRITE_MODE=stub até o mapeamento estar fechado.",
    false
  );
}

export async function writeOrderToSpharm(
  order: PendingOrder,
  cfg: AgentConfig,
  pool: SqlPool | null
): Promise<WriteOrderResult> {
  const mode: OrdersWriteMode = cfg.ordersWriteMode ?? "stub";
  if (mode === "stub") return writeStub(order, cfg);
  if (mode === "insert") {
    if (!pool) {
      throw new WriteOrderError(
        "ordersWriteMode=insert requer pool SQL Server aberto, mas pool=null.",
        false
      );
    }
    return writeInsert(order, cfg, pool);
  }
  throw new WriteOrderError(`ordersWriteMode desconhecido: ${String(mode)}`, false);
}
