-- Origem física da linha de venda entra na identidade.
--
-- O ERP Softreis tem mais do que uma tabela de linhas de venda. A venda
-- de balcão (série G) está em [Atendimento Detalhe]; a venda suspensa
-- (série VSG) — que contabilística e fiscalmente é uma venda como outra
-- qualquer — está em [Atendimento Susp Detalhe], com a SUA sequência de
-- IDs. A chave anterior, (farmaciaId, externalSaleLineId), assumia uma
-- só tabela: ingerir a segunda fonte sobrescreveria linhas da primeira
-- assim que os dois contadores se cruzassem.
--
-- A auditoria de produção de 2026-08-18 não encontrou colisões HOJE.
-- Isso não é garantia sobre amanhã — são sequências independentes de
-- tabelas independentes. Discriminar pela origem custa uma coluna e
-- remove a classe inteira do problema.
--
-- Forward-only e não destrutiva:
--   . a coluna entra com DEFAULT, portanto as linhas existentes ficam
--     todas marcadas como o que de facto são: [Atendimento Detalhe]
--   . o índice único novo é criado ANTES de o antigo cair, para não
--     haver um instante sem protecção de unicidade
--   . nenhum dado é apagado ou reescrito

ALTER TABLE "IngestVendaLinhaRaw"
  ADD COLUMN IF NOT EXISTS "sourceNamespace" TEXT NOT NULL DEFAULT 'ATENDIMENTO_DETALHE',
  ADD COLUMN IF NOT EXISTS "serie" TEXT,
  ADD COLUMN IF NOT EXISTS "documento" TEXT;

-- Índice único novo primeiro. Se houver duplicados inesperados, esta
-- instrução falha e a migração aborta com os dados intactos — que é o
-- comportamento correcto.
CREATE UNIQUE INDEX IF NOT EXISTS "IngestVendaLinhaRaw_farmaciaId_sourceNamespace_externalSaleLineId_key"
  ON "IngestVendaLinhaRaw" ("farmaciaId", "sourceNamespace", "externalSaleLineId");

DROP INDEX IF EXISTS "IngestVendaLinhaRaw_farmaciaId_externalSaleLineId_key";

CREATE INDEX IF NOT EXISTS "IngestVendaLinhaRaw_sourceNamespace_idx"
  ON "IngestVendaLinhaRaw" ("sourceNamespace");
