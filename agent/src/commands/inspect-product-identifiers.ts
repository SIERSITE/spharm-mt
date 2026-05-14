/**
 * agent/src/commands/inspect-product-identifiers.ts
 *
 * Probe READ-ONLY para identificar a coluna em `dbo.Stocks` que contém
 * o CNP individual do produto (necessário para mapear linhas SaaS →
 * SPharm em `ordersWriteMode=insert`).
 *
 * Contexto: `CodCNPEM` foi inicialmente assumido como CNP. Operador
 * confirmou que NÃO é — é Código Nacional Para Equivalência
 * Medicamentosa (grupo homogéneo). Múltiplos produtos partilham o
 * mesmo CodCNPEM. Lookup baseado em CodCNPEM matcha produto ERRADO.
 *
 * Este comando:
 *   1. Lista todas as colunas de `dbo.Stocks` cujo nome contém:
 *      cnp, codigo, cnpem, barras, ean (case-insensitive)
 *   2. Para cada uma, mostra tipo + nullability
 *   3. Para cada CNP de teste (lista default ou --cnps CSV), tenta
 *      match em cada coluna candidata (com fallback para versão
 *      zero-padded em colunas char/varchar)
 *   4. Imprime resumo: qual coluna deu match em todos os CNPs de teste
 *   5. Persiste markdown em <outputDir>/product-identifiers-<data>/
 *
 * Tudo read-only. Nenhuma escrita. Nada enviado para a SaaS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";

const DEFAULT_TEST_CNPS = ["6433359", "5771464", "9754119", "8070409"];

const PATTERNS = ["%cnp%", "%codigo%", "%cnpem%", "%barras%", "%ean%"] as const;

const NUMERIC_TYPES = new Set([
  "int",
  "smallint",
  "bigint",
  "tinyint",
  "numeric",
  "decimal",
  "money",
  "smallmoney",
]);

const STRING_TYPES = new Set([
  "char",
  "varchar",
  "nchar",
  "nvarchar",
  "text",
  "ntext",
]);

type TypeFamily = "numeric" | "string" | "other";

function classifyType(dataType: string): TypeFamily {
  const t = dataType.toLowerCase();
  if (NUMERIC_TYPES.has(t)) return "numeric";
  if (STRING_TYPES.has(t)) return "string";
  return "other";
}

type CandidateColumn = {
  name: string;
  dataType: string;
  maxLength: number;
  isNullable: boolean;
  typeFamily: TypeFamily;
  /** Display de tipo (incluindo length/precision). */
  typeLabel: string;
};

type MatchResult = {
  matched: boolean;
  matchCount: number;
  sampleCodigoID: number | null;
  sampleNome: string | null;
  sampleValue: string | null;
  variantUsed: "raw" | "padded" | null;
  error?: string;
};

const RULE = "─".repeat(78);

type Args = {
  cnps: string[];
  help?: boolean;
};

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      cnps: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  const csv = typeof raw.values.cnps === "string" ? raw.values.cnps : "";
  const cnps = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    cnps: cnps.length > 0 ? cnps : [...DEFAULT_TEST_CNPS],
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: inspect-product-identifiers [--cnps \"6433359,5771464,...\"]");
  console.log("");
  console.log("Probe read-only para identificar a coluna em dbo.Stocks que contém o CNP.");
  console.log("Por defeito testa 4 CNPs conhecidos:");
  for (const c of DEFAULT_TEST_CNPS) console.log(`  · ${c}`);
  console.log("");
  console.log("Output: stdout summary + markdown em");
  console.log("  <outputDir>/product-identifiers-<YYYY-MM-DD>/inspection.md");
}

