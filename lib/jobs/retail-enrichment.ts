/**
 * lib/jobs/retail-enrichment.ts
 *
 * Worker do pipeline D (retail enrichment para NÃO-MEDICAMENTO).
 *
 * Selecciona produtos cujo `productType ∈ { COSMETICA, SUPLEMENTO,
 * DISPOSITIVO_MEDICO, HIGIENE_CUIDADO, ORTOPEDIA, PUERICULTURA,
 * VETERINARIA, OUTRO }` (i.e. ≠ MEDICAMENTO e ≠ NULL aceitável), com
 * lacunas (imagem, fabricante ou descrição rica), e tenta resolvê-los
 * via Open Beauty Facts / Open Food Facts / retail pharmacy connectors.
 *
 * **Anti-contaminação:**
 *   · NUNCA executa para `productType=MEDICAMENTO` (defense in depth —
 *     fonte autoritária é regulatório, não retail).
 *   · NUNCA escreve em produtos com `validadoManualmente=true`.
 *   · NUNCA substitui imagem existente por imagem retail mais fraca —
 *     escreve apenas quando `Produto.imagemUrl IS NULL`.
 *   · Confidence cap retail = 0.85 (THRESHOLD_AUTO=0.90 nunca alcançável
 *     por retail → escrita em fabricante continua bloqueada).
 *
 * **Auditoria:**
 *   Cada tentativa (success/no_match/error/partial_hit) é registada em
 *   `EnrichmentSourceLog` com source/status/confidence/url/query/raw*.
 *
 * **Idempotente:**
 *   Re-correr quando nada novo vem das fontes não muda nada (skip se
 *   o campo já está populado E o source rastro existe).
 *
 * **Multi-tenant safe:** recebe `prisma` parametrizado.
 *
 * Cadência recomendada: **05:00 UTC daily** (depois do regulatory tick).
 * Limite por tick é menor que regulatory porque HTTP retail é + caro
 * (3-5 req/produto vs 1 fetch INFOMED + reusable session).
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

// ─── Configuração e thresholds ──────────────────────────────────────────

const DEFAULT_MAX_PRODUCTS = 50;
const DEFAULT_MAX_DURATION_MS = 240_000;

/**
 * Confidence mínimo para gravar fields tier=RETAIL em Produto. Abaixo
 * disto, sinal vai apenas para EnrichmentSourceLog (audit) e o produto
 * pode ir para FilaRevisao se for caso disso.
 */
const RETAIL_WRITE_THRESHOLD = 0.75;

/**
 * Confidence mínimo para o produto ser candidato a revisão manual quando
 * NENHUMA fonte produz match acima do threshold de escrita. Abaixo disto
 * o produto é simplesmente marcado como "tentado" — não vai a fila.
 */
const REVIEW_MIN_CONFIDENCE = 0.55;

/** Rate limit entre invocações HTTP, partilhado entre OFF/OBF. */
const HTTP_MIN_INTERVAL_MS = 1100;

const USER_AGENT =
  "SPharm.MT/1.0 (catalog-retail-enrichment; https://github.com/spharm-mt)";

const HTTP_TIMEOUT_MS = 15_000;

