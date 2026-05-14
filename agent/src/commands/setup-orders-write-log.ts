/**
 * agent/src/commands/setup-orders-write-log.ts
 *
 * Cria (ou verifica que existe) a tabela auxiliar
 * `dbo.SPharmMT_OrderWriteLog` no SPharm ERP local.
 *
 * Esta tabela é **propriedade nossa** — não pertence ao schema SPharm,
 * não interfere com nenhum fluxo existente, e existe apenas para
 * guardar o mapeamento `outboxId (SaaS) → Encomenda ID (SPharm)` para
 * garantir idempotência sem escrever em colunas operacionais do ERP.
 *
 * Pré-requisito para `ordersWriteMode=insert`: sem esta tabela, o
 * agent recusa qualquer INSERT (ver `getInsertSchema` em
 * `spharm-orders-writer.ts`).
 *
 * SQL idempotente: se a tabela já existir, NÃO é alterada — apenas
 * verificada. Schema esperado:
 *
 *   outboxId    varchar(32) NOT NULL PRIMARY KEY
 *   encomendaId int         NOT NULL
 *   createdAt   datetime    NOT NULL DEFAULT GETDATE()
 *   payloadHash varchar(64) NULL
 *   status      varchar(20) NOT NULL DEFAULT 'created'
 *
 * Permissões: o SQL login precisa de CREATE TABLE em dbo (geralmente
 * NÃO concedido a app users). Se o CREATE falhar com permission denied,
 * o comando imprime o SQL completo para o DBA executar manualmente
 * via SSMS.
 */

import sql from "mssql";
import { loadConfig, ConfigError, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import type { SqlPool } from "../sql-client.js";

const TABLE_NAME = "dbo.SPharmMT_OrderWriteLog";

const CREATE_TABLE_SQL = `
IF OBJECT_ID('${TABLE_NAME}', 'U') IS NULL
BEGIN
    CREATE TABLE ${TABLE_NAME} (
        outboxId    varchar(32) NOT NULL,
        encomendaId int         NOT NULL,
        createdAt   datetime    NOT NULL CONSTRAINT DF_SPharmMT_OrderWriteLog_createdAt DEFAULT GETDATE(),
        payloadHash varchar(64) NULL,
        status      varchar(20) NOT NULL CONSTRAINT DF_SPharmMT_OrderWriteLog_status DEFAULT 'created',
        CONSTRAINT PK_SPharmMT_OrderWriteLog PRIMARY KEY CLUSTERED (outboxId)
    );
END
`.trim();

const RULE = "─".repeat(72);

async function tableExists(pool: SqlPool): Promise<boolean> {
  const r = await pool.request().query<{ oid: number | null }>(
    `SELECT OBJECT_ID('${TABLE_NAME}', 'U') AS oid`
  );
  return r.recordset[0]?.oid != null;
}

type ColumnRow = {
  name: string;
  dataType: string;
  maxLength: number;
  isNullable: boolean;
};

async function describeTable(pool: SqlPool): Promise<ColumnRow[]> {
  const r = await pool.request().query<{
    name: string;
    dataType: string;
    max_length: number;
    is_nullable: boolean;
  }>(`
    SELECT c.name AS name, ty.name AS dataType, c.max_length, c.is_nullable
    FROM sys.columns c
    JOIN sys.tables t ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
    WHERE s.name = 'dbo' AND t.name = 'SPharmMT_OrderWriteLog'
    ORDER BY c.column_id
  `);
  return r.recordset.map((row) => ({
    name: row.name,
    dataType: row.dataType,
    maxLength: row.max_length,
    isNullable: !!row.is_nullable,
  }));
}

function printColumns(cols: ColumnRow[]): void {
  console.log("Schema actual:");
  const w = Math.max(...cols.map((c) => c.name.length));
  for (const c of cols) {
    const len =
      c.dataType.startsWith("var") || c.dataType.startsWith("nvar")
        ? c.dataType.startsWith("n")
          ? `(${Math.floor(c.maxLength / 2)})`
          : `(${c.maxLength})`
        : "";
    console.log(`  ${c.name.padEnd(w)} ${c.dataType}${len}${c.isNullable ? " NULL" : " NOT NULL"}`);
  }
}

function printManualSql(): void {
  console.log("");
  console.log("SQL para o DBA executar via SSMS (login com permissão CREATE TABLE em dbo):");
  console.log("");
  console.log(CREATE_TABLE_SQL);
  console.log("");
  console.log("Depois de executar, voltar a correr `run-setup-orders-write-log.bat` para confirmar.");
}

export async function setupOrdersWriteLog(): Promise<number> {
  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("✗ Config inválida:");
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  console.log(RULE);
  console.log("setup-orders-write-log");
  console.log(RULE);
  console.log(`Database  : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Tabela    : ${TABLE_NAME}`);
  console.log("");
  console.log("Esta tabela é EXCLUSIVAMENTE do agent SPharm.MT — não interfere");
  console.log("com schema SPharm operacional. Guarda o mapeamento");
  console.log("outboxId (SaaS) → Encomenda ID (SPharm) para idempotência,");
  console.log("evitando escrever em colunas como VVM_ID que têm outro");
  console.log("significado operacional.");
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const beforeExists = await tableExists(pool);
      if (beforeExists) {
        console.log("✓ Tabela JÁ EXISTE — nada a criar.");
        console.log("");
        const cols = await describeTable(pool);
        printColumns(cols);
        console.log("");
        console.log(RULE);
        console.log("Setup OK — agent pode correr em ordersWriteMode=insert.");
        console.log(RULE);
        return 0;
      }

      console.log("· Tabela não existe. A tentar criar...");
      try {
        await pool.request().batch(CREATE_TABLE_SQL);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errObj = err as { number?: number };
        if (errObj.number === 262 || /CREATE TABLE permission denied|permission was denied/i.test(msg)) {
          console.error("");
          console.error("✗ SQL login não tem permissão CREATE TABLE em dbo.");
          console.error(`  Detalhe: ${msg}`);
          printManualSql();
          return 1;
        }
        console.error(`✗ Falha ao criar tabela: ${msg}`);
        printManualSql();
        return 1;
      }

      const afterExists = await tableExists(pool);
      if (!afterExists) {
        console.error("✗ CREATE TABLE foi reportado como sucesso mas a tabela continua a não existir. Inesperado.");
        return 1;
      }

      console.log("✓ Tabela CRIADA.");
      console.log("");
      const cols = await describeTable(pool);
      printColumns(cols);
      console.log("");
      console.log(RULE);
      console.log("Setup OK — agent pode correr em ordersWriteMode=insert.");
      console.log(RULE);
      console.log("Próximo passo:");
      console.log("  run-test-order-write.bat  (smoke test em DRY-RUN)");
      return 0;
    });
  } catch (err) {
    console.error("✗ Falha inesperada:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
