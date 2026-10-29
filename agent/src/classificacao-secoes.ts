/**
 * agent/src/classificacao-secoes.ts
 *
 * Secções ADICIONAIS do diagnóstico v2 (todas SELECT; nada de nomes de produtos, preços ou clientes):
 *   B. TODAS as colunas de dbo.Stocks (nome/tipo/anulável/default) — estrutura, não dados;
 *   C. dbo.Parametros (+ Parametros_Histo): só as colunas de CONFIGURAÇÃO relevantes que existirem;
 *   D. Histórico (Stocks_Histo / Stocks_HistoF): estabilidade de Etico_NETT e de Generico por artigo (CodigoID),
 *      transições de valor (LAG), datas mínima/máxima, linhas por valor — só agregados;
 *   E. Metadados SQL de Generico (e Etico_NETT): tipo, anulável, default, nº de NULL, por tabela.
 */

import {
  familiaDoTipo,
  lerColunasTabela,
  nomeCompacto,
  num,
  pareceDadoSensivel,
  pareceSegredo,
  q,
  sqlColunasDeTabela,
  tentar,
  valorSeguro,
  de,
  OMITIDO,
  type ColunaTabela,
  type Ref,
} from "./classificacao-base.js";
import type { LeitorSql, Linha } from "./sql-somente-leitura.js";

// ─────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────

export type ValorN = { valor: string | null; n: number };

export type StocksColunas = {
  existe: boolean;
  total: number;
  colunas: ColunaTabela[];
};

export type ParametrosSecao = {
  tabela: string;
  existe: boolean;
  linhas: number | null;
  colunasTotal: number | null;
  /** Colunas de configuração lidas (nomes não sensíveis). */
  colunasLidas: string[];
  /** Colunas esperadas (pedidas pelo utilizador) que não existem nesta base. */
  esperadasEmFalta: string[];
  ignoradas: Array<{ coluna: string; motivo: string }>;
  /** Valores da(s) linha(s) de Parametros (config não sensível). */
  valores: Array<Record<string, string | null>>;
  historico: {
    tabela: string;
    existe: boolean;
    linhas: number | null;
    colunasLidas: string[];
    esperadasEmFalta: string[];
    porColuna: Array<{ coluna: string; distintos: number; listaCompleta: boolean; valores: ValorN[] }>;
  };
  /** Factos neutros por coluna (sem concluir nada sobre Etico_NETT). */
  observacoes: string[];
};

export type CampoHistorico = {
  campo: "Etico_NETT" | "Generico";
  coluna: string | null;
  linhasPorValor: ValorN[];
  artigosTotal: number | null;
  artigosComMaisDeUmValor: number | null;
  transicoes: Array<{ de: string | null; para: string | null; n: number }> | null;
  /** Transições com de ≠ para (inclui NULL↔valor). */
  mudancas: number | null;
  nota?: string;
};
export type HistoricoTabela = {
  tabela: string;
  existe: boolean;
  linhas: number | null;
  colunaId: string | null;
  colunaData: string | null;
  dataMin: string | null;
  dataMax: string | null;
  artigos: number | null;
  campos: CampoHistorico[];
  nota?: string;
};

export type CampoMeta = {
  tabela: string;
  campo: "Generico" | "Etico_NETT";
  tabelaExiste: boolean;
  coluna: string | null;
  tipo: string | null;
  anulavel: boolean | null;
  padrao: string | null;
  total: number | null;
  nulos: number | null;
  nota: string;
};

export type SeccoesV2 = {
  stocksColunas: StocksColunas;
  parametros: ParametrosSecao;
  historico: HistoricoTabela[];
  camposMeta: CampoMeta[];
};

// ─────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────

export const REF_STOCKS: Ref = { esquema: "dbo", tabela: "Stocks" };
export const REF_PARAMETROS: Ref = { esquema: "dbo", tabela: "Parametros" };
export const REF_PARAMETROS_HISTO: Ref = { esquema: "dbo", tabela: "Parametros_Histo" };
export const TABELAS_HISTORICO = ["Stocks_Histo", "Stocks_HistoF"] as const;

/** Colunas de configuração pedidas explicitamente (as que existirem). */
export const PARAMETROS_PEDIDOS = [
  "TipoArtigoEtico", "TipoArtigoNETT", "TipoArtigoServ", "ActEtico", "ActNETT", "ActServ", "Encomendas_Separar_EtNett",
] as const;

