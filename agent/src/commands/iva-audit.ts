/**
 * agent/src/commands/iva-audit.ts
 *
 * Auditoria ÚNICA read-only do universo fiscal no ERP SPharm/Softreis.
 * Mesmo padrão do `movimentos-audit`: identifica a tabela mestre canónica
 * do IVA sem qualquer SQL manual do operador.
 *
 * Conceitos chave:
 *   · `dbo.Stocks.[Taxa IVA]` guarda CÓDIGOS internos do ERP (ex.: 1, 5, 6, 8).
 *     Estes códigos NÃO são percentagens. A taxa real (6 / 13 / 23 / 0)
 *     vive numa tabela mestre cujo nome varia por instalação Softreis.
 *
 *   · A tabela mestre identifica-se por 4 evidências cumulativas:
 *       1. FK declarada de `Stocks.[Taxa IVA]` para a master (sinal forte)
 *       2. Domínio da PK cobre {1, 5, 6, 8} (códigos observados)
 *       3. Existência de coluna com a percentagem (taxa/valor)
 *       4. Dimensão pequena (<50 rows) — tabela master fiscal típica
 *
 * Output:
 *   ./run/iva-audit-<timestamp>.md
 *   ./run/iva-audit-<timestamp>.json
 *
 * Cobertura completa num único run (~30s contra ERP local):
 *   1. Stocks.[Taxa IVA] — descoberta da coluna + distribuição de códigos
 *   2. Tabelas candidatas (LIKE %IVA% / %Taxa% / %Imposto% / %Fiscal% /
 *      Tbl_Tipo_%): schema completo, PK, FKs, row count, TOP samples
 *   3. FKs declaradas (a partir de Stocks E para Stocks)
 *   4. Domain match: colunas em qualquer tabela cujo domínio cobre
 *      {1, 5, 6, 8} (descoberta indutiva da master)
 *   5. Candidatos a mestre — ranking por score multi-evidência
 *   6. Proposta automática de JOIN com SQL pronto a colar
 *
 * NÃO comunica com SaaS. NÃO escreve em ERP. NÃO requer SSMS.
 *
 * Uso:
 *   agent iva-audit                # default: codigos observados via descoberta
 *   agent iva-audit --out-dir .\run
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { tableExists, listColumns, type ColumnMeta } from "./probe-helpers.js";

const RULE = "═".repeat(72);
const DEFAULT_SAMPLES = 10;

// Patterns LIKE para sys.tables. SoftReis varia entre instalações, daí
// não tentamos um único nome — apanhamos qualquer candidato e o scoring
// ordena por evidência.
const TABLE_NAME_PATTERNS = [
  "%IVA%",
  "%Iva%",
  "%iva%",
  "%Taxa%",
  "%taxa%",
  "%Imposto%",
  "%imposto%",
  "%Fiscal%",
  "%fiscal%",
  "Tbl_Tipo_%",   // padrão SoftReis para masters (ver Tbl_Tipo_Fornecedores)
  "Tbl_IVA%",
  "Tbl_Taxa%",
];

// ── Types ────────────────────────────────────────────────────────────

type SampleRow = Record<string, unknown>;

type IndexInfo = { name: string; columns: string[]; isUnique: boolean };
type FkInfo = {
  name: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
};

type TableProbe = {
  schema: string;
  name: string;
  matchedPattern: string;
  exists: boolean;
  rowCount: number;
  columns: ColumnMeta[];
  primaryKey: string[];
  indexes: IndexInfo[];
  /** FKs declaradas onde esta tabela é o pai (parent). */
  outgoingFks: FkInfo[];
  /** FKs declaradas onde esta tabela é referenciada. */
  incomingFks: FkInfo[];
  sample: SampleRow[];
};

type StocksTaxaIvaInfo = {
  columnName: string | null;
  dataType: string | null;
  distribution: Array<{ codigo: number | null; n: number }>;
  totalRows: number;
};

type DomainMatchHit = {
  schema: string;
  table: string;
  column: string;
  dataType: string;
  rowCount: number;
  /** Quantos dos códigos observados (1,5,6,8) existem nesta coluna. */
  matchedCodes: number[];
  /** Sample 10 valores distintos com count. */
  topValues: Array<{ value: unknown; n: number }>;
};

type MasterCandidate = {
  schema: string;
  table: string;
  matchedPattern: string;
  rowCount: number;
  primaryKey: string[];
  columns: ColumnMeta[];
  /** Coluna que parece conter a percentagem (Taxa/Percentagem/Valor/etc.). */
  rateColumnGuess: string | null;
  /** Coluna que parece ser PK fiscal (PK simples + nome ID-like). */
  codeColumnGuess: string | null;
  /** Score 0..100 — quanto maior, mais provável ser a master. */
  score: number;
  scoreBreakdown: {
    fkFromStocks: number;       // 40 pts se há FK declarada
    domainMatch: number;        // 30 pts se domínio cobre todos os códigos observados
    rateColumn: number;         // 15 pts se tem coluna de taxa numérica
    smallTable: number;         // 10 pts se rowCount < 50
    namePattern: number;        // 5 pts se nome bate Tbl_Tipo_% ou contém IVA
  };
  reasoning: string[];
};

