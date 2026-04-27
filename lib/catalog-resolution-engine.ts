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
  ClassificationSource,
  ExternalSourceData,
  FieldConflict,
  ProductFieldRelevance,
  ProductType,
  ResolvedField,
  ResolvedProduct,
  SourceSummary,
  SourceTier,
  VerificationStatus,
} from "./catalog-types";
import { SOURCE_TIER_RANK } from "./catalog-types";
import { getFieldRelevance } from "./catalog-classifier";

/**
 * Mapa de palavras-chave em texto bruto de breadcrumb / categoria externa /
 * nome do produto → ProductType canónico. Usado para upgrade de productType
 * quando o classifier deu OUTRO mas a evidência externa diz claramente o tipo.
 *
 * Ordem importa: o primeiro match vence.
 *
 * Categorias reforçadas com keywords presentes em nomes de produto comuns
 * (creme, emoliente, gel hidratante, suplemento, etc.) — para que mesmo
 * uma página sem breadcrumb consiga classificar via rawProductName.
 */
const CATEGORY_TO_PRODUCT_TYPE: Array<{ pattern: RegExp; type: ProductType }> = [
  {
    pattern:
      /dermo|skincare|skin\s?care|cuidados?\s+(?:de\s+)?(?:rosto|corpo|pele)|hidratantes?\s+corpor|cremes?\s+corpor|emoliente|creme\s+(?:de\s+)?noite|s[eé]rum|tonico|tónico|micelar|despigment|cica|atopic|at[oó]pic|psor[ií]ase\s+creme|exomega|trixera|toleriane|cicalfate/i,
    type: "DERMOCOSMETICA",
  },
  { pattern: /protec[cç][aã]o\s+solar|sunscreen|spf|fps|p[oó]s-?solar|after[\s-]?sun|autobronz/i, type: "DERMOCOSMETICA" },
  { pattern: /maquilhag|makeup|cosm[eé]tic|perfume|fragranc|batom|rimmel/i, type: "DERMOCOSMETICA" },
  { pattern: /suplement|vitamin|multivit|nutri[cç][aã]o|food\s+supplement|colag[eé]nio|magn[eé]sio|c[aá]lcio|prob[ií]o|prebi[oó]/i, type: "SUPLEMENTO" },
  { pattern: /beb[eé]|baby|infant|puericultura|fralda|chupeta|bibera|tetina|chuch/i, type: "PUERICULTURA" },
  { pattern: /veterin|\bpet\b|c[aã]o|gato|felino|canino|frontline|bravecto/i, type: "VETERINARIA" },
  { pattern: /ortop[eé]d|joelheira|tornozeleira|cinta\s+lombar|palmilha|meias?\s+de\s+compress/i, type: "ORTOPEDIA" },
  { pattern: /dispositivo\s+m[eé]dic|medical\s+device|term[oó]metro|tens[iaã]o\s+arterial|nebuliza|glic[eé]m/i, type: "DISPOSITIVO_MEDICO" },
  { pattern: /higiene|champ[oô]|shampoo|sabonet|gel\s+de\s+banho|pasta\s+dent|escova\s+dent|desodor|antitranspir/i, type: "HIGIENE_CUIDADO" },
];

/**
 * Olha para `rawCategory` / `categoria` / `rawProductName` das fontes
 * externas e devolve um ProductType canónico se houver match claro.
 * Devolve null caso contrário.
 *
 * Inclui o nome do produto na evidência: páginas sem breadcrumb mas com
 * nome explícito ("A-Derma Exomega Creme Emoliente") são suficientes para
 * inferir DERMOCOSMETICA.
 */
function inferProductTypeFromExternal(
  sources: ExternalSourceData[]
): { type: ProductType; evidence: string } | null {
  for (const s of sources) {
    const blob = [
      s.rawCategory ?? "",
      s.categoria ?? "",
      s.rawProductName ?? "",
    ].join(" ");
    if (!blob.trim()) continue;
    for (const rule of CATEGORY_TO_PRODUCT_TYPE) {
      if (rule.pattern.test(blob)) {
        return { type: rule.type, evidence: blob.trim().slice(0, 120) };
      }
    }
  }
  return null;
}

