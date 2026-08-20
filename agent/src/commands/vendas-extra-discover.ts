/**
 * agent/src/commands/vendas-extra-discover.ts
 *
 * As duas populações que faltam ao mapa: vendas a crédito e guias de
 * transferência. Read-only, sem POST, sem escrita.
 *
 * ── O DEFEITO DA REV75 ───────────────────────────────────────────────
 *
 * A primeira versão disto concluiu:
 *
 *     "A FK nao existe nesta instalacao: nao ha universo de credito."
 *
 * A inferência está errada, e a causa é interessante: durante toda esta
 * investigação a lição foi "FK declarada em vez de nome", porque escolher
 * uma coluna pelo nome fez o reader ler zero linhas. Aplicá-la aqui
 * transformou uma PREFERÊNCIA numa PRÉ-CONDIÇÃO — e a ausência de uma FK
 * passou a ser lida como ausência de tabela.
 *
 * `dbo.[Atendimento Credito]` e `dbo.[Atendimento Credito Detalhe]`
 * existem na Silveirense, medidas directamente. A relação lógica está lá
 * (`detalhe.[Atendimento Credito ID] = cabecalho.[Atendimento Credito ID]`)
 * — o que não está é declarada.
 *
 * Pelo mesmo motivo a secção das transferências bloqueava por exigir uma
 * FK `StocksMov -> tblMovStocksDet` e uma coluna `Serie` no cabeçalho.
 * `tblMovStocksCab` não tem `Serie` nenhuma, e a ligação
 * `sm.MovStocksDetID = det.MovStocksDetID` está em produção no pipeline
 * `stocksmov` desde a rev33.
 *
 * A regra correcta é: FK primeiro, estrutura depois, e NUNCA usar a
 * ausência de FK como veredicto sobre a existência de dados.
 *
 * ── A PERGUNTA QUE SÓ OS DADOS RESPONDEM ─────────────────────────────
 *
 * Uma transferência tem dois lados, e o relatório do SPharm é de VENDAS
 * da farmácia. Qual dos lados conta — saídas, entradas, as duas com
 * sinal, as duas em absoluto? E sobre que universo?
 *
 * Este comando constrói candidatos JUSTIFICÁVEIS (por tipo de documento,
 * motivo, destino, e universo documental), avalia cada um contra o gate
 * mensal do relatório com tolerância zero, e só aceita os que passam
 * 7/7 E não se sobrepõem à venda normal. Não é busca cega: cada
 * candidato tem uma leitura documental e ela é impressa.
 *
 * Uso:
 *   agent -- vendas-extra-discover [--from 2026-01-01] [--to 2026-08-01] [--db <base>]
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { janela } from "../janela.js";
import { GATES_SILVEIRENSE_2026, avaliarGate, nomeMes, renderGates } from "../gates-silveirense.js";
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

const DOUBLE = "═".repeat(74);
const RULE = "─".repeat(74);

const T_STOCKSMOV = "StocksMov";
const T_MOV_CAB = "tblMovStocksCab";
const T_MOV_DET = "tblMovStocksDet";

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
    from: typeof raw.values.from === "string" ? raw.values.from : "2026-01-01",
    to: typeof raw.values.to === "string" ? raw.values.to : "2026-08-01",
    db: typeof raw.values.db === "string" ? raw.values.db : undefined,
    help: raw.values.help === true,
  };
}

async function consultar<T>(
  pedido: sql.Request,
  texto: string,
  rotulo: string,
): Promise<{ recordset: T[] } | null> {
  try {
    return await pedido.query<T>(texto);
  } catch (err) {
    console.log(`    ✗ ${rotulo}: ${err instanceof Error ? err.message : String(err)}`);
    console.log("      ── SQL que falhou ──");
    for (const l of texto.split("\n")) console.log(`      | ${l}`);
    return null;
  }
}

function pickCol(cols: ColumnMeta[], padroes: RegExp[]): string | null {
  for (const re of padroes) {
    const m = cols.find((c) => re.test(c.name));
    if (m) return m.name;
  }
  return null;
}

function primeiraData(cols: ColumnMeta[]): string | null {
  return cols.find((c) => typeFamily(c.dataType) === "date")?.name ?? null;
}

function tem(cols: ColumnMeta[], nome: string): string | null {
  return cols.find((c) => c.name.toLowerCase() === nome.toLowerCase())?.name ?? null;
}

async function seccao(titulo: string, fn: () => Promise<void>): Promise<void> {
  console.log("");
  console.log(DOUBLE);
  console.log(titulo);
  console.log(DOUBLE);
  try {
    await fn();
  } catch (err) {
    console.log(`✗ SECCAO FALHOU: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Tabelas cujo nome contém todos os termos. Por `sys.tables`, não por
 * FK — é o que corrige o defeito da rev75.
 */
async function tabelasComNome(pool: SqlPool, termos: string[]): Promise<string[]> {
  const r = await pool.request().query<{ nome: string }>(
    `SELECT t.name AS nome FROM sys.tables t WHERE t.is_ms_shipped = 0 ORDER BY t.name`,
  );
  return r.recordset
    .map((x) => x.nome)
    .filter((n) => termos.every((t) => n.toLowerCase().includes(t.toLowerCase())));
}

