-- Bidirectional integration: outbox downstream (SPharmMT → SPharm).
-- Additive-only. Seguro correr em tenants com dados existentes.

-- CreateEnum OrderExportState
DO $$ BEGIN
  CREATE TYPE "OrderExportState" AS ENUM (
    'PENDENTE', 'EM_EXPORTACAO', 'EXPORTADO', 'FALHADO', 'CANCELADO'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Alter ListaEncomenda: novo sub-estado de exportação.
-- Default PENDENTE é seguro — sem OrderOutbox associado nada exporta.
ALTER TABLE "ListaEncomenda"
  ADD COLUMN IF NOT EXISTS "estadoExport" "OrderExportState" NOT NULL DEFAULT 'PENDENTE';

CREATE INDEX IF NOT EXISTS "ListaEncomenda_estadoExport_idx"
  ON "ListaEncomenda"("estadoExport");

-- CreateTable OrderOutbox (1:1 com ListaEncomenda)
CREATE TABLE IF NOT EXISTS "OrderOutbox" (
    "id"               TEXT NOT NULL,
    "listaEncomendaId" TEXT NOT NULL,
    "farmaciaId"       TEXT NOT NULL,
    "payloadJson"      TEXT NOT NULL,
    "idempotencyKey"   TEXT NOT NULL,
    "payloadHash"      TEXT NOT NULL,
    "state"            "OrderExportState" NOT NULL DEFAULT 'PENDENTE',
    "attemptCount"     INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError"        TEXT,
    "lastAttemptAt"    TIMESTAMP(3),
    "leasedBy"         TEXT,
    "leasedUntil"      TIMESTAMP(3),
    "spharmDocumentId" TEXT,
    "exportedAt"       TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderOutbox_listaEncomendaId_key"
  ON "OrderOutbox"("listaEncomendaId");

CREATE UNIQUE INDEX IF NOT EXISTS "OrderOutbox_idempotencyKey_key"
  ON "OrderOutbox"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "OrderOutbox_state_nextAttemptAt_idx"
  ON "OrderOutbox"("state", "nextAttemptAt");

CREATE INDEX IF NOT EXISTS "OrderOutbox_farmaciaId_state_idx"
  ON "OrderOutbox"("farmaciaId", "state");

CREATE INDEX IF NOT EXISTS "OrderOutbox_lastAttemptAt_idx"
  ON "OrderOutbox"("lastAttemptAt");

ALTER TABLE "OrderOutbox"
  ADD CONSTRAINT "OrderOutbox_listaEncomendaId_fkey"
  FOREIGN KEY ("listaEncomendaId") REFERENCES "ListaEncomenda"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable OrderExportAudit (timeline imutável)
CREATE TABLE IF NOT EXISTS "OrderExportAudit" (
    "id"             TEXT NOT NULL,
    "outboxId"       TEXT NOT NULL,
    "attempt"        INTEGER NOT NULL,
    "at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status"         TEXT NOT NULL,
    "message"        TEXT,
    "httpStatus"     INTEGER,
    "spharmSqlError" TEXT,
    "actorId"        TEXT,

    CONSTRAINT "OrderExportAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrderExportAudit_outboxId_at_idx"
  ON "OrderExportAudit"("outboxId", "at");

CREATE INDEX IF NOT EXISTS "OrderExportAudit_status_at_idx"
  ON "OrderExportAudit"("status", "at");

ALTER TABLE "OrderExportAudit"
  ADD CONSTRAINT "OrderExportAudit_outboxId_fkey"
  FOREIGN KEY ("outboxId") REFERENCES "OrderOutbox"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
