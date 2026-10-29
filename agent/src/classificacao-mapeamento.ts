/**
 * agent/src/classificacao-mapeamento.ts
 *
 * Mapeamento PROPOSTO de `dbo.Stocks.Etico_NETT` pela DESCRIÇÃO NORMALIZADA da tabela `dbo.Etico_NETT` (nunca só pelo
 * código), e «impressão» comparável do ambiente. Tudo PURO e sem I/O: o diagnóstico só MEDE e propõe; quem fixa o
 * mapeamento são pessoas (Entrega B). Não é código da Entrega B.
 *
 * Regra de normalização (explícita e testada): trim → NFD sem diacríticos → minúsculas → remover pontuação/símbolos →
 * colapsar espaços. Ex.: «Éticos»→«eticos», «Sacos L.»→«sacos l», «Serviços»→«servicos».
 */

import { createHash } from "node:crypto";

export type CategoriaClassificacao = "ETICO" | "NETT" | "SERVICO" | "SACOS" | "OUTROS" | "UNKNOWN";
/** Categoria de um ARTIGO: as do lookup + «sem classificação» (Etico_NETT NULL). */
export type CategoriaArtigo = CategoriaClassificacao | "SEM_CLASSIFICACAO";
export const CATEGORIAS: readonly CategoriaClassificacao[] = ["ETICO", "NETT", "SERVICO", "SACOS", "OUTROS", "UNKNOWN"];
export const CATEGORIAS_ARTIGO: readonly CategoriaArtigo[] = [...CATEGORIAS, "SEM_CLASSIFICACAO"];

/** Estado do mapeamento de UM artigo (para medir a cobertura). */
export type EstadoMapeamento = "mapeada" | "desconhecida" | "orfao" | "nula" | "sem-lookup";

/** Lookup observado na Silveirense (diagnóstico v1): código → descrição NORMALIZADA. Só para ALERTAR diferenças. */
export const REFERENCIA_SILVEIRENSE: Readonly<Record<string, string>> = {
  "1": "eticos",
  "2": "nett",
  "3": "servicos",
  "4": "sacos l",
  "5": "outros",
};

