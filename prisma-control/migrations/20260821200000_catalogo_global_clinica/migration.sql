-- Informação clínica no catálogo global — uma linha por (cnp, campo).
--
-- ADITIVA E REVERSÍVEL. Não toca em nenhuma linha das 16 524 existentes,
-- não altera nenhuma coluna, não apaga nada. O que já lá está continua a
-- ler-se e a escrever-se exactamente como antes; código anterior a esta
-- migração ignora a tabela nova sem se aperceber dela.
--
-- Reversão:
--     DROP TABLE "CatalogoGlobalClinica";
--     DROP TYPE  "CampoClinico";
-- Nesta ordem — a tabela depende do tipo. Nada mais precisa de ser
-- desfeito, porque nada mais foi feito.
--
-- `IF NOT EXISTS` em tudo: esta migração pode encontrar uma base onde
-- alguém já correu o SQL à mão, e falhar aí deixaria o control plane a
-- meio de uma migração — o pior sítio para estar.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CampoClinico') THEN
        CREATE TYPE "CampoClinico" AS ENUM (
            'CODIGO_ATC', 'DCI', 'FORMA_FARMACEUTICA', 'DOSAGEM', 'EMBALAGEM'
        );
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "CatalogoGlobalClinica" (
    "cnp"            INTEGER              NOT NULL,
    "campo"          "CampoClinico"       NOT NULL,
    "valor"          TEXT                 NOT NULL,
    "origem"         "OrigemConhecimento" NOT NULL,
    "confianca"      DOUBLE PRECISION     NOT NULL,
    "versaoRegras"   TEXT                 NOT NULL,
    "tenantOrigem"   TEXT,
    "promovidoPor"   TEXT,
    "promovidoEm"    TIMESTAMP(3),
    "criadoEm"       TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEm"  TIMESTAMP(3)         NOT NULL,

    CONSTRAINT "CatalogoGlobalClinica_pkey" PRIMARY KEY ("cnp", "campo")
);

CREATE INDEX IF NOT EXISTS "CatalogoGlobalClinica_campo_idx"
    ON "CatalogoGlobalClinica" ("campo");
CREATE INDEX IF NOT EXISTS "CatalogoGlobalClinica_origem_idx"
    ON "CatalogoGlobalClinica" ("origem");
CREATE INDEX IF NOT EXISTS "CatalogoGlobalClinica_actualizadoEm_idx"
    ON "CatalogoGlobalClinica" ("actualizadoEm");

-- ON DELETE CASCADE: a clínica é do produto global. Se o produto sair do
-- catálogo, a clínica dele não fica órfã à espera de ser reatribuída.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CatalogoGlobalClinica_cnp_fkey'
    ) THEN
        ALTER TABLE "CatalogoGlobalClinica"
            ADD CONSTRAINT "CatalogoGlobalClinica_cnp_fkey"
            FOREIGN KEY ("cnp") REFERENCES "CatalogoGlobal"("cnp")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
