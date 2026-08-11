-- ─────────────────────────────────────────────────────────────────────
-- Utilização/necessidade: vocabulário controlado + N:N com Produto.
--
-- Facetas de pesquisa operacional ("produtos para tosse") sem tocar na
-- taxonomia: Classificacao continua a responder "o que é", isto responde
-- "para que serve". Um produto tem um lugar na árvore e N utilizações.
--
-- Aditiva e idempotente — corre em qualquer tenant sem apagar nada. O
-- vocabulário entra depois, por seed (scripts/catalog-master/seed-utilizacoes.ts),
-- a partir de lib/catalog/utilizacoes.ts.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Utilizacao" (
    "id"              TEXT         NOT NULL,
    "slug"            TEXT         NOT NULL,
    "nome"            TEXT         NOT NULL,
    "descricao"       TEXT,
    "sinonimos"       TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "grupo"           TEXT,
    "estado"          "EntidadeEstado" NOT NULL DEFAULT 'ATIVO',
    "ordem"           INTEGER,
    "dataCriacao"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Utilizacao_pkey" PRIMARY KEY ("id")
);

-- O slug é a identidade partilhada entre tenants: garante que "tosse-seca"
-- é a mesma coisa em todas as bases e que o seed é idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS "Utilizacao_slug_key"   ON "Utilizacao"("slug");
CREATE INDEX        IF NOT EXISTS "Utilizacao_estado_idx" ON "Utilizacao"("estado");
CREATE INDEX        IF NOT EXISTS "Utilizacao_grupo_idx"  ON "Utilizacao"("grupo");

CREATE TABLE IF NOT EXISTS "ProdutoUtilizacao" (
    "produtoId"    TEXT         NOT NULL,
    "utilizacaoId" TEXT         NOT NULL,
    "fonte"        TEXT         NOT NULL,
    "confianca"    DOUBLE PRECISION,
    "dataCriacao"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProdutoUtilizacao_pkey" PRIMARY KEY ("produtoId", "utilizacaoId")
);

-- A PK composta é o que impede duplicados: um produto não pode ficar
-- associado duas vezes à mesma utilização, por muito que o classificador
-- volte a correr.
CREATE INDEX IF NOT EXISTS "ProdutoUtilizacao_utilizacaoId_idx" ON "ProdutoUtilizacao"("utilizacaoId");
CREATE INDEX IF NOT EXISTS "ProdutoUtilizacao_fonte_idx"        ON "ProdutoUtilizacao"("fonte");

-- FK para Utilizacao: é isto que torna o vocabulário fechado ao nível da
-- base. Sem uma linha em Utilizacao não há associação possível, portanto
-- não há forma de texto livre entrar por aqui.
DO $$
BEGIN
    ALTER TABLE "ProdutoUtilizacao"
      ADD CONSTRAINT "ProdutoUtilizacao_produtoId_fkey"
      FOREIGN KEY ("produtoId") REFERENCES "Produto"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "ProdutoUtilizacao"
      ADD CONSTRAINT "ProdutoUtilizacao_utilizacaoId_fkey"
      FOREIGN KEY ("utilizacaoId") REFERENCES "Utilizacao"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
