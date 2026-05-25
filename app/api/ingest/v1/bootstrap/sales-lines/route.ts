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
 * `produtoId` é resolvido server-side via `ProdutoFarmacia(farmaciaId,
 * externalProductId)` — o CodigoID é namespace POR-FARMÁCIA, NÃO global.
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
  asBoolOrNull,
  type BootstrapBatchResponse,
} from "@/lib/ingest/bootstrap";
import {
  bulkUpsertSalesLines,
  dedupeByKey,
  type SalesLineRow,
} from "@/lib/ingest/bulk";
import { resolveProdutoIdMap } from "@/lib/aggregate/resolve-produto";

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
  /// Softreis: Stocks.[Processa_Stocks] LEFT JOIN d.CodigoID. Quando
  /// o produto não satisfaz o filtro operacional do bootstrap
  /// (Retirado=0 AND Processa_Stocks<>0), o `Produto` não é upserted
  /// e o lookup serve para marcar `isNonStockService`:
  ///   · processaStocks=false E lookup falha → isNonStockService=true
  ///     (serviço/taxa, exclui da agregação VendaMensal)
  ///   · processaStocks=true|null E lookup falha → orphan operational
  ///     (produto legítimo missing — pede investigação)
  processaStocks: unknown;
};

/**
 * Classes válidas. Mantido em sync com `TipoDocumentoClassificacao.classe`
 * (string, sem enum Prisma para reclassificação retroactiva flexível).
 * Qualquer valor fora deste set — seja vindo do payload OU da lookup
 * table — é forçado a "UNKNOWN" (conservador).
 */
