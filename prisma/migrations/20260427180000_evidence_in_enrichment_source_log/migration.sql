-- Add evidence fields to EnrichmentSourceLog and PARTIAL_HIT enum value.
-- Additive-only; safe on tenants with existing rows.

-- Add new enum value. PostgreSQL 12+ permite ADD VALUE numa transação
-- desde que o valor novo não seja USADO na mesma transação — neste
-- ficheiro só adicionamos o valor + colunas, sem inserts.
ALTER TYPE "EnrichmentSourceStatus" ADD VALUE IF NOT EXISTS 'PARTIAL_HIT';

-- Add evidence columns. Todas nullable.
ALTER TABLE "EnrichmentSourceLog"
  ADD COLUMN IF NOT EXISTS "url"            TEXT,
  ADD COLUMN IF NOT EXISTS "query"          TEXT,
  ADD COLUMN IF NOT EXISTS "rawBrand"       TEXT,
  ADD COLUMN IF NOT EXISTS "rawCategory"    TEXT,
  ADD COLUMN IF NOT EXISTS "rawProductName" TEXT;
