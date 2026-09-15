-- Soft-delete de ListaEncomenda e Transferencia (ver comentários em
-- prisma/schema.prisma, enums EstadoListaEncomenda/EstadoTransferencia).
--
-- Puramente aditivo: só acrescenta um valor a cada enum já existente.
-- Nenhuma row é alterada, nenhum default muda.
ALTER TYPE "EstadoListaEncomenda" ADD VALUE 'ELIMINADA';
ALTER TYPE "EstadoTransferencia" ADD VALUE 'ELIMINADA';
