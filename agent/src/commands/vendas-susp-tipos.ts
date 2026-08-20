/**
 * agent/src/commands/vendas-susp-tipos.ts
 *
 * Que tipos documentais existem no circuito suspenso, e quais deles são
 * reversões. Read-only, sem persistência, sem POST.
 *
 * ── PORQUE EXISTE ────────────────────────────────────────────────────
 *
 * A regra actual do circuito suspenso é `venda {107}, reversao {}`. O
 * conjunto vazio foi uma DECISÃO tomada com prova: as 107 relações de
 * `Atendimento_SuspFT_NC_Susp` resolviam 107/107 para `[Atendimento]`,
 * portanto as notas de crédito das VSG entravam pelo circuito G e um
 * segundo reader subtraí-las-ia duas vezes.
 *
 * Essa prova é de UMA farmácia e de UM período. Se noutra instalação —
 * ou noutro período da mesma — a anulação for feita dentro do próprio
 * circuito suspenso, a regra actual recusa essas linhas e o histórico
 * fica com as vendas e sem as anulações. O total sobe e continua
 * plausível, que é a forma de erro mais cara deste projecto.
 *
 * ── O QUE ESTE COMANDO NÃO FAZ ───────────────────────────────────────
 *
 * Não classifica. Não decide. Não usa `Fim Venda` como critério — o
 * campo aparece nos cortes como DADO, para se ver o que vale, e nunca
 * num `WHERE`: já foi refutado uma vez como classificador e a lição
 * custou uma ronda inteira.
 *
 * Também não assume que "tipo diferente de 107" significa reversão. O
 * que separa venda de anulação é o SINAL, e é o sinal que se conta.
 *
 * ── OS DOIS ERP ──────────────────────────────────────────────────────
 *
 * `--db` aponta o comando a outra base do MESMO servidor, para auditar
 * as duas farmácias sem reconfigurar o agent:
 *
 *   agent -- vendas-susp-tipos --db SPharm_Silveirense
 *   agent -- vendas-susp-tipos --db SPharm_Segurado
 *
 * Uso:
 *   agent -- vendas-susp-tipos [--from 2024-01-01] [--to 2026-07-31] [--db <base>]
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { janela } from "../janela.js";
import {
  descobrirCabecalhoSusp,
  descobrirSchemaSusp,
  CLASSIFICACAO,
  NAMESPACES,
  type SchemaCabecalhoSusp,
  type SchemaFonteSusp,
} from "../vendas-fontes.js";
import {
  formatCell,
  listColumns,
  listForeignKeysOut,
  listPrimaryKey,
  quoteIdent,
  tableExists,
  typeFamily,
  type ColumnMeta,
} from "./probe-helpers.js";

const RULE = "─".repeat(74);
const DOUBLE = "═".repeat(74);

const T_FT_NC = "Atendimento_SuspFT_NC_Susp";
const T_ATEND = "Atendimento";
const T_ATEND_DET = "Atendimento Detalhe";

type Args = { from: string; to: string; db?: string; help: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      db: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : "2024-01-01",
    to: typeof raw.values.to === "string" ? raw.values.to : "2026-07-31",
    db: typeof raw.values.db === "string" ? raw.values.db : undefined,
    help: raw.values.help === true,
  };
}

async function seccao(titulo: string, fn: () => Promise<void>): Promise<void> {
  console.log("");
  console.log(DOUBLE);
  console.log(titulo);
  console.log(DOUBLE);
  try {
    await fn();
  } catch (err) {
    // Uma secção que falha não leva as outras atrás: um inventário
    // parcial vale mais do que um stack trace.
    console.log(`✗ SECCAO FALHOU: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Corre uma query da sonda. Se falhar, IMPRIME O SQL e devolve `null`.
 *
 * A rev71 morreu com `Invalid column name 'Serie'` e mais nada: nem a
 * query, nem que passo era, e as três secções seguintes morreram atrás.
 * Custou uma ronda inteira a descobrir onde estava o `Serie` — numa
 * sonda que existe precisamente para poupar rondas.
 *
 * Um passo que falha diz o que tentou e deixa os outros correr.
 */
async function consultar<T>(
  pedido: sql.Request,
  texto: string,
  rotulo: string,
): Promise<{ recordset: T[] } | null> {
  try {
    return await pedido.query<T>(texto);
  } catch (err) {
    console.log(`      ✗ ${rotulo}: ${err instanceof Error ? err.message : String(err)}`);
    console.log("        ── SQL que falhou ──");
    for (const l of texto.split("\n")) console.log(`        | ${l}`);
    return null;
  }
}

/** As peças do circuito suspenso, já resolvidas. */
type Circuito = {
  susp: SchemaFonteSusp;
  cab: SchemaCabecalhoSusp;
  /** `[dbo].[Atendimento Susp Detalhe] d JOIN [dbo].[Atendimento Susp] h ON …` */
  fonte: string;
  /** Expressões qualificadas, prontas a interpolar. */
  tipo: string;
  serie: string;
  numero: string;
  data: string;
  fimVenda: string;
  qtd: string;
  codigo: string;
  pkDet: string;
  pkCab: string;
};

/**
 * A coluna de estado do cabeçalho, se existir.
 *
 * Descoberta em vez de assumida: o `[Fim Venda]` existe na Silveirense e
 * não há garantia de que exista na Segurado com o mesmo nome. Entra no
 * relatório como coluna informativa; se faltar, sai `NULL` e o resto do
 * inventário corre na mesma.
 */
async function colunaFimVenda(pool: SqlPool, tabela: string): Promise<string | null> {
  const r = await pool
    .request()
    .input("t", tabela)
    .query<{ nome: string }>(
      `SELECT c.name AS nome
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id
        WHERE o.name = @t AND o.type = 'U' AND c.name LIKE '%Fim%Venda%'`,
    );
  return r.recordset[0]?.nome ?? null;
}

