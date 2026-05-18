/**
 * agent/src/commands/products-preview.ts
 *
 * Preview operacional read-only que junta master de produtos + stock
 * por armazém + fornecedor habitual. Validação visual antes da
 * primeira ingestão. Operacionaliza §5.3 do mapping canónico em
 * `docs/spharm-erp-canonical-mapping.md`.
 *
 * Tabelas hardcoded (validadas 2026-05-13):
 *   · dbo.Stocks            (s)   — master de produtos
 *   · dbo.ArmazensStocks    (ars) — stock por armazém
 *   · dbo.Fornecedores      (f)   — fornecedor habitual
 *
 * Resolução de colunas:
 *   · CodigoID, ArmazemID, [Fornecedor Habitual], [Fornecedor ID]
 *     são FIXAS (confirmadas por probes).
 *   · Designacao, PVP, PMC, PUC, Existencia, nome-fornecedor são
 *     resolvidos por heurística sobre `sys.columns` em runtime.
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
const FORNECEDORES: ParsedTableArg = { schema: "dbo", table: "Fornecedores" };

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
  console.log("Uso: products-preview");
  console.log("");
  console.log("Junta dbo.Stocks + dbo.ArmazensStocks + dbo.Fornecedores e mostra TOP 20");
  console.log("filtrado por produtos operacionais.");
  console.log("");
  console.log("Filtros hardcoded:");
  console.log("  Stocks.[Retirado] = 0         (exclui produtos descontinuados)");
  console.log("  Stocks.[Processa_Stocks] <> 0 (exclui artigos técnicos sem stock)");
  console.log("");
  console.log("Colunas fixas: CodigoID, Designacao, PVP (comercial), PMC, PUC,");
  console.log("  DataUltVenda, ArmazemID, Stock, FornHabID.");
  console.log("Heurísticas: Fornecedor (nome) — pendente confirmação.");
  console.log("");
  console.log("PUC é [Preco Ultima Compra_EUR] (NÃO Devolucao_EUR).");
  console.log("");
  console.log("Order: [Data Ultima Venda] DESC, CodigoID");
  console.log("");
  console.log("Garantias: read-only, TOP 20, sem persistência, sem ingest SaaS.");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md §5.3");
}

export async function productsPreview(): Promise<number> {
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
      // Resolução de colunas — paralelo, três sys.columns.
      const [stocksCols, arsCols, fornCols] = await Promise.all([
        listColumns(pool, STOCKS),
        listColumns(pool, ARMAZENSSTOCKS),
        listColumns(pool, FORNECEDORES),
      ]);

      // Colunas FIXAS confirmadas pelo operador em 2026-05-13:
      assertColumnsExist(
        stocksCols,
        [
          "CodigoID",
          "Nome Comercial",
          "Preco Venda Publico_EUR",
          "Preco Medio Compra_EUR",
          "Preco Ultima Compra_EUR",
          "Data Ultima Venda",
          "Retirado",
          "Processa_Stocks",
        ],
        "dbo.Stocks"
      );
      assertColumnsExist(
        arsCols,
        ["CodigoID", "ArmazemID", "Existencia Actual", "Fornecedor Habitual"],
        "dbo.ArmazensStocks"
      );
      assertColumnsExist(fornCols, ["Fornecedor ID"], "dbo.Fornecedores");

      const items: SelectItem[] = [];

      // ── Stocks (s) — todas FIXAS (PVP/PMC/PUC confirmadas 2026-05-13).
      // NOTA: PUC é [Preco Ultima Compra_EUR], NÃO [Preco Ultima Devolucao_EUR]
      //       (devolução não é custo de compra).
      items.push({ alias: "CodigoID",     expr: "s.CodigoID",                  sourceColumn: "CodigoID",                sourceTable: "Stocks" });
      items.push({ alias: "Designacao",   expr: "s.[Nome Comercial]",          sourceColumn: "Nome Comercial",          sourceTable: "Stocks" });
      items.push({ alias: "PVP",          expr: "s.[Preco Venda Publico_EUR]", sourceColumn: "Preco Venda Publico_EUR", sourceTable: "Stocks" });
      items.push({ alias: "PMC",          expr: "s.[Preco Medio Compra_EUR]",  sourceColumn: "Preco Medio Compra_EUR",  sourceTable: "Stocks" });
      items.push({ alias: "PUC",          expr: "s.[Preco Ultima Compra_EUR]", sourceColumn: "Preco Ultima Compra_EUR", sourceTable: "Stocks" });
      items.push({ alias: "DataUltVenda", expr: "s.[Data Ultima Venda]",       sourceColumn: "Data Ultima Venda",       sourceTable: "Stocks" });

      // ── ArmazensStocks (ars) — fixas
      items.push({ alias: "ArmazemID",  expr: "ars.ArmazemID",            sourceColumn: "ArmazemID",            sourceTable: "ArmazensStocks" });
      items.push({ alias: "Stock",      expr: "ars.[Existencia Actual]",  sourceColumn: "Existencia Actual",    sourceTable: "ArmazensStocks" });
      items.push({ alias: "FornHabID",  expr: "ars.[Fornecedor Habitual]", sourceColumn: "Fornecedor Habitual", sourceTable: "ArmazensStocks" });

      // ── Fornecedores (f) — heurística para nome (não confirmado ainda)
      const fornNome = pickColumnByHints(fornCols, {
        field: "nome",
        needles: ["nome comercial", "descric", "designac", "nome", "razao"],
        expect: ["string"],
      });
      if (fornNome) {
        items.push({
          alias: "Fornecedor",
          expr: `f.${quoteIdent(fornNome.name)}`,
          sourceColumn: fornNome.name,
          sourceTable: "Fornecedores",
        });
      }

      // ── SQL final — filtro operacional + ORDER BY [Data Ultima Venda] DESC
      const selectList = items.map((i) => `${i.expr} AS ${quoteIdent(i.alias)}`).join(",\n  ");
      const sqlText =
        `SELECT TOP 20\n  ${selectList}\n` +
        `FROM [dbo].[Stocks] s\n` +
        `LEFT JOIN [dbo].[ArmazensStocks] ars ON ars.CodigoID = s.CodigoID\n` +
        `LEFT JOIN [dbo].[Fornecedores] f ON f.[Fornecedor ID] = ars.[Fornecedor Habitual]\n` +
        `WHERE s.[Retirado] = 0\n` +
        `  AND s.[Processa_Stocks] <> 0\n` +
        `ORDER BY s.[Data Ultima Venda] DESC, s.CodigoID`;

      const res = await pool.request().query<Record<string, unknown>>(sqlText);

      // ── Render
      console.log(RULE);
      console.log(`products-preview — preview operacional`);
      console.log(RULE);
      console.log(`Database         : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
      console.log(`Tabelas          : dbo.Stocks, dbo.ArmazensStocks, dbo.Fornecedores`);
      console.log(`Filtros          : Stocks.[Retirado]=0 AND Stocks.[Processa_Stocks]<>0`);
      console.log(`Order            : Stocks.[Data Ultima Venda] DESC, Stocks.CodigoID`);
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
