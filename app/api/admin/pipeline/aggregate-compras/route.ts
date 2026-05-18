/**
 * app/api/admin/pipeline/aggregate-compras/route.ts
 *
 * POST /api/admin/pipeline/aggregate-compras
 *
 * Lê `StagingCompraRawLine` no intervalo [from, to), resolve produtos via
 * `ProdutoFarmacia.externalProductId` e fornecedores via
 * `FornecedorErpRef.externalFornecedorId`, agrega por
 * `(produtoId, dataRecepcao, fornecedorId)` e (Phase 1c.4) opcionalmente
 * faz UPSERT em `Compra` quando `write=true`.
 *
 * Modos:
 *   · `write=false` (default)  — DRY-RUN. Não escreve. Devolve preview.
 *   · `write=true`             — UPSERT em `Compra` usando o unique
 *                                 `Compra_aggregation_key (farmaciaId,
 *                                 produtoId, fornecedorId, data)`.
 *                                 Idempotente: re-run da mesma janela
 *                                 actualiza `quantidade`/`valorTotal`/
 *                                 `precoUnitario`/`ingestBatchId`/
 *                                 `aggregatedAt` em vez de duplicar.
 *
 * Exclusões hard-coded (decisão Phase 1c):
 *   · `externalTipoDocumentoId IN (4, 17)`  → NC, V/Crédito-VD
 *   · Linhas sem produto resolvido          → orphanProducts (reportadas)
 *   · Linhas sem fornecedor resolvido       → orphanFornecedores (reportadas)
 *
 * Concorrência:
 *   · `pg_try_advisory_xact_lock` por `(pipelineName, farmaciaId)`.
 *     Caller paralelo recebe 409 `acquire_lock_failed`.
 *
 * Auth: `withIntegrationAuth` (Bearer + X-Tenant-Slug).
 * Feature flag: `ENABLE_AGENT_BOOTSTRAP` (mesmo gate operacional dos
 *               outros endpoints integracao).
 *
 * Body:
 *   {
 *     farmaciaId: string,
 *     from: "YYYY-MM-DD",     // inclusive
 *     to:   "YYYY-MM-DD",     // exclusive
 *     write?: boolean         // default false
 *   }
 *
 * Response 200 (dry-run, write=false):
 *   {
 *     ok: true,
 *     dryRun: true,
 *     window: { from, to },
 *     excludedTipoDocumentoIds: number[],
 *     rawLinesRead: number,
 *     excludedLineCount: { total, byTipoDocumentoId: [{ externalTipoDocumentoId, count }] },
 *     candidateGroups: number,
 *     orphanProducts:    { count, sampleExternalCodigoIds: number[] },
 *     orphanFornecedores:{ count, sampleExternalFornecedorIds: number[] },
 *     projectedValorTotal: number,
 *     projectedQuantidade: number,
 *     topSuppliers: [{ fornecedorId, fornecedorNome, valorTotal, quantidade, groupCount }],
 *     docTypeDistribution: [{ externalTipoDocumentoId, count }],
 *     durationMs: number
 *   }
 *
 * Response 200 (write mode, write=true) — extra-fields:
 *   {
 *     ...all dry-run fields...,
 *     dryRun: false,
 *     aggregationBatchId: "agg-compra-<ts36>-<8hex>",
 *     created: number,
 *     updated: number,
 *     aggregated: number   // = created + updated
 *   }
 *
 * Response 400 (validation):
 *   { ok:false, error: "invalid_json" | "invalid_body" | "missing_farmacia_id" |
 *                       "invalid_window", message }
 *
 * Response 404 (assertFarmaciaInTenant):
 *   { ok:false, error: "farmacia_not_found", message }
 *
 * Response 409 (advisory lock):
 *   { ok:false, error: "abort", code: "acquire_lock_failed", message, durationMs }
 *
 * Response 503 (feature flag off):
 *   { ok:false, error: "feature_disabled", message }
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

const EXCLUDED_TIPO_DOCUMENTO_IDS: ReadonlyArray<number> = [4, 17];
const EXCLUDED_TIPO_DOCUMENTO_SET = new Set<number>(EXCLUDED_TIPO_DOCUMENTO_IDS);
const PIPELINE_NAME = "aggregate-compras";
const TX_TIMEOUT_MS = 50_000;
const TX_MAX_WAIT_MS = 5_000;
const ORPHAN_SAMPLE_SIZE = 20;
const TOP_SUPPLIERS_LIMIT = 10;

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

/**
 * Gera o batchId server-side da run de aggregation. Server-emitted (não
 * agent-emitted) para garantir unicidade entre operadores e correlação
 * 1:1 com a row PipelineRun futura. Formato:
 *   agg-compra-<base36 timestamp>-<8 hex>
 * Ex: agg-compra-mpbe5xj0-9c2f1e30
 */
