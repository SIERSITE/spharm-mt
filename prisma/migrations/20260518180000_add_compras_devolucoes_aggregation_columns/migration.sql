-- Phase 1c.1 — Aggregation columns + uniques para Compra/Devolucao.
--
-- Aditiva pura: apenas ADD COLUMN nullable, CREATE UNIQUE INDEX e
-- CREATE INDEX. Nenhum DROP, nenhuma backfill, nenhuma trigger.
--
-- Pré-requisitos (validados em demo-neon a 2026-05-18):
--   · Compra:    sem duplicados em (farmaciaId, produtoId, fornecedorId, data)
--   · Devolucao: tabela vazia → externalLineId arranca tudo NULL
--
-- Risco operacional em tenants não-vazios:
--   · CREATE UNIQUE INDEX em "Compra"_aggregation_key falha se houver
--     duplicados pré-existentes. Esta fase só aplica a demo-neon, onde
--     o pre-check confirmou 0 rows. Antes de aplicar a outros tenants
--     correr `scripts/admin/check-compra-dev-precheck.ts <slug>`.
--   · Postgres permite múltiplos NULLs em compound unique → rows legacy
--     com `externalLineId IS NULL` (Devolucao) ou `fornecedorId IS NULL`
--     (Compra) coexistem sem conflito.
--
-- A aggregation Phase 1c.1 corre EM DRY-RUN sobre estas colunas mas
-- não escreve. O endpoint POST /api/admin/pipeline/aggregate-compras
-- rejeita write=true com 400 not_enabled_yet.

ALTER TABLE "Compra" ADD COLUMN "ingestBatchId" TEXT;
ALTER TABLE "Compra" ADD COLUMN "aggregatedAt"  TIMESTAMP(3);

ALTER TABLE "Devolucao" ADD COLUMN "externalLineId" INTEGER;
ALTER TABLE "Devolucao" ADD COLUMN "ingestBatchId"  TEXT;
ALTER TABLE "Devolucao" ADD COLUMN "aggregatedAt"   TIMESTAMP(3);

-- Idempotência da aggregation.
CREATE UNIQUE INDEX "Compra_aggregation_key"
  ON "Compra"("farmaciaId", "produtoId", "fornecedorId", "data");

CREATE UNIQUE INDEX "Devolucao_farmaciaId_externalLineId_key"
  ON "Devolucao"("farmaciaId", "externalLineId");

-- Observabilidade + cleanup direccionado.
CREATE INDEX "Compra_ingestBatchId_idx"  ON "Compra"("ingestBatchId");
CREATE INDEX "Compra_aggregatedAt_idx"   ON "Compra"("aggregatedAt");
CREATE INDEX "Devolucao_ingestBatchId_idx" ON "Devolucao"("ingestBatchId");
CREATE INDEX "Devolucao_aggregatedAt_idx"  ON "Devolucao"("aggregatedAt");
