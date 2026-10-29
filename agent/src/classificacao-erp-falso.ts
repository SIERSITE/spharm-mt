/**
 * agent/src/classificacao-erp-falso.ts
 *
 * APOIO AOS TESTES (nunca entra no bundle: nada o importa fora de *.test.ts). Um «SQL Server» sintético, dirigido por um
 * CENÁRIO (colunas de Stocks, dados, tabelas de domínio, FKs, permissões), que responde por QUERY às consultas que a
 * auditoria gera — nenhuma ligação a nenhum ERP real. Calcula as agregações (perfil, top, tabulação cruzada,
 * Processa_Stocks, marcados, lookups) sobre os dados do cenário, para que os testes comparem o relatório com a verdade.
 */

import { PADROES_COLUNA } from "./classificacao-auditoria.js";
import type { Linha } from "./sql-somente-leitura.js";

export type ColDef = [nome: string, tipo: string, tamanho: number];
export type Valor = string | number | null;
export type RowStocks = Record<string, Valor>;

export type TabelaDef = { esquema?: string; tabela: string; cols: ColDef[]; linhas?: number };

export type Cenario = {
  stocksCols: ColDef[];
  dados: RowStocks[];
  /** Outras tabelas do ERP (esquema dbo por omissão): aparecem nas queries por nome e em sys.partitions. */
  tabelas?: TabelaDef[];
  /** Conteúdo (linhas) de tabelas pequenas/lookup, por nome de tabela. */
  conteudo?: Record<string, RowStocks[]>;
  fks?: Array<{ coluna: string; esquemaRef?: string; tabelaRef: string; colunaRef: string }>;
  /** Colunas «candidatas» extra devolvidas pela query de nomes (ex.: dbo.Clientes.Tipo Cliente). */
  candidatasExtra?: Linha[];
  permissoes?: { inserir: number | null; actualizar: number | null; apagar: number | null };
  versaoTexto?: string;
  baseDados?: string;
  /** Coluna cuja tabulação cruzada lança um erro (para testar a redacção de segredos nos avisos). */
  falhaCruzadaCom?: { coluna: string; mensagem: string };
  /** Qualquer query cujo texto contenha isto lança (ex.: simular timeout). */
  falhaSe?: { contem: string; mensagem: string };
  /** Tabelas de histórico (ex.: Stocks_Histo): colunas e linhas; as consultas de histórico calculam-se sobre `rows`. */
  historico?: Record<string, { cols: ColDef[]; rows: RowStocks[] }>;
  /** Anulabilidade por tabela e coluna (omissão: anulável). Ex.: { Stocks: { Generico: false } }. */
  anulavel?: Record<string, Record<string, boolean>>;
  /** Valor por omissão (sys.default_constraints) por tabela e coluna. */
  padrao?: Record<string, Record<string, string>>;
  /** Tabelas cujas consultas lançam «Invalid object name» (ex.: lookup apagado), por nome de tabela. */
  semTabela?: string[];
};

export type ErpFalso = {
  ler: (sql: string) => Promise<Linha[]>;
  executadas: string[];
  tabelasLidas: Set<string>;
};

const semAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const txt = (v: Valor | undefined): string | null => (v === null || v === undefined ? null : String(v));