// ═════════════════════════════════════════════════════════════════════
// CRÉDITO
// ═════════════════════════════════════════════════════════════════════

export type SchemaCredito = {
  detalheTabela: string | null;
  cabecalhoTabela: string | null;
  detalhePk: string | null;
  cabecalhoPk: string | null;
  /** A coluna de ligação, PRESENTE NAS DUAS tabelas. */
  chaveLigacao: string | null;
  /** Como a ligação foi estabelecida — para não se perder a proveniência. */
  origemLigacao: "FK declarada" | "estrutura (coluna comum)" | "nao resolve";
  data: string | null;
  serie: string | null;
  numero: string | null;
  tipoDocumento: string | null;
  estado: string | null;
  codigoId: string | null;
  quantidade: string | null;
  valor: string | null;
  pvp: string | null;
  colsCab: ColumnMeta[];
  colsDet: ColumnMeta[];
};

export async function descobrirCredito(pool: SqlPool): Promise<SchemaCredito> {
  const vazio: SchemaCredito = {
    detalheTabela: null, cabecalhoTabela: null, detalhePk: null, cabecalhoPk: null,
    chaveLigacao: null, origemLigacao: "nao resolve", data: null, serie: null,
    numero: null, tipoDocumento: null, estado: null, codigoId: null,
    quantidade: null, valor: null, pvp: null, colsCab: [], colsDet: [],
  };

  // Por ESTRUTURA. A FK é uma confirmação bem-vinda, não um requisito.
  const candidatas = await tabelasComNome(pool, ["credito"]);
  const detalheTabela =
    candidatas.find((n) => /detalhe/i.test(n) && !/validade/i.test(n)) ?? null;
  const cabecalhoTabela =
    candidatas.find((n) => !/detalhe/i.test(n) && !/validade/i.test(n)) ?? null;
  if (!detalheTabela) return { ...vazio, cabecalhoTabela };

  const alvoDet = { schema: "dbo", table: detalheTabela };
  const colsDet = await listColumns(pool, alvoDet);
  const pkDet = await listPrimaryKey(pool, alvoDet);
  let colsCab: ColumnMeta[] = [];
  let pkCab: string[] = [];
  if (cabecalhoTabela) {
    const alvoCab = { schema: "dbo", table: cabecalhoTabela };
    colsCab = await listColumns(pool, alvoCab);
    pkCab = await listPrimaryKey(pool, alvoCab);
  }

  // A chave lógica: a coluna que existe nos DOIS lados. Prefere-se a FK
  // declarada quando existir, mas a ausência dela não impede nada.
  const fksDet = await listForeignKeysOut(pool, alvoDet);
  const fkParaCab = cabecalhoTabela
    ? (fksDet.find(
        (f) => f.toTable.replace(/^dbo\./i, "").toLowerCase() === cabecalhoTabela.toLowerCase(),
      )?.fromColumns[0] ?? null)
    : null;
  const comum = colsCab.find((c) =>
    colsDet.some((d) => d.name.toLowerCase() === c.name.toLowerCase()) &&
    /credito.*id$/i.test(c.name),
  )?.name ?? null;
  const chaveLigacao = fkParaCab ?? comum;
  const origemLigacao: SchemaCredito["origemLigacao"] = fkParaCab
    ? "FK declarada"
    : comum
      ? "estrutura (coluna comum)"
      : "nao resolve";

  return {
    detalheTabela,
    cabecalhoTabela,
    detalhePk: pkDet.length === 1 ? pkDet[0]! : pickCol(colsDet, [/credito\s*detalhe\s*id$/i]),
    cabecalhoPk: pkCab.length === 1 ? pkCab[0]! : pickCol(colsCab, [/^atendimento\s*credito\s*id$/i]),
    chaveLigacao,
    origemLigacao,
    data:
      pickCol(colsCab, [/^data\s*venda$/i, /^data$/i]) ??
      primeiraData(colsCab) ??
      pickCol(colsDet, [/^data\s*venda$/i, /^data$/i]) ??
      primeiraData(colsDet),
    serie:
      pickCol(colsCab, [/^serie\s*facturacao$/i, /^seriefacturacao$/i, /^serie$/i]) ??
      colsCab.find((c) => /serie/i.test(c.name) && typeFamily(c.dataType) === "string")?.name ??
      null,
    numero: pickCol(colsCab, [/^numero\s*documento$/i, /^numero$/i]),
    tipoDocumento: pickCol(colsCab, [/^tipo\s*documento\s*id$/i, /^tipo\s*documento$/i]),
    estado: colsCab.find((c) => /fim\s*venda|estado|situacao/i.test(c.name))?.name ?? null,
    codigoId: pickCol(colsDet, [/^codigo\s*id$/i, /^codigoid$/i]),
    quantidade: pickCol(colsDet, [/^quantidade$/i, /^qtd$/i]),
    valor: pickCol(colsDet, [/^valor_eur$/i, /^valor$/i]),
    pvp: pickCol(colsDet, [/^preco\s*venda\s*publico_eur$/i, /^pvp_eur$/i, /^pvp$/i]),
    colsCab,
    colsDet,
  };
}

