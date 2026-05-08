/**
 * scripts/import-regulatory-record.ts
 *
 * Importador genérico para a tabela `RegulatoryRecord`. Lê XLSX/CSV de
 * qualquer fonte regulatória (CEDIME-ANF, INFARMED Open Data — listas
 * comparticipados/genéricos, etc.) e faz upsert por CNP.
 *
 * Política de merge:
 *   · Preservar não-null por defeito — uma corrida que traga `dci=null`
 *     não apaga um `dci` populado por uma corrida anterior. `--force`
 *     sobrescreve mesmo campos não-null (uso consciente).
 *   · `cnp > 2.000.000` filtrado (códigos internos ERP).
 *   · A coluna `source` é actualizada em cada upsert para a tag passada
 *     em `--source`. Identifica a fonte/import mais recente que tocou
 *     no registo.
 *
 * Auto-detect (best-effort, intencionalmente simples):
 *   · Formato — extensão (.csv, .xlsx, .xls)
 *   · CSV delimiter — `;` `,` ou TAB pela primeira linha
 *   · Header presence — primeira célula não-numérica
 *   · Encoding — tenta UTF-8; se vir caracteres de substituição, usa latin1
 *   · Field mapping — nomes comuns de coluna por field (fuzzy lowercase
 *     + sem acentos)
 *
 * Override manual:
 *   --map=cnp:0,estadoAim:1,designacaoOficial:2,titularAim:3
 *   (nomes de campo conforme schema RegulatoryRecord; índices base-0)
 *
 * Uso:
 *   # Sanity check (dry-run, ficheiro existente)
 *   npx tsx scripts/import-regulatory-record.ts \
 *     --file=example_files/fabricante.csv \
 *     --source=cedime_anf_2026-05 \
 *     --dry-run
 *
 *   # Live import com 4-col positional (header ausente, default mapping)
 *   npx tsx scripts/import-regulatory-record.ts \
 *     --file=example_files/fabricante.csv \
 *     --source=cedime_anf_2026-05
 *
 *   # INFARMED Open Data com header (auto-detect)
 *   npx tsx scripts/import-regulatory-record.ts \
 *     --file=infarmed_comparticipados.xlsx \
 *     --source=infarmed_comparticipados_2026-04
 *
 *   # Override manual quando auto-detect falha
 *   npx tsx scripts/import-regulatory-record.ts \
 *     --file=path.xlsx --source=tag \
 *     --map=cnp:0,codigoATC:5,dci:6,formaFarmaceutica:7
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import { legacyPrisma as prisma } from "../lib/prisma";

const MIN_CNP = 2_000_000;

// Campos canónicos do schema RegulatoryRecord — ordem usada nos logs.
const FIELDS = [
  "cnp",
  "designacaoOficial",
  "dci",
  "codigoATC",
  "formaFarmaceutica",
  "dosagem",
  "embalagem",
  "grupoTerapeutico",
  "titularAim",
  "estadoAim",
] as const;
type FieldName = (typeof FIELDS)[number];

// ─── CLI args ─────────────────────────────────────────────────────────────────

type Args = {
  file: string;
  source: string;
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
  force: boolean;
  manualMap: Partial<Record<FieldName, number>> | null;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Partial<Args> = {
    dryRun: false,
    limit: null,
    batchSize: 500,
    force: false,
    manualMap: null,
  };
  for (const a of argv) {
    if (a.startsWith("--file=")) out.file = a.slice("--file=".length);
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else if (a.startsWith("--batch-size=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0 && n <= 1000) out.batchSize = n;
    } else if (a.startsWith("--map=")) {
      const map: Partial<Record<FieldName, number>> = {};
      for (const part of a.slice("--map=".length).split(",")) {
        const [field, col] = part.split(":");
        const colNum = parseInt(col, 10);
        if ((FIELDS as readonly string[]).includes(field) && !isNaN(colNum)) {
          map[field as FieldName] = colNum;
        } else {
          console.warn(`[aviso] map inválido: ${part}`);
        }
      }
      out.manualMap = map;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  if (!out.file) throw new Error("--file=<path> é obrigatório");
  if (!out.source) throw new Error("--source=<tag> é obrigatório");
  return out as Args;
}

// ─── File reading ─────────────────────────────────────────────────────────────

/**
 * Lê o ficheiro como Buffer e devolve uma matriz de strings (linhas × colunas).
 * Trata UTF-8 com fallback para latin1 quando detecta caracteres de
 * substituição (encoding partido — sintoma típico do CEDIME/ANF dump).
 */
