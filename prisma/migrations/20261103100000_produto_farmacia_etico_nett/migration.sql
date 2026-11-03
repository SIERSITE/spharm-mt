-- Classificação ERP Ético / NETT por farmácia (Entrega B). Puramente aditiva:
-- um tipo novo + 5 colunas em "ProdutoFarmacia" (nulas ou com DEFAULT) + 1 índice.
-- Não altera dados existentes nem colunas existentes; reversível com DROP INDEX / DROP COLUMN / DROP TYPE.
CREATE TYPE "ClassificacaoEticoNett" AS ENUM ('ETICO', 'NETT');

ALTER TABLE "ProdutoFarmacia"
  ADD COLUMN "eticoNett" "ClassificacaoEticoNett",
  ADD COLUMN "eticoNettCodigoErp" INTEGER,
  ADD COLUMN "eticoNettDescricaoErp" TEXT,
  ADD COLUMN "eticoNettObservadoEm" TIMESTAMP(3),
  ADD COLUMN "eticoNettManual" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "ProdutoFarmacia_eticoNett_idx" ON "ProdutoFarmacia"("eticoNett");