/** O que falta para o reader de crédito poder correr. */
export function faltasCredito(c: SchemaCredito): string[] {
  const falta: string[] = [];
  if (!c.detalheTabela) falta.push("tabela de detalhe");
  if (!c.cabecalhoTabela) falta.push("tabela de cabecalho");
  if (!c.detalhePk) falta.push("pk do detalhe (identidade da linha)");
  if (!c.cabecalhoPk) falta.push("pk do cabecalho");
  if (!c.chaveLigacao) falta.push("chave de ligacao detalhe->cabecalho");
  if (!c.data) falta.push("coluna de data");
  if (!c.codigoId) falta.push("CodigoID");
  if (!c.quantidade) falta.push("quantidade");
  return falta;
}

// ═════════════════════════════════════════════════════════════════════
// TRANSFERÊNCIAS
// ═════════════════════════════════════════════════════════════════════

export type SchemaTransf = {
  cabExiste: boolean;
  detExiste: boolean;
  cabPk: string | null;
  detPk: string | null;
  /** `MovStocksCabID` no detalhe — ligação lógica, FK opcional. */
  detChaveCab: string | null;
  /** `MovStocksDetID` em StocksMov — ligação lógica, FK opcional. */
  smChaveDet: string | null;
  /** `[Detalhe ID]` em StocksMov: se preenchido, a linha JÁ é venda G. */
  smChaveAtendimento: string | null;
  data: string | null;
  numero: string | null;
  nDocExterno: string | null;
  tipoDocumento: string | null;
  motivo: string | null;
  armazem: string | null;
  destino: string | null;
  situacao: string | null;
  colsCab: ColumnMeta[];
};

export async function descobrirTransferencias(pool: SqlPool): Promise<SchemaTransf> {
  const alvoCab = { schema: "dbo", table: T_MOV_CAB };
  const alvoDet = { schema: "dbo", table: T_MOV_DET };
  const alvoSm = { schema: "dbo", table: T_STOCKSMOV };
  const [cabExiste, detExiste] = await Promise.all([
    tableExists(pool, alvoCab),
    tableExists(pool, alvoDet),
  ]);
  const vazio: SchemaTransf = {
    cabExiste, detExiste, cabPk: null, detPk: null, detChaveCab: null,
    smChaveDet: null, smChaveAtendimento: null, data: null, numero: null,
    nDocExterno: null, tipoDocumento: null, motivo: null, armazem: null,
    destino: null, situacao: null, colsCab: [],
  };
  if (!cabExiste || !detExiste) return vazio;

  const colsCab = await listColumns(pool, alvoCab);
  const colsDet = await listColumns(pool, alvoDet);
  const colsSm = await listColumns(pool, alvoSm);
  const pkCab = await listPrimaryKey(pool, alvoCab);
  const pkDet = await listPrimaryKey(pool, alvoDet);

  return {
    ...vazio,
    cabPk: (pkCab.length === 1 ? pkCab[0]! : null) ?? tem(colsCab, "MovStocksCabID"),
    detPk: (pkDet.length === 1 ? pkDet[0]! : null) ?? tem(colsDet, "MovStocksDetID"),
    // A coluna existe nas duas tabelas — é ligação suficiente. Exigir FK
    // aqui foi o que bloqueou a rev75.
    detChaveCab: tem(colsDet, "MovStocksCabID"),
    smChaveDet: tem(colsSm, "MovStocksDetID"),
    smChaveAtendimento: tem(colsSm, "Detalhe ID"),
    data: tem(colsCab, "Data") ?? primeiraData(colsCab),
    numero: tem(colsCab, "NMovStocks") ?? pickCol(colsCab, [/^numero$/i]),
    nDocExterno: tem(colsCab, "NDocExterno"),
    tipoDocumento: tem(colsCab, "Tipo Documento ID") ?? pickCol(colsCab, [/tipo.*documento/i]),
    motivo: tem(colsCab, "MovStocksCabMotivoID") ?? pickCol(colsCab, [/motivo/i]),
    armazem: tem(colsCab, "ArmazemID") ?? pickCol(colsCab, [/armazem/i]),
    destino: tem(colsCab, "MovStocksCabDestinoID") ?? pickCol(colsCab, [/destino/i]),
    situacao: tem(colsCab, "MovStocksCabSituacaoID") ?? pickCol(colsCab, [/situacao/i]),
    colsCab,
  };
}

/**
 * Procura a tabela de lookup de um ID, e devolve as designações.
 *
 * Um `MovStocksCabMotivoID = 44` não é interpretável. Se o ERP tiver uma
 * tabela onde 44 tem um nome, a regra deixa de ser "o motivo 44" e passa
 * a ser "as transferências entre armazéns" — que é a diferença entre uma
 * regra que se defende e um número que se copiou.
 */
