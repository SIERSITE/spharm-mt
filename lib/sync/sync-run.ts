/**
 * lib/sync/sync-run.ts
 *
 * Helpers para escrever no ledger `SyncRun` do control plane. Use por
 * scripts/jobs que querem deixar trace observável da sua execução.
 *
 * Padrão de uso (CLI):
 *
 *   import { startSyncRun, completeSyncRun, failSyncRun } from "@/lib/sync/sync-run";
 *
 *   const run = await startSyncRun({
 *     tenantSlug: "demo",
 *     source: "regulatory-import",
 *     triggerType: "CLI",
 *   });
 *   try {
 *     const counts = await doTheWork();
 *     await completeSyncRun(run.id, counts);
 *   } catch (err) {
 *     await failSyncRun(run.id, err);
 *     throw err;
 *   }
 *
 * Idempotência: cada chamada cria 1 linha (cuid()) — não há detecção
 * de duplicates. O caller é responsável por garantir que NÃO chama
 * startSyncRun() duas vezes pelo mesmo trabalho (cron lock, file lock).
 *
 * Recovery: linhas com status=RUNNING há mais de X minutos sem update
 * indicam worker morto. Detecção fica para fora deste módulo (job
 * separado a correr periodicamente).
 */

import { getControlPrismaCli } from "@/lib/sync/control-client-cli";
import { hostname } from "node:os";
import type {
  SyncRunStatus,
  SyncRunTrigger,
} from "@/generated/prisma-control/client";

export type StartSyncRunInput = {
  tenantSlug: string;
  source: string;
  triggerType?: SyncRunTrigger;
  workerId?: string;
  meta?: Record<string, unknown>;
};

export type SyncRunCounts = {
  recordsRead?: number;
  recordsInserted?: number;
  recordsUpdated?: number;
  recordsFailed?: number;
};

export type SyncRunHandle = {
  id: string;
  tenantSlug: string;
  source: string;
  startedAt: Date;
};

/** Default workerId quando o caller não fornece. Formato `${host}/${pid}`. */
function defaultWorkerId(): string {
  try {
    return `${hostname()}/${process.pid}`;
  } catch {
    return `unknown/${process.pid}`;
  }
}

/**
 * Cria uma nova linha SyncRun com status=RUNNING. Devolve um handle
 * mínimo (id + identificação) para uso nas chamadas subsequentes.
 */
export async function startSyncRun(input: StartSyncRunInput): Promise<SyncRunHandle> {
  const row = await getControlPrismaCli().syncRun.create({
    data: {
      tenantSlug: input.tenantSlug,
      source: input.source,
      status: "RUNNING" satisfies SyncRunStatus,
      triggerType: input.triggerType ?? "CLI",
      workerId: input.workerId ?? defaultWorkerId(),
      metaJson: input.meta ? JSON.stringify(input.meta) : null,
    },
    select: { id: true, tenantSlug: true, source: true, startedAt: true },
  });
  return row;
}

/**
 * Marca a linha como COMPLETED, popula `finishedAt`, calcula
 * `durationMs` e actualiza os contadores opcionais.
 */
export async function completeSyncRun(
  id: string,
  counts: SyncRunCounts = {},
): Promise<void> {
  const finishedAt = new Date();
  // Lê o startedAt para calcular duração com precisão. Fallback para
  // 0 se a linha não existir (caller atrasado).
  const existing = await getControlPrismaCli().syncRun.findUnique({
    where: { id },
    select: { startedAt: true },
  });
  const durationMs = existing
    ? Math.max(0, finishedAt.getTime() - existing.startedAt.getTime())
    : 0;

  await getControlPrismaCli().syncRun.update({
    where: { id },
    data: {
      status: "COMPLETED" satisfies SyncRunStatus,
      finishedAt,
      durationMs,
      ...sanitizeCounts(counts),
      errorSummary: null,
    },
  });
}

/**
 * Marca a linha como FAILED, popula `errorSummary` (≤ 500 char),
 * `finishedAt`, `durationMs` e contadores opcionais. NÃO re-lança o
 * erro — o caller decide isso.
 */
