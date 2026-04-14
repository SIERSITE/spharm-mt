/**
 * lib/catalog-classifier.ts
 *
 * Pré-classificação interna do tipo de produto a partir dos sinais disponíveis.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HIERARQUIA DE SINAIS (ordem de prioridade decrescente)
 *
 *  1. flagMSRM / flagMNSRM   → MEDICAMENTO com certeza (dados regulamentares)
 *  2. codigoATC presente     → MEDICAMENTO com alta confiança
 *  3. tipoArtigo mapeável    → tipo directo se mapeado
 *  4. Padrão de dosagem na designação (ex: "500MG", "10MG/ML")
 *     → MEDICAMENTO com alta confiança (salvo override por keywords)
 *  5. Forma farmacêutica inequívoca na designação (ex: "COMPRIMIDO", "XAROPE")
 *     → MEDICAMENTO com média confiança
 *  6. Marca / keyword forte por categoria → tipo específico
 *  7. Fallback → OUTRO com confiança baixa
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Versão das regras: bump CLASSIFICATION_VERSION ao alterar vocabulários ou lógica,
 * para que o job semanal reverifique produtos classificados com versão antiga.
 */

import type {
  ClassificationResult,
  ClassificationSource,
  ExternalVerificationHints,
  ProductFieldRelevance,
  ProductType,
} from "./catalog-types";

// ─── Versão das regras ────────────────────────────────────────────────────────

export const CLASSIFICATION_VERSION = "1.3";

// ─── Tipos de entrada ─────────────────────────────────────────────────────────

export type ProductClassificationInput = {
  designacao: string;
  tipoArtigo: string | null;
  flagMSRM: boolean;
  flagMNSRM: boolean;
  codigoATC: string | null;
  /**
   * Sinais internos agregados a partir de ProdutoFarmacia.*Origem.
   *
   * NOTA: NÃO incluir `fornecedorOrigem` aqui — é grossista/distribuidor,
   * não está correlacionado com tipo de produto de forma fiável e
   * historicamente gerou falsos positivos (ex: "Empifarma" classificado
   * como laboratório farmacêutico). Usar só categoria e subcategoria.
   */
  categoriaOrigem?: string | null;
  subcategoriaOrigem?: string | null;
};

// ─── Normalização ─────────────────────────────────────────────────────────────

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeKey(s: string): string {
  return stripAccents(s.toLowerCase());
}

// ─── Vocabulários ─────────────────────────────────────────────────────────────

/** Padrão de dosagem farmacêutica: número + unidade clínica */
const DOSAGE_PATTERN =
  /\b\d+[\.,]?\d*\s*(mg|mcg|µg|g\b|ml\b|ui\b|iu\b|meq|mmol|%\b)(\s*\/\s*(ml|g|mg|l))?\b/i;

/** Formas farmacêuticas que indicam MEDICAMENTO com alta confiança */
const MED_FORMS_HIGH = new Set([
  "comprimido", "comprimidos", "capsula", "capsulas",
  "xarope", "supositorio", "supositórios", "injetavel", "injetável",
  "ampola", "ampolas", "vial", "vials", "solucao injetavel",
  "po para solucao injetavel", "po para solucao oral",
  "suspensao injetavel", "granulado", "granulados",
  "inalador", "aerossol para inalacao", "po para inalacao",
  "adesivo transdermico", "sistema transdermico",
  "ovulos", "ovulo", "globulos", "globulo",
]);

/** Formas que podem ser medicamento OU cosmético — não decisivas sozinhas */
const MED_FORMS_AMBIGUOUS = new Set([
  "pomada", "pomadas", "creme", "cremes", "gel", "gels",
  "solucao", "solucoes", "lotion", "locao", "locoes",
  "gotas", "spray", "sprays", "espuma",
  "colirio", "colirios", "gotas nasais", "gotas auriculares",
]);

