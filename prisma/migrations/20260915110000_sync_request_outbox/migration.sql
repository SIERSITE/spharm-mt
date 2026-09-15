-- ─────────────────────────────────────────────────────────────────────
-- SyncRequest — Bloco E: botão "Sincronizar agora" em /stock.
--
-- Padrão outbox invertido: o browser deposita o pedido (server action),
-- o agent consome (GET pending → lease → executa → ack|fail), porque a
-- comunicação agent↔SaaS é 100% unidireccional (agent só faz PULL
-- agendado, nunca há webhook/SSE a acordar o agent no clique).
--
-- Aditiva: uma tabela nova + um enum novo, nenhuma coluna existente
-- tocada.
-- ─────────────────────────────────────────────────────────────────────

CREATE TYPE "EstadoSyncRequest" AS ENUM ('PENDENTE', 'EM_CURSO', 'CONCLUIDO', 'FALHOU', 'EXPIRADO');

CREATE TABLE "SyncRequest" (
    "id"                TEXT                NOT NULL,
    "farmaciaId"        TEXT                NOT NULL,
    "estado"            "EstadoSyncRequest" NOT NULL DEFAULT 'PENDENTE',
    "requestedByUserId" TEXT                NOT NULL,
    "requestedAt"       TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedAt"          TIMESTAMP(3),
    "leasedBy"          TEXT,
    "startedAt"         TIMESTAMP(3),
    "finishedAt"        TIMESTAMP(3),
    "timeoutAt"         TIMESTAMP(3)        NOT NULL,
    "resultado"         JSONB,
    "erro"              TEXT,
    CONSTRAINT "SyncRequest_pkey" PRIMARY KEY ("id")
);

-- Hot path: agent faz poll filtrado por farmácia + estado PENDENTE.
CREATE INDEX "SyncRequest_farmaciaId_estado_idx" ON "SyncRequest"("farmaciaId", "estado");
-- Leitura de estado/UI e detecção de expirados por estado+timeout.
CREATE INDEX "SyncRequest_estado_timeoutAt_idx" ON "SyncRequest"("estado", "timeoutAt");

-- Mutex real: só pode existir UM pedido ACTIVO (PENDENTE ou EM_CURSO)
-- por farmácia. Único PARCIAL — mesmo padrão de
-- "IngestProdutoRun_farmacia_aberta_key" (ver
-- 20260812100000_ingest_produto_run/migration.sql): o Prisma não
-- exprime unicidade condicional em schema.prisma, por isso este índice
-- não tem `@@unique` correspondente no modelo — só o `@@index` normal.
-- A garantia tem de estar na base: dois cliques quase simultâneos no
-- botão, ou um clique enquanto o agent ainda não fez ack do anterior,
-- criariam dois pedidos activos se isto fosse verificado só na
-- aplicação.
CREATE UNIQUE INDEX "SyncRequest_farmacia_ativo_key"
  ON "SyncRequest"("farmaciaId")
  WHERE "estado" IN ('PENDENTE', 'EM_CURSO');

ALTER TABLE "SyncRequest" ADD CONSTRAINT "SyncRequest_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncRequest" ADD CONSTRAINT "SyncRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "Utilizador"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
