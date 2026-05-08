/**
 * lib/regulatory-sources/infomed-search-resolver.ts
 *
 * Resolver HTTP-only do INFOMED para mapear CNP/designação → detail page.
 *
 * Implementa a sequência completa de 5 passos validada na investigação
 * Phase 1B (ver `notes/infomed-investigation.md`):
 *
 *   1. GET  index.xhtml                    → JSESSIONID + ViewState
 *   2. POST index.xhtml (submit lupa)       → <redirect/> XML
 *   3. GET  pesquisa-avancada.xhtml         → listagem com 0-N candidatos
 *   4. POST pesquisa-avancada (click row)   → <redirect/> XML, server selecciona med
 *   5. GET  detalhes-medicamento.xhtml      → detail page (resolvido via sessão)
 *
 * ZERO Playwright. Usa fetch + cheerio. Cada session é serial — o server
 * usa state-da-sessão para tracking, portanto NÃO paralelizar dentro de
 * uma sessão. Múltiplas sessões em paralelo são OK (cada uma tem o seu
 * JSESSIONID).
 *
 * Limites operacionais:
 *   - ≥1.5s rate limit entre requests do MESMO session (defensive)
 *   - Cada session faz typicamente 5+ requests para resolver 1 CNP
 *   - Throughput estimado: ~3-4s por CNP single-threaded
 */

import * as cheerio from "cheerio";
import {
  parseInfomedDetailHtml,
  type InfomedDetailResult,
  InfomedFetchError,
  InfomedParseError,
} from "./infarmed-detail-page";

// ─── Constantes ───────────────────────────────────────────────────────────────

const BASE_URL = "https://extranet.infarmed.pt/INFOMED-fo";
const INDEX_URL = `${BASE_URL}/index.xhtml`;
const PESQ_URL = `${BASE_URL}/pesquisa-avancada.xhtml`;
const DETAIL_URL = `${BASE_URL}/detalhes-medicamento.xhtml`;

const USER_AGENT =
  "Mozilla/5.0 (compatible; SPharm.MT/1.0; +https://github.com/spharm-mt) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 30_000;

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type SearchSession = {
  /** Cookie JSESSIONID inicializado no Step 1 GET index.xhtml. */
  jsessionid: string;
  /** ViewState do index.xhtml — usado em Step 2 (submit lupa). */
  indexViewState: string;
};

export type SearchResultRow = {
  rowIndex: number;
  medId: string;
  nome: string;
  dci: string;
  formaFarmaceutica: string;
  dosagem: string;
  titularAim: string;
};

export type SearchListagem = {
  rows: SearchResultRow[];
  /** ViewState da pesquisa-avancada — usado em Step 4 (click row). */
  pesquisaViewState: string;
};

export type ResolveOptions = {
  /** ms a esperar entre requests no mesmo session (defensive rate limit). */
  rateLimitMs: number;
  /** máximo de rows a fetch (cada row = +1 round-trip). default: 3 */
  maxCandidatesToFetch: number;
  /**
   * Sessão pré-existente para reusar. Se não passada, cria fresh.
   * Em modo session-reuse, o caller mantém uma sessão por N searches
   * antes de rotacionar (poupa GET index.xhtml e reduz pressão anti-bot).
   */
  session?: SearchSession;
};

export type ResolveOutcome =
  | {
      kind: "matched_strong";
      cnp: number;
      detail: InfomedDetailResult;
      matchedRow: SearchResultRow;
      candidatesEvaluated: number;
    }
  | {
      kind: "ambiguous";
      cnp: number;
      matchedRowsWithDetail: Array<{ row: SearchResultRow; detail: InfomedDetailResult }>;
      candidatesEvaluated: number;
    }
  | {
      kind: "not_found";
      cnp: number;
      reason: "no_results" | "no_cnp_match";
      rowsTotal: number;
      candidatesEvaluated: number;
    }
  | {
      kind: "failed";
      cnp: number;
      error: string;
      stage: "session" | "search" | "click" | "detail";
    };

export class InfomedSearchError extends Error {
  constructor(
    message: string,
    public stage: "session" | "search" | "click" | "detail",
    public httpStatus: number | null,
  ) {
    super(message);
    this.name = "InfomedSearchError";
  }
}

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────

