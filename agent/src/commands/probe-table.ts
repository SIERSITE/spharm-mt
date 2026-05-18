/**
 * agent/src/commands/probe-table.ts
 *
 * Probe genérico read-only sobre uma tabela arbitrária do SPharm ERP.
 * Dirigido — o operador passa `--table <schema>.<tabela>` explicitamente
 * (não há heurística de auto-detect). Aceita nomes com espaço via
 * delimited identifiers (`dbo.Atendimento Detalhe` → `[dbo].[Atendimento Detalhe]`).
 *
 * Output (stdout-only, sem persistência):
 *   · Row count estimado (sys.partitions)
 *   · Colunas + tipos + nullability
 *   · Primary key
 *   · Foreign keys out (esta → outras)
 *   · Foreign keys in (outras → esta)
 *   · Índices não-PK
 *   · MIN/MAX de colunas-data (até 3)
 *   · TOP 5 amostras
 *
 * Garantias:
 *   · Read-only, SQL 2008 R2, TOP 5, sem persistência, sem ingest SaaS.
 *   · Identifiers validados antes de interpolação (regex limita
 *     caracteres a A-Za-z0-9_ + espaço).
 */

import { parseArgs } from "node:util";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import {
  parseTableArg,
  assertTableExists,
  listColumns,
  estimateRowCount,
  listPrimaryKey,
  listForeignKeysOut,
  listForeignKeysIn,
  listIndexes,
  pickDateColumns,
  probeDateRanges,
  renderColumnType,
  renderSampleVertical,
  fmtRowCount,
  type ParsedTableArg,
} from "./probe-helpers.js";

const RULE = "─".repeat(70);

type Args = { table?: string; help?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      table: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    table: typeof raw.values.table === "string" ? raw.values.table : undefined,
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: probe-table --table <schema>.<tabela>");
  console.log("");
  console.log("Exemplos:");
  console.log('  probe-table --table dbo.Stocks');
  console.log('  probe-table --table dbo.ArmazensStocks');
  console.log('  probe-table --table "dbo.Atendimento Detalhe"   (aspas — nome com espaço)');
  console.log('  probe-table --table dbo.EntidadesFact_Cab');
  console.log("");
  console.log("Output: row count, colunas, PK, FKs in/out, índices, MIN/MAX de datas,");
  console.log("        TOP 5 amostras. Tudo stdout — sem ficheiros.");
  console.log("");
  console.log("Garantias: read-only, TOP 5, sem persistência, SQL 2008 R2.");
}

export async function probeTable(): Promise<number> {
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

  if (!args.table) {
    console.error("✗ --table é obrigatório.");
    console.error("");
    printHelp();
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

      // Recolha em paralelo onde dá — read-only, queries independentes.
      const [cols, rowCount, pk, fkOut, fkIn, idx] = await Promise.all([
        listColumns(pool, target),
        estimateRowCount(pool, target),
        listPrimaryKey(pool, target),
        listForeignKeysOut(pool, target),
        listForeignKeysIn(pool, target),
        listIndexes(pool, target),
      ]);

      const dateCols = pickDateColumns(cols, 3);
      const dateRanges = dateCols.length > 0 ? await probeDateRanges(pool, target, dateCols) : [];

      const sampleRes = await pool
        .request()
        .query<Record<string, unknown>>(`SELECT TOP 5 * FROM [${target.schema}].[${target.table}]`);

      // ─── Render ────────────────────────────────────────────────
      console.log(RULE);
      console.log(`probe-table — ${target.schema}.${target.table}`);
      console.log(RULE);
      console.log(`Database         : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
      console.log(`Row count (est.) : ${fmtRowCount(rowCount)}  (${rowCount} exact)`);
      console.log(`Colunas          : ${cols.length}`);
      console.log("");

      console.log(`Primary key (${pk.length}):`);
      if (pk.length === 0) console.log(`  (sem PK declarada)`);
      else console.log(`  ${pk.join(", ")}`);
      console.log("");

      console.log(`Foreign keys OUT — ${target.schema}.${target.table} → outras (${fkOut.length}):`);
      if (fkOut.length === 0) {
        console.log(`  (nenhuma FK declarada — relações podem ser implícitas no app code)`);
      } else {
        for (const fk of fkOut) {
          console.log(
            `  ${fk.name}: ${fk.fromTable}(${fk.fromColumns.join(",")}) → ` +
              `${fk.toTable}(${fk.toColumns.join(",")})`
          );
        }
      }
      console.log("");

      console.log(`Foreign keys IN  — outras → ${target.schema}.${target.table} (${fkIn.length}):`);
      if (fkIn.length === 0) {
        console.log(`  (nada referencia esta tabela via FK declarada)`);
      } else {
        for (const fk of fkIn) {
          console.log(
            `  ${fk.name}: ${fk.fromTable}(${fk.fromColumns.join(",")}) → ` +
              `${fk.toTable}(${fk.toColumns.join(",")})`
          );
        }
      }
      console.log("");

      console.log(`Índices não-PK (${idx.length}):`);
      if (idx.length === 0) console.log(`  (sem índices secundários)`);
      else {
        for (const ix of idx) {
          const uniq = ix.isUnique ? " UNIQUE" : "";
          console.log(`  ${ix.name} (${ix.type}${uniq}): ${ix.columns.join(", ")}`);
        }
      }
      console.log("");

      if (dateRanges.length > 0) {
        console.log(`Colunas-data (MIN/MAX, até 3):`);
        for (const dr of dateRanges) {
          const mn = dr.min ? dr.min.slice(0, 10) : "—";
          const mx = dr.max ? dr.max.slice(0, 10) : "—";
          console.log(`  ${dr.column.padEnd(28)} ${mn} → ${mx}`);
        }
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
