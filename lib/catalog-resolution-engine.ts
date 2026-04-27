/**
 * lib/catalog-resolution-engine.ts
 *
 * Motor de resolução do catálogo SPharm.MT.
 *
 * Combina sinais internos (classificação) com dados externos (conectores)
 * para produzir um resultado final uniforme por produto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRINCÍPIOS
 *
 *  1. Decisão POR CAMPO, não por fonte global.
 *     Um campo pode ser resolvido pela fonte A enquanto outro é resolvido
 *     pela fonte B — cada campo é avaliado independentemente.
 *
 *  2. Desempate por TIER.
 *     Se duas fontes têm confiança igual, ganha a de tier mais autoritário
 *     (REGULATORY > MANUFACTURER > DISTRIBUTOR > RETAIL > INTERNAL_INFERRED).
 *
 *  3. Acordo entre fontes reforça a confiança.
 *     +5% por fonte concordante adicional (máx. +15%).
 *
 *  4. Conflitos são EXPLÍCITOS, não silenciados.
 *     Quando ≥2 fontes com confiança ≥ threshold divergem num campo,
 *     isso é registado em `conflicts` e força verificationStatus=NEEDS_REVIEW.
 *
 *  5. A relevância por productType é inviolável.
 *     Campos irrelevantes (ex: DCI em dermocosmética) NUNCA são resolvidos,
 *     mesmo que alguma fonte tenha devolvido valor.
 * ─────────────────────────────────────────────────────────────────────────────
 * SEMÂNTICA DE verificationStatus (política Abril 2026 — corrigida)
 *
 * Política: aceitar mais classificações automáticas para reduzir backlog
 * de revisão manual. O GATE para revisão manual é a confiança do TIPO
 * (`productTypeConfidence`, vinda do classifier), NÃO a confiança máxima
 * dos campos externos. Justificação: um MEDICAMENTO com flagMSRM dá
 * typeConf=0.99 e devia ser auto-classificado mesmo sem match em INFARMED;
 * a falta de campos externos não devia mandá-lo para revisão.
 *
 *   NEEDS_REVIEW       → (a) conflito entre fontes em campos críticos, OU
 *                         (b) typeConf < 0.50 (classifier não conseguiu
 *                             identificar tipo de produto com confiança).
 *                         É a única origem de needsManualReview=true.
 *
 *   VERIFIED           → typeConf ≥ 0.50 E maxFieldConf ≥ 0.75 — temos
 *                         tipo com confiança suficiente E confirmação
 *                         externa forte (INFARMED ou múltiplas fontes).
 *
 *   PARTIALLY_VERIFIED → typeConf ≥ 0.50, sem confirmação externa forte.
 *                         "Auto-classified" — os campos resolvidos foram
 *                         persistidos automaticamente; weekly reverify
 *                         pode melhorar quando aparecerem mais fontes.
 *
 *   FAILED             → mantido no enum por compatibilidade; já não é
 *                         emitido pelo resolver.
 *
 * Persistência (catalog-persistence.ts) escreve campos com confidence ≥ 0.50
 * — alinhado com este policy. O bloqueio de tier para campos autoritários
 * (fabricante/dci/atc) continua a só aceitar REGULATORY/MANUFACTURER.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  ClassificationResult,
  ExternalSourceData,
  FieldConflict,
  ProductFieldRelevance,
  ResolvedField,
  ResolvedProduct,
  SourceSummary,
  SourceTier,
  VerificationStatus,
} from "./catalog-types";
import { SOURCE_TIER_RANK } from "./catalog-types";
import { getFieldRelevance } from "./catalog-classifier";

// ─── Helpers internos ─────────────────────────────────────────────────────────

type StringGetter = (src: ExternalSourceData) => string | null;

interface FieldSpec {
  name: string;
  getter: StringGetter;
  relevant: boolean;
  /**
   * Se presente, só aceita candidatos de fontes com tier nesta lista.
   * Usado para campos autoritários (fabricante, dci, atc) que nunca devem
   * ser resolvidos a partir de fontes de baixa autoridade, mesmo que essas
   * fontes devolvam um valor.
   */
  allowedTiers?: SourceTier[];
}

/** Tiers autorizados a preencher campos autoritários (fabricante, DCI, ATC). */
const AUTHORITATIVE_TIERS: SourceTier[] = ["REGULATORY", "MANUFACTURER"];

type Candidate = {
  value: string;
  normalized: string;
  confidence: number;
  source: string;
  tier: SourceTier;
};

const CONFLICT_THRESHOLD = 0.60;

/**
 * Banda baixa: abaixo disto a evidência não é suficientemente fiável para
 * persistir automaticamente — o produto vai para a fila de revisão manual.
 * Alinhado com `THRESHOLD_PARTIAL` em catalog-persistence.ts.
 */
const MIN_USEFUL_CONFIDENCE = 0.50;
/**
 * Banda alta: confiança suficiente para `verificationStatus = VERIFIED`.
 * Não confundir com persistência — produtos com 0.50 ≤ conf < 0.75 também
 * têm campos persistidos, mas mantêm `verificationStatus = PARTIALLY_VERIFIED`.
 */
