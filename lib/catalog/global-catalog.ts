/**
 * lib/catalog/global-catalog.ts
 *
 * Regras do catálogo global por CNP. Puro: sem base de dados, sem rede.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O PROBLEMA
 *
 * O mesmo CNP é o mesmo produto nacional. Enriquecer o Ozempic uma vez
 * por farmácia é pagar N vezes pela mesma conclusão — e, pior, deixar as
 * N farmácias chegarem a conclusões diferentes sem que nada o detecte.
 *
 * ─────────────────────────────────────────────────────────────────────
 * AS DUAS DIRECÇÕES, E PORQUE NÃO SÃO SIMÉTRICAS
 *
 * PROMOÇÃO (tenant → global) é sobre AUTORIDADE: entre dois
 * conhecimentos sobre o mesmo CNP, fica o de origem mais forte.
 *
 * PROJECÇÃO (global → tenant) é sobre NÃO ESTRAGAR: o tenant pode ter
 * razão por conhecer o que aquela farmácia vende, e o global pode estar
 * errado. Por isso a projecção nunca sobrepõe uma classificação
 * específica — levanta uma revisão e deixa como está.
 *
 * A assimetria é deliberada. Um erro global propagado a todas as
 * farmácias é o risco novo que esta camada introduz, e as regras de
 * projecção existem para o conter.
 */

/** Origem do conhecimento, por ordem de autoridade. */
export type OrigemGlobal = "HUMANO" | "REGULATORY" | "MODELO" | "PROPAGADO";

/**
 * Menor é mais autoritário — a mesma convenção do `SOURCE_TIER_RANK`.
 *
 * HUMANO em primeiro porque uma validação manual é a única coisa aqui
 * que alguém assinou. REGULATORY antes de MODELO porque o INFARMED sabe
 * o que registou e o modelo sabe o que leu. PROPAGADO em último porque
 * não é sequer uma observação deste produto — é a conclusão sobre um
 * irmão, aplicada aqui.
 */
export const ORIGEM_RANK: Readonly<Record<OrigemGlobal, number>> = {
  HUMANO: 0,
  REGULATORY: 1,
  MODELO: 2,
  PROPAGADO: 3,
};

export function maisAutoritaria(a: OrigemGlobal, b: OrigemGlobal): OrigemGlobal {
  return ORIGEM_RANK[a] <= ORIGEM_RANK[b] ? a : b;
}

/** Um "Outros <X>" não é conhecimento — é a ausência dele. */
export function ehEspecifica(subcategoria: string | null | undefined): boolean {
  return !!subcategoria && !/^outros\b/i.test(subcategoria);
}

// ─── Promoção: tenant → global ────────────────────────────────────────

export type ConhecimentoCandidato = {
  cnp: number;
  designacaoReferencia: string;
  productType: string | null;
  categoria: string | null;
  subcategoria: string | null;
  utilizacoes: Array<{ slug: string; confidence: number }>;
  confidence: number;
  evidenceType: string | null;
  origem: OrigemGlobal;
  versaoRegras: string;
  verificado: boolean;
  tenantOrigem: string;
};

export type ConhecimentoGlobal = {
  cnp: number;
  categoria: string | null;
  subcategoria: string | null;
  productType: string | null;
  confidence: number;
  origem: OrigemGlobal;
  versaoRegras: string;
  verificado: boolean;
  utilizacoes: Array<{ slug: string; confidence: number; origem: OrigemGlobal }>;
};

export type DecisaoPromocao = {
  promover: boolean;
  motivo: string;
};

/**
 * Vale a pena promover este conhecimento ao global?
 *
 * Regras, e todas dizem "não" mais vezes do que "sim":
 *  · sem par (categoria, subcategoria) específico não há o que promover —
 *    um fallback não é conhecimento;
 *  · o que já está no global só cede a origem MAIS autoritária, ou à
 *    mesma origem com confiança estritamente superior;
 *  · nunca se rebaixa a origem: um MODELO não substitui um HUMANO, por
 *    mais confiante que venha.
 */
export function avaliarPromocao(
  candidato: ConhecimentoCandidato,
  global: ConhecimentoGlobal | null,
): DecisaoPromocao {
  if (!ehEspecifica(candidato.subcategoria) || !candidato.categoria) {
    return { promover: false, motivo: "sem classificação específica — um fallback não é conhecimento" };
  }
  if (!global) {
    return { promover: true, motivo: "cnp ainda não conhecido globalmente" };
  }

  const rankNovo = ORIGEM_RANK[candidato.origem];
  const rankActual = ORIGEM_RANK[global.origem];

  if (rankNovo < rankActual) {
    return { promover: true, motivo: `origem mais autoritária: ${candidato.origem} > ${global.origem}` };
  }
  if (rankNovo > rankActual) {
    return { promover: false, motivo: `origem menos autoritária que a global (${candidato.origem} < ${global.origem})` };
  }
  // Mesma origem: só a confiança desempata, e tem de ser estritamente
  // maior — empate mantém o que lá está, para que reprocessar não gere
  // escrita nem mude nada.
  if (candidato.confidence > global.confidence) {
    return { promover: true, motivo: `mesma origem, confiança superior (${candidato.confidence.toFixed(2)} > ${global.confidence.toFixed(2)})` };
  }
  return { promover: false, motivo: "o global já tem conhecimento igual ou melhor" };
}

