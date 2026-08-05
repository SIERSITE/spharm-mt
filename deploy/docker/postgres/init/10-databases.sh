#!/usr/bin/env bash
# deploy/docker/postgres/init/10-databases.sh
#
# Cria o role da aplicação e as duas bases da plataforma.
#
# O `docker-entrypoint.sh` do PostgreSQL corre isto UMA vez, quando o
# PGDATA está vazio. Mas o script é escrito para poder ser corrido
# outra vez, à mão, contra um cluster já existente:
#
#     docker compose exec postgres bash /docker-entrypoint-initdb.d/10-databases.sh
#
# É a diferença entre "funciona na primeira instalação" e "funciona
# também quando alguém acrescenta uma base seis meses depois". Cada
# operação verifica primeiro se já está feita; nenhuma destrói nada.
#
# Bases criadas:
#   · $POSTGRES_CONTROL_DB — registo de tenants (control plane)
#   · $POSTGRES_LEGACY_DB  — base legacy / default
#
# As bases POR TENANT não são criadas aqui: são criadas uma a uma pelo
# provisionamento (`npm run tenancy:provision`), que também gera o role
# e a password de cada uma e as cifra no control plane. O que este
# script garante é que o cluster está pronto a recebê-las.
#
# SEGURANÇA: o role da aplicação NÃO é superutilizador e NÃO tem
# CREATEROLE/CREATEDB. É dono das duas bases da plataforma — o
# suficiente para as migrations, incluindo `CREATE EXTENSION pg_trgm`
# (extensão "trusted" desde o PG 13, que o dono da base pode instalar
# sem privilégios de superutilizador). A criação de bases de tenant
# exige o superutilizador e é feita de forma explícita e pontual.

set -Eeuo pipefail

APP_USER=${POSTGRES_APP_USER:-spharmmt_app}
APP_PASSWORD=${POSTGRES_APP_PASSWORD:-}
CONTROL_DB=${POSTGRES_CONTROL_DB:-spharmmt_control}
LEGACY_DB=${POSTGRES_LEGACY_DB:-spharmmt_legacy}
SUPERUSER=${POSTGRES_USER:-postgres}

log() { printf '[init-db] %s\n' "$*"; }

if [ -z "$APP_PASSWORD" ]; then
  printf '[init-db] ERRO: POSTGRES_APP_PASSWORD em falta.\n' >&2
  printf '[init-db] O ficheiro de segredos não foi montado neste container.\n' >&2
  exit 1
fi

# `psql -v ON_ERROR_STOP=1`: sem isto, um erro a meio do script deixa o
# cluster meio-configurado E o entrypoint declara sucesso.
psql_super() {
  psql --username "$SUPERUSER" --dbname "${1:-postgres}" \
       --set ON_ERROR_STOP=1 --no-psqlrc --quiet
}

exists_role() {
  [ "$(psql --username "$SUPERUSER" --dbname postgres -tAc \
        "SELECT 1 FROM pg_roles WHERE rolname = '${1}'")" = "1" ]
}

exists_db() {
  [ "$(psql --username "$SUPERUSER" --dbname postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '${1}'")" = "1" ]
}

# ─────────────────────────────────────────────────────────────────────
# 1. Role da aplicação
# ─────────────────────────────────────────────────────────────────────
if exists_role "$APP_USER"; then
  log "role ${APP_USER} já existe — password reposta a partir dos segredos"
  # ALTER e não CREATE: numa segunda execução isto realinha a password
  # com o ficheiro de segredos, que é a fonte de verdade. Nunca muda
  # privilégios de um role já existente.
  psql_super <<-SQL
	ALTER ROLE "${APP_USER}" WITH LOGIN PASSWORD '${APP_PASSWORD}';
	SQL
else
  log "a criar role ${APP_USER} (sem superuser, sem CREATEDB, sem CREATEROLE)"
  psql_super <<-SQL
	CREATE ROLE "${APP_USER}"
	  LOGIN
	  NOSUPERUSER
	  NOCREATEDB
	  NOCREATEROLE
	  NOREPLICATION
	  PASSWORD '${APP_PASSWORD}';
	SQL
fi

# ─────────────────────────────────────────────────────────────────────
# 2. Bases da plataforma
# ─────────────────────────────────────────────────────────────────────
create_db() {
  local db=$1 desc=$2
  if exists_db "$db"; then
    log "base ${db} já existe — não é tocada"
  else
    log "a criar base ${db} (${desc}), dono ${APP_USER}"
    # Sem LC_COLLATE/LC_CTYPE explícitos: herdam o locale com que o
    # cluster foi inicializado. Fixá-los aqui faria o script falhar em
    # qualquer imagem cujo locale fosse outro — e a base tem de casar
    # com o cluster, não com o que este ficheiro assume.
    # CREATE DATABASE não corre dentro de transação, daí ficar sozinho.
    psql_super <<-SQL
	CREATE DATABASE "${db}"
	  OWNER "${APP_USER}"
	  ENCODING 'UTF8'
	  TEMPLATE template0;
	SQL
  fi

  # Estas correm sempre: são idempotentes e repõem a política de acesso
  # mesmo numa base restaurada de um backup com permissões diferentes.
  psql_super <<-SQL
	REVOKE ALL ON DATABASE "${db}" FROM PUBLIC;
	GRANT CONNECT, TEMPORARY ON DATABASE "${db}" TO "${APP_USER}";
	SQL

  # O schema `public` deixou de ser escrivível por PUBLIC no PG 15, mas
  # continua a ser legível. Passá-lo para o dono fecha o último caminho
  # por onde um role novo veria objectos que não são dele.
  psql_super "$db" <<-SQL
	ALTER SCHEMA public OWNER TO "${APP_USER}";
	REVOKE ALL ON SCHEMA public FROM PUBLIC;
	GRANT ALL ON SCHEMA public TO "${APP_USER}";
	SQL
}

create_db "$CONTROL_DB" "control plane — registo de tenants"
create_db "$LEGACY_DB" "base legacy / default"

# ─────────────────────────────────────────────────────────────────────
# 3. Verificação
# ─────────────────────────────────────────────────────────────────────
# Um init que corre sem erros mas deixa o role sem conseguir ligar-se
# só se descobre quando a aplicação arranca e falha. Confirma-se agora.
for db in "$CONTROL_DB" "$LEGACY_DB"; do
  owner=$(psql --username "$SUPERUSER" --dbname postgres -tAc \
    "SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${db}'")
  if [ "$owner" != "$APP_USER" ]; then
    printf '[init-db] ERRO: base %s tem dono %s, esperado %s\n' "$db" "$owner" "$APP_USER" >&2
    exit 1
  fi
  log "verificado: ${db} · dono ${owner}"
done

is_super=$(psql --username "$SUPERUSER" --dbname postgres -tAc \
  "SELECT rolsuper FROM pg_roles WHERE rolname = '${APP_USER}'")
if [ "$is_super" != "f" ]; then
  printf '[init-db] ERRO: %s é superutilizador — não devia ser.\n' "$APP_USER" >&2
  exit 1
fi
log "verificado: ${APP_USER} não é superutilizador"

log "concluído"
