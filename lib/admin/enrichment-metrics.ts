import "server-only";
import { getPrisma } from "@/lib/prisma";
import { Prisma, type EnrichmentSourceStatus, type VerificationStatus } from "@/generated/prisma/client";
import { getConnectorsForProductType } from "@/lib/catalog-connectors";
import { MIN_CATALOGUABLE_CNP } from "@/lib/catalog-enrichment";
import type { ProductType } from "@/lib/catalog-types";

/**
 * lib/admin/enrichment-metrics.ts
 *
 * Aggregations read-only para o painel /admin/catalogo. Combina:
 *   · `EnrichmentSourceLog` — telemetria por chamada de conector.
 *   · `Produto` — coverage actual dos campos canónicos.
 *   · `FilaRevisao` — conflitos pendentes.
 *   · `getConnectorsForProductType` — estado do routing (que conectores
 *      estão activos por tipo).
 *
 * Tudo tenant-safe via getPrisma(). Nunca muta dados.
 */

const PRODUCT_TYPES: ProductType[] = [
  "MEDICAMENTO",
  "SUPLEMENTO",
  "DERMOCOSMETICA",
  "DISPOSITIVO_MEDICO",
  "HIGIENE_CUIDADO",
  "ORTOPEDIA",
  "PUERICULTURA",
  "VETERINARIA",
  "OUTRO",
];

const RETAIL_SOURCE_NAME = "retail_pharmacy";
const NO_MATCH_WARN_THRESHOLD = 0.85;
const ERROR_WARN_THRESHOLD = 0.20;

// ─── Connector performance ───────────────────────────────────────────────────

export type ConnectorSummary = {
  source: string;
  attempts: number;
  successes: number;
  noMatches: number;
  errors: number;
  successRate: number;
  noMatchRate: number;
  errorRate: number;
  avgConfidence: number | null;
  avgDurationMs: number | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorMessage: string | null;
  /** True quando o conector nunca corre (não está em CONNECTORS_BY_TYPE). */
  routedAtAll: boolean;
};

type RawCallRow = {
  source: string;
  status: EnrichmentSourceStatus;
  confidence: number | null;
  durationMs: number | null;
  createdAt: Date;
  errorMessage: string | null;
};

function bucketize(rows: RawCallRow[], routedSources: Set<string>): ConnectorSummary[] {
  const map = new Map<
    string,
    {
      attempts: number;
      successes: number;
      noMatches: number;
      errors: number;
      confSum: number;
      confCount: number;
      durSum: number;
      durCount: number;
      lastSuccessAt: Date | null;
      lastFailureAt: Date | null;
      lastErrorMessage: string | null;
    }
  >();

  function bucket(source: string) {
    let b = map.get(source);
    if (!b) {
      b = {
        attempts: 0,
        successes: 0,
        noMatches: 0,
        errors: 0,
        confSum: 0,
        confCount: 0,
        durSum: 0,
        durCount: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastErrorMessage: null,
      };
      map.set(source, b);
    }
    return b;
  }

  for (const r of rows) {
    const b = bucket(r.source);
    b.attempts++;
    if (r.durationMs != null) {
      b.durSum += r.durationMs;
      b.durCount++;
    }
    if (r.status === "SUCCESS") {
      b.successes++;
      if (r.confidence != null) {
        b.confSum += r.confidence;
        b.confCount++;
      }
      if (!b.lastSuccessAt || r.createdAt > b.lastSuccessAt) {
        b.lastSuccessAt = r.createdAt;
      }
    } else if (r.status === "NO_MATCH") {
      b.noMatches++;
      if (!b.lastFailureAt || r.createdAt > b.lastFailureAt) {
        b.lastFailureAt = r.createdAt;
      }
    } else {
      b.errors++;
      if (!b.lastFailureAt || r.createdAt > b.lastFailureAt) {
        b.lastFailureAt = r.createdAt;
        b.lastErrorMessage = r.errorMessage;
      }
    }
  }

  // Inclui sources que estão routed mas sem chamadas — ainda aparecem com 0s.
  for (const s of routedSources) {
    if (!map.has(s)) bucket(s);
  }

  const result: ConnectorSummary[] = [];
  for (const [source, b] of map.entries()) {
    result.push({
      source,
      attempts: b.attempts,
      successes: b.successes,
      noMatches: b.noMatches,
      errors: b.errors,
      successRate: b.attempts === 0 ? 0 : b.successes / b.attempts,
      noMatchRate: b.attempts === 0 ? 0 : b.noMatches / b.attempts,
      errorRate: b.attempts === 0 ? 0 : b.errors / b.attempts,
      avgConfidence: b.confCount === 0 ? null : b.confSum / b.confCount,
      avgDurationMs: b.durCount === 0 ? null : b.durSum / b.durCount,
      lastSuccessAt: b.lastSuccessAt,
      lastFailureAt: b.lastFailureAt,
      lastErrorMessage: b.lastErrorMessage,
      routedAtAll: routedSources.has(source),
    });
  }

  result.sort((a, b) => b.attempts - a.attempts);
  return result;
}