/** Linhas de configuração: `SELECT TOP (n) CAST(x.[col] AS NVARCHAR(100)) AS c0, ...` (sem WHERE/ORDER). */
export function sqlValoresParametros(r: Ref, colunas: string[], n = 5): string {
  const itens = colunas.slice(0, 40).map((c, i) => `CAST(x.${q(c)} AS NVARCHAR(100)) AS c${i}`);
  return [`SELECT TOP (${Math.max(1, Math.min(20, Math.trunc(n)))}) ${itens.join(", ")}`, `  FROM ${de(r)}`].join("\n");
}

const idxC = (c: string) => `x.${q(c)}`;

/** Linhas, artigos distintos e datas mínima/máxima de uma tabela de histórico (agregado). */
export function sqlHistoricoBase(r: Ref, colId: string, colData: string | null): string {
  const data = colData
    ? [`CONVERT(NVARCHAR(19), MIN(${idxC(colData)}), 120) AS dataMin`, `CONVERT(NVARCHAR(19), MAX(${idxC(colData)}), 120) AS dataMax`]
    : ["CAST(NULL AS NVARCHAR(19)) AS dataMin", "CAST(NULL AS NVARCHAR(19)) AS dataMax"];
  return [`SELECT COUNT(*) AS linhas, COUNT(DISTINCT ${idxC(colId)}) AS artigos, ${data.join(", ")}`, `  FROM ${de(r)}`].join("\n");
}

/** Nº de artigos com mais de um valor distinto (NULL conta como valor) ao longo do histórico. Agregado (tabela derivada na linha do FROM). */
export function sqlArtigosComMaisDeUmValor(r: Ref, colId: string, coluna: string): string {
  const interno =
    `SELECT ${idxC(colId)} AS id, COUNT(DISTINCT ISNULL(CAST(${idxC(coluna)} AS NVARCHAR(100)), N'~nulo~')) AS distintos` +
    ` FROM ${de(r)} GROUP BY ${idxC(colId)}`;
  return [
    "SELECT COUNT(*) AS artigos, SUM(CASE WHEN t.distintos > 1 THEN 1 ELSE 0 END) AS comMais",
    `  FROM (${interno}) t`,
  ].join("\n");
}

/**
 * Matriz de transições de valor consecutivas por artigo (LAG sobre a data). A 1.ª linha de cada artigo (ordem = 1) não é
 * uma transição e não é contada. Agregado; sem nomes nem preços.
 */
export function sqlTransicoes(r: Ref, colId: string, colData: string, coluna: string): string {
  const part = `PARTITION BY ${idxC(colId)} ORDER BY ${idxC(colData)}`;
  const interno =
    `SELECT CAST(LAG(${idxC(coluna)}) OVER (${part}) AS NVARCHAR(100)) AS de, CAST(${idxC(coluna)} AS NVARCHAR(100)) AS para,` +
    ` ROW_NUMBER() OVER (${part}) AS ordem FROM ${de(r)}`;
  const mudancas = "SUM(CASE WHEN t.ordem > 1 THEN 1 ELSE 0 END)";
  return [
    `SELECT TOP (400) t.de AS de, t.para AS para, ${mudancas} AS n`,
    `  FROM (${interno}) t`,
    " GROUP BY t.de, t.para",
    ` HAVING ${mudancas} > 0`,
    ` ORDER BY ${mudancas} DESC`,
  ].join("\n");
}

/** Nº de linhas e de NULL de uma coluna. */
export function sqlContagemNulos(r: Ref, coluna: string): string {
  return [`SELECT COUNT(*) AS total, SUM(CASE WHEN ${idxC(coluna)} IS NULL THEN 1 ELSE 0 END) AS nulos`, `  FROM ${de(r)}`].join("\n");
}