async function lookupDesignacoes(
  pool: SqlPool,
  coluna: string,
): Promise<{ tabela: string; valores: Map<number, string> } | null> {
  const r = await pool
    .request()
    .input("c", sql.NVarChar, coluna)
    .query<{ tabela: string }>(`
      SELECT t.name AS tabela
        FROM sys.tables t
        JOIN sys.columns c ON c.object_id = t.object_id
       WHERE t.is_ms_shipped = 0 AND c.name = @c
       ORDER BY (SELECT COUNT(*) FROM sys.columns x WHERE x.object_id = t.object_id)
    `);
  for (const { tabela } of r.recordset) {
    const cols = await listColumns(pool, { schema: "dbo", table: tabela });
    // Uma tabela de lookup é pequena e tem um texto ao lado do ID.
    const texto = cols.find(
      (c) => typeFamily(c.dataType) === "string" && !/guid|key/i.test(c.name),
    );
    if (!texto || cols.length > 12) continue;
    try {
      const v = await pool.request().query<{ id: number; nome: string }>(
        `SELECT ${quoteIdent(coluna)} AS id, ${quoteIdent(texto.name)} AS nome
           FROM [dbo].${quoteIdent(tabela)}`,
      );
      if (v.recordset.length === 0 || v.recordset.length > 500) continue;
      const m = new Map<number, string>();
      for (const x of v.recordset) m.set(Number(x.id), String(x.nome));
      return { tabela, valores: m };
    } catch {
      continue;
    }
  }
  return null;
}

/** As quatro leituras possíveis de uma quantidade de movimento. */
export const LEITURAS = [
  { chave: "SAIDAS", rotulo: "só as SAÍDAS (qtd<0), em absoluto" },
  { chave: "ENTRADAS", rotulo: "só as ENTRADAS (qtd>0)" },
  { chave: "AMBAS_SINAL", rotulo: "as DUAS, com sinal (líquido)" },
  { chave: "AMBAS_ABS", rotulo: "as DUAS, em valor absoluto" },
] as const;

export function exprLeitura(chave: string, qtd: string): string {
  switch (chave) {
    case "SAIDAS":
      return `SUM(CASE WHEN ${qtd} < 0 THEN ABS(CAST(${qtd} AS FLOAT)) ELSE 0 END)`;
    case "ENTRADAS":
      return `SUM(CASE WHEN ${qtd} > 0 THEN CAST(${qtd} AS FLOAT) ELSE 0 END)`;
    case "AMBAS_SINAL":
      return `SUM(CAST(${qtd} AS FLOAT))`;
    default:
      return `SUM(ABS(CAST(${qtd} AS FLOAT)))`;
  }
}

/** Um candidato a regra de transferência: universo + corte + leitura. */
type Candidato = {
  universo: string;
  fonte: string;
  qtd: string;
  data: string;
  corte: string;
  descricao: string;
  leitura: string;
};

// ═════════════════════════════════════════════════════════════════════

