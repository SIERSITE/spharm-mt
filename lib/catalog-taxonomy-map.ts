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
    /** Rota de salvamento pela designação — ver ROTAS_SALVAMENTO. */
    | "designacao_rota"
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

  // ── H: Preparados hormonais sistémicos ───────────────────────────────
  H02: "Hormonas e Corticoides",          // Corticoides sistémicos (prednisolona, metilprednisolona, deflazacorte)
  H03: "Hormonas e Corticoides",          // Hormonas tiróide/antitiroideus (levotiroxina, iodeto de potássio)

  // ── J: Anti-infecciosos sistémicos ───────────────────────────────────
  J01: "Anti-infecciosos",                // Antibióticos sistémicos (amoxicilina, azitromicina, cefradina)
  J02: "Anti-infecciosos",                // Antifúngicos sistémicos (fluconazol)
  J04: "Anti-infecciosos",                // Antimicobacterianos (raros em retalho)
  J05: "Anti-infecciosos",                // Antivirais sistémicos (aciclovir)
  J06: "Outros Medicamentos",             // Imunoglobulinas (hospitalar)
  J07: "Outros Medicamentos",             // Vacinas (especiais)

  // ── M: Sistema músculo-esquelético ───────────────────────────────────
  M01: "Analgésicos e Anti-inflamatórios", // AINEs (ibuprofeno, diclofenac, naproxeno)
  M02: "Analgésicos e Anti-inflamatórios", // Tópicos articulares
  M03: "Sistema Nervoso",                 // Relaxantes musculares
  M04: "Analgésicos e Anti-inflamatórios", // Antigotosos
  M05: "Outros Medicamentos",              // Doenças ósseas (bifosfonatos) — volume pequeno, mantém-se Outros

  // ── N: Sistema nervoso ───────────────────────────────────────────────
  N01: "Outros Medicamentos",             // Anestésicos (sistémicos/hospitalares) — excepção N01BB tópico (ver ATC_PREFIX4_TO_NIVEL2)
  N02: "Analgésicos e Anti-inflamatórios", // Analgésicos (paracetamol N02BE01, opióides)
  N03: "Sistema Nervoso",                 // Antiepilépticos
  N04: "Sistema Nervoso",                 // Antiparkinsonianos
  N05: "Sistema Nervoso",                 // Psicolépticos (ansiolíticos, antipsicóticos)
  N06: "Sistema Nervoso",                 // Psicoanalépticos (antidepressivos)
  N07: "Sistema Nervoso",                 // Outros do SNC

  // ── P: Antiparasitários ──────────────────────────────────────────────
  P02: "Sistema Digestivo",               // Antihelmínticos / vermífugos (mebendazol, albendazol) — actuam no tracto digestivo

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
 * Excepções por sub-prefixo ATC mais específico que o grupo de 3 chars
 * (tipicamente 5 chars = subgrupo químico). Consultado ANTES do prefixo
 * de 3 chars — tem prioridade máxima quando uma sub-classe ATC diverge
 * da regra geral do grupo.
 *
 * Lookup: o ATC do produto é testado contra cada chave por `startsWith`
 * — ordenado pelo comprimento desc para garantir match mais específico.
 *
 * Caso de uso actual: N01BB (anestésicos locais amidas — Lidocaína,
 * Prilocaína; ex.: EMLA creme) → "Dermatológicos" porque é aplicação
 * cutânea, embora N01 sistémico continue em "Outros Medicamentos".
 */
const ATC_SUBGROUP_TO_NIVEL2: Record<string, string> = {
  N01BB: "Dermatológicos",  // Anestésicos locais — amidas (Lidocaína, Prilocaína; tipicamente cremes EMLA)
};

