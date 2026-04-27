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
  EnrichmentTracer,
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
        designacaoOficial: true,
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
      // Evidência crua para o admin
      url: null,
      query: `InfarmedSnapshot WHERE cnp=${req.cnp}`,
      rawBrand: row.titularAim,
      rawCategory: row.grupoTerapeutico,
      rawProductName: row.designacaoOficial,
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
  baseConfidence: number,
  query: string,
  designacaoQuery: string
): ExternalSourceData {
  // Confiança base * (1 + bónus por similaridade acima do mínimo)
  const confidence = Math.min(baseConfidence * (0.85 + similarity * 0.4), 0.85);
  const firstCategory = p.categories
    ? p.categories.split(",").pop()?.trim() ?? null
    : null;
  const productName = p.product_name_pt || p.product_name || null;
  const partial = similarity < RETAIL_STRONG_SIMILARITY;
  return {
    source,
    tier: "RETAIL",
    matchedBy: similarity >= RETAIL_STRONG_SIMILARITY ? "designacao" : "fuzzy_name",
    confidence,
    // tier=RETAIL não é autoritário — fabricante nunca é aceite pela persistência
    // (AUTHORITATIVE_FIELDS em catalog-persistence.ts). Brand vai como rawBrand.
    fabricante: null,
    principioAtivo: null,
    atc: null,
    dosagem: null,
    embalagem: p.quantity ?? null,
    formaFarmaceutica: null,
    categoria: firstCategory,
    subcategoria: null,
    imagemUrl: p.image_front_url ?? p.image_url ?? null,
    notes: `${source} match "${productName ?? "?"}" sim=${similarity.toFixed(2)} q="${designacaoQuery}"`,
    partial,
    url: null, // OFF/OBF retornam payload directo, sem URL de página
    query,
    rawBrand: p.brands ?? null,
    rawCategory: p.categories ?? null,
    rawProductName: productName,
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
    return toExternalSource(
      best.product,
      "open_beauty_facts",
      best.similarity,
      0.70,
      `OBF search_terms="${req.designacao}"`,
      req.designacao
    );
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
    return toExternalSource(
      best.product,
      "open_food_facts",
      best.similarity,
      0.65,
      `OFF search_terms="${req.designacao}"`,
      req.designacao
    );
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
// Connector RETAIL para produtos não-medicamento. Estratégia de busca
// (Abril 2026 — re-escrita após audit que mostrou que a versão anterior
// não encontrava produtos com CNP único e identificável):
//
//   Stage 1: site-restricted CNP search
//     query: "<cnp>" (site:asuafarmaciaonline.pt OR site:wells.pt OR …)
//     Encontra páginas onde o CNP aparece literalmente no SKU ou texto
//     em sites de farmácia online portugueses conhecidos.
//
//   Stage 2: CNP + nome
//     query: "<cnp>" <primeiras palavras da designacao>
//     Sem restrição de site — procura o CNP em qualquer fonte que o use.
//
//   Stage 3: fallback por nome
//     query: <designacao> farmácia
//     Comportamento legacy.
//
// Critério de match (em ordem decrescente de força):
//   1. CNP aparece no URL → matchedBy=sku, confidence=0.80
//   2. CNP aparece no body da página → matchedBy=cnp, confidence=0.78
//   3. og:title com Jaccard ≥ 0.70 vs designacao → matchedBy=designacao, conf=0.70
//   4. og:title com Jaccard ≥ 0.35 vs designacao → matchedBy=fuzzy_name, conf=0.55
//      e o resultado é marcado partial=true (PARTIAL_HIT na telemetria).
//   5. Tudo abaixo → ignorado.
//
// Extracção de evidência:
//   - rawProductName: og:title ou h1
//   - rawBrand: JSON-LD Product.brand → microdata itemprop=brand → texto "Marca:"
//   - rawCategory: BreadcrumbList JSON-LD → microdata category → texto "Categoria:"
//   - imagemUrl: og:image
//
// O fabricante NUNCA é devolvido em ExternalSourceData.fabricante porque
// tier=RETAIL não pode escrever esse campo (defesa de tier no resolver).
// O rawBrand fica como evidência para o admin validar manualmente.
//
// Rate limit: 1 request / 1.5s (inclui pesquisa + cada candidato).
// Timeout por request: 12s. Qualquer erro → null (degrada graciosamente).

const RETAIL_MIN_INTERVAL_MS = 1_500;
const RETAIL_TIMEOUT_MS = 12_000;
const RETAIL_MAX_CANDIDATES = 4;
const RETAIL_MIN_SIMILARITY = 0.35;
const RETAIL_STRONG_SIMILARITY = 0.70;

/**
 * Estratégia por site de farmácia portuguesa.
 *
 * Cada site tem três pontos de entrada possíveis, tentados nesta ordem:
 *
 *   1. `search(query)`     URLs de pesquisa interna do site (?s= / ?q= / etc.).
 *                           A página de resultados é parseada por
 *                           `parseSiteSearchResults` para encontrar links
 *                           para páginas de produto.
 *
 *   2. `slugCandidates(designacao)`  URLs de produto adivinhadas a partir da
 *                           designação (ex: lojadafarmacia.com usa
 *                           `/pt/artigo/<slug>` — gerar slugs plausíveis e
 *                           tentar visitá-los directamente). Útil quando a
 *                           pesquisa interna não indexa pelo CNP.
 *
 *   3. (DDG cross-site no caller, fora deste objecto)
 *
 * `productUrl` é opcional: regex para reconhecer páginas de produto entre
 *  os links da página de resultados, filtrando ruído.
 */
type PharmacyStrategy = {
  domain: string;
  search: (query: string) => string[];
  slugCandidates?: (designacao: string) => string[];
  productUrl?: RegExp;
};

function shopify(domain: string): (q: string) => string[] {
  return (q) => [`https://${domain}/search?q=${encodeURIComponent(q)}`];
}
function woo(domain: string): (q: string) => string[] {
  return (q) => [
    `https://${domain}/?s=${encodeURIComponent(q)}&post_type=product`,
    `https://${domain}/?s=${encodeURIComponent(q)}`,
  ];
}
function generic(domain: string): (q: string) => string[] {
  return (q) => [
    `https://${domain}/?s=${encodeURIComponent(q)}`,
    `https://${domain}/search?q=${encodeURIComponent(q)}`,
    `https://${domain}/pesquisa?q=${encodeURIComponent(q)}`,
  ];
}

/**
 * Normaliza uma designação para um slug URL-safe (acentos removidos,
 * minúsculas, separadores `-`). Usado como base para gerar variantes.
 */
function baseSlug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Abreviações habituais nos exports do ERP SoftReis / SPharm que aparecem
 * directamente nos slugs de várias farmácias online (lojadafarmacia.com em
 * particular). Aplicar designação → forma abreviada para gerar candidatos.
 */
const ERP_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bcomprimidos?\b/gi, "comp"],
  [/\bc[aá]psulas?\b/gi, "caps"],
  [/\bcremes?\b/gi, "cr"],
  [/\bxaropes?\b/gi, "xpe"],
  [/\bemolientes?\b/gi, "emol"],
  [/\bcontrol\b/gi, "cont"],
  [/\bpomadas?\b/gi, "pom"],
  [/\bsprays?\b/gi, "spy"],
  [/\bampolas?\b/gi, "amp"],
  [/\bsolu[cç][aã]o\b/gi, "sol"],
  [/\bsuspens[aã]o\b/gi, "susp"],
  [/\bgranulados?\b/gi, "gran"],
  [/\bdisolu[cç][aã]o\b/gi, "dis"],
];

