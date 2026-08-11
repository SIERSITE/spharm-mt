/**
 * lib/catalog/utilizacoes-regras.ts
 *
 * Regras determinísticas que associam produtos a utilizações.
 *
 * Só sinais que já existem no catálogo: ATC e DCI (apenas quando vêm de
 * fonte regulatória), Grupo Homogéneo, taxonomia (categoria e
 * subcategoria), productType e designação. Sem scraping e sem modelo de
 * linguagem — uma associação errada aqui manda o operador à prateleira
 * errada, e isso custa mais do que a associação em falta.
 *
 * Cada regra declara a confiança do SINAL, não do resultado. O ATC é uma
 * classificação regulatória atribuída ao princípio activo: se um produto
 * tem R06A, é um anti-histamínico, ponto. A subcategoria foi atribuída
 * pelo nosso classificador e pode estar errada. A designação é a mais
 * frágil das três — por isso vale menos, mesmo quando o termo é claro.
 *
 * Abaixo de MIN_CONFIANCA nada é escrito. As regras fracas ficam aqui de
 * propósito: aparecem no relatório como recusadas, e isso mostra o que se
 * decidiu NÃO fazer. Uma regra que desaparece do ficheiro não deixa
 * rasto; uma regra recusada deixa.
 *
 * NÃO existe regra de recurso. Um produto sem sinal forte fica sem
 * utilização — não há "Outros". Uma faceta que devolve tudo não filtra
 * nada.
 */

/** Nada abaixo disto é escrito na base. */
export const MIN_CONFIANCA = 0.8;

export type RegraAtc = { atc: string; utilizacao: string; confianca: number; nota?: string };
export type RegraTaxonomia = { nome: string; utilizacao: string; confianca: number; nota?: string };
export type RegraTexto = {
  padrao: RegExp;
  utilizacao: string;
  confianca: number;
  /** Restringe a regra a estes productType. Vazio = todos. */
  tipos?: string[];
  nota?: string;
};

/**
 * ATC → utilização. Só aplicada quando o produto tem RegulatoryRecord,
 * isto é, quando o ATC veio do INFARMED e não de inferência nossa.
 *
 * Prefixos ao nível que a decisão exige: N02B chega para "dor e febre",
 * mas C05A tem de ser separado de C05 porque hemorroidas e insuficiência
 * venosa mandam a pessoa a prateleiras diferentes.
 */
