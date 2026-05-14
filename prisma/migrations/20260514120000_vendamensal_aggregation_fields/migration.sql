-- Add aggregation fields to VendaMensal. Todos nullable porque rows
-- legadas (Excel import) não os tinham. O aggregate-vendamensal.ts
-- populá-los; loaders legados continuam a deixar NULL.

ALTER TABLE "VendaMensal" ADD COLUMN "quantidadeLiquida"   DECIMAL(14,3);
ALTER TABLE "VendaMensal" ADD COLUMN "valorBruto"          DECIMAL(14,2);
ALTER TABLE "VendaMensal" ADD COLUMN "valorPagoUtente"     DECIMAL(14,2);
ALTER TABLE "VendaMensal" ADD COLUMN "valorComparticipado" DECIMAL(14,2);
ALTER TABLE "VendaMensal" ADD COLUMN "linhasVenda"         INTEGER;
ALTER TABLE "VendaMensal" ADD COLUMN "atendimentos"        INTEGER;
ALTER TABLE "VendaMensal" ADD COLUMN "origemAgregacao"     TEXT;
ALTER TABLE "VendaMensal" ADD COLUMN "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Index para queries por origem (admin/audit).
CREATE INDEX "VendaMensal_origemAgregacao_idx" ON "VendaMensal"("origemAgregacao");
