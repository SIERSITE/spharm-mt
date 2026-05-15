/**
 * agent/src/commands/inspect-compras-schema.ts
 *
 * Probe READ-ONLY sobre as tabelas do SPharm ERP local que tipicamente
 * compõem os domínios:
 *
 *   · Compras / recepções / facturas de compra / notas de entrada
 *     / movimentos de entrada — origem dos dados que devem aparecer
 *     em `Compra` (Prisma SaaS) e `Movimentos` (timeline produto)
 *
 *   · Devoluções a fornecedor / notas de devolução — origem dos dados
 *     que devem aparecer em `Devolucao` (tipo=FORNECEDOR)
 *
 * Não escreve nada. Não envia para a SaaS. O output serve para o
 * operador SPharm validar nomes de tabela e o admin desenhar as Fases
 * 1-6 (staging, ingest endpoint, agent extract, aggregation, pipeline).
 *
 * Aceita override `--tables "dbo.A,dbo.B Z"` se a lista default não
 * coincidir com o que a versão local do Softreis tem.
 *
 * Auto-discovery: além das tabelas default, procura via sys.tables por
 * vários patterns (compra, recep, entrada, devol, fornec, fact, nota,
 * aquisi, movimento) para apanhar variantes que escapem à lista fixa.
 *
 * Output:
 *   · stdout — sumário compacto por tabela + alertas
 *   · ficheiro markdown `<outputDir>/compras-schema-<YYYY-MM-DD>/inspection.md`
 *     com tudo: classificação de colunas por papel (produto/fornec/
 *     documento/quantidade/preço/data/tipo), hipótese de mapping, e
 *     perguntas para o operador SPharm responder.
 *
 * Garantias:
 *   · SQL login só precisa de db_datareader — apenas SELECT em sys.*
 *     e SELECT TOP 5 nas tabelas alvo
 *   · Zero alterações ao SPharm
 *   · TOP 5 pode conter dados operacionais (designações, fornecedores,
 *     CNPs vendidos). Operador valida antes de partilhar inspection.md.
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

// Lista default de candidatos. Após rev22 ter corrido contra um
// Softreis real (Cotovia, 2026-05-15), confirmámos os nomes reais
// das tabelas — singulares portugueses, não plurais. O FK declarado
// `dbo.Recepcao(Fornecedor ID) → dbo.Fornecedores(Fornecedor ID)` e
// `dbo.Devolucao(Fornecedor ID) → dbo.Fornecedores(Fornecedor ID)`
// validam que estas são as tabelas operacionais.
//
// Operador pode override com --tables se a versão dele usar nomes
// diferentes.
const DEFAULT_CANDIDATES = [
  // ─── Compras / Recepção (header + linhas + satélites) ──────────────
  "dbo.Recepcao",                              // header da recepção (FK → Fornecedores)
  "dbo.Recepcao Detalhe",                      // linhas (pattern Softreis: nome com espaço)
  "dbo.Recepcao Detalhe_Precos",               // satélite: detalhe de preços/PVP por linha
  "dbo.Recepcao Detalhe_DeliveryNoteDetail",   // satélite: link a guia de remessa
  "dbo.Recepcao DetalheDescN",                 // satélite: descontos tipo N
  "dbo.Recepcao_Anulados",                     // recepções canceladas (filtrar para excluir)
  "dbo.RecepcaoSituacao",                      // lookup de estados da recepção
  "dbo.Recepcao_Encomenda",                    // link: recepção ↔ encomenda originária

  // ─── Devoluções a fornecedor (header + linhas + workflow) ──────────
  "dbo.Devolucao",                             // header (FK → Fornecedores) — SEMPRE a fornecedor
  "dbo.Devolucao Detalhe",                     // linhas (FK CodigoID → Stocks)
  "dbo.Devolucao Detalhe_Recepcao Detalhe",    // link: linha devolução ↔ linha recepção origem
  "dbo.Devolucao_Anulados",                    // devoluções canceladas (filtrar para excluir)
  "dbo.Devolucao_Situacao",                    // lookup de estados da devolução
  "dbo.Devolucao_Resolucao",                   // workflow: resolução pelo fornecedor (NC recebida)

  // ─── Lookups ────────────────────────────────────────────────────────
  "dbo.MotivosDevolucaoRec",                   // códigos de motivo de devolução
  "dbo.Tbl_Tipo_Fornecedores",                 // categorias de fornecedor
];

// Patterns para auto-discovery em sys.tables. Cada pattern é uma
// substring case-insensitive. Excluímos "encomenda" porque já tem o
// seu próprio comando (inspect-orders-schema) — o domínio aqui é
// recepção/compra/devolução, não encomenda enviada.
const DISCOVERY_PATTERNS = [
  "compra",
  "recep",   // recepção / recepcao
  "entrada", // entradas, movimentoentrada, notasentrada
  "devol",   // devolucao / devolução
  "fornec",  // fornecedor / fornecedores
  "fact",    // factura / fatura
  "nota",    // notasentrada, notasdevolucao
  "aquisi",  // aquisição / aquisicoes
  "moviment", // movimentos (genérico — apanha StocksMov etc.)
];

const RULE = "─".repeat(72);

// ── Heurística de classificação de colunas por papel ─────────────────
//
// Cada papel tem uma lista de needles (substrings lowercase) que
// procuramos no nome da coluna. Ordem importa: needles mais específicas
// primeiro (codigoid antes de codigo).

type ColumnRole =
  | "produto"
  | "fornecedor"
  | "documento"
  | "quantidade"
  | "preco_custo"
  | "data"
  | "tipo_movimento"
  | "farmacia_filial";

const ROLE_NEEDLES: Record<ColumnRole, string[]> = {
  produto: ["codigoid", "codigo_artigo", "codigoartigo", "codartigo", "cnp", "cnan", "codnac", "ean", "barras"],
  fornecedor: ["fornecedor", "fornec", "supplier", "vendor"],
  documento: ["numdoc", "ndocumento", "ndoc", "n_doc", "numerodoc", "numero", "factur", "fatura", "guia"],
  quantidade: ["quantid", "qtde", "qtd"],
  preco_custo: ["pcusto", "pcu", "preco_cust", "precocust", "preco_compra", "custo", "pvp_compra", "pvp", "preco_unit", "precounit", "valor"],
  data: ["datalanc", "datareg", "dataemis", "datacomp", "datareceb", "dataentr", "datadoc", "dataf", "data"],
  tipo_movimento: ["tipodoc", "tipodocum", "tipoent", "tipoentrada", "tipomov", "tipo"],
  farmacia_filial: ["filial", "loja", "armazem", "armazémd", "delegacao"],
};

const ROLE_LABEL: Record<ColumnRole, string> = {
  produto: "Produto/CNP/CodigoID",
  fornecedor: "Fornecedor",
  documento: "Documento/Nº",
  quantidade: "Quantidade",
  preco_custo: "Preço/Custo/Valor",
  data: "Data",
  tipo_movimento: "Tipo movimento/doc",
  farmacia_filial: "Farmácia/Filial/Armazém",
};

function classifyByRole(cols: ColumnMeta[]): Record<ColumnRole, ColumnMeta[]> {
  const result: Record<ColumnRole, ColumnMeta[]> = {
    produto: [],
    fornecedor: [],
    documento: [],
    quantidade: [],
    preco_custo: [],
    data: [],
    tipo_movimento: [],
    farmacia_filial: [],
  };
  for (const c of cols) {
    const lower = c.name.toLowerCase();
    for (const role of Object.keys(ROLE_NEEDLES) as ColumnRole[]) {
      const needles = ROLE_NEEDLES[role];
      if (needles.some((n) => lower.includes(n))) {
        result[role].push(c);
      }
    }
  }
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────

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
  console.log("Uso: inspect-compras-schema [--tables \"dbo.A,dbo.B Z\"]");
  console.log("");
  console.log("Probe READ-ONLY ao schema das tabelas de compras + devoluções a");
  console.log("fornecedor no SPharm ERP local. Sem --tables, usa a lista default:");
  for (const c of DEFAULT_CANDIDATES) console.log(`  · ${c}`);
  console.log("");
  console.log("Auto-discovery por sys.tables:");
  for (const p of DISCOVERY_PATTERNS) console.log(`  · LIKE %${p}%`);
  console.log("");
  console.log("Output: stdout summary + ficheiro markdown em");
  console.log("  <outputDir>/compras-schema-<YYYY-MM-DD>/inspection.md");
  console.log("");
  console.log("Garantias: read-only, db_datareader, TOP 5 amostras.");
}

// ── Probe data ───────────────────────────────────────────────────────

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
  rolesByCol?: Record<ColumnRole, ColumnMeta[]>;
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
  probe.rolesByCol = classifyByRole(cols);

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
 * Auto-discovery: para cada pattern, procura tabelas user-defined com a
 * substring no nome. Devolve união ordenada (sem duplicados).
 */
