/**
 * scripts/browse-infomed-listagem.ts
 *
 * P9 Fase 1 — Browse INFOMED listagem completa via HTTP-only pagination.
 *
 * Substitui o approach search-by-CNP como caminho primário. Enumera todos
 * os medicamentos autorizados+comercializados do INFOMED (~9656) via:
 *
 *   1. GET  index.xhtml             → JSESSIONID
 *   2. GET  pesquisa-avancada.xhtml → ViewState do form de pesquisa avançada
 *   3. POST btnDoSearch (empty)     → page 1, total 9656
 *   4. POST pagination para N pages → cada page com 10 rows
 *
 * Para cada row extrai: MED_ID, nome, DCI, forma, dosagem, titular, estado.
 *
 * Output:
 *   scripts/data/infomed-listagem.json
 *
 * Resume: se o ficheiro existir, retoma do último page processado.
 *
 * Uso:
 *   npx tsx scripts/browse-infomed-listagem.ts
 *   npx tsx scripts/browse-infomed-listagem.ts --dry-run        (não escreve)
 *   npx tsx scripts/browse-infomed-listagem.ts --limit-pages=10 (smoke test)
 *   npx tsx scripts/browse-infomed-listagem.ts --resume
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";

const BASE = "https://extranet.infarmed.pt/INFOMED-fo";
const INDEX_URL = `${BASE}/index.xhtml`;
const PESQ_URL = `${BASE}/pesquisa-avancada.xhtml`;
const OUT_FILE = path.resolve("scripts/data/infomed-listagem.json");
const USER_AGENT =
  "Mozilla/5.0 (compatible; SPharm.MT/1.0; +https://github.com/spharm-mt) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 30_000;
const ROWS_PER_PAGE = 10;
const DEFAULT_RATE_LIMIT_MS = 500;

type Args = {
  dryRun: boolean;
  resume: boolean;
  limitPages: number | null;
  rateLimitMs: number;
};

function parseArgs(): Args {
  const out: Args = { dryRun: false, resume: false, limitPages: null, rateLimitMs: DEFAULT_RATE_LIMIT_MS };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--resume") out.resume = true;
    else if (a.startsWith("--limit-pages=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limitPages = n;
    } else if (a.startsWith("--rate-limit-ms=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 100) out.rateLimitMs = n;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

type ListagemRow = {
  medId: number;
  nome: string;
  dci: string;
  forma: string;
  dosagem: string;
  titular: string;
  estado: string;
};

type ListagemFile = {
  version: "1";
  lastUpdate: string;
  source: "infomed_pesquisa_avancada_browse";
  stats: {
    pagesProcessed: number;
    rowsExtracted: number;
    uniqueMedIds: number;
    failedPages: number;
    elapsedMs: number;
    totalPagesExpected: number | null;
  };
  rows: ListagemRow[];
  failedPageOffsets: number[];
};

function emptyFile(): ListagemFile {
  return {
    version: "1",
    lastUpdate: new Date().toISOString(),
    source: "infomed_pesquisa_avancada_browse",
    stats: {
      pagesProcessed: 0,
      rowsExtracted: 0,
      uniqueMedIds: 0,
      failedPages: 0,
      elapsedMs: 0,
      totalPagesExpected: null,
    },
    rows: [],
    failedPageOffsets: [],
  };
}

function loadFile(): ListagemFile {
  if (!fs.existsSync(OUT_FILE)) return emptyFile();
  try {
    const data = JSON.parse(fs.readFileSync(OUT_FILE, "utf-8")) as ListagemFile;
    if (data.version !== "1") return emptyFile();
    return data;
  } catch {
    return emptyFile();
  }
}

function saveAtomic(data: ListagemFile, dryRun: boolean): void {
  if (dryRun) return;
  data.lastUpdate = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, OUT_FILE);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function parseJsessionid(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /JSESSIONID=([^;]+)/.exec(setCookie);
  return m ? m[1] : null;
}

function extractViewState(html: string): string | null {
  const m = /name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

async function sleep(ms: number) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

// ─── Session bootstrap ───────────────────────────────────────────────────────

async function bootstrapSession(): Promise<{ jsessionid: string; viewState: string }> {
  // GET index.xhtml para obter JSESSIONID
  const r1 = await timedFetch(INDEX_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
    },
    redirect: "manual",
  });
  if (!r1.ok && r1.status !== 302) {
    throw new Error(`bootstrap GET index.xhtml HTTP ${r1.status}`);
  }
  const jsessionid = parseJsessionid(r1.headers.get("set-cookie"));
  if (!jsessionid) throw new Error("sem JSESSIONID em set-cookie");
  await r1.text(); // drain body

  // GET pesquisa-avancada.xhtml para obter ViewState
  const r2 = await timedFetch(PESQ_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      Cookie: `JSESSIONID=${jsessionid}`,
    },
  });
  if (!r2.ok) throw new Error(`bootstrap GET pesquisa-avancada HTTP ${r2.status}`);
  const html = await r2.text();
  const viewState = extractViewState(html);
  if (!viewState) throw new Error("sem ViewState em pesquisa-avancada");
  return { jsessionid, viewState };
}

// ─── POST btnDoSearch (page 1) ────────────────────────────────────────────────

/**
 * Constrói os 42 campos do form `mainForm` em pesquisa-avancada exactamente
 * como o browser envia. JSF requer que TODOS os inputs do form sejam enviados
 * (mesmo vazios) para a validação server-side passar e a search executar.
 * Capturado da v2 spike de um submit Playwright bem-sucedido (Bayer → 85 results).
 *
 * Sem isto, o server retorna "0 registos" mesmo com filtros default activos.
 */
