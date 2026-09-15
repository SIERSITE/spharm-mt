import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import { assertFarmaciaInTenant } from "@/lib/ingest/bootstrap";

/**
 * GET /api/outbox/v1/sync-requests/pending?farmaciaId=<cuid>
 *
 * Bloco E — o agent faz poll deste endpoint (comando `sync-now`,
 * dedicado e mais curto que o `daily-pipeline`) para saber se o botão
 * "Sincronizar agora" de /stock depositou um pedido para a SUA
 * farmácia. Cada instalação do agent está ligada a UMA farmácia
 * (`SPHARMMT_FARMACIA`), resolvida antes desta chamada — por isso,
 * ao contrário de `/orders/pending`, este endpoint É filtrado por
 * `farmaciaId` explícito e nunca devolve pedidos de outra farmácia do
 * mesmo tenant.
 *
 * Claim atómico: `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
 * LOCKED)` — mesmo padrão de `/orders/pending`. Como o mutex aplicacional
 * + o índice único parcial garantem no máximo UM pedido PENDENTE/EM_CURSO
 * por farmácia, isto devolve sempre 0 ou 1 linha.
 *
 * Um pedido PENDENTE mas cujo `timeoutAt` já passou NÃO é reclamado — a
 * UI já o lê como EXPIRADO (cálculo lazy, ver
 * `lib/sync-request/estado.ts`) e entregar trabalho a caminho de um
 * resultado que ninguém está à espera não serve ninguém.
 *
 * Sem `leasedUntil`/TTL de reclaim como em `OrderOutbox`: o agent corre
 * o subconjunto leve de forma SÍNCRONA dentro do mesmo comando CLI
 * logo a seguir a reclamar — não há um segundo processo a competir pela
 * mesma farmácia. Se o agent crashar depois de reclamar mas antes do
 * ack, o pedido fica EM_CURSO até `timeoutAt`; a leitura lazy trata-o
 * como EXPIRADO e o mutex volta a permitir um novo pedido.
 */

export const GET = withIntegrationAuth(async (ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const farmaciaId = url.searchParams.get("farmaciaId") ?? "";
  if (!farmaciaId) {
    return NextResponse.json(
      { error: "missing_farmacia_id", message: "farmaciaId é obrigatório." },
      { status: 400 }
    );
  }
  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  const agentId = req.headers.get("x-agent-instance") ?? `${ctx.tenant.slug}-agent`;
  const now = new Date();

  const claimed = await ctx.prisma.$queryRaw<
    Array<{
      id: string;
      farmaciaId: string;
      requestedAt: Date;
      timeoutAt: Date;
    }>
  >(Prisma.sql`
    WITH claimable AS (
      SELECT id
      FROM "SyncRequest"
      WHERE "farmaciaId" = ${farmaciaId}
        AND "estado" = 'PENDENTE'
        AND "timeoutAt" > ${now}
      ORDER BY "requestedAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "SyncRequest" s
    SET "estado" = 'EM_CURSO',
        "leasedAt" = ${now},
        "leasedBy" = ${agentId},
        "startedAt" = ${now}
    FROM claimable c
    WHERE s.id = c.id
    RETURNING s.id, s."farmaciaId", s."requestedAt", s."timeoutAt"
  `);

  return NextResponse.json({
    count: claimed.length,
    syncRequests: claimed.map((c) => ({
      syncRequestId: c.id,
      farmaciaId: c.farmaciaId,
      requestedAt: c.requestedAt.toISOString(),
      timeoutAt: c.timeoutAt.toISOString(),
    })),
  });
});
