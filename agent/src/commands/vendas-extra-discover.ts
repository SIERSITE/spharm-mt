/**
 * agent/src/commands/vendas-extra-discover.ts
 *
 * As duas populações que faltam ao mapa: vendas a crédito e guias de
 * transferência. Read-only, sem POST, sem escrita.
 *
 * ── O QUE ISTO TEM DE RESOLVER ───────────────────────────────────────
 *
 * O relatório oficial do SPharm tem dois interruptores. O SPharm.MT já
 * tem a dimensão (`naturezaVenda`), a agregação e os filtros — falta a
 * matéria-prima. Este comando descobre onde ela está.
 *
 * CRÉDITO parte de uma FK que o `stocksmov` já usa desde a rev33:
 * `StocksMov.[Atendimento Credito Detalhe ID]`. A tabela do outro lado
 * resolve-se por `sys.foreign_key_columns`, e o cabeçalho a partir dela.
 * Nenhum nome é escrito à mão.
 *
 * TRANSFERÊNCIAS partem de `tblMovStocksCab` + `tblMovStocksDet` +
 * `StocksMov`, que é a cadeia que o `stocksmov` já percorre. A série
 * `VCG_1/2169` vive no cabeçalho.
 *
 * ── A PERGUNTA QUE SÓ OS DADOS RESPONDEM ─────────────────────────────
 *
 * Uma transferência tem dois lados. O relatório do SPharm é de VENDAS da
 * farmácia, e nada no nome da série diz qual dos lados ele conta:
 *
 *   · só as saídas?
 *   · só as entradas?
 *   · as duas, com sinal?
 *
 * Adivinhar dá três respostas plausíveis e duas erradas. Por isso este
 * comando calcula as TRÊS e compara cada uma com o gate mensal do
 * relatório oficial, com tolerância zero. A que passar é a regra — e se
 * nenhuma passar, isso também é um resultado, e é melhor sabê-lo aqui do
 * que depois de um backfill.
 *
 * Uso:
 *   agent -- vendas-extra-discover [--from 2026-01-01] [--to 2026-08-20] [--db <base>]
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { janela } from "../janela.js";
import {
  GATES_SILVEIRENSE_2026,
  avaliarGate,
  nomeMes,
  renderGates,
} from "../gates-silveirense.js";
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
const COL_CREDITO_FK = "Atendimento Credito Detalhe ID";
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
    to: typeof raw.values.to === "string" ? raw.values.to : "2026-08-20",
    db: typeof raw.values.db === "string" ? raw.values.db : undefined,
    help: raw.values.help === true,
  };
}

/** Corre uma query e, se falhar, imprime o SQL. Nunca leva a secção atrás. */
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

/** O mapa de colunas de uma tabela, impresso para o operador ver. */
function mostrarColunas(rotulo: string, cols: ColumnMeta[], filtro: RegExp): void {
  const relevantes = cols.filter((c) => filtro.test(c.name));
  console.log(`    ${rotulo} (${cols.length} colunas, ${relevantes.length} relevantes):`);
  for (const c of relevantes) console.log(`      · ${c.name} (${c.dataType})`);
}

// ─────────────────────────────────────────────────────────────────────
// CRÉDITO
// ─────────────────────────────────────────────────────────────────────

type SchemaCredito = {
  detalheTabela: string | null;
  detalhePk: string | null;
  cabecalhoTabela: string | null;
  cabecalhoPk: string | null;
  detalheFkCabecalho: string | null;
  data: string | null;
  serie: string | null;
  numero: string | null;
  tipoDocumento: string | null;
  estado: string | null;
  codigoId: string | null;
  quantidade: string | null;
  valor: string | null;
  pvp: string | null;
};