/**
 * Devolve o resumo dos conectores nos últimos `daysBack` dias.
 * Default 7. Inclui conectores routed mesmo sem chamadas (com 0s).
 */
export async function loadConnectorSummary(daysBack = 7): Promise<ConnectorSummary[]> {
  const prisma = await getPrisma();
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  const rows = await prisma.enrichmentSourceLog.findMany({
    where: { createdAt: { gte: since } },
    select: {
      source: true,
      status: true,
      confidence: true,
      durationMs: true,
      createdAt: true,
      errorMessage: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50_000,
  });

  // Sources que aparecem em CONNECTORS_BY_TYPE (mesmo que ainda nunca tenham corrido).
  const routedSources = new Set<string>();
  for (const t of PRODUCT_TYPES) {
    for (const c of getConnectorsForProductType(t)) routedSources.add(c.name);
  }

  return bucketize(rows as RawCallRow[], routedSources);
}

// ─── Field outcome by source ─────────────────────────────────────────────────

export type FieldByConnectorRow = {
  source: string;
  field: string;
  count: number;
};

/**
 * Quantas vezes cada campo foi devolvido por cada fonte (últimos `daysBack` dias).
 * Útil para responder "que fonte está a alimentar fabricante / categoria / ATC?".
 */
export async function loadFieldsByConnector(daysBack = 7): Promise<FieldByConnectorRow[]> {
  const prisma = await getPrisma();
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  // unnest(fieldsReturned) e groupar por (source, field). PostgreSQL nativo.
  const rows = await prisma.$queryRaw<Array<{ source: string; field: string; count: bigint }>>(
    Prisma.sql`
      SELECT source, field, COUNT(*)::bigint AS count
      FROM "EnrichmentSourceLog", unnest("fieldsReturned") AS field
      WHERE "createdAt" >= ${since}
        AND status = 'SUCCESS'
      GROUP BY source, field
      ORDER BY count DESC
    `
  );

  return rows.map((r) => ({
    source: r.source,
    field: r.field,
    count: Number(r.count),
  }));
}

// ─── Pipeline summary ────────────────────────────────────────────────────────

export type PipelineSummary = {
  productsTotal: number;
  /**
   * Produtos catalogáveis: cnp > MIN_CATALOGUABLE_CNP. Os restantes são
   * códigos internos/ERP (taxas, serviços, atos clínicos, stock interno)
   * que ficam fora do enriquecimento web.
   */
  productsCataloguable: number;
  /** Produtos com cnp <= MIN_CATALOGUABLE_CNP — excluídos do enriquecimento. */
  productsInternalNonCataloguable: number;
  productsByVerificationStatus: Record<VerificationStatus, number>;
  productsEnrichedToday: number;
  productsEnrichedLast7Days: number;
  productsEnrichedLast30Days: number;
  productsValidatedManually: number;
  productsNeedsManualReview: number;
  productsByOrigemDados: Record<string, number>;
};

/**
 * Resumo macro do estado do catálogo. Não depende de EnrichmentSourceLog
 * — funciona mesmo antes da instrumentação correr pela primeira vez.
 */
export async function loadPipelineSummary(): Promise<PipelineSummary> {
  const prisma = await getPrisma();
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const where = { estado: { not: "INATIVO" as const } };
  const cataloguableWhere = {
    ...where,
    cnp: { gt: MIN_CATALOGUABLE_CNP },
  };

  const [
    productsTotal,
    productsCataloguable,
    byStatus,
    enrichedToday,
    enriched7,
    enriched30,
    validatedManually,
    needsManualReview,
    byOrigem,
  ] = await Promise.all([
    prisma.produto.count({ where }),
    prisma.produto.count({ where: cataloguableWhere }),
    prisma.produto.groupBy({
      by: ["verificationStatus"],
      where,
      _count: true,
    }),
    prisma.produto.count({
      where: { ...where, lastVerifiedAt: { gte: startOfToday } },
    }),
    prisma.produto.count({
      where: { ...where, lastVerifiedAt: { gte: sevenDaysAgo } },
    }),
    prisma.produto.count({
      where: { ...where, lastVerifiedAt: { gte: thirtyDaysAgo } },
    }),
    prisma.produto.count({ where: { ...where, validadoManualmente: true } }),
    prisma.produto.count({ where: { ...where, needsManualReview: true } }),
    prisma.produto.groupBy({
      by: ["origemDados"],
      where,
      _count: true,
    }),
  ]);

  const productsByVerificationStatus: Record<VerificationStatus, number> = {
    PENDING: 0,
    IN_PROGRESS: 0,
    VERIFIED: 0,
    PARTIALLY_VERIFIED: 0,
    FAILED: 0,
    NEEDS_REVIEW: 0,
  };
  for (const r of byStatus) productsByVerificationStatus[r.verificationStatus] = r._count;

  const productsByOrigemDados: Record<string, number> = {};
  for (const r of byOrigem) productsByOrigemDados[r.origemDados] = r._count;

  return {
    productsTotal,
    productsCataloguable,
    productsInternalNonCataloguable: Math.max(0, productsTotal - productsCataloguable),
    productsByVerificationStatus,
    productsEnrichedToday: enrichedToday,
    productsEnrichedLast7Days: enriched7,
    productsEnrichedLast30Days: enriched30,
    productsValidatedManually: validatedManually,
    productsNeedsManualReview: needsManualReview,
    productsByOrigemDados,
  };
}

// ─── Field coverage (Produto.* not-null %) ───────────────────────────────────

export type FieldCoverage = {
  field: string;
  filled: number;
  total: number;
  ratio: number;
};

export async function loadFieldCoverage(): Promise<FieldCoverage[]> {
  const prisma = await getPrisma();
  const where = { estado: { not: "INATIVO" as const } };

  const [total, fab, n1, n2, atc, dci, productTypeNotOutro, formaFarm, dosagem, embalagem, imagem] =
    await Promise.all([
      prisma.produto.count({ where }),
      prisma.produto.count({ where: { ...where, fabricanteId: { not: null } } }),
      prisma.produto.count({ where: { ...where, classificacaoNivel1Id: { not: null } } }),
      prisma.produto.count({ where: { ...where, classificacaoNivel2Id: { not: null } } }),
      prisma.produto.count({ where: { ...where, codigoATC: { not: null } } }),
      prisma.produto.count({ where: { ...where, dci: { not: null } } }),
      prisma.produto.count({ where: { ...where, productType: { not: "OUTRO" } } }),
      prisma.produto.count({ where: { ...where, formaFarmaceutica: { not: null } } }),
      prisma.produto.count({ where: { ...where, dosagem: { not: null } } }),
      prisma.produto.count({ where: { ...where, embalagem: { not: null } } }),
      prisma.produto.count({ where: { ...where, imagemUrl: { not: null } } }),
    ]);

  const make = (field: string, filled: number): FieldCoverage => ({
    field,
    filled,
    total,
    ratio: total === 0 ? 0 : filled / total,
  });

  return [
    make("productType (≠ OUTRO)", productTypeNotOutro),
    make("fabricante", fab),
    make("classificacao N1", n1),
    make("classificacao N2", n2),
    make("ATC", atc),
    make("DCI", dci),
    make("forma farmacêutica", formaFarm),
    make("dosagem", dosagem),
    make("embalagem", embalagem),
    make("imagemUrl", imagem),
  ];
}

// ─── Conflicts ───────────────────────────────────────────────────────────────

export type ConflictsSummary = {
  pendingTotal: number;
  pendingConflictTipo: number;
  recentNeedsReview: number;
};

export async function loadConflictsSummary(): Promise<ConflictsSummary> {
  const prisma = await getPrisma();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [pendingTotal, pendingConflictTipo, recentNeedsReview] = await Promise.all([
    prisma.filaRevisao.count({ where: { estado: "PENDENTE" } }),
    prisma.filaRevisao.count({
      where: { estado: "PENDENTE", tipoRevisao: "CONFLITO" },
    }),
    prisma.produto.count({
      where: {
        verificationStatus: "NEEDS_REVIEW",
        lastVerificationAttemptAt: { gte: sevenDaysAgo },
      },
    }),
  ]);

  return { pendingTotal, pendingConflictTipo, recentNeedsReview };
}

// ─── Connector status / warnings ─────────────────────────────────────────────

export type ConnectorStatus = {
  source: string;
  routedTypes: ProductType[];
};

export type Warning = {
  level: "info" | "warn" | "error";
  source?: string;
  message: string;
};

export function loadConnectorRouting(): ConnectorStatus[] {
  const map = new Map<string, ProductType[]>();
  for (const t of PRODUCT_TYPES) {
    for (const c of getConnectorsForProductType(t)) {
      const list = map.get(c.name) ?? [];
      list.push(t);
      map.set(c.name, list);
    }
  }
  return Array.from(map.entries())
    .map(([source, routedTypes]) => ({ source, routedTypes }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * Computa avisos derivados das outras métricas — não faz queries próprias.
 * Foco: chamar atenção a conectores tóxicos (alta taxa de erro), conector
 * retail_pharmacy desligado/em mau estado, ausência total de logs.
 */
export function computeWarnings(
  connectors: ConnectorSummary[],
  routed: ConnectorStatus[]
): Warning[] {
  const warnings: Warning[] = [];
  const routedNames = new Set(routed.map((r) => r.source));

  // 1. retail_pharmacy: estado actual.
  const retail = connectors.find((c) => c.source === RETAIL_SOURCE_NAME);
  if (!routedNames.has(RETAIL_SOURCE_NAME)) {
    warnings.push({
      level: "info",
      source: RETAIL_SOURCE_NAME,
      message:
        "retail_pharmacy não está em CONNECTORS_BY_TYPE — desligado. Active-o se quiser captar imagens/categorias para produtos não-medicamento.",
    });
  } else if (retail) {
    if (retail.attempts === 0) {
      warnings.push({
        level: "info",
        source: RETAIL_SOURCE_NAME,
        message:
          "retail_pharmacy está routed mas sem chamadas nos últimos 7 dias.",
      });
    } else {
      if (retail.errorRate >= ERROR_WARN_THRESHOLD) {
        warnings.push({
          level: "warn",
          source: RETAIL_SOURCE_NAME,
          message: `retail_pharmacy com taxa de erro elevada (${(retail.errorRate * 100).toFixed(0)}%). DDG HTML scrape é frágil; considere desligar até estabilizar.`,
        });
      }
      if (retail.noMatchRate >= NO_MATCH_WARN_THRESHOLD) {
        warnings.push({
          level: "warn",
          source: RETAIL_SOURCE_NAME,
          message: `retail_pharmacy com ${(retail.noMatchRate * 100).toFixed(0)}% de no-match. Está a render pouco — avaliar manter ligado.`,
        });
      }
    }
  }

  // 2. Outros conectores routed com taxa de erro elevada.
  for (const c of connectors) {
    if (c.source === RETAIL_SOURCE_NAME) continue;
    if (c.attempts >= 10 && c.errorRate >= ERROR_WARN_THRESHOLD) {
      warnings.push({
        level: "warn",
        source: c.source,
        message: `${c.source}: ${c.errors} erros em ${c.attempts} chamadas (${(c.errorRate * 100).toFixed(0)}%). Último erro: ${c.lastErrorMessage ?? "—"}`,
      });
    }
  }

  // 3. Pipeline sem qualquer log nos últimos 7 dias.
  const totalAttempts = connectors.reduce((s, c) => s + c.attempts, 0);
  if (totalAttempts === 0) {
    warnings.push({
      level: "info",
      message:
        "Sem chamadas a conectores nos últimos 7 dias. O worker está a correr? Há produtos PENDENTE na fila?",
    });
  }

  return warnings;
}
