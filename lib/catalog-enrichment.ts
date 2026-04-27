/**
 * lib/catalog-enrichment.ts
 *
 * Orquestrador do pipeline de enriquecimento do catálogo SPharm.MT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARQUITECTURA EM CAMADAS
 *
 *   1. CLASSIFICAÇÃO (catalog-classifier.ts)
 *      Pré-classificação interna baseada em sinais do produto:
 *      flagMSRM/MNSRM → codigoATC → tipoArtigo → padrões textuais.
 *      Produz: productType, confidence, classificationSource, hints.
 *
 *   2. CONECTORES (catalog-connectors.ts)
 *      Execução independente de cada conector externo.
 *      Cada conector devolve ExternalSourceData normalizado.
 *      Nenhum conector escreve na BD.
 *      Conectores activos: internal_pharmacy_data.
 *      Stubs: infarmed, open_beauty_facts, open_food_facts, eudamed.
 *
 *   3. RESOLUÇÃO (catalog-resolution-engine.ts)
 *      Combina sinais internos + externos por campo.
 *      Detecta conflitos. Calcula verificationStatus.
 *      Produz ResolvedProduct uniforme.
 *
 *   4. PERSISTÊNCIA (catalog-persistence.ts)
 *      Filtra campos por relevância e limiares de confiança.
 *      Nunca sobrescreve campos preenchidos ou validados manualmente.
 *      Grava metadados de verificação e histórico.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPERAÇÃO CONTÍNUA
 *
 *   Job diário  (scripts/jobs/daily-enrich.ts)
 *     — produtos novos, sem lastVerifiedAt, ou com verificationStatus=PENDING
 *
 *   Job semanal (scripts/jobs/weekly-reverify.ts)
 *     — produtos não verificados há X dias, tipo OUTRO, baixa confiança,
 *       sem imagem, ou com classificationVersion antiga
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { legacyPrisma as prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { classifyProductType, CLASSIFICATION_VERSION } from "./catalog-classifier";
import { runConnectors, type SourceCallEntry } from "./catalog-connectors";
import { resolveProduct } from "./catalog-resolution-engine";
import { persistResolvedProduct } from "./catalog-persistence";
import type {
  EnrichmentResult,
  EnrichmentSummary,
  EnrichmentTracer,
  ExternalLookupRequest,
  ProductType,
} from "./catalog-types";

/**
 * Logger que persiste cada chamada de conector em `EnrichmentSourceLog`.
 * Falhas de escrita são silenciadas — instrumentação nunca pode partir
 * o pipeline. O caller espera uma Promise<void>.
 */
