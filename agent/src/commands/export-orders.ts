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
  if (mode === "stub") {
    console.log("");
    console.log("⚠  STUB MODE — encomendas pendentes serão EXPORTADAS PARA JSON,");
    console.log("   NÃO escritas no SPharm. Para escrita real:");
    console.log("   editar agent.config.json → options.ordersWriteMode = \"insert\"");
  }
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
  const counters = {
    pulled: pending.count,
    inserted: 0,
    idempotent: 0,
    stub: 0,
    acked: 0,
    nacked: 0,
    failed: 0,
  };

  if (pending.count === 0) {
    console.log("");
    console.log("Nada para exportar. OK.");
    if (pool) await pool.close();
    printSummary(counters, mode, args.dryRun);
    return 0;
  }
  console.log("");

  for (const order of pending.orders) {
    const label = summariseOrder(order);
    console.log(`▶ ${label}`);
    try {
      // Em dry-run: o writer também faz rollback (em modo insert) e
      // não escreve ficheiro (em modo stub). Sem dry-run, escrita real.
      const result = await writeOrderToSpharm(order, cfg, pool, { dryRun: args.dryRun });
      console.log(`  ✓ write: spharmDocumentId=${result.spharmDocumentId} source=${result.source} (${fmtDuration(result.durationMs)})`);
      // Contadores granulares por source
      if (result.source === "created") counters.inserted++;
      else if (result.source === "idempotent") counters.idempotent++;
      else if (result.source === "stub") counters.stub++;
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
          counters.acked++;
        } catch (err) {
          // Write OK mas ACK falhou — o lease vai expirar e a SaaS
          // vai reentregar. Idempotência server-side garante que não
          // duplica no SPharm (mesmo outboxId).
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ ack falhou (write OK; lease vai expirar e reentregar): ${msg}`);
          counters.failed++;
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
          counters.nacked++;
        } catch (nackErr) {
          const m = nackErr instanceof Error ? nackErr.message : String(nackErr);
          console.error(`  ✗ nack falhou: ${m}`);
        }
      }
      counters.failed++;
    }
    console.log("");
  }

  if (pool) await pool.close();

  printSummary(counters, mode, args.dryRun);
  return counters.failed === 0 ? 0 : 2;
}

type Counters = {
  pulled: number;
  inserted: number;
  idempotent: number;
  stub: number;
  acked: number;
  nacked: number;
  failed: number;
};

function printSummary(c: Counters, mode: "stub" | "insert", dryRun: boolean): void {
  const rule = "═".repeat(72);
  console.log(rule);
  console.log("Resumo");
  console.log(rule);
  console.log(`  mode         : ${mode}${dryRun ? "  (dry-run)" : ""}`);
  console.log(`  pulled       : ${c.pulled}`);
  console.log(`  inserted     : ${c.inserted}     (writes novos no SPharm)`);
  console.log(`  idempotent   : ${c.idempotent}     (outboxId já existia — sem novo INSERT)`);
  if (mode === "stub") {
    console.log(`  stub         : ${c.stub}     (JSON gerado em outputDir/orders-export/)`);
  }
  console.log(`  acked        : ${c.acked}     (SaaS marcou EXPORTADO)`);
  console.log(`  nacked       : ${c.nacked}     (SaaS marcou FALHADO ou re-queued)`);
  console.log(`  failed       : ${c.failed}     (erros sem nack — lease expira e reentrega)`);
  console.log(rule);
  if (mode === "stub" && c.pulled > 0) {
    console.log("");
    console.log("⚠  ATENÇÃO: ordersWriteMode=stub — NADA foi escrito no SPharm.");
    console.log("   Apenas ficheiros JSON em <outputDir>/orders-export/<YYYY-MM-DD>/.");
    console.log("   Para escrita real: editar agent.config.json:");
    console.log('     options.ordersWriteMode = "insert"');
    console.log("     ordersInsert = { ... }   (ver agent.config.example.json)");
    console.log("   Antes da primeira escrita real: run-test-order-write.bat com DRY-RUN.");
  }
}
