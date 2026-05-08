-- AlterTable
ALTER TABLE "EnrichmentSourceLog" ALTER COLUMN "fieldsReturned" DROP DEFAULT;

-- CreateTable
CREATE TABLE "RegulatoryRecord" (
    "cnp" INTEGER NOT NULL,
    "designacaoOficial" TEXT,
    "dci" TEXT,
    "codigoATC" TEXT,
    "formaFarmaceutica" TEXT,
    "dosagem" TEXT,
    "embalagem" TEXT,
    "grupoTerapeutico" TEXT,
    "titularAim" TEXT,
    "estadoAim" TEXT,
    "source" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegulatoryRecord_pkey" PRIMARY KEY ("cnp")
);

-- CreateIndex
CREATE INDEX "RegulatoryRecord_codigoATC_idx" ON "RegulatoryRecord"("codigoATC");

-- CreateIndex
CREATE INDEX "RegulatoryRecord_dci_idx" ON "RegulatoryRecord"("dci");

-- CreateIndex
CREATE INDEX "RegulatoryRecord_source_idx" ON "RegulatoryRecord"("source");

-- CreateIndex
CREATE INDEX "RegulatoryRecord_estadoAim_idx" ON "RegulatoryRecord"("estadoAim");