function parseSetCookieJsessionid(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const m = /JSESSIONID=([^;]+)/.exec(setCookieHeader);
  return m ? m[1] : null;
}

function extractViewState(html: string): string | null {
  const m = /name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Step 1: GET index.xhtml ──────────────────────────────────────────────────

export async function startSearchSession(): Promise<SearchSession> {
  let res: Response;
  try {
    res = await timedFetch(INDEX_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      },
      redirect: "manual",
    });
  } catch (err) {
    throw new InfomedSearchError(
      `network error: ${err instanceof Error ? err.message : String(err)}`,
      "session",
      null,
    );
  }
  if (!res.ok && res.status !== 302) {
    throw new InfomedSearchError(`HTTP ${res.status}`, "session", res.status);
  }
  const setCookie = res.headers.get("set-cookie");
  const jsessionid = parseSetCookieJsessionid(setCookie);
  const html = await res.text();
  const viewState = extractViewState(html);
  if (!jsessionid) {
    throw new InfomedSearchError("sem JSESSIONID em Set-Cookie", "session", res.status);
  }
  if (!viewState) {
    throw new InfomedSearchError(
      "sem javax.faces.ViewState no HTML — anti-bot pode estar a bloquear",
      "session",
      res.status,
    );
  }
  return { jsessionid, indexViewState: viewState };
}

/**
 * Refresca o ViewState da `index.xhtml` REUSANDO o JSESSIONID actual.
 * Não cria nova sessão server-side — só obtém um ViewState fresco para
 * a próxima search no mesmo session.
 *
 * Lança InfomedSearchError em 503/erro — caller decide se rota para
 * nova sessão ou backoff.
 */
export async function refreshIndexViewState(jsessionid: string): Promise<string> {
  let res: Response;
  try {
    res = await timedFetch(INDEX_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        Cookie: `JSESSIONID=${jsessionid}`,
      },
      redirect: "manual",
    });
  } catch (err) {
    throw new InfomedSearchError(
      `refresh network error: ${err instanceof Error ? err.message : String(err)}`,
      "session",
      null,
    );
  }
  if (!res.ok && res.status !== 302) {
    throw new InfomedSearchError(
      `refresh HTTP ${res.status}`,
      "session",
      res.status,
    );
  }
  const html = await res.text();
  const viewState = extractViewState(html);
  if (!viewState) {
    throw new InfomedSearchError(
      "sem ViewState no refresh — sessão pode ter expirado",
      "session",
      res.status,
    );
  }
  return viewState;
}

// ─── Steps 2 + 3: submit + parse listagem ─────────────────────────────────────

export async function searchByDesignacao(
  session: SearchSession,
  term: string,
): Promise<SearchListagem> {
  if (!term || !term.trim()) {
    throw new InfomedSearchError("termo de pesquisa vazio", "search", null);
  }

  // Step 2: POST submit lupa
  const submitParams = new URLSearchParams();
  submitParams.set("javax.faces.partial.ajax", "true");
  submitParams.set("javax.faces.source", "mainForm:ajax");
  submitParams.set("javax.faces.partial.execute", "@all");
  submitParams.set("javax.faces.partial.render", "mainForm:messages+mainForm:nomesMessage");
  submitParams.set("mainForm:ajax", "mainForm:ajax");
  submitParams.set("mainForm", "mainForm");
  submitParams.set("mainForm:acMinLength_input", term);
  submitParams.set("mainForm:acMinLength_hinput", term);
  submitParams.set("mainForm:chkAutorizadoComercializado_input", "on");
  submitParams.set("javax.faces.ViewState", session.indexViewState);

  let r2: Response;
  try {
    r2 = await timedFetch(INDEX_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Faces-Request": "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: `JSESSIONID=${session.jsessionid}`,
        Origin: "https://extranet.infarmed.pt",
        Referer: INDEX_URL,
      },
      body: submitParams.toString(),
      redirect: "manual",
    });
  } catch (err) {
    throw new InfomedSearchError(
      `submit network error: ${err instanceof Error ? err.message : String(err)}`,
      "search",
      null,
    );
  }
  if (r2.status !== 200) {
    throw new InfomedSearchError(`submit HTTP ${r2.status}`, "search", r2.status);
  }
  const r2Body = await r2.text();
  // Servidor responde com <partial-response> sempre. Quando há resultados,
  // contém <redirect url="pesquisa-avancada.xhtml"/>. Quando o termo não
  // tem resultados, devolve apenas <update> com mensagens, sem redirect.
  // Tratamos isso como "no results" (não falha) — caller decide.
  if (!/<redirect/i.test(r2Body)) {
    return { rows: [], pesquisaViewState: "" };
  }

  // Step 3: GET pesquisa-avancada.xhtml
  let r3: Response;
  try {
    r3 = await timedFetch(PESQ_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        Cookie: `JSESSIONID=${session.jsessionid}`,
        Referer: INDEX_URL,
      },
    });
  } catch (err) {
    throw new InfomedSearchError(
      `pesquisa-avancada GET error: ${err instanceof Error ? err.message : String(err)}`,
      "search",
      null,
    );
  }
  if (!r3.ok) {
    throw new InfomedSearchError(`pesquisa-avancada HTTP ${r3.status}`, "search", r3.status);
  }
  const r3Html = await r3.text();
  const pesquisaViewState = extractViewState(r3Html);
  if (!pesquisaViewState) {
    throw new InfomedSearchError(
      "sem ViewState em pesquisa-avancada.xhtml",
      "search",
      r3.status,
    );
  }

  const rows = parseListagem(r3Html);
  return { rows, pesquisaViewState };
}

