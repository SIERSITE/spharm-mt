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

  // ── Subcategorias que passaram a ter produtos com a revisão de Agosto
  //    de 2026 (rotas de salvamento + vocabulário de substâncias).
  //    Sem estas linhas, o trabalho feito na taxonomia não chegava às
  //    utilizações: um champô deixou de estar em "Outros Dermocosmética",
  //    mas "Nariz", "Garganta" e "Ouvidos" continuavam a render zero.
  { nome: "Nariz", utilizacao: "nariz-entupido", confianca: 0.9 },
  { nome: "Lavagens e Soluções", utilizacao: "nariz-entupido", confianca: 0.85 },
  { nome: "Garganta", utilizacao: "dor-de-garganta", confianca: 0.9 },
  { nome: "Ouvidos", utilizacao: "ouvidos", confianca: 0.9 },
  { nome: "Olho Seco", utilizacao: "olhos-secos-irritados", confianca: 0.95 },
  { nome: "Lentes de Contacto e Acessórios", utilizacao: "lentes-de-contacto", confianca: 0.95 },
  { nome: "Respiratório", utilizacao: "asma-dpoc", confianca: 0.85 },
  { nome: "Preservativos", utilizacao: "saude-sexual", confianca: 0.95 },
  { nome: "Lubrificantes", utilizacao: "saude-sexual", confianca: 0.9 },
  { nome: "Testes", utilizacao: "saude-sexual", confianca: 0.9 },
  { nome: "Pensos e Compressas", utilizacao: "feridas-e-cortes", confianca: 0.9 },
  { nome: "Ligaduras", utilizacao: "feridas-e-cortes", confianca: 0.85 },
  { nome: "Antissépticos", utilizacao: "feridas-e-cortes", confianca: 0.9 },
  { nome: "Tratamento de Feridas", utilizacao: "feridas-e-cortes", confianca: 0.9 },
  { nome: "Luvas", utilizacao: "protecao-e-higiene", confianca: 0.9 },
  { nome: "Máscaras", utilizacao: "protecao-e-higiene", confianca: 0.95 },
  { nome: "Apoio à Mobilidade", utilizacao: "mobilidade-e-ortopedia", confianca: 0.95 },
  { nome: "Ajudas Técnicas", utilizacao: "mobilidade-e-ortopedia", confianca: 0.9 },
  { nome: "Tornozeleiras", utilizacao: "mobilidade-e-ortopedia", confianca: 0.9 },
  { nome: "Material de Imobilização", utilizacao: "mobilidade-e-ortopedia", confianca: 0.85 },
  { nome: "Nutrição Clínica", utilizacao: "nutricao-clinica", confianca: 0.95 },
  { nome: "Proteínas e Reforço Nutricional", utilizacao: "nutricao-clinica", confianca: 0.85 },
  { nome: "Chupetas e Biberões", utilizacao: "alimentacao-infantil", confianca: 0.85 },
  { nome: "Gravidez", utilizacao: "gravidez-e-amamentacao", confianca: 0.95 },
  { nome: "Amamentação", utilizacao: "gravidez-e-amamentacao", confianca: 0.95 },
  { nome: "Pós-parto", utilizacao: "gravidez-e-amamentacao", confianca: 0.85 },
  { nome: "Champôs", utilizacao: "queda-de-cabelo", confianca: 0.5, nota: "champô é rotina, não tratamento de queda" },
  { nome: "Cardiovascular", utilizacao: "tensao-arterial", confianca: 0.6, nota: "cardiovascular inclui colesterol e anticoagulação" },
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
  { padrao: /\bmolicare\b|\btena\b|fralda\s+adulto|slip\s+frald|resguardo\s+(?:de\s+)?cama/i, utilizacao: "incontinencia", confianca: 0.9 },
  { padrao: /\bfralda/i, utilizacao: "fralda-e-higiene-bebe", confianca: 0.85, tipos: ["PUERICULTURA"] },
  { padrao: /\bmordedor/i, utilizacao: "denticao", confianca: 0.9 },
  { padrao: /lentes\s+de\s+contacto|solu[çc][ãa]o\s+[úu]nica/i, utilizacao: "lentes-de-contacto", confianca: 0.9 },
  { padrao: /m[áa]scara\s+(cir[úu]rgica|ffp)|\bluvas?\b|[áa]lcool.?gel/i, utilizacao: "protecao-e-higiene", confianca: 0.9 },
  { padrao: /\bcanadiana|\bandarilho|\bbengala/i, utilizacao: "mobilidade-e-ortopedia", confianca: 0.9 },
  { padrao: /\btermómetro|\btermometro/i, utilizacao: "dor-e-febre", confianca: 0.7, nota: "medir febre não é tratar febre" },

  // ── Sintoma escrito na designação ───────────────────────────────────
  // Estes termos nomeiam a queixa, não a composição nem a marca — é o
  // critério que esta lista sempre teve. Um produto chamado "Xarope
  // Expectorante" declara para que serve.
  { padrao: /\bexpectorante|\bmucol[íi]tic|expetora[cç]|\bcatarro\b/i, utilizacao: "tosse-produtiva", confianca: 0.9 },
  { padrao: /\bantituss?[íi]v|tosse\s+seca|tosse\s+irritativ/i, utilizacao: "tosse-seca", confianca: 0.9 },
  { padrao: /\btosse\b/i, utilizacao: "tosse", confianca: 0.9 },
  { padrao: /\bconstipa[cç]|\bgripe\b|estados?\s+gripais/i, utilizacao: "constipacao-gripe", confianca: 0.85 },
  { padrao: /congest[aã]o\s+nasal|nariz\s+entupido|descongestion|lavagem\s+nasal|[aá]gua\s+do\s+mar|soro\s+fisio/i, utilizacao: "nariz-entupido", confianca: 0.85 },
  { padrao: /dor\s+de\s+garganta|\bgarganta\b/i, utilizacao: "dor-de-garganta", confianca: 0.85 },
  { padrao: /\bfebre\b|antipir[eé]tic/i, utilizacao: "dor-e-febre", confianca: 0.85 },
  { padrao: /dor\s+de\s+cabe[cç]a|cefaleia|enxaqueca/i, utilizacao: "dor-de-cabeca", confianca: 0.9 },
  { padrao: /c[oó]licas?\s+menstruais|dismenorreia|dor\s+menstrual/i, utilizacao: "dor-menstrual", confianca: 0.9 },
  { padrao: /\bazia\b|\brefluxo\b|acidez\s+g[aá]stric|enfartament/i, utilizacao: "azia-refluxo", confianca: 0.85 },
  { padrao: /obstipa[cç]|\blaxante|pris[aã]o\s+de\s+ventre|tr[aâ]nsito\s+intestinal/i, utilizacao: "obstipacao", confianca: 0.85 },
  { padrao: /\bdiarreia\b|antidiarreic|reidrata[cç][aã]o\s+oral/i, utilizacao: "diarreia", confianca: 0.9 },
  { padrao: /\benjoo\b|\bn[aá]useas?\b|antiem[eé]tic|enjoo\s+(?:de\s+)?(?:viagem|movimento)/i, utilizacao: "nauseas-enjoo", confianca: 0.85 },
  { padrao: /\bprobi[oó]tic|flora\s+intestinal|fermentos\s+l[aá]ctic/i, utilizacao: "flora-intestinal", confianca: 0.9 },
  { padrao: /\bhemorr[oó]id/i, utilizacao: "hemorroidas", confianca: 0.9 },
  { padrao: /\bafta\b|\baftas\b|gengivit|\bgengivas\b/i, utilizacao: "aftas-e-gengivas", confianca: 0.9 },
  { padrao: /dentes\s+sens[íi]v|sensibilidade\s+dent[aá]r/i, utilizacao: "dentes-sensiveis", confianca: 0.9 },
  { padrao: /\bmicose|p[eé]\s+de\s+atleta|fungos?\s+(?:da|das)\s+unhas?|onicomicose|antif[uú]ngic/i, utilizacao: "micoses", confianca: 0.85 },
  { padrao: /queimaduras?|escald[aã]o|p[oó]s.?solar|after.?sun/i, utilizacao: "queimaduras", confianca: 0.85 },
  { padrao: /\bacne\b|pele\s+oleosa|imperfei[cç][oõ]es|borbulhas/i, utilizacao: "acne", confianca: 0.85 },
  { padrao: /pele\s+at[oó]pica|dermatite\s+at[oó]pica|\beczema\b|pele\s+seca/i, utilizacao: "pele-seca-atopica", confianca: 0.85 },
  { padrao: /queda\s+(?:de\s+)?cabelo|anti-?queda|alopecia|minoxidil/i, utilizacao: "queda-de-cabelo", confianca: 0.9 },
  { padrao: /prote(?:c|ç)[aã]o\s+solar|protetor\s+solar|\b(?:spf|fps)\s*\d/i, utilizacao: "protecao-solar", confianca: 0.9 },
  { padrao: /olhos?\s+secos?|l[aá]grima\s+artificial|col[íi]rio\s+lubrific/i, utilizacao: "olhos-secos-irritados", confianca: 0.9 },
  { padrao: /\bcer[uú]men|higiene\s+auricular|tamp[oõ]es?\s+auricular/i, utilizacao: "ouvidos", confianca: 0.85 },
  { padrao: /c[oó]licas?\s+(?:do\s+)?(?:beb[eé]|lactente)/i, utilizacao: "colicas-do-bebe", confianca: 0.9 },
  { padrao: /\bdenti[cç][aã]o\b|primeiros\s+dentes/i, utilizacao: "denticao", confianca: 0.9 },
  { padrao: /\bgr[aá]vida|gravidez|amamenta[cç]|lacta[cç][aã]o|[aá]cido\s+f[oó]lico/i, utilizacao: "gravidez-e-amamentacao", confianca: 0.85 },
  { padrao: /\binsomnia|ins[oó]nia|dificuldade\s+em\s+adormecer|\bmelatonina/i, utilizacao: "sono", confianca: 0.9 },
  { padrao: /\bimunidade|defesas\s+imunit|sistema\s+imunit/i, utilizacao: "defesas-imunitarias", confianca: 0.85 },
  { padrao: /pernas\s+(?:cansadas|leves|pesadas)|insufici[eê]ncia\s+venosa|\bvarizes\b/i, utilizacao: "circulacao-e-pernas", confianca: 0.9 },
  { padrao: /deixar\s+de\s+fumar|cessa[cç][aã]o\s+tab[aá]gica|\bnicotina\b/i, utilizacao: "cessacao-tabagica", confianca: 0.9 },
  { padrao: /\b[uú]lcera\s+(?:de\s+)?press[aã]o|\bescaras?\b|p[eé]\s+diab[eé]tico|penso\s+avan[cç]ad/i, utilizacao: "feridas-cronicas", confianca: 0.9 },
];

