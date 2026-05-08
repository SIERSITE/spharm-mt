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
  startSearchSession,
  refreshIndexViewState,
  InfomedSearchError,
} from "../lib/regulatory-sources/infomed-search-resolver";
import type {
  ResolveOutcome,
  SearchSession,
} from "../lib/regulatory-sources/infomed-search-resolver";

// ─── Constantes ───────────────────────────────────────────────────────────────

const MAPPING_FILE = path.resolve("scripts/data/infomed-cnp-medguid-mapping.json");
const DEFAULT_LIMIT = 100;
/**
 * Rate-limit defensivo entre CNPs.
 *
 * Com session-reuse activo, o gargalo anti-bot move-se de "sessões frescas"
 * para "requests por minuto". 1500ms é suficiente porque cada CNP só cria
 * fresh session a cada N pesquisas (default 30).
 */
const DEFAULT_RATE_LIMIT_MS = 1500;

/**
 * Sessões reusadas: quantas pesquisas máximas antes de rotacionar.
 * Observámos que o anti-bot dispara após ~80 sessões frescas em ~5min;
 * mantendo 30 searches/session minimiza pressão anti-bot e dá margem.
 */
const DEFAULT_MAX_SEARCHES_PER_SESSION = 30;

/**
 * Cooldown ao rotacionar sessão (após max searches, ou após 503).
 * Dá tempo ao server para baixar contadores anti-bot.
 */
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Backoff exponencial em 503. Tentativas de retry para o mesmo CNP.
 * [10s, 30s, 90s] = 3 retries. Ao 4º 503, marca failed.
 */
const BACKOFF_503_MS = [10_000, 30_000, 90_000];
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
  maxSearchesPerSession: number;
  cooldownMs: number;
};