function buildMainFormParams(overrides: Record<string, string> = {}): URLSearchParams {
  const fields: Record<string, string> = {
    "mainForm:dci_input": "",
    "mainForm:ff_focus": "",
    "mainForm:ff_input": "",
    "mainForm:dosagem_input": "",
    "mainForm:medicamento_input": "",
    "mainForm:taim_input": "",
    "mainForm:num-processo": "",
    "mainForm:vias-admin_focus": "",
    "mainForm:vias-admin_input": "",
    "mainForm:grupo-produto_focus": "",
    "mainForm:grupo-produto_input": "",
    "mainForm:generico_focus": "",
    "mainForm:generico_input": "",
    "mainForm:numero-registro": "",
    "mainForm:cnpem": "",
    "mainForm:chnm": "",
    "mainForm:margem-terap_focus": "",
    "mainForm:margem-terap_input": "",
    "mainForm:monit-adicional_focus": "",
    "mainForm:monit-adicional_input": "",
    "mainForm:exist-docs-mmr_focus": "",
    "mainForm:exist-docs-mmr_input": "",
    "mainForm:estado-aim_focus": "",
    "mainForm:estado-aim_input": "REF_EST_AIM:001", // default: Autorizado
    "mainForm:estado-aim-de_input": "",
    "mainForm:estado-aim-a_input": "",
    "mainForm:estado-comercializacao_focus": "",
    "mainForm:estado-comercializacao_input": "REF_EST_COMERC:001", // default: Comercializado
    "mainForm:classif-dispensa_focus": "",
    "mainForm:classif-dispensa_input": "",
    "mainForm:classif-farmacoterapeutica_focus": "",
    "mainForm:classif-farmacoterapeutica_input": "",
    "mainForm:classif-atc_focus": "",
    "mainForm:classif-atc_input": "",
    "mainForm:dt-medicamentos_rppDD": String(ROWS_PER_PAGE),
  };
  Object.assign(fields, overrides);
  const params = new URLSearchParams();
  // Order matches browser capture
  params.set("javax.faces.partial.ajax", "true");
  params.set("javax.faces.source", "mainForm:btnDoSearch");
  params.set("javax.faces.partial.execute", "mainForm:pnlCriterios mainForm:btnDoSearch");
  params.set(
    "javax.faces.partial.render",
    "messages minLenghtMessage mainForm:dt-medicamentos mainForm:dg-medicamentos mainForm:overlay-msg-erros mainForm:btnDoSearch mainForm:btnDoClear mainForm:lblQuantidadeRegistros",
  );
  params.set("mainForm:btnDoSearch", "mainForm:btnDoSearch");
  params.set("mainForm", "mainForm");
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  return params;
}

