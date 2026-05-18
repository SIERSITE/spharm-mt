/**
 * agent/src/commands/sales-summary-preview.ts
 *
 * Preview agregado read-only para caracterizar a semântica das vendas
 * por `[Tipo Documento]` × `[Entidade ID]`. Operacionaliza §5.6 do
 * mapping canónico em `docs/spharm-erp-canonical-mapping.md`.
 *
 * Objectivo:
 *   · Identificar quais TipoDocumento são vendas reais vs. técnicas
 *   · Confirmar a semântica de `[Valor_EUR]` (pago utente vs. total
 *     linha) cruzando com EntidadeID + PVP × Qtd + comparticipação
 *
 * Duas queries:
 *   1) GROUP BY TipoDoc, EntidadeID — count/sum/min-max
 *   2) TOP 10 documentos por SUM([Valor_EUR]) DESC
 *
 * Filtros idênticos a sales-preview:
 *   · a.[Fim Venda] = 'S'
 *   · a.[Data Venda] BETWEEN @from AND @to
 *
 * Sem agregação fina por produto. Sem persistência. Sem ingest SaaS.
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import {
  listColumns,
  assertColumnsExist,
  renderSampleHorizontal,
  parseDateArg,
  type ParsedTableArg,
} from "./probe-helpers.js";

const RULE = "─".repeat(70);

const ATENDIMENTO: ParsedTableArg = { schema: "dbo", table: "Atendimento" };
const ATENDIMENTO_DET: ParsedTableArg = { schema: "dbo", table: "Atendimento Detalhe" };
const STOCKS: ParsedTableArg = { schema: "dbo", table: "Stocks" };

type Args = { from?: string; to?: string; help?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : undefined,
    to: typeof raw.values.to === "string" ? raw.values.to : undefined,
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: sales-summary-preview --from YYYY-MM-DD --to YYYY-MM-DD");
  console.log("");
  console.log("Agrega vendas por [Tipo Documento] × [Entidade ID] no intervalo.");
  console.log("Mostra também TOP 10 documentos por SUM([Valor_EUR]) DESC.");
  console.log("");
  console.log("Filtros hardcoded:");
  console.log("  a.[Fim Venda] = 'S'");
  console.log("  a.[Data Venda] BETWEEN @from AND @to");
  console.log("");
  console.log("Métricas (query 1, GROUP BY TipoDoc+EntidadeID):");
  console.log("  Linhas, Atendimentos, QtdTotal, ValorEUR, PVPCalculado,");
  console.log("  Comp1, Comp2, DataMin, DataMax");
  console.log("");
  console.log("Top 10 (query 2, GROUP BY AtendID): TotalValorLinha, TotalPVP, TotalCompart");
  console.log("");
  console.log("Garantias: read-only, sem persistência, sem ingest SaaS.");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md §5.6");
}

export async function salesSummaryPreview(): Promise<number> {
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

  if (!args.from || !args.to) {
    console.error("✗ --from e --to são obrigatórios.");
    console.error("");
    printHelp();
    return 1;
  }

  let fromDate: string;
  let toDate: string;
  try {
    fromDate = parseDateArg("--from", args.from) as string;
    toDate = parseDateArg("--to", args.to) as string;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (fromDate > toDate) {
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

  try {
    return await withPool(cfg, async (pool) => {
      const [aCols, dCols, sCols] = await Promise.all([
        listColumns(pool, ATENDIMENTO),
        listColumns(pool, ATENDIMENTO_DET),
        listColumns(pool, STOCKS),
      ]);

      assertColumnsExist(
        aCols,
        ["Atendimento ID", "Data Venda", "Fim Venda", "Tipo Documento"],
        "dbo.Atendimento"
      );
      assertColumnsExist(
        dCols,
        [
          "Atendimento ID",
          "CodigoID",
          "Quantidade",
          "Preco Venda Publico_EUR",
          "Valor_EUR",
          "PrComp_EUR",
          "PrComp_EUR2",
          "Entidade ID",
        ],
        "dbo.Atendimento Detalhe"
      );
      assertColumnsExist(sCols, ["CodigoID"], "dbo.Stocks");

      // ── Query 1: GROUP BY TipoDoc, EntidadeID ───────────────────
      const sqlGroup =
        `SELECT\n` +
        `  a.[Tipo Documento]                                  AS TipoDoc,\n` +
        `  d.[Entidade ID]                                     AS EntidadeID,\n` +
        `  COUNT(*)                                            AS Linhas,\n` +
        `  COUNT(DISTINCT a.[Atendimento ID])                  AS Atendimentos,\n` +
        `  CAST(SUM(d.[Quantidade]) AS DECIMAL(18,3))          AS QtdTotal,\n` +
        `  CAST(SUM(d.[Valor_EUR]) AS DECIMAL(18,2))           AS ValorEUR,\n` +
        `  CAST(SUM(d.[Preco Venda Publico_EUR] * d.[Quantidade]) AS DECIMAL(18,2)) AS PVPCalculado,\n` +
        `  CAST(SUM(ISNULL(d.[PrComp_EUR], 0)) AS DECIMAL(18,2))    AS Comp1,\n` +
        `  CAST(SUM(ISNULL(d.[PrComp_EUR2], 0)) AS DECIMAL(18,2))   AS Comp2,\n` +
        `  MIN(a.[Data Venda])                                 AS DataMin,\n` +
        `  MAX(a.[Data Venda])                                 AS DataMax\n` +
        `FROM [dbo].[Atendimento] a\n` +
        `JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]\n` +
        `JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]\n` +
        `WHERE a.[Fim Venda] = 'S'\n` +
        `  AND a.[Data Venda] BETWEEN @from AND @to\n` +
        `GROUP BY a.[Tipo Documento], d.[Entidade ID]\n` +
        `ORDER BY a.[Tipo Documento], d.[Entidade ID]`;

      const resGroup = await pool
        .request()
        .input("from", sql.NVarChar, `${fromDate} 00:00:00`)
        .input("to", sql.NVarChar, `${toDate} 23:59:59`)
        .query<Record<string, unknown>>(sqlGroup);

      // ── Query 2: TOP 10 documentos ──────────────────────────────
      const sqlTopDocs =
        `SELECT TOP 10\n` +
        `  a.[Atendimento ID]                                  AS AtendID,\n` +
        `  a.[Data Venda]                                      AS DataVenda,\n` +
        `  a.[Tipo Documento]                                  AS TipoDoc,\n` +
        `  CAST(SUM(d.[Valor_EUR]) AS DECIMAL(18,2))           AS TotalValorLinha,\n` +
        `  CAST(SUM(d.[Preco Venda Publico_EUR] * d.[Quantidade]) AS DECIMAL(18,2)) AS TotalPVP,\n` +
        `  CAST(SUM(ISNULL(d.[PrComp_EUR], 0) + ISNULL(d.[PrComp_EUR2], 0)) AS DECIMAL(18,2)) AS TotalCompart\n` +
        `FROM [dbo].[Atendimento] a\n` +
        `JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]\n` +
        `JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]\n` +
        `WHERE a.[Fim Venda] = 'S'\n` +
        `  AND a.[Data Venda] BETWEEN @from AND @to\n` +
        `GROUP BY a.[Atendimento ID], a.[Data Venda], a.[Tipo Documento]\n` +
        `ORDER BY SUM(d.[Valor_EUR]) DESC`;

      const resTopDocs = await pool
        .request()
        .input("from", sql.NVarChar, `${fromDate} 00:00:00`)
        .input("to", sql.NVarChar, `${toDate} 23:59:59`)
        .query<Record<string, unknown>>(sqlTopDocs);

      // ── Render
      console.log(RULE);
      console.log(`sales-summary-preview — caracterização semântica de vendas`);
      console.log(RULE);
      console.log(`Database         : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
      console.log(`Tabelas          : dbo.Atendimento, dbo.Atendimento Detalhe, dbo.Stocks`);
      console.log(`Filtros          : [Fim Venda]='S' AND [Data Venda] BETWEEN ${fromDate} AND ${toDate}`);
      console.log("");

      console.log(`══ Query 1 ── GROUP BY [Tipo Documento], [Entidade ID]`);
      console.log(`   ${resGroup.recordset.length} combinações distintas`);
      console.log("");
      if (resGroup.recordset.length === 0) {
        console.log("  (sem linhas — verifica intervalo de datas)");
      } else {
        console.log(
          renderSampleHorizontal(
            resGroup.recordset,
            [
              "TipoDoc",
              "EntidadeID",
              "Linhas",
              "Atendimentos",
              "QtdTotal",
              "ValorEUR",
              "PVPCalculado",
              "Comp1",
              "Comp2",
              "DataMin",
              "DataMax",
            ]
          )
        );
      }
      console.log("");

      console.log(`══ Query 2 ── TOP 10 documentos por SUM([Valor_EUR]) DESC`);
      console.log(`   ${resTopDocs.recordset.length} documentos`);
      console.log("");
      if (resTopDocs.recordset.length === 0) {
        console.log("  (sem documentos)");
      } else {
        console.log(
          renderSampleHorizontal(resTopDocs.recordset, [
            "AtendID",
            "DataVenda",
            "TipoDoc",
            "TotalValorLinha",
            "TotalPVP",
            "TotalCompart",
          ])
        );
      }
      console.log("");

      console.log(RULE);
      console.log("Interpretação operacional:");
      console.log("  · Comparar ValorEUR vs PVPCalculado por combo TipoDoc/EntidadeID:");
      console.log("      se ValorEUR ≈ PVPCalculado − (Comp1+Comp2)  ⇒ Valor_EUR = pago utente");
      console.log("      se ValorEUR ≈ PVPCalculado                  ⇒ Valor_EUR = total linha");
      console.log("  · EntidadeID=0 (ou similar) é tipicamente venda sem comparticipação");
      console.log("  · TipoDoc com Atendimentos=Linhas pode indicar docs técnicos (1-linha cada)");
      console.log("");
      console.log("Sem persistência — copia os dois blocos acima.");
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha no preview:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