/** Chaves de ATC_SUBGROUP_TO_NIVEL2 ordenadas por comprimento desc (cache). */
const ATC_SUBGROUP_KEYS_SORTED = Object.keys(ATC_SUBGROUP_TO_NIVEL2).sort(
  (a, b) => b.length - a.length,
);

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
    // ── Via de administração explícita ────────────────────────────────
    // Num ERP português a designação de um medicamento é, quase sempre,
    // "marca + dosagem + forma". A forma diz a via, e a via diz a
    // categoria com mais fiabilidade do que qualquer palavra da marca:
    // "sol oft" é oftálmico independentemente da substância. Estas regras
    // vêm PRIMEIRO porque a via é um facto do produto, não uma inferência
    // sobre o que ele trata.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(col[íi]rio|sol\.?\s*(?:oft|col)\b|gel\s*oft|pom\.?\s*oft|oft[aá]lm|unguento\s+oft)/i, nivel2: "Oftálmicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(gotas\s+auricul|sol\.?\s*(?:[oó]tica|auricular)|[oó]tico\s+gotas|auricular)/i, nivel2: "Otológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(l[aá]pis\s+uretral|sol\.?\s+uretral)/i, nivel2: "Urológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([oó]vulo|creme\s+vaginal|gel\s+vaginal|comp\.?\s+vaginal|anel\s+vaginal)/i, nivel2: "Ginecológicos" },

    // ── Analgésicos e anti-inflamatórios ──────────────────────────────
    // AINEs (M01A), analgésicos (N02A/N02B), antigotosos (M04).
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ibuprofeno|paracetamol|aspirina|diclofenac|naproxeno|nimesulida|ketoprofeno|\bdor\b|analges|anti-?inflamat)/i, nivel2: "Analgésicos e Anti-inflamatórios" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(etoricoxib|celecoxib|meloxicam|piroxicam|indometacina|aceclofenac|dexcetoprofeno|dexibuprofeno|flurbiprofeno|ac?[ií]clofenac|etofenamato|tenoxicam|lornoxicam)/i, nivel2: "Analgésicos e Anti-inflamatórios" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(tramadol|fentanilo|buprenorfina|tapentadol|code[ií]na|morfina|oxicodona|hidromorfona|metamizol|tiaprofenico)/i, nivel2: "Analgésicos e Anti-inflamatórios" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(alopurinol|zyloric|colchicina|febuxostat)/i, nivel2: "Analgésicos e Anti-inflamatórios" },
    // Antienxaqueca (N02C) — a taxonomia não tem categoria própria; a dor
    // é o que o produto trata.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(sumatriptano|zolmitriptano|rizatriptano|naratriptano|eletriptano|almotriptano|enxaqueca)/i, nivel2: "Analgésicos e Anti-inflamatórios" },

    // ── Constipação, tosse e gripe ────────────────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(constipa|tosse|gripe|expectorante|xarope|mucolit|descongestion)/i, nivel2: "Constipação, Tosse e Gripe" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(acetilciste[ií]na|ambroxol|carbociste[ií]na|bromexina|dextrometorfano|butamirato|oxolamina|levodropropizina|cloperastina|guaifenesina)/i, nivel2: "Constipação, Tosse e Gripe" },
    // Vias nasais (R01) e garganta (R02): pastilhas e sprays de garganta.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(sol\.?\s*nasal|spray\s+nasal|pulv\.?\s+nasal|gotas\s+nasais|xilometazolina|oximetazolina|nafazolina|fenilefrina)/i, nivel2: "Constipação, Tosse e Gripe" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(benzidamina|tantum\s+verde|clorexidina\s+pastilh|ambazona|flurbiprofeno\s+pastilh|garganta)/i, nivel2: "Constipação, Tosse e Gripe" },

    // ── Alergias (R06) ────────────────────────────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(alergia|anti-?histam|loratadina|cetiriz|desloratadina|bilastina|fexofenadina)/i, nivel2: "Alergias" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ebastina|rupatadina|levocetirizina|mizolastina|dimetindeno|clemastina|ciproheptadina|hidroxizina|cetotifeno)/i, nivel2: "Alergias" },

    // ── Sistema digestivo ─────────────────────────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(digest|est[oô]mago|azia|laxant|laxoberal|agiolax|psyllium|plantago|sennosid|sen[oa]si|obstipa|diarre|naus|omeprazol|pantoprazol|esomeprazol|ranitid|domperid|metoclop|loperam)/i, nivel2: "Sistema Digestivo" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(lansoprazol|rabeprazol|sucralfato|alginato|gaviscon|mesalazina|sulfassalazina|bisacodilo|lactulose|macrogol|picossulfato|simeticone|dimeticone|trimebutina|otilonio|mebeverina|butilescopolamina|racecadotril|ondansetrom|ondansetron|alizaprida|bromoprida)/i, nivel2: "Sistema Digestivo" },
    // Antihelmínticos (P02) — actuam no tracto digestivo.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(mebendazol|albendazol|pamoato\s+de\s+pirantel|verm[ií]fugo)/i, nivel2: "Sistema Digestivo" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(supo?s(?:it[oó]rio)?s?\s+de\s+glicerina|glicerina\s+supo)/i, nivel2: "Sistema Digestivo" },

    // ── Sistema nervoso ───────────────────────────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ansied|sedat|antidepress|diazepam|alprazolam|lorazepam|sertralina|fluoxetina|escitalopram|zolpidem|amitriptil)/i, nivel2: "Sistema Nervoso" },
    // Antipsicóticos e antidepressivos (N05A/N06A)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(quetiapina|olanzapina|risperidona|aripiprazol|paliperidona|amissulprida|clozapina|haloperidol|sulpirida|tiaprida|flupentixol|zuclopentixol|levomepromazina)/i, nivel2: "Sistema Nervoso" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(mirtazapina|venlafaxina|duloxetina|paroxetina|citalopram|trazodona|bupropiom|bupropiona|vortioxetina|agomelatina|clomipramina|nortriptilina|imipramina|reboxetina|tianeptina)/i, nivel2: "Sistema Nervoso" },
    // Antiepilépticos (N03) e antiparkinsónicos (N04)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(pregabalina|gabapentina|levetiracetam|topiramato|lamotrigina|carbamazepina|oxcarbazepina|valproato|valpr[oó]ico|fenito[ií]na|fenobarbital|zonisamida|lacosamida|etossuximida|brivaracetam|perampanel)/i, nivel2: "Sistema Nervoso" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(levodopa|carbidopa|pramipexol|ropinirol|rotigotina|rasagilina|selegilina|entacapona|amantadina|biperideno|trihexifenidilo)/i, nivel2: "Sistema Nervoso" },
    // Antidemenciais (N06D)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(donepezilo|memantina|rivastigmina|galantamina)/i, nivel2: "Sistema Nervoso" },
    // Benzodiazepinas, hipnóticos e ansiolíticos restantes (N05B/N05C)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(bromazepam|clobazam|clonazepam|midazolam|temazepam|loprazolam|flurazepam|estazolam|oxazepam|cloraze[pt]|mexazolam|etizolam|zopiclona|zaleplona|buspirona|hidroxizina\s+ans)/i, nivel2: "Sistema Nervoso" },
    // Psicoestimulantes (N06B) e relaxantes musculares (M03)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(metilfenidato|lisdexanfetamina|atomoxetina|modafinil)/i, nivel2: "Sistema Nervoso" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(tizanidina|baclofeno|tiocolquic[oó]sido|ciclobenzaprina|relaxante\s+muscul)/i, nivel2: "Sistema Nervoso" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(betaistina|betahistina|vertigem|sulbutiamina|piracetam|nicergolina|vinpocetina)/i, nivel2: "Sistema Nervoso" },

    // ── Cardiovascular ────────────────────────────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(hipertens|colesterol|cardiaco|enalapril|losartan|amlodipina|atorvastatina|sinvastatina|valsartan|bisoprolol|carvedilol|ramipril|perindopril|nebivolol|furosemid)/i, nivel2: "Cardiovascular" },
    // ARA-II e IECA restantes
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(irbesartan|olmesarta|candesartan|telmisartan|eprosartan|azilsartan|medoxomilo|lisinopril|captopril|zofenopril|quinapril|trandolapril|fosinopril|cilazapril|imidapril|sacubitril)/i, nivel2: "Cardiovascular" },
    // Diuréticos, bloqueadores de cálcio, beta-bloqueantes
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(hidroclorotiazida|clortalidona|indapamida|torasemida|espironolactona|eplerenona|amilorida|xipamida)/i, nivel2: "Cardiovascular" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(lercanidipina|lacidipina|nifedipina|felodipina|nitrendipina|barnidipina|manidipina|diltiazem|verapamil)/i, nivel2: "Cardiovascular" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(atenolol|metoprolol|propranolol|sotalol|labetalol|celiprolol)/i, nivel2: "Cardiovascular" },
    // Estatinas e restantes hipolipemiantes (C10)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(rosuvastatina|pravastatina|pitavastatina|fluvastatina|lovastatina|ezetimiba|fenofibrato|gemfibrozil|bezafibrato|alirocumab|evolocumab|[aá]cido\s+nicot[ií]nico)/i, nivel2: "Cardiovascular" },
    // Antitrombóticos (B01)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(rivaroxabano|apixabano|edoxabano|dabigatrano|clopidogrel|ticagrelor|prasugrel|varfarina|acenocumarol|enoxaparina|dalteparina|tinzaparina|cilostazol|pentoxifilina|dipiridamol|triflusal)/i, nivel2: "Cardiovascular" },
    // Antiarrítmicos, antianginosos e outros (C01)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ivabradina|trimetazidina|ranolazina|digoxina|amiodarona|dronedarona|flecainida|propafenona|isossorbida|nitroglicerina|moxonidina|doxazosina|urapidil|aliscireno)/i, nivel2: "Cardiovascular" },
    // Venotónicos e vasoprotectores (C05C)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(diosmina|hesperidina|troxerrutina|rutosido|dobesilato|escina|venoton|pernas\s+(?:cansadas|leves)|insufici[eê]ncia\s+venosa)/i, nivel2: "Cardiovascular" },

    // ── Diabetes ──────────────────────────────────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(diabet|metformina|insulina|glicemia|gliclazida|sitagliptina|empagliflozina|dapagliflozina)/i, nivel2: "Diabetes" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(glimepirida|glibenclamida|vildagliptina|linagliptina|saxagliptina|alogliptina|canagliflozina|ertugliflozina|repaglinida|pioglitazona|acarbose|liraglutido|semaglutido|dulaglutido|exenatido|glargina|degludec|lispro|asp[aá]rtico|glulisina)/i, nivel2: "Diabetes" },

    // ── Dermatológicos ────────────────────────────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(dermatolog|psor[ií]ase|eczema|micose|antif[uú]ngico|hidrocortisona|betametasona|mupirocina)/i, nivel2: "Dermatológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(mometasona|clobetasol|metilprednisolona\s+acepon|fluocinolona|fluticasona\s+cut|prednicarbato|desonida|calcipotriol)/i, nivel2: "Dermatológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(terbinafina|clotrimazol|cetoconazol|miconazol|bifonazol|isoconazol|sertaconazol|tioconazol|ciclopirox|amorolfina|griseofulvina|nistatina)/i, nivel2: "Dermatológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(adapaleno|isotretino[ií]na|per[oó]xido\s+de\s+benzo[ií]lo|tretino[ií]na|azel[aá]ico|clindamicina\s+t[oó]pic)/i, nivel2: "Dermatológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([aá]cido\s+fus[ií]dico|neomicina|bacitracina|gentamicina\s+cut|sulfadiazina\s+de\s+prata|imiquimode|podofilotoxina|tacrolimus\s+pom|pimecrolimus)/i, nivel2: "Dermatológicos" },
    // Pediculicidas e escabicidas (P03) — tratamento cutâneo.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(permetrina|malati[aã]o|dimeticona\s+piolh|piolhos?|l[êe]ndeas?|pediculos|sarna|escabiose)/i, nivel2: "Dermatológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(minoxidil|finasterida\s+1\s*mg|alopecia)/i, nivel2: "Dermatológicos" },

    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(oft[aá]lm|colir|gotas? oculares?|olho seco)/i, nivel2: "Oftálmicos" },
    // Antiglaucomatosos e oftálmicos tópicos (S01)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(latanoprosta|bimatoprosta|travoprosta|tafluprosta|dorzolamida|brinzolamida|brimonidina|timolol\s+oft|olopatadina|epinastina|hipromelose|carb[oó]mero|hialuronato\s+de\s+s[oó]dio\s+oft|ciclosporina\s+oft)/i, nivel2: "Oftálmicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ouvid|[oó]tic|otologic|otite)/i, nivel2: "Otológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ginec|vagin|menstru|climat[eé]|anticoncep|p[ií]lula)/i, nivel2: "Ginecológicos" },
    // Contraceptivos e hormonas sexuais femininas (G03)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(etinilestradiol|levonorgestrel|desogestrel|drospirenona|dienogeste|gestodeno|norgestimato|noretisterona|estradiol|progesterona|dienogest|ulipristal|clormadinona|tibolona|promestrieno)/i, nivel2: "Ginecológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(urol[oó]g|prost|cistite|infec[cç][aã]o urin[aá]ria|tansul|finasterid)/i, nivel2: "Urológicos" },
    // Disfunção eréctil (G04BE), bexiga hiperactiva (G04BD), BPH (G04C)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(sildenafil|tadalafil|vardenafil|avanafil|alprostadil)/i, nivel2: "Urológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(solifenacina|tolterodina|fesoterodina|oxibutinina|mirabegron|tr[oó]spio|dari?fenacina)/i, nivel2: "Urológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(dutasterida|alfuzosina|silodosina|terazosina|serenoa|nitrofuranto[ií]na|fosfomicina)/i, nivel2: "Urológicos" },

    // ── Respiratório ──────────────────────────────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(respir|asma|bronco|salbutamol|budesonida|fluticasona|formoterol|inalador)/i, nivel2: "Respiratório" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(montelucaste|tiotr[oó]pio|indacaterol|olodaterol|umeclid[íi]nio|glicopirr[oó]nio|aclid[íi]nio|vilanterol|beclometasona|ciclesonida|teofilina|roflumilaste|salmeterol|terbutalina|ipratr[oó]pio)/i, nivel2: "Respiratório" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(susp\.?\s+press.*inala|p[oó]\s+(?:para\s+)?inala|sol\.?\s+(?:para\s+)?inala)/i, nivel2: "Respiratório" },

    // ── Anti-infecciosos sistémicos (J) ───────────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(amoxicilina|flucloxacilina|ampicilina|penicilina|cefuroxima|cefixima|cefradina|cefaclor|ceftriaxona|cefalexina)/i, nivel2: "Anti-infecciosos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ciprofloxacina|levofloxacina|norfloxacina|moxifloxacina|ofloxacina|azitromicina|claritromicina|eritromicina|doxiciclina|minociclina|tetraciclina|clindamicina|metronidazol|sulfametoxazol|trimetoprim|rifampicina|linezolida|vancomicina|nitrofuranto)/i, nivel2: "Anti-infecciosos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(fluconazol|itraconazol|voriconazol|posaconazol|antibi[oó]tic)/i, nivel2: "Anti-infecciosos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(aciclovir|valaciclovir|famciclovir|oseltamivir|ribavirina|antiviral)/i, nivel2: "Anti-infecciosos" },

    // ── Hormonas e corticoides sistémicos (H) ─────────────────────────
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(levotiroxina|liotironina|tiamazol|propiltiouracilo|iodeto\s+de\s+pot[aá]ssio)/i, nivel2: "Hormonas e Corticoides" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(deflazacorte|prednisolona|prednisona|metilprednisolona|dexametasona|betametasona\s+(?:comp|inj)|hidrocortisona\s+(?:comp|inj)|corticoide)/i, nivel2: "Hormonas e Corticoides" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(testosterona|somatropina|desmopressina|cabergolina|bromocriptina)/i, nivel2: "Hormonas e Corticoides" },

    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(antiss?[eé]tico|desinfet|clorhex|betadine|iodopovid|[áa]lcool et[ií]lico)/i, nivel2: "Antisséticos e Desinfetantes" },

    // ── Marcas de balcão ──────────────────────────────────────────────
    // Último recurso, depois de todas as regras por substância e por via.
    // Uma marca não diz por si o que o produto trata — mas estas são
    // monocomponente e estáveis há décadas no mercado português, e a
    // alternativa para elas é o balde "Outros Medicamentos". Lista curta
    // e explícita: se uma marca não estiver aqui, o produto fica no
    // fallback, que é o resultado honesto.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(nicotina|niquitin|nicorette|nicotinell)/i, nivel2: "Sistema Nervoso" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(valdispert|passival|sedivitax|calmante\s+natur)/i, nivel2: "Sistema Nervoso" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(brufen|nurofen|panadol|panasorbe|ben-?u-?ron|ib-?u-?ron|migraspirina|aspegic|voltaren|flector|exxiv|dolenio|maxilase|tantum)/i, nivel2: "Analgésicos e Anti-inflamatórios" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(vicks|bisolduo|bisolvon|arkovox|coryzalia|strepfen|c[eê]gripe|antigrippine|griponal)/i, nivel2: "Constipação, Tosse e Gripe" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(gasec|ogasto|salofalk|citrafleet|dulcolax|microlax|imodium|buscopan|aero-?om|gaviscon)/i, nivel2: "Sistema Digestivo" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(eutirox|letrox|dexamethasone|medrol)/i, nivel2: "Hormonas e Corticoides" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(lovenox|innohep|clexane|fragmin|sintrom|plavix|ticlopidina)/i, nivel2: "Cardiovascular" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(humalog|novorapid|lantus|toujeo|tresiba|novomix|ryzodeg|abasaglar|accu-?chek|freestyle)/i, nivel2: "Diabetes" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(dermestril|estradot|bemfola|ovaleap|gonal|utrogestan|activelle)/i, nivel2: "Ginecológicos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ziprasidona|zeldox|ludiomil|dormonoct|rivotril|akineton)/i, nivel2: "Sistema Nervoso" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(oftacilox|vidisic|physioglau|ialuvit)/i, nivel2: "Oftálmicos" },
  ],
  "SUPLEMENTOS ALIMENTARES": [
    // Específicos antes dos genéricos: a frase "Estimulantes e Energizantes"
    // tem prioridade sobre o pattern de Vitaminas (que apanharia "Vitacell"
    // via /vit ?[abcde]/). Hepa/fígado idem antes de "Vitaminas".
    // Sono/Ansiedade tem que vencer "vitamin" também (gomas relax podem
    // mencionar vitaminas).
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ansiedade,?\s+stress|dist[uú]rbios?\s+(?:do|de)\s+sono|sono\s+kids|relax(?:ant)?\s+gomas|sono|dormir|relax|melaton|valer[ií]ana|passiflora|tilia)/i, nivel2: "Sono e Relaxamento" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(estimulantes?\s+e?\s+energizantes?|energ[ií]z|energ[ií]tic|\benerg|vitali|fadiga|cansa[cç]o|ginseng|cafe[ií]na|guaran[aá]|maca)/i, nivel2: "Energia e Vitalidade" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(probi[oó]t|pr[eé]bi[oó]t|transito|intest|lactobac|bifid|h?epat(?:o|ic)|f[ií]gado|digest|easylax|laxat[a-z]*|tr[aâ]nsit\w*\s+intest|trato\s+(?:digestivo|intestinal)|sa[uú]de\s+e\s+bem.?estar)/i, nivel2: "Digestão e Probióticos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(imun|defesa|resist[eê]ncia|equin[aá]cea|pr[oó]polis)/i, nivel2: "Imunidade" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([ií]ntima|vaginal|cranberry|ar[aâ]ndano|menopausa|climat[eé]rio|sa[uú]de\s+feminina|genipausa|afax)/i, nivel2: "Saúde Íntima" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(vitamin|multivit|vit ?[abcde]|\bb\d{1,2}\b|complexo b|magn[eé]sio|c[aá]lcio|zinco|ferro|mineral|pot[aá]ssio|i[oó]do|sel[eé]nio)/i, nivel2: "Vitaminas e Minerais" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(mem[oó]ria|concentra|cogni|ginkgo|bacopa)/i, nivel2: "Memória e Concentração" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(articul|osso|col[aá]geno|glucosam|condroit|msm|cartilag)/i, nivel2: "Articulações e Ossos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(cabelo|pele|unhas|biotina|queda|queratina|ecophane|cystiphane|lambdapil|phytophanere)/i, nivel2: "Cabelo, Pele e Unhas" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(peso|emagrec|queimador|saciant|drenant|adelga[cç]|depuralina|easyslim|kcal\s+blo|bloqueador\s+(?:de\s+)?(?:gordura|hidratos)|ventre\s+liso|minc)/i, nivel2: "Controlo de Peso" },
    // Fibra e psyllium são trânsito intestinal, não "outros".
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(psyllium|fibra|ispagula|plantago|linha[cç]a|inulina)/i, nivel2: "Digestão e Probióticos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(geleia\s+real|pr[oó]polis|equin[aá]cea|sabugueiro|shiitake|beta.?glucano)/i, nivel2: "Imunidade" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(omega|[oó]mega|epa\b|dha\b|[oó]leo\s+de\s+peixe|krill|onagra|borragem|lecitina)/i, nivel2: "Outros Suplementos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(coenzima\s*q10|\bq10\b|resveratrol|astaxantina|lute[ií]na|licopeno|beta.?caroteno|antioxidante|[aá]cido\s+alfa.?lipoico)/i, nivel2: "Outros Suplementos" },
  ],
  "DERMOCOSMÉTICA": [
    // O ERP abrevia quase tudo: "Cr Dia", "Lt Corp", "Ps" (pele seca),
    // "Pnm" (pele normal a mista). As regras específicas vêm antes das
    // genéricas — "anti-rugas creme de rosto" é anti-envelhecimento, não
    // "Rosto".
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(anti-?enve|anti-?idade|anti-?rugas?|antirrugas?|lift|firmeza|rugas?|redensif|neovadiol|liftactiv|redermic|hyalu|[aá]cido\s+hialur[oó]nico|retinol|colag[eé]nio\s+cr|antiage|filler|premium|physiolift|norelift)/i, nivel2: "Anti-envelhecimento" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(at[oó]pic|sens[ií]vel|sensibilidade|eczema|atoderm|lipikar|toleriane|sensibio|cicaplast|cicalfate|xemose|trixera|exomega|dexeryl|barrial|calmante|irritada)/i, nivel2: "Pele Sensível / Atópica" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(acne|oleosa|ole[oó]sa|espinhas?|imperfei[cç][oõ]es|comed[oó]n|effaclar|hyseac|cleanance|sebiaclear|keracnyl|sebum|seborr|mista)/i, nivel2: "Acne e Pele Oleosa" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(despigment|manchas?|clareador|whitening|pigmentclar|melascreen|depiwhite|antimanchas)/i, nivel2: "Despigmentantes" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(limpeza|demaquil|desmaquil|gel de limpeza|tonic|micelar|moussant|espuma\s+limp|[aá]gua\s+micel|limp\b|cleans)/i, nivel2: "Limpeza" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(hidrat|hydra|moistur|creme hidrat|nutritiv|nutrit|emolient|pele\s+seca|p\.?\s?seca\b|ur[eé]ia|\burea\b|cr\.?\s+gordo)/i, nivel2: "Hidratação" },
    // "Cr Dia" / "Cr Noite" / "Cr Facial" / "Serum" — cuidado de rosto.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(rosto|facial|serum|s[eé]rum|contorno\s+(?:dos\s+)?olhos|cont\.?\s*olh|cr\.?\s*dia|cr\.?\s*noite|creme\s+de\s+(?:dia|noite)|emul(?:s[aã]o)?\s+(?:dia|noite)|olhos\b|eye\b|l[aá]bial|l[aá]bios|labios|stick\s+lab|masc\.?\s+(?:facial|rosto|ilumin)|m[aá]scara\s+(?:facial|ilumin))/i, nivel2: "Rosto" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(corpo|body|corpor|lt\.?\s*corp|leite\s+corp|lo[cç][aã]o\s+corp|b[aá]lsamo\s+corp|estrias|celulite|anticelul|reafirm|redut(?:or)?\b|firmez)/i, nivel2: "Corpo" },
    // `(?![a-z])` e não `\b`: o ERP cola a medida à palavra ("Cr Maos75"),
    // e `\b` não casa entre "s" e "7". Mas sem lookahead nenhum, "pes"
    // apanhava "Pessego", "Pescoço" e "PEsp" — três falsos positivos
    // reais deste catálogo. Termina a palavra sem exigir fim de token.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(m[aã]os?(?![a-z])|p[eé]s(?![a-z])|feet|hand|podolog|calos?(?![a-z])|joanete|unhas?(?![a-z])|fissuras|gretas|akileine|footlogix|scholl|excilor)/i, nivel2: "Mãos e Pés" },
  ],
  "HIGIENE CORPORAL": [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(gel de banho|gel de duche|duche|banho|shower gel|body wash|gel\s+lavante|surgras|lavante|syndet)/i, nivel2: "Banho e Duche" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(desodor|anti[\s-]?transpir|deodor|\bdeo\b|roll-?on|stick\s+deo)/i, nivel2: "Desodorizantes" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([ií]ntim|higiene [ií]ntima|lactacyd|saugella|cumlaude|vulvar|hig\.?\s*int)/i, nivel2: "Higiene Íntima" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(sabonete|sab[aã]o|pain\s+dermato)/i, nivel2: "Sabonetes" },
  ],
  "HIGIENE ORAL": [
    // "Past Dent", "Pst Dent", "Pasta Dentifrica" — o ERP abrevia.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(pasta.*dent|past\.?\s*dent|pst\.?\s*dent|dentifr|dent[ií]fric|colgate|sensodyne|elmex|parodontax|fluocaril|kukident)/i, nivel2: "Pastas Dentífricas" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(escova.*dent|toothbrush|esc\.?\s*dent|escovilh[aã]o|interdent)/i, nivel2: "Escovas de Dentes" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(elixir|bochecho|mouthwash|listerine|eludril|colut[oó]rio|colut\b|enxaguante)/i, nivel2: "Elixires" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(fio dent|dental floss|fita\s+dent)/i, nivel2: "Fio Dentário" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(pr[oó]tese|dentadura|corega|fixador\s+prot)/i, nivel2: "Próteses Dentárias" },
  ],
  CAPILAR: [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(anti-?caspa|anticaspa|head.*shoulders|caspa|kelual|selegel|dercaps)/i, nivel2: "Anti-caspa" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(queda|minoxidil|anti-?queda|qued\b|anacaps|neoptide|triphasic|densifiq)/i, nivel2: "Queda de Cabelo" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(colora[cç][aã]o|tinta|tint.*capilar|phytocolor|vitaliacolor|louro|castanho\s+n|coloring)/i, nivel2: "Coloração" },
    // "Ch" e "Sh" são as abreviaturas de champô/shampoo em todo o ERP
    // ("Klorane Capilar Ch Centaureas 400ml"). Só por token exacto — como
    // substring apanhariam metade do catálogo.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(champ[oô]|shampoo|ch\s|sh\s|\bch$|\bsh$)/i, nivel2: "Champôs" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(condicion|amaciador|conditioner|acondic|bals(?:amo)?\s+capil|desembara[cç])/i, nivel2: "Condicionadores" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(m[aá]scara.*cabelo|tratamento.*capilar|hair mask|masc\.?\s*capil|capilar|s[eé]rum\s+capil|lo[cç][aã]o\s+capil)/i, nivel2: "Máscaras e Tratamentos" },
  ],
  "PUERICULTURA E BEBÉ": [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(fralda|diaper|toalhit)/i, nivel2: "Fraldas e Toalhitas" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(aptamil|leite.*beb|leite.*(?:lactente|cresciment|infant)|f[oó]rmula\s+infant|papa|nan\s+(?:hm|optipro|sensit)|hipp\b|holle\b)/i, nivel2: "Alimentação do Bebé" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(chupeta|bibera|biber[aã]o|tetina)/i, nivel2: "Chupetas e Biberões" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(at[oó]pic.*beb|beb.*at[oó]pic|exomega|trixera)/i, nivel2: "Pele Atópica do Bebé" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(higiene.*beb|beb.*higiene|gel\s+(?:de\s+)?banho|banho\s+calmant|champ[oô].*beb)/i, nivel2: "Higiene do Bebé" },
    // Brinquedos / acessórios não-alimentares de puericultura. Catch-all
    // para Chicco, brinquedos cavalgáveis, peluches, etc.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(chicco|brinquedos?|cavalg[aá]vel|peluche|cavalinho\s+saltit|carrinho\s+(?:de\s+)?(?:gelados?|brinquedo))/i, nivel2: "Acessórios de Bebé" },
    // Acessórios não-alimentares que o ERP não nomeia como "bebé" mas que
    // só existem na gama infantil: tesouras de pontas redondas, kits de
    // manicure, sacos de água, termómetros de banho, escovas.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(tesoura|corta.?unhas|kit\s+manicure|lima\b|escova\s+(?:de\s+)?cabelo|saco\s+(?:de\s+)?[aá]gua|termometro\s+banho|mordedor|babete|porta.?chupeta|cadeira|espreguica|banheira|redutor)/i, nivel2: "Acessórios de Bebé" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(extrator\s+(?:de\s+)?leite|bomba\s+(?:tira.?)?leite|disco\s+absorv|concha\s+mamil)/i, nivel2: "Acessórios de Bebé" },
  ],
  "MÃE E GRAVIDEZ": [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(gravid|gestant|pr[eé]-?natal)/i, nivel2: "Gravidez" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(p[oó]s-?parto|postparto)/i, nivel2: "Pós-parto" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(amament|extrator.*leite|lactation)/i, nivel2: "Amamentação" },
  ],
  "PROTEÇÃO SOLAR": [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(solar.*crian|kids|infantil.*solar)/i, nivel2: "Solar Criança" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(p[oó]s-?solar|after.?sun)/i, nivel2: "Pós-solar" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(autobronz|self.?tan)/i, nivel2: "Autobronzeador" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(solar|spf|fps|protetor.*solar|sunscreen)/i, nivel2: "Solar Adulto" },
  ],
  "DISPOSITIVOS MÉDICOS": [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(glic[eé]m|glucometro|teste.*diabet|glucose|tiras?\s+glicemi|contour\s+next|ascencia)/i, nivel2: "Glicemia e Diabetes" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(tens[aã]o|tensi[oó]metro|blood pressure|esfigmoman[oó])/i, nivel2: "Tensão Arterial" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(term[oó]metro|thermometer)/i, nivel2: "Termómetros" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(nebuliz|aeross?ol)/i, nivel2: "Nebulizadores" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(curativo|compressa|penso|gaze|adesivo|ades\b|soffix|ligadura|lig\b|algod[aã]o|band-?aid)/i, nivel2: "Material de Curativo" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(imobiliz|tala|gesso|ortotese|ort[oó]tese)/i, nivel2: "Material de Imobilização" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(teste\s+(?:gravidez|fertili|ovula)|teste|monitoriz|ox[ií]metro|saturac|autotest|\btira\b|tiras\b)/i, nivel2: "Testes e Monitorização" },
  ],
  COSMÉTICA: [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(verniz|nailvarnish|nail\s+(?:polish|art)|esmalte|acetona|removedor\s+verniz)/i, nivel2: "Maquilhagem" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(maquilh|makeup|make.?up|batom|lip\s*(?:gloss|stick)|rimel|rimmel|m[aá]scara\s+(?:de\s+)?pestanas|corretor|sombra|blush|p[oó]\s+(?:compact|solto|medium|matte)|eyeliner|delineador|base\s+(?:fluida|cobertura))/i, nivel2: "Maquilhagem" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(desmaquil|demaquil|remove makeup|bifasico\s+olhos)/i, nivel2: "Desmaquilhantes" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(perfume|eau de|eau\s+d[eo]|\bedt\b|\bedp\b|fragr[aâ]nc|parfum|colonia|col[oó]nia)/i, nivel2: "Perfumes" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(pin[cç]a|espelho|esponja|pincel|escova\s+(?:de\s+)?cabelo|lima\s+(?:de\s+)?unhas|corta.?unhas|alicate|rolos?\s+cabelo|elast[ií]cos?\s+cabelo|gancho)/i, nivel2: "Acessórios de Beleza" },
  ],
  ORTOPEDIA: [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(joelheira|knee|joelho\s+elast)/i, nivel2: "Joelheiras" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(tornozeleira|ankle)/i, nivel2: "Tornozeleiras" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(cinta|faixa lombar|lumbar|colar\s+cervical|cervical|abdominal|hern[ií]|suspens[oó]rio)/i, nivel2: "Cintas e Faixas" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(punho|cotoveleira|elbow|wrist|cotov|munhequeira)/i, nivel2: "Punhos e Cotoveleiras" },
    // Protecção plantar e digital: joanetes, calos, dedeiras, esporão.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(palmilha|insole|almof\.?\s*plantar|plantar|joanete|dedeira|salvadedos|separador|calcanhar|esporao|espor[aã]o|epitact|halux)/i, nivel2: "Palmilhas" },
    // "Segreta", "Stay Up", "Collant Af" — gama de compressão médica Ibici.
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(meia.*compress|compression stocking|meias?\s+(?:elast|descans)|collant|stay\s*up|segreta|varizes|\bjuzo\b|mediven)/i, nivel2: "Meias de Compressão" },
  ],
  "SAÚDE SEXUAL": [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(preservativo|condom)/i, nivel2: "Preservativos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(lubrificante|lubricant)/i, nivel2: "Lubrificantes" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(teste.*gravidez|test.*pregnan|teste.*fertil)/i, nivel2: "Testes" },
  ],
  "PRIMEIROS SOCORROS": [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(penso|compressa)/i, nivel2: "Pensos e Compressas" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ligadura|bandage)/i, nivel2: "Ligaduras" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(antiss?[eé]ptico|iodopovid|betadine)/i, nivel2: "Antissépticos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(trat.*ferida|cicatriz)/i, nivel2: "Tratamento de Feridas" },
  ],
  "MATERIAL CLÍNICO E CONSUMÍVEIS": [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(seringa|agulha|syringe|needle)/i, nivel2: "Seringas e Agulhas" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(luva|glove)/i, nivel2: "Luvas" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(m[aá]scara cir[uú]rg|m[aá]scara ffp|surgical mask)/i, nivel2: "Máscaras" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([aá]gua\s+destilada|[aá]lcool\s+(?:isopr[oó]p|et[ií]lico)|antiss?[eé]ptic|desinfetant|consum[ií]vel)/i, nivel2: "Consumíveis Clínicos" },
  ],
  "SAÚDE NATURAL": [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(fitoter|ervan[aá]rio|planta medicinal)/i, nivel2: "Fitoterapia" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(homeo|homeopatia|boiron|apis\s+mellif|nux\s+vomic|arnica\s+\d+ch|gr[aâ]nul[oa]s?\s+\d+ch|\d+\s*ch\s+(?:gran|comp|dilui))/i, nivel2: "Homeopatia" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(floral|flores de bach)/i, nivel2: "Florais" },
  ],
  VETERINÁRIA: [
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(c[aã]o|dog|canino)/i, nivel2: "Cães" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(gato|cat|felino)/i, nivel2: "Gatos" },
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(desparas|antiparas.*animal|frontline|bravecto)/i, nivel2: "Desparasitação" },
  ],
  "SERVIÇOS E ARTIGOS NÃO COMERCIALIZÁVEIS": [
    // Vacinas, consultas, atos clínicos (incluindo administrações SNS).
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(administra[cç][aã]o\s+vacina|vacina\s+(?:covid|gripe|sns|tetan|pneumoc|hpv)|consult[aá]\s+(?:enfermag|farmac[eê]ut)|servi[cç]o\s+cl[ií]nic)/i, nivel2: "Serviço Clínico" },
    // Taxas SNS / atos administrativos
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(taxa\s+(?:moderadora|sns)|tax|servi[cç]o\s+sns|reembolso)/i, nivel2: "Taxas e Atos" },
    // Operações administrativas
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(administra[cç][aã]o\b(?!.*vacina)|expedient|acto\s+administra)/i, nivel2: "Administração" },
    // Artigos internos / não-vendáveis (sacos, etiquetas, papelaria farmácia)
    { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(saco\s+(?:plast|farm)|etiquet|papel(?:aria)?\s+farma|artig[oa]s?\s+intern|n[aã]o[\s-]?vend[aá]vel)/i, nivel2: "Artigos Internos" },
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

