-- scripts/diagnostics/cnps-mt-readonly.sql
--
-- O QUE FAZ
--   Lista, para UMA farmacia do tenant, os produtos que EXISTEM no MT nessa
--   farmacia (Produto com ProdutoFarmacia dessa farmacia), uma linha por CNP:
--
--       cnp;flagGenerico;manual
--
--   · cnp          so digitos (Produto.cnp e' INT NOT NULL UNIQUE)
--   · flagGenerico 0/1 (Produto.flagGenerico; NULL -> 0; a coluna e' NOT NULL)
--   · manual       0/1: 1 se 'flagGenerico' esta em Produto."camposManuais"
--                  (TEXT[]), ou seja, o ERP nao pode sobrepor esse valor.
--   Ordenado por cnp, sem cabecalho, nada mais vai para stdout.
--
-- E' SO LEITURA
--   Transacao READ ONLY, so SELECT e um DO que apenas faz RAISE. Nao cria
--   tabelas (nem temporarias), nao escreve, termina em ROLLBACK.
--
-- NAO FOI EXECUTADO
--   Escrito por leitura de prisma/schema.prisma; nunca foi corrido num
--   PostgreSQL. Rever a primeira execucao com um LIMIT ou numa copia.
--
-- USO  (parametro -v farmacia= aceita o NOME EXATO ou o ID da farmacia)
--   psql "$DATABASE_URL" -v farmacia="Nome Exato" -At -f scripts/diagnostics/cnps-mt-readonly.sql > cnps-mt-silveirense.txt
--
--   Variante com \copy (cliente; o ficheiro e' escrito na maquina do psql).
--   \copy nao aceita multi-linha, por isso a query tem de ir numa linha:
--   ver notes/cnps-mt-exportacao.md.
--
-- TENANTS COM VARIAS FARMACIAS
--   Cada ERP = uma farmacia. Correr UMA VEZ POR FARMACIA e usar cada ficheiro
--   com o diagnostico da respetiva farmacia. Misturar farmacias distorce a
--   matriz MT x ERP. Se o nome/id nao existir ou apanhar mais de uma farmacia,
--   o script FALHA (ON_ERROR_STOP) sem escrever linhas.
--
-- BASE DE DADOS
--   Uma base por tenant (spharmmt_t_<slug>): lib/db-providers/local-postgres.ts
--   (createDatabase) + scripts/tenancy/_shared.ts. Ligar o psql a base do
--   tenant certo (ex.: spharmmt_t_silveira).

\set QUIET on
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset fieldsep ';'

-- Falha clara se -v farmacia=... nao foi dado (\if precisa de psql >= 10).
\if :{?farmacia}
\else
  SELECT 1/0 AS "falta_o_parametro_-v_farmacia";
\endif

BEGIN TRANSACTION READ ONLY;

-- Passa o parametro para dentro do DO (psql nao interpola dentro de $$...$$).
-- \gset consome o resultado: nada vai para stdout.
SELECT set_config('spharm.farmacia', :'farmacia', true) AS _cfg \gset

DO $verifica$
DECLARE
  alvo text := current_setting('spharm.farmacia');
  n int;
BEGIN
  SELECT count(*) INTO n FROM "Farmacia" f WHERE f."id"::text = alvo OR f."nome" = alvo;
  IF n = 0 THEN
    RAISE EXCEPTION 'cnps-mt-readonly: nenhuma farmacia com id/nome = %', alvo;
  ELSIF n > 1 THEN
    RAISE EXCEPTION 'cnps-mt-readonly: % farmacias com nome = % (usar o id)', n, alvo;
  END IF;
END
$verifica$;

SELECT p."cnp"::text
       || ';' || (COALESCE(p."flagGenerico", false))::int::text
       || ';' || (COALESCE('flagGenerico' = ANY(p."camposManuais"), false))::int::text
FROM "Produto" p
WHERE p."cnp"::text ~ '^[0-9]+$'
  AND EXISTS (
    SELECT 1
    FROM "ProdutoFarmacia" pf
    JOIN "Farmacia" f ON f."id" = pf."farmaciaId"
    WHERE pf."produtoId" = p."id"
      AND (f."id"::text = :'farmacia' OR f."nome" = :'farmacia')
  )
ORDER BY p."cnp";

ROLLBACK;
