/**
 * agent/src/commands/movimentos-audit.ts
 *
 * Auditoria ÚNICA do universo de movimentos no ERP SPharm/Softreis (rev32, v3).
 * Read-only. Produz UM relatório (.md + .json) com tudo o que é preciso
 * para fechar o domínio "Movimentos de Artigo" sem qualquer query manual.
 *
 * Conceitos chave:
 *   · `dbo.StocksMov` NÃO tem coluna TipoMov. O tipo deduz-se por FK:
 *       [Detalhe ID]                    → Atendimento (Venda ou DevCliente)
 *       [Atendimento Susp Detalhe ID]   → reserva
 *       [Atendimento Credito Detalhe ID]→ venda a crédito
 *       [Detalhe  Recp ID]              → Compra/Receção (DOIS ESPAÇOS)
 *       [Devolucao Detalhe ID]          → Devolução a Fornecedor
 *       [MovStocksDetID]                → movimento interno (Inventário/
 *                                          Quebra/Ajuste/Transferência),
 *                                          sub-tipo via MovStocksCab.Motivo
 *
 *   · As tabelas que ligam StocksMov ao motivo têm nomes que VARIAM por
 *     instalação Softreis. v3 descobre-as DINAMICAMENTE via sys.columns
 *     (procurando colunas MovStocksDetID, MovStocksCabID e
 *     MovStocksCabMotivoID em TODAS as tabelas user). Não assumimos nomes.
 *
 * Output:
 *   ./run/movimentos-audit-<timestamp>.md
 *   ./run/movimentos-audit-<timestamp>.json
 *
 * Cobertura completa num único run (~60s contra ERP local):
 *   1. dbo.StocksMov: schema + índices + row count + date range
 *   2. Volumetria por origem (FK-pattern, 24m)
 *   3. Sub-classificação VENDA vs Devolução Cliente (via Atendimento.[Tipo Documento])
 *   4. Movimentos internos (MovStocksDetID populated):
 *      4.1 DESCOBERTA via sys.columns das tabelas que contêm
 *          MovStocksDetID / MovStocksCabID / MovStocksCabMotivoID
 *      4.2 Resolução automática (table com PK = MovStocksDetID = "detail";
 *          PK = MovStocksCabID = "cab"); log de raciocínio
 *      4.3 Schemas das tabelas resolvidas + samples
 *      4.4 dbo.tblMovStocksCab_Motivo — DUMP COMPLETO
 *      4.5 Volumetria por motivo (24m, JOIN via tabelas resolvidas)
 *      4.6 Amostras TOP N por motivo
 *   5. Lookup [Tipo Documento] discovery
 *   6. Tabelas relacionadas (LIKE patterns) — mantido como bonus
 *   7. Correlação 7 dias (StocksMov × Atendimento × Recepcao × Devolucao)
 *
 * NÃO comunica com SaaS. NÃO escreve em ERP. NÃO requer SSMS.
 *
 * Uso:
 *   agent movimentos-audit                         # default 24m, 5 samples/motivo
 *   agent movimentos-audit --months 12 --samples 10
 *   agent movimentos-audit --out-dir C:\temp
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { tableExists, listColumns, type ColumnMeta } from "./probe-helpers.js";

const RULE = "═".repeat(72);
const DEFAULT_MONTHS = 24;
const DEFAULT_SAMPLES = 5;

// Colunas-chave que ligam StocksMov ao motivo do movimento interno.
// As tabelas que as contêm são descobertas em runtime — não assumimos nomes.
const INTERNAL_CHAIN_COLUMNS = ["MovStocksDetID", "MovStocksCabID", "MovStocksCabMotivoID"] as const;
type InternalColumn = typeof INTERNAL_CHAIN_COLUMNS[number];

// ── Types ────────────────────────────────────────────────────────────

type SampleRow = Record<string, unknown>;

type TableProbe = {
  schema: string;
  name: string;
  exists: boolean;
  rowCount: number;
  columns: ColumnMeta[];
  primaryKey: string[];
  indexes: Array<{ name: string; columns: string[]; isUnique: boolean }>;
  dateRange: { column: string; min: string | null; max: string | null } | null;
  sample: SampleRow[];
};

type RelatedTable = TableProbe & { matchedPattern: string };

type TableColumnHit = {
  schema: string;
  table: string;
  column: string;
  isInPk: boolean;
  pkColumnCount: number;
  isNullable: boolean;
  dataType: string;
};

type VolumetriaOrigem = {
  origem: string;
  rows: number;
  qtSum: number;
  qtPos: number;
  qtNeg: number;
  dataMin: string | null;
  dataMax: string | null;
};

type VolumetriaTipoDoc = {
  tipoDoc: number | null;
  inferred: "VENDA" | "DEVOLUCAO_CLIENTE" | "OUTROS";
  rows: number;
  qtSum: number;
  dataMin: string | null;
  dataMax: string | null;
};

type VolumetriaMotivo = {
  motivoId: number | null;
  motivoDesc: string | null;
  motivoInactivo: boolean | null;
  rows: number;
  qtSum: number;
  qtPos: number;
  qtNeg: number;
  dataMin: string | null;
  dataMax: string | null;
};

type SamplesPerMotivo = {
  motivoId: number | null;
  motivoDesc: string | null;
  rows: SampleRow[];
};

type AuditReport = {
  meta: {
    timestamp: string;
    agentRev: string;
    auditVersion: 3;
    erp: { host: string; port: number; database: string };
    paramsMonths: number;
    paramsSamples: number;
  };
  stocksMov: TableProbe & { fkColumnsDetected: string[] };
  volumetriaPorOrigem: VolumetriaOrigem[];
  volumetriaPorTipoDoc: VolumetriaTipoDoc[];
  movInterno: {
    candidatesByColumn: Record<InternalColumn, TableColumnHit[]>;
    resolvedDetTable: { schema: string; name: string; reasoning: string } | null;
    resolvedCabTable: { schema: string; name: string; reasoning: string } | null;
    resolutionLog: string[];
    detTableProbe: TableProbe | null;
    cabTableProbe: TableProbe | null;
    motivosFull: SampleRow[];
    motivosFullRowCount: number;
    volumetriaPorMotivo: VolumetriaMotivo[];
    samplesPorMotivo: SamplesPerMotivo[];
  };
  tipoDocumentoLookup: {
    tableName: string | null;
    rows: SampleRow[];
    triedNames: string[];
  };
  relatedTables: RelatedTable[];
  correlation: Array<{
    day: string;
    stocksMov: number;
    vendas: number;
    compras: number;
    devolFornecedor: number;
    deltaUnexplained: number;
  }>;
  warnings: string[];
};

// ── CLI args ─────────────────────────────────────────────────────────

type Args = {
  months: number;
  samples: number;
  outDir: string;
  help: boolean;
};

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      months: { type: "string" },
      samples: { type: "string" },
      "out-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const months = raw.values.months ? Number(raw.values.months) : DEFAULT_MONTHS;
  const samples = raw.values.samples ? Number(raw.values.samples) : DEFAULT_SAMPLES;
  return {
    months: Number.isFinite(months) && months > 0 ? months : DEFAULT_MONTHS,
    samples: Number.isFinite(samples) && samples > 0 ? samples : DEFAULT_SAMPLES,
    outDir: typeof raw.values["out-dir"] === "string" ? raw.values["out-dir"] : "./run",
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: movimentos-audit [--months N] [--samples N] [--out-dir <dir>]");
  console.log("");
  console.log("Auditoria ÚNICA read-only do universo de movimentos do ERP.");
  console.log("v3 (rev32): descoberta DINÂMICA das tabelas de movimento interno via");
  console.log("sys.columns — nomes não são assumidos, variam por instalação Softreis.");
  console.log("");
  console.log("Flags:");
  console.log("  --months <N>    janela de volumetria em meses (default 24)");
  console.log("  --samples <N>   amostras por motivo (default 5)");
  console.log("  --out-dir <d>   pasta de output (default ./run)");
}

// ── Coerce / pick helpers ────────────────────────────────────────────

function isoOrNull(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

function pickDateColumn(cols: ColumnMeta[], preferredNames: string[] = []): string | null {
  const dateLike = cols.filter((c) => /datetime|^date$/i.test(c.dataType));
  if (dateLike.length === 0) return null;
  for (const pref of preferredNames) {
    const m = dateLike.find((c) => c.name.toLowerCase() === pref.toLowerCase());
    if (m) return m.name;
  }
  const heuristic = dateLike.find((c) => /datamov|data\s*mov|datadev|data\s*dev|datarec|data\s*rec|datavend|data\s*venda|datadoc/i.test(c.name));
  return (heuristic ?? dateLike[0]).name;
}

// ── Generic SQL helpers ──────────────────────────────────────────────

async function getRowCount(pool: SqlPool, schema: string, table: string): Promise<number> {
  const r = await pool.request().input("s", sql.NVarChar, schema).input("t", sql.NVarChar, table)
    .query<{ n: number }>(`
      SELECT SUM(p.rows) n FROM sys.partitions p
      JOIN sys.tables t ON p.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name=@s AND t.name=@t AND p.index_id IN (0,1)`);
  return Number(r.recordset[0]?.n ?? 0);
}

async function getPrimaryKey(pool: SqlPool, schema: string, table: string): Promise<string[]> {
  const r = await pool.request().input("s", sql.NVarChar, schema).input("t", sql.NVarChar, table)
    .query<{ col: string }>(`
      SELECT c.name col FROM sys.indexes i
      JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id
      JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
      JOIN sys.tables t ON i.object_id=t.object_id
      JOIN sys.schemas s ON t.schema_id=s.schema_id
      WHERE s.name=@s AND t.name=@t AND i.is_primary_key=1
      ORDER BY ic.key_ordinal`);
  return r.recordset.map((x) => x.col);
}

async function getIndexes(pool: SqlPool, schema: string, table: string): Promise<Array<{ name: string; columns: string[]; isUnique: boolean }>> {
  const r = await pool.request().input("s", sql.NVarChar, schema).input("t", sql.NVarChar, table)
    .query<{ name: string; col: string; is_unique: boolean; key_ordinal: number }>(`
      SELECT i.name, c.name col, i.is_unique, ic.key_ordinal
      FROM sys.indexes i
      JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id
      JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
      JOIN sys.tables t ON i.object_id=t.object_id
      JOIN sys.schemas s ON t.schema_id=s.schema_id
      WHERE s.name=@s AND t.name=@t AND i.is_primary_key=0 AND ic.is_included_column=0
      ORDER BY i.name, ic.key_ordinal`);
  const m = new Map<string, { name: string; columns: string[]; isUnique: boolean }>();
  for (const row of r.recordset) {
    if (!m.has(row.name)) m.set(row.name, { name: row.name, columns: [], isUnique: !!row.is_unique });
    m.get(row.name)!.columns.push(row.col);
  }
  return Array.from(m.values());
}

async function getDateRange(pool: SqlPool, schema: string, table: string, dateCol: string): Promise<{ min: string | null; max: string | null }> {
  const r = await pool.request().query<{ min_date: Date | null; max_date: Date | null }>(
    `SELECT MIN([${dateCol}]) min_date, MAX([${dateCol}]) max_date FROM [${schema}].[${table}]`,
  );
  return { min: isoOrNull(r.recordset[0]?.min_date), max: isoOrNull(r.recordset[0]?.max_date) };
}

async function probeTableFull(pool: SqlPool, schema: string, table: string, sampleSize = 5): Promise<TableProbe> {
  const exists = await tableExists(pool, { schema, table });
  if (!exists) {
    return { schema, name: table, exists: false, rowCount: 0, columns: [], primaryKey: [], indexes: [], dateRange: null, sample: [] };
  }
  const columns = await listColumns(pool, { schema, table });
  const [rowCount, primaryKey, indexes] = await Promise.all([
    getRowCount(pool, schema, table),
    getPrimaryKey(pool, schema, table),
    getIndexes(pool, schema, table),
  ]);
  const dateCol = pickDateColumn(columns);
  const dateRange = dateCol ? { column: dateCol, ...(await getDateRange(pool, schema, table, dateCol)) } : null;
  let sample: SampleRow[] = [];
  try {
    const r = await pool.request().query<SampleRow>(`SELECT TOP ${sampleSize} * FROM [${schema}].[${table}]`);
    sample = r.recordset;
  } catch {
    // ignore — algumas tabelas com tipos exóticos podem falhar SELECT *
  }
  return { schema, name: table, exists: true, rowCount, columns, primaryKey, indexes, dateRange, sample };
}

// ── StocksMov FK-pattern volumetria ──────────────────────────────────

function detectStocksMovFks(cols: ColumnMeta[]): {
  detected: string[];
  detalheId: string | null;
  suspDetalheId: string | null;
  creditoDetalheId: string | null;
  recpDetalheId: string | null;
  devolDetalheId: string | null;
  movStocksDetId: string | null;
} {
  const byNorm = new Map<string, string>();
  for (const c of cols) byNorm.set(c.name.toLowerCase().replace(/\s+/g, " "), c.name);
  const pick = (...candidates: string[]): string | null => {
    for (const cand of candidates) {
      const real = byNorm.get(cand.toLowerCase().replace(/\s+/g, " "));
      if (real) return real;
    }
    return null;
  };
  const detalheId = pick("Detalhe ID");
  const suspDetalheId = pick("Atendimento Susp Detalhe ID");
  const creditoDetalheId = pick("Atendimento Credito Detalhe ID");
  const recpDetalheId = pick("Detalhe  Recp ID", "Detalhe Recp ID");
  const devolDetalheId = pick("Devolucao Detalhe ID");
  const movStocksDetId = pick("MovStocksDetID");
  const detected = [detalheId, suspDetalheId, creditoDetalheId, recpDetalheId, devolDetalheId, movStocksDetId]
    .filter((x): x is string => x !== null);
  return { detected, detalheId, suspDetalheId, creditoDetalheId, recpDetalheId, devolDetalheId, movStocksDetId };
}

async function getVolumetriaPorOrigem(
  pool: SqlPool,
  fks: ReturnType<typeof detectStocksMovFks>,
  dateCol: string,
  months: number,
): Promise<VolumetriaOrigem[]> {
  const parts: string[] = [];
  if (fks.devolDetalheId)    parts.push(`WHEN [${fks.devolDetalheId}] IS NOT NULL THEN 'DEVOLUCAO_FORNECEDOR'`);
  if (fks.recpDetalheId)     parts.push(`WHEN [${fks.recpDetalheId}] IS NOT NULL THEN 'COMPRA'`);
  if (fks.detalheId)         parts.push(`WHEN [${fks.detalheId}] IS NOT NULL THEN 'VENDA_OU_DEVOLUCAO_CLIENTE'`);
  if (fks.creditoDetalheId)  parts.push(`WHEN [${fks.creditoDetalheId}] IS NOT NULL THEN 'VENDA_CREDITO'`);
  if (fks.suspDetalheId)     parts.push(`WHEN [${fks.suspDetalheId}] IS NOT NULL THEN 'RESERVA'`);
  if (fks.movStocksDetId)    parts.push(`WHEN [${fks.movStocksDetId}] IS NOT NULL THEN 'MOV_INTERNO'`);
  const caseExpr = parts.length > 0
    ? `CASE\n        ${parts.join("\n        ")}\n        ELSE 'DESCONHECIDO'\n      END`
    : `'DESCONHECIDO'`;

  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const r = await pool.request().input("d", sql.DateTime, since).query<{
    origem: string; n: number; qtSum: number; qtPos: number; qtNeg: number;
    dataMin: Date | null; dataMax: Date | null;
  }>(`
    WITH classified AS (
      SELECT
        ${caseExpr} AS origem,
        [Qtd] AS qt,
        [${dateCol}] AS dataMov
      FROM [dbo].[StocksMov]
      WHERE [${dateCol}] >= @d
    )
    SELECT
      origem,
      COUNT_BIG(*) AS n,
      SUM(CAST(qt AS BIGINT)) AS qtSum,
      SUM(CASE WHEN qt > 0 THEN 1 ELSE 0 END) AS qtPos,
      SUM(CASE WHEN qt < 0 THEN 1 ELSE 0 END) AS qtNeg,
      MIN(dataMov) AS dataMin,
      MAX(dataMov) AS dataMax
    FROM classified
    GROUP BY origem
    ORDER BY n DESC`);
  return r.recordset.map((x) => ({
    origem: x.origem,
    rows: Number(x.n),
    qtSum: Number(x.qtSum ?? 0),
    qtPos: Number(x.qtPos),
    qtNeg: Number(x.qtNeg),
    dataMin: isoOrNull(x.dataMin),
    dataMax: isoOrNull(x.dataMax),
  }));
}

async function getVolumetriaPorTipoDoc(
  pool: SqlPool,
  detalheIdCol: string,
  dateCol: string,
  months: number,
): Promise<VolumetriaTipoDoc[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const r = await pool.request().input("d", sql.DateTime, since).query<{
    tipoDoc: number | null; n: number; qtSum: number; dataMin: Date | null; dataMax: Date | null;
  }>(`
    SELECT
      a.[Tipo Documento] AS tipoDoc,
      COUNT_BIG(*) AS n,
      SUM(CAST(sm.[Qtd] AS BIGINT)) AS qtSum,
      MIN(sm.[${dateCol}]) AS dataMin,
      MAX(sm.[${dateCol}]) AS dataMax
    FROM [dbo].[StocksMov] sm
    INNER JOIN [dbo].[Atendimento Detalhe] ad ON ad.[Detalhe ID] = sm.[${detalheIdCol}]
    INNER JOIN [dbo].[Atendimento] a ON a.[Atendimento ID] = ad.[Atendimento ID]
    WHERE sm.[${dateCol}] >= @d AND sm.[${detalheIdCol}] IS NOT NULL
    GROUP BY a.[Tipo Documento]
    ORDER BY n DESC`);
  return r.recordset.map((x) => ({
    tipoDoc: x.tipoDoc !== null ? Number(x.tipoDoc) : null,
    inferred: x.tipoDoc === 27 || x.tipoDoc === 104
      ? "DEVOLUCAO_CLIENTE" as const
      : x.tipoDoc !== null && [2, 7, 77].includes(Number(x.tipoDoc))
        ? "VENDA" as const
        : "OUTROS" as const,
    rows: Number(x.n),
    qtSum: Number(x.qtSum ?? 0),
    dataMin: isoOrNull(x.dataMin),
    dataMax: isoOrNull(x.dataMax),
  }));
}

// ── Discovery dinâmica da cadeia interna ─────────────────────────────

/**
 * Procura todas as tabelas user que contêm QUALQUER uma das colunas
 * `MovStocksDetID`, `MovStocksCabID`, `MovStocksCabMotivoID`. Reporta
 * se cada hit é parte da PK (= é o "owner" da entidade), nullable, etc.
 * Permite descobrir os nomes reais sem assumir.
 */
