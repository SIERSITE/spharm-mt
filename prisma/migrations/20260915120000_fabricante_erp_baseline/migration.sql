-- Baseline de fabricante ERP por farmácia (ver comentário em
-- prisma/schema.prisma, model ProdutoFarmacia).
--
-- Puramente aditivo: 5 colunas nullable, sem default, sem backfill.
-- Linhas existentes ficam com todos os valores NULL — o código trata
-- fabricanteErpBaseline IS NULL como "primeiro ciclo" para essa
-- farmácia+CNP, o que é seguro (nunca substitui um fabricante já
-- existente no primeiro ciclo, só o preenche se estiver vazio).
ALTER TABLE "ProdutoFarmacia"
  ADD COLUMN "fabricanteErpBaseline" TEXT,
  ADD COLUMN "fabricanteErpAtual" TEXT,
  ADD COLUMN "fabricanteErpFirstSeenAt" TIMESTAMP(3),
  ADD COLUMN "fabricanteErpLastSeenAt" TIMESTAMP(3),
  ADD COLUMN "fabricanteErpChangedAt" TIMESTAMP(3);
