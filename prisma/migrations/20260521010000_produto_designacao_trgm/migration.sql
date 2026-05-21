-- Pesquisa /stock: a pesquisa de texto passou a ser empurrada para SQL
-- (ILIKE em Produto.designacao + cnp/dci/ATC + Farmacia.nome). Índice
-- trigram acelera o ILIKE '%termo%' em designacao (o campo dominante da
-- pesquisa). pg_trgm é suportado no Neon.
--
-- Additive e idempotente (IF NOT EXISTS). CREATE INDEX não-concorrente
-- corre dentro da transação da migration; em ~28k linhas de Produto é
-- rápido. O push-down já beneficia mesmo sem o índice (filtragem
-- server-side em vez de materializar o catálogo no Node); o índice ajuda
-- quando a pesquisa é dominada por designacao.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Produto_designacao_trgm_idx"
  ON "Produto" USING gin (designacao gin_trgm_ops);
