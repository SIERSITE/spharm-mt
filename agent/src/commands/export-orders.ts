/**
 * agent/src/commands/export-orders.ts
 *
 * Polling do outbox SaaS e escrita das encomendas pending no SPharm
 * local. Fluxo por encomenda:
 *
 *   1. GET /api/outbox/v1/orders/pending — lease atómico até N orders
 *   2. Para cada order: writeOrderToSpharm (stub default)
 *      · Sucesso: POST .../ack com spharmDocumentId
 *      · Falha:   POST .../nack com retryable + error message
 *   3. Resumo final
 *
 * Idempotência:
 *   - O servidor SaaS já garante one-shot lease (5min TTL). Se o agent
 *     crashar a meio, a próxima invocação não duplica encomendas no
 *     SPharm porque o ACK só corre depois do write OK.
 *   - Em modo stub, o ficheiro é overwrite — re-ingestão da mesma
 *     encomenda produz o mesmo conteúdo (payload congelado).
 *   - Em modo insert (a implementar), o ERP deve recusar duplicado por
 *     um external_id que o agent passa = `outboxId` (ou idempotencyKey).
 *
 * Flags:
 *   --limit N        máximo de orders por execução (default 50)
 *   --dry-run        lease + write, mas NÃO faz ack/nack (apenas log)
 *
 * Exit codes:
 *   0  todas as orders processadas com sucesso (ou zero pending)
 *   1  config inválida ou erro fatal antes do loop
 *   2  uma ou mais orders falharam (nack enviado)
 */

import { parseArgs } from "node:util";
import * as os from "node:os";
import { loadConfig, ConfigError } from "../config.js";
import { SaasClient, type PendingOrder } from "../http-client.js";
import { writeOrderToSpharm, WriteOrderError } from "../spharm-orders-writer.js";
import { openPool } from "../sql-client.js";
import type { SqlPool } from "../sql-client.js";

type Args = {
  limit?: number;
  dryRun: boolean;
};

function parseCmd(): Args {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      limit: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    strict: true,
  });
  const limitRaw = values.limit ? parseInt(values.limit, 10) : NaN;
  return {
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    dryRun: values["dry-run"] === true,
  };
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function summariseOrder(o: PendingOrder): string {
  const lineCount = Array.isArray(o.payload.linhas) ? o.payload.linhas.length : 0;
  return `${o.outboxId} (lista=${o.listaEncomendaId}, farmácia=${o.farmaciaId}, linhas=${lineCount}, attempt=${o.attempt})`;
}

export async function exportOrders(): Promise<number> {
  let cfg;
  try {
    // 'saas' obrigatório; SQL só é necessário em modo insert
    cfg = loadConfig("saas");
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("✗ Config inválida:");
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  const args = parseCmd();
  const mode = cfg.ordersWriteMode ?? "stub";
  const agentInstance = `${cfg.tenantSlug}-${os.hostname()}`.slice(0, 100);

  console.log("─".repeat(72));
  console.log("export-orders");
  console.log("─".repeat(72));
  console.log(`tenant       : ${cfg.tenantSlug}`);
  console.log(`endpoint     : ${cfg.saasEndpoint}`);
  console.log(`agent inst.  : ${agentInstance}`);
  console.log(`write mode   : ${mode}`);
  console.log(`limit        : ${args.limit ?? 50}`);
  console.log(`dry-run      : ${args.dryRun ? "SIM (sem ack/nack)" : "não"}`);
  console.log("");

  const saas = new SaasClient(cfg);

  let pool: SqlPool | null = null;
  if (mode === "insert") {
    pool = openPool(cfg);
    try {
      await pool.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ SQL Server: ${msg}`);
      return 1;
    }
  }

  let pending;
  try {
    pending = await saas.pullPendingOrders({
      limit: args.limit,
      agentInstance,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ pullPendingOrders falhou: ${msg}`);
    if (pool) await pool.close();
    return 1;
  }

  console.log(`Recebidas ${pending.count} encomendas (lease até ${pending.leasedUntil}).`);
  if (pending.count === 0) {
    console.log("");
    console.log("Nada para exportar. OK.");
    if (pool) await pool.close();
    return 0;
  }
  console.log("");

  let okCount = 0;
  let failCount = 0;

  for (const order of pending.orders) {
    const label = summariseOrder(order);
    console.log(`▶ ${label}`);
    try {
      // Em dry-run: o writer também faz rollback (em modo insert) e
      // não escreve ficheiro (em modo stub). Sem dry-run, escrita real.
      const result = await writeOrderToSpharm(order, cfg, pool, { dryRun: args.dryRun });
      console.log(`  ✓ write: spharmDocumentId=${result.spharmDocumentId} source=${result.source} (${fmtDuration(result.durationMs)})`);
      if (args.dryRun) {
        console.log(`  · dry-run: write não persistido + ack NÃO enviado`);
      } else {
        try {
          await saas.ackOrder(order.outboxId, {
            spharmDocumentId: result.spharmDocumentId,
            durationMs: result.durationMs,
            details: result.details,
          });
          console.log(`  ✓ ack enviado`);
          okCount++;
        } catch (err) {
          // Write OK mas ACK falhou — o lease vai expirar e a SaaS
          // vai reentregar. Idempotência server-side garante que não
          // duplica no SPharm (mesmo outboxId).
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ ack falhou (write OK; lease vai expirar e reentregar): ${msg}`);
          failCount++;
        }
      }
    } catch (err) {
      const retryable = err instanceof WriteOrderError ? err.retryable : true;
      const sqlError =
        err instanceof WriteOrderError && err.sqlError ? err.sqlError : undefined;
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ write falhou (retryable=${retryable}): ${errorMsg}`);
      if (args.dryRun) {
        console.log(`  · dry-run: nack NÃO enviado`);
      } else {
        try {
          await saas.nackOrder(order.outboxId, {
            retryable,
            error: errorMsg,
            sqlError,
          });
          console.log(`  · nack enviado (retryable=${retryable})`);
        } catch (nackErr) {
          const m = nackErr instanceof Error ? nackErr.message : String(nackErr);
          console.error(`  ✗ nack falhou: ${m}`);
        }
      }
      failCount++;
    }
    console.log("");
  }

  if (pool) await pool.close();

  console.log("─".repeat(72));
  console.log(`Resumo: ${okCount} OK · ${failCount} falhas · ${pending.count} total`);
  console.log("─".repeat(72));

  return failCount === 0 ? 0 : 2;
}
