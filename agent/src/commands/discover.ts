/**
 * agent/src/commands/discover.ts
 *
 * Discovery read-only do schema da BD SPharm (Softreis) em SQL Server.
 * Recolhe **metadata apenas** — não lê linhas de dados clínicos nem
 * comerciais. Output em JSON + Markdown em `<outputDir>/`.
 *
 * Esta versão é a canónica — substitui o legacy
 * `scripts/erp/spharm-sqlserver-discover.ts` do repo SaaS, agora que
 * o agent vive em `agent/` standalone.
 *
 * Garantias:
 *   · Read-only: só consulta sys.* e DATABASEPROPERTYEX(). Nenhum DML.
 *   · Sem dados de negócio: row counts e datas min/max apenas em
 *     colunas que parecem timestamps de movimento (data, dataDoc, etc.).
 *   · Timeout curto (15s connect, 30s query) para evitar bloquear o ERP.
 *   · Falha-rápido com mensagem accionável se conexão ou config falham.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import sql, { type IResult } from "mssql";
import { loadConfig, maskSecret, type AgentConfig } from "../config.js";
import { openPool } from "../sql-client.js";

// ─────────────────────────────────────────────────────────────────────
// Heurísticas de detecção de candidatos
// ─────────────────────────────────────────────────────────────────────

type CandidateCategory =
  | "produtos"
  | "stocks"
  | "vendas"
  | "compras"
  | "devolucoes"
  | "ajustes"
  | "inventario"
  | "documentos"
  | "linhas"
  | "farmacias"
  | "fornecedores"
  | "clientes"
  | "fabricantes";

type CategoryRule = {
  category: CandidateCategory;
  needles: string[];
  blockers?: string[];
};

const CATEGORY_RULES: CategoryRule[] = [
  { category: "linhas", needles: ["linha", "_lin", "lin_", "detalhe", "itemdoc"] },
  { category: "vendas", needles: ["venda", "fatura", "factura", "talao", "talão", "fact_", "vnd"], blockers: ["devol"] },
  { category: "devolucoes", needles: ["devol", "credito_", "nc_", "notacred"] },
  { category: "compras", needles: ["compra", "encomenda", "ordemcomp", "encom"], blockers: ["fornecedor"] },
  { category: "ajustes", needles: ["ajuste", "acerto", "correc", "regulariz"] },
  { category: "inventario", needles: ["inventario", "inventário", "contagem"] },
  { category: "stocks", needles: ["stock", "existencia", "existência", "stkactual", "exist_"], blockers: ["movim"] },
  { category: "produtos", needles: ["produto", "artigo", "_art_", "art_", "medicamento"], blockers: ["fornec", "linha", "venda", "compra", "stock"] },
  { category: "farmacias", needles: ["farmacia", "farmácia", "loja", "armazem", "armazém", "deposito", "depósito", "estabelec"] },
  { category: "fornecedores", needles: ["fornec", "supplier"] },
  { category: "fabricantes", needles: ["fabricant", "marca_", "laborator"] },
  { category: "clientes", needles: ["cliente", "utente", "customer"] },
  { category: "documentos", needles: ["documento", "doc_", "_doc", "movimento"], blockers: ["linha"] },
];

function classifyTable(schema: string, table: string): CandidateCategory | null {
  const key = `${schema}.${table}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    const matched = rule.needles.some((n) => key.includes(n));
    if (!matched) continue;
    const blocked = rule.blockers?.some((b) => key.includes(b)) ?? false;
    if (blocked) continue;
    return rule.category;
  }
  return null;
}

const DATE_COLUMN_HINTS = [
  "data", "datadoc", "datamov", "datacria", "datacriacao", "datavenda",
  "dataentrada", "datasaida", "datainsercao", "dataregisto", "datehora",
  "datetime", "fechado", "criado", "modificado",
];
const DATE_TYPES = new Set(["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset"]);

function looksLikeMovementDate(columnName: string, dataType: string): boolean {
  if (!DATE_TYPES.has(dataType.toLowerCase())) return false;
  const lower = columnName.toLowerCase();
  return DATE_COLUMN_HINTS.some((h) => lower.includes(h));
}

// ─────────────────────────────────────────────────────────────────────
// Tipos do output
// ─────────────────────────────────────────────────────────────────────

type ColumnInfo = {
  name: string;
  dataType: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  ordinal: number;
};

type IndexInfo = {
  name: string;
  isUnique: boolean;
  type: string;
  columns: string[];
};

type TableInfo = {
  schema: string;
  name: string;
  fullName: string;
  rowCountEstimate: number;
  columns: ColumnInfo[];
  primaryKey: string[];
  indexes: IndexInfo[];
  candidateCategory: CandidateCategory | null;
  dateRanges?: { column: string; min: string | null; max: string | null }[];
};

type ForeignKeyInfo = {
  name: string;
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
};

type TriggerInfo = {
  schema: string;
  table: string;
  name: string;
  disabled: boolean;
  kind: string;
};

type DiscoveryOutput = {
  discoveredAt: string;
  database: {
    name: string;
    edition: string | null;
    productVersion: string | null;
    collation: string | null;
    compatibilityLevel: number | null;
  };
  connection: {
    host: string;
    port: number;
    database: string;
    user: string; // masked
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
  schemas: string[];
  tables: TableInfo[];
  foreignKeys: ForeignKeyInfo[];
  triggers: TriggerInfo[];
  candidates: Record<CandidateCategory, string[]>;
  warnings: string[];
};

function fmtRowCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─────────────────────────────────────────────────────────────────────
// Queries SQL Server (mesmas do legacy)
// ─────────────────────────────────────────────────────────────────────

const Q_DB_INFO = `
  SELECT
    DB_NAME() AS db_name,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('Edition')) AS edition,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('ProductVersion')) AS product_version,
    CONVERT(NVARCHAR(128), DATABASEPROPERTYEX(DB_NAME(), 'Collation')) AS collation,
    CONVERT(INT, DATABASEPROPERTYEX(DB_NAME(), 'Version')) AS compat_level
`;

const Q_SCHEMAS = `
  SELECT name FROM sys.schemas
  WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin',
                     'db_securityadmin','db_ddladmin','db_backupoperator','db_datareader',
                     'db_datawriter','db_denydatareader','db_denydatawriter')
  ORDER BY name
`;

const Q_TABLES = `
  SELECT
    s.name AS schema_name,
    t.name AS table_name,
    SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS row_count_estimate
  FROM sys.tables t
  JOIN sys.schemas s ON t.schema_id = s.schema_id
  JOIN sys.partitions p ON t.object_id = p.object_id
  WHERE t.is_ms_shipped = 0
  GROUP BY s.name, t.name
  ORDER BY s.name, t.name
`;

const Q_COLUMNS = `
  SELECT
    s.name AS schema_name, t.name AS table_name, c.name AS column_name,
    ty.name AS data_type, c.max_length, c.precision, c.scale,
    c.is_nullable, c.column_id AS ordinal
  FROM sys.columns c
  JOIN sys.tables t ON c.object_id = t.object_id
  JOIN sys.schemas s ON t.schema_id = s.schema_id
  JOIN sys.types ty ON c.user_type_id = ty.user_type_id
  WHERE t.is_ms_shipped = 0
  ORDER BY s.name, t.name, c.column_id
`;

const Q_PRIMARY_KEYS = `
  SELECT
    s.name AS schema_name, t.name AS table_name,
    c.name AS column_name, ic.key_ordinal
  FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  JOIN sys.schemas s ON t.schema_id = s.schema_id
  JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
  JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
  WHERE i.is_primary_key = 1 AND t.is_ms_shipped = 0
  ORDER BY s.name, t.name, ic.key_ordinal
`;

const Q_INDEXES = `
  SELECT
    s.name AS schema_name, t.name AS table_name, i.name AS index_name,
    i.is_unique, i.type_desc, c.name AS column_name, ic.key_ordinal
  FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  JOIN sys.schemas s ON t.schema_id = s.schema_id
  JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
  JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
  WHERE i.is_primary_key = 0 AND i.type > 0 AND t.is_ms_shipped = 0
  ORDER BY s.name, t.name, i.name, ic.key_ordinal
`;

const Q_FOREIGN_KEYS = `
  SELECT
    fk.name AS fk_name,
    fs.name AS fk_schema, ft.name AS fk_table, fc.name AS fk_column,
    rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column,
    fkc.constraint_column_id AS ord
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
  JOIN sys.tables ft ON fk.parent_object_id = ft.object_id
  JOIN sys.schemas fs ON ft.schema_id = fs.schema_id
  JOIN sys.columns fc ON fkc.parent_object_id = fc.object_id AND fkc.parent_column_id = fc.column_id
  JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
  JOIN sys.schemas rs ON rt.schema_id = rs.schema_id
  JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
  ORDER BY fk.name, fkc.constraint_column_id
`;

const Q_TRIGGERS = `
  SELECT
    s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name,
    tr.is_disabled,
    CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS kind
  FROM sys.triggers tr
  JOIN sys.tables t ON tr.parent_id = t.object_id
  JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE tr.is_ms_shipped = 0
  ORDER BY s.name, t.name, tr.name
`;

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

export async function discover(): Promise<number> {
  const t0 = Date.now();

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log("─".repeat(70));
  console.log("SPharm.MT agent — discover (SQL Server)");
  console.log("─".repeat(70));
  console.log(`Host         : ${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Database     : ${cfg.sqlDatabase}`);
  console.log(`User         : ${maskSecret(cfg.sqlUser)}`);
  console.log(`Encrypt      : ${cfg.sqlEncrypt}`);
  console.log(`Trust cert   : ${cfg.sqlTrustCert}`);
  console.log(`Output dir   : ${cfg.outputDir}`);
  console.log("─".repeat(70));

  const warnings: string[] = [];

  const pool = openPool(cfg);
  try {
    console.log("▶ A ligar ao SQL Server…");
    try {
      await pool.connect();
    } catch (err) {
      console.error("\n✗ Falha a ligar ao SQL Server:");
      console.error(`  ${err instanceof Error ? err.message : err}`);
      console.error("\nDiagnose: corre `npm run test-connection` primeiro.");
      return 1;
    }
    console.log("  ✓ ligação OK");

    console.log("▶ A ler db info…");
    const dbInfoRes = await pool.request().query<{
      db_name: string;
      edition: string | null;
      product_version: string | null;
      collation: string | null;
      compat_level: number | null;
    }>(Q_DB_INFO);
    const dbInfo = dbInfoRes.recordset[0];
    console.log(`  edition       : ${dbInfo.edition ?? "(?)"}`);
    console.log(`  version       : ${dbInfo.product_version ?? "(?)"}`);
    console.log(`  collation     : ${dbInfo.collation ?? "(?)"}`);
    console.log(`  compat level  : ${dbInfo.compat_level ?? "(?)"}`);

    console.log("▶ A enumerar schemas…");
    const schemasRes = await pool.request().query<{ name: string }>(Q_SCHEMAS);
    const schemas = schemasRes.recordset.map((r) => r.name);
    console.log(`  ${schemas.length} schema(s)`);

    console.log("▶ A enumerar tabelas + row counts (sys.partitions, sem SELECT em dados)…");
    const tablesRes = await pool
      .request()
      .query<{ schema_name: string; table_name: string; row_count_estimate: number }>(Q_TABLES);
    console.log(`  ${tablesRes.recordset.length} tabela(s)`);

    console.log("▶ A enumerar colunas…");
    const columnsRes = await pool.request().query(Q_COLUMNS);
    console.log(`  ${columnsRes.recordset.length} coluna(s)`);

    console.log("▶ A enumerar primary keys / índices / FKs / triggers…");
    const pkRes = await pool.request().query(Q_PRIMARY_KEYS);
    const indexesRes = await pool.request().query(Q_INDEXES);
    const fkRes = await pool.request().query(Q_FOREIGN_KEYS);
    const trigRes = await pool.request().query(Q_TRIGGERS);

    // ── Construir TableInfo[] ────────────────────────────────────
    const tableMap = new Map<string, TableInfo>();
    for (const r of tablesRes.recordset as Array<{ schema_name: string; table_name: string; row_count_estimate: number }>) {
      const key = `${r.schema_name}.${r.table_name}`;
      tableMap.set(key, {
        schema: r.schema_name,
        name: r.table_name,
        fullName: key,
        rowCountEstimate: Number(r.row_count_estimate) || 0,
        columns: [],
        primaryKey: [],
        indexes: [],
        candidateCategory: classifyTable(r.schema_name, r.table_name),
      });
    }

    for (const c of columnsRes.recordset as Array<{
      schema_name: string; table_name: string; column_name: string;
      data_type: string; max_length: number; precision: number; scale: number;
      is_nullable: boolean; ordinal: number;
    }>) {
      const t = tableMap.get(`${c.schema_name}.${c.table_name}`);
      if (!t) continue;
      t.columns.push({
        name: c.column_name,
        dataType: c.data_type,
        maxLength: c.max_length,
        precision: c.precision,
        scale: c.scale,
        nullable: !!c.is_nullable,
        ordinal: c.ordinal,
      });
    }

    for (const p of pkRes.recordset as Array<{ schema_name: string; table_name: string; column_name: string; key_ordinal: number }>) {
      const t = tableMap.get(`${p.schema_name}.${p.table_name}`);
      if (!t) continue;
      t.primaryKey.push(p.column_name);
    }

    const idxAgg = new Map<string, IndexInfo>();
    for (const ix of indexesRes.recordset as Array<{
      schema_name: string; table_name: string; index_name: string;
      is_unique: boolean; type_desc: string; column_name: string; key_ordinal: number;
    }>) {
      const key = `${ix.schema_name}.${ix.table_name}::${ix.index_name}`;
      let info = idxAgg.get(key);
      if (!info) {
        info = { name: ix.index_name, isUnique: !!ix.is_unique, type: ix.type_desc, columns: [] };
        idxAgg.set(key, info);
        const t = tableMap.get(`${ix.schema_name}.${ix.table_name}`);
        t?.indexes.push(info);
      }
      info.columns.push(ix.column_name);
    }

    const fkAgg = new Map<string, ForeignKeyInfo>();
    for (const f of fkRes.recordset as Array<{
      fk_name: string; fk_schema: string; fk_table: string; fk_column: string;
      ref_schema: string; ref_table: string; ref_column: string; ord: number;
    }>) {
      let info = fkAgg.get(f.fk_name);
      if (!info) {
        info = {
          name: f.fk_name,
          fromSchema: f.fk_schema, fromTable: f.fk_table, fromColumns: [],
          toSchema: f.ref_schema, toTable: f.ref_table, toColumns: [],
        };
        fkAgg.set(f.fk_name, info);
      }
      info.fromColumns.push(f.fk_column);
      info.toColumns.push(f.ref_column);
    }

    const triggers: TriggerInfo[] = (trigRes.recordset as Array<{
      schema_name: string; table_name: string; trigger_name: string; is_disabled: boolean; kind: string;
    }>).map((t) => ({
      schema: t.schema_name,
      table: t.table_name,
      name: t.trigger_name,
      disabled: !!t.is_disabled,
      kind: t.kind,
    }));

    // ── Date ranges em candidatos ────────────────────────────────
    console.log("▶ A amostrar min/max de datas em candidatos (sem leitura de outras colunas)…");
    let dateProbes = 0;
    let dateProbeErrors = 0;
    for (const t of tableMap.values()) {
      if (!t.candidateCategory) continue;
      if (t.rowCountEstimate === 0) continue;
      const dateCols = t.columns.filter((c) => looksLikeMovementDate(c.name, c.dataType));
      if (dateCols.length === 0) continue;
      t.dateRanges = [];
      for (const col of dateCols.slice(0, 2)) {
        dateProbes++;
        try {
          const r: IResult<{ mn: Date | null; mx: Date | null }> = await pool
            .request()
            .query(`SELECT MIN([${col.name}]) AS mn, MAX([${col.name}]) AS mx FROM [${t.schema}].[${t.name}]`);
          const row = r.recordset[0];
          t.dateRanges.push({
            column: col.name,
            min: row?.mn ? row.mn.toISOString() : null,
            max: row?.mx ? row.mx.toISOString() : null,
          });
        } catch (err) {
          dateProbeErrors++;
          warnings.push(`date probe falhou em ${t.fullName}.${col.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    console.log(`  ${dateProbes} probes (${dateProbeErrors} falhas)`);

    // ── Candidatos por categoria ─────────────────────────────────
    const candidates: Record<CandidateCategory, string[]> = {
      produtos: [], stocks: [], vendas: [], compras: [], devolucoes: [],
      ajustes: [], inventario: [], documentos: [], linhas: [],
      farmacias: [], fornecedores: [], clientes: [], fabricantes: [],
    };
    for (const t of tableMap.values()) {
      if (t.candidateCategory) candidates[t.candidateCategory].push(t.fullName);
    }
    for (const cat of Object.keys(candidates) as CandidateCategory[]) {
      candidates[cat].sort((a, b) => {
        const ra = tableMap.get(a)?.rowCountEstimate ?? 0;
        const rb = tableMap.get(b)?.rowCountEstimate ?? 0;
        return rb - ra;
      });
    }

    const output: DiscoveryOutput = {
      discoveredAt: new Date().toISOString(),
      database: {
        name: dbInfo.db_name,
        edition: dbInfo.edition,
        productVersion: dbInfo.product_version,
        collation: dbInfo.collation,
        compatibilityLevel: dbInfo.compat_level,
      },
      connection: {
        host: cfg.sqlHost,
        port: cfg.sqlPort,
        database: cfg.sqlDatabase,
        user: maskSecret(cfg.sqlUser),
        encrypt: cfg.sqlEncrypt,
        trustServerCertificate: cfg.sqlTrustCert,
      },
      schemas,
      tables: Array.from(tableMap.values()).sort((a, b) => a.fullName.localeCompare(b.fullName)),
      foreignKeys: Array.from(fkAgg.values()),
      triggers,
      candidates,
      warnings,
    };

    // ── Escrever ficheiros em <outputDir>/ ───────────────────────
    fs.mkdirSync(cfg.outputDir, { recursive: true });
    const jsonPath = path.join(cfg.outputDir, "spharm-sqlserver-discovery.json");
    const mdPath = path.join(cfg.outputDir, "spharm-sqlserver-discovery.md");
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");
    fs.writeFileSync(mdPath, renderMarkdown(output), "utf8");

    console.log("─".repeat(70));
    console.log(`✓ Discovery concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  JSON     : ${jsonPath}`);
    console.log(`  Markdown : ${mdPath}`);
    if (warnings.length > 0) {
      console.log(`\n${warnings.length} warning(s) — ver secção Warnings no markdown.`);
    }
    return 0;
  } finally {
    await pool.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Markdown renderer
// ─────────────────────────────────────────────────────────────────────

function renderColumnType(c: ColumnInfo): string {
  const t = c.dataType.toLowerCase();
  if (["varchar", "nvarchar", "char", "nchar", "varbinary", "binary"].includes(t)) {
    const len = c.maxLength === -1 ? "max" : t.startsWith("n") ? Math.floor((c.maxLength ?? 0) / 2) : c.maxLength;
    return `${c.dataType}(${len})`;
  }
  if (["decimal", "numeric"].includes(t)) return `${c.dataType}(${c.precision},${c.scale})`;
  return c.dataType;
}

function renderTable(t: TableInfo): string {
  const lines: string[] = [];
  lines.push(`### \`${t.fullName}\`  · ~${fmtRowCount(t.rowCountEstimate)} rows`);
  if (t.candidateCategory) lines.push(`*Candidato:* **${t.candidateCategory}**`);
  if (t.primaryKey.length > 0) lines.push(`*PK:* \`${t.primaryKey.join(", ")}\``);
  if (t.dateRanges && t.dateRanges.length > 0) {
    for (const dr of t.dateRanges) {
      const minS = dr.min ? dr.min.slice(0, 10) : "—";
      const maxS = dr.max ? dr.max.slice(0, 10) : "—";
      lines.push(`*Date range \`${dr.column}\`:* ${minS} → ${maxS}`);
    }
  }
  lines.push("");
  lines.push("| # | Col | Tipo | Null |");
  lines.push("|---|---|---|---|");
  for (const c of t.columns) {
    lines.push(`| ${c.ordinal} | \`${c.name}\` | ${renderColumnType(c)} | ${c.nullable ? "Y" : "N"} |`);
  }
  if (t.indexes.length > 0) {
    lines.push("");
    lines.push("**Índices não-PK:**");
    for (const ix of t.indexes) {
      const uniq = ix.isUnique ? " unique" : "";
      lines.push(`- \`${ix.name}\` (${ix.type}${uniq}): ${ix.columns.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function renderMarkdown(o: DiscoveryOutput): string {
  const lines: string[] = [];
  lines.push(`# SPharm ERP — SQL Server Discovery`);
  lines.push("");
  lines.push(`**Gerado:** ${o.discoveredAt}`);
  lines.push("");
  lines.push(`> Output automático do agent (\`agent/src/commands/discover.ts\`). Read-only sobre \`sys.*\`. Sem leitura de dados de negócio (excepto MIN/MAX de colunas-data em candidatos).`);
  lines.push("");

  lines.push(`## Conexão`);
  lines.push("");
  lines.push(`| Campo | Valor |`);
  lines.push(`|---|---|`);
  lines.push(`| Host | \`${o.connection.host}:${o.connection.port}\` |`);
  lines.push(`| Database | \`${o.connection.database}\` |`);
  lines.push(`| User | \`${o.connection.user}\` (masked) |`);
  lines.push(`| Encrypt | ${o.connection.encrypt} |`);
  lines.push(`| Trust cert | ${o.connection.trustServerCertificate} |`);
  lines.push("");

  lines.push(`## Database`);
  lines.push("");
  lines.push(`- **Name:** \`${o.database.name}\``);
  lines.push(`- **Edition:** ${o.database.edition ?? "—"}`);
  lines.push(`- **Product version:** ${o.database.productVersion ?? "—"}`);
  lines.push(`- **Collation:** \`${o.database.collation ?? "—"}\``);
  lines.push(`- **Compat level:** ${o.database.compatibilityLevel ?? "—"}`);
  lines.push("");

  lines.push(`## Schemas (${o.schemas.length})`);
  lines.push("");
  lines.push(o.schemas.map((s) => `\`${s}\``).join(" · "));
  lines.push("");

  lines.push(`## Candidatos detectados`);
  lines.push("");
  lines.push(`| Categoria | Nº | Tabelas (ordenadas por row count desc) |`);
  lines.push(`|---|---|---|`);
  const orderedCats: CandidateCategory[] = [
    "produtos", "stocks", "vendas", "compras", "devolucoes", "ajustes",
    "inventario", "documentos", "linhas", "farmacias", "fornecedores",
    "clientes", "fabricantes",
  ];
  for (const cat of orderedCats) {
    const list = o.candidates[cat];
    const top = list.slice(0, 6).map((n) => `\`${n}\``).join(", ");
    const more = list.length > 6 ? ` (+${list.length - 6})` : "";
    lines.push(`| **${cat}** | ${list.length} | ${top || "—"}${more} |`);
  }
  lines.push("");

  lines.push(`## Top 20 tabelas por row count`);
  lines.push("");
  const top20 = [...o.tables].sort((a, b) => b.rowCountEstimate - a.rowCountEstimate).slice(0, 20);
  lines.push(`| # | Tabela | Rows (est) | Cat |`);
  lines.push(`|---|---|---:|---|`);
  for (const [i, t] of top20.entries()) {
    lines.push(`| ${i + 1} | \`${t.fullName}\` | ${fmtRowCount(t.rowCountEstimate)} | ${t.candidateCategory ?? "—"} |`);
  }
  lines.push("");

  lines.push(`## Foreign Keys (${o.foreignKeys.length})`);
  lines.push("");
  if (o.foreignKeys.length === 0) {
    lines.push(`Nenhuma FK declarada — relações podem ser implícitas no código aplicacional.`);
  } else {
    lines.push(`| FK | De | Para |`);
    lines.push(`|---|---|---|`);
    for (const fk of o.foreignKeys.slice(0, 60)) {
      const from = `\`${fk.fromSchema}.${fk.fromTable}(${fk.fromColumns.join(",")})\``;
      const to = `\`${fk.toSchema}.${fk.toTable}(${fk.toColumns.join(",")})\``;
      lines.push(`| \`${fk.name}\` | ${from} | ${to} |`);
    }
    if (o.foreignKeys.length > 60) lines.push(`\n(+${o.foreignKeys.length - 60} mais — ver JSON)`);
  }
  lines.push("");

  lines.push(`## Triggers (${o.triggers.length})`);
  lines.push("");
  if (o.triggers.length === 0) {
    lines.push(`Sem triggers de utilizador.`);
  } else {
    lines.push(`| Trigger | Tabela | Tipo | Estado |`);
    lines.push(`|---|---|---|---|`);
    for (const t of o.triggers) {
      lines.push(`| \`${t.name}\` | \`${t.schema}.${t.table}\` | ${t.kind} | ${t.disabled ? "disabled" : "active"} |`);
    }
  }
  lines.push("");

  lines.push(`## Detalhe de tabelas candidatas`);
  lines.push("");
  for (const cat of orderedCats) {
    const list = o.candidates[cat];
    if (list.length === 0) continue;
    lines.push(`### Categoria: ${cat}`);
    lines.push("");
    for (const full of list.slice(0, 4)) {
      const t = o.tables.find((tt) => tt.fullName === full);
      if (!t) continue;
      lines.push(renderTable(t));
      lines.push("");
    }
    if (list.length > 4) {
      lines.push(`*(+${list.length - 4} mais nesta categoria — ver JSON)*`);
      lines.push("");
    }
  }

  if (o.warnings.length > 0) {
    lines.push(`## Warnings`);
    lines.push("");
    for (const w of o.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push(`## Próximos passos`);
  lines.push("");
  lines.push(`1. Validar manualmente as categorias detectadas com o conhecimento do SPharm ERP (Softreis).`);
  lines.push(`2. Para cada entidade-alvo (Produto / Stock / Venda / Compra / Devolução / Ajuste / Inventário / Fornecedor / Fabricante), identificar:`);
  lines.push(`   - Tabela mestre`);
  lines.push(`   - Coluna PK`);
  lines.push(`   - Coluna data de mov. (para incrementais)`);
  lines.push(`   - Coluna que identifica a farmácia/loja (multi-loja)`);
  lines.push(`   - Tabelas de linhas (header + lines em vendas/compras)`);
  lines.push(`3. Definir mapping ERP → SPharm.MT por entidade em \`notes/erp-direct-sync-mapping.md\`.`);
  lines.push(`4. Implementar comandos \`bootstrap\` e \`daily-sync\` no agent.`);

  return lines.join("\n") + "\n";
}
