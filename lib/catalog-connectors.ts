/**
 * lib/catalog-connectors.ts
 *
 * Conectores externos para o pipeline de verificação do catálogo SPharm.MT.
 *
 * Cada conector é independente e devolve ExternalSourceData normalizado.
 * NENHUM conector actualiza directamente a base de dados.
 *
 * Estado actual:
 *   internal_pharmacy_data  → ACTIVO  (lê ProdutoFarmacia.*Origem)
 *   infarmed                → STUB    (aguarda endpoint / credenciais INFARMED)
 *   open_beauty_facts       → STUB    (aguarda integração Open Beauty Facts)
 *   open_food_facts         → STUB    (aguarda integração Open Food Facts)
 *   eudamed                 → STUB    (aguarda acesso EUDAMED)
 *
 * Para activar um stub: implementar o corpo de lookup() e remover o comentário
 * "TODO". O contrato de retorno (ExternalSourceData) não muda.
 */

import { legacyPrisma as prisma } from "@/lib/prisma";
import type {
  ExternalLookupRequest,
  ExternalSourceData,
  ProductType,
} from "./catalog-types";

// ─── Interface do conector ────────────────────────────────────────────────────

export interface ExternalConnector {
  readonly name: string;
  lookup(req: ExternalLookupRequest): Promise<ExternalSourceData | null>;
}

// ─── Fonte interna — ProdutoFarmacia.*Origem ──────────────────────────────────

/**
 * Conector interno — NÃO devolve fabricante.
 *
 * O campo `fornecedorOrigem` em ProdutoFarmacia contém o grossista/distribuidor
 * habitual (Empifarma, OCP, Alliance, …), NÃO o titular da AIM nem o fabricante
 * real. Este conector nunca devolve `fabricante` para evitar contaminar o
 * catálogo mestre. O valor do fornecedor serve apenas como:
 *   - sinal de coerência interna (concordância multi-farmácia)
 *   - contexto para análise de abastecimento (fora deste pipeline)
 *
 * O que este conector devolve:
 *   - categoria / subcategoria  (seguras, vêm da taxonomia do ERP da farmácia)
 *
 * O que NUNCA devolve:
 *   - fabricante   → exige tier REGULATORY ou MANUFACTURER
 *   - principioAtivo / atc / dosagem / forma farmacêutica / embalagem  →
 *     exigem fontes regulamentares (INFARMED) ou fabricante
 */
