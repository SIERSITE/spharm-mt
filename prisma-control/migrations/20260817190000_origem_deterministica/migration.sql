-- Proveniência real: DETERMINISTICA entra na ordem de autoridade, e a
-- fonte crua do tenant passa a ficar guardada.
--
-- Porquê: o bootstrap carimbava MODELO em tudo o que não reconhecia, e o
-- que não reconhecia era quase tudo — as regras determinísticas do
-- catálogo (fill-rules) não deixam proveniência própria, e a coluna que
-- parecia dá-la, `Produto.classificationSource`, descreve o `productType`
-- e não a classificação. 15.260 candidatos saíram todos como MODELO.
--
-- Aditivo: não altera nem apaga nada.

-- ADD VALUE dentro de transacção é permitido desde o PostgreSQL 12 desde
-- que o valor novo não seja USADO na mesma transacção. Esta migração só
-- o acrescenta; quem o escreve é a aplicação, depois.
ALTER TYPE "OrigemConhecimento" ADD VALUE IF NOT EXISTS 'DETERMINISTICA' AFTER 'REGULATORY';

ALTER TABLE "CatalogoGlobal" ADD COLUMN "fonteOriginal" TEXT;
