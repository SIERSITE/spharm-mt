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
 *
 * ─────────────────────────────────────────────────────────────────────
 * A VALIDAÇÃO MANUAL LOCAL NÃO SOBE SOZINHA
 *
 * Uma pessoa numa farmácia que corrige um produto está a dizer «neste
 * balcão isto é assim». Não está a dizer «isto é assim em Portugal», e
 * muito menos a assumir a responsabilidade de o impor às outras
 * farmácias. As duas frases são diferentes, e tratá-las como iguais
 * transformaria cada correcção local — feita à pressa, ao balcão, sem
 * saber que existe um catálogo nacional — em verdade para toda a gente.
 *
 * Por isso `HUMANO` é a única origem que NÃO promove automaticamente:
 * precisa de uma aprovação explícita, com quem e porquê (ver
 * `AprovacaoHumana` e o comando `catalog:promote-global`). O conhecimento
 * inferido e o regulamentar continuam a subir pelas regras de sempre.
 */

/** Origem do conhecimento, por ordem de autoridade. */
export type OrigemGlobal = "HUMANO" | "REGULATORY" | "DETERMINISTICA" | "MODELO" | "PROPAGADO";

/**
 * Menor é mais autoritário — a mesma convenção do `SOURCE_TIER_RANK`, e
 * a ordem é a projecção fiel dele:
 *
 *   REGULATORY(0) … INTERNAL_INFERRED(4) … MODEL_INFERRED(5) … MODEL_PROPAGATED(6)
 *   REGULATORY(1) … DETERMINISTICA(2)    … MODELO(3)         … PROPAGADO(4)
 *
 * HUMANO em primeiro porque uma validação manual é a única coisa aqui
 * que alguém assinou. REGULATORY antes de tudo o resto porque o INFARMED
 * sabe o que registou.
 *
 * DETERMINISTICA acima de MODELO não é opinião nova: o `SOURCE_TIER_RANK`
 * já põe `INTERNAL_INFERRED` acima de `MODEL_INFERRED`. Uma regra nossa é
 * auditável e reproduzível; o modelo é nem uma coisa nem outra.
 *
 * PROPAGADO em último porque não é sequer uma observação deste produto —
 * é a conclusão sobre um irmão, aplicada aqui.
 */
export const ORIGEM_RANK: Readonly<Record<OrigemGlobal, number>> = {
  HUMANO: 0,
  REGULATORY: 1,
  DETERMINISTICA: 2,
  MODELO: 3,
  PROPAGADO: 4,
};

// ─── De onde veio, mesmo ──────────────────────────────────────────────

/**
 * O resultado de tentar dar origem global a uma fonte do tenant. Quando
 * `origem` é null, NÃO se promove — e o motivo diz porquê, para o
 * relatório o poder contar em vez de o esconder.
 *
 * Nunca há palpite: uma fonte que não esteja nesta tabela sai daqui como
 * null. O defeito que isto corrige era exactamente o oposto — um `else`
 * final que carimbava MODELO em tudo o que não reconhecia.
 */
export type Mapeamento = {
  origem: OrigemGlobal | null;
  motivo: string;
};

/**
 * Marca que a projecção deixa em `KnowledgeEnrichmentCache.origem` do
 * tenant, e que `ProdutoUtilizacao.fonte` já usava. É o que permite
 * distinguir, mais tarde, o que o tenant sabe do que lhe foi dito.
 */
export const ORIGEM_CACHE_GLOBAL = "CATALOGO_GLOBAL";

