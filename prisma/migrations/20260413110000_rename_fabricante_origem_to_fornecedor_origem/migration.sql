-- Renomeia ProdutoFarmacia.fabricanteOrigem → fornecedorOrigem.
-- A coluna nunca foi fabricante real: vem da coluna "Fornecedor Habitual"
-- do Excel (distribuidor/grossista diário da farmácia — Empifarma, OCP, etc.),
-- não do titular de AIM. Renomeia para alinhar a semântica com a realidade.
ALTER TABLE "ProdutoFarmacia" RENAME COLUMN "fabricanteOrigem" TO "fornecedorOrigem";
