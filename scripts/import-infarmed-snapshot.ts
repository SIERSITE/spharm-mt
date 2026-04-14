/**
 * scripts/import-infarmed-snapshot.ts
 *
 * Importa um snapshot do catálogo INFARMED (Portugal) para a tabela local
 * InfarmedSnapshot. Suporta CSV e XLSX.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PORQUÊ UM SNAPSHOT LOCAL
 *
 * A INFARMED não publica uma API REST documentada e pública. O catálogo de
 * medicamentos é distribuído como ficheiros (XLSX/CSV) descarregáveis do
 * portal Open Data. Este importer lê esse ficheiro e popula uma tabela local
 * consultada pelo infarmedConnector no pipeline de enriquecimento.
 *
 * Vantagens do snapshot vs. chamadas HTTP:
 *   - Zero latência no pipeline
 *   - Reproduzível (mesmo snapshot → mesmo resultado)
 *   - Sem rate limits / sem falhas de rede
 *   - Estado regulamentar versionado (snapshotVersion)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FORMATO DO FICHEIRO DE ENTRADA
 *
 * XLSX SEM CABEÇALHO, 4 colunas por posição:
 *   col 0 → cnp                (InfarmedSnapshot.cnp)
 *   col 1 → estado             (InfarmedSnapshot.estadoAim)
 *   col 2 → designacao         (InfarmedSnapshot.designacaoOficial)
 *   col 3 → fabricante         (InfarmedSnapshot.titularAim)
 *
 * Restantes campos (dci, codigoATC, formaFarmaceutica, dosagem, embalagem,
 * grupoTerapeutico) ficam a null.
 *
 * Como fallback, se uma linha vier como célula única com conteúdo
 * delimitado por vírgulas, é parseada com um parser CSV que respeita
 * campos entre aspas (ex: "DESIGNAÇÃO, COM VÍRGULA").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Uso:
 *   npx tsx scripts/import-infarmed-snapshot.ts --version=2026-04 --dry-run
 *   npx tsx scripts/import-infarmed-snapshot.ts --version=2026-04
 *
 * Opções:
 *   --file=PATH      Caminho do ficheiro. Default: example_files/novo_fabricante.xlsx
 *   --version=TAG    Identificador do snapshot. Default: data actual YYYY-MM
 *   --dry-run        Não escreve, só valida o parse
 *   --limit=N        Limitar número de linhas a importar (debug)
 */

import "dotenv/config";
import path from "path";
import * as fs from "fs";
import * as XLSX from "xlsx";
import { legacyPrisma as prisma } from "../lib/prisma";

const DEFAULT_FILE = "example_files/novo_fabricante.xlsx";
const MIN_CNP = 2_000_000;

// ─── Args ─────────────────────────────────────────────────────────────────────

type Args = {
  file: string | null;
  version: string;
  dryRun: boolean;
  limit: number | null;
  batch: number;
};

const DEFAULT_BATCH = 100;

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const now = new Date();
  const defaultVersion = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const out: Args = {
    file: DEFAULT_FILE,
    version: defaultVersion,
    dryRun: false,
    limit: null,
    batch: DEFAULT_BATCH,
  };

  for (const arg of args) {
    if (arg.startsWith("--file=")) out.file = arg.split("=")[1];
    else if (arg.startsWith("--version=")) out.version = arg.split("=")[1];
    else if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    }
    else if (arg.startsWith("--batch=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.batch = n;
    }
    else if (arg === "--dry-run") out.dryRun = true;
    else console.warn(`[aviso] Argumento desconhecido: ${arg}`);
  }

  return out;
}

// ─── Normalização ─────────────────────────────────────────────────────────────

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normHeader(s: string): string {
  return stripAccents(String(s ?? "").toLowerCase().trim());
}

function cleanString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

function normalizeEstado(raw: string | null): string | null {
  if (!raw) return null;
  const s = stripAccents(raw.toLowerCase());
  if (s.includes("autoriz")) return "Autorizado";
  if (s.includes("suspens")) return "Suspenso";
  if (s.includes("revog"))   return "Revogado";
  if (s.includes("caduc"))   return "Caducado";
  return raw.trim();
}

// ─── CSV line parser (respeita aspas) ────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

type ParsedRow = {
  cnp: number;
  designacaoOficial: string;
  dci: string | null;
  codigoATC: string | null;
  titularAim: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  grupoTerapeutico: string | null;
  estadoAim: string | null;
};

function readRows(filePath: string): unknown[][] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") {
    const raw = fs.readFileSync(filePath, "utf-8");
    const wb = XLSX.read(raw, { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
  }
  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
  }
  throw new Error(`Formato não suportado: ${ext}. Use .csv ou .xlsx`);
}

