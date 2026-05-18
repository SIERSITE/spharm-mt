/**
 * agent/src/commands/probe-helpers.ts
 *
 * Helpers partilhados pelas probes operacionais `discover-products`,
 * `discover-stock`, `discover-sales`. Vivem em
 * `docs/spharm-erp-canonical-mapping.md` § 4–5.
 *
 * Invariantes:
 *   · Read-only puro — apenas `sys.*` + `SELECT TOP N` em tabela alvo.
 *   · Compatibilidade SQL Server 2008 R2 — sem `OFFSET/FETCH`,
 *     `TRY_CAST`, `IIF`, `STRING_AGG`, etc.
 *   · Identificadores de schema/tabela validados via regex antes de
 *     entrarem na query (mssql não parametriza identifiers).
 *   · Sem escrita em disco. Saída é toda em stdout.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import sql from "mssql";
import type { SqlPool } from "../sql-client.js";

// ─────────────────────────────────────────────────────────────────────
// Identifier validation (schema.table sem injecção)
// ─────────────────────────────────────────────────────────────────────

/**
 * Limita os caracteres aceitáveis num identificador SQL. Softreis usa
 * nomes com espaço (`Atendimento Detalhe`), por isso o regex tolera-os
 * — válidos como delimited identifier `[Atendimento Detalhe]`. Não
 * cobre o universo SQL Server (que permite `]` escapado via `]]`, etc.)
 * — só aceita o subconjunto trivialmente seguro de interpolar dentro
 * de brackets. `[` e `]` ficam de fora explicitamente para evitar
 * escape de bracket.
 */
const IDENT_RE = /^[A-Za-z0-9_ ]{1,128}$/;

export type ParsedTableArg = { schema: string; table: string };

export function isValidIdentifier(s: string): boolean {
  return IDENT_RE.test(s);
}

export function parseTableArg(input: string): ParsedTableArg {
  const parts = input.split(".");
  if (parts.length !== 2) {
    throw new Error(
      `--table deve ter o formato "<schema>.<tabela>" (recebido: ${input}). ` +
        `Para nomes com espaço usa aspas: --table "dbo.Atendimento Detalhe".`
    );
  }
  const [schema, table] = parts as [string, string];
  if (!isValidIdentifier(schema) || !isValidIdentifier(table)) {
    throw new Error(
      `--table "${input}" contém caracteres não-permitidos. ` +
        `Aceites: A-Z a-z 0-9 _ espaço (max 128 cada). ` +
        `Brackets [ ] não são permitidos no input — interpolação envolve-os automaticamente.`
    );
  }
  return { schema, table };
}

export type CandidateRow = {
  schema: string;
  table: string;
  fullName: string;
  rowCount: number | null;
};

/**
 * Lê o JSON gerado por `discover` e devolve a lista completa de
 * candidatos ranked (já ordenada por row count desc do lado do discover)
 * para a categoria pedida. Devolve `[]` se o ficheiro não existir ou
 * a categoria estiver vazia.
 *
 * Inclui row count quando o `tables[]` correspondente existir, para o
 * operador conseguir distinguir master (poucas linhas, mestre típico)
 * de tabela de movimentos (muitas linhas) em vez de assumir que
 * `[0]` é o mestre. A heurística do discover acerta umas vezes e
 * outras não — daí esta lista ser informativa, não autoritativa.
 */
