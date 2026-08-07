/**
 * scripts/fetch-details-by-medid.ts
 *
 * P9 Fase 2 — GET `detalhes-medicamento.xhtml?med_id=<numeric>` para cada
 * MED_ID extraído pela Fase 1 (browse-infomed-listagem). A detail page
 * NÃO é anti-bot-filtered (confirmado em spike v4), pelo que paralelismo
 * é seguro com cuidado básico.
 *
 * Reutiliza `parseInfomedDetailHtml` de lib/regulatory-sources/infarmed-detail-page.ts
 * para extrair {nome, dci, ATC, formaFarmaceutica, dosagem, titularAim,
 * grupoTerapeutico, embalagens com CNPs, vias, classificacaoDispensa}.
 *
 * Input:  scripts/data/infomed-listagem.json
 * Output: scripts/data/infomed-listagem-details.json
 *
 * Defaults:
 *   --parallel=3        (workers concorrentes)
 *   --rate-limit-ms=300 (cada worker espera 300ms entre requests; 3×=10/s)
 *   --resume            (skip MED_IDs já em details file)
 *   --filter=ervp       ("ervp" = cross-match com Produto ERP em Outros Medicamentos;
 *                        "all" = todos; default "ervp")
 *
 * Uso:
 *   npx tsx scripts/fetch-details-by-medid.ts                 # default: cross-match ERP
 *   npx tsx scripts/fetch-details-by-medid.ts --filter=all    # universo todo
 *   npx tsx scripts/fetch-details-by-medid.ts --limit=100     # smoke test
 *   npx tsx scripts/fetch-details-by-medid.ts --parallel=5    # mais agressivo
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  parseInfomedDetailHtml,
  InfomedFetchError,
  InfomedParseError,
  type InfomedDetailResult,
} from "../lib/regulatory-sources/infarmed-detail-page";
import { legacyPrisma as prisma } from "../lib/prisma";

const BASE = "https://extranet.infarmed.pt/INFOMED-fo";
const DETAIL_URL = `${BASE}/detalhes-medicamento.xhtml`;
const LISTAGEM_FILE = path.resolve("scripts/data/infomed-listagem.json");
const DETAILS_FILE = path.resolve("scripts/data/infomed-listagem-details.json");
const USER_AGENT =
  "Mozilla/5.0 (compatible; SPharm.MT/1.0; +https://github.com/spharm-mt) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_PARALLEL = 3;
const DEFAULT_RATE_LIMIT_MS = 300;

type Args = {
  parallel: number;
  rateLimitMs: number;
  resume: boolean;
  limit: number | null;
  filter: "ervp" | "all";
  dryRun: boolean;
};

function parseArgs(): Args {
  const out: Args = {
    parallel: DEFAULT_PARALLEL,
    rateLimitMs: DEFAULT_RATE_LIMIT_MS,
    resume: false,
    limit: null,
    filter: "ervp",
    dryRun: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--resume") out.resume = true;
    else if (a.startsWith("--parallel=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 1 && n <= 10) out.parallel = n;
    } else if (a.startsWith("--rate-limit-ms=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 50) out.rateLimitMs = n;
    } else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else if (a.startsWith("--filter=")) {
      const v = a.split("=")[1];
      if (v === "all" || v === "ervp") out.filter = v;
      else console.warn(`[aviso] --filter inválido: ${v}; usar default ervp`);
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

type ListagemEntry = {
  medId: number;
  nome: string;
  dci: string;
  forma: string;
  dosagem: string;
  titular: string;
  estado: string;
};

type ListagemFile = {
  rows: ListagemEntry[];
};

type DetailRecord = {
  medId: number;
  fetchedAt: string;
  // From listagem
  nomeListagem: string;
  // From detail page
  designacaoOficial: string | null;
  dci: string | null;
  codigoATC: string | null;
  codigosAtcAll: string[];
  formaFarmaceutica: string | null;
  dosagem: string | null;
  titularAim: string | null;
  grupoTerapeutico: string | null;
  numeroProcesso: string | null;
  generico: boolean | null;
  classificacaoDispensa: string | null;
  viasAdministracao: string[];
  embalagens: Array<{ cnp: number; descricao: string | null; comercializacao: string | null }>;
  // Diagnostics
  htmlBytes: number;
  error: string | null;
};

type DetailsFile = {
  version: "1";
  lastUpdate: string;
  source: "infomed_detail_by_medid";
  stats: {
    medIdsTotal: number;
    detailFetched: number;
    withAtc: number;
    withDci: number;
    withEmbalagens: number;
    failed: number;
    elapsedMs: number;
    totalCnpsCollected: number;
  };
  details: Record<string, DetailRecord>;
};

function emptyDetails(): DetailsFile {
  return {
    version: "1",
    lastUpdate: new Date().toISOString(),
    source: "infomed_detail_by_medid",
    stats: {
      medIdsTotal: 0,
      detailFetched: 0,
      withAtc: 0,
      withDci: 0,
      withEmbalagens: 0,
      failed: 0,
      elapsedMs: 0,
      totalCnpsCollected: 0,
    },
    details: {},
  };
}

function loadDetails(): DetailsFile {
  if (!fs.existsSync(DETAILS_FILE)) return emptyDetails();
  try {
    const d = JSON.parse(fs.readFileSync(DETAILS_FILE, "utf-8")) as DetailsFile;
    if (d.version !== "1") return emptyDetails();
    return d;
  } catch {
    return emptyDetails();
  }
}

function saveAtomic(d: DetailsFile, dryRun: boolean) {
  if (dryRun) return;
  d.lastUpdate = new Date().toISOString();
  fs.mkdirSync(path.dirname(DETAILS_FILE), { recursive: true });
  const tmp = `${DETAILS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DETAILS_FILE);
}

// ─── HTTP fetcher ─────────────────────────────────────────────────────────────

async function fetchDetailByMedId(medId: number): Promise<InfomedDetailResult> {
  const url = `${DETAIL_URL}?med_id=${medId}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      },
      signal: ac.signal,
    });
  } catch (err) {
    throw new InfomedFetchError(
      `Network: ${err instanceof Error ? err.message : String(err)}`,
      null,
      url,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new InfomedFetchError(`HTTP ${resp.status}`, resp.status, url);
  }
  const html = await resp.text();
  return parseInfomedDetailHtml(html, String(medId), url);
}

// ─── Worker pool ──────────────────────────────────────────────────────────────

async function workerLoop(
  workerId: number,
  queue: ListagemEntry[],
  details: DetailsFile,
  args: Args,
  state: { processed: number; lastSavedAt: number },
): Promise<void> {
  while (true) {
    const entry = queue.shift();
    if (!entry) return;
    const medIdStr = String(entry.medId);
    if (args.resume && details.details[medIdStr] && !details.details[medIdStr].error) {
      continue;
    }

    const t0 = Date.now();
    let record: DetailRecord;
    try {
      const r = await fetchDetailByMedId(entry.medId);
      record = {
        medId: entry.medId,
        fetchedAt: new Date().toISOString(),
        nomeListagem: entry.nome,
        designacaoOficial: r.designacaoOficial,
        dci: r.dci,
        codigoATC: r.codigoATC,
        codigosAtcAll: r.codigosAtcAll,
        formaFarmaceutica: r.formaFarmaceutica,
        dosagem: r.dosagem,
        titularAim: r.titularAim,
        grupoTerapeutico: r.grupoTerapeutico,
        numeroProcesso: r.numeroProcesso,
        generico: r.generico,
        classificacaoDispensa: r.classificacaoDispensa,
        viasAdministracao: r.viasAdministracao,
        embalagens: r.embalagens.map((e) => ({
          cnp: e.cnp,
          descricao: e.descricao,
          comercializacao: e.comercializacao,
        })),
        htmlBytes: r.raw.htmlBytes,
        error: null,
      };
    } catch (err) {
      record = {
        medId: entry.medId,
        fetchedAt: new Date().toISOString(),
        nomeListagem: entry.nome,
        designacaoOficial: null,
        dci: null,
        codigoATC: null,
        codigosAtcAll: [],
        formaFarmaceutica: null,
        dosagem: null,
        titularAim: null,
        grupoTerapeutico: null,
        numeroProcesso: null,
        generico: null,
        classificacaoDispensa: null,
        viasAdministracao: [],
        embalagens: [],
        htmlBytes: 0,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      };
    }

    details.details[medIdStr] = record;
    state.processed++;
    const elapsedReq = Date.now() - t0;

    // Log a cada 25 records ou nos primeiros 10
    if (state.processed <= 10 || state.processed % 25 === 0) {
      const atc = record.codigoATC ?? "—";
      const cnps = record.embalagens.length;
      console.log(
        `  [w${workerId} #${state.processed}] medId=${entry.medId} "${entry.nome.slice(0, 30)}" ATC=${atc} CNPs=${cnps} ${record.error ? `[ERR ${record.error.slice(0, 30)}]` : ""}  (${elapsedReq}ms)`,
      );
    }

    // Checkpoint a cada 30s
    if (Date.now() - state.lastSavedAt > 30_000) {
      saveAtomic(details, args.dryRun);
      state.lastSavedAt = Date.now();
    }

    // Rate limit per-worker
    if (args.rateLimitMs > 0) {
      await new Promise((r) => setTimeout(r, args.rateLimitMs));
    }
  }
}

// ─── ERP cross-match ──────────────────────────────────────────────────────────

async function getErpRelevantNames(): Promise<Set<string>> {
  // Cross-match: nomes (lowercased + first word) de produtos MEDICAMENTO em Outros Medicamentos
  // não-validados manualmente. O cross-match é loose: comparamos primeiro token
  // do designacao do ERP com primeiro token do nome INFOMED.
  const outros = await prisma.classificacao.findFirst({
    where: { tipo: "NIVEL_2", nome: { equals: "Outros Medicamentos", mode: "insensitive" } },
    select: { id: true },
  });
  if (!outros) return new Set();

  const produtos = await prisma.produto.findMany({
    where: {
      productType: "MEDICAMENTO",
      estado: { not: "INATIVO" },
      classificacaoNivel2Id: outros.id,
      validadoManualmente: false,
    },
    select: { designacao: true },
  });
  const keys = new Set<string>();
  for (const p of produtos) {
    const firstTok = (p.designacao ?? "").trim().split(/[\s,]/)[0]?.toLowerCase();
    if (firstTok && firstTok.length >= 3) keys.add(firstTok);
  }
  return keys;
}

function filterListagemByErpRelevance(rows: ListagemEntry[], erpKeys: Set<string>): ListagemEntry[] {
  return rows.filter((r) => {
    const firstTok = r.nome.trim().split(/[\s,]/)[0]?.toLowerCase();
    return firstTok && erpKeys.has(firstTok);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const t0 = Date.now();
  console.log("─".repeat(74));
  console.log("INFOMED Fetch Details by MED_ID — parallel HTTP-only");
  console.log("─".repeat(74));
  console.log(`  filter:       ${args.filter}`);
  console.log(`  parallel:     ${args.parallel}`);
  console.log(`  rateLimitMs:  ${args.rateLimitMs}`);
  console.log(`  resume:       ${args.resume}`);
  console.log(`  limit:        ${args.limit ?? "(no limit)"}`);
  console.log(`  dryRun:       ${args.dryRun}`);

  // Carregar listagem
  if (!fs.existsSync(LISTAGEM_FILE)) {
    console.error(`[fatal] listagem file não existe: ${LISTAGEM_FILE}`);
    process.exit(1);
  }
  const listagem = JSON.parse(fs.readFileSync(LISTAGEM_FILE, "utf-8")) as ListagemFile;
  console.log(`\n[1] Listagem carregada: ${listagem.rows.length} rows`);

  // Filter
  let queue: ListagemEntry[];
  if (args.filter === "ervp") {
    console.log(`[2] Cross-match com ERP (Outros Medicamentos)...`);
    const erpKeys = await getErpRelevantNames();
    console.log(`    ERP keys distintas: ${erpKeys.size}`);
    queue = filterListagemByErpRelevance(listagem.rows, erpKeys);
    console.log(`    Cross-match listagem: ${queue.length} de ${listagem.rows.length} (${((queue.length / listagem.rows.length) * 100).toFixed(1)}%)`);
  } else {
    queue = [...listagem.rows];
    console.log(`[2] Sem filtro — processar todos os ${queue.length}`);
  }

  if (args.limit !== null) {
    queue = queue.slice(0, args.limit);
    console.log(`    Limit aplicado: ${queue.length}`);
  }

  // Resume: skip já feitos
  const details = args.resume ? loadDetails() : emptyDetails();
  if (args.resume) {
    const alreadyDone = new Set(Object.keys(details.details).filter((k) => !details.details[k].error));
    queue = queue.filter((e) => !alreadyDone.has(String(e.medId)));
    console.log(`    Resume: ${alreadyDone.size} já feitos; restam ${queue.length}`);
  }

  details.stats.medIdsTotal = queue.length;
  console.log(`\n[3] Lançar ${args.parallel} workers para ${queue.length} MED_IDs...`);

  const state = { processed: 0, lastSavedAt: Date.now() };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < args.parallel; i++) {
    workers.push(workerLoop(i + 1, queue, details, args, state));
  }
  await Promise.all(workers);

  // Final stats
  const allRecords = Object.values(details.details);
  details.stats.detailFetched = allRecords.filter((r) => !r.error).length;
  details.stats.withAtc = allRecords.filter((r) => r.codigoATC).length;
  details.stats.withDci = allRecords.filter((r) => r.dci).length;
  details.stats.withEmbalagens = allRecords.filter((r) => r.embalagens.length > 0).length;
  details.stats.failed = allRecords.filter((r) => r.error).length;
  details.stats.totalCnpsCollected = allRecords.reduce((s, r) => s + r.embalagens.length, 0);
  details.stats.elapsedMs = Date.now() - t0;
  saveAtomic(details, args.dryRun);

  console.log("\n" + "─".repeat(74));
  console.log("RESUMO");
  console.log("─".repeat(74));
  console.log(`  total processados:   ${state.processed}`);
  console.log(`  com ATC:             ${details.stats.withAtc}`);
  console.log(`  com DCI:             ${details.stats.withDci}`);
  console.log(`  com embalagens:      ${details.stats.withEmbalagens}`);
  console.log(`  total CNPs:          ${details.stats.totalCnpsCollected}`);
  console.log(`  falhas:              ${details.stats.failed}`);
  console.log(`  elapsed:             ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  rate:                ${(state.processed / Math.max(1, (Date.now() - t0) / 1000)).toFixed(2)}/s`);
  console.log(`  output:              ${DETAILS_FILE}`);
  console.log(`  mode:                ${args.dryRun ? "DRY-RUN" : "LIVE"}`);
  console.log("─".repeat(74));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[fatal]", err);
  await prisma.$disconnect();
  process.exit(1);
});
