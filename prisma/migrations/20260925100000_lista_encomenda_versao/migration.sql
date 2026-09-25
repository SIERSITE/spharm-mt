-- ListaEncomenda.versao — bloqueio optimista (optimistic locking) para o
-- autosave de rascunhos de encomenda.
--
-- Puramente aditivo: uma coluna nova com DEFAULT 0, nenhuma tabela nova,
-- nenhuma coluna existente tocada, nenhum dado migrado. Todas as
-- ListaEncomenda existentes ficam com versao=0 (equivalente a "nunca
-- gravada pelo autosave ainda") — o primeiro autosave de cada uma
-- incrementa a partir daí, sem precisar de nenhum backfill.
--
-- Reversível: DROP COLUMN "versao" desfaz por completo, sem perda de
-- nenhum dado que já existisse antes desta migration.

-- AlterTable
ALTER TABLE "ListaEncomenda" ADD COLUMN "versao" INTEGER NOT NULL DEFAULT 0;
