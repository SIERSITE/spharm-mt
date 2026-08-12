-- Recolhe os movimentos internos já ingeridos para a operação única
-- ACERTO_STOCK.
--
-- Até rev59 o classificador inferia seis tipos a partir do texto do
-- motivo (escrito pelo operador da farmácia) e de
-- `tblMovStocksCab.[Tipo Documento ID]` (cujos IDs são LOCAIS a cada
-- tenant). Essa inferência ficou gravada numa coluna que parece um
-- facto. Esta migração desfaz isso nas linhas que já existem, para que
-- o histórico e as ingestões novas digam a mesma coisa.
--
-- ── O que NÃO se perde ────────────────────────────────────────────
--
-- Nada de origem. `movStocksCabMotivoId` e `movStocksCabMotivoTexto`
-- ficam intactos em cada linha, e são eles a fonte: quem quiser saber
-- porque é que o acerto aconteceu lê o motivo do ERP em vez de ler uma
-- categoria derivada dele. `IngestStocksMovRaw` guarda ainda o payload
-- bruto de cada POST, portanto a classificação antiga é reconstituível
-- a partir dos dados, não só a partir de um backup.
--
-- ── Porque é que o filtro tem a cláusula da FK ────────────────────
--
-- `WHERE tipo IN (…)` sozinho seria quase certamente equivalente, mas
-- "quase" não chega para um UPDATE sobre centenas de milhares de
-- linhas. `externalMovStocksDetId IS NOT NULL` exige que a linha tenha
-- de facto origem interna, e não apenas um tipo que costumava vir de
-- origem interna. Se alguma linha tiver um destes tipos sem a FK — de
-- um pipeline legacy, de um import antigo — fica como está, e fica
-- visível na contagem.

UPDATE "MovimentoArtigo"
SET "tipo" = 'ACERTO_STOCK'
WHERE "tipo" IN (
    'INVENTARIO',
    'AJUSTE',
    'QUEBRA',
    'PERDA',
    'TRANSFERENCIA_ENTRADA',
    'TRANSFERENCIA_SAIDA'
  )
  AND "externalMovStocksDetId" IS NOT NULL;