/**
 * Gera múltiplos candidatos de slug a partir de uma designação:
 *   1. slug puro                    a-derma-exomega-control-creme-noite-emoliente-200ml
 *   2. slug com abreviações ERP     a-derma-exomega-cont-cr-noite-emol-200ml
 *   3. slug com tamanho colado      a-derma-exomega-cont-cr-noite-emol200ml
 *   4. slug truncado (sem tamanho)  a-derma-exomega-cont-cr-noite-emol
 *
 * O caller tenta cada candidato sequencialmente e usa o primeiro que devolva
 * uma página real (HTTP 200 + HTML).
 */
function generateSlugCandidates(designacao: string): string[] {
  if (!designacao || !designacao.trim()) return [];

  const cleaned = designacao.trim();

  let abbreviated = cleaned;
  for (const [re, repl] of ERP_ABBREVIATIONS) abbreviated = abbreviated.replace(re, repl);

  const sizeRe = /(\d+\s*(?:ml|g|mg|cps|comp|amp|un|x))\b/i;

  const variants = new Set<string>();
  variants.add(baseSlug(cleaned));
  variants.add(baseSlug(abbreviated));

  // Tamanho colado: "emol-200ml" → "emol200ml"
  for (const v of [baseSlug(cleaned), baseSlug(abbreviated)]) {
    const merged = v.replace(/-(\d+(?:ml|g|mg|cps|comp|amp|un|x))\b/i, "$1");
    variants.add(merged);
  }

  // Sem tamanho final
  for (const v of [baseSlug(cleaned), baseSlug(abbreviated)]) {
    const noSize = v.replace(/-?\d+(?:ml|g|mg|cps|comp|amp|un|x)\b/i, "");
    variants.add(noSize.replace(/-+$/g, ""));
  }
  // Variante adicional: aplica abbrev e remove tamanho com sizeRe
  variants.add(baseSlug(abbreviated.replace(sizeRe, "")));

  return Array.from(variants).filter((v) => v.length >= 5);
}

/**
 * Slug builder específico para lojadafarmacia.com — `/pt/artigo/<slug>`.
 */
function lojadafarmaciaSlugUrls(designacao: string): string[] {
  const slugs = generateSlugCandidates(designacao);
  return slugs.map((s) => `https://lojadafarmacia.com/pt/artigo/${s}`);
}

const PT_PHARMACY_STRATEGIES: PharmacyStrategy[] = [
  // Lojadafarmacia.com — site explicitamente validado pelo utilizador.
  // Estrutura `/pt/artigo/<slug>` torna o slug-fallback altamente eficaz
  // mesmo quando a pesquisa interna do site não indexa pelo CNP.
  {
    domain: "lojadafarmacia.com",
    search: generic("lojadafarmacia.com"),
    slugCandidates: lojadafarmaciaSlugUrls,
    productUrl: /\/pt\/artigo\//i,
  },
  { domain: "asuafarmaciaonline.pt", search: shopify("asuafarmaciaonline.pt") },
  { domain: "wells.pt", search: shopify("wells.pt") },
  { domain: "cf.pt", search: shopify("cf.pt") },
  { domain: "farmaciascarvalho.pt", search: woo("farmaciascarvalho.pt") },
  { domain: "farmaciaramos.com", search: shopify("farmaciaramos.com") },
  { domain: "farmacia24.pt", search: woo("farmacia24.pt") },
  { domain: "farmaciapinheiro.pt", search: woo("farmaciapinheiro.pt") },
  { domain: "bemestaratual.pt", search: shopify("bemestaratual.pt") },
  { domain: "powerhealth.pt", search: shopify("powerhealth.pt") },
  { domain: "farmaciagama.pt", search: generic("farmaciagama.pt") },
  { domain: "farmaciaalvim.pt", search: generic("farmaciaalvim.pt") },
];

