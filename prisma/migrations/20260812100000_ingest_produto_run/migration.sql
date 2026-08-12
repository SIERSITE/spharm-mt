-- ─────────────────────────────────────────────────────────────────────
-- Fronteira temporal das corridas de products-upload, medida pelo
-- relógio do SERVIDOR.
--
-- O sweep que marca produtos como retirados usava o `runStartedAt`
-- gerado pelo agent na máquina da farmácia (Windows, sem NTP garantido).
-- Com esse relógio adiantado, as linhas escritas durante a corrida
-- ficavam com dataAtualizacao anterior ao corte e o sweep retirava o
-- catálogo inteiro que acabara de ser carregado — devolvendo ok: true.
--
-- Aditiva e idempotente.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "IngestProdutoRun" (
    "id"                 TEXT         NOT NULL,
    "farmaciaId"         TEXT         NOT NULL,
    "startedAtServer"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBatchAtServer"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "produtosRecebidos"  INTEGER      NOT NULL DEFAULT 0,
    "estado"             TEXT         NOT NULL DEFAULT 'ABERTA',
    "finalizadaEm"       TIMESTAMP(3),
    "retiradas"          INTEGER,
    CONSTRAINT "IngestProdutoRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "IngestProdutoRun_farmaciaId_estado_idx"
  ON "IngestProdutoRun"("farmaciaId", "estado");
CREATE INDEX IF NOT EXISTS "IngestProdutoRun_farmaciaId_startedAtServer_idx"
  ON "IngestProdutoRun"("farmaciaId", "startedAtServer");

-- Uma única corrida ABERTA por farmácia. Único PARCIAL: as FINALIZADA e
-- ABANDONADA acumulam-se à vontade (é o histórico), mas duas abertas ao
-- mesmo tempo dariam dois cortes possíveis ao sweep.
--
-- A garantia tem de estar na base: o agent envia batches em sequência,
-- mas um retry sobreposto ou dois processos a correr criariam duas
-- corridas se isto fosse verificado só na aplicação.
CREATE UNIQUE INDEX IF NOT EXISTS "IngestProdutoRun_farmacia_aberta_key"
  ON "IngestProdutoRun"("farmaciaId")
  WHERE "estado" = 'ABERTA';

DO $$
BEGIN
    ALTER TABLE "IngestProdutoRun"
      ADD CONSTRAINT "IngestProdutoRun_farmaciaId_fkey"
      FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
