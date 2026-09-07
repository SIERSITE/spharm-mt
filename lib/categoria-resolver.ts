/**
 * lib/categoria-resolver.ts
 *
 * Fonte ÚNICA de verdade para resolver a categoria/subcategoria de um
 * produto em toda a aplicação.
 *
 * REGRA (post-cleanup, abril 2026):
 *
 *   SPharmMT é a fonte de verdade da classificação. SPharm/ERP fornece
 *   apenas CNP/designação/movimentos — os campos `ProdutoFarmacia.categoriaOrigem`
 *   e `subcategoriaOrigem` são texto livre não-fiável e NUNCA devem
 *   propagar como classificação canónica para a UI/relatórios/filtros.
 *
 * Resolução:
 *   1. `Produto.classificacaoNivel2.nome` → grupo (subcategoria canónica)
 *   2. `Produto.classificacaoNivel1.nome` → categoria (canónica)
 *   3. Sem canónico → categoria/grupo = `SEM_CLASSIFICACAO_LABEL`
 *      ("Por Classificar") usado APENAS como rótulo de UI.
 *      Não é uma categoria — é um indicador visual de produto sem
 *      classificação. O estado real está em
 *      `Produto.verificationStatus` / `Produto.needsManualReview`.
 *      Este rótulo NÃO deve aparecer em filtros nem ser persistido.
 *
 * Os campos `categoriaOrigem` / `subcategoriaOrigem` continuam aceites
 * no input por compatibilidade — mas são IGNORADOS. O classifier interno
 * (lib/catalog-classifier.ts) continua a usar estes sinais como reforço
 * fraco para escolher `productType`, mas NUNCA como categoria persistida.
 */

import { ehBalde } from "@/lib/catalog/classificacao-coerencia";

/**
 * Quanto detalhe tem a classificação deste produto.
 *
 * A distinção que faltava, e que estava a inflacionar o indicador mais
 * visível do catálogo:
 *
 *   ESPECIFICO  nível 1 e nível 2 reais — "DERMOCOSMÉTICA > Rosto"
 *   FAMILIA     nível 1 real, nível 2 é um balde — "DERMOCOSMÉTICA >
 *               Outros Dermocosmética". O produto ESTÁ classificado; o
 *               que falta é granularidade dentro da família.
 *   AUSENTE     sem nível 1 utilizável. É o único que é "por classificar".
 *
 * "Outros X" é um nível 2 LITERAL da taxonomia canónica — há 24 deles — e
 * durante muito tempo foi tratado, na prática, como ausência de
 * classificação. Não é: um produto em "Outros Medicamentos" é um
 * medicamento, conta como medicamento, agrupa com medicamentos e vende-se
 * na prateleira dos medicamentos. Só não se sabe qual.
 */
export type NivelDetalhe = "ESPECIFICO" | "FAMILIA" | "AUSENTE";

export type ClassificacaoRef = { nome: string } | null | undefined;

export type CategoriaSources = {
  classificacaoNivel1?: ClassificacaoRef;
  classificacaoNivel2?: ClassificacaoRef;
  /** @deprecated Não usado na resolução — só aceite por compatibilidade. */
  categoriaOrigem?: string | null;
  /** @deprecated Não usado na resolução — só aceite por compatibilidade. */
  subcategoriaOrigem?: string | null;
};

export type ResolvedCategoria = {
  /** Nível pai canónico ou `SEM_CLASSIFICACAO_LABEL` quando ausente. */
  categoria: string;
  /**
   * Nível específico canónico, ou a CATEGORIA quando o nível 2 é um balde.
   *
   * MUDANÇA (2026-09): um "Outros X" já não é devolvido como grupo. Era o
   * que fazia os relatórios agruparem por "Outros Dermocosmética" — um
   * grupo que não é um grupo, é o sítio onde se põe o que não se
   * classificou — e o que punha esse texto em colunas chamadas
   * "subcategoria". Quem quiser saber que falta detalhe pergunta-o a
   * `detalhe`, que é onde essa informação passa a viver.
   */
  grupo: string;
  /**
   * True SÓ quando não há nível 1 utilizável.
   *
   * Um produto em "Outros X" tem nível 1 e portanto NÃO precisa de
   * classificação — precisa de mais detalhe, que é outra coisa e tem
   * outro campo.
   */
  needsClassification: boolean;
  /** Ver `NivelDetalhe`. */
  detalhe: NivelDetalhe;
};

/**
 * Rótulo de UI para produtos sem classificação canónica. NÃO é uma
 * categoria — é apenas o texto a apresentar quando os campos
 * `classificacaoNivel*Id` estão `null`. Não deve ser persistido em
 * `Classificacao.nome` nem incluído em filtros de categoria.
 */
export const SEM_CLASSIFICACAO_LABEL = "Por Classificar";