/**
 * Helpers internos exportados para testes (regressão de slug, extracção
 * brand/categoria, inferência por nome conhecido).
 */
export const __retailInternals = {
  generateSlugCandidates,
  baseSlug,
  // Estes são definidos mais abaixo no ficheiro — referenciados aqui
  // através de getters lazy para evitar TDZ na ordem de inicialização.
  get extractRetailMetadata() {
    return extractRetailMetadata;
  },
  get inferBrandFromName() {
    return inferBrandFromName;
  },
  get extractBrand() {
    return extractBrand;
  },
  get extractRawCategory() {
    return extractRawCategory;
  },
};

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

/**
 * Extrai URLs candidatas de uma página de resultados de pesquisa interna
 * de um site de farmácia. Heurística: todos os <a href> que apontam para o
 * mesmo domínio e cujo path tem ar de página de produto (não-vazio, não-só
 * a homepage, não páginas de carrinho/conta/categoria genéricas).
 *
 * Filtra ruído conhecido (cart, checkout, account, login, my-account, etc.)
 * para evitar fetch desnecessário.
 */
function parseSiteSearchResults(html: string, domain: string): string[] {
  const urls = new Set<string>();
  const re = /<a[^>]*href="([^"]+)"/gi;
  const noise =
    /\/(?:carrinho|cart|checkout|conta|account|login|my-account|wishlist|favoritos|contactos?|sobre|about|politicas?|terms?)(?:[/?#]|$)/i;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let url = m[1];
    if (url.startsWith("//")) url = "https:" + url;
    else if (url.startsWith("/")) url = `https://${domain}${url}`;
    if (!/^https?:\/\//i.test(url)) continue;

    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    const target = domain.replace(/^www\./, "");
    if (host !== target) continue;
    if (noise.test(url)) continue;

    // Esquece âncoras dentro da mesma página
    const noFrag = url.split("#")[0];
    urls.add(noFrag);
    if (urls.size >= 12) break;
  }
  return Array.from(urls);
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
  brand: string | null;
};

/**
 * Lista de marcas comuns em farmácia portuguesa. Usada como fallback
 * quando os parsers estruturados falham mas o nome do produto começa por
 * uma marca conhecida (ex: "A-Derma Exomega ..." → "A-Derma").
 *
 * Mantida deliberadamente curta — só marcas com presença massiva em
 * farmácias PT. Adicionar mais à medida que aparecem em produção.
 */
const KNOWN_BRANDS_PT: string[] = [
  "A-Derma", "Aderma", "Avène", "Avene",
  "La Roche-Posay", "La Roche Posay", "Bioderma", "Vichy", "ISDIN", "Cerave", "CeraVe",
  "Eucerin", "Mustela", "Ducray", "Klorane", "Caudalie", "Uriage",
  "Roger & Gallet", "Roger&Gallet", "Lierac", "Sebamed", "Phyto",
  "René Furterer", "Rene Furterer", "Nuxe", "Filorga", "SVR", "Topicrem",
  "Galenic", "Sanex", "Galénic",
  "Nutribén", "Nutriben", "Aptamil", "NAN", "Hipp", "Holle",
  "Bial", "Pfizer", "Bayer", "Sanofi", "Novartis", "GSK", "Roche",
  "Advancis", "ADVANCIS", "Solgar", "Centrum", "Sustenium",
  "Compeed", "Hansaplast", "Niquitin", "Nicorette",
  "Esthederm", "Skinceuticals", "SkinCeuticals", "Phyto Phytocyane",
  "Heliocare", "Pharmaceris", "Sesderma",
];

/**
 * Tenta inferir a marca a partir do nome do produto: aceita um match no
 * início (prefix) contra a lista de marcas conhecidas. Devolve a forma
 * canónica com a capitalização original do KNOWN_BRANDS_PT (primeira
 * variante listada para esa marca).
 */
function inferBrandFromName(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name.trim();
  if (!cleaned) return null;
  // Comparação case-insensitive contra a lista; preferir matches mais
  // longos (evita "Avene" sobrepor-se a "Avène" quando ambas existem).
  const sorted = [...KNOWN_BRANDS_PT].sort((a, b) => b.length - a.length);
  for (const brand of sorted) {
    const re = new RegExp(`^\\s*${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(cleaned)) return brand;
  }
  return null;
}

/**
 * Extrai marca/laboratório do HTML, em ordem decrescente de fiabilidade:
 *   1. JSON-LD Product.brand.name
 *   2. itemprop="brand" content / texto interno
 *   3. Anchor com href contendo /marca/<slug>/ ou /brand/<slug>/
 *   4. Texto "Marca:" ou "Brand:" próximo do produto
 */
function extractBrand(html: string): string | null {
  // 1. JSON-LD Product.brand
  const blocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (blocks) {
    for (const block of blocks) {
      const m = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(block);
      if (!m) continue;
      try {
        const data: unknown = JSON.parse(m[1]);
        const candidates = Array.isArray(data) ? data : [data];
        for (const raw of candidates) {
          if (!raw || typeof raw !== "object") continue;
          const node = raw as Record<string, unknown>;
          const t = node["@type"];
          if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) {
            const brand = node["brand"];
            if (typeof brand === "string" && brand.trim()) return brand.trim();
            if (brand && typeof brand === "object") {
              const b = brand as Record<string, unknown>;
              if (typeof b.name === "string" && b.name.trim()) return b.name.trim();
            }
          }
        }
      } catch {
        /* JSON-LD inválido */
      }
    }
  }

  // 2. itemprop="brand" — content de meta ou texto de span/a
  const itempropMeta = /<meta[^>]*itemprop=["']brand["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (itempropMeta) return decodeHtmlEntities(itempropMeta[1]).trim();

  const itempropTag = /<[^>]*itemprop=["']brand["'][^>]*>([^<]+)</i.exec(html);
  if (itempropTag) {
    const v = decodeHtmlEntities(itempropTag[1]).trim();
    if (v.length > 0 && v.length < 80) return v;
  }

  // Aninhado: <span itemprop="brand"><span itemprop="name">X</span></span>
  const itempropNested = /<[^>]*itemprop=["']brand["'][^>]*>[\s\S]*?<[^>]*itemprop=["']name["'][^>]*>([^<]+)</i.exec(html);
  if (itempropNested) {
    const v = decodeHtmlEntities(itempropNested[1]).trim();
    if (v.length > 0 && v.length < 80) return v;
  }

  // 3. Anchor com href /marca/<slug>/ ou /marcas/<slug>/ ou /brand/<slug>/.
  //    Padrão muito comum em farmácias online portuguesas (lojadafarmacia,
  //    farmaciaramos, farmacia24…). O texto interno do anchor costuma ser
  //    o nome legível da marca; o slug é fallback para quando o link tem
  //    só uma imagem.
  const brandAnchor = /<a[^>]*href=["'][^"']*\/(?:marca|marcas|brand|brands)\/([^"'/?#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(
    html
  );
  if (brandAnchor) {
    const inner = brandAnchor[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const txt = decodeHtmlEntities(inner);
    if (txt.length >= 2 && txt.length <= 60) return txt;
    // Fallback: derivar do slug ("a-derma" → "A-Derma")
    const slug = decodeURIComponent(brandAnchor[1]).replace(/-+/g, " ");
    if (slug.length >= 2 && slug.length <= 60) {
      return slug
        .split(" ")
        .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ")
        .replace(/\s/g, "-");
    }
  }

  // 4. Texto "Marca:" / "Brand:" — capturar próxima palavra(s) razoável
  // Procura no HTML completo mas limita o resultado a algo plausível.
  const textPatterns = [
    /Marca\s*:\s*<[^>]+>\s*([A-Z][^<\n]{1,60})\s*</i,        // <strong>Marca:</strong> <a>X</a>
    />\s*Marca\s*:?\s*<\/[^>]+>\s*<[^>]+>\s*([A-Z][^<\n]{1,60})\s*</i, // similar nested
    /Marca\s*:\s*([A-Z][\w\s&.\-']{2,60})(?=[<\n,])/,        // "Marca: ADVANCIS\n"
    /Brand\s*:\s*([A-Z][\w\s&.\-']{2,60})(?=[<\n,])/,
  ];
  for (const re of textPatterns) {
    const m = re.exec(html);
    if (m) {
      const v = decodeHtmlEntities(m[1]).trim();
      // Sanity: brand é tipicamente 2-50 chars, sem demasiados espaços (não captura frases)
      if (v.length >= 2 && v.length <= 50 && (v.match(/\s/g) ?? []).length <= 5) {
        return v;
      }
    }
  }

  return null;
}

/**
 * Extrai todo o texto dos `<a>` dentro de um elemento HTML (string que
 * representa o conteúdo do elemento). Usado para apanhar breadcrumbs como
 * `<nav class="breadcrumb"><a>Home</a><a>Categoria</a><a>Produto</a></nav>`.
 */
function anchorTextsIn(html: string): string[] {
  const out: string[] = [];
  const re = /<a[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const txt = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (txt.length >= 1 && txt.length <= 80) out.push(decodeHtmlEntities(txt));
  }
  return out;
}

/**
 * Detecta um bloco breadcrumb HTML (nav/ol/ul/div com classe ou id contendo
 * "breadcrumb") e devolve "A > B > C" — texto dos seus anchors. Filtra
 * "Home" / "Início" / "Página inicial" / vazios.
 */
function extractHtmlBreadcrumb(html: string): string | null {
  const re =
    /<(?:nav|ol|ul|div)[^>]*(?:class|id)=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(?:nav|ol|ul|div)>/i;
  const m = re.exec(html);
  if (!m) return null;
  const texts = anchorTextsIn(m[1])
    .filter((t) => !/^(?:home|in[ií]cio|p[aá]gina inicial)$/i.test(t.trim()))
    .filter((t) => t.trim().length > 0);
  if (texts.length === 0) return null;
  return texts.join(" > ");
}

/**
 * Extrai categoria crua do HTML — breadcrumb completo, depois fallbacks meta,
 * depois texto "Categoria:".
 */
function extractRawCategory(html: string): string | null {
  const jsonLd = extractJsonLdBreadcrumb(html);
  if (jsonLd) return jsonLd;
  const htmlBreadcrumb = extractHtmlBreadcrumb(html);
  if (htmlBreadcrumb) return htmlBreadcrumb;
  const product = extractMetaContent(html, "product:category");
  if (product) return product;
  const article = extractMetaContent(html, "article:section");
  if (article) return article;
  // Texto explícito "Categoria: X"
  const m = /Categoria\s*:\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇa-zàáâãäçéèêíîïóôõöúûü\s,&.\-/]{2,80})(?=[<\n])/.exec(html);
  if (m) {
    const v = decodeHtmlEntities(m[1]).trim().replace(/\s+/g, " ");
    if (v.length >= 2 && v.length <= 80) return v;
  }
  return null;
}

/**
 * Extrai o conteúdo do primeiro `<h1>` da página, sem tags. Usado como
 * fallback de nome do produto quando og:title não está presente (alguns
 * sites pequenos não emitem OG meta tags).
 */
function extractH1(html: string): string | null {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!m) return null;
  const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length >= 3 && text.length <= 200 ? decodeHtmlEntities(text) : null;
}

function extractRetailMetadata(html: string): RetailExtracted {
  const nome =
    extractMetaContent(html, "og:title") ??
    extractMetaContent(html, "twitter:title") ??
    extractH1(html);
  // Brand: tenta parsers estruturados primeiro; se nada bater, infere do
  // prefixo do nome do produto contra a lista de marcas conhecidas
  // (cobre páginas que não emitem JSON-LD/itemprop nem têm /marca/<slug>/).
  const brand = extractBrand(html) ?? inferBrandFromName(nome);
  return {
    nome,
    imagem:
      extractMetaContent(html, "og:image") ??
      extractMetaContent(html, "twitter:image"),
    categoria: extractRawCategory(html),
    descricao:
      extractMetaContent(html, "og:description") ??
      extractMetaContent(html, "description"),
    brand,
  };
}

/** True se o CNP aparece literalmente no path do URL (com word-boundary). */
function urlMatchesCnp(url: string, cnp: number): boolean {
  return new RegExp(`(^|[^0-9])${cnp}([^0-9]|$)`).test(url);
}

/**
 * True se o CNP aparece literalmente no body da página HTML — exclui blocos
 * de script/style para evitar falsos positivos de código JS.
 *
 * Também devolve `explicit=true` quando o CNP aparece num token explícito
 * `[COD <cnp>]` / `COD: <cnp>` / `Cód.: <cnp>` — sinal mais forte que um
 * número solto, usado por lojadafarmacia.com e várias farmácias PT.
 */
function pageMatchesCnp(html: string, cnp: number): { match: boolean; explicit: boolean } {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const match = new RegExp(`(^|[^0-9])${cnp}([^0-9]|$)`).test(cleaned);
  const explicit = new RegExp(`\\b(?:COD|C[oó]d(?:igo)?)\\s*[.:]?\\s*\\[?${cnp}\\b`, "i").test(cleaned)
    || new RegExp(`\\[\\s*COD\\s*${cnp}\\s*\\]`, "i").test(cleaned);
  return { match, explicit };
}

type RetailCandidate = {
  url: string;
  meta: RetailExtracted;
  matchedBy: "sku" | "cnp" | "designacao" | "fuzzy_name";
  confidence: number;
  partial: boolean;
  similarity: number;
  query: string;
  score: number;
  cnpInUrl: boolean;
  cnpInPage: boolean;
};

/**
 * Avalia uma URL candidata: faz fetch, extrai metadados, decide se é match.
 * Devolve um RetailCandidate ou null se não for utilizável.
 */
async function evaluateRetailCandidate(
  url: string,
  cnp: number | null,
  designacao: string,
  query: string,
  trace: EnrichmentTracer | undefined
): Promise<RetailCandidate | null> {
  const html = await throttledFetchText(url);
  if (!html) {
    trace?.({ kind: "candidate", connector: "retail_pharmacy", url, httpOk: false, reason: "fetch failed" });
    return null;
  }
  trace?.({ kind: "candidate", connector: "retail_pharmacy", url, httpOk: true });

  const meta = extractRetailMetadata(html);
  const sim = meta.nome ? jaccard(meta.nome, designacao) : 0;
  const cnpInUrl = cnp != null && urlMatchesCnp(url, cnp);
  const cnpPage = cnp != null ? pageMatchesCnp(html, cnp) : { match: false, explicit: false };
  const cnpInPage = cnpPage.match;
  const cnpExplicit = cnpPage.explicit;

  let matchedBy: RetailCandidate["matchedBy"];
  let confidence: number;
  let partial = false;

  // Política Abril 2026 (revisão #3):
  //   CNP no URL                              → sku,         0.85
  //   [COD <cnp>] explícito no body           → cnp,         0.85  (igual a sku)
  //   CNP no body + (marca OU categoria)      → cnp,         0.82
  //   CNP no body                              → cnp,         0.78
  //   Jaccard ≥ 0.70                          → designacao,  ~0.70
  //   Jaccard ≥ 0.35                          → fuzzy_name,  ~0.55, partial
  //   Brand+breadcrumb (sem mais sinal)       → fuzzy_name,  0.55, partial
  if (cnpInUrl) {
    matchedBy = "sku";
    confidence = 0.85;
  } else if (cnpExplicit) {
    matchedBy = "cnp";
    confidence = 0.85;
  } else if (cnpInPage && (meta.brand || meta.categoria)) {
    matchedBy = "cnp";
    confidence = 0.82;
  } else if (cnpInPage) {
    matchedBy = "cnp";
    confidence = 0.78;
  } else if (sim >= RETAIL_STRONG_SIMILARITY) {
    matchedBy = "designacao";
    confidence = Math.min(0.65 * (0.85 + sim * 0.4), 0.78);
  } else if (sim >= RETAIL_MIN_SIMILARITY) {
    matchedBy = "fuzzy_name";
    confidence = Math.min(0.55 * (0.85 + sim * 0.4), 0.65);
    partial = true;
  } else if (meta.brand && meta.categoria) {
    matchedBy = "fuzzy_name";
    confidence = 0.55;
    partial = true;
  } else {
    trace?.({
      kind: "skipped",
      connector: "retail_pharmacy",
      url,
      reason: `no usable signal (cnpInUrl=${cnpInUrl} cnpInPage=${cnpInPage} sim=${sim.toFixed(2)} brand=${!!meta.brand} category=${!!meta.categoria})`,
    });
    return null;
  }

  trace?.({
    kind: "match",
    connector: "retail_pharmacy",
    url,
    cnpInUrl,
    cnpInPage,
    similarity: sim,
    rawBrand: meta.brand,
    rawCategory: meta.categoria,
    rawProductName: meta.nome,
    matchedBy,
    confidence,
    partial,
  });

  const score =
    confidence +
    (cnpInUrl ? 0.10 : cnpInPage ? 0.08 : 0) +
    sim * 0.05 +
    (meta.brand ? 0.02 : 0) +
    (meta.categoria ? 0.02 : 0);

  return {
    url,
    meta,
    matchedBy,
    confidence,
    partial,
    similarity: sim,
    query,
    score,
    cnpInUrl,
    cnpInPage,
  };
}

const retailPharmacyConnector: ExternalConnector = {
  name: "retail_pharmacy",

  async lookup(req): Promise<ExternalSourceData | null> {
    if (!req.designacao && !req.cnp && !req.url) return null;

    const trace = req.trace;
    const cnp = req.cnp ?? null;
    const cnpStr = cnp != null ? String(cnp) : null;

    let best: RetailCandidate | null = null;
    let candidatesEvaluated = 0;

    // ─── Estratégia 0: URL fixa (override de teste) ────────────────────────
    //
    // Quando o caller passa `req.url`, salta toda a pesquisa e avalia
    // directamente essa página. Útil para reproduzir um caso visto pelo
    // admin sem depender de DDG/site search.
    if (req.url) {
      trace?.({
        kind: "stage",
        connector: "retail_pharmacy",
        stage: "url_override",
        query: req.url,
      });
      const cand = await evaluateRetailCandidate(
        req.url,
        cnp,
        req.designacao,
        `url_override`,
        trace
      );
      candidatesEvaluated++;
      if (cand) best = cand;
    }

    // ─── Estratégia 1: site search directo por CNP em farmácias PT ─────────
    //
    // Para cada farmácia conhecida, lança a pesquisa interna do site com o
    // CNP (e fallback com o nome). Esta abordagem encontra páginas que o
    // DDG não indexou ou indexou mal. É a estratégia mais fiável para CNPs.
    //
    // Curto-circuita assim que apanha um match com CNP forte (sku ou cnp).
    if (cnpStr && (!best || (best.matchedBy !== "sku" && best.matchedBy !== "cnp"))) {
      for (const site of PT_PHARMACY_STRATEGIES) {
        if (best && (best.matchedBy === "sku" || best.matchedBy === "cnp")) break;

        for (const searchUrl of site.search(cnpStr)) {
          trace?.({
            kind: "stage",
            connector: "retail_pharmacy",
            stage: `site:${site.domain}`,
            query: searchUrl,
          });
          const searchHtml = await throttledFetchText(searchUrl);
          if (!searchHtml) continue;

          let urls = parseSiteSearchResults(searchHtml, site.domain);
          if (site.productUrl) urls = urls.filter((u) => site.productUrl!.test(u));
          urls = urls.slice(0, RETAIL_MAX_CANDIDATES);

          trace?.({
            kind: "search_results",
            connector: "retail_pharmacy",
            query: searchUrl,
            urls,
            via: "site_search",
          });
          if (urls.length === 0) continue;

          for (const url of urls) {
            const cand = await evaluateRetailCandidate(
              url,
              cnp,
              req.designacao,
              `site:${site.domain} cnp=${cnpStr}`,
              trace
            );
            candidatesEvaluated++;
            if (!cand) continue;
            if (!best || cand.score > best.score) best = cand;
            if (cand.matchedBy === "sku" || cand.matchedBy === "cnp") break;
          }
          if (best && (best.matchedBy === "sku" || best.matchedBy === "cnp")) break;
        }
      }
    }

    // ─── Estratégia 1b: slug fallback determinístico por site ──────────────
    //
    // Para sites cuja URL de produto segue um padrão previsível (lojadafarmacia
    // usa `/pt/artigo/<slug>`), gerar candidatos directamente da designação e
    // visitá-los. Apanha produtos cuja pesquisa interna não indexa pelo CNP
    // mas cuja página existe quando se sabe o slug.
    if (
      req.designacao &&
      (!best || (best.matchedBy !== "sku" && best.matchedBy !== "cnp"))
    ) {
      for (const site of PT_PHARMACY_STRATEGIES) {
        if (!site.slugCandidates) continue;
        if (best && (best.matchedBy === "sku" || best.matchedBy === "cnp")) break;

        const slugUrls = site.slugCandidates(req.designacao);
        if (slugUrls.length === 0) continue;

        trace?.({
          kind: "stage",
          connector: "retail_pharmacy",
          stage: `slug:${site.domain}`,
          query: `${slugUrls.length} candidato(s) gerado(s) a partir da designação`,
        });
        trace?.({
          kind: "search_results",
          connector: "retail_pharmacy",
          query: `slug:${site.domain}`,
          urls: slugUrls,
          via: "slug_guess",
        });

        for (const url of slugUrls) {
          const cand = await evaluateRetailCandidate(
            url,
            cnp,
            req.designacao,
            `slug:${site.domain}`,
            trace
          );
          candidatesEvaluated++;
          if (!cand) continue;
          if (!best || cand.score > best.score) best = cand;
          if (cand.matchedBy === "sku" || cand.matchedBy === "cnp") break;
        }
      }
    }

    // ─── Estratégia 2: DDG cross-site com CNP ──────────────────────────────
    //
    // Caso a estratégia 1 não tenha encontrado um match forte, tenta DDG
    // com o CNP entre aspas (sem restrição de site) — apanha lojas fora
    // da nossa lista que indexam o CNP.
    if (!best || (best.matchedBy !== "sku" && best.matchedBy !== "cnp")) {
      const ddgStages: Array<{ q: string; label: string }> = [];
      if (cnpStr) {
        const namePart = req.designacao
          .split(/\s+/)
          .filter((w) => w.length >= 3)
          .slice(0, 3)
          .join(" ");
        ddgStages.push({
          q: namePart ? `"${cnpStr}" ${namePart}` : `"${cnpStr}"`,
          label: "ddg_cnp",
        });
      }
      ddgStages.push({ q: `${req.designacao} farmácia`, label: "ddg_name" });

      for (const stage of ddgStages) {
        trace?.({
          kind: "stage",
          connector: "retail_pharmacy",
          stage: stage.label,
          query: stage.q,
        });
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(stage.q)}`;
        const html = await throttledFetchText(ddgUrl);
        if (!html) continue;
        const urls = parseDdgResults(html).slice(0, RETAIL_MAX_CANDIDATES);
        trace?.({
          kind: "search_results",
          connector: "retail_pharmacy",
          query: stage.q,
          urls,
          via: "ddg",
        });
        if (urls.length === 0) continue;

        for (const url of urls) {
          const cand = await evaluateRetailCandidate(
            url,
            cnp,
            req.designacao,
            stage.q,
            trace
          );
          candidatesEvaluated++;
          if (!cand) continue;
          if (!best || cand.score > best.score) best = cand;
          if (cand.matchedBy === "sku" || cand.matchedBy === "cnp") break;
        }
        if (best && (best.matchedBy === "sku" || best.matchedBy === "cnp")) break;
      }
    }

    if (!best) {
      trace?.({
        kind: "result",
        connector: "retail_pharmacy",
        status: "NO_MATCH",
        reason:
          candidatesEvaluated === 0
            ? "Nenhuma URL candidata devolvida pelas pesquisas (site search + DDG)"
            : `Avaliadas ${candidatesEvaluated} URL(s); nenhuma com sinal suficiente (CNP, similaridade, marca+breadcrumb)`,
      });
      return null;
    }

    trace?.({
      kind: "result",
      connector: "retail_pharmacy",
      status: best.partial ? "PARTIAL_HIT" : "SUCCESS",
      reason: `match ${best.matchedBy} conf=${best.confidence.toFixed(2)} ${best.url}`,
    });

    const descSnippet = best.meta.descricao
      ? " · " + best.meta.descricao.slice(0, 120).replace(/\s+/g, " ")
      : "";

    return {
      source: "retail_pharmacy",
      tier: "RETAIL",
      matchedBy: best.matchedBy,
      confidence: best.confidence,
      fabricante: null, // tier RETAIL — fabricante não é autoritário; brand vai como rawBrand
      principioAtivo: null,
      atc: null,
      dosagem: null,
      embalagem: null,
      formaFarmaceutica: null,
      categoria: best.meta.categoria,
      subcategoria: null,
      imagemUrl: best.meta.imagem,
      notes:
        `${best.matchedBy} match "${best.meta.nome ?? "(sem og:title)"}" ` +
        `sim=${best.similarity.toFixed(2)} via=${best.query}${descSnippet}`,
      // Evidência crua para o admin
      partial: best.partial,
      url: best.url,
      query: best.query,
      rawBrand: best.meta.brand,
      rawCategory: best.meta.categoria,
      rawProductName: best.meta.nome,
    };
  },
};

// ─── Routing por tipo ─────────────────────────────────────────────────────────

/**
 * Decisão pós-auditoria (abril 2026): `internalPharmacyConnector` foi REMOVIDO
 * deste routing. O conector estava a propagar `categoriaOrigem`/`familiaOrigem`
 * — texto bruto do ERP da farmácia — como `ExternalSourceData.categoria` que
 * depois alimentava o `taxonomy-map` para escolher classificação canónica.
 * Isto contradizia a regra "SPharmMT é a fonte de verdade da classificação;
 * SPharm/ERP só fornece CNP/designação/movimentos".
 *
 * O sinal interno continua a influenciar o classificador via
 * `fetchOrigemSignals` em catalog-enrichment.ts → `applyOrigemSignals` em
 * catalog-classifier.ts (reforço fraco ao pontuar `productType`), o que é
 * legítimo porque NÃO escreve texto livre como categoria persistida.
 *
 * O conector interno fica em código como referência, mas não é chamado.
 */
const CONNECTORS_BY_TYPE: Record<ProductType, ExternalConnector[]> = {
  MEDICAMENTO:        [infarmedConnector],
  SUPLEMENTO:         [openFoodFactsConnector, retailPharmacyConnector],
  DERMOCOSMETICA:     [openBeautyFactsConnector, retailPharmacyConnector],
  DISPOSITIVO_MEDICO: [eudamedConnector, retailPharmacyConnector],
  HIGIENE_CUIDADO:    [retailPharmacyConnector],
  ORTOPEDIA:          [retailPharmacyConnector],
  PUERICULTURA:       [retailPharmacyConnector],
  VETERINARIA:        [retailPharmacyConnector],
  OUTRO:              [retailPharmacyConnector],
};

/**
 * Devolve os conectores a usar para o tipo de produto, em ordem de prioridade.
 */
export function getConnectorsForProductType(type: ProductType): ExternalConnector[] {
  return CONNECTORS_BY_TYPE[type] ?? [];
}

/**
 * Resultado de uma única invocação de conector — payload para
 * instrumentação. O caller decide se persiste (em SPharmMT) ou descarta.
 */
export type SourceCallEntry = {
  source: string;
  productId: string;
  status: "SUCCESS" | "NO_MATCH" | "ERROR" | "PARTIAL_HIT";
  confidence: number | null;
  matchedBy: string | null;
  durationMs: number;
  /**
   * Lista de campos não-null devolvidos pela fonte. Vazia em NO_MATCH/ERROR.
   * Permite contar coverage por campo por fonte sem reler o ResolvedProduct.
   */
  fieldsReturned: string[];
  errorMessage: string | null;
  /** Evidência (Abril 2026) — propagada do ExternalSourceData. */
  url: string | null;
  query: string | null;
  rawBrand: string | null;
  rawCategory: string | null;
  rawProductName: string | null;
};

export type SourceCallLogger = (entry: SourceCallEntry) => Promise<void> | void;

/** Lista de campos do `ExternalSourceData` que contam para `fieldsReturned`. */
const TRACKED_FIELDS: Array<keyof ExternalSourceData> = [
  "fabricante",
  "principioAtivo",
  "atc",
  "dosagem",
  "embalagem",
  "formaFarmaceutica",
  "categoria",
  "subcategoria",
  "imagemUrl",
];

function fieldsReturnedFrom(data: ExternalSourceData): string[] {
  const out: string[] = [];
  for (const f of TRACKED_FIELDS) {
    const v = data[f];
    if (typeof v === "string" && v.trim().length > 0) out.push(f);
  }
  return out;
}

/**
 * Executa todos os conectores relevantes para o pedido.
 *
 * Cada conector é executado de forma independente: um erro num conector
 * não interrompe os restantes. Erros são registados como aviso E, se
 * `logger` for passado, persistidos para métricas.
 *
 * Devolve todos os resultados não-nulos, na ordem dos conectores. Loga
 * (via `logger`) uma entrada por chamada — incluindo NO_MATCH e ERROR —
 * para que o painel de saúde possa medir taxa de erro / no-match.
 */
export async function runConnectors(
  req: ExternalLookupRequest,
  logger?: SourceCallLogger
): Promise<ExternalSourceData[]> {
  const connectors = getConnectorsForProductType(req.productType);
  const results: ExternalSourceData[] = [];

  for (const connector of connectors) {
    const t0 = Date.now();
    let entry: SourceCallEntry;
    try {
      const result = await connector.lookup(req);
      const durationMs = Date.now() - t0;
      if (result !== null) {
        results.push(result);
        // Conectores que não emitem trace próprio (INFARMED / OFF / OBF):
        // o retail emite o seu, este não duplica porque enviar "result"
        // duas vezes é só ruído visual.
        if (connector.name !== "retail_pharmacy") {
          req.trace?.({
            kind: "result",
            connector: connector.name,
            status: result.partial ? "PARTIAL_HIT" : "SUCCESS",
            reason: `match ${result.matchedBy} conf=${result.confidence.toFixed(2)}`,
          });
        }
        entry = {
          source: connector.name,
          productId: req.productId,
          status: result.partial ? "PARTIAL_HIT" : "SUCCESS",
          confidence: result.confidence,
          matchedBy: result.matchedBy,
          durationMs,
          fieldsReturned: fieldsReturnedFrom(result),
          errorMessage: null,
          url: result.url ?? null,
          query: result.query ?? null,
          rawBrand: result.rawBrand ?? null,
          rawCategory: result.rawCategory ?? null,
          rawProductName: result.rawProductName ?? null,
        };
      } else {
        if (connector.name !== "retail_pharmacy") {
          req.trace?.({
            kind: "result",
            connector: connector.name,
            status: "NO_MATCH",
            reason: "Conector devolveu null — sem dados para este CNP/designação",
          });
        }
        entry = {
          source: connector.name,
          productId: req.productId,
          status: "NO_MATCH",
          confidence: null,
          matchedBy: null,
          durationMs,
          fieldsReturned: [],
          errorMessage: null,
          url: null,
          query: null,
          rawBrand: null,
          rawCategory: null,
          rawProductName: null,
        };
      }
    } catch (err) {
      const durationMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[connector:${connector.name}] Erro para produto ${req.cnp ?? req.designacao}: ${msg}`
      );
      req.trace?.({
        kind: "result",
        connector: connector.name,
        status: "ERROR",
        reason: msg.slice(0, 200),
      });
      entry = {
        source: connector.name,
        productId: req.productId,
        status: "ERROR",
        confidence: null,
        matchedBy: null,
        durationMs,
        fieldsReturned: [],
        errorMessage: msg.slice(0, 500),
        url: null,
        query: null,
        rawBrand: null,
        rawCategory: null,
        rawProductName: null,
      };
    }

    if (logger) {
      try {
        await logger(entry);
      } catch (logErr) {
        // Falha na instrumentação NUNCA interrompe o pipeline real.
        console.warn(
          `[connector:logger] falhou ao registar ${entry.source}: ${
            logErr instanceof Error ? logErr.message : String(logErr)
          }`
        );
      }
    }
  }

  return results;
}
