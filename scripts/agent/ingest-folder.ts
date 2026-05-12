/**
 * scripts/agent/ingest-folder.ts
 *
 * CLI agent simples: vê uma pasta de input do lado da farmácia,
 * detecta tipo de cada ficheiro Excel, faz upload para a API de
 * ingest e move o ficheiro para a sub-pasta correcta consoante a
 * resposta.
 *
 * Convenção de pastas (criadas se não existirem):
 *
 *   <input>/                         ← novos ficheiros aparecem aqui
 *   <input>/processed/               ← upload bem-sucedido
 *   <input>/processed/duplicates/    ← skipped_duplicate
 *   <input>/failed/                  ← upload falhou (rejeitado pelo
 *                                        servidor ou erro técnico)
 *   <input>/quarantine/              ← tipo desconhecido / extensão
 *                                        inválida / ficheiro corrupto
 *   ingest-agent.log                 ← JSONL append-only (na raíz da
 *                                        pasta-mãe)
 *
 * Detecção de tipo:
 *   1. Filename match (case-insensitive):
 *      · /stock/ ou /stock_atual/    → STOCK
 *      · /mapaevolucao|vendas|sales/ → VENDAS_MENSAIS
 *   2. Header check (se ambíguo): primeira linha do Excel contém
 *      colunas "Stock Atual"/"Quantidade" → STOCK
 *      ou colunas "Jan YYYY"/"Fev YYYY" → VENDAS_MENSAIS
 *   3. Caso contrário → quarantine
 *
 * Safety:
 *   · Só ficheiros .xlsx (outras extensões → quarantine)
 *   · Skip ficheiros com mtime < 2s (provavelmente ainda a copiar)
 *   · `--dry-run` parseia + classifica + mostra plano sem fazer
 *     uploads nem mover ficheiros
 *   · `--once` corre uma vez e sai
 *   · `--watch` poll de 5s indefinido (Ctrl+C para parar)
 *
 * Sem serviço Windows, sem daemon, sem stdin interactivo, sem
 * notificações. O operador corre e olha; ou põe num scheduled task
 * do Windows (`schtasks /create ...`) chamando `--once`.
 *
 * Uso:
 *   npx tsx scripts/agent/ingest-folder.ts \
 *     --tenant=farmacias-braga \
 *     --farmacia=ckxxxxxxxxxx \
 *     --input=C:/spharm-inbox \
 *     --endpoint=https://app.spharm.mt \
 *     --key=<ingest-key> \
 *     --once
 *
 * Hoje `--farmacia` exige o cuid da farmácia dentro do tenant. Para
 * obter o cuid: usar `npm run tenancy:health -- --slug=<tenant>` ou
 * via /admin painel. Quando existir `/api/ingest/v1/farmacias`
 * endpoint listing, o agent passará a aceitar `--farmacia=<nome>`.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, rename, readdir, stat, readFile, appendFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type DetectedType = "STOCK" | "VENDAS_MENSAIS" | "unknown";

type Args = {
  tenant: string;
  farmacia: string;
  input: string;
  endpoint: string;
  key: string;
  once: boolean;
  watch: boolean;
  dryRun: boolean;
  watchIntervalMs: number;
};

type LogEntry = {
  ts: string;
  file: string;
  hash?: string;
  type?: DetectedType;
  status: "processed" | "duplicate" | "failed" | "quarantined" | "skipped_unstable" | "dry-run";
  recordsRead?: number;
  recordsInserted?: number;
  recordsFailed?: number;
  durationMs?: number;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
};

type Summary = {
  processed: number;
  duplicates: number;
  failed: number;
  quarantined: number;
  skippedUnstable: number;
};

const STABLE_MTIME_MS = 2000;
const POLL_INTERVAL_DEFAULT_MS = 5000;

// ─── CLI args ──────────────────────────────────────────────────────────

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      farmacia: { type: "string" },
      input: { type: "string" },
      endpoint: { type: "string" },
      key: { type: "string" },
      once: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "watch-interval": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const missing: string[] = [];
  for (const k of ["tenant", "farmacia", "input", "endpoint", "key"] as const) {
    if (!values[k]) missing.push(k);
  }
  if (missing.length > 0) {
    console.error(
      `Argumentos em falta: ${missing.join(", ")}\n\n` +
        `Uso: npx tsx scripts/agent/ingest-folder.ts \\\n` +
        `       --tenant=<slug> --farmacia=<cuid> \\\n` +
        `       --input=<folder> --endpoint=<baseUrl> --key=<ingest-key> \\\n` +
        `       (--once | --watch) [--dry-run]\n`,
    );
    process.exit(1);
  }
  if (!values.once && !values.watch) {
    console.error(`Tens de passar --once ou --watch.`);
    process.exit(1);
  }
  return {
    tenant: values.tenant!,
    farmacia: values.farmacia!,
    input: values.input!,
    endpoint: values.endpoint!.replace(/\/+$/, ""),
    key: values.key!,
    once: !!values.once,
    watch: !!values.watch,
    dryRun: !!values["dry-run"],
    watchIntervalMs: values["watch-interval"]
      ? Math.max(1000, parseInt(values["watch-interval"], 10) || POLL_INTERVAL_DEFAULT_MS)
      : POLL_INTERVAL_DEFAULT_MS,
  };
}

// ─── Folder setup ──────────────────────────────────────────────────────

type Folders = {
  input: string;
  processed: string;
  duplicates: string;
  failed: string;
  quarantine: string;
  logFile: string;
};

async function ensureFolders(inputDir: string): Promise<Folders> {
  const folders: Folders = {
    input: inputDir,
    processed: join(inputDir, "processed"),
    duplicates: join(inputDir, "processed", "duplicates"),
    failed: join(inputDir, "failed"),
    quarantine: join(inputDir, "quarantine"),
    logFile: join(inputDir, "ingest-agent.log"),
  };
  for (const dir of [folders.processed, folders.duplicates, folders.failed, folders.quarantine]) {
    await mkdir(dir, { recursive: true });
  }
  return folders;
}

// ─── Type detection ────────────────────────────────────────────────────

function detectTypeFromName(filename: string): DetectedType | null {
  const lower = filename.toLowerCase();
  // Stock vence se a substring "stock" aparece — cobre stock_Atual,
  // stock_castelo, *_stock_*. Substring simples porque "_" é word-char
  // em JS regex e arruina \bstock\b.
  if (lower.includes("stock")) return "STOCK";
  // Vendas mensais: MapaEvolucaoVendas*, *vendas-mensais*, *sales-monthly*
  if (/mapaevolucao|vendas|sales/.test(lower)) return "VENDAS_MENSAIS";
  return null;
}

/**
 * Detecção de fallback via headers do Excel. Não importa o xlsx aqui
 * para evitar custo de parse — só lê a primeira linha como JSON via
 * `xlsx` quando o filename não decide.
 */
