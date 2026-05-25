/**
 * lib/aggregate/devolucoes.ts
 *
 * Agregação HARDENED `StagingDevolucaoFornecedorRawLine → Devolucao`.
 *
 * Mesmo padrão de compras (set-based, chunk mensal, ON CONFLICT, retry,
 * advisory-lock, resolução canónica) mas granularidade POR-LINHA: UPSERT em
 * `(farmaciaId, externalLineId)`. Decisão do operador (2026-05-25):
 *   · quantidade = quantidadeRecebida (só linhas confirmadas recebida>0)
 *   · valor = recebida × PVF unitário (pvfEurUnit; reconstruído de
 *     valorEurTotal/enviada quando pvfEurUnit é null)
 *   · tipo = FORNECEDOR; motivo = null (staging só tem motivoId numérico)
 *
 * Idempotente (P→R re-produz a row sem duplicar). Sem materialização em JS.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolvedPfCte } from "./resolve-produto";
import { monthChunks, withRetry } from "./chunk-util";

type AnyPrisma = Pick<PrismaClient, "$queryRaw" | "$transaction">;

export type AggregateDevolucoesOptions = {
  farmaciaId: string;
  from: Date;
  to: Date;
  write: boolean;
  batchId: string | null;
};

export type AggregateDevolucoesResult = {
  quantityField: "quantidadeRecebida";
  rawLinesRead: number;
  excludedByRecebida: number;
  estadoDistribution: Array<{ estado: string; count: number }>;
  candidateLines: number;
  orphanProducts: { count: number; sampleExternalCodigoIds: number[] };
  orphanFornecedores: { count: number; sampleExternalFornecedorIds: number[] };
  projectedValor: number;
  projectedQuantidadeRecebida: number;
  projectedQuantidadeEnviada: number;
  created: number;
  updated: number;
  chunks: number;
};

/** valor consistente com recebida: recebida × PVF unitário (reconstruído se preciso). */
const VALOR_EXPR = Prisma.sql`
  ROUND((s."quantidadeRecebida" * COALESCE(
    s."pvfEurUnit",
    CASE WHEN s."quantidadeEnviada" > 0 THEN s."valorEurTotal" / s."quantidadeEnviada" ELSE 0 END,
    0
  ))::numeric, 2)`;

