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

  const ler = async (sql: string): Promise<Linha[]> => {
    executadas.push(sql);
    if (c.falhaSe && sql.includes(c.falhaSe.contem)) throw new Error(c.falhaSe.mensagem);
    for (const m of sql.matchAll(/FROM \[(\w+)\]\.\[([^\]]+)\] x/g)) tabelasLidas.add(`${m[1]}.${m[2]}`);

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
      const cont = new Map<string | null, number>();
      for (const r of c.dados) cont.set(txt(r[m[2]!]), (cont.get(txt(r[m[2]!])) ?? 0) + 1);
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
