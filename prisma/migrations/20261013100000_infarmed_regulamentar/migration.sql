-- Dados regulamentares do INFARMED (ficheiro "allPackages"): camada versionada
-- e SEPARADA de Produto. Puramente aditiva: duas tabelas novas e um enum; não
-- toca em nenhuma tabela existente (a relação Produto→ProdutoRegulamentar é
-- só do lado da nova tabela).
--
-- Decisões:
--  · InfarmedImportacao guarda o histórico (uma linha por tentativa) e qual
--    versão está ativa; ProdutoRegulamentar guarda os dados POR VERSÃO. O
--    rollback é, por isso, só trocar qual versão está ativa — sem reescrever
--    dados e sem restaurar a base.
--  · No máximo UMA versão ativa: índice único parcial (não exprimível no
--    schema.prisma) — é a trava de base de dados contra duas importações a
--    declararem-se ativas ao mesmo tempo.
--  · CNPEM e Nº registo são texto/identificadores, nunca números a calcular.

-- CreateEnum
CREATE TYPE "InfarmedImportacaoEstado" AS ENUM ('EM_CURSO', 'APLICADA', 'REVERTIDA', 'FALHADA');

-- CreateTable
CREATE TABLE "InfarmedImportacao" (
    "id" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "urlOrigem" TEXT,
    "nomeFicheiro" TEXT,
    "sha256" TEXT NOT NULL,
    "descarregadoEm" TIMESTAMP(3) NOT NULL,
    "estado" "InfarmedImportacaoEstado" NOT NULL DEFAULT 'EM_CURSO',
    "ativa" BOOLEAN NOT NULL DEFAULT false,
    "versaoAnteriorId" TEXT,
    "linhasLidas" INTEGER NOT NULL DEFAULT 0,
    "linhasRejeitadas" INTEGER NOT NULL DEFAULT 0,
    "cnpDistintos" INTEGER NOT NULL DEFAULT 0,
    "produtosAssociados" INTEGER NOT NULL DEFAULT 0,
    "cnpNaoEncontrados" INTEGER NOT NULL DEFAULT 0,
    "registosNovos" INTEGER NOT NULL DEFAULT 0,
    "registosAlterados" INTEGER NOT NULL DEFAULT 0,
    "registosIguais" INTEGER NOT NULL DEFAULT 0,
    "camposAlterados" INTEGER NOT NULL DEFAULT 0,
    "deixaramDeEstarPresentes" INTEGER NOT NULL DEFAULT 0,
    "erro" TEXT,
    "relatorio" JSONB,
    "iniciadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminadaEm" TIMESTAMP(3),
    "revertidaEm" TIMESTAMP(3),

    CONSTRAINT "InfarmedImportacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProdutoRegulamentar" (
    "id" TEXT NOT NULL,
    "importacaoId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "cnp" INTEGER NOT NULL,
    "cnpem" TEXT,
    "substanciaAtiva" TEXT,
    "nomeMedicamento" TEXT,
    "formaFarmaceutica" TEXT,
    "dosagem" TEXT,
    "tamanhoEmbalagem" TEXT,
    "pvp" DECIMAL(12,4),
    "precoLivre" BOOLEAN NOT NULL DEFAULT false,
    "pvpNotificado" DECIMAL(12,4),
    "precoUtenteGeral" DECIMAL(12,4),
    "precoUtenteEspecial" DECIMAL(12,4),
    "estadoComercializacao" TEXT,
    "generico" BOOLEAN,
    "presenteNoFicheiro" BOOLEAN NOT NULL DEFAULT true,
    "atualizadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProdutoRegulamentar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InfarmedImportacao_sha256_idx" ON "InfarmedImportacao"("sha256");

-- CreateIndex
CREATE INDEX "InfarmedImportacao_estado_ativa_idx" ON "InfarmedImportacao"("estado", "ativa");

-- CreateIndex
CREATE INDEX "ProdutoRegulamentar_produtoId_idx" ON "ProdutoRegulamentar"("produtoId");

-- CreateIndex
CREATE INDEX "ProdutoRegulamentar_cnpem_importacaoId_idx" ON "ProdutoRegulamentar"("cnpem", "importacaoId");

-- CreateIndex
CREATE UNIQUE INDEX "ProdutoRegulamentar_importacaoId_produtoId_key" ON "ProdutoRegulamentar"("importacaoId", "produtoId");

-- AddForeignKey
ALTER TABLE "ProdutoRegulamentar" ADD CONSTRAINT "ProdutoRegulamentar_importacaoId_fkey" FOREIGN KEY ("importacaoId") REFERENCES "InfarmedImportacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoRegulamentar" ADD CONSTRAINT "ProdutoRegulamentar_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Trava: no máximo uma versão regulamentar ativa.
CREATE UNIQUE INDEX "InfarmedImportacao_uma_ativa_idx" ON "InfarmedImportacao" ((true)) WHERE "ativa";
