-- Grupo laboratorial pesquisável (tenant garantia — 2026-09).
--
-- Camada SEPARADA da identidade legal (Fabricante) — nunca a substitui.
-- Puramente aditivo: 5 tabelas novas, nenhuma coluna existente é tocada,
-- nenhum dado é migrado. Ver o doc comment de GrupoLaboratorial em
-- prisma/schema.prisma para o racional completo (sucessões empresariais
-- parciais como Pfizer→Viatris nalguns CNPs, não em todos).

-- CreateTable
CREATE TABLE "GrupoLaboratorial" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "nomeNormalizado" TEXT NOT NULL,
    "estado" "EntidadeEstado" NOT NULL DEFAULT 'ATIVO',
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrupoLaboratorial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrupoLaboratorialAlias" (
    "id" TEXT NOT NULL,
    "grupoLaboratorialId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasNormalizado" TEXT NOT NULL,
    "origem" TEXT,
    "estado" "EntidadeEstado" NOT NULL DEFAULT 'ATIVO',

    CONSTRAINT "GrupoLaboratorialAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrupoLaboratorialFabricante" (
    "id" TEXT NOT NULL,
    "grupoLaboratorialId" TEXT NOT NULL,
    "fabricanteId" TEXT NOT NULL,
    "tipoAssociacao" TEXT NOT NULL DEFAULT 'INEQUIVOCA',
    "evidencia" TEXT,
    "validadoManualmente" BOOLEAN NOT NULL DEFAULT false,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrupoLaboratorialFabricante_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegraGrupoLaboratorialPorCnp" (
    "id" TEXT NOT NULL,
    "cnp" INTEGER NOT NULL,
    "grupoLaboratorialId" TEXT NOT NULL,
    "fabricanteLegalEsperadoId" TEXT,
    "evidencia" TEXT,
    "estado" "EntidadeEstado" NOT NULL DEFAULT 'ATIVO',
    "validadoManualmente" BOOLEAN NOT NULL DEFAULT false,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegraGrupoLaboratorialPorCnp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProdutoGrupoLaboratorial" (
    "id" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "grupoLaboratorialId" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "regraCnpId" TEXT,
    "snapshotCnp" INTEGER,
    "validadoManualmente" BOOLEAN NOT NULL DEFAULT false,
    "evidencia" TEXT,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProdutoGrupoLaboratorial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GrupoLaboratorial_nomeNormalizado_key" ON "GrupoLaboratorial"("nomeNormalizado");

-- CreateIndex
CREATE UNIQUE INDEX "GrupoLaboratorialAlias_grupoLaboratorialId_aliasNormalizado_key" ON "GrupoLaboratorialAlias"("grupoLaboratorialId", "aliasNormalizado");

-- CreateIndex
CREATE INDEX "GrupoLaboratorialAlias_aliasNormalizado_idx" ON "GrupoLaboratorialAlias"("aliasNormalizado");

-- CreateIndex
CREATE UNIQUE INDEX "GrupoLaboratorialFabricante_fabricanteId_key" ON "GrupoLaboratorialFabricante"("fabricanteId");

-- CreateIndex
CREATE INDEX "GrupoLaboratorialFabricante_grupoLaboratorialId_idx" ON "GrupoLaboratorialFabricante"("grupoLaboratorialId");

-- CreateIndex
CREATE UNIQUE INDEX "RegraGrupoLaboratorialPorCnp_cnp_key" ON "RegraGrupoLaboratorialPorCnp"("cnp");

-- CreateIndex
CREATE UNIQUE INDEX "ProdutoGrupoLaboratorial_produtoId_key" ON "ProdutoGrupoLaboratorial"("produtoId");

-- CreateIndex
CREATE INDEX "ProdutoGrupoLaboratorial_grupoLaboratorialId_idx" ON "ProdutoGrupoLaboratorial"("grupoLaboratorialId");

-- CreateIndex
CREATE INDEX "ProdutoGrupoLaboratorial_regraCnpId_idx" ON "ProdutoGrupoLaboratorial"("regraCnpId");

-- CreateIndex
CREATE INDEX "ProdutoGrupoLaboratorial_snapshotCnp_idx" ON "ProdutoGrupoLaboratorial"("snapshotCnp");

-- AddForeignKey
ALTER TABLE "GrupoLaboratorialAlias" ADD CONSTRAINT "GrupoLaboratorialAlias_grupoLaboratorialId_fkey" FOREIGN KEY ("grupoLaboratorialId") REFERENCES "GrupoLaboratorial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrupoLaboratorialFabricante" ADD CONSTRAINT "GrupoLaboratorialFabricante_grupoLaboratorialId_fkey" FOREIGN KEY ("grupoLaboratorialId") REFERENCES "GrupoLaboratorial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrupoLaboratorialFabricante" ADD CONSTRAINT "GrupoLaboratorialFabricante_fabricanteId_fkey" FOREIGN KEY ("fabricanteId") REFERENCES "Fabricante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegraGrupoLaboratorialPorCnp" ADD CONSTRAINT "RegraGrupoLaboratorialPorCnp_grupoLaboratorialId_fkey" FOREIGN KEY ("grupoLaboratorialId") REFERENCES "GrupoLaboratorial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegraGrupoLaboratorialPorCnp" ADD CONSTRAINT "RegraGrupoLaboratorialPorCnp_fabricanteLegalEsperadoId_fkey" FOREIGN KEY ("fabricanteLegalEsperadoId") REFERENCES "Fabricante"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoGrupoLaboratorial" ADD CONSTRAINT "ProdutoGrupoLaboratorial_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoGrupoLaboratorial" ADD CONSTRAINT "ProdutoGrupoLaboratorial_grupoLaboratorialId_fkey" FOREIGN KEY ("grupoLaboratorialId") REFERENCES "GrupoLaboratorial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoGrupoLaboratorial" ADD CONSTRAINT "ProdutoGrupoLaboratorial_regraCnpId_fkey" FOREIGN KEY ("regraCnpId") REFERENCES "RegraGrupoLaboratorialPorCnp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoGrupoLaboratorial" ADD CONSTRAINT "ProdutoGrupoLaboratorial_snapshotCnp_fkey" FOREIGN KEY ("snapshotCnp") REFERENCES "RegulatoryRecord"("cnp") ON DELETE SET NULL ON UPDATE CASCADE;
