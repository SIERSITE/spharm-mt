/**
 * lib/catalog-types.ts
 *
 * Contratos TypeScript partilhados entre todas as camadas do pipeline
 * de classificação, verificação e enriquecimento do catálogo SPharm.MT.
 *
 * Hierarquia de importações (sem ciclos):
 *   catalog-types.ts             ← sem dependências internas
 *   catalog-normalizers.ts       ← sem dependências internas
 *   catalog-classifier.ts        ← importa catalog-types.ts
 *   catalog-connectors.ts        ← importa catalog-types.ts
 *   catalog-resolution-engine.ts ← importa catalog-types.ts, catalog-classifier.ts
 *   catalog-persistence.ts       ← importa catalog-types.ts, catalog-normalizers.ts,
 *                                   catalog-classification.ts, prisma
 *   catalog-enrichment.ts        ← importa todas as camadas acima
 */

// ─── Tipos base ────────────────────────────────────────────────────────────────

export type ProductType =
  | "MEDICAMENTO"        // medicamentos MSRM/MNSRM/genéricos
  | "SUPLEMENTO"         // suplementos alimentares, vitaminas, minerais
  | "DERMOCOSMETICA"     // cosmética, cuidado da pele, proteção solar
  | "DISPOSITIVO_MEDICO" // seringas, pensos, medidores, etc.
  | "HIGIENE_CUIDADO"    // higiene pessoal, cavidade oral, cabelo
  | "ORTOPEDIA"          // joelheiras, palmilhas, meias de compressão
  | "PUERICULTURA"       // produtos para bebé
  | "VETERINARIA"        // produtos veterinários
  | "OUTRO";             // não classificado / ambíguo

export type VerificationStatus =
  | "PENDING"             // ainda não verificado
  | "IN_PROGRESS"         // a ser verificado agora
  | "VERIFIED"            // verificado com confiança alta
  | "PARTIALLY_VERIFIED"  // verificado com confiança média
  | "FAILED"              // verificação sem dados
  | "NEEDS_REVIEW";       // conflito ou revisão manual necessária

/**
 * Origem do sinal que determinou o tipo de produto.
 * Ordenado do mais para o menos fidedigno.
 */
export type ClassificationSource =
  | "FLAG_MSRM"    // flagMSRM ou flagMNSRM (dado regulamentar)
  | "ATC_CODE"     // codigoATC presente
  | "TIPO_ARTIGO"  // tipoArtigo mapeado na tabela de equivalências
  | "TEXT_PATTERN" // padrão na designação (dosagem, forma, keywords)
  | "EXTERNAL"     // confirmado por fonte externa
  | "MANUAL";      // definido manualmente por utilizador

/**
 * Autoridade (tier) de uma fonte de dados.
 *
 * Ordenado do mais autoritário (REGULATORY) para o menos autoritário
 * (INTERNAL_INFERRED). O resolver usa tier para desempate quando
 * múltiplas fontes têm a mesma confiança numérica, e para bloquear
 * sobrescritas de dados de tier superior com dados de tier inferior.
 *
 * Regra geral: um valor de INTERNAL_INFERRED nunca deve substituir
 * um valor já estabelecido por uma fonte REGULATORY.
 */
export type SourceTier =
  | "REGULATORY"         // INFARMED, EUDAMED — registos oficiais
  | "MANUFACTURER"       // catálogo do fabricante (directo)
  | "DISTRIBUTOR"        // bases de dados de distribuidores / cooperativas
  | "RETAIL"             // bases abertas / retail (Open Beauty Facts, etc.)
  | "INTERNAL_INFERRED"; // agregação de ProdutoFarmacia.*Origem

/** Ordem numérica do tier (menor = maior autoridade) */
export const SOURCE_TIER_RANK: Record<SourceTier, number> = {
  REGULATORY: 0,
  MANUFACTURER: 1,
  DISTRIBUTOR: 2,
  RETAIL: 3,
  INTERNAL_INFERRED: 4,
};

// ─── Relevância de campos por tipo ───────────────────────────────────────────

export type ProductFieldRelevance = {
  fabricante: boolean;
  /** DCI / INN — só para medicamentos */
  dci: boolean;
  /** Código ATC — só para medicamentos */
  atc: boolean;
  /** Dosagem clínica (500 mg, 10 mg/ml…) — medicamentos e alguns suplementos */
  dosagem: boolean;
  /** Embalagem / quantidade */
  embalagem: boolean;
  /** Forma farmacêutica ou apresentação (comprimido, creme, cápsulas…) */
  formaFarmaceutica: boolean;
  /** Categoria de produto */
  categoria: boolean;
  /** Imagem do produto */
  imagemUrl: boolean;
};