function readRowsCsv(filePath: string): string[][] {
  const buffer = fs.readFileSync(filePath);
  // Detecta BOM UTF-8
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let text = buffer.toString(hasBom ? "utf-8" : "utf-8");
  // Se vir muitos U+FFFD na primeira porção, refaz como latin1
  const sample = text.slice(0, 1024);
  const replacementCount = (sample.match(/�/g) ?? []).length;
  if (replacementCount > 0) {
    console.log(`  [encoding] detectado ${replacementCount} char(s) substituição em UTF-8 → fallback latin1`);
    text = buffer.toString("latin1");
  }
  // Detecta delimitador na primeira linha
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = firstLine.includes(";") ? ";" : firstLine.includes("\t") ? "\t" : ",";
  console.log(`  [csv] delimitador: ${JSON.stringify(delim)}`);
  // Parse linha a linha respeitando aspas
  const lines = text.split(/\r?\n/);
  const rows: string[][] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    rows.push(parseCsvLine(line, delim));
  }
  return rows;
}

function parseCsvLine(line: string, delim: string): string[] {
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
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function readRowsXlsx(filePath: string): string[][] {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
  return rows.map((r) =>
    Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? "" : String(c).trim())) : []
  );
}

function readRows(filePath: string): string[][] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return readRowsCsv(filePath);
  if (ext === ".xlsx" || ext === ".xls") return readRowsXlsx(filePath);
  throw new Error(`Formato não suportado: ${ext}. Use .csv, .xlsx ou .xls.`);
}

// ─── Header / mapping detection ───────────────────────────────────────────────

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normHeader(s: string): string {
  return stripAccents(String(s ?? "").toLowerCase().trim()).replace(/\s+/g, " ");
}

/**
 * Aliases de coluna por field — lista conservadora, expandida quando
 * surgirem mais formatos. Match é por igualdade case-insensitive +
 * acentos removidos. Velocidade > perfeição.
 */
const FIELD_ALIASES: Record<FieldName, string[]> = {
  cnp: ["cnp", "cn", "codigo nacional", "code"],
  designacaoOficial: ["designacao", "designacao oficial", "nome", "produto", "name"],
  dci: ["dci", "substancia activa", "substancia ativa", "principio ativo", "inn"],
  codigoATC: ["codigoatc", "codigo atc", "atc"],
  formaFarmaceutica: ["forma farmaceutica", "forma", "ff"],
  dosagem: ["dosagem", "dose"],
  embalagem: ["embalagem", "apresentacao", "packaging"],
  grupoTerapeutico: ["grupo terapeutico", "gt"],
  titularAim: ["titular aim", "titular", "fabricante", "manufacturer"],
  estadoAim: ["estado aim", "estado", "status"],
};

/**
 * `firstRow` é candidato a header se a primeira célula NÃO parece um CNP
 * inteiro. Com isto, ficheiros como o CEDIME-ANF (linha 1 = "9999904;...")
 * são correctamente detectados como sem-header.
 */
function looksLikeHeader(firstRow: string[]): boolean {
  if (firstRow.length === 0) return false;
  const first = firstRow[0];
  if (!first) return false;
  // Se a primeira célula é um inteiro plausível (>1000), é cnp → sem header.
  const asNum = Number(String(first).replace(/[^\d-]/g, ""));
  if (Number.isFinite(asNum) && asNum > 1000) return false;
  return true;
}

