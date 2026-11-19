/**
 * lib/dados-atualizados-core.ts
 *
 * Lógica PURA (sem Prisma, sem "server-only") de «Dados atualizados até».
 * Partilhada pelo servidor (que a alimenta com linhas da BD), pelo cliente
 * (que formata) e pelos testes.
 *
 * ── Fonte ────────────────────────────────────────────────────────────
 * `PipelineRun` com kind ∈ {daily-pipeline, daily-sync} e status = OK.
 * O instante usado é `updatedAt`: relógio do SERVIDOR, escrito quando o
 * SaaS recebe e grava o fecho da corrida (não o relógio do agent, que é
 * telemetria e pode estar errado, nem a data de negócio do último
 * movimento, que não muda numa farmácia sem vendas).
 *
 * Fora, de propósito:
 *   · kind = sync-now — é a hora do último PEDIDO do utilizador;
 *   · status ≠ OK (PARTIAL/ERROR/ABORTED/RUNNING) — dados incompletos;
 *   · heartbeat do agent — prova que o agent está vivo, não que há dados.
 */

export const KINDS_DADOS = ["daily-pipeline", "daily-sync"] as const;
export const STATUS_DADOS = "OK";

export type FarmaciaRef = { id: string; nome: string };
export type CorridaRecebida = { farmaciaId: string; recebidaEm: Date };

export type DadosAtualizadosFarmacia = {
  id: string;
  nome: string;
  /** ISO-8601 UTC, ou null = ainda sem informação. */
  ate: string | null;
};

export type DadosAtualizados = {
  /** Data MAIS ANTIGA entre as farmácias que têm informação; null se nenhuma. */
  ate: string | null;
  farmacias: DadosAtualizadosFarmacia[];
};

/** Mais recente corrida por farmácia → mais antiga entre farmácias. */
export function agregarDadosAtualizados(
  farmacias: FarmaciaRef[],
  corridas: CorridaRecebida[],
): DadosAtualizados {
  const maisRecente = new Map<string, number>();
  for (const c of corridas) {
    const t = c.recebidaEm.getTime();
    if (!Number.isFinite(t)) continue;
    const atual = maisRecente.get(c.farmaciaId);
    if (atual === undefined || t > atual) maisRecente.set(c.farmaciaId, t);
  }
  const linhas: DadosAtualizadosFarmacia[] = farmacias.map((f) => {
    const t = maisRecente.get(f.id);
    return { id: f.id, nome: f.nome, ate: t === undefined ? null : new Date(t).toISOString() };
  });
  const tempos = linhas.filter((l) => l.ate !== null).map((l) => Date.parse(l.ate as string));
  return {
    ate: tempos.length ? new Date(Math.min(...tempos)).toISOString() : null,
    farmacias: linhas,
  };
}

const FUSO = "Europe/Lisbon";

/** "19/11/2026, 14:32" (fuso de Lisboa, determinístico em qualquer máquina). */
export function formatarDataHora(iso: string): string {
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
  return `${g("day")}/${g("month")}/${g("year")}, ${g("hour")}:${g("minute")}`;
}

export const TEXTO_SEM_INFO = "Atualização ainda não disponível";
export function textoCabecalho(ate: string | null): string {
  return ate ? `Dados atualizados até ${formatarDataHora(ate)}` : TEXTO_SEM_INFO;
}
