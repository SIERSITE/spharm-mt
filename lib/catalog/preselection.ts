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

// ─── Custos observados ────────────────────────────────────────────────

/**
 * Custo por produto medido no canary real de 2026-08-17 em silveira.
 * Não são estimativas: saíram do `usage` das respostas dessa corrida.
 */
export const CUSTO_POR_PRODUTO: Readonly<Record<string, number>> = {
  OUTROS_MEDICAMENTOS: 0.0131,
  NAO_CLASSIFICADO: 0.0067,
  SEM_UTILIZACOES: 0.0057,
};
