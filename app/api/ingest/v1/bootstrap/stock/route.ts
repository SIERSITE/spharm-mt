/**
 * app/api/ingest/v1/bootstrap/stock/route.ts
 *
 * POST /api/ingest/v1/bootstrap/stock
 *
 * Recebe um batch de payloads de stock per-armazém (granularidade do
 * agent dry-run §5.4) e faz upsert em `ProdutoFarmacia` agregado por
 * `externalProductId`. Cada `ProdutoFarmacia(produtoId, farmaciaId)`
 * recebe a SOMA do stock across armazéns do mesmo CodigoID — assim
 * preservamos a granularidade canónica do SPharm.MT (1 row por par
 * produto×farmácia) sem perder dados.
 *
 * Idempotência: reupload do mesmo batch produz o mesmo estado.
 * Upsert additive — campos não-presentes não são tocados.
 *
 * Pre-condição: o produto tem de existir em Produto (ou seja, o
 * endpoint /bootstrap/products tem de correr antes deste). Stock para
 * produtos não encontrados é skipped, não erro.
 */

import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import {
  assertBootstrapEnabled,
  assertFarmaciaInTenant,
  parseBatchBody,
  isFailure,
  asIntOrNull,
  asDecimalOrNull,
  type BootstrapBatchResponse,
} from "@/lib/ingest/bootstrap";
import {
  bulkUpsertProdutoFarmaciaStock,
  dedupeByKey,
  type ProdutoFarmaciaStockRow,
} from "@/lib/ingest/bulk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type StockPayload = {
  externalProductId: unknown;
  externalWarehouseId: unknown;
  stockAtual: unknown;
  stockMinimo: unknown;
  stockMaximo: unknown;
  stockEncomenda: unknown;
  stockReserva: unknown;
};

type StockAggregate = {
  externalProductId: number;
  stockAtual: number | null;
  stockMinimo: number | null;
  stockMaximo: number | null;
  stockEncomenda: number | null;
  stockReserva: number | null;
  // Para alerts: número de armazéns originais consolidados nesta agg.
  warehouseCount: number;
};

/**
 * Acumula `value` em `agg[field]` tratando null como "no contribution"
 * (não somar, mas se all-null ficar null).
 */
