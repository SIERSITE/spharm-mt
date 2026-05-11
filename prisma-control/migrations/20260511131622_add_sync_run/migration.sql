-- Fase 1 WS-B — SyncRun ledger (control plane).
-- Additive-only. Não toca em "Tenant" nem em "TenantEvent".

CREATE TYPE "SyncRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "SyncRunTrigger" AS ENUM ('CLI', 'CRON', 'UI', 'RETRY');

CREATE TABLE "SyncRun" (
    "id"              TEXT NOT NULL,
    "tenantSlug"      TEXT NOT NULL,
    "source"          TEXT NOT NULL,
    "status"          "SyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "triggerType"     "SyncRunTrigger" NOT NULL DEFAULT 'CLI',
    "workerId"        TEXT,
    "startedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt"      TIMESTAMP(3),
    "durationMs"      INTEGER,
    "recordsRead"     INTEGER NOT NULL DEFAULT 0,
    "recordsInserted" INTEGER NOT NULL DEFAULT 0,
    "recordsUpdated"  INTEGER NOT NULL DEFAULT 0,
    "recordsFailed"   INTEGER NOT NULL DEFAULT 0,
    "errorSummary"    TEXT,
    "metaJson"        TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncRun_tenantSlug_startedAt_idx" ON "SyncRun"("tenantSlug", "startedAt" DESC);
CREATE INDEX "SyncRun_source_startedAt_idx"     ON "SyncRun"("source",     "startedAt" DESC);
CREATE INDEX "SyncRun_status_startedAt_idx"     ON "SyncRun"("status",     "startedAt" DESC);
