-- Phase 1b.1 — Staging de compras + devoluções a fornecedor.
--
-- Cria duas tabelas WRITE-ONLY nesta fase (zero consumidores downstream):
--   · StagingCompraRawLine                   (1 row por linha de dbo.[Recepcao Detalhe])
--   · StagingDevolucaoFornecedorRawLine      (1 row por linha de dbo.[Devolucao Detalhe])
--
-- Mapping validado em rev24 inspection.md:
--   · Compras  : header dbo.Recepcao + linhas dbo.[Recepcao Detalhe]
--                · PK linha = [Detalhe  Recp ID] (dois espaços, quirk Softreis)
--                · Filtro: RecepcaoSituacaoID = 'N'
--                · Valor_EUR é UNITÁRIO (validado pelas amostras 4.1)
--   · Devolucoes: header dbo.Devolucao + linhas dbo.[Devolucao Detalhe]
--                · Sempre AO fornecedor (FK declarada)
--                · Filtro: DevolucaoSituacaoID <> 'A'
--                · Valor é TOTAL DA LINHA (validado pelas amostras 4.2)
--
-- Não-destrutivo:
--   · Apenas CREATE TABLE/INDEX/CONSTRAINT
--   · Nenhuma alteração a tabelas existentes
--   · Zero data migrations, zero backfill, zero triggers, zero views
--
-- onDelete:
--   · Staging → Farmacia: CASCADE (linhas morrem com a farmácia)
--
-- Idempotência das ingestões: `UNIQUE(farmaciaId, externalLineId)`.

