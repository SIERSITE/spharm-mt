-- Acrescenta ACERTO_STOCK ao enum TipoMovimentoArtigo.
--
-- Esta migração faz UMA coisa e a seguinte faz a outra, e a separação
-- não é estética: em Postgres, um valor acrescentado por ALTER TYPE …
-- ADD VALUE não pode ser USADO até a transacção que o acrescentou ter
-- feito commit. O Prisma corre cada ficheiro de migração dentro de uma
-- transacção, portanto juntar o ADD VALUE e o UPDATE no mesmo ficheiro
-- falha com "unsafe use of new value of enum type" — e falha só quando
-- corre contra a base, não em revisão de código.
--
-- Aditiva e reversível: nada é removido, nada é reescrito. Os valores
-- INVENTARIO / AJUSTE / QUEBRA / PERDA / TRANSFERENCIA_* continuam a
-- existir no tipo e a ser válidos; deixam apenas de ser produzidos.

ALTER TYPE "TipoMovimentoArtigo" ADD VALUE IF NOT EXISTS 'ACERTO_STOCK';
