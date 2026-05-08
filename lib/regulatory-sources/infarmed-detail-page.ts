/**
 * lib/regulatory-sources/infarmed-detail-page.ts
 *
 * Fetcher para a página de detalhe do INFOMED:
 *   https://extranet.infarmed.pt/INFOMED-fo/detalhes-medicamento.xhtml?med_guid=<id>
 *
 * Input:  med_guid (UUID/hash que identifica um medicamento no INFARMED)
 * Output: campos clínicos canónicos + lista de CNPs/embalagens.
 *
 * HTTP directo (sem Playwright) — a página de detalhe é HTML estático
 * acessível via GET com User-Agent declarado. Pesquisa por nome ou CNP
 * é OUTRO problema (browser automation) — fora do scope deste módulo.
 *
 * Parser: Cheerio (jQuery-like). A estrutura PrimeFaces 7.0 é altamente
 * regular — pares `<label>FieldName:</label><label class="...labelTexto">
 * Value</label>` em panelGrid. IDs estáveis para campos críticos:
 *   detalheMedNomeMed   → Nome do medicamento
 *   atcId               → datatable de códigos ATC
 *   cftId               → datatable de Classificação Farmacoterapêutica
 *   viasAdm             → datatable de Vias de Administração
 *   dispId              → datatable de classificação de dispensa (MSRM/MNSRM)
 *
 * Os `j_idtNNN` mudam entre versões do JSF — não usar como âncora. Usar
 * apenas IDs explícitos e os nomes de campo (texto do label).
 *
 * Rate limit: caller responsibility. Convenção sugerida: ≥1.5s entre
 * requests, User-Agent SPharm.MT identificável.
 *
 * Política de erros:
 *   · HTTP non-2xx → throw FetchError
 *   · HTML parsing fail → throw ParseError
 *   · Campos opcionais ausentes → null no resultado (não fail)
 *   · Sem campos minimos (nome OU dci OU atc) → throw ParseError
 *
 * NUNCA usar este módulo em código de produção sem rate limiter no caller.
 */

import * as cheerio from "cheerio";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type InfomedDetailResult = {
  medGuid: string;
  designacaoOficial: string;
  dci: string | null;
  codigoATC: string | null;
  /** Lista completa de ATCs (alguns medicamentos têm múltiplos). Primeiro = principal. */
  codigosAtcAll: string[];
  formaFarmaceutica: string | null;
  dosagem: string | null;
  titularAim: string | null;
  estadoAim: string | null;
  grupoTerapeutico: string | null;
  /** Lista completa de classificações farmacoterapêuticas. Primeira = principal. */
  gruposTerapeuticosAll: string[];
  numeroProcesso: string | null;
  /** "Sim" / "Não" / null. */
  generico: boolean | null;
  /** "MSRM" / "MNSRM" / null se não-categorizado. */
  classificacaoDispensa: string | null;
  /** Lista de Vias de Administração ("Via oral", "Via subcutânea", etc.). */
  viasAdministracao: string[];
  /** Apresentações com CNP, embalagem, e estado de comercialização. */
  embalagens: InfomedEmbalagem[];
  /** Snapshot bruto para audit/debug. */
  raw: {
    fetchedAt: string;
    sourceUrl: string;
    htmlBytes: number;
  };
};

export type InfomedEmbalagem = {
  cnp: number;
  /** Texto descritivo da embalagem, ex: "Frasco 30 unidades". */
  descricao: string | null;
  /** "Comercializado" | "Não Comercializado" | null. */
  comercializacao: string | null;
};

export class InfomedFetchError extends Error {
  constructor(message: string, public httpStatus: number | null, public url: string) {
    super(message);
    this.name = "InfomedFetchError";
  }
}

