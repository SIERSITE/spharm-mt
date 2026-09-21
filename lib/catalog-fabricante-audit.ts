/**
 * lib/catalog-fabricante-audit.ts
 *
 * Diagnóstico de possíveis duplicados/denominações desactualizadas em
 * `Fabricante` — a base do relatório pedido: ID, denominação actual,
 * nº de produtos, denominação oficial mais actual, relação entre as
 * entidades, fonte da validação, grau de confiança, acção recomendada.
 *
 * ── Duas fontes de sinal, NUNCA misturadas na mesma confiança ────────
 *
 *   1. `IDENTIDADES_CONHECIDAS` — uma tabela CURADA à mão, cada entrada
 *      com uma fonte oficial/credível verificada (site da empresa,
 *      registo comercial, INFARMED). É a ÚNICA fonte que pode produzir
 *      confiança ALTA e a acção "unificar"/"atualizar denominação".
 *      Sem entrada aqui, nunca há unificação automática — só a
 *      pesquisa manual pode adicionar uma entrada nova, com a fonte.
 *
 *   2. Semelhança textual entre nomes canónicos (`similaridadeNomes`)
 *      — heurística de apoio, NUNCA prova identidade. Um par
 *      textualmente parecido entra sempre como "analisar manualmente"
 *      com confiança BAIXA, nunca "unificar". E o inverso também é
 *      verdade e importante: duas denominações da MESMA empresa podem
 *      ser textualmente muito diferentes (o próprio caso "Alfa
 *      Wassermann" → "Alfasigma" não partilha nenhuma palavra
 *      significativa) — por isso a tabela curada existe: a
 *      identidade real de uma empresa não se infere do texto do nome.
 *
 * Tudo aqui é PURO — sem Prisma, sem rede. A leitura da BD vive em
 * `scripts/audit-fabricantes-duplicados.ts`.
 */

export type FabricanteResumo = {
  id: string;
  /** `Fabricante.nomeNormalizado` — já na forma canónica (normalizeFabricanteCanonico). */
  nomeNormalizado: string;
  estado: "ATIVO" | "INATIVO";
  numProdutos: number;
  aliases: string[];
};

export type GrauConfianca = "ALTA" | "MEDIA" | "BAIXA";

export type AcaoRecomendada =
  | "manter"
  | "atualizar_denominacao"
  | "unificar"
  | "analisar_manualmente";

/**
 * A situação, na terminologia exacta pedida — distinta da acção
 * MECÂNICA (`AcaoRecomendada`, o que a ferramenta faz). Duas entradas
 * podem ter a mesma acção ("unificar") por razões diferentes: uma
 * mudança de nome e uma fusão resultam ambas em "unificar", mas a
 * justificação apresentada ao utilizador tem de dizer QUAL das duas é.
 */
export type Situacao =
  | "atual"                 // continua a denominação certa, não mexer
  | "mudanca_nome"          // mesma entidade jurídica, nome diferente
  | "fusao"                 // duas+ entidades fundiram-se numa sucessora
  | "incorporacao"          // entidade absorvida por outra já existente
  | "mesmo_grupo_distinto"  // mesmo grupo, entidades continuam distintas — NUNCA unificar
  | "analise_manual";       // sinal insuficiente para decidir

/**
 * Uma correspondência JÁ VALIDADA contra fonte oficial/credível — nunca
 * inferida só por semelhança de texto. `antigos` são as formas
 * canónicas (após `normalizeFabricanteCanonico`) que são a MESMA
 * entidade jurídica que `canonico` (a denominação oficial mais actual).
 *
 * Adicionar uma entrada aqui é uma decisão humana, com fonte citada —
 * exactamente o processo que produziu a entrada Alfa Wassermann/
 * Alfasigma abaixo (pesquisa em 2026-09-21, ver `fonte`).
 */
export type IdentidadeConhecida = {
  antigos: readonly string[];
  canonico: string;
  situacao: Situacao;
  relacao: string;
  fonte: string;
  confianca: GrauConfianca;
  nota: string;
};