async function listCandidateColumns(pool: SqlPool): Promise<CandidateColumn[]> {
  const req = pool.request();
  const whereClauses: string[] = [];
  for (let i = 0; i < PATTERNS.length; i++) {
    req.input(`p${i}`, sql.VarChar, PATTERNS[i]);
    whereClauses.push(`LOWER(c.name) LIKE @p${i}`);
  }
  const r = await req.query<{
    name: string;
    dataType: string;
    max_length: number;
    precision: number;
    scale: number;
    is_nullable: boolean;
  }>(`
    SELECT c.name AS name, ty.name AS dataType, c.max_length, c.precision, c.scale, c.is_nullable
    FROM sys.columns c
    JOIN sys.tables t ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
    WHERE s.name = 'dbo' AND t.name = 'Stocks'
      AND (${whereClauses.join(" OR ")})
    ORDER BY c.column_id
  `);
  return r.recordset.map((row) => {
    const fam = classifyType(row.dataType);
    let typeLabel = row.dataType;
    const t = row.dataType.toLowerCase();
    if (["char", "varchar", "nchar", "nvarchar"].includes(t)) {
      const len = row.max_length === -1 ? "max" : t.startsWith("n") ? Math.floor(row.max_length / 2) : row.max_length;
      typeLabel = `${row.dataType}(${len})`;
    } else if (["numeric", "decimal"].includes(t)) {
      typeLabel = `${row.dataType}(${row.precision},${row.scale})`;
    }
    return {
      name: row.name,
      dataType: row.dataType,
      maxLength: row.max_length,
      isNullable: !!row.is_nullable,
      typeFamily: fam,
      typeLabel,
    };
  });
}