async function persistSourceCall(entry: SourceCallEntry): Promise<void> {
  try {
    await prisma.enrichmentSourceLog.create({
      data: {
        produtoId: entry.productId,
        source: entry.source,
        status: entry.status,
        confidence: entry.confidence,
        matchedBy: entry.matchedBy,
        durationMs: entry.durationMs,
        fieldsReturned: entry.fieldsReturned,
        errorMessage: entry.errorMessage,
        url: entry.url,
        query: entry.query,
        rawBrand: entry.rawBrand,
        rawCategory: entry.rawCategory,
        rawProductName: entry.rawProductName,
      },
    });
  } catch (err) {
    // Best-effort — não interromper enrichProduct por causa de telemetria.
    console.warn(
      `[enrichment] falhou a gravar EnrichmentSourceLog para ${entry.source}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// ─── Agregação de sinais de origem (ProdutoFarmacia.*Origem) ─────────────────

export type OrigemSignals = {
  categoriaOrigem: string | null;
  subcategoriaOrigem: string | null;
};

/**
 * Agrega os sinais úteis para classificação a partir das ProdutoFarmacia
 * associadas ao produto.
 *
 * Devolve APENAS categoria e subcategoria. O `fornecedorOrigem`
 * (grossista habitual — Empifarma, OCP, …) NÃO é incluído porque:
 *   a) não é fabricante,
 *   b) não é um sinal fiável de tipo de produto,
 *   c) historicamente gerou falsos positivos no classificador.
 *
 * Devolve todos-null se o produto não tem ProdutoFarmacia ou se nenhuma
 * categoria está preenchida.
 */
export async function fetchOrigemSignals(produtoId: string): Promise<OrigemSignals> {
  const records = await prisma.produtoFarmacia.findMany({
    where: { produtoId },
    select: {
      categoriaOrigem: true,
      subcategoriaOrigem: true,
      familiaOrigem: true,
    },
  });

  if (records.length === 0) {
    return { categoriaOrigem: null, subcategoriaOrigem: null };
  }

  const catFreq = new Map<string, number>();
  for (const r of records) {
    const cat = r.categoriaOrigem ?? r.familiaOrigem;
    if (cat) catFreq.set(cat, (catFreq.get(cat) ?? 0) + 1);
  }
  const topCat = catFreq.size > 0
    ? [...catFreq.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;

  const topSubcat = records.find(r => r.subcategoriaOrigem !== null)?.subcategoriaOrigem ?? null;

  return {
    categoriaOrigem: topCat,
    subcategoriaOrigem: topSubcat,
  };
}

// ─── Tipos de selecção ────────────────────────────────────────────────────────

export type DailyEnrichmentCriteria = {
  /** Produtos criados nas últimas N horas (default: 24) */
  createdWithinHours?: number;
  limit?: number;
  dryRun?: boolean;
};

export type WeeklyReverificationCriteria = {
  /** Produtos não verificados há mais de N dias (default: 30) */
  notVerifiedDays?: number;
  /** Incluir produtos com productTypeConfidence < threshold (default: 0.75) */
  lowConfidenceThreshold?: number;
  /** Incluir produtos cuja classificationVersion difere da actual */
  includeOutdatedVersion?: boolean;
  limit?: number;
  dryRun?: boolean;
};

// ─── Selecção de produtos ─────────────────────────────────────────────────────

/**
 * Critérios do job diário:
 *   - verificationStatus = PENDING  (nunca verificado)
 *   - OU lastVerifiedAt IS NULL
 *   - OU criado nas últimas N horas
 *
 * Priorização: produtos na EnriquecimentoFila com prioridade ALTA primeiro.
 */
export async function getProductsForDailyEnrichment(
  criteria: DailyEnrichmentCriteria = {}
): Promise<Array<{ id: string; cnp: number; designacao: string; productType: ProductType | null }>> {
  const { createdWithinHours = 24, limit = 100 } = criteria;
  const since = new Date(Date.now() - createdWithinHours * 60 * 60 * 1000);

  const rows = await prisma.produto.findMany({
    where: {
      estado: { not: "INATIVO" },
      filaEnriquecimento: { none: { estado: "EM_PROCESSAMENTO" } },
      OR: [
        { verificationStatus: "PENDING" },
        { lastVerifiedAt: null },
        { dataCriacao: { gte: since } },
      ],
    },
    select: {
      id: true,
      cnp: true,
      designacao: true,
      productType: true,
      filaEnriquecimento: { select: { prioridade: true } },
    },
    orderBy: { dataCriacao: "asc" },
    take: limit * 3,
  });

  const PRIO: Record<string, number> = { ALTA: 0, MEDIA: 1, BAIXA: 2 };
  return rows
    .sort((a, b) => {
      const pa = PRIO[a.filaEnriquecimento[0]?.prioridade ?? "BAIXA"] ?? 3;
      const pb = PRIO[b.filaEnriquecimento[0]?.prioridade ?? "BAIXA"] ?? 3;
      return pa - pb;
    })
    .slice(0, limit)
    .map(r => ({ id: r.id, cnp: r.cnp, designacao: r.designacao, productType: r.productType as ProductType | null }));
}

/**
 * Critérios do job semanal:
 *   - Não verificados há mais de N dias
 *   - OU classificados como OUTRO
 *   - OU productTypeConfidence baixa
 *   - OU sem imagemUrl
 *   - OU classificationVersion diferente da versão actual
 */
export async function getProductsForWeeklyReverification(
  criteria: WeeklyReverificationCriteria = {}
): Promise<Array<{ id: string; cnp: number; designacao: string; productType: ProductType | null }>> {
  const {
    notVerifiedDays = 30,
    lowConfidenceThreshold = 0.75,
    includeOutdatedVersion = true,
    limit = 500,
  } = criteria;

  const cutoff = new Date(Date.now() - notVerifiedDays * 24 * 60 * 60 * 1000);

  // Razões pelas quais um produto merece reverificação:
  //   - nunca verificado ou cutoff ultrapassado
  //   - classificado como OUTRO (pode melhorar com mais sinais)
  //   - baixa confiança no tipo
  //   - sem imagem (oportunidade de enriquecer)
  //   - classificado com versão antiga das regras
  const orConditions: Prisma.ProdutoWhereInput[] = [
    { lastVerifiedAt: { lt: cutoff } },
    { productType: "OUTRO" },
    { productTypeConfidence: { lt: lowConfidenceThreshold } },
    { imagemUrl: null },
  ];

  if (includeOutdatedVersion) {
    orConditions.push({
      AND: [
        { classificationVersion: { not: null } },
        { classificationVersion: { not: CLASSIFICATION_VERSION } },
      ],
    });
  }

  /**
   * Exclusões do job semanal:
   *  1. Produtos validados manualmente — a persistência não tocaria neles
   *     e reverificá-los é desperdício, EXCEPTO se a versão de classificação
   *     estiver desactualizada (útil para refresh de metadados).
   *  2. Produtos já em processamento na fila.
   *  3. Produtos INATIVOS.
   *
   * Nota: não excluímos "sem imagem" para produtos validadoManualmente porque
   * a ausência de imagem pode ser legítima; a persistência nunca vai
   * sobrescrever, portanto rodar é seguro mas ineficiente — daí o filtro.
   */
  const manualProtectionFilter: Prisma.ProdutoWhereInput = includeOutdatedVersion
    ? {
        OR: [
          { validadoManualmente: false },
          {
            AND: [
              { validadoManualmente: true },
              {
                OR: [
                  { classificationVersion: null },
                  { classificationVersion: { not: CLASSIFICATION_VERSION } },
                ],
              },
            ],
          },
        ],
      }
    : { validadoManualmente: false };

  const rows = await prisma.produto.findMany({
    where: {
      estado: { not: "INATIVO" },
      filaEnriquecimento: { none: { estado: "EM_PROCESSAMENTO" } },
      AND: [manualProtectionFilter, { OR: orConditions }],
    },
    select: {
      id: true,
      cnp: true,
      designacao: true,
      productType: true,
    },
    take: limit,
  });

  return rows.map(r => ({ id: r.id, cnp: r.cnp, designacao: r.designacao, productType: r.productType as ProductType | null }));
}

// ─── Fila de enriquecimento ───────────────────────────────────────────────────

type EnriquecimentoEstadoValue =
  | "PENDENTE" | "EM_PROCESSAMENTO" | "SUCESSO" | "SUCESSO_PARCIAL" | "FALHOU";

async function updateEnrichmentQueue(
  productId: string,
  estado: EnriquecimentoEstadoValue,
  options?: { mensagemErro?: string | null; ultimaFonte?: string | null }
): Promise<void> {
  const isAttempt = estado === "EM_PROCESSAMENTO";
  await prisma.enriquecimentoFila.upsert({
    where: { produtoId: productId },
    create: {
      produtoId: productId,
      estado,
      ultimaTentativa: isAttempt ? new Date() : undefined,
      numeroTentativas: isAttempt ? 1 : 0,
      ultimaFonte: options?.ultimaFonte ?? null,
      mensagemErro: options?.mensagemErro ?? null,
    },
    update: {
      estado,
      ...(isAttempt ? { ultimaTentativa: new Date(), numeroTentativas: { increment: 1 } } : {}),
      ...(options?.ultimaFonte !== undefined ? { ultimaFonte: options.ultimaFonte } : {}),
      ...(options?.mensagemErro !== undefined ? { mensagemErro: options.mensagemErro } : {}),
    },
  });
}

// ─── Fila de revisão manual ───────────────────────────────────────────────────

type TipoRevisaoValue =
  | "NOVO_PRODUTO" | "ENRIQUECIMENTO_FALHOU" | "CONFLITO"
  | "CLASSIFICACAO_PENDENTE" | "FABRICANTE_PENDENTE" | "OUTRO";

async function queueForManualReview(
  productId: string,
  motivo: string,
  dados?: unknown
): Promise<void> {
  const m = motivo.toLowerCase();
  let tipo: TipoRevisaoValue = "OUTRO";
  if (m.includes("conflito"))     tipo = "CONFLITO";
  else if (m.includes("classific")) tipo = "CLASSIFICACAO_PENDENTE";
  else if (m.includes("fabricante")) tipo = "FABRICANTE_PENDENTE";
  else if (m.includes("enriquecimento")) tipo = "ENRIQUECIMENTO_FALHOU";

  await prisma.filaRevisao.create({
    data: {
      produtoId: productId,
      tipoRevisao: tipo,
      prioridade: "MEDIA",
      estado: "PENDENTE",
      dadosOrigem: dados !== undefined
        ? (dados as Parameters<typeof prisma.filaRevisao.create>[0]["data"]["dadosOrigem"])
        : undefined,
    },
  });
}

// ─── Enriquecimento de produto único ─────────────────────────────────────────

/**
 * Enriquece e verifica um único produto:
 *
 *   1. Carrega o produto da BD.
 *   2. Classifica o tipo de produto (catalog-classifier.ts).
 *   3. Marca como IN_PROGRESS na fila de enriquecimento.
 *   4. Executa os conectores adequados (catalog-connectors.ts).
 *   5. Resolve o resultado uniforme (catalog-resolution-engine.ts).
 *   6. Persiste com filtros de relevância e confiança (catalog-persistence.ts).
 *   7. Cria revisão manual se necessário.
 *   8. Actualiza a fila de enriquecimento.
 */
export async function enrichProduct(
  productId: string,
  options?: { dryRun?: boolean; trace?: EnrichmentTracer; url?: string | null }
): Promise<EnrichmentResult> {
  const dryRun = options?.dryRun ?? false;
  const trace = options?.trace;
  const overrideUrl = options?.url ?? null;

  const product = await prisma.produto.findUnique({
    where: { id: productId },
    select: {
      id: true, cnp: true, designacao: true, tipoArtigo: true,
      flagMSRM: true, flagMNSRM: true, codigoATC: true,
      validadoManualmente: true,
    },
  });

  if (!product) {
    return {
      productId, cnp: null, status: "failed",
      productType: "OUTRO", productTypeConfidence: 0,
      verificationStatus: "FAILED", fieldsUpdated: [], queued: false, dryRun,
    };
  }

  // 1. Classificação — com sinais internos de taxonomia da farmácia
  //    (categoria/subcategoria apenas; fornecedor não é usado aqui)
  const origem = await fetchOrigemSignals(product.id);
  const classification = classifyProductType({
    designacao: product.designacao,
    tipoArtigo: product.tipoArtigo,
    flagMSRM: product.flagMSRM,
    flagMNSRM: product.flagMNSRM,
    codigoATC: product.codigoATC,
    categoriaOrigem: origem.categoriaOrigem,
    subcategoriaOrigem: origem.subcategoriaOrigem,
  });

  // 2. Marcar em processamento
  if (!dryRun) {
    await updateEnrichmentQueue(productId, "EM_PROCESSAMENTO");
    await prisma.produto.update({
      where: { id: productId },
      data: { verificationStatus: "IN_PROGRESS", lastVerificationAttemptAt: new Date() },
    });
  }

  // 3. Executar conectores
  const lookupReq: ExternalLookupRequest = {
    productId: product.id,
    cnp: product.cnp,
    designacao: product.designacao,
    productType: classification.productType,
    hints: classification.hints,
    trace,
    url: overrideUrl,
  };

  let sources;
  try {
    sources = await runConnectors(
      lookupReq,
      // Em dry-run não polui a tabela de métricas — os logs só fazem
      // sentido quando estamos a fazer enriquecimento real.
      dryRun ? undefined : persistSourceCall
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!dryRun) {
      await updateEnrichmentQueue(productId, "FALHOU", { mensagemErro: msg });
    }
    return {
      productId, cnp: product.cnp, status: "failed",
      productType: classification.productType,
      productTypeConfidence: classification.confidence,
      verificationStatus: "FAILED", fieldsUpdated: [], queued: false, dryRun,
    };
  }

  // 4. Resolução
  const resolved = resolveProduct(classification, sources);

  if (dryRun) {
    console.log(
      `  [${classification.productType} ${(classification.confidence * 100).toFixed(0)}%] CNP:${product.cnp} "${product.designacao}"`
    );
  }

  // 5. Persistência
  const persisted = await persistResolvedProduct({ productId, resolved, dryRun });

  // 6. Revisão manual se necessário.
  // Política Abril 2026: queue só se needsManualReview=true (gated pelo
  // resolver: conflito OU typeConf < 0.50 OU productType=OUTRO). Produtos
  // com `validadoManualmente=true` NUNCA são enfileirados — o admin já
  // decidiu, respeitar. Nota: usamos `resolved.needsManualReview` aqui
  // porque a persistência não altera a semântica de revisão; só o nível de
  // verificationStatus pode descer (VERIFIED → PARTIALLY_VERIFIED) quando
  // não houve campos de catálogo persistidos, mas isso não significa que
  // precise de revisão manual.
  let queued = false;
  if (!dryRun && resolved.needsManualReview && !product.validadoManualmente) {
    await queueForManualReview(
      productId,
      resolved.manualReviewReason ?? "Revisão automática",
      { classification, sourceSummary: resolved.sourceSummary, fieldsUpdated: persisted.fieldsUpdated }
    );
    queued = true;
  }

  // Debug — uma linha estruturada por produto. Reporta o productType e
  // confidence FINAL (após o resolver, não o do classifier). Se o
  // resolver fez upgrade via evidência externa (OUTRO → DERMOCOSMETICA
  // por breadcrumb/nome do produto), é o valor refinado que conta.
  // Reporta também `verificationStatus` *efectivo* — o que a
  // persistência acabou por gravar (pode diferir do que o resolver
  // sugeriu se nenhum campo de catálogo chegou a ser escrito).
  if (!dryRun) {
    const typeConfPct = (resolved.productTypeConfidence * 100).toFixed(0);
    const upgraded = resolved.productType !== classification.productType;
    const upgradeNote = upgraded
      ? ` (refined from ${classification.productType} ${(classification.confidence * 100).toFixed(0)}%)`
      : "";
    const fieldsStr = persisted.fieldsUpdated.length > 0
      ? persisted.fieldsUpdated.join(",")
      : "—";
    const statusNote =
      persisted.verificationStatus !== resolved.verificationStatus
        ? `${persisted.verificationStatus} (downgrade de ${resolved.verificationStatus})`
        : persisted.verificationStatus;
    console.log(
      `[enrich] cnp=${product.cnp ?? "?"} ` +
      `type=${resolved.productType} typeConf=${typeConfPct}%${upgradeNote} ` +
      `status=${statusNote} ` +
      `needsReview=${resolved.needsManualReview} ` +
      `queued=${queued}` +
      `${product.validadoManualmente ? " (validadoManualmente)" : ""} ` +
      `fields=[${fieldsStr}]`
    );
  }

  // 7. Actualizar fila de enriquecimento.
  //
  // Ordem de mapeamento (só executa se não-dry-run):
  //   verificationStatus VERIFIED              → SUCESSO
  //   verificationStatus PARTIALLY_VERIFIED    → SUCESSO_PARCIAL
  //   verificationStatus NEEDS_REVIEW          → FALHOU (precisa intervenção)
  //   sem campos persistidos E sem upgrade     → FALHOU
  //   por defeito (PENDING/IN_PROGRESS/FAILED) → SUCESSO_PARCIAL
  if (!dryRun) {
    const v = persisted.verificationStatus;
    const estadoFila: EnriquecimentoEstadoValue =
      v === "VERIFIED" ? "SUCESSO"
      : v === "PARTIALLY_VERIFIED" ? "SUCESSO_PARCIAL"
      : v === "NEEDS_REVIEW" ? "FALHOU"
      : persisted.fieldsUpdated.length === 0 ? "FALHOU"
      : "SUCESSO_PARCIAL";

    const primarySource = resolved.sourceSummary.primarySource;
    await updateEnrichmentQueue(productId, estadoFila, {
      ultimaFonte: primarySource,
    });
  }

  // Mapeamento final do EnrichmentResult.status — agora derivado do
  // verificationStatus efectivo, NÃO de fieldsUpdated.length. Razão:
  // produtos cujo único "field" útil foi a inferência de productType
  // (e cuja persistência é o próprio update do produtType) ficavam
  // marcados como `failed` mesmo com classificação correcta — confuso.
  const status: EnrichmentResult["status"] =
    persisted.verificationStatus === "VERIFIED" ? "success"
    : persisted.verificationStatus === "PARTIALLY_VERIFIED" ? "partial"
    : persisted.fieldsUpdated.length > 0 ? "partial"
    : "failed";

  return {
    productId,
    cnp: product.cnp,
    status,
    // O productType/confidence reportado é sempre o pós-resolver (autoridade
    // final). Se o classifier deu OUTRO 0.30 e o resolver upgradeu para
    // DERMOCOSMETICA 0.65 por evidência externa, é DERMOCOSMETICA 0.65 que
    // foi persistido — e é DERMOCOSMETICA 0.65 que reportamos.
    productType: resolved.productType,
    productTypeConfidence: resolved.productTypeConfidence,
    // verificationStatus reportado é o efectivo (pós-persistência).
    verificationStatus: persisted.verificationStatus,
    fieldsUpdated: persisted.fieldsUpdated,
    fieldDecisions: persisted.fieldDecisions,
    canonical: persisted.canonical,
    queued,
    dryRun,
  };
}

/**
 * Enriquece um único produto identificado por CNP. Helper usado pelo
 * comando `daily-enrich.ts --cnp=<cnp>` para diagnosticar produtos
 * específicos sem ter de descobrir o `produtoId` interno primeiro.
 *
 * Devolve null se nenhum Produto tiver esse CNP.
 */
export async function enrichProductByCnp(
  cnp: number,
  options?: { dryRun?: boolean; trace?: EnrichmentTracer; url?: string | null }
): Promise<EnrichmentResult | null> {
  const p = await prisma.produto.findUnique({
    where: { cnp },
    select: { id: true },
  });
  if (!p) return null;
  return enrichProduct(p.id, options);
}

// ─── Enriquecimento em lote ───────────────────────────────────────────────────

/**
 * Enriquece múltiplos produtos em lote sequencial.
 * Compatível com scripts/enrich-products.ts (interface existente).
 */
export async function enrichPendingProducts(options?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<EnrichmentSummary> {
  const { limit = 50, dryRun = false } = options ?? {};

  const products = await getProductsForDailyEnrichment({ limit, dryRun });
  console.log(`Encontrados ${products.length} produto(s) para enriquecimento`);

  return runBatch(products.map(p => p.id), dryRun);
}

/**
 * Reverifica produtos em lote (job semanal).
 */
export async function reverifyProducts(options?: {
  criteria?: WeeklyReverificationCriteria;
  dryRun?: boolean;
}): Promise<EnrichmentSummary> {
  const { criteria = {}, dryRun = false } = options ?? {};

  const products = await getProductsForWeeklyReverification({ ...criteria, dryRun });
  console.log(`Encontrados ${products.length} produto(s) para reverificação`);

  return runBatch(products.map(p => p.id), dryRun);
}

async function runBatch(productIds: string[], dryRun: boolean): Promise<EnrichmentSummary> {
  const summary: EnrichmentSummary = { total: productIds.length, success: 0, partial: 0, failed: 0, queued: 0 };

  for (const productId of productIds) {
    try {
      const result = await enrichProduct(productId, { dryRun });
      if (result.status === "success")  summary.success++;
      else if (result.status === "partial") summary.partial++;
      else summary.failed++;
      if (result.queued) summary.queued++;
    } catch (err) {
      summary.failed++;
      console.error(
        `  [erro] ${productId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return summary;
}

// Re-exportar tipos públicos
export type { EnrichmentResult, EnrichmentSummary } from "./catalog-types";
