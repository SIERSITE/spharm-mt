/**
 * lib/sync-request/estado.ts
 *
 * Regras PURAS do ciclo de vida de um `SyncRequest` (botão "Sincronizar
 * agora" em /stock — Bloco E). Sem I/O, sem Prisma: tudo aqui recebe um
 * "snapshot" simples e devolve uma decisão, para ser testável sem BD
 * (ver `scripts/tests/test-sync-on-demand.ts`).
 *
 * Padrão outbox invertido: o browser deposita o pedido; o agent (fora
 * deste módulo) executa-o assim que o reclamar. Desde que o agent
 * passou a fazer long-polling real (`agent/src/commands/sync-now.ts`,
 * `agent/docs/sync-now.md` secção 2), "agora" significa tipicamente
 * segundos — não minutos —, mas continua a não ser uma garantia
 * instantânea a 100% (o agent só reclama no ciclo de long-poll em que
 * o pedido calhar de existir, e a sincronização em si ainda depende do
 * ERP). A UI comunica isto sem exagerar (ver
 * `components/stock/sync-now-widget.tsx`).
 */

export type EstadoSyncRequest = "PENDENTE" | "EM_CURSO" | "CONCLUIDO" | "FALHOU" | "EXPIRADO";

/** Estados que contam como "há um pedido a decorrer" para o mutex e a UI. */
export const ESTADOS_ATIVOS: readonly EstadoSyncRequest[] = ["PENDENTE", "EM_CURSO"];

export function isEstadoAtivo(estado: EstadoSyncRequest): boolean {
  return (ESTADOS_ATIVOS as readonly string[]).includes(estado);
}

/**
 * Minutos até um pedido PENDENTE/EM_CURSO ser considerado expirado.
 *
 * 15 minutos cobre confortavelmente o pior caso de reclamação pelo
 * agent — hoje tipicamente ~1 minuto com o Task Scheduler a 1 min e o
 * long-poll interno a dominar a latência (ver `agent/docs/sync-now.md`
 * secção 2), não os ~2 min do desenho anterior — mais o tempo da
 * corrida em si (produtos+stock de uma farmácia, tipicamente segundos a
 * poucos minutos). Longo demais e o utilizador fica a olhar para um
 * botão "a sincronizar" muito depois de o agent ter desistido; curto
 * demais e uma corrida legitimamente lenta expira antes do ack chegar.
 */
export const SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT = 15;

export function computeTimeoutAt(
  agora: Date,
  minutos: number = SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT,
): Date {
  return new Date(agora.getTime() + minutos * 60_000);
}

export type SyncRequestEstadoSnapshot = {
  estado: EstadoSyncRequest;
  timeoutAt: Date;
};

/**
 * Cálculo LAZY de expiração.
 *
 * Não há cron dedicado neste projecto para varrer pedidos expirados —
 * mesma escolha que o resto do pipeline (ver `PipelineRun`/health
 * checks). Cada leitura decide: se o pedido está PENDENTE/EM_CURSO e já
 * passou `timeoutAt`, o estado EFECTIVO é EXPIRADO. O caller (server
 * action / endpoint) decide se persiste essa transição — ver
 * `lib/sync-request/estado.ts::deveriaPersistirExpiracao`.
 */
export function resolverEstadoEfetivo(
  req: SyncRequestEstadoSnapshot,
  agora: Date,
): EstadoSyncRequest {
  if (isEstadoAtivo(req.estado) && agora.getTime() > req.timeoutAt.getTime()) {
    return "EXPIRADO";
  }
  return req.estado;
}

/** Atalho: o estado persistido já não reflecte o estado efectivo (expirou agora mesmo). */
export function deveriaPersistirExpiracao(
  req: SyncRequestEstadoSnapshot,
  agora: Date,
): boolean {
  return resolverEstadoEfetivo(req, agora) === "EXPIRADO" && req.estado !== "EXPIRADO";
}

export type DecisaoNovoPedido =
  | { permitido: true }
  | { permitido: false; motivo: string; estadoActual: EstadoSyncRequest };

/**
 * Mutex aplicacional: só pode existir um pedido ACTIVO (PENDENTE ou
 * EM_CURSO, não expirado) por farmácia.
 *
 * `existente` é o pedido mais recente conhecido para essa farmácia (ou
 * `null` se nunca houve nenhum) — o caller só precisa de 1 query
 * (o mais recente por farmaciaId, ordenado por `requestedAt desc`).
 *
 * Esta função dá a mensagem amigável no caminho feliz; a garantia REAL
 * contra races (dois cliques quase simultâneos) é o índice único
 * PARCIAL criado na migração (`SyncRequest_farmacia_ativo_key`) — um
 * INSERT que viole o mutex falha na base mesmo que esta função, por
 * uma leitura desactualizada, tenha dito `permitido: true`.
 */
export function podeCriarNovoPedido(
  existente: SyncRequestEstadoSnapshot | null,
  agora: Date,
): DecisaoNovoPedido {
  if (!existente) return { permitido: true };
  const efetivo = resolverEstadoEfetivo(existente, agora);
  if (isEstadoAtivo(efetivo)) {
    return {
      permitido: false,
      estadoActual: efetivo,
      motivo:
        efetivo === "PENDENTE"
          ? "Já existe um pedido de sincronização pendente para esta farmácia — aguarda o agent processá-lo."
          : "Já existe uma sincronização em curso para esta farmácia — aguarda a conclusão.",
    };
  }
  return { permitido: true };
}

/**
 * Um pedido é reclamável pelo agent (GET pending) quando: pertence à
 * farmácia que o agent conhece via config, o estado PERSISTIDO é
 * PENDENTE, e o estado EFECTIVO (lazy) ainda não expirou. Um pedido
 * PENDENTE mas já expirado não deve ser entregue ao agent — seria
 * trabalho a caminho de um resultado que a UI já desistiu de esperar.
 */
export function eReclamavelPeloAgent(
  req: SyncRequestEstadoSnapshot & { farmaciaId: string },
  agora: Date,
  farmaciaIdDoAgent: string,
): boolean {
  if (req.farmaciaId !== farmaciaIdDoAgent) return false;
  if (req.estado !== "PENDENTE") return false;
  return resolverEstadoEfetivo(req, agora) === "PENDENTE";
}

/**
 * Um pedido só aceita ack/fail vindo de EM_CURSO — mesma defesa contra
 * races usada em `OrderOutbox` (`.../ack` e `.../nack` só aceitam
 * `EM_EXPORTACAO`). Aceitar de qualquer estado permitiria um ack tardio
 * (depois de o pedido já ter expirado e a UI ter desistido) reescrever
 * um resultado que já não é o dele.
 */
export function podeReceberAckOuFail(estadoPersistido: EstadoSyncRequest): boolean {
  return estadoPersistido === "EM_CURSO";
}

/** Os três contadores que o botão mostra quando o pedido conclui. */
export type SyncResultado = {
  stockAtualizado: number;
  produtosAtualizados: number;
  fabricantesAlterados: number;
};

export function resultadoVazio(): SyncResultado {
  return { stockAtualizado: 0, produtosAtualizados: 0, fabricantesAlterados: 0 };
}

/** Validação defensiva de um `resultado` recebido do agent (JSON solto). */
export function parseSyncResultado(raw: unknown): SyncResultado {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    stockAtualizado: num(obj.stockAtualizado),
    produtosAtualizados: num(obj.produtosAtualizados),
    fabricantesAlterados: num(obj.fabricantesAlterados),
  };
}
