-- Ficha de produto criada à mão, e a proveniência que a protege.
--
-- ─── Porquê ──────────────────────────────────────────────────────────
--
-- Um produto pode agora nascer no catálogo do SPharm.MT antes de existir
-- em qualquer farmácia. Sem estas colunas, a primeira sincronização do
-- ERP que trouxesse o mesmo CNP sobrepunha a designação escrita à mão:
-- `bulkUpsertProdutosByCnp` fazia `"designacao" = EXCLUDED."designacao"`
-- sem condição nenhuma.
--
-- ─── Porque é um array e não uma tabela ──────────────────────────────
--
-- A superfície exposta são TRÊS campos: designacao, flagGenerico e
-- flagMnsrmNCompart. Tudo o resto do catálogo — dci, codigoATC, dosagem,
-- fabricante, classificação — o ERP nunca tocou e continua a não tocar.
--
-- Para três campos, uma tabela de proveniência seria um join por linha
-- num caminho que processa milhares de produtos por lote. O array
-- resolve-se dentro do próprio `ON CONFLICT`, com um CASE por campo.
--
-- ─── Porque é seguro ─────────────────────────────────────────────────
--
-- As quatro colunas nascem com default ou nullable. `camposManuais`
-- começa vazio em todas as 40 651 fichas existentes, e é a verdade:
-- nenhuma foi escrita à mão — medido, `origemDados` é FARMACIA em 100 %
-- delas e `validadoManualmente` é false em 100 %.
--
-- Nada é apagado, nada é reescrito, nenhum comportamento muda até o
-- código desta revisão escrever nas colunas.
ALTER TABLE "Produto"
  ADD COLUMN "camposManuais"      TEXT[]       NOT NULL DEFAULT '{}',
  ADD COLUMN "criadoPorId"        TEXT,
  ADD COLUMN "contextoCriacao"    TEXT,
  ADD COLUMN "primeiraFarmaciaEm" TIMESTAMP(3);
