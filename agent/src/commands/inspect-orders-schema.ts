/**
 * agent/src/commands/inspect-orders-schema.ts
 *
 * Probe read-only sobre as tabelas do SPharm ERP local que tipicamente
 * compõem o domínio "encomendas a fornecedor". Não escreve nada — só
 * descobre estrutura. O resultado serve para decidir como activar
 * `ordersWriteMode=insert` em `agent/src/spharm-orders-writer.ts`.
 *
 * Candidatos fixos (passáveis via --tables se a lista no SPharm-alvo
 * for diferente — operador conhece os nomes locais):
 *   · dbo.Encomendas
 *   · dbo.Encomendas Detalhe
 *   · dbo.EncomendasFaltas
 *   · dbo.Encomendas_Prepara
 *   · dbo.Fornecedores
 *   · dbo.Stocks
 *
 * Para cada tabela existente recolhe:
 *   · row count estimado (sys.partitions, sem scan)
 *   · colunas + tipos + nullability
 *   · primary key
 *   · foreign keys IN e OUT
 *   · índices não-PK
 *   · MIN/MAX de colunas-data (até 3)
 *   · TOP 5 amostras
 *
 * Adicionalmente faz descoberta automática de tabelas com "encomenda"
 * no nome para apanhar variantes que não estejam na lista fixa.
 *
 * Output:
 *   · stdout — sumário compacto (status por tabela + insights)
 *   · ficheiro markdown `<outputDir>/orders-schema-<YYYY-MM-DD>/inspection.md`
 *     com tudo: pode ser anexado em conversa, partilhado com operador
 *     SPharm para validação, ou consumido por sessão futura.
 *
 * Garantias:
 *   · SQL login só precisa de db_datareader — todas as queries são
 *     SELECT em sys.* e SELECT TOP 5 nas tabelas alvo
 *   · Nada é enviado para a SaaS
 *   · TOP 5 pode conter dados operacionais (designações de produto,
 *     nomes de fornecedores). NÃO contém dados pessoais de clientes
 *     porque estas tabelas são B2B fornecedor — mas operador deve
 *     decidir antes de partilhar o ficheiro.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import {
  tableExists,
  listColumns,
  estimateRowCount,
  listPrimaryKey,
  listForeignKeysOut,
  listForeignKeysIn,
  listIndexes,
  pickDateColumns,
  probeDateRanges,
  renderColumnType,
  formatCell,
  parseTableArg,
  type ParsedTableArg,
  type ColumnMeta,
  type ForeignKeyEdge,
  type IndexEdge,
  type DateRange,
} from "./probe-helpers.js";

const DEFAULT_CANDIDATES = [
  "dbo.Encomendas",
  "dbo.Encomendas Detalhe",
  "dbo.EncomendasFaltas",
  "dbo.Encomendas_Prepara",
  "dbo.Fornecedores",
  "dbo.Stocks",
];

const RULE = "─".repeat(72);

type Args = {
  tables?: string[];
  help?: boolean;
};

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      tables: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const tables =
    typeof raw.values.tables === "string"
      ? raw.values.tables.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
  return { tables, help: raw.values.help === true };
}

function printHelp(): void {
  console.log("Uso: inspect-orders-schema [--tables \"dbo.A,dbo.B Z\"]");
  console.log("");
  console.log("Probe read-only às tabelas do domínio encomendas no SPharm ERP.");
  console.log("Sem --tables, usa o conjunto default:");
  for (const c of DEFAULT_CANDIDATES) console.log(`  · ${c}`);
  console.log("");
  console.log("Output: stdout summary + ficheiro markdown em");
  console.log("  <outputDir>/orders-schema-<YYYY-MM-DD>/inspection.md");
  console.log("");
  console.log("Garantias: read-only, db_datareader, TOP 5 amostras.");
}

type TableProbe = {
  schema: string;
  table: string;
  fullName: string;
  exists: boolean;
  rowCount?: number;
  columns?: ColumnMeta[];
  primaryKey?: string[];
  fkOut?: ForeignKeyEdge[];
  fkIn?: ForeignKeyEdge[];
  indexes?: IndexEdge[];
  dateRanges?: DateRange[];
  sampleRows?: Array<Record<string, unknown>>;
  sampleError?: string;
};

async function probeOne(pool: SqlPool, target: ParsedTableArg): Promise<TableProbe> {
  const probe: TableProbe = {
    schema: target.schema,
    table: target.table,
    fullName: `${target.schema}.${target.table}`,
    exists: false,
  };

  const exists = await tableExists(pool, target);
  if (!exists) return probe;
  probe.exists = true;

  const [cols, rowCount, pk, fkOut, fkIn, idx] = await Promise.all([
    listColumns(pool, target),
    estimateRowCount(pool, target),
    listPrimaryKey(pool, target),
    listForeignKeysOut(pool, target),
    listForeignKeysIn(pool, target),
    listIndexes(pool, target),
  ]);
  probe.columns = cols;
  probe.rowCount = rowCount;
  probe.primaryKey = pk;
  probe.fkOut = fkOut;
  probe.fkIn = fkIn;
  probe.indexes = idx;

  const dateCols = pickDateColumns(cols, 3);
  probe.dateRanges = dateCols.length > 0 ? await probeDateRanges(pool, target, dateCols) : [];

  try {
    const sampleRes = await pool
      .request()
      .query<Record<string, unknown>>(`SELECT TOP 5 * FROM [${target.schema}].[${target.table}]`);
    probe.sampleRows = sampleRes.recordset;
  } catch (err) {
    probe.sampleError = err instanceof Error ? err.message : String(err);
  }

  return probe;
}

/**
 * Auto-discovery: encontra qualquer tabela com "encomenda" no nome para
 * apanhar variantes que não estejam na lista default (ex:
 * "EncomendasHist", "EncomendasFolha", etc.). Read-only sobre sys.tables.
 */