const TIPO_ARTIGO_MAP: Record<string, ProductType> = {
  med: "MEDICAMENTO", medicamento: "MEDICAMENTO", medicine: "MEDICAMENTO",
  "genérico": "MEDICAMENTO", "generico": "MEDICAMENTO",
  msrm: "MEDICAMENTO", mnsrm: "MEDICAMENTO",
  suplemento: "SUPLEMENTO", "suplemento alimentar": "SUPLEMENTO",
  "complemento alimentar": "SUPLEMENTO",
  cosmetico: "DERMOCOSMETICA", "cosmético": "DERMOCOSMETICA",
  dermocosmetica: "DERMOCOSMETICA", "dermocosméticos": "DERMOCOSMETICA",
  cosmetica: "DERMOCOSMETICA", "cosmética": "DERMOCOSMETICA",
  "dispositivo medico": "DISPOSITIVO_MEDICO", "dispositivo médico": "DISPOSITIVO_MEDICO",
  dm: "DISPOSITIVO_MEDICO",
  higiene: "HIGIENE_CUIDADO", "higiene pessoal": "HIGIENE_CUIDADO",
  ortopedia: "ORTOPEDIA",
  puericultura: "PUERICULTURA", bebe: "PUERICULTURA", "bebé": "PUERICULTURA",
  veterinaria: "VETERINARIA", "veterinária": "VETERINARIA", vet: "VETERINARIA",
};

const KEYWORDS_SUPLEMENTO = new Set([
  "vitamina", "vitaminas", "suplemento", "suplemento alimentar",
  "omega", "omega 3", "omega3", "omega-3", "omega 6", "omega 9",
  "probiotico", "probioticos", "prebiotico", "prebioticos",
  "colagenio", "colageno", "colagenio",
  "magnesio", "zinco", "ferro", "calcio",
  "acido folico", "folato", "biotina", "vitamina c", "vitamina d",
  "vitamina d3", "vitamina b12", "vitamina b6", "vitamina e", "vitamina k",
  "melatonina", "curcuma", "curcumina", "ginkgo",
  "glucosamina", "condroitina", "acido hialuronico",
  "spirulina", "clorela", "proteina", "whey", "aminoacido",
  "antioxidante", "coenzima q10", "ubiquinol",
  "fitoterapia", "extrato de", "tintura de",
  "ginseng", "valeriana", "pasiflora", "arnica", "equinacea",
  "camomila", "propolis", "geleia real",
  "l-carnitina", "l carnitina", "triptofano", "lisina",
  "astaxantina", "luteina", "licopeno", "resveratrol",
]);

const KEYWORDS_DERMOCOSMETICA = new Set([
  "bioderma", "la roche", "laroche", "la roche-posay", "uriage",
  "avene", "eucerin", "cetaphil", "vichy", "caudalie", "nuxe",
  "lierac", "roc", "neutrogena", "svr", "topicrem", "isdin",
  "bepanthol", "bepantol", "bepanthen", "mustela", "klorane",
  "ducray", "phyto", "filorga", "embryolisse", "biretix",
  "sebamed", "seba med", "noreva", "mederma",
  "atoderm", "lipikar", "kerium", "aquaphor",
  "sensibio", "cicaplast", "effaclar", "toleriane", "anthelios",
  "photoderm", "hydrabio",
  "hidratante", "hidratacao", "serum", "soro facial",
  "protetor solar", "fotoprotecao", "spf",
  "anti-idade", "anti idade", "antiaging",
  "tonico facial", "micellar", "micelar",
  "bb cream", "cc cream",
  "autobronzeador", "bronzeador", "after sun",
  "limpeza facial", "esfoliante", "mascara facial",
]);

const KEYWORDS_DISPOSITIVO_MEDICO = new Set([
  "seringa", "seringas", "lanceta", "lancetas",
  "agulha", "agulhas", "cateter",
  "penso", "pensos", "penso rapido", "compressa", "compressas",
  "ligadura", "ligaduras", "gaze", "gazes",
  "luva", "luvas",
  "tensiometro", "esfigmomanometro",
  "glucometro", "glicometro", "oximetro",
  "nebulizador", "aerocamara",
  "termometro", "estetoscopio",
  "tira de glicemia", "tiras de glicemia", "tiras reativas",
  "aparelho auditivo", "saco de ostomia", "ostomia",
  "colchao antiescaras", "almofada antiescaras",
  "libre", "freestyle libre",
]);

const KEYWORDS_HIGIENE_CUIDADO = new Set([
  "gel de duche", "gel duche", "gel banho",
  "champo", "shampoo",
  "sabonete", "sabao liquido", "gel lavante",
  "pasta dentrifica", "pasta de dentes", "pasta dentifica",
  "elixir bocal", "colutorio", "enxaguante bucal", "fio dental",
  "desodorizante", "desodorante", "antitranspirante",
  "aftershave", "gel de barbear", "espuma de barbear",
  "creme depilatorio", "depilacao",
  "absorvente", "tampao",
  "gel intimo", "higiene intima",
  "lenco humido", "toalhete",
]);

