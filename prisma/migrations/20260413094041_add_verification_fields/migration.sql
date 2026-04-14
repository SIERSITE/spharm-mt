-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'VERIFIED', 'PARTIALLY_VERIFIED', 'FAILED', 'NEEDS_REVIEW');

-- AlterTable
ALTER TABLE "Produto" ADD COLUMN     "classificationSource" TEXT,
ADD COLUMN     "classificationVersion" TEXT,
ADD COLUMN     "externallyVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastVerificationAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "manualReviewReason" TEXT,
ADD COLUMN     "needsManualReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "productType" TEXT,
ADD COLUMN     "productTypeConfidence" DOUBLE PRECISION,
ADD COLUMN     "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "ProdutoVerificacaoHistorico" (
    "id" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "verificadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "productType" TEXT,
    "productTypeConf" DOUBLE PRECISION,
    "verificationStatus" TEXT NOT NULL,
    "sourceSummary" JSONB,
    "fieldsUpdated" TEXT[],

    CONSTRAINT "ProdutoVerificacaoHistorico_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProdutoVerificacaoHistorico_produtoId_verificadoEm_idx" ON "ProdutoVerificacaoHistorico"("produtoId", "verificadoEm");

-- CreateIndex
CREATE INDEX "Produto_verificationStatus_idx" ON "Produto"("verificationStatus");

-- CreateIndex
CREATE INDEX "Produto_productType_idx" ON "Produto"("productType");

-- CreateIndex
CREATE INDEX "Produto_lastVerifiedAt_idx" ON "Produto"("lastVerifiedAt");

-- AddForeignKey
ALTER TABLE "ProdutoVerificacaoHistorico" ADD CONSTRAINT "ProdutoVerificacaoHistorico_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;
