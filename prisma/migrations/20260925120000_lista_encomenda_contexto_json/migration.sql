-- ListaEncomenda.contextoJson — contexto funcional da proposta (modo,
-- período, cobertura, filtros) que gerou o rascunho, para reconstruir a
-- análise integralmente ao reabrir (recarregar a página, ou continuar
-- noutro computador).
--
-- Puramente aditivo: coluna nova, nullable, sem DEFAULT que precise de
-- backfill. Todas as ListaEncomenda existentes ficam com contextoJson=NULL
-- (equivalente a "sem contexto de proposta registado" — nunca leu nem
-- gravou nada até esta coluna existir).
--
-- Reversível: DROP COLUMN "contextoJson" desfaz por completo, sem perda
-- de nenhum dado que já existisse antes desta migration.

-- AlterTable
ALTER TABLE "ListaEncomenda" ADD COLUMN "contextoJson" TEXT;