const KEYWORDS_ORTOPEDIA = new Set([
  "joelheira", "joelheiras", "tornozeleira", "tornozeleiras",
  "munhequeira", "colar cervical",
  "palmilha", "palmilhas",
  "muleta", "muletas",
  "cinta lombar", "cinta abdominal",
  "meias de compressao", "meias compressao",
  "tala", "talas", "ortotese",
  "bengala", "andarilho", "cadeira de rodas",
  "sapato ortopedico",
]);

const KEYWORDS_PUERICULTURA = new Set([
  "fralda", "fraldas", "chupeta", "chupetas",
  "biberon", "biberao",
  "leite infantil", "leite em po para bebe", "leite para bebe",
  "papa", "papinha",
  "creme de muda fraldas", "pomada muda fraldas", "pomada fralda",
  "colonia bebe", "creme bebe", "gel bebe", "shampoo bebe",
]);

const KEYWORDS_VETERINARIA = new Set([
  "veterinario", "veterinaria",
  "antipulgas", "anti-pulgas",
  "antiparasitario animal", "antiparasitario externo",
  "cao", "gato", "felino", "canino",
  "spot on", "spot-on",
  "collar antiparasitario",
]);

// ─── Fontes recomendadas por tipo ─────────────────────────────────────────────

const PREFERRED_SOURCES: Record<ProductType, string[]> = {
  MEDICAMENTO: ["infarmed"],
  SUPLEMENTO: ["internal_pharmacy_data", "open_food_facts"],
  DERMOCOSMETICA: ["internal_pharmacy_data", "open_beauty_facts"],
  DISPOSITIVO_MEDICO: ["internal_pharmacy_data", "eudamed"],
  HIGIENE_CUIDADO: ["internal_pharmacy_data"],
  ORTOPEDIA: ["internal_pharmacy_data"],
  PUERICULTURA: ["internal_pharmacy_data"],
  VETERINARIA: ["internal_pharmacy_data"],
  OUTRO: ["internal_pharmacy_data"],
};

// ─── Tokenização ──────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  const norm = normalizeKey(text);
  const words = norm.split(/[\s\-\/,;:.()[\]]+/).filter(Boolean);
  const tokens = new Set<string>(words);
  for (let i = 0; i < words.length - 1; i++) tokens.add(`${words[i]} ${words[i + 1]}`);
  for (let i = 0; i < words.length - 2; i++) tokens.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return tokens;
}

function countMatches(tokens: Set<string>, keywords: Set<string>): number {
  let n = 0;
  for (const kw of keywords) if (tokens.has(kw)) n++;
  return n;
}

// ─── Geração de pistas para verificação externa ───────────────────────────────

function generateHints(
  type: ProductType,
  designacao: string,
): ExternalVerificationHints {
  const stopWords = new Set(["para", "com", "sem", "por", "dos", "das", "num", "uma", "uns", "nas", "nos"]);
  const words = stripAccents(designacao.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));
  const searchKeywords = [...new Set(words)].slice(0, 5);

  let potentialDCI: string | null = null;
  if (type === "MEDICAMENTO") {
    const match = DOSAGE_PATTERN.exec(designacao);
    if (match && match.index > 0) {
      const before = designacao.slice(0, match.index).trim();
      const firstWord = before.split(/[\s,/]+/)[0];
      if (firstWord && firstWord.length >= 3) potentialDCI = firstWord;
    }
  }

  return {
    preferredSources: PREFERRED_SOURCES[type],
    searchKeywords,
    potentialDCI,
  };
}

// ─── Classificação ────────────────────────────────────────────────────────────

/**
 * Classifica o tipo de produto a partir dos sinais disponíveis.
 *
 * Pipeline em duas fases:
 *   1. classifyCore(): lógica hierárquica baseada em flags, ATC, tipoArtigo
 *      e padrões textuais da designação.
 *   2. applyOrigemSignals(): refina com sinais internos de ProdutoFarmacia
 *      (fabricanteOrigem, categoriaOrigem, subcategoriaOrigem) — pode trocar
 *      um OUTRO por um tipo específico, ou reforçar confiança por acordo.
 *
 * Devolve sempre um resultado — nunca lança excepção.
 */
export function classifyProductType(
  input: ProductClassificationInput
): ClassificationResult {
  const base = classifyCore(input);
  return applyOrigemSignals(base, input);
}

/**
 * Classificação hierárquica pura a partir de flags, ATC, tipoArtigo
 * e padrões textuais — sem sinais de origem interna.
 */
