/**
 * scripts/import-mapping-to-regulatory-record.ts
 *
 * Importa o ficheiro staging produzido por `scripts/crawl-infomed-search.ts`
 * (`scripts/data/infomed-cnp-medguid-mapping.json`) para a tabela
 * `RegulatoryRecord`, fazendo upsert por CNP.
 *
 * Política de merge:
 *   · Preservar não-null por defeito — uma corrida que traga `dci=null`
 *     não apaga um `dci` populado por uma corrida anterior. `--force`
 *     sobrescreve mesmo campos não-null (uso consciente).
 *   · `cnp > 2.000.000` filtrado (códigos internos ERP).
 *   · A coluna `source` recebe a tag passada em `--source`. Default:
 *     `infomed_search_<YYYY-MM-DD>` baseado em `lastUpdate` do ficheiro.
 *
 * O ficheiro JSON tem dois tipos de entry:
 *   · `mappings[cnp]` — CNP com clinical fields populados (matched_strong
 *     ou sibling). É o que vai para RegulatoryRecord.
 *   · `notFound[cnp]` — CNPs onde a search falhou. NÃO entram em
 *     RegulatoryRecord (não temos data clínica).
 *
 * Uso:
 *   # Dry-run (default — não escreve em BD)
 *   npx tsx scripts/import-mapping-to-regulatory-record.ts --dry-run
 *
 *   # Live import — usa source default (infomed_search_<date>)
 *   npx tsx scripts/import-mapping-to-regulatory-record.ts
 *
 *   # Live import com source explícito
 *   npx tsx scripts/import-mapping-to-regulatory-record.ts \
 *     --source=infomed_search_2026-05-08
 *
 *   # Subset — só estes CNPs (validação manual antes de import total)
 *   npx tsx scripts/import-mapping-to-regulatory-record.ts \
 *     --only=5012345,5012346,5012347
 *
 *   # Sobrescrever campos não-null (raramente útil — só quando uma
 *   # corrida anterior gravou dados errados e queres rewrite)
 *   npx tsx scripts/import-mapping-to-regulatory-record.ts --force
 *
 *   # Excluir siblings (só matched_strong) — caso queiras importar apenas
 *   # CNPs com match directo de search (mais conservador)
 *   npx tsx scripts/import-mapping-to-regulatory-record.ts \
 *     --exclude-siblings --dry-run
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { legacyPrisma as prisma } from "../lib/prisma";

const MAPPING_FILE = path.resolve("scripts/data/infomed-cnp-medguid-mapping.json");
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

// ─── Tipos do staging file ────────────────────────────────────────────────────

type MappingEntry = {
  cnp: number;
  matchedAt: string;
  matchedVia: "search_designacao" | "sibling_cnp";
  searchedAs: string | null;
  designacaoOficial: string;
  dci: string | null;
  codigoATC: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  titularAim: string | null;
  estadoAim: string | null;
  grupoTerapeutico: string | null;
  siblings: number[];
};

type MappingFile = {
  version: "1";
  lastUpdate: string;
  stats: {
    searched: number;
    matched_strong: number;
    ambiguous: number;
    not_found: number;
    failed: number;
  };
  mappings: Record<string, MappingEntry>;
  notFound: Record<string, unknown>;
};

// ─── CLI args ─────────────────────────────────────────────────────────────────

type Args = {
  source: string | null;
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
  force: boolean;
  excludeSiblings: boolean;
  only: Set<number> | null;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = {
    source: null,
    dryRun: false,
    limit: null,
    batchSize: 500,
    force: false,
    excludeSiblings: false,
    only: null,
  };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--exclude-siblings") out.excludeSiblings = true;
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else if (a.startsWith("--batch-size=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0 && n <= 1000) out.batchSize = n;
    } else if (a.startsWith("--only=")) {
      const set = new Set<number>();
      for (const part of a.slice("--only=".length).split(",")) {
        const n = parseInt(part.trim(), 10);
        if (!isNaN(n) && n > 0) set.add(n);
      }
      out.only = set;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

// ─── Estado regulatório — normalização ────────────────────────────────────────

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
  if (s.includes("retirad")) return "Retirado por perigo para a Saúde Pública";
  if (s.includes("activ")) return "Activo";
  return raw.trim();
}

// ─── Conversão MappingEntry → ParsedRow ───────────────────────────────────────

type ParsedRow = Partial<Record<Exclude<FieldName, "cnp">, string | null>> & { cnp: number };

function mappingEntryToParsedRow(e: MappingEntry): ParsedRow {
  return {
    cnp: e.cnp,
    designacaoOficial: e.designacaoOficial ?? null,
    dci: e.dci,
    codigoATC: e.codigoATC,
    formaFarmaceutica: e.formaFarmaceutica,
    dosagem: e.dosagem,
    embalagem: e.embalagem,
    grupoTerapeutico: e.grupoTerapeutico,
    titularAim: e.titularAim,
    estadoAim: e.estadoAim,
  };
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
      console.warn(
        `  [erro createMany batch (${toInsert.length} rows)]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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

function defaultSourceTag(file: MappingFile): string {
  const day = (file.lastUpdate || new Date().toISOString()).slice(0, 10);
  return `infomed_search_${day}`;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("─".repeat(74));
  console.log("Importer mapping → RegulatoryRecord");
  console.log("─".repeat(74));

  if (!fs.existsSync(MAPPING_FILE)) {
    console.error(`[fatal] ficheiro staging não encontrado: ${MAPPING_FILE}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n[1/4] A ler staging file...`);
  const t0 = Date.now();
  let file: MappingFile;
  try {
    file = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf-8")) as MappingFile;
  } catch (err) {
    console.error(`[fatal] JSON inválido: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }
  if (file.version !== "1") {
    console.error(`[fatal] mapping version desconhecida: ${file.version}`);
    process.exitCode = 1;
    return;
  }

  const sourceTag = args.source ?? defaultSourceTag(file);
  console.log(`  staging file:    ${path.relative(process.cwd(), MAPPING_FILE)}`);
  console.log(`  lastUpdate:      ${file.lastUpdate}`);
  console.log(`  mappings totais: ${Object.keys(file.mappings).length}`);
  console.log(`  notFound:        ${Object.keys(file.notFound).length}`);
  console.log(`  source tag:      ${sourceTag}`);
  console.log(`  dryRun:          ${args.dryRun}`);
  console.log(`  force:           ${args.force}`);
  console.log(`  excludeSiblings: ${args.excludeSiblings}`);
  if (args.only) console.log(`  only:            ${args.only.size} CNPs`);
  if (args.limit) console.log(`  limit:           ${args.limit}`);
  console.log(`  read em ${fmtMs(Date.now() - t0)}`);

  // ─── Selecção das entries ──────────────────────────────────────────────────
  console.log(`\n[2/4] A filtrar entries...`);
  const t1 = Date.now();
  const stats = {
    total: 0,
    selected: 0,
    skippedSibling: 0,
    skippedBelowMin: 0,
    skippedNotInOnly: 0,
    skippedBadCnp: 0,
  };
  const selected: ParsedRow[] = [];

  for (const [cnpStr, entry] of Object.entries(file.mappings)) {
    stats.total++;
    if (args.limit !== null && selected.length >= args.limit) break;

    const cnp = Number(cnpStr);
    if (!Number.isFinite(cnp) || cnp <= 0) {
      stats.skippedBadCnp++;
      continue;
    }
    if (cnp <= MIN_CNP) {
      stats.skippedBelowMin++;
      continue;
    }
    if (args.excludeSiblings && entry.matchedVia === "sibling_cnp") {
      stats.skippedSibling++;
      continue;
    }
    if (args.only && !args.only.has(cnp)) {
      stats.skippedNotInOnly++;
      continue;
    }

    selected.push(mappingEntryToParsedRow(entry));
    stats.selected++;
  }

  console.log(`  total mappings:           ${stats.total}`);
  console.log(`  seleccionados:            ${stats.selected}`);
  console.log(`  saltados (siblings):      ${stats.skippedSibling}`);
  console.log(`  saltados (cnp <= ${MIN_CNP}): ${stats.skippedBelowMin}`);
  console.log(`  saltados (fora de --only): ${stats.skippedNotInOnly}`);
  console.log(`  saltados (cnp inválido):  ${stats.skippedBadCnp}`);
  console.log(`  filtrado em ${fmtMs(Date.now() - t1)}`);

  if (selected.length === 0) {
    console.warn("\nNada para importar.");
    return;
  }

  // Distribuição matched_strong vs sibling
  let mvDirect = 0;
  let mvSibling = 0;
  for (const cnpStr of Object.keys(file.mappings)) {
    const cnp = Number(cnpStr);
    if (selected.find((s) => s.cnp === cnp)) {
      if (file.mappings[cnpStr].matchedVia === "search_designacao") mvDirect++;
      else mvSibling++;
    }
  }
  console.log(`  · matched directo (search): ${mvDirect}`);
  console.log(`  · matched sibling:          ${mvSibling}`);

  // Cobertura por campo (no subset seleccionado)
  const fieldCoverage: Record<string, number> = {};
  for (const f of FIELDS) {
    if (f === "cnp") continue;
    fieldCoverage[f] = selected.filter((r) => r[f] != null).length;
  }
  console.log(`\n  Cobertura no subset seleccionado:`);
  for (const f of FIELDS) {
    if (f === "cnp") continue;
    const c = fieldCoverage[f];
    const pct = ((c / selected.length) * 100).toFixed(1);
    console.log(`    ${f.padEnd(20)} ${String(c).padStart(5)} (${pct}%)`);
  }

  // Amostra
  console.log(`\n  Amostra (5 entries seleccionadas):`);
  for (const p of selected.slice(0, 5)) {
    const compact: Record<string, unknown> = { cnp: p.cnp };
    for (const f of FIELDS) {
      if (f === "cnp") continue;
      const v = p[f];
      if (v != null) compact[f] = v.length > 40 ? `${v.slice(0, 37)}…` : v;
    }
    console.log(`    ${JSON.stringify(compact)}`);
  }

  // ─── Upsert em batches ─────────────────────────────────────────────────────
  console.log(`\n[3/4] A ${args.dryRun ? "simular" : "aplicar"} upserts em batches de ${args.batchSize}...`);
  const tBatch = Date.now();
  const totals: UpsertCounters = { inserted: 0, updatedSomeFields: 0, unchanged: 0, failed: 0 };
  const totalBatches = Math.ceil(selected.length / args.batchSize);

  for (let i = 0; i < selected.length; i += args.batchSize) {
    const batchNum = Math.floor(i / args.batchSize) + 1;
    const slice = selected.slice(i, i + args.batchSize);
    const tThisBatch = Date.now();
    const c = await upsertBatch(slice, sourceTag, args.force, args.dryRun);
    totals.inserted += c.inserted;
    totals.updatedSomeFields += c.updatedSomeFields;
    totals.unchanged += c.unchanged;
    totals.failed += c.failed;

    const processed = Math.min(i + args.batchSize, selected.length);
    const elapsed = Date.now() - tBatch;
    const rate = (processed / Math.max(1, elapsed)) * 1000;
    const eta = rate > 0 ? ((selected.length - processed) / rate) * 1000 : 0;
    console.log(
      `  [${String(batchNum).padStart(String(totalBatches).length)}/${totalBatches}] ` +
        `proc=${processed}/${selected.length} ` +
        `ins=${totals.inserted} upd=${totals.updatedSomeFields} unch=${totals.unchanged} fail=${totals.failed} ` +
        `batch=${Date.now() - tThisBatch}ms eta=${fmtMs(eta)}`,
    );
  }

  // ─── Métricas finais ───────────────────────────────────────────────────────
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
  const produtoCnps = (
    await prisma.produto.findMany({ where: { cnp: { gt: MIN_CNP } }, select: { cnp: true } })
  ).map((p) => p.cnp);
  const intersection = await prisma.regulatoryRecord.count({
    where: { cnp: { in: produtoCnps } },
  });

  const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
  console.log(`  total RegulatoryRecord:               ${total}`);
  console.log(`  com designacaoOficial:                ${withDesignacao} (${pct(withDesignacao, total)})`);
  console.log(`  com titularAim:                       ${withTitular} (${pct(withTitular, total)})`);
  console.log(`  com estadoAim:                        ${withEstado} (${pct(withEstado, total)})`);
  console.log(`  com codigoATC:                        ${withAtc} (${pct(withAtc, total)})`);
  console.log(`  com dci:                              ${withDci} (${pct(withDci, total)})`);
  console.log(`  com formaFarmaceutica:                ${withForma} (${pct(withForma, total)})`);
  console.log(`  com dosagem:                          ${withDosagem} (${pct(withDosagem, total)})`);
  console.log(`  com embalagem:                        ${withEmbalagem} (${pct(withEmbalagem, total)})`);
  console.log(`  com grupoTerapeutico:                 ${withGrupo} (${pct(withGrupo, total)})`);
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
