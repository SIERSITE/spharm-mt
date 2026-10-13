-- Ledger GLOBAL da atualização mensal dos dados regulamentares do INFARMED:
-- execuções, alerta de falha (um por mês) e estado da notificação por email.
-- Puramente aditiva: 3 enums e 2 tabelas novas.

-- CreateEnum
CREATE TYPE "InfarmedExecucaoResultado" AS ENUM ('CONCLUIDA', 'PARCIAL', 'FALHADA');

-- CreateEnum
CREATE TYPE "InfarmedAlertaEstado" AS ENUM ('PENDENTE', 'RESOLVIDO');

-- CreateEnum
CREATE TYPE "InfarmedNotificacaoEstado" AS ENUM ('NAO_ENVIADA', 'ENVIADA', 'FALHOU', 'NAO_CONFIGURADA');

-- CreateTable
CREATE TABLE "InfarmedExecucao" (
    "id" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "resultado" "InfarmedExecucaoResultado" NOT NULL,
    "motivo" TEXT,
    "motivoChave" TEXT,
    "sha256" TEXT,
    "bytes" INTEGER,
    "nomeFicheiro" TEXT,
    "utilizadorEmail" TEXT,
    "iniciadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminadaEm" TIMESTAMP(3),
    "tenants" JSONB,

    CONSTRAINT "InfarmedExecucao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfarmedAlerta" (
    "id" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "estado" "InfarmedAlertaEstado" NOT NULL DEFAULT 'PENDENTE',
    "motivo" TEXT NOT NULL,
    "motivoChave" TEXT NOT NULL,
    "tentativas" INTEGER NOT NULL DEFAULT 1,
    "tenantsFalhados" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,
    "resolvidoEm" TIMESTAMP(3),
    "resolvidoPor" TEXT,
    "notificacaoEstado" "InfarmedNotificacaoEstado" NOT NULL DEFAULT 'NAO_ENVIADA',
    "notificadoEm" TIMESTAMP(3),
    "notificacaoMotivoChave" TEXT,
    "notificacaoErro" TEXT,

    CONSTRAINT "InfarmedAlerta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InfarmedExecucao_iniciadaEm_idx" ON "InfarmedExecucao"("iniciadaEm");

-- CreateIndex
CREATE INDEX "InfarmedExecucao_periodo_idx" ON "InfarmedExecucao"("periodo");

-- CreateIndex
CREATE UNIQUE INDEX "InfarmedAlerta_periodo_key" ON "InfarmedAlerta"("periodo");

