/**
 * app/api/ingest/v1/bootstrap/products/route.ts
 *
 * POST /api/ingest/v1/bootstrap/products
 *
 * Recebe um batch de payloads canónicos de produto e faz upsert em:
 *   · `Produto` (catálogo — chaveado por `cnp`)
 *   · `ProdutoFarmacia` (per-farmacia — chaveado por `(produtoId, farmaciaId)`)
 *
 * Idempotência: reupload do mesmo batch actualiza in-place. Não apaga
 * dados existentes. Upsert additive — campos não-presentes no payload
 * NÃO são tocados (e.g. dci/codigoATC ficam intactos).
 *
 * Auth: withIntegrationAuth (Bearer + X-Tenant-Slug, padrão dos outros
 * endpoints /api/ingest/v1/*).
 *
 * Feature flag: ENABLE_AGENT_BOOTSTRAP=1 (lib/env.ts). Sem isto → 503.
 *
 * Body:
 *   {
 *     farmaciaId: string,
 *     items: ProductPayload[]    // até BOOTSTRAP_MAX_BATCH_SIZE
 *   }
 *
 * Response 200 sucesso:
 *   {
 *     ok: true,
 *     accepted: N,
 *     upserted: N,
 *     skipped: [{ index, reason, externalId? }],
 *     errors: [{ index, reason, externalId?, message }],
 *     durationMs: number
 *   }
 */