async function discoverByColumnNames(pool: SqlPool, columnNames: readonly string[]): Promise<TableColumnHit[]> {
  // SQL Server <= 2008 R2 não tem STRING_SPLIT; passamos como NVARCHAR temp + IN.
  // Usamos table-valued parameter? Não — overhead. Mais simples: query OR.
  const inClause = columnNames.map((_, i) => `@c${i}`).join(", ");
  const req = pool.request();
  columnNames.forEach((c, i) => req.input(`c${i}`, sql.NVarChar, c));
  const r = await req.query<{
    schema_: string; table_: string; column_: string;
    is_in_pk: number; pk_col_count: number;
    is_nullable: boolean; data_type: string;
  }>(`
    SELECT
      s.name AS schema_,
      t.name AS table_,
      c.name AS column_,
      ISNULL(pkInfo.is_in_pk, 0) AS is_in_pk,
      ISNULL(pkInfo.pk_col_count, 0) AS pk_col_count,
      c.is_nullable,
      ty.name AS data_type
    FROM sys.columns c
    JOIN sys.tables t ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
    OUTER APPLY (
      SELECT
        MAX(CASE WHEN ic.object_id IS NOT NULL THEN 1 ELSE 0 END) AS is_in_pk,
        (SELECT COUNT(*) FROM sys.index_columns ic2
         JOIN sys.indexes i2 ON i2.object_id=ic2.object_id AND i2.index_id=ic2.index_id
         WHERE ic2.object_id=t.object_id AND i2.is_primary_key=1) AS pk_col_count
      FROM sys.index_columns ic
      JOIN sys.indexes i ON i.object_id=ic.object_id AND i.index_id=ic.index_id
      WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id AND i.is_primary_key = 1
    ) pkInfo
    WHERE t.is_ms_shipped = 0
      AND c.name IN (${inClause})
    ORDER BY c.name, s.name, t.name`);
  return r.recordset.map((row) => ({
    schema: row.schema_,
    table: row.table_,
    column: row.column_,
    isInPk: Number(row.is_in_pk) === 1,
    pkColumnCount: Number(row.pk_col_count ?? 0),
    isNullable: !!row.is_nullable,
    dataType: row.data_type,
  }));
}