export class InfomedParseError extends Error {
  constructor(message: string, public medGuid: string) {
    super(message);
    this.name = "InfomedParseError";
  }
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const BASE_URL = "https://extranet.infarmed.pt/INFOMED-fo";
const DETAIL_PATH = "/detalhes-medicamento.xhtml";

const USER_AGENT =
  "Mozilla/5.0 (compatible; SPharm.MT/1.0; +https://github.com/spharm-mt) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;

// ─── Fetch + parse ────────────────────────────────────────────────────────────

/**
 * Faz fetch da página de detalhe do INFOMED e devolve o resultado parsed.
 * NÃO aplica rate limiting — caller responsável.
 *
 * @throws InfomedFetchError em HTTP não-2xx ou timeout
 * @throws InfomedParseError quando a página não tem campos mínimos
 */
export async function fetchInfomedDetail(medGuid: string): Promise<InfomedDetailResult> {
  if (!medGuid || !/^[a-zA-Z0-9-]+$/.test(medGuid)) {
    throw new InfomedFetchError(`med_guid inválido: ${JSON.stringify(medGuid)}`, null, "");
  }

  const url = `${BASE_URL}${DETAIL_PATH}?med_guid=${encodeURIComponent(medGuid)}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      },
      signal: ac.signal,
    });
  } catch (err) {
    throw new InfomedFetchError(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
      null,
      url,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new InfomedFetchError(
      `HTTP ${response.status} ${response.statusText}`,
      response.status,
      url,
    );
  }

  const html = await response.text();
  return parseInfomedDetailHtml(html, medGuid, url);
}

/**
 * Parse uma resposta HTML de `detalhes-medicamento.xhtml` para o resultado
 * canónico. Exposto separadamente para permitir testes com fixtures.
 */
export function parseInfomedDetailHtml(
  html: string,
  medGuid: string,
  sourceUrl: string,
): InfomedDetailResult {
  const $ = cheerio.load(html);

  // ── Nome (designacaoOficial) ──────────────────────────────────────
  // ID estável: #detalheMedNomeMed
  const designacaoOficial = textOf($, "#detalheMedNomeMed");
  if (!designacaoOficial) {
    throw new InfomedParseError(
      `Página sem #detalheMedNomeMed — provavelmente não é uma página de detalhe válida`,
      medGuid,
    );
  }

  // ── Campos label-pair ────────────────────────────────────────────
  const dci = labelPairValue($, "Substância Ativa/DCI:");
  const formaFarmaceutica = labelPairValue($, "Forma Farmacêutica:");
  const dosagem = labelPairValue($, "Dosagem:");
  const titularAim = labelPairValue($, "Titular de AIM:");
  const numeroProcesso = labelPairValue($, "Número de Processo:");
  const genericoText = labelPairValue($, "Genérico:");
  const generico = genericoText === "Sim" ? true : genericoText === "Não" ? false : null;

  // ── ATC (datatable id=atcId, possivelmente múltiplos) ────────────
  // Formato: "G04CA52 - tamsulosin and dutasteride"
  const codigosAtcAll = $("#atcId .ui-datagrid-data .ui-datagrid-row .labelTexto")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((s) => s.length > 0);
  const codigoATC = codigosAtcAll[0]
    ? extractAtcCode(codigosAtcAll[0])
    : null;

  // ── Classificação Farmacoterapêutica (datatable id=cftId) ────────
  // Formato: "7.4.2.1 - Medicamentos usados na retenção urinária"
  const gruposTerapeuticosAll = $("#cftId .ui-datagrid-data .ui-datagrid-row .labelTexto")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((s) => s.length > 0);
  const grupoTerapeutico = gruposTerapeuticosAll[0] ?? null;

  // ── Vias de Administração (datatable id=viasAdm) ─────────────────
  const viasAdministracao = $("#viasAdm .ui-datagrid-data .ui-datagrid-row .labelTexto")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((s) => s.length > 0);

  // ── Estado AIM ────────────────────────────────────────────────────
  // Aparece em vários sítios; o mais fiável é via texto livre que o JSF
  // expõe perto de "Autorizado em: <data>" ou via uma label dedicada.
  // Fallback: procurar palavras-chave isoladas.
  const estadoAim = extractEstadoAim($);

  // ── Classificação Dispensa (MSRM/MNSRM) ───────────────────────────
  const classificacaoDispensa = extractClassificacaoDispensa($);

  // ── Embalagens / CNPs ─────────────────────────────────────────────
  const embalagens = extractEmbalagens($);

  // Sanity: produto deve ter pelo menos nome + (dci OU atc OU embalagens)
  if (!dci && !codigoATC && embalagens.length === 0) {
    throw new InfomedParseError(
      `Página sem dci/atc/embalagens — parser failure ou página corrupta`,
      medGuid,
    );
  }

  return {
    medGuid,
    designacaoOficial,
    dci,
    codigoATC,
    codigosAtcAll,
    formaFarmaceutica,
    dosagem,
    titularAim,
    estadoAim,
    grupoTerapeutico,
    gruposTerapeuticosAll,
    numeroProcesso,
    generico,
    classificacaoDispensa,
    viasAdministracao,
    embalagens,
    raw: {
      fetchedAt: new Date().toISOString(),
      sourceUrl,
      htmlBytes: html.length,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function textOf($: cheerio.CheerioAPI, selector: string): string | null {
  const el = $(selector);
  if (el.length === 0) return null;
  const text = el.text().trim();
  return text.length > 0 ? text : null;
}

/**
 * Encontra um label cujo texto é exactamente `labelText` (ex: "Dosagem:"),
 * e devolve o texto da label seguinte com classe `labelTexto`. Os pares
 * estão lado a lado em panelGrid:
 *   <label>FieldName:</label>  <label class="...labelTexto">Value</label>
 */
function labelPairValue($: cheerio.CheerioAPI, labelText: string): string | null {
  let result: string | null = null;
  $("label").each((_, el) => {
    if (result !== null) return false; // first match wins
    const $el = $(el);
    if ($el.text().trim() !== labelText) return undefined;
    // Procurar o próximo label.labelTexto no DOM (next sibling, ou dentro do
    // ancestor próximo). PrimeFaces usa panelGrid em ui-g divs.
    let candidate = $el.parent().next().find("label.labelTexto").first();
    if (candidate.length === 0) {
      // Fallback: procurar globalmente o próximo label.labelTexto após este
      candidate = $el.nextAll("label.labelTexto").first();
    }
    if (candidate.length === 0) {
      // Último fallback — primeiro label.labelTexto que aparece após el no DOM
      let after = false;
      $("label").each((_, l) => {
        const $l = $(l);
        if (after && $l.hasClass("labelTexto")) {
          candidate = $l;
          return false;
        }
        if (l === el) after = true;
      });
    }
    const text = candidate.text().trim();
    if (text.length > 0) result = text;
    return undefined;
  });
  return result;
}

/**
 * Extrai o código ATC de uma string formatada "G04CA52 - tamsulosin and
 * dutasteride". Devolve a forma mais comprida válida (5 níveis):
 *   L1: A         (1 char — anatomia)
 *   L2: A10       (3 chars — grupo terapêutico)
 *   L3: A10B      (4 chars — subgrupo terapêutico/farmacológico)
 *   L4: A10BA     (5 chars — subgrupo químico)
 *   L5: A10BA02   (7 chars — substância)
 *
 * As alternativas estão ordenadas mais comprida primeiro para garantir
 * greedy match. Devolve null se não bater regex ATC.
 */
export function extractAtcCode(raw: string): string | null {
  const trimmed = raw.trim();
  const m = /^([A-V]\d{2}[A-Z]{2}\d{2}|[A-V]\d{2}[A-Z]{2}|[A-V]\d{2}[A-Z]|[A-V]\d{2}|[A-V])/.exec(
    trimmed,
  );
  if (!m) return null;
  return m[1];
}

function extractEstadoAim($: cheerio.CheerioAPI): string | null {
  // Tentativa 1 — via labelPair se o JSF expõe "Estado:" / "Estado AIM:"
  const direct = labelPairValue($, "Estado:") ?? labelPairValue($, "Estado AIM:");
  if (direct) return normalizeEstado(direct);

  // Tentativa 2 — texto livre no card "Autorizado em: dd/mm/yyyy"
  const html = $.html();
  const knownStates = ["Autorizado", "Suspenso", "Revogado", "Caducado", "Descontinuado"];
  for (const state of knownStates) {
    if (html.includes(`${state} em:`) || html.includes(`>${state}<`)) {
      return state;
    }
  }
  return null;
}

function normalizeEstado(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("autoriz")) return "Autorizado";
  if (s.includes("suspens")) return "Suspenso";
  if (s.includes("revog")) return "Revogado";
  if (s.includes("caduc")) return "Caducado";
  if (s.includes("descontinuad")) return "Descontinuado";
  return raw.trim();
}

function extractClassificacaoDispensa($: cheerio.CheerioAPI): string | null {
  // O datatable #dispId contém a classificação. Cada row tem um label
  // visível ("MSRM" ou "MNSRM") + um ícone com tooltip.
  const dispText = $("#dispId .ui-datagrid-data .labelTexto")
    .map((_, el) => $(el).text().trim())
    .get()
    .find((s) => /MSRM|MNSRM/.test(s));
  if (dispText) return dispText.match(/MSRM|MNSRM/)?.[0] ?? null;

  // Fallback — procurar pelo tooltip ou texto livre
  const html = $.html();
  if (/Medicamento sujeito a receita médica/i.test(html)) return "MSRM";
  if (/Medicamento não sujeito a receita médica/i.test(html)) return "MNSRM";
  return null;
}

/**
 * Extrai a lista de embalagens (CNP + descrição + estado comercialização).
 *
 * Estrutura no HTML:
 *   <div class="embalagem-main-panel">
 *     <div class="ui-panelgrid-header ...">
 *       <div class="ui-panel ... card-header-comercializado">  (ou card-header-nao-comercializado)
 *         <span class="btn btn-link">Frasco</span>           ← tipo
 *         <span class="btn btn-link">30 unidade(s)</span>    ← quantidade
 *         <span class="text-card-header">Comercializado</span>  ← estado
 *     <div class="ui-panelgrid-content">
 *       <span>5286570</span>  (após "Número de Registo:")    ← CNP
 *
 * A página tem DUAS versões do carousel (big e mobile-form) com os mesmos
 * dados — usar Map por CNP para deduplicar.
 */
function extractEmbalagens($: cheerio.CheerioAPI): InfomedEmbalagem[] {
  const found = new Map<number, InfomedEmbalagem>();

  $(".embalagem-main-panel").each((_, panelEl) => {
    const $panel = $(panelEl);

    // CNP — procurar o span após "Número de Registo:" label
    let cnp: number | null = null;
    $panel.find("label").each((_, labelEl) => {
      if (cnp !== null) return false;
      const $label = $(labelEl);
      if ($label.text().trim() === "Número de Registo:") {
        // Próximo span (ou seguinte div com .col-value > span)
        const valueEl =
          $label.parent().next().find("span").first().length > 0
            ? $label.parent().next().find("span").first()
            : $label.nextAll("span").first();
        const text = valueEl.text().trim();
        const n = Number(text.replace(/[^\d]/g, ""));
        if (Number.isFinite(n) && n > 2_000_000) cnp = n;
      }
      return undefined;
    });

    // Fallback: regex no panel text
    if (cnp === null) {
      const m = /\b(\d{7})\b/.exec($panel.text());
      if (m) {
        const n = Number(m[1]);
        if (n > 2_000_000) cnp = n;
      }
    }
    if (cnp === null) return undefined;

    // Tipo + quantidade — primeiros 2 spans .btn.btn-link no header
    const headerLinks = $panel.find(".btn.btn-link");
    const tipo = headerLinks.eq(0).text().trim();
    const quantidade = headerLinks.eq(1).text().trim();
    const descricao =
      [tipo, quantidade].filter((s) => s.length > 0).join(" ") || null;

    // Comercialização — text-card-header
    let comercializacao: string | null = null;
    const headerStatus = $panel.find(".text-card-header").first().text().trim();
    if (headerStatus.length > 0) {
      comercializacao = /n[aã]o\s*comercializ/i.test(headerStatus)
        ? "Não Comercializado"
        : /comercializ/i.test(headerStatus)
          ? "Comercializado"
          : headerStatus;
    } else {
      // Fallback via classe CSS
      const headerDiv = $panel.find(".ui-panelgrid-header > .ui-panel").first();
      if (headerDiv.hasClass("card-header-nao-comercializado")) {
        comercializacao = "Não Comercializado";
      } else if (headerDiv.hasClass("card-header-comercializado")) {
        comercializacao = "Comercializado";
      }
    }

    // Insere/funde — preserva non-null em re-passes (carousel-big vs mobile)
    const existing = found.get(cnp);
    if (existing) {
      found.set(cnp, {
        cnp,
        descricao: existing.descricao ?? descricao,
        comercializacao: existing.comercializacao ?? comercializacao,
      });
    } else {
      found.set(cnp, { cnp, descricao, comercializacao });
    }
    return undefined;
  });

  return [...found.values()].sort((a, b) => a.cnp - b.cnp);
}