function genAggregationBatchId(): string {
  return `agg-compra-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  // 1. Feature flag
  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  // 2. Body
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_json",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 400 }
    );
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const obj = body as Record<string, unknown>;

  const farmaciaId = typeof obj.farmaciaId === "string" ? obj.farmaciaId : "";
  if (!farmaciaId) {
    return NextResponse.json(
      { ok: false, error: "missing_farmacia_id" },
      { status: 400 }
    );
  }
  const from = parseDateOnly(obj.from);
  const to = parseDateOnly(obj.to);
  if (!from || !to) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_window",
        message: "from/to obrigatórios em formato YYYY-MM-DD.",
      },
      { status: 400 }
    );
  }
  if (from.getTime() >= to.getTime()) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_window",
        message: "from deve ser estritamente antes de to.",
      },
      { status: 400 }
    );
  }

  const write = obj.write === true;
  const aggregationBatchId = write ? genAggregationBatchId() : null;

  // 3. Farmácia existe no tenant
  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[pipeline/aggregate-compras] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      from: toIsoDay(from),
      to: toIsoDay(to),
      write,
      aggregationBatchId,
      excludedTipoDocumentoIds: EXCLUDED_TIPO_DOCUMENTO_IDS,
    })}`
  );

  try {
    const result = await ctx.prisma.$transaction(
      async (tx) => {
        // ── 1. Advisory lock por (pipeline × farmacia) ──────────────
        const locked = await tryAcquireAggregationXactLock(
          tx,
          PIPELINE_NAME,
          farmaciaId
        );
        if (!locked) {
          throw new AggregateLockError(
            "acquire_lock_failed",
            `Outro pipeline ${PIPELINE_NAME} em execução para farmaciaId=${farmaciaId}.`
          );
        }

        // ── 2. Raw staging window ──────────────────────────────────
        const rawLines = await tx.stagingCompraRawLine.findMany({
          where: {
            farmaciaId,
            dataRecepcao: { gte: from, lt: to },
          },
          select: {
            externalLineId: true,
            externalReceptionId: true,
            externalCodigoId: true,
            externalFornecedorId: true,
            externalTipoDocumentoId: true,
            dataRecepcao: true,
            quantidade: true,
            valorEurUnit: true,
          },
        });

        // ── 3. Resolve produtos via ProdutoFarmacia ────────────────
        const codigoIds = new Set<number>();
        for (const l of rawLines) codigoIds.add(l.externalCodigoId);
        const produtoMap = new Map<number, string>();
        if (codigoIds.size > 0) {
          const rows = await tx.produtoFarmacia.findMany({
            where: { farmaciaId, externalProductId: { in: [...codigoIds] } },
            select: { externalProductId: true, produtoId: true },
          });
          for (const r of rows) {
            if (r.externalProductId !== null) {
              produtoMap.set(r.externalProductId, r.produtoId);
            }
          }
        }

        // ── 4. Resolve fornecedores via FornecedorErpRef ───────────
        const fornecedorIds = new Set<number>();
        for (const l of rawLines) fornecedorIds.add(l.externalFornecedorId);
        const fornecedorMap = new Map<number, { id: string; nome: string }>();
        if (fornecedorIds.size > 0) {
          const rows = await tx.fornecedorErpRef.findMany({
            where: {
              farmaciaId,
              externalFornecedorId: { in: [...fornecedorIds] },
            },
            select: {
              externalFornecedorId: true,
              fornecedor: {
                select: { id: true, nomeNormalizado: true, nome: true },
              },
            },
          });
          for (const r of rows) {
            fornecedorMap.set(r.externalFornecedorId, {
              id: r.fornecedor.id,
              nome: r.fornecedor.nome ?? r.fornecedor.nomeNormalizado,
            });
          }
        }

        // ── 5. Process lines ───────────────────────────────────────
        const excludedByTipo = new Map<number, number>();
        let excludedTotal = 0;
        const orphanProducts = new Set<number>();
        const orphanFornecedores = new Set<number>();
        const docTypeCounts = new Map<number | null, number>();

        type Group = {
          produtoId: string;
          fornecedorId: string;
          fornecedorNome: string;
          dataKey: string;
          dataDate: Date;
          quantidade: number;
          valorTotal: number;
          lineCount: number;
        };
        const groups = new Map<string, Group>();
        const supplierTotals = new Map<
          string,
          {
            fornecedorId: string;
            fornecedorNome: string;
            valorTotal: number;
            quantidade: number;
            groups: Set<string>;
          }
        >();

        for (const l of rawLines) {
          // doc type distribution conta TODAS as linhas (antes de exclusões)
          const tipoKey = l.externalTipoDocumentoId;
          docTypeCounts.set(tipoKey, (docTypeCounts.get(tipoKey) ?? 0) + 1);

          // exclusão por tipoDoc — line never reaches group-building
          if (
            l.externalTipoDocumentoId !== null &&
            EXCLUDED_TIPO_DOCUMENTO_SET.has(l.externalTipoDocumentoId)
          ) {
            excludedTotal++;
            excludedByTipo.set(
              l.externalTipoDocumentoId,
              (excludedByTipo.get(l.externalTipoDocumentoId) ?? 0) + 1
            );
            continue;
          }

          const produtoId = produtoMap.get(l.externalCodigoId);
          if (!produtoId) {
            orphanProducts.add(l.externalCodigoId);
            continue;
          }
          const forn = fornecedorMap.get(l.externalFornecedorId);
          if (!forn) {
            orphanFornecedores.add(l.externalFornecedorId);
            continue;
          }

          const dataKey = toIsoDay(l.dataRecepcao);
          const groupKey = `${produtoId}|${forn.id}|${dataKey}`;
          const valorLinha = l.quantidade * Number(l.valorEurUnit);

          const existing = groups.get(groupKey);
          if (existing) {
            existing.quantidade += l.quantidade;
            existing.valorTotal += valorLinha;
            existing.lineCount++;
          } else {
            // dataDate canónica = start of day UTC do dataRecepcao.
            // Normalizado para garantir que múltiplas linhas do mesmo dia
            // mas com timestamps diferentes (ex: 09h vs 17h) caem no mesmo
            // grupo e produzem a mesma `Compra.data`.
            const dataDate = new Date(`${dataKey}T00:00:00.000Z`);
            groups.set(groupKey, {
              produtoId,
              fornecedorId: forn.id,
              fornecedorNome: forn.nome,
              dataKey,
              dataDate,
              quantidade: l.quantidade,
              valorTotal: valorLinha,
              lineCount: 1,
            });
          }

          const sup = supplierTotals.get(forn.id);
          if (sup) {
            sup.valorTotal += valorLinha;
            sup.quantidade += l.quantidade;
            sup.groups.add(groupKey);
          } else {
            supplierTotals.set(forn.id, {
              fornecedorId: forn.id,
              fornecedorNome: forn.nome,
              valorTotal: valorLinha,
              quantidade: l.quantidade,
              groups: new Set([groupKey]),
            });
          }
        }

        // ── 6. Totals + samples ────────────────────────────────────
        let projectedValorTotal = 0;
        let projectedQuantidade = 0;
        for (const g of groups.values()) {
          projectedValorTotal += g.valorTotal;
          projectedQuantidade += g.quantidade;
        }

        const topSuppliers = [...supplierTotals.values()]
          .sort((a, b) => b.valorTotal - a.valorTotal)
          .slice(0, TOP_SUPPLIERS_LIMIT)
          .map((s) => ({
            fornecedorId: s.fornecedorId,
            fornecedorNome: s.fornecedorNome,
            valorTotal: round2(s.valorTotal),
            quantidade: s.quantidade,
            groupCount: s.groups.size,
          }));

        const docTypeDistribution = [...docTypeCounts.entries()]
          .map(([id, count]) => ({ externalTipoDocumentoId: id, count }))
          .sort((a, b) => b.count - a.count);

        const excludedByTipoArr = [...excludedByTipo.entries()]
          .map(([id, count]) => ({ externalTipoDocumentoId: id, count }))
          .sort((a, b) => b.count - a.count);

        // ── 7. WRITE MODE — UPSERT em Compra ────────────────────────
        let created = 0;
        let updated = 0;
        if (write && aggregationBatchId !== null) {
          const aggregatedAt = new Date();

          for (const g of groups.values()) {
            // Aritmética é em Number → arredondar para a precisão real
            // da column Compra.valorTotal (Decimal 14,2). Decisão
            // documentada como risco residual (precision em janelas
            // grandes); migração para Decimal.js deferida.
            const valorTotal2 = round2(g.valorTotal);
            const precoUnitario =
              g.quantidade > 0 ? Math.round((g.valorTotal / g.quantidade) * 10000) / 10000 : null;

            // findFirst + create/update — espelha o padrão do
            // bootstrap/compras endpoint. Compound unique com nullable
            // `fornecedorId` (Compra_aggregation_key) é tratado aqui só
            // por valores não-null (orphanFornecedores fica fora do write
            // por construção — branch acima).
            const existing = await tx.compra.findFirst({
              where: {
                farmaciaId,
                produtoId: g.produtoId,
                fornecedorId: g.fornecedorId,
                data: g.dataDate,
              },
              select: { id: true },
            });

            const writeFields = {
              quantidade: new Prisma.Decimal(g.quantidade),
              valorTotal: new Prisma.Decimal(valorTotal2),
              precoUnitario:
                precoUnitario !== null ? new Prisma.Decimal(precoUnitario) : null,
              ingestBatchId: aggregationBatchId,
              aggregatedAt,
            };

            if (existing) {
              await tx.compra.update({
                where: { id: existing.id },
                data: writeFields,
              });
              updated++;
            } else {
              await tx.compra.create({
                data: {
                  farmaciaId,
                  produtoId: g.produtoId,
                  fornecedorId: g.fornecedorId,
                  data: g.dataDate,
                  ...writeFields,
                },
              });
              created++;
            }
          }
        }

        return {
          rawLinesRead: rawLines.length,
          excludedLineCount: {
            total: excludedTotal,
            byTipoDocumentoId: excludedByTipoArr,
          },
          candidateGroups: groups.size,
          orphanProducts: {
            count: orphanProducts.size,
            sampleExternalCodigoIds: [...orphanProducts].slice(0, ORPHAN_SAMPLE_SIZE),
          },
          orphanFornecedores: {
            count: orphanFornecedores.size,
            sampleExternalFornecedorIds: [...orphanFornecedores].slice(0, ORPHAN_SAMPLE_SIZE),
          },
          projectedValorTotal: round2(projectedValorTotal),
          projectedQuantidade,
          topSuppliers,
          docTypeDistribution,
          created,
          updated,
        };
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS }
    );

    const durationMs = Date.now() - t0;

    console.log(
      `[pipeline/aggregate-compras] done ${JSON.stringify({
        tenant: ctx.tenant.slug,
        farmaciaId,
        from: toIsoDay(from),
        to: toIsoDay(to),
        write,
        aggregationBatchId,
        rawLinesRead: result.rawLinesRead,
        candidateGroups: result.candidateGroups,
        excludedTotal: result.excludedLineCount.total,
        orphanProductsCount: result.orphanProducts.count,
        orphanFornecedoresCount: result.orphanFornecedores.count,
        projectedValorTotal: result.projectedValorTotal,
        projectedQuantidade: result.projectedQuantidade,
        created: result.created,
        updated: result.updated,
        durationMs,
      })}`
    );

    if (write) {
      return NextResponse.json({
        ok: true,
        dryRun: false,
        aggregationBatchId,
        window: { from: toIsoDay(from), to: toIsoDay(to) },
        excludedTipoDocumentoIds: [...EXCLUDED_TIPO_DOCUMENTO_IDS],
        rawLinesRead: result.rawLinesRead,
        excludedLineCount: result.excludedLineCount,
        candidateGroups: result.candidateGroups,
        orphanProducts: result.orphanProducts,
        orphanFornecedores: result.orphanFornecedores,
        projectedValorTotal: result.projectedValorTotal,
        projectedQuantidade: result.projectedQuantidade,
        topSuppliers: result.topSuppliers,
        docTypeDistribution: result.docTypeDistribution,
        created: result.created,
        updated: result.updated,
        aggregated: result.created + result.updated,
        durationMs,
      });
    }

    return NextResponse.json({
      ok: true,
      dryRun: true,
      window: { from: toIsoDay(from), to: toIsoDay(to) },
      excludedTipoDocumentoIds: [...EXCLUDED_TIPO_DOCUMENTO_IDS],
      rawLinesRead: result.rawLinesRead,
      excludedLineCount: result.excludedLineCount,
      candidateGroups: result.candidateGroups,
      orphanProducts: result.orphanProducts,
      orphanFornecedores: result.orphanFornecedores,
      projectedValorTotal: result.projectedValorTotal,
      projectedQuantidade: result.projectedQuantidade,
      topSuppliers: result.topSuppliers,
      docTypeDistribution: result.docTypeDistribution,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - t0;

    if (err instanceof AggregateLockError) {
      console.warn(
        `[pipeline/aggregate-compras] abort ${JSON.stringify({
          tenant: ctx.tenant.slug,
          farmaciaId,
          code: err.code,
          message: err.message,
          durationMs,
        })}`
      );
      return NextResponse.json(
        {
          ok: false,
          error: "abort",
          code: err.code,
          message: err.message,
          durationMs,
        },
        { status: 409 }
      );
    }

    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[pipeline/aggregate-compras] error ${JSON.stringify({
        tenant: ctx.tenant.slug,
        farmaciaId,
        write,
        aggregationBatchId,
        msg,
        durationMs,
      })}`
    );
    return NextResponse.json(
      { ok: false, error: "internal", message: msg, durationMs },
      { status: 500 }
    );
  }
});
