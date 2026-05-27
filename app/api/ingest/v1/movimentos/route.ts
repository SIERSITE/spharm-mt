/**
 * app/api/ingest/v1/movimentos/route.ts
 *
 * POST /api/ingest/v1/movimentos
 *
 * Block A3 — endpoint canónico para upload de StocksMov via agent local.
 * UPSERT idempotente em `MovimentoArtigo` por `(farmaciaId, externalMovId)`.
 * Snapshot raw paralelo em `IngestStocksMovRaw` (chave composta com
 * `ingestRunId` para replay).
 *
 * Garantias de isolamento:
 *   · ESCREVE em `MovimentoArtigo` (canónico) + `IngestStocksMovRaw` (cru)
 *   · NÃO toca Venda / Compra / Devolucao / VendaMensal / AjusteStock
 *   · NÃO toca dashboard reads
 *   · Resolução `externalProductId → produtoId` via `resolveProdutoIdMap`
 *     (ProdutoFarmacia, mesma regra canónica que sales-lines/stock)
 *
 * Classificação:
 *   O agent já envia `tipo` pré-classificado por `lib/movimento-classifier.ts`.
 *   O endpoint re-classifica defensivamente (raw fields também viajam no
 *   payload). Se o resultado for DESCONHECIDO, regista-o no campo `tipo`
 *   sem rejeitar — counts ficam no response para o agent reportar.
 *
 * Idempotência:
 *   ON CONFLICT (farmaciaId, externalMovId) DO UPDATE SET …
 *   `IngestStocksMovRaw` indexa por (farmaciaId, externalMovId, ingestRunId)
 *   — re-run com mesmo `ingestRunId` faz UPDATE; re-run com novo
 *   `ingestRunId` CRIA um snapshot adicional (auditoria).
 *
 * Auth: withIntegrationAuth (Bearer + X-Tenant-Slug).
 * Feature flag: ENABLE_AGENT_BOOTSTRAP=1.
 *
 * Hard limits:
 *   · max 500 items / batch (StocksMov pesa mais que CompraLine — JSON
 *     raw payload + ~15 campos canónicos = ~1 KB/row; 500 KB/batch é
 *     o sweet spot para timeout Vercel 60s).
 *
 * Body:
 *   {
 *     farmaciaId: string,
 *     ingestRunId: string,
 *     items: MovimentoLinePayload[]   // <= 500
 *   }
 *
 * Response 200:
 *   {
 *     ok: true,
 *     accepted: N,
 *     upserted: created + updated,
 *     created, updated,
 *     desconhecidos: N,          // promovidos a DESCONHECIDO
 *     orphanProducts: N,         // externalProductId sem ProdutoFarmacia
 *     skipped: [{...}],
 *     errors:  [{...}],
 *     durationMs,
 *     byTipo: { VENDA: N, ... }  // contagem por tipo
 *   }
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
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
import { resolveProdutoIdMap } from "@/lib/aggregate/resolve-produto";
import {
  classifyMovimento,
  type FkPattern,
} from "@/lib/movimento-classifier";
import type { TipoMovimentoArtigo } from "@/generated/prisma/client";
// O classifier devolve o seu próprio union type local (1:1 com Prisma enum);
// usamos o do Prisma no schema-side e confiamos no string match no boundary.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// rev35: bumped 60→120s para alinhar com aggregate-compras/devoluções.
// Set-based UPSERT torna 60s improvável de saturar, mas margem para
// payloads frios (cold function start + DB connection pool warm-up).
export const maxDuration = 120;

const HARD_BATCH_LIMIT = 500;

type MovimentoLinePayload = {
  externalMovId: unknown;
  externalProductId: unknown; // serializado como string para preservar ints largos

  dataMovimento: unknown;
  quantidade: unknown;
  quantidadeBonus: unknown;
  existenciaApos: unknown;
  custoUnitario: unknown;
  pmcAnterior: unknown;
  pmcNovo: unknown;
  armazemId: unknown;

  externalDetalheId: unknown;
  externalSuspDetalheId: unknown;
  externalCreditoDetalheId: unknown;
  externalRecpDetalheId: unknown;
  externalDevolucaoDetalheId: unknown;
  externalMovStocksDetId: unknown;

  movStocksCabId: unknown;
  movStocksCabTipoDocId: unknown;
  movStocksCabMotivoId: unknown;
  movStocksCabMotivoTexto: unknown;
  movStocksCabSituacao: unknown;
  movStocksCabUserId: unknown;
  movStocksCabPosto: unknown;
  movStocksCabNDocExterno: unknown;

  externalSaleId: unknown;
  tipoDocumentoId: unknown;
};

type MovimentosResponse = BootstrapBatchResponse & {
  created: number;
  updated: number;
  desconhecidos: number;
  orphanProducts: number;
  byTipo: Partial<Record<TipoMovimentoArtigo, number>>;
};

type Normalised = {
  externalMovId: number;
  externalProductId: string; // serializado em string (CodigoID pode ser >2^31 em ERPs futuros)
  externalProductIdNum: number;
  produtoId: string | null;

  dataMovimento: Date;
  tipo: TipoMovimentoArtigo;
  classifyReason: string;

  quantidade: number;
  quantidadeBonus: number;
  existenciaApos: number;
  custoUnitario: number;
  pmcAnterior: number;
  pmcNovo: number;
  armazemId: number;

  externalDetalheId: number | null;
  externalSuspDetalheId: number | null;
  externalCreditoDetalheId: number | null;
  externalRecpDetalheId: number | null;
  externalDevolucaoDetalheId: number | null;
  externalMovStocksDetId: number | null;

  movStocksCabId: number | null;
  movStocksCabTipoDocId: number | null;
  movStocksCabMotivoId: number | null;
  movStocksCabMotivoTexto: string | null;
  movStocksCabSituacao: string | null;
  movStocksCabUserId: number | null;
  movStocksCabPosto: number | null;
  movStocksCabNDocExterno: string | null;

  externalSaleId: number | null;
  tipoDocumentoId: number | null;
};

/**
 * Determinístico (md5 sobre `farmaciaId:externalMovId`) — gera o mesmo
 * `MovimentoArtigo.id` em runs sucessivos para o mesmo movimento ERP.
 * Substitui o helper SQL anterior (`'mov_' || substr(md5(…), 1, 24)`)
 * para o UPSERT set-based ter os IDs prontos do lado JS. Compatibilidade
 * preservada (mesmo formato → mesmo ID se os inputs forem iguais).
 */
