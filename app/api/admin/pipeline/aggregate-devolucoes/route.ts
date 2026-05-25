/**
 * app/api/admin/pipeline/aggregate-devolucoes/route.ts
 *
 * POST /api/admin/pipeline/aggregate-devolucoes
 *
 * Agrega `StagingDevolucaoFornecedorRawLine` no intervalo [from, to) para a
 * tabela final `Devolucao`. Espelha `aggregate-compras` mas com
 * granularidade POR-LINHA (não agrupa): cada linha de staging resolvível →
 * 1 row `Devolucao`, idempotente via UPSERT em `(farmaciaId, externalLineId)`
 * (a tabela foi desenhada para isto — ver schema.prisma).
 *
 * Decisão de quantidade (validada com o operador, 2026-05-25):
 *   · `quantidade` = `quantidadeRecebida` (qt aceite pelo fornecedor).
 *     Conservador: devoluções pendentes (recebida=0) NÃO produzem
 *     movimento até serem confirmadas. Só linhas com `recebida > 0` são
 *     escritas. Transição P→R é capturada na próxima agregação (UPSERT
 *     idempotente, sem duplicar).
 *   · `valor` = `recebida × PVF unitário` (pvfEurUnit; reconstruído de
 *     valorEurTotal/enviada quando pvfEurUnit é null) — consistente com a
 *     quantidade escolhida.
 *   · `tipo` = FORNECEDOR (dbo.Devolucao é sempre ao fornecedor).
 *   · `motivo` = null (staging só tem motivoId numérico; sem lookup de
 *     texto — não inventamos descrição).
 *
 * Resolução (idêntica a compras):
 *   · produto    via ProdutoFarmacia (farmaciaId, externalCodigoId)
 *   · fornecedor via FornecedorErpRef (farmaciaId, externalFornecedorId)
 *   Linhas que não resolvem → orphanProducts / orphanFornecedores (fora do
 *   write, reportadas). Anuladas ('A') já foram excluídas no staging.
 *
 * Modos: `write=false` (default) DRY-RUN; `write=true` UPSERT em Devolucao.
 * Concorrência: `pg_try_advisory_xact_lock` por (pipeline × farmacia).
 * Auth: `withIntegrationAuth`. Feature flag: `ENABLE_AGENT_BOOTSTRAP`.
 *
 * Body: { farmaciaId, from: "YYYY-MM-DD", to: "YYYY-MM-DD", write?: boolean }
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import {
  assertBootstrapEnabled,
  assertFarmaciaInTenant,
} from "@/lib/ingest/bootstrap";
import {
  AggregateLockError,
  tryAcquireAggregationXactLock,
} from "@/lib/pipeline/advisory-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "aggregate-devolucoes";
const TX_TIMEOUT_MS = 50_000;
const TX_MAX_WAIT_MS = 5_000;
const ORPHAN_SAMPLE_SIZE = 20;
const QUANTITY_FIELD = "quantidadeRecebida" as const;

function parseDateOnly(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function genAggregationBatchId(): string {
  return `agg-devol-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** valor consistente com a quantidade escolhida (recebida). */
