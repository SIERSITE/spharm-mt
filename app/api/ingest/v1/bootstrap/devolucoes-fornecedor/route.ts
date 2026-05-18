/**
 * app/api/ingest/v1/bootstrap/devolucoes-fornecedor/route.ts
 *
 * POST /api/ingest/v1/bootstrap/devolucoes-fornecedor
 *
 * Fase 1b.3 do pipeline compras/devoluções. Recebe um batch de linhas
 * de devolução AO fornecedor vindo do agent local e faz upsert
 * idempotente em `StagingDevolucaoFornecedorRawLine`.
 *
 * Pattern: cópia exacta do `bootstrap/compras` (mesmo auth, gate,
 * coercers, hard limits, findUnique+create/update, logging). Differenças:
 *   · staging table diferente
 *   · `valorEurTotal` é TOTAL DA LINHA (NÃO unitário) — reconciliação
 *     compara SUM(valorEurTotal) directo com headerTotalIncidenciaEur
 *   · estados capturados: P / E / R / X (anuladas 'A' excluídas no agent)
 *
 * Garantias de isolamento (production-safe):
 *   · ESCREVE apenas em `StagingDevolucaoFornecedorRawLine`
 *   · NÃO toca em Fornecedor / FornecedorErpRef
 *   · NÃO toca em Produto / ProdutoFarmacia
 *   · NÃO toca em Compra / Devolucao final
 *   · NÃO toca em StagingCompraRawLine
 *   · NÃO toca em vendas, dashboard, export-orders, aggregation
 *
 * Idempotência: `(farmaciaId, externalLineId)` único.
 * Transição P→R é capturada via UPDATE (mesma PK, `quantidadeRecebida`
 * passa de 0 a >0 + `devolucaoSituacaoId` muda).
 *
 * Reconciliação per-batch: para cada `externalDevolucaoId`, soma
 * `valorEurTotal` de todas as linhas e compara com
 * `headerTotalIncidenciaEur`. Tolerância 0.02€. Warning (não rejeita).
 *
 * Auth: withIntegrationAuth (Bearer + X-Tenant-Slug).
 * Feature flag: ENABLE_AGENT_BOOTSTRAP=1.
 *
 * Hard limits: max 500 linhas/batch.
 *
 * Response 200:
 *   {
 *     ok: true,
 *     accepted, upserted: created+updated,
 *     created, updated,
 *     reconciliationWarnings,
 *     byEstado: { P, E, R, X },
 *     skipped: [...], errors: [...], durationMs
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

type DevolucaoFornecedorLinePayload = {
  externalDevolucaoId: unknown;
  externalLineId: unknown;
  sequencia: unknown;
  externalNDevolucao: unknown;
  externalFornecedorId: unknown;
  dataDevolucao: unknown;
  devolucaoSituacaoId: unknown;
  armazemId: unknown;
  observacoes: unknown;
  serieFacturacao: unknown;
  atcud: unknown;
  ncertAt: unknown;
  systemEntryDate: unknown;
  headerTotalDocumento: unknown;
  headerTotalIvaEur: unknown;
  headerTotalIncidenciaEur: unknown;
  externalCodigoId: unknown;
  quantidadeEnviada: unknown;
  quantidadeRecebida: unknown;
  bonus: unknown;
  motivoId: unknown;
  iva: unknown;
  precoVendaPublicoEur: unknown;
  pvfEurUnit: unknown;
  valorEurTotal: unknown;
  validade: unknown;
  lote: unknown;
  recepcaoOrigemText: unknown;
  recepcaoOrigemData: unknown;
  ingestBatchId: unknown;
};

type DevolucoesFornecedorBootstrapResponse = BootstrapBatchResponse & {
  created: number;
  updated: number;
  reconciliationWarnings: number;
  byEstado: { P: number; E: number; R: number; X: number };
};

const HARD_BATCH_LIMIT = 500;
const RECONCILIATION_TOLERANCE_EUR = 0.02;
const VALID_STATES = new Set(["P", "E", "R", "X"]);

/**
 * Trata "NULL"/"null" string literal como null real (data quality
 * issue conhecido — operador digita "NULL" manualmente em campos texto).
 */