/**
 * A PROVENIÊNCIA DA CLASSIFICAÇÃO (nível 1 / nível 2) DE UM PRODUTO.
 *
 * ATENÇÃO ao que NÃO serve para isto: `Produto.classificationSource`.
 * Essa coluna descreve como se decidiu o `productType`
 * (MEDICAMENTO/SUPLEMENTO/…), escrita pelo classificador e pelo
 * `classify-backfill`. Quem escreve a classificação N1/N2 é o
 * `fill-rules`, que não lhe toca. São duas decisões diferentes e a base
 * só guarda proveniência para uma delas.
 *
 * Portanto a proveniência da classificação deriva-se do que existe:
 *   · `validadoManualmente`                     → HUMANO
 *   · KnowledgeEnrichmentCache persistido       → MODELO / PROPAGADO
 *   · senão                                     → DETERMINISTICA
 *
 * O último caso é o `fill-rules`: regras nossas sobre ATC, DCI, tipo de
 * artigo e padrões da designação. Determinístico, auditável, e a coisa
 * mais comum no catálogo — chamar-lhe MODELO era falso.
 */
export function origemDaClassificacao(p: {
  validadoManualmente: boolean;
  cacheOrigem: string | null;
}): Mapeamento {
  if (p.validadoManualmente) {
    return { origem: "HUMANO", motivo: "validadoManualmente no tenant" };
  }
  if (p.cacheOrigem === "PROPAGADO") {
    return { origem: "PROPAGADO", motivo: "conclusão do modelo sobre um irmão da família" };
  }
  if (p.cacheOrigem === "CLAUDE") {
    return { origem: "MODELO", motivo: "decisão do modelo sobre este cnp" };
  }
  // Esta classificação VEIO do catálogo global. Repromovê-la fecharia um
  // ciclo de lavagem: o `project-global` escreve-a no tenant, o
  // `bootstrap-global` volta a lê-la — já indistinguível de uma regra
  // local — e promove-a como DETERMINISTICA, que é MAIS autoritária que
  // o MODELO que a produziu. O global passaria a acreditar que uma
  // inferência do modelo era uma regra determinística, só por ter dado a
  // volta a um tenant. Concordar não é uma fonte independente.
  if (p.cacheOrigem === ORIGEM_CACHE_GLOBAL) {
    return { origem: null, motivo: "veio do catálogo global — não se repromove" };
  }
  if (p.cacheOrigem) {
    return { origem: null, motivo: `origem de cache por mapear: ${p.cacheOrigem}` };
  }
  return { origem: "DETERMINISTICA", motivo: "regras determinísticas do catálogo (fill-rules)" };
}

/**
 * A proveniência de UMA UTILIZAÇÃO, a partir de `ProdutoUtilizacao.fonte`.
 *
 * Cada associação tem a sua: um produto pode ter a classificação vinda de
 * uma regra e uma etiqueta posta à mão. Tratar o produto todo pela fonte
 * mais forte de qualquer uma das partes — como se fazia — contaminava as
 * duas.
 */
export function origemDaUtilizacao(fonte: string | null): Mapeamento {
  switch ((fonte ?? "").toUpperCase()) {
    case "MANUAL":
      return { origem: "HUMANO", motivo: "associação manual" };
    case "REGRA":
      return { origem: "DETERMINISTICA", motivo: "regra do catálogo" };
    case "MODELO":
      return { origem: "MODELO", motivo: "decisão do modelo" };
    case "MODELO_PROPAGADO":
      return { origem: "PROPAGADO", motivo: "propagada de um irmão da família" };
    // Veio DO catálogo global. Repromovê-la fecharia um ciclo: o global
    // reaprenderia de si próprio, e com a autoridade do tenant.
    case "CATALOGO_GLOBAL":
      return { origem: null, motivo: "já veio do catálogo global — não se repromove" };
    // "ERP" é como AQUELA farmácia arruma o produto no sistema dela. Pode
    // valer nacionalmente ou não, e a base não diz qual. Sem mapeamento.
    default:
      return { origem: null, motivo: `fonte de utilização sem mapeamento seguro: ${fonte ?? "(nula)"}` };
  }
}

export function maisAutoritaria(a: OrigemGlobal, b: OrigemGlobal): OrigemGlobal {
  return ORIGEM_RANK[a] <= ORIGEM_RANK[b] ? a : b;
}

