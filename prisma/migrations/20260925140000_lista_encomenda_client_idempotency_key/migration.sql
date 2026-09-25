-- ListaEncomenda.clientIdempotencyKey + clientRequestHash — chave gerada pelo cliente para
-- tornar idempotente a criação do rascunho eager em /encomendas/nova
-- (retries após timeout/perda de resposta não criam um 2.º rascunho).
--
-- Puramente aditivo: coluna nullable, sem backfill. UNIQUE em Postgres
-- permite múltiplos NULL, logo as listas existentes não colidem.
-- Reversível: DROP INDEX + DROP COLUMN (ambas).

-- AlterTable
ALTER TABLE "ListaEncomenda" ADD COLUMN "clientIdempotencyKey" TEXT,
ADD COLUMN "clientRequestHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ListaEncomenda_clientIdempotencyKey_key" ON "ListaEncomenda"("clientIdempotencyKey");
