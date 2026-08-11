-- ─────────────────────────────────────────────────────────────────────
-- Histórico das execuções dos backfills de catálogo.
--
-- Uma cobertura de 21% não diz nada isolada; 18% -> 21% -> 37% diz tudo.
-- Sem esta tabela cada corrida imprime números no terminal e perde-os.
--
-- Aditiva e idempotente.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CatalogoBackfillRun" (
    "id"                    TEXT             NOT NULL,
    "kind"                  TEXT             NOT NULL,
    "executadoEm"           TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "produtosAnalisados"    INTEGER          NOT NULL,
    "produtosClassificados" INTEGER          NOT NULL,
    "associacoes"           INTEGER          NOT NULL,
    "recusadas"             INTEGER          NOT NULL,
    "coberturaPercent"      DOUBLE PRECISION NOT NULL,
    "limiarConfianca"       DOUBLE PRECISION,
    "versaoRegras"          TEXT,
    "detalhes"              JSONB            NOT NULL DEFAULT '{}',
    CONSTRAINT "CatalogoBackfillRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CatalogoBackfillRun_kind_executadoEm_idx"
  ON "CatalogoBackfillRun"("kind", "executadoEm");
