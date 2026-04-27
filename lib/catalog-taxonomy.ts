/**
 * lib/catalog-taxonomy.ts
 *
 * Taxonomia canónica interna do catálogo SPharm.MT.
 *
 * Esta é a ÚNICA fonte de verdade para categorias (nível 1) e subcategorias
 * (nível 2). Nenhum conector, resolver ou persistência pode inventar
 * categorias fora desta lista. O seed da tabela `Classificacao` é feito
 * a partir daqui (ver scripts/seed-taxonomy.ts).
 *
 * Regras operacionais (post-cleanup, abril 2026):
 *   - Apenas categorias comerciais/operacionais reais.
 *   - "Outros <X>" é um nível 2 legítimo mas usado apenas como último recurso
 *     dentro de um nível 1 onde há sinal forte.
 *   - Categorias técnicas/transitórias ("Em Revisão", "Por Classificar",
 *     "Sem Match de Fonte") FORAM REMOVIDAS desta taxonomia. São estados de
 *     workflow representados por `verificationStatus` e `needsManualReview`
 *     no `Produto`, não classificações. Quando não há categoria real
 *     atribuível, `classificacaoNivel1Id` e `classificacaoNivel2Id` ficam
 *     `null`.
 */

export type CanonicalCategory = {
  nivel1: string;
  nivel2: string[];
};

export const CANONICAL_TAXONOMY: CanonicalCategory[] = [
  {
    nivel1: "MEDICAMENTOS",
    nivel2: [
      "Analgésicos e Anti-inflamatórios",
      "Constipação, Tosse e Gripe",
      "Alergias",
      "Sistema Digestivo",
      "Sistema Nervoso",
      "Cardiovascular",
      "Diabetes",
      "Dermatológicos",
      "Oftálmicos",
      "Otológicos",
      "Ginecológicos",
      "Urológicos",
      "Respiratório",
      "Antisséticos e Desinfetantes",
      "Outros Medicamentos",
    ],
  },
  {
    nivel1: "SUPLEMENTOS ALIMENTARES",
    nivel2: [
      "Vitaminas e Minerais",
      "Imunidade",
      "Energia e Vitalidade",
      "Memória e Concentração",
      "Sono e Relaxamento",
      "Digestão e Probióticos",
      "Articulações e Ossos",
      "Cabelo, Pele e Unhas",
      "Controlo de Peso",
      "Saúde Íntima",
      "Outros Suplementos",
    ],
  },
  {
    nivel1: "DERMOCOSMÉTICA",
    nivel2: [
      "Rosto",
      "Corpo",
      "Mãos e Pés",
      "Anti-envelhecimento",
      "Pele Sensível / Atópica",
      "Acne e Pele Oleosa",
      "Despigmentantes",
      "Limpeza",
      "Hidratação",
      "Outros Dermocosmética",
    ],
  },
  {
    nivel1: "HIGIENE CORPORAL",
    nivel2: [
      "Banho e Duche",
      "Desodorizantes",
      "Higiene Íntima",
      "Sabonetes",
      "Outros Higiene Corporal",
    ],
  },
  {
    nivel1: "HIGIENE ORAL",
    nivel2: [
      "Pastas Dentífricas",
      "Escovas de Dentes",
      "Elixires",
      "Fio Dentário",
      "Próteses Dentárias",
      "Outros Higiene Oral",
    ],
  },
  {
    nivel1: "CAPILAR",
    nivel2: [
      "Champôs",
      "Condicionadores",
      "Máscaras e Tratamentos",
      "Queda de Cabelo",
      "Anti-caspa",
      "Coloração",
      "Outros Capilar",
    ],
  },
  {
    nivel1: "PUERICULTURA E BEBÉ",
    nivel2: [
      "Fraldas e Toalhitas",
      "Alimentação do Bebé",
      "Higiene do Bebé",
      "Pele Atópica do Bebé",
      "Chupetas e Biberões",
      "Acessórios de Bebé",
      "Outros Puericultura e Bebé",
    ],
  },
  {
    nivel1: "MÃE E GRAVIDEZ",
    nivel2: [
      "Gravidez",
      "Pós-parto",
      "Amamentação",
      "Higiene e Cuidado",
      "Outros Mãe e Gravidez",
    ],
  },
  {
    nivel1: "NUTRIÇÃO",
    nivel2: [
      "Nutrição Clínica",
      "Proteínas e Reforço Nutricional",
      "Dietas Específicas",
      "Substitutos de Refeição",
      "Outros Nutrição",
    ],
  },
  {
    nivel1: "CONTROLO DE PESO",
    nivel2: [
      "Saciantes",
      "Queimadores",
      "Drenantes",
      "Refeições Substitutas",
      "Outros Controlo de Peso",
    ],
  },
  {
    nivel1: "DISPOSITIVOS MÉDICOS",
    nivel2: [
      "Testes e Monitorização",
      "Glicemia e Diabetes",
      "Tensão Arterial",
      "Termómetros",
      "Nebulizadores",
      "Material de Curativo",
      "Material de Imobilização",
      "Outros Dispositivos Médicos",
    ],
  },
  {
    nivel1: "PRIMEIROS SOCORROS",
    nivel2: [
      "Pensos e Compressas",
      "Ligaduras",
      "Antissépticos",
      "Tratamento de Feridas",
      "Outros Primeiros Socorros",
    ],
  },
  {
    nivel1: "ORTOPEDIA",
    nivel2: [
      "Joelheiras",
      "Tornozeleiras",
      "Cintas e Faixas",
      "Punhos e Cotoveleiras",
      "Palmilhas",
      "Meias de Compressão",
      "Outros Ortopedia",
    ],
  },
  {
    nivel1: "VETERINÁRIA",
    nivel2: [
      "Cães",
      "Gatos",
      "Desparasitação",
      "Higiene Animal",
      "Suplementos Veterinários",
      "Outros Veterinária",
    ],
  },
  {
    nivel1: "SAÚDE SEXUAL",
    nivel2: [
      "Preservativos",
      "Lubrificantes",
      "Testes",
      "Cuidado Íntimo",
      "Outros Saúde Sexual",
    ],
  },
  {
    nivel1: "OFTALMOLOGIA",
    nivel2: [
      "Gotas Oculares",
      "Olho Seco",
      "Lentes de Contacto e Acessórios",
      "Higiene Ocular",
      "Outros Oftalmologia",
    ],
  },
  {
    nivel1: "OTORRINO",
    nivel2: [
      "Nariz",
      "Garganta",
      "Ouvidos",
      "Lavagens e Soluções",
      "Outros Otorrino",
    ],
  },
  {
    nivel1: "MOBILIDADE E APOIO DIÁRIO",
    nivel2: [
      "Ajudas Técnicas",
      "Apoio à Mobilidade",
      "Conforto e Bem-estar",
      "Outros Mobilidade e Apoio Diário",
    ],
  },
  {
    nivel1: "PROTEÇÃO SOLAR",
    nivel2: [
      "Solar Adulto",
      "Solar Criança",
      "Pós-solar",
      "Autobronzeador",
      "Outros Proteção Solar",
    ],
  },
  {
    nivel1: "COSMÉTICA",
    nivel2: [
      "Maquilhagem",
      "Desmaquilhantes",
      "Perfumes",
      "Acessórios de Beleza",
      "Outros Cosmética",
    ],
  },
  {
    nivel1: "BEM-ESTAR",
    nivel2: [
      "Aromaterapia",
      "Relaxamento",
      "Sono",
      "Massagem",
      "Outros Bem-estar",
    ],
  },
  {
    nivel1: "MATERIAL CLÍNICO E CONSUMÍVEIS",
    nivel2: [
      "Seringas e Agulhas",
      "Luvas",
      "Máscaras",
      "Consumíveis Clínicos",
      "Outros Material Clínico",
    ],
  },
  {
    nivel1: "SAÚDE NATURAL",
    nivel2: [
      "Fitoterapia",
      "Homeopatia",
      "Florais",
      "Outros Saúde Natural",
    ],
  },
  {
    nivel1: "HIGIENE DO LAR E DESINFEÇÃO",
    nivel2: [
      "Desinfeção",
      "Higiene de Superfícies",
      "Proteção",
      "Outros Higiene do Lar e Desinfeção",
    ],
  },
  {
    nivel1: "ACESSÓRIOS DE FARMÁCIA",
    nivel2: [
      "Organizadores de Medicação",
      "Copos Medidores",
      "Caixas e Estojos",
      "Outros Acessórios de Farmácia",
    ],
  },
  {
    nivel1: "SERVIÇOS E ARTIGOS NÃO COMERCIALIZÁVEIS",
    nivel2: [
      "Administração",
      "Serviço Clínico",
      "Taxas e Atos",
      "Artigos Internos",
      "Outros Serviços",
    ],
  },
];