/**
 * Parse o HTML da pesquisa-avancada.xhtml e devolve as linhas da
 * datatable `mainForm:dt-medicamentos`. Cada linha tem:
 *   <td hidden>medId</td>
 *   <td><a id="...:linkNome">Nome</a></td>
 *   <td>DCI</td>
 *   <td>Forma Farmacêutica</td>
 *   <td>Dosagem</td>
 *   <td>Titular AIM</td>
 *   <td>Comercialização icon</td>
 *   <td hidden>estAimSort</td>
 *   <td>Documentos icons</td>
 */
function parseListagem(html: string): SearchResultRow[] {
  const $ = cheerio.load(html);
  const rows: SearchResultRow[] = [];
  $("#mainForm\\:dt-medicamentos_data > tr[data-ri]").each((_, tr) => {
    const $tr = $(tr);
    const ri = parseInt($tr.attr("data-ri") ?? "", 10);
    if (!Number.isFinite(ri)) return;
    const tds = $tr.find("> td");
    const medId = tds.eq(0).text().trim();
    const nome = tds.eq(1).find("a").first().text().trim() || tds.eq(1).text().trim();
    const dci = tds.eq(2).text().trim();
    const forma = tds.eq(3).text().trim();
    const dosagem = tds.eq(4).text().trim();
    const titular = tds.eq(5).text().trim();
    rows.push({
      rowIndex: ri,
      medId,
      nome,
      dci,
      formaFarmaceutica: forma,
      dosagem,
      titularAim: titular,
    });
  });
  return rows;
}

// ─── Steps 4 + 5: click row + session-based detail fetch ──────────────────────

