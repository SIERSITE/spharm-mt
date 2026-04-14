/**
 * scripts/update-fabricantes-from-xlsx.ts
 *
 * Atualiza directamente Produto.fabricanteId a partir de um XLSX simples,
 * sem pipeline, sem connectors, sem resolver.
 *
 * Formato do ficheiro (sem cabeçalho, posicional):
 *   col 0 = cnp         (Int)
 *   col 1 = estado      (ignorado aqui)
 *   col 2 = designacao  (ignorado aqui)
 *   col 3 = fabricante  (nome bruto)
 *
 * Regras:
 *   - Só considerar linhas com cnp > 2_000_000
 *   - Só actualizar produtos que já existam em Produto (match por cnp)
 *   - getOrCreateFabricante() para obter/criar o Fabricante pelo nome
 *   - Update directo de Produto.fabricanteId
 *   - Idempotente: re-correr não faz nada se o fabricante já está correcto
 *
 * Uso:
 *   npx tsx scripts/update-fabricantes-from-xlsx.ts --dry-run
 *   npx tsx scripts/update-fabricantes-from-xlsx.ts --limit=500
 *   npx tsx scripts/update-fabricantes-from-xlsx.ts
 */

import "dotenv/config";
import * as fs from "fs";
import * as XLSX from "xlsx";
import { legacyPrisma as prisma } from "../lib/prisma";
import { getOrCreateFabricante } from "../lib/catalog-persistence";

const DEFAULT_FILE = "example_files/novo_fabricante.xlsx";
const MIN_CNP = 2_000_000;
const DEFAULT_BATCH = 100;

// ─── Args ─────────────────────────────────────────────────────────────────────

type Args = {
  file: string;
  dryRun: boolean;
  limit: number | null;
  batch: number;
};

function parseArgs(): Args {
  const out: Args = { file: DEFAULT_FILE, dryRun: false, limit: null, batch: DEFAULT_BATCH };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--file=")) out.file = arg.split("=")[1];
    else if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else if (arg.startsWith("--batch=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.batch = n;
    } else if (arg === "--dry-run") out.dryRun = true;
    else console.warn(`[aviso] Argumento desconhecido: ${arg}`);
  }
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function cleanString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

function normalizeFabricanteNome(raw: string): string {
  return stripAccents(raw).toUpperCase().replace(/\s+/g, " ").trim();
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return m > 0 ? `${m}m${String(rs).padStart(2, "0")}s` : `${s}s`;
}

// ─── CSV fallback (vírgulas entre aspas) ──────────────────────────────────────

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
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function rowToFields(row: unknown[]): string[] {
  if (row.length >= 4) return row.map((c) => (c === null || c === undefined ? "" : String(c)));
  if (row.length === 1 && typeof row[0] === "string" && row[0].includes(",")) {
    return parseCsvLine(row[0]);
  }
  return row.map((c) => (c === null || c === undefined ? "" : String(c)));
}

// ─── Parse ────────────────────────────────────────────────────────────────────

type ParsedRow = { cnp: number; fabricanteRaw: string };

type ParseStats = {
  rows: ParsedRow[];
  totalRead: number;
  filteredByCnp: number;
  filteredNotInProduto: number;
  withCnpAboveMin: number;
  missingFabricante: number;
};

function parseFile(filePath: string, limit: number | null, produtoCnps: Set<number>): ParseStats {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];

  const stats: ParseStats = {
    rows: [],
    totalRead: 0,
    filteredByCnp: 0,
    filteredNotInProduto: 0,
    withCnpAboveMin: 0,
    missingFabricante: 0,
  };

  for (const rawRow of rows) {
    if (limit !== null && stats.rows.length >= limit) break;
    stats.totalRead++;

    if (!rawRow || rawRow.length === 0) continue;
    const fields = rowToFields(rawRow);
    if (fields.length < 4) continue;

    const cnp = Math.round(Number(String(fields[0]).replace(/[^\d.-]/g, "")));
    if (!Number.isFinite(cnp) || cnp <= 0) continue;

    if (cnp <= MIN_CNP) { stats.filteredByCnp++; continue; }
    stats.withCnpAboveMin++;

    if (!produtoCnps.has(cnp)) { stats.filteredNotInProduto++; continue; }

    const fabricanteRaw = cleanString(fields[3]);
    if (!fabricanteRaw) { stats.missingFabricante++; continue; }

    stats.rows.push({ cnp, fabricanteRaw });
  }

  return stats;
}

// ─── Update ───────────────────────────────────────────────────────────────────