function classifyCore(
  input: ProductClassificationInput
): ClassificationResult {
  const signals: string[] = [];
  let type: ProductType;
  let confidence: number;
  let source: ClassificationSource;

  // 1. Flags estruturais — ground truth regulamentar
  if (input.flagMSRM) {
    type = "MEDICAMENTO"; confidence = 0.99; source = "FLAG_MSRM";
    signals.push("flagMSRM");
    return { productType: type, confidence, classificationSource: source, classificationVersion: CLASSIFICATION_VERSION, signals, hints: generateHints(type, input.designacao) };
  }
  if (input.flagMNSRM) {
    type = "MEDICAMENTO"; confidence = 0.99; source = "FLAG_MSRM";
    signals.push("flagMNSRM");
    return { productType: type, confidence, classificationSource: source, classificationVersion: CLASSIFICATION_VERSION, signals, hints: generateHints(type, input.designacao) };
  }

  // 2. Código ATC presente
  if (input.codigoATC) {
    type = "MEDICAMENTO"; confidence = 0.97; source = "ATC_CODE";
    signals.push(`codigoATC=${input.codigoATC}`);
    return { productType: type, confidence, classificationSource: source, classificationVersion: CLASSIFICATION_VERSION, signals, hints: generateHints(type, input.designacao) };
  }

  // 3. tipoArtigo mapeável
  if (input.tipoArtigo) {
    const mapped = TIPO_ARTIGO_MAP[normalizeKey(input.tipoArtigo)];
    if (mapped) {
      signals.push(`tipoArtigo=${input.tipoArtigo}`);
      return { productType: mapped, confidence: 0.92, classificationSource: "TIPO_ARTIGO", classificationVersion: CLASSIFICATION_VERSION, signals, hints: generateHints(mapped, input.designacao) };
    }
  }

  // 4–7. Análise da designação
  source = "TEXT_PATTERN";
  const tokens = tokenize(input.designacao);
  const normDesig = normalizeKey(input.designacao);

  const hasDosagePattern = DOSAGE_PATTERN.test(input.designacao);
  if (hasDosagePattern) signals.push("dosage_pattern");

  let hasMedFormHigh = false;
  let hasMedFormAmbiguous = false;
  for (const form of MED_FORMS_HIGH) {
    if (tokens.has(form) || normDesig.includes(form)) {
      hasMedFormHigh = true;
      signals.push(`med_form_high:${form}`);
      break;
    }
  }
  if (!hasMedFormHigh) {
    for (const form of MED_FORMS_AMBIGUOUS) {
      if (tokens.has(form) || normDesig.includes(form)) {
        hasMedFormAmbiguous = true;
        signals.push(`med_form_ambiguous:${form}`);
        break;
      }
    }
  }

  const scoreVet  = countMatches(tokens, KEYWORDS_VETERINARIA);
  const scorePuer = countMatches(tokens, KEYWORDS_PUERICULTURA);
  const scoreOrt  = countMatches(tokens, KEYWORDS_ORTOPEDIA);
  const scoreDM   = countMatches(tokens, KEYWORDS_DISPOSITIVO_MEDICO);
  const scoreSupl = countMatches(tokens, KEYWORDS_SUPLEMENTO);
  const scoreDerm = countMatches(tokens, KEYWORDS_DERMOCOSMETICA);
  const scoreHig  = countMatches(tokens, KEYWORDS_HIGIENE_CUIDADO);

  if (scoreVet > 0)  signals.push(`veterinaria_kw:${scoreVet}`);
  if (scorePuer > 0) signals.push(`puericultura_kw:${scorePuer}`);
  if (scoreOrt > 0)  signals.push(`ortopedia_kw:${scoreOrt}`);
  if (scoreDM > 0)   signals.push(`dispositivo_kw:${scoreDM}`);
  if (scoreSupl > 0) signals.push(`suplemento_kw:${scoreSupl}`);
  if (scoreDerm > 0) signals.push(`dermocosm_kw:${scoreDerm}`);
  if (scoreHig > 0)  signals.push(`higiene_kw:${scoreHig}`);

  if (scoreVet >= 1)  return build("VETERINARIA", 0.80, source, signals, input.designacao);
  if (scorePuer >= 1) return build("PUERICULTURA", 0.80, source, signals, input.designacao);
  if (scoreOrt >= 1)  return build("ORTOPEDIA", 0.80, source, signals, input.designacao);
  if (scoreDM >= 1)   return build("DISPOSITIVO_MEDICO", 0.80, source, signals, input.designacao);

  if (scoreSupl >= 1) {
    if (hasMedFormHigh && scoreSupl < 2) return build("MEDICAMENTO", 0.75, source, signals, input.designacao);
    return build("SUPLEMENTO", scoreSupl >= 2 ? 0.82 : 0.72, source, signals, input.designacao);
  }

  if (scoreDerm >= 1) {
    if (hasDosagePattern && hasMedFormHigh) return build("MEDICAMENTO", 0.82, source, signals, input.designacao);
    return build("DERMOCOSMETICA", scoreDerm >= 2 ? 0.85 : 0.75, source, signals, input.designacao);
  }

  if (scoreHig >= 1) return build("HIGIENE_CUIDADO", 0.78, source, signals, input.designacao);

  if (hasMedFormHigh) return build("MEDICAMENTO", hasDosagePattern ? 0.90 : 0.78, source, signals, input.designacao);
  if (hasDosagePattern && hasMedFormAmbiguous) return build("MEDICAMENTO", 0.75, source, signals, input.designacao);
  if (hasDosagePattern) return build("MEDICAMENTO", 0.68, source, signals, input.designacao);

  return build("OUTRO", 0.30, source, signals, input.designacao);
}

