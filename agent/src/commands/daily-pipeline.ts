/**
 * agent/src/commands/daily-pipeline.ts
 *
 * Orquestrador autónomo do ciclo operacional diário:
 *
 *    1. compute `--date` = ontem se não dado (UTC date)
 *    2. acquire lockfile (run/pipeline.lock) — abort se já corre
 *    3. correr daily-sync (lê ERP → POSTa staging)
 *    4. correr aggregate-month server-side (chama API SaaS)
 *    5. validar safety conditions
 *    6. POST /api/admin/pipeline/record com status final
 *    7. release lockfile
 *    8. imprimir RESUMO operacional + escrever logs estruturados
 *
 * Logs locais (em `logs/`):
 *    · pipeline-YYYY-MM-DD.log    — resumo orquestrador
 *    · daily-sync-YYYY-MM-DD.log  — stdout do passo daily-sync
 *    · aggregate-YYYY-MM.log      — resposta do aggregate-month
 *
 * Safety aborts (ver `lib/aggregate/vendamensal.ts` para os 3 server-side):
 *    · UNKNOWN > 0
 *    · operationalOrphans > 0
 *    · valorBruto total negativo
 *    · Plus client-side: lockfile presente, tenant não resolvível.
 *
 * Idempotente: re-correr o mesmo --date é seguro (daily-sync upserts via
 * unique constraints; aggregate delete-then-insert scoped).
 */

import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import { SaasClient, SaasApiError, type PipelineAggregateResponse } from "../http-client.js";
import { parseDateArg, tableExists, listColumns } from "./probe-helpers.js";
import { runPipelineForDay, type PipelineRunCounts } from "./daily-sync-runner.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);

/* ---------- CLI ---------- */

type Args = { date?: string; help?: boolean; force?: boolean; skipAggregate?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      date: { type: "string" },
      help: { type: "boolean", short: "h" },
      force: { type: "boolean" },
      "skip-aggregate": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    date: typeof raw.values.date === "string" ? raw.values.date : undefined,
    help: raw.values.help === true,
    force: raw.values.force === true,
    skipAggregate: raw.values["skip-aggregate"] === true,
  };
}

function printHelp(): void {
  console.log("Uso: daily-pipeline [--date YYYY-MM-DD] [--force] [--skip-aggregate]");
  console.log("");
  console.log("Orquestrador autónomo: daily-sync + aggregate-month.");
  console.log("");
  console.log("Flags:");
  console.log("  --date YYYY-MM-DD   (default: ontem em UTC)");
  console.log("  --force             ignora lockfile existente (CUIDADO)");
  console.log("  --skip-aggregate    só corre daily-sync, salta agregação server-side");
  console.log("");
  console.log("Logs em ./logs/ (relativos ao directorio do agent).");
  console.log("Mapping doc: docs/operational-reporting-v1.md");
}

/* ---------- Date helpers ---------- */

/** Devolve ontem em UTC (YYYY-MM-DD). */
function yesterdayUtc(): string {
  const now = new Date();
  // Today midnight UTC
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const y = new Date(todayUtc.getTime() - 24 * 60 * 60 * 1000);
  return y.toISOString().slice(0, 10);
}

function monthOf(dateIso: string): string {
  return dateIso.slice(0, 7); // YYYY-MM
}

/* ---------- Lockfile ---------- */

const STALE_LOCK_MS = 6 * 60 * 60 * 1000; // 6 horas — safety net

type LockFileContent = {
  pid: number;
  startedAt: string;
  kind: string;
  date: string;
};

function lockFilePath(): string {
  return path.join(process.cwd(), "run", "pipeline.lock");
}

/**
 * Windows-specific: confirma se o PID está vivo via `tasklist`. Devolve
 * `true` se vivo, `false` se morto, `null` se não conseguimos
 * determinar (ex: tasklist indisponível, permissões). Em null, cai-se
 * no path de timestamp-based stale detection.
 */
