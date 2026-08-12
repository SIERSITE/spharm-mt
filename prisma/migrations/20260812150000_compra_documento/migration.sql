-- ─────────────────────────────────────────────────────────────────────
-- Qualidade dos documentos de compra.
--
-- Em 804 de 13 642 recepções da Silveirense a soma das linhas não bate
-- com o total do documento. O agent rev56 provou que as linhas em falta
-- não existem em tabela nenhuma do ERP: o Recepcao_IVAS_Forn conserva o
-- valor financeiro, mas não recupera produto nem quantidade.
--
-- A classificação vive no DOCUMENTO e não em Compra: essa é agregada por
-- (produto, dia, fornecedor) e pode juntar vários documentos, logo um
-- total documental numa linha de Compra seria rateio com outro nome.
-- Ratear atribuiria a produtos conhecidos o custo de produtos que
-- desapareceram — e esse número alimentaria o ultimoPrecoCompra.
--
-- Aditiva e idempotente. Nada é apagado, nada muda de significado:
-- Compra.valorTotal e Compra.precoUnitario continuam a ser "o que as
-- linhas explicam", exactamente como antes.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CompraDocumento" (
    "id"                      TEXT         NOT NULL,
    "farmaciaId"              TEXT         NOT NULL,
    "externalReceptionId"     INTEGER      NOT NULL,
    "externalTipoDocumentoId" INTEGER,
    "externalFornecedorId"    INTEGER      NOT NULL,
    "externalNRecepcao"       INTEGER,
    "dataRecepcao"            TIMESTAMP(3) NOT NULL,
    "totalDocumentoEur"       DECIMAL(14,2) NOT NULL,
    "valorExplicadoEur"       DECIMAL(14,2) NOT NULL,
    "deltaEur"                DECIMAL(14,2) NOT NULL,
    "nLinhas"                 INTEGER      NOT NULL,
    "qualidade"               TEXT         NOT NULL,
    "ingestBatchId"           TEXT,
    "calculadoEm"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompraDocumento_pkey" PRIMARY KEY ("id")
);

-- Identidade do documento no ERP. É por esta chave que a agregação
-- reescreve em vez de duplicar a cada corrida.
CREATE UNIQUE INDEX IF NOT EXISTS "CompraDocumento_farmaciaId_externalReceptionId_key"
  ON "CompraDocumento"("farmaciaId", "externalReceptionId");
CREATE INDEX IF NOT EXISTS "CompraDocumento_farmaciaId_qualidade_idx"
  ON "CompraDocumento"("farmaciaId", "qualidade");
CREATE INDEX IF NOT EXISTS "CompraDocumento_farmaciaId_dataRecepcao_idx"
  ON "CompraDocumento"("farmaciaId", "dataRecepcao");
CREATE INDEX IF NOT EXISTS "CompraDocumento_farmaciaId_tipo_idx"
  ON "CompraDocumento"("farmaciaId", "externalTipoDocumentoId");

DO $$
BEGIN
    ALTER TABLE "CompraDocumento"
      ADD CONSTRAINT "CompraDocumento_farmaciaId_fkey"
      FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Compra: um booleano derivado, e nada de valores documentais.
--
-- NULL de propósito no arranque: as linhas existentes foram agregadas
-- antes desta classificação e o seu estado é DESCONHECIDO. Marcá-las
-- como fiáveis seria afirmar o que não se verificou. Quem calcula custo
-- trata NULL como não fiável até a agregação voltar a correr.
ALTER TABLE "Compra"
  ADD COLUMN IF NOT EXISTS "custoFiavel" BOOLEAN;

CREATE INDEX IF NOT EXISTS "Compra_farmaciaId_custoFiavel_idx"
  ON "Compra"("farmaciaId", "custoFiavel");
