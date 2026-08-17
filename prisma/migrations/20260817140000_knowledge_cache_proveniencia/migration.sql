-- Proveniência do knowledge-enrichment.
--
-- Distingue uma decisão do modelo sobre ESTE produto (origem='CLAUDE') de
-- um valor herdado de um irmão da mesma família estrita
-- (origem='PROPAGADO', com propagadoDeCnp a apontar ao representante).
--
-- Ambas nullable: as linhas que já existem foram todas decisões directas,
-- mas não se reescreve o passado a adivinhar — ficam NULL, que é o que
-- significa "escrito antes de isto existir".
ALTER TABLE "KnowledgeEnrichmentCache" ADD COLUMN "origem" TEXT;
ALTER TABLE "KnowledgeEnrichmentCache" ADD COLUMN "propagadoDeCnp" INTEGER;

CREATE INDEX "KnowledgeEnrichmentCache_origem_idx" ON "KnowledgeEnrichmentCache"("origem");
