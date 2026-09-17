-- CreateTable
CREATE TABLE "VendaManutencao" (
    "id" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "cnp" INTEGER NOT NULL,
    "quantidadeTotal" DECIMAL(14,3) NOT NULL,
    "numMeses" INTEGER NOT NULL,
    "mesInicialAno" INTEGER NOT NULL,
    "mesInicialMes" INTEGER NOT NULL,
    "origemDistribuicao" TEXT NOT NULL DEFAULT 'AUTOMATICA',
    "estado" TEXT NOT NULL DEFAULT 'ATIVA',
    "criadoPorId" TEXT NOT NULL,
    "atualizadoPorId" TEXT,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendaManutencao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendaManutencaoCelula" (
    "id" TEXT NOT NULL,
    "manutencaoId" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "ano" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "quantidade" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "VendaManutencaoCelula_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendaManutencao_produtoId_idx" ON "VendaManutencao"("produtoId");

-- CreateIndex
CREATE INDEX "VendaManutencao_estado_idx" ON "VendaManutencao"("estado");

-- CreateIndex
CREATE INDEX "VendaManutencaoCelula_farmaciaId_ano_mes_idx" ON "VendaManutencaoCelula"("farmaciaId", "ano", "mes");

-- CreateIndex
CREATE UNIQUE INDEX "VendaManutencaoCelula_manutencaoId_farmaciaId_ano_mes_key" ON "VendaManutencaoCelula"("manutencaoId", "farmaciaId", "ano", "mes");

-- AddForeignKey
ALTER TABLE "VendaManutencao" ADD CONSTRAINT "VendaManutencao_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendaManutencao" ADD CONSTRAINT "VendaManutencao_criadoPorId_fkey" FOREIGN KEY ("criadoPorId") REFERENCES "Utilizador"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendaManutencao" ADD CONSTRAINT "VendaManutencao_atualizadoPorId_fkey" FOREIGN KEY ("atualizadoPorId") REFERENCES "Utilizador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendaManutencaoCelula" ADD CONSTRAINT "VendaManutencaoCelula_manutencaoId_fkey" FOREIGN KEY ("manutencaoId") REFERENCES "VendaManutencao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendaManutencaoCelula" ADD CONSTRAINT "VendaManutencaoCelula_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

