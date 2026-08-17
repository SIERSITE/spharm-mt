/**
 * lib/catalog/preselection.ts
 *
 * Lógica de pré-selecção do knowledge-enrichment: decidir, sem gastar uma
 * chamada, o que não precisa de ir ao modelo.
 *
 * Puro. Sem base de dados, sem rede. Quem lê linhas é o script de
 * auditoria; aqui só se decide sobre linhas já lidas.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE A CHAVE DE FAMÍLIA É ESTRITA
 *
 * A primeira versão desta análise agrupou por MARCA e concluiu que 47% do
 * residual era propagável. Os exemplos desmentiram-na:
 *
 *   "lycia art.221 conjunto cuticulas"  ←  "Lycia 2673 Deo Roll On 50ml"
 *   "Tesoura de Peles nº31"             ←  "TESOURA P/ LIGADURA"
 *   "PIC SPRAY GELO INSTANTANEO"        ←  "PIC PENSO 15CM"
 *
 * Um conjunto de cutículas não é um desodorizante. Propagar por marca é
 * inventar com outro nome — exactamente o que o resto do sistema recusa.
 *
 * A chave estrita só junta o que sobra da designação depois de retirar
 * dosagem, volume, contagem e forma: dois produtos coincidem quando são o
 * MESMO produto noutra dosagem ou embalagem. Dá bastante menos, e o que
 * dá aguenta ser olhado.
 */

/** Tokens que exprimem quantidade ou apresentação, não identidade. */
const UNIDADES = new Set([
  "mg", "g", "ml", "l", "mcg", "ug", "ui", "iu", "kg", "cm", "mm", "m",
  "un", "und", "unid", "unidade", "unidades", "u", "x", "de", "do", "da",
  "com", "para", "c", "s", "e", "o", "a", "no", "na", "pack", "cx", "caixa",
]);

/** Formas farmacêuticas e de apresentação. */
const FORMAS = new Set([
  "comp", "comprimido", "comprimidos", "caps", "capsula", "capsulas", "cap",
  "amp", "ampola", "ampolas", "sup", "supositorio", "supositorios",
  "xar", "xarope", "sol", "solucao", "susp", "suspensao", "po", "pos",
  "creme", "cr", "gel", "pom", "pomada", "pda", "emul", "emulsao",
  "loc", "locao", "spray", "gts", "gt", "gotas", "granulado", "colirio",
  "saq", "saqueta", "saquetas", "carteira", "carteiras", "fr", "frasco",
  "inalador", "penso", "pensos", "adesivo", "adesivos", "lib", "prol",
]);

export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Chave de família ESTRITA.
 *
 * Retira tudo o que varia entre apresentações do mesmo produto — números,
 * unidades, formas — e devolve o resto por ordem. Dois produtos partilham
 * chave só quando o que sobra é literalmente igual.
 *
 * `null` quando não sobra nada de identificável: um nome que é só números
 * não tem família, tem um código.
 */
