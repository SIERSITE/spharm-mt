-- Adds idempotencyKey to PipelineRun for /api/admin/pipeline/record.
--
-- O agent gera uma key determinística a partir do (kind, dateRef,
-- startedAt) do run. Retries da MESMA execução produzem a mesma key,
-- o endpoint detecta duplicado e devolve a row existente em vez de
-- inserir. Sem key (default null) o comportamento é o antigo (new
-- row em cada POST), preservando back-compat.
--
-- @@unique allows NULL values em Postgres (multiple NULL rows OK).

ALTER TABLE "PipelineRun" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "PipelineRun_idempotencyKey_key"
  ON "PipelineRun"("idempotencyKey");