type RuntimeMetrics = {
  sessionsCreated: number;
  rotations: number;
  http503Count: number;
  retries: number;
  searchesUsedThisSession: number[];
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
    maxSearchesPerSession: DEFAULT_MAX_SEARCHES_PER_SESSION,
    cooldownMs: DEFAULT_COOLDOWN_MS,
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
    } else if (a.startsWith("--max-searches-per-session=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 1 && n <= 200) out.maxSearchesPerSession = n;
    } else if (a.startsWith("--cooldown-ms=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 1000 && n <= 600_000) out.cooldownMs = n;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

// ─── Session pool ─────────────────────────────────────────────────────────────

type SessionPool = {
  current: SearchSession | null;
  searchesUsed: number;
  /** searches counts of expired sessions for stats */
  pastSearches: number[];
};

/**
 * Devolve uma session pronta a usar — reusa a actual se ainda dentro do
 * orçamento, senão rota (com cooldown). ViewState é refresh para garantir
 * que está fresco antes da próxima search.
 *
 * Em caso de erro 503 (anti-bot) durante refresh ou criação, lança
 * InfomedSearchError com httpStatus=503 — caller decide backoff.
 */
async function acquireSession(
  pool: SessionPool,
  args: Args,
  metrics: RuntimeMetrics,
): Promise<SearchSession> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Rotação se atingimos o limite de searches/session
  if (pool.current && pool.searchesUsed >= args.maxSearchesPerSession) {
    pool.pastSearches.push(pool.searchesUsed);
    metrics.searchesUsedThisSession.push(pool.searchesUsed);
    metrics.rotations++;
    pool.current = null;
    pool.searchesUsed = 0;
    console.log(
      `    [session] rotation após ${args.maxSearchesPerSession} searches; cooldown ${args.cooldownMs}ms`,
    );
    await sleep(args.cooldownMs);
  }

  // Nova sessão se não há
  if (!pool.current) {
    pool.current = await startSearchSession();
    pool.searchesUsed = 0;
    metrics.sessionsCreated++;
    return pool.current;
  }

  // Refresh ViewState reusando JSESSIONID
  try {
    const fresh = await refreshIndexViewState(pool.current.jsessionid);
    pool.current.indexViewState = fresh;
    return pool.current;
  } catch (err) {
    // Refresh falhou (sessão expirou ou 503) — rota
    console.warn(
      `    [session] refresh falhou (${err instanceof Error ? err.message.slice(0, 60) : err}); rota.`,
    );
    pool.pastSearches.push(pool.searchesUsed);
    metrics.searchesUsedThisSession.push(pool.searchesUsed);
    metrics.rotations++;
    pool.current = null;
    pool.searchesUsed = 0;
    throw err;
  }
}

/** Marca a session corrente como inválida (após 503 ou erro grave). */
function invalidateSession(pool: SessionPool, metrics: RuntimeMetrics): void {
  if (pool.current) {
    pool.pastSearches.push(pool.searchesUsed);
    metrics.searchesUsedThisSession.push(pool.searchesUsed);
    metrics.rotations++;
  }
  pool.current = null;
  pool.searchesUsed = 0;
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

  // Process loop com session pool + retry/backoff
  console.log(`\n  [run] processar ${targets.length} CNPs...`);
  console.log(`  [session] max searches/session: ${args.maxSearchesPerSession}, cooldown: ${args.cooldownMs}ms`);
  const tStart = Date.now();
  let processed = 0;

  const examples: {
    matched: Array<{ cnp: number; designacao: string; via: string; siblings: number; atc: string | null }>;
    ambiguous: Array<{ cnp: number; designacao: string; matched: number }>;
    notFound: Array<{ cnp: number; designacao: string; reason: string }>;
    failed: Array<{ cnp: number; designacao: string; error: string }>;
  } = { matched: [], ambiguous: [], notFound: [], failed: [] };
  const maxExamples = 25;

  const pool: SessionPool = { current: null, searchesUsed: 0, pastSearches: [] };
  const metrics: RuntimeMetrics = {
    sessionsCreated: 0,
    rotations: 0,
    http503Count: 0,
    retries: 0,
    searchesUsedThisSession: [],
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Resolve um CNP com retry-on-503 (backoff exponencial). */
  async function resolveWithRetry(
    cnp: number,
    designacao: string,
  ): Promise<ResolveOutcome> {
    let lastOutcome: ResolveOutcome | null = null;
    for (let attempt = 0; attempt <= BACKOFF_503_MS.length; attempt++) {
      try {
        const session = await acquireSession(pool, args, metrics);
        const outcome = await resolveCnpViaDesignacaoSearch(cnp, designacao, {
          rateLimitMs: args.rateLimitMs,
          maxCandidatesToFetch: args.maxCandidates,
          session,
        });
        pool.searchesUsed++;
        // Detect 503 inside outcome (failed at session/search/click stage)
        if (outcome.kind === "failed" && /503/.test(outcome.error)) {
          throw new InfomedSearchError(`503 in outcome (${outcome.stage})`, outcome.stage, 503);
        }
        return outcome;
      } catch (err) {
        if (err instanceof InfomedSearchError && err.httpStatus === 503) {
          metrics.http503Count++;
          invalidateSession(pool, metrics);
          if (attempt < BACKOFF_503_MS.length) {
            const backoff = BACKOFF_503_MS[attempt];
            metrics.retries++;
            console.log(
              `    [503] backoff ${backoff}ms before retry ${attempt + 1}/${BACKOFF_503_MS.length} (cnp=${cnp})`,
            );
            await sleep(backoff);
            continue;
          }
          // Backoffs esgotados — devolve failed
          lastOutcome = {
            kind: "failed",
            cnp,
            error: `HTTP 503 after ${BACKOFF_503_MS.length} retries`,
            stage: err.stage,
          };
          break;
        }
        // Outro erro — não retentamos
        return {
          kind: "failed",
          cnp,
          error: err instanceof Error ? err.message : String(err),
          stage: "session",
        };
      }
    }
    return lastOutcome ?? {
      kind: "failed",
      cnp,
      error: "exhausted retries",
      stage: "session",
    };
  }

  try {
    for (const product of targets) {
      processed++;
      mapping.stats.searched++;
      const tProd = Date.now();

      const outcome = await resolveWithRetry(product.cnp, product.designacao);

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
            atc: outcome.detail.codigoATC,
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

      // Rate-limit entre CNPs
      if (processed < targets.length) {
        await sleep(args.rateLimitMs);
      }
    }
  } finally {
    // Adicionar a session corrente às stats
    if (pool.current) {
      metrics.searchesUsedThisSession.push(pool.searchesUsed);
    }
    saveMappingAtomic(mapping);
  }

  // ── Final summary ────────────────────────────────────────────────────────
  const totalElapsed = Date.now() - tStart;
  const totalSiblingsAdded =
    Object.keys(mapping.mappings).length - mapping.stats.matched_strong;
  const avgSearchesPerSession =
    metrics.searchesUsedThisSession.length > 0
      ? metrics.searchesUsedThisSession.reduce((a, b) => a + b, 0) /
        metrics.searchesUsedThisSession.length
      : 0;
  // Estimativa de ETA para 6191 (se este run for representativo)
  const etaFor6191Ms =
    processed > 0 ? (totalElapsed / processed) * 6191 : 0;

  console.log(`\n${"═".repeat(74)}`);
  console.log("SUMÁRIO");
  console.log("═".repeat(74));
  console.log(`  processed:                  ${processed}`);
  console.log(`  matched_strong:             ${mapping.stats.matched_strong}`);
  console.log(`  siblings auto-mapped:       ${totalSiblingsAdded}`);
  console.log(`  total mapped (file):        ${Object.keys(mapping.mappings).length}`);
  console.log(`  ambiguous:                  ${mapping.stats.ambiguous}`);
  console.log(`  not_found:                  ${mapping.stats.not_found}`);
  console.log(`  failed:                     ${mapping.stats.failed}`);
  console.log(`  HTTP 503 count:             ${metrics.http503Count}`);
  console.log(`  retries (backoff):          ${metrics.retries}`);
  console.log(`  sessions created:           ${metrics.sessionsCreated}`);
  console.log(`  session rotations:          ${metrics.rotations}`);
  console.log(`  avg searches/session:       ${avgSearchesPerSession.toFixed(1)}`);
  console.log(`  tempo total:                ${fmtMs(totalElapsed)}`);
  console.log(
    `  taxa efectiva:              ${(processed / (totalElapsed / 1000)).toFixed(2)} CNPs/s ` +
      `(${(processed / (totalElapsed / 60000)).toFixed(1)}/min)`,
  );
  console.log(
    `  ETA para 6191 (cohort):     ${fmtMs(etaFor6191Ms)} (extrapolado deste run)`,
  );
  console.log(`  total notFound (file):      ${Object.keys(mapping.notFound).length}`);

  if (examples.matched.length > 0) {
    console.log(`\n  Exemplos matched (${examples.matched.length}):`);
    for (const e of examples.matched) {
      console.log(
        `    ${e.cnp}  ${e.designacao.slice(0, 45).padEnd(45)}  ` +
          `→ "${e.via.slice(0, 25).padEnd(25)}"  ${(e.atc ?? "—").padEnd(8)}  +${e.siblings} sib`,
      );
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
