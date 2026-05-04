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
 *      for possível.
 *   4. Se não há sinal suficiente para determinar (nivel1, nivel2) com
 *      categoria comercial REAL, devolve `null`. O persistence deixa
 *      `classificacao*Id` a `null` e o produto aparece como "sem
 *      classificação" — o estado vive em `verificationStatus` /
 *      `needsManualReview`, NÃO em categorias técnicas/transitórias.
 *
 * Usado por lib/catalog-persistence.ts antes de
 * resolveClassificationIdsFromCategory(), de forma a nunca gravar
 * categorias livres vindas das fontes nem categorias técnicas.
 */

import type { ProductType } from "./catalog-types";
import { getNivel2For, isValidNivel2, othersNameFor } from "./catalog-taxonomy";

export type TaxonomyMapInput = {
  productType: ProductType;
  productTypeConfidence: number;
  externalCategory: string | null;
  externalSubcategory: string | null;
  designacao: string;
  atc: string | null;
  /**
   * Princípio activo / DCI — se disponível, é usado como sinal de keyword
   * para escolher nivel2 dentro de MEDICAMENTOS quando o ATC sozinho não
   * é específico o suficiente, ou como fallback quando o ATC é null.
   * Origem típica: snapshot INFARMED (REGULATORY tier).
   */
  dci?: string | null;
};

