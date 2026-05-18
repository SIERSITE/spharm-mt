/**
 * app/api/ingest/v1/bootstrap/compras/route.ts
 *
 * POST /api/ingest/v1/bootstrap/compras
 *
 * Fase 1b.2 do pipeline compras/devoluções. Recebe um batch de linhas
 * de compra (recepção de mercadoria) vindo do agent local e faz upsert
 * idempotente em `StagingCompraRawLine`.
 *
 * Garantias de isolamento (production-safe):
 *   · ESCREVE apenas em `StagingCompraRawLine`
 *   · NÃO toca em Fornecedor / FornecedorErpRef
 *   · NÃO toca em Produto / ProdutoFarmacia
 *   · NÃO toca em Compra / Devolucao final
 *   · NÃO toca em vendas, dashboard, export-orders, aggregation
 *
 * Idempotência: `(farmaciaId, externalLineId)` é único. Re-runs do
 * mesmo batch UPDATE em vez de duplicar. Equivalente operacional ao
 * pattern `bootstrap/fornecedores` (findUnique + create/update).
 *
 * Reconciliação per-batch (best-effort): para cada `externalReceptionId`
 * visto no batch, compara `SUM(quantidade × valorEurUnit)` com
 * `headerTotalIncidenciaEur` denormalizado. Divergências > 0.02€
 * contadas como warning. NÃO rejeita o batch — apenas reporta.
 * Limitação: se um header está split entre múltiplos batches a soma
 * fica parcial e dispara falso warning. Agent mitiga enviando 1
 * recepção inteira por batch quando possível.
 *
 * Auth: withIntegrationAuth (Bearer + X-Tenant-Slug).
 * Feature flag: ENABLE_AGENT_BOOTSTRAP=1 (mesmo gate de fornecedores).
 *
 * Hard limits:
 *   · Max 500 linhas/batch (override do BOOTSTRAP_MAX_BATCH_SIZE=1000)
 *   · Empty items → 400 (parseBatchBody)
 *   · Missing farmaciaId → 400 (parseBatchBody)
 *   · Missing required line fields → skipped com reason explícito
 *
 * Body:
 *   {
 *     farmaciaId: string,
 *     items: CompraLinePayload[]    // <= 500
 *   }
 *
 * Response 200:
 *   {
 *     ok: true,
 *     accepted: N,
 *     upserted: created + updated,
 *     created: N,
 *     updated: N,
 *     reconciliationWarnings: N,
 *     skipped: [{ index, reason, externalId? }],
 *     errors:  [{ index, reason, externalId?, message }],
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
  asIsoDateOrNull,
  type BootstrapBatchResponse,
} from "@/lib/ingest/bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type CompraLinePayload = {
  externalReceptionId: unknown;
  externalLineId: unknown;
  sequencia: unknown;
  externalNRecepcao: unknown;
  externalFornecedorId: unknown;
  externalTipoDocumentoId: unknown;
  externalFornecedorNDoc: unknown;
  dataRecepcao: unknown;
  fornecedorData: unknown;
  armazemId: unknown;
  recepcaoSituacaoId: unknown;
  headerTotalBrutoEur: unknown;
  headerTotalIvaEur: unknown;
  headerTotalIncidenciaEur: unknown;
  externalCodigoId: unknown;
  quantidade: unknown;
  bonus: unknown;
  iva: unknown;
  desconto: unknown;
  precoVendaPublicoEur: unknown;
  valorEurUnit: unknown;
  validade: unknown;
  ingestBatchId: unknown;
};

type ComprasBootstrapResponse = BootstrapBatchResponse & {
  created: number;
  updated: number;
  reconciliationWarnings: number;
};

const HARD_BATCH_LIMIT = 500;
const RECONCILIATION_TOLERANCE_EUR = 0.02;

/**
 * Trata a string literal "NULL"/"null" como null real. Operador SPharm
 * pode digitar manualmente "NULL" em campos texto opcionais do ERP
 * (observado em `Fornecedor.nif` durante Fase 1a). Coercers numéricos
 * (asIntOrNull/asDecimalOrNull/asIsoDateOrNull) já tratam — esta
 * função cobre o caso string.
 */