function lineValor(
  recebida: number,
  enviada: number,
  pvfUnit: number | null,
  valorTotal: number | null,
): number {
  if (pvfUnit !== null && Number.isFinite(pvfUnit)) return round2(recebida * pvfUnit);
  if (valorTotal !== null && Number.isFinite(valorTotal) && enviada > 0) {
    return round2(recebida * (valorTotal / enviada));
  }
  return 0;
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const obj = body as Record<string, unknown>;

  const farmaciaId = typeof obj.farmaciaId === "string" ? obj.farmaciaId : "";
  if (!farmaciaId) {
    return NextResponse.json({ ok: false, error: "missing_farmacia_id" }, { status: 400 });
  }
  const from = parseDateOnly(obj.from);
  const to = parseDateOnly(obj.to);
  if (!from || !to) {
    return NextResponse.json(
      { ok: false, error: "invalid_window", message: "from/to obrigatórios em formato YYYY-MM-DD." },
      { status: 400 }
    );
  }
  if (from.getTime() >= to.getTime()) {
    return NextResponse.json(
      { ok: false, error: "invalid_window", message: "from deve ser estritamente antes de to." },
      { status: 400 }
    );
  }

  const write = obj.write === true;
  const aggregationBatchId = write ? genAggregationBatchId() : null;

  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[pipeline/aggregate-devolucoes] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      from: toIsoDay(from),
      to: toIsoDay(to),
      write,
      aggregationBatchId,
      quantityField: QUANTITY_FIELD,
    })}`
  );

  try {
    const result = await ctx.prisma.$transaction(
      async (tx) => {
        const locked = await tryAcquireAggregationXactLock(tx, PIPELINE_NAME, farmaciaId);
        if (!locked) {
          throw new AggregateLockError(
            "acquire_lock_failed",
            `Outro pipeline ${PIPELINE_NAME} em execução para farmaciaId=${farmaciaId}.`
          );
        }

        const rawLines = await tx.stagingDevolucaoFornecedorRawLine.findMany({
          where: { farmaciaId, dataDevolucao: { gte: from, lt: to } },
          select: {
            externalLineId: true,
            externalCodigoId: true,
            externalFornecedorId: true,
            dataDevolucao: true,
            devolucaoSituacaoId: true,
            quantidadeEnviada: true,
            quantidadeRecebida: true,
            pvfEurUnit: true,
            valorEurTotal: true,
          },
        });

        // Resolve produtos via ProdutoFarmacia (per-farmácia).
        const codigoIds = new Set<number>();
        for (const l of rawLines) codigoIds.add(l.externalCodigoId);
        const produtoMap = new Map<number, string>();
        if (codigoIds.size > 0) {
          const rows = await tx.produtoFarmacia.findMany({
            where: { farmaciaId, externalProductId: { in: [...codigoIds] } },
            select: { externalProductId: true, produtoId: true },
          });
          for (const r of rows) {
            if (r.externalProductId !== null) produtoMap.set(r.externalProductId, r.produtoId);
          }
        }

        // Resolve fornecedores via FornecedorErpRef.
        const fornecedorIds = new Set<number>();
        for (const l of rawLines) fornecedorIds.add(l.externalFornecedorId);
        const fornecedorMap = new Map<number, string>();
        if (fornecedorIds.size > 0) {
          const rows = await tx.fornecedorErpRef.findMany({
            where: { farmaciaId, externalFornecedorId: { in: [...fornecedorIds] } },
            select: { externalFornecedorId: true, fornecedorId: true },
          });
          for (const r of rows) fornecedorMap.set(r.externalFornecedorId, r.fornecedorId);
        }

        type Candidate = {
          externalLineId: number;
          produtoId: string;
          fornecedorId: string;
          data: Date;
          recebida: number;
          enviada: number;
          valor: number;
        };
        const candidates: Candidate[] = [];
        const orphanProducts = new Set<number>();
        const orphanFornecedores = new Set<number>();
        const estadoCounts = new Map<string, number>();
        let excludedByRecebida = 0;
        let projectedQuantidadeRecebida = 0;
        let projectedQuantidadeEnviada = 0;
        let projectedValor = 0;

        for (const l of rawLines) {
          const estado = l.devolucaoSituacaoId ?? "?";
          estadoCounts.set(estado, (estadoCounts.get(estado) ?? 0) + 1);

          const recebida = l.quantidadeRecebida ?? 0;
          // Decisão: só linhas confirmadas (recebida > 0) viram movimento.
          if (recebida <= 0) {
            excludedByRecebida++;
            continue;
          }
          const produtoId = produtoMap.get(l.externalCodigoId);
          if (!produtoId) {
            orphanProducts.add(l.externalCodigoId);
            continue;
          }
          const fornecedorId = fornecedorMap.get(l.externalFornecedorId);
          if (!fornecedorId) {
            orphanFornecedores.add(l.externalFornecedorId);
            continue;
          }

          const enviada = l.quantidadeEnviada ?? 0;
          const pvfUnit = l.pvfEurUnit !== null ? Number(l.pvfEurUnit) : null;
          const valorTotal = l.valorEurTotal !== null ? Number(l.valorEurTotal) : null;
          const valor = lineValor(recebida, enviada, pvfUnit, valorTotal);

          const dataDay = new Date(`${toIsoDay(l.dataDevolucao)}T00:00:00.000Z`);
          candidates.push({
            externalLineId: l.externalLineId,
            produtoId,
            fornecedorId,
            data: dataDay,
            recebida,
            enviada,
            valor,
          });
          projectedQuantidadeRecebida += recebida;
          projectedQuantidadeEnviada += enviada;
          projectedValor += valor;
        }

        const estadoDistribution = [...estadoCounts.entries()]
          .map(([estado, count]) => ({ estado, count }))
          .sort((a, b) => b.count - a.count);

        // WRITE MODE — UPSERT por (farmaciaId, externalLineId).
        let created = 0;
        let updated = 0;
        if (write && aggregationBatchId !== null) {
          const aggregatedAt = new Date();
          for (const c of candidates) {
            const writeFields = {
              produtoId: c.produtoId,
              data: c.data,
              quantidade: new Prisma.Decimal(c.recebida),
              valor: new Prisma.Decimal(c.valor),
              tipo: "FORNECEDOR" as const,
              motivo: null,
              fornecedorDestinoId: c.fornecedorId,
              ingestBatchId: aggregationBatchId,
              aggregatedAt,
            };
            const existing = await tx.devolucao.findFirst({
              where: { farmaciaId, externalLineId: c.externalLineId },
              select: { id: true },
            });
            if (existing) {
              await tx.devolucao.update({ where: { id: existing.id }, data: writeFields });
              updated++;
            } else {
              await tx.devolucao.create({
                data: { farmaciaId, externalLineId: c.externalLineId, ...writeFields },
              });
              created++;
            }
          }
        }

        return {
          rawLinesRead: rawLines.length,
          excludedByRecebida,
          estadoDistribution,
          candidateLines: candidates.length,
          orphanProducts: {
            count: orphanProducts.size,
            sampleExternalCodigoIds: [...orphanProducts].slice(0, ORPHAN_SAMPLE_SIZE),
          },
          orphanFornecedores: {
            count: orphanFornecedores.size,
            sampleExternalFornecedorIds: [...orphanFornecedores].slice(0, ORPHAN_SAMPLE_SIZE),
          },
          projectedValor: round2(projectedValor),
          projectedQuantidadeRecebida,
          projectedQuantidadeEnviada,
          created,
          updated,
        };
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS }
    );

    const durationMs = Date.now() - t0;
    console.log(
      `[pipeline/aggregate-devolucoes] done ${JSON.stringify({
        tenant: ctx.tenant.slug,
        farmaciaId,
        write,
        rawLinesRead: result.rawLinesRead,
        candidateLines: result.candidateLines,
        orphanProductsCount: result.orphanProducts.count,
        orphanFornecedoresCount: result.orphanFornecedores.count,
        created: result.created,
        updated: result.updated,
        durationMs,
      })}`
    );

    return NextResponse.json({
      ok: true,
      dryRun: !write,
      aggregationBatchId,
      window: { from: toIsoDay(from), to: toIsoDay(to) },
      quantityField: QUANTITY_FIELD,
      rawLinesRead: result.rawLinesRead,
      excludedLineCount: {
        total: result.excludedByRecebida,
        byEstado: result.estadoDistribution,
      },
      candidateLines: result.candidateLines,
      orphanProducts: result.orphanProducts,
      orphanFornecedores: result.orphanFornecedores,
      projectedValor: result.projectedValor,
      projectedQuantidade: result.projectedQuantidadeRecebida,
      projectedQuantidadeRecebida: result.projectedQuantidadeRecebida,
      projectedQuantidadeEnviada: result.projectedQuantidadeEnviada,
      estadoDistribution: result.estadoDistribution,
      ...(write
        ? { created: result.created, updated: result.updated, aggregated: result.created + result.updated }
        : {}),
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - t0;
    if (err instanceof AggregateLockError) {
      console.warn(
        `[pipeline/aggregate-devolucoes] abort ${JSON.stringify({ tenant: ctx.tenant.slug, farmaciaId, code: err.code, durationMs })}`
      );
      return NextResponse.json(
        { ok: false, error: "abort", code: err.code, message: err.message, durationMs },
        { status: 409 }
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[pipeline/aggregate-devolucoes] error ${JSON.stringify({ tenant: ctx.tenant.slug, farmaciaId, write, msg, durationMs })}`
    );
    return NextResponse.json({ ok: false, error: "internal", message: msg, durationMs }, { status: 500 });
  }
});