export const IDENTIDADES_CONHECIDAS: readonly IdentidadeConhecida[] = [
  {
    antigos: [
      "ALFA WASSERMANN PRODUTOS FARMACEUTICOS LDA",
      "BIOSAUDE PRODUTOS FARMACEUTICOS LDA",
    ],
    canonico: "ALFASIGMA PORTUGAL LDA",
    // Mudança de nome, não fusão: o NIF português (502857722) manteve-se
    // o MESMO nas três denominações — a entidade jurídica portuguesa
    // nunca se fundiu com outra entidade portuguesa. A fusão real
    // (Alfa Wassermann + Sigma-Tau → Alfasigma) aconteceu ao nível do
    // GRUPO em Itália, em 2015-2017; a filial portuguesa foi só
    // renomeada a seguir, em 2018, para reflectir a nova marca do grupo.
    situacao: "mudanca_nome",
    relacao: "Mesma entidade jurídica (mesmo NIF), renomeada — não é grupo, não é titular de AIM distinto, não é distribuidor separado.",
    fonte:
      "Site oficial pt.alfasigma.com/quem-somos/o-nosso-legado/ (histórico da empresa) + " +
      "einforma.pt (registo comercial português, NIF 502857722, denominações anteriores). " +
      "Consultado em 2026-09-21.",
    confianca: "ALTA",
    nota:
      "Mesmo NIF (502857722) nas três denominações sucessivas: \"BioSaúde – Produtos " +
      "Farmacêuticos, Lda.\" (constituída 1992) → \"Alfa Wassermann – Produtos " +
      "Farmacêuticos, Lda.\" (2013, após a Alfa Wassermann adquirir a totalidade do " +
      "capital em 2005) → \"Alfasigma Portugal, Lda.\" (Abril/2018, depois de a fusão " +
      "Alfa Wassermann + Sigma-Tau ter criado o GRUPO Alfasigma em 2015-2017 — a fusão " +
      "foi ao nível do grupo, a filial PT só mudou de nome). \"BioSaúde\" só é relevante " +
      "se existir alguma linha residual com essa grafia — não confirmado sem acesso à " +
      "BD viva do tenant Garantia.",
  },
];

/** Índice `nome antigo canónico → entrada curada`, para lookup O(1). */
const INDICE_IDENTIDADES: ReadonlyMap<string, IdentidadeConhecida> = new Map(
  IDENTIDADES_CONHECIDAS.flatMap((e) => e.antigos.map((antigo) => [antigo, e] as const)),
);

/**
 * Pares CONFIRMADOS como mesmo grupo empresarial mas entidades jurídicas
 * DISTINTAS — nunca a unificar, apesar de o nome ser parecido (e de a
 * heurística de semelhança, sozinha, os poder sinalizar como
 * candidatos). Existe para que este par pare de aparecer como "por
 * validar" — a validação já foi feita, e a conclusão foi "não mexer".
 */
export type IdentidadeGrupoDistinta = {
  nomeA: string;
  nomeB: string;
  motivo: string;
  fonte: string;
  confianca: GrauConfianca;
};

export const IDENTIDADES_MESMO_GRUPO_DISTINTAS: readonly IdentidadeGrupoDistinta[] = [
  {
    nomeA: "ALFASIGMA PORTUGAL LDA",
    nomeB: "ALFASIGMA S P A",
    motivo:
      "Mesmo grupo (Alfasigma), entidades jurídicas distintas: \"Alfasigma S.p.A.\" é a casa-mãe " +
      "italiana, titular AIM directo de alguns medicamentos comercializados em Portugal (ex.: " +
      "Anafranil, Zaditen, Syntocinon); \"Alfasigma Portugal, Lda.\" é a filial portuguesa, " +
      "titular AIM de outros (ex.: Sodolac, Exodolan, Lacteol, Vasilium, Plaquinol). Os dois " +
      "continuam activos, cada um com o seu próprio conjunto de produtos — nunca unificar.",
    fonte:
      "example_files/fabricante.csv (listagem nacional de titulares AIM, formato regulatório) — " +
      "os dois nomes aparecem em CNP diferentes, de forma consistente e não sobreposta.",
    confianca: "ALTA",
  },
];

const INDICE_GRUPO_DISTINTO: ReadonlyMap<string, IdentidadeGrupoDistinta> = new Map(
  IDENTIDADES_MESMO_GRUPO_DISTINTAS.flatMap((e) => [
    [e.nomeA, e] as const,
    [e.nomeB, e] as const,
  ]),
);

/** Sufixos societários que não devem pesar na comparação de semelhança (senão "BAYER LDA" e "PFIZER LDA" pareceriam parecidos só pelo "LDA"). */
const SUFIXOS_SOCIETARIOS = new Set([
  "LDA", "SA", "S", "A", "GMBH", "LTD", "INC", "LLC", "PLC", "SRL", "NV", "BV", "SARL", "AG", "L", "UNIPESSOAL",
]);

function tokensSignificativos(nomeCanonico: string): Set<string> {
  return new Set(nomeCanonico.split(" ").filter((t) => t.length > 0 && !SUFIXOS_SOCIETARIOS.has(t)));
}

/**
 * Semelhança textual entre dois nomes JÁ CANÓNICOS — Jaccard sobre
 * tokens significativos (sufixos societários excluídos). 0..1, nunca
 * usada para concluir identidade sozinha — só para sinalizar um par
 * como candidato a revisão manual.
 */
