/**
 * lib/aggregate/compras.ts
 *
 * Agregação HARDENED `StagingCompraRawLine → Compra` (Fase A do hardening).
 *
 * Substitui o loop `findFirst + create/update` por-linha (que estourava o
 * timeout de 50s a ~24k linhas) por agregação SET-BASED:
 *
 *   · 1 statement `INSERT … SELECT … GROUP BY … ON CONFLICT DO UPDATE` por
 *     CHUNK MENSAL. O Postgres agrega server-side — NADA é materializado em
 *     JS (memória constante). Sem findFirst, sem row-by-row.
 *   · Chunk por mês → commits pequenos, sem transação gigante.
 *   · Cada chunk: advisory-lock xact por (pipeline, farmácia) + retry seguro
 *     (idempotente via ON CONFLICT na unique key Compra_aggregation_key).
 *   · Resolução de produto via CTE canónica determinística (resolve as
 *     colisões externalProductId — ver lib/aggregate/resolve-produto.ts).
 *
 * Idempotente: re-correr a mesma janela converge (UPSERT aos mesmos valores).
 * Retomável: cada mês faz commit isolado; re-run re-faz meses já feitos sem
 * duplicar e continua.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolvedPfCte } from "./resolve-produto";
import { monthChunks, withRetry } from "./chunk-util";
import {
  QUALIDADE,
  TOLERANCIA_ABS_EUR,
  TOLERANCIA_REL,
} from "@/lib/compras/qualidade";

export const EXCLUDED_TIPO_DOCUMENTO_IDS = [4, 17] as const;

type AnyPrisma = Pick<PrismaClient, "$queryRaw" | "$executeRaw" | "$transaction">;

export type AggregateComprasOptions = {
  farmaciaId: string;
  from: Date; // inclusive
  to: Date; // exclusive
  write: boolean;
  batchId: string | null;
};

export type AggregateComprasResult = {
  rawLinesRead: number;
  excludedLineCount: {
    total: number;
    byTipoDocumentoId: Array<{ externalTipoDocumentoId: number; count: number }>;
  };
  candidateGroups: number;
  orphanProducts: { count: number; sampleExternalCodigoIds: number[] };
  orphanFornecedores: { count: number; sampleExternalFornecedorIds: number[] };
  projectedValorTotal: number;
  projectedQuantidade: number;
  topSuppliers: Array<{
    fornecedorId: string;
    fornecedorNome: string;
    valorTotal: number;
    quantidade: number;
    groupCount: number;
  }>;
  docTypeDistribution: Array<{ externalTipoDocumentoId: number | null; count: number }>;
  created: number;
  updated: number;
  chunks: number;
};

/**
 * Reconstroi `CompraDocumento` para a janela e classifica cada documento.
 *
 * Corre ANTES do UPSERT em `Compra`, porque é o veredicto por documento
 * que decide o `custoFiavel` de cada linha agregada.
 *
 * Set-based e idempotente: `ON CONFLICT` pela identidade do documento no
 * ERP, portanto reprocessar a mesma janela reescreve em vez de duplicar.
 *
 * A classificação está aqui em SQL e não em `classificarDocumento()` por
 * uma razão de escala — são dezenas de milhares de documentos e trazê-los
 * ao Node para os devolver seria uma travessia inteira sem necessidade.
 * Os limiares vêm do mesmo módulo, injectados como parâmetros, e o
 * `test-compras-qualidade.ts` verifica que as duas leituras concordam.
 */