const VERIFIED_THRESHOLD    = 0.75;

function collectCandidates(
  getter: StringGetter,
  sources: ExternalSourceData[],
  allowedTiers?: SourceTier[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const src of sources) {
    if (allowedTiers && !allowedTiers.includes(src.tier)) continue;
    const raw = getter(src);
    if (raw && raw.trim().length > 0) {
      const trimmed = raw.trim();
      out.push({
        value: trimmed,
        normalized: trimmed.toLowerCase(),
        confidence: src.confidence,
        source: src.source,
        tier: src.tier,
      });
    }
  }
  return out;
}

/**
 * Resolve um único campo.
 *
 * Regras:
 *  - Agrupa candidatos por valor normalizado (case-insensitive).
 *  - Para cada grupo: score = max(confidence) + min(0.05 × (n-1), 0.15).
 *  - Vencedor = grupo com maior score; desempate por menor tier rank (mais autoritário).
 *  - Dentro do grupo vencedor, escolhe o candidato de tier mais autoritário.
 */
function resolveField(
  spec: FieldSpec,
  sources: ExternalSourceData[]
): ResolvedField<string> | null {
  if (!spec.relevant) return null;

  const candidates = collectCandidates(spec.getter, sources, spec.allowedTiers);
  if (candidates.length === 0) return null;

  // Agrupa por valor normalizado
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const g = groups.get(c.normalized);
    if (g) g.push(c);
    else groups.set(c.normalized, [c]);
  }

  // Pontuação e desempate por tier
  let bestScore = -Infinity;
  let bestTierRank = Infinity;
  let winningGroup: Candidate[] | null = null;

  for (const group of groups.values()) {
    const maxConf = Math.max(...group.map(c => c.confidence));
    const agreementBonus = Math.min((group.length - 1) * 0.05, 0.15);
    const score = Math.min(maxConf + agreementBonus, 1.0);
    const topTierRank = Math.min(...group.map(c => SOURCE_TIER_RANK[c.tier]));

    if (
      score > bestScore ||
      (score === bestScore && topTierRank < bestTierRank)
    ) {
      bestScore = score;
      bestTierRank = topTierRank;
      winningGroup = group;
    }
  }

  if (!winningGroup) return null;

  // Dentro do grupo vencedor, escolhe o candidato de tier mais autoritário;
  // desempate seguinte: maior confiança.
  const winner = [...winningGroup].sort((a, b) => {
    const tierDiff = SOURCE_TIER_RANK[a.tier] - SOURCE_TIER_RANK[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return b.confidence - a.confidence;
  })[0];

  return {
    value: winner.value,
    confidence: bestScore,
    source: winner.source,
    tier: winner.tier,
    agreementCount: winningGroup.length,
  };
}

/**
 * Detecta conflito: ≥2 fontes divergentes com confiança ≥ CONFLICT_THRESHOLD.
 * Devolve o conflito estruturado ou null.
 */
function detectConflict(
  spec: FieldSpec,
  sources: ExternalSourceData[]
): FieldConflict | null {
  if (!spec.relevant) return null;

  const qualifying = collectCandidates(spec.getter, sources)
    .filter(c => c.confidence >= CONFLICT_THRESHOLD);

  if (qualifying.length < 2) return null;

  const distinctValues = new Set(qualifying.map(c => c.normalized));
  if (distinctValues.size < 2) return null;

  return {
    field: spec.name,
    values: qualifying.map(c => ({
      value: c.value,
      source: c.source,
      tier: c.tier,
      confidence: c.confidence,
    })),
  };
}

// ─── Motor principal ──────────────────────────────────────────────────────────

/**
 * Combina a classificação interna com os dados externos e produz
 * o resultado final uniforme para persistência.
 *
 * @param classification  Resultado da pré-classificação (catalog-classifier.ts)
 * @param sources         Dados recolhidos pelos conectores (catalog-connectors.ts)
 */