CREATE TABLE "StagingCompraRawLine" (
    "id"                       BIGSERIAL    NOT NULL,
    "farmaciaId"               TEXT         NOT NULL,
    "externalReceptionId"      INTEGER      NOT NULL,
    "externalLineId"           INTEGER      NOT NULL,
    "sequencia"                INTEGER,
    "externalNRecepcao"        INTEGER      NOT NULL,
    "externalFornecedorId"     INTEGER      NOT NULL,
    "externalTipoDocumentoId"  INTEGER,
    "externalFornecedorNDoc"   TEXT,
    "dataRecepcao"             TIMESTAMP(3) NOT NULL,
    "fornecedorData"           TIMESTAMP(3),
    "armazemId"                INTEGER      NOT NULL,
    "recepcaoSituacaoId"       TEXT         NOT NULL,
    "headerTotalBrutoEur"      DECIMAL(12,2) NOT NULL,
    "headerTotalIvaEur"        DECIMAL(12,2) NOT NULL,
    "headerTotalIncidenciaEur" DECIMAL(12,2) NOT NULL,
    "externalCodigoId"         INTEGER      NOT NULL,
    "quantidade"               INTEGER      NOT NULL,
    "bonus"                    INTEGER      NOT NULL,
    "iva"                      DECIMAL(4,2)  NOT NULL,
    "desconto"                 DECIMAL(7,2),
    "precoVendaPublicoEur"     DECIMAL(8,2)  NOT NULL,
    "valorEurUnit"             DECIMAL(10,2) NOT NULL,
    "validade"                 TIMESTAMP(3),
    "ingestedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestBatchId"            TEXT         NOT NULL,

    CONSTRAINT "StagingCompraRawLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StagingCompraRawLine_farmaciaId_externalLineId_key"
  ON "StagingCompraRawLine"("farmaciaId", "externalLineId");

CREATE INDEX "StagingCompraRawLine_farmaciaId_dataRecepcao_idx"
  ON "StagingCompraRawLine"("farmaciaId", "dataRecepcao");

CREATE INDEX "StagingCompraRawLine_farmaciaId_externalCodigoId_dataRecepc_idx"
  ON "StagingCompraRawLine"("farmaciaId", "externalCodigoId", "dataRecepcao");

CREATE INDEX "StagingCompraRawLine_farmaciaId_externalFornecedorId_dataRe_idx"
  ON "StagingCompraRawLine"("farmaciaId", "externalFornecedorId", "dataRecepcao");

CREATE INDEX "StagingCompraRawLine_farmaciaId_ingestBatchId_idx"
  ON "StagingCompraRawLine"("farmaciaId", "ingestBatchId");

ALTER TABLE "StagingCompraRawLine"
  ADD CONSTRAINT "StagingCompraRawLine_farmaciaId_fkey"
  FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "StagingDevolucaoFornecedorRawLine" (
    "id"                       BIGSERIAL    NOT NULL,
    "farmaciaId"               TEXT         NOT NULL,
    "externalDevolucaoId"      INTEGER      NOT NULL,
    "externalLineId"           INTEGER      NOT NULL,
    "sequencia"                INTEGER,
    "externalNDevolucao"       INTEGER      NOT NULL,
    "externalFornecedorId"     INTEGER      NOT NULL,
    "dataDevolucao"            TIMESTAMP(3) NOT NULL,
    "devolucaoSituacaoId"      TEXT         NOT NULL,
    "armazemId"                INTEGER      NOT NULL,
    "observacoes"              TEXT,
    "serieFacturacao"          TEXT,
    "atcud"                    TEXT,
    "ncertAt"                  INTEGER,
    "systemEntryDate"          TIMESTAMP(3),
    "headerTotalDocumento"     DECIMAL(9,2)  NOT NULL,
    "headerTotalIvaEur"        DECIMAL(12,2) NOT NULL,
    "headerTotalIncidenciaEur" DECIMAL(12,2) NOT NULL,
    "externalCodigoId"         INTEGER      NOT NULL,
    "quantidadeEnviada"        INTEGER      NOT NULL,
    "quantidadeRecebida"       INTEGER      NOT NULL,
    "bonus"                    INTEGER,
    "motivoId"                 INTEGER,
    "iva"                      DECIMAL(4,2)  NOT NULL,
    "precoVendaPublicoEur"     DECIMAL(8,2),
    "pvfEurUnit"               DECIMAL(8,2),
    "valorEurTotal"            DECIMAL(9,2),
    "validade"                 TIMESTAMP(3),
    "lote"                     TEXT,
    "recepcaoOrigemText"       TEXT,
    "recepcaoOrigemData"       TIMESTAMP(3),
    "ingestedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestBatchId"            TEXT         NOT NULL,

    CONSTRAINT "StagingDevolucaoFornecedorRawLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StagingDevolucaoFornecedorRawLine_farmaciaId_externalLineId_key"
  ON "StagingDevolucaoFornecedorRawLine"("farmaciaId", "externalLineId");

CREATE INDEX "StagingDevolucaoFornecedorRawLine_farmaciaId_dataDevolucao_idx"
  ON "StagingDevolucaoFornecedorRawLine"("farmaciaId", "dataDevolucao");

CREATE INDEX "StagingDevolucaoFornecedorRawLine_farmaciaId_externalCodigo_idx"
  ON "StagingDevolucaoFornecedorRawLine"("farmaciaId", "externalCodigoId", "dataDevolucao");

CREATE INDEX "StagingDevolucaoFornecedorRawLine_farmaciaId_externalFornec_idx"
  ON "StagingDevolucaoFornecedorRawLine"("farmaciaId", "externalFornecedorId", "dataDevolucao");

CREATE INDEX "StagingDevolucaoFornecedorRawLine_farmaciaId_devolucaoSitua_idx"
  ON "StagingDevolucaoFornecedorRawLine"("farmaciaId", "devolucaoSituacaoId");

CREATE INDEX "StagingDevolucaoFornecedorRawLine_farmaciaId_ingestBatchId_idx"
  ON "StagingDevolucaoFornecedorRawLine"("farmaciaId", "ingestBatchId");

ALTER TABLE "StagingDevolucaoFornecedorRawLine"
  ADD CONSTRAINT "StagingDevolucaoFornecedorRawLine_farmaciaId_fkey"
  FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