/**
 * Substância → utilização.
 *
 * Lida de duas origens, por esta ordem de força:
 *
 *  1. Grupo Homogéneo, pela substância no início da descrição
 *     ("Paracetamol | A101 | Oral | 1000 mg"). É atribuído pelo INFARMED
 *     e vale o valor declarado aqui.
 *
 *  2. Designação do produto. Em Portugal o genérico chama-se pela
 *     substância — "Irbesartan Pharmakern 300 Mg 28 Comp." — e essa
 *     palavra é o produto, não uma alusão a ele. Vale menos do que o
 *     Grupo Homogéneo (ver PENALIZACAO_DESIGNACAO) porque a designação é
 *     texto livre do ERP: pode trazer a substância de uma associação, ou
 *     uma marca que por acaso contém o radical.
 *
 * Só entram substâncias cuja utilização o vocabulário sabe exprimir. Um
 * antiepiléptico não tem entrada aqui: "epilepsia" não é uma faceta, e
 * inventar-lhe uma para não deixar o produto vazio seria pior do que
 * deixá-lo vazio.
 */
export const REGRAS_SUBSTANCIA: readonly RegraTaxonomia[] = [
  // ── Dor e febre ─────────────────────────────────────────────────────
  { nome: "paracetamol", utilizacao: "dor-e-febre", confianca: 0.95 },
  { nome: "ibuprofeno", utilizacao: "dor-e-febre", confianca: 0.9 },
  { nome: "acido acetilsalicilico", utilizacao: "dor-e-febre", confianca: 0.85 },
  { nome: "metamizol", utilizacao: "dor-e-febre", confianca: 0.9 },
  { nome: "dexcetoprofeno", utilizacao: "dor-e-febre", confianca: 0.9 },
  { nome: "dexibuprofeno", utilizacao: "dor-e-febre", confianca: 0.9 },
  { nome: "naproxeno", utilizacao: "dor-e-febre", confianca: 0.85 },
  { nome: "nimesulida", utilizacao: "dor-e-febre", confianca: 0.85 },
  { nome: "tramadol", utilizacao: "dor-e-febre", confianca: 0.9 },
  { nome: "codeina", utilizacao: "dor-e-febre", confianca: 0.85 },
  // Antienxaqueca: os triptanos não servem outra dor.
  { nome: "sumatriptano", utilizacao: "dor-de-cabeca", confianca: 0.95 },
  { nome: "zolmitriptano", utilizacao: "dor-de-cabeca", confianca: 0.95 },
  { nome: "rizatriptano", utilizacao: "dor-de-cabeca", confianca: 0.95 },
  { nome: "naratriptano", utilizacao: "dor-de-cabeca", confianca: 0.95 },
  { nome: "eletriptano", utilizacao: "dor-de-cabeca", confianca: 0.95 },
  { nome: "almotriptano", utilizacao: "dor-de-cabeca", confianca: 0.95 },
  // Dor músculo-esquelética
  { nome: "diclofenac", utilizacao: "dor-muscular-articular", confianca: 0.9 },
  { nome: "etofenamato", utilizacao: "dor-muscular-articular", confianca: 0.95 },
  { nome: "piroxicam", utilizacao: "dor-muscular-articular", confianca: 0.85 },
  { nome: "meloxicam", utilizacao: "dor-muscular-articular", confianca: 0.85 },
  { nome: "etoricoxib", utilizacao: "dor-muscular-articular", confianca: 0.9 },
  { nome: "celecoxib", utilizacao: "dor-muscular-articular", confianca: 0.9 },
  { nome: "aceclofenac", utilizacao: "dor-muscular-articular", confianca: 0.9 },
  { nome: "indometacina", utilizacao: "dor-muscular-articular", confianca: 0.85 },
  { nome: "tiocolquicosido", utilizacao: "dor-muscular-articular", confianca: 0.9 },
  { nome: "tizanidina", utilizacao: "dor-muscular-articular", confianca: 0.85 },
  { nome: "baclofeno", utilizacao: "dor-muscular-articular", confianca: 0.8 },

  // ── Respiratório ────────────────────────────────────────────────────
  { nome: "acetilcisteina", utilizacao: "tosse-produtiva", confianca: 0.95 },
  { nome: "ambroxol", utilizacao: "tosse-produtiva", confianca: 0.95 },
  { nome: "carbocisteina", utilizacao: "tosse-produtiva", confianca: 0.95 },
  { nome: "bromexina", utilizacao: "tosse-produtiva", confianca: 0.95 },
  { nome: "guaifenesina", utilizacao: "tosse-produtiva", confianca: 0.9 },
  { nome: "dextrometorfano", utilizacao: "tosse-seca", confianca: 0.95 },
  { nome: "butamirato", utilizacao: "tosse-seca", confianca: 0.95 },
  { nome: "levodropropizina", utilizacao: "tosse-seca", confianca: 0.95 },
  { nome: "cloperastina", utilizacao: "tosse-seca", confianca: 0.95 },
  { nome: "oxolamina", utilizacao: "tosse-seca", confianca: 0.9 },
  { nome: "xilometazolina", utilizacao: "nariz-entupido", confianca: 0.95 },
  { nome: "oximetazolina", utilizacao: "nariz-entupido", confianca: 0.95 },
  { nome: "nafazolina", utilizacao: "nariz-entupido", confianca: 0.9 },
  { nome: "benzidamina", utilizacao: "dor-de-garganta", confianca: 0.9 },
  { nome: "ambazona", utilizacao: "dor-de-garganta", confianca: 0.9 },
  { nome: "loratadina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "cetirizina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "desloratadina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "levocetirizina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "bilastina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "ebastina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "rupatadina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "fexofenadina", utilizacao: "alergia-respiratoria", confianca: 0.95 },
  { nome: "mizolastina", utilizacao: "alergia-respiratoria", confianca: 0.9 },
  { nome: "salbutamol", utilizacao: "asma-dpoc", confianca: 0.95 },
  { nome: "budesonida", utilizacao: "asma-dpoc", confianca: 0.9 },
  { nome: "formoterol", utilizacao: "asma-dpoc", confianca: 0.95 },
  { nome: "salmeterol", utilizacao: "asma-dpoc", confianca: 0.95 },
  { nome: "tiotropio", utilizacao: "asma-dpoc", confianca: 0.95 },
  { nome: "ipratropio", utilizacao: "asma-dpoc", confianca: 0.9 },
  { nome: "montelucaste", utilizacao: "asma-dpoc", confianca: 0.9 },
  { nome: "indacaterol", utilizacao: "asma-dpoc", confianca: 0.95 },

  // ── Digestivo ───────────────────────────────────────────────────────
  { nome: "omeprazol", utilizacao: "azia-refluxo", confianca: 0.95 },
  { nome: "pantoprazol", utilizacao: "azia-refluxo", confianca: 0.95 },
  { nome: "esomeprazol", utilizacao: "azia-refluxo", confianca: 0.95 },
  { nome: "lansoprazol", utilizacao: "azia-refluxo", confianca: 0.95 },
  { nome: "rabeprazol", utilizacao: "azia-refluxo", confianca: 0.95 },
  { nome: "ranitidina", utilizacao: "azia-refluxo", confianca: 0.9 },
  { nome: "sucralfato", utilizacao: "azia-refluxo", confianca: 0.85 },
  { nome: "magaldrato", utilizacao: "azia-refluxo", confianca: 0.9 },
  { nome: "bisacodilo", utilizacao: "obstipacao", confianca: 0.95 },
  { nome: "lactulose", utilizacao: "obstipacao", confianca: 0.9 },
  { nome: "macrogol", utilizacao: "obstipacao", confianca: 0.9 },
  { nome: "picossulfato", utilizacao: "obstipacao", confianca: 0.95 },
  { nome: "loperamida", utilizacao: "diarreia", confianca: 0.95 },
  { nome: "racecadotril", utilizacao: "diarreia", confianca: 0.95 },
  { nome: "domperidona", utilizacao: "nauseas-enjoo", confianca: 0.9 },
  { nome: "metoclopramida", utilizacao: "nauseas-enjoo", confianca: 0.9 },
  { nome: "dimenidrinato", utilizacao: "nauseas-enjoo", confianca: 0.95 },
  { nome: "ondansetrom", utilizacao: "nauseas-enjoo", confianca: 0.9 },
  { nome: "simeticone", utilizacao: "gases-colicas", confianca: 0.9 },
  { nome: "dimeticone", utilizacao: "gases-colicas", confianca: 0.85 },
  { nome: "butilescopolamina", utilizacao: "gases-colicas", confianca: 0.85 },
  { nome: "mebeverina", utilizacao: "gases-colicas", confianca: 0.85 },
  { nome: "trimebutina", utilizacao: "gases-colicas", confianca: 0.85 },

  // ── Pele ────────────────────────────────────────────────────────────
  { nome: "terbinafina", utilizacao: "micoses", confianca: 0.95 },
  { nome: "clotrimazol", utilizacao: "micoses", confianca: 0.95 },
  { nome: "cetoconazol", utilizacao: "micoses", confianca: 0.9 },
  { nome: "miconazol", utilizacao: "micoses", confianca: 0.9 },
  { nome: "bifonazol", utilizacao: "micoses", confianca: 0.95 },
  { nome: "sertaconazol", utilizacao: "micoses", confianca: 0.95 },
  { nome: "ciclopirox", utilizacao: "micoses", confianca: 0.95 },
  { nome: "amorolfina", utilizacao: "micoses", confianca: 0.95 },
  { nome: "adapaleno", utilizacao: "acne", confianca: 0.95 },
  { nome: "peroxido de benzoilo", utilizacao: "acne", confianca: 0.95 },
  { nome: "isotretinoina", utilizacao: "acne", confianca: 0.9 },
  { nome: "permetrina", utilizacao: "piolhos", confianca: 0.9 },
  { nome: "iodopovidona", utilizacao: "feridas-e-cortes", confianca: 0.9 },
  { nome: "clorexidina", utilizacao: "feridas-e-cortes", confianca: 0.85 },

  // ── Apoio ao doente ─────────────────────────────────────────────────
  { nome: "metformina", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "gliclazida", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "glimepirida", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "sitagliptina", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "vildagliptina", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "linagliptina", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "empagliflozina", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "dapagliflozina", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "insulina", utilizacao: "diabetes", confianca: 0.95 },
  { nome: "sinvastatina", utilizacao: "colesterol", confianca: 0.95 },
  { nome: "atorvastatina", utilizacao: "colesterol", confianca: 0.95 },
  { nome: "rosuvastatina", utilizacao: "colesterol", confianca: 0.95 },
  { nome: "pravastatina", utilizacao: "colesterol", confianca: 0.95 },
  { nome: "pitavastatina", utilizacao: "colesterol", confianca: 0.95 },
  { nome: "fluvastatina", utilizacao: "colesterol", confianca: 0.95 },
  { nome: "ezetimiba", utilizacao: "colesterol", confianca: 0.95 },
  { nome: "fenofibrato", utilizacao: "colesterol", confianca: 0.9 },
  { nome: "enalapril", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "lisinopril", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "ramipril", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "perindopril", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "captopril", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "losartan", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "valsartan", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "irbesartan", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "candesartan", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "telmisartan", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "olmesartan", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "amlodipina", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "lercanidipina", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "nifedipina", utilizacao: "tensao-arterial", confianca: 0.85 },
  { nome: "bisoprolol", utilizacao: "tensao-arterial", confianca: 0.85 },
  { nome: "nebivolol", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "carvedilol", utilizacao: "tensao-arterial", confianca: 0.85 },
  { nome: "hidroclorotiazida", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "indapamida", utilizacao: "tensao-arterial", confianca: 0.9 },
  { nome: "clortalidona", utilizacao: "tensao-arterial", confianca: 0.85 },
  { nome: "diosmina", utilizacao: "circulacao-e-pernas", confianca: 0.9 },
  { nome: "troxerrutina", utilizacao: "circulacao-e-pernas", confianca: 0.9 },
  { nome: "dobesilato", utilizacao: "circulacao-e-pernas", confianca: 0.9 },
  { nome: "glucosamina", utilizacao: "articulacoes-e-ossos", confianca: 0.9 },
  { nome: "condroitina", utilizacao: "articulacoes-e-ossos", confianca: 0.9 },
  { nome: "alendronico", utilizacao: "articulacoes-e-ossos", confianca: 0.9 },
  { nome: "risedronato", utilizacao: "articulacoes-e-ossos", confianca: 0.9 },

  // ── Bem-estar ───────────────────────────────────────────────────────
  { nome: "melatonina", utilizacao: "sono", confianca: 0.95 },
  { nome: "zolpidem", utilizacao: "sono", confianca: 0.95 },
  { nome: "zopiclona", utilizacao: "sono", confianca: 0.95 },
  { nome: "valeriana", utilizacao: "sono", confianca: 0.85 },
  { nome: "passiflora", utilizacao: "stress-e-ansiedade", confianca: 0.85 },
  { nome: "alprazolam", utilizacao: "stress-e-ansiedade", confianca: 0.9 },
  { nome: "lorazepam", utilizacao: "stress-e-ansiedade", confianca: 0.9 },
  { nome: "bromazepam", utilizacao: "stress-e-ansiedade", confianca: 0.9 },
  { nome: "diazepam", utilizacao: "stress-e-ansiedade", confianca: 0.85 },
  { nome: "nicotina", utilizacao: "cessacao-tabagica", confianca: 0.95 },
];

/**
 * Quanto se desconta quando a substância vem da designação e não do
 * Grupo Homogéneo. Calibrado para que uma regra de 0.85 (sinal já com
 * ressalva) caia abaixo de MIN_CONFIANCA e não seja escrita, enquanto as
 * de 0.9 e 0.95 — substâncias que só têm um uso — sobrevivam.
 */
export const PENALIZACAO_DESIGNACAO = 0.05;

/**
 * Utilizações que implicam outra, mais geral. Aplicado depois das
 * regras: quem procura "Tosse" tem de encontrar também os antitússicos e
 * os expectorantes, senão a faceta geral devolve menos que as
 * específicas. A confiança é herdada — a implicação é lógica, não um
 * sinal novo.
 */
export const IMPLICACOES: Readonly<Record<string, string>> = {
  "tosse-seca": "tosse",
  "tosse-produtiva": "tosse",
};
