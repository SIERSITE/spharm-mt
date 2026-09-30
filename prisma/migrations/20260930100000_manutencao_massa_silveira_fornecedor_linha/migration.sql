-- Manutenção em massa do catálogo (exclusiva do tenant silveira — ver
-- lib/tenant-context.ts, TENANT_CATALOGO_MASSA) e fornecedor por linha
-- nas encomendas (todos os tenants). Puramente aditiva.
--
-- NOTA: um `prisma migrate diff` contra o estado real desta base
-- descartável também devolveu DROP/RENAME INDEX em três índices
-- (Compra_farmaciaId_custoFiavel_idx, KnowledgeEnrichmentCache_origem_idx,
-- Produto_designacao_trgm_idx, e três RenameIndex) — drift pré-existente
-- de migrations/versões anteriores do Prisma, nada a ver com este
-- trabalho. Deliberadamente EXCLUÍDO desta migration: não se toca em
-- índices que não fazem parte desta funcionalidade.

-- CreateEnum
CREATE TYPE "TipoManutencaoMassa" AS ENUM ('FABRICANTE', 'FORNECEDOR');

-- AlterTable
ALTER TABLE "LinhaEncomenda" ADD COLUMN "designacaoSnapshot" TEXT;

-- AlterTable
-- loteDivididoEm marca o rascunho original de uma finalização com
-- separação por fornecedor (ver lib/encomendas/finalizar-multi-fornecedor.ts).
-- Deliberadamente um campo aditivo NULLABLE, NÃO um novo valor do enum
-- EstadoListaEncomenda — uma tentativa inicial usava um valor de enum
-- ("PREPARADA"), revertida depois de confirmar empiricamente que um
-- Prisma Client mais antigo (gerado antes desse valor existir) lança
-- "Value 'PREPARADA' not found in enum" em QUALQUER query sobre
-- ListaEncomenda que toque numa row nesse estado, mesmo findMany() sem
-- filtro nenhum. Um campo novo nullable é invisível para esse cliente
-- antigo (nunca seleccionado, nunca lançado) e não tem esse risco.
ALTER TABLE "ListaEncomenda" ADD COLUMN "loteOrigemId" TEXT;
ALTER TABLE "ListaEncomenda" ADD COLUMN "loteDivididoEm" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CatalogoManutencaoOperacao" (
    "id" TEXT NOT NULL,
    "tipo" "TipoManutencaoMassa" NOT NULL,
    "utilizadorId" TEXT NOT NULL,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "farmaciaId" TEXT,
    "filtrosJson" TEXT NOT NULL,
    "valorNovoId" TEXT NOT NULL,
    "quantidadeSolicitada" INTEGER NOT NULL,
    "quantidadeAlterada" INTEGER NOT NULL,
    "quantidadeIgnorada" INTEGER NOT NULL,
    "motivo" TEXT,
    "origem" TEXT NOT NULL DEFAULT 'MANUTENCAO_MASSA',
    "operacaoOrigemId" TEXT,

    CONSTRAINT "CatalogoManutencaoOperacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogoManutencaoOperacaoItem" (
    "id" TEXT NOT NULL,
    "operacaoId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "valorAnteriorId" TEXT,
    "valorNovoId" TEXT NOT NULL,

    CONSTRAINT "CatalogoManutencaoOperacaoItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogoManutencaoOperacao_tipo_idx" ON "CatalogoManutencaoOperacao"("tipo");

-- CreateIndex
CREATE INDEX "CatalogoManutencaoOperacao_utilizadorId_idx" ON "CatalogoManutencaoOperacao"("utilizadorId");

-- CreateIndex
CREATE INDEX "CatalogoManutencaoOperacao_operacaoOrigemId_idx" ON "CatalogoManutencaoOperacao"("operacaoOrigemId");

-- CreateIndex
CREATE INDEX "CatalogoManutencaoOperacao_dataCriacao_idx" ON "CatalogoManutencaoOperacao"("dataCriacao");

-- CreateIndex
CREATE INDEX "CatalogoManutencaoOperacaoItem_operacaoId_idx" ON "CatalogoManutencaoOperacaoItem"("operacaoId");

-- CreateIndex
CREATE INDEX "CatalogoManutencaoOperacaoItem_produtoId_idx" ON "CatalogoManutencaoOperacaoItem"("produtoId");

-- CreateIndex
CREATE INDEX "ListaEncomenda_loteOrigemId_idx" ON "ListaEncomenda"("loteOrigemId");

-- CreateIndex
CREATE INDEX "ListaEncomenda_loteDivididoEm_idx" ON "ListaEncomenda"("loteDivididoEm");

-- AddForeignKey
ALTER TABLE "CatalogoManutencaoOperacao" ADD CONSTRAINT "CatalogoManutencaoOperacao_utilizadorId_fkey" FOREIGN KEY ("utilizadorId") REFERENCES "Utilizador"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogoManutencaoOperacao" ADD CONSTRAINT "CatalogoManutencaoOperacao_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogoManutencaoOperacao" ADD CONSTRAINT "CatalogoManutencaoOperacao_operacaoOrigemId_fkey" FOREIGN KEY ("operacaoOrigemId") REFERENCES "CatalogoManutencaoOperacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogoManutencaoOperacaoItem" ADD CONSTRAINT "CatalogoManutencaoOperacaoItem_operacaoId_fkey" FOREIGN KEY ("operacaoId") REFERENCES "CatalogoManutencaoOperacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogoManutencaoOperacaoItem" ADD CONSTRAINT "CatalogoManutencaoOperacaoItem_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListaEncomenda" ADD CONSTRAINT "ListaEncomenda_loteOrigemId_fkey" FOREIGN KEY ("loteOrigemId") REFERENCES "ListaEncomenda"("id") ON DELETE SET NULL ON UPDATE CASCADE;