async function descobrirCredito(pool: SqlPool): Promise<SchemaCredito> {
  const vazio: SchemaCredito = {
    detalheTabela: null, detalhePk: null, cabecalhoTabela: null, cabecalhoPk: null,
    detalheFkCabecalho: null, data: null, serie: null, numero: null,
    tipoDocumento: null, estado: null, codigoId: null, quantidade: null,
    valor: null, pvp: null,
  };

  // A ponte: a FK DECLARADA que sai de StocksMov pela coluna que o
  // pipeline de movimentos já lê. Nunca pelo nome da tabela.
  const fks = await listForeignKeysOut(pool, { schema: "dbo", table: T_STOCKSMOV });
  const edge = fks.find((f) =>
    f.fromColumns.some((c) => c.toLowerCase() === COL_CREDITO_FK.toLowerCase()),
  );
  const detalheTabela = edge ? edge.toTable.replace(/^dbo\./i, "") : null;
  if (!detalheTabela) return vazio;

  const alvoDet = { schema: "dbo", table: detalheTabela };
  if (!(await tableExists(pool, alvoDet))) return { ...vazio, detalheTabela };
  const colsDet = await listColumns(pool, alvoDet);
  const pkDet = await listPrimaryKey(pool, alvoDet);

  // O cabeçalho: a única FK que sai do detalhe e não volta ao catálogo.
  const fksDet = await listForeignKeysOut(pool, alvoDet);
  const cabEdge = fksDet.find((f) => {
    const t = f.toTable.replace(/^dbo\./i, "").toLowerCase();
    return t !== "stocks" && t !== "entidades" && t !== detalheTabela.toLowerCase();
  });
  const cabecalhoTabela = cabEdge ? cabEdge.toTable.replace(/^dbo\./i, "") : null;

  let colsCab: ColumnMeta[] = [];
  let pkCab: string[] = [];
  if (cabecalhoTabela && (await tableExists(pool, { schema: "dbo", table: cabecalhoTabela }))) {
    colsCab = await listColumns(pool, { schema: "dbo", table: cabecalhoTabela });
    pkCab = await listPrimaryKey(pool, { schema: "dbo", table: cabecalhoTabela });
  }

  return {
    detalheTabela,
    detalhePk: pkDet.length === 1 ? pkDet[0]! : null,
    cabecalhoTabela,
    cabecalhoPk: pkCab.length === 1 ? pkCab[0]! : null,
    detalheFkCabecalho: cabEdge?.fromColumns[0] ?? null,
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
    estado: colsCab.find((c) => /fim.*venda|estado|situacao/i.test(c.name))?.name ?? null,
    codigoId: pickCol(colsDet, [/^codigo\s*id$/i, /^codigoid$/i]),
    quantidade: pickCol(colsDet, [/^quantidade$/i, /^qtd$/i]),
    valor: pickCol(colsDet, [/^valor_eur$/i, /^valor$/i]),
    pvp: pickCol(colsDet, [/^preco\s*venda\s*publico_eur$/i, /^pvp_eur$/i, /^pvp$/i]),
  };
}

// ─────────────────────────────────────────────────────────────────────
// TRANSFERÊNCIAS
// ─────────────────────────────────────────────────────────────────────

type SchemaTransf = {
  cabExiste: boolean;
  detExiste: boolean;
  cabPk: string | null;
  detPk: string | null;
  detFkCab: string | null;
  smFkDet: string | null;
  data: string | null;
  serie: string | null;
  numero: string | null;
  tipoDocumento: string | null;
  motivo: string | null;
  /** Armazém/entidade de origem e destino, se o cabeçalho os expuser. */
  origem: string | null;
  destino: string | null;
  entidade: string | null;
  colsCab: ColumnMeta[];
};

