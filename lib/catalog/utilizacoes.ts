/**
 * lib/catalog/utilizacoes.ts
 *
 * Vocabulário CONTROLADO de utilizações/necessidades. Esta lista é a
 * única origem: `Utilizacao` é povoada por seed a partir daqui, e não há
 * caminho de escrita que crie linhas a partir de texto do utilizador.
 *
 * Porquê fechado: uma faceta de pesquisa alimentada por texto livre
 * degrada-se sempre. "tosse", "Tosse", "p/ tosse" e "tosse seca?" viram
 * quatro facetas, e a pesquisa deixa de ser confiável ao balcão.
 *
 * Porquê partilhado entre tenants: cada farmácia tem a sua base, mas o
 * `slug` significa o mesmo em todas. Um relatório de grupo agrega sem
 * traduzir, e o trabalho de classificação feito numa farmácia é
 * reaproveitável nas outras.
 *
 * REGRAS PARA MEXER NISTO
 *  · Acrescentar é seguro. Correr o seed a seguir.
 *  · NUNCA renomear um `slug`: desliga as associações já feitas nas
 *    outras bases. Para substituir, marcar `descontinuada` e criar nova.
 *  · `nome` e `sinonimos` podem mudar à vontade — são apresentação e
 *    pesquisa, não identidade.
 *
 * ÂMBITO: isto organiza o catálogo por necessidade declarada, para quem
 * atende encontrar o que tem na loja. Não é indicação terapêutica nem
 * substitui a decisão de quem dispensa.
 */

export type Utilizacao = {
  slug: string;
  nome: string;
  grupo: GrupoUtilizacao;
  descricao: string;
  sinonimos: string[];
  /** Sai da pesquisa mas mantém as associações históricas. */
  descontinuada?: boolean;
};

export const GRUPOS = [
  "Respiratório",
  "Dor e febre",
  "Digestivo",
  "Pele",
  "Olhos, ouvidos e boca",
  "Mãe e bebé",
  "Bem-estar e prevenção",
  "Apoio ao doente",
] as const;

export type GrupoUtilizacao = (typeof GRUPOS)[number];

/**
 * Granularidade: uma utilização só existe se um operador a usasse como
 * termo de pesquisa E separasse produtos que de outro modo ficariam
 * juntos. "Tosse seca" e "tosse produtiva" passam — levam a prateleiras
 * diferentes. "Tosse noturna" não — não muda o que se tira da prateleira.
 */