// ─── Sinais de origem interna (ProdutoFarmacia.*Origem) ──────────────────────

/**
 * Mapeamentos conservadores de categoria/subcategoria (normalizadas e sem
 * acentos) para ProductType. Só entradas inequívocas — produtos genéricos
 * (ex: "SISTEMA NERVOSO") não desambiguam entre MEDICAMENTO e SUPLEMENTO
 * e são tratadas via MED_CATEGORY_PATTERNS abaixo.
 */
const CATEGORIA_TYPE_MAP: Array<{ pattern: RegExp; type: ProductType }> = [
  { pattern: /\b(dermocosmet|cosmet)/,                   type: "DERMOCOSMETICA" },
  { pattern: /\b(puericult|bebe|leite infantil|chupet)/, type: "PUERICULTURA" },
  { pattern: /\bortoped/,                                type: "ORTOPEDIA" },
  { pattern: /\b(veterin|animal domestico|petfood)/,     type: "VETERINARIA" },
  { pattern: /\b(dispositivo medico|optic|meter|tira(s)? teste)/, type: "DISPOSITIVO_MEDICO" },
  { pattern: /\b(higiene|cuidado pessoal|cavidade oral|bucal)/,    type: "HIGIENE_CUIDADO" },
  { pattern: /\b(suplemento|complemento alimentar|vitamina|mineral|probiot)/, type: "SUPLEMENTO" },
];

/**
 * Padrões de áreas terapêuticas que sugerem MEDICAMENTO mas não são
 * decisivos (SUPLEMENTO pode cair em "SISTEMA NERVOSO" também). Usados
 * apenas como reforço fraco quando não há sinal mais específico.
 */
const MED_CATEGORY_PATTERNS: RegExp[] = [
  /\bsistema (nervoso|cardiovascular|respirat|digestiv|imunit|endocrin|urinari|reprodut|hormonal|locomotor|osteoarticul)/,
  /\baparelho (digestiv|urin|respirat|cardio|genit)/,
  /\b(oftalm|otorrino|dermatolog|ginecolog|urolog)/,
  /\b(antibiot|analgesic|anti.?inflam|antihistamin|antihipert|antidiab|antidepre)/,
];

/**
 * Refina a classificação base com sinais internos da taxonomia da farmácia.
 *
 * Apenas categoria/subcategoria são usadas — NÃO fornecedor. O fornecedor
 * habitual (Empifarma, OCP, …) não está correlacionado com tipo de produto
 * e historicamente gerou falsos positivos.
 *
 * Regras (conservadoras):
 *  R1. Base=OUTRO + categoria dá tipo não-med explícito → troca para esse tipo.
 *  R2. Base=OUTRO + categoria terapêutica → MEDICAMENTO fraco (0.65).
 *  R3. Base matches origemType → bónus de +0.05 (cap 0.95).
 *  R4. Base=MEDICAMENTO + categoria terapêutica → bónus +0.05.
 *  R5. Conflito entre base e origem específica → mantém base (texto é mais fidedigno).
 *
 * Nunca desce confiança; só sobe ou mantém.
 */