/**
 * Dada a discovery, resolve qual é a tabela "detail" (PK = MovStocksDetID)
 * e "cab" (PK = MovStocksCabID). Heurística: prefere PK simples (1 coluna)
 * com o nome alvo como PK; se múltiplas, escolhe a que tem menos colunas PK.
 * Retorna também log de raciocínio para auditoria.
 */
function resolveInternalChain(hits: TableColumnHit[]): {
  detTable: { schema: string; name: string; reasoning: string } | null;
  cabTable: { schema: string; name: string; reasoning: string } | null;
  log: string[];
} {
  const log: string[] = [];
  const byCol: Record<InternalColumn, TableColumnHit[]> = {
    MovStocksDetID: [], MovStocksCabID: [], MovStocksCabMotivoID: [],
  };
  for (const h of hits) {
    if (h.column in byCol) byCol[h.column as InternalColumn].push(h);
  }

  function pickOwner(col: InternalColumn): { schema: string; name: string; reasoning: string } | null {
    const candidates = byCol[col];
    if (candidates.length === 0) {
      log.push(`${col}: 0 tabelas encontradas.`);
      return null;
    }
    log.push(`${col}: ${candidates.length} tabela(s) com a coluna.`);
    // Preferir: PK simples (pk_col_count=1) com a coluna NOT NULL e no PK
    const ownerSimple = candidates.find((c) => c.isInPk && c.pkColumnCount === 1 && !c.isNullable);
    if (ownerSimple) {
      log.push(`  → owner (PK simples): ${ownerSimple.schema}.${ownerSimple.table}`);
      return { schema: ownerSimple.schema, name: ownerSimple.table, reasoning: `PK simples = ${col}` };
    }
    // Fallback: PK composta mas inclui esta coluna (pk_col_count >= 2)
    const ownerCompound = candidates.find((c) => c.isInPk && !c.isNullable);
    if (ownerCompound) {
      log.push(`  → owner (PK composta): ${ownerCompound.schema}.${ownerCompound.table} (PK tem ${ownerCompound.pkColumnCount} cols)`);
      return { schema: ownerCompound.schema, name: ownerCompound.table, reasoning: `PK composta inclui ${col}` };
    }
    // Sem owner claro — listar candidatos
    log.push(`  ✗ sem owner — todas as tabelas têm a coluna como FK/secundária:`);
    for (const c of candidates) {
      log.push(`     · ${c.schema}.${c.table} (${c.isInPk ? "PK" : "FK"}, ${c.isNullable ? "nullable" : "not null"})`);
    }
    return null;
  }

  const detTable = pickOwner("MovStocksDetID");
  const cabTable = pickOwner("MovStocksCabID");
  if (detTable && cabTable) {
    log.push(`✓ Cadeia resolvida: StocksMov.[MovStocksDetID] → ${detTable.schema}.${detTable.name} → (via MovStocksCabID) → ${cabTable.schema}.${cabTable.name} → tblMovStocksCab_Motivo`);
  }
  return { detTable, cabTable, log };
}