async function writeChunk(
  prisma: AnyPrisma,
  farmaciaId: string,
  mFrom: Date,
  mTo: Date,
  batchId: string,
): Promise<{ created: number; updated: number }> {
  return withRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const lock = await tx.$queryRaw<Array<{ ok: boolean }>>(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`aggregate-devolucoes:${farmaciaId}`}, 0)) AS ok`,
        );
        if (!lock[0]?.ok) throw new Error("acquire_lock failed (retry)");

        const rows = await tx.$queryRaw<Array<{ created: number; updated: number }>>(Prisma.sql`
          WITH ${resolvedPfCte(farmaciaId)},
          ins AS (
            INSERT INTO "Devolucao"
              ("id","farmaciaId","produtoId","externalLineId","data","quantidade","valor","tipo","motivo","fornecedorDestinoId","ingestBatchId","aggregatedAt","dataIngestao")
            SELECT
              gen_random_uuid()::text,
              s."farmaciaId",
              rpf."produtoId",
              s."externalLineId",
              date_trunc('day', s."dataDevolucao"),
              s."quantidadeRecebida"::numeric,
              ${VALOR_EXPR},
              'FORNECEDOR'::"TipoDevolucao",
              NULL,
              fer."fornecedorId",
              ${batchId}, now(), now()
            FROM "StagingDevolucaoFornecedorRawLine" s
            JOIN resolved_pf rpf
              ON rpf."farmaciaId" = s."farmaciaId" AND rpf."externalProductId" = s."externalCodigoId"
            JOIN "FornecedorErpRef" fer
              ON fer."farmaciaId" = s."farmaciaId" AND fer."externalFornecedorId" = s."externalFornecedorId"
            WHERE s."farmaciaId" = ${farmaciaId}
              AND s."dataDevolucao" >= ${mFrom} AND s."dataDevolucao" < ${mTo}
              AND s."quantidadeRecebida" > 0
            ON CONFLICT ("farmaciaId","externalLineId") DO UPDATE SET
              "produtoId"           = EXCLUDED."produtoId",
              "data"                = EXCLUDED."data",
              "quantidade"          = EXCLUDED."quantidade",
              "valor"               = EXCLUDED."valor",
              "fornecedorDestinoId" = EXCLUDED."fornecedorDestinoId",
              "ingestBatchId"       = EXCLUDED."ingestBatchId",
              "aggregatedAt"        = EXCLUDED."aggregatedAt"
            RETURNING (xmax = 0) AS inserted
          )
          SELECT
            COUNT(*) FILTER (WHERE inserted)::int AS created,
            COUNT(*) FILTER (WHERE NOT inserted)::int AS updated
          FROM ins
        `);
        return { created: Number(rows[0]?.created ?? 0), updated: Number(rows[0]?.updated ?? 0) };
      },
      { timeout: 60_000, maxWait: 8_000 },
    ),
  );
}

export async function aggregateDevolucoes(
  prisma: AnyPrisma,
  opts: AggregateDevolucoesOptions,
): Promise<AggregateDevolucoesResult> {
  const { farmaciaId, from, to, write, batchId } = opts;
  const windowFilter = Prisma.sql`s."farmaciaId" = ${farmaciaId} AND s."dataDevolucao" >= ${from} AND s."dataDevolucao" < ${to}`;

  const [rawRow] = await prisma.$queryRaw<Array<{ total: number; excl: number }>>(Prisma.sql`
    SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE s."quantidadeRecebida" <= 0)::int excl
    FROM "StagingDevolucaoFornecedorRawLine" s WHERE ${windowFilter}`);

  const estadoRows = await prisma.$queryRaw<Array<{ estado: string; c: number }>>(Prisma.sql`
    SELECT s."devolucaoSituacaoId" AS estado, COUNT(*)::int c
    FROM "StagingDevolucaoFornecedorRawLine" s WHERE ${windowFilter} GROUP BY 1 ORDER BY c DESC`);

  const [orphProd] = await prisma.$queryRaw<Array<{ c: number; sample: number[] }>>(Prisma.sql`
    SELECT COUNT(DISTINCT s."externalCodigoId")::int c, (ARRAY_AGG(DISTINCT s."externalCodigoId"))[1:20] sample
    FROM "StagingDevolucaoFornecedorRawLine" s
    WHERE ${windowFilter} AND s."quantidadeRecebida" > 0
      AND NOT EXISTS (SELECT 1 FROM "ProdutoFarmacia" pf
        WHERE pf."farmaciaId" = s."farmaciaId" AND pf."externalProductId" = s."externalCodigoId")`);

  const [orphForn] = await prisma.$queryRaw<Array<{ c: number; sample: number[] }>>(Prisma.sql`
    SELECT COUNT(DISTINCT s."externalFornecedorId")::int c, (ARRAY_AGG(DISTINCT s."externalFornecedorId"))[1:20] sample
    FROM "StagingDevolucaoFornecedorRawLine" s
    WHERE ${windowFilter} AND s."quantidadeRecebida" > 0
      AND NOT EXISTS (SELECT 1 FROM "FornecedorErpRef" fer
        WHERE fer."farmaciaId" = s."farmaciaId" AND fer."externalFornecedorId" = s."externalFornecedorId")`);

  const [proj] = await prisma.$queryRaw<Array<{ lines: number; rec: number; env: number; val: number }>>(Prisma.sql`
    WITH ${resolvedPfCte(farmaciaId)}
    SELECT COUNT(*)::int lines,
      COALESCE(SUM(s."quantidadeRecebida"),0)::float rec,
      COALESCE(SUM(s."quantidadeEnviada"),0)::float env,
      COALESCE(SUM(${VALOR_EXPR}),0)::float val
    FROM "StagingDevolucaoFornecedorRawLine" s
    JOIN resolved_pf rpf ON rpf."farmaciaId" = s."farmaciaId" AND rpf."externalProductId" = s."externalCodigoId"
    JOIN "FornecedorErpRef" fer ON fer."farmaciaId" = s."farmaciaId" AND fer."externalFornecedorId" = s."externalFornecedorId"
    WHERE ${windowFilter} AND s."quantidadeRecebida" > 0`);

  let created = 0;
  let updated = 0;
  let chunks = 0;
  if (write && batchId) {
    for (const c of monthChunks(from, to)) {
      const r = await writeChunk(prisma, farmaciaId, c.from, c.to, batchId);
      created += r.created;
      updated += r.updated;
      chunks++;
    }
  }

  return {
    quantityField: "quantidadeRecebida",
    rawLinesRead: Number(rawRow?.total ?? 0),
    excludedByRecebida: Number(rawRow?.excl ?? 0),
    estadoDistribution: estadoRows.map((r) => ({ estado: r.estado, count: Number(r.c) })),
    candidateLines: Number(proj?.lines ?? 0),
    orphanProducts: { count: Number(orphProd?.c ?? 0), sampleExternalCodigoIds: (orphProd?.sample ?? []).map(Number) },
    orphanFornecedores: { count: Number(orphForn?.c ?? 0), sampleExternalFornecedorIds: (orphForn?.sample ?? []).map(Number) },
    projectedValor: Math.round(Number(proj?.val ?? 0) * 100) / 100,
    projectedQuantidadeRecebida: Number(proj?.rec ?? 0),
    projectedQuantidadeEnviada: Number(proj?.env ?? 0),
    created,
    updated,
    chunks,
  };
}
