/**
 * agent/src/commands/stock-upload.ts
 *
 * Upload SÓ do pipeline STOCK para `/api/ingest/v1/bootstrap/stock`.
 * Reutiliza `runStockPipeline` do bootstrap-upload — NÃO envia `products`
 * nem `sales-lines`. Idempotente (upsert COALESCE por (produtoId,
 * farmaciaId); re-run produz o mesmo estado).
 *
 * Stock é um SNAPSHOT corrente (existência actual agregada por CodigoID),
 * por isso NÃO recebe `--from`/`--to`.
 *
 * Pré-requisitos:
 *   · `/bootstrap/products` já correu para esta farmácia — a resolução
 *     produtoId é feita server-side via `ProdutoFarmacia(farmaciaId,
 *     externalProductId)`, criada pelo /products (ver fix 88f7825:
 *     CodigoID é namespace POR-FARMÁCIA). Sem PF, o stock fica skipped.
 *   · `ENABLE_AGENT_BOOTSTRAP=1` no SaaS.
 *   · `SPHARMMT_FARMACIA` no .env / agent.config.json.
 *   · `test-connection` passa.
 *
 * Usa a config ACTUAL do agent (mesma de bootstrap-upload). Útil para
 * repor/atualizar só o stock de uma farmácia sem re-bootstrap completo.
 */

import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import { SaasClient, SaasApiError } from "../http-client.js";
import {
  runStockPipeline,
  resolveFarmaciaId,
  renderTotals,
} from "./bootstrap-upload.js";

const RULE = "─".repeat(70);

export async function stockUpload(): Promise<number> {
  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both"); // precisa SQL E SaaS
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!cfg.farmacia) {
    console.error("✗ SPHARMMT_FARMACIA não está definido (cuid ou nome da farmácia).");
    return 1;
  }

  const client = new SaasClient(cfg);
  let farmaciaId: string;
  try {
    farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
  } catch (err) {
    console.error("✗ Resolução de farmácia falhou:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const t0 = Date.now();
  console.log(RULE);
  console.log("stock-upload — upload SÓ de stock (idempotente)");
  console.log(RULE);
  console.log(`SaaS endpoint     : ${cfg.saasEndpoint}`);
  console.log(`Tenant slug       : ${cfg.tenantSlug}`);
  console.log(`Farmácia (resolved): ${farmaciaId}`);
  console.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log("NOTA: NÃO envia products nem sales-lines. Stock = snapshot corrente.");
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const stockTotals = await runStockPipeline(pool, client, farmaciaId);
      console.log("");
      console.log("Pipeline STOCK:");
      renderTotals("stock", stockTotals);
      const wallMs = Date.now() - t0;
      console.log(RULE);
      console.log(`Wall time         : ${(wallMs / 1000).toFixed(1)}s`);
      if (stockTotals.errors === 0) {
        console.log("✓ stock-upload concluído sem erros.");
        return 0;
      }
      console.error(`✗ stock-upload concluído com ${stockTotals.errors} erros — ver acima.`);
      return 1;
    });
  } catch (err) {
    console.error("\n✗ Falha no stock-upload:");
    if (err instanceof SaasApiError) {
      console.error(`  SaaS ${err.method} ${err.path} → HTTP ${err.statusCode}`);
      if (err.bodySnippet) console.error(`  body: ${err.bodySnippet}`);
      if (err.statusCode === 503) {
        console.error(`  Hint: ENABLE_AGENT_BOOTSTRAP precisa estar a "1" no SaaS.`);
      }
      if (err.statusCode === 401) {
        console.error(`  Hint: ingest key inválida ou tenant slug errado.`);
      }
    } else {
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}