async function dumpFullTable(pool: SqlPool, schema: string, table: string, maxRows = 1000): Promise<SampleRow[]> {
  try {
    const r = await pool.request().query<SampleRow>(`SELECT TOP ${maxRows} * FROM [${schema}].[${table}]`);
    return r.recordset;
  } catch {
    return [];
  }
}

/**
 * Volumetria por motivo (24m) usando as tabelas RESOLVIDAS. As FKs em
 * MovStocks_Det/Cab (nomes reais) são detectadas: a coluna PK do detalhe
 * é o JOIN key vs StocksMov.MovStocksDetID; a coluna MovStocksCabID dentro
 * do detalhe é o JOIN key vs cab.MovStocksCabID; a coluna MovStocksCabMotivoID
 * dentro do cab é o JOIN key vs tblMovStocksCab_Motivo.
 */
async function getVolumetriaPorMotivo(
  pool: SqlPool,
  detTable: { schema: string; name: string },
  cabTable: { schema: string; name: string },
  movStocksDetIdColInSm: string,
  dateCol: string,
  months: number,
): Promise<VolumetriaMotivo[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  try {
    const r = await pool.request().input("d", sql.DateTime, since).query<{
      motivoId: number | null; motivoDesc: string | null; motivoInactivo: boolean | null;
      n: number; qtSum: number; qtPos: number; qtNeg: number;
      dataMin: Date | null; dataMax: Date | null;
    }>(`
      SELECT
        msc.[MovStocksCabMotivoID] AS motivoId,
        m.[Motivo] AS motivoDesc,
        m.[MotivoInactivo] AS motivoInactivo,
        COUNT_BIG(*) AS n,
        SUM(CAST(sm.[Qtd] AS BIGINT)) AS qtSum,
        SUM(CASE WHEN sm.[Qtd] > 0 THEN 1 ELSE 0 END) AS qtPos,
        SUM(CASE WHEN sm.[Qtd] < 0 THEN 1 ELSE 0 END) AS qtNeg,
        MIN(sm.[${dateCol}]) AS dataMin,
        MAX(sm.[${dateCol}]) AS dataMax
      FROM [dbo].[StocksMov] sm
      INNER JOIN [${detTable.schema}].[${detTable.name}] msd ON msd.[MovStocksDetID] = sm.[${movStocksDetIdColInSm}]
      INNER JOIN [${cabTable.schema}].[${cabTable.name}] msc ON msc.[MovStocksCabID] = msd.[MovStocksCabID]
      LEFT JOIN [dbo].[tblMovStocksCab_Motivo] m ON m.[MovStocksCabMotivoID] = msc.[MovStocksCabMotivoID]
      WHERE sm.[${dateCol}] >= @d AND sm.[${movStocksDetIdColInSm}] IS NOT NULL
      GROUP BY msc.[MovStocksCabMotivoID], m.[Motivo], m.[MotivoInactivo]
      ORDER BY n DESC`);
    return r.recordset.map((x) => ({
      motivoId: x.motivoId !== null ? Number(x.motivoId) : null,
      motivoDesc: x.motivoDesc,
      motivoInactivo: x.motivoInactivo,
      rows: Number(x.n),
      qtSum: Number(x.qtSum ?? 0),
      qtPos: Number(x.qtPos),
      qtNeg: Number(x.qtNeg),
      dataMin: isoOrNull(x.dataMin),
      dataMax: isoOrNull(x.dataMax),
    }));
  } catch {
    return [];
  }
}

async function getSamplesPorMotivo(
  pool: SqlPool,
  detTable: { schema: string; name: string },
  cabTable: { schema: string; name: string },
  movStocksDetIdColInSm: string,
  dateCol: string,
  months: number,
  samplesPerMotivo: number,
): Promise<SamplesPerMotivo[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  try {
    const r = await pool.request().input("d", sql.DateTime, since).input("n", sql.Int, samplesPerMotivo).query<SampleRow & { rn: number; motivoId: number | null; motivoDesc: string | null }>(`
      WITH ranked AS (
        SELECT
          sm.[StocksMovID], sm.[CodigoID], sm.[${dateCol}] AS DataMov,
          sm.[Qtd], sm.[QtdBonus], sm.[Existencia], sm.[ValorCustoUnit],
          sm.[OldPMC], sm.[NovoPMC], sm.[${movStocksDetIdColInSm}] AS MovStocksDetID,
          sm.[StocksMovArmazemID],
          msc.[MovStocksCabMotivoID] AS motivoId,
          m.[Motivo] AS motivoDesc,
          ROW_NUMBER() OVER (PARTITION BY msc.[MovStocksCabMotivoID] ORDER BY sm.[${dateCol}] DESC) AS rn
        FROM [dbo].[StocksMov] sm
        INNER JOIN [${detTable.schema}].[${detTable.name}] msd ON msd.[MovStocksDetID] = sm.[${movStocksDetIdColInSm}]
        INNER JOIN [${cabTable.schema}].[${cabTable.name}] msc ON msc.[MovStocksCabID] = msd.[MovStocksCabID]
        LEFT JOIN [dbo].[tblMovStocksCab_Motivo] m ON m.[MovStocksCabMotivoID] = msc.[MovStocksCabMotivoID]
        WHERE sm.[${dateCol}] >= @d AND sm.[${movStocksDetIdColInSm}] IS NOT NULL
      )
      SELECT * FROM ranked WHERE rn <= @n ORDER BY motivoId, rn`);
    const groups = new Map<string, SamplesPerMotivo>();
    for (const row of r.recordset) {
      const key = String(row.motivoId ?? "NULL");
      if (!groups.has(key)) {
        groups.set(key, {
          motivoId: row.motivoId !== null ? Number(row.motivoId) : null,
          motivoDesc: row.motivoDesc,
          rows: [],
        });
      }
      const { rn: _rn, motivoId: _m, motivoDesc: _d, ...rest } = row as Record<string, unknown>;
      void _rn; void _m; void _d;
      groups.get(key)!.rows.push(rest);
    }
    return Array.from(groups.values());
  } catch {
    return [];
  }
}