/** Valores distintos de uma coluna com contagem (agregado). */
export function sqlValoresDistintos(r: Ref, coluna: string, top: number): string {
  const n = Math.max(1, Math.min(200, Math.trunc(top)));
  const e = `CAST(${idxC(coluna)} AS NVARCHAR(100))`;
  return [`SELECT TOP (${n}) ${e} AS valor, COUNT(*) AS n`, `  FROM ${de(r)}`, ` GROUP BY ${e}`, " ORDER BY COUNT(*) DESC"].join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// Lógica pura
// ─────────────────────────────────────────────────────────────────────

/** Coluna de data do histórico: tipo data/hora; prefere nomes com «histo», depois «data»/«date». */
export function escolherColunaData(cols: ColunaTabela[]): string | null {
  const TIPOS = new Set(["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset"]);
  const pont = (c: ColunaTabela) => {
    const n = nomeCompacto(c.coluna);
    return (n.includes("histo") ? 3 : 0) + (n.startsWith("data") || n.startsWith("date") ? 2 : 0) + (n.includes("data") || n.includes("date") ? 1 : 0);
  };
  const cand = cols.filter((c) => TIPOS.has(c.tipo.toLowerCase()));
  if (cand.length === 0) return null;
  return [...cand].sort((a, b) => pont(b) - pont(a) || a.ordem - b.ordem)[0]!.coluna;
}

const colPorNome = (cols: ColunaTabela[], nome: string) => cols.find((c) => nomeCompacto(c.coluna) === nomeCompacto(nome)) ?? null;

/** Decide quais colunas de uma tabela de parâmetros se leem (config não sensível). PURA. */
export function selecionarColunasParametros(cols: ColunaTabela[]): {
  ler: ColunaTabela[];
  ignoradas: Array<{ coluna: string; motivo: string }>;
  esperadasEmFalta: string[];
} {
  const ler: ColunaTabela[] = [];
  const ignoradas: Array<{ coluna: string; motivo: string }> = [];
  const pedidosCompactos = PARAMETROS_PEDIDOS.map(nomeCompacto);
  for (const c of cols) {
    const n = nomeCompacto(c.coluna);
    const relevante = pedidosCompactos.includes(n) || n.startsWith("tipoartigo") || /^act[a-z]/.test(n) || /etico|nett|servic|generic/.test(n);
    if (!relevante) continue;
    if (pareceSegredo(c.coluna) || pareceDadoSensivel(c.coluna)) {
      // o NOME é estrutura (aprovada); o que nunca se lê são os DADOS desta coluna
      ignoradas.push({ coluna: c.coluna, motivo: "o nome sugere segredo, dado pessoal ou monetário: os dados não são lidos" });
      continue;
    }
    const fam = familiaDoTipo(c.tipo);
    if (fam === "outro" || (fam === "texto" && (c.tamanho === -1 || (c.tamanho ?? 0) > 50))) {
      ignoradas.push({ coluna: c.coluna, motivo: `tipo ${c.tipo}${c.tamanho ? `(${c.tamanho})` : ""} não lido (só números/bit/texto até 50 bytes)` });
      continue;
    }
    ler.push(c);
  }
  const esperadasEmFalta = PARAMETROS_PEDIDOS.filter((p) => !cols.some((c) => nomeCompacto(c.coluna) === nomeCompacto(p)));
  return { ler: ler.slice(0, 60), ignoradas, esperadasEmFalta: [...esperadasEmFalta] };
}

const ehNuloOuZero = (v: string | null) => v === null || v.trim() === "" || v.trim() === "0";

/** Factos neutros sobre os valores lidos (nunca conclui o significado de uma coluna). PURA. */
export function observacoesParametros(p: Pick<ParametrosSecao, "colunasLidas" | "valores" | "historico" | "existe">): string[] {
  const obs: string[] = [];
  if (!p.existe) return ["dbo.Parametros não existe nesta base."];
  p.colunasLidas.forEach((c) => {
    const vs = p.valores.map((v) => v[c] ?? null);
    if (vs.length === 0) obs.push(`${c}: sem linhas em dbo.Parametros.`);
    else if (vs.every((v) => v === null)) obs.push(`${c}: NULL em todas as ${vs.length} linha(s) de dbo.Parametros.`);
    else if (vs.every(ehNuloOuZero)) obs.push(`${c}: NULL/0/vazio em todas as ${vs.length} linha(s) (nenhum valor configurado).`);
    else obs.push(`${c}: valor(es) ${[...new Set(vs.map((v) => (v === null ? "NULL" : v)))].join(", ")}.`);
  });
  for (const h of p.historico.porColuna) {
    obs.push(`${h.coluna} (Parametros_Histo): ${h.distintos} valor(es) distinto(s)${h.valores.length ? ` — ${h.valores.slice(0, 6).map((v) => `${v.valor ?? "NULL"}×${v.n}`).join(", ")}` : ""}.`);
  }
  obs.push("Factos apenas: o diagnóstico não conclui o que estas colunas significam para Etico_NETT; o agent não as lê.");
  return obs;
}

// ─────────────────────────────────────────────────────────────────────
// Leitura
// ─────────────────────────────────────────────────────────────────────

export type CtxSeccoes = {
  ler: LeitorSql;
  avisos: string[];
  dentroDoOrcamento: () => boolean;
  /** `esquema.tabela` (minúsculas) → nº de linhas (sys.partitions). */
  linhasPorTabela: Map<string, number>;
  /** Acima disto não se executam as consultas de histórico com tabela derivada/janela. */
  maxLinhasHistorico: number;
};

const linhasDe = (c: CtxSeccoes, r: Ref) => c.linhasPorTabela.get(`${r.esquema}.${r.tabela}`.toLowerCase()) ?? null;

export async function lerSeccoesV2(c: CtxSeccoes): Promise<SeccoesV2> {
  // ── B. colunas de Stocks ──
  const rowsStocks = (await tentar(c.avisos, "colunas de Stocks (metadados completos)", () => c.ler(sqlColunasDeTabela(REF_STOCKS)))) ?? [];
  const colsStocks = lerColunasTabela(rowsStocks);
  const stocksColunas: StocksColunas = {
    existe: colsStocks.length > 0,
    total: colsStocks.length,
    // Estrutura de uma tabela de catálogo aprovada: TODOS os nomes (nunca dados). O sanitizador de texto continua a aplicar-se.
    colunas: colsStocks,
  };

  // ── tabelas de histórico: metadados e leitura ──
  const tabelasHist: Array<{ ref: Ref; cols: ColunaTabela[]; linhas: number | null }> = [];
  for (const t of TABELAS_HISTORICO) {
    const ref: Ref = { esquema: "dbo", tabela: t };
    const rows = (await tentar(c.avisos, `colunas de ${t}`, () => c.ler(sqlColunasDeTabela(ref)))) ?? [];
    tabelasHist.push({ ref, cols: lerColunasTabela(rows), linhas: linhasDe(c, ref) });
  }

  // ── E. metadados de Generico / Etico_NETT ──
  const camposMeta: CampoMeta[] = [];
  const fontes: Array<{ ref: Ref; cols: ColunaTabela[]; linhas: number | null }> = [{ ref: REF_STOCKS, cols: colsStocks, linhas: linhasDe(c, REF_STOCKS) }, ...tabelasHist];
  for (const f of fontes) {
    for (const campo of ["Generico", "Etico_NETT"] as const) {
      const nome = `${f.ref.esquema}.${f.ref.tabela}`;
      if (f.cols.length === 0) {
        camposMeta.push({ tabela: nome, campo, tabelaExiste: false, coluna: null, tipo: null, anulavel: null, padrao: null, total: null, nulos: null, nota: "tabela inexistente" });
        continue;
      }
      const col = colPorNome(f.cols, campo);
      if (!col) {
        camposMeta.push({ tabela: nome, campo, tabelaExiste: true, coluna: null, tipo: null, anulavel: null, padrao: null, total: null, nulos: null, nota: "coluna inexistente nesta tabela" });
        continue;
      }
      const m: CampoMeta = { tabela: nome, campo, tabelaExiste: true, coluna: col.coluna, tipo: col.tipo, anulavel: col.anulavel, padrao: col.padrao, total: null, nulos: null, nota: "" };
      const grande = f.linhas !== null && f.linhas > c.maxLinhasHistorico && f.ref.tabela !== "Stocks";
      if (!col.anulavel) {
        m.nulos = 0;
        m.nota = "coluna NOT NULL: não pode ter NULL";
      } else if (grande || !c.dentroDoOrcamento()) {
        m.nota = grande ? `tabela com mais de ${c.maxLinhasHistorico} linhas: contagem de NULL não executada` : "orçamento de tempo esgotado";
      } else {
        const r = await tentar(c.avisos, `NULL de ${nome}.${col.coluna}`, () => c.ler(sqlContagemNulos(f.ref, col.coluna)));
        if (r?.[0]) {
          m.total = num(r[0].total);
          m.nulos = num(r[0].nulos);
          m.nota = "coluna anulável: contagem de NULL feita em SQL";
        }
      }
      camposMeta.push(m);
    }
  }

  // ── C. Parametros / Parametros_Histo ──
  const parametros = await lerParametros(c);

  // ── D. histórico ──
  const historico: HistoricoTabela[] = [];
  for (const t of tabelasHist) historico.push(await lerHistorico(c, t.ref, t.cols, t.linhas));

  return { stocksColunas, parametros, historico, camposMeta };
}

async function lerParametros(c: CtxSeccoes): Promise<ParametrosSecao> {
  const colsRows = (await tentar(c.avisos, "colunas de Parametros", () => c.ler(sqlColunasDeTabela(REF_PARAMETROS)))) ?? [];
  const cols = lerColunasTabela(colsRows);
  const histRows = (await tentar(c.avisos, "colunas de Parametros_Histo", () => c.ler(sqlColunasDeTabela(REF_PARAMETROS_HISTO)))) ?? [];
  const colsH = lerColunasTabela(histRows);
  const sel = selecionarColunasParametros(cols);
  const selH = selecionarColunasParametros(colsH);
  const p: ParametrosSecao = {
    tabela: "dbo.Parametros",
    existe: cols.length > 0,
    linhas: linhasDe(c, REF_PARAMETROS),
    colunasTotal: cols.length || null,
    colunasLidas: sel.ler.map((x) => x.coluna),
    esperadasEmFalta: cols.length > 0 ? sel.esperadasEmFalta : [...PARAMETROS_PEDIDOS],
    ignoradas: sel.ignoradas,
    valores: [],
    historico: {
      tabela: "dbo.Parametros_Histo",
      existe: colsH.length > 0,
      linhas: linhasDe(c, REF_PARAMETROS_HISTO),
      colunasLidas: selH.ler.map((x) => x.coluna),
      esperadasEmFalta: colsH.length > 0 ? selH.esperadasEmFalta : [...PARAMETROS_PEDIDOS],
      porColuna: [],
    },
    observacoes: [],
  };
  if (p.existe && p.colunasLidas.length > 0 && c.dentroDoOrcamento()) {
    for (let i = 0; i < p.colunasLidas.length; i += 40) {
      const grupo = p.colunasLidas.slice(i, i + 40);
      const rows = await tentar(c.avisos, "valores de Parametros", () => c.ler(sqlValoresParametros(REF_PARAMETROS, grupo)));
      (rows ?? []).forEach((r, k) => {
        p.valores[k] = { ...(p.valores[k] ?? {}), ...Object.fromEntries(grupo.map((col, j) => [col, valorSeguro(r[`c${j}`])])) };
      });
    }
  }
  if (p.historico.existe) {
    for (const col of p.historico.colunasLidas) {
      if (!c.dentroDoOrcamento()) {
        c.avisos.push("orçamento de tempo esgotado antes de ler Parametros_Histo");
        break;
      }
      const rows = await tentar(c.avisos, `Parametros_Histo.${col}`, () => c.ler(sqlValoresDistintos(REF_PARAMETROS_HISTO, col, 50)));
      if (rows) {
        p.historico.porColuna.push({
          coluna: col,
          distintos: rows.length,
          listaCompleta: rows.length < 50,
          valores: rows.map((r) => ({ valor: valorSeguro(r.valor), n: num(r.n) })),
        });
      }
    }
  }
  p.observacoes = observacoesParametros(p);
  return p;
}

async function lerHistorico(c: CtxSeccoes, ref: Ref, cols: ColunaTabela[], linhas: number | null): Promise<HistoricoTabela> {
  const nome = `${ref.esquema}.${ref.tabela}`;
  const h: HistoricoTabela = { tabela: nome, existe: cols.length > 0, linhas, colunaId: null, colunaData: null, dataMin: null, dataMax: null, artigos: null, campos: [] };
  if (!h.existe) return h;
  const id = colPorNome(cols, "CodigoID");
  h.colunaId = id?.coluna ?? null;
  h.colunaData = escolherColunaData(cols);
  if (!id) {
    h.nota = "sem coluna CodigoID: estabilidade por artigo não calculada";
    return h;
  }
  const grande = linhas !== null && linhas > c.maxLinhasHistorico;
  if (grande) {
    h.nota = `tabela com ${linhas} linhas (> ${c.maxLinhasHistorico}): consultas de histórico não executadas (aumentar com --max-linhas-historico)`;
    c.avisos.push(`${nome}: ${h.nota}`);
    return h;
  }
  if (!c.dentroDoOrcamento()) {
    h.nota = "orçamento de tempo esgotado";
    return h;
  }
  const base = await tentar(c.avisos, `${nome} (datas e artigos)`, () => c.ler(sqlHistoricoBase(ref, id.coluna, h.colunaData)));
  if (base?.[0]) {
    h.linhas = num(base[0].linhas);
    h.artigos = num(base[0].artigos);
    h.dataMin = base[0].dataMin === null || base[0].dataMin === undefined ? null : String(base[0].dataMin);
    h.dataMax = base[0].dataMax === null || base[0].dataMax === undefined ? null : String(base[0].dataMax);
  }
  for (const campo of ["Etico_NETT", "Generico"] as const) {
    const col = colPorNome(cols, campo);
    const cf: CampoHistorico = { campo, coluna: col?.coluna ?? null, linhasPorValor: [], artigosTotal: null, artigosComMaisDeUmValor: null, transicoes: null, mudancas: null };
    h.campos.push(cf);
    if (!col) {
      cf.nota = "coluna inexistente nesta tabela";
      continue;
    }
    if (!c.dentroDoOrcamento()) {
      cf.nota = "orçamento de tempo esgotado";
      continue;
    }
    const vals = await tentar(c.avisos, `${nome}.${col.coluna} (linhas por valor)`, () => c.ler(sqlValoresDistintos(ref, col.coluna, 50)));
    if (vals) cf.linhasPorValor = vals.map((r: Linha) => ({ valor: valorSeguro(r.valor), n: num(r.n) }));
    const multi = await tentar(c.avisos, `${nome}.${col.coluna} (artigos com mais de um valor)`, () => c.ler(sqlArtigosComMaisDeUmValor(ref, id.coluna, col.coluna)));
    if (multi?.[0]) {
      cf.artigosTotal = num(multi[0].artigos);
      cf.artigosComMaisDeUmValor = num(multi[0].comMais);
    }
    if (h.colunaData && c.dentroDoOrcamento()) {
      const tr = await tentar(c.avisos, `${nome}.${col.coluna} (transições)`, () => c.ler(sqlTransicoes(ref, id.coluna, h.colunaData!, col.coluna)));
      if (tr) {
        cf.transicoes = tr.map((r) => ({ de: valorSeguro(r.de), para: valorSeguro(r.para), n: num(r.n) }));
        cf.mudancas = cf.transicoes.filter((x) => x.de !== x.para).reduce((s, x) => s + x.n, 0);
      }
    } else if (!h.colunaData) {
      cf.nota = "sem coluna de data identificada: transições não calculadas";
    }
  }
  return h;
}

// ─────────────────────────────────────────────────────────────────────
// Markdown
// ─────────────────────────────────────────────────────────────────────

const cel = (v: string | number | null | undefined) => (v === null || v === undefined ? "NULL" : `\`${String(v).replace(/\|/g, "\\|")}\``);

export function renderSeccoesV2(L: string[], s: SeccoesV2): void {
  L.push("## B. Todas as colunas de dbo.Stocks (estrutura; metadados de sys.columns, sem dados)", "");
  if (!s.stocksColunas.existe) L.push("(dbo.Stocks sem colunas lidas)", "");
  else {
    L.push(`${s.stocksColunas.total} coluna(s).`, "", "| # | coluna | tipo | anulável | default |", "|---|---|---|---|---|");
    for (const c of s.stocksColunas.colunas) {
      const t = `${c.tipo}${c.tamanho && c.tamanho > 0 && ["char", "varchar", "nchar", "nvarchar", "binary", "varbinary"].includes(c.tipo) ? `(${c.tamanho})` : c.tamanho === -1 ? "(max)" : ""}`;
      L.push(`| ${c.ordem} | ${cel(c.coluna)} | ${t} | ${c.anulavel ? "sim" : "não"} | ${c.padrao ? cel(c.padrao) : ""} |`);
    }
    L.push("");
  }

  const p = s.parametros;
  L.push("## C. dbo.Parametros (configuração) e dbo.Parametros_Histo", "");
  if (!p.existe) L.push("dbo.Parametros não existe nesta base.", "");
  else {
    L.push(
      `dbo.Parametros: ${p.colunasTotal} coluna(s), ${p.linhas ?? "?"} linha(s). Lidas só colunas de configuração relevantes (nunca nomes sensíveis): ${p.colunasLidas.join(", ") || "(nenhuma)"}`,
      "",
    );
    if (p.esperadasEmFalta.length > 0) L.push(`Colunas pedidas que NÃO existem nesta base: ${p.esperadasEmFalta.join(", ")}`, "");
    if (p.ignoradas.length > 0) L.push(`Colunas relevantes não lidas: ${p.ignoradas.map((i) => `${i.coluna} (${i.motivo})`).join("; ")}`, "");
    if (p.valores.length > 0 && p.colunasLidas.length > 0) {
      L.push(`| linha | ${p.colunasLidas.join(" | ")} |`, `|---|${p.colunasLidas.map(() => "---").join("|")}|`);
      p.valores.forEach((v, i) => L.push(`| ${i + 1} | ${p.colunasLidas.map((c) => cel(v[c])).join(" | ")} |`));
      L.push("");
    }
  }
  const ph = p.historico;
  if (!ph.existe) L.push("dbo.Parametros_Histo não existe nesta base.", "");
  else {
    L.push(`dbo.Parametros_Histo (${ph.linhas ?? "?"} linhas): valores distintos por coluna de configuração${ph.esperadasEmFalta.length ? ` (não existem: ${ph.esperadasEmFalta.join(", ")})` : ""}`, "");
    for (const col of ph.porColuna) L.push(`- ${col.coluna}: ${col.distintos}${col.listaCompleta ? "" : "+"} distinto(s) — ${col.valores.slice(0, 12).map((v) => `${cel(v.valor)}×${v.n}`).join(", ")}`);
    L.push("");
  }
  for (const o of p.observacoes) L.push(`- ${o}`);
  L.push("");

  L.push("## D. Histórico: estabilidade de Etico_NETT e de Generico (Stocks_Histo / Stocks_HistoF)", "");
  for (const h of s.historico) {
    L.push(`### ${h.tabela}`, "");
    if (!h.existe) {
      L.push("tabela inexistente.", "");
      continue;
    }
    L.push(
      `Linhas: ${h.linhas ?? "?"} · artigos (CodigoID) distintos: ${h.artigos ?? "?"} · coluna de data: ${h.colunaData ?? "(nenhuma identificada)"} · datas: ${h.dataMin ?? "?"} → ${h.dataMax ?? "?"}`,
      "",
    );
    if (h.nota) L.push(`Nota: ${h.nota}`, "");
    for (const cf of h.campos) {
      L.push(`**${cf.campo}** (${cf.coluna ?? "coluna inexistente"})${cf.nota ? ` — ${cf.nota}` : ""}`, "");
      if (!cf.coluna) continue;
      L.push(
        `- artigos com mais de um valor distinto: **${cf.artigosComMaisDeUmValor ?? "?"}** de ${cf.artigosTotal ?? "?"}`,
        `- linhas por valor: ${cf.linhasPorValor.map((v) => `${cel(v.valor)}×${v.n}`).join(", ") || "?"}`,
      );
      if (cf.transicoes) {
        L.push(`- transições consecutivas (de → para): ${cf.mudancas} mudança(s) de valor`, "", "| de | para | ocorrências |", "|---|---|---|");
        for (const t of cf.transicoes) L.push(`| ${cel(t.de)} | ${cel(t.para)} | ${t.n} |`);
      }
      L.push("");
    }
  }

  L.push("## E. Metadados SQL de Generico e Etico_NETT (tipo, anulável, default, NULL)", "");
  L.push("| tabela | campo | coluna | tipo | anulável | default | linhas | NULL | nota |", "|---|---|---|---|---|---|---|---|---|");
  for (const m of s.camposMeta) {
    L.push(
      `| ${m.tabela} | ${m.campo} | ${m.coluna ?? "-"} | ${m.tipo ?? "-"} | ${m.anulavel === null ? "-" : m.anulavel ? "sim" : "não"} | ${m.padrao ? cel(m.padrao) : ""} | ${m.total ?? ""} | ${m.nulos ?? ""} | ${m.nota} |`,
    );
  }
  L.push("");
}
