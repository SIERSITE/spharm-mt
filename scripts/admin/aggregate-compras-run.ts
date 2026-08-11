/**
 * scripts/admin/aggregate-compras-run.ts
 *
 * Runner local da Fase 1c que replica EXACTAMENTE a lógica do route
 * handler `app/api/admin/pipeline/aggregate-compras/route.ts` — mesma
 * janela, mesmas exclusões, mesmo advisory lock, mesma resolução de
 * lookups, mesma agregação, mesmo UPSERT em `Compra` quando --write.
 *
 * Único bypass face ao endpoint: a camada HTTP (`withIntegrationAuth`,
 * parse de body). Necessário porque o Bearer key live só existe na
 * máquina do agent (farmácia). Esta validação corre contra a MESMA BD
 * tenant que o endpoint deployado usa, via tenant client construído a
 * partir do control plane.
 *
 * Uso:
 *   # dry-run
 *   npx tsx scripts/admin/aggregate-compras-run.ts \
 *     --slug=demo-neon --farmacia-id=<id> --from=YYYY-MM-DD --to=YYYY-MM-DD
 *
 *   # write real
 *   npx tsx scripts/admin/aggregate-compras-run.ts \
 *     --slug=demo-neon --farmacia-id=<id> --from=YYYY-MM-DD --to=YYYY-MM-DD --write
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

class AggregateLockError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
async function tryAcquireAggregationXactLock(
  exec: { $queryRaw: <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T> },
  pipelineName: string,
  farmaciaId: string
): Promise<boolean> {
  const rows = await exec.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtext(${pipelineName}), hashtext(${farmaciaId})) AS acquired
  `;
  return rows[0]?.acquired === true;
}

const EXCLUDED_TIPO_DOCUMENTO_IDS: ReadonlyArray<number> = [4, 17];
const EXCLUDED_TIPO_DOCUMENTO_SET = new Set<number>(EXCLUDED_TIPO_DOCUMENTO_IDS);
const PIPELINE_NAME = "aggregate-compras";
const TX_TIMEOUT_MS = 50_000;
const TX_MAX_WAIT_MS = 5_000;
const ORPHAN_SAMPLE_SIZE = 20;
const TOP_SUPPLIERS_LIMIT = 10;

function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function genAggregationBatchId(): string {
  return `agg-compra-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      "farmacia-id": { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  const slug = values.slug;
  const farmaciaId = values["farmacia-id"];
  const fromStr = values.from;
  const toStr = values.to;
  const write = values.write === true;
  if (!slug || !farmaciaId || !fromStr || !toStr) {
    console.error(
      "Usage: --slug=demo-neon --farmacia-id=<id> --from=YYYY-MM-DD --to=YYYY-MM-DD [--write]"
    );
    process.exit(1);
  }
  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    console.error("invalid window");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`tenant ${slug} not found`);
  const tp = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });
  const farmacia = await tp.farmacia.findUnique({ where: { id: farmaciaId }, select: { id: true, nome: true } });
  if (!farmacia) throw new Error(`farmaciaId ${farmaciaId} not in tenant ${slug}`);

  const aggregationBatchId = write ? genAggregationBatchId() : null;
  console.error(
    `[aggregate-compras-run] start tenant=${slug} farmaciaId=${farmaciaId} (${farmacia.nome}) ` +
      `window=[${toIsoDay(from)}→${toIsoDay(to)}] write=${write} batchId=${aggregationBatchId}`
  );

  const t0 = Date.now();
  const result = await tp.$transaction(
    async (tx) => {
      const locked = await tryAcquireAggregationXactLock(tx, PIPELINE_NAME, farmaciaId);
      if (!locked) {
        throw new AggregateLockError(
          "acquire_lock_failed",
          `Outro pipeline ${PIPELINE_NAME} em execução para farmaciaId=${farmaciaId}.`
        );
      }

      const rawLines = await tx.stagingCompraRawLine.findMany({
        where: { farmaciaId, dataRecepcao: { gte: from, lt: to } },
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

      const fornecedorIds = new Set<number>();
      for (const l of rawLines) fornecedorIds.add(l.externalFornecedorId);
      const fornecedorMap = new Map<number, { id: string; nome: string }>();
      if (fornecedorIds.size > 0) {
        const rows = await tx.fornecedorErpRef.findMany({
          where: { farmaciaId, externalFornecedorId: { in: [...fornecedorIds] } },
          select: {
            externalFornecedorId: true,
            fornecedor: { select: { id: true, nomeNormalizado: true, nome: true } },
          },
        });
        for (const r of rows) {
          fornecedorMap.set(r.externalFornecedorId, {
            id: r.fornecedor.id,
            nome: r.fornecedor.nome ?? r.fornecedor.nomeNormalizado,
          });
        }
      }

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
        { fornecedorId: string; fornecedorNome: string; valorTotal: number; quantidade: number; groups: Set<string> }
      >();

      for (const l of rawLines) {
        const tipoKey = l.externalTipoDocumentoId;
        docTypeCounts.set(tipoKey, (docTypeCounts.get(tipoKey) ?? 0) + 1);
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

      let created = 0;
      let updated = 0;
      if (write && aggregationBatchId !== null) {
        const aggregatedAt = new Date();
        for (const g of groups.values()) {
          const valorTotal2 = round2(g.valorTotal);
          const precoUnitario =
            g.quantidade > 0
              ? Math.round((g.valorTotal / g.quantidade) * 10000) / 10000
              : null;
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
            await tx.compra.update({ where: { id: existing.id }, data: writeFields });
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
        excludedLineCount: { total: excludedTotal, byTipoDocumentoId: excludedByTipoArr },
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

  const baseResponse = {
    ok: true,
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
  };

  const response = write
    ? {
        ...baseResponse,
        dryRun: false,
        aggregationBatchId,
        created: result.created,
        updated: result.updated,
        aggregated: result.created + result.updated,
      }
    : { ...baseResponse, dryRun: true };

  console.log(JSON.stringify(response, null, 2));

  await tp.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
