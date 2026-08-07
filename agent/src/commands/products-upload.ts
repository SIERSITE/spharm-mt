/**
 * agent/src/commands/products-upload.ts
 *
 * rev45 — Upload SÓ do pipeline PRODUTOS para
 * `/api/ingest/v1/bootstrap/products`. Reusa `runProductsPipeline` do
 * `bootstrap-upload` em modo `{ batchSize: 25, retry: true }`. NÃO envia
 * `stock` nem `sales-lines` nem `compras` nem `devoluções` — só atualiza
 * o catálogo + ProdutoFarmacia da farmácia.
 *
 * Caso de uso primário (rev45): refresh do campo `ProdutoFarmacia.taxaIvaPercent`
 * sem ter de re-correr `bootstrap-upload` ou `full-sync` (que tocam stock,
 * vendas e agregações). O server resolve a taxa via
 * `normalizeIva()` para o canónico PT {0, 6, 13, 23} e marca
 * `taxaIvaSource = 'STOCKS_MESTRE'` para os produtos que o agent envia.
 *
 * **Não recebe `--from`/`--to`** — produtos são um snapshot (catálogo
 * corrente), não uma janela temporal. A pipeline lê `dbo.Stocks` com
 * `Retirado=0 AND Processa_Stocks<>0`, ordenando por `CodigoID`.
 *
 * Idempotente (UPSERT server-side por (farmaciaId, externalProductId);
 * re-run produz o mesmo estado).
 *
 * **Robustez (rev45):**
 *   · batch HTTP inicial = 25 (vs 50 do bootstrap-upload)
 *   · retry + backoff exponencial 1s/2s/4s/8s em 502/503/504/timeout/cancel
 *   · shrink em metade até floor de 10 quando os retries esgotam
 *   · `Failed to cancel request in 5000ms` (undici) tratado como transient
 *
 * Pré-requisitos:
 *   · `ENABLE_AGENT_BOOTSTRAP=1` no SaaS
 *   · `SPHARMMT_FARMACIA` no .env / agent.config.json
 *   · `test-connection` passa
 *   · (recomendado) `iva-audit` correu pelo menos uma vez — confirma
 *     `dbo.IVA` master + `Stocks.[Taxa IVA] → IVA.[IVA id]`
 */

import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import { SaasClient, SaasApiError } from "../http-client.js";
import {
  runProductsPipeline,
  resolveFarmaciaId,
  renderTotals,
} from "./bootstrap-upload.js";

const RULE = "─".repeat(70);

export async function productsUpload(): Promise<number> {
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
  // `runStartedAt` é capturado ANTES do primeiro batch e enviado ao
  // endpoint /bootstrap/products/finalize no fim. Marca o ponto de corte
  // do sweep: tudo o que não foi tocado nesta corrida (dataAtualizacao <
  // runStartedAt) transita para flagRetirado=true. Ver modelo canónico
  // 2026-06 (decisão arquitectural sobre produtos retirados).
  const runStartedAt = new Date().toISOString();
  console.log(RULE);
  console.log("products-upload — upload SÓ de produtos (idempotente, retry+shrink)");
  console.log(RULE);
  console.log(`SaaS endpoint     : ${cfg.saasEndpoint}`);
  console.log(`Tenant slug       : ${cfg.tenantSlug}`);
  console.log(`Farmácia (resolved): ${farmaciaId}`);
  console.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Run started at    : ${runStartedAt}`);
  console.log("NOTA: NÃO envia stock, sales-lines, compras nem devoluções.");
  console.log("       Catálogo + ProdutoFarmacia (precos + IVA) apenas.");
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const productsTotals = await runProductsPipeline(pool, client, farmaciaId, {
        batchSize: 25,
        retry: true,
      });
      console.log("");
      console.log("Pipeline PRODUTOS:");
      renderTotals("products", productsTotals);

      // Sweep só corre se a pipeline terminou sem erros. Em caso de erro
      // parcial, o último batch pode ter ficado pelo caminho — marcar
      // produtos como retirados aí seria incorrecto. O operador re-corre.
      if (productsTotals.errors === 0) {
        console.log("");
        console.log("▶ Sweep pós-upload (flagRetirado)…");
        try {
          const sweep = await client.bootstrapProductsFinalize(
            { farmaciaId, runStartedAt },
            60_000,
          );
          console.log(
            `  ✓ ${sweep.retiredCount} produto(s) marcado(s) como flagRetirado=true ` +
              `(linhas não tocadas desde ${runStartedAt}; ${sweep.durationMs} ms)`,
          );
        } catch (sweepErr) {
          console.error("  ✗ Sweep falhou:", sweepErr instanceof Error ? sweepErr.message : sweepErr);
          console.error("    Os produtos ficaram com flagRetirado anterior — re-correr products-upload reconcilia.");
          return 1;
        }
      } else {
        console.log("");
        console.log("⚠ Sweep pós-upload SALTADO — pipeline teve erros, re-correr products-upload.");
      }

      const wallMs = Date.now() - t0;
      console.log(RULE);
      console.log(`Wall time         : ${(wallMs / 1000).toFixed(1)}s`);
      if (productsTotals.errors === 0) {
        console.log("✓ products-upload concluído sem erros.");
        return 0;
      }
      console.error(`✗ products-upload concluído com ${productsTotals.errors} erros — ver acima.`);
      return 1;
    });
  } catch (err) {
    console.error("\n✗ Falha no products-upload:");
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
