/**
 * agent/src/commands/inspect-codigoid.ts
 *
 * Probe read-only direccionada a uma lista de `CodigoID` específicos
 * em `dbo.Stocks`. Auxiliar de diagnose para produtos que aparecem
 * em vendas (IngestVendaLinhaRaw) mas que não foram upserted em
 * `Produto` no SaaS — tipicamente porque não satisfazem o filtro
 * operacional `[Retirado]=0 AND [Processa_Stocks]<>0` do bootstrap
 * ou daily-sync.
 *
 * Uso:
 *   inspect-codigoid --ids 35023,12551,34972
 *
 * Output: 1 bloco por CodigoID com Codigo (CNP), Codigo Externo (se
 * existir), Nome Comercial, flags operacionais, datas chave, PVP.
 *
 * Garantias:
 *   · Read-only, SQL 2008 R2 compatível
 *   · IN clause com IDs validados como int (sem injection)
 *   · Schema detection: [Codigo Externo] e Data_Actualiz incluídos
 *     se existirem; omitidos se não
 *   · Sem persistência (stdout-only)
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import { listColumns } from "./probe-helpers.js";

const RULE = "─".repeat(70);

type Args = { ids?: string; help?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      ids: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    ids: typeof raw.values.ids === "string" ? raw.values.ids : undefined,
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: inspect-codigoid --ids 123,456,789");
  console.log("");
  console.log("Consulta dbo.Stocks read-only para uma lista de CodigoIDs.");
  console.log("Mostra: CNP (Codigo), Codigo Externo (se existir), Nome Comercial,");
  console.log("        flags operacionais (Retirado, Processa_Stocks),");
  console.log("        datas (Data Ultima Venda/Compra, Data_Actualiz se existir),");
  console.log("        Preco Venda Publico_EUR.");
  console.log("");
  console.log("Útil para diagnosticar produtos órfãos de IngestVendaLinhaRaw");
  console.log("antes de decidir tratamento (re-bootstrap permissivo vs --allow-orphans).");
  console.log("");
  console.log("Exemplo:");
  console.log("  inspect-codigoid --ids 35023,12551,34972,34993,38555,41905");
}

function parseIds(arg: string): number[] {
  const parts = arg.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) throw new Error("--ids está vazio");
  if (parts.length > 200) throw new Error(`--ids tem ${parts.length} valores; máximo 200`);
  const ids: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) {
      throw new Error(`--ids contém valor não-inteiro: "${p}"`);
    }
    const n = parseInt(p, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`--ids contém valor inválido: "${p}"`);
    }
    ids.push(n);
  }
  return ids;
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "(null)";
  if (v instanceof Date) return v.toISOString().slice(0, 19) + "Z";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export async function inspectCodigoId(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    printHelp();
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!args.ids) {
    console.error("✗ --ids é obrigatório (lista CSV de CodigoIDs).");
    printHelp();
    return 1;
  }

  let ids: number[];
  try {
    ids = parseIds(args.ids);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
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
      // Schema detection p/ colunas opcionais
      const cols = await listColumns(pool, { schema: "dbo", table: "Stocks" });
      const colSet = new Set(cols.map((c) => c.name));
      const hasCodigoExterno = colSet.has("Codigo Externo");
      const hasDataActualiz = colSet.has("Data_Actualiz");

      // SELECT list com schema-detected columns
      const selectCols = [
        "CodigoID",
        "[Codigo]",
        ...(hasCodigoExterno ? ["[Codigo Externo]"] : []),
        "[Nome Comercial]",
        "[Retirado]",
        "[Processa_Stocks]",
        "[Data Ultima Venda]",
        "[Data Ultima Compra]",
        ...(hasDataActualiz ? ["[Data_Actualiz]"] : []),
        "[Preco Venda Publico_EUR]",
      ];

      // IDs já validados como int — interpolação segura no IN clause.
      const sqlText = `
        SELECT ${selectCols.join(", ")}
        FROM [dbo].[Stocks]
        WHERE CodigoID IN (${ids.join(",")})
        ORDER BY CodigoID
      `;

      const rs = await pool.request().query<Record<string, unknown>>(sqlText);

      console.log(RULE);
      console.log(`inspect-codigoid — ${ids.length} ID(s) consultados`);
      console.log(RULE);
      console.log(`Database         : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
      console.log(`Schema detection : Codigo Externo=${hasCodigoExterno ? "✓" : "✗"}, Data_Actualiz=${hasDataActualiz ? "✓" : "✗"}`);
      console.log(`IDs              : ${ids.join(", ")}`);
      console.log(`Encontrados      : ${rs.recordset.length} de ${ids.length}`);
      console.log("");

      // Identifica IDs não-encontrados
      const foundIds = new Set(rs.recordset.map((r) => Number(r.CodigoID)));
      const missing = ids.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        console.log(`⚠ NÃO ENCONTRADOS em dbo.Stocks: ${missing.join(", ")}`);
        console.log("   (CodigoID existe em IngestVendaLinhaRaw mas não em Stocks ERP — possivelmente apagado depois da venda)");
        console.log("");
      }

      // Print 1 bloco por row
      for (const row of rs.recordset) {
        console.log(`─── CodigoID ${row.CodigoID} ───`);
        for (const colExpr of selectCols) {
          // colExpr é "CodigoID" ou "[Codigo]" ou "[Nome Comercial]"
          const key = colExpr.startsWith("[") ? colExpr.slice(1, -1) : colExpr;
          console.log(`  ${key.padEnd(28)} ${fmtCell(row[key])}`);
        }
        console.log("");
      }

      // Análise rápida — quais foram os flags problemáticos?
      console.log("Análise (causa provável de orphan):");
      for (const row of rs.recordset) {
        const retirado = row["Retirado"];
        const processa = row["Processa_Stocks"];
        const motivo: string[] = [];
        const retiradoBool = typeof retirado === "number" ? retirado !== 0 : Boolean(retirado);
        const processaBool = typeof processa === "number" ? processa !== 0 : Boolean(processa);
        if (retiradoBool) motivo.push("Retirado=1");
        if (!processaBool) motivo.push("Processa_Stocks=0");
        const motivoStr = motivo.length > 0 ? motivo.join(" AND ") : "(satisfaz filtro operacional — orphan por outra causa)";
        console.log(`  ${String(row.CodigoID).padStart(7)}  ${motivoStr}`);
      }
      console.log("");
      console.log(RULE);
      console.log("Sem persistência — copia o bloco acima.");
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha na probe:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
