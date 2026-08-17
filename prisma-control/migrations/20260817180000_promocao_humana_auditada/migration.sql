-- Promoção ao catálogo global: auditada, e a humana só por decisão explícita.
--
-- Aditivo. Não altera nenhuma coluna existente e não mexe em dados.
--
-- Migração separada da 20260817160000 de propósito: aquela pode já ter
-- sido aplicada nalgum lado, e reescrevê-la partiria o checksum que o
-- Prisma guarda em _prisma_migrations.

ALTER TABLE "CatalogoGlobal"
    ADD COLUMN "promovidoPor"      TEXT,
    ADD COLUMN "promovidoEm"       TIMESTAMP(3),
    ADD COLUMN "promovidoDeTenant" TEXT,
    ADD COLUMN "promocaoMotivo"    TEXT;

CREATE INDEX "CatalogoGlobal_promovidoEm_idx" ON "CatalogoGlobal"("promovidoEm");

-- Rasto append-only. Sem FK para "CatalogoGlobal": um registo de
-- auditoria que desaparece com a linha auditada não serve de auditoria.
CREATE TABLE "CatalogoGlobalPromocao" (
    "id" TEXT NOT NULL,
    "cnp" INTEGER NOT NULL,
    "origem" "OrigemConhecimento" NOT NULL,
    "actor" TEXT NOT NULL,
    "tenantOrigem" TEXT NOT NULL,
    "aprovador" TEXT,
    "motivo" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "versaoRegras" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogoGlobalPromocao_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogoGlobalPromocao_cnp_criadoEm_idx" ON "CatalogoGlobalPromocao"("cnp", "criadoEm" DESC);
CREATE INDEX "CatalogoGlobalPromocao_aprovador_idx" ON "CatalogoGlobalPromocao"("aprovador");
CREATE INDEX "CatalogoGlobalPromocao_criadoEm_idx" ON "CatalogoGlobalPromocao"("criadoEm" DESC);