// ─── Rotas de salvamento (designação → nivel1 + nivel2) ──────────────────────
//
// PORQUÊ ISTO EXISTE
//
// O nível 1 é decidido pelo `productType`, e o nível 2 só é procurado
// dentro desse nível 1. Um champô classificado como DERMOCOSMETICA nunca
// encontra "Champôs", porque essa subcategoria vive em CAPILAR. O produto
// acabava em "Outros Dermocosmética" — um balde com 2 747 artigos, que ao
// balcão não vale mais do que não ter categoria nenhuma.
//
// Estas rotas ligam uma designação inequívoca directamente ao par
// (nivel1, nivel2) certo, atravessando a fronteira do productType.
//
// QUANDO CORREM — e só então
//   · o mapeamento principal ia devolver "Outros <X>" (fallback), ou
//   · não havia nível 1 nenhum (produto por classificar).
//
// Uma classificação ESPECÍFICA já obtida por ATC, DCI ou keyword nunca
// chega aqui. É esta condição de entrada, e não a redacção de cada
// padrão, que garante que o salvamento não degrada nada: no pior caso
// troca um balde por outro balde.
//
// CRITÉRIO PARA ENTRAR NA TABELA
// O padrão tem de identificar o produto por si só, sem contexto. "champô"
// entra; "gel" e "spray" não — dizem a forma, não o que o produto é.
// Primeira rota que casa ganha, por isso a ordem é do mais específico
// para o mais geral.

