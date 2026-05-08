-- CreateEnum
CREATE TYPE "AcquisitionJobStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'PARTIAL', 'FAILED', 'BLOCKED');

-- CreateTable
CREATE TABLE "RegulatoryAcquisitionJob" (
    "id" TEXT NOT NULL,
    "cnp" INTEGER NOT NULL,
    "designacao" TEXT,
    "status" "AcquisitionJobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastSourceTried" TEXT,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fieldsObtained" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceResults" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegulatoryAcquisitionJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegulatoryAcquisitionJob_cnp_key" ON "RegulatoryAcquisitionJob"("cnp");

-- CreateIndex
CREATE INDEX "RegulatoryAcquisitionJob_status_nextAttemptAt_idx" ON "RegulatoryAcquisitionJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "RegulatoryAcquisitionJob_priority_nextAttemptAt_idx" ON "RegulatoryAcquisitionJob"("priority", "nextAttemptAt");