export async function failSyncRun(
  id: string,
  error: unknown,
  counts: SyncRunCounts = {},
): Promise<void> {
  const finishedAt = new Date();
  const existing = await getControlPrismaCli().syncRun.findUnique({
    where: { id },
    select: { startedAt: true },
  });
  const durationMs = existing
    ? Math.max(0, finishedAt.getTime() - existing.startedAt.getTime())
    : 0;
  const errorSummary = errorToSummary(error);

  await getControlPrismaCli().syncRun.update({
    where: { id },
    data: {
      status: "FAILED" satisfies SyncRunStatus,
      finishedAt,
      durationMs,
      ...sanitizeCounts(counts),
      errorSummary,
    },
  });
}

/**
 * Wrap conveniente: executa `fn`, garante que ou completeSyncRun ou
 * failSyncRun é chamado. Re-lança erro depois de o registar.
 */
export async function withSyncRun<T>(
  input: StartSyncRunInput,
  fn: (handle: SyncRunHandle) => Promise<{ result: T; counts?: SyncRunCounts }>,
): Promise<T> {
  const handle = await startSyncRun(input);
  try {
    const { result, counts } = await fn(handle);
    await completeSyncRun(handle.id, counts ?? {});
    return result;
  } catch (err) {
    await failSyncRun(handle.id, err);
    throw err;
  }
}

/**
 * Actualiza `lastHeartbeatAt` da linha para agora. Chamar periodicamente
 * (a cada ~30s) durante runs longos para que o health check consiga
 * distinguir "worker vivo" de "worker morto".
 *
 * Silencioso em erro — o run principal não deve falhar só porque o
 * heartbeat falhou (rede temporária ao control plane).
 */
export async function heartbeatSyncRun(id: string): Promise<void> {
  try {
    await getControlPrismaCli().syncRun.update({
      where: { id },
      data: { lastHeartbeatAt: new Date() },
    });
  } catch (err) {
    // best-effort — não vale quebrar o run
    if (process.env.NODE_ENV !== "production") {
      console.warn("[heartbeatSyncRun] falhou:", err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Devolve `true` se já existir uma linha RUNNING para o mesmo
 * (tenantSlug, source) com heartbeat recente (< `staleThresholdMs`).
 * Usado como lock cooperativo entre invocações paralelas do mesmo cron.
 *
 * NÃO é um lock atómico ao nível de BD (não usa `SELECT ... FOR UPDATE`)
 * — se dois workers começarem simultaneamente, ambos podem passar.
 * Isso é aceitável para o pipeline de enriquecimento (jobs são idempotentes
 * por CNP), e demasiado caro para justificar um advisory lock aqui.
 */
export async function isSyncRunAlreadyRunning(
  tenantSlug: string,
  source: string,
  staleThresholdMs: number = 5 * 60 * 1000,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - staleThresholdMs);
  const row = await getControlPrismaCli().syncRun.findFirst({
    where: {
      tenantSlug,
      source,
      status: "RUNNING",
      OR: [
        { lastHeartbeatAt: { gte: cutoff } },
        // sem heartbeat mas iniciado há < 30s (arranque)
        { lastHeartbeatAt: null, startedAt: { gte: new Date(Date.now() - 30_000) } },
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

function sanitizeCounts(c: SyncRunCounts): Record<string, number> {
  const out: Record<string, number> = {};
  if (Number.isFinite(c.recordsRead) && (c.recordsRead ?? 0) >= 0) {
    out.recordsRead = Math.floor(c.recordsRead!);
  }
  if (Number.isFinite(c.recordsInserted) && (c.recordsInserted ?? 0) >= 0) {
    out.recordsInserted = Math.floor(c.recordsInserted!);
  }
  if (Number.isFinite(c.recordsUpdated) && (c.recordsUpdated ?? 0) >= 0) {
    out.recordsUpdated = Math.floor(c.recordsUpdated!);
  }
  if (Number.isFinite(c.recordsFailed) && (c.recordsFailed ?? 0) >= 0) {
    out.recordsFailed = Math.floor(c.recordsFailed!);
  }
  return out;
}

function errorToSummary(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message ?? String(error);
    return msg.length > 500 ? msg.slice(0, 497) + "..." : msg;
  }
  const s = String(error);
  return s.length > 500 ? s.slice(0, 497) + "..." : s;
}