function genMovId(farmaciaId: string, externalMovId: number): string {
  return (
    "mov_" +
    createHash("md5")
      .update(`${farmaciaId}:${externalMovId}`)
      .digest("hex")
      .slice(0, 24)
  );
}

function asExternalProductId(v: unknown): { num: number; str: string } | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    return { num: Math.trunc(v), str: String(Math.trunc(v)) };
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return { num: Math.trunc(n), str: v.trim() };
  }
  return null;
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  // Body shape estendido (ingestRunId obrigatório, não vem por parseBatchBody)
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("ingestRunId" in body) ||
    typeof (body as { ingestRunId: unknown }).ingestRunId !== "string"
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_ingest_run_id",
        message: "Body obriga `ingestRunId: string`.",
      },
      { status: 400 },
    );
  }
  const ingestRunId = (body as { ingestRunId: string }).ingestRunId.trim();
  if (!ingestRunId) {
    return NextResponse.json(
      { ok: false, error: "empty_ingest_run_id" },
      { status: 400 },
    );
  }

  // Reutiliza parseBatchBody sobre o body já lido — temos de simular um Request.
  const mockReq = {
    async json() {
      return body;
    },
  } as Request;
  const parsed = await parseBatchBody<MovimentoLinePayload>(mockReq);
  if (isFailure(parsed)) return parsed.response;
  const { farmaciaId, items } = parsed;

  if (items.length > HARD_BATCH_LIMIT) {
    return NextResponse.json(
      {
        ok: false,
        error: "payload_too_large",
        message: `Batch tem ${items.length} items; máximo ${HARD_BATCH_LIMIT} para movimentos.`,
      },
      { status: 413 },
    );
  }

  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[ingest/movimentos] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
      ingestRunId,
    })}`,
  );

  const skipped: MovimentosResponse["skipped"] = [];
  const errors: MovimentosResponse["errors"] = [];

  // ── Pass 1: normalizar + classificar (sem produtoId ainda) ─────
  const normalised: Normalised[] = [];
  const rawByIndex = new Map<number, MovimentoLinePayload>();
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? ({} as MovimentoLinePayload);

    const externalMovId = asIntOrNull(raw.externalMovId);
    if (externalMovId === null) {
      skipped.push({ index: i, reason: "missing_external_mov_id" });
      continue;
    }
    const epId = asExternalProductId(raw.externalProductId);
    if (epId === null) {
      skipped.push({ index: i, reason: "missing_external_product_id", externalId: externalMovId });
      continue;
    }
    const dataMovimento = asIsoDateOrNull(raw.dataMovimento);
    if (dataMovimento === null) {
      skipped.push({ index: i, reason: "missing_data_movimento", externalId: externalMovId });
      continue;
    }
    const quantidade = asIntOrNull(raw.quantidade);
    if (quantidade === null) {
      skipped.push({ index: i, reason: "missing_quantidade", externalId: externalMovId });
      continue;
    }
    const existenciaApos = asIntOrNull(raw.existenciaApos);
    if (existenciaApos === null) {
      skipped.push({ index: i, reason: "missing_existencia_apos", externalId: externalMovId });
      continue;
    }
    const armazemId = asIntOrNull(raw.armazemId);
    if (armazemId === null) {
      skipped.push({ index: i, reason: "missing_armazem_id", externalId: externalMovId });
      continue;
    }

    // FK pattern
    const fk: FkPattern = {
      detalheId: asIntOrNull(raw.externalDetalheId),
      suspDetalheId: asIntOrNull(raw.externalSuspDetalheId),
      creditoDetalheId: asIntOrNull(raw.externalCreditoDetalheId),
      recpDetalheId: asIntOrNull(raw.externalRecpDetalheId),
      devolucaoDetalheId: asIntOrNull(raw.externalDevolucaoDetalheId),
      movStocksDetId: asIntOrNull(raw.externalMovStocksDetId),
    };
    const motivoTexto = asStringOrNull(raw.movStocksCabMotivoTexto);
    const cabTipoDocId = asIntOrNull(raw.movStocksCabTipoDocId);
    const tipoDocumentoId = asIntOrNull(raw.tipoDocumentoId);

    const cls = classifyMovimento({
      fk,
      atendimentoTipoDocId: tipoDocumentoId,
      motivoTexto,
      cabTipoDocId,
      qtd: quantidade,
    });

    rawByIndex.set(i, raw);
    normalised.push({
      externalMovId,
      externalProductId: epId.str,
      externalProductIdNum: epId.num,
      produtoId: null,
      dataMovimento,
      tipo: cls.tipo,
      classifyReason: cls.reason,
      quantidade,
      quantidadeBonus: asIntOrNull(raw.quantidadeBonus) ?? 0,
      existenciaApos,
      custoUnitario: asDecimalOrNull(raw.custoUnitario) ?? 0,
      pmcAnterior: asDecimalOrNull(raw.pmcAnterior) ?? 0,
      pmcNovo: asDecimalOrNull(raw.pmcNovo) ?? 0,
      armazemId,
      externalDetalheId: fk.detalheId,
      externalSuspDetalheId: fk.suspDetalheId,
      externalCreditoDetalheId: fk.creditoDetalheId,
      externalRecpDetalheId: fk.recpDetalheId,
      externalDevolucaoDetalheId: fk.devolucaoDetalheId,
      externalMovStocksDetId: fk.movStocksDetId,
      movStocksCabId: asIntOrNull(raw.movStocksCabId),
      movStocksCabTipoDocId: cabTipoDocId,
      movStocksCabMotivoId: asIntOrNull(raw.movStocksCabMotivoId),
      movStocksCabMotivoTexto: motivoTexto,
      movStocksCabSituacao: asStringOrNull(raw.movStocksCabSituacao),
      movStocksCabUserId: asIntOrNull(raw.movStocksCabUserId),
      movStocksCabPosto: asIntOrNull(raw.movStocksCabPosto),
      movStocksCabNDocExterno: asStringOrNull(raw.movStocksCabNDocExterno),
      externalSaleId: asIntOrNull(raw.externalSaleId),
      tipoDocumentoId,
    });
  }

  // ── Pass 2: resolver externalProductId → produtoId em lote ─────
  const externalIds = Array.from(
    new Set(normalised.map((n) => n.externalProductIdNum)),
  );
  const produtoIdByExternal = await resolveProdutoIdMap(
    ctx.prisma,
    farmaciaId,
    externalIds,
  );
  let orphanProducts = 0;
  for (const n of normalised) {
    const pid = produtoIdByExternal.get(n.externalProductIdNum);
    n.produtoId = pid ?? null;
    if (!pid) orphanProducts++;
  }

  // ── Pass 3: UPSERT SET-BASED (rev35) ──────────────────────────
  // Construímos um único `INSERT … VALUES (…), (…), … ON CONFLICT …`
  // com todas as N linhas do batch. Substitui o loop linha-a-linha
  // (~50 ms/row) por 2 round-trips totais (canónico + raw). 500 linhas
  // passam de ~25 s para ~1-2 s. Resolve o HTTP 504 rev34.
  //
  // IDs gerados em JS via md5 — DETERMINÍSTICO + STÁVEL (mesmo input
  // produz mesmo id → re-runs UPDATEam em vez de duplicar com new id).
  // Compatível com o formato SQL anterior (`'mov_' || substr(md5(...),...)`).
  //
  // Idempotência preservada por (farmaciaId, externalMovId) UNIQUE +
  // ON CONFLICT DO UPDATE. Retries do agent UPSERTam rows já inseridas.
  let created = 0;
  let updated = 0;
  let desconhecidos = 0;
  const byTipo: Partial<Record<TipoMovimentoArtigo, number>> = {};
  for (const n of normalised) {
    if (n.tipo === "DESCONHECIDO") desconhecidos++;
    byTipo[n.tipo] = (byTipo[n.tipo] ?? 0) + 1;
  }

  if (normalised.length > 0) {
    try {
      const movValues = normalised.map(
        (n) =>
          Prisma.sql`(
            ${genMovId(farmaciaId, n.externalMovId)},
            ${farmaciaId}, ${n.externalMovId}, ${n.externalProductId}, ${n.produtoId},
            ${n.dataMovimento}, ${n.tipo}::"TipoMovimentoArtigo",
            ${n.quantidade}, ${n.quantidadeBonus}, ${n.existenciaApos},
            ${n.custoUnitario}, ${n.pmcAnterior}, ${n.pmcNovo}, ${n.armazemId},
            ${n.externalDetalheId}, ${n.externalSuspDetalheId}, ${n.externalCreditoDetalheId},
            ${n.externalRecpDetalheId}, ${n.externalDevolucaoDetalheId}, ${n.externalMovStocksDetId},
            ${n.movStocksCabId}, ${n.movStocksCabTipoDocId}, ${n.movStocksCabMotivoId},
            ${n.movStocksCabMotivoTexto}, ${n.movStocksCabSituacao}, ${n.movStocksCabUserId},
            ${n.movStocksCabPosto}, ${n.movStocksCabNDocExterno},
            ${n.externalSaleId}, ${n.tipoDocumentoId},
            ${ingestRunId}, NOW(), NOW()
          )`,
      );

      const upsertResult = await ctx.prisma.$queryRaw<Array<{ inserted: boolean }>>(Prisma.sql`
        INSERT INTO "MovimentoArtigo" (
          "id", "farmaciaId", "externalMovId", "externalProductId", "produtoId",
          "dataMovimento", "tipo",
          "quantidade", "quantidadeBonus", "existenciaApos",
          "custoUnitario", "pmcAnterior", "pmcNovo", "armazemId",
          "externalDetalheId", "externalSuspDetalheId", "externalCreditoDetalheId",
          "externalRecpDetalheId", "externalDevolucaoDetalheId", "externalMovStocksDetId",
          "movStocksCabId", "movStocksCabTipoDocId", "movStocksCabMotivoId",
          "movStocksCabMotivoTexto", "movStocksCabSituacao", "movStocksCabUserId",
          "movStocksCabPosto", "movStocksCabNDocExterno",
          "externalSaleId", "tipoDocumentoId",
          "ingestRunId", "ingestedAt", "updatedAt"
        )
        VALUES ${Prisma.join(movValues, ", ")}
        ON CONFLICT ("farmaciaId", "externalMovId") DO UPDATE SET
          "externalProductId"           = EXCLUDED."externalProductId",
          "produtoId"                   = EXCLUDED."produtoId",
          "dataMovimento"               = EXCLUDED."dataMovimento",
          "tipo"                        = EXCLUDED."tipo",
          "quantidade"                  = EXCLUDED."quantidade",
          "quantidadeBonus"             = EXCLUDED."quantidadeBonus",
          "existenciaApos"              = EXCLUDED."existenciaApos",
          "custoUnitario"               = EXCLUDED."custoUnitario",
          "pmcAnterior"                 = EXCLUDED."pmcAnterior",
          "pmcNovo"                     = EXCLUDED."pmcNovo",
          "armazemId"                   = EXCLUDED."armazemId",
          "externalDetalheId"           = EXCLUDED."externalDetalheId",
          "externalSuspDetalheId"       = EXCLUDED."externalSuspDetalheId",
          "externalCreditoDetalheId"    = EXCLUDED."externalCreditoDetalheId",
          "externalRecpDetalheId"       = EXCLUDED."externalRecpDetalheId",
          "externalDevolucaoDetalheId"  = EXCLUDED."externalDevolucaoDetalheId",
          "externalMovStocksDetId"      = EXCLUDED."externalMovStocksDetId",
          "movStocksCabId"              = EXCLUDED."movStocksCabId",
          "movStocksCabTipoDocId"       = EXCLUDED."movStocksCabTipoDocId",
          "movStocksCabMotivoId"        = EXCLUDED."movStocksCabMotivoId",
          "movStocksCabMotivoTexto"     = EXCLUDED."movStocksCabMotivoTexto",
          "movStocksCabSituacao"        = EXCLUDED."movStocksCabSituacao",
          "movStocksCabUserId"          = EXCLUDED."movStocksCabUserId",
          "movStocksCabPosto"           = EXCLUDED."movStocksCabPosto",
          "movStocksCabNDocExterno"     = EXCLUDED."movStocksCabNDocExterno",
          "externalSaleId"              = EXCLUDED."externalSaleId",
          "tipoDocumentoId"             = EXCLUDED."tipoDocumentoId",
          "ingestRunId"                 = EXCLUDED."ingestRunId",
          "updatedAt"                   = NOW()
        RETURNING (xmax = 0) AS inserted
      `);
      for (const r of upsertResult) {
        if (r.inserted) created++;
        else updated++;
      }

      // Snapshot cru paralelo — também set-based. Mesmo padrão
      // multi-VALUES + ON CONFLICT. Idempotente por (farmaciaId,
      // externalMovId, ingestRunId) — re-run com mesmo ingestRunId
      // UPDATEa em vez de criar snapshot adicional.
      const rawValues = normalised.map((n, idx) => {
        const rawRow = rawByIndex.get(idx) ?? {};
        return Prisma.sql`(${farmaciaId}, ${n.externalMovId}, ${JSON.stringify(rawRow)}::jsonb, ${ingestRunId})`;
      });
      await ctx.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "IngestStocksMovRaw" ("farmaciaId", "externalMovId", "payload", "ingestRunId")
        VALUES ${Prisma.join(rawValues, ", ")}
        ON CONFLICT ("farmaciaId", "externalMovId", "ingestRunId") DO UPDATE SET
          "payload" = EXCLUDED."payload"
      `);
    } catch (err) {
      // Set-based falha = batch inteiro falha. Idempotência preserva-se:
      // re-run com mesmo ingestRunId + mesmas linhas é safe. Reportamos
      // o erro como bloqueador do batch e deixamos o agent re-tentar.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[ingest/movimentos] set-based UPSERT falhou tenant=${ctx.tenant.slug} farmaciaId=${farmaciaId} ingestRunId=${ingestRunId} items=${normalised.length}: ${msg}`,
      );
      return NextResponse.json(
        {
          ok: false,
          error: "upsert_batch_failed",
          message: msg,
          accepted: items.length,
          batchSize: normalised.length,
        },
        { status: 500 },
      );
    }
  }

  const durationMs = Date.now() - t0;
  const upserted = created + updated;

  const response: MovimentosResponse = {
    ok: true,
    accepted: items.length,
    upserted,
    created,
    updated,
    desconhecidos,
    orphanProducts,
    byTipo,
    skipped,
    errors,
    durationMs,
  };

  console.log(
    `[ingest/movimentos] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      ingestRunId,
      accepted: items.length,
      created,
      updated,
      desconhecidos,
      orphanProducts,
      byTipo,
      skipped: skipped.length,
      errors: errors.length,
      elapsedMs: durationMs,
    })}`,
  );

  return NextResponse.json(response);
});