/** Internals exportados para testes de regressão. */
export const __resolverInternals = {
  inferProductTypeFromExternal,
};

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
  let { productType, confidence: typeConf } = classification;
  const { classificationVersion, hints } = classification;
  let classificationSource: ClassificationSource = classification.classificationSource;

  // ─── Refinamento de productType a partir de evidência externa ───────────
  //
  // Se o classifier interno deu OUTRO (ou um tipo com confiança baixa) e o
  // retail / breadcrumb diz claramente outra coisa, faz upgrade. Justifica:
  // produtos sem flagMSRM/ATC/tipoArtigo caem em OUTRO por defeito mesmo
  // quando o nome ou o site indica claramente DERMOCOSMETICA, SUPLEMENTO,
  // etc. — a evidência externa é precisamente o que falta.
  //
  // A confiança pós-refinamento é capada em 0.65 — suficiente para passar
  // o gate de revisão (0.50) e para o mapper escolher uma categoria
  // canónica, mas abaixo do tier "VERIFIED" (0.75) que exige fonte forte.
  if (productType === "OUTRO" || typeConf < MIN_USEFUL_CONFIDENCE) {
    const inferred = inferProductTypeFromExternal(sources);
    if (inferred) {
      productType = inferred.type;
      typeConf = Math.max(typeConf, 0.65);
      classificationSource = "EXTERNAL";
    }
  }

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
  //
  // Gates para NEEDS_REVIEW (em ordem de prioridade):
  //   (1) conflito entre fontes em campos críticos
  //   (2) productType ainda OUTRO depois da tentativa de upgrade externo —
  //       não faz sentido VERIFIED para um produto sem categoria comercial
  //       atribuída
  //   (3) typeConf < 0.50 (classifier nem o resolver conseguiram tipo claro)
  //
  // VERIFIED exige tipo claro (≠ OUTRO) E confirmação externa forte
  // (maxFieldConf ≥ 0.75). PARTIALLY_VERIFIED quando o tipo está claro
  // mas a evidência externa não atinge o tier alto.
  let verificationStatus: VerificationStatus;
  if (hasAnyConflict) {
    verificationStatus = "NEEDS_REVIEW";
  } else if (productType === "OUTRO") {
    verificationStatus = "NEEDS_REVIEW";
  } else if (typeConf < MIN_USEFUL_CONFIDENCE) {
    verificationStatus = "NEEDS_REVIEW";
  } else if (maxFieldConf >= VERIFIED_THRESHOLD) {
    verificationStatus = "VERIFIED";
  } else {
    verificationStatus = "PARTIALLY_VERIFIED";
  }

  // needsManualReview ⇔ NEEDS_REVIEW. Sem excepções legacy.
  const needsManualReview = verificationStatus === "NEEDS_REVIEW";

  // Razão explícita para revisão manual. Cada caso é distinto porque o
  // admin precisa de saber *o quê* arranjar (procurar fabricante, validar
  // categoria, escolher entre conflito, etc.) — "Sem motivo" ou "Revisão
  // automática" não são úteis.
  let manualReviewReason: string | null = null;
  if (needsManualReview) {
    if (hasAnyConflict) {
      const fields = conflicts.map((c) => c.field).join(", ");
      manualReviewReason = `Conflito entre fontes em: ${fields}`;
    } else if (productType === "OUTRO" && sources.length === 0) {
      manualReviewReason =
        `Tipo OUTRO sem evidência externa — nenhum conector encontrou ` +
        `informação para este CNP/designação`;
    } else if (productType === "OUTRO") {
      const cats = sources
        .map((s) => s.rawCategory ?? s.categoria)
        .filter((c): c is string => !!c && c.trim().length > 0);
      const fontes = sources.map((s) => s.source).join(", ");
      manualReviewReason =
        `Tipo OUTRO mesmo após evidência externa — keywords das fontes ` +
        `não mapearam a uma categoria conhecida. Fontes: ${fontes}` +
        (cats.length > 0
          ? `. Categorias devolvidas: ${cats.slice(0, 3).join(" | ")}`
          : ". Sem categorias devolvidas.");
    } else if (sources.length === 0) {
      manualReviewReason =
        `Sem dados de fontes externas — nenhum conector encontrou ` +
        `informação para este CNP/designação (tipo=${productType}, ` +
        `conf=${(typeConf * 100).toFixed(0)}%)`;
    } else if (typeConf < MIN_USEFUL_CONFIDENCE) {
      const cats = sources
        .map((s) => s.rawCategory ?? s.categoria)
        .filter((c): c is string => !!c && c.trim().length > 0);
      const fontes = sources.map((s) => s.source).join(", ");
      manualReviewReason =
        `Tipo de produto não determinado (conf ${(typeConf * 100).toFixed(0)}%). ` +
        `Fontes consultadas: ${fontes}` +
        (cats.length > 0
          ? `. Categorias devolvidas: ${cats.slice(0, 3).join(" | ")}`
          : ". Sem categorias devolvidas.");
    } else {
      manualReviewReason =
        `Revisão necessária. tipo=${productType} ` +
        `conf=${(typeConf * 100).toFixed(0)}% ` +
        `maxFieldConf=${(maxFieldConf * 100).toFixed(0)}%`;
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
