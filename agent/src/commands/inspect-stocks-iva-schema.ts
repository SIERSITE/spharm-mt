/**
 * agent/src/commands/inspect-stocks-iva-schema.ts
 *
 * Diagnóstico read-only do schema da tabela mestre `dbo.Stocks` para
 * descobrir o campo de IVA. Lista:
 *
 *   · candidatos (qualquer coluna com 'iva' no nome) — TODOS, sem filtro
 *   · TOP 10 valores DISTINCT em cada candidato (para validar escala)
 *   · todas as tabelas dbo.* cujo nome contém 'iva' ou 'taxa' (master?)
 *   · dump completo das ~100 primeiras colunas de Stocks (debug)
 *
 * NÃO toca em dados. NÃO envia para o SaaS.
 *
 * Output destinado a ser colado num issue para análise manual.
 */
import type { ConnectionPool as SqlPool } from "mssql";
import { loadConfig } from "../config.js";
import { withPool } from "../sql-client.js";

export async function inspectStocksIvaSchema(): Promise<number> {
  const cfg = loadConfig("sql");
  return await withPool(cfg, async (pool) => {
    await run(pool);
    return 0;
  });
}

async function run(pool: SqlPool): Promise<void> {
  console.log("\n=== 1. Colunas de dbo.Stocks que contêm 'iva' no nome ===\n");
  const candCols = await pool.request().query<{ column_: string; type_: string }>(`
    SELECT c.name AS column_, ty.name AS type_
    FROM sys.columns c
    JOIN sys.tables t  ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.types ty  ON c.user_type_id = ty.user_type_id
    WHERE s.name = 'dbo' AND t.name = 'Stocks' AND c.name LIKE '%iva%'
    ORDER BY c.column_id
  `);
  if (candCols.recordset.length === 0) {
    console.log("  (nenhuma coluna com 'iva' no nome encontrada)");
  } else {
    for (const r of candCols.recordset) {
      console.log(`  [${r.column_}]  ${r.type_}`);
    }
  }

  // Sample TOP 10 distinct values for each candidate
  console.log("\n=== 2. TOP 10 valores DISTINCT por candidato (validar escala) ===\n");
  for (const c of candCols.recordset) {
    console.log(`-- Stocks.[${c.column_}] (${c.type_}):`);
    try {
      const rs = await pool.request().query<{ v: unknown; n: number }>(`
        SELECT TOP 10 [${c.column_}] AS v, COUNT(*) AS n
        FROM [dbo].[Stocks]
        WHERE [Retirado] = 0
        GROUP BY [${c.column_}]
        ORDER BY COUNT(*) DESC
      `);
      for (const row of rs.recordset) {
        console.log(`     valor=${String(row.v).padStart(12)} × ${row.n}`);
      }
    } catch (e) {
      console.log(`     ⚠ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Master tables candidates (dbo.IVAs, dbo.TaxasIVA, etc.)
  console.log("\n=== 3. Tabelas dbo.* com 'iva' ou 'taxa' no nome (master?) ===\n");
  const masterTables = await pool.request().query<{ table_: string }>(`
    SELECT t.name AS table_
    FROM sys.tables t
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'dbo' AND (t.name LIKE '%iva%' OR t.name LIKE '%taxa%')
    ORDER BY t.name
  `);
  if (masterTables.recordset.length === 0) {
    console.log("  (nenhuma tabela candidata)");
  } else {
    for (const r of masterTables.recordset) {
      console.log(`  · dbo.[${r.table_}]`);
      try {
        const cols = await pool.request().query<{ column_: string }>(`
          SELECT c.name AS column_
          FROM sys.columns c
          JOIN sys.tables t ON c.object_id = t.object_id
          JOIN sys.schemas s ON t.schema_id = s.schema_id
          WHERE s.name = 'dbo' AND t.name = '${r.table_.replace(/'/g, "''")}'
          ORDER BY c.column_id
        `);
        console.log(`      colunas: ${cols.recordset.map((c) => `[${c.column_}]`).join(", ")}`);
        // Sample 5 rows
        const sample = await pool
          .request()
          .query(`SELECT TOP 5 * FROM [dbo].[${r.table_}]`);
        console.log(`      sample 5 rows: ${JSON.stringify(sample.recordset)}`);
      } catch (e) {
        console.log(`      ⚠ ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Full Stocks columns dump (cap 200)
  console.log("\n=== 4. Dump COMPLETO das colunas de dbo.Stocks (cap 200) ===\n");
  const allCols = await pool.request().query<{ column_: string; type_: string }>(`
    SELECT TOP 200 c.name AS column_, ty.name AS type_
    FROM sys.columns c
    JOIN sys.tables t  ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.types ty  ON c.user_type_id = ty.user_type_id
    WHERE s.name = 'dbo' AND t.name = 'Stocks'
    ORDER BY c.column_id
  `);
  for (const r of allCols.recordset) {
    console.log(`  [${r.column_}]  ${r.type_}`);
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("Cola tudo o que está acima na conversa para análise.");
}