async function findEncomendasVariants(pool: SqlPool): Promise<string[]> {
  const r = await pool
    .request()
    .input("pattern", sql.NVarChar, "%encomenda%")
    .query<{ schema_name: string; table_name: string }>(`
      SELECT s.name AS schema_name, t.name AS table_name
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE t.is_ms_shipped = 0
        AND LOWER(t.name) LIKE @pattern
      ORDER BY s.name, t.name
    `);
  return r.recordset.map((row) => `${row.schema_name}.${row.table_name}`);
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ─── Heurística para o cabeçalho do markdown ──────────────────────────

function findColumnByNames(cols: ColumnMeta[] | undefined, needles: string[]): ColumnMeta | null {
  if (!cols) return null;
  for (const c of cols) {
    const lower = c.name.toLowerCase();
    if (needles.some((n) => lower.includes(n))) return c;
  }
  return null;
}

function summariseLookup(probes: Map<string, TableProbe>): {
  stocksHasCnp: boolean;
  stocksHasCodigoArtigo: boolean;
  cnpColumn: string | null;
  codigoArtigoColumn: string | null;
} {
  const stocks = probes.get("dbo.Stocks");
  if (!stocks?.columns) {
    return { stocksHasCnp: false, stocksHasCodigoArtigo: false, cnpColumn: null, codigoArtigoColumn: null };
  }
  const cnp = findColumnByNames(stocks.columns, ["cnp", "cnan", "codnac"]);
  const codigo = findColumnByNames(stocks.columns, ["codigoartigo", "codigo_artigo", "codigoid", "codartigo"]);
  return {
    stocksHasCnp: cnp !== null,
    stocksHasCodigoArtigo: codigo !== null,
    cnpColumn: cnp?.name ?? null,
    codigoArtigoColumn: codigo?.name ?? null,
  };
}

function renderMarkdown(
  cfg: AgentConfig,
  probes: Map<string, TableProbe>,
  variants: string[],
  inputCandidates: string[]
): string {
  const lines: string[] = [];
  const now = new Date();
  lines.push("# SPharm ERP — Schema das tabelas de encomendas");
  lines.push("");
  lines.push(`- **Capturado em**: ${now.toISOString()}`);
  lines.push(`- **Database**: \`${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}\``);
  lines.push(`- **Agent version**: ${cfg.agentVersion}`);
  lines.push("");
  lines.push("Probe **read-only** (db_datareader). Nenhuma escrita. Nada enviado para a SaaS.");
  lines.push("");
  lines.push("## 1. Resumo");
  lines.push("");
  lines.push("| Tabela | Existe | Row count (est.) | PK | FK out | FK in | Índices |");
  lines.push("|---|---|---:|---|---:|---:|---:|");
  for (const fullName of inputCandidates) {
    const p = probes.get(fullName);
    if (!p) continue;
    if (!p.exists) {
      lines.push(`| \`${fullName}\` | ❌ não existe | — | — | — | — | — |`);
      continue;
    }
    const pk = p.primaryKey && p.primaryKey.length > 0 ? p.primaryKey.join(", ") : "—";
    lines.push(
      `| \`${fullName}\` | ✅ | ${p.rowCount ?? "?"} | ${pk} | ${p.fkOut?.length ?? 0} | ${p.fkIn?.length ?? 0} | ${p.indexes?.length ?? 0} |`
    );
  }
  lines.push("");

  if (variants.length > 0) {
    lines.push("### Variantes detectadas por auto-discovery (`LIKE %encomenda%`)");
    lines.push("");
    for (const v of variants) {
      const tagged = inputCandidates.includes(v) ? " *(na lista default)*" : "";
      lines.push(`- \`${v}\`${tagged}`);
    }
    lines.push("");
  }

  // ── Lookup CNP → CodigoArtigo ───────────────────────────────────
  const lookup = summariseLookup(probes);
  lines.push("## 2. Lookup CNP → CodigoArtigo (necessário para mapear linhas SaaS → SPharm)");
  lines.push("");
  if (!probes.get("dbo.Stocks")?.exists) {
    lines.push("⚠️ `dbo.Stocks` não existe ou não foi probed — não consigo identificar o lookup.");
  } else {
    lines.push(`- Coluna CNP em \`dbo.Stocks\`: ${lookup.cnpColumn ? `\`${lookup.cnpColumn}\` ✅` : "❌ não detectada (procurei: cnp, cnan, codnac)"}`);
    lines.push(`- Coluna CodigoArtigo em \`dbo.Stocks\`: ${lookup.codigoArtigoColumn ? `\`${lookup.codigoArtigoColumn}\` ✅` : "❌ não detectada (procurei: codigoartigo, codigoid, codartigo)"}`);
  }
  lines.push("");
  if (lookup.cnpColumn && lookup.codigoArtigoColumn) {
    lines.push("Query de lookup proposta (para validação manual):");
    lines.push("");
    lines.push("```sql");
    lines.push(`SELECT TOP 1 [${lookup.codigoArtigoColumn}]`);
    lines.push(`FROM   [dbo].[Stocks]`);
    lines.push(`WHERE  [${lookup.cnpColumn}] = @cnp`);
    lines.push("```");
    lines.push("");
    lines.push("⚠️ Confirmar com operador: o CNP no SaaS corresponde 1:1 a este campo? Há produtos sem CNP no Stocks? Há ambiguidades (mesmo CNP, várias rows)?");
  }
  lines.push("");

  // ── Detalhe por tabela ──────────────────────────────────────────
  lines.push("## 3. Detalhe por tabela");
  lines.push("");
  for (const fullName of inputCandidates) {
    const p = probes.get(fullName);
    if (!p) continue;
    lines.push(`### \`${p.fullName}\``);
    lines.push("");
    if (!p.exists) {
      lines.push("❌ Não existe nesta base de dados.");
      lines.push("");
      continue;
    }

    lines.push(`- Row count (estimativa): **${p.rowCount}**`);
    lines.push(`- Primary key: ${p.primaryKey && p.primaryKey.length > 0 ? "`" + p.primaryKey.join(", ") + "`" : "(sem PK declarada)"}`);
    lines.push("");

    // Colunas
    lines.push("**Colunas:**");
    lines.push("");
    lines.push("| # | Nome | Tipo | Nullable |");
    lines.push("|---:|---|---|:-:|");
    p.columns?.forEach((c, i) => {
      lines.push(`| ${i + 1} | \`${c.name}\` | ${renderColumnType(c)} | ${c.nullable ? "Y" : "N"} |`);
    });
    lines.push("");

    // FKs
    if (p.fkOut && p.fkOut.length > 0) {
      lines.push(`**FKs OUT — \`${p.fullName}\` → outras (${p.fkOut.length}):**`);
      lines.push("");
      for (const fk of p.fkOut) {
        lines.push(`- \`${fk.name}\`: \`${fk.fromTable}(${fk.fromColumns.join(",")})\` → \`${fk.toTable}(${fk.toColumns.join(",")})\``);
      }
      lines.push("");
    } else {
      lines.push("**FKs OUT:** (nenhuma declarada — relações podem ser implícitas no código)");
      lines.push("");
    }

    if (p.fkIn && p.fkIn.length > 0) {
      lines.push(`**FKs IN — outras → \`${p.fullName}\` (${p.fkIn.length}):**`);
      lines.push("");
      for (const fk of p.fkIn) {
        lines.push(`- \`${fk.name}\`: \`${fk.fromTable}(${fk.fromColumns.join(",")})\` → \`${fk.toTable}(${fk.toColumns.join(",")})\``);
      }
      lines.push("");
    }

    // Índices
    if (p.indexes && p.indexes.length > 0) {
      lines.push(`**Índices não-PK (${p.indexes.length}):**`);
      lines.push("");
      for (const ix of p.indexes) {
        const uniq = ix.isUnique ? " UNIQUE" : "";
        lines.push(`- \`${ix.name}\` (${ix.type}${uniq}): ${ix.columns.map((c) => `\`${c}\``).join(", ")}`);
      }
      lines.push("");
    }

    // MIN/MAX de datas
    if (p.dateRanges && p.dateRanges.length > 0) {
      lines.push("**Datas (MIN → MAX):**");
      lines.push("");
      for (const dr of p.dateRanges) {
        const mn = dr.min ? dr.min.slice(0, 10) : "—";
        const mx = dr.max ? dr.max.slice(0, 10) : "—";
        lines.push(`- \`${dr.column}\`: ${mn} → ${mx}`);
      }
      lines.push("");
    }

    // Amostras (TOP 5)
    lines.push("**TOP 5 amostras:**");
    lines.push("");
    if (p.sampleError) {
      lines.push(`> Erro a obter amostras: ${p.sampleError}`);
      lines.push("");
    } else if (!p.sampleRows || p.sampleRows.length === 0) {
      lines.push("> (tabela vazia)");
      lines.push("");
    } else {
      lines.push("```");
      for (const [i, row] of p.sampleRows.entries()) {
        lines.push(`── linha ${i + 1} ──`);
        if (!p.columns) continue;
        const colWidth = Math.min(32, Math.max(...p.columns.map((c) => c.name.length)));
        for (const c of p.columns) {
          const v = formatCell((row as Record<string, unknown>)[c.name]);
          lines.push(`  ${c.name.padEnd(colWidth)}  ${v}`);
        }
      }
      lines.push("```");
      lines.push("");
    }
  }

  // ── Proposta de SQL INSERT transaccional ─────────────────────────
  lines.push("## 4. Proposta de SQL INSERT transaccional (DRAFT)");
  lines.push("");
  lines.push("⚠️ **Não executar** sem validação manual pelo operador SPharm. Esta proposta é construída a partir das heurísticas sobre o schema acima. O operador tem de confirmar:");
  lines.push("");
  lines.push("- Nome exacto da PK da `Encomendas` (auto-incrementada? GUID? sequencial manual?)");
  lines.push("- Como obter o ID atribuído após INSERT (`SCOPE_IDENTITY()`? coluna pré-calculada? trigger atribui?)");
  lines.push("- Defaults para `Estado`, `TipoDoc`, datas, série/número (constraints do ERP)");
  lines.push("- Existe alguma trigger / stored procedure obrigatória para criação de encomenda? (`usp_CriarEncomenda` etc.) Em ERPs como o SPharm é comum haver regras de negócio implementadas server-side que um INSERT directo NÃO dispara.");
  lines.push("- Onde guardar o `outboxId` da SaaS no SPharm para idempotência (coluna livre? observações? tabela auxiliar?)");
  lines.push("- Permissão SQL: `db_datawriter` na schema das tabelas-alvo, OU **stored procedure dedicada com EXECUTE permission** (preferível — encapsula as regras do ERP)");
  lines.push("");
  lines.push("```sql");
  lines.push("-- DRAFT — pendente de validação operacional");
  lines.push("");
  lines.push("BEGIN TRY");
  lines.push("    BEGIN TRAN;");
  lines.push("");
  lines.push("    -- 1) Header da encomenda");
  lines.push("    -- TODO: confirmar coluna IDENTITY ou esquema de numeração");
  lines.push("    INSERT INTO [dbo].[Encomendas]");
  lines.push("        (");
  lines.push("            -- colunas a popular — confirmar com a secção 3 deste documento");
  lines.push("            FornecedorId, DataCriacao, Estado");
  lines.push("            /* , Observacoes, OutboxIdSaaS, ... */");
  lines.push("        )");
  lines.push("    VALUES");
  lines.push("        (@fornecedorId, GETDATE(), 'P' /* default a confirmar */);");
  lines.push("");
  lines.push("    DECLARE @encomendaId INT = SCOPE_IDENTITY();");
  lines.push("    -- Se a PK não for IDENTITY, substituir por leitura explícita");
  lines.push("");
  lines.push("    -- 2) Linhas — uma a uma com lookup CNP → CodigoArtigo");
  lines.push("    --    (no agent JS, fazer este loop com prepared statement");
  lines.push("    --     parametrizado para evitar SQL injection)");
  if (lookup.cnpColumn && lookup.codigoArtigoColumn) {
    lines.push(`    DECLARE @codigoArtigo NVARCHAR(50);`);
    lines.push(`    SELECT TOP 1 @codigoArtigo = [${lookup.codigoArtigoColumn}]`);
    lines.push(`      FROM [dbo].[Stocks]`);
    lines.push(`     WHERE [${lookup.cnpColumn}] = @cnp;`);
    lines.push("    IF @codigoArtigo IS NULL");
    lines.push("    BEGIN");
    lines.push("        ;THROW 50001, 'CNP não encontrado no Stocks', 1;");
    lines.push("    END");
    lines.push("");
  } else {
    lines.push("    -- Lookup CNP→CodigoArtigo: não pude inferir colunas. Preencher manualmente");
    lines.push("    -- a partir da secção 3 (`dbo.Stocks`).");
    lines.push("");
  }
  lines.push("    INSERT INTO [dbo].[Encomendas Detalhe]");
  lines.push("        (EncomendaId, CodigoArtigo, Quantidade /*, ... */)");
  lines.push("    VALUES");
  lines.push("        (@encomendaId, @codigoArtigo, @quantidade);");
  lines.push("    -- ... repetir para cada linha");
  lines.push("");
  lines.push("    COMMIT;");
  lines.push("    SELECT @encomendaId AS spharmDocumentId;");
  lines.push("END TRY");
  lines.push("BEGIN CATCH");
  lines.push("    IF @@TRANCOUNT > 0 ROLLBACK;");
  lines.push("    THROW;");
  lines.push("END CATCH;");
  lines.push("```");
  lines.push("");
  lines.push("Idempotência sugerida: guardar `outboxId` da SaaS numa coluna livre do header. Antes do INSERT, fazer SELECT para confirmar que ainda não existe — se existir, devolver o `spharmDocumentId` existente em vez de duplicar.");
  lines.push("");

  // ── Próximos passos ─────────────────────────────────────────────
  lines.push("## 5. Próximos passos (em ordem)");
  lines.push("");
  lines.push("1. Operador SPharm revê secção 3 e responde às perguntas da secção 4.");
  lines.push("2. Refinar proposta SQL com os defaults reais do ERP (TipoDoc, série/número, estado inicial).");
  lines.push("3. Decidir caminho de write: INSERT directo (mais simples, mais frágil) ou stored procedure dedicada (encapsula regras do ERP). **Recomendação**: SP dedicada se já existir uma como `usp_CriarEncomenda`.");
  lines.push("4. Implementar `writeInsert` em [`agent/src/spharm-orders-writer.ts`](../../agent/src/spharm-orders-writer.ts) com a SQL/SP final + prepared statements parametrizados.");
  lines.push("5. Smoke test em ambiente controlado (1 encomenda, modo `SPHARMMT_ORDERS_WRITE_MODE=insert`, validar manualmente no UI SPharm).");
  lines.push("6. Só depois activar para a primeira farmácia real.");
  lines.push("");
  lines.push("Até este caminho estar percorrido, **`ordersWriteMode=stub` é o único modo válido em produção**.");
  return lines.join("\n");
}

