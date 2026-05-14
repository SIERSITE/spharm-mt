-- PipelineRun: auditoria do pipeline autónomo daily-sync → aggregate.
--
-- Single-shot record por execução. Append-only operacionalmente, mas
-- updates permitidos para fechar `RUNNING` → `OK`/`ERROR`/`ABORTED`.
-- Ver schema.prisma para semântica de kinds + status.

CREATE TABLE "PipelineRun" (
  "id" TEXT NOT NULL,
  "farmaciaId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "dateRef" TEXT,
  "durationMs" INTEGER,
  "errorMessage" TEXT,
  "details" JSONB NOT NULL DEFAULT '{}',
  "triggeredBy" TEXT NOT NULL DEFAULT 'agent',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PipelineRun_farmaciaId_kind_startedAt_idx"
  ON "PipelineRun"("farmaciaId", "kind", "startedAt");

CREATE INDEX "PipelineRun_status_startedAt_idx"
  ON "PipelineRun"("status", "startedAt");

ALTER TABLE "PipelineRun"
  ADD CONSTRAINT "PipelineRun_farmaciaId_fkey"
  FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
