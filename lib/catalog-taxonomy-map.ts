/**
 * lib/catalog-taxonomy-map.ts
 *
 * Mapeamento determinístico de sinais (productType, designação, ATC,
 * categoria externa) para a taxonomia canónica interna
 * (lib/catalog-taxonomy.ts).
 *
 * Princípios:
 *   1. Nunca devolve categorias fora da taxonomia canónica.
 *   2. Determinístico: os mesmos inputs → o mesmo output.
 *   3. "Outros <X>" só se o nivel1 for forte e nenhum match específico
 *      for possível. Mesmo assim, preferir "Em Revisão".
 *   4. Se não há sinal suficiente para determinar nivel1, cai em
 *      CATEGORIAS TÉCNICAS / (Em Revisão | Por Classificar).
 *
 * Usado por lib/catalog-persistence.ts antes de
 * resolveClassificationIdsFromCategory(), de forma a nunca gravar
 * categorias livres vindas das fontes.
 */

import type { ProductType } from "./catalog-types";
import {
  getNivel2For,
  isValidNivel2,
  TRANSITORIA_NIVEL1,
  TRANSITORIA_POR_CLASSIFICAR,
  TRANSITORIA_EM_REVISAO,
} from "./catalog-taxonomy";

export type TaxonomyMapInput = {
  productType: ProductType;
  productTypeConfidence: number;
  externalCategory: string | null;
  externalSubcategory: string | null;
  designacao: string;
  atc: string | null;
};

export type TaxonomyMapOutput = {
  nivel1: string;
  nivel2: string;
  confidence: number;
  method:
    | "keyword"
    | "atc"
    | "external_category_hint"
    | "product_type_only"
    | "em_revisao"
    | "por_classificar";
  /** true = fallback transitório (Em Revisão / Por Classificar / Outros) */
  isFallback: boolean;
};

// ─── ProductType → Nivel1 canónico ────────────────────────────────────────────

const PRODUCT_TYPE_TO_NIVEL1: Record<ProductType, string | null> = {
  MEDICAMENTO: "MEDICAMENTOS",
  SUPLEMENTO: "SUPLEMENTOS ALIMENTARES",
  DERMOCOSMETICA: "DERMOCOSMÉTICA",
  HIGIENE_CUIDADO: "HIGIENE CORPORAL", // default refinado abaixo por keyword
  DISPOSITIVO_MEDICO: "DISPOSITIVOS MÉDICOS",
  ORTOPEDIA: "ORTOPEDIA",
  PUERICULTURA: "PUERICULTURA E BEBÉ",
  VETERINARIA: "VETERINÁRIA",
  OUTRO: null,
};

// ─── ATC (1ª letra) → Nivel2 canónico dentro de MEDICAMENTOS ──────────────────

const ATC_LETTER_TO_NIVEL2: Record<string, string> = {
  A: "Sistema Digestivo",            // Alimentary tract and metabolism
  B: "Outros Medicamentos",           // Blood and blood forming organs
  C: "Cardiovascular",               // Cardiovascular system
  D: "Dermatológicos",               // Dermatologicals
  G: "Ginecológicos",                // Genito-urinary system
  H: "Outros Medicamentos",           // Systemic hormonal preparations
  J: "Outros Medicamentos",           // Anti-infectives systemic
  L: "Outros Medicamentos",           // Antineoplastic
  M: "Analgésicos e Anti-inflamatórios", // Musculo-skeletal system
  N: "Sistema Nervoso",              // Nervous system
  P: "Outros Medicamentos",           // Antiparasitic
  R: "Respiratório",                 // Respiratory system
  S: "Oftálmicos",                   // Sensory organs
  V: "Outros Medicamentos",           // Various
};

// ─── Keyword rules por nivel1 → ordem importa (first match wins) ──────────────

type KeywordRule = { pattern: RegExp; nivel2: string };

