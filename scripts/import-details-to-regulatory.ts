/**
 * scripts/import-details-to-regulatory.ts
 *
 * P9 Fase 3 — Import de `scripts/data/infomed-listagem-details.json` para
 * RegulatoryRecord. Expande cada detail × N embalagens → N rows
 * RegulatoryRecord (uma por CNP).
 *
 * Política de merge: idêntica a `import-mapping-to-regulatory-record.ts`:
 *   · preserve-non-null por defeito (existing values não sobrescritos)
 *   · `--force` overrides
 *   · Bulk createMany com skipDuplicates; updates per-row para overlap
 *
 * Source tag default: `infomed_browse_<YYYY-MM-DD>` (P9 browse approach).
 *
 * Uso:
 *   npx tsx scripts/import-details-to-regulatory.ts --dry-run
 *   npx tsx scripts/import-details-to-regulatory.ts
 *   npx tsx scripts/import-details-to-regulatory.ts --force
 *   npx tsx scripts/import-details-to-regulatory.ts --limit=100
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { legacyPrisma } from "../lib/prisma";
import type { PrismaClient } from "../generated/prisma/client";

const DETAILS_FILE = path.resolve("scripts/data/infomed-listagem-details.json");
const MIN_CNP = 2_000_000;

// Tenant-safe: prisma é resolvido em main(); default = legacyPrisma.
let prisma: PrismaClient = legacyPrisma;

// SyncRun id, hoisted ao escopo do módulo para que o `.catch()` no
// fundo do ficheiro consiga registar falha. Só populado quando
// `--record-sync-run` é passado.
let runId: string | null = null;

const FIELDS = [
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

type Args = {
  source: string;
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
  force: boolean;
  tenantSlug: string | null;
  recordSyncRun: boolean;
};

function parseArgs(): Args {
  const out: Args = {
    source: `infomed_browse_${new Date().toISOString().slice(0, 10)}`,
    dryRun: false,
    limit: null,
    batchSize: 500,
    force: false,
    tenantSlug: null,
    recordSyncRun: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--record-sync-run") out.recordSyncRun = true;
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else if (a.startsWith("--batch-size=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0 && n <= 1000) out.batchSize = n;
    } else if (a.startsWith("--tenant=")) {
      const v = a.split("=")[1];
      if (v) out.tenantSlug = v;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeEstado(raw: string | null): string | null {
  if (!raw) return null;
  const s = stripAccents(raw.toLowerCase());
  if (s.includes("autoriz")) return "Autorizado";
  if (s.includes("suspens")) return "Suspenso";
  if (s.includes("revog")) return "Revogado";
  if (s.includes("caduc")) return "Caducado";
  if (s.includes("desactiv") || s.includes("desativ")) return "Desactivado";
  if (s.includes("descontinuad")) return "Descontinuado";
  if (s.includes("retirad")) return "Retirado";
  if (s.includes("activ")) return "Activo";
  return raw.trim();
}

type ParsedRow = Partial<Record<Exclude<FieldName, never>, string | null>> & { cnp: number };

type DetailRecord = {
  medId: number;
  designacaoOficial: string | null;
  dci: string | null;
  codigoATC: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  titularAim: string | null;
  grupoTerapeutico: string | null;
  embalagens: Array<{ cnp: number; descricao: string | null; comercializacao: string | null }>;
};

function expandDetailsToRows(details: Record<string, DetailRecord>): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const seenCnps = new Set<number>();
  for (const r of Object.values(details)) {
    for (const e of r.embalagens) {
      if (!Number.isFinite(e.cnp) || e.cnp <= MIN_CNP) continue;
      // Skip duplicates (mesmo CNP pode aparecer via múltiplos medicamentos — preferir primeiro)
      if (seenCnps.has(e.cnp)) continue;
      seenCnps.add(e.cnp);
      rows.push({
        cnp: e.cnp,
        designacaoOficial: r.designacaoOficial,
        dci: r.dci,
        codigoATC: r.codigoATC,
        formaFarmaceutica: r.formaFarmaceutica,
        dosagem: r.dosagem,
        embalagem: e.descricao,
        titularAim: r.titularAim,
        grupoTerapeutico: r.grupoTerapeutico,
        estadoAim: e.comercializacao ?? "Autorizado",
      });
    }
  }
  return rows;
}

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

  const existing = await prisma.regulatoryRecord.findMany({
    where: { cnp: { in: batch.map((r) => r.cnp) } },
  });
  const byCnp = new Map(existing.map((r) => [r.cnp, r]));

  const toInsert: ParsedRow[] = [];
  const toUpdate: Array<{ cnp: number; data: Record<string, string | null> }> = [];

  for (const incoming of batch) {
    const cur = byCnp.get(incoming.cnp);
    if (!cur) {
      toInsert.push(incoming);
      continue;
    }
    const updates: Record<string, string | null> = {};
    for (const field of FIELDS) {
      const newVal = (incoming[field] ?? null) as string | null;
      const curVal = (cur as unknown as Record<string, string | null>)[field];
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
      const res = await prisma.regulatoryRecord.createMany({ data, skipDuplicates: true });
      counters.inserted += res.count;
    } catch (err) {
      counters.failed += toInsert.length;
      console.warn(`  [erro createMany batch (${toInsert.length})]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const u of toUpdate) {
    try {
      await prisma.regulatoryRecord.update({ where: { cnp: u.cnp }, data: u.data });
      counters.updatedSomeFields++;
    } catch (err) {
      counters.failed++;
      console.warn(`  [erro update cnp=${u.cnp}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return counters;
}

async function main() {
  const args = parseArgs();

  // Tenant-safe resolution
  if (args.tenantSlug) {
    const { getTenantPrismaOrLegacy } = await import("../lib/tenant-registry");
    prisma = await getTenantPrismaOrLegacy(args.tenantSlug);
  }
  const slugForLedger = args.tenantSlug ?? "legacy";

  // SyncRun observability (opt-in)
  if (args.recordSyncRun) {
    const { startSyncRun } = await import("../lib/sync/sync-run");
    const handle = await startSyncRun({
      tenantSlug: slugForLedger,
      source: "regulatory-import",
      meta: {
        sourceTag: args.source,
        dryRun: args.dryRun,
        force: args.force,
        batchSize: args.batchSize,
        limit: args.limit,
        file: DETAILS_FILE,
      },
    });
    runId = handle.id;
  }

  console.log("─".repeat(74));
  console.log("Import P9 details → RegulatoryRecord");
  console.log("─".repeat(74));
  console.log(`  source:      ${args.source}`);
  console.log(`  dryRun:      ${args.dryRun}`);
  console.log(`  force:       ${args.force}`);
  console.log(`  batchSize:   ${args.batchSize}`);
  console.log(`  limit:       ${args.limit ?? "(no limit)"}`);
  console.log(`  tenant:      ${args.tenantSlug ?? "(legacy)"}`);
  if (runId) console.log(`  syncRunId:   ${runId}`);

  if (!fs.existsSync(DETAILS_FILE)) {
    console.error(`[fatal] ficheiro details não existe: ${DETAILS_FILE}`);
    process.exit(1);
  }

  console.log(`\n[1/4] A ler details file...`);
  const t0 = Date.now();
  const file = JSON.parse(fs.readFileSync(DETAILS_FILE, "utf-8")) as { details: Record<string, DetailRecord> };
  const totalDetails = Object.keys(file.details).length;
  console.log(`  medicamentos no file: ${totalDetails}`);

  console.log(`\n[2/4] A expandir detail × embalagens → RegulatoryRecord rows...`);
  let rows = expandDetailsToRows(file.details);
  console.log(`  expanded rows: ${rows.length} (CNPs únicos)`);

  if (args.limit) {
    rows = rows.slice(0, args.limit);
    console.log(`  limit aplicado: ${rows.length}`);
  }

  const withAtc = rows.filter((r) => r.codigoATC).length;
  const withDci = rows.filter((r) => r.dci).length;
  console.log(`  com codigoATC:    ${withAtc} (${((withAtc / rows.length) * 100).toFixed(1)}%)`);
  console.log(`  com dci:          ${withDci} (${((withDci / rows.length) * 100).toFixed(1)}%)`);

  console.log(`\n  Amostra (5 rows):`);
  for (const r of rows.slice(0, 5)) {
    const compact: Record<string, unknown> = { cnp: r.cnp };
    for (const f of FIELDS) {
      const v = r[f];
      if (v != null) compact[f] = String(v).slice(0, 40);
    }
    console.log(`    ${JSON.stringify(compact)}`);
  }

  console.log(`\n[3/4] A ${args.dryRun ? "simular" : "aplicar"} upserts em batches de ${args.batchSize}...`);
  const tBatch = Date.now();
  const totals: UpsertCounters = { inserted: 0, updatedSomeFields: 0, unchanged: 0, failed: 0 };
  const totalBatches = Math.ceil(rows.length / args.batchSize);
  for (let i = 0; i < rows.length; i += args.batchSize) {
    const batchNum = Math.floor(i / args.batchSize) + 1;
    const slice = rows.slice(i, i + args.batchSize);
    const tThis = Date.now();
    const c = await upsertBatch(slice, args.source, args.force, args.dryRun);
    totals.inserted += c.inserted;
    totals.updatedSomeFields += c.updatedSomeFields;
    totals.unchanged += c.unchanged;
    totals.failed += c.failed;
    const processed = Math.min(i + args.batchSize, rows.length);
    const elapsed = Date.now() - tBatch;
    const rate = (processed / Math.max(1, elapsed)) * 1000;
    const eta = rate > 0 ? ((rows.length - processed) / rate) * 1000 : 0;
    console.log(
      `  [${String(batchNum).padStart(String(totalBatches).length)}/${totalBatches}]` +
        ` proc=${processed}/${rows.length} ins=${totals.inserted} upd=${totals.updatedSomeFields} unch=${totals.unchanged} fail=${totals.failed}` +
        ` batch=${Date.now() - tThis}ms eta=${Math.round(eta / 1000)}s`,
    );
  }

  console.log(`\n[4/4] Métricas pós-import:`);
  const total = await prisma.regulatoryRecord.count();
  const withAtcRR = await prisma.regulatoryRecord.count({ where: { codigoATC: { not: null } } });
  const withDciRR = await prisma.regulatoryRecord.count({ where: { dci: { not: null } } });
  console.log(`  total RegulatoryRecord:  ${total}`);
  console.log(`  com codigoATC:           ${withAtcRR} (${((withAtcRR / total) * 100).toFixed(1)}%)`);
  console.log(`  com dci:                 ${withDciRR} (${((withDciRR / total) * 100).toFixed(1)}%)`);

  console.log(`\n${"─".repeat(74)}`);
  console.log(
    `RESULTADO ${args.dryRun ? "(DRY-RUN)" : "(LIVE)"}: ` +
      `inseridos=${totals.inserted} actualizados=${totals.updatedSomeFields} ` +
      `inalterados=${totals.unchanged} falhas=${totals.failed} ` +
      `· tempo=${Math.round((Date.now() - tBatch) / 1000)}s`,
  );
  console.log("─".repeat(74));

  if (runId) {
    const { completeSyncRun } = await import("../lib/sync/sync-run");
    await completeSyncRun(runId, {
      recordsRead: rows.length,
      recordsInserted: totals.inserted,
      recordsUpdated: totals.updatedSomeFields,
      recordsFailed: totals.failed,
    });
  }
}

main()
  .catch(async (e) => {
    console.error("[erro fatal]", e);
    if (runId) {
      try {
        const { failSyncRun } = await import("../lib/sync/sync-run");
        await failSyncRun(runId, e);
      } catch (closeErr) {
        console.error("[erro fatal] failSyncRun também falhou:", closeErr);
      }
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