/** Normaliza uma descrição de lookup (ver cabeçalho). `null`/vazio → "". */
export function normalizarDescricao(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const REGRAS_PREFIXO: ReadonlyArray<readonly [string, CategoriaClassificacao]> = [
  ["etic", "ETICO"],
  ["nett", "NETT"],
  ["servic", "SERVICO"],
  ["sacos", "SACOS"],
  ["outros", "OUTROS"],
];

/** PROPOSTA (a validar por pessoas): categoria por prefixo da descrição normalizada; senão UNKNOWN. */
export function categoriaPorDescricao(descricaoNormalizada: string): CategoriaClassificacao {
  const d = descricaoNormalizada.trim();
  if (d === "") return "UNKNOWN";
  for (const [prefixo, categoria] of REGRAS_PREFIXO) if (d.startsWith(prefixo)) return categoria;
  return "UNKNOWN";
}

export type LinhaLookup = { codigo: string; descricao: string | null };
export type UsoCodigo = { codigo: string | null; n: number };

export type LinhaMapeada = {
  codigo: string;
  descricaoCrua: string | null;
  descricaoNormalizada: string;
  categoriaProposta: CategoriaClassificacao;
  /** Nº de artigos em dbo.Stocks com este código (universo TOTAL do ERP). */
  artigos: number;
  alertas: string[];
};

export type MapeamentoEticoNett = {
  lookupEncontrado: boolean;
  /** Como o lookup foi descoberto: FK declarada de Stocks.Etico_NETT, ou pelo nome da tabela. */
  origemLookup: "fk" | "nome" | null;
  tabela: string | null;
  colunaCodigo: string | null;
  colunaDescricao: string | null;
  linhas: LinhaMapeada[];
  /** Códigos usados em Stocks sem linha no lookup. */
  orfaos: Array<{ codigo: string; artigos: number }>;
  /** Artigos com Etico_NETT NULL. */
  nulos: number;
  totalArtigos: number;
  alertas: string[];
  aviso: string;
};

export const AVISO_PROPOSTA =
  "PROPOSTA a validar por pessoas: a categoria sai da DESCRIÇÃO normalizada do lookup (prefixo: etic→ETICO, nett→NETT, servic→SERVICO, " +
  "sacos→SACOS, outros→OUTROS; senão UNKNOWN), nunca só do código. O diagnóstico não fixa o mapeamento.";

const chave = (c: string | null | undefined) => (c === null || c === undefined ? "" : String(c).trim());

/**
 * Constrói o mapeamento a partir das linhas do lookup e do uso dos códigos em Stocks. Pura.
 * `lookup === null` = lookup ausente (tabela/FK não encontrada ou ilegível).
 */
export function construirMapeamento(
  lookup: LinhaLookup[] | null,
  uso: UsoCodigo[],
  meta: { origem: "fk" | "nome" | null; tabela: string | null; colunaCodigo: string | null; colunaDescricao: string | null } = {
    origem: null,
    tabela: null,
    colunaCodigo: null,
    colunaDescricao: null,
  },
): MapeamentoEticoNett {
  const alertas: string[] = [];
  const usoPorCodigo = new Map<string, number>();
  let nulos = 0;
  let totalArtigos = 0;
  for (const u of uso) {
    totalArtigos += u.n;
    if (u.codigo === null || chave(u.codigo) === "") {
      nulos += u.n;
      continue;
    }
    usoPorCodigo.set(chave(u.codigo), (usoPorCodigo.get(chave(u.codigo)) ?? 0) + u.n);
  }
  if (nulos > 0) alertas.push(`${nulos} artigo(s) com Stocks.Etico_NETT NULL (sem classificação).`);

  if (lookup === null) {
    alertas.unshift("lookup dbo.Etico_NETT ausente (sem FK declarada e sem tabela com esse nome): nenhuma descrição disponível, nada é mapeado.");
    const orfaos = [...usoPorCodigo].map(([codigo, artigos]) => ({ codigo, artigos })).sort((a, b) => b.artigos - a.artigos);
    if (orfaos.length > 0) alertas.push(`${orfaos.length} código(s) usados em Stocks sem lookup: ${orfaos.map((o) => `${o.codigo}×${o.artigos}`).join(", ")}.`);
    return { lookupEncontrado: false, ...meta, origemLookup: meta.origem, linhas: [], orfaos, nulos, totalArtigos, alertas, aviso: AVISO_PROPOSTA };
  }

  const linhas: LinhaMapeada[] = [];
  const vistos = new Map<string, number>();
  for (const l of lookup) {
    const codigo = chave(l.codigo);
    vistos.set(codigo, (vistos.get(codigo) ?? 0) + 1);
    const norm = normalizarDescricao(l.descricao);
    const categoria = categoriaPorDescricao(norm);
    const al: string[] = [];
    if (categoria === "UNKNOWN") al.push(`descrição «${norm}» não mapeia para nenhuma categoria conhecida (UNKNOWN).`);
    const ref = REFERENCIA_SILVEIRENSE[codigo];
    if (ref === undefined) al.push(`código ${codigo} não existe no lookup da Silveirense (1..5).`);
    else if (ref !== norm) al.push(`código ${codigo} tem descrição «${norm}»; na Silveirense era «${ref}».`);
    linhas.push({
      codigo,
      descricaoCrua: l.descricao,
      descricaoNormalizada: norm,
      categoriaProposta: categoria,
      artigos: usoPorCodigo.get(codigo) ?? 0,
      alertas: al,
    });
  }
  linhas.sort((a, b) => a.codigo.localeCompare(b.codigo, "pt", { numeric: true }));

  for (const [codigo, n] of vistos) if (n > 1) alertas.push(`código ${codigo} duplicado no lookup (${n} linhas).`);
  const porCategoria = new Map<CategoriaClassificacao, string[]>();
  for (const l of linhas) porCategoria.set(l.categoriaProposta, [...(porCategoria.get(l.categoriaProposta) ?? []), l.codigo]);
  for (const [cat, cods] of porCategoria) {
    if (cat !== "UNKNOWN" && cods.length > 1) alertas.push(`${cods.length} linhas do lookup mapeiam para ${cat} (códigos ${cods.join(", ")}).`);
  }
  for (const l of linhas) for (const a of l.alertas) alertas.push(a);
  for (const codigo of Object.keys(REFERENCIA_SILVEIRENSE)) {
    if (!linhas.some((l) => l.codigo === codigo)) alertas.push(`código ${codigo} da Silveirense («${REFERENCIA_SILVEIRENSE[codigo]}») não existe neste lookup.`);
  }
  if (lookup.length === 0) alertas.push("lookup existe mas está vazio.");

  const codigosLookup = new Set(linhas.map((l) => l.codigo));
  const orfaos = [...usoPorCodigo]
    .filter(([codigo]) => !codigosLookup.has(codigo))
    .map(([codigo, artigos]) => ({ codigo, artigos }))
    .sort((a, b) => b.artigos - a.artigos);
  if (orfaos.length > 0) {
    alertas.push(`órfãos: ${orfaos.length} código(s) em Stocks sem linha no lookup: ${orfaos.map((o) => `${o.codigo}×${o.artigos}`).join(", ")}.`);
  }
  return {
    lookupEncontrado: true,
    origemLookup: meta.origem,
    tabela: meta.tabela,
    colunaCodigo: meta.colunaCodigo,
    colunaDescricao: meta.colunaDescricao,
    linhas,
    orfaos,
    nulos,
    totalArtigos,
    alertas: [...new Set(alertas)],
    aviso: AVISO_PROPOSTA,
  };
}

/** Classifica UM código de Stocks.Etico_NETT segundo o mapeamento (descrição, nunca só o código). */
export function classificarCodigo(codigo: string | null | undefined, m: MapeamentoEticoNett): { categoria: CategoriaArtigo; estado: EstadoMapeamento } {
  const c = chave(codigo);
  if (codigo === null || codigo === undefined || c === "") return { categoria: "SEM_CLASSIFICACAO", estado: "nula" };
  if (!m.lookupEncontrado) return { categoria: "UNKNOWN", estado: "sem-lookup" };
  const linha = m.linhas.find((l) => l.codigo === c);
  if (!linha) return { categoria: "UNKNOWN", estado: "orfao" };
  return linha.categoriaProposta === "UNKNOWN" ? { categoria: "UNKNOWN", estado: "desconhecida" } : { categoria: linha.categoriaProposta, estado: "mapeada" };
}

export type Impressao = {
  /** SHA-256 (grupos de 8 hex com «-») do lookup normalizado (código=descrição normalizada, por código) ou «sem-lookup». */
  lookup: string;
  /** SHA-256 da lista (ordenada, minúsculas) de nomes de colunas de dbo.Stocks. */
  colunasStocks: string;
  /** SHA-256 das duas anteriores. */
  combinada: string;
  /** Primeiros 12 hex da combinada, em grupos de 4 (para comparar à vista). */
  curta: string;
  nColunasStocks: number;
  nLinhasLookup: number | null;
};

/**
 * Hash em grupos de 8 hex separados por «-»: o sanitizador do relatório remove sequências de ≥ 9 dígitos (NIF/telefone) e um
 * SHA-256 em bloco podia ser mutilado por isso; em grupos de 8 nunca há 9 dígitos seguidos.
 */
const agrupar = (hex: string) => (hex.match(/.{1,8}/g) ?? []).join("-");
const sha = (t: string) => agrupar(createHash("sha256").update(t, "utf8").digest("hex"));

/** «Impressão» comparável entre tenants: não contém nomes de tenant, só hashes e contagens. Pura. */
export function calcularImpressao(m: MapeamentoEticoNett | null, colunasStocks: string[]): Impressao {
  const cols = [...new Set(colunasStocks.map((c) => c.trim().toLowerCase()))].sort();
  const lookupTexto = m && m.lookupEncontrado ? m.linhas.map((l) => `${l.codigo}=${l.descricaoNormalizada}`).sort().join("\n") : "sem-lookup";
  const h1 = sha(`lookup\n${lookupTexto}`);
  const h2 = sha(`colunas\n${cols.join("\n")}`);
  const h3 = sha(`${h1}\n${h2}`);
  const curta = (h3.replace(/-/g, "").slice(0, 12).match(/.{4}/g) ?? []).join("-");
  return {
    lookup: h1,
    colunasStocks: h2,
    combinada: h3,
    curta,
    nColunasStocks: cols.length,
    nLinhasLookup: m && m.lookupEncontrado ? m.linhas.length : null,
  };
}
