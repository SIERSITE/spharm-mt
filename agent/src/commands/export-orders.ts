/**
 * agent/src/commands/export-orders.ts
 *
 * Polling do outbox SaaS e escrita das encomendas pending no SPharm
 * local. Fluxo por encomenda:
 *
 *   1. GET /api/outbox/v1/orders/pending — lease atómico até N orders
 *   2. Para cada order: writeOrderToSpharm (stub default | insert real)
 *      · Sucesso: POST .../ack com spharmDocumentId
 *      · Falha:   POST .../nack com retryable + error message
 *   3. Resumo final
 *
 * Exactly-once semantics:
 *   - Lease no SaaS é atómico (skip locked, TTL 5min)
 *   - Em modo insert: writeInsert verifica `dbo.SPharmMT_OrderWriteLog`
 *     ANTES de qualquer INSERT. Se outboxId já existir, retorna o
 *     Encomenda ID existente sem reescrever no SPharm. Isto cobre o
 *     cenário: agent escreveu em SPharm, comitou, e crashou ANTES de
 *     fazer ACK ao SaaS. Re-execução re-leasa a mesma encomenda do
 *     SaaS, descobre que já foi escrita, retry só o ACK.
 *   - Em modo stub, o ficheiro é overwrite — re-ingestão produz mesmo
 *     conteúdo (payload congelado).
 *
 * Startup self-check (modo insert apenas):
 *   - SELECT 1
 *   - sys.columns probe (IDENTITY de Encomendas + Encomendas Detalhe)
 *   - OBJECT_ID(SPharmMT_OrderWriteLog)
 *   - sys.columns probe da `productLookupColumn` configurada
 *
 * Logs:
 *   - stdout/stderr → log agregado do BAT (logs/export-orders-<data>.log)
 *   - Por erro: linha adicional em logs/export-orders-errors-<data>.log
 *     com timestamp, outboxId, retryable, mensagem, stack curta
 *
 * Flags:
 *   --limit N        máximo de orders por execução (default 50)
 *   --dry-run        lease + write, mas NÃO faz ack/nack (apenas log)
 *
 * Exit codes:
 *   0  todas as orders processadas com sucesso (ou zero pending)
 *   1  config inválida ou erro fatal antes do loop (preflight failed)
 *   2  uma ou mais orders falharam — Task Scheduler regista falha
 */

import { parseArgs } from "node:util";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, ConfigError, assertOrdersWriteReady } from "../config.js";
import { SaasClient, type PendingOrder } from "../http-client.js";
import {
  writeOrderToSpharm,
  WriteOrderError,
  preflightInsertMode,
} from "../spharm-orders-writer.js";
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

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function shortStack(err: unknown, maxLines = 4): string {
  if (!(err instanceof Error) || !err.stack) return "";
  const lines = err.stack.split("\n");
  // Skip the first line (it's usually just "Error: message")
  const stackLines = lines.slice(1, 1 + maxLines).map((l) => l.trim());
  return stackLines.join("\n");
}

/**
 * Appender ao ficheiro de erros — append-only, JSON-like-but-human.
 * Falhas a escrever no log são silenciosas (não queremos que log writer
 * impeça o agent de funcionar). Path: logs/export-orders-errors-<date>.log
 * relativo ao cwd (que o BAT define como a pasta do agent).
 */
type ErrorLogEntry = {
  outboxId: string | null;
  phase: "preflight" | "pull" | "write" | "ack" | "nack";
  retryable: boolean;
  error: string;
  details?: string;
};

