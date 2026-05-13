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
  // Necessário porque ProdutoFarmacia.produtoId não é nullable e
  // referencia Produto.id (não externalProductId).
  const externalIds = Array.from(aggMap.keys());
  const produtos = externalIds.length
    ? await ctx.prisma.produto.findMany({
        where: { externalProductId: { in: externalIds } },
        select: { id: true, externalProductId: true },
      })
    : [];
  const produtoIdByExternal = new Map<number, string>();
  for (const p of produtos) {
    if (p.externalProductId !== null) {
      produtoIdByExternal.set(p.externalProductId, p.id);
    }
  }

  // 3) Upsert ProdutoFarmacia por agg. Sem produto correspondente →
  // skipped (não erro — operador pode re-executar bootstrap-upload
  // products primeiro).
  const errors: BootstrapBatchResponse["errors"] = [];
  let upserted = 0;
  for (const agg of aggMap.values()) {
    const produtoId = produtoIdByExternal.get(agg.externalProductId);
    if (!produtoId) {
      skipped.push({
        index: -1, // não corresponde a um único índice (foi agregado de N)
        reason: "produto_not_found",
        externalId: agg.externalProductId,
      });
      continue;
    }
    try {
      const data: Prisma.ProdutoFarmaciaUncheckedUpdateInput = {
        externalProductId: agg.externalProductId,
        stockAtual: agg.stockAtual ?? undefined,
        stockMinimo: agg.stockMinimo ?? undefined,
        stockMaximo: agg.stockMaximo ?? undefined,
        stockEncomenda: agg.stockEncomenda ?? undefined,
        stockReserva: agg.stockReserva ?? undefined,
      };
      await ctx.prisma.produtoFarmacia.upsert({
        where: { produtoId_farmaciaId: { produtoId, farmaciaId } },
        create: {
          produtoId,
          farmaciaId,
          externalProductId: agg.externalProductId,
          stockAtual: agg.stockAtual ?? null,
          stockMinimo: agg.stockMinimo ?? null,
          stockMaximo: agg.stockMaximo ?? null,
          stockEncomenda: agg.stockEncomenda ?? null,
          stockReserva: agg.stockReserva ?? null,
        },
        update: data,
      });
      upserted++;
    } catch (err) {
      errors.push({
        index: -1,
        reason: "upsert_failed",
        externalId: agg.externalProductId,
        message: err instanceof Error ? err.message : String(err),
      });
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