/** @deprecated Use `SEM_CLASSIFICACAO_LABEL`. Mantido só por compatibilidade. */
export const POR_CLASSIFICAR = SEM_CLASSIFICACAO_LABEL;

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/**
 * Par (categoria, subcategoria) para relatórios operacionais.
 *
 * `resolveCategoria` devolve `categoria`/`grupo`, e `grupo` cai para o N1
 * quando não há N2 — o que é certo para agrupar, e errado para uma coluna
 * chamada "subcategoria". Pior: três módulos punham o `grupo` num campo
 * chamado `categoria` e depois comparavam-no com um dropdown de nomes de
 * NÍVEL 1. O filtro só acertava em produtos SEM nível 2, e o
 * enriquecimento — que existe justamente para preencher o nível 2 — ia
 * tornando o filtro cada vez mais vazio.
 *
 * Aqui os dois níveis são o que dizem ser:
 *   · `categoria`    — nível 1, ou "Por Classificar";
 *   · `subcategoria` — nível 2, ou "" quando não há um distinto.
 *
 * String vazia e não o rótulo: "Por Classificar" numa subcategoria seria
 * uma opção de filtro que não corresponde a classificação nenhuma.
 */
export type ParClassificacao = {
  categoria: string;
  subcategoria: string;
  /** Ver `NivelDetalhe`. Permite distinguir "" por balde de "" por ausência. */
  detalhe: NivelDetalhe;
};

export function resolverPar(src: CategoriaSources): ParClassificacao {
  const r = resolveCategoria(src);
  return {
    categoria: r.categoria,
    // Vazio quando não há nível 2 ESPECÍFICO — incluindo o caso do balde.
    // Uma coluna chamada "subcategoria" com "Outros Dermocosmética" lá
    // dentro não estava a informar ninguém: repetia a categoria com uma
    // palavra à frente.
    subcategoria: r.grupo && r.grupo !== r.categoria ? r.grupo : "",
    detalhe: r.detalhe,
  };
}

export function resolveCategoria(src: CategoriaSources): ResolvedCategoria {
  const canonN1 = clean(src.classificacaoNivel1?.nome);
  const canonN2 = clean(src.classificacaoNivel2?.nome);

  if (!canonN1 && !canonN2) {
    return {
      categoria: SEM_CLASSIFICACAO_LABEL,
      grupo: SEM_CLASSIFICACAO_LABEL,
      needsClassification: true,
      detalhe: "AUSENTE",
    };
  }

  // Categoria (pai): preferir canon N1; se só houver N2, devolve-o como categoria.
  const categoria = canonN1 || canonN2;
  // Um "Outros X" não é um grupo — é a ausência de um. O grupo passa a ser
  // a própria categoria, e a falta de detalhe fica registada em `detalhe`
  // em vez de ser inferida do texto por cada consumidor à sua maneira.
  const n2Util = canonN2 && !ehBalde(canonN2) ? canonN2 : "";

  return {
    categoria,
    grupo: n2Util || categoria,
    needsClassification: false,
    detalhe: n2Util ? "ESPECIFICO" : "FAMILIA",
  };
}

// ─── Proveniência da classificação ────────────────────────────────────

/**
 * De onde veio a classificação, e com que autoridade.
 *
 * Composto de propósito a partir de DOIS campos:
 *
 *   · `validadoManualmente` — que já era a verdade do MANUAL antes de
 *     isto existir e continua a sê-lo;
 *   · `classificacaoEstado`  — AUSENTE | PROVISORIA | CANONICA.
 *
 * MANUAL não é um valor do enum na base. A tentação era pô-lo lá e ter um
 * campo só, mas isso criava a mesma verdade em dois sítios — e duas
 * cópias de uma verdade é a garantia de que um dia discordam, com um
 * produto validado por uma pessoa a aparecer como automático porque
 * alguém actualizou um campo e não o outro.
 *
 * Aqui a precedência está escrita uma vez, e é a mesma que o SQL de
 * escrita aplica:
 *
 *      MANUAL > CANONICA > PROVISORIA > AUSENTE
 */
export type OrigemClassificacao = "MANUAL" | "CANONICA" | "PROVISORIA" | "AUSENTE";

export type ProvenienciaSources = {
  validadoManualmente?: boolean | null;
  classificacaoEstado?: OrigemClassificacao | string | null;
};

export function origemClassificacao(p: ProvenienciaSources): OrigemClassificacao {
  if (p.validadoManualmente) return "MANUAL";
  const e = p.classificacaoEstado;
  if (e === "CANONICA" || e === "PROVISORIA") return e;
  // Inclui `null`/`undefined`: uma linha lida sem o campo não é
  // classificada como canónica por omissão. O optimismo por omissão
  // aqui daria um badge "canónica" a um produto sobre o qual não se
  // perguntou nada.
  return "AUSENTE";
}

/** Rótulo curto para a UI. */
export const ROTULO_ORIGEM: Readonly<Record<OrigemClassificacao, string>> = Object.freeze({
  MANUAL: "Validada",
  CANONICA: "Canónica",
  PROVISORIA: "Provisória",
  AUSENTE: "Por classificar",
});

/**
 * A classificação conta como CLASSIFICADA nos relatórios?
 *
 * Uma provisória conta — é esse o ponto de a escrever. O que ela não é é
 * definitiva, e é isso que o badge diz.
 */
export function contaComoClassificado(o: OrigemClassificacao): boolean {
  return o !== "AUSENTE";
}
