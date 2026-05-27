/**
 * agent/src/commands/movimentos-audit.ts
 *
 * Auditoria ÚNICA do universo de movimentos no ERP SPharm/Softreis.
 * Read-only. Produz UM relatório (markdown + JSON) para o operador enviar
 * de volta. Substitui a sequência de 6 probes manuais que estavam a ser
 * pedidas — corre tudo num único comando, ~30s contra o ERP local.
 *
 * Output:
 *   ./run/movimentos-audit-<timestamp>.md
 *   ./run/movimentos-audit-<timestamp>.json
 *
 * Cobertura:
 *   1. Schema completo de dbo.StocksMov + detecção heurística da coluna
 *      "TipoMov" (varia entre instalações Softreis).
 *   2. Volumetria 24m por TipoMov.
 *   3. TOP 10 amostras vertical por tipo.
 *   4. Discovery de tabelas relacionadas (inventário/ajuste/quebra/
 *      perda/transferência/regularização/anulação) via sys.tables.
 *   5. Para cada candidata: schema + row count + 3 sample rows.
 *   6. Lookups: [Tipo Documento] completo + qualquer tabela TipoMov*
 *      encontrada.
 *   7. Correlação 7 dias: StocksMov × Atendimento × Recepcao × Devolucao
 *      por dia. Identifica dias onde StocksMov >> outros (= ajustes/
 *      inventários puros sem documento).
 *
 * Não escreve no ERP. Não comunica com o SaaS. 100% local + ficheiro.
 *
 * Uso:
 *   agent movimentos-audit                         # default 24m, 10 samples
 *   agent movimentos-audit --months 12 --samples 5 # override
 *   agent movimentos-audit --out-dir C:\temp       # output dir custom
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
const DEFAULT_SAMPLES = 10;

// ── Types ────────────────────────────────────────────────────────────

type SampleRow = Record<string, unknown>;

type RelatedTable = {
  name: string;
  schema: string;
  rowCount: number;
  columns: ColumnMeta[];
  sample: SampleRow[];
  matchedPattern: string;
};

type AuditReport = {
  meta: {
    timestamp: string;
    agentRev: string;
    erp: { host: string; port: number; database: string };
    paramsMonths: number;
    paramsSamples: number;
  };
  stocksMov: {
    exists: boolean;
    rowCountEstimate: number;
    columns: ColumnMeta[];
    primaryKey: string[];
    indexes: Array<{ name: string; columns: string[]; isUnique: boolean }>;
    dateRangeAll: { column: string; min: string | null; max: string | null } | null;
    tipoColumnDetected: string | null;
    tipoColumnScore: number;
    tipoColumnAllCandidates: Array<{ name: string; score: number }>;
  };
  volumetria: Array<{
    tipo: string | number | null;
    rows: number;
    produtosDistintos: number;
    qtSum: number;
    qtPositiveLines: number;
    qtNegativeLines: number;
    dataMin: string | null;
    dataMax: string | null;
  }>;
  samples: Array<{ tipo: string; rows: SampleRow[] }>;
  relatedTables: RelatedTable[];
  lookups: {
    tipoDocumento: SampleRow[];
    tipoMovLookups: Array<{ table: string; rows: SampleRow[] }>;
  };
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
  console.log("Produz um relatório único (.md + .json) com o universo de movimentos do ERP.");
  console.log("Read-only. Não toca em SaaS. Cobre StocksMov + tabelas relacionadas + lookups.");
  console.log("");
  console.log("Flags:");
  console.log("  --months <N>    janela de volumetria em meses (default 24)");
  console.log("  --samples <N>   TOP N amostras por tipo (default 10)");
  console.log("  --out-dir <d>   pasta de output (default ./run)");
}

// ── Heurística de detecção da coluna TipoMov ─────────────────────────

function scoreTipoColumn(name: string): number {
  const n = name.toLowerCase();
  if (n === "tipomov" || n === "tipo_mov" || n === "tipomovimento" || n === "tipo_movimento") return 100;
  if (n === "tipomovid" || n === "tipo_movimento_id" || n === "tipomovimentoid") return 95;
  if (n.startsWith("tipomov") || n.startsWith("tipo_mov") || n.startsWith("tipomovimento")) return 80;
  if (n === "tipo") return 70;
  if (/^tipo[_ ]?doc/.test(n)) return 60;  // pode ser ambíguo com Atendimento.TipoDoc
  if (n.includes("tipo") && (n.includes("mov") || n.includes("operac"))) return 55;
  if (n.includes("tipo")) return 30;
  return 0;
}

function detectTipoColumn(cols: ColumnMeta[]): {
  detected: string | null;
  score: number;
  all: Array<{ name: string; score: number }>;
} {
  const scored = cols.map((c) => ({ name: c.name, score: scoreTipoColumn(c.name) }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return {
    detected: best && best.score >= 50 ? best.name : null,
    score: best?.score ?? 0,
    all: scored.filter((s) => s.score > 0),
  };
}

// ── Date column detection ────────────────────────────────────────────

function pickDateColumn(cols: ColumnMeta[]): string | null {
  const dateLike = cols.filter((c) => /datetime|^date$/i.test(c.dataType));
  if (dateLike.length === 0) return null;
  const named = dateLike.find((c) => /datamov|data[_ ]?mov|data[_ ]?op/i.test(c.name));
  return (named ?? dateLike[0]).name;
}

// ── Helpers SQL ──────────────────────────────────────────────────────

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
  const row = r.recordset[0];
  return {
    min: row?.min_date instanceof Date ? row.min_date.toISOString() : null,
    max: row?.max_date instanceof Date ? row.max_date.toISOString() : null,
  };
}

async function getVolumetria(
  pool: SqlPool,
  schema: string,
  table: string,
  tipoCol: string,
  dateCol: string,
  qtyCol: string | null,
  prodCol: string | null,
  months: number,
): Promise<AuditReport["volumetria"]> {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const qtyExpr = qtyCol ? `SUM(ABS([${qtyCol}]))` : "0";
  const prodExpr = prodCol ? `COUNT(DISTINCT [${prodCol}])` : "0";
  const qtyPos = qtyCol ? `SUM(CASE WHEN [${qtyCol}] > 0 THEN 1 ELSE 0 END)` : "0";
  const qtyNeg = qtyCol ? `SUM(CASE WHEN [${qtyCol}] < 0 THEN 1 ELSE 0 END)` : "0";
  const r = await pool.request().input("d", sql.DateTime, since).query<{
    tipo: string | number | null;
    n: number;
    prods: number;
    qt: number;
    pos: number;
    neg: number;
    minD: Date | null;
    maxD: Date | null;
  }>(`
    SELECT [${tipoCol}] tipo,
           COUNT_BIG(*) n,
           ${prodExpr} prods,
           ${qtyExpr} qt,
           ${qtyPos} pos,
           ${qtyNeg} neg,
           MIN([${dateCol}]) minD,
           MAX([${dateCol}]) maxD
    FROM [${schema}].[${table}]
    WHERE [${dateCol}] >= @d
    GROUP BY [${tipoCol}]
    ORDER BY 2 DESC`);
  return r.recordset.map((row) => ({
    tipo: row.tipo,
    rows: Number(row.n),
    produtosDistintos: Number(row.prods),
    qtSum: Number(row.qt ?? 0),
    qtPositiveLines: Number(row.pos),
    qtNegativeLines: Number(row.neg),
    dataMin: row.minD instanceof Date ? row.minD.toISOString() : null,
    dataMax: row.maxD instanceof Date ? row.maxD.toISOString() : null,
  }));
}

async function getSamplesPerTipo(
  pool: SqlPool,
  schema: string,
  table: string,
  tipoCol: string,
  dateCol: string,
  tipos: Array<string | number | null>,
  samplesPerTipo: number,
): Promise<AuditReport["samples"]> {
  const out: AuditReport["samples"] = [];
  for (const tipo of tipos) {
    if (tipo === null) continue;
    const req = pool.request().input("t", typeof tipo === "number" ? sql.Int : sql.NVarChar, tipo).input("n", sql.Int, samplesPerTipo);
    const r = await req.query<SampleRow>(`
      SELECT TOP (@n) * FROM [${schema}].[${table}]
      WHERE [${tipoCol}] = @t
      ORDER BY [${dateCol}] DESC`);
    out.push({ tipo: String(tipo), rows: r.recordset });
  }
  return out;
}

// ── Tabelas relacionadas ─────────────────────────────────────────────

const RELATED_PATTERNS: Array<{ pattern: string; label: string }> = [
  { pattern: "%nventar%", label: "inventário" },
  { pattern: "%egulariz%", label: "regularização" },
  { pattern: "%uebra%", label: "quebra" },
  { pattern: "%erda%", label: "perda" },
  { pattern: "%ransfer%", label: "transferência" },
  { pattern: "%juste%", label: "ajuste" },
  { pattern: "%nulac%", label: "anulação" },
  { pattern: "%TipoMov%", label: "lookup tipoMov" },
  { pattern: "%Tipo_Mov%", label: "lookup tipoMov" },
  { pattern: "%Motivo%", label: "motivos" },
];

async function findRelatedTables(pool: SqlPool): Promise<Array<{ name: string; schema: string; matchedPattern: string }>> {
  const out: Array<{ name: string; schema: string; matchedPattern: string }> = [];
  const seen = new Set<string>();
  for (const p of RELATED_PATTERNS) {
    const r = await pool.request().input("p", sql.NVarChar, p.pattern).query<{ schema: string; name: string }>(`
      SELECT ss.name schema_, tt.name FROM sys.tables tt
      JOIN sys.schemas ss ON tt.schema_id = ss.schema_id
      WHERE tt.is_ms_shipped = 0 AND tt.name LIKE @p
      ORDER BY ss.name, tt.name`);
    for (const row of r.recordset) {
      // sql.NVarChar maps schema_ via select alias; resolve as 'schema' below
      const sch = (row as unknown as Record<string, string>)["schema_"] ?? "dbo";
      const key = `${sch}.${row.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: row.name, schema: sch, matchedPattern: p.label });
    }
  }
  return out;
}

async function dumpRelatedTable(pool: SqlPool, schema: string, name: string, matchedPattern: string): Promise<RelatedTable> {
  const cols = await listColumns(pool, { schema, table: name });
  const rowCount = await getRowCount(pool, schema, name);
  let sample: SampleRow[] = [];
  try {
    const r = await pool.request().query<SampleRow>(`SELECT TOP 3 * FROM [${schema}].[${name}]`);
    sample = r.recordset;
  } catch {
    // ignore — tabela com colunas exóticas pode falhar SELECT *
  }
  return { name, schema, rowCount, columns: cols, sample, matchedPattern };
}

// ── Lookups ──────────────────────────────────────────────────────────

async function getTipoDocumentoLookup(pool: SqlPool): Promise<SampleRow[]> {
  try {
    const r = await pool.request().query<SampleRow>(
      `SELECT [Tipo Documento ID] id, [Descricao] descricao FROM [dbo].[Tipo Documento] ORDER BY id`,
    );
    return r.recordset;
  } catch {
    return [];
  }
}

async function getTipoMovLookups(pool: SqlPool, candidates: Array<{ schema: string; name: string }>): Promise<Array<{ table: string; rows: SampleRow[] }>> {
  const out: Array<{ table: string; rows: SampleRow[] }> = [];
  for (const t of candidates) {
    try {
      const r = await pool.request().query<SampleRow>(`SELECT TOP 50 * FROM [${t.schema}].[${t.name}]`);
      out.push({ table: `${t.schema}.${t.name}`, rows: r.recordset });
    } catch {
      // skip
    }
  }
  return out;
}

// ── Correlação 7 dias ────────────────────────────────────────────────

async function getCorrelation(
  pool: SqlPool,
  stocksMovDateCol: string,
): Promise<AuditReport["correlation"]> {
  const since = new Date();
  since.setDate(since.getDate() - 7);
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
      WHERE CAST(a.[Data Venda] AS DATE) = d.dia AND a.[Fim Venda]='S'
    ) ven
    OUTER APPLY (
      SELECT COUNT_BIG(*) n FROM [dbo].[Recepcao Detalhe] rd
      JOIN [dbo].[Recepcao] r ON r.[Recepcao ID]=rd.[Recepcao ID]
      WHERE CAST(r.[Data Recepcao] AS DATE) = d.dia AND r.[RecepcaoSituacaoID]='N'
    ) com
    OUTER APPLY (
      SELECT COUNT_BIG(*) n FROM [dbo].[Devolucao Detalhe] dd
      JOIN [dbo].[Devolucao] dv ON dv.[Devolucao ID]=dd.[Devolucao ID]
      WHERE CAST(dv.[DataDevolucao] AS DATE) = d.dia
    ) dev
    ORDER BY d.dia DESC`);
  return r.recordset.map((row) => ({
    day: row.dia.toISOString().slice(0, 10),
    stocksMov: Number(row.stocksMov ?? 0),
    vendas: Number(row.vendas ?? 0),
    compras: Number(row.compras ?? 0),
    devolFornecedor: Number(row.devol ?? 0),
    deltaUnexplained: Number(row.stocksMov ?? 0) - Number(row.vendas ?? 0) - Number(row.compras ?? 0) - Number(row.devol ?? 0),
  }));
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

function renderMarkdown(r: AuditReport): string {
  const md: string[] = [];
  md.push(`# Auditoria de Movimentos ERP\n`);
  md.push(`- **Timestamp:** ${r.meta.timestamp}`);
  md.push(`- **Agent rev:** ${r.meta.agentRev}`);
  md.push(`- **ERP:** ${r.meta.erp.database}@${r.meta.erp.host}:${r.meta.erp.port}`);
  md.push(`- **Janela volumetria:** ${r.meta.paramsMonths} meses · samples=${r.meta.paramsSamples}\n`);

  if (r.warnings.length > 0) {
    md.push(`## ⚠ Warnings\n`);
    for (const w of r.warnings) md.push(`- ${w}`);
    md.push("");
  }

  md.push(`## 1. dbo.StocksMov\n`);
  if (!r.stocksMov.exists) {
    md.push(`✗ **NÃO EXISTE.** Pipeline incremental de stock está em risco.\n`);
  } else {
    md.push(`- Row count estimado: **${r.stocksMov.rowCountEstimate.toLocaleString("pt-PT")}**`);
    md.push(`- Date range: ${r.stocksMov.dateRangeAll?.column ? `[${r.stocksMov.dateRangeAll.column}] ${r.stocksMov.dateRangeAll.min?.slice(0,10) ?? "?"} → ${r.stocksMov.dateRangeAll.max?.slice(0,10) ?? "?"}` : "—"}`);
    md.push(`- **TipoMov column detected:** ${r.stocksMov.tipoColumnDetected ?? "✗ NÃO DETECTADA"} (score ${r.stocksMov.tipoColumnScore})`);
    if (r.stocksMov.tipoColumnAllCandidates.length > 1) {
      md.push(`  - Outros candidatos: ${r.stocksMov.tipoColumnAllCandidates.slice(1).map((c) => `${c.name}(${c.score})`).join(", ")}`);
    }
    md.push(`- PK: ${r.stocksMov.primaryKey.join(", ") || "(sem)"}`);
    md.push(`\n### 1.1 Colunas\n`);
    md.push("```");
    for (const c of r.stocksMov.columns) md.push(`  ${fmtCol(c)}`);
    md.push("```\n");
    if (r.stocksMov.indexes.length > 0) {
      md.push(`### 1.2 Índices não-PK\n`);
      for (const i of r.stocksMov.indexes) md.push(`- \`${i.name}\`${i.isUnique ? " UNIQUE" : ""}: (${i.columns.join(", ")})`);
      md.push("");
    }
  }

  md.push(`## 2. Volumetria ${r.meta.paramsMonths}m por TipoMov\n`);
  if (r.volumetria.length === 0) {
    md.push(`(sem dados — tipo não detectado ou tabela vazia)\n`);
  } else {
    md.push(`| Tipo | Linhas | Produtos | Qt abs | Qt>0 | Qt<0 | minD | maxD |`);
    md.push(`|---|---:|---:|---:|---:|---:|---|---|`);
    for (const v of r.volumetria) {
      md.push(`| ${v.tipo ?? "NULL"} | ${v.rows.toLocaleString("pt-PT")} | ${v.produtosDistintos} | ${v.qtSum} | ${v.qtPositiveLines} | ${v.qtNegativeLines} | ${v.dataMin?.slice(0,10) ?? "—"} | ${v.dataMax?.slice(0,10) ?? "—"} |`);
    }
    md.push("");
  }

  md.push(`## 3. Amostras TOP ${r.meta.paramsSamples} por tipo (vertical)\n`);
  for (const s of r.samples) {
    md.push(`### tipo=${s.tipo}\n`);
    md.push("```");
    s.rows.slice(0, r.meta.paramsSamples).forEach((row, i) => {
      md.push(`-- [${i + 1}] --`);
      for (const [k, v] of Object.entries(row)) md.push(`  ${k}: ${formatVal(v)}`);
    });
    md.push("```\n");
  }

  md.push(`## 4. Tabelas relacionadas (sys.tables matching)\n`);
  if (r.relatedTables.length === 0) {
    md.push(`(nenhuma tabela com padrões: ${RELATED_PATTERNS.map(p => p.pattern).join(", ")})\n`);
  } else {
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
          for (const [k, v] of Object.entries(row)) md.push(`  ${k}: ${formatVal(v)}`);
        });
        md.push("```");
      }
      md.push("");
    }
  }

  md.push(`## 5. Lookups\n`);
  md.push(`### 5.1 dbo.[Tipo Documento] (${r.lookups.tipoDocumento.length} entradas)\n`);
  md.push("```");
  for (const row of r.lookups.tipoDocumento) {
    md.push(`  ${row.id} → ${row.descricao ?? "(sem descrição)"}`);
  }
  md.push("```\n");
  if (r.lookups.tipoMovLookups.length > 0) {
    md.push(`### 5.2 Lookups TipoMov encontradas\n`);
    for (const lk of r.lookups.tipoMovLookups) {
      md.push(`#### ${lk.table}\n`);
      md.push("```");
      lk.rows.forEach((row) => md.push(`  ${JSON.stringify(row)}`));
      md.push("```\n");
    }
  } else {
    md.push(`### 5.2 Lookups TipoMov\n\n(nenhuma tabela TipoMov* encontrada)\n`);
  }

  md.push(`## 6. Correlação 7 dias (StocksMov vs documentos)\n`);
  if (r.correlation.length === 0) {
    md.push(`(sem dados nos últimos 7 dias)\n`);
  } else {
    md.push(`| Dia | StocksMov | Vendas | Compras | Devol.Forn | Δ unexplained |`);
    md.push(`|---|---:|---:|---:|---:|---:|`);
    for (const c of r.correlation) {
      md.push(`| ${c.day} | ${c.stocksMov} | ${c.vendas} | ${c.compras} | ${c.devolFornecedor} | ${c.deltaUnexplained > 0 ? "**+" + c.deltaUnexplained + "**" : c.deltaUnexplained} |`);
    }
    md.push("");
    md.push(`> Δ unexplained > 0 ⇒ movimentos StocksMov sem correspondência em Atendimento/Recepcao/Devolucao = **candidatos a ajustes/inventário/transferência**.\n`);
  }

  return md.join("\n");
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return "(null)";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "…";
  return String(v);
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
  console.log("movimentos-audit — discovery única do universo de movimentos");
  console.log(RULE);
  console.log(`ERP: ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Janela: ${args.months} meses  ·  Samples: ${args.samples} por tipo`);
  console.log(`Output: ${outDir}\\movimentos-audit-${ts}.{md,json}`);
  console.log("");

  const warnings: string[] = [];
  const report: AuditReport = {
    meta: { timestamp: new Date().toISOString(), agentRev: process.env.AGENT_REV ?? "?", erp: { host: cfg.sqlHost, port: cfg.sqlPort, database: cfg.sqlDatabase }, paramsMonths: args.months, paramsSamples: args.samples },
    stocksMov: { exists: false, rowCountEstimate: 0, columns: [], primaryKey: [], indexes: [], dateRangeAll: null, tipoColumnDetected: null, tipoColumnScore: 0, tipoColumnAllCandidates: [] },
    volumetria: [], samples: [], relatedTables: [],
    lookups: { tipoDocumento: [], tipoMovLookups: [] },
    correlation: [], warnings,
  };

  try {
    return await withPool(cfg, async (pool) => {
      // ── 1. StocksMov ──
      console.log("▶ 1/6  Schema dbo.StocksMov ...");
      const smExists = await tableExists(pool, { schema: "dbo", table: "StocksMov" });
      report.stocksMov.exists = smExists;
      if (!smExists) {
        warnings.push("dbo.StocksMov NÃO EXISTE neste ERP — todo o módulo de movimentos fica em risco.");
      } else {
        report.stocksMov.columns = await listColumns(pool, { schema: "dbo", table: "StocksMov" });
        report.stocksMov.rowCountEstimate = await getRowCount(pool, "dbo", "StocksMov");
        report.stocksMov.primaryKey = await getPrimaryKey(pool, "dbo", "StocksMov");
        report.stocksMov.indexes = await getIndexes(pool, "dbo", "StocksMov");
        const tipoDet = detectTipoColumn(report.stocksMov.columns);
        report.stocksMov.tipoColumnDetected = tipoDet.detected;
        report.stocksMov.tipoColumnScore = tipoDet.score;
        report.stocksMov.tipoColumnAllCandidates = tipoDet.all;
        if (!tipoDet.detected) warnings.push("Coluna TipoMov não detectada por heurística; ver lista de candidatos.");
        const dateCol = pickDateColumn(report.stocksMov.columns);
        if (dateCol) {
          report.stocksMov.dateRangeAll = { column: dateCol, ...(await getDateRange(pool, "dbo", "StocksMov", dateCol)) };
        } else {
          warnings.push("Coluna date-like não encontrada em StocksMov (esperado DataMov ou similar).");
        }

        // ── 2. Volumetria ──
        console.log("▶ 2/6  Volumetria 24m por tipo ...");
        const qtyCol = report.stocksMov.columns.find((c) => /quantid|qtde|qtd/i.test(c.name))?.name ?? null;
        const prodCol = report.stocksMov.columns.find((c) => /^codigoid$/i.test(c.name))?.name ?? null;
        if (tipoDet.detected && dateCol) {
          report.volumetria = await getVolumetria(pool, "dbo", "StocksMov", tipoDet.detected, dateCol, qtyCol, prodCol, args.months);
          // ── 3. Samples ──
          console.log("▶ 3/6  Samples por tipo ...");
          const tipos = report.volumetria.map((v) => v.tipo);
          report.samples = await getSamplesPerTipo(pool, "dbo", "StocksMov", tipoDet.detected, dateCol, tipos, args.samples);
        } else {
          warnings.push("Volumetria saltada — falta TipoMov ou date column.");
        }

        // ── 6. Correlação ──
        if (dateCol) {
          console.log("▶ 4/6  Correlação 7 dias ...");
          try {
            report.correlation = await getCorrelation(pool, dateCol);
          } catch (e) {
            warnings.push(`Correlação falhou: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      // ── 4. Tabelas relacionadas ──
      console.log("▶ 5/6  Tabelas relacionadas (sys.tables LIKE patterns) ...");
      const candidates = await findRelatedTables(pool);
      const tipoMovCandidates: Array<{ schema: string; name: string }> = [];
      for (const c of candidates) {
        try {
          report.relatedTables.push(await dumpRelatedTable(pool, c.schema, c.name, c.matchedPattern));
          if (c.matchedPattern === "lookup tipoMov") tipoMovCandidates.push(c);
        } catch (e) {
          warnings.push(`Falha a inspeccionar ${c.schema}.${c.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ── 5. Lookups ──
      console.log("▶ 6/6  Lookups ([Tipo Documento] + TipoMov*) ...");
      report.lookups.tipoDocumento = await getTipoDocumentoLookup(pool);
      report.lookups.tipoMovLookups = await getTipoMovLookups(pool, tipoMovCandidates);

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
      console.log(`  StocksMov: ${report.stocksMov.exists ? `${report.stocksMov.rowCountEstimate.toLocaleString("pt-PT")} rows` : "✗ NÃO EXISTE"}`);
      console.log(`  TipoMov detectado: ${report.stocksMov.tipoColumnDetected ?? "✗"}  (score ${report.stocksMov.tipoColumnScore})`);
      console.log(`  Tipos distintos no período: ${report.volumetria.length}`);
      console.log(`  Tabelas relacionadas: ${report.relatedTables.length}`);
      console.log(`  Lookups TipoMov: ${report.lookups.tipoMovLookups.length}`);
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