const KEYWORD_RULES: Record<string, KeywordRule[]> = {
  MEDICAMENTOS: [
    { pattern: /\b(ibuprofeno|paracetamol|aspirina|diclofenac|naproxeno|nimesulida|ketoprofeno|\bdor\b|analges|anti-?inflamat)/i, nivel2: "Analgésicos e Anti-inflamatórios" },
    { pattern: /\b(constipa|tosse|gripe|expectorante|xarope|mucolit|descongestion)/i, nivel2: "Constipação, Tosse e Gripe" },
    { pattern: /\b(alergia|anti-?histam|loratadina|cetiriz|desloratadina|bilastina|fexofenadina)/i, nivel2: "Alergias" },
    { pattern: /\b(digest|est[oô]mago|azia|laxante|obstipa|diarre|naus|omeprazol|pantoprazol|esomeprazol|ranitid|domperid|metoclop|loperam)/i, nivel2: "Sistema Digestivo" },
    { pattern: /\b(ansied|sedat|antidepress|diazepam|alprazolam|lorazepam|sertralina|fluoxetina|escitalopram|zolpidem|amitriptil)/i, nivel2: "Sistema Nervoso" },
    { pattern: /\b(hipertens|colesterol|cardiaco|enalapril|losartan|amlodipina|atorvastatina|sinvastatina|valsartan|bisoprolol|carvedilol|ramipril|perindopril|nebivolol|furosemid)/i, nivel2: "Cardiovascular" },
    { pattern: /\b(diabet|metformina|insulina|glicemia|gliclazida|sitagliptina|empagliflozina|dapagliflozina)/i, nivel2: "Diabetes" },
    { pattern: /\b(dermatolog|psor[ií]ase|eczema|micose|antif[uú]ngico|hidrocortisona|betametasona|mupirocina)/i, nivel2: "Dermatológicos" },
    { pattern: /\b(oft[aá]lm|colir|gotas? oculares?|olho seco)/i, nivel2: "Oftálmicos" },
    { pattern: /\b(ouvid|[oó]tic|otologic|otite)/i, nivel2: "Otológicos" },
    { pattern: /\b(ginec|vagin|menstru|climat[eé]|anticoncep|p[ií]lula)/i, nivel2: "Ginecológicos" },
    { pattern: /\b(urol[oó]g|prost|cistite|infec[cç][aã]o urin[aá]ria|tansul|finasterid)/i, nivel2: "Urológicos" },
    { pattern: /\b(respir|asma|bronco|salbutamol|budesonida|fluticasona|formoterol|inalador)/i, nivel2: "Respiratório" },
    { pattern: /\b(antiss?[eé]tico|desinfet|clorhex|betadine|iodopovid|[áa]lcool et[ií]lico)/i, nivel2: "Antisséticos e Desinfetantes" },
  ],
  "SUPLEMENTOS ALIMENTARES": [
    { pattern: /\b(vitamin|multivit|vit ?[abcde]|\bb\d{1,2}\b|complexo b|magn[eé]sio|c[aá]lcio|zinco|ferro|mineral|pot[aá]ssio|i[oó]do|sel[eé]nio)/i, nivel2: "Vitaminas e Minerais" },
    { pattern: /\b(imun|defesa|resist[eê]ncia|equin[aá]cea|pr[oó]polis)/i, nivel2: "Imunidade" },
    { pattern: /\b(energ|vitali|fadiga|cansa[cç]o|ginseng|cafe[ií]na|guaran[aá]|maca)/i, nivel2: "Energia e Vitalidade" },
    { pattern: /\b(mem[oó]ria|concentra|cogni|ginkgo|bacopa)/i, nivel2: "Memória e Concentração" },
    { pattern: /\b(sono|dormir|relax|melaton|valer[ií]ana|passiflora|tilia)/i, nivel2: "Sono e Relaxamento" },
    { pattern: /\b(probi[oó]t|pr[eé]bi[oó]t|transito|intest|lactobac|bifid)/i, nivel2: "Digestão e Probióticos" },
    { pattern: /\b(articul|osso|col[aá]geno|glucosam|condroit|msm|cartilag)/i, nivel2: "Articulações e Ossos" },
    { pattern: /\b(cabelo|pele|unhas|biotina|queda|queratina)/i, nivel2: "Cabelo, Pele e Unhas" },
    { pattern: /\b(peso|emagrec|queimador|saciant|drenant)/i, nivel2: "Controlo de Peso" },
    { pattern: /\b([ií]ntima|vaginal|cranberry|ar[aâ]ndano)/i, nivel2: "Saúde Íntima" },
  ],
  "DERMOCOSMÉTICA": [
    { pattern: /\b(anti-?enve|anti-?idade|anti-?rugas?|lifting|firmeza)/i, nivel2: "Anti-envelhecimento" },
    { pattern: /\b(at[oó]pic|sens[ií]vel|sensibilidade|eczema)/i, nivel2: "Pele Sensível / Atópica" },
    { pattern: /\b(acne|oleosa|ole[oó]sa|espinhas?|imperfei[cç][oõ]es|comed[oó]n)/i, nivel2: "Acne e Pele Oleosa" },
    { pattern: /\b(despigment|manchas?|clareador|whitening)/i, nivel2: "Despigmentantes" },
    { pattern: /\b(limpeza|demaquil|desmaquil|gel de limpeza|tonic|micelar)/i, nivel2: "Limpeza" },
    { pattern: /\b(hidrat|moistur|creme hidrat|nutritiv)/i, nivel2: "Hidratação" },
    { pattern: /\b(rosto|facial|serum|s[eé]rum|contorno dos olhos)/i, nivel2: "Rosto" },
    { pattern: /\b(corpo|body)/i, nivel2: "Corpo" },
    { pattern: /\b(m[aã]os|p[eé]s|feet|hand)/i, nivel2: "Mãos e Pés" },
  ],
  "HIGIENE CORPORAL": [
    { pattern: /\b(gel de banho|gel de duche|duche|banho|shower gel|body wash)/i, nivel2: "Banho e Duche" },
    { pattern: /\b(desodor|antitranspir|deodor)/i, nivel2: "Desodorizantes" },
    { pattern: /\b([ií]ntim|higiene [ií]ntima)/i, nivel2: "Higiene Íntima" },
    { pattern: /\b(sabonete|sab[aã]o)/i, nivel2: "Sabonetes" },
  ],
  "HIGIENE ORAL": [
    { pattern: /\b(pasta.*dent|dentifr|colgate|sensodyne|elmex|parodontax)/i, nivel2: "Pastas Dentífricas" },
    { pattern: /\b(escova.*dent|toothbrush)/i, nivel2: "Escovas de Dentes" },
    { pattern: /\b(elixir|bochecho|mouthwash|listerine|eludril)/i, nivel2: "Elixires" },
    { pattern: /\b(fio dent|dental floss)/i, nivel2: "Fio Dentário" },
    { pattern: /\b(pr[oó]tese|dentadura|corega)/i, nivel2: "Próteses Dentárias" },
  ],
  CAPILAR: [
    { pattern: /\b(anti-?caspa|anticaspa|head.*shoulders)/i, nivel2: "Anti-caspa" },
    { pattern: /\b(queda|minoxidil|anti-?queda)/i, nivel2: "Queda de Cabelo" },
    { pattern: /\b(color|tinta|tint.*capilar)/i, nivel2: "Coloração" },
    { pattern: /\b(champ[oô]|shampoo)/i, nivel2: "Champôs" },
    { pattern: /\b(condicion|amaciador|conditioner)/i, nivel2: "Condicionadores" },
    { pattern: /\b(m[aá]scara.*cabelo|tratamento.*capilar|hair mask)/i, nivel2: "Máscaras e Tratamentos" },
  ],
  "PUERICULTURA E BEBÉ": [
    { pattern: /\b(fralda|diaper|toalhit)/i, nivel2: "Fraldas e Toalhitas" },
    { pattern: /\b(leite.*beb|leite.*infant|f[oó]rmula infant|papa)/i, nivel2: "Alimentação do Bebé" },
    { pattern: /\b(chupeta|bibera|biber[aã]o|tetina)/i, nivel2: "Chupetas e Biberões" },
    { pattern: /\b(at[oó]pic.*beb|beb.*at[oó]pic)/i, nivel2: "Pele Atópica do Bebé" },
    { pattern: /\b(higiene.*beb|beb.*higiene)/i, nivel2: "Higiene do Bebé" },
  ],
  "MÃE E GRAVIDEZ": [
    { pattern: /\b(gravid|gestant|pr[eé]-?natal)/i, nivel2: "Gravidez" },
    { pattern: /\b(p[oó]s-?parto|postparto)/i, nivel2: "Pós-parto" },
    { pattern: /\b(amament|extrator.*leite|lactation)/i, nivel2: "Amamentação" },
  ],
  "PROTEÇÃO SOLAR": [
    { pattern: /\b(solar.*crian|kids|infantil.*solar)/i, nivel2: "Solar Criança" },
    { pattern: /\b(p[oó]s-?solar|after.?sun)/i, nivel2: "Pós-solar" },
    { pattern: /\b(autobronz|self.?tan)/i, nivel2: "Autobronzeador" },
    { pattern: /\b(solar|spf|fps|protetor.*solar|sunscreen)/i, nivel2: "Solar Adulto" },
  ],
  "DISPOSITIVOS MÉDICOS": [
    { pattern: /\b(glic[eé]m|glucometro|teste.*diabet|glucose)/i, nivel2: "Glicemia e Diabetes" },
    { pattern: /\b(tens[aã]o|tensi[oó]metro|blood pressure|esfigmoman[oó])/i, nivel2: "Tensão Arterial" },
    { pattern: /\b(term[oó]metro|thermometer)/i, nivel2: "Termómetros" },
    { pattern: /\b(nebuliz|aeross?ol)/i, nivel2: "Nebulizadores" },
    { pattern: /\b(curativo|compressa|penso|gaze)/i, nivel2: "Material de Curativo" },
    { pattern: /\b(imobiliz|tala)/i, nivel2: "Material de Imobilização" },
    { pattern: /\b(teste|monitoriz)/i, nivel2: "Testes e Monitorização" },
  ],
  ORTOPEDIA: [
    { pattern: /\b(joelheira|knee)/i, nivel2: "Joelheiras" },
    { pattern: /\b(tornozeleira|ankle)/i, nivel2: "Tornozeleiras" },
    { pattern: /\b(cinta|faixa lombar|lumbar)/i, nivel2: "Cintas e Faixas" },
    { pattern: /\b(punho|cotoveleira|elbow|wrist)/i, nivel2: "Punhos e Cotoveleiras" },
    { pattern: /\b(palmilha|insole)/i, nivel2: "Palmilhas" },
    { pattern: /\b(meia.*compress|compression stocking)/i, nivel2: "Meias de Compressão" },
  ],
  "SAÚDE SEXUAL": [
    { pattern: /\b(preservativo|condom)/i, nivel2: "Preservativos" },
    { pattern: /\b(lubrificante|lubricant)/i, nivel2: "Lubrificantes" },
    { pattern: /\b(teste.*gravidez|test.*pregnan|teste.*fertil)/i, nivel2: "Testes" },
  ],
  "PRIMEIROS SOCORROS": [
    { pattern: /\b(penso|compressa)/i, nivel2: "Pensos e Compressas" },
    { pattern: /\b(ligadura|bandage)/i, nivel2: "Ligaduras" },
    { pattern: /\b(antiss?[eé]ptico|iodopovid|betadine)/i, nivel2: "Antissépticos" },
    { pattern: /\b(trat.*ferida|cicatriz)/i, nivel2: "Tratamento de Feridas" },
  ],
  "MATERIAL CLÍNICO E CONSUMÍVEIS": [
    { pattern: /\b(seringa|agulha|syringe|needle)/i, nivel2: "Seringas e Agulhas" },
    { pattern: /\b(luva|glove)/i, nivel2: "Luvas" },
    { pattern: /\b(m[aá]scara cir[uú]rg|m[aá]scara ffp|surgical mask)/i, nivel2: "Máscaras" },
  ],
  COSMÉTICA: [
    { pattern: /\b(maquilh|makeup|batom|rimmel|base|corretor|sombra)/i, nivel2: "Maquilhagem" },
    { pattern: /\b(desmaquil|demaquil|remove makeup)/i, nivel2: "Desmaquilhantes" },
    { pattern: /\b(perfume|eau de|fragr[aâ]nc)/i, nivel2: "Perfumes" },
  ],
  "SAÚDE NATURAL": [
    { pattern: /\b(fitoter|ervan[aá]rio|planta medicinal)/i, nivel2: "Fitoterapia" },
    { pattern: /\b(homeo|homeopatia)/i, nivel2: "Homeopatia" },
    { pattern: /\b(floral|flores de bach)/i, nivel2: "Florais" },
  ],
  VETERINÁRIA: [
    { pattern: /\b(c[aã]o|dog|canino)/i, nivel2: "Cães" },
    { pattern: /\b(gato|cat|felino)/i, nivel2: "Gatos" },
    { pattern: /\b(desparas|antiparas.*animal|frontline|bravecto)/i, nivel2: "Desparasitação" },
  ],
};

