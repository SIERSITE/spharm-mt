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
 *   · products-upload    (rev45: SÓ produtos → /bootstrap/products, idempotente, retry+shrink)
 *   · stock-upload       (SÓ stock → /bootstrap/stock, idempotente)
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
import { vendasSuspCadeia } from "./commands/vendas-susp-cadeia.js";
import { vendasSuspNc } from "./commands/vendas-susp-nc.js";
import { vendasSuspTipos } from "./commands/vendas-susp-tipos.js";
import { vendasParidade } from "./commands/vendas-paridade.js";
import { productsPreview } from "./commands/products-preview.js";
import { stockPreview } from "./commands/stock-preview.js";
import { salesPreview } from "./commands/sales-preview.js";
import { salesSummaryPreview } from "./commands/sales-summary-preview.js";
import { bootstrapDryRun } from "./commands/bootstrap-dry-run.js";
import { bootstrapUpload } from "./commands/bootstrap-upload.js";
import { productsUpload } from "./commands/products-upload.js";
import { stockUpload } from "./commands/stock-upload.js";
import { fullSync } from "./commands/full-sync.js";
import { dailySync, dailySyncDryRun } from "./commands/daily-sync.js";
import { dailyPipeline } from "./commands/daily-pipeline.js";
import { exportOrders } from "./commands/export-orders.js";
import { inspectOrdersSchema } from "./commands/inspect-orders-schema.js";
import { inspectComprasSchema } from "./commands/inspect-compras-schema.js";
import { inspectComprasLookups } from "./commands/inspect-compras-lookups.js";
import { inspectProductIdentifiers } from "./commands/inspect-product-identifiers.js";
import { setupOrdersWriteLog } from "./commands/setup-orders-write-log.js";
import { testOrderWrite } from "./commands/test-order-write.js";
import { inspectCodigoId } from "./commands/inspect-codigoid.js";
import { fornecedoresDryRun, fornecedoresUpload } from "./commands/fornecedores.js";
import { comprasDryRun, comprasUpload } from "./commands/compras.js";
import {
  devolucoesFornecedorDryRun,
  devolucoesFornecedorUpload,
} from "./commands/devolucoes-fornecedor.js";
import { movimentosAudit } from "./commands/movimentos-audit.js";
import { stocksmovDryRun, stocksmovUpload } from "./commands/stocksmov.js";
import { acertosStockDryRun } from "./commands/acertos-stock.js";
import { ivaAudit } from "./commands/iva-audit.js";
import { catalogAudit } from "./commands/catalog-audit.js";
import { catalogDiscoverLinks } from "./commands/catalog-discover-links.js";
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
  "vendas-susp-cadeia": {
    run: vendasSuspCadeia,
    desc: "Segue a cadeia documental da venda suspensa nos dois sentidos (linha↔documento) a partir de IDs e documentos VSG reais. Read-only.",
  },
  "vendas-susp-tipos": {
    run: vendasSuspTipos,
    desc: "Inventaria os tipos documentais do circuito suspenso, procura reversões pelo SINAL e cruza-as com o circuito G. Read-only, --db aponta outra base.",
  },
  "vendas-paridade": {
    run: vendasParidade,
    desc: "Dry-run: as cinco populações de venda por mês (NORMAL/CREDITO/TRANSFERENCIA e as somas), comparadas automaticamente com o relatório oficial do SPharm. Read-only.",
  },
  "vendas-susp-nc": {
    run: vendasSuspNc,
    desc: "Dada uma relação de Atendimento_SuspFT_NC_Susp, onde está a NC e onde estão as suas linhas — procura o ID por conteúdo em todas as PKs do ERP. Read-only.",
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
  "products-upload": {
    run: productsUpload,
    desc: "rev45: upload SÓ de produtos → /bootstrap/products. NÃO envia stock/sales. Batch 25 + retry+backoff+shrink. Idempotente. Refresh IVA per-farmácia.",
  },
  "stock-upload": {
    run: stockUpload,
    desc: "Upload SÓ de stock (snapshot) → /bootstrap/stock. NÃO envia products/sales. Idempotente.",
  },
  "full-sync": {
    run: fullSync,
    desc: "Sync COMPLETA inicial (onboarding): produtos→stock→vendas→fornecedores→compras→devoluções→agregações. Idempotente, retomável por fase. --from/--to, --dry-run, --force.",
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
  "inspect-orders-schema": {
    run: inspectOrdersSchema,
    desc: "Probe read-only às tabelas SPharm de encomendas. Gera markdown para validação.",
  },
  "inspect-compras-schema": {
    run: inspectComprasSchema,
    desc: "Probe read-only às tabelas SPharm de compras/recepções + devoluções a fornecedor. Gera markdown com hipótese de mapping.",
  },
  "inspect-compras-lookups": {
    run: inspectComprasLookups,
    desc: "Probe read-only focado: Fornecedores + Tipo Documento + amostras pós-data-corte + validação fórmulas + orphans.",
  },
  "inspect-product-identifiers": {
    run: inspectProductIdentifiers,
    desc: "Probe read-only às colunas de dbo.Stocks que podem ser o CNP individual. Testa CNPs conhecidos contra cada coluna candidata.",
  },
  "setup-orders-write-log": {
    run: setupOrdersWriteLog,
    desc: "Cria/verifica dbo.SPharmMT_OrderWriteLog (tabela auxiliar de idempotência). Pré-requisito para ordersWriteMode=insert.",
  },
  "test-order-write": {
    run: testOrderWrite,
    desc: "Smoke test do INSERT de encomenda em SPharm (dry-run default; --commit para escrita real).",
  },
  "inspect-codigoid": {
    run: inspectCodigoId,
    desc: "Probe dbo.Stocks read-only para lista de CodigoIDs (--ids).",
  },
  "iva-audit": {
    run: ivaAudit,
    desc: "rev41: auditoria estrutural fiscal do ERP — descobre a tabela mestre do IVA via FKs + domain matching + scoring. Read-only. Gera ./run/iva-audit-<ts>.{md,json}.",
  },
  "catalog-audit": {
    run: catalogAudit,
    desc: "rev46: auditoria estrutural do catálogo regulamentar — localiza DCI, ATC, Grupo Homogéneo e Fabricante em Stocks e nas tabelas de lookup, via sys.columns + FKs + taxa de preenchimento. Read-only. Gera ./run/catalog-audit-<ts>.{md,json}.",
  },
  "catalog-discover-links": {
    run: catalogDiscoverLinks,
    desc: "rev49: descoberta READ-ONLY de relacoes por METADADOS (sys.columns/foreign_keys/indexes). Caca GrupoHomID, SPRActID, Codigo, CNP, CodigoProduto, ProdutoID, StockID em todas as tabelas e testa por CONTEUDO a ligacao a dbo.Stocks. Gera ./run/catalog-discover-links-<ts>.json.",
  },
  "fornecedores-dry-run": {
    run: fornecedoresDryRun,
    desc: "Fase 1a: lê dbo.Fornecedores + LEFT JOIN Tbl_Tipo_Fornecedores. Sumário + TOP 10. SEM POST.",
  },
  "fornecedores-upload": {
    run: fornecedoresUpload,
    desc: "Fase 1a: POST /api/ingest/v1/bootstrap/fornecedores. Idempotente por (farmaciaId, externalFornecedorId).",
  },
  "compras-dry-run": {
    run: comprasDryRun,
    desc: "Fase 1b: lê dbo.Recepcao + dbo.[Recepcao Detalhe]. Sumário + reconciliação + orphans locais. SEM POST.",
  },
  "compras-upload": {
    run: comprasUpload,
    desc: "Fase 1b: POST /api/ingest/v1/bootstrap/compras (StagingCompraRawLine). Idempotente por (farmaciaId, externalLineId).",
  },
  "devolucoes-fornecedor-dry-run": {
    run: devolucoesFornecedorDryRun,
    desc: "Fase 1b: lê dbo.Devolucao + dbo.[Devolucao Detalhe]. Sumário P/E/R/X + reconciliação + orphans. SEM POST.",
  },
  "devolucoes-fornecedor-upload": {
    run: devolucoesFornecedorUpload,
    desc: "Fase 1b: POST /api/ingest/v1/bootstrap/devolucoes-fornecedor. Captura P→R via UPSERT idempotente.",
  },
  "movimentos-audit": {
    run: movimentosAudit,
    desc: "Auditoria ÚNICA read-only do universo de movimentos (StocksMov + relacionadas). Gera .md+.json em ./run/.",
  },
  "stocksmov-dry-run": {
    run: stocksmovDryRun,
    desc: "Block B1: read-only StocksMov + classify local. Sumário por tipo + cobertura DESCONHECIDO + top motivos. SEM POST.",
  },
  "stocksmov-upload": {
    run: stocksmovUpload,
    desc: "Block B2: POST /api/ingest/v1/movimentos. Paginado por StocksMovID. Idempotente por (farmaciaId, externalMovId). --from/--to[/--since-id].",
  },
  "acertos-stock-dry-run": {
    run: acertosStockDryRun,
    desc: "Read-only: conta os acertos de stock (MOV_INTERNO) da janela — sinais, quantidade líquida, produtos, duplicados por StocksMovID, amostras. SEM POST.",
  },
  health: {
    run: health,
    desc: "Resumo de config + connectivity + diagnóstico verboso.",
  },
};

/**
 * Banner de versão impresso no início de cada execução do agent.
 * Os valores são injectados em build-time por esbuild define (ver
 * agent/build.mjs). Em dev (tsx) ficam undefined → "dev".
 *
 * Aparece em stdout do BAT, que o auto-export redirige para
 * logs/export-orders-<data>.log. Útil para correlacionar logs com
 * versão exacta do ZIP em farmácias distintas.
 */
function printVersionBanner(): void {
  const rev = process.env.AGENT_REV || "dev";
  const commit = process.env.AGENT_COMMIT || "unknown";
  const buildTs = process.env.AGENT_BUILD_TS || "-";
  console.log(`Agent: rev${rev} commit ${commit} built ${buildTs}`);
}

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

  // Banner antes do help/comando — fica no topo de cada log file. Para
  // `--version`/`-v` imprime e sai imediatamente.
  if (cmd === "--version" || cmd === "-v") {
    printVersionBanner();
    process.exit(0);
    return;
  }
  printVersionBanner();

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
