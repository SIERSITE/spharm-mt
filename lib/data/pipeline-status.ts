/**
 * lib/data/pipeline-status.ts
 *
 * Loader server-only para /admin/pipeline. Lê PipelineRun + counts
 * derivados (VendaMensal, IngestVendaLinhaRaw). Não modifica nada.
 */

import "server-only";
import { getPrisma } from "@/lib/prisma";
import { PIPELINE_KIND, PIPELINE_STATUS } from "@/lib/pipeline/types";

export type PipelineRunSummary = {
  id: string;
  kind: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  dateRef: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  details: Record<string, unknown>;
  triggeredBy: string;
};

export type PipelineStatusData = {
  lastDailyPipeline: PipelineRunSummary | null;
  lastAggregate: PipelineRunSummary | null;
  lastDailySync: PipelineRunSummary | null;
  recentRuns: PipelineRunSummary[];
  recentFailures: PipelineRunSummary[];
  metrics: {
    vendaMensalRowsAgent: number;
    vendaMensalRowsAll: number;
    unknowns: number;
    operationalOrphans: number;
    nonStockServices: number;
    lastAggregatedMonth: { ano: number; mes: number; rows: number } | null;
  };
};

function toSummary(r: {
  id: string;
  kind: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  dateRef: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  details: unknown;
  triggeredBy: string;
}): PipelineRunSummary {
  return {
    ...r,
    details: (r.details as Record<string, unknown> | null) ?? {},
  };
}

export async function getPipelineStatus(): Promise<PipelineStatusData> {
  const prisma = await getPrisma();

  const [
    lastDailyPipeline,
    lastAggregate,
    lastDailySync,
    recentRuns,
    recentFailures,
    vendaMensalRowsAgent,
    vendaMensalRowsAll,
    unknowns,
    operationalOrphans,
    nonStockServices,
    lastMonthAgg,
  ] = await Promise.all([
    prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.DAILY },
      orderBy: { startedAt: "desc" },
    }),
    prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.AGGREGATE },
      orderBy: { startedAt: "desc" },
    }),
    prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.DAILY_SYNC },
      orderBy: { startedAt: "desc" },
    }),
    prisma.pipelineRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
    prisma.pipelineRun.findMany({
      where: {
        status: { in: [PIPELINE_STATUS.ERROR, PIPELINE_STATUS.ABORTED] },
      },
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
    prisma.vendaMensal.count({ where: { origemAgregacao: "agent-bootstrap-staging" } }),
    prisma.vendaMensal.count(),
    prisma.ingestVendaLinhaRaw.count({ where: { tipoDocumentoClass: "UNKNOWN" } }),
    prisma.ingestVendaLinhaRaw.count({
      where: { produtoId: null, isNonStockService: false },
    }),
    prisma.ingestVendaLinhaRaw.count({
      where: { produtoId: null, isNonStockService: true },
    }),
    prisma.vendaMensal.findFirst({
      where: { origemAgregacao: "agent-bootstrap-staging" },
      orderBy: [{ ano: "desc" }, { mes: "desc" }],
      select: { ano: true, mes: true },
    }),
  ]);

  let lastAggregatedMonth: PipelineStatusData["metrics"]["lastAggregatedMonth"] = null;
  if (lastMonthAgg) {
    const rows = await prisma.vendaMensal.count({
      where: {
        ano: lastMonthAgg.ano,
        mes: lastMonthAgg.mes,
        origemAgregacao: "agent-bootstrap-staging",
      },
    });
    lastAggregatedMonth = { ano: lastMonthAgg.ano, mes: lastMonthAgg.mes, rows };
  }

  return {
    lastDailyPipeline: lastDailyPipeline ? toSummary(lastDailyPipeline) : null,
    lastAggregate: lastAggregate ? toSummary(lastAggregate) : null,
    lastDailySync: lastDailySync ? toSummary(lastDailySync) : null,
    recentRuns: recentRuns.map(toSummary),
    recentFailures: recentFailures.map(toSummary),
    metrics: {
      vendaMensalRowsAgent,
      vendaMensalRowsAll,
      unknowns,
      operationalOrphans,
      nonStockServices,
      lastAggregatedMonth,
    },
  };
}