function isPidAlive(pid: number): boolean | null {
  if (process.platform !== "win32") return null;
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const r = spawnSync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
      { encoding: "utf8", timeout: 5_000 }
    );
    if (r.status !== 0 || !r.stdout) return null;
    // "INFO: No tasks are running..." quando PID não existe; CSV row
    // com o nome do processo quando vive.
    const out = r.stdout.trim();
    if (out.toLowerCase().includes("no tasks")) return false;
    // CSV: a primeira coluna é o image name. Se tem aspas, o PID existe.
    return out.startsWith('"');
  } catch {
    return null;
  }
}

async function acquireLock(force: boolean, kind: string, date: string): Promise<void> {
  const lock = lockFilePath();
  mkdirSync(path.dirname(lock), { recursive: true });

  if (existsSync(lock)) {
    try {
      const raw = await fs.readFile(lock, "utf8");
      const data = JSON.parse(raw) as LockFileContent;
      const ageMs = Date.now() - new Date(data.startedAt).getTime();
      if (!Number.isFinite(ageMs) || ageMs < 0) {
        throw new Error(`Lock corrupted (startedAt=${data.startedAt})`);
      }

      // Liveness check: se o PID já não existe, lock está stale ainda
      // que o timestamp seja recente. Evita esperar 6h após crash.
      const alive = isPidAlive(data.pid);
      if (alive === false) {
        console.warn(
          `⚠ Lockfile pid=${data.pid} já não está vivo (started=${data.startedAt}) — a reclamar.`
        );
      } else if (ageMs > STALE_LOCK_MS || force) {
        console.warn(
          `⚠ Lockfile stale (${(ageMs / 1000 / 60).toFixed(0)} min) ou --force — a reclamar.`
        );
      } else {
        // PID vivo (ou indeterminável) E timestamp recente E sem --force.
        throw new Error(
          `Pipeline já corre (pid=${data.pid}, started=${data.startedAt}, kind=${data.kind}). Usa --force ou aguarda.`
        );
      }
    } catch (err) {
      if (!force) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      console.warn("⚠ Lockfile ilegível — --force a sobrescrever.");
    }
  }

  const payload: LockFileContent = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    kind,
    date,
  };
  writeFileSync(lock, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8" });
}

async function releaseLock(): Promise<void> {
  const lock = lockFilePath();
  if (existsSync(lock)) {
    try {
      await fs.unlink(lock);
    } catch {
      // ignore
    }
  }
}

/* ---------- Logs ---------- */

