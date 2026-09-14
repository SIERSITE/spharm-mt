-- Proveniência de uma linha de encomenda.
--
-- ─── Porquê ──────────────────────────────────────────────────────────
--
-- "Gerar nova proposta" substituía as linhas todas. O que o utilizador
-- tinha acrescentado à mão — o artigo que ele escolheu um a um, contra
-- a recomendação do cálculo — desaparecia. Sem esta coluna não há como
-- distinguir, no momento do recálculo, o que foi calculado do que foi
-- decidido.
--
-- ─── Porque é seguro ─────────────────────────────────────────────────
--
-- A coluna nasce com DEFAULT 'PROPOSTA', e é a verdade sobre todas as
-- linhas que já existem: até esta revisão, o cálculo automático era o
-- ÚNICO caminho para criar uma linha de encomenda. Nenhuma linha
-- histórica muda de significado — passam a dizer explicitamente o que
-- já eram implicitamente.
--
-- Nada é apagado, nada é reescrito, e nenhuma encomenda já exportada é
-- afectada: o payload congelado em OrderOutbox não inclui este campo.
--
-- ─── Os três valores ─────────────────────────────────────────────────
--
--   PROPOSTA  cálculo automático a partir de vendas
--   MANUAL    o utilizador escolheu o artigo e escreveu a quantidade
--   SUGESTAO  veio de uma sugestão aceite noutro ecrã (excessos,
--             transferências) por prefill
--
-- MANUAL e SUGESTAO sobrevivem a um recálculo; PROPOSTA não. A regra
-- vive em `lib/encomendas/origem-linha.ts` e é testada lá — não aqui,
-- porque uma regra de negócio escrita em SQL é uma regra que ninguém
-- relê.
CREATE TYPE "OrigemLinhaEncomenda" AS ENUM ('PROPOSTA', 'MANUAL', 'SUGESTAO');

ALTER TABLE "LinhaEncomenda"
  ADD COLUMN "origem" "OrigemLinhaEncomenda" NOT NULL DEFAULT 'PROPOSTA';