type JoinProposal = {
  master: { schema: string; table: string };
  joinFromColumn: string;
  joinToColumn: string;
  rateColumn: string | null;
  /** SQL completo pronto a executar (validação visual no ERP). */
  validationSql: string;
};

type IvaAuditReport = {
  meta: {
    timestamp: string;
    agentRev: string;
    auditVersion: 1;
    erp: { host: string; port: number; database: string };
    paramsSamples: number;
  };
  stocksTaxaIva: StocksTaxaIvaInfo;
  candidateTables: TableProbe[];
  fksFromStocks: FkInfo[];
  fksToStocks: FkInfo[];
  domainMatches: DomainMatchHit[];
  masterCandidates: MasterCandidate[];
  topProposal: JoinProposal | null;
  warnings: string[];
};

// ── CLI args ─────────────────────────────────────────────────────────

type Args = { samples: number; outDir: string; help: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      samples: { type: "string" },
      "out-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const samples = raw.values.samples ? Number(raw.values.samples) : DEFAULT_SAMPLES;
  return {
    samples: Number.isFinite(samples) && samples > 0 ? samples : DEFAULT_SAMPLES,
    outDir: typeof raw.values["out-dir"] === "string" ? raw.values["out-dir"] : "./run",
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: iva-audit [--samples N] [--out-dir <dir>]");
  console.log("");
  console.log("Auditoria ÚNICA read-only do universo fiscal do ERP.");
  console.log("Identifica a tabela mestre canónica do IVA sem qualquer SQL manual:");
  console.log("  · descobre todas as tabelas candidatas (%IVA% / %Taxa% / %Imposto%);");
  console.log("  · lê FKs declaradas;");
  console.log("  · procura colunas com domínio que cobre os códigos observados;");
  console.log("  · ordena candidatos por score multi-evidência;");
  console.log("  · propõe SQL de JOIN.");
  console.log("");
  console.log("Output: ./run/iva-audit-<timestamp>.{md,json}");
}

// ── Generic helpers ──────────────────────────────────────────────────

async function getRowCount(pool: SqlPool, schema: string, table: string): Promise<number> {
  const r = await pool.request()
    .input("s", sql.NVarChar, schema)
    .input("t", sql.NVarChar, table)
    .query<{ n: number }>(`
      SELECT SUM(p.rows) n FROM sys.partitions p
      JOIN sys.tables t ON p.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name=@s AND t.name=@t AND p.index_id IN (0,1)
    `);
  return Number(r.recordset[0]?.n ?? 0);
}

async function getPrimaryKey(pool: SqlPool, schema: string, table: string): Promise<string[]> {
  const r = await pool.request()
    .input("s", sql.NVarChar, schema)
    .input("t", sql.NVarChar, table)
    .query<{ col: string }>(`
      SELECT c.name col FROM sys.indexes i
      JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id
      JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
      JOIN sys.tables t ON i.object_id=t.object_id
      JOIN sys.schemas s ON t.schema_id=s.schema_id
      WHERE s.name=@s AND t.name=@t AND i.is_primary_key=1
      ORDER BY ic.key_ordinal
    `);
  return r.recordset.map((x) => x.col);
}

async function getIndexes(pool: SqlPool, schema: string, table: string): Promise<IndexInfo[]> {
  const r = await pool.request()
    .input("s", sql.NVarChar, schema)
    .input("t", sql.NVarChar, table)
    .query<{ name: string; col: string; is_unique: boolean }>(`
      SELECT i.name, c.name col, i.is_unique
      FROM sys.indexes i
      JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id
      JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
      JOIN sys.tables t ON i.object_id=t.object_id
      JOIN sys.schemas s ON t.schema_id=s.schema_id
      WHERE s.name=@s AND t.name=@t AND i.is_primary_key=0 AND ic.is_included_column=0
      ORDER BY i.name, ic.key_ordinal
    `);
  const m = new Map<string, IndexInfo>();
  for (const row of r.recordset) {
    if (!m.has(row.name)) m.set(row.name, { name: row.name, columns: [], isUnique: !!row.is_unique });
    m.get(row.name)!.columns.push(row.col);
  }
  return Array.from(m.values());
}

async function getOutgoingFks(pool: SqlPool, schema: string, table: string): Promise<FkInfo[]> {
  const r = await pool.request()
    .input("s", sql.NVarChar, schema)
    .input("t", sql.NVarChar, table)
    .query<{ name: string; from_col: string; to_table: string; to_col: string }>(`
      SELECT
        fk.name                          AS name,
        pc.name                          AS from_col,
        OBJECT_NAME(fk.referenced_object_id) AS to_table,
        rc.name                          AS to_col
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
      JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
      WHERE ps.name = @s AND pt.name = @t
      ORDER BY fk.name, fkc.constraint_column_id
    `);
  const m = new Map<string, FkInfo>();
  for (const row of r.recordset) {
    if (!m.has(row.name)) {
      m.set(row.name, {
        name: row.name,
        fromTable: `${schema}.${table}`,
        fromColumns: [],
        toTable: row.to_table,
        toColumns: [],
      });
    }
    const fk = m.get(row.name)!;
    fk.fromColumns.push(row.from_col);
    fk.toColumns.push(row.to_col);
  }
  return Array.from(m.values());
}

async function getIncomingFks(pool: SqlPool, schema: string, table: string): Promise<FkInfo[]> {
  const r = await pool.request()
    .input("s", sql.NVarChar, schema)
    .input("t", sql.NVarChar, table)
    .query<{ name: string; from_table: string; from_col: string; to_col: string }>(`
      SELECT
        fk.name                          AS name,
        OBJECT_NAME(fk.parent_object_id) AS from_table,
        pc.name                          AS from_col,
        rc.name                          AS to_col
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
      JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
      WHERE rs.name = @s AND rt.name = @t
      ORDER BY fk.name, fkc.constraint_column_id
    `);
  const m = new Map<string, FkInfo>();
  for (const row of r.recordset) {
    if (!m.has(row.name)) {
      m.set(row.name, {
        name: row.name,
        fromTable: row.from_table,
        fromColumns: [],
        toTable: `${schema}.${table}`,
        toColumns: [],
      });
    }
    const fk = m.get(row.name)!;
    fk.fromColumns.push(row.from_col);
    fk.toColumns.push(row.to_col);
  }
  return Array.from(m.values());
}

async function getSample(pool: SqlPool, schema: string, table: string, n: number): Promise<SampleRow[]> {
  try {
    const r = await pool.request().query<SampleRow>(
      `SELECT TOP ${n} * FROM [${schema}].[${table}]`,
    );
    return r.recordset;
  } catch {
    return [];
  }
}

// ── Discovery: tabelas candidatas ────────────────────────────────────

async function findCandidateTables(pool: SqlPool): Promise<Array<{ schema: string; name: string; matchedPattern: string }>> {
  const out: Array<{ schema: string; name: string; matchedPattern: string }> = [];
  const seen = new Set<string>();
  for (const pat of TABLE_NAME_PATTERNS) {
    const r = await pool.request().input("p", sql.NVarChar, pat).query<{
      schema_: string;
      name_: string;
    }>(`
      SELECT s.name AS schema_, t.name AS name_
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = 'dbo' AND t.name LIKE @p
      ORDER BY t.name
    `);
    for (const row of r.recordset) {
      const key = `${row.schema_}.${row.name_}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ schema: row.schema_, name: row.name_, matchedPattern: pat });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function probeCandidate(
  pool: SqlPool,
  c: { schema: string; name: string; matchedPattern: string },
  sampleSize: number,
): Promise<TableProbe> {
  const exists = await tableExists(pool, { schema: c.schema, table: c.name });
  if (!exists) {
    return {
      schema: c.schema, name: c.name, matchedPattern: c.matchedPattern,
      exists: false, rowCount: 0, columns: [], primaryKey: [], indexes: [],
      outgoingFks: [], incomingFks: [], sample: [],
    };
  }
  const [columns, rowCount, primaryKey, indexes, outgoingFks, incomingFks, sample] = await Promise.all([
    listColumns(pool, { schema: c.schema, table: c.name }),
    getRowCount(pool, c.schema, c.name),
    getPrimaryKey(pool, c.schema, c.name),
    getIndexes(pool, c.schema, c.name),
    getOutgoingFks(pool, c.schema, c.name),
    getIncomingFks(pool, c.schema, c.name),
    getSample(pool, c.schema, c.name, sampleSize),
  ]);
  return {
    schema: c.schema, name: c.name, matchedPattern: c.matchedPattern,
    exists: true, rowCount, columns, primaryKey, indexes,
    outgoingFks, incomingFks, sample,
  };
}

// ── Stocks.[Taxa IVA] — coluna + distribuição ────────────────────────

async function inspectStocksTaxaIva(pool: SqlPool): Promise<StocksTaxaIvaInfo> {
  // Descobrir o nome real da coluna (pode ter espaço, _, etc.)
  const colsR = await pool.request().query<{ column_: string; type_: string }>(`
    SELECT c.name AS column_, ty.name AS type_
    FROM sys.columns c
    JOIN sys.tables t  ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.types ty  ON c.user_type_id = ty.user_type_id
    WHERE s.name = 'dbo' AND t.name = 'Stocks' AND c.name LIKE '%iva%'
    ORDER BY c.column_id
  `);
  // Heurística: nome com 'taxa' tem prioridade; senão o primeiro com 'iva'.
  const taxaCol = colsR.recordset.find((c) => /taxa/i.test(c.column_));
  const ivaCol = taxaCol ?? colsR.recordset[0];
  if (!ivaCol) {
    return { columnName: null, dataType: null, distribution: [], totalRows: 0 };
  }
  const distR = await pool.request().query<{ codigo: number | null; n: number }>(`
    SELECT [${ivaCol.column_}] AS codigo, COUNT(*) AS n
    FROM [dbo].[Stocks]
    WHERE [Retirado] = 0 AND [Processa_Stocks] <> 0
    GROUP BY [${ivaCol.column_}]
    ORDER BY COUNT(*) DESC
  `);
  const totalR = await pool.request().query<{ n: number }>(`
    SELECT COUNT(*) AS n FROM [dbo].[Stocks]
    WHERE [Retirado] = 0 AND [Processa_Stocks] <> 0
  `);
  return {
    columnName: ivaCol.column_,
    dataType: ivaCol.type_,
    distribution: distR.recordset,
    totalRows: Number(totalR.recordset[0]?.n ?? 0),
  };
}

// ── Domain matching: encontrar colunas que cobrem os códigos ─────────

/**
 * Para cada tabela candidata, procura colunas numéricas cujo domínio
 * contém os códigos observados. Descobre a master mesmo sem FK declarada.
 *
 * Limita a tabelas com ≤500 rows (caso típico de master fiscal) para
 * não fazer scan a tabelas transaccionais grandes.
 */
async function findDomainMatches(
  pool: SqlPool,
  candidateTables: TableProbe[],
  observedCodes: number[],
  sampleTopN: number,
): Promise<DomainMatchHit[]> {
  if (observedCodes.length === 0) return [];
  const hits: DomainMatchHit[] = [];

  for (const tbl of candidateTables) {
    if (!tbl.exists) continue;
    if (tbl.rowCount > 500) continue; // master fiscal é sempre pequena

    // Colunas numéricas elegíveis
    const numericCols = tbl.columns.filter((c) =>
      /^(?:tinyint|smallint|int|bigint|decimal|numeric|float|real)$/i.test(c.dataType)
    );

    for (const c of numericCols) {
      try {
        // Quais dos códigos observados existem nesta coluna?
        const codesCsv = observedCodes.join(",");
        const r = await pool.request().query<{ v: number; n: number }>(`
          SELECT [${c.name}] AS v, COUNT(*) AS n
          FROM [${tbl.schema}].[${tbl.name}]
          WHERE [${c.name}] IN (${codesCsv})
          GROUP BY [${c.name}]
        `);
        const matched = r.recordset.map((x) => Number(x.v));
        if (matched.length === 0) continue;

        // TOP 10 valores distintos da coluna (para contexto humano)
        const topR = await pool.request().query<{ v: unknown; n: number }>(`
          SELECT TOP ${sampleTopN} [${c.name}] AS v, COUNT(*) AS n
          FROM [${tbl.schema}].[${tbl.name}]
          GROUP BY [${c.name}]
          ORDER BY COUNT(*) DESC
        `);

        hits.push({
          schema: tbl.schema,
          table: tbl.name,
          column: c.name,
          dataType: c.dataType,
          rowCount: tbl.rowCount,
          matchedCodes: matched,
          topValues: topR.recordset.map((row) => ({ value: row.v, n: Number(row.n) })),
        });
      } catch {
        // Coluna pode ter tipo exótico — ignorar
      }
    }
  }

  // Ordenar: mais códigos matched primeiro; depois tabelas mais pequenas
  return hits.sort((a, b) => {
    if (b.matchedCodes.length !== a.matchedCodes.length) {
      return b.matchedCodes.length - a.matchedCodes.length;
    }
    return a.rowCount - b.rowCount;
  });
}

// ── Scoring de candidatos a tabela mestre ────────────────────────────

function scoreCandidates(
  candidateTables: TableProbe[],
  fksFromStocks: FkInfo[],
  domainMatches: DomainMatchHit[],
  observedCodes: number[],
  stocksTaxaIvaColumn: string | null,
): MasterCandidate[] {
  const candidates: MasterCandidate[] = [];

  // Set de tabelas referenciadas por Stocks.[Taxa IVA] (FK forte)
  const fkTargets = new Set<string>();
  for (const fk of fksFromStocks) {
    if (stocksTaxaIvaColumn === null) continue;
    if (fk.fromColumns.includes(stocksTaxaIvaColumn)) {
      fkTargets.add(fk.toTable);
    }
  }

  // Map: tabela → domain matches
  const domainByTable = new Map<string, DomainMatchHit[]>();
  for (const dm of domainMatches) {
    const key = `${dm.schema}.${dm.table}`;
    if (!domainByTable.has(key)) domainByTable.set(key, []);
    domainByTable.get(key)!.push(dm);
  }

  for (const tbl of candidateTables) {
    if (!tbl.exists) continue;
    if (tbl.rowCount > 500) continue;

    const reasoning: string[] = [];
    let score = 0;
    const breakdown = {
      fkFromStocks: 0,
      domainMatch: 0,
      rateColumn: 0,
      smallTable: 0,
      namePattern: 0,
    };

    // 1) FK declarada de Stocks para esta tabela
    if (fkTargets.has(tbl.name)) {
      breakdown.fkFromStocks = 40;
      reasoning.push(`FK declarada em Stocks aponta para esta tabela (sinal mais forte)`);
    }

    // 2) Domain match — coluna desta tabela contém códigos observados
    const dms = domainByTable.get(`${tbl.schema}.${tbl.name}`) ?? [];
    const bestDm = dms.sort((a, b) => b.matchedCodes.length - a.matchedCodes.length)[0];
    let codeColumnGuess: string | null = null;
    if (bestDm) {
      const coverage = bestDm.matchedCodes.length / observedCodes.length;
      breakdown.domainMatch = Math.round(30 * coverage);
      reasoning.push(
        `Coluna [${bestDm.column}] cobre ${bestDm.matchedCodes.length}/${observedCodes.length} dos códigos observados (${bestDm.matchedCodes.join(",")})`,
      );
      codeColumnGuess = bestDm.column;
    }

    // PK simples também é hint para code column
    if (codeColumnGuess === null && tbl.primaryKey.length === 1) {
      codeColumnGuess = tbl.primaryKey[0];
      reasoning.push(`PK simples [${codeColumnGuess}] usada como joinTo na ausência de domain match`);
    }

    // 3) Coluna que parece ser a taxa real (Taxa/Percentagem/Valor/etc.)
    const rateColumnGuess = findRateColumn(tbl.columns);
    if (rateColumnGuess) {
      breakdown.rateColumn = 15;
      reasoning.push(`Coluna [${rateColumnGuess}] candidata a guardar a percentagem real`);
    }

    // 4) Tabela pequena
    if (tbl.rowCount > 0 && tbl.rowCount < 50) {
      breakdown.smallTable = 10;
      reasoning.push(`Dimensão pequena (${tbl.rowCount} rows) — coerente com master fiscal`);
    }

    // 5) Nome bate padrão SoftReis
    if (/^Tbl_Tipo_/i.test(tbl.name) || /IVA/i.test(tbl.name)) {
      breakdown.namePattern = 5;
      reasoning.push(`Nome bate convenção SoftReis (Tbl_Tipo_* ou contém "IVA")`);
    }

    score = breakdown.fkFromStocks + breakdown.domainMatch + breakdown.rateColumn
          + breakdown.smallTable + breakdown.namePattern;

    if (score === 0) continue; // sem evidência mínima, não vale listar

    candidates.push({
      schema: tbl.schema,
      table: tbl.name,
      matchedPattern: tbl.matchedPattern,
      rowCount: tbl.rowCount,
      primaryKey: tbl.primaryKey,
      columns: tbl.columns,
      rateColumnGuess,
      codeColumnGuess,
      score,
      scoreBreakdown: breakdown,
      reasoning,
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Tenta identificar a coluna da master que guarda a taxa em
 * percentagem. Ordem de preferência: Taxa > Percentagem > Valor > Iva.
 * Tipo numérico exigido (decimal/numeric/float/real/int).
 */
function findRateColumn(cols: ColumnMeta[]): string | null {
  const numeric = cols.filter((c) =>
    /^(?:decimal|numeric|float|real|tinyint|smallint|int)$/i.test(c.dataType),
  );
  const patterns: RegExp[] = [
    /^taxa$/i,
    /^percent/i,
    /^perc[_ ]?iva$/i,
    /^iva$/i,
    /^valor$/i,
    /^taxa[_ ]?iva$/i,
  ];
  for (const re of patterns) {
    const m = numeric.find((c) => re.test(c.name));
    if (m) return m.name;
  }
  // Fallback: qualquer numeric não-PK com domínio plausível (6/13/23 nos
  // samples) — análise estática sem queries adicionais. Conservador:
  // só devolvemos com prefix match.
  return null;
}

// ── Proposta de JOIN ─────────────────────────────────────────────────

function buildJoinProposal(
  top: MasterCandidate | undefined,
  stocksTaxaIvaColumn: string | null,
): JoinProposal | null {
  if (!top) return null;
  if (!stocksTaxaIvaColumn) return null;
  if (!top.codeColumnGuess) return null;

  const masterTable = `[${top.schema}].[${top.table}]`;
  const rateCol = top.rateColumnGuess;
  const rateSelect = rateCol ? `m.[${rateCol}]` : `CAST(NULL AS DECIMAL)`;

  const validationSql = [
    `-- iva-audit: proposta automática de JOIN`,
    `-- master:    ${masterTable}`,
    `-- joinFrom:  Stocks.[${stocksTaxaIvaColumn}]`,
    `-- joinTo:    ${top.table}.[${top.codeColumnGuess}]`,
    `-- rateCol:   ${rateCol ?? "(não detectada)"}`,
    ``,
    `-- 1. Conteúdo da master (mapeamento bruto)`,
    `SELECT * FROM ${masterTable} ORDER BY [${top.codeColumnGuess}];`,
    ``,
    `-- 2. Validação do JOIN com Stocks (TOP 50)`,
    `SELECT TOP 50`,
    `  s.[CodigoID],`,
    `  s.[Codigo]            AS cnp,`,
    `  s.[Nome Comercial]    AS designacao,`,
    `  s.[${stocksTaxaIvaColumn}] AS taxa_iva_codigo,`,
    `  ${rateSelect}         AS taxa_real`,
    `FROM [dbo].[Stocks] s`,
    `LEFT JOIN ${masterTable} m`,
    `  ON m.[${top.codeColumnGuess}] = s.[${stocksTaxaIvaColumn}]`,
    `WHERE s.[Retirado] = 0 AND s.[Processa_Stocks] <> 0`,
    `ORDER BY s.[Codigo];`,
    ``,
    `-- 3. Cobertura — todos os códigos mapeiam?`,
    `SELECT`,
    `  s.[${stocksTaxaIvaColumn}] AS codigo_erp,`,
    `  ${rateSelect}              AS taxa_real,`,
    `  COUNT(*)                   AS n_produtos`,
    `FROM [dbo].[Stocks] s`,
    `LEFT JOIN ${masterTable} m`,
    `  ON m.[${top.codeColumnGuess}] = s.[${stocksTaxaIvaColumn}]`,
    `WHERE s.[Retirado] = 0`,
    `GROUP BY s.[${stocksTaxaIvaColumn}], ${rateSelect}`,
    `ORDER BY n_produtos DESC;`,
  ].join("\n");

  return {
    master: { schema: top.schema, table: top.table },
    joinFromColumn: stocksTaxaIvaColumn,
    joinToColumn: top.codeColumnGuess,
    rateColumn: rateCol,
    validationSql,
  };
}

// ── Markdown render ──────────────────────────────────────────────────

function fmtSample(rows: SampleRow[]): string {
  if (rows.length === 0) return "_(vazio)_";
  return "```\n" + JSON.stringify(rows, null, 2) + "\n```";
}

function renderMarkdown(r: IvaAuditReport): string {
  const lines: string[] = [];
  lines.push(`# iva-audit — relatório`);
  lines.push("");
  lines.push(`- timestamp: \`${r.meta.timestamp}\``);
  lines.push(`- agent rev: \`${r.meta.agentRev}\``);
  lines.push(`- erp: \`${r.meta.erp.host}:${r.meta.erp.port}/${r.meta.erp.database}\``);
  lines.push("");
  lines.push("---");
  lines.push("");

  // 1. Stocks.[Taxa IVA]
  lines.push("## 1. dbo.Stocks — coluna de IVA");
  lines.push("");
  if (r.stocksTaxaIva.columnName) {
    lines.push(`- coluna: **\`[${r.stocksTaxaIva.columnName}]\`**  (\`${r.stocksTaxaIva.dataType}\`)`);
    lines.push(`- total produtos (Retirado=0 AND Processa_Stocks<>0): **${r.stocksTaxaIva.totalRows.toLocaleString("pt-PT")}**`);
    lines.push("");
    lines.push(`| código | n produtos |`);
    lines.push(`|---:|---:|`);
    for (const d of r.stocksTaxaIva.distribution) {
      lines.push(`| ${d.codigo ?? "(null)"} | ${d.n.toLocaleString("pt-PT")} |`);
    }
  } else {
    lines.push("✗ **Nenhuma coluna com 'iva' no nome encontrada em dbo.Stocks.**");
  }
  lines.push("");

  // 2. Candidate tables
  lines.push(`## 2. Tabelas candidatas (LIKE %IVA% / %Taxa% / %Imposto% / %Fiscal% / Tbl_Tipo_%)`);
  lines.push("");
  lines.push(`Encontradas: **${r.candidateTables.length}**`);
  lines.push("");
  for (const t of r.candidateTables) {
    lines.push(`### \`${t.schema}.${t.name}\``);
    lines.push("");
    if (!t.exists) {
      lines.push(`- ✗ não existe (anomalia)`);
      lines.push("");
      continue;
    }
    lines.push(`- pattern match: \`${t.matchedPattern}\``);
    lines.push(`- row count: **${t.rowCount.toLocaleString("pt-PT")}**`);
    lines.push(`- PK: ${t.primaryKey.length > 0 ? "`" + t.primaryKey.join(", ") + "`" : "_(sem PK declarada)_"}`);
    lines.push(`- colunas (${t.columns.length}):`);
    for (const c of t.columns) {
      const nullStr = c.nullable ? "NULL" : "NOT NULL";
      lines.push(`    - \`[${c.name}]\` ${c.dataType} ${nullStr}`);
    }
    if (t.outgoingFks.length > 0) {
      lines.push(`- FKs **outgoing** (esta tabela → outras):`);
      for (const fk of t.outgoingFks) {
        lines.push(`    - \`${fk.name}\`: \`${fk.fromColumns.join(",")}\` → \`${fk.toTable}.${fk.toColumns.join(",")}\``);
      }
    }
    if (t.incomingFks.length > 0) {
      lines.push(`- FKs **incoming** (outras → esta tabela):`);
      for (const fk of t.incomingFks) {
        lines.push(`    - \`${fk.name}\`: \`${fk.fromTable}.${fk.fromColumns.join(",")}\` → \`${fk.toColumns.join(",")}\``);
      }
    }
    lines.push(`- sample (TOP ${t.sample.length}):`);
    lines.push(fmtSample(t.sample));
    lines.push("");
  }

  // 3. FKs Stocks
  lines.push(`## 3. Foreign Keys envolvendo dbo.Stocks`);
  lines.push("");
  lines.push(`### FKs **a partir** de Stocks (Stocks → outras tabelas):`);
  if (r.fksFromStocks.length === 0) {
    lines.push("_(nenhuma declarada — SoftReis frequentemente não declara FKs)_");
  } else {
    for (const fk of r.fksFromStocks) {
      lines.push(`- \`${fk.name}\`: \`Stocks.${fk.fromColumns.join(",")}\` → \`${fk.toTable}.${fk.toColumns.join(",")}\``);
    }
  }
  lines.push("");
  lines.push(`### FKs **para** Stocks (outras tabelas → Stocks):`);
  if (r.fksToStocks.length === 0) {
    lines.push("_(nenhuma declarada)_");
  } else {
    for (const fk of r.fksToStocks) {
      lines.push(`- \`${fk.name}\`: \`${fk.fromTable}.${fk.fromColumns.join(",")}\` → \`Stocks.${fk.toColumns.join(",")}\``);
    }
  }
  lines.push("");

  // 4. Domain matches
  lines.push(`## 4. Domain match — colunas que contêm os códigos observados`);
  lines.push("");
  lines.push(`Procura indutiva: para cada tabela candidata com ≤500 rows, varre colunas numéricas e regista quais contêm valores dos códigos vistos em Stocks.[Taxa IVA].`);
  lines.push("");
  if (r.domainMatches.length === 0) {
    lines.push("_(nenhuma coluna candidata cobre os códigos)_");
  } else {
    lines.push(`| tabela | coluna | type | rows | códigos matched | top 5 valores |`);
    lines.push(`|---|---|---|---:|---|---|`);
    for (const dm of r.domainMatches.slice(0, 20)) {
      const top = dm.topValues.slice(0, 5).map((v) => `${v.value}×${v.n}`).join(", ");
      lines.push(`| \`${dm.schema}.${dm.table}\` | \`[${dm.column}]\` | ${dm.dataType} | ${dm.rowCount} | ${dm.matchedCodes.join(",")} | ${top} |`);
    }
  }
  lines.push("");

  // 5. Candidatos a tabela mestre
  lines.push(`## 5. Candidatos a tabela mestre de IVA`);
  lines.push("");
  if (r.masterCandidates.length === 0) {
    lines.push("✗ **Nenhum candidato com evidência mínima.** A master de IVA pode estar fora dos patterns auditados (sugerir alargar `TABLE_NAME_PATTERNS` em `iva-audit.ts`).");
  } else {
    for (const c of r.masterCandidates) {
      lines.push(`### \`${c.schema}.${c.table}\` — score **${c.score}/100**`);
      lines.push("");
      lines.push(`- pattern: \`${c.matchedPattern}\``);
      lines.push(`- rows: ${c.rowCount}`);
      lines.push(`- PK: ${c.primaryKey.length > 0 ? "`[" + c.primaryKey.join(",") + "]`" : "_(sem PK)_"}`);
      lines.push(`- coluna código (joinTo): ${c.codeColumnGuess ? "`[" + c.codeColumnGuess + "]`" : "_(não identificada)_"}`);
      lines.push(`- coluna taxa (rate):    ${c.rateColumnGuess ? "`[" + c.rateColumnGuess + "]`" : "_(não identificada)_"}`);
      lines.push(`- breakdown:`);
      lines.push(`    - FK from Stocks: \`+${c.scoreBreakdown.fkFromStocks}\``);
      lines.push(`    - Domain match:   \`+${c.scoreBreakdown.domainMatch}\``);
      lines.push(`    - Rate column:    \`+${c.scoreBreakdown.rateColumn}\``);
      lines.push(`    - Small table:    \`+${c.scoreBreakdown.smallTable}\``);
      lines.push(`    - Name pattern:   \`+${c.scoreBreakdown.namePattern}\``);
      lines.push(`- raciocínio:`);
      for (const reason of c.reasoning) lines.push(`    - ${reason}`);
      lines.push("");
    }
  }

  // 6. Proposta automática
  lines.push(`## 6. Proposta automática de JOIN`);
  lines.push("");
  if (!r.topProposal) {
    lines.push("✗ **Sem proposta** — top candidate insuficiente. Reportar este audit completo + dump da BD para análise manual.");
  } else {
    const p = r.topProposal;
    lines.push(`- master:    \`${p.master.schema}.${p.master.table}\``);
    lines.push(`- joinFrom:  \`Stocks.[${p.joinFromColumn}]\``);
    lines.push(`- joinTo:    \`${p.master.table}.[${p.joinToColumn}]\``);
    lines.push(`- rateColumn: ${p.rateColumn ? "`[" + p.rateColumn + "]`" : "_(não detectada — JOIN funciona mas a taxa precisa de coluna manual)_"}`);
    lines.push("");
    lines.push(`### SQL de validação (copy-paste para SSMS)`);
    lines.push("");
    lines.push("```sql");
    lines.push(p.validationSql);
    lines.push("```");
  }
  lines.push("");

  if (r.warnings.length > 0) {
    lines.push(`## Warnings`);
    lines.push("");
    for (const w of r.warnings) lines.push(`- ⚠ ${w}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────

export async function ivaAudit(): Promise<number> {
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

  const cfg = loadConfig("sql");
  const warnings: string[] = [];

  return await withPool(cfg, async (pool) => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = path.resolve(args.outDir);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const report: IvaAuditReport = {
      meta: {
        timestamp: new Date().toISOString(),
        agentRev: process.env.AGENT_REV ?? "(unknown)",
        auditVersion: 1,
        erp: { host: cfg.sqlHost, port: cfg.sqlPort, database: cfg.sqlDatabase },
        paramsSamples: args.samples,
      },
      stocksTaxaIva: { columnName: null, dataType: null, distribution: [], totalRows: 0 },
      candidateTables: [],
      fksFromStocks: [],
      fksToStocks: [],
      domainMatches: [],
      masterCandidates: [],
      topProposal: null,
      warnings,
    };

    console.log("");
    console.log(RULE);
    console.log("  iva-audit  —  diagnóstico fiscal do ERP SPharm/Softreis");
    console.log(RULE);
    console.log("");

    // 1. Stocks.[Taxa IVA]
    console.log("▶ 1/5  dbo.Stocks — coluna de IVA + distribuição de códigos ...");
    try {
      report.stocksTaxaIva = await inspectStocksTaxaIva(pool);
      if (report.stocksTaxaIva.columnName) {
        console.log(`       coluna detectada: [${report.stocksTaxaIva.columnName}] (${report.stocksTaxaIva.dataType})`);
        console.log(`       códigos: ${report.stocksTaxaIva.distribution.length} distintos sobre ${report.stocksTaxaIva.totalRows} produtos`);
      } else {
        warnings.push("dbo.Stocks não tem coluna com 'iva' no nome.");
      }
    } catch (e) {
      warnings.push(`Inspect Stocks falhou: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. Candidate tables
    console.log("▶ 2/5  Procura tabelas candidatas (%IVA% / %Taxa% / %Imposto% / %Fiscal% / Tbl_Tipo_%) ...");
    const cands = await findCandidateTables(pool);
    console.log(`       encontradas: ${cands.length}`);
    for (const c of cands) {
      try {
        const probe = await probeCandidate(pool, c, args.samples);
        report.candidateTables.push(probe);
        console.log(`       · ${c.schema}.${c.name} (${probe.rowCount} rows, ${probe.columns.length} cols)`);
      } catch (e) {
        warnings.push(`Probe falhou em ${c.schema}.${c.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 3. FKs Stocks
    console.log("▶ 3/5  FKs envolvendo dbo.Stocks ...");
    try {
      report.fksFromStocks = await getOutgoingFks(pool, "dbo", "Stocks");
      report.fksToStocks = await getIncomingFks(pool, "dbo", "Stocks");
      console.log(`       outgoing: ${report.fksFromStocks.length} · incoming: ${report.fksToStocks.length}`);
    } catch (e) {
      warnings.push(`FK lookup falhou: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 4. Domain matching
    console.log("▶ 4/5  Domain matching — varrer colunas candidatas pelos códigos observados ...");
    const observedCodes = report.stocksTaxaIva.distribution
      .map((d) => d.codigo)
      .filter((v): v is number => typeof v === "number");
    if (observedCodes.length === 0) {
      warnings.push("Sem códigos observados em Stocks.[Taxa IVA] — domain match impossível.");
    } else {
      try {
        report.domainMatches = await findDomainMatches(pool, report.candidateTables, observedCodes, args.samples);
        console.log(`       hits: ${report.domainMatches.length}`);
      } catch (e) {
        warnings.push(`Domain match falhou: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 5. Scoring + proposta
    console.log("▶ 5/5  Scoring de candidatos + proposta de JOIN ...");
    report.masterCandidates = scoreCandidates(
      report.candidateTables,
      report.fksFromStocks,
      report.domainMatches,
      observedCodes,
      report.stocksTaxaIva.columnName,
    );
    report.topProposal = buildJoinProposal(
      report.masterCandidates[0],
      report.stocksTaxaIva.columnName,
    );
    console.log(`       candidatos: ${report.masterCandidates.length}`);
    if (report.topProposal) {
      console.log(`       proposta top: ${report.topProposal.master.schema}.${report.topProposal.master.table}`);
    } else {
      console.log(`       proposta top: ✗ sem candidato válido`);
    }

    // Output
    const md = renderMarkdown(report);
    const mdPath = path.join(outDir, `iva-audit-${ts}.md`);
    const jsonPath = path.join(outDir, `iva-audit-${ts}.json`);
    writeFileSync(mdPath, md, "utf8");
    writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

    console.log("");
    console.log(RULE);
    console.log("✓ Relatório gerado:");
    console.log(`  Markdown: ${mdPath}`);
    console.log(`  JSON    : ${jsonPath}`);
    console.log(RULE);
    console.log(`  Stocks.[Taxa IVA]   : ${report.stocksTaxaIva.columnName ? `[${report.stocksTaxaIva.columnName}] · ${report.stocksTaxaIva.distribution.length} códigos · ${report.stocksTaxaIva.totalRows.toLocaleString("pt-PT")} produtos` : "✗ não encontrada"}`);
    console.log(`  Tabelas candidatas  : ${report.candidateTables.length}`);
    console.log(`  FKs outgoing Stocks : ${report.fksFromStocks.length}`);
    console.log(`  FKs incoming Stocks : ${report.fksToStocks.length}`);
    console.log(`  Domain hits         : ${report.domainMatches.length}`);
    console.log(`  Candidatos a mestre : ${report.masterCandidates.length}`);
    if (report.masterCandidates.length > 0) {
      const top = report.masterCandidates[0];
      console.log(`  Top candidate       : ${top.schema}.${top.table} · score ${top.score}/100`);
    }
    console.log(`  Warnings            : ${warnings.length}`);
    if (warnings.length > 0) for (const w of warnings) console.log(`    ⚠ ${w}`);
    console.log("");

    return 0;
  });
}
