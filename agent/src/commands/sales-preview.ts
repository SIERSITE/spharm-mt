/**
 * agent/src/commands/sales-preview.ts
 *
 * Preview operacional read-only que junta cabeçalho de venda + linhas
 * + master de produtos, restrito a vendas concluídas dentro de um
 * intervalo de datas. Operacionaliza §5.5 do mapping canónico em
 * `docs/spharm-erp-canonical-mapping.md`.
 *
 * Tabelas hardcoded (validadas 2026-05-13):
 *   · dbo.Atendimento           (a) — cabeçalho de venda
 *   · dbo.Atendimento Detalhe   (d) — linhas de venda
 *   · dbo.Stocks                (s) — master de produtos (para Nome Comercial)
 *
 * **Todas as colunas são FIXAS** (confirmadas pelo operador em 2026-05-13).
 * Sem heurística no SELECT — qualquer divergência futura é diagnóstico
 * imediato via `assertColumnsExist`.
 *
 * Filtros HARDCODED no SQL:
 *   · a.[Fim Venda] IN ('S','U')       — só vendas concluídas
 *   · a.[Data Venda] BETWEEN @from AND @to
 *
 * Tipo Documento aparece no SELECT mas NÃO no WHERE — operador valida
 * tipos reais antes de uma iteração futura excluir tipos técnicos.
 *
 * Linha-a-linha — sem agregação. Linhas duplicadas com o mesmo
 * `CodigoID` no mesmo `Atendimento ID` são legítimas e distinguem-se
 * por `[Detalhe ID] + [Sequencia]`.
 *
 * Garantias: read-only, TOP 20, sem persistência, sem ingest SaaS.
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
  type SelectItem,
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
  console.log("Uso: sales-preview --from YYYY-MM-DD --to YYYY-MM-DD");
  console.log("");
  console.log("Junta dbo.Atendimento + dbo.Atendimento Detalhe + dbo.Stocks");
  console.log("e mostra TOP 20 ordenado por [Data Venda] DESC.");
  console.log("");
  console.log("Filtros hardcoded:");
  console.log("  a.[Fim Venda] IN ('S','U')                          (vendas concluídas)");
  console.log("  a.[Data Venda] BETWEEN @from AND @to         (intervalo obrigatório)");
  console.log("");
  console.log("Colunas (todas fixas, validadas 2026-05-13):");
  console.log("  DetalheID, Sequencia, AtendID, DataVenda, TipoDoc,");
  console.log("  CodigoID, Designacao, Qtd, PVPUnitario, ValorLinha,");
  console.log("  IVAValor, DescontoValor, Comparticipacao1/2, EntidadeID");
  console.log("");
  console.log("Exemplos:");
  console.log("  sales-preview --from 2026-05-01 --to 2026-05-12");
  console.log("");
  console.log("Garantias: read-only, TOP 20, sem persistência, sem ingest SaaS.");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md §5.5");
}

export async function salesPreview(): Promise<number> {
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

      // Diagnose claro se algum ERP futuro renomear/remover uma destas:
      assertColumnsExist(
        aCols,
        ["Atendimento ID", "Data Venda", "Fim Venda", "Tipo Documento"],
        "dbo.Atendimento"
      );
      assertColumnsExist(
        dCols,
        [
          "Detalhe ID",
          "Sequencia",
          "Atendimento ID",
          "CodigoID",
          "Quantidade",
          "Preco Venda Publico_EUR",
          "Valor_EUR",
          "Val_IVA_EUR",
          "Val_Desc_EUR",
          "PrComp_EUR",
          "PrComp_EUR2",
          "Entidade ID",
        ],
        "dbo.Atendimento Detalhe"
      );
      assertColumnsExist(sCols, ["CodigoID", "Nome Comercial"], "dbo.Stocks");

      // Mapping fixo — sem heurística.
      const items: SelectItem[] = [
        { alias: "DetalheID",         expr: "d.[Detalhe ID]",              sourceColumn: "Detalhe ID",              sourceTable: "Atendimento Detalhe" },
        { alias: "Sequencia",         expr: "d.[Sequencia]",               sourceColumn: "Sequencia",               sourceTable: "Atendimento Detalhe" },
        { alias: "AtendID",           expr: "a.[Atendimento ID]",          sourceColumn: "Atendimento ID",          sourceTable: "Atendimento" },
        { alias: "DataVenda",         expr: "a.[Data Venda]",              sourceColumn: "Data Venda",              sourceTable: "Atendimento" },
        { alias: "TipoDoc",           expr: "a.[Tipo Documento]",          sourceColumn: "Tipo Documento",          sourceTable: "Atendimento" },
        { alias: "CodigoID",          expr: "d.[CodigoID]",                sourceColumn: "CodigoID",                sourceTable: "Atendimento Detalhe" },
        { alias: "Designacao",        expr: "s.[Nome Comercial]",          sourceColumn: "Nome Comercial",          sourceTable: "Stocks" },
        { alias: "Qtd",               expr: "d.[Quantidade]",              sourceColumn: "Quantidade",              sourceTable: "Atendimento Detalhe" },
        { alias: "PVPUnitario",       expr: "d.[Preco Venda Publico_EUR]", sourceColumn: "Preco Venda Publico_EUR", sourceTable: "Atendimento Detalhe" },
        { alias: "ValorLinha",        expr: "d.[Valor_EUR]",               sourceColumn: "Valor_EUR",               sourceTable: "Atendimento Detalhe" },
        { alias: "IVAValor",          expr: "d.[Val_IVA_EUR]",             sourceColumn: "Val_IVA_EUR",             sourceTable: "Atendimento Detalhe" },
        { alias: "DescontoValor",     expr: "d.[Val_Desc_EUR]",            sourceColumn: "Val_Desc_EUR",            sourceTable: "Atendimento Detalhe" },
        { alias: "Comparticipacao1",  expr: "d.[PrComp_EUR]",              sourceColumn: "PrComp_EUR",              sourceTable: "Atendimento Detalhe" },
        { alias: "Comparticipacao2",  expr: "d.[PrComp_EUR2]",             sourceColumn: "PrComp_EUR2",             sourceTable: "Atendimento Detalhe" },
        { alias: "EntidadeID",        expr: "d.[Entidade ID]",             sourceColumn: "Entidade ID",             sourceTable: "Atendimento Detalhe" },
      ];

      const selectList = items.map((i) => `${i.expr} AS [${i.alias}]`).join(",\n  ");
      const sqlText =
        `SELECT TOP 20\n  ${selectList}\n` +
        `FROM [dbo].[Atendimento] a\n` +
        `JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]\n` +
        `JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]\n` +
        `WHERE a.[Fim Venda] IN ('S', 'U')\n` +
        `  AND a.[Data Venda] BETWEEN @from AND @to\n` +
        `ORDER BY a.[Data Venda] DESC, a.[Atendimento ID], d.[Sequencia]`;

      const res = await pool
        .request()
        .input("from", sql.NVarChar, `${fromDate} 00:00:00`)
        .input("to", sql.NVarChar, `${toDate} 23:59:59`)
        .query<Record<string, unknown>>(sqlText);

      console.log(RULE);
      console.log(`sales-preview — preview operacional (linha-a-linha, sem agregação)`);
      console.log(RULE);
      console.log(`Database         : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
      console.log(`Tabelas          : dbo.Atendimento, dbo.Atendimento Detalhe, dbo.Stocks`);
      console.log(`Filtros          : [Fim Venda] IN ('S','U') AND [Data Venda] BETWEEN ${fromDate} AND ${toDate}`);
      console.log(`Order            : [Data Venda] DESC, [Atendimento ID], [Sequencia]`);
      console.log("");

      console.log("Colunas (todas fixas):");
      const aliasW = Math.max(...items.map((i) => i.alias.length));
      for (const i of items) {
        const src = `${i.sourceTable}.${i.sourceColumn}`;
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
      if (res.recordset.length === 0) {
        console.log(
          `⚠ 0 linhas — verifica que existem vendas com [Fim Venda] IN ('S','U') no intervalo. ` +
            `[Tipo Documento] não está filtrado; se mesmo assim vier vazio, alarga --from.`
        );
      } else {
        console.log("Sem persistência — copia o bloco acima.");
      }
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha no preview:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
