-- Phase 1a — Fornecedores: staging link per-farmácia ↔ Fornecedor canónico.
--
-- Adiciona:
--   · Fornecedor.nome  (TEXT, nullable) — Nome Fornecedor canónico SaaS
--   · Fornecedor.nif   (TEXT, nullable) — NIF canónico SaaS
--   · FornecedorErpRef (nova tabela) — snapshot per-farmácia do ERP local
--
-- Idempotência da ingestão: `@@unique([farmaciaId, externalFornecedorId])`.
--
-- Não-destrutivo:
--   · Fornecedor.nomeNormalizado @unique GLOBAL preserva-se intacto.
--   · Rows pré-existentes em Fornecedor ficam com nome=NULL e nif=NULL até
--     o agent fornecedores-upload as enriquecer.
--   · FornecedorAlias e relações existentes (compras, devolucoes, indicadores,
--     listasEncomenda, produtosFarmacia) inalteradas.
--
-- onDelete:
--   · FornecedorErpRef → Fornecedor: CASCADE (ref morre com o canónico)
--   · FornecedorErpRef → Farmacia:   CASCADE (ref morre com a farmácia)

ALTER TABLE "Fornecedor" ADD COLUMN "nome" TEXT;
ALTER TABLE "Fornecedor" ADD COLUMN "nif" TEXT;

CREATE TABLE "FornecedorErpRef" (
    "id" TEXT NOT NULL,
    "fornecedorId" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "externalFornecedorId" INTEGER NOT NULL,
    "nomeAbreviadoErp" TEXT NOT NULL,
    "nomeFornecedorErp" TEXT,
    "nifErp" TEXT,
    "tipoFornecedorErpId" INTEGER,
    "tipoFornecedorErpDesc" TEXT,
    "inactivoErp" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestBatchId" TEXT,

    CONSTRAINT "FornecedorErpRef_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FornecedorErpRef_farmaciaId_externalFornecedorId_key"
  ON "FornecedorErpRef"("farmaciaId", "externalFornecedorId");

CREATE INDEX "FornecedorErpRef_fornecedorId_idx"
  ON "FornecedorErpRef"("fornecedorId");

CREATE INDEX "FornecedorErpRef_farmaciaId_inactivoErp_idx"
  ON "FornecedorErpRef"("farmaciaId", "inactivoErp");

CREATE INDEX "FornecedorErpRef_farmaciaId_lastSyncedAt_idx"
  ON "FornecedorErpRef"("farmaciaId", "lastSyncedAt");

ALTER TABLE "FornecedorErpRef"
  ADD CONSTRAINT "FornecedorErpRef_fornecedorId_fkey"
  FOREIGN KEY ("fornecedorId") REFERENCES "Fornecedor"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FornecedorErpRef"
  ADD CONSTRAINT "FornecedorErpRef_farmaciaId_fkey"
  FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
