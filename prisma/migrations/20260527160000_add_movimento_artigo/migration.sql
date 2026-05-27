-- Block A1 — MovimentoArtigo canonical model (StocksMov-derived).
--
-- Cria 3 artefactos novos + 1 alteração não destrutiva:
--   · ENUM "TipoMovimentoArtigo"          (13 valores; ver schema.prisma)
--   · TABLE "MovimentoArtigo"             (1 row por dbo.StocksMov.StocksMovID)
--   · TABLE "IngestStocksMovRaw"          (staging cru + JSON payload)
--   · ALTER  "Farmacia" ADD COLUMN useMovimentosCanonical BOOLEAN DEFAULT false
--
-- Tudo NÃO-DESTRUTIVO:
--   · Apenas CREATE TYPE / TABLE / INDEX / CONSTRAINT
--   · ALTER em Farmacia adiciona coluna NULLABLE/DEFAULT — zero risco
--   · NÃO toca Venda / Compra / Devolucao / VendaMensal / AjusteStock
--   · NÃO altera dashboard reads
--
-- Idempotência semântica do upload:
--   · UNIQUE(farmaciaId, externalMovId) na MovimentoArtigo
--   · UNIQUE(farmaciaId, externalMovId, ingestRunId) no staging
--
-- Feature flag por farmácia: rollback = SET useMovimentosCanonical=false.

-- ── 1. ENUM ─────────────────────────────────────────────────────────
CREATE TYPE "TipoMovimentoArtigo" AS ENUM (
  'VENDA',
  'DEVOLUCAO_CLIENTE',
  'VENDA_CREDITO',
  'RESERVA_SUSPENSA',
  'COMPRA',
  'DEVOLUCAO_FORNECEDOR',
  'INVENTARIO',
  'AJUSTE',
  'QUEBRA',
  'PERDA',
  'TRANSFERENCIA_ENTRADA',
  'TRANSFERENCIA_SAIDA',
  'DESCONHECIDO'
);

-- ── 2. Feature flag per-farmácia ────────────────────────────────────
ALTER TABLE "Farmacia"
  ADD COLUMN "useMovimentosCanonical" BOOLEAN NOT NULL DEFAULT false;

-- ── 3. MovimentoArtigo (canónico) ───────────────────────────────────
CREATE TABLE "MovimentoArtigo" (
  "id"                          TEXT                  NOT NULL,
  "farmaciaId"                  TEXT                  NOT NULL,
  "externalMovId"               INTEGER               NOT NULL,
  "externalProductId"           TEXT                  NOT NULL,
  "produtoId"                   TEXT,

  "dataMovimento"               TIMESTAMP(3)          NOT NULL,
  "tipo"                        "TipoMovimentoArtigo" NOT NULL,

  "quantidade"                  INTEGER               NOT NULL,
  "quantidadeBonus"             INTEGER               NOT NULL DEFAULT 0,
  "existenciaApos"              INTEGER               NOT NULL,
  "custoUnitario"               DECIMAL(12,4)         NOT NULL,
  "pmcAnterior"                 DECIMAL(12,4)         NOT NULL,
  "pmcNovo"                     DECIMAL(12,4)         NOT NULL,
  "armazemId"                   INTEGER               NOT NULL,

  "externalDetalheId"           INTEGER,
  "externalSuspDetalheId"       INTEGER,
  "externalCreditoDetalheId"    INTEGER,
  "externalRecpDetalheId"       INTEGER,
  "externalDevolucaoDetalheId"  INTEGER,
  "externalMovStocksDetId"      INTEGER,

  "movStocksCabId"              INTEGER,
  "movStocksCabTipoDocId"       INTEGER,
  "movStocksCabMotivoId"        INTEGER,
  "movStocksCabMotivoTexto"     TEXT,
  "movStocksCabSituacao"        TEXT,
  "movStocksCabUserId"          INTEGER,
  "movStocksCabPosto"           INTEGER,
  "movStocksCabNDocExterno"     TEXT,

  "externalSaleId"              INTEGER,
  "tipoDocumentoId"             INTEGER,

  "ingestRunId"                 TEXT,
  "ingestedAt"                  TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                   TIMESTAMP(3)          NOT NULL,

  CONSTRAINT "MovimentoArtigo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MovimentoArtigo_farmaciaId_externalMovId_key"
  ON "MovimentoArtigo"("farmaciaId", "externalMovId");
CREATE INDEX "MovimentoArtigo_farmaciaId_externalProductId_dataMovimento_idx"
  ON "MovimentoArtigo"("farmaciaId", "externalProductId", "dataMovimento");
CREATE INDEX "MovimentoArtigo_farmaciaId_dataMovimento_tipo_idx"
  ON "MovimentoArtigo"("farmaciaId", "dataMovimento", "tipo");
CREATE INDEX "MovimentoArtigo_farmaciaId_tipo_dataMovimento_idx"
  ON "MovimentoArtigo"("farmaciaId", "tipo", "dataMovimento");
CREATE INDEX "MovimentoArtigo_produtoId_dataMovimento_idx"
  ON "MovimentoArtigo"("produtoId", "dataMovimento");
CREATE INDEX "MovimentoArtigo_farmaciaId_movStocksCabId_idx"
  ON "MovimentoArtigo"("farmaciaId", "movStocksCabId");
CREATE INDEX "MovimentoArtigo_ingestRunId_idx"
  ON "MovimentoArtigo"("ingestRunId");

ALTER TABLE "MovimentoArtigo"
  ADD CONSTRAINT "MovimentoArtigo_farmaciaId_fkey"
  FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MovimentoArtigo"
  ADD CONSTRAINT "MovimentoArtigo_produtoId_fkey"
  FOREIGN KEY ("produtoId") REFERENCES "Produto"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. IngestStocksMovRaw (staging cru, replay) ────────────────────
CREATE TABLE "IngestStocksMovRaw" (
  "id"            BIGSERIAL    NOT NULL,
  "farmaciaId"    TEXT         NOT NULL,
  "externalMovId" INTEGER      NOT NULL,
  "payload"       JSONB        NOT NULL,
  "ingestRunId"   TEXT         NOT NULL,
  "ingestedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "IngestStocksMovRaw_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IngestStocksMovRaw_farmaciaId_externalMovId_ingestRunId_key"
  ON "IngestStocksMovRaw"("farmaciaId", "externalMovId", "ingestRunId");
CREATE INDEX "IngestStocksMovRaw_farmaciaId_ingestRunId_idx"
  ON "IngestStocksMovRaw"("farmaciaId", "ingestRunId");
CREATE INDEX "IngestStocksMovRaw_ingestedAt_idx"
  ON "IngestStocksMovRaw"("ingestedAt");

ALTER TABLE "IngestStocksMovRaw"
  ADD CONSTRAINT "IngestStocksMovRaw_farmaciaId_fkey"
  FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