function renderStdout(probes: Map<string, TableProbe>, inputCandidates: string[]): string {
  const lines: string[] = [];
  lines.push(RULE);
  lines.push("inspect-orders-schema — sumário");
  lines.push(RULE);
  lines.push("");
  for (const fullName of inputCandidates) {
    const p = probes.get(fullName);
    if (!p) continue;
    if (!p.exists) {
      lines.push(`  ✗ ${fullName.padEnd(30)} não existe`);
      continue;
    }
    const pkStr = p.primaryKey && p.primaryKey.length > 0 ? p.primaryKey.join(",") : "—";
    lines.push(
      `  ✓ ${fullName.padEnd(30)} ${String(p.rowCount).padStart(8)} rows · ` +
        `${p.columns?.length ?? 0} cols · PK=${pkStr} · ` +
        `FK out=${p.fkOut?.length ?? 0} in=${p.fkIn?.length ?? 0} · idx=${p.indexes?.length ?? 0}`
    );
  }
  lines.push("");
  const lookup = summariseLookup(probes);
  lines.push("Lookup CNP→CodigoArtigo em dbo.Stocks:");
  lines.push(`  CNP            : ${lookup.cnpColumn ? "✓ " + lookup.cnpColumn : "✗ não detectado"}`);
  lines.push(`  CodigoArtigo   : ${lookup.codigoArtigoColumn ? "✓ " + lookup.codigoArtigoColumn : "✗ não detectado"}`);
  return lines.join("\n");
}