export function erpFalso(c: Cenario): ErpFalso {
  const executadas: string[] = [];
  const tabelasLidas = new Set<string>();
  const tabelas: TabelaDef[] = [{ esquema: "dbo", tabela: "Stocks", cols: c.stocksCols, linhas: c.dados.length }, ...(c.tabelas ?? [])];

  for (const [nome, h] of Object.entries(c.historico ?? {})) tabelas.push({ esquema: "dbo", tabela: nome, cols: h.cols, linhas: h.rows.length });
  const dadosDe = (tabela: string): RowStocks[] =>
    tabela === "Stocks" ? c.dados : c.historico?.[tabela]?.rows ?? c.conteudo?.[tabela] ?? [];
  const colsDe = (tabela: string): ColDef[] => tabelas.find((t) => t.tabela === tabela)?.cols ?? [];
  const cacheListas = new Map<string, Set<string>>();
  const lista = (sql: string): Set<string> => {
    const m = sql.match(/ IN \(([^)]*)\)/);
    const bruto = m ? m[1]! : "";
    let set = cacheListas.get(bruto);
    if (!set) {
      set = new Set(bruto.split(",").map((x) => x.trim().replace(/^N?'|'$/g, "")));
      if (cacheListas.size > 64) cacheListas.clear();
      cacheListas.set(bruto, set);
    }
    return set;
  };
  const emLista = (v: Valor | undefined, l: Set<string>) => v !== null && v !== undefined && l.has(String(v).trim());
  const agrupar = <T,>(linhas: T[], chave: (x: T) => unknown): Map<string, T[]> => {
    const g = new Map<string, T[]>();
    for (const x of linhas) {
      const k = JSON.stringify(chave(x));
      g.set(k, [...(g.get(k) ?? []), x]);
    }
    return g;
  };
  const estadoNum = (v: Valor | undefined) => (v === null || v === undefined ? "nulo" : Number(v) === 0 ? "zero" : "dif");

  /** Consultas do diagnóstico v2 (secções B–G). Devolve undefined se a query não é destas. */
  const v2 = (sql: string): Linha[] | undefined => {
    let m: RegExpMatchArray | null;
    // B/C/D/E: metadados de colunas de UMA tabela
    m = sql.match(/OBJECT_ID\(N'([^']+)'\)/);
    if (m && sql.includes("AS ordem") && sql.includes("dc.definition")) {
      const tabela = m[1]!.replace(/^dbo\./, "");
      if (c.semTabela?.includes(tabela)) return [];
      const cols = colsDe(tabela);
      return cols.map(([coluna, tipo, tamanho], i) => ({
        ordem: i + 1,
        coluna,
        tipo,
        tamanho,
        precisao: 0,
        escala: 0,
        anulavel: (c.anulavel?.[tabela]?.[coluna] ?? true) ? 1 : 0,
        padrao: c.padrao?.[tabela]?.[coluna] ?? null,
      }));
    }
    // G: dimensões do universo
    if (/ AS cat, .* AS gen, .* AS ps, .* AS ret, COUNT\(\*\) AS n/.test(sql.replace(/\n/g, " "))) {
      const col = (re: RegExp) => sql.match(re)?.[1] ?? null;
      const cat = col(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(50\)\) AS cat/);
      const gen = col(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(10\)\) AS gen/);
      const ps = col(/CASE WHEN x\.\[([^\]]+)\] IS NULL THEN N'nulo' WHEN x\.\[[^\]]+\] = 0 THEN N'zero' ELSE N'dif' END AS ps/);
      const ret = col(/CASE WHEN x\.\[([^\]]+)\] IS NULL THEN N'nulo' WHEN x\.\[[^\]]+\] = 0 THEN N'zero' ELSE N'dif' END AS ret/);
      const inL = sql.includes(" IN (") ? lista(sql) : null;
      const base = c.dados.filter((r) => (inL ? emLista(r.Codigo, inL) : true));
      const g = agrupar(base, (r) => [cat ? txt(r[cat]) : null, gen ? txt(r[gen]) : null, ps ? estadoNum(r[ps]) : null, ret ? estadoNum(r[ret]) : null]);
      return [...g.entries()].map(([k, rs]) => {
        const [a, b, d, e] = JSON.parse(k) as [string | null, string | null, string | null, string | null];
        return { cat: a, gen: b, ps: d, ret: e, n: rs.length };
      });
    }
    if (sql.includes("AS cnps, COUNT(*) AS linhas")) {
      const l = lista(sql);
      const hits = c.dados.filter((r) => emLista(r.Codigo, l));
      return [{ cnps: new Set(hits.map((r) => String(r.Codigo))).size, linhas: hits.length }];
    }
    if (/^SELECT TOP \(\d+\) CAST\(x\.\[[^\]]+\] AS NVARCHAR\(30\)\) AS cnp\n  FROM/.test(sql) && sql.includes(" IN (")) {
      const l = lista(sql);
      return c.dados.filter((r) => emLista(r.Codigo, l)).map((r) => ({ cnp: String(r.Codigo) }));
    }
    if (/AS cnp, CAST\(x\.\[[^\]]+\] AS NVARCHAR\(50\)\) AS cat/.test(sql)) {
      const l = lista(sql);
      const n = Number(sql.match(/TOP \((\d+)\)/)![1]);
      const cat = sql.match(/AS NVARCHAR\(50\)\) AS cat/) ? sql.match(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(50\)\) AS cat/)![1]! : "Etico_NETT";
      const corpo = sql.split("\n WHERE ")[1] ?? "";
      const [filtroCnp, ...resto] = corpo.split(" AND ");
      void filtroCnp;
      const cond = resto.join(" AND ");
      const hits = c.dados.filter((r) => emLista(r.Codigo, l));
      let sel: RowStocks[];
      if (cond.includes("Etico_NETT] IN (") || /\] IN \(/.test(cond)) {
        const cods = lista(cond.replace(/\n[\s\S]*$/, ""));
        sel = hits.filter((r) => emLista(r[cat], cods));
      } else if (cond.includes("Retirado")) {
        sel = hits.filter((r) => !(Number(r.Processa_Stocks ?? 0) !== 0 && r.Processa_Stocks !== null && r.Retirado === 0));
      } else {
        sel = hits.filter((r) => r.Processa_Stocks === null || r.Processa_Stocks === undefined || Number(r.Processa_Stocks) === 0);
      }
      return sel.slice(0, n).map((r) => ({ cnp: String(r.Codigo), cat: txt(r[cat]) }));
    }
    // F: lookup e uso dos códigos
    m = sql.match(/AS codigo, CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) AS descricao\n  FROM \[(\w+)\]\.\[([^\]]+)\] x/);
    if (m) {
      if (c.semTabela?.includes(m[3]!)) throw new Error(`Invalid object name '${m[2]}.${m[3]}'.`);
      const cod = sql.match(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(50\)\) AS codigo/)![1]!;
      return (c.conteudo?.[m[3]!] ?? []).map((r) => ({ codigo: txt(r[cod]), descricao: txt(r[m![1]!]) }));
    }
    m = sql.match(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(50\)\) AS codigo, COUNT\(\*\) AS n/);
    if (m) {
      const g = agrupar(c.dados, (r) => txt(r[m![1]!]));
      return [...g.entries()].map(([k, rs]) => ({ codigo: JSON.parse(k) as string | null, n: rs.length })).sort((a, b) => b.n - a.n);
    }
    // C: valores de Parametros (sem ORDER BY)
    m = sql.match(/^SELECT TOP \((\d+)\) (CAST\(x\.\[[^\]]+\] AS NVARCHAR\(100\)\) AS c\d+(?:, )?)+\n  FROM \[(\w+)\]\.\[([^\]]+)\] x WITH \(NOLOCK\)$/);
    if (m) {
      const cols = [...sql.matchAll(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) AS c(\d+)/g)];
      return dadosDe(m[4]!).slice(0, Number(m[1])).map((r) => Object.fromEntries(cols.map((e) => [`c${e[2]}`, txt(r[e[1]!])])));
    }
    // D/E: histórico e contagens numa tabela que NÃO é Stocks (ou NULL em Stocks)
    m = sql.match(/FROM \[(\w+)\]\.\[([^\]]+)\] x WITH \(NOLOCK\)/);
    const tab = m?.[2] ?? null;
    if (tab && sql.includes("AS dataMin")) {
      const id = sql.match(/COUNT\(DISTINCT x\.\[([^\]]+)\]\) AS artigos/)![1]!;
      const dt = sql.match(/MIN\(x\.\[([^\]]+)\]\)/)?.[1] ?? null;
      const rs = dadosDe(tab);
      const datas = dt ? rs.map((r) => String(r[dt])).sort() : [];
      return [{ linhas: rs.length, artigos: new Set(rs.map((r) => String(r[id]))).size, dataMin: datas[0] ?? null, dataMax: datas[datas.length - 1] ?? null }];
    }
    if (tab && sql.includes("AS comMais")) {
      const id = sql.match(/SELECT x\.\[([^\]]+)\] AS id/)![1]!;
      const col = sql.match(/ISNULL\(CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\)/)![1]!;
      const g = agrupar(dadosDe(tab), (r) => txt(r[id]));
      let multi = 0;
      for (const rs of g.values()) if (new Set(rs.map((r) => txt(r[col]))).size > 1) multi++;
      return [{ artigos: g.size, comMais: multi }];
    }
    if (tab && sql.includes("LAG(")) {
      const id = sql.match(/PARTITION BY x\.\[([^\]]+)\]/)![1]!;
      const dt = sql.match(/ORDER BY x\.\[([^\]]+)\]/)![1]!;
      const col = sql.match(/LAG\(x\.\[([^\]]+)\]\)/)![1]!;
      const trans = new Map<string, { de: string | null; para: string | null; n: number }>();
      for (const rs of agrupar(dadosDe(tab), (r) => txt(r[id])).values()) {
        const ord = [...rs].sort((a, b) => String(a[dt]).localeCompare(String(b[dt])));
        for (let i = 1; i < ord.length; i++) {
          const de = txt(ord[i - 1]![col]);
          const para = txt(ord[i]![col]);
          const k = JSON.stringify([de, para]);
          const e = trans.get(k) ?? { de, para, n: 0 };
          e.n++;
          trans.set(k, e);
        }
      }
      return [...trans.values()].sort((a, b) => b.n - a.n);
    }
    if (tab && /^SELECT COUNT\(\*\) AS total, SUM\(CASE WHEN x\.\[[^\]]+\] IS NULL THEN 1 ELSE 0 END\) AS nulos\n/.test(sql)) {
      const col = sql.match(/WHEN x\.\[([^\]]+)\] IS NULL/)![1]!;
      const rs = dadosDe(tab);
      return [{ total: rs.length, nulos: rs.filter((r) => txt(r[col]) === null).length }];
    }
    return undefined;
  };

  const ler = async (sql: string): Promise<Linha[]> => {
    executadas.push(sql);
    if (c.falhaSe && sql.includes(c.falhaSe.contem)) throw new Error(c.falhaSe.mensagem);
    for (const m of sql.matchAll(/FROM \[(\w+)\]\.\[([^\]]+)\] x/g)) tabelasLidas.add(`${m[1]}.${m[2]}`);
    const dv2 = v2(sql);
    if (dv2 !== undefined) return dv2;

    if (sql.includes("@@VERSION")) {
      return [{ versao: c.versaoTexto ?? "Microsoft SQL Server 2008 R2 (SP3) - 10.50.6000.34 (X64) \n\tAug 19 2014 12:21:34 \n\tCopyright (c) Microsoft Corporation", baseDados: c.baseDados ?? "SPharmDemo" }];
    }
    if (sql.includes("SERVERPROPERTY")) {
      return [{ produtoVersao: "10.50.6000.34", nivel: "SP3", edicao: "Standard Edition (64-bit)", compat: 100, colacao: "Latin1_General_CI_AS" }];
    }
    if (sql.includes("HAS_PERMS_BY_NAME")) {
      const p = c.permissoes ?? { inserir: 0, actualizar: 0, apagar: 0 };
      return [{ podeInserir: p.inserir, podeActualizar: p.actualizar, podeApagar: p.apagar }];
    }
    if (sql.includes("SUM(p.rows)")) {
      return tabelas.map((t) => ({ esquema: t.esquema ?? "dbo", tabela: t.tabela, linhas: t.linhas ?? c.conteudo?.[t.tabela]?.length ?? 0 }));
    }
    if (sql.includes("ON t.object_id = fk.referenced_object_id")) {
      const refs = new Set((c.fks ?? []).map((f) => f.tabelaRef));
      return tabelas.filter((t) => refs.has(t.tabela)).flatMap((t) => t.cols.map(([coluna, tipo, tamanho]) => ({ esquema: t.esquema ?? "dbo", tabela: t.tabela, coluna, tipo, tamanho })));
    }
    if (sql.includes("OBJECT_SCHEMA_NAME")) {
      return (c.fks ?? []).map((f) => ({ coluna: f.coluna, esquemaRef: f.esquemaRef ?? "dbo", tabelaRef: f.tabelaRef, colunaRef: f.colunaRef }));
    }
    if (sql.includes("c.name COLLATE Latin1_General_CI_AI")) {
      const stocks = c.stocksCols
        .filter(([n]) => PADROES_COLUNA.some((p) => semAcentos(n).includes(p)))
        .map(([coluna, tipo, tamanho]) => ({ esquema: "dbo", tabela: "Stocks", coluna, tipo, tamanho, anulavel: 1 }));
      return [...stocks, ...(c.candidatasExtra ?? [])];
    }
    if (sql.includes("t.name COLLATE Latin1_General_CI_AI")) {
      const padroes = [...sql.matchAll(/LIKE N'%([^%]+)%'/g)].map((m) => m[1]!);
      return tabelas
        .filter((t) => padroes.some((p) => semAcentos(t.tabela).includes(p)))
        .flatMap((t) => t.cols.map(([coluna, tipo, tamanho]) => ({ esquema: t.esquema ?? "dbo", tabela: t.tabela, coluna, tipo, tamanho })));
    }
    if (sql.includes("OBJECT_ID('dbo.Stocks')") && sql.includes("ty.name AS tipo")) {
      return c.stocksCols.map(([coluna, tipo, tamanho]) => ({ coluna, tipo, tamanho }));
    }
    let m = sql.match(/COUNT\(DISTINCT x\.\[([^\]]+)\]\)/);
    if (m) {
      const vs = c.dados.map((r) => txt(r[m![1]!]));
      const nn = vs.filter((v) => v !== null) as string[];
      return [{
        total: vs.length,
        preenchidas: nn.length,
        distintos: new Set(nn).size,
        vazios: nn.filter((v) => v.trim() === "").length,
        zeros: nn.filter((v) => v.trim() === "0").length,
        uns: nn.filter((v) => v.trim() === "1").length,
      }];
    }
    m = sql.match(/SELECT TOP \((\d+)\) CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) AS valor, COUNT\(\*\) AS n/);
    if (m) {
      const tabValores = sql.match(/FROM \[(\w+)\]\.\[([^\]]+)\] x/)?.[2] ?? "Stocks";
      const fonte = dadosDe(tabValores);
      const cont = new Map<string | null, number>();
      for (const r of fonte) cont.set(txt(r[m[2]!]), (cont.get(txt(r[m[2]!])) ?? 0) + 1);
      return [...cont].sort((a, b) => b[1] - a[1]).slice(0, Number(m[1])).map(([valor, n]) => ({ valor, n }));
    }
    m = sql.match(/LEFT JOIN \[(\w+)\]\.\[([^\]]+)\] l WITH \(NOLOCK\) ON l\.\[([^\]]+)\] = x\.\[([^\]]+)\]/);
    if (m) {
      const [, , tab, refCol, fkCol] = m;
      const desc = sql.match(/CAST\(l\.\[([^\]]+)\] AS NVARCHAR\(100\)\) AS b/)![1]!;
      const lk = c.conteudo?.[tab!] ?? [];
      const cont = new Map<string, { a: string | null; b: string | null; n: number }>();
      for (const r of c.dados) {
        const cod = txt(r[fkCol!]);
        const hit = lk.find((l) => txt(l[refCol!]) === cod);
        const b = hit ? txt(hit[desc]) : null;
        const k = JSON.stringify([cod, b]);
        const e = cont.get(k) ?? { a: cod, b, n: 0 };
        e.n++;
        cont.set(k, e);
      }
      return [...cont.values()].sort((x, y) => y.n - x.n);
    }
    m = sql.match(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) AS a, CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) AS b/);
    if (m) {
      if (c.falhaCruzadaCom && (m[1] === c.falhaCruzadaCom.coluna || m[2] === c.falhaCruzadaCom.coluna)) throw new Error(c.falhaCruzadaCom.mensagem);
      const cont = new Map<string, { a: string | null; b: string | null; n: number }>();
      for (const r of c.dados) {
        const k = JSON.stringify([txt(r[m[1]!]), txt(r[m[2]!])]);
        const e = cont.get(k) ?? { a: txt(r[m[1]!]), b: txt(r[m[2]!]), n: 0 };
        e.n++;
        cont.set(k, e);
      }
      return [...cont.values()].sort((x, y) => y.n - x.n);
    }
    if (sql.includes("AS diferenteDeZero")) {
      const ps = c.dados.map((r) => r.Processa_Stocks ?? null);
      const out: Linha = {
        total: ps.length,
        zero: ps.filter((v) => v === 0).length,
        diferenteDeZero: ps.filter((v) => v !== null && v !== 0).length,
        nulos: ps.filter((v) => v === null).length,
      };
      if (sql.includes("AS ativosBootstrap")) out.ativosBootstrap = c.dados.filter((r) => r.Retirado === 0 && r.Processa_Stocks !== null && r.Processa_Stocks !== undefined && r.Processa_Stocks !== 0).length;
      return [out];
    }
    if (sql.includes("AS marcadosIncluidos")) {
      const col = sql.match(/x\.\[([^\]]+)\] IS NOT NULL/)![1]!;
      const marcado = (r: RowStocks) => {
        const v = txt(r[col]);
        return v !== null && v.trim() !== "" && v.trim() !== "0";
      };
      const incluido = (r: RowStocks) => r.Processa_Stocks !== null && r.Processa_Stocks !== undefined && r.Processa_Stocks !== 0;
      return [{
        marcados: c.dados.filter(marcado).length,
        marcadosIncluidos: c.dados.filter((r) => marcado(r) && incluido(r)).length,
        marcadosExcluidos: c.dados.filter((r) => marcado(r) && !incluido(r)).length,
        naoMarcados: c.dados.filter((r) => !marcado(r)).length,
        naoMarcadosExcluidos: c.dados.filter((r) => !marcado(r) && !incluido(r)).length,
      }];
    }
    if (sql.includes("AS processaStocks")) {
      const zero = /WHERE x\.\[Processa_Stocks\] = 0/.test(sql);
      const extras = [...sql.matchAll(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(60\)\) AS c(\d)/g)];
      return c.dados.filter((r) => (zero ? r.Processa_Stocks === 0 : r.Processa_Stocks !== 0 && r.Processa_Stocks !== null)).slice(0, 10).map((r) => {
        const o: Linha = { cnp: r.Codigo, codigoId: r.CodigoID, processaStocks: String(r.Processa_Stocks) };
        for (const e of extras) o[`c${e[2]}`] = txt(r[e[1]!]);
        return o;
      });
    }
    if (sql.includes("AS cnp, x.[CodigoID] AS codigoId") && /WHERE x\.\[[^\]]+\] IS NULL|= N'/.test(sql)) {
      const nulo = sql.match(/WHERE x\.\[([^\]]+)\] IS NULL/);
      const val = sql.match(/WHERE CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) = N'((?:[^']|'')*)'/);
      const n = Number(sql.match(/TOP \((\d+)\)/)![1]);
      const sel = nulo ? c.dados.filter((r) => txt(r[nulo[1]!]) === null) : c.dados.filter((r) => txt(r[val![1]!]) === val![2]!.replace(/''/g, "'"));
      return sel.slice(0, n).map((r) => ({ cnp: r.Codigo, codigoId: r.CodigoID }));
    }
    if (sql.includes(" IN (")) {
      const lista = [...sql.matchAll(/'(\d+)'/g)].map((x) => x[1]!);
      const extras = [...sql.matchAll(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(60\)\) AS c(\d+)/g)];
      return c.dados.filter((r) => lista.includes(String(r.Codigo))).map((r) => {
        const o: Linha = { cnp: String(r.Codigo), codigoId: r.CodigoID };
        for (const e of extras) o[`c${e[2]}`] = txt(r[e[1]!]);
        return o;
      });
    }
    // conteúdo de uma tabela pequena (não-Stocks): SELECT TOP (n) CAST(x.[a] AS NVARCHAR(60)) AS c0, ... FROM [s].[t] x ... ORDER BY
    m = sql.match(/FROM \[(\w+)\]\.\[([^\]]+)\] x WITH \(NOLOCK\)\s+ORDER BY x\.\[([^\]]+)\]\s*$/);
    if (m && /AS c0/.test(sql) && m[2] !== "Stocks") {
      const cols = [...sql.matchAll(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(60\)\) AS c(\d+)/g)];
      const linhas = c.conteudo?.[m[2]!] ?? [];
      return linhas.map((r) => {
        const o: Linha = {};
        for (const e of cols) o[`c${e[2]}`] = txt(r[e[1]!]);
        return o;
      });
    }
    throw new Error(`query não prevista pelo ERP falso: ${sql.slice(0, 140)}`);
  };
  return { ler, executadas, tabelasLidas };
}