/**
 * Nomes das antigas categorias técnicas, mantidos só para a query do
 * script de cleanup que põe `classificacao*Id` a `null` em produtos que
 * ainda os tenham em BD. Não usar fora do cleanup.
 */
export const LEGACY_TECHNICAL_NIVEL1_NAMES = [
  "CATEGORIAS TÉCNICAS / TRANSITÓRIAS",
];

export const CANONICAL_NIVEL1_NAMES: string[] = CANONICAL_TAXONOMY.map((c) => c.nivel1);

export function getNivel2For(nivel1: string): string[] {
  return CANONICAL_TAXONOMY.find((c) => c.nivel1 === nivel1)?.nivel2 ?? [];
}

export function isValidNivel1(name: string): boolean {
  return CANONICAL_TAXONOMY.some((c) => c.nivel1 === name);
}

export function isValidNivel2(nivel1: string, nivel2: string): boolean {
  return getNivel2For(nivel1).includes(nivel2);
}

/**
 * Devolve o nome do nivel2 "Outros <X>" para um nivel1, se existir.
 * Usar APENAS como último recurso de fallback dentro de um nivel1 com
 * sinal forte. Caso contrário, deixar `classificacao*Id` a `null` e
 * sinalizar via `needsManualReview`.
 */
export function othersNameFor(nivel1: string): string | null {
  return getNivel2For(nivel1).find((n) => /^outros\b/i.test(n)) ?? null;
}