function montar(susp: SchemaFonteSusp, cab: SchemaCabecalhoSusp, fimVenda: string | null): Circuito {
  const q = (c: string | null) => (c ? quoteIdent(c) : null);
  const falta: string[] = [];
  const exigir = (nome: string, v: string | null) => {
    if (!v) falta.push(nome);
    return v;
  };
  const pkDet = exigir("pk do detalhe", q(susp.pk));
  const fk = exigir("FK declarada para o cabecalho", q(susp.cabecalhoFk));
  const pkCab = exigir("pk do cabecalho", q(cab.pk));
  const tipo = exigir("Tipo Documento ID", q(cab.tipoDocumento));
  const data = exigir("Data Venda", q(cab.dataVenda));
  const qtd = exigir("Quantidade", q(susp.quantidade));
  const codigo = exigir("CodigoID", q(susp.codigoId));
  if (falta.length > 0) {
    throw new Error(
      `nao foi possivel montar o circuito suspenso — falta: ${falta.join(", ")}`,
    );
  }
  return {
    susp,
    cab,
    fonte:
      `[dbo].${quoteIdent(susp.tabela)} d\n` +
      `  JOIN [dbo].${quoteIdent(cab.tabela)} h ON h.${pkCab} = d.${fk}`,
    tipo: `h.${tipo}`,
    serie: cab.serie ? `h.${q(cab.serie)}` : "NULL",
    numero: cab.numero ? `h.${q(cab.numero)}` : "NULL",
    data: `h.${data}`,
    // `Fim Venda` entra como DADO, nunca como filtro.
    fimVenda: fimVenda ? `h.${quoteIdent(fimVenda)}` : "NULL",
    qtd: `d.${qtd}`,
    codigo: `d.${codigo}`,
    pkDet: `d.${pkDet}`,
    pkCab: `h.${pkCab}`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// O circuito G, descoberto. Nada aqui é nomeado à mão.
// ─────────────────────────────────────────────────────────────────────

/**
 * A §4 da rev71 partiu nas DUAS farmácias com `Invalid column name
 * 'Serie'`, e não foi um erro de escrita: foi ter escrito `a.[Serie]` à
 * mão numa sonda cujo resto do agent pergunta ao `sys.columns` antes de
 * nomear uma coluna. `[Atendimento]` não tem coluna `Serie` nenhuma — a
 * série "G" dos documentos vem de outro sítio, e o reader do circuito G
 * já emite `NULL` quando ela falta.
 *
 * Daqui sai a exigência: o cruzamento tem de funcionar SEM série do lado
 * G. A série é um adorno do relatório; a ligação faz-se por
 * identificador, que é o que a FK declara.
 */
type CircuitoG = {
  existe: boolean;
  tabela: string;
  detalhe: string;
  detalheExiste: boolean;
  pk: string | null;
  serie: string | null;
  numero: string | null;
  tipoDocumento: string | null;
  dataVenda: string | null;
  /** FK DECLARADA de `[Atendimento Detalhe]` para `[Atendimento]`. */
  detFk: string | null;
  detQtd: string | null;
  detCodigo: string | null;
  /** O que existe mesmo, para o operador ver em vez de adivinhar. */
  colunasInteresse: string[];
};

function pickCol(cols: ColumnMeta[], padroes: RegExp[]): string | null {
  for (const re of padroes) {
    const m = cols.find((c) => re.test(c.name));
    if (m) return m.name;
  }
  return null;
}

async function descobrirCircuitoG(pool: SqlPool): Promise<CircuitoG> {
  const tA = { schema: "dbo", table: T_ATEND };
  const tD = { schema: "dbo", table: T_ATEND_DET };
  const [existe, detalheExiste] = await Promise.all([
    tableExists(pool, tA),
    tableExists(pool, tD),
  ]);
  const base: CircuitoG = {
    existe,
    detalheExiste,
    tabela: T_ATEND,
    detalhe: T_ATEND_DET,
    pk: null,
    serie: null,
    numero: null,
    tipoDocumento: null,
    dataVenda: null,
    detFk: null,
    detQtd: null,
    detCodigo: null,
    colunasInteresse: [],
  };
  if (!existe) return base;

  const colsA = await listColumns(pool, tA);
  const pkA = await listPrimaryKey(pool, tA);
  const colsD = detalheExiste ? await listColumns(pool, tD) : [];
  const fksD = detalheExiste ? await listForeignKeysOut(pool, tD) : [];
  // FK declarada primeiro, nome só como último recurso — a mesma ordem
  // que resolveu o `Atendimento Susp ID` contra o `Atendimento ID`.
  const fkDeclarada =
    fksD.find((f) => f.toTable.toLowerCase() === `dbo.${T_ATEND}`.toLowerCase())
      ?.fromColumns[0] ?? null;

  return {
    ...base,
    pk: (pkA.length === 1 ? pkA[0] : null) ?? pickCol(colsA, [/^atendimento\s*id$/i]),
    // Pode simplesmente não existir. Isso é um resultado, não uma falha.
    serie:
      pickCol(colsA, [
        /^serie$/i,
        /^serie\s*facturacao$/i,
        /^seriefacturacao$/i,
        /^serie\s*documento$/i,
      ]) ??
      colsA.find((c) => /serie/i.test(c.name) && typeFamily(c.dataType) === "string")?.name ??
      null,
    numero:
      pickCol(colsA, [/^numero\s*documento$/i, /^numero$/i, /^n\s*documento$/i]) ??
      colsA.find((c) => /numero/i.test(c.name) && typeFamily(c.dataType) === "int")?.name ??
      null,
    tipoDocumento: pickCol(colsA, [
      /^tipo\s*documento$/i,
      /^tipo\s*documento\s*id$/i,
      /tipo.*documento/i,
    ]),
    dataVenda:
      pickCol(colsA, [/^data\s*venda$/i, /^data$/i]) ??
      colsA.find((c) => typeFamily(c.dataType) === "date")?.name ??
      null,
    detFk: fkDeclarada ?? pickCol(colsD, [/^atendimento\s*id$/i]),
    detQtd: pickCol(colsD, [/^quantidade$/i, /^qtd$/i]),
    detCodigo: pickCol(colsD, [/^codigo\s*id$/i, /^codigoid$/i]),
    colunasInteresse: colsA
      .filter((c) => /serie|numero|tipo|data|fim/i.test(c.name))
      .map((c) => `${c.name} (${c.dataType})`),
  };
}

/** Uma relação FT→NC, com as duas pontas já resolvidas contra o ERP. */
type LinhaCadeia = {
  suspId: number;
  suspSerie: string | null;
  suspNumero: number | null;
  suspTipo: number | null;
  ncId: number | null;
  gTipo: number | null;
  gData: Date | null;
  gNumero: number | null;
  gSerie: string | null;
  nLinhas: number | null;
  somaQtd: number | null;
};

/** As duas pontas de `Atendimento_SuspFT_NC_Susp`, também descobertas. */
type Relacao = {
  existe: boolean;
  tabela: string;
  colFt: string | null;
  colNc: string | null;
  origem: string;
};

async function descobrirRelacao(pool: SqlPool, tabelaCabSusp: string): Promise<Relacao> {
  const t = { schema: "dbo", table: T_FT_NC };
  const existe = await tableExists(pool, t);
  if (!existe) {
    return { existe: false, tabela: T_FT_NC, colFt: null, colNc: null, origem: "-" };
  }
  const cols = await listColumns(pool, t);
  const fks = await listForeignKeysOut(pool, t);
  const alvo = (nome: string) =>
    fks.find((f) => f.toTable.toLowerCase() === `dbo.${nome}`.toLowerCase())
      ?.fromColumns[0] ?? null;
  const ftFk = alvo(tabelaCabSusp);
  const ncFk = alvo(T_ATEND);
  const colFt = ftFk ?? pickCol(cols, [/_FT$/i, /susp.*id/i]);
  let colNc = ncFk ?? pickCol(cols, [/_NC$/i]);
  if (colNc !== null && colNc === colFt) colNc = null;
  const origem =
    ftFk && ncFk ? "FK declarada" : ftFk || ncFk ? "FK declarada + nome" : "nome";
  return { existe: true, tabela: T_FT_NC, colFt, colNc, origem };
}

// ─────────────────────────────────────────────────────────────────────
// As queries da §4, como funções puras
// ─────────────────────────────────────────────────────────────────────
//
// Estão fora do comando por um motivo só: para poderem ser construídas e
// verificadas sem ERP nenhum. A §4 correu contra duas farmácias e partiu
// nas duas — e ninguém tinha maneira de ver a query antes de a mandar.
// Agora um teste constrói-as com esquemas fictícios (com série e sem
// série do lado G) e verifica o texto inteiro, não fragmentos dele.

export type PecasCadeia = {
  pkCab: string;
  serie: string;
  numero: string;
  tipo: string;
  data: string;
  janelaSql: string;
  cabTabela: string;
  qRel: string;
  cFt: string;
  cNc: string;
  qA: string;
  gPk: string;
  gTipo: string;
  gData: string;
  gNumero: string;
  gSerie: string;
  linhasExpr: string;
  somaExpr: string;
};

/** Uma linha por relação FT→NC: as duas pontas, lado a lado. */
export function sqlCadeiaFtNc(p: PecasCadeia): string {
  return [
    `SELECT ${p.pkCab} AS suspId,`,
    `       ${p.serie} AS suspSerie,`,
    `       ${p.numero} AS suspNumero,`,
    `       ${p.tipo} AS suspTipo,`,
    `       x.${p.cNc} AS ncId,`,
    `       ${p.gTipo} AS gTipo,`,
    `       ${p.gData} AS gData,`,
    `       ${p.gNumero} AS gNumero,`,
    `       ${p.gSerie} AS gSerie,`,
    `       ${p.linhasExpr} AS nLinhas,`,
    `       ${p.somaExpr} AS somaQtd`,
    `  FROM ${p.qRel} x`,
    `  JOIN [dbo].${quoteIdent(p.cabTabela)} h ON ${p.pkCab} = x.${p.cFt}`,
    // LEFT: uma NC que não resolva no circuito G é precisamente o
    // resultado que interessa ver, não uma linha para descartar.
    `  LEFT JOIN ${p.qA} a ON a.${p.gPk} = x.${p.cNc}`,
    ` WHERE ${p.janelaSql}`,
    ` ORDER BY ${p.tipo}, ${p.data}`,
  ].join("\n");
}

export type PecasAnulacoes = {
  pkCab: string;
  tipo: string;
  fonte: string;
  janelaSql: string;
  qtd: string;
  serieSel: string;
  numSel: string;
  qRel: string;
  cFt: string;
  cNc: string;
  gemeaExpr: string;
  qD: string;
  dFk: string;
};

/**
 * Os documentos suspensos com linha negativa, e onde está a reversão.
 *
 * Três desfechos, e só três: a NC tem linhas no circuito G (o reader G já
 * a lê — declarar reversão aqui subtrai duas vezes); há ponte mas não há
 * linhas lá (a quantidade só existe do lado suspenso); não há ponte
 * nenhuma (a anulação vive inteira no circuito suspenso).
 */
export function sqlAnulacoesSuspensas(p: PecasAnulacoes): string {
  return [
    "WITH neg AS (",
    `  SELECT DISTINCT ${p.pkCab} AS suspId,`,
    `         ${p.tipo} AS tipo,`,
    `         ${p.serieSel} AS serie,`,
    `         ${p.numSel} AS num`,
    `    FROM ${p.fonte}`,
    `   WHERE ${p.janelaSql} AND ${p.qtd} < 0`,
    "),",
    "rot AS (",
    "  SELECT n.tipo AS tipo,",
    "         n.suspId AS suspId,",
    `         (SELECT TOP 1 x1.${p.cNc} FROM ${p.qRel} x1 WHERE x1.${p.cFt} = n.suspId) AS ncDirecto,`,
    `         ${p.gemeaExpr} AS ncGemea`,
    "    FROM neg n",
    "),",
    "res AS (",
    "  SELECT r.tipo AS tipo,",
    "         COALESCE(r.ncDirecto, r.ncGemea) AS nc,",
    "         CASE WHEN r.ncDirecto IS NOT NULL THEN 'D'",
    "              WHEN r.ncGemea IS NOT NULL THEN 'G'",
    "              ELSE '-' END AS rota",
    "    FROM rot r",
    "),",
    "fim AS (",
    "  SELECT res.tipo AS tipo,",
    "         res.nc AS nc,",
    "         res.rota AS rota,",
    "         CASE WHEN res.nc IS NULL THEN 0",
    `              ELSE (SELECT COUNT(*) FROM ${p.qD} dd WHERE dd.${p.dFk} = res.nc)`,
    "          END AS nLinhas",
    "    FROM res",
    ")",
    "SELECT s.tipo AS tipo,",
    "       COUNT(*) AS docsNeg,",
    "       SUM(CASE WHEN s.nc IS NOT NULL AND s.nLinhas > 0 THEN 1 ELSE 0 END) AS comLinhasG,",
    "       SUM(CASE WHEN s.nc IS NOT NULL AND s.nLinhas = 0 THEN 1 ELSE 0 END) AS relSemLinhas,",
    "       SUM(CASE WHEN s.nc IS NULL THEN 1 ELSE 0 END) AS semRelacao,",
    "       SUM(CASE WHEN s.rota = 'D' THEN 1 ELSE 0 END) AS rotaDirecta,",
    "       SUM(CASE WHEN s.rota = 'G' THEN 1 ELSE 0 END) AS rotaGemea",
    "  FROM fim s",
    " GROUP BY s.tipo",
    " ORDER BY s.tipo",
  ].join("\n");
}

export type PecasCruzDia = {
  qD: string;
  qA: string;
  gPk: string;
  dFk: string;
  detCodigo: string;
  detData: string;
  detQtd: string;
  codigo: string;
  data: string;
  qtd: string;
  fonte: string;
  janelaSql: string;
};

/** O mesmo cruzamento, sem depender da tabela de relações existir. */
export function sqlCruzProdutoDia(p: PecasCruzDia): string {
  return [
    "SELECT s.codigo AS codigo,",
    "       s.dia AS dia,",
    "       s.qtdSusp AS qtdSusp,",
    "       (SELECT COUNT(*)",
    `          FROM ${p.qD} gd`,
    `          JOIN ${p.qA} ga ON ga.${p.gPk} = gd.${p.dFk}`,
    `         WHERE gd.${p.detCodigo} = s.codigo`,
    `           AND CAST(ga.${p.detData} AS DATE) = s.dia`,
    `           AND gd.${p.detQtd} < 0) AS nG`,
    "  FROM (",
    `    SELECT ${p.codigo} AS codigo,`,
    `           CAST(${p.data} AS DATE) AS dia,`,
    `           SUM(CAST(${p.qtd} AS FLOAT)) AS qtdSusp`,
    `      FROM ${p.fonte}`,
    `     WHERE ${p.janelaSql} AND ${p.qtd} < 0`,
    `     GROUP BY ${p.codigo}, CAST(${p.data} AS DATE)`,
    "  ) s",
  ].join("\n");
}

export async function vendasSuspTipos(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    console.log("Uso: vendas-susp-tipos [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--db <base>]");
    console.log("");
    console.log("Read-only. Inventaria os tipos documentais do circuito suspenso,");
    console.log("procura reversoes pelo SINAL e cruza-as com o circuito G.");
    console.log("Nao classifica e nao usa [Fim Venda] como criterio.");
    return 0;
  }

  const j = janela(args.from, args.to);
  const base = loadConfig("sql");
  const cfg = args.db ? { ...base, sqlDatabase: args.db } : base;

  return withPool(cfg, async (pool) => {
    console.log(DOUBLE);
    console.log("vendas-susp-tipos — READ-ONLY");
    console.log(DOUBLE);
    console.log(`ERP    : ${cfg.sqlDatabase}@${cfg.sqlHost}`);
    console.log(`Janela : ${j.inicio} .. ${j.fimExclusivo} (exclusivo)`);
    console.log("");
    console.log("[Fim Venda] aparece nos cortes como DADO. Nao entra em WHERE");
    console.log("nenhum: ja foi refutado como classificador.");
    console.log("Nao se assume que tipo != 107 e reversao — conta-se o SINAL.");

    const [susp, cab] = await Promise.all([
      descobrirSchemaSusp(pool),
      descobrirCabecalhoSusp(pool),
    ]);
    if (!susp.existe || !cab.existe) {
      console.log("");
      console.log("✗ Esta instalacao nao tem o circuito suspenso:");
      console.log(`   [${susp.tabela}] existe: ${susp.existe}`);
      console.log(`   [${cab.tabela}] existe: ${cab.existe}`);
      return 1;
    }
    const colFimVenda = await colunaFimVenda(pool, cab.tabela);
    let C: Circuito;
    try {
      C = montar(susp, cab, colFimVenda);
    } catch (err) {
      console.log(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    console.log("");
    console.log(
      `Circuito: ${susp.tabela}.${susp.cabecalhoFk} -> ${cab.tabela}.${cab.pk} (FK declarada)`,
    );
    console.log(
      `Colunas : tipo=${cab.tipoDocumento} serie=${cab.serie ?? "-"} ` +
        `numero=${cab.numero ?? "-"} data=${cab.dataVenda ?? "-"} qtd=${susp.quantidade}`,
    );

    const janelaSql = `${C.data} >= @from AND ${C.data} < @to`;
    const req = () =>
      pool.request().input("from", sql.NVarChar, j.inicio).input("to", sql.NVarChar, j.fimExclusivo);

    // ── 1. Inventário ────────────────────────────────────────────
    await seccao("1. INVENTARIO — tipo x serie x [Fim Venda] x sinal", async () => {
      const r = await req().query<{
        tipoDoc: number | null;
        serie: string | null;
        fimVenda: string | null;
        sinal: string;
        linhas: number;
        docs: number;
        soma: number;
        primeiro: Date | null;
        ultimo: Date | null;
      }>(`
        SELECT ${C.tipo} AS tipoDoc,
               ${C.serie} AS serie,
               ${C.fimVenda} AS fimVenda,
               CASE WHEN ${C.qtd} < 0 THEN 'NEGATIVA'
                    WHEN ${C.qtd} > 0 THEN 'POSITIVA'
                    ELSE 'ZERO' END AS sinal,
               COUNT(*) AS linhas,
               COUNT(DISTINCT ${C.pkCab}) AS docs,
               SUM(CAST(${C.qtd} AS FLOAT)) AS soma,
               MIN(${C.data}) AS primeiro,
               MAX(${C.data}) AS ultimo
          FROM ${C.fonte}
         WHERE ${janelaSql}
         GROUP BY ${C.tipo}, ${C.serie}, ${C.fimVenda},
                  CASE WHEN ${C.qtd} < 0 THEN 'NEGATIVA'
                       WHEN ${C.qtd} > 0 THEN 'POSITIVA'
                       ELSE 'ZERO' END
         ORDER BY ${C.tipo}, 4
      `);
      if (r.recordset.length === 0) {
        console.log("  (nenhuma linha suspensa nesta janela)");
        return;
      }
      console.log(
        `  ${"tipoDoc".padEnd(9)}${"serie".padEnd(9)}${"fimVenda".padEnd(10)}${"sinal".padEnd(10)}` +
          `${"linhas".padStart(8)}${"docs".padStart(7)}${"soma qtd".padStart(11)}   periodo`,
      );
      const declarados = CLASSIFICACAO[NAMESPACES.ATENDIMENTO_SUSP_DETALHE];
      for (const d of r.recordset) {
        const td = d.tipoDoc;
        const estado =
          td === null
            ? ""
            : declarados.venda.has(td)
              ? ""
              : declarados.reversao.has(td)
                ? ""
                : "   <- POR DECLARAR";
        console.log(
          `  ${String(d.tipoDoc ?? "-").padEnd(9)}${formatCell(d.serie, 8).padEnd(9)}` +
            `${formatCell(d.fimVenda, 9).padEnd(10)}${d.sinal.padEnd(10)}` +
            `${String(d.linhas).padStart(8)}${String(d.docs).padStart(7)}` +
            `${String(d.soma).padStart(11)}   ` +
            `${formatCell(d.primeiro, 10)} .. ${formatCell(d.ultimo, 10)}${estado}`,
        );
      }
      console.log("");
      console.log("  Leitura: um tipo com linhas NEGATIVAS e candidato a reversao.");
      console.log("  Um tipo por declarar e recusado pelo reader — as suas linhas");
      console.log("  nao entram no historico, nem como venda nem como anulacao.");
    });

    // ── 2. Caça às reversões, pelo sinal ─────────────────────────
    await seccao("2. REVERSOES — procuradas pelo SINAL, nao pelo nome", async () => {
      const neg = await req().query<{ n: number; docs: number }>(`
        SELECT COUNT(*) AS n, COUNT(DISTINCT ${C.pkCab}) AS docs
          FROM ${C.fonte} WHERE ${janelaSql} AND ${C.qtd} < 0
      `);
      console.log(
        `  linhas com quantidade negativa : ${neg.recordset[0]?.n ?? 0} ` +
          `em ${neg.recordset[0]?.docs ?? 0} documento(s)`,
      );

      if (cab.numero) {
        const numNeg = await req().query<{ n: number }>(`
          SELECT COUNT(*) AS n FROM ${C.fonte}
           WHERE ${janelaSql} AND ${C.numero} < 0
        `);
        console.log(`  [${cab.numero}] negativo          : ${numNeg.recordset[0]?.n ?? 0}`);
      }

      // Pares +/- com a mesma série e o mesmo número absoluto. Se
      // existirem, a anulação vive DENTRO do circuito suspenso.
      if (cab.numero && cab.serie) {
        const pares = await req().query<{
          serie: string | null;
          num: number;
          tipos: string;
          docs: number;
          soma: number;
        }>(`
          SELECT ${C.serie} AS serie, ABS(${C.numero}) AS num,
                 COUNT(DISTINCT ${C.tipo}) AS tipos,
                 COUNT(DISTINCT ${C.pkCab}) AS docs,
                 SUM(CAST(${C.qtd} AS FLOAT)) AS soma
            FROM ${C.fonte}
           WHERE ${janelaSql}
           GROUP BY ${C.serie}, ABS(${C.numero})
          HAVING COUNT(DISTINCT ${C.pkCab}) > 1
           ORDER BY 2 DESC
        `);
        console.log("");
        console.log(
          `  mesma serie + mesmo |numero| em mais de um documento: ${pares.recordset.length}`,
        );
        for (const p of pares.recordset.slice(0, 15)) {
          console.log(
            `    ${formatCell(p.serie, 8).padEnd(9)}${String(p.num).padStart(9)}  ` +
              `docs=${p.docs} tipos=${p.tipos} soma=${p.soma}`,
          );
        }
      }

      // Simetria por produto: mesmo CodigoID, quantidades opostas, no
      // mesmo instante. É a assinatura de uma anulação imediata.
      const simetria = await req().query<{
        data: Date | null;
        codigo: number;
        pos: number;
        neg: number;
      }>(`
        SELECT ${C.data} AS data, ${C.codigo} AS codigo,
               SUM(CASE WHEN ${C.qtd} > 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS pos,
               SUM(CASE WHEN ${C.qtd} < 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS neg
          FROM ${C.fonte}
         WHERE ${janelaSql}
         GROUP BY ${C.data}, ${C.codigo}
        HAVING SUM(CASE WHEN ${C.qtd} < 0 THEN 1 ELSE 0 END) > 0
         ORDER BY 1 DESC
      `);
      console.log("");
      console.log(`  mesmo produto+instante com linha negativa: ${simetria.recordset.length}`);
      for (const s of simetria.recordset.slice(0, 15)) {
        const anula = s.pos + s.neg === 0 ? "  (anula exactamente)" : "";
        console.log(
          `    ${formatCell(s.data, 19).padEnd(21)}CodigoID=${String(s.codigo).padEnd(9)}` +
            `+${s.pos} ${s.neg}${anula}`,
        );
      }
      if (
        (neg.recordset[0]?.n ?? 0) === 0 &&
        simetria.recordset.length === 0
      ) {
        console.log("");
        console.log("  NENHUMA reversao dentro do circuito suspenso nesta janela.");
        console.log("  Se houver anulacoes de VSG, entram por outro circuito — §4.");
      }
    });

    // ── 3. Exemplos reais, por tipo ──────────────────────────────
    await seccao("3. EXEMPLOS REAIS por tipo documental", async () => {
      const tipos = await req().query<{ tipoDoc: number | null }>(`
        SELECT DISTINCT ${C.tipo} AS tipoDoc FROM ${C.fonte} WHERE ${janelaSql}
      `);
      for (const t of tipos.recordset) {
        console.log("");
        console.log(RULE);
        console.log(`### tipoDoc = ${t.tipoDoc ?? "(nulo)"}`);
        const cond = t.tipoDoc === null ? `${C.tipo} IS NULL` : `${C.tipo} = ${t.tipoDoc}`;
        // Amostra deliberadamente enviesada para o negativo: se houver
        // reversões, é isso que interessa ver, não mais uma venda.
        const ex = await req().query<Record<string, unknown>>(`
          SELECT TOP 8 ${C.data} AS data, ${C.serie} AS serie, ${C.numero} AS numero,
                 ${C.tipo} AS tipo, ${C.fimVenda} AS fimVenda,
                 ${C.codigo} AS codigoId, ${C.qtd} AS quantidade, ${C.pkDet} AS linhaId
            FROM ${C.fonte}
           WHERE ${janelaSql} AND ${cond}
           ORDER BY CASE WHEN ${C.qtd} < 0 THEN 0 ELSE 1 END, ${C.data} DESC
        `);
        console.log(
          `  ${"data".padEnd(21)}${"serie".padEnd(8)}${"numero".padStart(9)}` +
            `${"tipo".padStart(6)}${"fimVenda".padStart(10)}${"CodigoID".padStart(10)}${"qtd".padStart(8)}`,
        );
        for (const e of ex.recordset) {
          console.log(
            `  ${formatCell(e.data, 19).padEnd(21)}${formatCell(e.serie, 7).padEnd(8)}` +
              `${String(e.numero ?? "-").padStart(9)}${String(e.tipo ?? "-").padStart(6)}` +
              `${formatCell(e.fimVenda, 9).padStart(10)}${String(e.codigoId).padStart(10)}` +
              `${String(e.quantidade).padStart(8)}`,
          );
        }
      }
    });

    // ── 4. Cruzamento com o circuito G ───────────────────────────
    await seccao("4. CRUZAMENTO com o circuito G — a mesma operacao nos dois?", async () => {
      const g = await descobrirCircuitoG(pool);
      const rel = await descobrirRelacao(pool, cab.tabela);

      // ── 4.0 o que o schema DIZ, antes de qualquer query de dados ──
      console.log("  4.0 SCHEMA DO CIRCUITO G — resolvido por metadata");
      console.log(`      [${g.tabela}]        existe=${g.existe} pk=${g.pk ?? "(por resolver)"}`);
      console.log(
        `      serie=${g.serie ?? "NAO EXISTE"}  numero=${g.numero ?? "NAO EXISTE"}  ` +
          `tipoDoc=${g.tipoDocumento ?? "-"}  data=${g.dataVenda ?? "-"}`,
      );
      console.log(
        `      [${g.detalhe}] existe=${g.detalheExiste} ` +
          `fk->${g.tabela}=${g.detFk ?? "-"} qtd=${g.detQtd ?? "-"} codigo=${g.detCodigo ?? "-"}`,
      );
      if (g.colunasInteresse.length > 0) {
        console.log(`      colunas de [${g.tabela}] com serie/numero/tipo/data/fim no nome:`);
        for (const c of g.colunasInteresse) console.log(`        · ${c}`);
      }
      if (!g.serie) {
        console.log("      NOTA: o circuito G nao tem coluna de serie nesta base. O");
        console.log("      cruzamento faz-se por IDENTIFICADOR; a serie do lado G sai");
        console.log("      NULL e nao afecta nenhuma contagem.");
      }
      if (!g.existe || !g.pk) {
        console.log("      Sem [Atendimento] ou sem pk nao ha cruzamento possivel.");
        return;
      }

      const qA = `[dbo].${quoteIdent(g.tabela)}`;
      const qD = `[dbo].${quoteIdent(g.detalhe)}`;
      const gPk = quoteIdent(g.pk);
      const gTipo = g.tipoDocumento ? `a.${quoteIdent(g.tipoDocumento)}` : "NULL";
      const gData = g.dataVenda ? `a.${quoteIdent(g.dataVenda)}` : "NULL";
      const gNumero = g.numero ? `a.${quoteIdent(g.numero)}` : "NULL";
      const gSerie = g.serie ? `a.${quoteIdent(g.serie)}` : "NULL";
      const podeContarLinhas = g.detalheExiste && g.detFk !== null;
      const dFk = g.detFk ? quoteIdent(g.detFk) : null;

      console.log("");
      console.log(`  4.1 RELACAO [${rel.tabela}]`);
      if (!rel.existe) {
        console.log("      nao existe nesta instalacao — nao ha ponte declarada");
        console.log("      entre o circuito suspenso e o G.");
      } else if (!rel.colFt || !rel.colNc) {
        console.log(
          `      existe mas as pontas nao resolvem: FT=${rel.colFt ?? "-"} NC=${rel.colNc ?? "-"}`,
        );
      } else {
        const qRel = `[dbo].${quoteIdent(rel.tabela)}`;
        const cFt = quoteIdent(rel.colFt);
        const cNc = quoteIdent(rel.colNc);
        console.log(`      pontas (${rel.origem}): FT=${rel.colFt} -> [${cab.tabela}]`);
        console.log(`                              NC=${rel.colNc} -> [${g.tabela}]`);

        const sqlTotais = [
          "SELECT COUNT(*) AS n,",
          `       COUNT(DISTINCT x.${cFt}) AS ft,`,
          `       COUNT(DISTINCT x.${cNc}) AS nc,`,
          `       SUM(CASE WHEN x.${cFt} IS NULL THEN 1 ELSE 0 END) AS ftNulo,`,
          `       SUM(CASE WHEN x.${cNc} IS NULL THEN 1 ELSE 0 END) AS ncNulo`,
          `  FROM ${qRel} x`,
        ].join("\n");
        const tot = await consultar<{
          n: number;
          ft: number;
          nc: number;
          ftNulo: number;
          ncNulo: number;
        }>(pool.request(), sqlTotais, "4.1 totais da relacao");
        const d0 = tot?.recordset[0];
        if (tot) {
          console.log(
            `      ${d0?.n ?? 0} relacoes | FT distintos=${d0?.ft ?? 0} (nulos ${d0?.ftNulo ?? 0}) ` +
              `| NC distintos=${d0?.nc ?? 0} (nulos ${d0?.ncNulo ?? 0})`,
          );
        }

        // ── 4.2 a cadeia, relação a relação ────────────────────
        const linhasExpr = podeContarLinhas
          ? `(SELECT COUNT(*) FROM ${qD} dd WHERE dd.${dFk} = x.${cNc})`
          : "NULL";
        const somaExpr =
          podeContarLinhas && g.detQtd
            ? `(SELECT SUM(CAST(dd.${quoteIdent(g.detQtd)} AS FLOAT)) FROM ${qD} dd WHERE dd.${dFk} = x.${cNc})`
            : "NULL";

        const sqlCadeia = sqlCadeiaFtNc({
          pkCab: C.pkCab,
          serie: C.serie,
          numero: C.numero,
          tipo: C.tipo,
          data: C.data,
          janelaSql,
          cabTabela: cab.tabela,
          qRel,
          cFt,
          cNc,
          qA,
          gPk,
          gTipo,
          gData,
          gNumero,
          gSerie,
          linhasExpr,
          somaExpr,
        });
        console.log("");
        console.log("  4.2 A CADEIA, relacao a relacao — separada por tipoDoc suspenso");
        const cadeia = await consultar<LinhaCadeia>(req(), sqlCadeia, "4.2 cadeia FT->NC");
        if (cadeia && cadeia.recordset.length === 0) {
          console.log("      (nenhuma relacao com cabecalho suspenso dentro da janela)");
        }
        const porTipo = new Map<string, LinhaCadeia[]>();
        for (const x of cadeia?.recordset ?? []) {
          const k = String(x.suspTipo ?? "(nulo)");
          const lista = porTipo.get(k);
          if (lista) lista.push(x);
          else porTipo.set(k, [x]);
        }
        const MAX = 40;
        for (const [tipo, lista] of porTipo) {
          console.log("");
          console.log(`      ── tipoDoc suspenso ${tipo} — ${lista.length} relacao(oes)`);
          console.log(
            `        ${"suspId".padStart(9)} ${"doc susp".padEnd(16)}${"tipo".padStart(5)}  ` +
              `${"ncId".padStart(9)} ${"tipoG".padStart(6)} ${"data G".padEnd(12)}` +
              `${"doc G".padEnd(16)}${"linhas".padStart(7)}${"soma qtd".padStart(10)}`,
          );
          for (const x of lista.slice(0, MAX)) {
            const docSusp =
              x.suspSerie || x.suspNumero !== null
                ? `${x.suspSerie ?? "?"}/${x.suspNumero ?? "?"}`
                : "·";
            const docG =
              x.gSerie || x.gNumero !== null ? `${x.gSerie ?? "?"}/${x.gNumero ?? "?"}` : "·";
            console.log(
              `        ${String(x.suspId).padStart(9)} ${docSusp.padEnd(16)}` +
                `${String(x.suspTipo ?? "-").padStart(5)}  ${String(x.ncId ?? "-").padStart(9)} ` +
                `${String(x.gTipo ?? "-").padStart(6)} ${formatCell(x.gData, 19).slice(0, 10).padEnd(12)}` +
                `${docG.padEnd(16)}${String(x.nLinhas ?? "-").padStart(7)}` +
                `${String(x.somaQtd ?? "-").padStart(10)}` +
                (x.ncId === null ? "  <- sem NC" : x.gTipo === null ? "  <- NC nao resolve no G" : ""),
            );
          }
          if (lista.length > MAX) {
            console.log(`        (+${lista.length - MAX} omitidas deste tipo — o total acima e completo)`);
          }
        }

        // ── 4.3 as anulações suspensas, e onde está a reversão ──
        if (!podeContarLinhas) {
          console.log("");
          console.log(`  4.3 impossivel: [${g.detalhe}] sem FK resolvida para [${g.tabela}].`);
        } else {
          const serieSel = cab.serie ? C.serie : "CAST(NULL AS NVARCHAR(50))";
          const numSel = cab.numero ? `ABS(${C.numero})` : "CAST(NULL AS INT)";
          // A NC pode estar ligada ao PRÓPRIO documento negativo ou ao
          // seu gémeo positivo (mesma serie + mesmo |numero|). Contam-se
          // as duas rotas, e diz-se qual carregou.
          const gemeaExpr =
            cab.serie && cab.numero
              ? `(SELECT TOP 1 x2.${cNc}` +
                ` FROM ${qRel} x2` +
                ` JOIN [dbo].${quoteIdent(cab.tabela)} h2 ON h2.${quoteIdent(cab.pk!)} = x2.${cFt}` +
                ` WHERE h2.${quoteIdent(cab.serie)} = n.serie` +
                ` AND ABS(h2.${quoteIdent(cab.numero)}) = n.num` +
                ` AND h2.${quoteIdent(cab.pk!)} <> n.suspId)`
              : "NULL";

          const sqlBuckets = sqlAnulacoesSuspensas({
            pkCab: C.pkCab,
            tipo: C.tipo,
            fonte: C.fonte,
            janelaSql,
            qtd: C.qtd,
            serieSel,
            numSel,
            qRel,
            cFt,
            cNc,
            gemeaExpr,
            qD,
            dFk: dFk!,
          });
          console.log("");
          console.log("  4.3 ANULACOES SUSPENSAS (documentos com linha negativa) — por tipoDoc");
          const buckets = await consultar<{
            tipo: number | null;
            docsNeg: number;
            comLinhasG: number;
            relSemLinhas: number;
            semRelacao: number;
            rotaDirecta: number;
            rotaGemea: number;
          }>(req(), sqlBuckets, "4.3 anulacoes suspensas");
          if (buckets && buckets.recordset.length === 0) {
            console.log("      (nenhum documento suspenso com linhas negativas na janela)");
          } else if (buckets) {
            console.log(
              `      ${"tipoDoc".padEnd(9)}${"docs -".padStart(8)}${"NC c/ linhas G".padStart(16)}` +
                `${"rel s/ linhas".padStart(15)}${"sem relacao".padStart(13)}   rota`,
            );
          }
          for (const b of buckets?.recordset ?? []) {
            console.log(
              `      ${String(b.tipo ?? "-").padEnd(9)}${String(b.docsNeg).padStart(8)}` +
                `${String(b.comLinhasG).padStart(16)}${String(b.relSemLinhas).padStart(15)}` +
                `${String(b.semRelacao).padStart(13)}   directa=${b.rotaDirecta} gemea=${b.rotaGemea}`,
            );
          }
          console.log("");
          console.log("      COMO SE LE:");
          console.log("       . NC c/ linhas no G  -> a reversao JA entra pelo reader G.");
          console.log("         Declarar reversao no circuito suspenso subtrai a MESMA");
          console.log("         operacao duas vezes. Canonico: circuito G.");
          console.log("       . rel s/ linhas no G -> ha ponte mas nao ha linhas la. A");
          console.log("         quantidade so existe do lado suspenso.");
          console.log("       . sem relacao       -> a anulacao vive INTEIRA no circuito");
          console.log("         suspenso e o reader suspenso tem de a ler, ou perde-se.");
        }
      }

      // ── 4.4 sem depender da tabela de relações ────────────────
      if (!podeContarLinhas || !g.detCodigo || !g.detQtd || !g.dataVenda) {
        console.log("");
        console.log("  4.4 cruzamento por produto+dia indisponivel: falta");
        console.log(
          `      ${[
            podeContarLinhas ? null : `fk [${g.detalhe}]->[${g.tabela}]`,
            g.detCodigo ? null : "CodigoID no detalhe",
            g.detQtd ? null : "quantidade no detalhe",
            g.dataVenda ? null : `data em [${g.tabela}]`,
          ]
            .filter(Boolean)
            .join(", ")}`,
        );
        return;
      }
      const sqlCruz = sqlCruzProdutoDia({
        qD,
        qA,
        gPk,
        dFk: dFk!,
        detCodigo: quoteIdent(g.detCodigo),
        detData: quoteIdent(g.dataVenda),
        detQtd: quoteIdent(g.detQtd),
        codigo: C.codigo,
        data: C.data,
        qtd: C.qtd,
        fonte: C.fonte,
        janelaSql,
      });
      console.log("");
      console.log("  4.4 SEM a tabela de relacoes — linhas suspensas negativas que");
      console.log("      tenham NC do circuito G no mesmo dia e produto:");
      const cruz = await consultar<{
        codigo: number;
        dia: string;
        qtdSusp: number;
        nG: number;
      }>(req(), sqlCruz, "4.4 cruzamento produto+dia");
      if (!cruz) return;
      if (cruz.recordset.length === 0) {
        console.log("      (nao ha linhas suspensas negativas nesta janela)");
      }
      const comG = cruz.recordset.filter((x) => x.nG > 0).length;
      console.log(
        `      ${cruz.recordset.length} par(es) produto+dia | ${comG} tambem com NC no G`,
      );
      for (const x of cruz.recordset.slice(0, 20)) {
        console.log(
          `        CodigoID=${String(x.codigo).padEnd(9)} ${x.dia} susp=${x.qtdSusp} ` +
            `${x.nG > 0 ? `TAMBEM no G (${x.nG} linha(s)) <- risco de dupla contagem` : "so no circuito suspenso"}`,
        );
      }
      if (cruz.recordset.length > 20) {
        console.log(`        (+${cruz.recordset.length - 20} omitidos — os totais acima sao completos)`);
      }
    });

    // ── 5. A matriz para a regra ─────────────────────────────────
    await seccao("5. MATRIZ tipo x sinal — a base da regra", async () => {
      const r = await req().query<{
        tipoDoc: number | null;
        pos: number;
        neg: number;
        somaPos: number;
        somaNeg: number;
      }>(`
        SELECT ${C.tipo} AS tipoDoc,
               SUM(CASE WHEN ${C.qtd} > 0 THEN 1 ELSE 0 END) AS pos,
               SUM(CASE WHEN ${C.qtd} < 0 THEN 1 ELSE 0 END) AS neg,
               SUM(CASE WHEN ${C.qtd} > 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS somaPos,
               SUM(CASE WHEN ${C.qtd} < 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS somaNeg
          FROM ${C.fonte}
         WHERE ${janelaSql}
         GROUP BY ${C.tipo}
         ORDER BY 1
      `);
      console.log(
        `  ${"tipoDoc".padEnd(9)}${"linhas +".padStart(10)}${"linhas -".padStart(10)}` +
          `${"soma +".padStart(12)}${"soma -".padStart(12)}   leitura`,
      );
      const decl = CLASSIFICACAO[NAMESPACES.ATENDIMENTO_SUSP_DETALHE];
      for (const d of r.recordset) {
        const td = d.tipoDoc;
        const conhecido =
          td !== null && (decl.venda.has(td) || decl.reversao.has(td));
        const leitura =
          d.neg > 0 && d.pos > 0
            ? "os DOIS sinais — regra por tipo+sinal"
            : d.neg > 0
              ? "so negativo — candidato a reversao"
              : "so positivo — candidato a venda";
        console.log(
          `  ${String(td ?? "-").padEnd(9)}${String(d.pos).padStart(10)}${String(d.neg).padStart(10)}` +
            `${String(d.somaPos).padStart(12)}${String(d.somaNeg).padStart(12)}   ${leitura}` +
            (conhecido ? "" : "  [POR DECLARAR]"),
        );
      }
      console.log("");
      console.log(`  Declarado hoje para este circuito:`);
      console.log(`    venda    = {${[...decl.venda].join(", ")}}`);
      console.log(`    reversao = {${[...decl.reversao].join(", ")}}`);
      console.log("");
      console.log("  Um tipo [POR DECLARAR] tem as linhas RECUSADAS pelo reader:");
      console.log("  nao entram como venda nem como anulacao. Se aparecer aqui");
      console.log("  com volume, o historico fica incompleto ate ser declarado.");
    });

    console.log("");
    console.log(DOUBLE);
    console.log("FIM — nada foi escrito. Nenhum POST ao SaaS.");
    console.log(DOUBLE);
    return 0;
  });
}
