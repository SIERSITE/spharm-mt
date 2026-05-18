/**
 * agent/src/commands/discover-sales.ts
 *
 * Probe read-only sobre a tabela de **linhas de venda** do SPharm ERP.
 * Operacionaliza o §3.3 do mapping canónico em
 * `docs/spharm-erp-canonical-mapping.md`.
 *
 * Para além das colunas-chave + TOP 5, esta probe acrescenta:
 *   · MIN/MAX da coluna-data detectada
 *   · TOP 5 dias com mais linhas (últimos 30 dias)
 *
 * Aceita `--from YYYY-MM-DD` e `--to YYYY-MM-DD` para restringir a
 * amostra TOP 5. Datas validadas em TS antes de irem para o SQL
 * (parametrizadas via `mssql`).
 *
 * Garantias:
 *   · Read-only, SQL 2008 R2, TOP 5, sem persistência (stdout-only).
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import {
  parseTableArg,
  printCandidateHint,
  assertTableExists,
  listColumns,
  estimateRowCount,
  classifyColumns,
  renderColumnType,
  renderSampleVertical,
  parseDateArg,
  type FieldHint,
  type ParsedTableArg,
} from "./probe-helpers.js";

const SALES_HINTS: FieldHint[] = [
  { field: "data", needles: ["datadoc", "datavenda", "datamov", "datacria", "data"], expect: ["date"] },
  { field: "cnp/codArt", needles: ["codcnp", "codnac", "cnp", "codart", "codprod", "codartigo"], expect: ["int", "string"] },
  { field: "quantidade", needles: ["quantidade", "qtdvendid", "qtd", "quant"], expect: ["decimal", "int"] },
  { field: "valorTotal", needles: ["valortotal", "pvptotal", "total", "valor"], expect: ["decimal"] },
  { field: "valorUnitario", needles: ["pvpunitario", "pvpunit", "precounitario", "unitario"], expect: ["decimal"] },
  { field: "custoUnitario", needles: ["precocusto", "custounit", "puc"], expect: ["decimal"] },
  { field: "comparticipacao", needles: ["compart"], expect: ["decimal"] },
  { field: "pagoUtente", needles: ["pagoutente", "pagocliente", "utentepago"], expect: ["decimal"] },
  { field: "tipoDoc", needles: ["tipodoc", "tipovenda"], expect: ["string", "int"] },
  { field: "numDoc", needles: ["numdoc", "numfact", "numero"], expect: ["int", "string"] },
  { field: "serie", needles: ["serie"], expect: ["string", "int"] },
];

const RULE = "─".repeat(70);

type Args = { table?: string; from?: string; to?: string; help?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      table: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    table: typeof raw.values.table === "string" ? raw.values.table : undefined,
    from: typeof raw.values.from === "string" ? raw.values.from : undefined,
    to: typeof raw.values.to === "string" ? raw.values.to : undefined,
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: discover-sales --table <schema>.<tabela> [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
  console.log("");
  console.log("Exemplos:");
  console.log('  discover-sales --table "dbo.Atendimento Detalhe"');
  console.log('  discover-sales --table dbo.EntidadesFact_Det');
  console.log('  discover-sales --table dbo.EntidadesFact_Det --from 2026-04-01');
  console.log("");
  console.log("Sem --table, mostra a lista de candidatos detectados pelo `discover`");
  console.log("(apenas hint — não auto-escolhe; a heurística falha frequentemente).");
  console.log("");
  console.log("--from / --to restringem APENAS a amostra TOP 5. O resumo de dias top");
  console.log("usa sempre janela fixa dos últimos 30 dias para detectar movimento real.");
  console.log("");
  console.log("Garantias: read-only, TOP 5, sem persistência, SQL 2008 R2.");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md");
}

export async function discoverSales(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err);
    console.error("");
    printHelp();
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  let fromDate: string | null;
  let toDate: string | null;
  try {
    fromDate = parseDateArg("--from", args.from);
    toDate = parseDateArg("--to", args.to);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (fromDate && toDate && fromDate > toDate) {
    console.error(`✗ --from (${fromDate}) é posterior a --to (${toDate}).`);
    return 1;
  }

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!args.table) {
    console.error("✗ --table é obrigatório.");
    console.error("");
    console.error("Vendas costumam viver em header+linhas:");
    console.error("  · Softreis ATD: dbo.Atendimento + \"dbo.Atendimento Detalhe\"");
    console.error("  · Softreis fact: dbo.EntidadesFact_Cab + dbo.EntidadesFact_Det");
    console.error("");
    printCandidateHint("vendas", cfg.outputDir);
    console.error("");
    console.error("Categoria linhas (para tabelas de detalhe sem data — vão precisar de join):");
    printCandidateHint("linhas", cfg.outputDir);
    return 1;
  }

  let target: ParsedTableArg;
  try {
    target = parseTableArg(args.table);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    return await withPool(cfg, async (pool) => {
      await assertTableExists(pool, target);
      const cols = await listColumns(pool, target);
      const rowCount = await estimateRowCount(pool, target);

      const classified = classifyColumns(cols, SALES_HINTS);
      const dateCol = classified.find((c) => c.field === "data")?.match ?? null;

      // ── TOP 5 amostra (com filtro de data se fornecido)
      const tName = `[${target.schema}].[${target.table}]`;
      const reqSample = pool.request();
      let sampleSql: string;
      if (dateCol && (fromDate || toDate)) {
        const dCol = `[${dateCol.name}]`;
        const clauses: string[] = [];
        if (fromDate) {
          reqSample.input("from", sql.NVarChar, fromDate);
          clauses.push(`${dCol} >= @from`);
        }
        if (toDate) {
          reqSample.input("to", sql.NVarChar, toDate);
          clauses.push(`${dCol} <= @to`);
        }
        sampleSql = `SELECT TOP 5 * FROM ${tName} WHERE ${clauses.join(" AND ")} ORDER BY ${dCol} DESC`;
      } else {
        sampleSql = `SELECT TOP 5 * FROM ${tName}`;
      }
      const sampleRes = await reqSample.query<Record<string, unknown>>(sampleSql);

      // ── MIN/MAX da coluna-data (se existir)
      let minMax: { mn: Date | null; mx: Date | null } | null = null;
      if (dateCol) {
        const r = await pool
          .request()
          .query<{ mn: Date | null; mx: Date | null }>(
            `SELECT MIN([${dateCol.name}]) AS mn, MAX([${dateCol.name}]) AS mx FROM ${tName}`
          );
        minMax = r.recordset[0] ?? null;
      }

      // ── TOP 5 dias com mais linhas (últimos 30 dias). Só se houver data.
      let topDays: Array<{ d: Date | null; n: number }> = [];
      if (dateCol) {
        const r = await pool
          .request()
          .query<{ d: Date | null; n: number }>(
            `SELECT TOP 5 CAST([${dateCol.name}] AS DATE) AS d, COUNT(*) AS n
             FROM ${tName}
             WHERE [${dateCol.name}] >= DATEADD(DAY, -30, GETDATE())
             GROUP BY CAST([${dateCol.name}] AS DATE)
             ORDER BY COUNT(*) DESC`
          );
        topDays = r.recordset;
      }

      console.log(RULE);
      console.log(`discover-sales — ${target.schema}.${target.table}`);
      console.log(RULE);
      console.log(`Database         : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
      console.log(`Row count (est.) : ${rowCount}`);
      console.log(`Colunas          : ${cols.length}`);
      if (fromDate || toDate) {
        console.log(`Filtro amostra   : ${fromDate ?? "(open)"} → ${toDate ?? "(open)"}`);
      }
      console.log("");

      console.log("Colunas-chave detectadas (ERP → SPharm.MT):");
      const longest = Math.max(...classified.map((c) => c.field.length));
      let matched = 0;
      for (const c of classified) {
        const detail = c.match
          ? `${c.match.name} (${renderColumnType(c.match)})${c.match.nullable ? " null" : ""}`
          : "— não detectada";
        if (c.match) matched++;
        console.log(`  ${c.field.padEnd(longest)}  ← ${detail}`);
      }
      console.log(`  (${matched}/${classified.length} campos do mapping §3.3 detectados)`);
      console.log("");

      if (dateCol && minMax) {
        const mn = minMax.mn ? minMax.mn.toISOString().slice(0, 10) : "—";
        const mx = minMax.mx ? minMax.mx.toISOString().slice(0, 10) : "—";
        console.log(`Range de ${dateCol.name}: ${mn} → ${mx}`);
        console.log("");
      } else if (!dateCol) {
        console.log("⚠ Sem coluna-data detectada — sumário temporal omitido.");
        console.log("  Verifica manualmente a estrutura da tabela; pode ser uma linha");
        console.log("  sem header join (data vem da tabela de documento).");
        console.log("");
      }

      if (topDays.length > 0) {
        console.log("TOP 5 dias com mais linhas (últimos 30 dias):");
        for (const row of topDays) {
          const ds = row.d ? row.d.toISOString().slice(0, 10) : "—";
          console.log(`  ${ds}   ${row.n} linhas`);
        }
        console.log("");
      } else if (dateCol) {
        console.log("TOP dias: 0 linhas nos últimos 30 dias (BD silenciosa ou pré-piloto).");
        console.log("");
      }

      console.log("Lista completa de colunas:");
      const colNameWidth = Math.min(40, Math.max(...cols.map((c) => c.name.length)));
      for (const c of cols) {
        const t = renderColumnType(c);
        const n = c.nullable ? "Y" : "N";
        console.log(`  ${c.name.padEnd(colNameWidth)}  ${t.padEnd(22)}  null=${n}`);
      }
      console.log("");

      console.log(`TOP 5 amostras (${sampleRes.recordset.length} linhas):`);
      console.log(renderSampleVertical(sampleRes.recordset, cols));
      console.log(RULE);
      console.log("Sem persistência — outputs ficam no stdout. Copia o bloco acima.");
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha na probe:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
