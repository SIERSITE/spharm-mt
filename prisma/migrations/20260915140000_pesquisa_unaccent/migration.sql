-- Pesquisa por artigo (Vendas/Margens) tem de ignorar acentos:
-- "avene" tinha de encontrar "Avène", "AVENE", "Avene", "avéne" — e um
-- ILIKE simples não faz isso, porque "è"/"é"/"e" são bytes/codepoints
-- diferentes e a collation não os funde por omissão.
--
-- `unaccent` é uma extensão TRUSTED (tal como `pg_trgm`, já activada na
-- migration 20260521010000_produto_designacao_trgm) — instalável pelo
-- role da aplicação, sem superuser.
--
-- A função `unaccent(text)` da extensão é STABLE, não IMMUTABLE — não
-- pode ser usada directamente num índice funcional. O wrapper
-- `unaccent_immutable` marca-a IMMUTABLE (o padrão documentado do
-- Postgres para isto): o dicionário "unaccent" é estático dentro desta
-- instalação, por isso a promessa é segura. Se o dicionário alguma vez
-- mudar, o índice tem de ser reconstruído — não é o caso aqui.
--
-- O índice trigram RAW em Produto.designacao (migration acima) fica
-- intacto — outras pesquisas (ex: /stock) continuam a usá-lo. Este é
-- ADITIVO: um segundo índice funcional para a pesquisa
-- accent-insensitive, para que `unaccent_immutable(designacao) ILIKE
-- unaccent_immutable('%termo%')` continue a resolver por índice em vez
-- de fazer sequential scan à medida que o catálogo cresce.
--
-- Additive e idempotente. CREATE INDEX não-concorrente corre dentro da
-- transacção da migration — aceitável à mesma escala da migration trgm
-- original (~28k linhas de Produto).

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION unaccent_immutable(text)
RETURNS text AS
$$
  SELECT public.unaccent('public.unaccent', $1)
$$
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

CREATE INDEX IF NOT EXISTS "Produto_designacao_unaccent_trgm_idx"
  ON "Produto" USING gin (unaccent_immutable(designacao) gin_trgm_ops);
