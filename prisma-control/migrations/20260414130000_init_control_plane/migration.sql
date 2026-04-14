-- CreateEnum
CREATE TYPE "TenantEstado" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'FAILED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "nifGrupo" TEXT,
    "estado" "TenantEstado" NOT NULL DEFAULT 'PROVISIONING',
    "dbHost" TEXT NOT NULL,
    "dbPort" INTEGER NOT NULL DEFAULT 5432,
    "dbName" TEXT NOT NULL,
    "dbUser" TEXT NOT NULL,
    "dbPassEncrypted" TEXT NOT NULL,
    "dbRegion" TEXT,
    "schemaVersion" TEXT,
    "provisionedAt" TIMESTAMP(3),
    "lastMigratedAt" TIMESTAMP(3),
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastHealthStatus" TEXT,
    "lastBackupAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX "Tenant_estado_idx" ON "Tenant"("estado");
CREATE INDEX "Tenant_createdAt_idx" ON "Tenant"("createdAt");

-- CreateTable
CREATE TABLE "TenantEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "metaJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TenantEvent_tenantId_createdAt_idx" ON "TenantEvent"("tenantId", "createdAt");
CREATE INDEX "TenantEvent_action_createdAt_idx" ON "TenantEvent"("action", "createdAt");

-- CreateTable
CREATE TABLE "GlobalAdmin" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ultimoLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalAdmin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GlobalAdmin_email_key" ON "GlobalAdmin"("email");

-- CreateTable
CREATE TABLE "GlobalAdminTenant" (
    "globalAdminId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'support',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalAdminTenant_pkey" PRIMARY KEY ("globalAdminId","tenantId")
);

CREATE INDEX "GlobalAdminTenant_tenantId_idx" ON "GlobalAdminTenant"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantEvent" ADD CONSTRAINT "TenantEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GlobalAdminTenant" ADD CONSTRAINT "GlobalAdminTenant_globalAdminId_fkey" FOREIGN KEY ("globalAdminId") REFERENCES "GlobalAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GlobalAdminTenant" ADD CONSTRAINT "GlobalAdminTenant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