export async function inspectOrdersSchema(): Promise<number> {
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

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const inputCandidates = args.tables && args.tables.length > 0 ? args.tables : DEFAULT_CANDIDATES;
  const targets: ParsedTableArg[] = [];
  for (const raw of inputCandidates) {
    try {
      targets.push(parseTableArg(raw));
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  console.log(RULE);
  console.log("inspect-orders-schema");
  console.log(RULE);
  console.log(`Database  : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Candidatos: ${inputCandidates.length}`);
  for (const c of inputCandidates) console.log(`  · ${c}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const probes = new Map<string, TableProbe>();
      for (const t of targets) {
        const fullName = `${t.schema}.${t.table}`;
        console.log(`▶ probing ${fullName} ...`);
        const probe = await probeOne(pool, t);
        probes.set(fullName, probe);
        if (probe.exists) {
          console.log(`  ✓ ${probe.rowCount} rows, ${probe.columns?.length ?? 0} cols`);
        } else {
          console.log(`  ✗ não existe`);
        }
      }

      console.log("");
      console.log("▶ auto-discovery: tabelas com 'encomenda' no nome ...");
      let variants: string[];
      try {
        variants = await findEncomendasVariants(pool);
        console.log(`  ${variants.length} tabela(s) detectada(s)`);
      } catch (err) {
        console.error(`  ✗ falhou: ${err instanceof Error ? err.message : String(err)}`);
        variants = [];
      }
      console.log("");

      // Render stdout summary
      console.log(renderStdout(probes, inputCandidates));
      console.log("");

      // Persist markdown
      const outDir = path.resolve(cfg.outputDir, `orders-schema-${ymd(new Date())}`);
      fs.mkdirSync(outDir, { recursive: true });
      const mdPath = path.resolve(outDir, "inspection.md");
      const md = renderMarkdown(cfg, probes, variants, inputCandidates);
      fs.writeFileSync(mdPath, md, "utf8");

      console.log(RULE);
      console.log(`Markdown completo: ${mdPath}`);
      console.log(RULE);
      console.log("Próximo passo: rever o markdown, responder às perguntas da secção 4");
      console.log("e SÓ ENTÃO implementar writeInsert em spharm-orders-writer.ts.");
      console.log("Até lá, ordersWriteMode=stub é o único modo seguro.");
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha na inspecção:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