function rowToFields(row: unknown[]): string[] {
  // Caso normal: xlsx já entrega células separadas.
  if (row.length >= 4) return row.map((c) => (c === null || c === undefined ? "" : String(c)));
  // Fallback: linha veio como célula única com CSV dentro.
  if (row.length === 1 && typeof row[0] === "string" && row[0].includes(",")) {
    return parseCsvLine(row[0]);
  }
  return row.map((c) => (c === null || c === undefined ? "" : String(c)));
}

type ParseStats = {
  rows: ParsedRow[];
  totalRead: number;
  filteredByCnp: number;
  filteredNotInProduto: number;
  withCnpAboveMin: number;
  skipped: number;
};

function parseFile(
  filePath: string,
  limit: number | null,
  produtoCnps: Set<number>,
): ParseStats {
  const rows = readRows(filePath);
  const stats: ParseStats = {
    rows: [],
    totalRead: 0,
    filteredByCnp: 0,
    filteredNotInProduto: 0,
    withCnpAboveMin: 0,
    skipped: 0,
  };
  if (rows.length === 0) return stats;

  for (let r = 0; r < rows.length; r++) {
    if (limit !== null && stats.rows.length >= limit) break;

    stats.totalRead++;
    const rawRow = rows[r] as unknown[];
    if (!rawRow || rawRow.length === 0) { stats.skipped++; continue; }

    const fields = rowToFields(rawRow);
    if (fields.length < 4) { stats.skipped++; continue; }

    const cnpRaw = fields[0];
    if (!cnpRaw) { stats.skipped++; continue; }
    const cnp = Math.round(Number(String(cnpRaw).replace(/[^\d.-]/g, "")));
    if (!Number.isFinite(cnp) || cnp <= 0) { stats.skipped++; continue; }

    if (cnp <= MIN_CNP) { stats.filteredByCnp++; continue; }
    stats.withCnpAboveMin++;

    if (!produtoCnps.has(cnp)) { stats.filteredNotInProduto++; continue; }

    const estado = normalizeEstado(cleanString(fields[1]));
    const designacao = cleanString(fields[2]);
    if (!designacao) { stats.skipped++; continue; }
    const fabricante = cleanString(fields[3]);

    stats.rows.push({
      cnp,
      designacaoOficial: designacao,
      dci: null,
      codigoATC: null,
      titularAim: fabricante,
      formaFarmaceutica: null,
      dosagem: null,
      embalagem: null,
      grupoTerapeutico: null,
      estadoAim: estado,
    });
  }

  return stats;
}

// ─── Upsert em lote ───────────────────────────────────────────────────────────

type ImportStats = {
  parsed: number;
  inserted: number;
  updated: number;
  skippedParse: number;
};

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return m > 0 ? `${m}m${String(rs).padStart(2, "0")}s` : `${s}s`;
}

// Timeout generoso da transacção para margem em Neon/Prisma (default 5000 ms é curto).
const TX_TIMEOUT_MS = 30_000;
const TX_MAX_WAIT_MS = 10_000;

