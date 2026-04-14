-- CreateTable
CREATE TABLE "InfarmedSnapshot" (
    "id" TEXT NOT NULL,
    "cnp" INTEGER NOT NULL,
    "designacaoOficial" TEXT NOT NULL,
    "dci" TEXT,
    "codigoATC" TEXT,
    "titularAim" TEXT,
    "formaFarmaceutica" TEXT,
    "dosagem" TEXT,
    "embalagem" TEXT,
    "grupoTerapeutico" TEXT,
    "estadoAim" TEXT,
    "snapshotVersion" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InfarmedSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InfarmedSnapshot_cnp_key" ON "InfarmedSnapshot"("cnp");

-- CreateIndex
CREATE INDEX "InfarmedSnapshot_snapshotVersion_idx" ON "InfarmedSnapshot"("snapshotVersion");

-- CreateIndex
CREATE INDEX "InfarmedSnapshot_estadoAim_idx" ON "InfarmedSnapshot"("estadoAim");
