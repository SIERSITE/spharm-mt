#!/usr/bin/env node
/**
 * agent/src/cli.ts
 *
 * Entrypoint do `spharmmt-agent`. Encaminha o primeiro positional
 * argument para o comando correspondente. Sem deps de CLI parsing —
 * cada comando trata os seus flags via `node:util.parseArgs`.
 *
 * Comandos disponíveis (v0.1):
 *   · test-connection
 *   · discover
 *   · discover-products  (probe TOP 5, sem persistência)
 *   · discover-stock     (probe TOP 5, sem persistência)
 *   · discover-sales     (probe TOP 5, sem persistência)
 *   · probe-table        (probe genérico dirigido por --table)
 *   · products-preview   (TOP 20 com JOINs — Stocks/ArmazensStocks/Fornecedores)
 *   · stock-preview      (TOP 20 com JOINs — Stocks/ArmazensStocks/Armazens)
 *   · sales-preview      (TOP 20 com JOINs + filtros datas/Fim Venda)
 *   · sales-summary-preview (GROUP BY TipoDoc+EntidadeID + TOP 10 docs)
 *   · bootstrap-dry-run  (preview canónico da 1ª ingestão — sem escrita)
 *   · bootstrap-upload   (1ª ingestão REAL, idempotente, gated por feature flag)
 *   · daily-sync        (sync incremental diário, reusa endpoints bootstrap)
 *   · daily-sync-dry-run (preview do daily-sync sem POST)
 *   · health
 *
 * Planeados (próxima iteração, após mapping ERP→SPharm.MT consolidado):
 *   · bootstrap
 *   · daily-sync
 */

import { testConnection } from "./commands/test-connection.js";
import { discover } from "./commands/discover.js";
import { discoverProducts } from "./commands/discover-products.js";
import { discoverStock } from "./commands/discover-stock.js";
import { discoverSales } from "./commands/discover-sales.js";
import { probeTable } from "./commands/probe-table.js";
import { productsPreview } from "./commands/products-preview.js";
import { stockPreview } from "./commands/stock-preview.js";
import { salesPreview } from "./commands/sales-preview.js";
import { salesSummaryPreview } from "./commands/sales-summary-preview.js";
import { bootstrapDryRun } from "./commands/bootstrap-dry-run.js";
import { bootstrapUpload } from "./commands/bootstrap-upload.js";
import { dailySync, dailySyncDryRun } from "./commands/daily-sync.js";
import { dailyPipeline } from "./commands/daily-pipeline.js";
import { exportOrders } from "./commands/export-orders.js";
import { inspectCodigoId } from "./commands/inspect-codigoid.js";
import { health } from "./commands/health.js";

type CommandFn = () => Promise<number>;

const COMMANDS: Record<string, { run: CommandFn; desc: string }> = {
  "test-connection": {
    run: testConnection,
    desc: "Valida config + SQL Server + SaaS connectivity. Fail-fast.",
  },
  discover: {
    run: discover,
    desc: "Lê metadata do ERP SQL Server (read-only). Output em output/.",
  },
  "discover-products": {
    run: discoverProducts,
    desc: "Probe TOP 5 na tabela mestre de artigos. Sem persistência.",
  },
  "discover-stock": {
    run: discoverStock,
    desc: "Probe TOP 5 + sumário de stock corrente. Sem persistência.",
  },
  "discover-sales": {
    run: discoverSales,
    desc: "Probe TOP 5 em linhas de venda + dias top. Sem persistência.",
  },
  "probe-table": {
    run: probeTable,
    desc: "Probe genérico (PK/FKs/datas/TOP 5) — --table obrigatório.",
  },
  "products-preview": {
    run: productsPreview,
    desc: "Preview TOP 20: Stocks + ArmazensStocks + Fornecedores. Read-only.",
  },
  "stock-preview": {
    run: stockPreview,
    desc: "Preview TOP 20: Stocks + ArmazensStocks + Armazens. Read-only.",
  },
  "sales-preview": {
    run: salesPreview,
    desc: "Preview TOP 20: Atendimento + Detalhe + Stocks. --from/--to obrigatórios.",
  },
  "sales-summary-preview": {
    run: salesSummaryPreview,
    desc: "Agregado por TipoDoc+EntidadeID + TOP 10 docs. Caracteriza Valor_EUR.",
  },
  "bootstrap-dry-run": {
    run: bootstrapDryRun,
    desc: "Preview da 1ª ingestão: payloads canónicos + counts + alerts. SEM escrita.",
  },
  "bootstrap-upload": {
    run: bootstrapUpload,
    desc: "1ª ingestão REAL para a SaaS. Idempotente. Requer ENABLE_AGENT_BOOTSTRAP=1.",
  },
  "daily-sync": {
    run: dailySync,
    desc: "Sync incremental diário (--date). Reusa endpoints bootstrap. Idempotente.",
  },
  "daily-sync-dry-run": {
    run: dailySyncDryRun,
    desc: "Dry-run do daily-sync — preview SQL + amostras sem POST.",
  },
  "daily-pipeline": {
    run: dailyPipeline,
    desc: "Orquestrador autónomo: daily-sync + aggregate. Lockfile + logs locais.",
  },
  "export-orders": {
    run: exportOrders,
    desc: "Puxa encomendas pending do SaaS e escreve no SPharm local (stub|insert).",
  },
  "inspect-codigoid": {
    run: inspectCodigoId,
    desc: "Probe dbo.Stocks read-only para lista de CodigoIDs (--ids).",
  },
  health: {
    run: health,
    desc: "Resumo de config + connectivity + diagnóstico verboso.",
  },
};

function printHelp(): void {
  console.log("spharmmt-agent — SPharm.MT local agent (SQL Server)");
  console.log("");
  console.log("Uso:");
  console.log("  spharmmt-agent <comando>");
  console.log("  npm run agent <comando>");
  console.log("");
  console.log("Comandos:");
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, info] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(w + 2)} ${info.desc}`);
  }
  console.log("");
  console.log("Config: copia .env.example para .env e preenche.");
  console.log("Docs:   ver agent/README.md");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    process.exit(cmd ? 0 : 1);
    return;
  }

  const entry = COMMANDS[cmd];
  if (!entry) {
    console.error(`✗ Comando desconhecido: ${cmd}`);
    console.error("");
    printHelp();
    process.exit(1);
    return;
  }

  try {
    const exitCode = await entry.run();
    process.exit(exitCode);
  } catch (err) {
    console.error("[fatal]", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
      console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    }
    process.exit(1);
  }
}

main();