type RotaSalvamento = { pattern: RegExp; nivel1: string; nivel2: string };

const ROTAS_SALVAMENTO: RotaSalvamento[] = [
  // ── Código de família do fornecedor de puericultura ───────────────────
  // 480 artigos deste catálogo começam por "Ch.<Familia><código>"
  // ("Ch.Chu74915310000 Physio Comf Neut Sil 12m+"). É o código de
  // família de um único fornecedor de puericultura — verificado: dos que
  // já tinham categoria, a esmagadora maioria estava em PUERICULTURA E
  // BEBÉ, e os restantes eram artigos de bebé que as regras genéricas
  // apanharam pelo substantivo ("copo", "óculos", "tesoura") e mandaram
  // para o sítio errado.
  //
  // Fica em primeiro lugar de propósito: o código de família é mais
  // fiável do que qualquer palavra da designação que venha a seguir.
  { pattern: /^ch\.\s*(?:chu|bib|tet|phys)/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Chupetas e Biberões" },
  { pattern: /^ch\.\s*(?:ali|colh|maa)/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Alimentação do Bebé" },
  { pattern: /^ch\.\s*(?:hig|crem|ora|ban)/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Higiene do Bebé" },
  { pattern: /^ch\.\s*[a-z]{2,4}\d/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Acessórios de Bebé" },

  // ── Proteção solar ────────────────────────────────────────────────────
  // "Spf50", "Fps 30", "Fotoprot", e as gamas solares por nome.
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(p[oó]s[\s.-]?sol|after.?sun|ap(?:res)?[\s.-]?sol)/i, nivel1: "PROTEÇÃO SOLAR", nivel2: "Pós-solar" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(autobronz|self.?tan|bronzead)/i, nivel1: "PROTEÇÃO SOLAR", nivel2: "Autobronzeador" },
  // Só solar E infantil na mesma designação. Sem a segunda condição isto
  // apanhava todos os SPF do catálogo e enchia "Solar Criança" com gama
  // de adulto.
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(?:kids?|crian[cç]a|infantil|pedi[aá]tric|beb[eé]).{0,25}\b(?:spf|fps|solar|fotoprot)|\b(?:spf|fps|solar|fotoprot).{0,25}\b(?:kids?|crian[cç]a|infantil|pedi[aá]tric)/i, nivel1: "PROTEÇÃO SOLAR", nivel2: "Solar Criança" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(spf|fps|fp)\s*\d+|fotoprot|photoderm|anthelios|sun\s?secure|sunface|piz\s+buin|heliocare|capital\s+soleil|protetor\s+solar|prote[cç][aã]o\s+solar|sunscreen/i, nivel1: "PROTEÇÃO SOLAR", nivel2: "Solar Adulto" },

  // ── Higiene oral ──────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(colut[oó]rio|colut\b|elixir\s+(?:bucal|oral)|bochecho|mouthwash|listerine|eludril|bexident)/i, nivel1: "HIGIENE ORAL", nivel2: "Elixires" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(pasta\s+dent|past\.?\s+dent|pst\.?\s+dent|dentifr|dent[ií]fric)/i, nivel1: "HIGIENE ORAL", nivel2: "Pastas Dentífricas" },
  // As marcas de higiene oral escrevem "Escov", "Esc" e nada mais ("Gum
  // Bi-Direction 2714 Escov 1,4Mm X6"). Ancorar na marca evita apanhar
  // escovas de cabelo, que também são só "Esc".
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(escov\w*\s+(?:de\s+)?dent|esc\.?\s+dent|escovilh[aã]o|escovil|interdent|toothbrush|esc\s+d\b|soft\s?picks?|limp\s+lingual)/i, nivel1: "HIGIENE ORAL", nivel2: "Escovas de Dentes" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(gum|curaprox|elgydium|oral\s?-?\s?b|halita|colgate|sensodyne|parodontax)\b.{0,30}\b(?:esc|escov|recarga)/i, nivel1: "HIGIENE ORAL", nivel2: "Escovas de Dentes" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(gum|curaprox|elgydium|oral\s?-?\s?b|halita|colgate|sensodyne|parodontax|fluocaril)\b.{0,30}\b(?:gel\s+dent|past|pasta|dentifr)/i, nivel1: "HIGIENE ORAL", nivel2: "Pastas Dentífricas" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(fio\s+dent|fita\s+dent|dental\s+floss)/i, nivel1: "HIGIENE ORAL", nivel2: "Fio Dentário" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(pr[oó]tese\s+dent|dentadura|corega|kukident|fixador\s+pr[oó]tese)/i, nivel1: "HIGIENE ORAL", nivel2: "Próteses Dentárias" },

  // ── Capilar ───────────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(anti-?caspa|caspa|kelual|selegel)/i, nivel1: "CAPILAR", nivel2: "Anti-caspa" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(queda\s+(?:de\s+)?cabelo|anti[\s-]?queda|aminexil|aminactif|minoxidil|anacaps|neoptide|triphasic|alopecia)/i, nivel1: "CAPILAR", nivel2: "Queda de Cabelo" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(colora[cç][aã]o\s+(?:perm|capil)|tinta\s+(?:capil|cabelo)|phytocolor|vitaliacolor)/i, nivel1: "CAPILAR", nivel2: "Coloração" },
  // "Ch" e "Sh" são as abreviaturas de champô em todo o ERP ("Ducray
  // Elution Ch 200ml", "Foltene Sh Cab Fraco"). O `(?!\.)` exclui os
  // prefixos de código do fornecedor ("Ch.Chu7490541000"), onde "Ch" é
  // família de artigo e não champô.
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(champ[oôu]|shampoo)\b|\b(?:ch|sh)\b(?!\.)/i, nivel1: "CAPILAR", nivel2: "Champôs" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(m[aá]scara\s+capil|masc\.?\s+capil|tratamento\s+capil|lo[cç][aã]o\s+capil|s[eé]rum\s+capil|capilar|desfrisante|alisad)/i, nivel1: "CAPILAR", nivel2: "Máscaras e Tratamentos" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(acondic|condicionador|amaciador\s+cabelo|desembara[cç]|desemb\b)/i, nivel1: "CAPILAR", nivel2: "Condicionadores" },

  // ── Cosmética ─────────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(verniz|nailvarnish|esmalte\s+unhas|nail\s+polish)/i, nivel1: "COSMÉTICA", nivel2: "Maquilhagem" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(batom|lip\s*gloss|lipstick|rimel|rimmel|m[aá]scara\s+(?:de\s+)?pestanas|eyeliner|delineador|sombra\s+olhos|blush|corretor|p[oó]\s+compact|maquilha)/i, nivel1: "COSMÉTICA", nivel2: "Maquilhagem" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(desmaq|demaq|bif[aá]sico\s+olhos)/i, nivel1: "COSMÉTICA", nivel2: "Desmaquilhantes" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(perfume|parfum|\bedt\b|\bedp\b|eau\s+de\s+(?:toilette|parfum|cologne)|col[oó]nia|fragr[aâ]nc)/i, nivel1: "COSMÉTICA", nivel2: "Perfumes" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(pin[cç]a\s+sobran|lima\s+(?:de\s+)?unhas|corta.?unhas|escova\s+(?:de\s+)?cabelo|esc\.?\s+cab|pincel\s+maquilh|rolos?\s+(?:de\s+)?cabelo|acetona)/i, nivel1: "COSMÉTICA", nivel2: "Acessórios de Beleza" },

  // ── Higiene corporal ──────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(desodor|anti[\s-]?transpir|\bdeo\b|deo\s+(?:stress|stick|roll)|roll-?on\s+deo)/i, nivel1: "HIGIENE CORPORAL", nivel2: "Desodorizantes" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([ií]ntim[ao]?\b|higiene\s+[ií]ntima|hig\.?\s*int\b|lactacyd|saugella|cumlaude|saforelle|palomacare|vulvar)/i, nivel1: "HIGIENE CORPORAL", nivel2: "Higiene Íntima" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(gel\s+(?:de\s+)?(?:banho|banh\b|ban\b|duch)|cr\.?\s+duch|[oó]leo\s+(?:de\s+)?banho|shower\s+gel|body\s+wash|surgras|espuma\s+banho)/i, nivel1: "HIGIENE CORPORAL", nivel2: "Banho e Duche" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(sabonete|sab\b|sab[aã]o\s+l[ií]quido|pain\s+dermato)/i, nivel1: "HIGIENE CORPORAL", nivel2: "Sabonetes" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(depilat[oó]ri|creme\s+descol|cr\.?\s+descol|depila|cera\s+depil|lycia)/i, nivel1: "HIGIENE CORPORAL", nivel2: "Outros Higiene Corporal" },

  // ── Material clínico e consumíveis ────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(luvas?)\b/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS", nivel2: "Luvas" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(seringas?|agulhas?|lancetas?|cateter|contentor\s+agulhas)/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS", nivel2: "Seringas e Agulhas" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(m[aá]scara\s+(?:cir[uú]rg|ffp|prot)|mascara\s+descart)/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS", nivel2: "Máscaras" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([aá]lcool\s+(?:gel|et[ií]lico|isopropi|sanit|\d)|gel\s+hidroalco[oó]l|[aá]gua\s+destilada|hidroalcoolico)/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS", nivel2: "Consumíveis Clínicos" },

  // ── Primeiros socorros ────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ligaduras?|lig\.?\s+(?:elast|adesiv|pano|red|tubolar)|ligadura|rede\s+elast|malha\s+tubular)/i, nivel1: "PRIMEIROS SOCORROS", nivel2: "Ligaduras" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(pensos?\b|compressas?|gaze|adesivos?\b|ades\b|soffix|leukosilk|leukoplast|algod[aã]o\s+(?:hidr[oó]f|card)|algod[aã]o\b)/i, nivel1: "PRIMEIROS SOCORROS", nivel2: "Pensos e Compressas" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(iodopovid|betadine|clorexidina|antiss?[eé]ptic|desinfetant\s+ferid|[aá]gua\s+oxigenada|[aá]gua\s+oxig|mercuroc|nitrato\s+(?:de\s+)?prata|violeta\s+genciana)/i, nivel1: "PRIMEIROS SOCORROS", nivel2: "Antissépticos" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(cicatriz|trat\.?\s+ferid|spray\s+ferid|hidrocol[oó]id|[uú]lcera|escara)/i, nivel1: "PRIMEIROS SOCORROS", nivel2: "Tratamento de Feridas" },

  // ── Otorrino e oftalmologia ───────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([aá]gua\s+do\s+mar|ag\.?\s+mar\b|soro\s+fisio|physiolog|physiodose|lavagem\s+nasal|sol\.?\s+nasal|spray\s+nasal|nasal\b|physiomer|marimer|rhinomer|sterimar|nasalmer|lyomer|tonimer|sinefrina)/i, nivel1: "OTORRINO", nivel2: "Lavagens e Soluções" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(tamp(?:[oõ]es|[aã]o)\s+(?:auric|ouvid|ruido)|ohropax|cer[uú]men|otolog|ouvidos?)\b/i, nivel1: "OTORRINO", nivel2: "Ouvidos" },
  { pattern: /\bgarganta\b|\b(rebu[cç]ados?\s+(?:mel|eucal)|em\s?eukal|ricola|pulmoll|strepsils|mel\s+rosado)/i, nivel1: "OTORRINO", nivel2: "Garganta" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(lentes?\s+(?:de\s+)?cont|solu[cç][aã]o\s+(?:[uú]nica|(?:de\s+)?lentes)|l[ií]quido\s+lentes|renu\b|opti.?free)/i, nivel1: "OFTALMOLOGIA", nivel2: "Lentes de Contacto e Acessórios" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(l[aá]grima\s+artific|olhos?\s+secos?|systane|hylo\b|col[íi]rio\s+lub|lubrificante\s+ocul)/i, nivel1: "OFTALMOLOGIA", nivel2: "Olho Seco" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(toalhitas?\s+ocul|higiene\s+ocul|blefar|optrex|banho\s+ocul)/i, nivel1: "OFTALMOLOGIA", nivel2: "Higiene Ocular" },
  // "Gts Oft", "Gel Oft", "Sol Oft" — a via ocular escrita como o ERP a
  // escreve. Sem productType, estes ficavam sem categoria nenhuma.
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])((?:gts|gotas|gel|sol|pom|col)\.?\s+oft|oft[aá]lmic|col[íi]rio)/i, nivel1: "OFTALMOLOGIA", nivel2: "Gotas Oculares" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(spray\s+auricular|sol\.?\s+auricular|gotas\s+auricul|auricular)/i, nivel1: "OTORRINO", nivel2: "Ouvidos" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(sterillium|desinf\.?\s+m[aã]os|esponja\s+(?:de\s+)?lavagem|pr[eé].?cir[uú]rg|clorohex|clorhex)/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS", nivel2: "Consumíveis Clínicos" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(estojo\s+prim|primeiros\s+socorros|prim\.?\s+soc\b|mala\s+socorr)/i, nivel1: "PRIMEIROS SOCORROS", nivel2: "Outros Primeiros Socorros" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([oó]culos\s+(?:de\s+)?leitura|[oó]culos\s+leit|[oó]culos\s+(?:de\s+)?sol|[oó]culos\b)/i, nivel1: "OFTALMOLOGIA", nivel2: "Outros Oftalmologia" },

  // ── Mobilidade ────────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(bengalas?|canadianas?|andarilhos?|muletas?|cadeira\s+(?:de\s+)?rodas|ponteira\s+(?:p\/|para|bengala|andarilho))/i, nivel1: "MOBILIDADE E APOIO DIÁRIO", nivel2: "Apoio à Mobilidade" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(alteador\s+sanit|barra\s+apoio|assento\s+banho|cadeira\s+banho|resguardo\s+cama)/i, nivel1: "MOBILIDADE E APOIO DIÁRIO", nivel2: "Ajudas Técnicas" },

  // ── Saúde sexual ──────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(preservativ|preservat\b|condom|durex|control\s+(?:senses|nature)|profil[aá]ctic)/i, nivel1: "SAÚDE SEXUAL", nivel2: "Preservativos" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(copo\s+menstrual|intimina|tampões?\s+(?:higi[eé]n|ob\b)|penso\s+higi[eé]n|absorvente\s+higi[eé]n)/i, nivel1: "SAÚDE SEXUAL", nivel2: "Cuidado Íntimo" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(lubrificante\s+[ií]ntim|gel\s+lubrificante)/i, nivel1: "SAÚDE SEXUAL", nivel2: "Lubrificantes" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(teste\s+(?:de\s+)?(?:gravidez|ovula|fertil))/i, nivel1: "SAÚDE SEXUAL", nivel2: "Testes" },

  // ── Saúde natural ─────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ch[aá]\s|\bch[aá]$|infus[aã]o|inf\.?\s+saq|saqueta\s+ch|yogi\s+tea|tisana|ervan[aá]ri)/i, nivel1: "SAÚDE NATURAL", nivel2: "Fitoterapia" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(boiron|lehning|\d+\s*ch\b\s*(?:gran|comp|dilui)|gr[aâ]nulos?\s+\d+ch|homeopat|traumeel|sedivitax)/i, nivel1: "SAÚDE NATURAL", nivel2: "Homeopatia" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(flores\s+de\s+bach|floral\s+bach)/i, nivel1: "SAÚDE NATURAL", nivel2: "Florais" },

  // ── Bem-estar ─────────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([oó]leo\s+(?:de\s+)?massagem|massagem\b|[oó]leo\s+essencial|aromaterapia|difusor\s+aroma)/i, nivel1: "BEM-ESTAR", nivel2: "Massagem" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([oó]leo\s+corp|[oó]leo\s+(?:de\s+)?am[eê]ndoas|[oó]leo\s+(?:de\s+)?(?:trigo|calendula|cal[eê]ndula|rosa\s+mosqueta)|[oó]leo\b)/i, nivel1: "DERMOCOSMÉTICA", nivel2: "Corpo" },

  // ── Acessórios de farmácia ────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(caixa\s+(?:de\s+)?comprimidos|organizador\s+(?:de\s+)?medica|porta.?comprimidos|pill\s?box|caixa\s+comp\b)/i, nivel1: "ACESSÓRIOS DE FARMÁCIA", nivel2: "Organizadores de Medicação" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(copo\s+(?:medidor|dosea)|seringa\s+dosea|colher\s+dosea)/i, nivel1: "ACESSÓRIOS DE FARMÁCIA", nivel2: "Copos Medidores" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(cortador\s+(?:de\s+)?comprimidos|triturador\s+comprimidos|estojo\s+(?:de\s+)?viagem|frasco\s+(?:de\s+)?vidro|frasco\s+vd)/i, nivel1: "ACESSÓRIOS DE FARMÁCIA", nivel2: "Caixas e Estojos" },

  // ── Dispositivos médicos ──────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(term[oó]metro)/i, nivel1: "DISPOSITIVOS MÉDICOS", nivel2: "Termómetros" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(tensi[oó]met|medidor\s+(?:de\s+)?tens[aã]o|esfigmoman)/i, nivel1: "DISPOSITIVOS MÉDICOS", nivel2: "Tensão Arterial" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(nebulizador|aeroc[aâ]mara|c[aâ]mara\s+expansora|inalador\s+aparelho)/i, nivel1: "DISPOSITIVOS MÉDICOS", nivel2: "Nebulizadores" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(tiras?\s+glicemi|tira\s+sangue\s+glic|gluc[oó]metro|glic[oó]metro|freestyle\s+libre|contour\s+next|accu.?chek)/i, nivel1: "DISPOSITIVOS MÉDICOS", nivel2: "Glicemia e Diabetes" },
  // Estomaterapia, algaliação e laringectomia: gamas hospitalares que a
  // farmácia dispensa (Coloplast, Hollister, B.Braun, Welland, Provox).
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(algalia|saco\s+(?:de\s+)?(?:urina|uro|ostomia)|ostomia|coloplast|hollister|welland|provox|b\.?\s?braun|sonda\s+vesical|recort[aá]vel|urostomia|colostomia|placa\s+recort)/i, nivel1: "DISPOSITIVOS MÉDICOS", nivel2: "Outros Dispositivos Médicos" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(pera\s+(?:de\s+)?borracha|enema|clister|irrigador|softwash|seringa\s+lavagem)/i, nivel1: "DISPOSITIVOS MÉDICOS", nivel2: "Outros Dispositivos Médicos" },

  // ── Ortopedia ─────────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(dedeiras?|salvadedos|separador\s+(?:de\s+)?dedos|protetor\s+joanete|joanete|almof\.?\s+plantar|palmilhas?)/i, nivel1: "ORTOPEDIA", nivel2: "Palmilhas" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(joelheiras?)/i, nivel1: "ORTOPEDIA", nivel2: "Joelheiras" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(meias?\s+(?:de\s+)?compress|collant|stay\s*up|segreta|juzo|juzoflex|mediven)/i, nivel1: "ORTOPEDIA", nivel2: "Meias de Compressão" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(cinta\s+(?:lombar|abdominal)|colar\s+cervical|faixa\s+lombar)/i, nivel1: "ORTOPEDIA", nivel2: "Cintas e Faixas" },

  // ── Puericultura: acessórios genéricos ────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(babetes?|babeiro|mordedor|porta.?chupeta|corta.?unhas\s+beb|kit\s+manicure\s+beb)/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Acessórios de Bebé" },

  // ── Nutrição clínica ──────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(fresubin|fortimel|meritene|nutrison|ensure|resource\s+\w|espessante|nutri[cç][aã]o\s+(?:cl[ií]nica|ent[eé]rica)|hiperprote)/i, nivel1: "NUTRIÇÃO", nivel2: "Nutrição Clínica" },

  // ── Cosmética: acessórios de beleza ───────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(invisibobble|tangle\s?teezer|elast(?:icos?)?\s+(?:de\s+)?cabelo|gancho\s+cabelo|titania|disco\s+desmaq|discos?\s+algod[aã]o|alicate\s+(?:de\s+)?unhas|pin[cç]as?\b|espelho\s+(?:de\s+)?(?:bolsa|aument))/i, nivel1: "COSMÉTICA", nivel2: "Acessórios de Beleza" },

  // ── Higiene do lar e desinfeção ───────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(inseticida|repelente\s+(?:de\s+)?(?:roupa|traca)|anti-?tra[cç]a|roupeiro|nataflina|naftalina|desinfetante\s+superf|lix[ií]via)/i, nivel1: "HIGIENE DO LAR E DESINFEÇÃO", nivel2: "Higiene de Superfícies" },

  // ── Acessórios de farmácia ────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(copos?\b|boi[aã]o|frasco\b|tesouras?\b|contentor\b)/i, nivel1: "ACESSÓRIOS DE FARMÁCIA", nivel2: "Outros Acessórios de Farmácia" },

  // ── Puericultura ──────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(chupetas?|chup\b|biber[aã]o|biberon|bib\b|tetinas?|tet\.?\s*(?:fisiol|sil))/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Chupetas e Biberões" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(fraldas?\s+(?:beb|infant|t\d)|toalhitas?\s+beb|muda.?fraldas)/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Fraldas e Toalhitas" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(leite\s+(?:infantil|lactente|cresciment|transi[cç])|f[oó]rmula\s+infant|papa\s+(?:infant|l[aá]ctea)|aptamil|nutriben|novalac|miltina)/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Alimentação do Bebé" },

  // ── Veterinária ───────────────────────────────────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(desparasit|antipulgas|anti-?pulgas|spot.?on|coleira\s+antiparas|frontline|bravecto|advantix|seresto)/i, nivel1: "VETERINÁRIA", nivel2: "Desparasitação" },

  // ── Serviços e artigos não comercializáveis ───────────────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(administra[cç][aã]o\s+(?:de\s+)?vacina|servi[cç]o\s+(?:sns|cl[ií]nic)|consulta\s+(?:enfermag|farmac|nutri)|checksaude|check\s?sa[uú]de|rastreio)/i, nivel1: "SERVIÇOS E ARTIGOS NÃO COMERCIALIZÁVEIS", nivel2: "Serviço Clínico" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(taxa\s+(?:moderadora|sns)|produtos?\s+n[aã]o\s+codificad|artigos?\s+intern|saco\s+(?:de\s+)?(?:papel|pap\b|pl[aá]stico|farm)|consum[ií]v\w*\s+(?:embalage|escritor)|saq\.?\s+kraft|rolo\s+t[eé]rmico)/i, nivel1: "SERVIÇOS E ARTIGOS NÃO COMERCIALIZÁVEIS", nivel2: "Artigos Internos" },
  { pattern: /\bfee\s+(?:de\s+)?servi[cç]o|\bfee\s+(?:down|to)\b/i, nivel1: "SERVIÇOS E ARTIGOS NÃO COMERCIALIZÁVEIS", nivel2: "Taxas e Atos" },

  // ── Piolhos, dentição e enjoo: produtos definidos pelo problema ───────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(piolhos?|l[êe]ndeas?|pediculos)/i, nivel1: "MEDICAMENTOS", nivel2: "Dermatológicos" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(anel\s+denti[cç]|denti[cç][aã]o|primeiros?\s+dentes)/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Acessórios de Bebé" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(fungos?\s+(?:das\s+)?unhas?|onicomicose|excilor|pedisilk|myco\s+clear|calicida|raspador|lima\s+p[eé]s|pedra\s+p[oó]mes)/i, nivel1: "DERMOCOSMÉTICA", nivel2: "Mãos e Pés" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(gotas\s+auricul|sol\.?\s+auricular|cer[uú]men|cerunex|otalgan|otolog)/i, nivel1: "OTORRINO", nivel2: "Ouvidos" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(aftas?\b|gengivit|aloclair|bioadhesive\s+gel|est(?:o|ó)matit)/i, nivel1: "HIGIENE ORAL", nivel2: "Outros Higiene Oral" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(repelente|mosquit|citronela|carra[cç]a|insetifug|bodyguard)/i, nivel1: "DERMOCOSMÉTICA", nivel2: "Outros Dermocosmética" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(b[aá]lsamo\s+labial|brilho\s+labial|stick\s+labial|protetor\s+labial|lip\s+balm)/i, nivel1: "DERMOCOSMÉTICA", nivel2: "Rosto" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(saco\s+(?:de\s+)?(?:[aá]gua|ag\.?)\s*(?:quente)?|thermo\s+gel|coldhot|compressa\s+(?:gel|t[eé]rmica)|spray\s+gelo|gelo\s+instant)/i, nivel1: "PRIMEIROS SOCORROS", nivel2: "Outros Primeiros Socorros" },
  // Incontinência do adulto: o ERP escreve a marca e o formato, nunca a
  // palavra "incontinência".
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(molicare|\btena\b|fralda\s+adulto|cueca\s+(?:absorv|\w+\s*x\d)|resguardo\s+(?:de\s+)?cama|penso\s+incontin|slip\s+frald)/i, nivel1: "DISPOSITIVOS MÉDICOS", nivel2: "Outros Dispositivos Médicos" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(masc\.?\s+cir[uú]rg|m[aá]scara\s+cir[uú]rg|ffp\d)/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS", nivel2: "Máscaras" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(insupen|medfine|agulha\s+caneta|ag\.?\s+caneta|penfine)/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS", nivel2: "Seringas e Agulhas" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(muda\s+frald|creme\s+muda|assadura|pom(?:ada)?\s+frald)/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Fraldas e Toalhitas" },
  { pattern: /\bbeb[eé]\b.{0,25}\b(?:toalhet|creme|cr\b|leite|lt\b|lo[cç][aã]o|shamp|champ|limp|hidrat|banho|gel)|\b(?:toalhet|champ|shamp)\w*.{0,15}\bbeb[eé]\b/i, nivel1: "PUERICULTURA E BEBÉ", nivel2: "Higiene do Bebé" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(p[oó]s.?parto|posparto|mala\s+maternidad)/i, nivel1: "MÃE E GRAVIDEZ", nivel2: "Pós-parto" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(laca\s+(?:spray|cabelo)|gel\s+fixador|espuma\s+cabelo|styling)/i, nivel1: "CAPILAR", nivel2: "Outros Capilar" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(ag\.?\s+(?:termal|mic(?:elar)?)|[aá]gua\s+(?:termal|micelar))/i, nivel1: "DERMOCOSMÉTICA", nivel2: "Limpeza" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(base\s+fluida|couvrance|mousse\s+matif|maq\s+t\s*\d|fundo\s+de\s+teint|pestanas?\b|sobrancelh)/i, nivel1: "COSMÉTICA", nivel2: "Maquilhagem" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(aeroch[aâ]mber|c[aâ]mara\s+expansora|flow\s?vu)/i, nivel1: "DISPOSITIVOS MÉDICOS", nivel2: "Nebulizadores" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])(banda\s+cera|cera\s+(?:depilat|corporal)|body\s+natur)/i, nivel1: "HIGIENE CORPORAL", nivel2: "Outros Higiene Corporal" },
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([aá]gua\s+(?:de\s+)?rosas|[aá]gua\s+termal|[aá]gua\s+micelar)/i, nivel1: "DERMOCOSMÉTICA", nivel2: "Limpeza" },

  // ── Éter, glicerina e outros a granel do receituário ──────────────────
  { pattern: /(?<![a-zA-ZÀ-ÿ0-9])([eé]ter\s+(?:et[ií]lico|sulf[uú]rico|diet[ií]lico)|[eé]ter\b|clorof[oó]rmio|acetona\s+farm|bicarbonato\s+(?:de\s+)?s[oó]dio|borato\s+(?:de\s+)?s[oó]dio|c[aâ]nfora|[aá]cido\s+b[oó]rico|glicerina\b|vaselina)/i, nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS", nivel2: "Consumíveis Clínicos" },
];