async function reconstruirDocumentos(
  tx: AnyPrisma,
  farmaciaId: string,
  mFrom: Date,
  mTo: Date,
  batchId: string,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "CompraDocumento" (
      "id","farmaciaId","externalReceptionId","externalTipoDocumentoId",
      "externalFornecedorId","externalNRecepcao","dataRecepcao",
      "totalDocumentoEur","valorExplicadoEur","deltaEur","nLinhas",
      "qualidade","ingestBatchId","calculadoEm")
    SELECT
      gen_random_uuid()::text,
      d."farmaciaId",
      d."externalReceptionId",
      d."externalTipoDocumentoId",
      d."externalFornecedorId",
      d."externalNRecepcao",
      d."dataRecepcao",
      d."totalDocumento",
      d."valorExplicado",
      ROUND(d."valorExplicado" - d."totalDocumento", 2),
      d."nLinhas",
      CASE
        WHEN d."nLinhas" = 0 THEN ${QUALIDADE.SEM_LINHAS}
        WHEN d."totalDocumento" = 0 THEN ${QUALIDADE.NAO_FINANCEIRO}
        WHEN ABS(d."valorExplicado" - d."totalDocumento")
             <= GREATEST(${TOLERANCIA_ABS_EUR}::numeric,
                         ABS(d."totalDocumento") * ${TOLERANCIA_REL}::numeric)
          THEN ${QUALIDADE.RECONCILIADA}
        ELSE ${QUALIDADE.DETALHE_INCOMPLETO}
      END,
      ${batchId},
      now()
    FROM (
      SELECT
        s."farmaciaId",
        s."externalReceptionId",
        MIN(s."externalTipoDocumentoId") AS "externalTipoDocumentoId",
        MIN(s."externalFornecedorId")    AS "externalFornecedorId",
        MIN(s."externalNRecepcao")       AS "externalNRecepcao",
        MIN(s."dataRecepcao")            AS "dataRecepcao",
        -- O total do header vem repetido em cada linha: MIN e MAX são
        -- iguais e qualquer um serve.
        MIN(s."headerTotalIncidenciaEur")                       AS "totalDocumento",
        ROUND(SUM(s."quantidade" * s."valorEurUnit")::numeric, 2) AS "valorExplicado",
        COUNT(*)::int                                            AS "nLinhas"
      FROM "StagingCompraRawLine" s
      WHERE s."farmaciaId" = ${farmaciaId}
        AND s."dataRecepcao" >= ${mFrom} AND s."dataRecepcao" < ${mTo}
      GROUP BY s."farmaciaId", s."externalReceptionId"
    ) d
    ON CONFLICT ("farmaciaId","externalReceptionId") DO UPDATE SET
      "externalTipoDocumentoId" = EXCLUDED."externalTipoDocumentoId",
      "externalFornecedorId"    = EXCLUDED."externalFornecedorId",
      "externalNRecepcao"       = EXCLUDED."externalNRecepcao",
      "dataRecepcao"            = EXCLUDED."dataRecepcao",
      "totalDocumentoEur"       = EXCLUDED."totalDocumentoEur",
      "valorExplicadoEur"       = EXCLUDED."valorExplicadoEur",
      "deltaEur"                = EXCLUDED."deltaEur",
      "nLinhas"                 = EXCLUDED."nLinhas",
      "qualidade"               = EXCLUDED."qualidade",
      "ingestBatchId"           = EXCLUDED."ingestBatchId",
      "calculadoEm"             = EXCLUDED."calculadoEm"`);
}

const TIPO_FILTER = Prisma.sql`(s."externalTipoDocumentoId" IS NULL OR s."externalTipoDocumentoId" NOT IN (4, 17))`;

/** UPSERT set-based de UM chunk mensal. Devolve created/updated via xmax. */
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
          Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`aggregate-compras:${farmaciaId}`}, 0)) AS ok`,
        );
        if (!lock[0]?.ok) throw new Error("acquire_lock failed (retry)");

        // Primeiro o veredicto por documento: é dele que sai o
        // `custoFiavel` de cada linha agregada logo a seguir.
        await reconstruirDocumentos(tx as unknown as AnyPrisma, farmaciaId, mFrom, mTo, batchId);

        const rows = await tx.$queryRaw<Array<{ created: number; updated: number }>>(Prisma.sql`
          WITH ${resolvedPfCte(farmaciaId)},
          ins AS (
            INSERT INTO "Compra"
              ("id","farmaciaId","produtoId","fornecedorId","data","quantidade","valorTotal","precoUnitario","custoFiavel","ingestBatchId","aggregatedAt","dataIngestao")
            SELECT
              gen_random_uuid()::text,
              s."farmaciaId",
              rpf."produtoId",
              fer."fornecedorId",
              date_trunc('day', s."dataRecepcao"),
              SUM(s."quantidade")::numeric,
              ROUND(SUM(s."quantidade" * s."valorEurUnit")::numeric, 2),
              CASE WHEN SUM(s."quantidade") > 0
                   THEN ROUND(SUM(s."quantidade" * s."valorEurUnit")::numeric / SUM(s."quantidade"), 4)
                   ELSE NULL END,
              -- Só é fiável se TODOS os documentos que contribuíram para
              -- esta linha estiverem reconciliados. Basta um incompleto
              -- no mesmo produto-dia para o preço unitário passar a ser
              -- uma mistura de custo real com custo desconhecido.
              bool_and(cd."qualidade" = ${QUALIDADE.RECONCILIADA}),
              ${batchId}, now(), now()
            FROM "StagingCompraRawLine" s
            JOIN resolved_pf rpf
              ON rpf."farmaciaId" = s."farmaciaId" AND rpf."externalProductId" = s."externalCodigoId"
            JOIN "FornecedorErpRef" fer
              ON fer."farmaciaId" = s."farmaciaId" AND fer."externalFornecedorId" = s."externalFornecedorId"
            -- INNER e não LEFT: uma linha sem documento classificado não
            -- pode ser agregada, porque não se sabe se o seu custo é
            -- real. A reconstrucao corre antes e cobre a janela
            -- toda, portanto na prática não exclui nada.
            JOIN "CompraDocumento" cd
              ON cd."farmaciaId" = s."farmaciaId"
             AND cd."externalReceptionId" = s."externalReceptionId"
            WHERE s."farmaciaId" = ${farmaciaId}
              AND s."dataRecepcao" >= ${mFrom} AND s."dataRecepcao" < ${mTo}
              AND ${TIPO_FILTER}
            GROUP BY s."farmaciaId", rpf."produtoId", fer."fornecedorId", date_trunc('day', s."dataRecepcao")
            ON CONFLICT ("farmaciaId","produtoId","fornecedorId","data") DO UPDATE SET
              "quantidade"    = EXCLUDED."quantidade",
              "valorTotal"    = EXCLUDED."valorTotal",
              "precoUnitario" = EXCLUDED."precoUnitario",
              "custoFiavel"   = EXCLUDED."custoFiavel",
              "ingestBatchId" = EXCLUDED."ingestBatchId",
              "aggregatedAt"  = EXCLUDED."aggregatedAt"
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

export async function aggregateCompras(
  prisma: AnyPrisma,
  opts: AggregateComprasOptions,
): Promise<AggregateComprasResult> {
  const { farmaciaId, from, to, write, batchId } = opts;
  const windowFilter = Prisma.sql`s."farmaciaId" = ${farmaciaId} AND s."dataRecepcao" >= ${from} AND s."dataRecepcao" < ${to}`;

  // ── Reporting set-based (uma passagem cada, sem materializar em JS) ──
  const [rawRow] = await prisma.$queryRaw<Array<{ c: number }>>(
    Prisma.sql`SELECT COUNT(*)::int c FROM "StagingCompraRawLine" s WHERE ${windowFilter}`,
  );
  const rawLinesRead = Number(rawRow?.c ?? 0);

  const docTypeRows = await prisma.$queryRaw<Array<{ tipo: number | null; c: number }>>(
    Prisma.sql`SELECT s."externalTipoDocumentoId" AS tipo, COUNT(*)::int c
      FROM "StagingCompraRawLine" s WHERE ${windowFilter} GROUP BY 1 ORDER BY c DESC`,
  );
  const docTypeDistribution = docTypeRows.map((r) => ({ externalTipoDocumentoId: r.tipo, count: Number(r.c) }));
  const excludedRows = docTypeRows.filter(
    (r) => r.tipo !== null && (EXCLUDED_TIPO_DOCUMENTO_IDS as readonly number[]).includes(r.tipo),
  );

  const [orphProd] = await prisma.$queryRaw<Array<{ c: number; sample: number[] }>>(Prisma.sql`
    SELECT COUNT(DISTINCT s."externalCodigoId")::int c,
      (ARRAY_AGG(DISTINCT s."externalCodigoId"))[1:20] sample
    FROM "StagingCompraRawLine" s
    WHERE ${windowFilter} AND ${TIPO_FILTER}
      AND NOT EXISTS (SELECT 1 FROM "ProdutoFarmacia" pf
        WHERE pf."farmaciaId" = s."farmaciaId" AND pf."externalProductId" = s."externalCodigoId")`);

  const [orphForn] = await prisma.$queryRaw<Array<{ c: number; sample: number[] }>>(Prisma.sql`
    SELECT COUNT(DISTINCT s."externalFornecedorId")::int c,
      (ARRAY_AGG(DISTINCT s."externalFornecedorId"))[1:20] sample
    FROM "StagingCompraRawLine" s
    WHERE ${windowFilter} AND ${TIPO_FILTER}
      AND NOT EXISTS (SELECT 1 FROM "FornecedorErpRef" fer
        WHERE fer."farmaciaId" = s."farmaciaId" AND fer."externalFornecedorId" = s."externalFornecedorId")`);

  const [proj] = await prisma.$queryRaw<Array<{ groups: number; q: number; v: number }>>(Prisma.sql`
    WITH ${resolvedPfCte(farmaciaId)}
    SELECT COUNT(*)::int groups, COALESCE(SUM(q),0)::float q, COALESCE(SUM(v),0)::float v
    FROM (
      SELECT SUM(s."quantidade") q, SUM(s."quantidade" * s."valorEurUnit") v
      FROM "StagingCompraRawLine" s
      JOIN resolved_pf rpf ON rpf."farmaciaId" = s."farmaciaId" AND rpf."externalProductId" = s."externalCodigoId"
      JOIN "FornecedorErpRef" fer ON fer."farmaciaId" = s."farmaciaId" AND fer."externalFornecedorId" = s."externalFornecedorId"
      WHERE ${windowFilter} AND ${TIPO_FILTER}
      GROUP BY s."farmaciaId", rpf."produtoId", fer."fornecedorId", date_trunc('day', s."dataRecepcao")
    ) g`);

  const topSuppliers = (
    await prisma.$queryRaw<Array<{ fornecedorId: string; nome: string; q: number; v: number; gc: number }>>(Prisma.sql`
      WITH ${resolvedPfCte(farmaciaId)}
      SELECT fer."fornecedorId",
        COALESCE(fo.nome, fo."nomeNormalizado") nome,
        SUM(s."quantidade")::float q,
        ROUND(SUM(s."quantidade" * s."valorEurUnit")::numeric, 2)::float v,
        COUNT(DISTINCT rpf."produtoId" || '|' || date_trunc('day', s."dataRecepcao")::text)::int gc
      FROM "StagingCompraRawLine" s
      JOIN resolved_pf rpf ON rpf."farmaciaId" = s."farmaciaId" AND rpf."externalProductId" = s."externalCodigoId"
      JOIN "FornecedorErpRef" fer ON fer."farmaciaId" = s."farmaciaId" AND fer."externalFornecedorId" = s."externalFornecedorId"
      JOIN "Fornecedor" fo ON fo.id = fer."fornecedorId"
      WHERE ${windowFilter} AND ${TIPO_FILTER}
      GROUP BY fer."fornecedorId", COALESCE(fo.nome, fo."nomeNormalizado")
      ORDER BY v DESC LIMIT 10`)
  ).map((r) => ({
    fornecedorId: r.fornecedorId,
    fornecedorNome: r.nome,
    valorTotal: Number(r.v),
    quantidade: Number(r.q),
    groupCount: Number(r.gc),
  }));

  // ── WRITE (chunked, set-based) ──
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
    rawLinesRead,
    excludedLineCount: {
      total: excludedRows.reduce((a, r) => a + Number(r.c), 0),
      byTipoDocumentoId: excludedRows.map((r) => ({ externalTipoDocumentoId: r.tipo as number, count: Number(r.c) })),
    },
    candidateGroups: Number(proj?.groups ?? 0),
    orphanProducts: { count: Number(orphProd?.c ?? 0), sampleExternalCodigoIds: (orphProd?.sample ?? []).map(Number) },
    orphanFornecedores: { count: Number(orphForn?.c ?? 0), sampleExternalFornecedorIds: (orphForn?.sample ?? []).map(Number) },
    projectedValorTotal: Math.round(Number(proj?.v ?? 0) * 100) / 100,
    projectedQuantidade: Number(proj?.q ?? 0),
    topSuppliers,
    docTypeDistribution,
    created,
    updated,
    chunks,
  };
}