async function detectTypeFromHeader(filePath: string): Promise<DetectedType | null> {
  try {
    // Dynamic import — xlsx é pesado, só carregamos quando preciso.
    const XLSX = await import("xlsx");
    const wb = XLSX.readFile(filePath, { sheetRows: 2 });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return null;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
    if (rows.length === 0) return null;
    const header = (rows[0] as unknown[]).map((c) => String(c ?? "").toLowerCase().trim());
    // Sales mensais: tem colunas como "jan 2025", "fev 2025"
    const hasMonthCol = header.some((h) => /^(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s+\d{4}$/i.test(h));
    if (hasMonthCol) return "VENDAS_MENSAIS";
    // Stock: tem "stock" + "puc"/"quantidade" no header
    const hasStock = header.some((h) => h === "stock atual" || h.includes("stock"));
    const hasQty = header.some((h) => h.includes("quantidade") || h === "puc");
    if (hasStock || hasQty) return "STOCK";
    return null;
  } catch {
    return null;
  }
}

async function detectType(filePath: string): Promise<DetectedType> {
  const ext = extname(filePath).toLowerCase();
  if (ext !== ".xlsx") return "unknown";
  const byName = detectTypeFromName(basename(filePath));
  if (byName) return byName;
  const byHeader = await detectTypeFromHeader(filePath);
  if (byHeader) return byHeader;
  return "unknown";
}

// ─── Hash + stability ─────────────────────────────────────────────────

function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function isStable(filePath: string): Promise<boolean> {
  const st = await stat(filePath);
  if (st.size === 0) return false;
  return Date.now() - st.mtime.getTime() >= STABLE_MTIME_MS;
}

// ─── Upload ───────────────────────────────────────────────────────────

type UploadResponse = {
  ok: boolean;
  status?: string;
  loteIngestaoId?: string;
  hashConteudo?: string;
  records?: { read: number; inserted: number; failed: number };
  durationMs?: number;
  message?: string;
  error?: string;
};

async function uploadFile(args: Args, filePath: string, type: "STOCK" | "VENDAS_MENSAIS", buffer: Buffer): Promise<{
  httpStatus: number;
  body: UploadResponse;
}> {
  const path =
    type === "STOCK"
      ? "/api/ingest/v1/snapshot/stock"
      : "/api/ingest/v1/snapshot/sales-monthly";
  const url = `${args.endpoint}${path}`;

  const form = new FormData();
  form.append("farmaciaId", args.farmacia);
  // Node 24 native Blob — File-like
  const blob = new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  form.append("file", blob, basename(filePath));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.key}`,
      "X-Tenant-Slug": args.tenant,
    },
    body: form,
  });
  // Read text first (body stream só pode ser consumido uma vez).
  // Tenta JSON parse; em falha, devolve o snippet textual para
  // ajudar a diagnosticar respostas HTML (ex: Next.js 500 page).
  const raw = await res.text().catch(() => "");
  let body: UploadResponse;
  try {
    body = JSON.parse(raw) as UploadResponse;
  } catch {
    const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 200);
    body = {
      ok: false,
      error: "non_json_response",
      message: `HTTP ${res.status} · ${snippet || "(empty body)"}`,
    };
  }
  return { httpStatus: res.status, body };
}

// ─── File move helpers ────────────────────────────────────────────────

async function moveFile(src: string, destDir: string): Promise<string> {
  const dest = join(destDir, `${Date.now()}_${basename(src)}`);
  await rename(src, dest);
  return dest;
}

// ─── Logging ─────────────────────────────────────────────────────────

async function logEvent(folders: Folders, entry: LogEntry): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  await appendFile(folders.logFile, line, "utf8").catch(() => {});
  // Também imprime no stdout (formato curto para humano)
  const human = formatHumanLog(entry);
  console.log(human);
}

function formatHumanLog(e: LogEntry): string {
  const ts = e.ts.slice(11, 19);
  const status = e.status.padEnd(18);
  const recs =
    e.recordsRead !== undefined
      ? `read=${e.recordsRead} ins=${e.recordsInserted ?? "?"} fail=${e.recordsFailed ?? "?"}`
      : "";
  const typeStr = e.type ? `[${e.type.padEnd(15)}]` : `[?              ]`;
  const dur = e.durationMs !== undefined ? `${e.durationMs}ms` : "";
  const err = e.errorMessage ? ` · ${e.errorMessage.slice(0, 80)}` : "";
  return `  ${ts}  ${status}  ${typeStr}  ${basename(e.file).padEnd(40)}  ${recs}  ${dur}${err}`;
}

// ─── Process one file ─────────────────────────────────────────────────

async function processFile(args: Args, folders: Folders, filePath: string, summary: Summary): Promise<void> {
  const startedAt = Date.now();
  const ts = new Date().toISOString();
  const fname = basename(filePath);

  // ── 1. Estabilidade ──────────────────────────────────────────────
  if (!(await isStable(filePath))) {
    await logEvent(folders, { ts, file: filePath, status: "skipped_unstable" });
    summary.skippedUnstable++;
    return;
  }

  // ── 2. Tipo ──────────────────────────────────────────────────────
  const type = await detectType(filePath);
  if (type === "unknown") {
    await logEvent(folders, { ts, file: filePath, type, status: "quarantined", errorMessage: "tipo desconhecido (filename + header não bateram)" });
    if (!args.dryRun) await moveFile(filePath, folders.quarantine);
    summary.quarantined++;
    return;
  }

  // ── 3. Hash ──────────────────────────────────────────────────────
  const buffer = await readFile(filePath);
  const hash = hashBuffer(buffer);

  // ── 4. Dry-run ───────────────────────────────────────────────────
  if (args.dryRun) {
    await logEvent(folders, { ts, file: filePath, hash, type, status: "dry-run" });
    return;
  }

  // ── 5. Upload ────────────────────────────────────────────────────
  let res;
  try {
    res = await uploadFile(args, filePath, type, buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent(folders, {
      ts, file: filePath, hash, type,
      status: "failed",
      errorCode: "network",
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    });
    await moveFile(filePath, folders.failed);
    summary.failed++;
    return;
  }

  // ── 6. Decisão por response ──────────────────────────────────────
  const { httpStatus, body } = res;
  const durationMs = Date.now() - startedAt;

  if (httpStatus === 200 && body.status === "processed") {
    await logEvent(folders, {
      ts, file: filePath, hash, type,
      status: "processed",
      recordsRead: body.records?.read,
      recordsInserted: body.records?.inserted,
      recordsFailed: body.records?.failed,
      durationMs,
    });
    await moveFile(filePath, folders.processed);
    summary.processed++;
    return;
  }

  if (httpStatus === 200 && body.status === "skipped_duplicate") {
    await logEvent(folders, {
      ts, file: filePath, hash, type,
      status: "duplicate",
      durationMs,
      errorMessage: body.message,
    });
    await moveFile(filePath, folders.duplicates);
    summary.duplicates++;
    return;
  }

  // ── 7. Falha (4xx/5xx) ───────────────────────────────────────────
  await logEvent(folders, {
    ts, file: filePath, hash, type,
    status: "failed",
    httpStatus,
    errorCode: body.error ?? `http_${httpStatus}`,
    errorMessage: body.message ?? `HTTP ${httpStatus}`,
    durationMs,
  });
  await moveFile(filePath, folders.failed);
  summary.failed++;
}

// ─── Main loop ────────────────────────────────────────────────────────

async function processFolderOnce(args: Args, folders: Folders): Promise<Summary> {
  const summary: Summary = { processed: 0, duplicates: 0, failed: 0, quarantined: 0, skippedUnstable: 0 };
  const entries = await readdir(folders.input, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => join(folders.input, e.name))
    // Saltar o ficheiro de log
    .filter((p) => basename(p) !== "ingest-agent.log");

  if (files.length === 0) return summary;

  for (const f of files) {
    try {
      await processFile(args, folders, f, summary);
    } catch (err) {
      // Erro inesperado a processar ficheiro — não para o loop
      console.error(`[fatal] ${f}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return summary;
}