async function findVariants(pool: SqlPool, patterns: string[]): Promise<string[]> {
  const set = new Set<string>();
  for (const p of patterns) {
    const r = await pool
      .request()
      .input("pattern", sql.NVarChar, `%${p}%`)
      .query<{ schema_name: string; table_name: string }>(`
        SELECT s.name AS schema_name, t.name AS table_name
        FROM sys.tables t
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE t.is_ms_shipped = 0
          AND LOWER(t.name) LIKE @pattern
      `);
    for (const row of r.recordset) set.add(`${row.schema_name}.${row.table_name}`);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ── Hipótese de mapping (heurística sobre os probes) ─────────────────

type MappingHypothesis = {
  comprasHeader: string | null;
  comprasLinhas: string | null;
  devolucoesFornecedor: string | null;
  fornecedores: string | null;
  stocksProdutoKey: { table: string; column: string } | null;
  notes: string[];
};

function buildHypothesis(probes: Map<string, TableProbe>): MappingHypothesis {
  const existing = Array.from(probes.values()).filter((p) => p.exists);
  const notes: string[] = [];

  function findByNameContains(needle: string): TableProbe | null {
    return existing.find((p) => p.table.toLowerCase().includes(needle)) ?? null;
  }
  function findFirstMatching(predicate: (p: TableProbe) => boolean): TableProbe | null {
    return existing.find(predicate) ?? null;
  }

  // Compras header: tabela com nome ~"compra"/"recep"/"factura"/"aquisi"
  // que NÃO seja claramente "detalhe"/"linha"/"item" (essas são linhas).
  let comprasHeader =
    findFirstMatching((p) => {
      const n = p.table.toLowerCase();
      const isHeader = (n.includes("compra") || n.includes("recep") || n.includes("factura") ||
                        n.includes("fatura") || n.includes("aquisi") || n.includes("entrada")) &&
                       !n.includes("detal") && !n.includes("linha") && !n.includes("item") &&
                       !n.includes("mov");
      return isHeader;
    });
  // Compras linhas: tabela com "compra"+"detalhe" ou "recep"+"detalhe"
  let comprasLinhas =
    findFirstMatching((p) => {
      const n = p.table.toLowerCase();
      const isLine = (n.includes("compra") || n.includes("recep") || n.includes("entrada")) &&
                     (n.includes("detal") || n.includes("linha") || n.includes("item"));
      return isLine;
    });

  // Devoluções a fornecedor: pode ser tabela dedicada OU campo num genérico
  let devolucoesFornecedor =
    findByNameContains("devolfornec") ??
    findByNameContains("devolucoes_fornec") ??
    findFirstMatching((p) => {
      const n = p.table.toLowerCase();
      return n.includes("devol") && n.includes("fornec");
    }) ??
    findByNameContains("devol"); // genérico — pode ter campo tipo
  if (devolucoesFornecedor && !devolucoesFornecedor.table.toLowerCase().includes("fornec")) {
    notes.push(
      `Tabela "${devolucoesFornecedor.fullName}" parece ser de devoluções genéricas — ` +
        `pode misturar clientes e fornecedores. Procurar coluna 'tipo' / 'destino' para filtrar.`
    );
  }

  // Fornecedores
  const fornecedores =
    findByNameContains("fornecedor") ??
    findByNameContains("supplier") ??
    null;

  // Stocks produto key (lookup CodigoID/CNP)
  const stocks = probes.get("dbo.Stocks");
  let stocksProdutoKey: { table: string; column: string } | null = null;
  if (stocks?.columns) {
    // Procura coluna candidata para CNP/CodigoID
    for (const needle of ["codigoid", "cnp", "codigoartigo", "codartigo"]) {
      const col = stocks.columns.find((c) => c.name.toLowerCase().includes(needle));
      if (col) {
        stocksProdutoKey = { table: "dbo.Stocks", column: col.name };
        break;
      }
    }
  }

  if (!comprasHeader) {
    notes.push(
      "Não consegui inferir tabela header de compras. Operador precisa de indicar manualmente " +
        "qual a tabela onde aparecem novas recepções/facturas. Ver lista de variants no auto-discovery."
    );
  }
  if (comprasHeader && !comprasLinhas) {
    notes.push(
      `Identifiquei header (\`${comprasHeader.fullName}\`) mas não encontrei a tabela de linhas. ` +
        "Pode ser que header já contenha linhas (compras agregadas), ou a tabela tem nome não-óbvio."
    );
  }
  if (!devolucoesFornecedor) {
    notes.push(
      "Não consegui inferir tabela de devoluções a fornecedor. Pode estar dentro de uma tabela genérica " +
        "de movimentos (dbo.StocksMov com tipo de movimento) ou nem existir como tabela dedicada."
    );
  }
  if (!fornecedores) {
    notes.push("Não consegui inferir tabela de fornecedores. Operador deve confirmar.");
  }
  if (!stocksProdutoKey) {
    notes.push(
      "Não consegui inferir coluna de produto em dbo.Stocks. Necessário para fazer lookup CNP → ID interno " +
        "ao agregar compras. Re-correr inspect-product-identifiers.bat se necessário."
    );
  }

  return {
    comprasHeader: comprasHeader?.fullName ?? null,
    comprasLinhas: comprasLinhas?.fullName ?? null,
    devolucoesFornecedor: devolucoesFornecedor?.fullName ?? null,
    fornecedores: fornecedores?.fullName ?? null,
    stocksProdutoKey,
    notes,
  };
}

// ── Markdown render ──────────────────────────────────────────────────

function renderMarkdown(
  cfg: AgentConfig,
  probes: Map<string, TableProbe>,
  variants: string[],
  inputCandidates: string[],
  hypothesis: MappingHypothesis
): string {
  const lines: string[] = [];
  const now = new Date();
  lines.push("# SPharm ERP — Schema de Compras e Devoluções a Fornecedor");
  lines.push("");
  lines.push(`- **Capturado em**: ${now.toISOString()}`);
  lines.push(`- **Database**: \`${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}\``);
  lines.push(`- **Agent rev**: ${process.env.AGENT_REV ?? "?"}`);
  lines.push("");
  lines.push("Probe **read-only** (db_datareader). Nenhuma escrita no SPharm. Nada enviado para a SaaS.");
  lines.push("");
  lines.push("Este documento serve para o **operador SPharm validar** o mapping das tabelas reais");
  lines.push("antes do admin SPharm.MT desenhar as Fases 1-6 (staging, ingest, agent extract,");
  lines.push("aggregation, daily-pipeline, validação) que vão alimentar `Compra` e `Devolucao` na SaaS.");
  lines.push("");

  // ── 1. Resumo ───────────────────────────────────────────────────
  lines.push("## 1. Resumo das tabelas candidatas default");
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

  // ── 2. Variantes detectadas por auto-discovery ──────────────────
  lines.push("## 2. Auto-discovery por sys.tables");
  lines.push("");
  lines.push("Patterns procurados:");
  for (const p of DISCOVERY_PATTERNS) lines.push(`- \`LIKE %${p}%\``);
  lines.push("");
  if (variants.length === 0) {
    lines.push("> Nenhuma variante detectada além das candidatas default acima.");
    lines.push("");
  } else {
    lines.push(`Detectadas **${variants.length}** tabelas com match em qualquer um dos patterns:`);
    lines.push("");
    for (const v of variants) {
      const tagged = inputCandidates.includes(v) ? " *(já na lista default)*" : " ⚡ *fora da default*";
      lines.push(`- \`${v}\`${tagged}`);
    }
    lines.push("");
    const offDefault = variants.filter((v) => !inputCandidates.includes(v));
    if (offDefault.length > 0) {
      lines.push("**Variantes fora da default** — operador deve indicar qual destas é relevante.");
      lines.push("Para inspeccionar uma destas adicionalmente:");
      lines.push("");
      lines.push("```");
      lines.push(`run-inspect-compras-schema.bat`);
      lines.push(`# ou directo:`);
      lines.push(`node.exe agent.cjs inspect-compras-schema --tables "${offDefault.slice(0, 3).join(",")}"`);
      lines.push("```");
      lines.push("");
    }
  }

  // ── 3. Detalhe por tabela ───────────────────────────────────────
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

    // Heurística por papel
    if (p.rolesByCol) {
      const rolesUsed = (Object.keys(p.rolesByCol) as ColumnRole[]).filter((r) => p.rolesByCol![r].length > 0);
      if (rolesUsed.length > 0) {
        lines.push("**Colunas com papel inferido:**");
        lines.push("");
        lines.push("| Papel | Colunas detectadas |");
        lines.push("|---|---|");
        for (const role of rolesUsed) {
          const colNames = p.rolesByCol[role].map((c) => `\`${c.name}\` (${renderColumnType(c)})`).join(", ");
          lines.push(`| ${ROLE_LABEL[role]} | ${colNames} |`);
        }
        lines.push("");
      }
    }

    // Colunas completas
    lines.push("**Colunas completas:**");
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
    } else if (p.exists) {
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

    // Datas
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

    // Amostras
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

  // ── 4. Hipótese de mapping ──────────────────────────────────────
  lines.push("## 4. Hipótese de mapping (heurística — VALIDAR com operador)");
  lines.push("");
  lines.push("Esta secção é **inferida** a partir dos nomes de tabela e papéis de colunas.");
  lines.push("O operador SPharm deve confirmar tudo antes de qualquer Fase 1+ avançar.");
  lines.push("");
  lines.push("| Domínio | Tabela provável | Confiança |");
  lines.push("|---|---|---|");
  lines.push(`| Compras — header (1 doc por recepção/factura) | ${hypothesis.comprasHeader ? "`" + hypothesis.comprasHeader + "`" : "**(não inferido)**"} | ${hypothesis.comprasHeader ? "média" : "—"} |`);
  lines.push(`| Compras — linhas (1 linha por produto+doc) | ${hypothesis.comprasLinhas ? "`" + hypothesis.comprasLinhas + "`" : "**(não inferido)**"} | ${hypothesis.comprasLinhas ? "média" : "—"} |`);
  lines.push(`| Devoluções a fornecedor | ${hypothesis.devolucoesFornecedor ? "`" + hypothesis.devolucoesFornecedor + "`" : "**(não inferido)**"} | ${hypothesis.devolucoesFornecedor ? "baixa" : "—"} |`);
  lines.push(`| Master de fornecedores | ${hypothesis.fornecedores ? "`" + hypothesis.fornecedores + "`" : "**(não inferido)**"} | ${hypothesis.fornecedores ? "alta" : "—"} |`);
  lines.push(`| Lookup de produto (PK em Stocks) | ${hypothesis.stocksProdutoKey ? "`" + hypothesis.stocksProdutoKey.table + "." + hypothesis.stocksProdutoKey.column + "`" : "**(não inferido)**"} | ${hypothesis.stocksProdutoKey ? "alta" : "—"} |`);
  lines.push("");

  if (hypothesis.notes.length > 0) {
    lines.push("**Notas e ressalvas:**");
    lines.push("");
    for (const n of hypothesis.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  lines.push("### Chaves prováveis (para idempotência)");
  lines.push("");
  lines.push("Padrão dos outros pipelines (sales-lines): `(farmaciaId, externalDocumentId, externalLineId)`.");
  lines.push("Aqui o equivalente provável é o par `(header.PK, linha.LinhaID/Sequencia)` — operador confirma.");
  lines.push("");

  lines.push("### Campos obrigatórios para `Compra` (Prisma SaaS)");
  lines.push("");
  lines.push("Do schema [prisma/schema.prisma](../../../../prisma/schema.prisma#L850):");
  lines.push("");
  lines.push("| Campo SaaS | Mapping provável SPharm | Confirmar? |");
  lines.push("|---|---|---|");
  lines.push("| `farmaciaId` | (resolvido server-side via tenant) | n/a |");
  lines.push("| `produtoId` | Lookup `Stocks.CodigoID` (ou coluna equivalente) → resolução server-side via `Produto.externalProductId` | ✅ confirmar coluna lookup |");
  lines.push("| `fornecedorId` | header.FornecedorID (FK para Fornecedores) | ✅ confirmar coluna |");
  lines.push("| `data` | header.DataRecepcao OU header.DataDoc OU linha.Data | ✅ confirmar semântica |");
  lines.push("| `quantidade` | linha.Quantidade | ✅ confirmar coluna |");
  lines.push("| `valorTotal` | linha.ValorTotal OU (Quantidade × PrecoCusto) | ✅ confirmar fórmula |");
  lines.push("| `precoUnitario` | linha.PrecoCusto | ✅ confirmar coluna |");
  lines.push("| `descontoBonificacao` | linha.Desconto OU linha.Bonificacao | ✅ opcional |");
  lines.push("| `numeroDocumento` | header.NumDocumento OU header.NFactura | ✅ confirmar coluna |");
  lines.push("");

  lines.push("### Campos obrigatórios para `Devolucao` (tipo=FORNECEDOR)");
  lines.push("");
  lines.push("Do schema [prisma/schema.prisma](../../../../prisma/schema.prisma#L878):");
  lines.push("");
  lines.push("| Campo SaaS | Mapping provável SPharm |");
  lines.push("|---|---|");
  lines.push("| `tipo` | Constante `FORNECEDOR` para todas as rows desta tabela |");
  lines.push("| `produtoId` | linha.CodigoID → `Produto.externalProductId` |");
  lines.push("| `fornecedorDestinoId` | header.FornecedorID |");
  lines.push("| `data` | header.DataDevolucao |");
  lines.push("| `quantidade` | linha.Quantidade |");
  lines.push("| `valor` | linha.ValorTotal |");
  lines.push("| `motivo` | header.Motivo (se existir) |");
  lines.push("");

  // ── 5. Perguntas para o operador ────────────────────────────────
  lines.push("## 5. Perguntas para o operador SPharm");
  lines.push("");
  lines.push("Por favor responder em texto livre — vai informar o desenho das Fases 1-6.");
  lines.push("");
  lines.push("### Sobre compras / recepções");
  lines.push("");
  lines.push("1. **Onde aparecem compras no SPharm UI?**");
  lines.push("   (que menu / ecrã o operador da farmácia abre para ver recepções de mercadoria recebida hoje)");
  lines.push("");
  lines.push("2. **Que documento representa a recepção de mercadoria?**");
  lines.push("   - Recepção contra encomenda?");
  lines.push("   - Factura de fornecedor?");
  lines.push("   - Guia de remessa?");
  lines.push("   - Nota de entrada?");
  lines.push("   - Mais que um destes — qual é o que conta para stock?");
  lines.push("");
  lines.push("3. **Existe distinção entre factura, guia, encomenda recebida?**");
  lines.push("   - A mesma mercadoria pode aparecer em vários documentos?");
  lines.push("   - Qual é o documento canónico para reporting de compras (o que faz mexer stock)?");
  lines.push("");
  lines.push("4. **Há números de série/lote por linha de compra?**");
  lines.push("   (não é obrigatório para o MVP, mas se sim a Fase 1 staging deve guardar)");
  lines.push("");
  lines.push("### Sobre devoluções a fornecedor");
  lines.push("");
  lines.push("5. **Onde aparecem devoluções a fornecedor no SPharm UI?**");
  lines.push("");
  lines.push("6. **Tem tabela própria ou está misturado com devoluções de cliente?**");
  lines.push("   Se misturado: que coluna distingue cliente vs fornecedor?");
  lines.push("");
  lines.push("7. **Estados/motivos comuns** (expirado, danificado, recall, etc.) — alguma codificação?");
  lines.push("");
  lines.push("### Sobre fornecedores");
  lines.push("");
  lines.push("8. **A tabela de fornecedores tem várias entries para o mesmo fornecedor real?**");
  lines.push("   (ex: \"Alliance\", \"ALLIANCE HEALTHCARE\", \"Alliance Healthcare, S.A.\")");
  lines.push("   - Há um nome canónico, ou só os ID interno são únicos?");
  lines.push("");
  lines.push("9. **Há fornecedores que aparecem em compras mas não estão na tabela mestre?**");
  lines.push("   (ex: importações directas, ad-hoc — FK relaxada)");
  lines.push("");
  lines.push("### Para validação smoke (Fase 6)");
  lines.push("");
  lines.push("10. **Que fornecedor real podemos usar para os primeiros testes?**");
  lines.push("    (nome legível + ID interno se possível)");
  lines.push("");
  lines.push("11. **Que CNP/CodigoID real podemos usar?**");
  lines.push("    Recomendado: um produto que tenha tido recepção recente e que o operador consiga validar visualmente.");
  lines.push("");
  lines.push("12. **Janela temporal que faz sentido para o backfill inicial?**");
  lines.push("    (ex: \"compras dos últimos 30 dias\", \"todo 2026\", \"desde data X\")");
  lines.push("");

  // ── 6. Próximos passos ──────────────────────────────────────────
  lines.push("## 6. Próximos passos");
  lines.push("");
  lines.push("1. Operador SPharm revê secções 3-4 (tabelas + hipótese) e responde às perguntas da secção 5.");
  lines.push("2. Admin SPharm.MT recebe o `inspection.md` + respostas e decide entre:");
  lines.push("   - Avançar para Fase 1 (staging Prisma + endpoints + agent extract).");
  lines.push("   - Re-correr `inspect-compras-schema --tables \"...\"` com lista refinada se houver tabelas relevantes fora da default.");
  lines.push("3. Até validação completa, **nada é escrito** na SaaS — `Compra` e `Devolucao` continuam vazias.");
  lines.push("");

  return lines.join("\n");
}

function renderStdout(probes: Map<string, TableProbe>, inputCandidates: string[], hypothesis: MappingHypothesis): string {
  const lines: string[] = [];
  lines.push(RULE);
  lines.push("inspect-compras-schema — sumário");
  lines.push(RULE);
  lines.push("");
  for (const fullName of inputCandidates) {
    const p = probes.get(fullName);
    if (!p) continue;
    if (!p.exists) {
      lines.push(`  ✗ ${fullName.padEnd(36)} não existe`);
      continue;
    }
    const pkStr = p.primaryKey && p.primaryKey.length > 0 ? p.primaryKey.join(",") : "—";
    const roleHits = p.rolesByCol
      ? (Object.keys(p.rolesByCol) as ColumnRole[]).filter((r) => p.rolesByCol![r].length > 0).length
      : 0;
    lines.push(
      `  ✓ ${fullName.padEnd(36)} ${String(p.rowCount).padStart(8)} rows · ` +
        `${p.columns?.length ?? 0} cols · PK=${pkStr} · roles=${roleHits}`
    );
  }
  lines.push("");
  lines.push("Hipótese de mapping (heurística):");
  lines.push(`  compras header     : ${hypothesis.comprasHeader ?? "(não inferido)"}`);
  lines.push(`  compras linhas     : ${hypothesis.comprasLinhas ?? "(não inferido)"}`);
  lines.push(`  devol. fornecedor  : ${hypothesis.devolucoesFornecedor ?? "(não inferido)"}`);
  lines.push(`  fornecedores       : ${hypothesis.fornecedores ?? "(não inferido)"}`);
  lines.push(`  produto lookup     : ${hypothesis.stocksProdutoKey ? hypothesis.stocksProdutoKey.table + "." + hypothesis.stocksProdutoKey.column : "(não inferido)"}`);
  if (hypothesis.notes.length > 0) {
    lines.push("");
    lines.push("Avisos:");
    for (const n of hypothesis.notes) lines.push(`  ⚠ ${n}`);
  }
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────

export async function inspectComprasSchema(): Promise<number> {
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
  console.log("inspect-compras-schema");
  console.log(RULE);
  console.log(`Database  : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Candidatos: ${inputCandidates.length}`);
  for (const c of inputCandidates) console.log(`  · ${c}`);
  console.log("");
  console.log("Auto-discovery patterns:");
  for (const p of DISCOVERY_PATTERNS) console.log(`  · LIKE %${p}%`);
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
      console.log("▶ auto-discovery: sys.tables LIKE patterns ...");
      let variants: string[];
      try {
        variants = await findVariants(pool, DISCOVERY_PATTERNS);
        console.log(`  ${variants.length} tabela(s) detectada(s) (união de ${DISCOVERY_PATTERNS.length} patterns)`);
      } catch (err) {
        console.error(`  ✗ falhou: ${err instanceof Error ? err.message : String(err)}`);
        variants = [];
      }
      console.log("");

      const hypothesis = buildHypothesis(probes);
      console.log(renderStdout(probes, inputCandidates, hypothesis));
      console.log("");

      const outDir = path.resolve(cfg.outputDir, `compras-schema-${ymd(new Date())}`);
      fs.mkdirSync(outDir, { recursive: true });
      const mdPath = path.resolve(outDir, "inspection.md");
      const md = renderMarkdown(cfg, probes, variants, inputCandidates, hypothesis);
      fs.writeFileSync(mdPath, md, "utf8");

      console.log(RULE);
      console.log(`Markdown completo: ${mdPath}`);
      console.log(RULE);
      console.log("Próximo passo:");
      console.log("  1. Rever as secções 3 (detalhe) e 4 (hipótese de mapping).");
      console.log("  2. Responder às perguntas da secção 5 (operador SPharm).");
      console.log("  3. Enviar ao admin SPharm.MT.");
      console.log("");
      console.log("Até validação operacional, nada vai ser escrito na SaaS para Compra/Devolucao.");
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha na inspecção:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
