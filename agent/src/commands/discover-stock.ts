/**
 * agent/src/commands/discover-stock.ts
 *
 * Probe read-only sobre a tabela que detém stock corrente. Em Softreis
 * o stock costuma viver na própria mestre de artigos (campo
 * `stockactual`); por isso esta probe aceita a mesma tabela do master
 * de produtos. Operacionaliza o §3.2 do mapping canónico em
 * `docs/spharm-erp-canonical-mapping.md`.
 *
 * Para além das colunas-chave + TOP 5, esta probe acrescenta um pequeno
 * sumário de consistência (positivos / negativos / movimentos recentes).
 * Tudo via `COUNT(*)` com `WHERE` simples — sem scan adicional.
 *
 * Garantias:
 *   · Read-only, SQL 2008 R2, TOP 5, sem persistência (stdout-only).
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

const STOCK_HINTS: FieldHint[] = [
  { field: "cnp", needles: ["codcnp", "codnacional", "codnac", "cnp"], expect: ["int"] },
  { field: "designacao", needles: ["designac", "descric", "nome"], expect: ["string"] },
  { field: "stockAtual", needles: ["stockactual", "stkactual", "existencia", "qtdstock", "stockatual"], expect: ["decimal", "int"] },
  { field: "stockMinimo", needles: ["stockmin", "stkmin", "qtdmin"], expect: ["decimal", "int"] },
  { field: "stockMaximo", needles: ["stockmax", "stkmax", "qtdmax"], expect: ["decimal", "int"] },
  { field: "pvp", needles: ["pvprec", "precovenda", "pvp"], expect: ["decimal"] },
  { field: "pmc", needles: ["precomedio", "pcmedio", "pmc"], expect: ["decimal"] },
  { field: "puc", needles: ["precoultima", "precoult", "ultcompra", "puc"], expect: ["decimal"] },
  { field: "dataUltimaVenda", needles: ["dataultvenda", "dtultvenda", "ultvenda"], expect: ["date"] },
  { field: "dataUltimaCompra", needles: ["dataultcompra", "dtultcompra", "ultcompra"], expect: ["date"] },
  { field: "validadeMaisAntiga", needles: ["validade", "prazo", "dtvalid"], expect: ["date"] },
  { field: "flagRetirado", needles: ["retirado", "inactivo", "bloqueado"], expect: ["bool", "string", "int"] },
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
  console.log("Uso: discover-stock --table <schema>.<tabela>");
  console.log("");
  console.log("Exemplos:");
  console.log('  discover-stock --table dbo.Stocks');
  console.log('  discover-stock --table dbo.ArmazensStocks');
  console.log("");
  console.log("Sem --table, mostra a lista de candidatos detectados pelo `discover`");
  console.log("(apenas hint — não auto-escolhe; a heurística falha frequentemente).");
  console.log("");
  console.log("Garantias: read-only, TOP 5, sem persistência, SQL 2008 R2.");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md");
}

export async function discoverStock(): Promise<number> {
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
    console.error("Stock costuma viver no master de artigos (Softreis: dbo.Stocks) OU");
    console.error("numa tabela por-armazém (dbo.ArmazensStocks). Hints do discover:");
    console.error("");
    printCandidateHint("stocks", cfg.outputDir);
    console.error("");
    console.error("Categoria produtos (caso stock esteja no master):");
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

      const sampleRes = await pool
        .request()
        .query<Record<string, unknown>>(`SELECT TOP 5 * FROM [${target.schema}].[${target.table}]`);

      const classified = classifyColumns(cols, STOCK_HINTS);
      const stockCol = classified.find((c) => c.field === "stockAtual")?.match ?? null;
      const ultVendaCol = classified.find((c) => c.field === "dataUltimaVenda")?.match ?? null;

      // ── Resumo de consistência (apenas se a coluna existir)
      type Summary = {
        positives: number | null;
        zero: number | null;
        negatives: number | null;
        movedLast30: number | null;
        movedLast90: number | null;
      };
      const summary: Summary = {
        positives: null,
        zero: null,
        negatives: null,
        movedLast30: null,
        movedLast90: null,
      };

      if (stockCol) {
        const sCol = `[${stockCol.name}]`;
        const tName = `[${target.schema}].[${target.table}]`;
        // 3 queries simples, cada uma com `WHERE` indexado-ou-scan curto.
        const rPos = await pool
          .request()
          .query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tName} WHERE ${sCol} > 0`);
        const rZero = await pool
          .request()
          .query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tName} WHERE ${sCol} = 0`);
        const rNeg = await pool
          .request()
          .query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tName} WHERE ${sCol} < 0`);
        summary.positives = Number(rPos.recordset[0]?.n ?? 0);
        summary.zero = Number(rZero.recordset[0]?.n ?? 0);
        summary.negatives = Number(rNeg.recordset[0]?.n ?? 0);
      }

      if (ultVendaCol) {
        const dCol = `[${ultVendaCol.name}]`;
        const tName = `[${target.schema}].[${target.table}]`;
        const r30 = await pool
          .request()
          .query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${tName} WHERE ${dCol} >= DATEADD(DAY, -30, GETDATE())`
          );
        const r90 = await pool
          .request()
          .query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${tName} WHERE ${dCol} >= DATEADD(DAY, -90, GETDATE())`
          );
        summary.movedLast30 = Number(r30.recordset[0]?.n ?? 0);
        summary.movedLast90 = Number(r90.recordset[0]?.n ?? 0);
      }

      console.log(RULE);
      console.log(`discover-stock — ${target.schema}.${target.table}`);
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
      console.log(`  (${matched}/${classified.length} campos do mapping §3.2 detectados)`);
      console.log("");

      if (stockCol || ultVendaCol) {
        console.log("Resumo de consistência:");
        if (stockCol) {
          console.log(`  via ${stockCol.name}:`);
          console.log(`    stock > 0   : ${summary.positives}`);
          console.log(`    stock = 0   : ${summary.zero}`);
          console.log(`    stock < 0   : ${summary.negatives}  (esperado 0; ERPs por vezes têm ajustes em curso)`);
        }
        if (ultVendaCol) {
          console.log(`  via ${ultVendaCol.name}:`);
          console.log(`    vendido nos últimos 30 dias : ${summary.movedLast30}`);
          console.log(`    vendido nos últimos 90 dias : ${summary.movedLast90}`);
        }
        console.log("");
      }

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
