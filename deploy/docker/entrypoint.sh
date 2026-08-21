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

# ─────────────────────────────────────────────────────────────────────
# Runtime administrativo (SÓ nos modos de ferramentas)
# ─────────────────────────────────────────────────────────────────────
#
# `tenant:create --provider=local --create-db` precisa de uma ligação de
# superutilizador para o CREATE ROLE / CREATE DATABASE do tenant novo
# (ver lib/db-providers/local-postgres.ts). O contrato do CLI já existe e
# não muda: ele lê POSTGRES_ADMIN_URL e TENANT_DB_HOST.
#
# O que muda é de onde vêm. Derivadas AQUI, em memória, a partir da
# password de superutilizador que só o serviço `migrate` monta
# (secrets/tools.secrets.env, 0600 root:root). Consequências:
#
#   · POSTGRES_ADMIN_URL não existe em ficheiro nenhum — nem no
#     stack.env, nem no platform.env, nem na imagem;
#   · não aparece em `docker compose config`, que é o output que as
#     pessoas colam em mensagens quando pedem ajuda;
#   · o web e o worker nunca a vêem, porque nem sequer montam o ficheiro
#     de onde ela sai (e são limpos abaixo, por precaução).
#
# NUNCA registar o URL: leva a password. O log diz o utilizador e o
# destino, que é o que serve para diagnosticar.
ensure_admin_url() {
  if [ -n "${POSTGRES_ADMIN_URL:-}" ]; then
    log "administração: POSTGRES_ADMIN_URL definido explicitamente (não derivado)"
    return 0
  fi

  if [ -z "${POSTGRES_SUPERUSER_PASSWORD:-}" ]; then
    # NÃO é erro. Os fluxos `--provider=neon` e `--provider=manual` não
    # precisam de superutilizador nenhum, e as migrations também não.
    log "administração: sem POSTGRES_SUPERUSER_PASSWORD — só --provider=neon|manual"
    return 0
  fi

  local admin_user=${POSTGRES_SUPERUSER:-postgres}
  # Base de manutenção: ligar a `postgres` e não à do control plane. Um
  # CREATE DATABASE não pode correr dentro da base que se está a usar
  # como alvo, e a `postgres` existe sempre.
  POSTGRES_ADMIN_URL=$(
    ADMIN_USER="$admin_user" ADMIN_PASSWORD="$POSTGRES_SUPERUSER_PASSWORD" \
    ADMIN_DB="${POSTGRES_ADMIN_DB:-postgres}" \
    node -e '
      const enc = encodeURIComponent;
      const host = process.env.POSTGRES_HOST || "postgres";
      const port = process.env.POSTGRES_PORT || "5432";
      const ssl  = (process.env.DATABASE_SSLMODE || "").trim();
      let url = `postgresql://${enc(process.env.ADMIN_USER)}:${enc(process.env.ADMIN_PASSWORD)}@${host}:${port}/${process.env.ADMIN_DB}`;
      if (ssl) url += `?sslmode=${enc(ssl)}`;
      process.stdout.write(url);
    '
  )
  export POSTGRES_ADMIN_URL

  # O provider `local` precisa das duas: o URL para ADMINISTRAR e o host
  # que vai ficar gravado na ligação do tenant. São conceitos distintos —
  # daí não as deduzir uma da outra dentro do provider.
  export TENANT_DB_HOST=${TENANT_DB_HOST:-${POSTGRES_HOST:-postgres}}
  export TENANT_DB_PORT=${TENANT_DB_PORT:-${POSTGRES_PORT:-5432}}

  log "administração: POSTGRES_ADMIN_URL derivado (${admin_user}@${POSTGRES_HOST:-postgres}:${POSTGRES_PORT:-5432}/${POSTGRES_ADMIN_DB:-postgres}), tenants em ${TENANT_DB_HOST}:${TENANT_DB_PORT}"
}

# Defesa em profundidade para os serviços que servem tráfego. Se algum
# dia alguém acrescentar o ficheiro de segredos errado ao `env_file` do
# web, o processo continua a não receber credenciais de superutilizador:
# um bug de configuração deixa de ser uma escalada de privilégios.
drop_admin_credentials() {
  unset POSTGRES_ADMIN_URL POSTGRES_SUPERUSER_PASSWORD POSTGRES_SUPERUSER
}

