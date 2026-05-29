-- MovimentoArtigo — paridade operacional com o relatório "Movimento de
-- Artigos" do ERP SPharm. Adiciona a camada documental + contraparte +
-- bónus split + preço/valor ao modelo canónico, para que o extrato da
-- ficha do artigo seja funcionalmente equivalente ao impresso pelo ERP.
--
-- Não-destrutiva:
--   · CREATE TYPE "ContraparteTipo"
--   · ALTER TABLE "MovimentoArtigo" ADD COLUMN ...  (todas nullable ou
--     com DEFAULT 0; rows existentes pré-rev36 mantêm-se válidas)
--   · NÃO toca em Venda / Compra / Devolucao / VendaMensal / AjusteStock
--   · NÃO altera dashboard reads
--
-- Após esta migration o agent rev36 começa a popular as colunas novas.
-- Rows antigas ficam com NULL nas colunas novas até re-upload do agent.

-- ── 1. ENUM ContraparteTipo ────────────────────────────────────────
CREATE TYPE "ContraparteTipo" AS ENUM (
  'CLIENTE',
  'FORNECEDOR',
  'FARMACIA_ORIGEM',
  'FARMACIA_DESTINO'
);

-- ── 2. Colunas documento (composto pelo agent a partir de Atendimento
--      / Recepcao_Cab / Devolucao_Cab / tblMovStocksCab conforme FK) ──
ALTER TABLE "MovimentoArtigo"
  ADD COLUMN "documentoTipo"     VARCHAR(40),
  ADD COLUMN "documentoNumero"   VARCHAR(40),
  ADD COLUMN "referenciaExterna" VARCHAR(80);

-- ── 3. Contraparte (cliente / fornecedor / farmácia origem|destino) ──
ALTER TABLE "MovimentoArtigo"
  ADD COLUMN "contraparteNome" VARCHAR(160),
  ADD COLUMN "contraparteTipo" "ContraparteTipo";

-- ── 4. Armazém + utilizador (nomes legíveis) ───────────────────────
ALTER TABLE "MovimentoArtigo"
  ADD COLUMN "armazemNome"    VARCHAR(60),
  ADD COLUMN "utilizadorNome" VARCHAR(80);

-- ── 5. Bónus split + Ex.Bon running balance ────────────────────────
-- `quantidadeBonus` (combinado) fica deprecated mas mantido. Os 3
-- novos vêm de StocksMov.BonusEnt/BonusSai/ExistenciaBonus.
ALTER TABLE "MovimentoArtigo"
  ADD COLUMN "quantidadeBonusEnt"  INT NOT NULL DEFAULT 0,
  ADD COLUMN "quantidadeBonusSai"  INT NOT NULL DEFAULT 0,
  ADD COLUMN "existenciaBonusApos" INT NOT NULL DEFAULT 0;

-- ── 6. Preço / valor (preserva o que o ERP imprimiu sem recálculo) ──
ALTER TABLE "MovimentoArtigo"
  ADD COLUMN "precoUnitario" DECIMAL(12, 4),
  ADD COLUMN "valorLinha"    DECIMAL(12, 2);

-- Sem novos índices: as queries do extrato (produtoId × farmaciaId ×
-- dataMovimento) já têm cobertura suficiente nos indexes existentes.