// ── Tipo Documento lookup discovery ──────────────────────────────────

async function findTipoDocumentoLookup(pool: SqlPool): Promise<AuditReport["tipoDocumentoLookup"]> {
  const candidates = [
    "Tipo Documento", "TipoDocumento", "Tbl_TipoDocumento", "Tbl_Tipo_Documento",
    "Tipos Documento", "TipoDocumentos", "Tipo_Documento", "TiposDoc", "TipoDoc",
  ];
  const tried: string[] = [];
  for (const t of candidates) {
    tried.push(t);
    if (!(await tableExists(pool, { schema: "dbo", table: t }))) continue;
    const cols = await listColumns(pool, { schema: "dbo", table: t });
    const idCol = cols.find((c) => /id$/i.test(c.name) && /tipo|doc/i.test(c.name))?.name ?? cols[0]?.name;
    const descCol = cols.find((c) => /descr|nome|name|titulo/i.test(c.name))?.name;
    try {
      const sel = descCol ? `[${idCol}] AS id, [${descCol}] AS descricao` : `[${idCol}] AS id, NULL AS descricao`;
      const r = await pool.request().query<SampleRow>(`SELECT TOP 200 ${sel} FROM [dbo].[${t}] ORDER BY [${idCol}]`);
      return { tableName: `dbo.${t}`, rows: r.recordset, triedNames: tried };
    } catch {
      // continua
    }
  }
  return { tableName: null, rows: [], triedNames: tried };
}

// ── Related tables (sys.tables LIKE patterns) ────────────────────────

const RELATED_PATTERNS: Array<{ pattern: string; label: string }> = [
  { pattern: "%nventar%", label: "inventário" },
  { pattern: "%egulariz%", label: "regularização" },
  { pattern: "%uebra%", label: "quebra" },
  { pattern: "%erda%", label: "perda" },
  { pattern: "%ransfer%", label: "transferência" },
  { pattern: "%juste%", label: "ajuste" },
  { pattern: "%nulac%", label: "anulação" },
  { pattern: "%Motivo%", label: "motivos" },
  { pattern: "%MovStocks%", label: "movstocks (bonus)" },
];

