-- ─────────────────────────────────────────────────────────────────────
-- ProdutoFarmacia: campos de IVA persistidos pelo pipeline de
-- recuperação. Todos nullable, sem default destrutivo. Idempotente:
-- pode ser executada várias vezes em diferentes tenants sem perder
-- valores existentes (re-run do recuperador faz UPDATE selectivo).
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "ProdutoFarmacia"
  ADD COLUMN IF NOT EXISTS "taxaIvaPercent"   INTEGER,
  ADD COLUMN IF NOT EXISTS "taxaIvaSource"    TEXT,
  ADD COLUMN IF NOT EXISTS "taxaIvaUpdatedAt" TIMESTAMP(3);

-- Index para o bucket "Por taxa IVA" do relatório de Inventário
-- (4 buckets canónicos: 6/13/23/null).
CREATE INDEX IF NOT EXISTS "ProdutoFarmacia_taxaIvaPercent_idx"
  ON "ProdutoFarmacia"("taxaIvaPercent");
