-- Alter enum: adicionar OPERADOR
ALTER TYPE "UtilizadorPerfil" ADD VALUE IF NOT EXISTS 'OPERADOR';

-- Alter table: Utilizador ganha mustChangePassword + ultimoLogin
ALTER TABLE "Utilizador" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Utilizador" ADD COLUMN IF NOT EXISTS "ultimoLogin" TIMESTAMP(3);

-- CreateTable UtilizadorFarmacia
CREATE TABLE IF NOT EXISTS "UtilizadorFarmacia" (
    "id" TEXT NOT NULL,
    "utilizadorId" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UtilizadorFarmacia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UtilizadorFarmacia_utilizadorId_farmaciaId_key"
  ON "UtilizadorFarmacia"("utilizadorId", "farmaciaId");

CREATE INDEX IF NOT EXISTS "UtilizadorFarmacia_farmaciaId_idx"
  ON "UtilizadorFarmacia"("farmaciaId");

ALTER TABLE "UtilizadorFarmacia"
  ADD CONSTRAINT "UtilizadorFarmacia_utilizadorId_fkey"
  FOREIGN KEY ("utilizadorId") REFERENCES "Utilizador"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UtilizadorFarmacia"
  ADD CONSTRAINT "UtilizadorFarmacia_farmaciaId_fkey"
  FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable AuditLog
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "metaJson" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "Utilizador"("id") ON DELETE SET NULL ON UPDATE CASCADE;