export const REGRAS_ATC: readonly RegraAtc[] = [
  // Respiratório
  { atc: "R05C", utilizacao: "tosse-produtiva", confianca: 0.95 },
  { atc: "R05D", utilizacao: "tosse-seca", confianca: 0.95 },
  { atc: "R06A", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { atc: "R01A", utilizacao: "nariz-entupido", confianca: 0.9 },
  { atc: "R01B", utilizacao: "nariz-entupido", confianca: 0.9 },
  { atc: "R03A", utilizacao: "asma-dpoc", confianca: 0.95 },
  { atc: "R03B", utilizacao: "asma-dpoc", confianca: 0.95 },
  { atc: "R02A", utilizacao: "dor-de-garganta", confianca: 0.9 },

  // Dor
  { atc: "N02B", utilizacao: "dor-e-febre", confianca: 0.95 },
  { atc: "N02A", utilizacao: "dor-e-febre", confianca: 0.9 },
  { atc: "N02C", utilizacao: "dor-de-cabeca", confianca: 0.95 },
  { atc: "M01A", utilizacao: "dor-muscular-articular", confianca: 0.9 },
  { atc: "M02A", utilizacao: "dor-muscular-articular", confianca: 0.95 },

  // Digestivo
  { atc: "A02A", utilizacao: "azia-refluxo", confianca: 0.95 },
  { atc: "A02B", utilizacao: "azia-refluxo", confianca: 0.95 },
  { atc: "A06A", utilizacao: "obstipacao", confianca: 0.95 },
  { atc: "A07B", utilizacao: "diarreia", confianca: 0.9 },
  { atc: "A07D", utilizacao: "diarreia", confianca: 0.9 },
  { atc: "A07F", utilizacao: "flora-intestinal", confianca: 0.9 },
  { atc: "A04A", utilizacao: "nauseas-enjoo", confianca: 0.95 },
  { atc: "C05A", utilizacao: "hemorroidas", confianca: 0.95 },
  // Antiespasmódicos servem cólicas mas também outras dores viscerais.
  { atc: "A03A", utilizacao: "gases-colicas", confianca: 0.7, nota: "antiespasmódico não é só cólica/gases" },

  // Pele
  { atc: "D01A", utilizacao: "micoses", confianca: 0.95 },
  { atc: "D01B", utilizacao: "micoses", confianca: 0.95 },
  { atc: "D10A", utilizacao: "acne", confianca: 0.95 },
  { atc: "D10B", utilizacao: "acne", confianca: 0.95 },
  { atc: "D08A", utilizacao: "feridas-e-cortes", confianca: 0.9 },
  { atc: "D03A", utilizacao: "feridas-e-cortes", confianca: 0.9 },
  { atc: "D02A", utilizacao: "pele-seca-atopica", confianca: 0.9 },
  { atc: "P03A", utilizacao: "piolhos", confianca: 0.85 },

  // Olhos, ouvidos, boca
  { atc: "S01X", utilizacao: "olhos-secos-irritados", confianca: 0.9 },
  { atc: "S02", utilizacao: "ouvidos", confianca: 0.9 },
  { atc: "A01A", utilizacao: "higiene-oral", confianca: 0.7, nota: "A01A cobre desde flúor a antifúngico oral" },

  // Bem-estar
  { atc: "A11", utilizacao: "vitaminas-e-minerais", confianca: 0.95 },
  { atc: "A12", utilizacao: "vitaminas-e-minerais", confianca: 0.9 },
  { atc: "B03A", utilizacao: "vitaminas-e-minerais", confianca: 0.85 },
  { atc: "N05B", utilizacao: "stress-e-ansiedade", confianca: 0.9 },
  { atc: "N05C", utilizacao: "sono", confianca: 0.9 },
  { atc: "N07BA", utilizacao: "cessacao-tabagica", confianca: 0.95 },
  { atc: "M05B", utilizacao: "articulacoes-e-ossos", confianca: 0.85 },
  { atc: "C05C", utilizacao: "circulacao-e-pernas", confianca: 0.9 },

  // Apoio ao doente
  { atc: "A10", utilizacao: "diabetes", confianca: 0.95 },
  { atc: "C10A", utilizacao: "colesterol", confianca: 0.95 },
  { atc: "C10B", utilizacao: "colesterol", confianca: 0.95 },
  { atc: "C02", utilizacao: "tensao-arterial", confianca: 0.9 },
  { atc: "C07", utilizacao: "tensao-arterial", confianca: 0.85 },
  { atc: "C08", utilizacao: "tensao-arterial", confianca: 0.9 },
  { atc: "C09", utilizacao: "tensao-arterial", confianca: 0.9 },
  // Diuréticos tanto tratam hipertensão como insuficiência cardíaca.
  { atc: "C03", utilizacao: "tensao-arterial", confianca: 0.75, nota: "diurético nem sempre é anti-hipertensor" },
];

/** Subcategoria (nível 2) → utilização. Nome exacto da taxonomia. */
export const REGRAS_SUBCATEGORIA: readonly RegraTaxonomia[] = [
  { nome: "Constipação, Tosse e Gripe", utilizacao: "constipacao-gripe", confianca: 0.9 },
  { nome: "Alergias", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "Analgésicos e Anti-inflamatórios", utilizacao: "dor-e-febre", confianca: 0.9 },
  { nome: "Diabetes", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "Glicemia e Diabetes", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "Solar Adulto", utilizacao: "protecao-solar", confianca: 0.95 },
  { nome: "Solar Criança", utilizacao: "protecao-solar", confianca: 0.95 },
  { nome: "Pós-solar", utilizacao: "queimaduras", confianca: 0.85 },
  { nome: "Material de Curativo", utilizacao: "feridas-e-cortes", confianca: 0.9 },
  { nome: "Antisséticos e Desinfetantes", utilizacao: "feridas-e-cortes", confianca: 0.85 },
  { nome: "Otológicos", utilizacao: "ouvidos", confianca: 0.9 },
  { nome: "Pastas Dentífricas", utilizacao: "higiene-oral", confianca: 0.95 },
  { nome: "Escovas de Dentes", utilizacao: "higiene-oral", confianca: 0.95 },
  { nome: "Elixires", utilizacao: "higiene-oral", confianca: 0.95 },
  { nome: "Fio Dentário", utilizacao: "higiene-oral", confianca: 0.95 },
  { nome: "Vitaminas e Minerais", utilizacao: "vitaminas-e-minerais", confianca: 0.95 },
  { nome: "Digestão e Probióticos", utilizacao: "flora-intestinal", confianca: 0.85 },
  { nome: "Sono e Relaxamento", utilizacao: "sono", confianca: 0.9 },
  { nome: "Energia e Vitalidade", utilizacao: "cansaco-e-energia", confianca: 0.9 },
  { nome: "Imunidade", utilizacao: "defesas-imunitarias", confianca: 0.95 },
  { nome: "Articulações e Ossos", utilizacao: "articulacoes-e-ossos", confianca: 0.95 },
  { nome: "Acne e Pele Oleosa", utilizacao: "acne", confianca: 0.95 },
  { nome: "Queda de Cabelo", utilizacao: "queda-de-cabelo", confianca: 0.95 },
  { nome: "Pele Sensível / Atópica", utilizacao: "pele-seca-atopica", confianca: 0.95 },
  { nome: "Pele Atópica do Bebé", utilizacao: "pele-seca-atopica", confianca: 0.9 },
  { nome: "Meias de Compressão", utilizacao: "circulacao-e-pernas", confianca: 0.95 },
  { nome: "Palmilhas", utilizacao: "mobilidade-e-ortopedia", confianca: 0.9 },
  { nome: "Joelheiras", utilizacao: "mobilidade-e-ortopedia", confianca: 0.9 },
  { nome: "Punhos e Cotoveleiras", utilizacao: "mobilidade-e-ortopedia", confianca: 0.9 },
  { nome: "Cintas e Faixas", utilizacao: "mobilidade-e-ortopedia", confianca: 0.9 },
  { nome: "Tensão Arterial", utilizacao: "tensao-arterial", confianca: 0.95 },
  { nome: "Fraldas e Toalhitas", utilizacao: "fralda-e-higiene-bebe", confianca: 0.95 },
  { nome: "Higiene do Bebé", utilizacao: "fralda-e-higiene-bebe", confianca: 0.85 },
  { nome: "Alimentação do Bebé", utilizacao: "alimentacao-infantil", confianca: 0.95 },
  { nome: "Controlo de Peso", utilizacao: "controlo-de-peso", confianca: 0.95 },
  { nome: "Nebulizadores", utilizacao: "asma-dpoc", confianca: 0.9 },
  { nome: "Anti-caspa", utilizacao: "pele-seca-atopica", confianca: 0.7, nota: "caspa não é pele atópica" },
  { nome: "Hidratação", utilizacao: "pele-seca-atopica", confianca: 0.7, nota: "hidratante de rotina não é pele atópica" },
  { nome: "Oftálmicos", utilizacao: "olhos-secos-irritados", confianca: 0.7, nota: "oftálmico cobre glaucoma, infecção, etc." },
  { nome: "Próteses Dentárias", utilizacao: "higiene-oral", confianca: 0.75 },
];

/** Categoria (nível 1) → utilização. Só quando o ramo inteiro serve. */
export const REGRAS_CATEGORIA: readonly RegraTaxonomia[] = [
  { nome: "PROTEÇÃO SOLAR", utilizacao: "protecao-solar", confianca: 0.95 },
  { nome: "HIGIENE ORAL", utilizacao: "higiene-oral", confianca: 0.9 },
];

/**
 * Designação. O sinal mais fraco: aqui só entram termos que designam a
 * função do produto e não a sua composição ou marca.
 */
export const REGRAS_TEXTO: readonly RegraTexto[] = [
  { padrao: /\brepelente/i, utilizacao: "picadas-e-insetos", confianca: 0.9 },
  { padrao: /\b(piolhos?|l[êe]ndeas?)\b/i, utilizacao: "piolhos", confianca: 0.95 },
  { padrao: /\bpreservativ/i, utilizacao: "saude-sexual", confianca: 0.95 },
  { padrao: /teste\s+(de\s+)?gravidez/i, utilizacao: "saude-sexual", confianca: 0.9 },
  { padrao: /\bincontin/i, utilizacao: "incontinencia", confianca: 0.95 },
  { padrao: /\bfralda/i, utilizacao: "fralda-e-higiene-bebe", confianca: 0.85, tipos: ["PUERICULTURA"] },
  { padrao: /\bmordedor/i, utilizacao: "denticao", confianca: 0.9 },
  { padrao: /lentes\s+de\s+contacto|solu[çc][ãa]o\s+[úu]nica/i, utilizacao: "lentes-de-contacto", confianca: 0.9 },
  { padrao: /m[áa]scara\s+(cir[úu]rgica|ffp)|\bluvas?\b|[áa]lcool.?gel/i, utilizacao: "protecao-e-higiene", confianca: 0.9 },
  { padrao: /\bcanadiana|\bandarilho|\bbengala/i, utilizacao: "mobilidade-e-ortopedia", confianca: 0.9 },
  { padrao: /\btermómetro|\btermometro/i, utilizacao: "dor-e-febre", confianca: 0.7, nota: "medir febre não é tratar febre" },
];

/**
 * Grupo Homogéneo → utilização, pela substância no início da descrição
 * ("Paracetamol | A101 | Oral | 1000 mg"). Fica escrito para quando a
 * ingestão do ERP povoar o campo — hoje está vazio, e a regra rende zero.
 * Preferimos isto a inventar um caminho novo quando os dados chegarem.
 */
export const REGRAS_SUBSTANCIA: readonly RegraTaxonomia[] = [
  { nome: "paracetamol", utilizacao: "dor-e-febre", confianca: 0.95 },
  { nome: "ibuprofeno", utilizacao: "dor-e-febre", confianca: 0.9 },
  { nome: "acido acetilsalicilico", utilizacao: "dor-e-febre", confianca: 0.85 },
  { nome: "loratadina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "cetirizina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "desloratadina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "omeprazol", utilizacao: "azia-refluxo", confianca: 0.95 },
  { nome: "pantoprazol", utilizacao: "azia-refluxo", confianca: 0.95 },
  { nome: "esomeprazol", utilizacao: "azia-refluxo", confianca: 0.95 },
  { nome: "acetilcisteina", utilizacao: "tosse-produtiva", confianca: 0.95 },
  { nome: "ambroxol", utilizacao: "tosse-produtiva", confianca: 0.95 },
  { nome: "carbocisteina", utilizacao: "tosse-produtiva", confianca: 0.95 },
  { nome: "metformina", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "sinvastatina", utilizacao: "colesterol", confianca: 0.95 },
  { nome: "atorvastatina", utilizacao: "colesterol", confianca: 0.95 },
  { nome: "rosuvastatina", utilizacao: "colesterol", confianca: 0.95 },
];
