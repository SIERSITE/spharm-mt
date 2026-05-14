-- Adds isNonStockService flag to IngestVendaLinhaRaw.
--
-- Marca linhas de venda que correspondem a serviços/taxas SEM produto
-- operacional (Softreis: Stocks.[Processa_Stocks] = 0). Exemplos:
-- "Administração de Injectáveis", "TAXA ENTREGA AO DOMICILIO",
-- "taxa de serviço", "Checksaude Avaliação Pressão Arterial",
-- "Checksaude MAPA 48h".
--
-- O endpoint /api/ingest/v1/bootstrap/sales-lines marca esta flag
-- server-side quando o lookup ao Produto falha E o agent envia
-- `processaStocks=false` no payload.
--
-- A agregação VendaMensal exclui rows com isNonStockService=true,
-- reportando-as separadamente de orphans verdadeiros.
--
-- Default false preserva semântica para rows pré-existentes (vão
-- continuar a contar como "operational orphans" até backfill).

ALTER TABLE "IngestVendaLinhaRaw"
  ADD COLUMN "isNonStockService" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "IngestVendaLinhaRaw_isNonStockService_idx"
  ON "IngestVendaLinhaRaw"("isNonStockService");