async function upsertBatch(rows: ParsedRow[], version: string, batchSize: number): Promise<ImportStats> {
  const stats: ImportStats = { parsed: rows.length, inserted: 0, updated: 0, skippedParse: 0 };
  const total = rows.length;
  const totalBatches = Math.ceil(total / batchSize);
  const t0 = Date.now();

  console.log(`Batches   : ${totalBatches} × ${batchSize} registos (total ${total})`);
  console.log(`TX timeout: ${TX_TIMEOUT_MS}ms (maxWait ${TX_MAX_WAIT_MS}ms)`);
  console.log();

  for (let i = 0; i < total; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const tBatch = Date.now();

    // Saber quais já existem ANTES de escrever, para contabilizar insert vs update.
    const existing = new Set(
      (await prisma.infarmedSnapshot.findMany({
        where: { cnp: { in: batch.map((r) => r.cnp) } },
        select: { cnp: true },
      })).map((r) => r.cnp)
    );

    // Transacção por batch: tudo ou nada dentro do batch, sem bloquear o import inteiro.
    await prisma.$transaction(
      batch.map((r) =>
        prisma.infarmedSnapshot.upsert({
          where: { cnp: r.cnp },
          create: { ...r, snapshotVersion: version },
          update: {
            designacaoOficial: r.designacaoOficial,
            dci: r.dci,
            codigoATC: r.codigoATC,
            titularAim: r.titularAim,
            formaFarmaceutica: r.formaFarmaceutica,
            dosagem: r.dosagem,
            embalagem: r.embalagem,
            grupoTerapeutico: r.grupoTerapeutico,
            estadoAim: r.estadoAim,
            snapshotVersion: version,
            importedAt: new Date(),
          },
        })
      ),
      { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS }
    );

    let batchInserted = 0;
    let batchUpdated = 0;
    for (const r of batch) {
      if (existing.has(r.cnp)) batchUpdated++;
      else batchInserted++;
    }
    stats.inserted += batchInserted;
    stats.updated += batchUpdated;

    const processed = Math.min(i + batchSize, total);
    const elapsed = Date.now() - t0;
    const batchMs = Date.now() - tBatch;
    const rate = processed / (elapsed / 1000);
    const etaMs = rate > 0 ? ((total - processed) / rate) * 1000 : 0;
    const pct = ((processed / total) * 100).toFixed(1);

    console.log(
      `  [${String(batchNum).padStart(String(totalBatches).length)}/${totalBatches}] ` +
      `proc=${processed}/${total} (${pct}%)  ` +
      `ins=${stats.inserted}  upd=${stats.updated}  ` +
      `batch=${batchMs}ms  elapsed=${fmtDuration(elapsed)}  eta=${fmtDuration(etaMs)}`
    );
  }

  return stats;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.file) args.file = DEFAULT_FILE;

  if (!fs.existsSync(args.file)) {
    console.error(`Ficheiro não encontrado: ${args.file}`);
    process.exit(1);
  }

  const sep = "─".repeat(66);
  console.log(sep);
  console.log("SPharm.MT — Importer INFARMED snapshot");
  console.log(sep);
  console.log(`Ficheiro : ${args.file}`);
  console.log(`Versão   : ${args.version}`);
  if (args.dryRun) console.log("Modo     : DRY-RUN (sem escrita)");
  if (args.limit) console.log(`Limit    : ${args.limit}`);
  console.log(`Batch    : ${args.batch}`);
  console.log();

  // Passo 1: carregar da BD o Set de CNPs elegíveis (Produto com cnp > MIN_CNP).
  console.log(`A carregar CNPs de Produto com cnp > ${MIN_CNP}…`);
  const tLoad = Date.now();
  const produtoRows = await prisma.produto.findMany({
    where: { cnp: { gt: MIN_CNP } },
    select: { cnp: true },
  });
  const produtoCnpSet = new Set<number>(produtoRows.map((p) => p.cnp));
  console.log(`  ${produtoCnpSet.size} CNPs elegíveis em Produto (${fmtDuration(Date.now() - tLoad)})`);
  console.log();

  if (produtoCnpSet.size === 0) {
    console.error(`Nenhum Produto com cnp > ${MIN_CNP}. Nada a importar.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // Passo 2: parse do ficheiro externo, já filtrado contra o Set.
  const parseStats = parseFile(args.file, args.limit, produtoCnpSet);
  const rows = parseStats.rows;
  console.log(`Formato  : posicional sem cabeçalho [cnp, estado, designacao, fabricante]`);
  console.log(`Lidas    : ${parseStats.totalRead} linhas do ficheiro`);
  console.log(`Filtro   : ${parseStats.filteredByCnp} descartadas por cnp <= ${MIN_CNP}`);
  console.log(`         : ${parseStats.filteredNotInProduto} descartadas por não existirem em Produto`);
  console.log(`Parse    : ${rows.length} a importar, ${parseStats.skipped} saltadas (parse)`);
  console.log();

  const printResumo = (stats: ImportStats | null, elapsedMs: number | null) => {
    console.log();
    console.log(sep);
    console.log("RESUMO");
    console.log(sep);
    console.log(`  Lidas ficheiro         : ${parseStats.totalRead}`);
    console.log(`  Com cnp > ${MIN_CNP}   : ${parseStats.withCnpAboveMin}`);
    console.log(`  Elegíveis em Produto   : ${produtoCnpSet.size}`);
    console.log(`  Importadas/actualizadas: ${stats ? stats.inserted + stats.updated : rows.length}`);
    if (stats) {
      console.log(`    ├─ inseridas         : ${stats.inserted}`);
      console.log(`    └─ actualizadas      : ${stats.updated}`);
    }
    console.log(`  Ignoradas (sem Produto): ${parseStats.filteredNotInProduto}`);
    console.log(`  Saltadas no parse      : ${parseStats.skipped}`);
    if (elapsedMs !== null) console.log(`  Tempo total            : ${fmtDuration(elapsedMs)}`);
    console.log(`  Batch size             : ${args.batch}`);
    console.log(sep);
  };

  if (rows.length === 0) {
    console.warn("Nada para importar após intersecção com Produto.");
    printResumo(null, null);
    await prisma.$disconnect();
    return;
  }

  if (args.dryRun) {
    console.log("Amostra das 5 primeiras linhas a importar:");
    for (const r of rows.slice(0, 5)) {
      console.log(`  CNP:${r.cnp}  Estado=${r.estadoAim ?? "—"}`);
      console.log(`    "${r.designacaoOficial}"`);
      console.log(`    Fabricante=${r.titularAim ?? "—"}`);
    }
    printResumo(null, null);
    await prisma.$disconnect();
    return;
  }

  console.log("A importar…");
  const tStart = Date.now();
  const stats = await upsertBatch(rows, args.version, args.batch);
  const totalElapsed = Date.now() - tStart;

  printResumo(stats, totalElapsed);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
