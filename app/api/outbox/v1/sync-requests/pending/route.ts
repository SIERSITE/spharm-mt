import { NextResponse, type NextRequest } from "next/server";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import { assertFarmaciaInTenant } from "@/lib/ingest/bootstrap";
import { clampWaitSeconds, longPollClaim } from "@/lib/sync-request/longpoll";

/**
 * GET /api/outbox/v1/sync-requests/pending?farmaciaId=<cuid>&waitSeconds=<N>
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
 * `runtime`/`dynamic` declarados explicitamente: uma rota que pode
 * ficar à espera segundos dentro do handler não pode arriscar ser
 * tratada como estática/cacheável pelo Next.
 *
 * ── Long-poll (perto de tempo real, sem processo persistente) ────────
 *
 * `waitSeconds` (opcional, tecto `LONGPOLL_MAX_WAIT_SECONDS` = 25s):
 * se o primeiro SELECT não encontra nada reclamável, o handler NÃO
 * responde logo com `count: 0` — repete a tentativa de claim
 * internamente, a cada `LONGPOLL_POLL_INTERVAL_MS` (~1.2s), até
 * aparecer algo ou até `waitSeconds` esgotar. O deploy é `next start`
 * de longa duração atrás de um nginx com `proxy_read_timeout 310s`
 * (`deploy/docker/proxy/spharmmt-proxy-common.inc`), por isso manter
 * este pedido HTTP aberto ~20s é seguro. Ver `lib/sync-request/longpoll.ts`
 * para a lógica pura (testável sem BD) e `agent/src/commands/sync-now.ts`
 * para quem consome isto (vários ciclos sequenciais de long-poll numa
 * só corrida do agent).
 *
 * Sem `waitSeconds` (ou `<= 0`): UMA tentativa, resposta imediata — o
 * comportamento de sempre, para não quebrar nenhum chamador existente
 * que não conheça este parâmetro.
 *
 * Claim atómico: `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
 * LOCKED)` — mesmo padrão de `/orders/pending`, repetido a cada
 * tentativa (dentro ou fora do long-poll). Como o mutex aplicacional
 * + o índice único parcial garantem no máximo UM pedido PENDENTE/EM_CURSO
 * por farmácia, isto devolve sempre 0 ou 1 linha.
 *
 * Um pedido PENDENTE mas cujo `timeoutAt` já passou NÃO é reclamado — a
 * UI já o lê como EXPIRADO (cálculo lazy, ver
 * `lib/sync-request/estado.ts`) e entregar trabalho a caminho de um
 * resultado que ninguém está à espera não serve ninguém. Cada
 * tentativa de claim usa o instante EM QUE CORRE (não o instante em que
 * o pedido HTTP chegou) — um pedido que expira a meio de uma janela de
 * long-poll deixa de ser reclamável a partir desse momento, como seria
 * de esperar.
 *
 * Sem `leasedUntil`/TTL de reclaim como em `OrderOutbox`: o agent corre
 * o subconjunto leve de forma SÍNCRONA dentro do mesmo comando CLI
 * logo a seguir a reclamar — não há um segundo processo a competir pela
 * mesma farmácia. Se o agent crashar depois de reclamar mas antes do
 * ack, o pedido fica EM_CURSO até `timeoutAt`; a leitura lazy trata-o
 * como EXPIRADO e o mutex volta a permitir um novo pedido.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClaimedRow = {
  id: string;
  farmaciaId: string;
  requestedAt: Date;
  timeoutAt: Date;
};

async function attemptClaim(
  prisma: PrismaClient,
  farmaciaId: string,
  agentId: string,
): Promise<ClaimedRow[]> {
  const now = new Date();
  return prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
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
}

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
  const waitSeconds = clampWaitSeconds(url.searchParams.get("waitSeconds"));

  const claimed = await longPollClaim(
    () => attemptClaim(ctx.prisma, farmaciaId, agentId),
    { waitSeconds },
  );

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
