/**
 * lib/sync-request-data.ts
 *
 * Server-only. Loaders Prisma para o widget "Sincronizar agora" em
 * /stock (Bloco E). Espelha `lib/stock-data.ts` na separação
 * servidor/cliente: NUNCA importar a partir de um Client Component —
 * use os tipos de `lib/sync-request/estado.ts` no cliente.
 */
import "server-only";
import { getPrisma } from "@/lib/prisma";
import { canAccessFarmaciaSync } from "@/lib/permissions";
import type { SessionUser } from "@/lib/auth";
import { PIPELINE_KIND } from "@/lib/pipeline/types";
import {
  deveriaPersistirExpiracao,
  parseSyncResultado,
  resolverEstadoEfetivo,
  type EstadoSyncRequest,
  type SyncResultado,
} from "@/lib/sync-request/estado";

export type SyncFarmaciaOption = { id: string; nome: string };

export type SyncWidgetStatus = {
  farmaciaId: string;
  /** "SEM_PEDIDO" quando esta farmácia nunca teve nenhum SyncRequest. */
  estado: EstadoSyncRequest | "SEM_PEDIDO";
  requestedAt: string | null;
  finishedAt: string | null;
  resultado: SyncResultado | null;
  erro: string | null;
  /** ISO da última sincronização CONCLUÍDA — nunca a de um pedido falhado/expirado. */
  ultimaSincronizacaoOk: string | null;
};

/** Farmácias ATIVAS a que a sessão tem acesso — universo do selector do widget. */
export async function loadFarmaciasParaSync(session: SessionUser): Promise<SyncFarmaciaOption[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO" },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  return farmacias.filter((f) => canAccessFarmaciaSync(session, f.id));
}

/**
 * Estado corrente do pedido de sincronização de UMA farmácia, com
 * expiração lazy já resolvida (e persistida, best-effort) — ver
 * `lib/sync-request/estado.ts::resolverEstadoEfetivo`.
 *
 * A "última sincronização OK" é o mais recente entre:
 *   · o `SyncRequest` mais recente com estado CONCLUIDO (pode não ser o
 *     último pedido — o último pode ter falhado depois);
 *   · a `PipelineRun` mais recente kind=sync-now status=OK (o ack do
 *     agent escreve as duas em conjunto — ver a rota `.../ack`).
 * Tomar o mais recente das duas cobre o caso em que uma delas falhou a
 * escrever por qualquer razão sem esconder uma sincronização real.
 */
export async function loadSyncStatus(farmaciaId: string): Promise<SyncWidgetStatus> {
  const prisma = await getPrisma();
  const agora = new Date();

  const [ultimoPedido, ultimoSucesso, ultimaPipelineRunOk] = await Promise.all([
    prisma.syncRequest.findFirst({
      where: { farmaciaId },
      orderBy: { requestedAt: "desc" },
    }),
    prisma.syncRequest.findFirst({
      where: { farmaciaId, estado: "CONCLUIDO" },
      orderBy: { finishedAt: "desc" },
    }),
    prisma.pipelineRun.findFirst({
      where: { farmaciaId, kind: PIPELINE_KIND.SYNC_NOW, status: "OK" },
      orderBy: { finishedAt: "desc" },
    }),
  ]);

  const ultimaSincronizacaoOk =
    [ultimoSucesso?.finishedAt ?? null, ultimaPipelineRunOk?.finishedAt ?? null]
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString() ?? null;

  if (!ultimoPedido) {
    return {
      farmaciaId,
      estado: "SEM_PEDIDO",
      requestedAt: null,
      finishedAt: null,
      resultado: null,
      erro: null,
      ultimaSincronizacaoOk,
    };
  }

  const efetivo = resolverEstadoEfetivo(ultimoPedido, agora);

  // Persistência lazy da expiração. Best-effort: se outra leitura (ou o
  // ack tardio do agent) já mexeu na row entretanto, este UPDATE não
  // pode rebentar a leitura do estado — reporta-se sempre `efetivo`,
  // persistido ou não.
  if (deveriaPersistirExpiracao(ultimoPedido, agora)) {
    try {
      await prisma.syncRequest.update({
        where: { id: ultimoPedido.id },
        data: {
          estado: "EXPIRADO",
          finishedAt: ultimoPedido.finishedAt ?? agora,
          erro: ultimoPedido.erro ?? "Pedido expirou sem resposta do agent.",
        },
      });
    } catch {
      // concorrência — outro caller já tratou (ack/fail do agent, ou
      // outra leitura em paralelo). O `efetivo` já calculado continua correcto.
    }
  }

  return {
    farmaciaId,
    estado: efetivo,
    requestedAt: ultimoPedido.requestedAt.toISOString(),
    finishedAt: ultimoPedido.finishedAt?.toISOString() ?? null,
    resultado: efetivo === "CONCLUIDO" ? parseSyncResultado(ultimoPedido.resultado) : null,
    erro: efetivo === "FALHOU" || efetivo === "EXPIRADO" ? ultimoPedido.erro : null,
    ultimaSincronizacaoOk,
  };
}
