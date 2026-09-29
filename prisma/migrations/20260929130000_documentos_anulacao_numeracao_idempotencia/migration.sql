-- Estado ANULADA para ListaEncomenda/Transferencia (documento que já saiu
-- de RASCUNHO e foi cancelado, distinto de ELIMINADA — ver comentários nos
-- enums EstadoListaEncomenda/EstadoTransferencia em prisma/schema.prisma).
--
-- Puramente aditivo: só acrescenta um valor a cada enum já existente.
ALTER TYPE "EstadoListaEncomenda" ADD VALUE 'ANULADA';
ALTER TYPE "EstadoTransferencia" ADD VALUE 'ANULADA';

-- Cabeçalho dos documentos profissionais (NIF só aparece se preenchido).
ALTER TABLE "Farmacia" ADD COLUMN "nif" TEXT;

-- ListaEncomenda: numeração definitiva (só atribuída na finalização,
-- nunca em RASCUNHO) e auditoria da anulação.
ALTER TABLE "ListaEncomenda" ADD COLUMN "numero" TEXT;
ALTER TABLE "ListaEncomenda" ADD COLUMN "motivoAnulacao" TEXT;
ALTER TABLE "ListaEncomenda" ADD COLUMN "anuladoPorId" TEXT;
ALTER TABLE "ListaEncomenda" ADD COLUMN "anuladoEm" TIMESTAMP(3);
CREATE UNIQUE INDEX "ListaEncomenda_numero_key" ON "ListaEncomenda"("numero");
ALTER TABLE "ListaEncomenda" ADD CONSTRAINT "ListaEncomenda_anuladoPorId_fkey"
  FOREIGN KEY ("anuladoPorId") REFERENCES "Utilizador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Transferencia: data de finalização, numeração, auditoria da anulação e
-- idempotência de criação (chave gerada pelo cliente + hash do pedido,
-- ver lib/transferencias/criar-transferencia.ts).
ALTER TABLE "Transferencia" ADD COLUMN "dataFinalizacao" TIMESTAMP(3);
ALTER TABLE "Transferencia" ADD COLUMN "numero" TEXT;
ALTER TABLE "Transferencia" ADD COLUMN "motivoAnulacao" TEXT;
ALTER TABLE "Transferencia" ADD COLUMN "anuladoPorId" TEXT;
ALTER TABLE "Transferencia" ADD COLUMN "anuladoEm" TIMESTAMP(3);
ALTER TABLE "Transferencia" ADD COLUMN "clientIdempotencyKey" TEXT;
ALTER TABLE "Transferencia" ADD COLUMN "clientRequestHash" TEXT;
CREATE UNIQUE INDEX "Transferencia_numero_key" ON "Transferencia"("numero");
CREATE UNIQUE INDEX "Transferencia_clientIdempotencyKey_key" ON "Transferencia"("clientIdempotencyKey");
ALTER TABLE "Transferencia" ADD CONSTRAINT "Transferencia_anuladoPorId_fkey"
  FOREIGN KEY ("anuladoPorId") REFERENCES "Utilizador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- LinhaTransferencia: snapshot da designação no momento da criação, para
-- que uma reimpressão futura seja idêntica ao documento original mesmo se
-- Produto.designacao for editada depois (o CNP já é a chave imutável, não
-- precisa de snapshot).
ALTER TABLE "LinhaTransferencia" ADD COLUMN "designacaoSnapshot" TEXT;

-- Numeração definitiva dos documentos (lib/documentos/numeracao.ts),
-- atribuída apenas na finalização. Sequências independentes por tipo de
-- documento; nunca reaproveitadas nem retroactivamente aplicadas a rows
-- já existentes (numero fica NULL nesses casos).
CREATE SEQUENCE "seq_numero_encomenda" START 1;
CREATE SEQUENCE "seq_numero_transferencia" START 1;