function logsDir(): string {
  const dir = path.join(process.cwd(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

class TeeLogger {
  private readonly chunks: string[] = [];
  constructor(private readonly filePath: string) {}
  log(line: string): void {
    const ts = new Date().toISOString();
    const formatted = `[${ts}] ${line}`;
    this.chunks.push(formatted);
    console.log(line);
  }
  raw(line: string): void {
    // Sem timestamp — preserva formatação ASCII art.
    this.chunks.push(line);
    console.log(line);
  }
  async flush(): Promise<void> {
    await fs.writeFile(this.filePath, this.chunks.join("\n") + "\n", { encoding: "utf8" });
  }
}

/* ---------- Pipeline body ---------- */

async function resolveFarmaciaId(client: SaasClient, hint: string): Promise<string> {
  const r = await client.listFarmacias(15_000);
  const isCuid = /^c[a-z0-9]{20,}$/i.test(hint);
  const match = isCuid
    ? r.farmacias.find((f) => f.id === hint)
    : r.farmacias.find((f) => f.nome.toLowerCase() === hint.toLowerCase());
  if (!match) {
    throw new Error(
      `Farmácia "${hint}" não encontrada (${r.farmacias.length} disponíveis).`
    );
  }
  if (match.estado !== "ATIVO") {
    throw new Error(`Farmácia "${match.nome}" inactiva (${match.estado}).`);
  }
  return match.id;
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function fmtEur(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------- Entrypoint ---------- */

export async function dailyPipeline(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    printHelp();
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  const date = args.date ?? yesterdayUtc();
  let parsedDate: string;
  try {
    parsedDate = parseDateArg("--date", date) as string;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }
  const month = monthOf(parsedDate);

  // Tee log capture (escreve no fim)
  const pipelineLog = new TeeLogger(path.join(logsDir(), `pipeline-${parsedDate}.log`));
  const dailySyncLog = new TeeLogger(path.join(logsDir(), `daily-sync-${parsedDate}.log`));
  const aggregateLog = new TeeLogger(path.join(logsDir(), `aggregate-${month}.log`));

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both");
  } catch (err) {
    pipelineLog.log(`✗ Config inválida: ${err instanceof Error ? err.message : String(err)}`);
    await pipelineLog.flush();
    return 1;
  }
  if (!cfg.farmacia) {
    pipelineLog.log("✗ SPHARMMT_FARMACIA não está definido em agent.config.json.");
    await pipelineLog.flush();
    return 1;
  }

  const t0 = Date.now();
  const startedAt = new Date();
  const steps: Array<{ name: string; status: "OK" | "ERROR" | "SKIPPED"; durationMs: number; message?: string }> = [];
  let dailySyncCounts: PipelineRunCounts | null = null;
  let aggregateResp: PipelineAggregateResponse | null = null;

  pipelineLog.raw(DOUBLE_RULE);
  pipelineLog.raw(`daily-pipeline — autonomous run`);
  pipelineLog.raw(DOUBLE_RULE);
  pipelineLog.log(`SaaS endpoint     : ${cfg.saasEndpoint}`);
  pipelineLog.log(`Tenant slug       : ${cfg.tenantSlug}`);
  pipelineLog.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  pipelineLog.log(`Dia               : ${parsedDate}`);
  pipelineLog.log(`Mês para agregar  : ${month}`);
  pipelineLog.log(`Skip aggregate    : ${args.skipAggregate ? "sim" : "não"}`);
  pipelineLog.log("");

  let lockAcquired = false;
  let pipelineStatus: "OK" | "ERROR" | "ABORTED" = "OK";
  let errorMessage: string | undefined;
  let farmaciaId: string = "";

  try {
    // Lock acquire
    try {
      await acquireLock(args.force === true, "daily-pipeline", parsedDate);
      lockAcquired = true;
    } catch (err) {
      pipelineStatus = "ABORTED";
      errorMessage = err instanceof Error ? err.message : String(err);
      pipelineLog.log(`✗ ABORTED [lock]: ${errorMessage}`);
      return 1;
    }

    const client = new SaasClient(cfg);
    try {
      farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
    } catch (err) {
      pipelineStatus = "ERROR";
      errorMessage = err instanceof Error ? err.message : String(err);
      pipelineLog.log(`✗ ERROR [farmacia]: ${errorMessage}`);
      return 1;
    }
    pipelineLog.log(`Farmácia resolved : ${farmaciaId}`);
    pipelineLog.log("");

    // 1) daily-sync
    const tDailySync = Date.now();
    pipelineLog.raw(RULE);
    pipelineLog.log(`▶ Step 1/2: daily-sync ${parsedDate}`);
    pipelineLog.raw(RULE);
    try {
      dailySyncCounts = await withPool(cfg, async (pool) => {
        return runPipelineForDay({
          pool,
          client,
          farmaciaId,
          date: parsedDate,
          schemaProbes: { tableExists, listColumns },
          logger: dailySyncLog,
        });
      });
      const dur = Date.now() - tDailySync;
      steps.push({ name: "daily-sync", status: "OK", durationMs: dur });
      pipelineLog.log(`  daily-sync OK em ${fmtDuration(dur)}`);
      pipelineLog.log(`  products read=${dailySyncCounts.productsRead} upserted=${dailySyncCounts.productsUpserted} errors=${dailySyncCounts.productsErrors}`);
      pipelineLog.log(`  stock    read=${dailySyncCounts.stockRead} upserted=${dailySyncCounts.stockUpserted} errors=${dailySyncCounts.stockErrors}`);
      pipelineLog.log(`  sales    read=${dailySyncCounts.salesRead} upserted=${dailySyncCounts.salesUpserted} non_stock=${dailySyncCounts.salesNonStockServices} op_orphans=${dailySyncCounts.salesOperationalOrphans} errors=${dailySyncCounts.salesErrors}`);
      pipelineLog.log("");
    } catch (err) {
      const dur = Date.now() - tDailySync;
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ name: "daily-sync", status: "ERROR", durationMs: dur, message: msg });
      pipelineStatus = "ERROR";
      errorMessage = `daily-sync falhou: ${msg}`;
      pipelineLog.log(`✗ daily-sync ERROR: ${msg}`);
      return 1;
    }

    // 2) aggregate-month (skippable)
    if (args.skipAggregate) {
      steps.push({ name: "aggregate-month", status: "SKIPPED", durationMs: 0, message: "--skip-aggregate" });
      pipelineLog.log(`⏭ Step 2/2: aggregate-month SKIPPED (--skip-aggregate)`);
    } else {
      const tAgg = Date.now();
      pipelineLog.raw(RULE);
      pipelineLog.log(`▶ Step 2/2: aggregate-month ${month}`);
      pipelineLog.raw(RULE);
      try {
        aggregateResp = await client.pipelineAggregateMonth(
          { month, write: true },
          90_000
        );
        const dur = Date.now() - tAgg;
        steps.push({ name: "aggregate-month", status: "OK", durationMs: dur });
        aggregateLog.log(`aggregate-month ${month} response: ${JSON.stringify(aggregateResp, null, 2)}`);
        pipelineLog.log(`  aggregate-month OK em ${fmtDuration(dur)}`);
        pipelineLog.log(`  rows inserted: ${aggregateResp.rowsInserted}  deleted: ${aggregateResp.rowsDeleted}`);
        pipelineLog.log(`  unknowns: ${aggregateResp.preflight.unknowns}`);
        pipelineLog.log(`  non-stock services: ${aggregateResp.preflight.nonStockServices}`);
        pipelineLog.log(`  operational orphans: ${aggregateResp.preflight.operationalOrphans}`);
        pipelineLog.log(`  valorBruto Σ: ${fmtEur(aggregateResp.totals.valorBruto)} EUR`);
        pipelineLog.log("");
      } catch (err) {
        const dur = Date.now() - tAgg;
        let msg: string;
        if (err instanceof SaasApiError) {
          // 409 abort vs 500
          msg = `${err.method} ${err.path} → HTTP ${err.statusCode}: ${err.bodySnippet ?? ""}`;
          if (err.statusCode === 409) pipelineStatus = "ABORTED";
          else pipelineStatus = "ERROR";
        } else {
          msg = err instanceof Error ? err.message : String(err);
          pipelineStatus = "ERROR";
        }
        steps.push({ name: "aggregate-month", status: "ERROR", durationMs: dur, message: msg });
        errorMessage = `aggregate-month falhou: ${msg}`;
        pipelineLog.log(`✗ aggregate-month ${pipelineStatus}: ${msg}`);
        aggregateLog.log(`aggregate-month ${month} ${pipelineStatus}: ${msg}`);
        return 1;
      }
    }
  } catch (err) {
    pipelineStatus = "ERROR";
    errorMessage = err instanceof Error ? err.message : String(err);
    pipelineLog.log(`✗ ERROR inesperado: ${errorMessage}`);
    return 1;
  } finally {
    const wallMs = Date.now() - t0;
    const finishedAt = new Date();

    // Resumo final
    pipelineLog.raw("");
    pipelineLog.raw(DOUBLE_RULE);
    pipelineLog.log(`DAILY PIPELINE ${pipelineStatus}`);
    pipelineLog.log(`Date: ${parsedDate}`);
    pipelineLog.raw("");
    if (dailySyncCounts) {
      pipelineLog.log(`Products synced: ${dailySyncCounts.productsUpserted}`);
      pipelineLog.log(`Stock rows synced: ${dailySyncCounts.stockUpserted}`);
      pipelineLog.log(`Sales lines synced: ${dailySyncCounts.salesUpserted}`);
      pipelineLog.raw("");
    }
    if (aggregateResp) {
      pipelineLog.log(`VendaMensal:`);
      pipelineLog.log(`  rows inserted: ${aggregateResp.rowsInserted}`);
      pipelineLog.log(`  valorBruto: ${fmtEur(aggregateResp.totals.valorBruto)} EUR`);
      pipelineLog.log(`  devoluções: ${aggregateResp.preflight.byClass.DEVOLUCAO_ANULACAO ?? 0}`);
      pipelineLog.raw("");
      pipelineLog.log(`Unknown TipoDocs: ${aggregateResp.preflight.unknowns}`);
      pipelineLog.log(`Operational orphans: ${aggregateResp.preflight.operationalOrphans}`);
      pipelineLog.raw("");
    }
    if (errorMessage) {
      pipelineLog.log(`Error: ${errorMessage}`);
      pipelineLog.raw("");
    }
    pipelineLog.log(`Duration total: ${fmtDuration(wallMs)}`);
    pipelineLog.raw(DOUBLE_RULE);

    // Record run no SaaS (best effort — não falha o pipeline)
    if (farmaciaId) {
      try {
        const client = new SaasClient(cfg);
        const details = {
          dailyDate: parsedDate,
          aggregateMonth: month,
          steps,
          dailySync: dailySyncCounts ?? undefined,
          aggregate: aggregateResp
            ? {
                ano: parseInt(month.slice(0, 4), 10),
                mes: parseInt(month.slice(5, 7), 10),
                rawLines: aggregateResp.preflight.rawLines,
                produtosDistinct: aggregateResp.preflight.produtosDistinct,
                atendimentosDistinct: aggregateResp.preflight.atendimentosDistinct,
                byClass: aggregateResp.preflight.byClass,
                unknowns: aggregateResp.preflight.unknowns,
                nonStockServices: aggregateResp.preflight.nonStockServices,
                operationalOrphans: aggregateResp.preflight.operationalOrphans,
                rowsInserted: aggregateResp.rowsInserted,
                rowsDeleted: aggregateResp.rowsDeleted,
                valorBrutoSum: aggregateResp.totals.valorBruto,
                quantidadeLiquidaSum: aggregateResp.totals.quantidadeLiquida,
                linhasVendaSum: aggregateResp.totals.linhasVenda,
                atendimentosSum: aggregateResp.totals.atendimentos,
                aggregateRunId: aggregateResp.pipelineRunId,
              }
            : undefined,
        };
        // Idempotency key determinístico: retries da MESMA execução
        // (mesmo startedAt) produzem a mesma key → upsert server-side.
        // Mudança de qualquer componente (dia ou hora de arranque) gera
        // key nova, preservando audit log para runs independentes.
        const idempotencyKey = `daily-pipeline:${farmaciaId}:${parsedDate}:${startedAt.toISOString()}`;
        await client.pipelineRecord(
          {
            farmaciaId,
            kind: "daily-pipeline",
            status: pipelineStatus,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: wallMs,
            dateRef: parsedDate,
            errorMessage,
            details,
            triggeredBy: "agent",
            idempotencyKey,
          },
          15_000
        );
      } catch (err) {
        pipelineLog.log(
          `⚠ Falha a registar PipelineRun no SaaS: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Flush logs
    await Promise.allSettled([
      pipelineLog.flush(),
      dailySyncLog.flush(),
      aggregateLog.flush(),
    ]);
    if (lockAcquired) await releaseLock();
  }

  return pipelineStatus === "OK" ? 0 : 1;
}
