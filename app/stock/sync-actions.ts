"use server";

/**
 * app/stock/sync-actions.ts
 *
 * Server actions do botão "Sincronizar agora" em /stock (Bloco E).
 *
 * O browser NUNCA toca na BD/ERP local da farmácia — só deposita um
 * `SyncRequest` (padrão outbox, invertido face ao `OrderOutbox` de
 * encomendas: aqui quem escreve é o humano e quem consome é o agent).
 * "Agora" na prática significa "assim que o agent fizer o próximo poll
 * dedicado" — nunca instantâneo. Ver `agent/src/commands/sync-now.ts` e
 * `app/api/outbox/v1/sync-requests/*`.
 *
 * Auth: mesmo padrão do Bloco A (`getHistoricoProdutoAction`) —
 * `requirePermission("stock.sync")` + `canAccessFarmaciaSync` por
 * farmácia pedida explicitamente.
 */

import { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { requirePermission, canAccessFarmaciaSync } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import {
  computeTimeoutAt,
  podeCriarNovoPedido,
  type SyncRequestEstadoSnapshot,
} from "@/lib/sync-request/estado";
import { loadFarmaciasParaSync, loadSyncStatus, type SyncFarmaciaOption, type SyncWidgetStatus } from "@/lib/sync-request-data";

export type SyncActionResult =
  | { ok: true; status: SyncWidgetStatus }
  | { ok: false; error: string };

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Universo de farmácias que o utilizador da sessão pode escolher no widget. */
export async function getFarmaciasParaSyncAction(): Promise<SyncFarmaciaOption[]> {
  const session = await requirePermission("stock.sync");
  return loadFarmaciasParaSync(session);
}

/**
 * Leitura de estado — chamada no mount do widget e em polling curto
 * enquanto há um pedido activo. Também resolve a expiração lazy (ver
 * `lib/sync-request-data.ts::loadSyncStatus`).
 */
export async function getSyncStatusAction(input: { farmaciaId: string }): Promise<SyncActionResult> {
  const session = await requirePermission("stock.sync");
  const farmaciaId = input.farmaciaId?.trim();
  if (!farmaciaId) return { ok: false, error: "Farmácia em falta." };
  if (!canAccessFarmaciaSync(session, farmaciaId)) {
    return { ok: false, error: "Sem acesso a esta farmácia." };
  }
  return { ok: true, status: await loadSyncStatus(farmaciaId) };
}

/**
 * Cria o pedido de sincronização. Mutex (só um pedido PENDENTE/EM_CURSO
 * por farmácia) verificado a dois níveis:
 *   1. Leitura do último pedido + `podeCriarNovoPedido` — mensagem
 *      amigável no caminho feliz.
 *   2. Índice único PARCIAL na base (`SyncRequest_farmacia_ativo_key`)
 *      — rede de segurança real contra dois cliques quase simultâneos;
 *      um INSERT que o viole cai aqui como P2002 e devolve a mesma
 *      mensagem amigável em vez de rebentar.
 */
export async function requestSyncNowAction(input: { farmaciaId: string }): Promise<SyncActionResult> {
  const session = await requirePermission("stock.sync");
  const farmaciaId = input.farmaciaId?.trim();
  if (!farmaciaId) return { ok: false, error: "Farmácia em falta." };
  if (!canAccessFarmaciaSync(session, farmaciaId)) {
    return { ok: false, error: "Sem acesso a esta farmácia." };
  }

  const prisma = await getPrisma();
  const agora = new Date();

  const existente = await prisma.syncRequest.findFirst({
    where: { farmaciaId },
    orderBy: { requestedAt: "desc" },
    select: { estado: true, timeoutAt: true },
  });
  const snapshot: SyncRequestEstadoSnapshot | null = existente
    ? { estado: existente.estado, timeoutAt: existente.timeoutAt }
    : null;
  const decisao = podeCriarNovoPedido(snapshot, agora);
  if (!decisao.permitido) {
    return { ok: false, error: decisao.motivo };
  }

  let created: { id: string };
  try {
    created = await prisma.syncRequest.create({
      data: {
        farmaciaId,
        requestedByUserId: session.sub,
        timeoutAt: computeTimeoutAt(agora),
      },
      select: { id: true },
    });
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      return {
        ok: false,
        error: "Já existe um pedido de sincronização activo para esta farmácia — outro pedido ganhou a corrida por instantes.",
      };
    }
    throw err;
  }

  await logAudit({
    actorId: session.sub,
    action: "stock.sync_now.requested",
    entity: "SyncRequest",
    entityId: created.id,
    meta: { farmaciaId },
  });

  return { ok: true, status: await loadSyncStatus(farmaciaId) };
}
