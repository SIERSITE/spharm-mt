/**
 * agent/src/commands/stock-preview.ts
 *
 * Preview operacional read-only que junta master de produtos + stock
 * por armazém + descrição do armazém. Operacionaliza §5.4 do mapping
 * canónico em `docs/spharm-erp-canonical-mapping.md`.
 *
 * Tabelas hardcoded (validadas 2026-05-13):
 *   · dbo.Stocks            (s)   — master de produtos
 *   · dbo.ArmazensStocks    (ars) — stock por armazém
 *   · dbo.Armazens          (a)   — descrição do armazém
 *
 * Garantias: read-only, TOP 20, sem persistência, sem ingest SaaS.
 */

import { parseArgs } from "node:util";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import {
  listColumns,
  assertColumnsExist,
  pickColumnByHints,
  quoteIdent,
  renderSampleHorizontal,
  type SelectItem,
  type ParsedTableArg,
} from "./probe-helpers.js";

const RULE = "─".repeat(70);

const STOCKS: ParsedTableArg = { schema: "dbo", table: "Stocks" };
const ARMAZENSSTOCKS: ParsedTableArg = { schema: "dbo", table: "ArmazensStocks" };
const ARMAZENS: ParsedTableArg = { schema: "dbo", table: "Armazens" };

type Args = { help?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: { help: { type: "boolean", short: "h" } },
    strict: true,
    allowPositionals: false,
  });
  return { help: raw.values.help === true };
}

function printHelp(): void {
  console.log("Uso: stock-preview");
  console.log("");
  console.log("Junta dbo.Stocks + dbo.ArmazensStocks + dbo.Armazens e mostra TOP 20");
  console.log("filtrado por produtos operacionais, ordenado por existência DESC.");
  console.log("");
  console.log("Filtros hardcoded:");
  console.log("  Stocks.[Retirado] = 0         (exclui produtos descontinuados)");
  console.log("  Stocks.[Processa_Stocks] <> 0 (exclui artigos técnicos sem stock)");
  console.log("");
  console.log("Colunas fixas: CodigoID, Designacao, ArmazemID, Existencia, StockMin, StockMax.");
  console.log("Heurísticas: Armazem (nome) — pendente confirmação.");
  console.log("");
  console.log("Order: ArmazensStocks.[Existencia Actual] DESC, Stocks.CodigoID");
  console.log("");
  console.log("Garantias: read-only, TOP 20, sem persistência, sem ingest SaaS.");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md §5.4");
}

export async function stockPreview(): Promise<number> {
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

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    return await withPool(cfg, async (pool) => {
      const [stocksCols, arsCols, armCols] = await Promise.all([
        listColumns(pool, STOCKS),
        listColumns(pool, ARMAZENSSTOCKS),
        listColumns(pool, ARMAZENS),
      ]);

      // Colunas FIXAS confirmadas pelo operador em 2026-05-13:
      assertColumnsExist(
        stocksCols,
        ["CodigoID", "Nome Comercial", "Retirado", "Processa_Stocks"],
        "dbo.Stocks"
      );
      assertColumnsExist(
        arsCols,
        ["CodigoID", "ArmazemID", "Existencia Actual", "Stock Minimo", "Stock Maximo/Reposicao"],
        "dbo.ArmazensStocks"
      );
      assertColumnsExist(armCols, ["ArmazemID"], "dbo.Armazens");

      const items: SelectItem[] = [];

      items.push({ alias: "CodigoID",   expr: "s.CodigoID",                    sourceColumn: "CodigoID",                sourceTable: "Stocks" });
      items.push({ alias: "Designacao", expr: "s.[Nome Comercial]",            sourceColumn: "Nome Comercial",          sourceTable: "Stocks" });
      items.push({ alias: "ArmazemID",  expr: "ars.ArmazemID",                 sourceColumn: "ArmazemID",               sourceTable: "ArmazensStocks" });

      const armNome = pickColumnByHints(armCols, {
        field: "nome",
        needles: ["nome", "descric", "designac"],
        expect: ["string"],
      });
      if (armNome) {
        items.push({
          alias: "Armazem",
          expr: `a.${quoteIdent(armNome.name)}`,
          sourceColumn: armNome.name,
          sourceTable: "Armazens",
        });
      }

      items.push({ alias: "Existencia", expr: "ars.[Existencia Actual]",        sourceColumn: "Existencia Actual",       sourceTable: "ArmazensStocks" });
      items.push({ alias: "StockMin",   expr: "ars.[Stock Minimo]",             sourceColumn: "Stock Minimo",            sourceTable: "ArmazensStocks" });
      items.push({ alias: "StockMax",   expr: "ars.[Stock Maximo/Reposicao]",   sourceColumn: "Stock Maximo/Reposicao",  sourceTable: "ArmazensStocks" });

      // SQL final — filtro operacional Stocks + ORDER BY [Existencia Actual] DESC
      const selectList = items.map((i) => `${i.expr} AS ${quoteIdent(i.alias)}`).join(",\n  ");
      const sqlText =
        `SELECT TOP 20\n  ${selectList}\n` +
        `FROM [dbo].[Stocks] s\n` +
        `JOIN [dbo].[ArmazensStocks] ars ON ars.CodigoID = s.CodigoID\n` +
        `LEFT JOIN [dbo].[Armazens] a ON a.ArmazemID = ars.ArmazemID\n` +
        `WHERE s.[Retirado] = 0\n` +
        `  AND s.[Processa_Stocks] <> 0\n` +
        `ORDER BY ars.[Existencia Actual] DESC, s.CodigoID`;

      const res = await pool.request().query<Record<string, unknown>>(sqlText);

      console.log(RULE);
      console.log(`stock-preview — preview operacional`);
      console.log(RULE);
      console.log(`Database         : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
      console.log(`Tabelas          : dbo.Stocks, dbo.ArmazensStocks, dbo.Armazens`);
      console.log(`Filtros          : Stocks.[Retirado]=0 AND Stocks.[Processa_Stocks]<>0`);
      console.log(`Order            : ArmazensStocks.[Existencia Actual] DESC, Stocks.CodigoID`);
      console.log("");

      console.log("Colunas resolvidas:");
      const aliasW = Math.max(...items.map((i) => i.alias.length));
      for (const i of items) {
        const src = i.sourceColumn ? `${i.sourceTable}.${i.sourceColumn}` : `${i.sourceTable}.<expr>`;
        console.log(`  ${i.alias.padEnd(aliasW)}  ← ${src}`);
      }
      console.log("");

      console.log(`TOP 20 linhas (${res.recordset.length} devolvidas):`);
      console.log(
        renderSampleHorizontal(
          res.recordset,
          items.map((i) => i.alias)
        )
      );
      console.log(RULE);
      console.log("Sem persistência — copia o bloco acima.");
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha no preview:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
