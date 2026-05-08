/**
 * scripts/crawl-infomed-search.ts
 *
 * HTTP-only crawler do INFOMED para popular `RegulatoryRecord` via mapping
 * incremental. NÃO usa Playwright em runtime.
 *
 * Cohort: produtos da BD que precisam de enrichment regulatório. Para cada
 * CNP, faz a sequência de 5 passos no INFOMED (ver
 * `lib/regulatory-sources/infomed-search-resolver.ts`) e persiste o
 * resultado num ficheiro JSON staging.
 *
 * Output (este crawler NÃO escreve em RegulatoryRecord):
 *   scripts/data/infomed-cnp-medguid-mapping.json
 *
 * Match forte: detail page de exactamente UMA das rows da listagem contém
 * o CNP-alvo nas embalagens. Outros casos (zero ou múltiplos) ficam em
 * `notFound` com razão.
 *
 * Resumível: skip de mapped + skip de notFound (excepto --retry-not-found).
 *
 * Uso:
 *   # Smoke 100, dry-run
 *   npx tsx scripts/crawl-infomed-search.ts --limit=100 --dry-run
 *
 *   # Smoke 100 live
 *   npx tsx scripts/crawl-infomed-search.ts --limit=100
 *
 *   # Resume — skip mapped/notFound, processa próximos
 *   npx tsx scripts/crawl-infomed-search.ts --limit=1000 --resume
 *
 *   # Re-tentar not-found (após melhorar normalize, etc.)
 *   npx tsx scripts/crawl-infomed-search.ts --limit=200 --retry-not-found
 *
 *   # Rate limit mais conservador
 *   npx tsx scripts/crawl-infomed-search.ts --limit=500 --rate-limit-ms=2500
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { legacyPrisma as prisma } from "../lib/prisma";
import {
  resolveCnpViaDesignacaoSearch,
  normalizeForSearch,
} from "../lib/regulatory-sources/infomed-search-resolver";
import type { ResolveOutcome } from "../lib/regulatory-sources/infomed-search-resolver";

// ─── Constantes ───────────────────────────────────────────────────────────────

const MAPPING_FILE = path.resolve("scripts/data/infomed-cnp-medguid-mapping.json");
const DEFAULT_LIMIT = 100;
/**
 * Rate-limit defensivo entre CNPs. Cada CNP cria fresh session (GET index)
 * e o INFOMED tem anti-bot que devolve 503 quando se criam muitas sessões
 * num curto período. 3000ms = ~20 CNPs/min ≈ 1200/hora — suficiente para
 * 6191 CNPs em ~5h overnight.
 */
const DEFAULT_RATE_LIMIT_MS = 3000;
const DEFAULT_CHECKPOINT_EVERY = 5;
const DEFAULT_MAX_CANDIDATES = 3;

// ─── Tipos ────────────────────────────────────────────────────────────────────

type MappingEntry = {
  cnp: number;
  matchedAt: string;
  matchedVia: "search_designacao" | "sibling_cnp";
  searchedAs: string | null;
  // Clinical fields extraídos do detail page
  designacaoOficial: string;
  dci: string | null;
  codigoATC: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  titularAim: string | null;
  estadoAim: string | null;
  grupoTerapeutico: string | null;
  /** Outros CNPs extraídos do mesmo detail page (todas as embalagens). */
  siblings: number[];
};

type NotFoundEntry = {
  cnp: number;
  searchedAs: string;
  searchedAt: string;
  reason: "no_results" | "no_cnp_match" | "ambiguous" | "failed";
  details?: string;
  candidatesEvaluated: number;
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
  notFound: Record<string, NotFoundEntry>;
};