function cleanStringOrNull(v: unknown): string | null {
  const s = asStringOrNull(v);
  if (s === null) return null;
  if (s === "NULL" || s === "null") return null;
  return s;
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  // 1. Feature flag
  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  // 2. Body
  const parsed = await parseBatchBody<CompraLinePayload>(req);
  if (isFailure(parsed)) return parsed.response;
  const { farmaciaId, items } = parsed;

  // 3. Hard limit específico (500 < BOOTSTRAP_MAX_BATCH_SIZE=1000).
  //    Cada Recepção tem ~30 linhas média (rev24); 500 cabe ~15
  //    recepções inteiras por batch, alinhado com tempo Vercel (60s).
  if (items.length > HARD_BATCH_LIMIT) {
    return NextResponse.json(
      {
        ok: false,
        error: "payload_too_large",
        message: `Batch tem ${items.length} items; máximo ${HARD_BATCH_LIMIT} para compras. Particionar do lado do agent.`,
      },
      { status: 413 }
    );
  }

  // 4. Farmácia existe no tenant
  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[bootstrap/compras] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
    })}`
  );

  const skipped: ComprasBootstrapResponse["skipped"] = [];
  const errors: ComprasBootstrapResponse["errors"] = [];
  let created = 0;
  let updated = 0;

  // Reconciliação per-batch. Best-effort — header split entre batches
  // não fica reconciliado corretamente nesta janela. Documentado como
  // limitação aceitável (warning, não rejection).
  const headerSums = new Map<
    number,
    { expected: number; computed: number; linesSeen: number }
  >();

  // IDs de batch vistos no payload (para auditoria + cleanup futuro).
  const batchIdsSeen = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? ({} as CompraLinePayload);

    // ── Required fields (sem default seguro) ─────────────────────
    const externalLineId = asIntOrNull(raw.externalLineId);
    if (externalLineId === null) {
      skipped.push({ index: i, reason: "missing_external_line_id" });
      continue;
    }
    const externalReceptionId = asIntOrNull(raw.externalReceptionId);
    if (externalReceptionId === null) {
      skipped.push({ index: i, reason: "missing_external_reception_id", externalId: externalLineId });
      continue;
    }
    const externalCodigoId = asIntOrNull(raw.externalCodigoId);
    if (externalCodigoId === null) {
      skipped.push({ index: i, reason: "missing_external_codigo_id", externalId: externalLineId });
      continue;
    }
    const externalFornecedorId = asIntOrNull(raw.externalFornecedorId);
    if (externalFornecedorId === null) {
      skipped.push({ index: i, reason: "missing_external_fornecedor_id", externalId: externalLineId });
      continue;
    }
    const externalNRecepcao = asIntOrNull(raw.externalNRecepcao);
    if (externalNRecepcao === null) {
      skipped.push({ index: i, reason: "missing_n_recepcao", externalId: externalLineId });
      continue;
    }
    const dataRecepcao = asIsoDateOrNull(raw.dataRecepcao);
    if (dataRecepcao === null) {
      skipped.push({ index: i, reason: "missing_data_recepcao", externalId: externalLineId });
      continue;
    }
    const armazemId = asIntOrNull(raw.armazemId);
    if (armazemId === null) {
      skipped.push({ index: i, reason: "missing_armazem_id", externalId: externalLineId });
      continue;
    }
    const quantidade = asIntOrNull(raw.quantidade);
    if (quantidade === null) {
      skipped.push({ index: i, reason: "missing_quantidade", externalId: externalLineId });
      continue;
    }
    const valorEurUnit = asDecimalOrNull(raw.valorEurUnit);
    if (valorEurUnit === null) {
      skipped.push({ index: i, reason: "missing_valor_eur_unit", externalId: externalLineId });
      continue;
    }
    const headerTotalBrutoEur = asDecimalOrNull(raw.headerTotalBrutoEur);
    const headerTotalIvaEur = asDecimalOrNull(raw.headerTotalIvaEur);
    const headerTotalIncidenciaEur = asDecimalOrNull(raw.headerTotalIncidenciaEur);
    if (
      headerTotalBrutoEur === null ||
      headerTotalIvaEur === null ||
      headerTotalIncidenciaEur === null
    ) {
      skipped.push({ index: i, reason: "missing_header_totals", externalId: externalLineId });
      continue;
    }
    const ingestBatchId = cleanStringOrNull(raw.ingestBatchId);
    if (ingestBatchId === null) {
      skipped.push({ index: i, reason: "missing_ingest_batch_id", externalId: externalLineId });
      continue;
    }
    batchIdsSeen.add(ingestBatchId);

    // ── Optional / defaultable ──────────────────────────────────
    const sequencia = asIntOrNull(raw.sequencia);
    const externalTipoDocumentoId = asIntOrNull(raw.externalTipoDocumentoId);
    const externalFornecedorNDoc = cleanStringOrNull(raw.externalFornecedorNDoc);
    const fornecedorData = asIsoDateOrNull(raw.fornecedorData);
    // recepcaoSituacaoId default 'N' — agent filtra no SQL, mas safety net.
    const recepcaoSituacaoId = cleanStringOrNull(raw.recepcaoSituacaoId) ?? "N";
    const bonus = asIntOrNull(raw.bonus) ?? 0;
    const iva = asDecimalOrNull(raw.iva) ?? 0;
    const desconto = asDecimalOrNull(raw.desconto);
    const precoVendaPublicoEur = asDecimalOrNull(raw.precoVendaPublicoEur) ?? 0;
    const validade = asIsoDateOrNull(raw.validade);

    // ── Reconciliation accumulator ──────────────────────────────
    // expected = primeiro headerTotalIncidenciaEur visto para este recId.
    // Se diferentes linhas trouxerem totais discrepantes (data quality
    // issue do agent), assume-se o primeiro como referência.
    const lineValue = quantidade * valorEurUnit;
    const prior = headerSums.get(externalReceptionId);
    if (prior) {
      prior.computed += lineValue;
      prior.linesSeen++;
    } else {
      headerSums.set(externalReceptionId, {
        expected: headerTotalIncidenciaEur,
        computed: lineValue,
        linesSeen: 1,
      });
    }

    // ── UPSERT (findUnique + create/update — matches fornecedores) ──
    try {
      const existing = await ctx.prisma.stagingCompraRawLine.findUnique({
        where: {
          farmaciaId_externalLineId: { farmaciaId, externalLineId },
        },
        select: { id: true },
      });

      const dataFields = {
        externalReceptionId,
        externalLineId,
        sequencia,
        externalNRecepcao,
        externalFornecedorId,
        externalTipoDocumentoId,
        externalFornecedorNDoc,
        dataRecepcao,
        fornecedorData,
        armazemId,
        recepcaoSituacaoId,
        headerTotalBrutoEur,
        headerTotalIvaEur,
        headerTotalIncidenciaEur,
        externalCodigoId,
        quantidade,
        bonus,
        iva,
        desconto,
        precoVendaPublicoEur,
        valorEurUnit,
        validade,
        ingestBatchId,
      };

      if (existing) {
        await ctx.prisma.stagingCompraRawLine.update({
          where: { id: existing.id },
          data: dataFields,
        });
        updated++;
      } else {
        await ctx.prisma.stagingCompraRawLine.create({
          data: {
            farmaciaId,
            ...dataFields,
          },
        });
        created++;
      }
    } catch (err) {
      errors.push({
        index: i,
        reason: "upsert_failed",
        externalId: externalLineId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Reconciliação: warning por header com divergência > 0.02€ ──
  let reconciliationWarnings = 0;
  for (const [recId, { expected, computed, linesSeen }] of headerSums) {
    const diff = Math.abs(expected - computed);
    if (diff > RECONCILIATION_TOLERANCE_EUR) {
      reconciliationWarnings++;
      console.warn(
        `[bootstrap/compras] reconciliation_warning ${JSON.stringify({
          tenant: ctx.tenant.slug,
          farmaciaId,
          externalReceptionId: recId,
          expectedIncidenciaEur: Math.round(expected * 100) / 100,
          computedFromLines: Math.round(computed * 100) / 100,
          diffEur: Math.round(diff * 100) / 100,
          linesSeen,
        })}`
      );
    }
  }

  const durationMs = Date.now() - t0;
  const upserted = created + updated;

  const response: ComprasBootstrapResponse = {
    ok: true,
    accepted: items.length,
    upserted,
    created,
    updated,
    reconciliationWarnings,
    skipped,
    errors,
    durationMs,
  };

  console.log(
    `[bootstrap/compras] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      ingestBatchIds: Array.from(batchIdsSeen).slice(0, 5),
      accepted: items.length,
      created,
      updated,
      reconciliationWarnings,
      headersInBatch: headerSums.size,
      skipped: skipped.length,
      errors: errors.length,
      elapsedMs: durationMs,
    })}`
  );

  return NextResponse.json(response);
});