// ─── Projecção: global → tenant ───────────────────────────────────────

export type EstadoLocal = {
  cnp: number;
  validadoManualmente: boolean;
  categoria: string | null;
  subcategoria: string | null;
  productType: string | null;
  /** Utilizações que o produto já tem no tenant. */
  utilizacoes: Array<{ slug: string; fonte: string; confianca: number | null }>;
};

export type AccaoProjeccao =
  /** Escrever categoria/subcategoria no tenant. */
  | "ESCREVER_CLASSIFICACAO"
  /** Não escrever nada e não reportar: já está igual. */
  | "NO_OP"
  /** Não escrever; abrir CatalogoGlobalRevisao. */
  | "REVISAO"
  /** Não tocar, nem reportar: decisão humana local. */
  | "INTOCAVEL";

export type DecisaoProjeccao = {
  accao: AccaoProjeccao;
  /** Slugs a escrever. Vazio quando nenhum passa. */
  utilizacoes: string[];
  /** Preencher productType? Só quando falta no tenant. */
  escreverProductType: boolean;
  motivo: string;
  /** Preenchido quando a acção é REVISAO. */
  revisao: { tipo: string; valorGlobal: string; valorLocal: string } | null;
};

/**
 * O que fazer com este CNP neste tenant.
 *
 * A ordem das guardas é significativa:
 *  1. `validadoManualmente` — nem se lê o resto. Uma decisão humana no
 *     tenant não é matéria para o global opinar.
 *  2. classificação específica IGUAL — no-op silencioso, que é o caso
 *     mais comum numa segunda corrida.
 *  3. classificação específica DIFERENTE — revisão, nunca escrita. É
 *     aqui que se contém o risco novo desta camada: um erro global não
 *     pode degradar uma classificação específica local.
 *  4. NULL ou "Outros <X>" — pode receber.
 *
 * As utilizações seguem em paralelo e com a sua própria regra: MANUAL é
 * intocável, e uma automática só cede a confiança estritamente superior.
 * A autoridade do que vem do global é sempre inferior à de uma decisão
 * directa sobre este produto neste tenant — por isso a confiança
 * projectada entra reduzida (ver FATOR_PROJECCAO).
 */
export const FATOR_PROJECCAO = 0.99;

export function avaliarProjeccao(
  global: ConhecimentoGlobal,
  local: EstadoLocal,
): DecisaoProjeccao {
  const nada = { utilizacoes: [] as string[], escreverProductType: false, revisao: null };

  if (local.validadoManualmente) {
    return { ...nada, accao: "INTOCAVEL", motivo: "validadoManualmente no tenant" };
  }

  // Utilizações: decididas independentemente da classificação. Um
  // produto pode ter a classificação certa e faltarem-lhe etiquetas.
  const porSlug = new Map(local.utilizacoes.map((u) => [u.slug, u]));
  const utilizacoes = global.utilizacoes
    .filter((g) => {
      const jaLa = porSlug.get(g.slug);
      if (!jaLa) return true;
      if (jaLa.fonte === "MANUAL") return false;
      return g.confidence * FATOR_PROJECCAO > (jaLa.confianca ?? 0);
    })
    .map((g) => g.slug);

  const escreverProductType = !local.productType && !!global.productType;

  if (ehEspecifica(local.subcategoria)) {
    const igual =
      local.categoria === global.categoria && local.subcategoria === global.subcategoria;
    if (igual) {
      return {
        ...nada,
        utilizacoes,
        escreverProductType,
        accao: utilizacoes.length > 0 || escreverProductType ? "ESCREVER_CLASSIFICACAO" : "NO_OP",
        motivo: igual && utilizacoes.length === 0 ? "já igual ao global" : "classificação igual; faltavam utilizações",
      };
    }
    return {
      ...nada,
      accao: "REVISAO",
      motivo: "o tenant tem uma classificação específica diferente da global",
      revisao: {
        tipo: "CLASSIFICACAO",
        valorGlobal: `${global.categoria} > ${global.subcategoria}`,
        valorLocal: `${local.categoria} > ${local.subcategoria}`,
      },
    };
  }

  if (!ehEspecifica(global.subcategoria) || !global.categoria) {
    return { ...nada, utilizacoes, escreverProductType, accao: utilizacoes.length > 0 || escreverProductType ? "ESCREVER_CLASSIFICACAO" : "NO_OP", motivo: "o global também não tem classificação específica" };
  }

  return {
    ...nada,
    utilizacoes,
    escreverProductType,
    accao: "ESCREVER_CLASSIFICACAO",
    motivo: local.subcategoria ? "local em fallback — recebe do global" : "local sem classificação — recebe do global",
  };
}

/**
 * O conhecimento global está actualizado face à versão de regras actual?
 *
 * Serve para reprojectar só o que ficou para trás quando a versão sobe,
 * em vez de reprocessar tudo.
 */
export function estaDesactualizado(global: ConhecimentoGlobal, versaoActual: string): boolean {
  return global.versaoRegras !== versaoActual;
}
