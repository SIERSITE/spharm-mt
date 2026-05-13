-- AlterTable: Produto — novo external ID + flag MnsrmNCompart
ALTER TABLE "Produto" ADD COLUMN "externalProductId" INTEGER;
ALTER TABLE "Produto" ADD COLUMN "flagMnsrmNCompart" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Produto_externalProductId_key" ON "Produto"("externalProductId");

-- AlterTable: ProdutoFarmacia — denormalised externalProductId, stock encomenda/reserva, fornecedor externo
ALTER TABLE "ProdutoFarmacia" ADD COLUMN "externalProductId" INTEGER;
ALTER TABLE "ProdutoFarmacia" ADD COLUMN "stockEncomenda" DECIMAL(14,3);
ALTER TABLE "ProdutoFarmacia" ADD COLUMN "stockReserva" DECIMAL(14,3);
ALTER TABLE "ProdutoFarmacia" ADD COLUMN "fornecedorExternalId" INTEGER;

-- CreateIndex
CREATE INDEX "ProdutoFarmacia_farmaciaId_externalProductId_idx"
  ON "ProdutoFarmacia"("farmaciaId", "externalProductId");

-- CreateTable: staging das linhas de venda raw
CREATE TABLE "IngestVendaLinhaRaw" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "externalSaleId" INTEGER NOT NULL,
    "externalSaleLineId" INTEGER NOT NULL,
    "sequencia" INTEGER,
    "dataVenda" TIMESTAMP(3),
    "tipoDocumento" INTEGER,
    "tipoDocumentoClass" TEXT NOT NULL,
    "externalProductId" INTEGER NOT NULL,
    "produtoId" TEXT,
    "quantidade" DECIMAL(14,3),
    "pvpUnitario" DECIMAL(12,4),
    "valorLinha" DECIMAL(14,2),
    "ivaValor" DECIMAL(14,2),
    "descontoValor" DECIMAL(14,2),
    "comparticipacao1" DECIMAL(14,2),
    "comparticipacao2" DECIMAL(14,2),
    "entidadeId" INTEGER,
    "rawJson" JSONB NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestVendaLinhaRaw_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: idempotência por farmacia + Detalhe ID
CREATE UNIQUE INDEX "IngestVendaLinhaRaw_farmaciaId_externalSaleLineId_key"
  ON "IngestVendaLinhaRaw"("farmaciaId", "externalSaleLineId");

CREATE INDEX "IngestVendaLinhaRaw_farmaciaId_dataVenda_idx"
  ON "IngestVendaLinhaRaw"("farmaciaId", "dataVenda");

CREATE INDEX "IngestVendaLinhaRaw_externalSaleId_idx"
  ON "IngestVendaLinhaRaw"("externalSaleId");

CREATE INDEX "IngestVendaLinhaRaw_tipoDocumento_idx"
  ON "IngestVendaLinhaRaw"("tipoDocumento");

CREATE INDEX "IngestVendaLinhaRaw_produtoId_idx"
  ON "IngestVendaLinhaRaw"("produtoId");

-- AddForeignKey
ALTER TABLE "IngestVendaLinhaRaw"
  ADD CONSTRAINT "IngestVendaLinhaRaw_farmaciaId_fkey"
  FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IngestVendaLinhaRaw"
  ADD CONSTRAINT "IngestVendaLinhaRaw_produtoId_fkey"
  FOREIGN KEY ("produtoId") REFERENCES "Produto"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