# ─────────────────────────────────────────────────────────────────────
# Aprovisionamento (SÓ no `web`)
# ─────────────────────────────────────────────────────────────────────
#
# POST /api/admin/v1/tenants cria um cliente, e criar um cliente exige
# CREATE ROLE + CREATE DATABASE. Esse pedido chega ao serviço `web` — que
# não pode ter a password de superutilizador.
#
# A saída é um role intermédio: `spharmmt_provisioner`, com CREATEDB e
# CREATEROLE e mais nada (ver postgres/init/10-databases.sh). O `web`
# recebe a password DELE, nunca a do superutilizador, e monta o
# POSTGRES_ADMIN_URL aqui, em memória.
#
# Porque é que isto é aceitável, e vale a pena ser explícito: o que o
# role acrescenta ao alcance de um RCE no `web` é criar e destruir bases.
# NÃO acrescenta leitura de dados — o `web` já lê todos os tenants por
# desenho, é ele que os serve. O delta é disponibilidade, não
# confidencialidade.
#
# O `worker` não recebe nada disto: não expõe API nenhuma.
ensure_provisioner_url() {
  if [ -n "${POSTGRES_ADMIN_URL:-}" ]; then return 0; fi
  if [ -z "${POSTGRES_PROVISIONER_PASSWORD:-}" ]; then
    log "aprovisionamento: sem POSTGRES_PROVISIONER_PASSWORD — criar clientes por API vai falhar com erro explícito"
    return 0
  fi

  local prov_user=${POSTGRES_PROVISIONER_USER:-spharmmt_provisioner}
  POSTGRES_ADMIN_URL=$(
    ADMIN_USER="$prov_user" ADMIN_PASSWORD="$POSTGRES_PROVISIONER_PASSWORD" \
    ADMIN_DB="${POSTGRES_ADMIN_DB:-postgres}" \
    node -e '
      const enc = encodeURIComponent;
      const host = process.env.POSTGRES_HOST || "postgres";
      const port = process.env.POSTGRES_PORT || "5432";
      const ssl  = (process.env.DATABASE_SSLMODE || "").trim();
      let url = `postgresql://${enc(process.env.ADMIN_USER)}:${enc(process.env.ADMIN_PASSWORD)}@${host}:${port}/${process.env.ADMIN_DB}`;
      if (ssl) url += `?sslmode=${enc(ssl)}`;
      process.stdout.write(url);
    '
  )
  export POSTGRES_ADMIN_URL
  export TENANT_DB_HOST=${TENANT_DB_HOST:-${POSTGRES_HOST:-postgres}}
  export TENANT_DB_PORT=${TENANT_DB_PORT:-${POSTGRES_PORT:-5432}}
  log "aprovisionamento: POSTGRES_ADMIN_URL derivado (${prov_user}@${POSTGRES_HOST:-postgres}:${POSTGRES_PORT:-5432}), tenants em ${TENANT_DB_HOST}:${TENANT_DB_PORT}"
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
    drop_admin_credentials
    ensure_provisioner_url
    ensure_db_urls
    log "a arrancar o servidor Next em ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
    # `exec` para que o Node fique com o PID 1 e receba SIGTERM
    # directamente — sem isto o `docker stop` esperava os 10s completos
    # e matava o processo a meio de um pedido.
    exec node server.js
    ;;

  worker)
    drop_admin_credentials
    # Sem aprovisionamento: o worker nao expoe API e nao cria clientes.
    unset POSTGRES_PROVISIONER_PASSWORD
    # Credencial do modelo: DEFESA EM PROFUNDIDADE, nao o mecanismo.
    #
    # O que tira mesmo a chave ao worker e o compose: `model.secrets.env`
    # e montado pelo `web` e pelo `migrate` e nunca por este servico. Este
    # `unset` so protege o caso de alguem voltar a acrescentar o ficheiro
    # aqui — e protege-o so a meio, o que e importante saber.
    #
    # Medido em producao, com a chave no app.secrets.env que os dois
    # montam:
    #
    #   /proc/1/environ do worker                       -> ausente
    #   docker exec spharmmt-worker printenv ANTHROPIC.. -> PRESENTE
    #   docker inspect -f '{{.Config.Env}}'             -> PRESENTE
    #
    # O `unset` limpa o ambiente DESTE processo e do que ele executa. Nao
    # apaga nada de `Config.Env`, que e onde o `env_file` grava o valor —
    # e cada `docker exec` constroi o ambiente do processo novo a partir
    # dai. Por isso o worker nunca teve a chave e qualquer `docker exec`
    # nele devolvia-a na mesma.
    #
    # Um segredo que se apanha com um `docker exec` no container errado
    # nao esta entregue apenas a quem precisa dele. Nao o entregar e a
    # unica forma de o nao entregar.
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
    ensure_db_urls
    log "a arrancar o worker (SCHEDULER_ENABLED=${SCHEDULER_ENABLED:-0})"
    exec node scripts/workers/scheduler.mjs "$@"
    ;;

  migrate)
    ensure_db_urls
    ensure_admin_url
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
    ensure_admin_url
    exec bash "$@"
    ;;

  *)
    # Qualquer outro argumento é tratado como comando — permite
    # `docker compose run --rm migrate npm run tenancy:list` sem ter de
    # acrescentar um modo por cada script.
    ensure_db_urls
    ensure_admin_url
    exec "$mode" "$@"
    ;;
esac