function appendErrorLog(entry: ErrorLogEntry, err?: unknown): void {
  try {
    const dir = path.resolve(process.cwd(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.resolve(dir, `export-orders-errors-${ymd(new Date())}.log`);
    const ts = new Date().toISOString();
    const head = `[${ts}] outbox=${entry.outboxId ?? "-"} phase=${entry.phase} retryable=${entry.retryable}`;
    const body = `  ${entry.error}`;
    const det = entry.details ? `  ${entry.details}` : "";
    const stack = err ? shortStack(err) : "";
    const indentedStack = stack ? stack.split("\n").map((l) => `    ${l}`).join("\n") : "";
    const block = [head, body, det, indentedStack].filter((s) => s.length > 0).join("\n") + "\n\n";
    fs.appendFileSync(file, block, "utf8");
  } catch {
    // log writer não pode bloquear o agent
  }
}

type Counters = {
  pulled: number;
  inserted: number;
  idempotent: number;
  recovered: number;
  stub: number;
  acked: number;
  nacked: number;
  failed: number;
};

function newCounters(): Counters {
  return {
    pulled: 0,
    inserted: 0,
    idempotent: 0,
    recovered: 0,
    stub: 0,
    acked: 0,
    nacked: 0,
    failed: 0,
  };
}

function printSummary(c: Counters, mode: "stub" | "insert", dryRun: boolean, durationMs: number): void {
  const rule = "═".repeat(72);
  console.log(rule);
  console.log("EXPORT ORDERS SUMMARY");
  console.log(rule);
  console.log(`  mode      : ${mode}${dryRun ? "  (dry-run)" : ""}`);
  console.log(`  pulled    : ${c.pulled}`);
  console.log(`  inserted  : ${c.inserted}`);
  console.log(`  idempotent: ${c.idempotent}`);
  console.log(`  recovered : ${c.recovered}     (write-log já tinha — agent ressuscitou pós-crash)`);
  if (mode === "stub") {
    console.log(`  stub      : ${c.stub}     (JSON apenas, NÃO escrito em SPharm)`);
  }
  console.log(`  acked     : ${c.acked}`);
  console.log(`  nacked    : ${c.nacked}`);
  console.log(`  failed    : ${c.failed}`);
  console.log(`  duration  : ${fmtDuration(durationMs)}`);
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

export async function exportOrders(): Promise<number> {
  const startedAt = Date.now();
  let cfg;
  try {
    cfg = loadConfig("saas");
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("✗ Config inválida:");
      console.error(err.message);
      appendErrorLog(
        { outboxId: null, phase: "preflight", retryable: false, error: "config inválida", details: err.message },
        err
      );
      return 1;
    }
    throw err;
  }

  const args = parseCmd();
  const mode = cfg.ordersWriteMode ?? "stub";
  const agentInstance = `${cfg.tenantSlug}-${os.hostname()}`.slice(0, 100);

  // Falha cedo se mode=insert mas ordersInsert incompleto.
  try {
    assertOrdersWriteReady(cfg);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("✗ Config insuficiente para ordersWriteMode=insert:");
      console.error(err.message);
      appendErrorLog(
        { outboxId: null, phase: "preflight", retryable: false, error: "ordersInsert config incompleta", details: err.message },
        err
      );
      return 1;
    }
    throw err;
  }

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

  const counters = newCounters();

  // Startup self-check: abre pool e roda preflight (SELECT 1 +
  // sys.columns + write-log + productLookupColumn). Modo stub não
  // precisa de SQL — pula esta secção.
  let pool: SqlPool | null = null;
  if (mode === "insert") {
    try {
      pool = openPool(cfg);
      await pool.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ SQL Server connect falhou: ${msg}`);
      appendErrorLog(
        { outboxId: null, phase: "preflight", retryable: true, error: "SQL Server connect falhou", details: msg },
        err
      );
      return 1;
    }

    try {
      const pf = await preflightInsertMode(pool, cfg.ordersInsert!);
      console.log(`preflight OK — productLookupColumn=${pf.productLookupColumn} (${pf.productLookupType}), Encomenda ID identity=${pf.encomendaIdIsIdentity}`);
      console.log("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof WriteOrderError ? err.retryable : false;
      console.error(`✗ preflight falhou: ${msg}`);
      appendErrorLog(
        { outboxId: null, phase: "preflight", retryable, error: "preflight insert mode falhou", details: msg },
        err
      );
      try { await pool.close(); } catch { /* ignore */ }
      return 1;
    }
  }

  const saas = new SaasClient(cfg);

  let pending;
  try {
    pending = await saas.pullPendingOrders({
      limit: args.limit,
      agentInstance,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ pullPendingOrders falhou: ${msg}`);
    appendErrorLog(
      { outboxId: null, phase: "pull", retryable: true, error: "pullPendingOrders falhou", details: msg },
      err
    );
    if (pool) await pool.close();
    return 1;
  }

  counters.pulled = pending.count;
  console.log(`Recebidas ${pending.count} encomendas (lease até ${pending.leasedUntil}).`);

  if (pending.count === 0) {
    console.log("");
    console.log("Nada para exportar. OK.");
    if (pool) await pool.close();
    printSummary(counters, mode, args.dryRun, Date.now() - startedAt);
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
      // No contexto de export-orders, source=idempotent significa
      // especificamente recovered: SaaS released o lease porque ainda
      // não recebeu ACK, mas o write-log já tinha — agent crashou entre
      // commit SQL e ack HTTP. Re-tentativa só do ACK. Mostramos o
      // label operacional "recovered" no log para clareza.
      const displaySource = result.source === "idempotent" ? "recovered" : result.source;
      console.log(`  ✓ write: spharmDocumentId=${result.spharmDocumentId} source=${displaySource} (${fmtDuration(result.durationMs)})`);

      if (result.source === "created") counters.inserted++;
      else if (result.source === "idempotent") counters.recovered++;
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
          // vai reentregar. Idempotência via write-log garante que
          // não duplica no SPharm (mesmo outboxId).
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ ack falhou (write OK; lease vai expirar e reentregar): ${msg}`);
          appendErrorLog(
            {
              outboxId: order.outboxId,
              phase: "ack",
              retryable: true,
              error: "ack falhou após write OK",
              details: `source=${result.source} spharmDocumentId=${result.spharmDocumentId}: ${msg}`,
            },
            err
          );
          counters.failed++;
        }
      }
    } catch (err) {
      const retryable = err instanceof WriteOrderError ? err.retryable : false;
      const sqlError =
        err instanceof WriteOrderError && err.sqlError ? err.sqlError : undefined;
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ write falhou (retryable=${retryable}): ${errorMsg}`);

      appendErrorLog(
        {
          outboxId: order.outboxId,
          phase: "write",
          retryable,
          error: "writeOrderToSpharm falhou",
          details: sqlError
            ? `${errorMsg} | SQL code=${sqlError.code ?? "?"} number=${sqlError.number ?? "?"}`
            : errorMsg,
        },
        err
      );

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
          appendErrorLog(
            {
              outboxId: order.outboxId,
              phase: "nack",
              retryable: true,
              error: "nack falhou após write falha",
              details: m,
            },
            nackErr
          );
        }
      }
      counters.failed++;
    }
    console.log("");
  }

  if (pool) await pool.close();

  printSummary(counters, mode, args.dryRun, Date.now() - startedAt);
  return counters.failed === 0 ? 0 : 2;
}
