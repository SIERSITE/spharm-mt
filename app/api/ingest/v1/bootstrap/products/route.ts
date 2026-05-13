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

  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? ({} as ProductPayload);
    const externalProductId = asIntOrNull(raw.externalProductId);
    const cnp = asIntOrNull(raw.cnp);
    const designacao = asStringOrNull(raw.designacao);

    // CNP é a chave canónica do catálogo (Produto.cnp @unique).
    // Sem CNP, o produto não pode entrar na tabela Produto.
    if (cnp === null) {
      skipped.push({
        index: i,
        reason: "missing_cnp",
        externalId: externalProductId ?? undefined,
      });
      continue;
    }
    if (designacao === null) {
      skipped.push({
        index: i,
        reason: "missing_designacao",
        externalId: externalProductId ?? undefined,
      });
      continue;
    }

    const pvp = asDecimalOrNull(raw.pvp);
    const pmc = asDecimalOrNull(raw.pmc);
    const puc = asDecimalOrNull(raw.puc);
    const dataUltimaVenda = asIsoDateOrNull(raw.dataUltimaVenda);
    const dataUltimaCompra = asIsoDateOrNull(raw.dataUltimaCompra);
    const flagRetirado = asBoolOrFalse(raw.retirado);
    const flagGenerico = asBoolOrFalse(raw.generico);
    const flagMnsrmNCompart = asBoolOrFalse(raw.mnsrmNCompart);
    const fornecedorExternalId = asIntOrNull(raw.fornecedorHabitualId);
    const fornecedorOrigem = asStringOrNull(raw.fornecedorHabitualNome);

    try {
      // 4.1 Upsert Produto por cnp. Additive — campos populados por
      // outras fontes (dci, codigoATC, fabricanteId) NÃO são tocados.
      const produto = await ctx.prisma.produto.upsert({
        where: { cnp },
        create: {
          cnp,
          externalProductId: externalProductId ?? null,
          designacao,
          flagGenerico,
          flagMnsrmNCompart,
          origemDados: "FARMACIA",
        },
        update: {
          externalProductId: externalProductId ?? undefined,
          designacao,
          flagGenerico,
          flagMnsrmNCompart,
        },
      });

      // 4.2 Upsert ProdutoFarmacia (produtoId, farmaciaId). NÃO toca em
      // stockAtual/Minimo/Maximo — esses vêm do endpoint /stock.
      await ctx.prisma.produtoFarmacia.upsert({
        where: {
          produtoId_farmaciaId: {
            produtoId: produto.id,
            farmaciaId,
          },
        },
        create: {
          produtoId: produto.id,
          farmaciaId,
          externalProductId: externalProductId ?? null,
          pvp: pvp ?? null,
          pmc: pmc ?? null,
          puc: puc ?? null,
          dataUltimaVenda,
          dataUltimaCompra,
          flagRetirado,
          fornecedorExternalId: fornecedorExternalId ?? null,
          fornecedorOrigem: fornecedorOrigem ?? null,
        },
        update: {
          externalProductId: externalProductId ?? undefined,
          pvp: pvp ?? undefined,
          pmc: pmc ?? undefined,
          puc: puc ?? undefined,
          dataUltimaVenda: dataUltimaVenda ?? undefined,
          dataUltimaCompra: dataUltimaCompra ?? undefined,
          flagRetirado,
          fornecedorExternalId: fornecedorExternalId ?? undefined,
          fornecedorOrigem: fornecedorOrigem ?? undefined,
        },
      });
      upserted++;
    } catch (err) {
      errors.push({
        index: i,
        reason: "upsert_failed",
        externalId: externalProductId ?? undefined,
        message: err instanceof Error ? err.message : String(err),
      });
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