export function listDiscoveryCandidates(
  category: "produtos" | "stocks" | "vendas" | "linhas" | "documentos" | "fornecedores" | "farmacias",
  outputDir: string
): CandidateRow[] {
  const jsonPath = path.join(outputDir, "spharm-sqlserver-discovery.json");
  if (!fs.existsSync(jsonPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    return [];
  }
  const obj = parsed as
    | {
        candidates?: Record<string, string[]>;
        tables?: Array<{ fullName: string; rowCountEstimate: number }>;
      }
    | null;
  const list = obj?.candidates?.[category];
  if (!Array.isArray(list) || list.length === 0) return [];
  const rowCountByFull = new Map<string, number>();
  for (const t of obj?.tables ?? []) {
    if (typeof t?.fullName === "string" && typeof t?.rowCountEstimate === "number") {
      rowCountByFull.set(t.fullName, t.rowCountEstimate);
    }
  }
  const out: CandidateRow[] = [];
  for (const full of list) {
    if (typeof full !== "string" || !full.includes(".")) continue;
    const [schema, table] = full.split(".");
    if (!schema || !table) continue;
    if (!isValidIdentifier(schema) || !isValidIdentifier(table)) continue;
    out.push({
      schema,
      table,
      fullName: full,
      rowCount: rowCountByFull.get(full) ?? null,
    });
  }
  return out;
}

/**
 * Formata uma row count para output legível (1234 → 1.2k, 1234567 → 1.2M).
 */
export function fmtRowCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Imprime a lista de candidatos como hint quando o operador não passou
 * `--table`. Devolve a lista (para que o caller possa decidir se erro
 * é "sem candidatos" vs "ambíguo"). Não auto-escolhe nenhum.
 */
export function printCandidateHint(
  category: "produtos" | "stocks" | "vendas" | "linhas" | "documentos" | "fornecedores" | "farmacias",
  outputDir: string
): CandidateRow[] {
  const list = listDiscoveryCandidates(category, outputDir);
  if (list.length === 0) {
    console.error(`Sem candidatos para categoria "${category}" no discover.json em ${outputDir}.`);
    console.error(`Corre primeiro \`run-discover.bat\` ou passa --table <schema>.<tabela>.`);
    return list;
  }
  console.error(`Candidatos detectados para "${category}" (ranked por row count, do discover.json):`);
  for (const c of list.slice(0, 12)) {
    console.error(`  · ${c.fullName.padEnd(40)} ~${fmtRowCount(c.rowCount)} rows`);
  }
  if (list.length > 12) console.error(`  (+${list.length - 12} mais — ver discover.md)`);
  console.error("");
  console.error(`A heurística do discover é só um hint — usa --table explicitamente:`);
  console.error(`  --table "<schema>.<tabela>"  (aspas obrigatórias se o nome tiver espaços)`);
  return list;
}

// ─────────────────────────────────────────────────────────────────────
// Metadata leve sobre a tabela alvo (sem scan)
// ─────────────────────────────────────────────────────────────────────

export type ColumnMeta = {
  name: string;
  dataType: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
};

/**
 * Confirma que `<schema>.<table>` existe como user-table. Falha-rápido
 * com mensagem accionável se não. Atira *antes* de qualquer query
 * data-side — garante que a interpolação `[${schema}].[${table}]` é
 * sobre algo que o SQL Server confirmou existir.
 */
/**
 * Variante non-throwing de `assertTableExists`. Útil para schema
 * detection condicional (ex: daily-sync verificar se `dbo.StocksMov`
 * existe antes de gerar SQL que o referencia).
 */
export async function tableExists(pool: SqlPool, t: ParsedTableArg): Promise<boolean> {
  const r = await pool
    .request()
    .input("s", sql.NVarChar, t.schema)
    .input("t", sql.NVarChar, t.table)
    .query<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt
      FROM sys.tables tt
      JOIN sys.schemas ss ON tt.schema_id = ss.schema_id
      WHERE ss.name = @s AND tt.name = @t AND tt.is_ms_shipped = 0
    `);
  return Number(r.recordset[0]?.cnt ?? 0) > 0;
}

export async function assertTableExists(pool: SqlPool, t: ParsedTableArg): Promise<void> {
  const r = await pool
    .request()
    .input("s", sql.NVarChar, t.schema)
    .input("t", sql.NVarChar, t.table)
    .query<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt
      FROM sys.tables tt
      JOIN sys.schemas ss ON tt.schema_id = ss.schema_id
      WHERE ss.name = @s AND tt.name = @t AND tt.is_ms_shipped = 0
    `);
  const cnt = Number(r.recordset[0]?.cnt ?? 0);
  if (cnt === 0) {
    throw new Error(
      `Tabela "${t.schema}.${t.table}" não existe (ou não é user-table). ` +
        `Corre \`npm run discover\` e verifica a secção Candidatos do output.`
    );
  }
}