/**
 * Devolve um mapping field→colIndex usando o header do ficheiro. Os
 * fields não encontrados ficam ausentes do mapping.
 */
function mappingFromHeader(headerRow: string[]): Partial<Record<FieldName, number>> {
  const map: Partial<Record<FieldName, number>> = {};
  for (let i = 0; i < headerRow.length; i++) {
    const norm = normHeader(headerRow[i]);
    for (const field of FIELDS) {
      if (map[field] !== undefined) continue;
      const aliases = FIELD_ALIASES[field];
      if (aliases.some((a) => a === norm)) {
        map[field] = i;
        break;
      }
    }
  }
  return map;
}

/** Mapping default para o formato CEDIME/ANF de 4 colunas (sem header). */
const DEFAULT_4COL_MAPPING: Partial<Record<FieldName, number>> = {
  cnp: 0,
  estadoAim: 1,
  designacaoOficial: 2,
  titularAim: 3,
};

// ─── Parse ────────────────────────────────────────────────────────────────────

type ParsedRow = Partial<Record<Exclude<FieldName, "cnp">, string | null>> & { cnp: number };

function cleanCellString(raw: string | undefined | null): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

function parseCnp(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[^\d]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0 || n > 9_999_999) return null;
  return Math.round(n);
}

type ParseStats = {
  totalRead: number;
  parsed: ParsedRow[];
  skippedNoCnp: number;
  skippedBelowMin: number;
  skippedNoFields: number;
};

function parseRows(
  rows: string[][],
  mapping: Partial<Record<FieldName, number>>,
  hasHeader: boolean,
  limit: number | null,
): ParseStats {
  const stats: ParseStats = {
    totalRead: 0,
    parsed: [],
    skippedNoCnp: 0,
    skippedBelowMin: 0,
    skippedNoFields: 0,
  };
  const startIdx = hasHeader ? 1 : 0;

  for (let i = startIdx; i < rows.length; i++) {
    if (limit !== null && stats.parsed.length >= limit) break;
    const row = rows[i];
    if (!row || row.length === 0) continue;
    stats.totalRead++;

    const cnpCol = mapping.cnp;
    if (cnpCol === undefined) {
      stats.skippedNoCnp++;
      continue;
    }
    const cnp = parseCnp(row[cnpCol]);
    if (cnp === null) {
      stats.skippedNoCnp++;
      continue;
    }
    if (cnp <= MIN_CNP) {
      stats.skippedBelowMin++;
      continue;
    }

    const parsed: ParsedRow = { cnp };
    let nonNullFields = 0;
    for (const field of FIELDS) {
      if (field === "cnp") continue;
      const col = mapping[field];
      if (col === undefined) continue;
      const val = cleanCellString(row[col]);
      parsed[field] = val;
      if (val !== null) nonNullFields++;
    }

    // Linha sem qualquer campo útil (só cnp) — saltar
    if (nonNullFields === 0) {
      stats.skippedNoFields++;
      continue;
    }

    stats.parsed.push(parsed);
  }
  return stats;
}

// ─── Estado regulatório — normalização ────────────────────────────────────────

function normalizeEstado(raw: string | null): string | null {
  if (!raw) return null;
  const s = stripAccents(raw.toLowerCase());
  if (s.includes("autoriz")) return "Autorizado";
  if (s.includes("suspens")) return "Suspenso";
  if (s.includes("revog")) return "Revogado";
  if (s.includes("caduc")) return "Caducado";
  if (s.includes("desactiv") || s.includes("desativ")) return "Desactivado (CEDIME/ANF)";
  if (s.includes("descontinuad")) return "Descontinuado";
  if (s.includes("retirad")) return "Retirado por perigo para a Saúde Pública";
  if (s.includes("activ")) return "Activo";
  if (s.includes("excluid")) return "Excluído da comparticipação";
  if (s.includes("inicial")) return "Situação Inicial";
  return raw.trim();
}