const internalPharmacyConnector: ExternalConnector = {
  name: "internal_pharmacy_data",

  async lookup(req): Promise<ExternalSourceData | null> {
    const records = await prisma.produtoFarmacia.findMany({
      where: { produtoId: req.productId },
      select: {
        fornecedorOrigem: true,
        categoriaOrigem: true,
        subcategoriaOrigem: true,
        familiaOrigem: true,
      },
    });

    if (records.length === 0) return null;

    // Fornecedor: usado apenas para medir coerência interna (não é devolvido)
    const fornFreq = new Map<string, number>();
    for (const r of records) {
      if (r.fornecedorOrigem) {
        fornFreq.set(r.fornecedorOrigem, (fornFreq.get(r.fornecedorOrigem) ?? 0) + 1);
      }
    }
    const topForn = fornFreq.size > 0
      ? [...fornFreq.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : null;
    const fornAgreement = topForn ? (fornFreq.get(topForn) ?? 0) : 0;

    // Categoria: prioridade categoriaOrigem → familiaOrigem
    const catFreq = new Map<string, number>();
    for (const r of records) {
      const cat = r.categoriaOrigem ?? r.familiaOrigem;
      if (cat) catFreq.set(cat, (catFreq.get(cat) ?? 0) + 1);
    }
    const topCat = catFreq.size > 0
      ? [...catFreq.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : null;

    const topSubcat =
      records.find(r => r.subcategoriaOrigem !== null)?.subcategoriaOrigem ?? null;

    // Sem categoria → nada útil a devolver
    if (!topCat) return null;

    /**
     * Scoring (sem contribuição de fabricante — porque nunca é devolvido):
     *   base                              0.55
     *   + fornecedor consistente (≥2 farm)+0.05  (coerência interna, não escrita)
     *   + fornecedor presente (1 farm)    +0.02
     *   + categoria presente              +0.05
     *   + subcategoria presente           +0.05
     *   + bónus coerência cat+subcat      +0.05
     *
     *   cap 0.75 quando categoria + subcategoria presentes
     *   cap 0.70 caso contrário
     *
     * Casos típicos:
     *   único farm. + só categoria         → 0.60
     *   único farm. + cat + subcat         → 0.72 (0.55+0.02+0.05+0.05+0.05)
     *   multi farm. + cat + subcat         → 0.75 (cap)
     *
     * Máximo possível abaixo do THRESHOLD_AUTO (0.90). Escrita só pode ocorrer
     * em campos com THRESHOLD_PARTIAL (0.75) — evidência totalmente interna
     * nunca pode elevar um produto a VERIFIED, por design.
     */
    let confidence = 0.55;
    if (fornAgreement >= 2) confidence += 0.05;
    else if (topForn)        confidence += 0.02;
    if (topCat)              confidence += 0.05;
    if (topSubcat)           confidence += 0.05;

    const catCoherence = !!(topCat && topSubcat);
    if (catCoherence) confidence += 0.05;

    const cap = catCoherence ? 0.75 : 0.70;
    confidence = Math.min(confidence, cap);

    const coherenceNote = catCoherence ? " [cat+subcat]" : "";

    return {
      source: "internal_pharmacy_data",
      tier: "INTERNAL_INFERRED",
      matchedBy: "cnp",
      confidence,
      fabricante: null,          // NUNCA — fornecedor ≠ fabricante
      principioAtivo: null,
      atc: null,
      dosagem: null,
      embalagem: null,
      formaFarmaceutica: null,
      categoria: topCat,
      subcategoria: topSubcat,
      imagemUrl: null,
      notes: `Agregado de ${records.length} registo(s) ProdutoFarmacia${coherenceNote}`,
    };
  },
};

// ─── INFARMED / INFOMED ───────────────────────────────────────────────────────

/**
 * Conector INFARMED — lê do snapshot local em InfarmedSnapshot.
 *
 * Fonte: ficheiro oficial INFARMED (XLSX/CSV) importado via
 * `scripts/import-infarmed-snapshot.ts`. Consulta por CNP (chave primária
 * na BD oficial portuguesa de medicamentos).
 *
 * Tier: REGULATORY (primeira fonte autoritária disponível no pipeline)
 * Confidence: 0.95 (CNP match directo contra registo oficial)
 *
 * Regras de filtro:
 *  - Produtos com estadoAim ∈ {Suspenso, Revogado, Caducado} são ignorados
 *    (devolve null). Não queremos propagar medicamentos inactivos.
 *  - Sem snapshot → devolve null (pipeline degrada graciosamente).
 */
const infarmedConnector: ExternalConnector = {
  name: "infarmed",

  async lookup(req): Promise<ExternalSourceData | null> {
    if (!req.cnp) return null;

    const row = await prisma.infarmedSnapshot.findUnique({
      where: { cnp: req.cnp },
      select: {
        dci: true,
        codigoATC: true,
        titularAim: true,
        formaFarmaceutica: true,
        dosagem: true,
        embalagem: true,
        grupoTerapeutico: true,
        estadoAim: true,
        snapshotVersion: true,
      },
    });

    if (!row) return null;

    // Ignorar medicamentos não autorizados
    if (
      row.estadoAim &&
      ["Suspenso", "Revogado", "Caducado"].includes(row.estadoAim)
    ) {
      return null;
    }

    return {
      source: "infarmed",
      tier: "REGULATORY",
      matchedBy: "cnp",
      confidence: 0.95,
      fabricante: row.titularAim,        // Titular da AIM = fabricante canónico
      principioAtivo: row.dci,
      atc: row.codigoATC,
      dosagem: row.dosagem,
      embalagem: row.embalagem,
      formaFarmaceutica: row.formaFarmaceutica,
      categoria: row.grupoTerapeutico,
      subcategoria: null,
      imagemUrl: null,
      notes: `INFARMED snapshot ${row.snapshotVersion}${row.estadoAim ? ` · ${row.estadoAim}` : ""}`,
    };
  },
};

// ─── HTTP helper (rate-limited fetch) ─────────────────────────────────────────

const OPEN_FACTS_UA =
  "SPharm.MT/1.0 (catalog-enrichment; https://github.com/spharm-mt)";
const OPEN_FACTS_MIN_INTERVAL_MS = 1_100; // rate limit amigável (OFF/OBF)
const OPEN_FACTS_TIMEOUT_MS = 15_000;

let lastOpenFactsRequestAt = 0;

async function throttledFetchJson(url: string): Promise<unknown | null> {
  const now = Date.now();
  const wait = Math.max(0, OPEN_FACTS_MIN_INTERVAL_MS - (now - lastOpenFactsRequestAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastOpenFactsRequestAt = Date.now();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), OPEN_FACTS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": OPEN_FACTS_UA, Accept: "application/json" },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Text matching helpers ────────────────────────────────────────────────────

function stripAccentsLower(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(s: string): Set<string> {
  return new Set(
    stripAccentsLower(s)
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
  );
}

function jaccard(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 ? inter / union : 0;
}

// ─── Open Facts search (OFF / OBF / OPFF) ─────────────────────────────────────

type OpenFactsProduct = {
  product_name?: string;
  product_name_pt?: string;
  brands?: string;
  categories?: string;
  image_front_url?: string;
  image_url?: string;
  quantity?: string;
};

async function searchOpenFacts(baseUrl: string, query: string): Promise<OpenFactsProduct[]> {
  const url =
    `${baseUrl}/cgi/search.pl?search_terms=${encodeURIComponent(query)}` +
    `&search_simple=1&action=process&json=1&page_size=5`;
  const data = await throttledFetchJson(url);
  if (!data || typeof data !== "object") return [];
  const products = (data as { products?: OpenFactsProduct[] }).products;
  return Array.isArray(products) ? products : [];
}

function pickBestMatch(
  products: OpenFactsProduct[],
  designacao: string,
  minSimilarity = 0.35
): { product: OpenFactsProduct; similarity: number } | null {
  let best: { product: OpenFactsProduct; similarity: number } | null = null;
  for (const p of products) {
    const name = p.product_name_pt || p.product_name;
    if (!name) continue;
    const sim = jaccard(name, designacao);
    if (sim >= minSimilarity && (!best || sim > best.similarity)) {
      best = { product: p, similarity: sim };
    }
  }
  return best;
}

function toExternalSource(
  p: OpenFactsProduct,
  source: string,
  similarity: number,
  baseConfidence: number
): ExternalSourceData {
  // Confiança base * (1 + bónus por similaridade acima do mínimo)
  const confidence = Math.min(baseConfidence * (0.85 + similarity * 0.4), 0.85);
  const firstCategory = p.categories
    ? p.categories.split(",").pop()?.trim() ?? null
    : null;
  return {
    source,
    tier: "RETAIL",
    matchedBy: "designacao",
    confidence,
    // tier=RETAIL não é autoritário — fabricante nunca é aceite pela persistência
    // (AUTHORITATIVE_FIELDS em catalog-persistence.ts). Deixamos null para evitar
    // warnings desnecessários no log.
    fabricante: null,
    principioAtivo: null,
    atc: null,
    dosagem: null,
    embalagem: p.quantity ?? null,
    formaFarmaceutica: null,
    categoria: firstCategory,
    subcategoria: null,
    imagemUrl: p.image_front_url ?? p.image_url ?? null,
    notes: `${source} match "${p.product_name_pt || p.product_name}" sim=${similarity.toFixed(2)}`,
  };
}

// ─── Open Beauty Facts ────────────────────────────────────────────────────────

const openBeautyFactsConnector: ExternalConnector = {
  name: "open_beauty_facts",

  async lookup(req): Promise<ExternalSourceData | null> {
    if (!req.designacao) return null;
    const products = await searchOpenFacts(
      "https://world.openbeautyfacts.org",
      req.designacao
    );
    const best = pickBestMatch(products, req.designacao);
    if (!best) return null;
    return toExternalSource(best.product, "open_beauty_facts", best.similarity, 0.70);
  },
};

// ─── Open Food Facts ─────────────────────────────────────────────────────────

const openFoodFactsConnector: ExternalConnector = {
  name: "open_food_facts",

  async lookup(req): Promise<ExternalSourceData | null> {
    if (!req.designacao) return null;
    const products = await searchOpenFacts(
      "https://world.openfoodfacts.org",
      req.designacao
    );
    const best = pickBestMatch(products, req.designacao);
    if (!best) return null;
    return toExternalSource(best.product, "open_food_facts", best.similarity, 0.65);
  },
};

// ─── EUDAMED ─────────────────────────────────────────────────────────────────

const eudamedConnector: ExternalConnector = {
  name: "eudamed",

  async lookup(_req): Promise<ExternalSourceData | null> {
    // TODO: Integrar com EUDAMED (European Database on Medical Devices).
    //
    // Portal público: https://ec.europa.eu/tools/eudamed
    // API pública (quando disponível): https://ec.europa.eu/tools/eudamed/api
    // Alternativa: GMDN (Global Medical Device Nomenclature — gmdn.org)
    //
    // tier: "REGULATORY"   (registo oficial europeu)
    // confidence: 0.85
    return null;
  },
};

// ─── Retail Pharmacy (web search + OG / JSON-LD parsing) ─────────────────────
//
// Connector RETAIL genérico para produtos não-medicamento.
//
// Fluxo:
//   1. Pesquisa a designação do produto no DuckDuckGo HTML
//      (https://html.duckduckgo.com/html/?q=...) — sem JS, devolve HTML
//      simples com os resultados.
//   2. Para cada um dos primeiros N resultados, faz fetch da página e
//      extrai meta-dados standard Open Graph (og:title, og:image,
//      og:description) e, quando disponível, JSON-LD BreadcrumbList
//      para obter o caminho de categoria.
//   3. Escolhe a página cujo `og:title` tem maior similaridade Jaccard
//      com a designação. Rate-limited, timeout, never throws.
//
// Rate limit: 1 request / 1.5s (inclui a pesquisa + cada candidato).
// Timeout por request: 12s. Qualquer erro → null (não crasha o pipeline).

const RETAIL_MIN_INTERVAL_MS = 1_500;
const RETAIL_TIMEOUT_MS = 12_000;
const RETAIL_MAX_CANDIDATES = 3;
const RETAIL_MIN_SIMILARITY = 0.35;
const RETAIL_STRONG_SIMILARITY = 0.70;

// UA de browser: DDG HTML é menos amigável a clients não-browser.
const RETAIL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let lastRetailRequestAt = 0;

async function throttledFetchText(url: string): Promise<string | null> {
  const now = Date.now();
  const wait = Math.max(0, RETAIL_MIN_INTERVAL_MS - (now - lastRetailRequestAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRetailRequestAt = Date.now();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RETAIL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": RETAIL_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      },
      signal: ac.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/**
 * Extrai URLs dos resultados da página HTML do DuckDuckGo.
 * DDG usa <a class="result__a" href="..."> — por vezes envolvido num
 * redirect /l/?uddg=<encoded-url>.
 */
function parseDdgResults(html: string): string[] {
  const urls: string[] = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let url = m[1];
    const mr = /uddg=([^&]+)/.exec(url);
    if (mr) {
      try {
        url = decodeURIComponent(mr[1]);
      } catch {
        /* ignore */
      }
    }
    if (/^https?:\/\//i.test(url)) urls.push(url);
    if (urls.length >= 10) break;
  }
  return urls;
}

/** Lê o conteúdo de uma meta tag OG / name por nome. */
function extractMetaContent(html: string, property: string): string | null {
  const esc = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]*(?:property|name)=["']${esc}["'][^>]*content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${esc}["']`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return decodeHtmlEntities(m[1]).trim();
  }
  return null;
}

/** Procura um BreadcrumbList em blocos JSON-LD e devolve "A > B > C". */
function extractJsonLdBreadcrumb(html: string): string | null {
  const blocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (!blocks) return null;

  const extractName = (item: unknown): string | null => {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name === "string") return obj.name;
    if (obj.item && typeof obj.item === "object") {
      const inner = obj.item as Record<string, unknown>;
      if (typeof inner.name === "string") return inner.name;
    }
    return null;
  };

  for (const block of blocks) {
    const m = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(block);
    if (!m) continue;
    try {
      const data: unknown = JSON.parse(m[1]);
      const nodes = Array.isArray(data) ? data : [data];
      for (const raw of nodes) {
        if (!raw || typeof raw !== "object") continue;
        const n = raw as Record<string, unknown>;
        if (n["@type"] === "BreadcrumbList" && Array.isArray(n.itemListElement)) {
          const names = (n.itemListElement as unknown[])
            .map(extractName)
            .filter((x): x is string => typeof x === "string" && x.length > 0);
          if (names.length > 0) return names.join(" > ");
        }
      }
    } catch {
      /* JSON-LD inválido, ignora */
    }
  }
  return null;
}

type RetailExtracted = {
  nome: string | null;
  imagem: string | null;
  categoria: string | null;
  descricao: string | null;
};

function extractRetailMetadata(html: string): RetailExtracted {
  return {
    nome:
      extractMetaContent(html, "og:title") ??
      extractMetaContent(html, "twitter:title"),
    imagem:
      extractMetaContent(html, "og:image") ??
      extractMetaContent(html, "twitter:image"),
    categoria:
      extractJsonLdBreadcrumb(html) ??
      extractMetaContent(html, "product:category") ??
      extractMetaContent(html, "article:section"),
    descricao:
      extractMetaContent(html, "og:description") ??
      extractMetaContent(html, "description"),
  };
}

const retailPharmacyConnector: ExternalConnector = {
  name: "retail_pharmacy",

  async lookup(req): Promise<ExternalSourceData | null> {
    if (!req.designacao) return null;

    // 1. Pesquisa no DuckDuckGo HTML
    const query = `${req.designacao} farmácia`;
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const searchHtml = await throttledFetchText(searchUrl);
    if (!searchHtml) return null;

    const candidates = parseDdgResults(searchHtml).slice(0, RETAIL_MAX_CANDIDATES);
    if (candidates.length === 0) return null;

    // 2. Para cada candidato, fetch + extract + score
    let best: { url: string; data: RetailExtracted; similarity: number } | null = null;

    for (const url of candidates) {
      const html = await throttledFetchText(url);
      if (!html) continue;
      const data = extractRetailMetadata(html);
      if (!data.nome) continue;

      const sim = jaccard(data.nome, req.designacao);
      if (sim < RETAIL_MIN_SIMILARITY) continue;

      if (!best || sim > best.similarity) {
        best = { url, data, similarity: sim };
      }
      // short-circuit se já temos match forte
      if (sim >= RETAIL_STRONG_SIMILARITY) break;
    }

    if (!best) return null;

    // Confiança base do tier RETAIL, escalada pela similaridade do match
    const baseConfidence = 0.65;
    const confidence = Math.min(baseConfidence * (0.85 + best.similarity * 0.4), 0.80);

    const descSnippet = best.data.descricao
      ? " · " + best.data.descricao.slice(0, 140).replace(/\s+/g, " ")
      : "";

    return {
      source: "retail_pharmacy",
      tier: "RETAIL",
      matchedBy: "designacao",
      confidence,
      fabricante: null,         // tier RETAIL não é autoritário
      principioAtivo: null,
      atc: null,
      dosagem: null,
      embalagem: null,
      formaFarmaceutica: null,
      categoria: best.data.categoria,
      subcategoria: null,
      imagemUrl: best.data.imagem,
      notes:
        `retail_pharmacy match "${best.data.nome}" sim=${best.similarity.toFixed(2)} ` +
        `url=${best.url}${descSnippet}`,
    };
  },
};

// ─── Routing por tipo ─────────────────────────────────────────────────────────

const CONNECTORS_BY_TYPE: Record<ProductType, ExternalConnector[]> = {
  MEDICAMENTO:        [infarmedConnector, internalPharmacyConnector],
  SUPLEMENTO:         [internalPharmacyConnector, openFoodFactsConnector, retailPharmacyConnector],
  DERMOCOSMETICA:     [internalPharmacyConnector, openBeautyFactsConnector, retailPharmacyConnector],
  DISPOSITIVO_MEDICO: [internalPharmacyConnector, eudamedConnector, retailPharmacyConnector],
  HIGIENE_CUIDADO:    [internalPharmacyConnector, retailPharmacyConnector],
  ORTOPEDIA:          [internalPharmacyConnector, retailPharmacyConnector],
  PUERICULTURA:       [internalPharmacyConnector, retailPharmacyConnector],
  VETERINARIA:        [internalPharmacyConnector, retailPharmacyConnector],
  OUTRO:              [internalPharmacyConnector, retailPharmacyConnector],
};

/**
 * Devolve os conectores a usar para o tipo de produto, em ordem de prioridade.
 */
export function getConnectorsForProductType(type: ProductType): ExternalConnector[] {
  return CONNECTORS_BY_TYPE[type] ?? [internalPharmacyConnector];
}

/**
 * Executa todos os conectores relevantes para o pedido.
 *
 * Cada conector é executado de forma independente: um erro num conector
 * não interrompe os restantes. Erros são registados como aviso.
 *
 * Devolve todos os resultados não-nulos, na ordem dos conectores.
 */
export async function runConnectors(
  req: ExternalLookupRequest
): Promise<ExternalSourceData[]> {
  const connectors = getConnectorsForProductType(req.productType);
  const results: ExternalSourceData[] = [];

  for (const connector of connectors) {
    try {
      const result = await connector.lookup(req);
      if (result !== null) results.push(result);
    } catch (err) {
      console.warn(
        `[connector:${connector.name}] Erro para produto ${req.cnp ?? req.designacao}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return results;
}