const KNOWN_CLASSES = new Set([
  "VENDA",
  "DEVOLUCAO_ANULACAO",
  "UNKNOWN",
  "IGNORE_TECHNICAL",
]);

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

  // 0) Pre-fetch server-side classifier table. Lookup map por
  //    tipoDocumento → classe. Lido em CADA request — alterações à
  //    tabela são imediatas para uploads subsequentes.
  //    Decisão arquitectural 2026-05-14 (mapping doc §10):
  //    classificação centralizada server-side, agent envia tipoDocumento
  //    raw; `tipoDocumentoClass` no payload é fallback legacy.
  const classifications = await ctx.prisma.tipoDocumentoClassificacao.findMany({
    select: { tipoDocumento: true, classe: true },
  });
  const classifierMap = new Map<number, string>();
  for (const c of classifications) {
    if (KNOWN_CLASSES.has(c.classe)) {
      classifierMap.set(c.tipoDocumento, c.classe);
    }
    // Classes desconhecidas na tabela são silenciosamente ignoradas
    // (cai no fallback). Logamos no fim p/ visibilidade.
  }

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
    processaStocks: boolean | null;
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
    // Resolução de tipoDocumentoClass: classifier server-side > payload
    // legacy > UNKNOWN.
    const tipoRaw = asIntOrNull(raw.tipoDocumento);
    let tipoDocumentoClass: string;
    if (tipoRaw !== null && classifierMap.has(tipoRaw)) {
      tipoDocumentoClass = classifierMap.get(tipoRaw)!;
    } else {
      const clientClass = asStringOrNull(raw.tipoDocumentoClass) ?? "UNKNOWN";
      tipoDocumentoClass = KNOWN_CLASSES.has(clientClass) ? clientClass : "UNKNOWN";
    }

    resolved.push({
      index: i,
      externalSaleId,
      externalSaleLineId,
      sequencia: asIntOrNull(raw.sequencia),
      dataVenda: asIsoDateOrNull(raw.dataVenda),
      tipoDocumento: asIntOrNull(raw.tipoDocumento),
      tipoDocumentoClass,
      externalProductId,
      processaStocks: asBoolOrNull(raw.processaStocks),
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
  // CRÍTICO: resolve via ProdutoFarmacia SCOPED por (farmaciaId,
  // externalProductId), NÃO via Produto.externalProductId global. O CodigoID
  // é um namespace POR-FARMÁCIA; resolver pelo valor global (last-writer)
  // orfaniza ou MIS-ATRIBUI as vendas da farmácia cujo CodigoID não é o
  // guardado. A ProdutoFarmacia (gravada pelo /products) tem o CodigoID
  // correcto da farmácia. Pré-condição: /products correu antes.
  // Resolução DETERMINÍSTICA (regra canónica) — desambigua os CodigoID
  // reciclados (colisões) por (flagRetirado, dataUltimaVenda, stockAtual,
  // produtoId). Substitui o Map last-wins (não-determinístico).
  const externalIds = Array.from(new Set(resolved.map((r) => r.externalProductId)));
  const produtoIdByExternal = await resolveProdutoIdMap(ctx.prisma, farmaciaId, externalIds);

  // 3) Upsert each line. Idempotente via @@unique(farmaciaId,
  // externalSaleLineId).
  //
  // Para cada linha:
  //  - resolve produtoId via map externalProductId → id
  //  - quando produtoId é null:
  //      · processaStocks === false → isNonStockService=true (serviço/taxa)
  //      · processaStocks === true|null → orphan operational, flag
  //        permanece false até diagnose explícita
  //
  // A flag é update incondicional — se o operador re-classifica (corre
  // backfill) e depois faz reupload deste batch com ERP a indicar
  // processaStocks=true, a flag baixa para false. Cenário invulgar mas
  // a semântica é "o ERP é a verdade no momento do upsert".
  let upserted = 0;
  let orphanCount = 0;
  let nonStockServiceCount = 0;

  // `rawJson` é forense e NÃO é lido por nenhum processo (a agregação
  // VendaMensal usa as colunas estruturadas). Por defeito guardamos apenas
  // um stub — as colunas estruturadas preservam o conceito funcional e a
  // idempotência (chave (farmaciaId, externalSaleLineId) é independente do
  // rawJson). Isto trava o crescimento de storage do staging. Activar
  // `INGEST_STORE_RAW_JSON=1` para guardar o payload completo (auditoria/
  // reprocessamento sem re-query ao ERP).
  const keepRawJson =
    process.env.INGEST_STORE_RAW_JSON === "1" ||
    process.env.INGEST_STORE_RAW_JSON === "true";
  const RAW_STUB = { _omitted: true } as const;

  // Construir as linhas (resolve produtoId + isNonStockService).
  const rows: SalesLineRow[] = resolved.map((r) => {
    const produtoId = produtoIdByExternal.get(r.externalProductId) ?? null;
    const isNonStockService = produtoId === null && r.processaStocks === false;
    if (produtoId === null) orphanCount++;
    if (isNonStockService) nonStockServiceCount++;
    return {
      farmaciaId,
      externalSaleId: r.externalSaleId,
      externalSaleLineId: r.externalSaleLineId,
      sequencia: r.sequencia,
      dataVenda: r.dataVenda,
      tipoDocumento: r.tipoDocumento,
      tipoDocumentoClass: r.tipoDocumentoClass,
      externalProductId: r.externalProductId,
      produtoId,
      isNonStockService,
      quantidade: r.quantidade,
      pvpUnitario: r.pvpUnitario,
      valorLinha: r.valorLinha,
      ivaValor: r.ivaValor,
      descontoValor: r.descontoValor,
      comparticipacao1: r.comparticipacao1,
      comparticipacao2: r.comparticipacao2,
      entidadeId: r.entidadeId,
      rawJson: keepRawJson ? r.raw : RAW_STUB,
    };
  });

  // Dedupe intra-batch por (farmaciaId, externalSaleLineId) — last wins —
  // para o ON CONFLICT bulk não recusar a mesma chave duas vezes.
  const deduped = dedupeByKey(
    rows,
    (r) => `${r.farmaciaId} ${r.externalSaleLineId}`
  );

  // Bulk upsert num único INSERT ... ON CONFLICT (1 round-trip ao Neon,
  // vs N upserts linha-a-linha). Fallback per-row se o bulk falhar, para
  // isolar a linha problemática e manter o reporting por-item.
  try {
    await bulkUpsertSalesLines(ctx.prisma, deduped);
    upserted = deduped.length;
  } catch (bulkErr) {
    console.warn(
      `[bootstrap/sales-lines] bulk_failed_fallback_per_row ${JSON.stringify({
        tenant: ctx.tenant.slug,
        farmaciaId,
        rows: deduped.length,
        message: (bulkErr instanceof Error ? bulkErr.message : String(bulkErr)).slice(0, 200),
      })}`
    );
    upserted = 0;
    for (const row of deduped) {
      try {
        const data = {
          ...row,
          rawJson: row.rawJson as unknown as Prisma.InputJsonValue,
        };
        await ctx.prisma.ingestVendaLinhaRaw.upsert({
          where: {
            farmaciaId_externalSaleLineId: {
              farmaciaId,
              externalSaleLineId: row.externalSaleLineId,
            },
          },
          create: data,
          update: data,
        });
        upserted++;
      } catch (err) {
        errors.push({
          index: -1,
          reason: "upsert_failed",
          externalId: row.externalSaleLineId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  const operationalOrphans = orphanCount - nonStockServiceCount;

  // Distribuição por classe — observabilidade do classifier server-side
  const classDist: Record<string, number> = {};
  for (const r of resolved) {
    classDist[r.tipoDocumentoClass] = (classDist[r.tipoDocumentoClass] ?? 0) + 1;
  }

  const durationMs = Date.now() - t0;
  console.log(
    `[bootstrap/sales-lines] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
      upserted,
      orphanProductLines: orphanCount,
      nonStockServiceLines: nonStockServiceCount,
      operationalOrphans,
      skipped: skipped.length,
      errors: errors.length,
      classDist,
      classifierTableSize: classifierMap.size,
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

  const response: BootstrapBatchResponse & {
    orphanProductLines: number;
    nonStockServiceLines: number;
    operationalOrphans: number;
  } = {
    ok: true,
    accepted: items.length,
    upserted,
    orphanProductLines: orphanCount,
    nonStockServiceLines: nonStockServiceCount,
    operationalOrphans,
    skipped,
    errors,
    durationMs,
  };
  return NextResponse.json(response);
});