/** Um "Outros <X>" não é conhecimento — é a ausência dele. */
export function ehEspecifica(subcategoria: string | null | undefined): boolean {
  return !!subcategoria && !/^outros\b/i.test(subcategoria);
}

// ─── Promoção: tenant → global ────────────────────────────────────────

/** Uma utilização candidata, com a SUA própria proveniência. */
export type UtilizacaoCandidata = {
  slug: string;
  confidence: number;
  /** null = fonte sem mapeamento seguro; não sobe. */
  origem: OrigemGlobal | null;
  /** O valor cru de `ProdutoUtilizacao.fonte`, para o relatório. */
  fonteOriginal: string | null;
  motivo: string;
};

export type ConhecimentoCandidato = {
  cnp: number;
  designacaoReferencia: string;
  productType: string | null;
  categoria: string | null;
  subcategoria: string | null;
  utilizacoes: UtilizacaoCandidata[];
  confidence: number;
  evidenceType: string | null;
  /** Origem da CLASSIFICAÇÃO. null = por mapear; não sobe. */
  origem: OrigemGlobal | null;
  /** Motivo do mapeamento — vai para o relatório, promova ou não. */
  motivoOrigem: string;
  /**
   * `Produto.classificationSource` cru. NÃO é a proveniência da
   * classificação (ver `origemDaClassificacao`) — é a do `productType`.
   * Guarda-se para não se perder a única proveniência que a base tem.
   */
  fonteOriginal: string | null;
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

/**
 * A decisão tem DUAS PARTES INDEPENDENTES, e é essa a correcção de fundo.
 *
 * Antes, um produto sem classificação específica era recusado inteiro — e
 * levava com ele utilizações clínicas perfeitamente boas. Mas as duas
 * coisas não dependem uma da outra: saber que um produto serve para
 * "diabetes" é conhecimento nacional válido mesmo quando ninguém sabe
 * ainda em que prateleira o arrumar.
 *
 * `CatalogoGlobalUtilizacao` tem chave estrangeira para `CatalogoGlobal`,
 * portanto a linha do produto continua a ter de existir — mas pode
 * existir com categoria e subcategoria a NULL.
 */
export type DecisaoPromocao = {
  /** Promove ALGUMA coisa: classificação, utilizações, ou ambas. */
  promover: boolean;
  classificacao: {
    promover: boolean;
    motivo: string;
    /**
     * Não subiu apenas porque falta a aprovação humana — o resto das
     * regras deixava passar. Distingue "recusado" de "à espera de
     * alguém", que são coisas diferentes no relatório.
     */
    aguardaAprovacao: boolean;
  };
  utilizacoes: {
    promover: UtilizacaoCandidata[];
    recusadas: Array<{ slug: string; motivo: string; aguardaAprovacao: boolean }>;
  };
  /** Resumo, para contadores e para o rasto: o motivo da classificação. */
  motivo: string;
  aguardaAprovacao?: boolean;
};

/**
 * Autorização explícita para levar conhecimento de origem HUMANO ao
 * catálogo global. Sem isto, uma validação manual local fica local.
 *
 * Os dois campos são obrigatórios e é de propósito: quem responde por
 * isto, e porquê. Uma aprovação sem motivo é um carimbo, e um carimbo
 * não se audita.
 */
export type AprovacaoHumana = {
  aprovador: string;
  motivo: string;
};

export type ContextoPromocao = {
  aprovacao?: AprovacaoHumana | null;
};

/** Esta origem exige aprovação explícita para subir ao global? */
export function precisaAprovacaoHumana(origem: OrigemGlobal | null): boolean {
  return origem === "HUMANO";
}

export function aprovacaoValida(
  a: AprovacaoHumana | null | undefined,
): a is AprovacaoHumana {
  return !!a && a.aprovador.trim().length > 0 && a.motivo.trim().length > 0;
}

type ParteDecidida = { promover: boolean; motivo: string; aguardaAprovacao: boolean };

const recusa = (motivo: string, aguardaAprovacao = false): ParteDecidida =>
  ({ promover: false, motivo, aguardaAprovacao });

/** A guarda de aprovação, igual para a classificação e para cada utilização. */
function faltaAprovacao(origem: OrigemGlobal | null, ctx: ContextoPromocao): string | null {
  if (!precisaAprovacaoHumana(origem)) return null;
  if (aprovacaoValida(ctx.aprovacao)) return null;
  return ctx.aprovacao
    ? "aprovação humana incompleta: exige aprovador E motivo"
    : "validação manual local não sobe sozinha — exige promoção humana explícita (catalog:promote-global)";
}

function decidirClassificacao(
  c: ConhecimentoCandidato,
  global: ConhecimentoGlobal | null,
  ctx: ContextoPromocao,
): ParteDecidida {
  if (!c.origem) return recusa(c.motivoOrigem);

  const semAprovacao = faltaAprovacao(c.origem, ctx);
  if (semAprovacao) return recusa(semAprovacao, true);

  if (!ehEspecifica(c.subcategoria) || !c.categoria) {
    return recusa("sem classificação específica — um fallback não é conhecimento");
  }
  if (!global) {
    return { promover: true, motivo: "cnp ainda não conhecido globalmente", aguardaAprovacao: false };
  }

  const rankNovo = ORIGEM_RANK[c.origem];
  const rankActual = ORIGEM_RANK[global.origem];

  if (rankNovo < rankActual) {
    return { promover: true, motivo: `origem mais autoritária: ${c.origem} > ${global.origem}`, aguardaAprovacao: false };
  }
  if (rankNovo > rankActual) {
    return recusa(`origem menos autoritária que a global (${c.origem} < ${global.origem})`);
  }
  // Mesma origem e classificação DIFERENTE: só a confiança desempata, e
  // tem de ser estritamente maior — empate mantém o que lá está, para
  // que reprocessar não gere escrita nem mude nada.
  if (c.confidence > global.confidence) {
    return {
      promover: true,
      motivo: `mesma origem, confiança superior (${c.confidence.toFixed(2)} > ${global.confidence.toFixed(2)})`,
      aguardaAprovacao: false,
    };
  }
  return recusa("o global já tem conhecimento igual ou melhor");
}

/**
 * Vale a pena promover este conhecimento ao global?
 *
 * Decide as DUAS partes em separado — ver `DecisaoPromocao`. As regras de
 * cada uma dizem "não" mais vezes do que "sim":
 *
 *  · origem por mapear NÃO sobe: não se carimba nada por conveniência;
 *  · uma decisão humana NÃO sobe sem aprovação explícita;
 *  · uma classificação precisa de par (categoria, subcategoria)
 *    específico — um fallback não é conhecimento. As utilizações NÃO
 *    precisam: valem por si;
 *  · o que já está no global só cede a origem MAIS autoritária, ou à
 *    mesma origem com confiança estritamente superior;
 *  · repetir ao global o que ele já disse nunca é promoção.
 *
 * A aprovação DESBLOQUEIA a origem HUMANO; não dispensa nada do resto.
 */
export function avaliarPromocao(
  candidato: ConhecimentoCandidato,
  global: ConhecimentoGlobal | null,
  ctx: ContextoPromocao = {},
): DecisaoPromocao {
  const classificacao = decidirClassificacao(candidato, global, ctx);

  const jaLa = new Map((global?.utilizacoes ?? []).map((u) => [u.slug, u]));
  const promover: UtilizacaoCandidata[] = [];
  const recusadas: Array<{ slug: string; motivo: string; aguardaAprovacao: boolean }> = [];

  for (const u of candidato.utilizacoes) {
    if (!u.origem) { recusadas.push({ slug: u.slug, motivo: u.motivo, aguardaAprovacao: false }); continue; }

    const semAprovacao = faltaAprovacao(u.origem, ctx);
    if (semAprovacao) { recusadas.push({ slug: u.slug, motivo: semAprovacao, aguardaAprovacao: true }); continue; }

    const actual = jaLa.get(u.slug);
    if (!actual) { promover.push(u); continue; }

    const rankNovo = ORIGEM_RANK[u.origem];
    const rankActual = ORIGEM_RANK[actual.origem];
    if (rankNovo < rankActual) { promover.push(u); continue; }
    if (rankNovo === rankActual && u.confidence > actual.confidence) { promover.push(u); continue; }
    recusadas.push({ slug: u.slug, motivo: "o global já tem esta utilização igual ou melhor", aguardaAprovacao: false });
  }

  return {
    promover: classificacao.promover || promover.length > 0,
    classificacao,
    utilizacoes: { promover, recusadas },
    motivo: classificacao.motivo,
    aguardaAprovacao: classificacao.aguardaAprovacao,
  };
}

// ─── Registo de promoção: quem, onde, quando, porquê ──────────────────

/**
 * Uma linha do rasto de auditoria. Escrita a cada promoção que ACONTECE
 * — as recusas não geram registo, senão o rasto ficava soterrado pelas
 * dezenas de milhares de "o global já tem melhor" de cada re-corrida.
 *
 * O `actor` é sempre preenchido: ou é uma pessoa, ou é o nome do processo
 * que correu. "Não se sabe quem" não é um valor aceitável aqui.
 */
export type RegistoPromocao = {
  cnp: number;
  origem: OrigemGlobal;
  /** Quem: operador identificado, ou o processo automático. */
  actor: string;
  /** Onde: o tenant de onde veio o conhecimento. */
  tenantOrigem: string;
  /** Quem aprovou. Só nas promoções humanas explícitas. */
  aprovador: string | null;
  /** Porquê: o motivo da aprovação, ou o motivo da decisão automática. */
  motivo: string;
  confidence: number;
  versaoRegras: string;
};

/**
 * A origem que representa esta promoção.
 *
 * Quando só sobem utilizações, a origem do produto não é a da
 * classificação — que não subiu — mas a mais autoritária das utilizações
 * que subiram. Registar a da classificação seria dizer que subiu algo que
 * não subiu.
 */
export function origemDaPromocao(
  candidato: ConhecimentoCandidato,
  decisao: DecisaoPromocao,
): OrigemGlobal | null {
  if (decisao.classificacao.promover && candidato.origem) return candidato.origem;
  let melhor: OrigemGlobal | null = null;
  for (const u of decisao.utilizacoes.promover) {
    if (u.origem && (melhor === null || ORIGEM_RANK[u.origem] < ORIGEM_RANK[melhor])) melhor = u.origem;
  }
  return melhor;
}

export function registoPromocao(
  candidato: ConhecimentoCandidato,
  decisao: DecisaoPromocao,
  ctx: ContextoPromocao & { actor: string },
): RegistoPromocao | null {
  const origem = origemDaPromocao(candidato, decisao);
  if (!origem) return null;
  const aprovada = aprovacaoValida(ctx.aprovacao) ? ctx.aprovacao : null;
  const motivoAutomatico = decisao.classificacao.promover
    ? decisao.motivo
    : `só utilizações: ${decisao.utilizacoes.promover.map((u) => u.slug).join(", ")}`;
  return {
    cnp: candidato.cnp,
    origem,
    actor: ctx.actor.trim() || "desconhecido",
    tenantOrigem: candidato.tenantOrigem,
    aprovador: aprovada?.aprovador ?? null,
    motivo: aprovada?.motivo ?? motivoAutomatico,
    confidence: candidato.confidence,
    versaoRegras: candidato.versaoRegras,
  };
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