// ─── Hints de categoria externa (fontes OFF/OBF/etc) → Nivel1 ─────────────────

const EXTERNAL_CATEGORY_HINTS: Array<{ pattern: RegExp; nivel1: string }> = [
  { pattern: /vitamin|supplement|nutri[ct]ion|food supplement/i, nivel1: "SUPLEMENTOS ALIMENTARES" },
  { pattern: /sunscreen|sun ?care|solar/i,                        nivel1: "PROTEÇÃO SOLAR" },
  { pattern: /beaut|cosmet|skincare|skin ?care/i,                  nivel1: "DERMOCOSMÉTICA" },
  { pattern: /makeup|make.?up|lipstick|fragrance/i,                nivel1: "COSMÉTICA" },
  { pattern: /oral ?care|dental|toothpaste/i,                      nivel1: "HIGIENE ORAL" },
  { pattern: /hair ?care|shampoo/i,                                nivel1: "CAPILAR" },
  { pattern: /baby|infant|beb[eé]/i,                                nivel1: "PUERICULTURA E BEBÉ" },
  { pattern: /pregnan|maternity|m[aã]e/i,                           nivel1: "MÃE E GRAVIDEZ" },
  { pattern: /pet|veterinar|animal/i,                              nivel1: "VETERINÁRIA" },
  { pattern: /medical ?device|dispositivo/i,                       nivel1: "DISPOSITIVOS MÉDICOS" },
  { pattern: /orthoped|ortop[eé]d/i,                                nivel1: "ORTOPEDIA" },
  { pattern: /homeopath|fitoter|herbal|natural/i,                   nivel1: "SAÚDE NATURAL" },
  { pattern: /hygien|banho|body ?wash|soap/i,                       nivel1: "HIGIENE CORPORAL" },
];

