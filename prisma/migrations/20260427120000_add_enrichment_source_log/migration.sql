-- Catalog enrichment instrumentation: per-call source logs.
-- Additive-only. Seguro correr em tenants com dados existentes.

-- CreateEnum EnrichmentSourceStatus
DO $$ BEGIN
  CREATE TYPE "EnrichmentSourceStatus" AS ENUM ('SUCCESS', 'NO_MATCH', 'ERROR');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable EnrichmentSourceLog
CREATE TABLE IF NOT EXISTS "EnrichmentSourceLog" (
    "id"             TEXT NOT NULL,
    "produtoId"      TEXT NOT NULL,
    "source"         TEXT NOT NULL,
    "status"         "EnrichmentSourceStatus" NOT NULL,
    "confidence"     DOUBLE PRECISION,
    "matchedBy"      TEXT,
    "durationMs"     INTEGER,
    "fieldsReturned" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "errorMessage"   TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrichmentSourceLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey: cascade delete with Produto.
DO $$ BEGIN
  ALTER TABLE "EnrichmentSourceLog"
    ADD CONSTRAINT "EnrichmentSourceLog_produtoId_fkey"
    FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Indexes for the metrics aggregations:
--   (source, createdAt)  — agregado por fonte / janela temporal
--   (produtoId, createdAt) — histórico por produto
--   (status, createdAt) — taxa de erro / no-match recentes
CREATE INDEX IF NOT EXISTS "EnrichmentSourceLog_source_createdAt_idx"
  ON "EnrichmentSourceLog"("source", "createdAt");
CREATE INDEX IF NOT EXISTS "EnrichmentSourceLog_produtoId_createdAt_idx"
  ON "EnrichmentSourceLog"("produtoId", "createdAt");
CREATE INDEX IF NOT EXISTS "EnrichmentSourceLog_status_createdAt_idx"
  ON "EnrichmentSourceLog"("status", "createdAt");