export async function clickRowAndFetchDetail(
  session: SearchSession,
  listagem: SearchListagem,
  rowIndex: number,
): Promise<InfomedDetailResult> {
  // Step 4: POST click linkNome
  const clickParams = new URLSearchParams();
  clickParams.set("javax.faces.partial.ajax", "true");
  clickParams.set("javax.faces.source", `mainForm:dt-medicamentos:${rowIndex}:linkNome`);
  clickParams.set("javax.faces.partial.execute", `mainForm:dt-medicamentos:${rowIndex}:linkNome`);
  clickParams.set("mainForm", "mainForm");
  clickParams.set(
    `mainForm:dt-medicamentos:${rowIndex}:linkNome`,
    `mainForm:dt-medicamentos:${rowIndex}:linkNome`,
  );
  clickParams.set("javax.faces.ViewState", listagem.pesquisaViewState);

  let r4: Response;
  try {
    r4 = await timedFetch(PESQ_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Faces-Request": "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: `JSESSIONID=${session.jsessionid}`,
        Origin: "https://extranet.infarmed.pt",
        Referer: PESQ_URL,
      },
      body: clickParams.toString(),
      redirect: "manual",
    });
  } catch (err) {
    throw new InfomedSearchError(
      `click row network error: ${err instanceof Error ? err.message : String(err)}`,
      "click",
      null,
    );
  }
  if (r4.status !== 200) {
    throw new InfomedSearchError(`click row HTTP ${r4.status}`, "click", r4.status);
  }
  const r4Body = await r4.text();
  if (!/<redirect/i.test(r4Body)) {
    throw new InfomedSearchError(
      `click row response sem <redirect/> — body: ${r4Body.slice(0, 200)}`,
      "click",
      r4.status,
    );
  }

  // Step 5: GET detalhes-medicamento.xhtml (server resolves via session)
  let r5: Response;
  try {
    r5 = await timedFetch(DETAIL_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        Cookie: `JSESSIONID=${session.jsessionid}`,
        Referer: PESQ_URL,
      },
    });
  } catch (err) {
    throw new InfomedSearchError(
      `detail GET network error: ${err instanceof Error ? err.message : String(err)}`,
      "detail",
      null,
    );
  }
  if (!r5.ok) {
    throw new InfomedSearchError(`detail HTTP ${r5.status}`, "detail", r5.status);
  }
  const r5Html = await r5.text();

  // Reusa o parser existente. medGuid é desconhecido em flow session-based;
  // passamos o nome como id estável (o consumer pode optar por substituir).
  // O parser usa medGuid apenas para mensagens de erro.
  try {
    return parseInfomedDetailHtml(r5Html, "session-resolved", DETAIL_URL);
  } catch (err) {
    if (err instanceof InfomedParseError || err instanceof InfomedFetchError) {
      throw new InfomedSearchError(`detail parse: ${err.message}`, "detail", r5.status);
    }
    throw err;
  }
}

// ─── Match logic ──────────────────────────────────────────────────────────────

/**
 * Normaliza dosagem para comparação. Ex.:
 *   "3.75 Mg/2 Ml" → "3.75 mg/2 ml"
 *   "0,1 mg/ml"    → "0.1 mg/ml"
 */
function normalizeDosagem(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .trim();
}

/**
 * Extrai um dosage hint da designacao. Ex.:
 *   "Decapeptyl 3.75 Mg/2 Ml Pó..." → "3.75mg/2ml"
 */
function extractDosagemFromDesignacao(designacao: string): string | null {
  const m = designacao.match(
    /\b(\d+[\.,]?\d*\s*(?:mg|mcg|µg|g|ml|ui|iu|%)(?:\s*\/\s*\d*\.?\d*\s*(?:mg|ml|g|l))?)/i,
  );
  return m ? normalizeDosagem(m[1]) : null;
}

/**
 * Normaliza a designacao para o termo de pesquisa: tira dosagem, embalagem
 * e quantidade, mantém só o nome do medicamento + DCI. Idêntico ao
 * normalizeForSearch da iteração Playwright.
 */