export function similaridadeNomes(a: string, b: string): number {
  const ta = tokensSignificativos(a);
  const tb = tokensSignificativos(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersecao = 0;
  for (const t of ta) if (tb.has(t)) intersecao++;
  const uniao = ta.size + tb.size - intersecao;
  return uniao === 0 ? 0 : intersecao / uniao;
}

/** Abaixo disto, um par nem entra como candidato de semelhança textual — ruído. */
export const LIMIAR_SIMILARIDADE_CANDIDATA = 0.5;

export type LinhaRelatorioFabricante = {
  id: string;
  nomeAtual: string;
  numProdutos: number;
  denominacaoOficial: string | null;
  situacao: Situacao;
  relacao: string;
  fonte: string;
  confianca: GrauConfianca | "—";
  acao: AcaoRecomendada;
  /** Só preenchido quando a acção veio de semelhança textual, nunca da tabela curada. */
  candidatosPorSemelhanca?: { nome: string; score: number }[];
};

/**
 * Classifica UM fabricante ATIVO contra a tabela curada + semelhança
 * textual com os restantes ATIVOS. Pura — o chamador já trouxe a lista
 * completa de fabricantes ativos (`todosAtivos`) para a comparação de
 * semelhança.
 */
export function classificarFabricante(
  f: FabricanteResumo,
  todosAtivos: readonly FabricanteResumo[],
): LinhaRelatorioFabricante {
  const conhecido = INDICE_IDENTIDADES.get(f.nomeNormalizado);
  if (conhecido) {
    // Existe já uma linha ATIVA com a denominação oficial? Se sim, é um
    // caso de UNIFICAR (duas linhas, mesma empresa). Se não, é só
    // ACTUALIZAR a denominação desta própria linha (não há para onde
    // unificar — esta é a única linha desta empresa no tenant).
    const existeCanonico = todosAtivos.some(
      (o) => o.id !== f.id && o.nomeNormalizado === conhecido.canonico,
    );
    return {
      id: f.id,
      nomeAtual: f.nomeNormalizado,
      numProdutos: f.numProdutos,
      denominacaoOficial: conhecido.canonico,
      situacao: conhecido.situacao,
      relacao: conhecido.relacao,
      fonte: conhecido.fonte,
      confianca: conhecido.confianca,
      acao: existeCanonico ? "unificar" : "atualizar_denominacao",
    };
  }

  // É a PRÓPRIA denominação oficial de uma entrada curada? Então esta
  // linha é o alvo — mantém-se (a acção de unificar/actualizar é
  // reportada do LADO da linha antiga, não deste lado).
  const eAlvoDeUnificacao = IDENTIDADES_CONHECIDAS.some((e) => e.canonico === f.nomeNormalizado);
  if (eAlvoDeUnificacao) {
    return {
      id: f.id,
      nomeAtual: f.nomeNormalizado,
      numProdutos: f.numProdutos,
      denominacaoOficial: f.nomeNormalizado,
      situacao: "atual",
      relacao: "Denominação oficial mais actual (alvo de unificação de outra(s) linha(s)).",
      fonte: IDENTIDADES_CONHECIDAS.find((e) => e.canonico === f.nomeNormalizado)!.fonte,
      confianca: "ALTA",
      acao: "manter",
    };
  }

  // Mesmo grupo, entidade CONFIRMADA como distinta — validação já feita,
  // conclusão foi "não mexer". Reportado com confiança ALTA (é uma
  // conclusão validada, não uma dúvida) mas acção "manter".
  const grupoDistinto = INDICE_GRUPO_DISTINTO.get(f.nomeNormalizado);
  if (grupoDistinto) {
    return {
      id: f.id,
      nomeAtual: f.nomeNormalizado,
      numProdutos: f.numProdutos,
      denominacaoOficial: f.nomeNormalizado,
      situacao: "mesmo_grupo_distinto",
      relacao: grupoDistinto.motivo,
      fonte: grupoDistinto.fonte,
      confianca: grupoDistinto.confianca,
      acao: "manter",
    };
  }

  // Sem entrada curada — só semelhança textual, sempre "analisar
  // manualmente" quando há candidatos, nunca uma acção mais forte.
  const candidatos = todosAtivos
    .filter((o) => o.id !== f.id)
    .map((o) => ({ nome: o.nomeNormalizado, score: similaridadeNomes(f.nomeNormalizado, o.nomeNormalizado) }))
    .filter((c) => c.score >= LIMIAR_SIMILARIDADE_CANDIDATA)
    .sort((a, b) => b.score - a.score);

  if (candidatos.length > 0) {
    return {
      id: f.id,
      nomeAtual: f.nomeNormalizado,
      numProdutos: f.numProdutos,
      denominacaoOficial: null,
      situacao: "analise_manual",
      relacao: "Semelhança textual com outra(s) denominação(ões) — NÃO validado; pode ser a mesma empresa, um grupo diferente, ou coincidência de nome.",
      fonte: "Heurística de semelhança de texto (Jaccard sobre tokens) — não é fonte credível por si só.",
      confianca: "BAIXA",
      acao: "analisar_manualmente",
      candidatosPorSemelhanca: candidatos,
    };
  }

  return {
    id: f.id,
    nomeAtual: f.nomeNormalizado,
    numProdutos: f.numProdutos,
    denominacaoOficial: f.nomeNormalizado,
    situacao: "atual",
    relacao: "Sem sinal de duplicação conhecido.",
    fonte: "—",
    confianca: "—",
    acao: "manter",
  };
}