export type TaxonomyMapOutput = {
  nivel1: string;
  nivel2: string;
  confidence: number;
  method:
    | "keyword"
    | "atc"
    | "atc_prefix"
    | "dci"
    | "external_category_hint"
    | "product_type_only"
    | "others_fallback";
  /**
   * Razão estruturada para diagnóstico — explicita *porquê* o mapper
   * escolheu este (nivel1, nivel2). Útil em logs verbose, especialmente
   * para entender porque um medicamento caiu em "Outros Medicamentos"
   * ou porque um ATC foi (ou não foi) usado.
   */
  reason: string;
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

// ─── ATC → Nivel2 canónico dentro de MEDICAMENTOS ────────────────────────────
//
// O ATC (Anatomical Therapeutic Chemical) tem 5 níveis hierárquicos:
//
//   N         (1 char) — grupo anatómico principal
//   N02       (3 chars) — grupo terapêutico principal
//   N02B      (4 chars) — subgrupo terapêutico/farmacológico
//   N02BE     (5 chars) — subgrupo químico-terapêutico/farmacológico
//   N02BE01   (7 chars) — substância química (DCI)
//
// O nível-1 (primeira letra) sozinho é demasiado coarse para decidir nivel2
// canónico — por exemplo, um analgésico (N02) e um antiepiléptico (N03)
// caem ambos na letra "N" mas deveriam ir para "Analgésicos e Anti-
// inflamatórios" e "Sistema Nervoso" respectivamente.
//
// Estratégia (Maio 2026):
//   1. Se atc tem ≥3 chars e o prefixo de 3 está em ATC_PREFIX_TO_NIVEL2,
//      usa esse mapeamento (alta confiança, 0.92).
//   2. Senão, fallback à letra (ATC_LETTER_TO_NIVEL2, conf 0.85).
//   3. Senão, keyword/DCI (conf 0.80).
//
// "Outros Medicamentos" como nivel2 só aparece quando NENHUMA das fontes
// (ATC prefix, ATC letter, keyword, DCI) tem um match canónico — é o
// último recurso, alinhado com a política do mapper.

/**
 * Mapa fino por prefixo de 3 caracteres (grupo terapêutico ATC L2).
 * Cobre os casos onde a primeira letra é demasiado genérica.
 */
const ATC_PREFIX_TO_NIVEL2: Record<string, string> = {
  // ── A: Aparelho digestivo e metabolismo ──────────────────────────────
  A02: "Sistema Digestivo",   // Anti-ácidos, IBP, anti-úlcera
  A03: "Sistema Digestivo",   // Antiespasmódicos, anticolinérgicos
  A04: "Sistema Digestivo",   // Antieméticos
  A06: "Sistema Digestivo",   // Laxantes
  A07: "Sistema Digestivo",   // Antidiarreicos, anti-inflamatórios intestinais
  A09: "Sistema Digestivo",   // Digestivos enzimáticos
  A10: "Diabetes",            // Insulinas, antidiabéticos orais
  A11: "Outros Medicamentos", // Vitaminas (sem cat específica em MEDICAMENTOS)
  A12: "Outros Medicamentos", // Suplementos minerais (idem)
  A16: "Outros Medicamentos", // Outros — metabolismo

  // ── B: Sangue e órgãos hematopoiéticos ───────────────────────────────
  // Anticoagulantes/antitrombóticos não têm cat própria; cardiovascular
  // é o destino clínico mais frequente (apixabano, varfarina, AAS dose CV).
  B01: "Cardiovascular",      // Antitrombóticos
  B02: "Outros Medicamentos", // Antihemorrágicos
  B03: "Outros Medicamentos", // Antianémicos

  // ── C: Sistema cardiovascular ────────────────────────────────────────
  C01: "Cardiovascular",
  C02: "Cardiovascular",
  C03: "Cardiovascular",      // Diuréticos (uso cardio)
  C04: "Cardiovascular",
  C05: "Cardiovascular",
  C07: "Cardiovascular",      // Beta-bloqueantes (nebivolol, bisoprolol)
  C08: "Cardiovascular",      // Bloqueadores Ca (amlodipina)
  C09: "Cardiovascular",      // IECA/ARA (enalapril, losartan, ramipril)
  C10: "Cardiovascular",      // Estatinas (atorvastatina, sinvastatina)

  // ── D: Dermatológicos ────────────────────────────────────────────────
  D01: "Dermatológicos",      // Antifúngicos tópicos
  D02: "Dermatológicos",      // Emolientes/protectores
  D03: "Dermatológicos",      // Cicatrizantes
  D05: "Dermatológicos",      // Antipsoríase
  D06: "Dermatológicos",      // Antibióticos/quimioterápicos tópicos
  D07: "Dermatológicos",      // Corticosteróides tópicos
  D08: "Antisséticos e Desinfetantes", // Antissépticos/desinfetantes (clorhexidina, iodopovidona)
  D10: "Dermatológicos",      // Antiacne
  D11: "Dermatológicos",      // Outros dermatológicos

  // ── G: Sistema genito-urinário e hormonas sexuais ────────────────────
  G01: "Ginecológicos",
  G02: "Ginecológicos",
  G03: "Ginecológicos",       // Hormonas sexuais (anticoncepcionais, TRH)
  G04: "Urológicos",          // Urológicos (tansulosina, finasterida BPH)

  // ── J: Anti-infecciosos sistémicos (sem cat dedicada — fica Outros) ──
  J01: "Outros Medicamentos", // Antibióticos sistémicos
  J02: "Outros Medicamentos", // Antifúngicos sistémicos
  J04: "Outros Medicamentos", // Antimicobacterianos
  J05: "Outros Medicamentos", // Antivirais sistémicos
  J06: "Outros Medicamentos", // Imunoglobulinas
  J07: "Outros Medicamentos", // Vacinas

  // ── M: Sistema músculo-esquelético ───────────────────────────────────
  M01: "Analgésicos e Anti-inflamatórios", // AINEs (ibuprofeno, diclofenac, naproxeno)
  M02: "Analgésicos e Anti-inflamatórios", // Tópicos articulares
  M03: "Sistema Nervoso",                 // Relaxantes musculares
  M04: "Analgésicos e Anti-inflamatórios", // Antigotosos
  M05: "Outros Medicamentos",              // Doenças ósseas (bifosfonatos)

  // ── N: Sistema nervoso ───────────────────────────────────────────────
  N01: "Outros Medicamentos",             // Anestésicos
  N02: "Analgésicos e Anti-inflamatórios", // Analgésicos (paracetamol N02BE01, opióides)
  N03: "Sistema Nervoso",                 // Antiepilépticos
  N04: "Sistema Nervoso",                 // Antiparkinsonianos
  N05: "Sistema Nervoso",                 // Psicolépticos (ansiolíticos, antipsicóticos)
  N06: "Sistema Nervoso",                 // Psicoanalépticos (antidepressivos)
  N07: "Sistema Nervoso",                 // Outros do SNC

  // ── R: Sistema respiratório ──────────────────────────────────────────
  R01: "Constipação, Tosse e Gripe",      // Nasais (descongestionantes)
  R02: "Constipação, Tosse e Gripe",      // Garganta
  R03: "Respiratório",                    // Asma/DPOC (salbutamol, budesonida, formoterol)
  R05: "Constipação, Tosse e Gripe",      // Tosse e expectorantes
  R06: "Alergias",                        // Anti-histamínicos sistémicos (cetirizina, loratadina, bilastina)
  R07: "Respiratório",                    // Outros respiratórios

  // ── S: Órgãos sensoriais ─────────────────────────────────────────────
  S01: "Oftálmicos",
  S02: "Otológicos",
  S03: "Oftálmicos",                      // Combinados oftálmicos+otológicos — preferir oftálmico
};

/**
 * Mapa coarse por primeira letra do ATC. Fallback quando o prefixo de 3
 * não está coberto. Mantém-se conservador para evitar mapping errados.
 */
const ATC_LETTER_TO_NIVEL2: Record<string, string> = {
  A: "Sistema Digestivo",            // Alimentary tract and metabolism
  B: "Outros Medicamentos",           // Blood and blood forming organs
  C: "Cardiovascular",               // Cardiovascular system
  D: "Dermatológicos",               // Dermatologicals
  G: "Ginecológicos",                // Genito-urinary system (default G01-G03)
  H: "Outros Medicamentos",           // Systemic hormonal preparations
  J: "Outros Medicamentos",           // Anti-infectives systemic
  L: "Outros Medicamentos",           // Antineoplastic
  M: "Analgésicos e Anti-inflamatórios", // Musculo-skeletal system
  N: "Sistema Nervoso",              // Nervous system (default não-N02)
  P: "Outros Medicamentos",           // Antiparasitic
  R: "Respiratório",                 // Respiratory system (default não-R06)
  S: "Oftálmicos",                   // Sensory organs (default S01)
  V: "Outros Medicamentos",           // Various
};

// ─── Keyword rules por nivel1 → ordem importa (first match wins) ──────────────

type KeywordRule = { pattern: RegExp; nivel2: string };

const KEYWORD_RULES: Record<string, KeywordRule[]> = {
  MEDICAMENTOS: [
    { pattern: /\b(ibuprofeno|paracetamol|aspirina|diclofenac|naproxeno|nimesulida|ketoprofeno|\bdor\b|analges|anti-?inflamat)/i, nivel2: "Analgésicos e Anti-inflamatórios" },
    { pattern: /\b(constipa|tosse|gripe|expectorante|xarope|mucolit|descongestion)/i, nivel2: "Constipação, Tosse e Gripe" },
    { pattern: /\b(alergia|anti-?histam|loratadina|cetiriz|desloratadina|bilastina|fexofenadina)/i, nivel2: "Alergias" },
    { pattern: /\b(digest|est[oô]mago|azia|laxant|laxoberal|agiolax|psyllium|plantago|sennosid|sen[oa]si|obstipa|diarre|naus|omeprazol|pantoprazol|esomeprazol|ranitid|domperid|metoclop|loperam)/i, nivel2: "Sistema Digestivo" },
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
    // Específicos antes dos genéricos: a frase "Estimulantes e Energizantes"
    // tem prioridade sobre o pattern de Vitaminas (que apanharia "Vitacell"
    // via /vit ?[abcde]/). Hepa/fígado idem antes de "Vitaminas".
    // Sono/Ansiedade tem que vencer "vitamin" também (gomas relax podem
    // mencionar vitaminas).
    { pattern: /\b(ansiedade,?\s+stress|dist[uú]rbios?\s+(?:do|de)\s+sono|sono\s+kids|relax(?:ant)?\s+gomas|sono|dormir|relax|melaton|valer[ií]ana|passiflora|tilia)/i, nivel2: "Sono e Relaxamento" },
    { pattern: /\b(estimulantes?\s+e?\s+energizantes?|energ[ií]z|energ[ií]tic|\benerg|vitali|fadiga|cansa[cç]o|ginseng|cafe[ií]na|guaran[aá]|maca)/i, nivel2: "Energia e Vitalidade" },
    { pattern: /\b(probi[oó]t|pr[eé]bi[oó]t|transito|intest|lactobac|bifid|h?epat(?:o|ic)|f[ií]gado|digest|easylax|laxat[a-z]*|tr[aâ]nsit\w*\s+intest|trato\s+(?:digestivo|intestinal)|sa[uú]de\s+e\s+bem.?estar)/i, nivel2: "Digestão e Probióticos" },
    { pattern: /\b(imun|defesa|resist[eê]ncia|equin[aá]cea|pr[oó]polis)/i, nivel2: "Imunidade" },
    { pattern: /\b([ií]ntima|vaginal|cranberry|ar[aâ]ndano|menopausa|climat[eé]rio|sa[uú]de\s+feminina|genipausa|afax)/i, nivel2: "Saúde Íntima" },
    { pattern: /\b(vitamin|multivit|vit ?[abcde]|\bb\d{1,2}\b|complexo b|magn[eé]sio|c[aá]lcio|zinco|ferro|mineral|pot[aá]ssio|i[oó]do|sel[eé]nio)/i, nivel2: "Vitaminas e Minerais" },
    { pattern: /\b(mem[oó]ria|concentra|cogni|ginkgo|bacopa)/i, nivel2: "Memória e Concentração" },
    { pattern: /\b(articul|osso|col[aá]geno|glucosam|condroit|msm|cartilag)/i, nivel2: "Articulações e Ossos" },
    { pattern: /\b(cabelo|pele|unhas|biotina|queda|queratina)/i, nivel2: "Cabelo, Pele e Unhas" },
    { pattern: /\b(peso|emagrec|queimador|saciant|drenant)/i, nivel2: "Controlo de Peso" },
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
    { pattern: /\b(aptamil|leite.*beb|leite.*(?:lactente|cresciment|infant)|f[oó]rmula\s+infant|papa|nan\s+(?:hm|optipro|sensit)|hipp\b|holle\b)/i, nivel2: "Alimentação do Bebé" },
    { pattern: /\b(chupeta|bibera|biber[aã]o|tetina)/i, nivel2: "Chupetas e Biberões" },
    { pattern: /\b(at[oó]pic.*beb|beb.*at[oó]pic|exomega|trixera)/i, nivel2: "Pele Atópica do Bebé" },
    { pattern: /\b(higiene.*beb|beb.*higiene|gel\s+(?:de\s+)?banho|banho\s+calmant|champ[oô].*beb)/i, nivel2: "Higiene do Bebé" },
    // Brinquedos / acessórios não-alimentares de puericultura. Catch-all
    // para Chicco, brinquedos cavalgáveis, peluches, etc.
    { pattern: /\b(chicco|brinquedos?|cavalg[aá]vel|peluche|cavalinho\s+saltit|carrinho\s+(?:de\s+)?(?:gelados?|brinquedo))/i, nivel2: "Acessórios de Bebé" },
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
    { pattern: /\b(glic[eé]m|glucometro|teste.*diabet|glucose|tiras?\s+glicemi|contour\s+next|ascencia)/i, nivel2: "Glicemia e Diabetes" },
    { pattern: /\b(tens[aã]o|tensi[oó]metro|blood pressure|esfigmoman[oó])/i, nivel2: "Tensão Arterial" },
    { pattern: /\b(term[oó]metro|thermometer)/i, nivel2: "Termómetros" },
    { pattern: /\b(nebuliz|aeross?ol)/i, nivel2: "Nebulizadores" },
    { pattern: /\b(curativo|compressa|penso|gaze)/i, nivel2: "Material de Curativo" },
    { pattern: /\b(imobiliz|tala)/i, nivel2: "Material de Imobilização" },
    { pattern: /\b(teste\s+(?:gravidez|fertili|ovula)|teste|monitoriz)/i, nivel2: "Testes e Monitorização" },
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
    { pattern: /\b([aá]gua\s+destilada|[aá]lcool\s+(?:isopr[oó]p|et[ií]lico)|antiss?[eé]ptic|desinfetant|consum[ií]vel)/i, nivel2: "Consumíveis Clínicos" },
  ],
  COSMÉTICA: [
    { pattern: /\b(maquilh|makeup|batom|rimmel|base|corretor|sombra)/i, nivel2: "Maquilhagem" },
    { pattern: /\b(desmaquil|demaquil|remove makeup)/i, nivel2: "Desmaquilhantes" },
    { pattern: /\b(perfume|eau de|fragr[aâ]nc)/i, nivel2: "Perfumes" },
  ],
  "SAÚDE NATURAL": [
    { pattern: /\b(fitoter|ervan[aá]rio|planta medicinal)/i, nivel2: "Fitoterapia" },
    { pattern: /\b(homeo|homeopatia|boiron|apis\s+mellif|nux\s+vomic|arnica\s+\d+ch|gr[aâ]nul[oa]s?\s+\d+ch|\d+\s*ch\s+(?:gran|comp|dilui))/i, nivel2: "Homeopatia" },
    { pattern: /\b(floral|flores de bach)/i, nivel2: "Florais" },
  ],
  VETERINÁRIA: [
    { pattern: /\b(c[aã]o|dog|canino)/i, nivel2: "Cães" },
    { pattern: /\b(gato|cat|felino)/i, nivel2: "Gatos" },
    { pattern: /\b(desparas|antiparas.*animal|frontline|bravecto)/i, nivel2: "Desparasitação" },
  ],
  "SERVIÇOS E ARTIGOS NÃO COMERCIALIZÁVEIS": [
    // Vacinas, consultas, atos clínicos (incluindo administrações SNS).
    { pattern: /\b(administra[cç][aã]o\s+vacina|vacina\s+(?:covid|gripe|sns|tetan|pneumoc|hpv)|consult[aá]\s+(?:enfermag|farmac[eê]ut)|servi[cç]o\s+cl[ií]nic)/i, nivel2: "Serviço Clínico" },
    // Taxas SNS / atos administrativos
    { pattern: /\b(taxa\s+(?:moderadora|sns)|tax|servi[cç]o\s+sns|reembolso)/i, nivel2: "Taxas e Atos" },
    // Operações administrativas
    { pattern: /\b(administra[cç][aã]o\b(?!.*vacina)|expedient|acto\s+administra)/i, nivel2: "Administração" },
    // Artigos internos / não-vendáveis (sacos, etiquetas, papelaria farmácia)
    { pattern: /\b(saco\s+(?:plast|farm)|etiquet|papel(?:aria)?\s+farma|artig[oa]s?\s+intern|n[aã]o[\s-]?vend[aá]vel)/i, nivel2: "Artigos Internos" },
  ],
};

// ─── Hints de categoria externa (fontes OFF/OBF/etc) → Nivel1 ─────────────────
//
// Ordem importa: o primeiro match vence. Padrões mais ESPECÍFICOS ficam em
// cima (ex.: "saúde oral" antes de "saúde", "estimulantes/energizantes"
// antes de "energ" puro). Cobre vocabulário comum em farmácia portuguesa
// (Mamã/Bebé/Criança, Dermis, Saúde e Bem-estar, Estimulantes, etc.).
const EXTERNAL_CATEGORY_HINTS: Array<{ pattern: RegExp; nivel1: string }> = [
  // ── Pattern G — Serviços / vacinas SNS / taxas (intencionalmente OUTRO no
  //    productType, mas com canonical real em SERVIÇOS E ARTIGOS NÃO
  //    COMERCIALIZÁVEIS).
  { pattern: /administra[cç][aã]o\s+vacina|servi[cç]o\s+(?:sns|cl[ií]nic|farma)|consult[aá]\s+enfermag|vacina\s+(?:covid|gripe|sns)|taxa\s+(?:moderadora|sns)/i, nivel1: "SERVIÇOS E ARTIGOS NÃO COMERCIALIZÁVEIS" },

  // ── Específicos antes de gerais
  { pattern: /sa[uú]de\s+oral|oral ?care|dental|toothpaste|escova(?:s)?\s+(?:de\s+)?dentes?|pasta(?:s)?\s+(?:de\s+)?dent|fio\s+dent[aá]rio|elixir/i, nivel1: "HIGIENE ORAL" },
  { pattern: /estimulantes?\s+e?\s+energizantes?|energ[ií]ticos?(?:\s|$)/i, nivel1: "SUPLEMENTOS ALIMENTARES" },
  { pattern: /circula(?:c|ç)[aã]o|pernas\s+cansadas|venoton[ií]c|hemorr[oó]id|h?emo\s+duo/i, nivel1: "SUPLEMENTOS ALIMENTARES" },
  { pattern: /sa[uú]de\s+e\s+bem.?estar|bem.?estar\s+(?:geral|f[ií]sico)|h?epat(?:o|ic)|fígado|figado|articula(?:c|ç)[oõ]es|imunidade|defesas?/i, nivel1: "SUPLEMENTOS ALIMENTARES" },

  // ── Pattern A — Suplementos por breadcrumb categórico
  { pattern: /ansiedade,?\s+stress|dist[uú]rbios?\s+(?:do|de)\s+sono|relax(?:ant)?\s+gomas/i, nivel1: "SUPLEMENTOS ALIMENTARES" },
  { pattern: /trato\s+(?:digestivo|intestinal)/i, nivel1: "SUPLEMENTOS ALIMENTARES" },
  { pattern: /sistema\s+cardiovascular|colesterol/i, nivel1: "SUPLEMENTOS ALIMENTARES" },
  { pattern: /sa[uú]de\s+feminina|menopausa|climat[eé]rio|genipausa/i, nivel1: "SUPLEMENTOS ALIMENTARES" },

  // ── Pattern F — Homeopatia (Boiron, dilution \dch)
  { pattern: /\bboiron\b|apis\s+mellif|nux\s+vomic|\barnica\b\s+\d+ch|gr[aâ]nul[oa]s?\s+\d+ch|\d+\s*ch\s+(?:gran|comp|dilui)/i, nivel1: "SAÚDE NATURAL" },

  // Breadcrumb "Medicamentos" — explícito numa árvore tipo "INDICE.eu >
  // Medicamentos > <produto>".
  { pattern: /(?:^|>|\/)\s*medicamentos?\s*(?:>|\/|$)/i, nivel1: "MEDICAMENTOS" },

  // ── Pattern E — Puericultura: Aptamil/leite infantil + brinquedos Chicco
  { pattern: /aptamil|leite\s+(?:lactente|cresciment|infant)|f[oó]rmula\s+infant|nan\s+(?:hm|optipro|sensit)|hipp\b|holle\b/i, nivel1: "PUERICULTURA E BEBÉ" },
  { pattern: /chicco|brinquedos?|cavalg[aá]vel|peluche|cavalinho\s+saltit/i, nivel1: "PUERICULTURA E BEBÉ" },
  { pattern: /m[aã]m[aã]|crian[cç]a|infantil|puericultura/i, nivel1: "PUERICULTURA E BEBÉ" },

  // ── Pattern D — Material clínico / Dispositivos médicos
  { pattern: /tiras?\s+glicemi|contour\s+next|ascencia|glucometro/i, nivel1: "DISPOSITIVOS MÉDICOS" },
  { pattern: /teste\s+(?:gravidez|fertili|ovula)/i, nivel1: "DISPOSITIVOS MÉDICOS" },
  { pattern: /pensos?\s+e?\s+material\s+de\s+desinfe|material\s+cl[ií]nic/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS" },
  { pattern: /[aá]gua\s+destilada|[aá]lcool\s+(?:isopr[oó]p|et[ií]lico)/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS" },

  { pattern: /hidratantes?\s+corpor|cuidados?\s+(?:de\s+)?corpo|dermocosm[eé]tica|dermis|corpo\s+e\s+rosto/i, nivel1: "DERMOCOSMÉTICA" },
  { pattern: /protec(?:c|ç)[aã]o\s+solar|sunscreen|sun ?care|solar(?:\b|es)|fotoprotec/i, nivel1: "PROTEÇÃO SOLAR" },

  // ── Originais
  { pattern: /vitamin|supplement|nutri[ct]ion|food supplement|prob[ií]o|prebi[oó]|colag[eé]nio|magn[eé]sio|c[aá]lcio/i, nivel1: "SUPLEMENTOS ALIMENTARES" },
  { pattern: /beaut|cosmet|skincare|skin ?care|cuidados?\s+(?:de\s+)?(?:rosto|pele)|s[eé]rum|toleriane|cicalfate/i, nivel1: "DERMOCOSMÉTICA" },
  { pattern: /makeup|make.?up|lipstick|fragrance|maquilhag|perfumes?/i, nivel1: "COSMÉTICA" },
  { pattern: /hair ?care|shampoo|champ[oô]|capilar/i, nivel1: "CAPILAR" },
  { pattern: /baby|infant|beb[eé]/i, nivel1: "PUERICULTURA E BEBÉ" },
  { pattern: /pregnan|maternity|m[aã]e\s+e\s+grav|gestant/i, nivel1: "MÃE E GRAVIDEZ" },
  { pattern: /pet\s|veterinar|cães|gatos|c[aã]es|frontline|bravecto|antiparasit[aá]rio/i, nivel1: "VETERINÁRIA" },
  { pattern: /medical ?device|dispositivo\s+m[eé]dic|term[oó]metro|nebuliza|tens[iaã]o\s+arterial|glic[eé]m/i, nivel1: "DISPOSITIVOS MÉDICOS" },
  { pattern: /orthoped|ortop[eé]d|joelheira|tornozeleira|cinta\s+lombar|palmilha/i, nivel1: "ORTOPEDIA" },
  { pattern: /homeopath|fitoter|herbal|natural/i, nivel1: "SAÚDE NATURAL" },
  { pattern: /hygien|gel\s+(?:de\s+)?banho|gel\s+(?:de\s+)?duche|body ?wash|soap|sabonet|desodor|antitranspir/i, nivel1: "HIGIENE CORPORAL" },
];

// ─── Resolução ────────────────────────────────────────────────────────────────

function resolveNivel1FromExternal(input: TaxonomyMapInput): { nivel1: string; confidence: number } | null {
  // Preferência: breadcrumb (autoridade alta, conf 0.85). Fallback:
  // designação do produto (conf 0.70 — evidência mais fraca que categoria
  // explícita mas suficiente para casos como serviços SNS, Aptamil sem
  // breadcrumb, "Aposan Teste Gravidez" como nome cru, etc.). Só fica em
  // null quando NEM breadcrumb NEM nome têm sinal — aí o productType
  // assume o lead.
  const breadcrumb = [input.externalCategory ?? "", input.externalSubcategory ?? ""].join(" ");
  if (breadcrumb.trim()) {
    for (const h of EXTERNAL_CATEGORY_HINTS) {
      if (h.pattern.test(breadcrumb)) return { nivel1: h.nivel1, confidence: 0.85 };
    }
  }
  const designacao = input.designacao ?? "";
  if (designacao.trim()) {
    for (const h of EXTERNAL_CATEGORY_HINTS) {
      if (h.pattern.test(designacao)) return { nivel1: h.nivel1, confidence: 0.70 };
    }
  }
  return null;
}

function resolveNivel1FromProductType(input: TaxonomyMapInput): { nivel1: string; confidence: number } | null {
  const mapped = PRODUCT_TYPE_TO_NIVEL1[input.productType];
  if (!mapped) return null;
  return { nivel1: mapped, confidence: input.productTypeConfidence };
}

type Nivel2Resolution = {
  nivel2: string;
  confidence: number;
  method: "atc" | "atc_prefix" | "keyword" | "dci" | "external_category_hint";
  reason: string;
};

function resolveNivel2(nivel1: string, input: TaxonomyMapInput): Nivel2Resolution | null {
  const isMed = nivel1 === "MEDICAMENTOS";
  const atc = input.atc?.trim() ?? null;
  const atcUpper = atc ? atc.toUpperCase() : null;

  // 1. MEDICAMENTOS — ATC prefixo de 3 (mais específico que letra). Cobre
  //    casos como N02 (analgésicos), R06 (alergias), C07/C08/C09/C10
  //    (cardiovascular), D08 (antissépticos), S02 (otológicos), etc.
  if (isMed && atcUpper && atcUpper.length >= 3) {
    const prefix3 = atcUpper.slice(0, 3);
    const byPrefix = ATC_PREFIX_TO_NIVEL2[prefix3];
    if (byPrefix && isValidNivel2(nivel1, byPrefix)) {
      return {
        nivel2: byPrefix,
        confidence: 0.92,
        method: "atc_prefix",
        reason: `ATC prefix ${prefix3} (${atcUpper}) → ${byPrefix}`,
      };
    }
  }

  // 2. Keyword matching sobre designação + categoria externa + DCI.
  //    Para medicamentos, o DCI (vindo da snapshot INFARMED) é frequentemente
  //    a única palavra reconhecível — incluí-lo no texto-alvo permite que
  //    keywords como "ibuprofeno" / "paracetamol" / "nebivolol" / "cetirizina"
  //    resolvam o nivel2 mesmo quando a designacao do ERP é abreviada.
  const textBlob = [
    input.externalCategory ?? "",
    input.externalSubcategory ?? "",
    input.designacao,
    input.dci ?? "",
  ].join(" ");

  const rules = KEYWORD_RULES[nivel1] ?? [];
  for (const rule of rules) {
    if (rule.pattern.test(textBlob)) {
      const matched = rule.pattern.exec(textBlob)?.[0] ?? "?";
      // Pequeno boost se foi a DCI a despoletar o match (sinal regulatório
      // forte). Detecção: o match tem de cair dentro do segmento DCI do blob.
      const dciHit = !!input.dci && rule.pattern.test(input.dci);
      const conf = dciHit && isMed ? 0.85 : 0.80;
      return {
        nivel2: rule.nivel2,
        confidence: conf,
        method: dciHit && isMed ? "dci" : "keyword",
        reason: dciHit && isMed
          ? `DCI "${input.dci}" → keyword match "${matched}" → ${rule.nivel2}`
          : `keyword "${matched}" → ${rule.nivel2}`,
      };
    }
  }

  // 3. MEDICAMENTOS — ATC letra (1 char) como fallback coarse. Só corre
  //    se o prefixo de 3 não estava no mapa, o que significa que o ATC é
  //    raro/genérico (ex.: "Z" inválido, "V03" misc). A confiança é menor
  //    porque a letra sozinha é ambígua dentro de N/R/S.
  if (isMed && atcUpper && atcUpper.length >= 1) {
    const letter = atcUpper.charAt(0);
    const byLetter = ATC_LETTER_TO_NIVEL2[letter];
    if (byLetter && isValidNivel2(nivel1, byLetter)) {
      return {
        nivel2: byLetter,
        confidence: 0.78,
        method: "atc",
        reason: `ATC letter ${letter} (${atcUpper}, prefix3 sem match) → ${byLetter}`,
      };
    }
  }

  // 4. Validação de qualquer nivel2 textualmente presente na categoria externa
  if (input.externalCategory || input.externalSubcategory) {
    const externalBlob = `${input.externalCategory ?? ""} ${input.externalSubcategory ?? ""}`.toLowerCase();
    for (const n2 of getNivel2For(nivel1)) {
      if (externalBlob.includes(n2.toLowerCase())) {
        return {
          nivel2: n2,
          confidence: 0.78,
          method: "external_category_hint",
          reason: `breadcrumb contém "${n2}"`,
        };
      }
    }
  }

  return null;
}

/**
 * Mapeia signals para uma categoria canónica (nivel1, nivel2).
 *
 * Nunca inventa nomes. Nunca devolve fora da taxonomia canónica.
 *
 * Política (revisão Abril 2026):
 *   · Sem nivel1 fiável (sem hint externo nem productType ≠ OUTRO com
 *     conf ≥ 0.60) → devolve `null`. O persistence deixa
 *     `classificacao*Id` a null e o estado fica em `verificationStatus`.
 *   · Nivel1 fiável mas nivel2 não identificável → cai em "Outros <nivel1>"
 *     (real, não técnico). Razão: forçar um produto a ficar sem
 *     classificação só porque não há keyword específica é pior do que
 *     atribuir-lhe a subcategoria "catch-all" do nivel1 correcto. O
 *     admin sempre pode reclassificar. `confidence` da fallback fica
 *     em 0.55 — abaixo do limiar de auto-VERIFIED, mas acima do
 *     `THRESHOLD_PARTIAL` (0.50) para que a persistência grave.
 */
export function mapToCanonical(input: TaxonomyMapInput): TaxonomyMapOutput | null {
  const fromExternal = resolveNivel1FromExternal(input);
  const fromType = resolveNivel1FromProductType(input);

  // Safety: para MEDICAMENTO com confiança alta (flagMSRM/flagMNSRM/ATC
  // foram suficientes para o classifier dar 0.95+), o productType é
  // autoridade superior a qualquer breadcrumb retail. Sem isto, uma
  // página retail com breadcrumb "Saúde > Cardiovascular" poderia
  // empurrar a classificação para SUPLEMENTOS ALIMENTARES (via padrão
  // /sistema cardiovascular|colesterol/), mesmo o produto sendo um
  // medicamento C09 (IECA). Os outros productTypes não têm a mesma
  // garantia regulatória — só MEDICAMENTO tem flag/ATC oficial.
  const isHighConfMed =
    input.productType === "MEDICAMENTO" && input.productTypeConfidence >= 0.90;
  let n1 = fromExternal ?? fromType;
  let n1FromTypeOverride = false;
  if (isHighConfMed && fromType && (!n1 || n1.nivel1 !== fromType.nivel1)) {
    n1 = fromType;
    n1FromTypeOverride = true;
  }

  if (!n1 || n1.confidence < 0.60) {
    return null;
  }

  const n1ReasonPrefix = n1FromTypeOverride
    ? `nivel1 via productType=MEDICAMENTO (high-conf, override breadcrumb) → ${n1.nivel1}`
    : fromExternal
    ? `nivel1 via breadcrumb/designação → ${n1.nivel1}`
    : `nivel1 via productType=${input.productType} → ${n1.nivel1}`;

  const n2 = resolveNivel2(n1.nivel1, input);
  if (n2) {
    return {
      nivel1: n1.nivel1,
      nivel2: n2.nivel2,
      confidence: Math.min(n1.confidence, n2.confidence),
      method: n2.method,
      reason: `${n1ReasonPrefix}; ${n2.reason}`,
    };
  }

  // Nivel1 claro mas nivel2 sem keyword. Em vez de devolver null, usa
  // "Outros <X>" como fallback REAL. Sempre acima do limiar de gravação
  // (0.55 ≥ THRESHOLD_PARTIAL=0.50) mas abaixo de VERIFIED (0.75) para
  // sinalizar à UI que o nivel2 foi inferido por fallback, não por keyword.
  const others = othersNameFor(n1.nivel1);
  if (others) {
    // Razão diagnóstica explícita para o caller (logs, UI, fila de revisão).
    // Para MEDICAMENTOS, lista os sinais que falharam: ATC prefix, ATC
    // letra, keyword/DCI — para o admin saber porque é que o medicamento
    // ficou em "Outros Medicamentos".
    let fallbackReason = "sem keyword/ATC específico";
    if (n1.nivel1 === "MEDICAMENTOS") {
      const parts: string[] = [];
      if (input.atc) {
        const u = input.atc.toUpperCase();
        const p3 = u.length >= 3 ? u.slice(0, 3) : null;
        const letter = u.charAt(0);
        const p3Mapped = p3 ? ATC_PREFIX_TO_NIVEL2[p3] : null;
        const letterMapped = ATC_LETTER_TO_NIVEL2[letter];
        if (p3 && !p3Mapped) parts.push(`ATC prefix ${p3} sem mapeamento`);
        if (letter && !letterMapped) parts.push(`ATC letter ${letter} sem mapeamento`);
        if (p3Mapped && !isValidNivel2(n1.nivel1, p3Mapped)) {
          parts.push(`ATC prefix ${p3} → "${p3Mapped}" não é nivel2 válido`);
        }
      } else {
        parts.push("ATC ausente");
      }
      if (input.dci) {
        parts.push(`DCI "${input.dci}" sem keyword associada`);
      } else {
        parts.push("DCI ausente");
      }
      parts.push("designação sem keyword reconhecida");
      fallbackReason = parts.join("; ");
    }
    return {
      nivel1: n1.nivel1,
      nivel2: others,
      confidence: Math.min(n1.confidence, 0.55),
      method: "others_fallback",
      reason: `${n1ReasonPrefix}; fallback "${others}" (${fallbackReason})`,
    };
  }

  // Sem fallback "Outros" disponível (improvável — todos os nivel1 da
  // taxonomia têm um) — devolve só nivel1, sem nivel2.
  return null;
}