async function submitInitialSearch(
  jsessionid: string,
  viewState: string,
): Promise<{ rows: ListagemRow[]; total: number; viewState: string }> {
  const params = buildMainFormParams();
  params.set("javax.faces.ViewState", viewState);

  const res = await timedFetch(PESQ_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Faces-Request": "partial/ajax",
      "X-Requested-With": "XMLHttpRequest",
      Cookie: `JSESSIONID=${jsessionid}`,
      Origin: "https://extranet.infarmed.pt",
      Referer: PESQ_URL,
    },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`btnDoSearch HTTP ${res.status}`);
  const body = await res.text();

  // DEBUG: dump body if env var set
  if (process.env.SPHARM_DEBUG_BROWSE) {
    fs.writeFileSync(path.resolve("scripts/data/spike-pesquisa-avancada-v4/debug-initial-body.xml"), body);
    console.log(`    [debug] initial body bytes=${body.length}, dumped to debug-initial-body.xml`);
  }

  const rows = parseRowsFromPartialResponse(body);
  const total = parseTotalFromBody(body);
  const newViewState = extractViewStateFromPartial(body) ?? viewState;
  return { rows, total, viewState: newViewState };
}

// ─── POST pagination (page N) ────────────────────────────────────────────────

async function fetchPage(
  jsessionid: string,
  viewState: string,
  offset: number,
): Promise<{ rows: ListagemRow[]; viewState: string }> {
  // Para pagination, source/execute/render são diferentes (alvo é só a datatable)
  // Mas os 35 campos do form continuam a ter de ser enviados para JSF validar state.
  const params = buildMainFormParams();
  // Override os campos AJAX para "page" event em vez de "btnDoSearch"
  params.set("javax.faces.source", "mainForm:dt-medicamentos");
  params.set("javax.faces.partial.execute", "mainForm:dt-medicamentos");
  params.set("javax.faces.partial.render", "mainForm:dt-medicamentos");
  params.set("javax.faces.behavior.event", "page");
  params.set("javax.faces.partial.event", "page");
  params.delete("mainForm:btnDoSearch");
  params.set("mainForm:dt-medicamentos_pagination", "true");
  params.set("mainForm:dt-medicamentos_first", String(offset));
  params.set("mainForm:dt-medicamentos_rows", String(ROWS_PER_PAGE));
  params.set("mainForm:dt-medicamentos_encodeFeature", "true");
  params.set("javax.faces.ViewState", viewState);

  const res = await timedFetch(PESQ_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Faces-Request": "partial/ajax",
      "X-Requested-With": "XMLHttpRequest",
      Cookie: `JSESSIONID=${jsessionid}`,
      Origin: "https://extranet.infarmed.pt",
      Referer: PESQ_URL,
    },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`pagination offset=${offset} HTTP ${res.status}`);
  const body = await res.text();
  // DEBUG: dump primeira page-2 para inspecção
  if (process.env.SPHARM_DEBUG_BROWSE && offset === ROWS_PER_PAGE) {
    fs.writeFileSync(path.resolve("scripts/data/spike-pesquisa-avancada-v4/debug-page2-body.xml"), body);
    console.log(`    [debug] page 2 body bytes=${body.length} → debug-page2-body.xml`);
  }
  const rows = parseRowsFromPartialResponse(body);
  const newViewState = extractViewStateFromPartial(body) ?? viewState;
  return { rows, viewState: newViewState };
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function extractViewStateFromPartial(body: string): string | null {
  // Em partial-response, ViewState aparece como <update id="...:javax.faces.ViewState..."><![CDATA[...]]></update>
  const m = /<update[^>]*id="[^"]*javax\.faces\.ViewState[^"]*"[^>]*>(?:<!\[CDATA\[)?([^<\]]+)/.exec(body);
  return m ? m[1].trim() : null;
}

function parseTotalFromBody(body: string): number {
  // Procura no body de update da datatable um texto tipo "de um total de 9656 registos"
  const m = /de um total de\s+(\d+)\s+registos/i.exec(body);
  return m ? parseInt(m[1], 10) : 0;
}

function parseRowsFromPartialResponse(body: string): ListagemRow[] {
  // O partial-response envolve o HTML da datatable em CDATA dentro de <update id="mainForm:dt-medicamentos">
  // Extrair o conteúdo CDATA primeiro
  const updateMatch = /<update[^>]*id="[^"]*dt-medicamentos"[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/update>/i.exec(
    body,
  );
  let html = updateMatch ? updateMatch[1] : body;
  // Desentidar HTML entities básicas
  html = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

  // Wrap em <table> para o parser HTML aceitar <tr> soltos (cenário de pagination
  // partial-response em que o update id="...dt-medicamentos" devolve só <tr>s).
  // Page 1 inclui <table> completo; page 2+ devolve apenas rows.
  const wrapped = /<table\b/i.test(html) ? html : `<table><tbody>${html}</tbody></table>`;
  const $ = cheerio.load(wrapped);
  const rows: ListagemRow[] = [];
  // Strip script/style content (PrimeFaces inclui muito JS inline) antes de extrair text
  $("script, style").remove();
  $("tr[data-ri]").each((_i, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 8) return;
    const medIdStr = $(cells[0]).text().trim();
    const medId = parseInt(medIdStr, 10);
    if (!Number.isFinite(medId)) return;
    // Nome: o link <a id="...:linkNome"> tem o texto limpo
    const linkNome = $(cells[1]).find('a[id$=":linkNome"]').first();
    const nome = (linkNome.length > 0 ? linkNome.text() : $(cells[1]).text())
      .trim()
      .replace(/\s+/g, " ");
    const dci = $(cells[2]).text().trim().replace(/\s+/g, " ");
    const forma = $(cells[3]).text().trim().replace(/\s+/g, " ");
    const dosagem = $(cells[4]).text().trim().replace(/\s+/g, " ");
    const titular = $(cells[5]).text().trim().replace(/\s+/g, " ");
    // Estado: cell index 7 (cell 6 é comercializacao icon)
    const estado = $(cells[7]).text().trim().replace(/\s+/g, " ");
    rows.push({ medId, nome, dci, forma, dosagem, titular, estado });
  });
  return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const t0 = Date.now();
  console.log("─".repeat(74));
  console.log("INFOMED Listagem Browse — HTTP-only pagination");
  console.log("─".repeat(74));
  console.log(`  dryRun:        ${args.dryRun}`);
  console.log(`  resume:        ${args.resume}`);
  console.log(`  limitPages:    ${args.limitPages ?? "(no limit)"}`);
  console.log(`  rateLimitMs:   ${args.rateLimitMs}`);
  console.log(`  outFile:       ${OUT_FILE}`);

  const file = args.resume ? loadFile() : emptyFile();
  const seenMedIds = new Set(file.rows.map((r) => r.medId));
  let pagesDone = file.stats.pagesProcessed;
  let rowsTotal = file.stats.rowsExtracted;
  let failedPages = file.stats.failedPages;

  console.log(`\n[1] Bootstrap session...`);
  const { jsessionid, viewState: vsInitial } = await bootstrapSession();
  console.log(`    JSESSIONID:   ${jsessionid.slice(0, 30)}...`);
  console.log(`    ViewState:    ${vsInitial.slice(0, 40)}...`);

  let currentVS = vsInitial;
  let totalExpected = file.stats.totalPagesExpected ?? 0;
  let totalRegistos = 0;

  // Page 1 — sempre via btnDoSearch (mesmo em resume — para refresh ViewState)
  console.log(`\n[2] Submit initial (page 1)...`);
  const initial = await submitInitialSearch(jsessionid, currentVS);
  currentVS = initial.viewState;
  totalRegistos = initial.total;
  totalExpected = Math.ceil(totalRegistos / ROWS_PER_PAGE);
  console.log(`    total registos:    ${totalRegistos}`);
  console.log(`    pages expected:    ${totalExpected}`);
  console.log(`    page 1 rows:       ${initial.rows.length}`);
  if (initial.rows.length > 0) {
    console.log(`    sample row:        medId=${initial.rows[0].medId}  "${initial.rows[0].nome}"`);
  }

  // Inserir page 1 (substitui no resume — sempre re-fetched)
  if (!args.resume || pagesDone === 0) {
    for (const r of initial.rows) {
      if (!seenMedIds.has(r.medId)) {
        seenMedIds.add(r.medId);
        file.rows.push(r);
      }
    }
    pagesDone = 1;
    rowsTotal = file.rows.length;
  }
  file.stats.totalPagesExpected = totalExpected;

  // Pages 2..N
  const pagesPlanned = args.limitPages ? Math.min(totalExpected, args.limitPages) : totalExpected;
  const startPage = Math.max(2, pagesDone + 1);
  console.log(`\n[3] Paginating pages ${startPage}..${pagesPlanned}`);

  let lastCheckpointAt = Date.now();
  for (let pageNum = startPage; pageNum <= pagesPlanned; pageNum++) {
    const offset = (pageNum - 1) * ROWS_PER_PAGE;
    await sleep(args.rateLimitMs);

    try {
      const { rows, viewState: vs } = await fetchPage(jsessionid, currentVS, offset);
      currentVS = vs;
      let newRows = 0;
      for (const r of rows) {
        if (!seenMedIds.has(r.medId)) {
          seenMedIds.add(r.medId);
          file.rows.push(r);
          newRows++;
        }
      }
      pagesDone++;
      rowsTotal = file.rows.length;
      file.stats.pagesProcessed = pagesDone;
      file.stats.rowsExtracted = rowsTotal;
      file.stats.uniqueMedIds = seenMedIds.size;
      file.stats.elapsedMs = Date.now() - t0;

      const elapsed = (Date.now() - t0) / 1000;
      const rate = pagesDone / Math.max(1, elapsed);
      const eta = (pagesPlanned - pagesDone) / Math.max(0.001, rate);
      if (pageNum % 20 === 0 || pageNum === pagesPlanned || pageNum <= 5) {
        console.log(
          `    page ${String(pageNum).padStart(4)}/${pagesPlanned}  rows=+${newRows}  total=${rowsTotal}  rate=${rate.toFixed(2)}/s  eta=${(eta / 60).toFixed(1)}min`,
        );
      }
      // Checkpoint a cada 50 pages
      if (Date.now() - lastCheckpointAt > 30_000 || pageNum % 50 === 0) {
        saveAtomic(file, args.dryRun);
        lastCheckpointAt = Date.now();
      }
    } catch (err) {
      failedPages++;
      file.failedPageOffsets.push(offset);
      file.stats.failedPages = failedPages;
      console.warn(
        `    page ${pageNum} (offset=${offset}) FALHOU: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Em caso de erro grave, tentar refresh do ViewState via bootstrap
      if (err instanceof Error && /HTTP\s+(50\d|40[13])/i.test(err.message)) {
        console.warn(`    a refresh session em 5s...`);
        await sleep(5000);
        const fresh = await bootstrapSession();
        // Não esquecer: nova sessão precisa nova page 1
        const reInit = await submitInitialSearch(fresh.jsessionid, fresh.viewState);
        currentVS = reInit.viewState;
        // jsessionid NÃO é actualizado aqui — let-binding. Vamos sair do loop e descartar
        console.warn(`    [aviso] nova sessão criada — sessão antiga ${jsessionid.slice(0, 10)}... descartada; reinicia o script`);
        break;
      }
    }
  }

  // Save final
  file.stats.pagesProcessed = pagesDone;
  file.stats.rowsExtracted = file.rows.length;
  file.stats.uniqueMedIds = seenMedIds.size;
  file.stats.failedPages = failedPages;
  file.stats.elapsedMs = Date.now() - t0;
  saveAtomic(file, args.dryRun);

  console.log("\n" + "─".repeat(74));
  console.log("RESUMO");
  console.log("─".repeat(74));
  console.log(`  pages processed:     ${pagesDone}/${pagesPlanned}`);
  console.log(`  rows extracted:      ${file.rows.length}`);
  console.log(`  med_ids únicos:      ${seenMedIds.size}`);
  console.log(`  failed pages:        ${failedPages}`);
  console.log(`  elapsed:             ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  rate:                ${(pagesDone / Math.max(1, (Date.now() - t0) / 1000)).toFixed(2)} pages/s`);
  console.log(`  output:              ${OUT_FILE}`);
  console.log(`  mode:                ${args.dryRun ? "DRY-RUN (no write)" : "LIVE"}`);
  console.log("─".repeat(74));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
