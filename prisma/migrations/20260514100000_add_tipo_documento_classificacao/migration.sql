-- CreateTable: lookup server-side de classificação de TipoDocumento
CREATE TABLE "TipoDocumentoClassificacao" (
    "tipoDocumento" INTEGER NOT NULL,
    "classe" TEXT NOT NULL,
    "descricao" TEXT,
    "notas" TEXT,
    "classifiedBy" TEXT,
    "classifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TipoDocumentoClassificacao_pkey" PRIMARY KEY ("tipoDocumento")
);

-- CreateIndex
CREATE INDEX "TipoDocumentoClassificacao_classe_idx"
    ON "TipoDocumentoClassificacao"("classe");

-- Seed: defaults seguros conforme decisão arquitectural 2026-05-14
-- ON CONFLICT DO NOTHING garante idempotência ao re-correr migrations
-- e protege contra over-write de classificações já editadas pelo operador.
INSERT INTO "TipoDocumentoClassificacao"
  ("tipoDocumento", "classe", "descricao", "classifiedBy", "classifiedAt", "updatedAt")
VALUES
  (77,  'VENDA',              'Venda comercial (default Softreis)',          'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (104, 'DEVOLUCAO_ANULACAO', 'Devolução / anulação (default Softreis)',     'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2,   'UNKNOWN',            'Caracterização pendente (default cautelar)',  'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (7,   'UNKNOWN',            'Caracterização pendente — detectado 2024-01-01 sample', 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("tipoDocumento") DO NOTHING;