async function searchCnpInColumn(
  pool: SqlPool,
  col: CandidateColumn,
  cnp: string
): Promise<MatchResult> {
  if (col.typeFamily === "other") {
    return {
      matched: false,
      matchCount: 0,
      sampleCodigoID: null,
      sampleNome: null,
      sampleValue: null,
      variantUsed: null,
      error: `tipo ${col.dataType} não-suportado para comparação directa`,
    };
  }

  // Para evitar problemas de tipo, usamos sempre CAST para NVARCHAR
  // de ambos os lados e comparamos como strings. Não aproveita índice
  // (que existiria em coluna numérica) mas com TOP 2 + 34k rows é OK
  // para um probe single-shot.
  const cnpRaw = cnp.trim();
  const cnpPadded = cnpRaw.padStart(13, "0"); // tentativa para char(13)
  try {
    const req = pool.request();
    req.input("raw", sql.NVarChar(50), cnpRaw);
    req.input("padded", sql.NVarChar(50), cnpPadded);
    const r = await req.query<{
      CodigoID: number;
      NomeComercial: string;
      ValRaw: string;
      cnt: number;
    }>(`
      SELECT TOP 2
        s.[CodigoID]                                AS CodigoID,
        s.[Nome Comercial]                          AS NomeComercial,
        LTRIM(RTRIM(CAST(s.[${col.name}] AS NVARCHAR(50)))) AS ValRaw,
        (SELECT COUNT(*) FROM [dbo].[Stocks]
           WHERE LTRIM(RTRIM(CAST([${col.name}] AS NVARCHAR(50)))) IN (@raw, @padded)) AS cnt
      FROM [dbo].[Stocks] s
      WHERE LTRIM(RTRIM(CAST(s.[${col.name}] AS NVARCHAR(50)))) IN (@raw, @padded)
    `);
    if (r.recordset.length === 0) {
      return {
        matched: false,
        matchCount: 0,
        sampleCodigoID: null,
        sampleNome: null,
        sampleValue: null,
        variantUsed: null,
      };
    }
    const top = r.recordset[0]!;
    const variantUsed: "raw" | "padded" =
      String(top.ValRaw) === cnpRaw ? "raw" : "padded";
    return {
      matched: true,
      matchCount: Number(top.cnt),
      sampleCodigoID: Number(top.CodigoID),
      sampleNome: top.NomeComercial,
      sampleValue: String(top.ValRaw),
      variantUsed,
    };
  } catch (err) {
    return {
      matched: false,
      matchCount: 0,
      sampleCodigoID: null,
      sampleNome: null,
      sampleValue: null,
      variantUsed: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getTop20Stocks(
  pool: SqlPool,
  columnNames: string[]
): Promise<Array<Record<string, unknown>>> {
  // Sempre incluímos CodigoID e Nome Comercial para contexto.
  const fixed = ["CodigoID", "Nome Comercial"];
  const all = Array.from(new Set([...fixed, ...columnNames]));
  const select = all.map((n) => `[${n}]`).join(", ");
  // ORDER BY CodigoID DESC para apanhar produtos recentes
  const r = await pool.request().query<Record<string, unknown>>(`
    SELECT TOP 20 ${select}
    FROM [dbo].[Stocks]
    ORDER BY [CodigoID] DESC
  `);
  return r.recordset;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function fmtCell(v: unknown, maxLen = 40): string {
  if (v === null || v === undefined) return "·";
  if (v instanceof Date) return v.toISOString().slice(0, 19);
  let s = String(v).replace(/\s+/g, " ");
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s;
}

function renderMarkdown(
  cfg: AgentConfig,
  candidates: CandidateColumn[],
  results: Map<string, MatchResult[]>,
  cnps: string[],
  top20: Array<Record<string, unknown>>,
  conclusion: string[]
): string {
  const lines: string[] = [];
  const now = new Date();
  lines.push("# SPharm ERP — Identificadores de produto em `dbo.Stocks`");
  lines.push("");
  lines.push(`- **Capturado em**: ${now.toISOString()}`);
  lines.push(`- **Database**: \`${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}\``);
  lines.push("");
  lines.push("Probe **read-only**. Procurar a coluna que contém o CNP individual ");
  lines.push("(NÃO o grupo homogéneo `CodCNPEM`).");
  lines.push("");

  lines.push("## 1. Colunas candidatas");
  lines.push("");
  lines.push("Critério: nome contém `cnp` OR `codigo` OR `cnpem` OR `barras` OR `ean` (case-insensitive).");
  lines.push("");
  lines.push("| # | Coluna | Tipo | Nullable | Família tipo |");
  lines.push("|---:|---|---|:-:|---|");
  candidates.forEach((c, i) => {
    lines.push(`| ${i + 1} | \`${c.name}\` | ${c.typeLabel} | ${c.isNullable ? "Y" : "N"} | ${c.typeFamily} |`);
  });
  lines.push("");

  lines.push("## 2. Match dos CNPs de teste em cada coluna");
  lines.push("");
  lines.push("Para cada CNP, tentativa de match em cada coluna candidata (com fallback ");
  lines.push("zero-padded a 13 chars para colunas string). `matchCount > 1` significa ");
  lines.push("**coluna NÃO única para o CNP** (caso típico de `CodCNPEM` — grupo homogéneo).");
  lines.push("");
  for (const cnp of cnps) {
    lines.push(`### CNP \`${cnp}\``);
    lines.push("");
    lines.push("| Coluna | Match? | Count | CodigoID | Nome Comercial | Variant |");
    lines.push("|---|:-:|---:|---:|---|---|");
    const rs = results.get(cnp) ?? [];
    rs.forEach((r, i) => {
      const c = candidates[i]!;
      if (r.error) {
        lines.push(`| \`${c.name}\` | ⚠ | — | — | \`(erro: ${r.error})\` | — |`);
      } else if (!r.matched) {
        lines.push(`| \`${c.name}\` | ✗ | 0 | — | — | — |`);
      } else {
        const flag = r.matchCount === 1 ? "✓" : `⚠ (${r.matchCount})`;
        lines.push(
          `| \`${c.name}\` | ${flag} | ${r.matchCount} | ${r.sampleCodigoID} | ${fmtCell(r.sampleNome, 50)} | ${r.variantUsed} |`
        );
      }
    });
    lines.push("");
  }

  lines.push("## 3. Conclusão automática");
  lines.push("");
  for (const c of conclusion) lines.push(`- ${c}`);
  lines.push("");
  lines.push("⚠ A conclusão automática é apenas um hint. **Operador SPharm deve validar** ");
  lines.push("manualmente que a coluna sugerida contém o CNP individual de cada produto.");
  lines.push("");

  lines.push("## 4. TOP 20 produtos mais recentes (ORDER BY CodigoID DESC)");
  lines.push("");
  lines.push("Inclui `CodigoID`, `Nome Comercial` e todas as colunas candidatas para ");
  lines.push("inspecção visual.");
  lines.push("");
  if (top20.length > 0) {
    const allCols = Array.from(
      new Set(["CodigoID", "Nome Comercial", ...candidates.map((c) => c.name)])
    );
    lines.push("| " + allCols.map((c) => `\`${c}\``).join(" | ") + " |");
    lines.push("|" + allCols.map(() => "---").join("|") + "|");
    for (const row of top20) {
      lines.push(
        "| " + allCols.map((c) => fmtCell((row as Record<string, unknown>)[c], 30)).join(" | ") + " |"
      );
    }
  }
  lines.push("");

  lines.push("## 5. Próximos passos");
  lines.push("");
  lines.push("1. Operador SPharm confirma a coluna correcta com base em §2 + §3.");
  lines.push("2. Editar `agent.config.json` → `ordersInsert.productLookupColumn = \"<nome>\"`.");
  lines.push("3. Correr `run-test-order-write.bat` em DRY-RUN com CNP real.");
  lines.push("4. **NUNCA configurar `productLookupColumn` como `CodCNPEM`** — é grupo");
  lines.push("   homogéneo, identifica grupos de produtos equivalentes, não produtos individuais.");
  return lines.join("\n");
}

function computeConclusion(
  candidates: CandidateColumn[],
  results: Map<string, MatchResult[]>,
  cnps: string[]
): { sentences: string[]; suggested: string | null } {
  const sentences: string[] = [];
  // Para cada coluna, ver em quantos CNPs deu match com count==1 (único)
  type Score = { uniqueMatches: number; ambiguousMatches: number; noMatches: number };
  const scores = new Map<string, Score>();
  for (const c of candidates) {
    scores.set(c.name, { uniqueMatches: 0, ambiguousMatches: 0, noMatches: 0 });
  }
  for (const cnp of cnps) {
    const rs = results.get(cnp) ?? [];
    rs.forEach((r, i) => {
      const c = candidates[i]!;
      const s = scores.get(c.name)!;
      if (r.error || !r.matched) s.noMatches++;
      else if (r.matchCount === 1) s.uniqueMatches++;
      else s.ambiguousMatches++;
    });
  }

  // Coluna ideal: matches únicos em todos os CNPs
  const ideal = candidates.find((c) => {
    const s = scores.get(c.name)!;
    return s.uniqueMatches === cnps.length;
  });

  let suggested: string | null = null;
  if (ideal) {
    suggested = ideal.name;
    sentences.push(
      `✓ Coluna provável: \`${ideal.name}\` (${ideal.typeLabel}) — match único em todos os ${cnps.length} CNPs de teste.`
    );
  } else {
    sentences.push(
      `⚠ Nenhuma coluna deu match único em todos os ${cnps.length} CNPs de teste. Inspecção visual necessária.`
    );
    // Listar a melhor candidata se houver
    const sorted = [...candidates].sort((a, b) => {
      const sa = scores.get(a.name)!;
      const sb = scores.get(b.name)!;
      return sb.uniqueMatches - sa.uniqueMatches;
    });
    const best = sorted[0];
    if (best) {
      const s = scores.get(best.name)!;
      if (s.uniqueMatches > 0) {
        sentences.push(
          `Melhor candidata parcial: \`${best.name}\` (${s.uniqueMatches}/${cnps.length} matches únicos).`
        );
      }
    }
  }

  // Avisos sobre colunas perigosas
  for (const c of candidates) {
    const s = scores.get(c.name)!;
    if (s.ambiguousMatches > 0) {
      const lcname = c.name.toLowerCase();
      const isCnpem = lcname.includes("cnpem");
      const flag = isCnpem ? "(esperado — grupo homogéneo)" : "(suspeito — possível grupo, não produto)";
      sentences.push(
        `⚠ \`${c.name}\`: ${s.ambiguousMatches} CNP(s) com >1 match ${flag}. NÃO usar como productLookupColumn.`
      );
    }
  }

  return { sentences, suggested };
}

export async function inspectProductIdentifiers(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err);
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

  console.log(RULE);
  console.log("inspect-product-identifiers");
  console.log(RULE);
  console.log(`Database  : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`CNPs teste: ${args.cnps.join(", ")}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      console.log("▶ listing candidate columns (LIKE %cnp%/%codigo%/%cnpem%/%barras%/%ean%) ...");
      const candidates = await listCandidateColumns(pool);
      if (candidates.length === 0) {
        console.error("✗ Nenhuma coluna encontrada com os padrões. Tabela dbo.Stocks existe? Permissão sys.columns OK?");
        return 1;
      }
      console.log(`  ${candidates.length} coluna(s) candidata(s)`);
      for (const c of candidates) {
        console.log(`  · ${c.name.padEnd(22)} ${c.typeLabel.padEnd(20)} ${c.isNullable ? "NULL" : "NOT NULL"}`);
      }
      console.log("");

      // Match per CNP
      const results = new Map<string, MatchResult[]>();
      for (const cnp of args.cnps) {
        console.log(`▶ testing CNP ${cnp} ...`);
        const perCol: MatchResult[] = [];
        for (const col of candidates) {
          const r = await searchCnpInColumn(pool, col, cnp);
          perCol.push(r);
        }
        results.set(cnp, perCol);
      }
      console.log("");

      // Top 20 amostras
      console.log("▶ TOP 20 produtos recentes ...");
      const top20 = await getTop20Stocks(
        pool,
        candidates.map((c) => c.name)
      );
      console.log(`  ${top20.length} linhas`);
      console.log("");

      const { sentences, suggested } = computeConclusion(candidates, results, args.cnps);

      // ─── Stdout summary ─────────────────────────────────────────
      console.log(RULE);
      console.log("Resumo");
      console.log(RULE);
      for (const cnp of args.cnps) {
        const rs = results.get(cnp) ?? [];
        const winners = rs
          .map((r, i) => ({ r, c: candidates[i]! }))
          .filter((x) => x.r.matched && x.r.matchCount === 1);
        const ambiguous = rs
          .map((r, i) => ({ r, c: candidates[i]! }))
          .filter((x) => x.r.matched && x.r.matchCount > 1);
        console.log(`CNP ${cnp}:`);
        if (winners.length === 0 && ambiguous.length === 0) {
          console.log("  ✗ sem match em nenhuma coluna");
        }
        for (const w of winners) {
          console.log(
            `  ✓ ${w.c.name.padEnd(22)} match único → CodigoID=${w.r.sampleCodigoID} (${fmtCell(w.r.sampleNome, 40)})`
          );
        }
        for (const a of ambiguous) {
          console.log(`  ⚠ ${a.c.name.padEnd(22)} match ambíguo: ${a.r.matchCount} produtos`);
        }
      }
      console.log("");
      for (const s of sentences) console.log(s);
      console.log("");
      if (suggested) {
        console.log(`Recomendação automática: productLookupColumn = "${suggested}"`);
        console.log("(operador SPharm valida antes de configurar)");
      }
      console.log("");

      // Markdown
      const outDir = path.resolve(cfg.outputDir, `product-identifiers-${ymd(new Date())}`);
      fs.mkdirSync(outDir, { recursive: true });
      const mdPath = path.resolve(outDir, "inspection.md");
      fs.writeFileSync(
        mdPath,
        renderMarkdown(cfg, candidates, results, args.cnps, top20, sentences),
        "utf8"
      );
      console.log(RULE);
      console.log(`Markdown completo: ${mdPath}`);
      console.log(RULE);
      return 0;
    });
  } catch (err) {
    console.error("✗ Falha na inspecção:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