// ─── Resolução ────────────────────────────────────────────────────────────────

function resolveNivel1FromExternal(input: TaxonomyMapInput): { nivel1: string; confidence: number } | null {
  const blob = [input.externalCategory ?? "", input.externalSubcategory ?? ""].join(" ");
  if (!blob.trim()) return null;
  for (const h of EXTERNAL_CATEGORY_HINTS) {
    if (h.pattern.test(blob)) return { nivel1: h.nivel1, confidence: 0.85 };
  }
  return null;
}

function resolveNivel1FromProductType(input: TaxonomyMapInput): { nivel1: string; confidence: number } | null {
  const mapped = PRODUCT_TYPE_TO_NIVEL1[input.productType];
  if (!mapped) return null;
  return { nivel1: mapped, confidence: input.productTypeConfidence };
}

function resolveNivel2(nivel1: string, input: TaxonomyMapInput): { nivel2: string; confidence: number } | null {
  // 1. Se é MEDICAMENTOS e há ATC válido, usar a 1ª letra
  if (nivel1 === "MEDICAMENTOS" && input.atc) {
    const letter = input.atc.charAt(0).toUpperCase();
    const byAtc = ATC_LETTER_TO_NIVEL2[letter];
    if (byAtc && isValidNivel2(nivel1, byAtc)) {
      return { nivel2: byAtc, confidence: 0.90 };
    }
  }

  // 2. Keyword matching sobre designação + categoria externa
  const textBlob = [
    input.externalCategory ?? "",
    input.externalSubcategory ?? "",
    input.designacao,
  ].join(" ");

  const rules = KEYWORD_RULES[nivel1] ?? [];
  for (const rule of rules) {
    if (rule.pattern.test(textBlob)) {
      return { nivel2: rule.nivel2, confidence: 0.80 };
    }
  }

  // 3. Validação de qualquer nivel2 textualmente presente na categoria externa
  if (input.externalCategory || input.externalSubcategory) {
    const externalBlob = `${input.externalCategory ?? ""} ${input.externalSubcategory ?? ""}`.toLowerCase();
    for (const n2 of getNivel2For(nivel1)) {
      if (externalBlob.includes(n2.toLowerCase())) {
        return { nivel2: n2, confidence: 0.78 };
      }
    }
  }

  return null;
}

