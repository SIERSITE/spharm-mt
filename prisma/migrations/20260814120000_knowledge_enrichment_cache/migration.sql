-- Cache do knowledge-enrichment (lib/catalog/knowledge-enrichment.ts).
-- Guarda TODOS os resultados, incluindo os DESCONHECIDO: é isso que
-- impede o job diário de voltar a perguntar por produtos que já se sabe
-- que o modelo não reconhece.
CREATE TABLE "KnowledgeEnrichmentCache" (
    "chave" TEXT NOT NULL,
    "cnp" INTEGER NOT NULL,
    "designacao" TEXT NOT NULL,
    "versao" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "productType" TEXT,
    "categoria" TEXT,
    "subcategoria" TEXT,
    "forma" TEXT,
    "utilizacoes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "rationale" TEXT,
    "persistido" BOOLEAN NOT NULL DEFAULT false,
    "motivo" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeEnrichmentCache_pkey" PRIMARY KEY ("chave")
);

CREATE INDEX "KnowledgeEnrichmentCache_cnp_idx" ON "KnowledgeEnrichmentCache"("cnp");
CREATE INDEX "KnowledgeEnrichmentCache_versao_evidenceType_idx" ON "KnowledgeEnrichmentCache"("versao", "evidenceType");
CREATE INDEX "KnowledgeEnrichmentCache_persistido_idx" ON "KnowledgeEnrichmentCache"("persistido");