// ─── Classificação interna ────────────────────────────────────────────────────

/** Pistas para guiar os conectores externos na pesquisa do produto */
export type ExternalVerificationHints = {
  /** Fontes recomendadas, por ordem de prioridade */
  preferredSources: string[];
  /** Keywords normalizadas da designação para pesquisa externa */
  searchKeywords: string[];
  /** DCI potencial extraído da designação (só para MEDICAMENTO) */
  potentialDCI: string | null;
};

/** Resultado da pré-classificação interna */
export type ClassificationResult = {
  productType: ProductType;
  confidence: number;
  classificationSource: ClassificationSource;
  classificationVersion: string;
  signals: string[];
  hints: ExternalVerificationHints;
};

// ─── Conectores externos ──────────────────────────────────────────────────────

/** Pedido enviado a cada conector externo */
export type ExternalLookupRequest = {
  /** ID interno do produto (para lookups na BD interna) */
  productId: string;
  /** CNP — chave primária para fontes externas */
  cnp: number | null;
  designacao: string;
  productType: ProductType;
  hints: ExternalVerificationHints;
};

/**
 * Dados devolvidos por um conector externo.
 * Formato intermédio normalizado — nunca atualiza a BD directamente.
 */
export type ExternalSourceData = {
  /** Identificador da fonte (ex: "infarmed", "internal_pharmacy_data") */
  source: string;
  /** Nível de autoridade desta fonte — usado para desempate e bloqueio de sobrescritas */
  tier: SourceTier;
  /** Como foi feita a correspondência */
  matchedBy: "cnp" | "designacao" | "ean" | "unknown";
  /** Confiança global desta fonte para este produto (0..1) */
  confidence: number;
  fabricante: string | null;
  principioAtivo: string | null;
  atc: string | null;
  dosagem: string | null;
  embalagem: string | null;
  formaFarmaceutica: string | null;
  categoria: string | null;
  subcategoria: string | null;
  imagemUrl: string | null;
  /** Notas de diagnóstico opcionais */
  notes: string | null;
};

// ─── Motor de resolução ───────────────────────────────────────────────────────

/** Campo resolvido com metadados de origem e confiança */
export type ResolvedField<T> = {
  value: T;
  confidence: number;
  source: string;
  tier: SourceTier;
  /** Número de fontes que concordaram com este valor */
  agreementCount: number;
};

/** Registo de conflito detectado entre fontes num campo */
export type FieldConflict = {
  field: string;
  values: Array<{ value: string; source: string; tier: SourceTier; confidence: number }>;
};

export type SourceSummary = {
  sourcesAttempted: string[];
  sourcesSucceeded: string[];
  primarySource: string | null;
  totalFieldsResolved: number;
};

/** Resultado final uniforme produzido pelo motor de resolução */
export type ResolvedProduct = {
  productType: ProductType;
  productTypeConfidence: number;
  classificationSource: ClassificationSource;
  classificationVersion: string;
  // Campos resolvidos (null = não resolvido ou irrelevante para este tipo)
  fabricante: ResolvedField<string> | null;
  dci: ResolvedField<string> | null;
  codigoATC: ResolvedField<string> | null;
  formaFarmaceutica: ResolvedField<string> | null;
  dosagem: ResolvedField<string> | null;
  embalagem: ResolvedField<string> | null;
  imagemUrl: ResolvedField<string> | null;
  categoria: ResolvedField<string> | null;
  subcategoria: ResolvedField<string> | null;
  // Metadados de verificação
  verificationStatus: VerificationStatus;
  externallyVerified: boolean;
  needsManualReview: boolean;
  manualReviewReason: string | null;
  sourceSummary: SourceSummary;
  /** Conflitos detectados entre fontes (campo → valores divergentes) */
  conflicts: FieldConflict[];
  lastVerifiedAt: Date;
};

// ─── Persistência ─────────────────────────────────────────────────────────────

export type PersistenceInput = {
  productId: string;
  resolved: ResolvedProduct;
  dryRun?: boolean;
};

export type PersistenceResult = {
  fieldsUpdated: string[];
  produtoEstado: string;
};

// ─── Orquestração ─────────────────────────────────────────────────────────────

export type EnrichmentResult = {
  productId: string;
  cnp: number | null;
  status: "success" | "partial" | "failed" | "skipped";
  productType: ProductType;
  productTypeConfidence: number;
  verificationStatus: VerificationStatus;
  fieldsUpdated: string[];
  queued: boolean;
  dryRun: boolean;
};

export type EnrichmentSummary = {
  total: number;
  success: number;
  partial: number;
  failed: number;
  queued: number;
};