async function descobrirTransferencias(pool: SqlPool): Promise<SchemaTransf> {
  const alvoCab = { schema: "dbo", table: T_MOV_CAB };
  const alvoDet = { schema: "dbo", table: T_MOV_DET };
  const [cabExiste, detExiste] = await Promise.all([
    tableExists(pool, alvoCab),
    tableExists(pool, alvoDet),
  ]);
  const vazio: SchemaTransf = {
    cabExiste, detExiste, cabPk: null, detPk: null, detFkCab: null, smFkDet: null,
    data: null, serie: null, numero: null, tipoDocumento: null, motivo: null,
    origem: null, destino: null, entidade: null, colsCab: [],
  };
  if (!cabExiste) return vazio;

  const colsCab = await listColumns(pool, alvoCab);
  const pkCab = await listPrimaryKey(pool, alvoCab);
  const colsDet = detExiste ? await listColumns(pool, alvoDet) : [];
  const pkDet = detExiste ? await listPrimaryKey(pool, alvoDet) : [];
  const fksDet = detExiste ? await listForeignKeysOut(pool, alvoDet) : [];
  const fksSm = await listForeignKeysOut(pool, { schema: "dbo", table: T_STOCKSMOV });

  const detFkCab =
    fksDet.find((f) => f.toTable.replace(/^dbo\./i, "").toLowerCase() === T_MOV_CAB.toLowerCase())
      ?.fromColumns[0] ??
    pickCol(colsDet, [/^movstockscabid$/i]);
  const smFkDet =
    fksSm.find((f) => f.toTable.replace(/^dbo\./i, "").toLowerCase() === T_MOV_DET.toLowerCase())
      ?.fromColumns[0] ?? null;

  return {
    ...vazio,
    cabPk: pkCab.length === 1 ? pkCab[0]! : pickCol(colsCab, [/^movstockscabid$/i]),
    detPk: pkDet.length === 1 ? pkDet[0]! : pickCol(colsDet, [/^movstocksdetid$/i]),
    detFkCab,
    smFkDet,
    data: pickCol(colsCab, [/^data\s*mov$/i, /^datamov$/i, /^data$/i]) ?? primeiraData(colsCab),
    serie:
      pickCol(colsCab, [/^serie$/i, /^serie\s*documento$/i]) ??
      colsCab.find((c) => /serie/i.test(c.name) && typeFamily(c.dataType) === "string")?.name ??
      null,
    numero: pickCol(colsCab, [/^numero$/i, /^numero\s*documento$/i, /^ndoc/i]),
    tipoDocumento: pickCol(colsCab, [/^tipo\s*documento\s*id$/i, /^tipo\s*documento$/i]),
    motivo: pickCol(colsCab, [/motivo/i]),
    // Origem/destino: propriedade ESTRUTURAL, preferível a qualquer regra
    // por nome de série. Só se usa o que existir mesmo.
    origem: colsCab.find((c) => /origem|armazem.*sai|sai.*armazem/i.test(c.name))?.name ?? null,
    destino: colsCab.find((c) => /destino|armazem.*ent|ent.*armazem/i.test(c.name))?.name ?? null,
    entidade: colsCab.find((c) => /entidade|farmacia|cliente/i.test(c.name))?.name ?? null,
    colsCab,
  };
}

/** As três leituras possíveis de uma transferência. */
type Hipotese = { chave: string; rotulo: string; expr: string };

function hipoteses(qtd: string): Hipotese[] {
  return [
    {
      chave: "SAIDAS",
      rotulo: "só as SAÍDAS, em valor absoluto",
      expr: `SUM(CASE WHEN ${qtd} < 0 THEN ABS(CAST(${qtd} AS FLOAT)) ELSE 0 END)`,
    },
    {
      chave: "ENTRADAS",
      rotulo: "só as ENTRADAS, em valor absoluto",
      expr: `SUM(CASE WHEN ${qtd} > 0 THEN CAST(${qtd} AS FLOAT) ELSE 0 END)`,
    },
    {
      chave: "AMBAS_SINAL",
      rotulo: "as DUAS, com sinal (líquido)",
      expr: `SUM(CAST(${qtd} AS FLOAT))`,
    },
    {
      chave: "AMBAS_ABS",
      rotulo: "as DUAS, em valor absoluto",
      expr: `SUM(ABS(CAST(${qtd} AS FLOAT)))`,
    },
  ];
}

/** Família da série: VCG, VCG_1, ou outra. Só para CORTAR, não para decidir. */
function familia(serie: string | null): string {
  const s = (serie ?? "").trim().toUpperCase();
  if (s === "VCG_1") return "VCG_1";
  if (s === "VCG") return "VCG";
  return s || "(nula)";
}