export function resolveProduct(
  classification: ClassificationResult,
  sources: ExternalSourceData[]
): ResolvedProduct {
  const { productType, confidence: typeConf, classificationSource, classificationVersion, hints } = classification;
  const relevance: ProductFieldRelevance = getFieldRelevance(productType);

  /**
   * Especificações dos campos a resolver.
   *
   * Campos autoritários (fabricante, dci, codigoATC) têm `allowedTiers`
   * restrito a REGULATORY/MANUFACTURER — nunca podem ser resolvidos via
   * INTERNAL_INFERRED, DISTRIBUTOR ou RETAIL. Esta regra é a primeira
   * linha de defesa contra contaminação do catálogo (ex: gravar um
   * grossista como fabricante).
   *
   * Os restantes campos (categoria, embalagem, imagem, forma, dosagem)
   * não têm restrição de tier — qualquer fonte pode contribuir.
   */
  const specs: Record<string, FieldSpec> = {
    fabricante:        { name: "fabricante",        getter: s => s.fabricante,        relevant: relevance.fabricante, allowedTiers: AUTHORITATIVE_TIERS },
    dci:               { name: "dci",               getter: s => s.principioAtivo,    relevant: relevance.dci,        allowedTiers: AUTHORITATIVE_TIERS },
    codigoATC:         { name: "codigoATC",         getter: s => s.atc,               relevant: relevance.atc,        allowedTiers: AUTHORITATIVE_TIERS },
    formaFarmaceutica: { name: "formaFarmaceutica", getter: s => s.formaFarmaceutica, relevant: relevance.formaFarmaceutica },
    dosagem:           { name: "dosagem",           getter: s => s.dosagem,           relevant: relevance.dosagem },
    embalagem:         { name: "embalagem",         getter: s => s.embalagem,         relevant: relevance.embalagem },
    imagemUrl:         { name: "imagemUrl",         getter: s => s.imagemUrl,         relevant: relevance.imagemUrl },
    categoria:         { name: "categoria",         getter: s => s.categoria,         relevant: relevance.categoria },
    subcategoria:      { name: "subcategoria",      getter: s => s.subcategoria,      relevant: relevance.categoria },
  };

  const fabricante        = resolveField(specs.fabricante, sources);
  const dci               = resolveField(specs.dci, sources);
  const codigoATC         = resolveField(specs.codigoATC, sources);
  const formaFarmaceutica = resolveField(specs.formaFarmaceutica, sources);
  const dosagem           = resolveField(specs.dosagem, sources);
  const embalagem         = resolveField(specs.embalagem, sources);
  const imagemUrl         = resolveField(specs.imagemUrl, sources);
  const categoria         = resolveField(specs.categoria, sources);
  const subcategoria      = resolveField(specs.subcategoria, sources);

  const resolvedFields = [fabricante, dci, codigoATC, formaFarmaceutica, dosagem, embalagem, imagemUrl, categoria, subcategoria]
    .filter((f): f is ResolvedField<string> => f !== null);

  const totalFieldsResolved = resolvedFields.length;
  const maxFieldConf = resolvedFields.length > 0
    ? Math.max(...resolvedFields.map(f => f.confidence))
    : 0;

  // Detecção de conflitos nos campos críticos
  const criticalSpecs = [specs.fabricante, specs.dci, specs.codigoATC, specs.formaFarmaceutica, specs.dosagem];
  const conflicts: FieldConflict[] = [];
  for (const spec of criticalSpecs) {
    const conflict = detectConflict(spec, sources);
    if (conflict) conflicts.push(conflict);
  }
  const hasAnyConflict = conflicts.length > 0;

  // Classificação externa (qualquer fonte não-interna)
  const externallyVerified = sources.some(s => s.tier !== "INTERNAL_INFERRED");

  // Source summary
  const sourceSummary: SourceSummary = {
    sourcesAttempted: hints.preferredSources,
    sourcesSucceeded: sources.map(s => s.source),
    primarySource: sources.length > 0
      ? [...sources].sort((a, b) => SOURCE_TIER_RANK[a.tier] - SOURCE_TIER_RANK[b.tier])[0].source
      : null,
    totalFieldsResolved,
  };

  // verificationStatus — política Abril 2026 corrigida (ver doc no topo).
  // GATE para NEEDS_REVIEW: typeConf (productTypeConfidence), NÃO maxFieldConf.
  // Razão: queremos auto-classificar produtos cujo tipo é claro mesmo sem
  // confirmação externa (ex: medicamento com flagMSRM mas CNP ausente do
  // snapshot INFARMED).
  let verificationStatus: VerificationStatus;
  if (hasAnyConflict) {
    verificationStatus = "NEEDS_REVIEW";
  } else if (typeConf < MIN_USEFUL_CONFIDENCE) {
    verificationStatus = "NEEDS_REVIEW";
  } else if (maxFieldConf >= VERIFIED_THRESHOLD) {
    // Tipo claro + confirmação externa forte.
    verificationStatus = "VERIFIED";
  } else {
    // Tipo claro mas sem confirmação externa forte — auto-classified.
    verificationStatus = "PARTIALLY_VERIFIED";
  }

  // needsManualReview ⇔ NEEDS_REVIEW. Sem excepções legacy.
  const needsManualReview = verificationStatus === "NEEDS_REVIEW";

  let manualReviewReason: string | null = null;
  if (needsManualReview) {
    if (hasAnyConflict) {
      const fields = conflicts.map((c) => c.field).join(", ");
      manualReviewReason = `Conflito entre fontes em: ${fields}`;
    } else {
      manualReviewReason = `Tipo de produto não determinado (confiança ${(typeConf * 100).toFixed(0)}%)`;
    }
  }

  return {
    productType,
    productTypeConfidence: typeConf,
    classificationSource,
    classificationVersion,
    fabricante,
    dci,
    codigoATC,
    formaFarmaceutica,
    dosagem,
    embalagem,
    imagemUrl,
    categoria,
    subcategoria,
    verificationStatus,
    externallyVerified,
    needsManualReview,
    manualReviewReason,
    sourceSummary,
    conflicts,
    lastVerifiedAt: new Date(),
  };
}