export async function vendasExtraDiscover(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    console.log("Uso: vendas-extra-discover [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--db <base>]");
    console.log("");
    console.log("Read-only. Descobre por ESTRUTURA (nao por FK) as fontes de venda");
    console.log("a credito e de guias de transferencia, resolve os lookups dos IDs");
    console.log("documentais, e testa candidatos justificaveis contra o gate mensal");
    console.log("do relatorio oficial com tolerancia zero.");
    return 0;
  }

  const j = janela(args.from, args.to);
  const base = loadConfig("sql");
  const cfg = args.db ? { ...base, sqlDatabase: args.db } : base;

  return withPool(cfg, async (pool) => {
    console.log(DOUBLE);
    console.log("vendas-extra-discover — READ-ONLY");
    console.log(DOUBLE);
    console.log(`ERP    : ${cfg.sqlDatabase}@${cfg.sqlHost}`);
    console.log(`Janela : ${j.inicio} .. ${j.fimExclusivo} (exclusivo)`);
    console.log("");
    console.log("FK declarada e uma PREFERENCIA, nunca uma pre-condicao. A rev75");
    console.log("concluiu 'nao ha credito' porque nao havia FK — e as tabelas");
    console.log("existiam. Aqui procura-se por sys.tables/sys.columns primeiro.");

    const req = () =>
      pool.request().input("from", sql.NVarChar, j.inicio).input("to", sql.NVarChar, j.fimExclusivo);

    // ═══ 1. CRÉDITO ═══════════════════════════════════════════════
    await seccao("1. CREDITO — descoberto por ESTRUTURA", async () => {
      const todas = await tabelasComNome(pool, ["credito"]);
      console.log(`  Tabelas com 'credito' no nome: ${todas.length}`);
      for (const t of todas) console.log(`    · ${t}`);

      const c = await descobrirCredito(pool);
      console.log("");
      console.log("  1.1 SCHEMA RESOLVIDO");
      console.log(`    cabecalho : ${c.cabecalhoTabela ?? "-"}  pk=${c.cabecalhoPk ?? "-"}`);
      console.log(`    detalhe   : ${c.detalheTabela ?? "-"}  pk=${c.detalhePk ?? "-"}`);
      console.log(`    ligacao   : ${c.chaveLigacao ?? "-"}  (${c.origemLigacao})`);
      console.log(`    data=${c.data ?? "-"}  serie=${c.serie ?? "-"}  numero=${c.numero ?? "-"}`);
      console.log(`    tipoDoc=${c.tipoDocumento ?? "-"}  estado=${c.estado ?? "-"}`);
      console.log(`    produto=${c.codigoId ?? "-"}  qtd=${c.quantidade ?? "-"}  valor=${c.valor ?? "-"}`);

      const falta = faltasCredito(c);
      if (falta.length > 0) {
        console.log("");
        console.log("    ✗ READER DE CREDITO IMPOSSIVEL — falta:");
        for (const f of falta) console.log(`      · ${f}`);
        console.log("    Isto NAO significa 'sem credito': significa que o schema");
        console.log("    desta instalacao nao expoe o que o reader precisa.");
        return;
      }
      console.log("");
      console.log("    ✓ SCHEMA SUFICIENTE — o reader de VENDAS_CREDITO pode correr.");

      const qCab = `[dbo].${quoteIdent(c.cabecalhoTabela!)}`;
      const qDet = `[dbo].${quoteIdent(c.detalheTabela!)}`;
      const lig = quoteIdent(c.chaveLigacao!);
      const fonte = `${qDet} d\n  JOIN ${qCab} h ON h.${lig} = d.${lig}`;
      const eData = `h.${quoteIdent(c.data!)}`;
      const eSerie = c.serie ? `h.${quoteIdent(c.serie)}` : "NULL";
      const eTipo = c.tipoDocumento ? `h.${quoteIdent(c.tipoDocumento)}` : "NULL";
      const eEstado = c.estado ? `h.${quoteIdent(c.estado)}` : "NULL";
      const eNumero = c.numero ? `h.${quoteIdent(c.numero)}` : "NULL";
      const eQtd = `d.${quoteIdent(c.quantidade!)}`;
      const eValor = c.valor ? `d.${quoteIdent(c.valor)}` : "NULL";

      console.log("");
      console.log("  1.2 mes x serie x tipoDoc x estado");
      const agg = await consultar<{
        mes: number; serie: string | null; tipo: number | null; estado: string | null;
        docs: number; linhas: number; quantidade: number; valor: number;
      }>(
        req(),
        [
          `SELECT MONTH(${eData}) AS mes, ${eSerie} AS serie, ${eTipo} AS tipo,`,
          `       ${eEstado} AS estado,`,
          `       COUNT(DISTINCT h.${quoteIdent(c.cabecalhoPk!)}) AS docs,`,
          "       COUNT(*) AS linhas,",
          `       SUM(CAST(${eQtd} AS FLOAT)) AS quantidade,`,
          `       SUM(CAST(${eValor} AS FLOAT)) AS valor`,
          `  FROM ${fonte}`,
          ` WHERE ${eData} >= @from AND ${eData} < @to`,
          ` GROUP BY MONTH(${eData}), ${eSerie}, ${eTipo}, ${eEstado}`,
          " ORDER BY 1, 2, 3, 4",
        ].join("\n"),
        "agregado de credito",
      );
      if (agg && agg.recordset.length === 0) {
        console.log("");
        console.log("    READER OK / ZERO DOCUMENTOS na janela.");
        console.log("    Nao e o mesmo que 'sem reader': a cadeia resolve, a query");
        console.log("    corre, e o ERP nao tem documentos de credito no periodo.");
      }
      for (const r of agg?.recordset ?? []) {
        console.log(
          `    ${nomeMes(Number(r.mes)).padEnd(6)}${formatCell(r.serie, 10).padEnd(11)}` +
            `tipo=${String(r.tipo ?? "-").padEnd(5)} estado=${formatCell(r.estado, 4).padEnd(5)}` +
            ` docs=${String(r.docs).padStart(6)} linhas=${String(r.linhas).padStart(7)}` +
            ` qtd=${String(r.quantidade).padStart(9)} valor=${String(Math.round(Number(r.valor ?? 0))).padStart(9)}`,
        );
      }
      if (agg && agg.recordset.length > 0) {
        console.log("");
        console.log("  1.3 DEZ DOCUMENTOS REAIS");
        const ex = await consultar<Record<string, unknown>>(
          req(),
          [
            "SELECT TOP 10",
            `       ${eData} AS data, ${eSerie} AS serie, ${eNumero} AS numero,`,
            `       ${eTipo} AS tipo, ${eEstado} AS estado,`,
            `       d.${quoteIdent(c.codigoId!)} AS codigoId, ${eQtd} AS quantidade,`,
            `       ${eValor} AS valor, d.${quoteIdent(c.detalhePk!)} AS linhaId`,
            `  FROM ${fonte}`,
            ` WHERE ${eData} >= @from AND ${eData} < @to`,
            ` ORDER BY ${eData} DESC`,
          ].join("\n"),
          "exemplos de credito",
        );
        for (const e of ex?.recordset ?? []) {
          console.log(
            `    ${formatCell(e.data, 19).slice(0, 10)} ${formatCell(e.serie, 9).padEnd(10)}` +
              `${String(e.numero ?? "-").padStart(9)} tipo=${String(e.tipo ?? "-").padEnd(4)}` +
              ` estado=${formatCell(e.estado, 4).padEnd(5)} cnpId=${String(e.codigoId).padEnd(9)}` +
              ` qtd=${String(e.quantidade).padStart(6)} linha=${String(e.linhaId)}`,
          );
        }
      }
    });

    // ═══ 2. TRANSFERÊNCIAS ════════════════════════════════════════
    await seccao("2. TRANSFERENCIAS — cabecalho+detalhe SEM depender de FK", async () => {
      const t = await descobrirTransferencias(pool);
      console.log("  2.1 SCHEMA RESOLVIDO");
      console.log(`    ${T_MOV_CAB}: existe=${t.cabExiste} pk=${t.cabPk ?? "-"}`);
      console.log(`    ${T_MOV_DET}: existe=${t.detExiste} pk=${t.detPk ?? "-"} chave->cab=${t.detChaveCab ?? "-"}`);
      console.log(`    ${T_STOCKSMOV}: chave->det=${t.smChaveDet ?? "-"} chave->atendimento=${t.smChaveAtendimento ?? "-"}`);
      console.log(`    data=${t.data ?? "-"} numero=${t.numero ?? "-"} nDocExterno=${t.nDocExterno ?? "-"}`);
      console.log(`    tipoDoc=${t.tipoDocumento ?? "-"} motivo=${t.motivo ?? "-"}`);
      console.log(`    armazem=${t.armazem ?? "-"} destino=${t.destino ?? "-"} situacao=${t.situacao ?? "-"}`);
      console.log("");
      console.log(`    NOTA: ${T_MOV_CAB} nao tem coluna de serie. A serie 'VCG_1/2169'`);
      console.log("    e composta noutro sitio — por isso a regra NAO pode ser por serie.");

      if (!t.cabExiste || !t.detExiste || !t.cabPk || !t.detChaveCab || !t.data) {
        console.log("");
        console.log("    Cadeia incompleta — sem candidatos possiveis.");
        return;
      }

      // ── 2.2 os lookups: dar nome aos IDs ───────────────────────
      console.log("");
      console.log("  2.2 LOOKUPS — o que significam os IDs");
      const nomes = new Map<string, Map<number, string>>();
      for (const col of [t.tipoDocumento, t.motivo, t.destino, t.situacao]) {
        if (!col) continue;
        const lk = await lookupDesignacoes(pool, col);
        if (lk) {
          nomes.set(col, lk.valores);
          console.log(`    ${col} -> [${lk.tabela}] (${lk.valores.size} valores)`);
          for (const [id, nome] of [...lk.valores].slice(0, 30)) {
            console.log(`      ${String(id).padStart(5)} = ${nome}`);
          }
        } else {
          console.log(`    ${col} -> sem tabela de designacoes encontrada`);
        }
      }
      const desig = (col: string | null, id: number | null): string => {
        if (!col || id === null) return "";
        const n = nomes.get(col)?.get(id);
        return n ? ` (${n})` : "";
      };

      const qCab = `[dbo].${quoteIdent(T_MOV_CAB)}`;
      const qDet = `[dbo].${quoteIdent(T_MOV_DET)}`;
      const cabPk = quoteIdent(t.cabPk);
      const eData = `c.${quoteIdent(t.data)}`;
      const eTipo = t.tipoDocumento ? `c.${quoteIdent(t.tipoDocumento)}` : "NULL";
      const eMotivo = t.motivo ? `c.${quoteIdent(t.motivo)}` : "NULL";
      const eDestino = t.destino ? `c.${quoteIdent(t.destino)}` : "NULL";

      // Universo 1: cabeçalho + detalhe, quantidade do detalhe.
      const fonteDet = `${qCab} c\n  JOIN ${qDet} d ON d.${quoteIdent(t.detChaveCab)} = c.${cabPk}`;
      const qtdDet = "d.[Quantidade]";
      // Universo 2: a mesma cadeia, mas a quantidade do LIVRO-RAZÃO.
      // `StocksMov` é onde o movimento real está, com sinal.
      const podeSm = !!(t.smChaveDet && t.detPk);
      const fonteSm = podeSm
        ? `${qCab} c\n  JOIN ${qDet} d ON d.${quoteIdent(t.detChaveCab)} = c.${cabPk}\n` +
          `  JOIN [dbo].${quoteIdent(T_STOCKSMOV)} sm ON sm.${quoteIdent(t.smChaveDet!)} = d.${quoteIdent(t.detPk!)}`
        : null;
      const qtdSm = "sm.[Qtd]";

      // ── 2.3 o inventário, com designações ──────────────────────
      console.log("");
      console.log("  2.3 INVENTARIO mes x tipoDoc x motivo x destino x sinal");
      const inv = await consultar<{
        mes: number; tipo: number | null; motivo: number | null; destino: number | null;
        sinal: string; docs: number; linhas: number; quantidade: number;
      }>(
        req(),
        [
          `SELECT MONTH(${eData}) AS mes, ${eTipo} AS tipo, ${eMotivo} AS motivo,`,
          `       ${eDestino} AS destino,`,
          `       CASE WHEN ${qtdDet} < 0 THEN 'NEG' WHEN ${qtdDet} > 0 THEN 'POS' ELSE 'ZERO' END AS sinal,`,
          `       COUNT(DISTINCT c.${cabPk}) AS docs, COUNT(*) AS linhas,`,
          `       SUM(CAST(${qtdDet} AS FLOAT)) AS quantidade`,
          `  FROM ${fonteDet}`,
          ` WHERE ${eData} >= @from AND ${eData} < @to`,
          ` GROUP BY MONTH(${eData}), ${eTipo}, ${eMotivo}, ${eDestino},`,
          `          CASE WHEN ${qtdDet} < 0 THEN 'NEG' WHEN ${qtdDet} > 0 THEN 'POS' ELSE 'ZERO' END`,
          " ORDER BY 2, 3, 1",
        ].join("\n"),
        "inventario de movimentos",
      );
      for (const r of (inv?.recordset ?? []).slice(0, 80)) {
        console.log(
          `    ${nomeMes(Number(r.mes)).padEnd(5)}tipo=${String(r.tipo ?? "-").padEnd(4)}${desig(t.tipoDocumento, r.tipo).padEnd(24)}` +
            `mot=${String(r.motivo ?? "-").padEnd(5)}${desig(t.motivo, r.motivo).padEnd(24)}` +
            `dst=${String(r.destino ?? "-").padEnd(5)}${r.sinal.padEnd(6)}` +
            `docs=${String(r.docs).padStart(5)} qtd=${String(r.quantidade).padStart(9)}`,
        );
      }
      if ((inv?.recordset.length ?? 0) > 80) {
        console.log(`    (+${inv!.recordset.length - 80} linhas omitidas)`);
      }

      // ── 2.4 sobreposição com a venda normal ────────────────────
      //
      // Um candidato que já esteja contado em NORMAL duplica. Isto
      // mede-o antes de qualquer gate: `StocksMov.[Detalhe ID]` não nulo
      // significa que a linha É uma venda de balcão.
      let sobreposicao = -1;
      if (podeSm && t.smChaveAtendimento) {
        const ov = await consultar<{ n: number; total: number }>(
          req(),
          [
            `SELECT SUM(CASE WHEN sm.${quoteIdent(t.smChaveAtendimento)} IS NOT NULL THEN 1 ELSE 0 END) AS n,`,
            "       COUNT(*) AS total",
            `  FROM ${fonteSm}`,
            ` WHERE ${eData} >= @from AND ${eData} < @to`,
          ].join("\n"),
          "sobreposicao com a venda normal",
        );
        sobreposicao = Number(ov?.recordset[0]?.n ?? -1);
        console.log("");
        console.log(
          `  2.4 SOBREPOSICAO COM NORMAL: ${sobreposicao} de ${ov?.recordset[0]?.total ?? "?"} linhas ` +
            `tem [${t.smChaveAtendimento}] preenchido`,
        );
        console.log("      Linhas com esse campo preenchido JA entram pelo circuito G.");
        console.log("      Um candidato que as inclua duplica unidades.");
      }

      // ── 2.5 candidatos contra o gate ───────────────────────────
      console.log("");
      console.log(RULE);
      console.log("  2.5 CANDIDATOS CONTRA O GATE MENSAL (tolerancia ZERO)");
      console.log(RULE);

      const tipos = [...new Set((inv?.recordset ?? []).map((r) => r.tipo).filter((x) => x !== null))] as number[];
      const motivos = [...new Set((inv?.recordset ?? []).map((r) => r.motivo))];

      const cortes: Array<{ cond: string; desc: string }> = [
        { cond: "1=1", desc: "todos os movimentos" },
        ...tipos.map((td) => ({
          cond: `${eTipo} = ${td}`,
          desc: `tipoDoc ${td}${desig(t.tipoDocumento, td)}`,
        })),
        ...(t.destino
          ? [
              { cond: `${eDestino} IS NOT NULL`, desc: "com destino definido (transferência dirigida)" },
              { cond: `${eDestino} IS NULL`, desc: "sem destino definido" },
            ]
          : []),
        ...tipos.flatMap((td) =>
          motivos
            .filter((m) => m !== null)
            .map((m) => ({
              cond: `${eTipo} = ${td} AND ${eMotivo} = ${m}`,
              desc: `tipoDoc ${td}${desig(t.tipoDocumento, td)} + motivo ${m}${desig(t.motivo, m)}`,
            })),
        ),
      ];

      const universos: Array<{ nome: string; fonte: string; qtd: string }> = [
        { nome: "detalhe (tblMovStocksDet.Quantidade)", fonte: fonteDet, qtd: qtdDet },
        ...(fonteSm ? [{ nome: "livro-razao (StocksMov.Qtd)", fonte: fonteSm, qtd: qtdSm }] : []),
      ];

      const aprovados: Candidato[] = [];
      let avaliados = 0;
      for (const u of universos) {
        for (const corte of cortes) {
          for (const l of LEITURAS) {
            avaliados++;
            const r = await consultar<{ mes: number; total: number }>(
              req(),
              [
                `SELECT MONTH(${eData}) AS mes, ${exprLeitura(l.chave, u.qtd)} AS total`,
                `  FROM ${u.fonte}`,
                ` WHERE ${eData} >= @from AND ${eData} < @to AND ${corte.cond}`,
                ` GROUP BY MONTH(${eData})`,
              ].join("\n"),
              `${u.nome} / ${corte.desc} / ${l.chave}`,
            );
            if (!r) continue;
            const porMes = new Map<number, number>();
            for (const x of r.recordset) porMes.set(Number(x.mes), Number(x.total ?? 0));
            const res = GATES_SILVEIRENSE_2026.map((g) =>
              avaliarGate(g.mes, g.transferencias, Math.round(porMes.get(g.mes) ?? 0)),
            );
            if (res.every((x) => x.passa)) {
              aprovados.push({
                universo: u.nome, fonte: u.fonte, qtd: u.qtd, data: eData,
                corte: corte.cond, descricao: corte.desc, leitura: l.chave,
              });
              console.log("");
              for (const ln of renderGates(
                `★ ${u.nome} | ${corte.desc} | ${l.rotulo}`,
                res,
              )) {
                console.log(ln);
              }
            }
          }
        }
      }
      console.log("");
      console.log(`  ${avaliados} candidatos avaliados, ${aprovados.length} com 7/7 desvio zero.`);

      if (aprovados.length === 0) {
        console.log("");
        console.log("  NENHUM CANDIDATO REPRODUZ O GATE.");
        console.log("");
        console.log("  Isto NAO e uma falha da sonda — e a informacao de que a");
        console.log("  populacao do relatorio nao esta neste universo. O MENOR");
        console.log("  CONJUNTO DE INFORMACAO EM FALTA e:");
        console.log("");
        console.log("   1. Onde e composta a serie 'VCG_1/2169'? Nao esta em");
        console.log(`      ${T_MOV_CAB}. Query:`);
        console.log("        SELECT t.name, c.name FROM sys.columns c");
        console.log("          JOIN sys.tables t ON t.object_id=c.object_id");
        console.log("         WHERE c.name LIKE '%Serie%' AND t.is_ms_shipped=0;");
        console.log("");
        console.log("   2. Um documento VCG_1 concreto, do lado do ERP, com a data");
        console.log("      e o total que o relatorio lhe atribui. Com um so exemplo");
        console.log("      a cadeia fecha-se por conteudo, como se fez com as VSG.");
        console.log("");
        console.log("   3. Se o relatorio soma linhas de OUTRO circuito (ex: vendas");
        console.log("      a entidades/farmacias no proprio Atendimento), a query:");
        console.log("        SELECT MONTH([Data Venda]) mes, [Tipo Documento] tipo,");
        console.log("               COUNT(*) linhas, SUM(d.[Quantidade]) qtd");
        console.log("          FROM dbo.Atendimento a");
        console.log("          JOIN dbo.[Atendimento Detalhe] d");
        console.log("            ON d.[Atendimento ID]=a.[Atendimento ID]");
        console.log("         WHERE a.[Data Venda]>='2026-01-01'");
        console.log("           AND a.[Data Venda]<'2026-08-01'");
        console.log("         GROUP BY MONTH([Data Venda]),[Tipo Documento];");
        console.log("");
        console.log("  NAO implementar o reader com um candidato que nao bate.");
        return;
      }

      // ── 2.6 os aprovados, com prova documental ─────────────────
      console.log("");
      console.log(RULE);
      console.log("  2.6 PROVA DOCUMENTAL DOS APROVADOS");
      console.log(RULE);
      if (aprovados.length > 1) {
        console.log("  Mais do que um candidato bate. A regra a implementar e a mais");
        console.log("  SIMPLES com leitura documental coerente — ver as amostras.");
      }
      for (const a of aprovados.slice(0, 3)) {
        console.log("");
        console.log(`  ── ${a.universo} | ${a.descricao} | ${a.leitura}`);
        const ex = await consultar<Record<string, unknown>>(
          req(),
          [
            "SELECT TOP 10",
            `       ${eData} AS data,`,
            `       ${t.numero ? `c.${quoteIdent(t.numero)}` : "NULL"} AS numero,`,
            `       ${t.nDocExterno ? `c.${quoteIdent(t.nDocExterno)}` : "NULL"} AS ndoc,`,
            `       ${eTipo} AS tipo, ${eMotivo} AS motivo, ${eDestino} AS destino,`,
            `       ${t.armazem ? `c.${quoteIdent(t.armazem)}` : "NULL"} AS armazem,`,
            "       d.[CodigoID] AS codigoId,",
            `       ${a.qtd} AS quantidade, c.${cabPk} AS docId`,
            `  FROM ${a.fonte}`,
            ` WHERE ${eData} >= @from AND ${eData} < @to AND ${a.corte}`,
            ` ORDER BY ${eData} DESC`,
          ].join("\n"),
          "amostra do candidato",
        );
        for (const e of ex?.recordset ?? []) {
          console.log(
            `    ${formatCell(e.data, 19).slice(0, 10)} doc=${String(e.docId).padEnd(8)}` +
              ` n=${String(e.numero ?? "-").padEnd(8)} ndoc=${formatCell(e.ndoc, 12).padEnd(13)}` +
              ` tipo=${String(e.tipo ?? "-").padEnd(4)} mot=${String(e.motivo ?? "-").padEnd(4)}` +
              ` dst=${String(e.destino ?? "-").padEnd(5)} arm=${String(e.armazem ?? "-").padEnd(4)}` +
              ` cnpId=${String(e.codigoId).padEnd(9)} qtd=${String(e.quantidade).padStart(6)}`,
          );
        }
        console.log("");
        console.log("    A REGRA A DECLARAR em REGRA_TRANSFERENCIA (vendas-fontes.ts):");
        console.log(`      universo  : ${a.universo}`);
        console.log(`      corte     : ${a.corte}`);
        console.log(`      direccao  : ${a.leitura}`);
        if (sobreposicao > 0) {
          console.log(`      ATENCAO: ${sobreposicao} linhas deste universo tem [Detalhe ID]`);
          console.log("      preenchido e JA entram por NORMAL. Confirmar que o corte");
          console.log("      acima as exclui, senao ha dupla contagem.");
        }
      }
    });

    console.log("");
    console.log(DOUBLE);
    console.log("FIM — nada foi escrito. Nenhum POST ao SaaS.");
    console.log(DOUBLE);
    return 0;
  });
}