type Args = {
  limit: number;
  cohort: string;
  rateLimitMs: number;
  checkpointEvery: number;
  maxCandidates: number;
  resume: boolean;
  retryNotFound: boolean;
  dryRun: boolean;
};

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(): Args {
  const out: Args = {
    limit: DEFAULT_LIMIT,
    cohort: "outros-medicamentos",
    rateLimitMs: DEFAULT_RATE_LIMIT_MS,
    checkpointEvery: DEFAULT_CHECKPOINT_EVERY,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    resume: false,
    retryNotFound: false,
    dryRun: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--resume") out.resume = true;
    else if (a === "--retry-not-found") out.retryNotFound = true;
    else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0 && n <= 50_000) out.limit = n;
    } else if (a.startsWith("--cohort=")) {
      out.cohort = a.split("=")[1];
    } else if (a.startsWith("--rate-limit-ms=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 500 && n <= 30_000) out.rateLimitMs = n;
    } else if (a.startsWith("--checkpoint-every=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 1 && n <= 1000) out.checkpointEvery = n;
    } else if (a.startsWith("--max-candidates=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 1 && n <= 20) out.maxCandidates = n;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

// ─── Mapping I/O ──────────────────────────────────────────────────────────────

function emptyMapping(): MappingFile {
  return {
    version: "1",
    lastUpdate: new Date().toISOString(),
    stats: { searched: 0, matched_strong: 0, ambiguous: 0, not_found: 0, failed: 0 },
    mappings: {},
    notFound: {},
  };
}

function loadMapping(): MappingFile {
  if (!fs.existsSync(MAPPING_FILE)) return emptyMapping();
  try {
    const data = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf-8")) as MappingFile;
    if (data.version !== "1") {
      console.warn(`[aviso] mapping version desconhecida ${data.version} — começar limpo`);
      return emptyMapping();
    }
    return data;
  } catch (err) {
    console.warn(`[aviso] mapping corrupted (${err instanceof Error ? err.message : err})`);
    return emptyMapping();
  }
}

function saveMappingAtomic(data: MappingFile): void {
  data.lastUpdate = new Date().toISOString();
  fs.mkdirSync(path.dirname(MAPPING_FILE), { recursive: true });
  const tmp = `${MAPPING_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, MAPPING_FILE);
}

// ─── Cohort ───────────────────────────────────────────────────────────────────

type CohortProduct = { cnp: number; designacao: string };

async function loadCohort(cohort: string): Promise<CohortProduct[]> {
  if (cohort === "outros-medicamentos") {
    const nivel2 = await prisma.classificacao.findFirst({
      where: {
        tipo: "NIVEL_2",
        nome: { equals: "Outros Medicamentos", mode: "insensitive" },
        classificacaoPai: { nome: { equals: "MEDICAMENTOS", mode: "insensitive" } },
      },
      select: { id: true },
    });
    if (!nivel2) throw new Error(`Classificacao 'Outros Medicamentos' não encontrada`);
    return prisma.produto.findMany({
      where: {
        productType: "MEDICAMENTO",
        classificacaoNivel2Id: nivel2.id,
        validadoManualmente: false,
        estado: { not: "INATIVO" },
        cnp: { gt: 2_000_000 },
      },
      select: { cnp: true, designacao: true },
      orderBy: { cnp: "asc" },
    });
  }
  if (cohort === "med-no-clinical") {
    return prisma.produto.findMany({
      where: {
        productType: "MEDICAMENTO",
        codigoATC: null,
        dci: null,
        validadoManualmente: false,
        estado: { not: "INATIVO" },
        cnp: { gt: 2_000_000 },
      },
      select: { cnp: true, designacao: true },
      orderBy: { cnp: "asc" },
    });
  }
  throw new Error(`Cohort desconhecido: ${cohort}`);
}

// ─── Build MappingEntry from outcome ──────────────────────────────────────────

function entryFromOutcome(
  outcome: Extract<ResolveOutcome, { kind: "matched_strong" }>,
  searchedAs: string,
  forCnp: number,
): MappingEntry {
  const d = outcome.detail;
  const allCnps = d.embalagens.map((e) => e.cnp);
  // Embalagem para este CNP especificamente (se conhecida)
  const ourEmb = d.embalagens.find((e) => e.cnp === forCnp);
  const isPrimary = forCnp === outcome.cnp;
  return {
    cnp: forCnp,
    matchedAt: new Date().toISOString(),
    matchedVia: isPrimary ? "search_designacao" : "sibling_cnp",
    searchedAs: isPrimary ? searchedAs : null,
    designacaoOficial: d.designacaoOficial,
    dci: d.dci,
    codigoATC: d.codigoATC,
    formaFarmaceutica: d.formaFarmaceutica,
    dosagem: d.dosagem,
    embalagem: ourEmb?.descricao ?? null,
    titularAim: d.titularAim,
    estadoAim: d.estadoAim,
    grupoTerapeutico: d.grupoTerapeutico,
    siblings: allCnps.filter((c) => c !== forCnp),
  };
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("─".repeat(74));
  console.log("INFOMED Crawler HTTP-only — CNP → detalhes regulatórios");
  console.log("─".repeat(74));
  console.log(`  cohort:           ${args.cohort}`);
  console.log(`  limit:            ${args.limit}`);
  console.log(`  rateLimitMs:      ${args.rateLimitMs}`);
  console.log(`  maxCandidates:    ${args.maxCandidates}`);
  console.log(`  resume:           ${args.resume}`);
  console.log(`  retryNotFound:    ${args.retryNotFound}`);
  console.log(`  dryRun:           ${args.dryRun}`);
  console.log(`  mapping file:     ${MAPPING_FILE}`);

  // Load existing mapping (resume) ou empty
  const mapping = args.resume ? loadMapping() : emptyMapping();
  console.log(
    `\n  Mapping carregado: ${Object.keys(mapping.mappings).length} mapped, ${Object.keys(mapping.notFound).length} not_found`,
  );

  // Cohort
  const cohortAll = await loadCohort(args.cohort);
  console.log(`  Cohort total:     ${cohortAll.length}`);

  // Filtro: skip mapped + (skip notFound a menos que retry)
  const toProcess = cohortAll.filter((p) => {
    const k = String(p.cnp);
    if (mapping.mappings[k]) return false;
    if (!args.retryNotFound && mapping.notFound[k]) return false;
    return true;
  });
  console.log(`  Por processar:    ${toProcess.length} (após skip mapped/notFound)`);

  const targets = toProcess.slice(0, args.limit);
  if (targets.length === 0) {
    console.log("\n  Nada para fazer. Sai.");
    await prisma.$disconnect();
    return;
  }
  console.log(`  Vão processar:    ${targets.length}`);

  // Sample
  console.log(`\n  Amostra (5):`);
  for (const p of targets.slice(0, 5)) {
    console.log(`    cnp=${p.cnp}  ${p.designacao.slice(0, 60)}`);
    console.log(`      → search: "${normalizeForSearch(p.designacao)}"`);
  }

  if (args.dryRun) {
    console.log(`\n  [dry-run] sem requests HTTP, sem writes. Sai.`);
    await prisma.$disconnect();
    return;
  }

  // Process loop
  console.log(`\n  [run] processar ${targets.length} CNPs...`);
  const tStart = Date.now();
  let processed = 0;

  const examples: {
    matched: Array<{ cnp: number; designacao: string; via: string; siblings: number }>;
    ambiguous: Array<{ cnp: number; designacao: string; matched: number }>;
    notFound: Array<{ cnp: number; designacao: string; reason: string }>;
    failed: Array<{ cnp: number; designacao: string; error: string }>;
  } = { matched: [], ambiguous: [], notFound: [], failed: [] };
  const maxExamples = 20;

  try {
    for (const product of targets) {
      processed++;
      mapping.stats.searched++;
      const tProd = Date.now();

      const outcome = await resolveCnpViaDesignacaoSearch(product.cnp, product.designacao, {
        rateLimitMs: args.rateLimitMs,
        maxCandidatesToFetch: args.maxCandidates,
      });

      const elapsed = Date.now() - tProd;

      if (outcome.kind === "matched_strong") {
        // Adicionar TODOS os CNPs do detail page (siblings)
        const allCnps = outcome.detail.embalagens.map((e) => e.cnp);
        const searchedAs = normalizeForSearch(product.designacao);
        let added = 0;
        for (const c of allCnps) {
          if (mapping.mappings[String(c)]) continue;
          mapping.mappings[String(c)] = entryFromOutcome(outcome, searchedAs, c);
          delete mapping.notFound[String(c)]; // limpa notFound se estava lá
          added++;
        }
        mapping.stats.matched_strong++;
        if (examples.matched.length < maxExamples) {
          examples.matched.push({
            cnp: product.cnp,
            designacao: product.designacao,
            via: outcome.matchedRow.nome,
            siblings: allCnps.filter((c) => c !== product.cnp).length,
          });
        }
        console.log(
          `  [${processed}/${targets.length}] cnp=${product.cnp} ✓ MATCHED ` +
            `"${outcome.detail.designacaoOficial}" (${outcome.detail.codigoATC ?? "no-ATC"}) ` +
            `+${allCnps.length - 1} siblings (added=${added}) [${fmtMs(elapsed)}, evaluated=${outcome.candidatesEvaluated}]`,
        );
      } else if (outcome.kind === "ambiguous") {
        mapping.notFound[String(product.cnp)] = {
          cnp: product.cnp,
          searchedAs: normalizeForSearch(product.designacao),
          searchedAt: new Date().toISOString(),
          reason: "ambiguous",
          details: `${outcome.matchedRowsWithDetail.length} candidatos com este CNP nas embalagens`,
          candidatesEvaluated: outcome.candidatesEvaluated,
        };
        mapping.stats.ambiguous++;
        if (examples.ambiguous.length < maxExamples) {
          examples.ambiguous.push({
            cnp: product.cnp,
            designacao: product.designacao,
            matched: outcome.matchedRowsWithDetail.length,
          });
        }
        console.log(
          `  [${processed}/${targets.length}] cnp=${product.cnp} ⚠ AMBIGUOUS ` +
            `(${outcome.matchedRowsWithDetail.length} matches) [${fmtMs(elapsed)}]`,
        );
      } else if (outcome.kind === "not_found") {
        mapping.notFound[String(product.cnp)] = {
          cnp: product.cnp,
          searchedAs: normalizeForSearch(product.designacao),
          searchedAt: new Date().toISOString(),
          reason: outcome.reason,
          details: `rowsTotal=${outcome.rowsTotal}`,
          candidatesEvaluated: outcome.candidatesEvaluated,
        };
        mapping.stats.not_found++;
        if (examples.notFound.length < maxExamples) {
          examples.notFound.push({
            cnp: product.cnp,
            designacao: product.designacao,
            reason: `${outcome.reason} (rows=${outcome.rowsTotal}, eval=${outcome.candidatesEvaluated})`,
          });
        }
        console.log(
          `  [${processed}/${targets.length}] cnp=${product.cnp} · NOT_FOUND ` +
            `(${outcome.reason}, rows=${outcome.rowsTotal}, evaluated=${outcome.candidatesEvaluated}) [${fmtMs(elapsed)}]`,
        );
      } else {
        // failed
        mapping.notFound[String(product.cnp)] = {
          cnp: product.cnp,
          searchedAs: normalizeForSearch(product.designacao),
          searchedAt: new Date().toISOString(),
          reason: "failed",
          details: `stage=${outcome.stage}: ${outcome.error}`,
          candidatesEvaluated: 0,
        };
        mapping.stats.failed++;
        if (examples.failed.length < maxExamples) {
          examples.failed.push({
            cnp: product.cnp,
            designacao: product.designacao,
            error: `[${outcome.stage}] ${outcome.error.slice(0, 100)}`,
          });
        }
        console.log(
          `  [${processed}/${targets.length}] cnp=${product.cnp} ✗ FAILED ` +
            `[${outcome.stage}] ${outcome.error.slice(0, 80)} [${fmtMs(elapsed)}]`,
        );
      }

      // Checkpoint
      if (processed % args.checkpointEvery === 0) {
        saveMappingAtomic(mapping);
        const totalElapsed = Date.now() - tStart;
        const rate = processed / (totalElapsed / 1000);
        const eta = rate > 0 ? ((targets.length - processed) / rate) * 1000 : 0;
        console.log(
          `    [checkpoint] saved · ${processed}/${targets.length} ` +
            `· rate=${rate.toFixed(2)}/s · eta=${fmtMs(eta)}`,
        );
      }

      // Rate-limit entre CNPs — protege contra anti-bot que limita
      // a criação de sessões fresh por IP. Cada CNP cria 1 session.
      if (processed < targets.length) {
        await new Promise((r) => setTimeout(r, args.rateLimitMs));
      }
    }
  } finally {
    saveMappingAtomic(mapping);
  }

  // ── Final summary ────────────────────────────────────────────────────────
  const totalElapsed = Date.now() - tStart;
  console.log(`\n${"═".repeat(74)}`);
  console.log("SUMÁRIO");
  console.log("═".repeat(74));
  console.log(`  processados:                ${processed}`);
  console.log(`  matched_strong (este run):  ${mapping.stats.matched_strong}`);
  console.log(`  ambiguous:                  ${mapping.stats.ambiguous}`);
  console.log(`  not_found:                  ${mapping.stats.not_found}`);
  console.log(`  failed:                     ${mapping.stats.failed}`);
  console.log(`  tempo total:                ${fmtMs(totalElapsed)}`);
  console.log(
    `  taxa efectiva:              ${(processed / (totalElapsed / 1000)).toFixed(2)} CNPs/s ` +
      `(${(processed / (totalElapsed / 60000)).toFixed(1)}/min)`,
  );
  console.log(`  total mapped (file):        ${Object.keys(mapping.mappings).length}`);
  console.log(`  total notFound (file):      ${Object.keys(mapping.notFound).length}`);

  if (examples.matched.length > 0) {
    console.log(`\n  Exemplos matched (${examples.matched.length}):`);
    for (const e of examples.matched) {
      console.log(`    ${e.cnp}  ${e.designacao.slice(0, 50).padEnd(50)}  → "${e.via}" (+${e.siblings} siblings)`);
    }
  }
  if (examples.ambiguous.length > 0) {
    console.log(`\n  Exemplos ambiguous (${examples.ambiguous.length}):`);
    for (const e of examples.ambiguous) {
      console.log(`    ${e.cnp}  ${e.designacao.slice(0, 60).padEnd(60)}  matched=${e.matched}`);
    }
  }
  if (examples.notFound.length > 0) {
    console.log(`\n  Exemplos not_found (${examples.notFound.length}):`);
    for (const e of examples.notFound) {
      console.log(`    ${e.cnp}  ${e.designacao.slice(0, 50).padEnd(50)}  ${e.reason}`);
    }
  }
  if (examples.failed.length > 0) {
    console.log(`\n  Exemplos failed (${examples.failed.length}):`);
    for (const e of examples.failed) {
      console.log(`    ${e.cnp}  ${e.designacao.slice(0, 40).padEnd(40)}  ${e.error}`);
    }
  }

  console.log(`\n  Mapping file: ${MAPPING_FILE}`);
  console.log("═".repeat(74));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