function accumulate(
  agg: StockAggregate,
  field: keyof Omit<StockAggregate, "externalProductId" | "warehouseCount">,
  value: number | null
): void {
  if (value === null) return;
  const current = agg[field];
  agg[field] = current === null ? value : current + value;
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  const parsed = await parseBatchBody<StockPayload>(req);
  if (isFailure(parsed)) return parsed.response;
  const { farmaciaId, items } = parsed;

  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[bootstrap/stock] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
    })}`
  );

  // 1) Aggregate per externalProductId (SUM across armazéns).
  // Granularidade do payload: (externalProductId, externalWarehouseId).
  // Granularidade do destino: (farmaciaId, produtoId) — 1 row per
  // produto na farmácia. Para multi-armazém futuro, criar uma tabela
  // por-armazém (fora deste sprint).
  const skipped: BootstrapBatchResponse["skipped"] = [];
  const aggMap = new Map<number, StockAggregate>();
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? ({} as StockPayload);
    const externalProductId = asIntOrNull(raw.externalProductId);
    if (externalProductId === null) {
      skipped.push({ index: i, reason: "missing_external_product_id" });
      continue;
    }
    let agg = aggMap.get(externalProductId);
    if (!agg) {
      agg = {
        externalProductId,
        stockAtual: null,
        stockMinimo: null,
        stockMaximo: null,
        stockEncomenda: null,
        stockReserva: null,
        warehouseCount: 0,
      };
      aggMap.set(externalProductId, agg);
    }
    accumulate(agg, "stockAtual", asDecimalOrNull(raw.stockAtual));
    accumulate(agg, "stockMinimo", asDecimalOrNull(raw.stockMinimo));
    accumulate(agg, "stockMaximo", asDecimalOrNull(raw.stockMaximo));
    accumulate(agg, "stockEncomenda", asDecimalOrNull(raw.stockEncomenda));
    accumulate(agg, "stockReserva", asDecimalOrNull(raw.stockReserva));
    agg.warehouseCount++;
  }

  // 2) Resolver externalProductId → produtoId em lote (1 query).
  // CRÍTICO: resolve via ProdutoFarmacia SCOPED por (farmaciaId,
  // externalProductId), NÃO via Produto.externalProductId global. O
  // CodigoID/externalProductId é um NAMESPACE POR-FARMÁCIA (o ERP recicla
  // CodigoIDs entre farmácias do mesmo tenant — ver Produto.externalProductId
  // docstring e migration drop_produto_external_product_id_unique). O
  // Produto.externalProductId guarda só UM valor (last-writer), portanto
  // resolver por ele atribui o stock à farmácia errada ou a nenhum produto
  // (stockAtual fica NULL). A ProdutoFarmacia tem o CodigoID correcto da
  // farmácia (gravado pelo /products). Pré-condição: /products correu antes.
  const externalIds = Array.from(aggMap.keys());
  const pfRows = externalIds.length
    ? await ctx.prisma.produtoFarmacia.findMany({
        where: { farmaciaId, externalProductId: { in: externalIds } },
        select: { produtoId: true, externalProductId: true },
      })
    : [];
  const produtoIdByExternal = new Map<number, string>();
  for (const pf of pfRows) {
    if (pf.externalProductId !== null) {
      produtoIdByExternal.set(pf.externalProductId, pf.produtoId);
    }
  }

  // 3) Upsert ProdutoFarmacia por agg. Sem produto correspondente →
  // skipped (não erro — operador pode re-executar bootstrap-upload
  // products primeiro).
  const errors: BootstrapBatchResponse["errors"] = [];
  let upserted = 0;

  // Resolver produtoId por agg; sem produto → skipped (não erro).
  const stockRows: ProdutoFarmaciaStockRow[] = [];
  for (const agg of aggMap.values()) {
    const produtoId = produtoIdByExternal.get(agg.externalProductId);
    if (!produtoId) {
      skipped.push({
        index: -1, // foi agregado de N linhas — sem índice único
        reason: "produto_not_found",
        externalId: agg.externalProductId,
      });
      continue;
    }
    stockRows.push({
      produtoId,
      farmaciaId,
      externalProductId: agg.externalProductId,
      stockAtual: agg.stockAtual,
      stockMinimo: agg.stockMinimo,
      stockMaximo: agg.stockMaximo,
      stockEncomenda: agg.stockEncomenda,
      stockReserva: agg.stockReserva,
    });
  }
  const stockDedup = dedupeByKey(stockRows, (r) => `${r.produtoId} ${r.farmaciaId}`);

  // Bulk upsert num único INSERT ... ON CONFLICT (campos de stock, COALESCE
  // preserva existentes). Fallback per-row se o bulk falhar.
  try {
    await bulkUpsertProdutoFarmaciaStock(ctx.prisma, stockDedup);
    upserted = stockDedup.length;
  } catch (bulkErr) {
    console.warn(
      `[bootstrap/stock] bulk_failed_fallback_per_row ${JSON.stringify({
        tenant: ctx.tenant.slug,
        farmaciaId,
        rows: stockDedup.length,
        message: (bulkErr instanceof Error ? bulkErr.message : String(bulkErr)).slice(0, 200),
      })}`
    );
    upserted = 0;
    for (const r of stockDedup) {
      try {
        const data: Prisma.ProdutoFarmaciaUncheckedUpdateInput = {
          externalProductId: r.externalProductId,
          stockAtual: r.stockAtual ?? undefined,
          stockMinimo: r.stockMinimo ?? undefined,
          stockMaximo: r.stockMaximo ?? undefined,
          stockEncomenda: r.stockEncomenda ?? undefined,
          stockReserva: r.stockReserva ?? undefined,
        };
        await ctx.prisma.produtoFarmacia.upsert({
          where: { produtoId_farmaciaId: { produtoId: r.produtoId, farmaciaId } },
          create: {
            produtoId: r.produtoId,
            farmaciaId,
            externalProductId: r.externalProductId,
            stockAtual: r.stockAtual ?? null,
            stockMinimo: r.stockMinimo ?? null,
            stockMaximo: r.stockMaximo ?? null,
            stockEncomenda: r.stockEncomenda ?? null,
            stockReserva: r.stockReserva ?? null,
          },
          update: data,
        });
        upserted++;
      } catch (err) {
        errors.push({
          index: -1,
          reason: "upsert_failed",
          externalId: r.externalProductId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const durationMs = Date.now() - t0;
  console.log(
    `[bootstrap/stock] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
      aggregated: aggMap.size,
      upserted,
      skipped: skipped.length,
      errors: errors.length,
      durationMs,
    })}`
  );
  for (const e of errors.slice(0, 10)) {
    console.warn(`[bootstrap/stock] item_error ${JSON.stringify({
      tenant: ctx.tenant.slug,
      externalId: e.externalId,
      reason: e.reason,
      message: e.message.slice(0, 200),
    })}`);
  }

  const response: BootstrapBatchResponse & { aggregated: number } = {
    ok: true,
    accepted: items.length,
    aggregated: aggMap.size,
    upserted,
    skipped,
    errors,
    durationMs,
  };
  return NextResponse.json(response);
});
