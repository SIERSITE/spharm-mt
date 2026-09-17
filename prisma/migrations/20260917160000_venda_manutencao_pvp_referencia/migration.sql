-- AlterTable
-- Quantidade em Int (era Decimal(14,3)) — alinhado com o comportamento
-- EFECTIVO do loader do mapa de Vendas, que já arredonda tudo a
-- inteiro (`Math.round(toF(r.quantidade))`, lib/vendas-data.ts) antes
-- de somar. `USING ROUND(...)::INTEGER` explícito para nunca depender
-- do cast implícito por omissão do Postgres. Nenhuma linha existe
-- ainda nestas tabelas em produção — a migration anterior
-- (20260917150000_venda_manutencao) nunca foi aplicada a nenhuma BD
-- de tenant.
ALTER TABLE "VendaManutencao" ALTER COLUMN "quantidadeTotal" SET DATA TYPE INTEGER USING ROUND("quantidadeTotal")::INTEGER;

-- AlterTable
ALTER TABLE "VendaManutencaoCelula" ALTER COLUMN "quantidade" SET DATA TYPE INTEGER USING ROUND("quantidade")::INTEGER;

-- CreateTable
-- PVP de referência por (manutenção, farmácia) — snapshot imutável,
-- nullable (nunca 0 como substituto silencioso de um preço real). Ver
-- a nota grande em VendaManutencaoFarmacia no schema.
CREATE TABLE "VendaManutencaoFarmacia" (
    "id" TEXT NOT NULL,
    "manutencaoId" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "pvpReferencia" DECIMAL(12,4),

    CONSTRAINT "VendaManutencaoFarmacia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendaManutencaoFarmacia_manutencaoId_farmaciaId_key" ON "VendaManutencaoFarmacia"("manutencaoId", "farmaciaId");

-- AddForeignKey
ALTER TABLE "VendaManutencaoFarmacia" ADD CONSTRAINT "VendaManutencaoFarmacia_manutencaoId_fkey" FOREIGN KEY ("manutencaoId") REFERENCES "VendaManutencao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendaManutencaoFarmacia" ADD CONSTRAINT "VendaManutencaoFarmacia_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
