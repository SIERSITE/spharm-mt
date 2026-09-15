-- ─────────────────────────────────────────────────────────────────────
-- Transferência interna como documento próprio (Bloco D — encomenda de
-- grupo com decisão por linha).
--
-- ── O que isto substitui ────────────────────────────────────────────
--
-- Até aqui, "transferir" era criar uma segunda ListaEncomenda na
-- farmácia destino com uma LinhaEncomenda cujo `notas` era texto livre
-- (ver `createInternalTransferAction`) — o que arrastava a
-- transferência para o circuito de exportação ao ERP
-- (OrderOutbox/OrderExportAudit) e obrigava a navegar para o detalhe
-- dessa encomenda, perdendo o contexto da proposta de grupo em
-- preparação.
--
-- ── O que isto é ─────────────────────────────────────────────────────
--
-- Um registo interno, e nada mais:
--
--   · sem exportação ao ERP — Transferencia/LinhaTransferencia não têm
--     nenhuma relação com OrderOutbox/OrderExportAudit, e nenhum código
--     as lê para gerar payload de exportação;
--   · unilateral, como já era — não decrementa nem gera saída na
--     farmácia de origem, é só a decisão + quantidade.
--
-- Aditiva: duas tabelas novas, nenhuma coluna existente tocada.
-- ─────────────────────────────────────────────────────────────────────

-- Dois estados só, de propósito: sem circuito de exportação a
-- monitorizar, só o registo (RASCUNHO) e a decisão fechada (FINALIZADA).
CREATE TYPE "EstadoTransferencia" AS ENUM ('RASCUNHO', 'FINALIZADA');

CREATE TABLE "Transferencia" (
    "id"                TEXT                  NOT NULL,
    "farmaciaOrigemId"  TEXT                  NOT NULL,
    "farmaciaDestinoId" TEXT                  NOT NULL,
    "estado"            "EstadoTransferencia" NOT NULL DEFAULT 'RASCUNHO',
    "criadoPorId"       TEXT                  NOT NULL,
    "dataCriacao"       TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao"   TIMESTAMP(3)          NOT NULL,
    CONSTRAINT "Transferencia_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LinhaTransferencia" (
    "id"              TEXT           NOT NULL,
    "transferenciaId" TEXT           NOT NULL,
    "produtoId"       TEXT           NOT NULL,
    "quantidade"      DECIMAL(14,3)  NOT NULL,
    "notas"           TEXT,
    CONSTRAINT "LinhaTransferencia_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Transferencia_farmaciaOrigemId_idx" ON "Transferencia"("farmaciaOrigemId");
CREATE INDEX "Transferencia_farmaciaDestinoId_idx" ON "Transferencia"("farmaciaDestinoId");
CREATE INDEX "Transferencia_criadoPorId_idx" ON "Transferencia"("criadoPorId");
CREATE INDEX "Transferencia_estado_idx" ON "Transferencia"("estado");

CREATE INDEX "LinhaTransferencia_produtoId_idx" ON "LinhaTransferencia"("produtoId");
CREATE UNIQUE INDEX "LinhaTransferencia_transferenciaId_produtoId_key" ON "LinhaTransferencia"("transferenciaId", "produtoId");

-- Duas FK para a mesma tabela (Farmacia): origem e destino, cada uma
-- com o seu nome de constraint — é por isto que a relação é nomeada no
-- schema (`@relation("TransferenciaOrigem"/"TransferenciaDestino")").
ALTER TABLE "Transferencia" ADD CONSTRAINT "Transferencia_farmaciaOrigemId_fkey" FOREIGN KEY ("farmaciaOrigemId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transferencia" ADD CONSTRAINT "Transferencia_farmaciaDestinoId_fkey" FOREIGN KEY ("farmaciaDestinoId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transferencia" ADD CONSTRAINT "Transferencia_criadoPorId_fkey" FOREIGN KEY ("criadoPorId") REFERENCES "Utilizador"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LinhaTransferencia" ADD CONSTRAINT "LinhaTransferencia_transferenciaId_fkey" FOREIGN KEY ("transferenciaId") REFERENCES "Transferencia"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinhaTransferencia" ADD CONSTRAINT "LinhaTransferencia_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;
