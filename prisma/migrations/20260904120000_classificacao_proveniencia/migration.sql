-- Proveniência da classificação N1/N2, e a resposta bruta do enrichment.
--
-- Três blocos independentes. Nenhum altera comportamento por si só: as
-- colunas nascem todas nullable ou com default, e nada as lê até o código
-- desta revisão as ler.
--
-- ─── 1 · Estado da classificação ────────────────────────────────────
--
-- Até aqui não havia campo nenhum a dizer de onde vinha o N1/N2. O
-- `classificationSource` que existe descreve o `productType` (ATC_CODE,
-- FLAG_MSRM, TEXT_PATTERN) — outro eixo, no mesmo sítio, e por isso
-- nenhum dos dois legível.
--
-- MANUAL não é um valor deste enum de propósito: `validadoManualmente` já
-- é essa verdade. A mesma verdade em dois campos é a garantia de que um
-- dia discordam.
CREATE TYPE "ClassificacaoEstado" AS ENUM ('AUSENTE', 'PROVISORIA', 'CANONICA');

ALTER TABLE "Produto"
  ADD COLUMN "classificacaoEstado"    "ClassificacaoEstado" NOT NULL DEFAULT 'AUSENTE',
  ADD COLUMN "classificacaoOrigem"    TEXT,
  ADD COLUMN "classificacaoConfianca" DOUBLE PRECISION,
  ADD COLUMN "classificacaoVersao"    TEXT;

-- ─── 2 · Backfill ───────────────────────────────────────────────────
--
-- Quem tem nível 1 fica CANONICA. É a leitura honesta do que existe: tudo
-- o que está classificado hoje passou por uma regra determinística, por
-- uma fonte forte, ou por uma pessoa — nenhuma dedução de modelo foi
-- escrita, porque era precisamente isso que o gate recusava.
--
-- A origem NÃO é adivinhada. Não há na base nada que distinga, em
-- retrospectiva, uma classificação vinda de `fill-rules` de uma vinda do
-- ERP ou do catálogo global; inventar uma origem plausível seria fabricar
-- proveniência, que é o oposto do que estas colunas existem para fazer.
-- Fica um valor neutro e explícito.
--
-- `classificacaoConfianca` e `classificacaoVersao` ficam NULL: não se
-- conhecem, e NULL é como se escreve "não se conhece".
UPDATE "Produto"
   SET "classificacaoEstado" = 'CANONICA',
       "classificacaoOrigem" = 'PRE_PROVENIENCIA'
 WHERE "classificacaoNivel1Id" IS NOT NULL;

-- O resto fica AUSENTE, que é o default — nenhum UPDATE necessário.
--
-- PROVISORIA fica a ZERO. É a garantia que torna o rollback do bloco
-- inteiro trivial no dia seguinte a esta migração: qualquer linha
-- PROVISORIA que exista foi escrita pelo reprocessamento, e por mais
-- nada.

-- ─── 3 · A resposta bruta do modelo ─────────────────────────────────
--
-- `categoria`/`subcategoria` na cache só sobrevivem em par válido
-- (`isValidNivel2`). Um par que a taxonomia não tem era anulado em
-- silêncio, e a cache guardava NULL — indistinguível de "o modelo não
-- respondeu". Perdia-se o sinal que separa "o modelo falhou" de "a nossa
-- taxonomia não tem onde pôr isto". E como a resposta já estava paga,
-- perdia-se pago.
--
-- As colunas de reavaliação existem para o reprocessamento ser idempotente
-- e retomável: sem elas, uma corrida interrompida a meio de 2 774 linhas
-- não sabe onde ficou.
ALTER TABLE "KnowledgeEnrichmentCache"
  ADD COLUMN "categoriaBruta"    TEXT,
  ADD COLUMN "subcategoriaBruta" TEXT,
  ADD COLUMN "reavaliadoEm"      TIMESTAMP(3),
  ADD COLUMN "reavaliadoVersao"  TEXT;

-- As linhas que já existem ficam com brutos NULL. Não se reescreve o
-- passado a adivinhar: NULL aqui significa "escrito antes de isto
-- existir", e é distinguível de "" ou de um valor inventado.
--
-- Excepção legítima e barata: onde o par SOBREVIVEU, o bruto é conhecido
-- — é o próprio par. Copiá-lo não é adivinhar, é registar o que se sabe.
UPDATE "KnowledgeEnrichmentCache"
   SET "categoriaBruta"    = categoria,
       "subcategoriaBruta" = subcategoria
 WHERE categoria IS NOT NULL;

CREATE INDEX "Produto_classificacaoEstado_idx"
    ON "Produto"("classificacaoEstado");
CREATE INDEX "KnowledgeEnrichmentCache_reavaliadoVersao_idx"
    ON "KnowledgeEnrichmentCache"("reavaliadoVersao");
