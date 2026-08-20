-- Dimensão `naturezaVenda`: NORMAL | CREDITO | TRANSFERENCIA
--
-- ── PORQUE EXISTE ────────────────────────────────────────────────────
--
-- O relatório oficial do SPharm tem dois interruptores — incluir vendas
-- a crédito, incluir guias de transferência — e o mapa de vendas do
-- SPharm.MT tem de os ter também. Na Silveirense, 2026, a diferença
-- entre os dois modos é grande e real:
--
--     mes   credito=ON transf=OFF   credito=ON transf=ON   delta
--     Jan          13 270                 16 498           3 228
--     Fev          11 547                 13 715           2 168
--     Mar          13 397                 15 157           1 760
--     Abr          12 652                 14 918           2 266
--     Mai          13 204                 16 057           2 853
--     Jun          12 380                 15 169           2 789
--     Jul          14 120                 18 737           4 617
--
-- Um total já somado não se desliga. Por isso a natureza entra na CHAVE
-- de `VendaMensal`: alternar os interruptores passa a ser um filtro na
-- query, não um reprocessamento do histórico.
--
-- ── PORQUE É QUE O DEFAULT NÃO É UMA SUPOSIÇÃO ───────────────────────
--
-- Tudo o que está gravado hoje veio de `ATENDIMENTO_DETALHE` ou de
-- `ATENDIMENTO_SUSP_DETALHE`, e as duas são vendas normais. Os readers
-- de crédito e de transferência ainda não existem, portanto nenhuma
-- linha existente pode ter outra natureza. `NORMAL` preserva o histórico
-- inteiro sem reprocessar nada.

-- ── staging ──────────────────────────────────────────────────────────
ALTER TABLE "IngestVendaLinhaRaw"
  ADD COLUMN IF NOT EXISTS "naturezaVenda" TEXT NOT NULL DEFAULT 'NORMAL';

-- ── agregação ────────────────────────────────────────────────────────
ALTER TABLE "VendaMensal"
  ADD COLUMN IF NOT EXISTS "naturezaVenda" TEXT NOT NULL DEFAULT 'NORMAL';

-- A chave passa a incluir a natureza. A antiga é largada só DEPOIS de a
-- nova existir: entre os dois comandos a tabela nunca fica sem protecção
-- contra duplicados.
CREATE UNIQUE INDEX IF NOT EXISTS "VendaMensal_farmaciaId_produtoId_ano_mes_naturezaVenda_key"
  ON "VendaMensal" ("farmaciaId", "produtoId", "ano", "mes", "naturezaVenda");

ALTER TABLE "VendaMensal"
  DROP CONSTRAINT IF EXISTS "VendaMensal_farmaciaId_produtoId_ano_mes_key";

DROP INDEX IF EXISTS "VendaMensal_farmaciaId_produtoId_ano_mes_key";

CREATE INDEX IF NOT EXISTS "VendaMensal_farmaciaId_ano_mes_naturezaVenda_idx"
  ON "VendaMensal" ("farmaciaId", "ano", "mes", "naturezaVenda");
