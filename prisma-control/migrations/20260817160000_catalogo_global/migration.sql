-- Catálogo global por CNP, partilhado por todos os tenants.
--
-- Aditivo: não toca em nenhuma tabela existente do control plane.
-- Nada aqui é operacional — sem preço, stock, fornecedor ou venda.

CREATE TYPE "OrigemConhecimento" AS ENUM ('HUMANO', 'REGULATORY', 'MODELO', 'PROPAGADO');

CREATE TABLE "CatalogoGlobal" (
    "cnp" INTEGER NOT NULL,
    "designacaoReferencia" TEXT NOT NULL,
    "productType" TEXT,
    "categoria" TEXT,
    "subcategoria" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceType" TEXT,
    "rationale" TEXT,
    "origem" "OrigemConhecimento" NOT NULL,
    "modelo" TEXT,
    "versaoRegras" TEXT NOT NULL,
    "verificado" BOOLEAN NOT NULL DEFAULT false,
    "tenantOrigem" TEXT,
    "propagadoDeCnp" INTEGER,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogoGlobal_pkey" PRIMARY KEY ("cnp")
);

CREATE TABLE "CatalogoGlobalUtilizacao" (
    "cnp" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "origem" "OrigemConhecimento" NOT NULL,
    "versaoRegras" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogoGlobalUtilizacao_pkey" PRIMARY KEY ("cnp","slug")
);

CREATE TABLE "CatalogoGlobalRevisao" (
    "id" TEXT NOT NULL,
    "cnp" INTEGER NOT NULL,
    "tenantSlug" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "valorGlobal" TEXT,
    "valorLocal" TEXT,
    "detalhe" TEXT,
    "detectadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvidoEm" TIMESTAMP(3),
    "resolucao" TEXT,

    CONSTRAINT "CatalogoGlobalRevisao_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogoGlobal_origem_idx" ON "CatalogoGlobal"("origem");
CREATE INDEX "CatalogoGlobal_versaoRegras_idx" ON "CatalogoGlobal"("versaoRegras");
CREATE INDEX "CatalogoGlobal_actualizadoEm_idx" ON "CatalogoGlobal"("actualizadoEm");
CREATE INDEX "CatalogoGlobalUtilizacao_slug_idx" ON "CatalogoGlobalUtilizacao"("slug");
CREATE INDEX "CatalogoGlobalUtilizacao_origem_idx" ON "CatalogoGlobalUtilizacao"("origem");
CREATE INDEX "CatalogoGlobalRevisao_tenantSlug_detectadoEm_idx" ON "CatalogoGlobalRevisao"("tenantSlug", "detectadoEm" DESC);
CREATE INDEX "CatalogoGlobalRevisao_cnp_idx" ON "CatalogoGlobalRevisao"("cnp");
CREATE INDEX "CatalogoGlobalRevisao_resolvidoEm_idx" ON "CatalogoGlobalRevisao"("resolvidoEm");

ALTER TABLE "CatalogoGlobalUtilizacao" ADD CONSTRAINT "CatalogoGlobalUtilizacao_cnp_fkey"
    FOREIGN KEY ("cnp") REFERENCES "CatalogoGlobal"("cnp") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CatalogoGlobalRevisao" ADD CONSTRAINT "CatalogoGlobalRevisao_cnp_fkey"
    FOREIGN KEY ("cnp") REFERENCES "CatalogoGlobal"("cnp") ON DELETE CASCADE ON UPDATE CASCADE;