// ─────────────────────────────────────────────────────────────────────

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
    console.log("Read-only. Descobre por FK as fontes de venda a credito e de");
    console.log("guias de transferencia, e testa as tres leituras possiveis da");
    console.log("transferencia contra o gate mensal do relatorio oficial.");
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
    console.log("Nenhuma tabela e nomeada a mao: tudo sai de sys.foreign_key_columns,");
    console.log("sys.indexes e sys.columns. O que nao resolver aparece como '-'.");

    const req = () =>
      pool.request().input("from", sql.NVarChar, j.inicio).input("to", sql.NVarChar, j.fimExclusivo);

    // ══ CRÉDITO ═══════════════════════════════════════════════════
    await seccao("1. CREDITO — a partir de StocksMov.[Atendimento Credito Detalhe ID]", async () => {
      const c = await descobrirCredito(pool);
      console.log("  1.1 SCHEMA");
      console.log(`    detalhe   : ${c.detalheTabela ?? "NAO RESOLVE"}  pk=${c.detalhePk ?? "-"}`);
      console.log(`    cabecalho : ${c.cabecalhoTabela ?? "-"}  pk=${c.cabecalhoPk ?? "-"}  fk=${c.detalheFkCabecalho ?? "-"}`);
      console.log(`    data=${c.data ?? "-"}  serie=${c.serie ?? "-"}  numero=${c.numero ?? "-"}`);
      console.log(`    tipoDoc=${c.tipoDocumento ?? "-"}  estado=${c.estado ?? "-"}`);
      console.log(`    produto=${c.codigoId ?? "-"}  qtd=${c.quantidade ?? "-"}  valor=${c.valor ?? "-"}  pvp=${c.pvp ?? "-"}`);

      if (!c.detalheTabela) {
        console.log("");
        console.log("    A FK nao existe nesta instalacao: nao ha universo de credito.");
        console.log("    Para a Silveirense isto e o esperado — o utilizador confirmou");
        console.log("    que a farmacia nao emite vendas a credito.");
        return;
      }
      if (!c.detalhePk || !c.codigoId || !c.quantidade) {
        console.log("");
        console.log("    Colunas essenciais por resolver — sem reader possivel.");
        return;
      }

      const qDet = `[dbo].${quoteIdent(c.detalheTabela)}`;
      const temCab = !!(c.cabecalhoTabela && c.cabecalhoPk && c.detalheFkCabecalho);
      const fonte = temCab
        ? `${qDet} d\n  JOIN [dbo].${quoteIdent(c.cabecalhoTabela!)} h ON h.${quoteIdent(c.cabecalhoPk!)} = d.${quoteIdent(c.detalheFkCabecalho!)}`
        : `${qDet} d`;
      const pref = temCab ? "h." : "d.";
      const eData = c.data ? `${pref}${quoteIdent(c.data)}` : null;
      const eSerie = c.serie ? `${pref}${quoteIdent(c.serie)}` : "NULL";
      const eTipo = c.tipoDocumento ? `${pref}${quoteIdent(c.tipoDocumento)}` : "NULL";
      const eNumero = c.numero ? `${pref}${quoteIdent(c.numero)}` : "NULL";
      const eEstado = c.estado ? `${pref}${quoteIdent(c.estado)}` : "NULL";
      const eQtd = `d.${quoteIdent(c.quantidade)}`;
      const eValor = c.valor ? `d.${quoteIdent(c.valor)}` : "NULL";
      if (!eData) {
        console.log("    Sem coluna de data — nao da para agregar por mes.");
        return;
      }

      console.log("");
      console.log("  1.2 AGREGADO mes x serie x tipo x sinal");
      const agg = await consultar<{
        mes: number; serie: string | null; tipo: number | null; sinal: string;
        docs: number; linhas: number; quantidade: number; valor: number;
      }>(
        req(),
        [
          `SELECT MONTH(${eData}) AS mes,`,
          `       ${eSerie} AS serie,`,
          `       ${eTipo} AS tipo,`,
          `       CASE WHEN ${eQtd} < 0 THEN 'NEG' WHEN ${eQtd} > 0 THEN 'POS' ELSE 'ZERO' END AS sinal,`,
          `       COUNT(DISTINCT ${temCab ? `h.${quoteIdent(c.cabecalhoPk!)}` : `d.${quoteIdent(c.detalhePk)}`}) AS docs,`,
          "       COUNT(*) AS linhas,",
          `       SUM(CAST(${eQtd} AS FLOAT)) AS quantidade,`,
          `       SUM(CAST(${eValor} AS FLOAT)) AS valor`,
          `  FROM ${fonte}`,
          ` WHERE ${eData} >= @from AND ${eData} < @to`,
          ` GROUP BY MONTH(${eData}), ${eSerie}, ${eTipo},`,
          `          CASE WHEN ${eQtd} < 0 THEN 'NEG' WHEN ${eQtd} > 0 THEN 'POS' ELSE 'ZERO' END`,
          " ORDER BY 1, 2, 3, 4",
        ].join("\n"),
        "agregado de credito",
      );
      if (agg && agg.recordset.length === 0) {
        console.log("    (ZERO linhas de credito na janela — coerente com a Silveirense)");
      }
      if (agg && agg.recordset.length > 0) {
        console.log(
          `    ${"mes".padEnd(6)}${"serie".padEnd(10)}${"tipo".padStart(6)}${"sinal".padStart(7)}` +
            `${"docs".padStart(8)}${"linhas".padStart(8)}${"qtd".padStart(11)}${"valor".padStart(12)}`,
        );
        for (const r of agg.recordset) {
          console.log(
            `    ${nomeMes(Number(r.mes)).padEnd(6)}${formatCell(r.serie, 9).padEnd(10)}` +
              `${String(r.tipo ?? "-").padStart(6)}${r.sinal.padStart(7)}` +
              `${String(r.docs).padStart(8)}${String(r.linhas).padStart(8)}` +
              `${String(r.quantidade).padStart(11)}${String(Math.round(Number(r.valor ?? 0)))
                .padStart(12)}`,
          );
        }

        console.log("");
        console.log("  1.3 DEZ DOCUMENTOS REAIS");
        const ex = await consultar<Record<string, unknown>>(
          req(),
          [
            "SELECT TOP 10",
            `       ${eData} AS data, ${eSerie} AS serie, ${eNumero} AS numero,`,
            `       ${eTipo} AS tipo, ${eEstado} AS estado,`,
            `       d.${quoteIdent(c.codigoId)} AS codigoId, ${eQtd} AS quantidade,`,
            `       ${eValor} AS valor, d.${quoteIdent(c.detalhePk)} AS linhaId`,
            `  FROM ${fonte}`,
            ` WHERE ${eData} >= @from AND ${eData} < @to`,
            ` ORDER BY ${eData} DESC`,
          ].join("\n"),
          "exemplos de credito",
        );
        for (const e of ex?.recordset ?? []) {
          console.log(
            `    ${formatCell(e.data, 19).slice(0, 10)} ${formatCell(e.serie, 8).padEnd(9)}` +
              `${String(e.numero ?? "-").padStart(9)} tipo=${String(e.tipo ?? "-").padEnd(5)}` +
              ` estado=${formatCell(e.estado, 6).padEnd(7)} cnpId=${String(e.codigoId).padEnd(9)}` +
              ` qtd=${String(e.quantidade).padStart(6)} linha=${String(e.linhaId)}`,
          );
        }
      }
    });

    // ══ TRANSFERÊNCIAS ════════════════════════════════════════════
    await seccao("2. TRANSFERENCIAS — tblMovStocksCab + tblMovStocksDet + StocksMov", async () => {
      const t = await descobrirTransferencias(pool);
      console.log("  2.1 SCHEMA");
      console.log(`    ${T_MOV_CAB}: existe=${t.cabExiste} pk=${t.cabPk ?? "-"}`);
      console.log(`    ${T_MOV_DET}: existe=${t.detExiste} pk=${t.detPk ?? "-"} fk->cab=${t.detFkCab ?? "-"}`);
      console.log(`    ${T_STOCKSMOV}: fk->det=${t.smFkDet ?? "-"}`);
      console.log(`    data=${t.data ?? "-"} serie=${t.serie ?? "-"} numero=${t.numero ?? "-"}`);
      console.log(`    tipoDoc=${t.tipoDocumento ?? "-"} motivo=${t.motivo ?? "-"}`);
      console.log(`    origem=${t.origem ?? "-"} destino=${t.destino ?? "-"} entidade=${t.entidade ?? "-"}`);
      if (t.colsCab.length > 0) {
        mostrarColunas(
          T_MOV_CAB,
          t.colsCab,
          /serie|numero|data|tipo|motivo|origem|destino|entidade|farmacia|armazem|situacao|doc/i,
        );
      }
      if (!t.cabExiste || !t.cabPk || !t.detFkCab || !t.smFkDet || !t.data || !t.serie) {
        console.log("");
        console.log("    Cadeia incompleta — sem reader possivel. Falta:");
        for (const [n, v] of [
          [T_MOV_CAB, t.cabExiste ? "ok" : null],
          ["pk do cabecalho", t.cabPk],
          ["fk detalhe->cabecalho", t.detFkCab],
          ["fk StocksMov->detalhe", t.smFkDet],
          ["data", t.data],
          ["serie", t.serie],
        ] as const) {
          if (!v) console.log(`      · ${n}`);
        }
        return;
      }

      const fonte =
        `[dbo].${quoteIdent(T_STOCKSMOV)} sm\n` +
        `  JOIN [dbo].${quoteIdent(T_MOV_DET)} det ON det.${quoteIdent(t.detPk ?? "MovStocksDetID")} = sm.${quoteIdent(t.smFkDet)}\n` +
        `  JOIN [dbo].${quoteIdent(T_MOV_CAB)} cab ON cab.${quoteIdent(t.cabPk)} = det.${quoteIdent(t.detFkCab)}`;
      const eData = `cab.${quoteIdent(t.data)}`;
      const eSerie = `cab.${quoteIdent(t.serie)}`;
      const eQtd = "sm.[Qtd]";
      const eTipo = t.tipoDocumento ? `cab.${quoteIdent(t.tipoDocumento)}` : "NULL";

      console.log("");
      console.log("  2.2 FAMILIAS DE SERIE — mes x serie x sinal");
      const agg = await consultar<{
        mes: number; serie: string | null; tipo: number | null; sinal: string;
        docs: number; linhas: number; quantidade: number;
      }>(
        req(),
        [
          `SELECT MONTH(${eData}) AS mes,`,
          `       ${eSerie} AS serie,`,
          `       ${eTipo} AS tipo,`,
          `       CASE WHEN ${eQtd} < 0 THEN 'NEG' WHEN ${eQtd} > 0 THEN 'POS' ELSE 'ZERO' END AS sinal,`,
          `       COUNT(DISTINCT cab.${quoteIdent(t.cabPk)}) AS docs,`,
          "       COUNT(*) AS linhas,",
          `       SUM(CAST(${eQtd} AS FLOAT)) AS quantidade`,
          `  FROM ${fonte}`,
          ` WHERE ${eData} >= @from AND ${eData} < @to`,
          ` GROUP BY MONTH(${eData}), ${eSerie}, ${eTipo},`,
          `          CASE WHEN ${eQtd} < 0 THEN 'NEG' WHEN ${eQtd} > 0 THEN 'POS' ELSE 'ZERO' END`,
          " ORDER BY 2, 1, 4",
        ].join("\n"),
        "agregado de transferencias",
      );
      type LinhaTransf = {
        mes: number; serie: string | null; tipo: number | null; sinal: string;
        docs: number; linhas: number; quantidade: number;
      };
      const porFamilia = new Map<string, LinhaTransf[]>();
      for (const r of agg?.recordset ?? []) {
        const f = familia(r.serie);
        const l = porFamilia.get(f);
        if (l) l.push(r);
        else porFamilia.set(f, [r]);
      }
      console.log(
        `    ${"familia".padEnd(10)}${"mes".padEnd(6)}${"tipo".padStart(6)}${"sinal".padStart(7)}` +
          `${"docs".padStart(8)}${"linhas".padStart(8)}${"quantidade".padStart(13)}`,
      );
      for (const [f, linhas] of porFamilia) {
        for (const r of linhas) {
          console.log(
            `    ${f.padEnd(10)}${nomeMes(Number(r.mes)).padEnd(6)}${String(r.tipo ?? "-").padStart(6)}` +
              `${r.sinal.padStart(7)}${String(r.docs).padStart(8)}${String(r.linhas).padStart(8)}` +
              `${String(r.quantidade).padStart(13)}`,
          );
        }
      }

      console.log("");
      console.log("  2.3 DEZ DOCUMENTOS REAIS DE CADA FAMILIA");
      for (const f of porFamilia.keys()) {
        console.log("");
        console.log(`    ── familia ${f}`);
        const cond = f === "(nula)" ? `${eSerie} IS NULL` : `${eSerie} = '${f.replace(/'/g, "''")}'`;
        const ex = await consultar<Record<string, unknown>>(
          req(),
          [
            "SELECT TOP 10",
            `       ${eData} AS data, ${eSerie} AS serie,`,
            `       ${t.numero ? `cab.${quoteIdent(t.numero)}` : "NULL"} AS numero,`,
            `       ${eTipo} AS tipo,`,
            `       ${t.motivo ? `cab.${quoteIdent(t.motivo)}` : "NULL"} AS motivo,`,
            `       ${t.origem ? `cab.${quoteIdent(t.origem)}` : "NULL"} AS origem,`,
            `       ${t.destino ? `cab.${quoteIdent(t.destino)}` : "NULL"} AS destino,`,
            `       ${t.entidade ? `cab.${quoteIdent(t.entidade)}` : "NULL"} AS entidade,`,
            "       sm.[CodigoID] AS codigoId, sm.[Qtd] AS quantidade,",
            "       sm.[StocksMovArmazemID] AS armazem, sm.[StocksMovID] AS movId",
            `  FROM ${fonte}`,
            ` WHERE ${eData} >= @from AND ${eData} < @to AND ${cond}`,
            ` ORDER BY ${eData} DESC`,
          ].join("\n"),
          `exemplos ${f}`,
        );
        for (const e of ex?.recordset ?? []) {
          console.log(
            `      ${formatCell(e.data, 19).slice(0, 10)} ${formatCell(e.serie, 6).padEnd(7)}` +
              `${String(e.numero ?? "-").padStart(8)} tipo=${String(e.tipo ?? "-").padEnd(4)}` +
              ` org=${formatCell(e.origem, 6).padEnd(7)} dst=${formatCell(e.destino, 6).padEnd(7)}` +
              ` ent=${formatCell(e.entidade, 8).padEnd(9)} arm=${String(e.armazem ?? "-").padEnd(4)}` +
              ` cnpId=${String(e.codigoId).padEnd(9)} qtd=${String(e.quantidade).padStart(6)}`,
          );
          if (e.motivo) console.log(`        motivo: ${formatCell(e.motivo, 60)}`);
        }
      }

      // ── 2.4 A pergunta que só os dados respondem ──────────────
      console.log("");
      console.log(RULE);
      console.log("  2.4 QUAL DAS LEITURAS BATE COM O RELATORIO OFICIAL");
      console.log(RULE);
      console.log("  Uma transferencia tem dois lados e o nome da serie nao diz");
      console.log("  qual deles o relatorio conta. Calculam-se as quatro leituras");
      console.log("  e compara-se cada uma com o gate mensal. Tolerancia ZERO.");

      const familias = [...porFamilia.keys()];
      // Cada família sozinha, e todas juntas. A regra final tem de ser a
      // mais simples que passe — se só VCG_1 passa, a regra é essa.
      const conjuntos: Array<{ nome: string; cond: string }> = [
        { nome: "TODAS as series", cond: "1=1" },
        ...familias.map((f) => ({
          nome: `só ${f}`,
          cond: f === "(nula)" ? `${eSerie} IS NULL` : `${eSerie} = '${f.replace(/'/g, "''")}'`,
        })),
      ];

      let algumPassou = false;
      for (const conj of conjuntos) {
        for (const h of hipoteses(eQtd)) {
          const r = await consultar<{ mes: number; total: number }>(
            req(),
            [
              `SELECT MONTH(${eData}) AS mes, ${h.expr} AS total`,
              `  FROM ${fonte}`,
              ` WHERE ${eData} >= @from AND ${eData} < @to AND ${conj.cond}`,
              ` GROUP BY MONTH(${eData})`,
            ].join("\n"),
            `${conj.nome} / ${h.chave}`,
          );
          if (!r) continue;
          const porMes = new Map<number, number>();
          for (const x of r.recordset) porMes.set(Number(x.mes), Number(x.total ?? 0));
          const res = GATES_SILVEIRENSE_2026.map((g) =>
            avaliarGate(g.mes, g.transferencias, Math.round(porMes.get(g.mes) ?? 0)),
          );
          const passa = res.every((x) => x.passa);
          if (passa) algumPassou = true;
          console.log("");
          for (const l of renderGates(`${conj.nome} — ${h.rotulo} [${h.chave}]`, res)) {
            console.log(l);
          }
          if (passa) {
            console.log("    ★★★ ESTA LEITURA REPRODUZ O RELATORIO OFICIAL ★★★");
            console.log(`    Regra: serie ${conj.nome}, direccao ${h.chave}`);
          }
        }
      }
      console.log("");
      if (!algumPassou) {
        console.log("  NENHUMA das leituras reproduz o gate.");
        console.log("  Isso e um resultado, nao uma falha da sonda: significa que a");
        console.log("  populacao de transferencias do relatorio nao e exactamente");
        console.log("  este universo. Os cortes acima dizem por onde continuar —");
        console.log("  provavelmente tipo de documento ou motivo, nao a serie.");
        console.log("  NAO implementar o reader com uma leitura que nao bate.");
      } else {
        console.log("  Implementar o reader com a leitura marcada acima, e mais nada.");
      }
    });

    console.log("");
    console.log(DOUBLE);
    console.log("FIM — nada foi escrito. Nenhum POST ao SaaS.");
    console.log(DOUBLE);
    return 0;
  });
}