export const UTILIZACOES: readonly Utilizacao[] = [
  // ── Respiratório ────────────────────────────────────────────────────
  // "Tosse" é o termo por que se pergunta ao balcão; "seca" ou "com
  // expectoração" é o que se apura a seguir. As três coexistem de
  // propósito: quem já sabe filtra pela específica, quem não sabe vê a
  // prateleira toda. Um produto com tosse-seca ou tosse-produtiva recebe
  // SEMPRE também "tosse" — sem isso a faceta geral devolvia menos que as
  // específicas, que é o contrário do que se espera dela.
  { slug: "tosse", nome: "Tosse", grupo: "Respiratório",
    descricao: "Qualquer tipo de tosse. Agrega tosse seca e tosse com expectoração.",
    // Sem "antitússico" nem "expectorante": esses pertencem às
    // específicas. Um sinónimo aqui roubava-lhes a resolução, porque
    // `resolverUtilizacao` devolve o primeiro que casa e esta vem antes.
    sinonimos: ["tosse", "xarope para a tosse"] },
  { slug: "tosse-seca", nome: "Tosse seca", grupo: "Respiratório",
    descricao: "Tosse irritativa, sem expectoração.",
    sinonimos: ["tosse irritativa", "antitússico", "tosse sem catarro"] },
  { slug: "tosse-produtiva", nome: "Tosse com expectoração", grupo: "Respiratório",
    descricao: "Tosse com secreções.",
    sinonimos: ["expectorante", "mucolítico", "tosse com catarro"] },
  { slug: "constipacao-gripe", nome: "Constipação e gripe", grupo: "Respiratório",
    descricao: "Sintomas gerais de constipação ou gripe.",
    sinonimos: ["gripe", "constipação", "estados gripais"] },
  { slug: "nariz-entupido", nome: "Nariz entupido", grupo: "Respiratório",
    descricao: "Congestão nasal e lavagem nasal.",
    sinonimos: ["descongestionante", "congestão nasal", "soro nasal"] },
  { slug: "dor-de-garganta", nome: "Dor de garganta", grupo: "Respiratório",
    descricao: "Irritação e dor faríngea.",
    sinonimos: ["garganta", "faringe", "pastilhas para a garganta"] },
  { slug: "alergia-respiratoria", nome: "Alergias", grupo: "Respiratório",
    descricao: "Rinite alérgica e sintomas alérgicos sazonais.",
    sinonimos: ["anti-histamínico", "rinite", "pólen", "alergia"] },
  { slug: "asma-dpoc", nome: "Asma e DPOC", grupo: "Respiratório",
    descricao: "Apoio respiratório crónico, incluindo câmaras expansoras.",
    sinonimos: ["inalador", "bombinha", "câmara expansora"] },

  // ── Dor e febre ─────────────────────────────────────────────────────
  { slug: "dor-e-febre", nome: "Dor e febre", grupo: "Dor e febre",
    descricao: "Analgésicos e antipiréticos de uso geral.",
    sinonimos: ["analgésico", "antipirético", "febre", "dor"] },
  { slug: "dor-de-cabeca", nome: "Dor de cabeça", grupo: "Dor e febre",
    descricao: "Cefaleias e enxaquecas.",
    sinonimos: ["cefaleia", "enxaqueca", "migraine"] },
  { slug: "dor-muscular-articular", nome: "Dor muscular e articular", grupo: "Dor e febre",
    descricao: "Contusões, lombalgia, dor articular. Inclui tópicos.",
    sinonimos: ["anti-inflamatório", "lombar", "costas", "articulações", "pomada"] },
  { slug: "dor-menstrual", nome: "Dor menstrual", grupo: "Dor e febre",
    descricao: "Dismenorreia e desconforto do período.",
    sinonimos: ["cólicas menstruais", "período", "dismenorreia"] },

  // ── Digestivo ───────────────────────────────────────────────────────
  { slug: "azia-refluxo", nome: "Azia e refluxo", grupo: "Digestivo",
    descricao: "Acidez, enfartamento e refluxo.",
    sinonimos: ["antiácido", "acidez", "estômago", "enfartamento"] },
  { slug: "obstipacao", nome: "Prisão de ventre", grupo: "Digestivo",
    descricao: "Obstipação.", sinonimos: ["laxante", "obstipação", "intestino preso"] },
  { slug: "diarreia", nome: "Diarreia", grupo: "Digestivo",
    descricao: "Diarreia aguda e reidratação oral.",
    sinonimos: ["antidiarreico", "soro de reidratação"] },
  { slug: "flora-intestinal", nome: "Flora intestinal", grupo: "Digestivo",
    descricao: "Probióticos e apoio à flora, incluindo pós-antibiótico.",
    sinonimos: ["probiótico", "fermentos lácteos"] },
  { slug: "nauseas-enjoo", nome: "Náuseas e enjoo", grupo: "Digestivo",
    descricao: "Enjoo de viagem e náusea.",
    sinonimos: ["antiemético", "enjoo do movimento", "vómitos"] },
  { slug: "gases-colicas", nome: "Gases e cólicas", grupo: "Digestivo",
    descricao: "Flatulência e desconforto abdominal.",
    sinonimos: ["flatulência", "inchaço", "cólicas"] },
  { slug: "hemorroidas", nome: "Hemorroidas", grupo: "Digestivo",
    descricao: "Desconforto hemorroidário.", sinonimos: ["hemorroidas"] },

  // ── Pele ────────────────────────────────────────────────────────────
  { slug: "feridas-e-cortes", nome: "Feridas e cortes", grupo: "Pele",
    descricao: "Desinfecção e penso de feridas ligeiras.",
    sinonimos: ["desinfetante", "penso rápido", "curativo", "antisséptico"] },
  { slug: "queimaduras", nome: "Queimaduras", grupo: "Pele",
    descricao: "Queimaduras ligeiras, incluindo solares.",
    sinonimos: ["escaldão", "pós-solar"] },
  { slug: "pele-seca-atopica", nome: "Pele seca e atópica", grupo: "Pele",
    descricao: "Hidratação, dermatite atópica, eczema.",
    sinonimos: ["emoliente", "eczema", "atopia", "hidratante corporal"] },
  { slug: "acne", nome: "Acne e pele oleosa", grupo: "Pele",
    descricao: "Acne e seborreia.", sinonimos: ["borbulhas", "pele oleosa"] },
  { slug: "micoses", nome: "Micoses", grupo: "Pele",
    descricao: "Fungos da pele e unhas, pé de atleta.",
    sinonimos: ["antifúngico", "pé de atleta", "unha"] },
  { slug: "picadas-e-insetos", nome: "Picadas e repelentes", grupo: "Pele",
    descricao: "Repelentes e alívio de picadas.",
    sinonimos: ["repelente", "mosquitos", "carraça"] },
  { slug: "protecao-solar", nome: "Proteção solar", grupo: "Pele",
    descricao: "Protetores solares.", sinonimos: ["solar", "SPF", "protetor"] },
  { slug: "piolhos", nome: "Piolhos", grupo: "Pele",
    descricao: "Pediculose.", sinonimos: ["lêndeas", "pediculose"] },
  { slug: "queda-de-cabelo", nome: "Queda de cabelo", grupo: "Pele",
    descricao: "Queda capilar e fortalecimento.", sinonimos: ["capilar", "alopecia"] },

  // ── Olhos, ouvidos e boca ───────────────────────────────────────────
  { slug: "olhos-secos-irritados", nome: "Olhos secos e irritados", grupo: "Olhos, ouvidos e boca",
    descricao: "Lágrimas artificiais e higiene ocular.",
    sinonimos: ["colírio", "lágrima artificial", "olho seco"] },
  { slug: "lentes-de-contacto", nome: "Lentes de contacto", grupo: "Olhos, ouvidos e boca",
    descricao: "Soluções e manutenção de lentes.", sinonimos: ["líquido de lentes"] },
  { slug: "ouvidos", nome: "Ouvidos", grupo: "Olhos, ouvidos e boca",
    descricao: "Higiene auricular e cerúmen.", sinonimos: ["cera", "cerúmen", "otológico"] },
  { slug: "higiene-oral", nome: "Higiene oral", grupo: "Olhos, ouvidos e boca",
    descricao: "Escovas, pastas, fio e colutórios.",
    sinonimos: ["dentífrico", "escova de dentes", "elixir", "fio dentário"] },
  { slug: "aftas-e-gengivas", nome: "Aftas e gengivas", grupo: "Olhos, ouvidos e boca",
    descricao: "Aftas, gengivite e desconforto oral.",
    sinonimos: ["afta", "gengivite", "gengivas"] },
  { slug: "dentes-sensiveis", nome: "Dentes sensíveis", grupo: "Olhos, ouvidos e boca",
    descricao: "Hipersensibilidade dentária.", sinonimos: ["sensibilidade dentária"] },

  // ── Mãe e bebé ──────────────────────────────────────────────────────
  { slug: "gravidez-e-amamentacao", nome: "Gravidez e amamentação", grupo: "Mãe e bebé",
    descricao: "Apoio à grávida e à lactação.",
    sinonimos: ["grávida", "lactação", "mamilos", "ácido fólico"] },
  { slug: "alimentacao-infantil", nome: "Alimentação infantil", grupo: "Mãe e bebé",
    descricao: "Leites, papas e biberões.",
    sinonimos: ["leite infantil", "papa", "biberão", "tetina"] },
  { slug: "fralda-e-higiene-bebe", nome: "Fralda e higiene do bebé", grupo: "Mãe e bebé",
    descricao: "Fraldas, toalhitas e cuidado da zona da fralda.",
    sinonimos: ["fralda", "toalhitas", "muda-fraldas", "assaduras"] },
  { slug: "colicas-do-bebe", nome: "Cólicas do bebé", grupo: "Mãe e bebé",
    descricao: "Cólicas e desconforto do lactente.", sinonimos: ["cólicas do lactente"] },
  { slug: "denticao", nome: "Dentição", grupo: "Mãe e bebé",
    descricao: "Erupção dentária no bebé.", sinonimos: ["primeiros dentes", "mordedor"] },

  // ── Bem-estar e prevenção ───────────────────────────────────────────
  { slug: "vitaminas-e-minerais", nome: "Vitaminas e minerais", grupo: "Bem-estar e prevenção",
    descricao: "Suplementação vitamínica e mineral.",
    sinonimos: ["multivitamínico", "vitamina D", "ferro", "magnésio"] },
  { slug: "cansaco-e-energia", nome: "Cansaço e energia", grupo: "Bem-estar e prevenção",
    descricao: "Astenia e fadiga.", sinonimos: ["fadiga", "astenia", "tónico"] },
  { slug: "sono", nome: "Sono", grupo: "Bem-estar e prevenção",
    descricao: "Dificuldade em adormecer.", sinonimos: ["insónia", "melatonina", "dormir"] },
  { slug: "stress-e-ansiedade", nome: "Stress e ansiedade", grupo: "Bem-estar e prevenção",
    descricao: "Nervosismo e tensão do dia-a-dia.", sinonimos: ["nervos", "calmante"] },
  { slug: "defesas-imunitarias", nome: "Defesas imunitárias", grupo: "Bem-estar e prevenção",
    descricao: "Apoio imunitário.", sinonimos: ["imunidade", "vitamina C", "própolis"] },
  { slug: "controlo-de-peso", nome: "Controlo de peso", grupo: "Bem-estar e prevenção",
    descricao: "Gestão de peso e saciedade.", sinonimos: ["emagrecer", "saciedade", "dieta"] },
  { slug: "cessacao-tabagica", nome: "Deixar de fumar", grupo: "Bem-estar e prevenção",
    descricao: "Substituição de nicotina.", sinonimos: ["nicotina", "tabaco", "fumar"] },
  { slug: "saude-sexual", nome: "Saúde sexual", grupo: "Bem-estar e prevenção",
    descricao: "Contraceção de barreira, lubrificantes e testes.",
    sinonimos: ["preservativo", "lubrificante", "teste de gravidez"] },
  { slug: "circulacao-e-pernas", nome: "Circulação e pernas cansadas", grupo: "Bem-estar e prevenção",
    descricao: "Insuficiência venosa e meias de compressão.",
    sinonimos: ["varizes", "meias de compressão", "pernas pesadas"] },
  { slug: "articulacoes-e-ossos", nome: "Articulações e ossos", grupo: "Bem-estar e prevenção",
    descricao: "Apoio articular e ósseo.", sinonimos: ["cálcio", "colagénio", "cartilagem"] },

  // ── Apoio ao doente ─────────────────────────────────────────────────
  { slug: "diabetes", nome: "Diabetes", grupo: "Apoio ao doente",
    descricao: "Medição, agulhas, lancetas e pé diabético.",
    sinonimos: ["glicemia", "tiras", "lancetas", "insulina"] },
  { slug: "tensao-arterial", nome: "Tensão arterial", grupo: "Apoio ao doente",
    descricao: "Medição e apoio cardiovascular.",
    sinonimos: ["tensiómetro", "hipertensão", "pressão arterial"] },
  { slug: "colesterol", nome: "Colesterol", grupo: "Apoio ao doente",
    descricao: "Apoio ao perfil lipídico.", sinonimos: ["lípidos", "esteróis"] },
  { slug: "incontinencia", nome: "Incontinência", grupo: "Apoio ao doente",
    descricao: "Absorventes e resguardos.", sinonimos: ["fralda adulto", "resguardo", "penso"] },
  { slug: "mobilidade-e-ortopedia", nome: "Mobilidade e ortopedia", grupo: "Apoio ao doente",
    descricao: "Ortóteses, canadianas e apoio à marcha.",
    sinonimos: ["joelheira", "pulso", "canadiana", "cinta", "tala"] },
  { slug: "feridas-cronicas", nome: "Feridas crónicas", grupo: "Apoio ao doente",
    descricao: "Úlceras, escaras e penso avançado.",
    sinonimos: ["úlcera", "escara", "pé diabético", "penso avançado"] },
  { slug: "nutricao-clinica", nome: "Nutrição clínica", grupo: "Apoio ao doente",
    descricao: "Suplementação oral em desnutrição ou doença.",
    sinonimos: ["suplemento hiperproteico", "espessante", "nutrição entérica"] },
  { slug: "protecao-e-higiene", nome: "Proteção e higiene", grupo: "Apoio ao doente",
    descricao: "Máscaras, luvas, desinfeção de mãos e superfícies.",
    sinonimos: ["máscara", "luvas", "álcool-gel", "desinfetante de mãos"] },
];

/** Índice por slug. Falha cedo se a lista tiver slugs repetidos. */
export const UTILIZACOES_POR_SLUG: ReadonlyMap<string, Utilizacao> = (() => {
  const m = new Map<string, Utilizacao>();
  for (const u of UTILIZACOES) {
    if (m.has(u.slug)) throw new Error(`Utilizacao com slug repetido: ${u.slug}`);
    m.set(u.slug, u);
  }
  return m;
})();

/**
 * Única porta de entrada para transformar texto em utilização. Devolve
 * null para o que não estiver no vocabulário — é isto que impede que
 * texto livre se torne uma faceta.
 */
export function resolverUtilizacao(termo: string): Utilizacao | null {
  const t = normalizar(termo);
  if (!t) return null;
  for (const u of UTILIZACOES) {
    if (normalizar(u.slug) === t || normalizar(u.nome) === t) return u;
    if (u.sinonimos.some((s) => normalizar(s) === t)) return u;
  }
  return null;
}

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // marcas diacriticas
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