async function findRelatedTables(pool: SqlPool): Promise<Array<{ name: string; schema: string; matchedPattern: string }>> {
  const out: Array<{ name: string; schema: string; matchedPattern: string }> = [];
  const seen = new Set<string>();
  for (const p of RELATED_PATTERNS) {
    const r = await pool.request().input("p", sql.NVarChar, p.pattern).query<{ schema_: string; name: string }>(`
      SELECT ss.name schema_, tt.name FROM sys.tables tt
      JOIN sys.schemas ss ON tt.schema_id = ss.schema_id
      WHERE tt.is_ms_shipped = 0 AND tt.name LIKE @p
      ORDER BY ss.name, tt.name`);
    for (const row of r.recordset) {
      const sch = row.schema_ ?? "dbo";
      const key = `${sch}.${row.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: row.name, schema: sch, matchedPattern: p.label });
    }
  }
  return out;
}

async function dumpRelatedTable(pool: SqlPool, schema: string, name: string, matchedPattern: string): Promise<RelatedTable> {
  const probe = await probeTableFull(pool, schema, name, 3);
  return { ...probe, matchedPattern };
}

// ── Correlação 7 dias ────────────────────────────────────────────────

async function getCorrelation(
  pool: SqlPool,
  stocksMovDateCol: string,
): Promise<AuditReport["correlation"]> {
  let devolDateCol: string | null = null;
  if (await tableExists(pool, { schema: "dbo", table: "Devolucao" })) {
    const cols = await listColumns(pool, { schema: "dbo", table: "Devolucao" });
    devolDateCol = pickDateColumn(cols, ["Data Devolucao", "DataDevolucao", "Data", "DataMov", "Data Mov"]);
  }

  const since = new Date();
  since.setDate(since.getDate() - 7);
  const devolApply = devolDateCol
    ? `OUTER APPLY (
        SELECT COUNT_BIG(*) n FROM [dbo].[Devolucao Detalhe] dd
        JOIN [dbo].[Devolucao] dv ON dv.[Devolucao ID]=dd.[Devolucao ID]
        WHERE CAST(dv.[${devolDateCol}] AS DATE) = d.dia
      ) dev`
    : `OUTER APPLY (SELECT CAST(0 AS BIGINT) n) dev`;
  try {
    const r = await pool.request().input("d", sql.DateTime, since).query<{
      dia: Date; stocksMov: number; vendas: number; compras: number; devol: number;
    }>(`
      SELECT d.dia, sm.n stocksMov, ven.n vendas, com.n compras, dev.n devol
      FROM (
        SELECT DISTINCT CAST([${stocksMovDateCol}] AS DATE) dia FROM [dbo].[StocksMov] WHERE [${stocksMovDateCol}] >= @d
      ) d
      OUTER APPLY (SELECT COUNT_BIG(*) n FROM [dbo].[StocksMov] x WHERE CAST(x.[${stocksMovDateCol}] AS DATE) = d.dia) sm
      OUTER APPLY (
        SELECT COUNT_BIG(*) n FROM [dbo].[Atendimento Detalhe] ad
        JOIN [dbo].[Atendimento] a ON a.[Atendimento ID]=ad.[Atendimento ID]
        WHERE CAST(a.[Data Venda] AS DATE) = d.dia AND a.[Fim Venda] IN ('S','U')
      ) ven
      OUTER APPLY (
        SELECT COUNT_BIG(*) n FROM [dbo].[Recepcao Detalhe] rd
        JOIN [dbo].[Recepcao] r ON r.[Recepcao ID]=rd.[Recepcao ID]
        WHERE CAST(r.[Data Recepcao] AS DATE) = d.dia AND r.[RecepcaoSituacaoID]='N'
      ) com
      ${devolApply}
      ORDER BY d.dia DESC`);
    return r.recordset.map((row) => ({
      day: row.dia.toISOString().slice(0, 10),
      stocksMov: Number(row.stocksMov ?? 0),
      vendas: Number(row.vendas ?? 0),
      compras: Number(row.compras ?? 0),
      devolFornecedor: Number(row.devol ?? 0),
      deltaUnexplained: Number(row.stocksMov ?? 0) - Number(row.vendas ?? 0) - Number(row.compras ?? 0) - Number(row.devol ?? 0),
    }));
  } catch (e) {
    throw new Error(`correlação falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Markdown renderer ────────────────────────────────────────────────

function fmtCol(c: ColumnMeta): string {
  let type = c.dataType;
  if (c.precision && /numeric|decimal/i.test(type)) type += `(${c.precision},${c.scale ?? 0})`;
  else if (c.maxLength && /char|binary/i.test(type)) {
    const n = c.maxLength === -1 ? "MAX" : c.dataType.startsWith("n") ? c.maxLength / 2 : c.maxLength;
    type += `(${n})`;
  }
  return `${c.name} :: ${type}${c.nullable ? " NULL" : " NOT NULL"}`;
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "(null)";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "…";
  return String(v);
}

function renderTableProbe(md: string[], t: TableProbe, title?: string): void {
  md.push(`${title ?? `### ${t.schema}.${t.name}`} — ${t.exists ? `${t.rowCount.toLocaleString("pt-PT")} rows` : "✗ NÃO EXISTE"}\n`);
  if (!t.exists) { md.push(""); return; }
  md.push(`- PK: ${t.primaryKey.join(", ") || "(sem)"}`);
  if (t.dateRange) md.push(`- Date range [${t.dateRange.column}]: ${t.dateRange.min?.slice(0, 10) ?? "?"} → ${t.dateRange.max?.slice(0, 10) ?? "?"}`);
  md.push("");
  md.push("```");
  for (const c of t.columns) md.push(`  ${fmtCol(c)}`);
  md.push("```");
  if (t.indexes.length > 0) {
    md.push(`\nÍndices:`);
    for (const i of t.indexes) md.push(`- \`${i.name}\`${i.isUnique ? " UNIQUE" : ""}: (${i.columns.join(", ")})`);
  }
  if (t.sample.length > 0) {
    md.push(`\nSample (${t.sample.length} rows):`);
    md.push("```");
    t.sample.forEach((row, i) => {
      md.push(`-- [${i + 1}] --`);
      for (const [k, v] of Object.entries(row)) md.push(`  ${k}: ${fmtVal(v)}`);
    });
    md.push("```");
  }
  md.push("");
}

function renderMarkdown(r: AuditReport): string {
  const md: string[] = [];
  md.push(`# Auditoria de Movimentos ERP (v${r.meta.auditVersion})\n`);
  md.push(`- **Timestamp:** ${r.meta.timestamp}`);
  md.push(`- **Agent rev:** ${r.meta.agentRev}`);
  md.push(`- **ERP:** ${r.meta.erp.database}@${r.meta.erp.host}:${r.meta.erp.port}`);
  md.push(`- **Janela:** ${r.meta.paramsMonths} meses · samples/motivo=${r.meta.paramsSamples}\n`);

  if (r.warnings.length > 0) {
    md.push(`## ⚠ Warnings\n`);
    for (const w of r.warnings) md.push(`- ${w}`);
    md.push("");
  }

  md.push(`## 1. dbo.StocksMov\n`);
  renderTableProbe(md, r.stocksMov, "### Schema");
  md.push(`### FK columns detectadas (classificador FK-pattern)\n`);
  md.push(r.stocksMov.fkColumnsDetected.length > 0
    ? r.stocksMov.fkColumnsDetected.map((c) => `- \`[${c}]\``).join("\n")
    : "✗ NENHUMA FK detectada — schema inesperado.");
  md.push("");

  md.push(`## 2. Volumetria por origem (FK-pattern, ${r.meta.paramsMonths}m)\n`);
  if (r.volumetriaPorOrigem.length === 0) {
    md.push(`(sem dados)\n`);
  } else {
    md.push(`| Origem | Linhas | qt sum | qt>0 | qt<0 | minD | maxD |`);
    md.push(`|---|---:|---:|---:|---:|---|---|`);
    for (const v of r.volumetriaPorOrigem) {
      md.push(`| ${v.origem} | ${v.rows.toLocaleString("pt-PT")} | ${v.qtSum.toLocaleString("pt-PT")} | ${v.qtPos.toLocaleString("pt-PT")} | ${v.qtNeg.toLocaleString("pt-PT")} | ${v.dataMin?.slice(0, 10) ?? "—"} | ${v.dataMax?.slice(0, 10) ?? "—"} |`);
    }
    md.push("");
  }

  md.push(`## 3. Sub-classificação VENDA vs Devolução Cliente (via Atendimento.[Tipo Documento])\n`);
  if (r.volumetriaPorTipoDoc.length === 0) {
    md.push(`(sem dados — sem FK [Detalhe ID] populada ou Atendimento JOIN falhou)\n`);
  } else {
    md.push(`| TipoDoc | Inferred | Linhas | qt sum | minD | maxD |`);
    md.push(`|---:|---|---:|---:|---|---|`);
    for (const v of r.volumetriaPorTipoDoc) {
      md.push(`| ${v.tipoDoc ?? "NULL"} | ${v.inferred} | ${v.rows.toLocaleString("pt-PT")} | ${v.qtSum.toLocaleString("pt-PT")} | ${v.dataMin?.slice(0, 10) ?? "—"} | ${v.dataMax?.slice(0, 10) ?? "—"} |`);
    }
    md.push("");
  }

  md.push(`## 4. Movimentos internos (MovStocksDetID populated)\n`);
  md.push(`### 4.1 Discovery dinâmica — tabelas com colunas-chave\n`);
  for (const col of INTERNAL_CHAIN_COLUMNS) {
    const hits = r.movInterno.candidatesByColumn[col];
    md.push(`**\`${col}\`** — ${hits.length} tabela(s) encontradas`);
    if (hits.length > 0) {
      md.push(`| Schema | Tabela | Em PK? | Cols PK | Nullable | Tipo |`);
      md.push(`|---|---|---|---:|---|---|`);
      for (const h of hits) {
        md.push(`| ${h.schema} | ${h.table} | ${h.isInPk ? "**sim**" : "não"} | ${h.pkColumnCount} | ${h.isNullable ? "sim" : "não"} | ${h.dataType} |`);
      }
    }
    md.push("");
  }

  md.push(`### 4.2 Resolução automática da cadeia\n`);
  md.push("```");
  for (const line of r.movInterno.resolutionLog) md.push(line);
  md.push("```");
  md.push(`- **Detail table (PK MovStocksDetID):** ${r.movInterno.resolvedDetTable ? `\`${r.movInterno.resolvedDetTable.schema}.${r.movInterno.resolvedDetTable.name}\` (${r.movInterno.resolvedDetTable.reasoning})` : "✗ NÃO RESOLVIDA"}`);
  md.push(`- **Cab table (PK MovStocksCabID):** ${r.movInterno.resolvedCabTable ? `\`${r.movInterno.resolvedCabTable.schema}.${r.movInterno.resolvedCabTable.name}\` (${r.movInterno.resolvedCabTable.reasoning})` : "✗ NÃO RESOLVIDA"}`);
  md.push("");

  md.push(`### 4.3 Schema das tabelas resolvidas\n`);
  if (r.movInterno.detTableProbe) renderTableProbe(md, r.movInterno.detTableProbe, "#### Detail");
  if (r.movInterno.cabTableProbe) renderTableProbe(md, r.movInterno.cabTableProbe, "#### Cab");

  md.push(`### 4.4 dbo.tblMovStocksCab_Motivo — DUMP COMPLETO (${r.movInterno.motivosFullRowCount} rows)\n`);
  if (r.movInterno.motivosFull.length === 0) {
    md.push(`(vazio ou tabela inacessível)\n`);
  } else {
    md.push("```");
    for (const m of r.movInterno.motivosFull) md.push(`  ${JSON.stringify(m)}`);
    md.push("```\n");
  }

  md.push(`### 4.5 Volumetria por motivo (${r.meta.paramsMonths}m)\n`);
  if (r.movInterno.volumetriaPorMotivo.length === 0) {
    md.push(`(sem dados — cadeia não resolvida ou sem movimentos internos no período)\n`);
  } else {
    md.push(`| MotivoID | Descrição | Inactivo? | Linhas | qt sum | qt>0 | qt<0 | minD | maxD |`);
    md.push(`|---:|---|---|---:|---:|---:|---:|---|---|`);
    for (const v of r.movInterno.volumetriaPorMotivo) {
      md.push(`| ${v.motivoId ?? "NULL"} | ${(v.motivoDesc ?? "(null)").replace(/\|/g, "\\|")} | ${v.motivoInactivo === null ? "?" : v.motivoInactivo ? "sim" : "não"} | ${v.rows.toLocaleString("pt-PT")} | ${v.qtSum.toLocaleString("pt-PT")} | ${v.qtPos.toLocaleString("pt-PT")} | ${v.qtNeg.toLocaleString("pt-PT")} | ${v.dataMin?.slice(0, 10) ?? "—"} | ${v.dataMax?.slice(0, 10) ?? "—"} |`);
    }
    md.push("");
  }

  md.push(`### 4.6 Amostras TOP ${r.meta.paramsSamples} por motivo\n`);
  if (r.movInterno.samplesPorMotivo.length === 0) {
    md.push(`(sem dados)\n`);
  } else {
    for (const g of r.movInterno.samplesPorMotivo) {
      md.push(`#### motivo=${g.motivoId ?? "NULL"} (${g.motivoDesc ?? "(null)"})\n`);
      md.push("```");
      g.rows.forEach((row, i) => {
        md.push(`-- [${i + 1}] --`);
        for (const [k, v] of Object.entries(row)) md.push(`  ${k}: ${fmtVal(v)}`);
      });
      md.push("```\n");
    }
  }

  md.push(`## 5. Lookup [Tipo Documento]\n`);
  md.push(`Tentou: ${r.tipoDocumentoLookup.triedNames.map((n) => `\`dbo.${n}\``).join(", ")}\n`);
  if (r.tipoDocumentoLookup.tableName === null) {
    md.push(`✗ Nenhuma tabela TipoDocumento encontrada com nomes candidatos.\n`);
  } else {
    md.push(`✓ Encontrada: \`${r.tipoDocumentoLookup.tableName}\` (${r.tipoDocumentoLookup.rows.length} rows)\n`);
    md.push("```");
    for (const row of r.tipoDocumentoLookup.rows) md.push(`  ${JSON.stringify(row)}`);
    md.push("```\n");
  }

  md.push(`## 6. Tabelas relacionadas (sys.tables LIKE patterns)\n`);
  for (const t of r.relatedTables) {
    md.push(`### ${t.schema}.${t.name} (${t.matchedPattern}) — ${t.rowCount.toLocaleString("pt-PT")} rows\n`);
    md.push("```");
    for (const c of t.columns) md.push(`  ${fmtCol(c)}`);
    md.push("```");
    if (t.sample.length > 0) {
      md.push(`\nSample (3 rows):`);
      md.push("```");
      t.sample.forEach((row, i) => {
        md.push(`-- [${i + 1}] --`);
        for (const [k, v] of Object.entries(row)) md.push(`  ${k}: ${fmtVal(v)}`);
      });
      md.push("```");
    }
    md.push("");
  }

  md.push(`## 7. Correlação 7 dias (StocksMov vs documentos)\n`);
  if (r.correlation.length === 0) {
    md.push(`(sem dados nos últimos 7 dias)\n`);
  } else {
    md.push(`| Dia | StocksMov | Vendas | Compras | Devol.Forn | Δ unexplained |`);
    md.push(`|---|---:|---:|---:|---:|---:|`);
    for (const c of r.correlation) {
      md.push(`| ${c.day} | ${c.stocksMov} | ${c.vendas} | ${c.compras} | ${c.devolFornecedor} | ${c.deltaUnexplained > 0 ? "**+" + c.deltaUnexplained + "**" : c.deltaUnexplained} |`);
    }
    md.push("");
    md.push(`> Δ unexplained > 0 ⇒ movimentos StocksMov sem correspondência em Atendimento/Recepcao/Devolucao = candidatos a movimentos internos.\n`);
  }

  return md.join("\n");
}

// ── Entry point ──────────────────────────────────────────────────────

export async function movimentosAudit(): Promise<number> {
  let args: Args;
  try { args = parseCmdArgs(); }
  catch (err) { console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err); return 1; }
  if (args.help) { printHelp(); return 0; }

  let cfg: AgentConfig;
  try { cfg = loadConfig("sql"); }
  catch (err) { console.error("✗ Config inválida:", err instanceof Error ? err.message : String(err)); return 1; }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.resolve(args.outDir);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  console.log(RULE);
  console.log("movimentos-audit v3 — discovery dinâmica do universo de movimentos");
  console.log(RULE);
  console.log(`ERP: ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Janela: ${args.months} meses  ·  Samples/motivo: ${args.samples}`);
  console.log(`Output: ${outDir}\\movimentos-audit-${ts}.{md,json}`);
  console.log("");

  const warnings: string[] = [];

  const emptyProbe: TableProbe = { schema: "dbo", name: "", exists: false, rowCount: 0, columns: [], primaryKey: [], indexes: [], dateRange: null, sample: [] };
  const report: AuditReport = {
    meta: { timestamp: new Date().toISOString(), agentRev: process.env.AGENT_REV ?? "?", auditVersion: 3, erp: { host: cfg.sqlHost, port: cfg.sqlPort, database: cfg.sqlDatabase }, paramsMonths: args.months, paramsSamples: args.samples },
    stocksMov: { ...emptyProbe, name: "StocksMov", fkColumnsDetected: [] },
    volumetriaPorOrigem: [],
    volumetriaPorTipoDoc: [],
    movInterno: {
      candidatesByColumn: { MovStocksDetID: [], MovStocksCabID: [], MovStocksCabMotivoID: [] },
      resolvedDetTable: null,
      resolvedCabTable: null,
      resolutionLog: [],
      detTableProbe: null,
      cabTableProbe: null,
      motivosFull: [],
      motivosFullRowCount: 0,
      volumetriaPorMotivo: [],
      samplesPorMotivo: [],
    },
    tipoDocumentoLookup: { tableName: null, rows: [], triedNames: [] },
    relatedTables: [],
    correlation: [],
    warnings,
  };

  try {
    return await withPool(cfg, async (pool) => {
      // ── 1. dbo.StocksMov ──
      console.log("▶ 1/9  Schema dbo.StocksMov + FK detection ...");
      const smProbe = await probeTableFull(pool, "dbo", "StocksMov", 0);
      const fks = detectStocksMovFks(smProbe.columns);
      report.stocksMov = { ...smProbe, fkColumnsDetected: fks.detected };
      if (!smProbe.exists) {
        warnings.push("dbo.StocksMov NÃO EXISTE — auditoria não pode prosseguir além deste ponto.");
      } else if (fks.detected.length < 5) {
        warnings.push(`Apenas ${fks.detected.length}/6 FKs detectadas em StocksMov — schema pode estar incompleto. Detectadas: ${fks.detected.join(", ")}`);
      }
      const dateCol = smProbe.dateRange?.column ?? null;

      if (smProbe.exists && dateCol) {
        // ── 2. Volumetria por origem ──
        console.log("▶ 2/9  Volumetria por origem (FK-pattern) ...");
        try {
          report.volumetriaPorOrigem = await getVolumetriaPorOrigem(pool, fks, dateCol, args.months);
        } catch (e) {
          warnings.push(`Volumetria por origem falhou: ${e instanceof Error ? e.message : String(e)}`);
        }

        // ── 3. Sub-classificação VENDA vs DC ──
        if (fks.detalheId) {
          console.log("▶ 3/9  Sub-classificação VENDA vs Devolução Cliente ...");
          try {
            report.volumetriaPorTipoDoc = await getVolumetriaPorTipoDoc(pool, fks.detalheId, dateCol, args.months);
          } catch (e) {
            warnings.push(`Volumetria por TipoDoc falhou: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // ── 4. Discovery dinâmica da cadeia interna ──
        console.log("▶ 4/9  Discovery via sys.columns das tabelas com MovStocksDetID/CabID/MotivoID ...");
        const hits = await discoverByColumnNames(pool, INTERNAL_CHAIN_COLUMNS);
        for (const h of hits) {
          if (h.column in report.movInterno.candidatesByColumn) {
            report.movInterno.candidatesByColumn[h.column as InternalColumn].push(h);
          }
        }
        const resolution = resolveInternalChain(hits);
        report.movInterno.resolutionLog = resolution.log;
        report.movInterno.resolvedDetTable = resolution.detTable;
        report.movInterno.resolvedCabTable = resolution.cabTable;

        // ── 5. Probes das tabelas resolvidas ──
        console.log("▶ 5/9  Schemas + samples das tabelas resolvidas + motivos full dump ...");
        if (resolution.detTable) {
          report.movInterno.detTableProbe = await probeTableFull(pool, resolution.detTable.schema, resolution.detTable.name, 5);
        } else {
          warnings.push("Detail table (MovStocksDetID owner) não resolvida — sub-classificação por motivo impossível.");
        }
        if (resolution.cabTable) {
          report.movInterno.cabTableProbe = await probeTableFull(pool, resolution.cabTable.schema, resolution.cabTable.name, 5);
        } else {
          warnings.push("Cab table (MovStocksCabID owner) não resolvida — sub-classificação por motivo impossível.");
        }

        const motivosCount = await getRowCount(pool, "dbo", "tblMovStocksCab_Motivo");
        report.movInterno.motivosFullRowCount = motivosCount;
        report.movInterno.motivosFull = await dumpFullTable(pool, "dbo", "tblMovStocksCab_Motivo", 1000);

        // ── 6 + 7. Volumetria + Samples (apenas se cadeia resolvida) ──
        if (resolution.detTable && resolution.cabTable && fks.movStocksDetId) {
          console.log("▶ 6/9  Volumetria por motivo (JOIN tabelas resolvidas) ...");
          report.movInterno.volumetriaPorMotivo = await getVolumetriaPorMotivo(
            pool, resolution.detTable, resolution.cabTable, fks.movStocksDetId, dateCol, args.months,
          );
          console.log("▶ 7/9  Amostras por motivo ...");
          report.movInterno.samplesPorMotivo = await getSamplesPorMotivo(
            pool, resolution.detTable, resolution.cabTable, fks.movStocksDetId, dateCol, args.months, args.samples,
          );
          if (report.movInterno.volumetriaPorMotivo.length === 0) {
            warnings.push("Cadeia resolvida mas volumetria por motivo voltou vazia — JOIN pode estar incorrecto, ou simplesmente não há movimentos internos no período.");
          }
        } else {
          warnings.push("Cadeia interna não totalmente resolvida — volumetria/samples por motivo saltadas.");
        }

        // ── 8. Tipo Documento lookup ──
        console.log("▶ 8/9  Discovery do lookup [Tipo Documento] ...");
        report.tipoDocumentoLookup = await findTipoDocumentoLookup(pool);
        if (!report.tipoDocumentoLookup.tableName) {
          warnings.push(`Lookup [Tipo Documento] não encontrado: ${report.tipoDocumentoLookup.triedNames.join(", ")}`);
        }

        // ── 9. Correlação 7 dias ──
        console.log("▶ 9/9  Correlação 7 dias ...");
        try {
          report.correlation = await getCorrelation(pool, dateCol);
        } catch (e) {
          warnings.push(`Correlação 7d falhou: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ── Related tables (sempre, mesmo se StocksMov falhar) ──
      console.log("▶ Bonus  Tabelas relacionadas (sys.tables LIKE patterns) ...");
      const candidates = await findRelatedTables(pool);
      for (const c of candidates) {
        try {
          report.relatedTables.push(await dumpRelatedTable(pool, c.schema, c.name, c.matchedPattern));
        } catch (e) {
          warnings.push(`Falha a inspeccionar ${c.schema}.${c.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ── Output ──
      const md = renderMarkdown(report);
      const mdPath = path.join(outDir, `movimentos-audit-${ts}.md`);
      const jsonPath = path.join(outDir, `movimentos-audit-${ts}.json`);
      writeFileSync(mdPath, md, "utf8");
      writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

      console.log("");
      console.log(RULE);
      console.log("✓ Relatório gerado:");
      console.log(`  Markdown: ${mdPath}`);
      console.log(`  JSON    : ${jsonPath}`);
      console.log(RULE);
      console.log(`  StocksMov: ${report.stocksMov.exists ? `${report.stocksMov.rowCount.toLocaleString("pt-PT")} rows · ${report.stocksMov.fkColumnsDetected.length}/6 FKs detectadas` : "✗ NÃO EXISTE"}`);
      console.log(`  Origens distintas: ${report.volumetriaPorOrigem.length}`);
      console.log(`  Detail table resolvida: ${report.movInterno.resolvedDetTable ? `${report.movInterno.resolvedDetTable.schema}.${report.movInterno.resolvedDetTable.name}` : "✗"}`);
      console.log(`  Cab table resolvida   : ${report.movInterno.resolvedCabTable ? `${report.movInterno.resolvedCabTable.schema}.${report.movInterno.resolvedCabTable.name}` : "✗"}`);
      console.log(`  Motivos no lookup: ${report.movInterno.motivosFullRowCount}`);
      console.log(`  Motivos com movimentos (24m): ${report.movInterno.volumetriaPorMotivo.length}`);
      console.log(`  Lookup [Tipo Documento]: ${report.tipoDocumentoLookup.tableName ?? "✗ não encontrado"}`);
      console.log(`  Tabelas relacionadas: ${report.relatedTables.length}`);
      console.log(`  Correlação 7d: ${report.correlation.length} dias`);
      console.log(`  Warnings: ${warnings.length}`);
      if (warnings.length > 0) for (const w of warnings) console.log(`    ⚠ ${w}`);
      console.log("");
      console.log("Próximo passo: envia ambos os ficheiros (.md e .json) para análise.");
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha:", err instanceof Error ? err.message : String(err));
    return 1;
  }
}