// ─── Upsert com regra "preservar não-null" ────────────────────────────────────

type UpsertCounters = {
  inserted: number;
  updatedSomeFields: number;
  unchanged: number;
  failed: number;
};

async function upsertBatch(
  batch: ParsedRow[],
  source: string,
  force: boolean,
  dryRun: boolean,
): Promise<UpsertCounters> {
  const counters: UpsertCounters = { inserted: 0, updatedSomeFields: 0, unchanged: 0, failed: 0 };
  if (batch.length === 0) return counters;

  // Carrega registos existentes em massa
  const existing = await prisma.regulatoryRecord.findMany({
    where: { cnp: { in: batch.map((r) => r.cnp) } },
  });
  const byCnp = new Map(existing.map((r) => [r.cnp, r]));

  // Separa novos vs existentes para usar createMany (bulk) no caso comum
  const toInsert: ParsedRow[] = [];
  const toUpdate: Array<{ cnp: number; data: Record<string, string | null> }> = [];

  for (const incoming of batch) {
    const cur = byCnp.get(incoming.cnp);
    if (!cur) {
      toInsert.push(incoming);
      continue;
    }
    // Update — preservar não-null (a menos que --force)
    const updates: Record<string, string | null> = {};
    for (const field of FIELDS) {
      if (field === "cnp") continue;
      const newVal = incoming[field] ?? null;
      const curVal = cur[field as keyof typeof cur] as string | null;
      if (force) {
        if (newVal !== curVal) {
          updates[field] = field === "estadoAim" ? normalizeEstado(newVal) : newVal;
        }
      } else if (curVal == null && newVal != null) {
        updates[field] = field === "estadoAim" ? normalizeEstado(newVal) : newVal;
      }
    }
    if (Object.keys(updates).length === 0) {
      counters.unchanged++;
    } else {
      updates.source = source;
      toUpdate.push({ cnp: incoming.cnp, data: updates });
    }
  }

  if (dryRun) {
    counters.inserted += toInsert.length;
    counters.updatedSomeFields += toUpdate.length;
    return counters;
  }

  // Live — bulk insert em UMA single round-trip via createMany.
  // Em vez de N inserts sequenciais (200 × ~50ms = 10s/batch), passa a
  // 1 round-trip ~150-300ms. Updates ficam per-row (raros nesta primeira
  // corrida; quando ocorrem, o user já decidiu correr live deliberadamente).
  if (toInsert.length > 0) {
    try {
      const data = toInsert.map((r) => ({
        cnp: r.cnp,
        designacaoOficial: r.designacaoOficial ?? null,
        dci: r.dci ?? null,
        codigoATC: r.codigoATC ?? null,
        formaFarmaceutica: r.formaFarmaceutica ?? null,
        dosagem: r.dosagem ?? null,
        embalagem: r.embalagem ?? null,
        grupoTerapeutico: r.grupoTerapeutico ?? null,
        titularAim: r.titularAim ?? null,
        estadoAim: r.estadoAim ? normalizeEstado(r.estadoAim) : null,
        source,
      }));
      // skipDuplicates: protege contra rows que entraram entre o findMany
      // e o createMany (race) ou entre re-corridas do importer com a mesma
      // fonte. Skipped duplicates NÃO são falhas — só linhas que já existem
      // e que o merge não precisava de tocar. Os outros já foram contados
      // como `unchanged` ou `updatedSomeFields` no pré-split.
      const res = await prisma.regulatoryRecord.createMany({ data, skipDuplicates: true });
      counters.inserted += res.count;
      // Diff entre toInsert.length e res.count = duplicados absorvidos
      // pelo skipDuplicates. Não somar a `failed` — não são erros.
    } catch (err) {
      counters.failed += toInsert.length;
      console.warn(
        `  [erro createMany batch (${toInsert.length} rows)]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Updates per-row (caminho lento, mas só corre quando há overlap real)
  for (const u of toUpdate) {
    try {
      await prisma.regulatoryRecord.update({ where: { cnp: u.cnp }, data: u.data });
      counters.updatedSomeFields++;
    } catch (err) {
      counters.failed++;
      console.warn(
        `  [erro update cnp=${u.cnp}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return counters;
}


// ─── Main ─────────────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("─".repeat(74));
  console.log("Importer RegulatoryRecord");
  console.log("─".repeat(74));
  console.log(`  file:       ${args.file}`);
  console.log(`  source:     ${args.source}`);
  console.log(`  dryRun:     ${args.dryRun}`);
  console.log(`  force:      ${args.force}`);
  console.log(`  batchSize:  ${args.batchSize}`);
  if (args.limit) console.log(`  limit:      ${args.limit}`);
  if (args.manualMap) console.log(`  manualMap:  ${JSON.stringify(args.manualMap)}`);

  if (!fs.existsSync(args.file)) {
    console.error(`[fatal] ficheiro não encontrado: ${args.file}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n[1/4] A ler ficheiro...`);
  const t0 = Date.now();
  const rows = readRows(args.file);
  console.log(`  ${rows.length} linhas lidas em ${fmtMs(Date.now() - t0)}`);

  // Mapping
  const hasHeader = args.manualMap === null && rows.length > 0 && looksLikeHeader(rows[0]);
  let mapping: Partial<Record<FieldName, number>>;
  if (args.manualMap) {
    mapping = args.manualMap;
    console.log(`  mapping: manual override ${JSON.stringify(mapping)}`);
  } else if (hasHeader) {
    mapping = mappingFromHeader(rows[0]);
    console.log(`  mapping: detectado por header → ${JSON.stringify(mapping)}`);
  } else {
    mapping = DEFAULT_4COL_MAPPING;
    console.log(
      `  mapping: sem header → 4-col positional default ` +
        `(cnp=0, estadoAim=1, designacaoOficial=2, titularAim=3)`,
    );
  }

  if (mapping.cnp === undefined) {
    console.error(
      `[fatal] coluna 'cnp' não mapeada. Use --map=cnp:<col>,... para forçar.`,
    );
    process.exitCode = 1;
    return;
  }

  // Parse
  console.log(`\n[2/4] A parsear linhas...`);
  const t1 = Date.now();
  const stats = parseRows(rows, mapping, hasHeader, args.limit);
  console.log(`  parsed: ${stats.parsed.length}`);
  console.log(`  skipped: cnp inválido=${stats.skippedNoCnp}, cnp<=${MIN_CNP}=${stats.skippedBelowMin}, sem campos úteis=${stats.skippedNoFields}`);
  console.log(`  tempo parse: ${fmtMs(Date.now() - t1)}`);

  if (stats.parsed.length === 0) {
    console.warn("Nada para importar.");
    return;
  }

  // Amostra
  console.log(`\n  Amostra (5 linhas parseadas):`);
  for (const p of stats.parsed.slice(0, 5)) {
    const compact: Record<string, unknown> = { cnp: p.cnp };
    for (const f of FIELDS) {
      if (f === "cnp") continue;
      const v = p[f];
      if (v != null) compact[f] = v.length > 40 ? `${v.slice(0, 37)}…` : v;
    }
    console.log(`    ${JSON.stringify(compact)}`);
  }

  // Upsert em batches
  console.log(`\n[3/4] A ${args.dryRun ? "simular" : "aplicar"} upserts em batches de ${args.batchSize}...`);
  const tBatch = Date.now();
  const totals: UpsertCounters = { inserted: 0, updatedSomeFields: 0, unchanged: 0, failed: 0 };
  const totalBatches = Math.ceil(stats.parsed.length / args.batchSize);

  for (let i = 0; i < stats.parsed.length; i += args.batchSize) {
    const batchNum = Math.floor(i / args.batchSize) + 1;
    const slice = stats.parsed.slice(i, i + args.batchSize);
    const tThisBatch = Date.now();
    const c = await upsertBatch(slice, args.source, args.force, args.dryRun);
    totals.inserted += c.inserted;
    totals.updatedSomeFields += c.updatedSomeFields;
    totals.unchanged += c.unchanged;
    totals.failed += c.failed;

    const processed = Math.min(i + args.batchSize, stats.parsed.length);
    const elapsed = Date.now() - tBatch;
    const rate = processed / Math.max(1, elapsed) * 1000;
    const eta = rate > 0 ? ((stats.parsed.length - processed) / rate) * 1000 : 0;
    console.log(
      `  [${String(batchNum).padStart(String(totalBatches).length)}/${totalBatches}] ` +
        `proc=${processed}/${stats.parsed.length} ` +
        `ins=${totals.inserted} upd=${totals.updatedSomeFields} unch=${totals.unchanged} fail=${totals.failed} ` +
        `batch=${Date.now() - tThisBatch}ms eta=${fmtMs(eta)}`,
    );
  }

  // Métricas finais — coverage por campo
  console.log(`\n[4/4] Métricas de qualidade pós-import:`);
  const [
    total,
    withDci,
    withAtc,
    withForma,
    withDosagem,
    withEmbalagem,
    withGrupo,
    withTitular,
    withEstado,
    withDesignacao,
  ] = await Promise.all([
    prisma.regulatoryRecord.count(),
    prisma.regulatoryRecord.count({ where: { dci: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { codigoATC: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { formaFarmaceutica: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { dosagem: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { embalagem: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { grupoTerapeutico: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { titularAim: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { estadoAim: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { designacaoOficial: { not: null } } }),
  ]);
  const produtoCount = await prisma.produto.count({ where: { cnp: { gt: MIN_CNP } } });
  const intersection = await prisma.regulatoryRecord.count({
    where: { cnp: { in: (await prisma.produto.findMany({ where: { cnp: { gt: MIN_CNP } }, select: { cnp: true } })).map((p) => p.cnp) } },
  });

  const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
  console.log(`  total RegulatoryRecord:           ${total}`);
  console.log(`  com designacaoOficial:            ${withDesignacao} (${pct(withDesignacao, total)})`);
  console.log(`  com titularAim:                   ${withTitular} (${pct(withTitular, total)})`);
  console.log(`  com estadoAim:                    ${withEstado} (${pct(withEstado, total)})`);
  console.log(`  com codigoATC:                    ${withAtc} (${pct(withAtc, total)})`);
  console.log(`  com dci:                          ${withDci} (${pct(withDci, total)})`);
  console.log(`  com formaFarmaceutica:            ${withForma} (${pct(withForma, total)})`);
  console.log(`  com dosagem:                      ${withDosagem} (${pct(withDosagem, total)})`);
  console.log(`  com embalagem:                    ${withEmbalagem} (${pct(withEmbalagem, total)})`);
  console.log(`  com grupoTerapeutico:             ${withGrupo} (${pct(withGrupo, total)})`);
  console.log(`  cobertura RegulatoryRecord ∩ Produto: ${intersection} / ${produtoCount} (${pct(intersection, produtoCount)})`);

  console.log(`\n${"─".repeat(74)}`);
  console.log(
    `RESULTADO ${args.dryRun ? "(DRY-RUN)" : "(LIVE)"}: ` +
      `inseridos=${totals.inserted} actualizados=${totals.updatedSomeFields} ` +
      `inalterados=${totals.unchanged} falhas=${totals.failed} ` +
      `· tempo=${fmtMs(Date.now() - tBatch)}`,
  );
  console.log("─".repeat(74));
}

main()
  .catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