type UpdateStats = {
  processed: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

async function processBatches(
  rows: ParsedRow[],
  batchSize: number,
): Promise<UpdateStats> {
  const stats: UpdateStats = { processed: 0, updated: 0, unchanged: 0, skipped: 0 };
  const total = rows.length;
  const totalBatches = Math.ceil(total / batchSize);
  const t0 = Date.now();

  // Cache de Fabricante por nome normalizado → id, para não bater na BD a cada linha.
  const fabricanteIdCache = new Map<string, string>();

  console.log(`Batches   : ${totalBatches} × ${batchSize} (total ${total})`);
  console.log();

  for (let i = 0; i < total; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const tBatch = Date.now();

    // 1. Carregar o estado actual (fabricanteId) de todos os CNPs do batch.
    const existing = await prisma.produto.findMany({
      where: { cnp: { in: batch.map((r) => r.cnp) } },
      select: { cnp: true, fabricanteId: true },
    });
    const currentFabById = new Map(existing.map((p) => [p.cnp, p.fabricanteId]));

    for (const r of batch) {
      const nomeNorm = normalizeFabricanteNome(r.fabricanteRaw);
      if (!nomeNorm) { stats.skipped++; stats.processed++; continue; }

      let fabId = fabricanteIdCache.get(nomeNorm);
      if (!fabId) {
        fabId = await getOrCreateFabricante(nomeNorm, r.fabricanteRaw);
        fabricanteIdCache.set(nomeNorm, fabId);
      }

      const currentFabId = currentFabById.get(r.cnp);
      if (currentFabId === fabId) {
        stats.unchanged++;
      } else {
        await prisma.produto.update({
          where: { cnp: r.cnp },
          data: { fabricanteId: fabId },
        });
        stats.updated++;
      }
      stats.processed++;
    }

    const elapsed = Date.now() - t0;
    const batchMs = Date.now() - tBatch;
    const rate = stats.processed / (elapsed / 1000);
    const etaMs = rate > 0 ? ((total - stats.processed) / rate) * 1000 : 0;
    const pct = ((stats.processed / total) * 100).toFixed(1);

    console.log(
      `  [${String(batchNum).padStart(String(totalBatches).length)}/${totalBatches}] ` +
      `proc=${stats.processed}/${total} (${pct}%)  ` +
      `upd=${stats.updated}  unchanged=${stats.unchanged}  skip=${stats.skipped}  ` +
      `batch=${batchMs}ms  elapsed=${fmtDuration(elapsed)}  eta=${fmtDuration(etaMs)}`
    );
  }

  return stats;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (!fs.existsSync(args.file)) {
    console.error(`Ficheiro não encontrado: ${args.file}`);
    process.exit(1);
  }

  const sep = "─".repeat(66);
  console.log(sep);
  console.log("SPharm.MT — Update Fabricantes a partir de XLSX");
  console.log(sep);
  console.log(`Ficheiro : ${args.file}`);
  if (args.dryRun) console.log("Modo     : DRY-RUN (sem escrita)");
  if (args.limit) console.log(`Limit    : ${args.limit}`);
  console.log(`Batch    : ${args.batch}`);
  console.log();

  // 1. Carregar CNPs elegíveis em Produto.
  console.log(`A carregar CNPs de Produto com cnp > ${MIN_CNP}…`);
  const tLoad = Date.now();
  const produtoRows = await prisma.produto.findMany({
    where: { cnp: { gt: MIN_CNP } },
    select: { cnp: true },
  });
  const produtoCnpSet = new Set<number>(produtoRows.map((p) => p.cnp));
  console.log(`  ${produtoCnpSet.size} CNPs elegíveis (${fmtDuration(Date.now() - tLoad)})`);
  console.log();

  if (produtoCnpSet.size === 0) {
    console.error(`Nenhum Produto com cnp > ${MIN_CNP}.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // 2. Parse com filtros.
  const parseStats = parseFile(args.file, args.limit, produtoCnpSet);
  const rows = parseStats.rows;
  console.log(`Lidas         : ${parseStats.totalRead}`);
  console.log(`cnp <= ${MIN_CNP} : ${parseStats.filteredByCnp} descartadas`);
  console.log(`sem Produto   : ${parseStats.filteredNotInProduto} descartadas`);
  console.log(`sem fabricante: ${parseStats.missingFabricante} descartadas`);
  console.log(`a processar   : ${rows.length}`);
  console.log();

  const printResumo = (u: UpdateStats | null, elapsedMs: number | null) => {
    console.log();
    console.log(sep);
    console.log("RESUMO");
    console.log(sep);
    console.log(`  Lidas ficheiro         : ${parseStats.totalRead}`);
    console.log(`  Com cnp > ${MIN_CNP}   : ${parseStats.withCnpAboveMin}`);
    console.log(`  Elegíveis em Produto   : ${produtoCnpSet.size}`);
    console.log(`  A processar            : ${rows.length}`);
    if (u) {
      console.log(`  Actualizados           : ${u.updated}`);
      console.log(`  Inalterados            : ${u.unchanged}`);
      console.log(`  Saltados               : ${u.skipped}`);
    }
    console.log(`  Ignoradas (sem Produto): ${parseStats.filteredNotInProduto}`);
    console.log(`  Sem fabricante         : ${parseStats.missingFabricante}`);
    if (elapsedMs !== null) console.log(`  Tempo total            : ${fmtDuration(elapsedMs)}`);
    console.log(`  Batch size             : ${args.batch}`);
    console.log(sep);
  };

  if (rows.length === 0) {
    console.warn("Nada para processar.");
    printResumo(null, null);
    await prisma.$disconnect();
    return;
  }

  if (args.dryRun) {
    console.log("Amostra das 10 primeiras linhas:");
    for (const r of rows.slice(0, 10)) {
      console.log(`  CNP:${r.cnp}  fabricante="${r.fabricanteRaw}"  → norm="${normalizeFabricanteNome(r.fabricanteRaw)}"`);
    }
    printResumo(null, null);
    await prisma.$disconnect();
    return;
  }

  console.log("A actualizar…");
  const tStart = Date.now();
  const u = await processBatches(rows, args.batch);
  const totalElapsed = Date.now() - tStart;

  printResumo(u, totalElapsed);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
