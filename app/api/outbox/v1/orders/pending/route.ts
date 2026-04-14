import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { withIntegrationAuth } from "@/lib/integracao/auth";

/**
 * GET /api/outbox/v1/orders/pending?limit=50
 *
 * Claim de lease: rows em PENDENTE com nextAttemptAt <= now são
 * atomicamente marcadas como EM_EXPORTACAO e devolvidas já "leased"
 * ao agent. O UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
 * garante que duas execuções concorrentes do mesmo agent (ou dois
 * agents diferentes a apontarem ao mesmo tenant) NÃO recebem a
 * mesma row.
 *
 * A lease dura 5 minutos — se o agent crashar antes de /ack ou
 * /release, o próximo tick reclama a row.
 */

const LEASE_TTL_MS = 5 * 60 * 1000;

export const GET = withIntegrationAuth(async (ctx, req) => {
  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(1, Number(url.searchParams.get("limit") ?? "50")),
    200
  );
  const agentId =
    req.headers.get("x-agent-instance") ?? ctx.tenant.slug + "-agent";

  const now = new Date();
  const leasedUntil = new Date(now.getTime() + LEASE_TTL_MS);

  // Claim atómico. Postgres-only — skip locked + returning.
  const claimed = await ctx.prisma.$queryRaw<
    Array<{
      id: string;
      listaEncomendaId: string;
      farmaciaId: string;
      payloadJson: string;
      idempotencyKey: string;
      payloadHash: string;
      attemptCount: number;
      leasedBy: string | null;
      leasedUntil: Date | null;
    }>
  >(Prisma.sql`
    WITH claimable AS (
      SELECT id
      FROM "OrderOutbox"
      WHERE (
              "state" = 'PENDENTE'
              AND "nextAttemptAt" <= ${now}
            )
         OR (
              "state" = 'EM_EXPORTACAO'
              AND "leasedUntil" IS NOT NULL
              AND "leasedUntil" <= ${now}
            )
      ORDER BY "nextAttemptAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OrderOutbox" o
    SET "state" = 'EM_EXPORTACAO',
        "leasedBy" = ${agentId},
        "leasedUntil" = ${leasedUntil},
        "lastAttemptAt" = ${now},
        "attemptCount" = o."attemptCount" + 1,
        "updatedAt" = ${now}
    FROM claimable c
    WHERE o.id = c.id
    RETURNING o.id,
              o."listaEncomendaId",
              o."farmaciaId",
              o."payloadJson",
              o."idempotencyKey",
              o."payloadHash",
              o."attemptCount",
              o."leasedBy",
              o."leasedUntil"
  `);

  // Audit: uma linha por lease claim.
  if (claimed.length > 0) {
    await ctx.prisma.orderExportAudit.createMany({
      data: claimed.map((c) => ({
        outboxId: c.id,
        attempt: c.attemptCount,
        status: "LEASE_CLAIMED",
        message: `leasedBy=${agentId} leasedUntil=${leasedUntil.toISOString()}`,
      })),
    });
  }

  return NextResponse.json({
    leasedUntil: leasedUntil.toISOString(),
    count: claimed.length,
    orders: claimed.map((c) => ({
      outboxId: c.id,
      listaEncomendaId: c.listaEncomendaId,
      farmaciaId: c.farmaciaId,
      idempotencyKey: c.idempotencyKey,
      payloadHash: c.payloadHash,
      attempt: c.attemptCount,
      payload: JSON.parse(c.payloadJson),
    })),
  });
});