export async function listColumns(pool: SqlPool, t: ParsedTableArg): Promise<ColumnMeta[]> {
  const r = await pool
    .request()
    .input("s", sql.NVarChar, t.schema)
    .input("t", sql.NVarChar, t.table)
    .query<{
      name: string;
      dataType: string;
      max_length: number;
      precision: number;
      scale: number;
      is_nullable: boolean;
    }>(`
      SELECT
        c.name AS name,
        ty.name AS dataType,
        c.max_length,
        c.precision,
        c.scale,
        c.is_nullable
      FROM sys.columns c
      JOIN sys.tables tt ON c.object_id = tt.object_id
      JOIN sys.schemas ss ON tt.schema_id = ss.schema_id
      JOIN sys.types ty ON c.user_type_id = ty.user_type_id
      WHERE ss.name = @s AND tt.name = @t
      ORDER BY c.column_id
    `);
  return r.recordset.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    maxLength: c.max_length,
    precision: c.precision,
    scale: c.scale,
    nullable: !!c.is_nullable,
  }));
}

/**
 * Estimativa por `sys.partitions` (heap ou clustered). Sem `COUNT(*)`
 * — evita scan completo em tabelas grandes.
 */
export async function estimateRowCount(pool: SqlPool, t: ParsedTableArg): Promise<number> {
  const r = await pool
    .request()
    .input("s", sql.NVarChar, t.schema)
    .input("t", sql.NVarChar, t.table)
    .query<{ rows: number }>(`
      SELECT SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS rows
      FROM sys.partitions p
      JOIN sys.tables tt ON p.object_id = tt.object_id
      JOIN sys.schemas ss ON tt.schema_id = ss.schema_id
      WHERE ss.name = @s AND tt.name = @t
    `);
  return Number(r.recordset[0]?.rows ?? 0);
}

/**
 * Devolve as colunas que compõem a primary key, ordenadas pela
 * posição no key (`key_ordinal`). Lista vazia se a tabela não tem PK.
 */
export async function listPrimaryKey(pool: SqlPool, t: ParsedTableArg): Promise<string[]> {
  const r = await pool
    .request()
    .input("s", sql.NVarChar, t.schema)
    .input("t", sql.NVarChar, t.table)
    .query<{ column_name: string }>(`
      SELECT c.name AS column_name
      FROM sys.indexes i
      JOIN sys.tables tt ON i.object_id = tt.object_id
      JOIN sys.schemas ss ON tt.schema_id = ss.schema_id
      JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE i.is_primary_key = 1
        AND ss.name = @s AND tt.name = @t
      ORDER BY ic.key_ordinal
    `);
  return r.recordset.map((row) => row.column_name);
}

export type ForeignKeyEdge = {
  name: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
};

/**
 * Devolve FKs declaradas que SAEM desta tabela (esta → outras).
 */
export async function listForeignKeysOut(pool: SqlPool, t: ParsedTableArg): Promise<ForeignKeyEdge[]> {
  const r = await pool
    .request()
    .input("s", sql.NVarChar, t.schema)
    .input("t", sql.NVarChar, t.table)
    .query<{
      fk_name: string;
      from_schema: string;
      from_table: string;
      from_column: string;
      to_schema: string;
      to_table: string;
      to_column: string;
      ord: number;
    }>(`
      SELECT
        fk.name AS fk_name,
        fs.name AS from_schema, ft.name AS from_table, fc.name AS from_column,
        rs.name AS to_schema, rt.name AS to_table, rc.name AS to_column,
        fkc.constraint_column_id AS ord
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      JOIN sys.tables ft ON fk.parent_object_id = ft.object_id
      JOIN sys.schemas fs ON ft.schema_id = fs.schema_id
      JOIN sys.columns fc ON fkc.parent_object_id = fc.object_id AND fkc.parent_column_id = fc.column_id
      JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
      JOIN sys.schemas rs ON rt.schema_id = rs.schema_id
      JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
      WHERE fs.name = @s AND ft.name = @t
      ORDER BY fk.name, fkc.constraint_column_id
    `);
  return aggregateFkRows(r.recordset);
}

/**
 * Devolve FKs declaradas que ENTRAM nesta tabela (outras → esta).
 * Útil para confirmar "quem referencia este master".
 */
