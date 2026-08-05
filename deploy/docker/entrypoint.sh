#!/usr/bin/env bash
# deploy/docker/entrypoint.sh
#
# Entrypoint único da imagem da aplicação. Duas responsabilidades:
#
#   1. Construir DATABASE_URL / CONTROL_DATABASE_URL a partir das peças
#      (host, porto, utilizador, base, sslmode) e do segredo.
#   2. Despachar para o modo pedido: web | worker | migrate | <comando>.
#
# Porquê construir os URLs aqui e não no compose: o compose só sabe
# interpolar variáveis do ambiente do processo que o invoca ou de um
# `--env-file`, e ambos fariam a password aparecer em texto no output de
# `docker compose config` — que é precisamente um dos comandos de
# validação. Aqui a password entra por `env_file`, nunca é impressa, e
# `docker compose config` continua a poder ser corrido em frente a
# qualquer pessoa.
#
# Nenhum valor secreto é escrito no stdout. As mensagens de diagnóstico
# mostram host, porto e base — nunca utilizador com password nem o URL
# completo.
#
# Saída: o que o comando despachado devolver · 2 configuração inválida

set -Eeuo pipefail

log() { printf '[entrypoint] %s\n' "$*"; }
fail() { printf '[entrypoint] ERRO: %s\n' "$*" >&2; exit 2; }

# ─────────────────────────────────────────────────────────────────────
# Construção dos URLs de ligação
# ─────────────────────────────────────────────────────────────────────

# build_url <base> — imprime a connection string. O escape de
# utilizador e password é feito em Node (encodeURIComponent): uma
# password com `@`, `/` ou `:` — e os geradores produzem exactamente
# esse alfabeto — parte um URL montado por concatenação, e o erro
# resultante ("getaddrinfo ENOTFOUND") não aponta para a causa.
build_url() {
  local db=$1
  # Aspas simples de propósito: o que está lá dentro é JavaScript, e a
  # expansão do shell partiria os `${...}` do template literal.
  # shellcheck disable=SC2016
  DB_NAME="$db" node -e '
    const enc = encodeURIComponent;
    const user = process.env.POSTGRES_APP_USER || "";
    const pass = process.env.POSTGRES_APP_PASSWORD || "";
    const host = process.env.POSTGRES_HOST || "postgres";
    const port = process.env.POSTGRES_PORT || "5432";
    const db   = process.env.DB_NAME;
    const ssl  = (process.env.DATABASE_SSLMODE || "").trim();
    let url = `postgresql://${enc(user)}:${enc(pass)}@${host}:${port}/${db}`;
    if (ssl) url += `?sslmode=${enc(ssl)}`;
    process.stdout.write(url);
  '
}

ensure_db_urls() {
  # Um URL definido explicitamente ganha sempre — permite apontar a
  # aplicação a uma base externa sem tocar em código nem no compose.
  if [ -z "${DATABASE_URL:-}" ]; then
    [ -n "${POSTGRES_LEGACY_DB:-}" ] || fail "nem DATABASE_URL nem POSTGRES_LEGACY_DB estão definidos"
    [ -n "${POSTGRES_APP_USER:-}" ] || fail "POSTGRES_APP_USER em falta"
    [ -n "${POSTGRES_APP_PASSWORD:-}" ] || fail "POSTGRES_APP_PASSWORD em falta (ficheiro de segredos não foi carregado?)"
    DATABASE_URL=$(build_url "$POSTGRES_LEGACY_DB")
    export DATABASE_URL
  fi

  if [ -z "${CONTROL_DATABASE_URL:-}" ]; then
    [ -n "${POSTGRES_CONTROL_DB:-}" ] || fail "nem CONTROL_DATABASE_URL nem POSTGRES_CONTROL_DB estão definidos"
    CONTROL_DATABASE_URL=$(build_url "$POSTGRES_CONTROL_DB")
    export CONTROL_DATABASE_URL
  fi

  log "postgres ${POSTGRES_HOST:-postgres}:${POSTGRES_PORT:-5432} · legacy=${POSTGRES_LEGACY_DB:-<url>} · control=${POSTGRES_CONTROL_DB:-<url>} · sslmode=${DATABASE_SSLMODE:-<default>}"
}

# Espera activa pelo PostgreSQL. O `depends_on: service_healthy` do
# compose já cobre o arranque normal; isto cobre o reinício do Postgres
# com a aplicação de pé, em que o container não é recriado.
wait_for_postgres() {
  local host=${POSTGRES_HOST:-postgres} port=${POSTGRES_PORT:-5432}
  local deadline=$(( $(date +%s) + ${DB_WAIT_TIMEOUT:-60} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # shellcheck disable=SC2016
    if node -e '
      const net = require("node:net");
      const s = net.connect(Number(process.argv[2]), process.argv[1]);
      s.on("connect", () => { s.end(); process.exit(0); });
      s.on("error", () => process.exit(1));
      s.setTimeout(2000, () => { s.destroy(); process.exit(1); });
    ' "$host" "$port" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  fail "PostgreSQL em ${host}:${port} não respondeu em ${DB_WAIT_TIMEOUT:-60}s"
}

# ─────────────────────────────────────────────────────────────────────
# Modos
# ─────────────────────────────────────────────────────────────────────

mode=${1:-web}
shift || true

case "$mode" in
  web)
    ensure_db_urls
    log "a arrancar o servidor Next em ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
    # `exec` para que o Node fique com o PID 1 e receba SIGTERM
    # directamente — sem isto o `docker stop` esperava os 10s completos
    # e matava o processo a meio de um pedido.
    exec node server.js
    ;;

  worker)
    ensure_db_urls
    log "a arrancar o worker (SCHEDULER_ENABLED=${SCHEDULER_ENABLED:-0})"
    exec node scripts/workers/scheduler.mjs "$@"
    ;;

  migrate)
    ensure_db_urls
    wait_for_postgres

    # Ordem obrigatória: o control plane primeiro. É ele que regista os
    # tenants, e `tenancy:migrate-all` lê essa lista para saber que
    # bases migrar.
    log "migrations do control plane..."
    npx prisma migrate deploy --config prisma-control.config.ts

    log "migrations da base legacy..."
    npx prisma migrate deploy --config prisma.config.ts

    # Bases dos tenants. Ausência de tenants NÃO é erro — é o estado
    # normal de uma instalação nova, e falhar aqui impediria a stack de
    # subir pela primeira vez.
    if [ "${MIGRATE_TENANTS:-1}" = "1" ]; then
      log "migrations das bases de tenant..."
      npm run --silent tenancy:migrate-all || log "AVISO: migrate-all terminou com erros (sem tenants ainda? ver acima)"
    else
      log "migrations de tenant ignoradas (MIGRATE_TENANTS=0)"
    fi

    log "migrations concluídas"
    ;;

  shell)
    ensure_db_urls
    exec bash "$@"
    ;;

  *)
    # Qualquer outro argumento é tratado como comando — permite
    # `docker compose run --rm migrate npm run tenancy:list` sem ter de
    # acrescentar um modo por cada script.
    ensure_db_urls
    exec "$mode" "$@"
    ;;
esac
