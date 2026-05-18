-- Phase 1c.2 — Drop unique global em Produto.externalProductId.
--
-- Bug observado:
--   daily-sync de produtos em demo-neon (2024-04-01) falhou Pipeline 1
--   com 7 P2002 "Unique constraint failed on fields: (externalProductId)"
--   para IDs: 11819, 17247, 21235 (e 4 outros). Os 3 IDs verificados
--   estavam JÁ atribuídos a Produtos com CNP X, mas o agent enviou
--   payloads com CNP Y (≠ X) e o mesmo externalProductId — o UPSERT por
--   cnp tenta criar novo Produto e o INSERT viola a unique.
--
-- Causa raiz:
--   externalProductId mapeia a `Stocks.CodigoID` no ERP local da farmácia
--   (Softreis). Esse ID é namespace LOCAL — pode ser reciclado quando o
--   operador apaga e re-cria um produto, ou variar entre farmácias do
--   mesmo tenant. Nunca foi uma chave canónica.
--   Identidade real do catálogo: `Produto.cnp @unique` (mantém-se).
--
-- Decisão:
--   Drop da unique global + criação de index não-unique para preservar
--   perf dos lookups que o agent faz por externalProductId.
--
-- Aditiva:
--   · 0 rows alteradas (DROP/CREATE de índice; dados intactos)
--   · 0 FKs apontam a esta unique (verificado por grep)
--   · Catálogo `Produto.cnp @unique` mantém-se
--   · Reversível: re-criar a unique requer dedupe prévio. Sem dedupe,
--     basta `DROP INDEX "Produto_externalProductId_idx";
--     CREATE UNIQUE INDEX "Produto_externalProductId_key" ON
--     "Produto"("externalProductId");` — só passa se demo-neon estiver
--     limpo de dupes.
--
-- Pré-requisito de aplicação:
--   Aplicar APENAS a demo-neon nesta sub-fase. Outros tenants
--   (grupo-silveira, piloto-demo) ficam intocados até autorização
--   explícita; quando aplicar deploy automático via migrate-all, a
--   migration é compatível (drop só remove constraint, não exige dedupe).

DROP INDEX IF EXISTS "Produto_externalProductId_key";

CREATE INDEX "Produto_externalProductId_idx" ON "Produto"("externalProductId");
