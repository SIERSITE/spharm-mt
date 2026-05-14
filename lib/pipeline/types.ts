/**
 * lib/pipeline/types.ts
 *
 * Shapes canónicos do payload `details` de `PipelineRun.details` JSON.
 * Não há enforcement DB-side — esta tipagem serve para o agent +
 * endpoints + health CLI + página /admin/pipeline lerem/escreverem
 * com a mesma forma.
 *
 * IMPORTANTE: alterações breaking aqui exigem migration de leitura,
 * porque rows antigas em PipelineRun.details ficam com o shape velho.
 * Adicionar campos novos (optional) é safe; remover/renomear não é.
 */

/** Counts emitidos por um pipeline de daily-sync. */
export type DailySyncDetails = {
  productsRead: number;
  productsUpserted: number;
  productsSkipped: number;
  productsErrors: number;
  stockRead: number;
  stockUpserted: number;
  stockErrors: number;
  salesRead: number;
  salesUpserted: number;
  salesSkipped: number;
  salesErrors: number;
  salesNonStockServices: number;
  salesOperationalOrphans: number;
};

/** Counts emitidos pelo aggregate-month. */
export type AggregateMonthDetails = {
  ano: number;
  mes: number;
  rawLines: number;
  produtosDistinct: number;
  atendimentosDistinct: number;
  byClass: Record<string, number>;
  unknowns: number;
  nonStockServices: number;
  operationalOrphans: number;
  rowsInserted: number;
  rowsDeleted: number;
  valorBrutoSum: number;
  quantidadeLiquidaSum: number;
  linhasVendaSum: number;
  atendimentosSum: number;
  /// Identifica o run de aggregate criado pelo server-side. Permite ao
  /// daily-pipeline referir-se ao sub-run.
  aggregateRunId?: string;
};

/** Payload composto do orquestrador daily-pipeline. */
export type DailyPipelineDetails = {
  /// "ontem" calculado pelo orquestrador (YYYY-MM-DD).
  dailyDate: string;
  /// Mês alvo da agregação (YYYY-MM).
  aggregateMonth: string;
  dailySync?: DailySyncDetails;
  aggregate?: AggregateMonthDetails;
  /// Sub-passos que abortaram + razão.
  steps: Array<{
    name: string;
    status: "OK" | "ERROR" | "SKIPPED";
    durationMs: number;
    message?: string;
  }>;
};

export const PIPELINE_KIND = {
  DAILY: "daily-pipeline",
  DAILY_SYNC: "daily-sync",
  AGGREGATE: "aggregate-month",
} as const;

export const PIPELINE_STATUS = {
  RUNNING: "RUNNING",
  OK: "OK",
  ERROR: "ERROR",
  ABORTED: "ABORTED",
} as const;

export type PipelineKind = (typeof PIPELINE_KIND)[keyof typeof PIPELINE_KIND];
export type PipelineStatus = (typeof PIPELINE_STATUS)[keyof typeof PIPELINE_STATUS];

export function isPipelineKind(s: string): s is PipelineKind {
  return s === PIPELINE_KIND.DAILY || s === PIPELINE_KIND.DAILY_SYNC || s === PIPELINE_KIND.AGGREGATE;
}

export function isPipelineStatus(s: string): s is PipelineStatus {
  return s === PIPELINE_STATUS.RUNNING || s === PIPELINE_STATUS.OK ||
         s === PIPELINE_STATUS.ERROR || s === PIPELINE_STATUS.ABORTED;
}