/**
 * Mapeia signals para uma categoria canónica (nivel1, nivel2).
 *
 * Nunca inventa nomes. Nunca devolve fora da taxonomia canónica.
 * Fallbacks preferenciais: "Em Revisão" > "Por Classificar" > "Outros <X>".
 */
export function mapToCanonical(input: TaxonomyMapInput): TaxonomyMapOutput {
  // Resolução de nivel1 — prioridade: hint de categoria externa > productType
  const fromExternal = resolveNivel1FromExternal(input);
  const fromType = resolveNivel1FromProductType(input);

  const n1 = fromExternal ?? fromType;
  const n1Method: TaxonomyMapOutput["method"] = fromExternal
    ? "external_category_hint"
    : "product_type_only";

  if (n1 && n1.confidence >= 0.60) {
    const n2 = resolveNivel2(n1.nivel1, input);
    if (n2) {
      return {
        nivel1: n1.nivel1,
        nivel2: n2.nivel2,
        confidence: Math.min(n1.confidence, n2.confidence),
        method: n2.confidence >= 0.88 ? "atc" : "keyword",
        isFallback: false,
      };
    }
    // Nivel1 claro, nivel2 não identificável → Em Revisão (não caímos em "Outros")
    return {
      nivel1: TRANSITORIA_NIVEL1,
      nivel2: TRANSITORIA_EM_REVISAO,
      confidence: 0.55,
      method: "em_revisao",
      isFallback: true,
    };
  }

  // Sem nivel1 determinável
  const hadAnySignal =
    !!input.externalCategory || !!input.externalSubcategory || !!input.atc;
  return {
    nivel1: TRANSITORIA_NIVEL1,
    nivel2: hadAnySignal ? TRANSITORIA_EM_REVISAO : TRANSITORIA_POR_CLASSIFICAR,
    confidence: 0.50,
    method: hadAnySignal ? "em_revisao" : "por_classificar",
    isFallback: true,
  };
}
