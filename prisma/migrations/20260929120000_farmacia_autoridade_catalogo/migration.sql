-- Farmácia autoritativa para o catálogo partilhado do tenant (ver
-- comentário em prisma/schema.prisma, model Farmacia).
--
-- Puramente aditiva: 1 coluna boolean com DEFAULT false. Todas as linhas
-- existentes ficam com `false` — nenhuma farmácia de nenhum tenant fica
-- marcada como autoritativa por esta migração; isso é uma decisão
-- explícita, feita depois, por tenant (ver
-- scripts/admin/set-farmacia-autoridade-catalogo.ts), nunca automática.
ALTER TABLE "Farmacia"
  ADD COLUMN "autoridadeCatalogo" BOOLEAN NOT NULL DEFAULT false;
