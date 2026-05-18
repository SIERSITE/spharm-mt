/**
 * agent/src/commands/discover-products.ts
 *
 * Probe read-only sobre a tabela mestre de **artigos / produtos** do
 * SPharm ERP. Operacionaliza o §3.1 do mapping canónico em
 * `docs/spharm-erp-canonical-mapping.md`.
 *
 * Garantias:
 *   · Read-only — apenas `sys.*` + `SELECT TOP 5` na tabela alvo.
 *   · Compatibilidade SQL Server 2008 R2.
 *   · TOP 5 linhas, sem `OFFSET/FETCH`.
 *   · Sem persistência — stdout apenas.
 *   · Sem ORM. SQL explícito, identifiers validados antes de
 *     interpolação.
 *
 * Uso:
 *   npm run discover-products
 *   npm run discover-products -- --table dbo.Artigo
 */

import { parseArgs } from "node:util";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import {
  parseTableArg,
  printCandidateHint,
  assertTableExists,
  listColumns,
  estimateRowCount,
  classifyColumns,
  renderColumnType,
  renderSampleVertical,
  type FieldHint,
  type ParsedTableArg,
} from "./probe-helpers.js";

const PRODUCT_HINTS: FieldHint[] = [
  // Specific needles primeiro para o `break` da classifyColumns escolher o melhor match
  { field: "cnp", needles: ["codcnp", "codnacional", "codnac", "cnp"], expect: ["int"] },
  { field: "designacao", needles: ["designac", "descric", "nomeartigo", "nomeprod", "nome"], expect: ["string"] },
  { field: "pvp", needles: ["pvprec", "precovenda", "pvp"], expect: ["decimal"] },
  { field: "pmc", needles: ["precomedio", "pcmedio", "pmc"], expect: ["decimal"] },
  { field: "puc", needles: ["precoultima", "precoult", "ultcompra", "puc"], expect: ["decimal"] },
  { field: "stockAtual", needles: ["stockactual", "stkactual", "existencia", "qtdstock", "stockatual"], expect: ["decimal", "int"] },
  { field: "stockMinimo", needles: ["stockmin", "stkmin", "qtdmin"], expect: ["decimal", "int"] },
  { field: "stockMaximo", needles: ["stockmax", "stkmax", "qtdmax"], expect: ["decimal", "int"] },
  { field: "fabricante", needles: ["titular", "fabricant", "laborator", "marca"], expect: ["string"] },
  { field: "codigoATC", needles: ["codatc", "atc"], expect: ["string"] },
  { field: "dci", needles: ["principioactivo", "subactiva", "dci"], expect: ["string"] },
  { field: "formaFarmaceutica", needles: ["formafarm", "forma"], expect: ["string"] },
  { field: "dosagem", needles: ["dosag"], expect: ["string"] },
  { field: "embalagem", needles: ["embalagem", "unidades"], expect: ["string", "int", "decimal"] },
  { field: "flagMSRM", needles: ["msrm", "receita"], expect: ["string", "bool", "int"] },
  { field: "flagGenerico", needles: ["generico"], expect: ["string", "bool", "int"] },
  { field: "tipoArtigo", needles: ["tipoartigo", "tipoart", "familia"], expect: ["string", "int"] },
];

const RULE = "─".repeat(70);

type Args = { table?: string; help?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      table: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    table: typeof raw.values.table === "string" ? raw.values.table : undefined,
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: discover-products --table <schema>.<tabela>");
  console.log("");
  console.log("Exemplos:");
  console.log('  discover-products --table dbo.Stocks');
  console.log('  discover-products --table "dbo.Artigos"');
  console.log("");
  console.log("Sem --table, mostra a lista de candidatos detectados pelo `discover`");
  console.log("(apenas hint — não auto-escolhe; a heurística falha frequentemente).");
  console.log("");
  console.log("Garantias: read-only, TOP 5, sem persistência, SQL 2008 R2.");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md");
}

export async function discoverProducts(): Promise<number> {
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

  if (!args.table) {
    console.error("✗ --table é obrigatório.");
    console.error("");
    printCandidateHint("produtos", cfg.outputDir);
    return 1;
  }

  let target: ParsedTableArg;
  try {
    target = parseTableArg(args.table);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    return await withPool(cfg, async (pool) => {
      await assertTableExists(pool, target);
      const cols = await listColumns(pool, target);
      const rowCount = await estimateRowCount(pool, target);

      // TOP 5 amostra. Identifiers já validados por IDENT_RE.
      const sampleRes = await pool
        .request()
        .query<Record<string, unknown>>(`SELECT TOP 5 * FROM [${target.schema}].[${target.table}]`);

      const classified = classifyColumns(cols, PRODUCT_HINTS);

      console.log(RULE);
      console.log(`discover-products — ${target.schema}.${target.table}`);
      console.log(RULE);
      console.log(`Database         : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
      console.log(`Row count (est.) : ${rowCount}`);
      console.log(`Colunas          : ${cols.length}`);
      console.log("");

      console.log("Colunas-chave detectadas (ERP → SPharm.MT):");
      const longest = Math.max(...classified.map((c) => c.field.length));
      let matched = 0;
      for (const c of classified) {
        const detail = c.match
          ? `${c.match.name} (${renderColumnType(c.match)})${c.match.nullable ? " null" : ""}`
          : "— não detectada";
        if (c.match) matched++;
        console.log(`  ${c.field.padEnd(longest)}  ← ${detail}`);
      }
      console.log(`  (${matched}/${classified.length} campos do mapping §3.1 detectados)`);
      console.log("");

      console.log("Lista completa de colunas:");
      const colNameWidth = Math.min(40, Math.max(...cols.map((c) => c.name.length)));
      for (const c of cols) {
        const t = renderColumnType(c);
        const n = c.nullable ? "Y" : "N";
        console.log(`  ${c.name.padEnd(colNameWidth)}  ${t.padEnd(22)}  null=${n}`);
      }
      console.log("");

      console.log(`TOP 5 amostras (${sampleRes.recordset.length} linhas):`);
      console.log(renderSampleVertical(sampleRes.recordset, cols));
      console.log(RULE);
      console.log("Sem persistência — outputs ficam no stdout. Copia o bloco acima.");
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha na probe:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