function applyOrigemSignals(
  base: ClassificationResult,
  input: ProductClassificationInput
): ClassificationResult {
  const cat = input.categoriaOrigem ? normalizeKey(input.categoriaOrigem) : "";
  const sub = input.subcategoriaOrigem ? normalizeKey(input.subcategoriaOrigem) : "";

  if (!cat && !sub) return base;

  const catText = `${cat} ${sub}`.trim();
  const signals = [...base.signals];

  // Detectar tipo sugerido pela categoria
  let origemType: ProductType | null = null;
  for (const { pattern, type } of CATEGORIA_TYPE_MAP) {
    if (catText && pattern.test(catText)) {
      origemType = type;
      signals.push(`origem_cat:${type}`);
      break;
    }
  }

  const catIsTherapeutic = catText && MED_CATEGORY_PATTERNS.some(p => p.test(catText));
  if (catIsTherapeutic) signals.push("origem_therapeutic_cat");

  // R1: base=OUTRO + categoria dá tipo não-med explícito → adopta
  if (base.productType === "OUTRO" && origemType && origemType !== "MEDICAMENTO") {
    return {
      ...base,
      productType: origemType,
      confidence: Math.max(base.confidence, 0.72),
      classificationSource: "TEXT_PATTERN",
      signals,
      // Regenerar hints com as fontes preferidas do novo tipo
      hints: { ...base.hints, preferredSources: PREFERRED_SOURCES[origemType] },
    };
  }

  // R2: base=OUTRO + categoria terapêutica → MEDICAMENTO fraco
  if (base.productType === "OUTRO" && catIsTherapeutic) {
    return {
      ...base,
      productType: "MEDICAMENTO",
      confidence: 0.65,
      classificationSource: "TEXT_PATTERN",
      signals,
      hints: { ...base.hints, preferredSources: PREFERRED_SOURCES.MEDICAMENTO },
    };
  }

  // R3: base específica + origem concorda → bónus
  if (origemType && base.productType === origemType) {
    return {
      ...base,
      confidence: Math.min(base.confidence + 0.05, 0.95),
      signals,
    };
  }

  // R4: base=MEDICAMENTO + reforço terapêutico → bónus
  if (base.productType === "MEDICAMENTO" && catIsTherapeutic) {
    return {
      ...base,
      confidence: Math.min(base.confidence + 0.05, 0.95),
      signals,
    };
  }

  // R5: conflito silencioso — mantém base (texto é mais fidedigno)
  return { ...base, signals };
}

function build(
  type: ProductType,
  confidence: number,
  source: ClassificationSource,
  signals: string[],
  designacao: string,
): ClassificationResult {
  return {
    productType: type,
    confidence,
    classificationSource: source,
    classificationVersion: CLASSIFICATION_VERSION,
    signals,
    hints: generateHints(type, designacao),
  };
}

// ─── Relevância de campos por tipo ────────────────────────────────────────────

const RELEVANCE_ALL: ProductFieldRelevance = {
  fabricante: true, dci: true, atc: true, dosagem: true,
  embalagem: true, formaFarmaceutica: true, categoria: true, imagemUrl: true,
};

const RELEVANCE_NON_PHARMA: ProductFieldRelevance = {
  fabricante: true, dci: false, atc: false, dosagem: false,
  embalagem: true, formaFarmaceutica: true, categoria: true, imagemUrl: true,
};

export function getFieldRelevance(type: ProductType): ProductFieldRelevance {
  switch (type) {
    case "MEDICAMENTO":       return RELEVANCE_ALL;
    case "SUPLEMENTO":        return { ...RELEVANCE_NON_PHARMA, dosagem: true };
    case "DERMOCOSMETICA":    return RELEVANCE_NON_PHARMA;
    case "DISPOSITIVO_MEDICO":return { ...RELEVANCE_NON_PHARMA, formaFarmaceutica: false };
    case "HIGIENE_CUIDADO":   return RELEVANCE_NON_PHARMA;
    case "ORTOPEDIA":         return { ...RELEVANCE_NON_PHARMA, formaFarmaceutica: false };
    case "PUERICULTURA":      return { ...RELEVANCE_NON_PHARMA, formaFarmaceutica: false };
    case "VETERINARIA":       return RELEVANCE_NON_PHARMA;
    case "OUTRO":             return { ...RELEVANCE_NON_PHARMA, formaFarmaceutica: false };
  }
}

// Re-exportar tipos de catalog-types.ts para compatibilidade com importadores existentes
export type { ProductType, ProductFieldRelevance, ClassificationResult } from "./catalog-types";
