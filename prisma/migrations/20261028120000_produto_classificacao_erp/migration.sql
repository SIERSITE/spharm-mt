-- Classificação do produto vinda do ERP (Ético / NETT / Serviço / Genérico).
-- Puramente ADITIVA: 7 colunas novas em "Produto", todas anuláveis ou com
-- DEFAULT constante; nenhuma linha existente é reescrita nem perde dados.
--
-- Decisões:
--  · Flags INDEPENDENTES e tri-estado (true / false / NULL). NULL = "o ERP
--    nunca informou" e é o estado de TODAS as fichas existentes. Não se
--    assume exclusividade mútua entre Ético, NETT e Serviço (não está
--    provada); a combinação Serviço + (Ético | NETT) é só SINALIZADA em
--    "classificacaoErpConflito", nunca corrigida.
--  · "genericoErp" distingue "não genérico" (false) de "desconhecido"
--    (NULL) SEM alterar "flagGenerico" (boolean NOT NULL DEFAULT false,
--    semântica actual preservada).
--  · "classificacaoErpOrigem" guarda a proveniência ("spharm_erp:<campo>=
--    <tabela.coluna>;…"); "classificacaoErpEm" a última alteração efectiva.
--  · Protegíveis por "camposManuais" (chaves erpEtico, erpNett, erpServico,
--    genericoErp) — ver lib/ingest/classificacao-erp.ts.
--  · Rollback: ignoradas por qualquer versão anterior do código (colunas
--    anuláveis/com default); podem ficar na base sem efeito.

-- AlterTable
ALTER TABLE "Produto"
  ADD COLUMN "erpEtico" BOOLEAN,
  ADD COLUMN "erpNett" BOOLEAN,
  ADD COLUMN "erpServico" BOOLEAN,
  ADD COLUMN "genericoErp" BOOLEAN,
  ADD COLUMN "classificacaoErpConflito" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "classificacaoErpEm" TIMESTAMP(3),
  ADD COLUMN "classificacaoErpOrigem" TEXT;