export function chaveFamiliaEstrita(designacao: string): string | null {
  const limpo = normalizar(designacao)
    .replace(/[^a-z ]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
  if (!limpo) return null;

  const tokens = limpo
    .split(" ")
    .filter((t) => t.length > 1 && !UNIDADES.has(t) && !FORMAS.has(t));

  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

/**
 * Nome sem conteúdo reconhecível.
 *
 * Não é uma decisão de excluir para sempre — é uma marca de que o modelo
 * também não vai ter por onde pegar. O relatório conta-os à parte
 * precisamente para se poder decidir isso com números à frente.
 */
export function nomeOpaco(designacao: string): boolean {
  const s = normalizar(designacao).replace(/[^a-z0-9 ]/g, " ").trim();
  const letras = s.replace(/[^a-z]/g, "");
  if (letras.length < 4) return true;
  const palavras = s.split(/ +/).filter((t) => /^[a-z]{3,}$/.test(t));
  return palavras.length === 0;
}

// ─── Famílias ─────────────────────────────────────────────────────────

export type ProdutoPreselecao = {
  cnp: number;
  designacao: string;
  nivel1: string | null;
  nivel2: string | null;
  utilizacoes: string[];
};

export type Familia = {
  chave: string;
  membros: ProdutoPreselecao[];
  /** Irmãos com N2 específica (não "Outros <X>"). */
  resolvidos: ProdutoPreselecao[];
  /** Irmãos com pelo menos uma utilização. */
  comUtilizacoes: ProdutoPreselecao[];
  /** Motivo pelo qual esta família NÃO pode propagar. */
  conflito: string | null;
};

export function ehEspecifica(nivel2: string | null): boolean {
  return !!nivel2 && !/^outros\b/i.test(nivel2);
}

/**
 * Agrupa por chave estrita e marca os conflitos.
 *
 * Uma família com dois níveis 2 específicos diferentes entre irmãos não
 * propaga nada: se os que já estão classificados não concordam entre si,
 * não há conclusão para herdar. O mesmo para utilizações divergentes.
 * Reportar o conflito vale mais que escolher um lado.
 */
export function agruparFamilias(produtos: readonly ProdutoPreselecao[]): Map<string, Familia> {
  const fams = new Map<string, Familia>();
  for (const p of produtos) {
    const chave = chaveFamiliaEstrita(p.designacao);
    if (!chave) continue;
    let f = fams.get(chave);
    if (!f) {
      f = { chave, membros: [], resolvidos: [], comUtilizacoes: [], conflito: null };
      fams.set(chave, f);
    }
    f.membros.push(p);
    if (ehEspecifica(p.nivel2)) f.resolvidos.push(p);
    if (p.utilizacoes.length > 0) f.comUtilizacoes.push(p);
  }

  for (const f of fams.values()) {
    const n2 = new Set(f.resolvidos.map((p) => `${p.nivel1} > ${p.nivel2}`));
    if (n2.size > 1) {
      f.conflito = `irmãos em ${n2.size} classificações diferentes: ${[...n2].join(" | ")}`;
      continue;
    }
    const conjuntos = new Set(f.comUtilizacoes.map((p) => [...p.utilizacoes].sort().join(",")));
    if (conjuntos.size > 1) {
      f.conflito = `irmãos com ${conjuntos.size} conjuntos de utilizações diferentes: ${[...conjuntos].join(" | ")}`;
    }
  }
  return fams;
}

// ─── Cobertura de utilizações por subcategoria ────────────────────────

export type CoberturaSub = {
  chave: string;
  nivel1: string;
  nivel2: string;
  total: number;
  comUtilizacao: number;
  percent: number;
};

/**
 * Que fracção dos produtos de cada subcategoria tem utilizações depois da
 * fase determinística.
 *
 * Uma subcategoria com centenas de produtos e cobertura perto de zero não
 * é um buraco por preencher — é o vocabulário a não ter termo que lhe
 * assente. Um alicate de unhas não tem utilização; perguntar é pagar por
 * um SKIP. Mas o limiar não se fixa aqui: o auditor mostra <1%, <2% e <5%
 * e a decisão é de quem lê.
 */
export function coberturaPorSubcategoria(
  produtos: readonly ProdutoPreselecao[],
): CoberturaSub[] {
  const m = new Map<string, CoberturaSub>();
  for (const p of produtos) {
    if (!ehEspecifica(p.nivel2)) continue;
    const chave = `${p.nivel1} > ${p.nivel2}`;
    let v = m.get(chave);
    if (!v) {
      v = { chave, nivel1: p.nivel1 ?? "", nivel2: p.nivel2 ?? "", total: 0, comUtilizacao: 0, percent: 0 };
      m.set(chave, v);
    }
    v.total++;
    if (p.utilizacoes.length > 0) v.comUtilizacao++;
  }
  for (const v of m.values()) v.percent = v.total ? (v.comUtilizacao / v.total) * 100 : 0;
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/** Subcategorias abaixo de um limiar de cobertura, com população mínima. */
export function subcategoriasExcluiveis(
  cobertura: readonly CoberturaSub[],
  limiarPercent: number,
  populacaoMinima: number,
): Set<string> {
  return new Set(
    cobertura
      .filter((c) => c.total >= populacaoMinima && c.percent < limiarPercent)
      .map((c) => c.chave),
  );
}

// ─── Partição do residual ─────────────────────────────────────────────

/**
 * Limiar de cobertura abaixo do qual uma subcategoria deixa de ir ao
 * modelo, e população mínima para a percentagem significar alguma coisa.
 *
 * 2% e 30 — os valores que a auditoria mostrou lado a lado com 1% e 5% e
 * que ficaram escolhidos. Não há caminho para 5% no código: alargar o
 * limiar é uma decisão que se toma alterando esta constante, com o
 * relatório da auditoria à frente, não uma opção de linha de comando.
 */
export const LIMIAR_COBERTURA_PERCENT = 2;
export const POPULACAO_MINIMA_SUBCATEGORIA = 30;

/**
 * Uma decisão propagada perde SEMPRE para uma observação directa do
 * mesmo produto. O `on conflict` das utilizações só sobrepõe quando a
 * confiança nova é estritamente maior; com este factor, um valor
 * propagado nunca desaloja um que o modelo tenha visto de frente.
 */
export const FATOR_CONFIANCA_PROPAGADA = 0.99;

export type Destino =
  /** Vai ao modelo, sem família de que dependa. */
  | "ENVIAR"
  /** Vai ao modelo, e a decisão dele serve a família. */
  | "REPRESENTANTE"
  /** Não vai: espera pela decisão do representante. */
  | "PROPAGAR"
  /** Não vai: a subcategoria não tem utilização plausível no vocabulário. */
  | "EXCLUIR_BAIXA_COBERTURA"
  /** Não vai: o nome não dá por onde pegar. */
  | "EXCLUIR_OPACO";

export type Preselecao = {
  cnp: number;
  destino: Destino;
  chaveFamilia: string | null;
  /** Preenchido só em PROPAGAR. */
  representanteCnp: number | null;
  motivo: string;
};

export type LinhaResidualPre = { cnp: number; estrato: string };

/**
 * Decide, sem gastar uma chamada, o destino de cada produto do residual.
 *
 * ORDEM DAS REGRAS, e é significativa:
 *  1. opaco — se o nome não diz nada, nem o modelo nem uma família o
 *     salvam, e não vale a pena olhar mais;
 *  2. baixa cobertura — só em SEM_UTILIZACOES, porque só aí a pergunta é
 *     sobre utilizações; um produto por classificar não é dispensado por
 *     a subcategoria dos OUTROS não ter etiquetas;
 *  3. família.
 *
 * Uma família só propaga quando NÃO tem conflito. Irmãos já classificados
 * que não concordam entre si não deixam conclusão para herdar, e escolher
 * um lado seria inventar por outra via.
 *
 * O representante é o cnp mais baixo da família dentro do mesmo estrato —
 * determinístico, para que duas corridas escolham o mesmo e a cache
 * signifique o mesmo.
 */
export function preselecionar(
  residual: readonly LinhaResidualPre[],
  contexto: readonly ProdutoPreselecao[],
  opts: {
    familias?: Map<string, Familia>;
    subcategoriasExcluidas?: ReadonlySet<string>;
  } = {},
): Map<number, Preselecao> {
  const familias = opts.familias ?? agruparFamilias(contexto);
  const excluidas =
    opts.subcategoriasExcluidas ??
    subcategoriasExcluiveis(
      coberturaPorSubcategoria(contexto),
      LIMIAR_COBERTURA_PERCENT,
      POPULACAO_MINIMA_SUBCATEGORIA,
    );

  const porCnp = new Map(contexto.map((p) => [p.cnp, p]));
  const estratoDe = new Map(residual.map((r) => [r.cnp, r.estrato]));
  const familiaDe = new Map<number, Familia>();
  for (const f of familias.values()) for (const m of f.membros) familiaDe.set(m.cnp, f);

  const out = new Map<number, Preselecao>();
  // Ordem por cnp: o representante de uma família é sempre o mesmo,
  // corrida após corrida.
  const ordenado = [...residual].sort((a, b) => a.cnp - b.cnp);
  const representantePorFamilia = new Map<string, number>();

  for (const linha of ordenado) {
    const p = porCnp.get(linha.cnp);
    if (!p) continue;
    const f = familiaDe.get(linha.cnp) ?? null;
    const chaveFamilia = f?.chave ?? null;
    const base = { cnp: linha.cnp, chaveFamilia, representanteCnp: null };

    if (nomeOpaco(p.designacao)) {
      out.set(linha.cnp, { ...base, destino: "EXCLUIR_OPACO", motivo: "designação sem conteúdo reconhecível" });
      continue;
    }

    if (linha.estrato === "SEM_UTILIZACOES" && ehEspecifica(p.nivel2)) {
      const chaveSub = `${p.nivel1} > ${p.nivel2}`;
      if (excluidas.has(chaveSub)) {
        out.set(linha.cnp, {
          ...base,
          destino: "EXCLUIR_BAIXA_COBERTURA",
          motivo: `"${chaveSub}": <${LIMIAR_COBERTURA_PERCENT}% dos produtos têm utilização`,
        });
        continue;
      }
    }

    if (f && !f.conflito) {
      const irmaosNoEstrato = f.membros.filter((m) => estratoDe.get(m.cnp) === linha.estrato);
      if (irmaosNoEstrato.length > 1) {
        const marca = `${linha.estrato}::${f.chave}`;
        const rep = representantePorFamilia.get(marca);
        if (rep === undefined) {
          representantePorFamilia.set(marca, linha.cnp);
          out.set(linha.cnp, {
            ...base,
            destino: "REPRESENTANTE",
            motivo: `representa ${irmaosNoEstrato.length - 1} irmão(s) da família "${f.chave}"`,
          });
        } else {
          out.set(linha.cnp, {
            ...base,
            destino: "PROPAGAR",
            representanteCnp: rep,
            motivo: `herda do representante ${rep} da família "${f.chave}"`,
          });
        }
        continue;
      }
    }

    out.set(linha.cnp, {
      ...base,
      destino: "ENVIAR",
      motivo: f?.conflito ? `família em conflito — vai sozinho: ${f.conflito}` : "sem família com irmãos no residual",
    });
  }

  return out;
}

// ─── Custos observados ────────────────────────────────────────────────

/**
 * Custo por produto medido no canary real de 2026-08-17 (tenant silveira).
 * Não são estimativas: saíram do `usage` das respostas dessa corrida.
 *
 * SÓ o auditor usa isto, e só para projectar. O runner não lhe toca: o
 * custo de uma corrida é sempre o `usage` real das respostas dessa
 * corrida, por estrato. Um número de um tenant não decide nada noutro.
 */
export const CUSTO_POR_PRODUTO: Readonly<Record<string, number>> = {
  OUTROS_MEDICAMENTOS: 0.0131,
  NAO_CLASSIFICADO: 0.0067,
  SEM_UTILIZACOES: 0.0057,
};
