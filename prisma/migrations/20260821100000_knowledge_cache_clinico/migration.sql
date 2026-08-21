-- ke-2.0: campos clínicos na cache de enriquecimento.
--
-- Aditiva e reversível: cinco colunas nullable, sem backfill, sem
-- alteração de linhas existentes. As linhas de ke-1.1 continuam válidas
-- e ficam com NULL — o que é correcto, porque essa versão não perguntou
-- nada de clínico. A chave da cache inclui a versão, portanto ke-2.0
-- escreve linhas novas em vez de reescrever as antigas.
ALTER TABLE "KnowledgeEnrichmentCache"
  ADD COLUMN IF NOT EXISTS "dci"               TEXT,
  ADD COLUMN IF NOT EXISTS "codigoATC"         TEXT,
  ADD COLUMN IF NOT EXISTS "dosagem"           TEXT,
  ADD COLUMN IF NOT EXISTS "embalagem"         TEXT,
  ADD COLUMN IF NOT EXISTS "confidenceClinica" DOUBLE PRECISION;
