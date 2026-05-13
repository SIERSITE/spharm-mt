/**
 * app/api/ingest/v1/bootstrap/sales-lines/route.ts
 *
 * POST /api/ingest/v1/bootstrap/sales-lines
 *
 * Recebe um batch de linhas de venda raw e insere em
 * `IngestVendaLinhaRaw` (tabela staging). **Não agrega**, **não toca
 * em `Venda`/`VendaMensal`**. Idempotência forte via
 * `@@unique(farmaciaId, externalSaleLineId)` — reupload da mesma
 * linha actualiza-a em vez de duplicar.
 *
 * `produtoId` é resolvido server-side via `Produto.externalProductId`.
 * Se não houver match, fica null — a linha continua a entrar como
 * staging para forensic + reprocessamento futuro.
 *
 * Pre-condição: idealmente o operador correu /bootstrap/products
 * antes, para que produtoId seja resolúvel. Mas o endpoint não falha
 * se não — apenas reporta orphans em `skipped` (informativo, não
 * impeditivo).
 *
 * Feature flag: ENABLE_AGENT_BOOTSTRAP=1.
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
  asStringOrNull,
  asIsoDateOrNull,
  type BootstrapBatchResponse,
} from "@/lib/ingest/bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type SaleLinePayload = {
  externalSaleId: unknown;
  externalSaleLineId: unknown;
  sequencia: unknown;
  dataVenda: unknown;
  tipoDocumento: unknown;
  tipoDocumentoClass: unknown;
  externalProductId: unknown;
  quantidade: unknown;
  pvpUnitario: unknown;
  valorLinha: unknown;
  ivaValor: unknown;
  descontoValor: unknown;
  comparticipacao1: unknown;
  comparticipacao2: unknown;
  entidadeId: unknown;
};

const KNOWN_CLASSES = new Set(["VENDA", "DEVOLUCAO_ANULACAO", "UNKNOWN"]);

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  const parsed = await parseBatchBody<SaleLinePayload>(req);
  if (isFailure(parsed)) return parsed.response;
  const { farmaciaId, items } = parsed;

  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[bootstrap/sales-lines] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
    })}`
  );

  // 1) Coerce + validate.
  const skipped: BootstrapBatchResponse["skipped"] = [];
  const errors: BootstrapBatchResponse["errors"] = [];

  type Resolved = {
    index: number;
    externalSaleId: number;
    externalSaleLineId: number;
    sequencia: number | null;
    dataVenda: Date | null;
    tipoDocumento: number | null;
    tipoDocumentoClass: string;
    externalProductId: number;
    quantidade: number | null;
    pvpUnitario: number | null;
    valorLinha: number | null;
    ivaValor: number | null;
    descontoValor: number | null;
    comparticipacao1: number | null;
    comparticipacao2: number | null;
    entidadeId: number | null;
    raw: SaleLinePayload;
  };

  const resolved: Resolved[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? ({} as SaleLinePayload);
    const externalSaleId = asIntOrNull(raw.externalSaleId);
    const externalSaleLineId = asIntOrNull(raw.externalSaleLineId);
    const externalProductId = asIntOrNull(raw.externalProductId);

    if (externalSaleId === null) {
      skipped.push({ index: i, reason: "missing_external_sale_id" });
      continue;
    }
    if (externalSaleLineId === null) {
      skipped.push({ index: i, reason: "missing_external_sale_line_id" });
      continue;
    }
    if (externalProductId === null) {
      skipped.push({
        index: i,
        reason: "missing_external_product_id",
        externalId: externalSaleLineId,
      });
      continue;
    }
    const classRaw = asStringOrNull(raw.tipoDocumentoClass) ?? "UNKNOWN";
    const tipoDocumentoClass = KNOWN_CLASSES.has(classRaw) ? classRaw : "UNKNOWN";

    resolved.push({
      index: i,
      externalSaleId,
      externalSaleLineId,
      sequencia: asIntOrNull(raw.sequencia),
      dataVenda: asIsoDateOrNull(raw.dataVenda),
      tipoDocumento: asIntOrNull(raw.tipoDocumento),
      tipoDocumentoClass,
      externalProductId,
      quantidade: asDecimalOrNull(raw.quantidade),
      pvpUnitario: asDecimalOrNull(raw.pvpUnitario),
      valorLinha: asDecimalOrNull(raw.valorLinha),
      ivaValor: asDecimalOrNull(raw.ivaValor),
      descontoValor: asDecimalOrNull(raw.descontoValor),
      comparticipacao1: asDecimalOrNull(raw.comparticipacao1),
      comparticipacao2: asDecimalOrNull(raw.comparticipacao2),
      entidadeId: asIntOrNull(raw.entidadeId),
      raw,
    });
  }

  // 2) Resolver externalProductId → produtoId em lote.
  const externalIds = Array.from(new Set(resolved.map((r) => r.externalProductId)));
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

  // 3) Upsert each line. Idempotente via @@unique(farmaciaId,
  // externalSaleLineId).
  let upserted = 0;
  let orphanCount = 0;
  for (const r of resolved) {
    const produtoId = produtoIdByExternal.get(r.externalProductId) ?? null;
    if (produtoId === null) orphanCount++;

    try {
      const data = {
        farmaciaId,
        externalSaleId: r.externalSaleId,
        externalSaleLineId: r.externalSaleLineId,
        sequencia: r.sequencia,
        dataVenda: r.dataVenda,
        tipoDocumento: r.tipoDocumento,
        tipoDocumentoClass: r.tipoDocumentoClass,
        externalProductId: r.externalProductId,
        produtoId,
        quantidade: r.quantidade,
        pvpUnitario: r.pvpUnitario,
        valorLinha: r.valorLinha,
        ivaValor: r.ivaValor,
        descontoValor: r.descontoValor,
        comparticipacao1: r.comparticipacao1,
        comparticipacao2: r.comparticipacao2,
        entidadeId: r.entidadeId,
        rawJson: r.raw as unknown as Prisma.InputJsonValue,
      };
      await ctx.prisma.ingestVendaLinhaRaw.upsert({
        where: {
          farmaciaId_externalSaleLineId: {
            farmaciaId,
            externalSaleLineId: r.externalSaleLineId,
          },
        },
        create: data,
        update: data,
      });
      upserted++;
    } catch (err) {
      errors.push({
        index: r.index,
        reason: "upsert_failed",
        externalId: r.externalSaleLineId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const durationMs = Date.now() - t0;
  console.log(
    `[bootstrap/sales-lines] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
      upserted,
      orphanProductLines: orphanCount,
      skipped: skipped.length,
      errors: errors.length,
      durationMs,
    })}`
  );
  for (const e of errors.slice(0, 10)) {
    console.warn(`[bootstrap/sales-lines] item_error ${JSON.stringify({
      tenant: ctx.tenant.slug,
      index: e.index,
      externalId: e.externalId,
      reason: e.reason,
      message: e.message.slice(0, 200),
    })}`);
  }

  const response: BootstrapBatchResponse & { orphanProductLines: number } = {
    ok: true,
    accepted: items.length,
    upserted,
    orphanProductLines: orphanCount,
    skipped,
    errors,
    durationMs,
  };
  return NextResponse.json(response);
});