import { NextResponse } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import {
  assertBootstrapEnabled,
  assertFarmaciaInTenant,
  parseBatchBody,
  isFailure,
  asIntOrNull,
  asDecimalOrNull,
  asStringOrNull,
  asBoolOrFalse,
  asIsoDateOrNull,
  type BootstrapBatchResponse,
} from "@/lib/ingest/bootstrap";
import {
  bulkUpsertProdutosByCnp,
  bulkUpsertProdutoFarmaciaProducts,
  dedupeByKey,
  type ProdutoFarmaciaProductRow,
} from "@/lib/ingest/bulk";
import { normalizeIva } from "@/lib/iva";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ProductPayload = {
  externalProductId: unknown;
  cnp: unknown;
  designacao: unknown;
  pvp: unknown;
  pmc: unknown;
  puc: unknown;
  dataUltimaVenda: unknown;
  dataUltimaCompra: unknown;
  retirado: unknown;
  generico: unknown;
  mnsrmNCompart: unknown;
  fornecedorHabitualId: unknown;
  fornecedorHabitualNome: unknown;
  /**
   * Taxa IVA do produto na tabela mestre `dbo.Stocks`. Capturada pelo
   * agent rev39+ via discovery dinâmica (`Stocks.[IVA]`, `[Codigo_IVA]`,
   * `[TaxaIVA]` — depende do quirk do SoftReis). Aceita fracção
   * (0.06/0.13/0.23) OU percentagem (6/13/23). Normaliza para {6,13,23,null}.
   * Quando o agent (≤ rev38) não envia, fica undefined → preserva o
   * existente em BD via COALESCE.
   */
  taxaIva: unknown;
};

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  // 1. Feature flag
  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  // 2. Body
  const parsed = await parseBatchBody<ProductPayload>(req);
  if (isFailure(parsed)) return parsed.response;
  const { farmaciaId, items } = parsed;

  // 3. Farmácia existe no tenant
  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[bootstrap/products] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
    })}`
  );

  // 4. Upsert linha-a-linha. SEM `$transaction` wrapper: cada upsert
  // (Produto e ProdutoFarmacia) é internamente atómico via unique
  // constraints. Eliminar a transaction reduz ~50ms/item de overhead
  // BEGIN/COMMIT — significativo em batches grandes via Neon serverless.
  //
  // Edge case: se Produto upsert OK e ProdutoFarmacia upsert falha,
  // ficamos com Produto sem ProdutoFarmacia para esta farmácia. NÃO é
  // inconsistência — retry do batch refaz o ProdutoFarmacia (idempotente
  // via @@unique(produtoId, farmaciaId)). Reportado em `errors[]` para
  // diagnose.
  const skipped: BootstrapBatchResponse["skipped"] = [];
  const errors: BootstrapBatchResponse["errors"] = [];
  let upserted = 0;

  type Accepted = {
    index: number;
    cnp: number;
    externalProductId: number | null;
    designacao: string;
    flagGenerico: boolean;
    flagMnsrmNCompart: boolean;
    pvp: number | null;
    pmc: number | null;
    puc: number | null;
    dataUltimaVenda: Date | null;
    dataUltimaCompra: Date | null;
    flagRetirado: boolean;
    fornecedorExternalId: number | null;
    fornecedorOrigem: string | null;
    /** {6, 13, 23, null}. null se agent não enviou ou valor não-canónico. */
    taxaIvaPercent: number | null;
  };

  // 1) Validar/coercer. CNP é a chave canónica (Produto.cnp @unique);
  //    sem CNP o produto não entra no catálogo.
  const accepted: Accepted[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? ({} as ProductPayload);
    const externalProductId = asIntOrNull(raw.externalProductId);
    const cnp = asIntOrNull(raw.cnp);
    const designacao = asStringOrNull(raw.designacao);
    if (cnp === null) {
      skipped.push({ index: i, reason: "missing_cnp", externalId: externalProductId ?? undefined });
      continue;
    }
    if (designacao === null) {
      skipped.push({ index: i, reason: "missing_designacao", externalId: externalProductId ?? undefined });
      continue;
    }
    // IVA: agent ≤ rev38 não envia (undefined) → fica null e o pipeline
    // preserva o existente via COALESCE no bulk. rev39+ envia número
    // (fracção 0.06 ou percentagem 6) que normalizamos para {6,13,23,null}.
    const taxaIvaRaw = asDecimalOrNull(raw.taxaIva);
    const taxaIvaPercent = taxaIvaRaw === null ? null : (normalizeIva(taxaIvaRaw) ?? null);
    accepted.push({
      index: i,
      cnp,
      externalProductId,
      designacao,
      flagGenerico: asBoolOrFalse(raw.generico),
      flagMnsrmNCompart: asBoolOrFalse(raw.mnsrmNCompart),
      pvp: asDecimalOrNull(raw.pvp),
      pmc: asDecimalOrNull(raw.pmc),
      puc: asDecimalOrNull(raw.puc),
      dataUltimaVenda: asIsoDateOrNull(raw.dataUltimaVenda),
      dataUltimaCompra: asIsoDateOrNull(raw.dataUltimaCompra),
      flagRetirado: asBoolOrFalse(raw.retirado),
      fornecedorExternalId: asIntOrNull(raw.fornecedorHabitualId),
      fornecedorOrigem: asStringOrNull(raw.fornecedorHabitualNome),
      taxaIvaPercent,
    });
  }

  // Dedupe por cnp (last wins) — evita o ON CONFLICT recusar a mesma
  // chave duas vezes no bulk e iguala a semântica de upserts sequenciais.
  const dedup = dedupeByKey(accepted, (a) => String(a.cnp));

  // 2) Bulk: Produto por cnp (RETURNING id) → mapa cnp→id → ProdutoFarmacia.
  //    Update aditivo: campos fortes do catálogo (dci, codigoATC, etc.) e
  //    campos de stock NÃO são tocados. Fallback per-row se o bulk falhar.
  try {
    const cnpToId = await bulkUpsertProdutosByCnp(
      ctx.prisma,
      dedup.map((a) => ({
        cnp: a.cnp,
        externalProductId: a.externalProductId,
        designacao: a.designacao,
        flagGenerico: a.flagGenerico,
        flagMnsrmNCompart: a.flagMnsrmNCompart,
      }))
    );
    const pfRows: ProdutoFarmaciaProductRow[] = [];
    for (const a of dedup) {
      const produtoId = cnpToId.get(a.cnp);
      if (!produtoId) continue;
      pfRows.push({
        produtoId,
        farmaciaId,
        externalProductId: a.externalProductId,
        pvp: a.pvp,
        pmc: a.pmc,
        puc: a.puc,
        dataUltimaVenda: a.dataUltimaVenda,
        dataUltimaCompra: a.dataUltimaCompra,
        flagRetirado: a.flagRetirado,
        fornecedorExternalId: a.fornecedorExternalId,
        fornecedorOrigem: a.fornecedorOrigem,
        taxaIvaPercent: a.taxaIvaPercent,
      });
    }
    await bulkUpsertProdutoFarmaciaProducts(ctx.prisma, pfRows);
    upserted = dedup.length;
  } catch (bulkErr) {
    console.warn(
      `[bootstrap/products] bulk_failed_fallback_per_row ${JSON.stringify({
        tenant: ctx.tenant.slug,
        farmaciaId,
        rows: dedup.length,
        message: (bulkErr instanceof Error ? bulkErr.message : String(bulkErr)).slice(0, 200),
      })}`
    );
    upserted = 0;
    for (const a of dedup) {
      try {
        const produto = await ctx.prisma.produto.upsert({
          where: { cnp: a.cnp },
          create: {
            cnp: a.cnp,
            externalProductId: a.externalProductId ?? null,
            designacao: a.designacao,
            flagGenerico: a.flagGenerico,
            flagMnsrmNCompart: a.flagMnsrmNCompart,
            origemDados: "FARMACIA",
          },
          update: {
            externalProductId: a.externalProductId ?? undefined,
            designacao: a.designacao,
            flagGenerico: a.flagGenerico,
            flagMnsrmNCompart: a.flagMnsrmNCompart,
          },
        });
        await ctx.prisma.produtoFarmacia.upsert({
          where: { produtoId_farmaciaId: { produtoId: produto.id, farmaciaId } },
          create: {
            produtoId: produto.id,
            farmaciaId,
            externalProductId: a.externalProductId ?? null,
            pvp: a.pvp ?? null,
            pmc: a.pmc ?? null,
            puc: a.puc ?? null,
            dataUltimaVenda: a.dataUltimaVenda,
            dataUltimaCompra: a.dataUltimaCompra,
            flagRetirado: a.flagRetirado,
            fornecedorExternalId: a.fornecedorExternalId ?? null,
            fornecedorOrigem: a.fornecedorOrigem ?? null,
            ...(a.taxaIvaPercent !== null
              ? {
                  taxaIvaPercent: a.taxaIvaPercent,
                  taxaIvaSource: "STOCKS_MESTRE",
                  taxaIvaUpdatedAt: new Date(),
                }
              : {}),
          },
          update: {
            externalProductId: a.externalProductId ?? undefined,
            pvp: a.pvp ?? undefined,
            pmc: a.pmc ?? undefined,
            puc: a.puc ?? undefined,
            dataUltimaVenda: a.dataUltimaVenda ?? undefined,
            dataUltimaCompra: a.dataUltimaCompra ?? undefined,
            flagRetirado: a.flagRetirado,
            fornecedorExternalId: a.fornecedorExternalId ?? undefined,
            fornecedorOrigem: a.fornecedorOrigem ?? undefined,
            // IVA: rev39+ → sobrescreve com source mestre. rev≤38 → null.
            ...(a.taxaIvaPercent !== null
              ? {
                  taxaIvaPercent: a.taxaIvaPercent,
                  taxaIvaSource: "STOCKS_MESTRE",
                  taxaIvaUpdatedAt: new Date(),
                }
              : {}),
          },
        });
        upserted++;
      } catch (err) {
        errors.push({
          index: a.index,
          reason: "upsert_failed",
          externalId: a.externalProductId ?? undefined,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const durationMs = Date.now() - t0;
  console.log(
    `[bootstrap/products] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
      upserted,
      skipped: skipped.length,
      errors: errors.length,
      durationMs,
    })}`
  );
  for (const e of errors.slice(0, 10)) {
    console.warn(`[bootstrap/products] item_error ${JSON.stringify({
      tenant: ctx.tenant.slug,
      index: e.index,
      externalId: e.externalId,
      reason: e.reason,
      message: e.message.slice(0, 200),
    })}`);
  }

  const response: BootstrapBatchResponse = {
    ok: true,
    accepted: items.length,
    upserted,
    skipped,
    errors,
    durationMs,
  };
  return NextResponse.json(response);
});