function cleanStringOrNull(v: unknown): string | null {
  const s = asStringOrNull(v);
  if (s === null) return null;
  if (s === "NULL" || s === "null") return null;
  return s;
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  const parsed = await parseBatchBody<DevolucaoFornecedorLinePayload>(req);
  if (isFailure(parsed)) return parsed.response;
  const { farmaciaId, items } = parsed;

  if (items.length > HARD_BATCH_LIMIT) {
    return NextResponse.json(
      {
        ok: false,
        error: "payload_too_large",
        message: `Batch tem ${items.length} items; máximo ${HARD_BATCH_LIMIT} para devoluções. Particionar do lado do agent.`,
      },
      { status: 413 }
    );
  }

  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[bootstrap/devolucoes-fornecedor] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
    })}`
  );

  const skipped: DevolucoesFornecedorBootstrapResponse["skipped"] = [];
  const errors: DevolucoesFornecedorBootstrapResponse["errors"] = [];
  let created = 0;
  let updated = 0;
  const byEstado: { P: number; E: number; R: number; X: number } = {
    P: 0,
    E: 0,
    R: 0,
    X: 0,
  };

  const headerSums = new Map<
    number,
    { expected: number; computed: number; linesSeen: number }
  >();
  const batchIdsSeen = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? ({} as DevolucaoFornecedorLinePayload);

    // ── Required fields ─────────────────────────────────────────
    const externalLineId = asIntOrNull(raw.externalLineId);
    if (externalLineId === null) {
      skipped.push({ index: i, reason: "missing_external_line_id" });
      continue;
    }
    const externalDevolucaoId = asIntOrNull(raw.externalDevolucaoId);
    if (externalDevolucaoId === null) {
      skipped.push({ index: i, reason: "missing_external_devolucao_id", externalId: externalLineId });
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
    const externalNDevolucao = asIntOrNull(raw.externalNDevolucao);
    if (externalNDevolucao === null) {
      skipped.push({ index: i, reason: "missing_n_devolucao", externalId: externalLineId });
      continue;
    }
    const dataDevolucao = asIsoDateOrNull(raw.dataDevolucao);
    if (dataDevolucao === null) {
      skipped.push({ index: i, reason: "missing_data_devolucao", externalId: externalLineId });
      continue;
    }
    const devolucaoSituacaoIdRaw = cleanStringOrNull(raw.devolucaoSituacaoId);
    if (devolucaoSituacaoIdRaw === null) {
      skipped.push({ index: i, reason: "missing_devolucao_situacao_id", externalId: externalLineId });
      continue;
    }
    // Safety net: agent filtra 'A' no SQL, mas defesa-em-profundidade
    if (devolucaoSituacaoIdRaw === "A") {
      skipped.push({ index: i, reason: "devolucao_anulada", externalId: externalLineId });
      continue;
    }
    if (!VALID_STATES.has(devolucaoSituacaoIdRaw)) {
      skipped.push({ index: i, reason: "invalid_situacao_id", externalId: externalLineId });
      continue;
    }
    const devolucaoSituacaoId = devolucaoSituacaoIdRaw;

    const armazemId = asIntOrNull(raw.armazemId);
    if (armazemId === null) {
      skipped.push({ index: i, reason: "missing_armazem_id", externalId: externalLineId });
      continue;
    }
    const quantidadeEnviada = asIntOrNull(raw.quantidadeEnviada);
    if (quantidadeEnviada === null) {
      skipped.push({ index: i, reason: "missing_quantidade_enviada", externalId: externalLineId });
      continue;
    }
    const quantidadeRecebida = asIntOrNull(raw.quantidadeRecebida) ?? 0;

    const headerTotalDocumento = asDecimalOrNull(raw.headerTotalDocumento);
    const headerTotalIvaEur = asDecimalOrNull(raw.headerTotalIvaEur);
    const headerTotalIncidenciaEur = asDecimalOrNull(raw.headerTotalIncidenciaEur);
    if (
      headerTotalDocumento === null ||
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

    // ── Optional ────────────────────────────────────────────────
    const sequencia = asIntOrNull(raw.sequencia);
    const observacoes = cleanStringOrNull(raw.observacoes);
    const serieFacturacao = cleanStringOrNull(raw.serieFacturacao);
    const atcud = cleanStringOrNull(raw.atcud);
    const ncertAt = asIntOrNull(raw.ncertAt);
    const systemEntryDate = asIsoDateOrNull(raw.systemEntryDate);
    const bonus = asIntOrNull(raw.bonus);
    const motivoId = asIntOrNull(raw.motivoId);
    const iva = asDecimalOrNull(raw.iva) ?? 0;
    const precoVendaPublicoEur = asDecimalOrNull(raw.precoVendaPublicoEur);
    const pvfEurUnit = asDecimalOrNull(raw.pvfEurUnit);
    // valorEurTotal é TOTAL da linha (Qt Enviada × PVF_EUR). Pode ser
    // null em casos raros (devoluções sintéticas?) — capturar mas não
    // skippar (operador resolve no SaaS).
    const valorEurTotal = asDecimalOrNull(raw.valorEurTotal);
    const validade = asIsoDateOrNull(raw.validade);
    const lote = cleanStringOrNull(raw.lote);
    const recepcaoOrigemText = cleanStringOrNull(raw.recepcaoOrigemText);
    const recepcaoOrigemData = asIsoDateOrNull(raw.recepcaoOrigemData);

    // ── Estado counter ──────────────────────────────────────────
    byEstado[devolucaoSituacaoId as "P" | "E" | "R" | "X"]++;

    // ── Reconciliation ──────────────────────────────────────────
    // Para devoluções, valorEurTotal é JÁ o total da linha. Soma directa.
    // Linhas com valorEurTotal=null contribuem 0 (signal indirect via
    // divergência).
    const lineValue = valorEurTotal ?? 0;
    const prior = headerSums.get(externalDevolucaoId);
    if (prior) {
      prior.computed += lineValue;
      prior.linesSeen++;
    } else {
      headerSums.set(externalDevolucaoId, {
        expected: headerTotalIncidenciaEur,
        computed: lineValue,
        linesSeen: 1,
      });
    }

    // ── UPSERT ──────────────────────────────────────────────────
    try {
      const existing = await ctx.prisma.stagingDevolucaoFornecedorRawLine.findUnique({
        where: {
          farmaciaId_externalLineId: { farmaciaId, externalLineId },
        },
        select: { id: true },
      });

      const dataFields = {
        externalDevolucaoId,
        externalLineId,
        sequencia,
        externalNDevolucao,
        externalFornecedorId,
        dataDevolucao,
        devolucaoSituacaoId,
        armazemId,
        observacoes,
        serieFacturacao,
        atcud,
        ncertAt,
        systemEntryDate,
        headerTotalDocumento,
        headerTotalIvaEur,
        headerTotalIncidenciaEur,
        externalCodigoId,
        quantidadeEnviada,
        quantidadeRecebida,
        bonus,
        motivoId,
        iva,
        precoVendaPublicoEur,
        pvfEurUnit,
        valorEurTotal,
        validade,
        lote,
        recepcaoOrigemText,
        recepcaoOrigemData,
        ingestBatchId,
      };

      if (existing) {
        await ctx.prisma.stagingDevolucaoFornecedorRawLine.update({
          where: { id: existing.id },
          data: dataFields,
        });
        updated++;
      } else {
        await ctx.prisma.stagingDevolucaoFornecedorRawLine.create({
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

  // ── Reconciliação ───────────────────────────────────────────
  let reconciliationWarnings = 0;
  for (const [devId, { expected, computed, linesSeen }] of headerSums) {
    const diff = Math.abs(expected - computed);
    if (diff > RECONCILIATION_TOLERANCE_EUR) {
      reconciliationWarnings++;
      console.warn(
        `[bootstrap/devolucoes-fornecedor] reconciliation_warning ${JSON.stringify({
          tenant: ctx.tenant.slug,
          farmaciaId,
          externalDevolucaoId: devId,
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

  const response: DevolucoesFornecedorBootstrapResponse = {
    ok: true,
    accepted: items.length,
    upserted,
    created,
    updated,
    reconciliationWarnings,
    byEstado,
    skipped,
    errors,
    durationMs,
  };

  console.log(
    `[bootstrap/devolucoes-fornecedor] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      ingestBatchIds: Array.from(batchIdsSeen).slice(0, 5),
      accepted: items.length,
      created,
      updated,
      reconciliationWarnings,
      byEstado,
      headersInBatch: headerSums.size,
      skipped: skipped.length,
      errors: errors.length,
      elapsedMs: durationMs,
    })}`
  );

  return NextResponse.json(response);
});