/**
 * Procura uma rota de salvamento para a designação. Devolve apenas pares
 * que existam mesmo na taxonomia canónica — uma rota mal escrita fica sem
 * efeito em vez de inventar uma categoria.
 */
function resolverSalvamento(designacao: string): RotaSalvamento | null {
  if (!designacao?.trim()) return null;
  for (const rota of ROTAS_SALVAMENTO) {
    if (!rota.pattern.test(designacao)) continue;
    if (!isValidNivel2(rota.nivel1, rota.nivel2)) continue;
    return rota;
  }
  return null;
}

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

  // 1a. MEDICAMENTOS — sub-prefixo ATC (excepções 4-5 chars). Consultado
  //     ANTES do prefixo de 3 para que sub-classes específicas (ex.:
  //     N01BB → Dermatológicos para anestésicos tópicos) tenham prioridade
  //     sobre a regra do grupo de 3 chars (ex.: N01 → Outros Medicamentos).
  if (isMed && atcUpper) {
    for (const key of ATC_SUBGROUP_KEYS_SORTED) {
      if (atcUpper.startsWith(key)) {
        const target = ATC_SUBGROUP_TO_NIVEL2[key];
        if (target && isValidNivel2(nivel1, target)) {
          return {
            nivel2: target,
            confidence: 0.94,
            method: "atc_prefix",
            reason: `ATC subgroup ${key} (${atcUpper}) → ${target}`,
          };
        }
      }
    }
  }

  // 1b. MEDICAMENTOS — ATC prefixo de 3 (mais específico que letra). Cobre
  //     casos como N02 (analgésicos), R06 (alergias), C07/C08/C09/C10
  //     (cardiovascular), D08 (antissépticos), S02 (otológicos), etc.
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
    // Sem nível 1 nenhum — nem breadcrumb, nem productType utilizável.
    // Antes de desistir, tenta a rota de salvamento pela designação: é o
    // único sinal que existe sempre. Não há nada para degradar aqui.
    const rota = resolverSalvamento(input.designacao);
    if (rota) {
      return {
        nivel1: rota.nivel1,
        nivel2: rota.nivel2,
        confidence: 0.7,
        method: "designacao_rota",
        reason: `sem nivel1 (productType=${input.productType}); rota de salvamento "${rota.pattern.source.slice(0, 40)}" → ${rota.nivel1} > ${rota.nivel2}`,
      };
    }
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

  // Nível 1 claro, nível 2 sem match: o produto ia para "Outros <X>".
  // Antes disso, tenta a rota de salvamento — o nível 2 certo pode viver
  // noutro nível 1 (um champô em DERMOCOSMÉTICA pertence a CAPILAR >
  // Champôs). Trocar um balde por uma subcategoria real é sempre ganho;
  // e como só entramos aqui quando o resultado ia ser fallback, nenhuma
  // classificação específica pode ser perdida por esta via.
  const rota = resolverSalvamento(input.designacao);
  if (rota) {
    return {
      nivel1: rota.nivel1,
      nivel2: rota.nivel2,
      confidence: Math.min(n1.confidence, 0.75),
      method: "designacao_rota",
      reason: `${n1ReasonPrefix}; sem nivel2 em "${n1.nivel1}"; rota de salvamento → ${rota.nivel1} > ${rota.nivel2}`,
    };
  }

  // Sem rota: "Outros <X>" como fallback REAL. Sempre acima do limiar de
  // gravação (0.55 ≥ THRESHOLD_PARTIAL=0.50) mas abaixo de VERIFIED
  // (0.75) para sinalizar à UI que o nivel2 foi inferido por fallback.
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