export async function listForeignKeysIn(pool: SqlPool, t: ParsedTableArg): Promise<ForeignKeyEdge[]> {
  const r = await pool
    .request()
    .input("s", sql.NVarChar, t.schema)
    .input("t", sql.NVarChar, t.table)
    .query<{
      fk_name: string;
      from_schema: string;
      from_table: string;
      from_column: string;
      to_schema: string;
      to_table: string;
      to_column: string;
      ord: number;
    }>(`
      SELECT
        fk.name AS fk_name,
        fs.name AS from_schema, ft.name AS from_table, fc.name AS from_column,
        rs.name AS to_schema, rt.name AS to_table, rc.name AS to_column,
        fkc.constraint_column_id AS ord
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      JOIN sys.tables ft ON fk.parent_object_id = ft.object_id
      JOIN sys.schemas fs ON ft.schema_id = fs.schema_id
      JOIN sys.columns fc ON fkc.parent_object_id = fc.object_id AND fkc.parent_column_id = fc.column_id
      JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
      JOIN sys.schemas rs ON rt.schema_id = rs.schema_id
      JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
      WHERE rs.name = @s AND rt.name = @t
      ORDER BY fk.name, fkc.constraint_column_id
    `);
  return aggregateFkRows(r.recordset);
}

function aggregateFkRows(
  rows: Array<{
    fk_name: string;
    from_schema: string;
    from_table: string;
    from_column: string;
    to_schema: string;
    to_table: string;
    to_column: string;
    ord: number;
  }>
): ForeignKeyEdge[] {
  const agg = new Map<string, ForeignKeyEdge>();
  for (const r of rows) {
    let edge = agg.get(r.fk_name);
    if (!edge) {
      edge = {
        name: r.fk_name,
        fromTable: `${r.from_schema}.${r.from_table}`,
        fromColumns: [],
        toTable: `${r.to_schema}.${r.to_table}`,
        toColumns: [],
      };
      agg.set(r.fk_name, edge);
    }
    edge.fromColumns.push(r.from_column);
    edge.toColumns.push(r.to_column);
  }
  return Array.from(agg.values());
}

export type IndexEdge = {
  name: string;
  isUnique: boolean;
  type: string;
  columns: string[];
};

/**
 * Lista índices não-PK da tabela. Útil para inferir candidatos a
 * unique (e.g. CodigoID com unique não-PK).
 */
export async function listIndexes(pool: SqlPool, t: ParsedTableArg): Promise<IndexEdge[]> {
  const r = await pool
    .request()
    .input("s", sql.NVarChar, t.schema)
    .input("t", sql.NVarChar, t.table)
    .query<{
      index_name: string;
      is_unique: boolean;
      type_desc: string;
      column_name: string;
      key_ordinal: number;
    }>(`
      SELECT
        i.name AS index_name,
        i.is_unique,
        i.type_desc,
        c.name AS column_name,
        ic.key_ordinal
      FROM sys.indexes i
      JOIN sys.tables tt ON i.object_id = tt.object_id
      JOIN sys.schemas ss ON tt.schema_id = ss.schema_id
      JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE i.is_primary_key = 0
        AND i.type > 0
        AND ss.name = @s AND tt.name = @t
      ORDER BY i.name, ic.key_ordinal
    `);
  const agg = new Map<string, IndexEdge>();
  for (const row of r.recordset) {
    let info = agg.get(row.index_name);
    if (!info) {
      info = {
        name: row.index_name,
        isUnique: !!row.is_unique,
        type: row.type_desc,
        columns: [],
      };
      agg.set(row.index_name, info);
    }
    info.columns.push(row.column_name);
  }
  return Array.from(agg.values());
}

/**
 * Tipos de coluna SQL Server que tipicamente representam data/timestamp.
 */
const DATE_TYPES = new Set(["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset"]);

/**
 * Devolve as colunas-data da tabela (no máximo `limit`, ordem original).
 */
export function pickDateColumns(cols: ColumnMeta[], limit = 3): ColumnMeta[] {
  return cols.filter((c) => DATE_TYPES.has(c.dataType.toLowerCase())).slice(0, limit);
}

export type DateRange = { column: string; min: string | null; max: string | null };

/**
 * MIN/MAX para uma lista de colunas-data. Cada coluna gera uma query
 * separada — fácil de raciocinar, mas O(n) requests. Limit antes
 * para não dilatar.
 */
