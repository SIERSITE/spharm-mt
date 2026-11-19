/**
 * lib/ultima-atualizacao-core.ts
 *
 * Lógica PURA (sem Prisma, sem "server-only") do bloco «Última atualização» do
 * menu lateral: uma linha por farmácia, cada uma com a data da SUA última
 * atualização concluída. Não há data global nem «a mais antiga».
 *
 * ── Fonte ────────────────────────────────────────────────────────────
 * `PipelineRun` com kind ∈ {daily-pipeline, daily-sync} e status = OK; o
 * instante é `updatedAt` (relógio do SERVIDOR, escrito quando o SaaS grava o
 * fecho da corrida — não o `finishedAt`, que vem do relógio da farmácia).
 *
 * Fora, de propósito: sync-now (hora do pedido do utilizador), PARTIAL/ERROR/
 * ABORTED/RUNNING (incompletas ou falhadas), aggregate-month, tentativas e o
 * heartbeat do agent (prova que está vivo, não que chegaram dados).
 */

export const KINDS_ATUALIZACAO = ["daily-pipeline", "daily-sync"] as const;
export const STATUS_ATUALIZACAO = "OK";

export type FarmaciaRef = { id: string; nome: string };
export type CorridaConcluida = { farmaciaId: string; recebidaEm: Date };

export type UltimaAtualizacaoFarmacia = {
  id: string;
  nome: string;
  /** ISO-8601 UTC, ou null = sem atualização concluída. */
  ate: string | null;
};

/** Por farmácia, a corrida concluída mais recente. Mantém a ordem recebida. */
export function ultimasAtualizacoes(farmacias: FarmaciaRef[], corridas: CorridaConcluida[]): UltimaAtualizacaoFarmacia[] {
  const maisRecente = new Map<string, number>();
  for (const c of corridas) {
    const t = c.recebidaEm.getTime();
    if (!Number.isFinite(t)) continue;
    const atual = maisRecente.get(c.farmaciaId);
    if (atual === undefined || t > atual) maisRecente.set(c.farmaciaId, t);
  }
  return farmacias.map((f) => {
    const t = maisRecente.get(f.id);
    return { id: f.id, nome: f.nome, ate: t === undefined ? null : new Date(t).toISOString() };
  });
}

const FUSO = "Europe/Lisbon";

/** "19/11/2026 às 08:24" (fuso de Lisboa, determinístico em qualquer máquina). */
export function formatarAtualizacao(iso: string): string {
  const p = new Intl.DateTimeFormat("pt-PT", {
    timeZone: FUSO,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}/${g("month")}/${g("year")} às ${g("hour")}:${g("minute")}`;
}

export const TEXTO_SEM_ATUALIZACAO = "Sem atualização disponível";
export const TITULO_BLOCO = "Última atualização";