export function normalizeForSearch(designacao: string): string {
  let s = designacao;
  s = s.replace(
    /\b\d+[\.,]?\d*\s*(?:mg|mcg|µg|g|ml|ui|iu|meq|mmol|%)\b(?:\s*\/\s*(?:ml|g|mg|l))?/gi,
    "",
  );
  s = s.replace(
    /\bx?\s*\d+\s*(?:comp(?:rimidos?)?|caps(?:ulas?)?|amp|sol|susp|gota|emul|gran|sticks?|sache|saqueta|unidade\(?s?\)?)\b/gi,
    "",
  );
  s = s.replace(/\b\d+\s*(?:unidade\(?s?\)?|cápsulas?|c[áa]ps|comprimidos?|comp)\b/gi, "");
  s = s.replace(
    /\b(?:comp|caps|sol|susp|emul|bisn|amp|gel|cr|cre|cremes?|p[oó]|inj|injet[aá]vel|veg|gota[s]?|aliv|forte|adulto|infant)\b/gi,
    "",
  );
  s = s.replace(/[,;\/\\]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  const tokens = s.split(/\s+/).filter((t) => t.length >= 2);
  return tokens.slice(0, 5).join(" ");
}

/**
 * Ordena rows por similaridade ao designacao alvo. Usa dosagem extraída
 * como tie-breaker forte: se a designacao tiver "3.75 mg/2 ml" e uma row
 * tiver dosagem "3.75 mg/2 ml" → essa row vai primeiro.
 */
export function rankCandidates(
  rows: SearchResultRow[],
  designacao: string,
): SearchResultRow[] {
  const targetDose = extractDosagemFromDesignacao(designacao);
  return [...rows].sort((a, b) => {
    if (targetDose) {
      const aMatch = normalizeDosagem(a.dosagem) === targetDose;
      const bMatch = normalizeDosagem(b.dosagem) === targetDose;
      if (aMatch && !bMatch) return -1;
      if (bMatch && !aMatch) return 1;
    }
    // Tie-breaker: nome mais simples (sem qualifiers) primeiro
    return a.nome.length - b.nome.length;
  });
}

// ─── High-level orchestration ─────────────────────────────────────────────────

/**
 * Resolve um CNP via pesquisa por designacao. Faz a sequência completa
 * de 5 passos e devolve um outcome com força de match.
 *
 * Strong match: o detail page de UMA das rows contém o CNP nas embalagens.
 * Ambiguous: múltiplas rows têm o CNP (deveria ser raro mas é safe-default).
 * Not found: nenhuma row tem o CNP (CNP pode ser non-medicamento).
 *
 * Pause de `rateLimitMs` entre cada step interno.
 */
export async function resolveCnpViaDesignacaoSearch(
  cnp: number,
  designacao: string,
  opts: ResolveOptions,
): Promise<ResolveOutcome> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let session: SearchSession;
  try {
    if (opts.session) {
      session = opts.session;
    } else {
      session = await startSearchSession();
    }
  } catch (err) {
    return {
      kind: "failed",
      cnp,
      error: err instanceof Error ? err.message : String(err),
      stage: "session",
    };
  }
  await sleep(opts.rateLimitMs);

  const term = normalizeForSearch(designacao);
  if (!term) {
    return { kind: "not_found", cnp, reason: "no_results", rowsTotal: 0, candidatesEvaluated: 0 };
  }

  let listagem: SearchListagem;
  try {
    listagem = await searchByDesignacao(session, term);
  } catch (err) {
    return {
      kind: "failed",
      cnp,
      error: err instanceof Error ? err.message : String(err),
      stage: "search",
    };
  }
  if (listagem.rows.length === 0) {
    return { kind: "not_found", cnp, reason: "no_results", rowsTotal: 0, candidatesEvaluated: 0 };
  }
  await sleep(opts.rateLimitMs);

  // Rank candidates por dosagem match — alvo provável fica primeiro
  const ranked = rankCandidates(listagem.rows, designacao);
  const toEvaluate = ranked.slice(0, opts.maxCandidatesToFetch);

  // Step 4 + 5: fetch detail para cada candidato e verificar CNP
  const matches: Array<{ row: SearchResultRow; detail: InfomedDetailResult }> = [];
  let evaluated = 0;
  for (const row of toEvaluate) {
    evaluated++;
    let detail: InfomedDetailResult;
    try {
      detail = await clickRowAndFetchDetail(session, listagem, row.rowIndex);
    } catch (err) {
      // Erro num candidato — continuar para o próximo
      console.warn(
        `  [resolve cnp=${cnp}] candidato row=${row.rowIndex} (${row.nome}) falhou: ${err instanceof Error ? err.message.slice(0, 100) : err}`,
      );
      await sleep(opts.rateLimitMs);
      continue;
    }
    if (detail.embalagens.some((e) => e.cnp === cnp)) {
      matches.push({ row, detail });
    }
    await sleep(opts.rateLimitMs);
  }

  if (matches.length === 1) {
    return {
      kind: "matched_strong",
      cnp,
      detail: matches[0].detail,
      matchedRow: matches[0].row,
      candidatesEvaluated: evaluated,
    };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      cnp,
      matchedRowsWithDetail: matches,
      candidatesEvaluated: evaluated,
    };
  }
  return {
    kind: "not_found",
    cnp,
    reason: "no_cnp_match",
    rowsTotal: listagem.rows.length,
    candidatesEvaluated: evaluated,
  };
}