function mergeSummary(a: Summary, b: Summary): Summary {
  return {
    processed: a.processed + b.processed,
    duplicates: a.duplicates + b.duplicates,
    failed: a.failed + b.failed,
    quarantined: a.quarantined + b.quarantined,
    skippedUnstable: a.skippedUnstable + b.skippedUnstable,
  };
}

function printSummary(s: Summary, args: Args): void {
  console.log("\n" + "─".repeat(78));
  console.log(`Resumo${args.dryRun ? " (DRY-RUN)" : ""}:`);
  console.log(`  processed:    ${s.processed}`);
  console.log(`  duplicates:   ${s.duplicates}`);
  console.log(`  failed:       ${s.failed}`);
  console.log(`  quarantined:  ${s.quarantined}`);
  console.log(`  skipped (mid-write): ${s.skippedUnstable}`);
}

async function main(): Promise<number> {
  const args = parseCliArgs();
  console.log("─".repeat(78));
  console.log(`ingest-folder agent ${args.dryRun ? "(DRY-RUN) " : ""}— tenant=${args.tenant}`);
  console.log("─".repeat(78));
  console.log(`  endpoint:        ${args.endpoint}`);
  console.log(`  farmacia:        ${args.farmacia}`);
  console.log(`  input:           ${args.input}`);
  console.log(`  mode:            ${args.watch ? `watch (poll ${args.watchIntervalMs}ms)` : "once"}`);

  const folders = await ensureFolders(args.input);

  if (args.once) {
    const s = await processFolderOnce(args, folders);
    printSummary(s, args);
    return s.failed > 0 ? 1 : 0;
  }

  // ── Watch mode ───────────────────────────────────────────────────
  const totals: Summary = { processed: 0, duplicates: 0, failed: 0, quarantined: 0, skippedUnstable: 0 };
  console.log("\n[watch] polling — Ctrl+C para parar.\n");
  let interrupted = false;
  process.on("SIGINT", () => { interrupted = true; });
  process.on("SIGTERM", () => { interrupted = true; });

  while (!interrupted) {
    const s = await processFolderOnce(args, folders);
    const touched = s.processed + s.duplicates + s.failed + s.quarantined;
    if (touched > 0) {
      console.log(`[tick] processed=${s.processed} duplicates=${s.duplicates} failed=${s.failed} quarantined=${s.quarantined}`);
    }
    Object.assign(totals, mergeSummary(totals, s));
    if (interrupted) break;
    await sleep(args.watchIntervalMs);
  }
  printSummary(totals, args);
  return 0;
}

main()
  .then((code) => { process.exit(code); })
  .catch((err) => {
    console.error("[fatal]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