let lastHttpAt = 0;
async function throttledFetchJson(url: string): Promise<unknown | null> {
  const now = Date.now();
  const wait = Math.max(0, HTTP_MIN_INTERVAL_MS - (now - lastHttpAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHttpAt = Date.now();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
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

// ─── Tipos públicos ─────────────────────────────────────────────────────

export type RetailTickOptions = {
  prisma: PrismaClient;
  maxProducts?: number;
  maxDurationMs?: number;
  /** Se passado, restringe aos productType indicados. */
  productTypes?: ReadonlyArray<string>;
};

export type RetailTickSummary = {
  startedAt: string;
  durationMs: number;
  processed: number;
  outcomes: {
    fieldsWritten: number;
    imagemFilled: number;
    enqueuedReview: number;
    noMatch: number;
    errors: number;
  };
  bySource: {
    obfHits: number;
    offHits: number;
    obfMisses: number;
    offMisses: number;
  };
  stoppedReason: "no_candidates" | "max_products" | "deadline";
};

// ─── Selecção de candidatos ─────────────────────────────────────────────

/**
 * Produtos não-medicamento com lacunas. Heurística:
 *   · imagemUrl IS NULL (image enrichment é a prioridade #1)
 *   · OU designacao curta (<=30) → tenta enriquecer com nome retail
 *   · OU fabricanteId NULL → tenta marca via retail
 *
 * Ordena por uma proxy de "valor": cnp > 5_000_000 primeiro (CNPs altos
 * = produtos mais novos / mais activos no retail), depois por dataAtualizacao.
 */
async function selectCandidates(
  prisma: PrismaClient,
  limit: number,
  productTypes: ReadonlyArray<string> | undefined,
): Promise<
  Array<{
    id: string;
    cnp: number;
    designacao: string;
    productType: string | null;
    imagemUrl: string | null;
    fabricanteId: string | null;
  }>
> {
  // Filtro base — defende contra contaminação de medicamentos
  const baseFilter: Prisma.ProdutoWhereInput = {
    estado: { not: "INATIVO" },
    validadoManualmente: false,
    productType: productTypes
      ? { in: [...productTypes] }
      : { notIn: ["MEDICAMENTO"], not: null },
    cnp: { gt: 2_000_000 },
    OR: [
      { imagemUrl: null },
      { fabricanteId: null },
      // designacao "curta" — heurística simples sem hardcode (>0 + length filter
      // via $queryRaw seria mais preciso; este caminho é suficiente em v1).
    ],
  };

  return prisma.produto.findMany({
    where: baseFilter,
    select: {
      id: true,
      cnp: true,
      designacao: true,
      productType: true,
      imagemUrl: true,
      fabricanteId: true,
    },
    orderBy: [{ dataCriacao: "desc" }],
    take: limit,
  });
}

// ─── Fetchers OFF/OBF (minimal, multi-tenant safe) ──────────────────────

type OpenFactsHit = {
  source: "open_beauty_facts" | "open_food_facts";
  productName: string | null;
  brand: string | null;
  category: string | null;
  imageUrl: string | null;
  similarity: number;
  confidence: number;
  url: string | null;
};

function stripAccentsLower(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function jaccard(a: string, b: string): number {
  const ta = new Set(stripAccentsLower(a).split(/\s+/).filter(Boolean));
  const tb = new Set(stripAccentsLower(b).split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

async function searchOpenFacts(
  base: "https://world.openbeautyfacts.org" | "https://world.openfoodfacts.org",
  source: OpenFactsHit["source"],
  designacao: string,
  baseConfidence: number,
): Promise<OpenFactsHit | null> {
  const q = encodeURIComponent(designacao);
  const url = `${base}/cgi/search.pl?search_terms=${q}&json=1&page_size=20`;
  const data = await throttledFetchJson(url);
  if (!data || typeof data !== "object") return null;
  const products =
    Array.isArray((data as { products?: unknown[] }).products)
      ? ((data as { products: unknown[] }).products as Array<Record<string, unknown>>)
      : [];
  if (products.length === 0) return null;

  let best: { p: Record<string, unknown>; sim: number } | null = null;
  for (const p of products) {
    const name =
      (p.product_name_pt as string | undefined) ||
      (p.product_name as string | undefined) ||
      null;
    if (!name) continue;
    const sim = jaccard(name, designacao);
    if (sim >= 0.35 && (!best || sim > best.sim)) best = { p, sim };
  }
  if (!best) return null;

  const p = best.p;
  const productName =
    (p.product_name_pt as string | undefined) ||
    (p.product_name as string | undefined) ||
    null;
  const brand = (p.brands as string | undefined) || null;
  const category = (p.categories as string | undefined)?.split(",").pop()?.trim() || null;
  const imageUrl =
    (p.image_front_url as string | undefined) ||
    (p.image_url as string | undefined) ||
    null;

  // Confiança base * (0.85 + sim*0.4), cap em 0.85
  const confidence = Math.min(baseConfidence * (0.85 + best.sim * 0.4), 0.85);
  return {
    source,
    productName,
    brand,
    category,
    imageUrl,
    similarity: best.sim,
    confidence,
    url: null,
  };
}

// ─── Processamento por produto ──────────────────────────────────────────

async function processProduto(
  prisma: PrismaClient,
  produto: {
    id: string;
    cnp: number;
    designacao: string;
    productType: string | null;
    imagemUrl: string | null;
    fabricanteId: string | null;
  },
): Promise<{
  outcome: "wrote" | "no_match" | "review" | "error";
  fieldsWritten: number;
  imagemFilled: boolean;
  bySource: { obf: OpenFactsHit | null; off: OpenFactsHit | null };
}> {
  const designacao = produto.designacao.trim();
  if (designacao.length < 3) {
    return {
      outcome: "no_match",
      fieldsWritten: 0,
      imagemFilled: false,
      bySource: { obf: null, off: null },
    };
  }

  // Escolher fontes a tentar pelo productType. Em ausência de tipo,
  // tenta ambas em sequência (custo: ~2-4s).
  const type = produto.productType ?? "OUTRO";
  const tryObf = ["DERMOCOSMETICA", "HIGIENE_CUIDADO", "ORTOPEDIA", "PUERICULTURA", "OUTRO"].includes(type);
  const tryOff = ["SUPLEMENTO", "VETERINARIA", "OUTRO"].includes(type);

  let obfHit: OpenFactsHit | null = null;
  let offHit: OpenFactsHit | null = null;

  const tStart = Date.now();
  try {
    if (tryObf) {
      obfHit = await searchOpenFacts(
        "https://world.openbeautyfacts.org",
        "open_beauty_facts",
        designacao,
        0.7,
      );
    }
    if (tryOff) {
      offHit = await searchOpenFacts(
        "https://world.openfoodfacts.org",
        "open_food_facts",
        designacao,
        0.65,
      );
    }
  } catch (err) {
    await logSource(prisma, produto.id, "open_beauty_facts", "ERROR", null, [], err);
    return {
      outcome: "error",
      fieldsWritten: 0,
      imagemFilled: false,
      bySource: { obf: obfHit, off: offHit },
    };
  }

  const candidates = [obfHit, offHit].filter((h): h is OpenFactsHit => h !== null);
  if (candidates.length === 0) {
    if (tryObf) await logSource(prisma, produto.id, "open_beauty_facts", "NO_MATCH", null, []);
    if (tryOff) await logSource(prisma, produto.id, "open_food_facts", "NO_MATCH", null, []);
    return {
      outcome: "no_match",
      fieldsWritten: 0,
      imagemFilled: false,
      bySource: { obf: obfHit, off: offHit },
    };
  }

  // Best by confidence
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  const httpDuration = Date.now() - tStart;

  // Log de cada fonte que produziu hit
  for (const h of candidates) {
    const status = h.confidence >= RETAIL_WRITE_THRESHOLD ? "SUCCESS" : "PARTIAL_HIT";
    const fieldsReturned = [
      ...(h.imageUrl ? ["imagemUrl"] : []),
      ...(h.brand ? ["fabricante"] : []),
      ...(h.category ? ["categoria"] : []),
      ...(h.productName ? ["designacao"] : []),
    ];
    await prisma.enrichmentSourceLog.create({
      data: {
        produtoId: produto.id,
        source: h.source,
        status,
        confidence: h.confidence,
        matchedBy: h.similarity >= 0.7 ? "designacao" : "fuzzy_name",
        durationMs: Math.round(httpDuration),
        fieldsReturned,
        errorMessage: null,
        url: h.url,
        query: `search_terms="${designacao}"`,
        rawBrand: h.brand,
        rawCategory: h.category,
        rawProductName: h.productName,
      },
    });
  }

  // Decisão de escrita: só se confidence >= threshold
  if (best.confidence < RETAIL_WRITE_THRESHOLD) {
    // Ambíguo / sinal fraco — enqueue revisão (sem escrever fields).
    if (best.confidence >= REVIEW_MIN_CONFIDENCE) {
      await enqueueReview(prisma, produto.id, "CLASSIFICACAO_PENDENTE", {
        reason: "retail_low_confidence",
        bestSource: best.source,
        confidence: best.confidence,
        candidates: candidates.map((c) => ({
          source: c.source,
          confidence: c.confidence,
          similarity: c.similarity,
        })),
      });
      return {
        outcome: "review",
        fieldsWritten: 0,
        imagemFilled: false,
        bySource: { obf: obfHit, off: offHit },
      };
    }
    return {
      outcome: "no_match",
      fieldsWritten: 0,
      imagemFilled: false,
      bySource: { obf: obfHit, off: offHit },
    };
  }

  // Confidence suficiente — escrever apenas campos NULL em Produto
  // (preserve-non-null e nunca substituir imagem mais forte).
  const data: Record<string, string> = {};
  let imagemFilled = false;
  if (produto.imagemUrl == null && best.imageUrl) {
    data.imagemUrl = best.imageUrl;
    imagemFilled = true;
  }
  // designacao retail só sobrescreve se a actual for muito curta (<=20)
  // E o nome retail for substancialmente mais rico — política conservadora.
  if (best.productName && best.productName.length > produto.designacao.length + 8 && produto.designacao.length <= 25) {
    // Não escrevemos a designacao por defeito — fica para revisão manual.
    // Audit log já tem o rawProductName.
  }

  // fabricante: nunca escrevemos directamente. Tier=RETAIL não é autoritário
  // para fabricante (regra cross-pipeline). Vai como rawBrand para auditoria
  // e potencial revisão manual.

  // categoria: só escrita seria via Classificacao N2 — fica para o Fase A
  // reclassify (que já existe). Aqui não tocamos.

  if (Object.keys(data).length === 0) {
    return {
      outcome: "no_match",
      fieldsWritten: 0,
      imagemFilled: false,
      bySource: { obf: obfHit, off: offHit },
    };
  }
  await prisma.produto.update({ where: { id: produto.id }, data });
  return {
    outcome: "wrote",
    fieldsWritten: Object.keys(data).length - (imagemFilled ? 1 : 0),
    imagemFilled,
    bySource: { obf: obfHit, off: offHit },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function logSource(
  prisma: PrismaClient,
  produtoId: string,
  source: string,
  status: "SUCCESS" | "NO_MATCH" | "ERROR" | "PARTIAL_HIT",
  confidence: number | null,
  fieldsReturned: string[],
  errOrMsg?: unknown,
): Promise<void> {
  await prisma.enrichmentSourceLog.create({
    data: {
      produtoId,
      source,
      status,
      confidence,
      fieldsReturned,
      errorMessage:
        errOrMsg instanceof Error
          ? errOrMsg.message.slice(0, 500)
          : typeof errOrMsg === "string"
          ? errOrMsg.slice(0, 500)
          : null,
    },
  });
}

async function enqueueReview(
  prisma: PrismaClient,
  produtoId: string,
  tipoRevisao: "CONFLITO" | "ENRIQUECIMENTO_FALHOU" | "CLASSIFICACAO_PENDENTE" | "FABRICANTE_PENDENTE",
  dadosOrigem: Prisma.InputJsonValue,
): Promise<void> {
  const existing = await prisma.filaRevisao.findFirst({
    where: { produtoId, tipoRevisao, estado: "PENDENTE" },
    select: { id: true },
  });
  if (existing) return;
  await prisma.filaRevisao.create({
    data: {
      produtoId,
      tipoRevisao,
      prioridade: "MEDIA",
      estado: "PENDENTE",
      dadosOrigem,
    },
  });
}

// ─── Entry point ────────────────────────────────────────────────────────

export async function runRetailTick(
  options: RetailTickOptions,
): Promise<RetailTickSummary> {
  const t0 = new Date();
  const { prisma } = options;
  const maxProducts = options.maxProducts ?? DEFAULT_MAX_PRODUCTS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const deadline = t0.getTime() + maxDurationMs;

  const summary: RetailTickSummary = {
    startedAt: t0.toISOString(),
    durationMs: 0,
    processed: 0,
    outcomes: {
      fieldsWritten: 0,
      imagemFilled: 0,
      enqueuedReview: 0,
      noMatch: 0,
      errors: 0,
    },
    bySource: { obfHits: 0, offHits: 0, obfMisses: 0, offMisses: 0 },
    stoppedReason: "no_candidates",
  };

  const candidates = await selectCandidates(prisma, maxProducts * 2, options.productTypes);
  if (candidates.length === 0) {
    summary.durationMs = Date.now() - t0.getTime();
    return summary;
  }

  for (const produto of candidates) {
    if (summary.processed >= maxProducts) {
      summary.stoppedReason = "max_products";
      break;
    }
    if (Date.now() > deadline) {
      summary.stoppedReason = "deadline";
      break;
    }
    summary.processed++;
    try {
      const r = await processProduto(prisma, produto);
      summary.outcomes.fieldsWritten += r.fieldsWritten;
      if (r.imagemFilled) summary.outcomes.imagemFilled++;
      if (r.outcome === "review") summary.outcomes.enqueuedReview++;
      if (r.outcome === "no_match") summary.outcomes.noMatch++;
      if (r.outcome === "error") summary.outcomes.errors++;
      if (r.bySource.obf) summary.bySource.obfHits++;
      else summary.bySource.obfMisses++;
      if (r.bySource.off) summary.bySource.offHits++;
      else summary.bySource.offMisses++;
    } catch (err) {
      console.error("[retail-enrichment] produto threw:", err);
      summary.outcomes.errors++;
    }
  }

  if (summary.processed >= maxProducts) summary.stoppedReason = "max_products";
  summary.durationMs = Date.now() - t0.getTime();
  return summary;
}