export async function probeDateRanges(
  pool: SqlPool,
  t: ParsedTableArg,
  dateCols: ColumnMeta[]
): Promise<DateRange[]> {
  const out: DateRange[] = [];
  for (const col of dateCols) {
    const r = await pool
      .request()
      .query<{ mn: Date | null; mx: Date | null }>(
        `SELECT MIN([${col.name}]) AS mn, MAX([${col.name}]) AS mx FROM [${t.schema}].[${t.table}]`
      );
    const row = r.recordset[0];
    out.push({
      column: col.name,
      min: row?.mn ? row.mn.toISOString() : null,
      max: row?.mx ? row.mx.toISOString() : null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Heurística de classificação coluna → campo canónico
// ─────────────────────────────────────────────────────────────────────

export type TypeFamily = "int" | "decimal" | "string" | "date" | "bool";

const TYPE_FAMILY: Record<string, TypeFamily> = {
  bigint: "int",
  int: "int",
  smallint: "int",
  tinyint: "int",
  decimal: "decimal",
  numeric: "decimal",
  money: "decimal",
  smallmoney: "decimal",
  float: "decimal",
  real: "decimal",
  varchar: "string",
  nvarchar: "string",
  char: "string",
  nchar: "string",
  text: "string",
  ntext: "string",
  date: "date",
  datetime: "date",
  datetime2: "date",
  smalldatetime: "date",
  datetimeoffset: "date",
  bit: "bool",
};

export function typeFamily(dataType: string): TypeFamily | null {
  return TYPE_FAMILY[dataType.toLowerCase()] ?? null;
}

export type FieldHint = {
  /** Nome do campo canónico SPharm.MT (output legível). */
  field: string;
  /** Substrings (lowercase) que casam no nome da coluna ERP. */
  needles: string[];
  /** Famílias de tipo aceitáveis. Vazio = aceita qualquer. */
  expect?: TypeFamily[];
};

export type ClassifiedField = {
  field: string;
  match: ColumnMeta | null;
};

export function classifyColumns(cols: ColumnMeta[], hints: FieldHint[]): ClassifiedField[] {
  return hints.map((h) => {
    let best: ColumnMeta | null = null;
    for (const c of cols) {
      const lower = c.name.toLowerCase();
      const nameOK = h.needles.some((n) => lower.includes(n));
      if (!nameOK) continue;
      if (h.expect && h.expect.length > 0) {
        const fam = typeFamily(c.dataType);
        if (fam === null || !h.expect.includes(fam)) continue;
      }
      best = c;
      break; // primeiro match — needles devem estar por especificidade
    }
    return { field: h.field, match: best };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Renderização stdout (sem dependências externas)
// ─────────────────────────────────────────────────────────────────────

export function renderColumnType(c: ColumnMeta): string {
  const t = c.dataType.toLowerCase();
  if (["varchar", "nvarchar", "char", "nchar", "varbinary", "binary"].includes(t)) {
    const len =
      c.maxLength === -1
        ? "max"
        : t.startsWith("n")
        ? Math.floor((c.maxLength ?? 0) / 2)
        : c.maxLength;
    return `${c.dataType}(${len})`;
  }
  if (["decimal", "numeric"].includes(t)) {
    return `${c.dataType}(${c.precision},${c.scale})`;
  }
  return c.dataType;
}

export function formatCell(v: unknown, maxLen = 60): string {
  if (v === null || v === undefined) return "·";
  if (v instanceof Date) return v.toISOString().slice(0, 19) + "Z";
  if (typeof v === "object") {
    if (Buffer.isBuffer(v)) return `<bin ${v.length}b>`;
    return JSON.stringify(v).slice(0, maxLen);
  }
  let s = String(v);
  s = s.replace(/\s+/g, " ");
  if (s.length > maxLen) s = s.slice(0, maxLen - 3) + "...";
  return s;
}

/**
 * Render TOP-N em formato vertical (mais legível em tabelas com
 * 30+ colunas que side-by-side com headers).
 */
export function renderSampleVertical(rows: unknown[], columns: ColumnMeta[]): string {
  if (rows.length === 0) return "  (sem linhas)";
  const lines: string[] = [];
  const colWidth = Math.min(
    32,
    Math.max(...columns.map((c) => c.name.length))
  );
  for (const [i, row] of rows.entries()) {
    lines.push(`  ─── linha ${i + 1} ───`);
    const r = row as Record<string, unknown>;
    for (const c of columns) {
      const v = formatCell(r[c.name]);
      lines.push(`    ${c.name.padEnd(colWidth)}  ${v}`);
    }
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// Helpers para previews operacionais (products-preview / stock-preview
// / sales-preview) — combinam qualifying colunas conhecidas + resolução
// heurística do resto.
// ─────────────────────────────────────────────────────────────────────

/**
 * Envolve um nome de coluna em brackets para interpolação segura em
 * SQL. Rejeita nomes com `[` ou `]` — `sys.columns` não devolve nomes
 * com brackets em Softreis, mas defensivo na mesma.
 */
export function quoteIdent(name: string): string {
  if (name.includes("[") || name.includes("]")) {
    throw new Error(`Identifier inseguro (contém [ ou ]): ${name}`);
  }
  return `[${name}]`;
}

/**
 * Verifica que cada nome em `required` existe em `cols` (case-sensitive
 * por defeito porque os nomes vêm de `sys.columns` no mesmo collation
 * que o resto da query). Atira `Error` com lista completa de faltantes
 * — diagnose claro de mapping desactualizado.
 */
export function assertColumnsExist(
  cols: ColumnMeta[],
  required: string[],
  tableLabel: string
): void {
  const have = new Set(cols.map((c) => c.name));
  const missing = required.filter((r) => !have.has(r));
  if (missing.length > 0) {
    throw new Error(
      `Tabela ${tableLabel} não tem colunas esperadas: ${missing.join(", ")}. ` +
        `Mapping em docs/spharm-erp-canonical-mapping.md precisa de actualização.`
    );
  }
}

/**
 * Devolve o nome da PRIMEIRA coluna que satisfaz `hints[i]` (na ordem),
 * ou `null` se nenhuma match. Wrapper fino sobre `classifyColumns` para
 * o caso em que só queres o nome (e.g. construção de SELECT).
 */
export function pickColumnByHints(cols: ColumnMeta[], hint: FieldHint): ColumnMeta | null {
  const [c] = classifyColumns(cols, [hint]);
  return c?.match ?? null;
}

/**
 * Item para o SELECT-list de um preview. `expr` é uma expressão SQL
 * pronta a interpolar (e.g. `s.[CodigoID]` ou `f.[Nome]`); `alias` é o
 * nome amigável que vai aparecer na coluna do output.
 */
export type SelectItem = {
  alias: string;
  expr: string;
  /** Coluna ERP que originou o item, para logging no header. Null para itens fixos sem fonte (e.g. expressões compostas). */
  sourceColumn: string | null;
  /** Tabela ERP de origem (label livre, e.g. "Stocks"). */
  sourceTable: string;
};

/**
 * Renderer horizontal para previews. Não tenta encaixar 100% no
 * terminal — cells truncadas a `maxCellWidth` (default 24) para
 * limitar a explosão de comprimento mas mantendo legibilidade.
 */
export function renderSampleHorizontal(
  rows: unknown[],
  aliases: string[],
  options?: { maxCellWidth?: number }
): string {
  if (rows.length === 0) return "  (sem linhas)";
  const maxW = options?.maxCellWidth ?? 24;
  const widths: Record<string, number> = {};
  for (const a of aliases) {
    let w = a.length;
    for (const r of rows) {
      const v = formatCell((r as Record<string, unknown>)[a], maxW);
      if (v.length > w) w = v.length;
    }
    widths[a] = Math.min(w, maxW);
  }
  const sep = "  ";
  const lines: string[] = [];
  lines.push(aliases.map((a) => a.padEnd(widths[a]!)).join(sep));
  lines.push(aliases.map((a) => "-".repeat(widths[a]!)).join(sep));
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    lines.push(aliases.map((a) => formatCell(row[a], maxW).padEnd(widths[a]!)).join(sep));
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// Argumento data — validação ISO simples (sem `Date.parse` leniente)
// ─────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateArg(name: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!DATE_RE.test(value)) {
    throw new Error(`${name} deve ser YYYY-MM-DD (recebido: ${value}).`);
  }
  // Validação extra: Date.parse não rejeita "2026-02-30". Reconstrói e compara.
  const [y, m, d] = value.split("-").map((p) => parseInt(p, 10));
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() + 1 !== m ||
    dt.getUTCDate() !== d
  ) {
    throw new Error(`${name}: data ${value} é inválida (dia inexistente?).`);
  }
  return value;
}
