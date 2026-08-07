#!/usr/bin/env bash
# deploy/tests/live-build-no-database-url.sh
#
# O build da imagem TEM de ser independente da base de dados.
#
# Porquê este teste existe: o `build` do package.json corria
# `prisma migrate deploy` entre o `prisma generate` e o `next build`.
# Construir a imagem passava assim a exigir uma DATABASE_URL válida e um
# PostgreSQL de pé — coisa que no `docker build` não existe. Na VPS a
# fase 1 morreu com:
#
#     The datasource.url property is required in your Prisma config file
#     when using prisma migrate deploy.
#
# Além de partir o build, era errado de princípio: aplicava migrações à
# base apontada por DATABASE_URL (a legacy) como efeito secundário de
# construir uma imagem, sem ninguém pedir e sem passar pelo serviço
# `migrate`, que é onde as migrações têm o seu lugar — depois do
# PostgreSQL estar healthy.
#
# CONSTRÓI A PARTIR DO ESTADO COMMITADO (git archive HEAD), não da árvore
# de trabalho. É a diferença que deixou este bug passar: os testes locais
# usavam o working tree, onde a correcção já estava por commitar, e por
# isso passavam — enquanto a VPS, que clona o repositório, falhava. Um
# teste que constrói o working tree não pode provar nada sobre o que a
# VPS vai receber.
#
# Prova, por esta ordem:
#   1. `web` e `migrate` constroem com DATABASE_URL AUSENTE
#   2. o `migrate deploy` não corre em nenhum dos builds
#   3. depois de construídas, as migrações continuam a aplicar-se pelo
#      serviço `migrate` — que é o caminho legítimo
#
# Não altera nada fora do seu directório temporário.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TAG="nodburl"; PROJECT="spharmmt-${TAG}"; NET="spharmmt-${TAG}"

pass=0; fail=0
ok_()  { printf '  [OK]    %s\n' "$1"; pass=$((pass+1)); }
bad_() { printf '  [FALHA] %s\n' "$1"; fail=$((fail+1)); }
note() { printf '          %s\n' "$1"; }

TMP=$(mktemp -d)
SRC="${TMP}/src"        # estado commitado, extraído aqui
TMP_D="$TMP"; SRC_D="$SRC"
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
if command -v cygpath >/dev/null 2>&1; then
  TMP_D=$(cygpath -w "$TMP"); SRC_D=$(cygpath -w "$SRC")
fi

cleanup() {
  echo; echo "-- limpeza --"
  docker compose -f "${SRC_D}\\deploy\\docker\\docker-compose.yml" \
    --env-file "${TMP_D}\\stack.env" --profile tools -p "$PROJECT" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "spharmmt-app:${TAG}" "spharmmt-app:${TAG}-migrator" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
  echo "limpo"
}
trap cleanup EXIT

echo "=== build sem DATABASE_URL (a partir do estado COMMITADO) ==="
echo

# ── Estado commitado, não a árvore de trabalho ───────────────────────
mkdir -p "$SRC"
if git -C "$REPO_ROOT" archive HEAD | tar -x -C "$SRC" 2>/dev/null; then
  HEADSHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
  ok_ "estado commitado extraído (${HEADSHA:0:12})"
else
  bad_ "git archive HEAD falhou"; exit 1
fi

# Se a árvore de trabalho diferir do commitado nos ficheiros que este
# teste cobre, dizê-lo alto: é a situação que produziu o bug.
DIRTY=$(git -C "$REPO_ROOT" status --porcelain -- package.json deploy/docker/Dockerfile 2>/dev/null)
if [ -n "$DIRTY" ]; then
  note "AVISO: há alterações por commitar em package.json/Dockerfile —"
  note "este teste ignora-as de propósito, porque a VPS também as ignora:"
  printf '%s\n' "$DIRTY" | sed 's/^/            /'
fi

# ── O script de build não pode tocar na base ────────────────────────
BUILD_SCRIPT=$(node -e "console.log(require('${SRC}/package.json'.replace(/\\\\/g,'/')).scripts.build)" 2>/dev/null)
note "build = ${BUILD_SCRIPT}"
case "$BUILD_SCRIPT" in
  *"migrate deploy"*) bad_ "o script de build ainda corre 'migrate deploy'" ;;
  *) ok_ "o script de build não corre 'migrate deploy'" ;;
esac
case "$BUILD_SCRIPT" in
  *"prisma generate"*) ok_ "o script de build ainda gera o Prisma Client" ;;
  *) bad_ "o build deixou de correr 'prisma generate' — o cliente não é gerado" ;;
esac
case "$BUILD_SCRIPT" in
  *"next build"*) ok_ "o script de build ainda corre 'next build'" ;;
  *) bad_ "o build deixou de correr 'next build'" ;;
esac

# Continua a haver forma explícita de aplicar migrações à mão.
if node -e "process.exit(require('${SRC}/package.json'.replace(/\\\\/g,'/')).scripts['db:migrate:deploy']?0:1)" 2>/dev/null; then
  ok_ "existe 'db:migrate:deploy' para aplicar migrações explicitamente"
else
  bad_ "não há forma explícita de correr 'prisma migrate deploy'"
fi

# ── stack.env SEM DATABASE_URL em lado nenhum ───────────────────────
mkdir -p "${TMP}"/{env,secrets,pg/init,pg/data,proxy/conf,proxy/certs,proxy/acme,agent-base,backups}
cp "${SRC}"/deploy/docker/postgres/init/*.sh "${TMP}/pg/init/" 2>/dev/null
cp "${SRC}"/deploy/docker/proxy/spharmmt.conf "${TMP}/proxy/conf/" 2>/dev/null
cp "${SRC}"/deploy/docker/proxy/spharmmt-proxy-common.inc "${TMP}/proxy/conf/" 2>/dev/null

SU="su-$(date +%s)"; APP="app-$(date +%s)"; PROV="prov-$(date +%s)"
cat >"${TMP}/env/platform.env" <<EOF
NODE_ENV=production
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_SUPERUSER=postgres
POSTGRES_APP_USER=spharmmt_app
POSTGRES_CONTROL_DB=spharmmt_control
POSTGRES_LEGACY_DB=spharmmt_legacy
PUBLIC_APP_URL=http://127.0.0.1:18098
SPHARMMT_PUBLIC_ENDPOINT=http://127.0.0.1:18098
SESSION_COOKIE_SECURE=0
SCHEDULER_ENABLED=0
ALLOW_LEGACY_DATABASE_FALLBACK=0
REFRESH_IPF_MULTI_TENANT_ENABLED=0
TENANT_FALLBACK_ENABLED=1
TENANT_DB_SSLMODE=disable
TENANT_DB_HOST=postgres
TENANT_DB_PORT=5432
EOF
cat >"${TMP}/secrets/app.secrets.env" <<EOF
POSTGRES_APP_PASSWORD=${APP}
AUTH_SECRET=nodb-auth-secret-0123456789012345
TENANT_ENCRYPTION_SECRET=nodb-tenant-encryption-012345678
EMAIL_CONFIG_SECRET=nodb-email-0123456789012345678901
CRON_SECRET=nodb-cron
ADMIN_API_TOKENS=tok-nodb-0123456789
POSTGRES_PROVISIONER_PASSWORD=${PROV}
EOF
printf 'POSTGRES_SUPERUSER_PASSWORD=%s\n' "$SU" >"${TMP}/secrets/tools.secrets.env"
cat >"${TMP}/secrets/postgres.secrets.env" <<EOF
POSTGRES_PASSWORD=${SU}
POSTGRES_APP_PASSWORD=${APP}
POSTGRES_PROVISIONER_PASSWORD=${PROV}
EOF
cat >"${TMP}/stack.env" <<EOF
APP_BUILD_CONTEXT=${SRC_D}
APP_IMAGE=spharmmt-app
APP_TAG=${TAG}
APP_REVISION=nodb
INSTALL_CHROMIUM=0
SERVER_ACTIONS_ALLOWED_ORIGINS=127.0.0.1:18098
PUBLIC_APP_URL=http://127.0.0.1:18098
SPHARMMT_ROOT=${TMP_D}
SPHARMMT_ENV_FILE=${TMP_D}/env/platform.env
SPHARMMT_NETWORK=${NET}
SPHARMMT_PG_CONTAINER=pg-${TAG}
SPHARMMT_APP_CONTAINER=app-${TAG}
SPHARMMT_WORKER_CONTAINER=worker-${TAG}
SPHARMMT_PROXY_CONTAINER=proxy-${TAG}
PORT=3000
POSTGRES_DATA_DIR=${TMP_D}/pg/data
POSTGRES_INIT_DIR=${TMP_D}/pg/init
PROXY_CONF_DIR=${TMP_D}/proxy/conf
PROXY_CERTS_DIR=${TMP_D}/proxy/certs
ACME_DIR=${TMP_D}/proxy/acme
AGENT_BASE_DIR=${TMP_D}/agent-base
BACKUP_DIR=${TMP_D}/backups
PROXY_BIND=127.0.0.1
PROXY_HTTP_PORT=18098
PROXY_HTTPS_PORT=18445
EOF

if grep -rq 'DATABASE_URL' "${TMP}/stack.env" "${TMP}/env/platform.env" "${TMP}/secrets/" 2>/dev/null; then
  bad_ "há DATABASE_URL na configuração — o teste não provaria nada"
  grep -rn 'DATABASE_URL' "${TMP}/stack.env" "${TMP}/env/platform.env" "${TMP}/secrets/" | sed 's/^/          /'
else
  ok_ "DATABASE_URL ausente de toda a configuração do build"
fi
# E também não pode estar no ambiente de quem corre o teste.
if [ -n "${DATABASE_URL:-}" ]; then
  bad_ "DATABASE_URL está definida no ambiente — a limpar para o teste"
  unset DATABASE_URL
else
  ok_ "DATABASE_URL ausente do ambiente"
fi

COMPOSE_D="${SRC_D}\\deploy\\docker\\docker-compose.yml"
dcb() { docker compose -f "$COMPOSE_D" --env-file "${TMP_D}\\stack.env" --profile tools -p "$PROJECT" "$@"; }
docker network create "$NET" >/dev/null 2>&1 || true

echo
echo "1. construir os DOIS alvos sem base de dados"
if dcb build web >"${TMP}/build-web.log" 2>&1; then
  ok_ "'web' constrói sem DATABASE_URL"
else
  bad_ "'web' NÃO constrói sem DATABASE_URL"
  grep -iE 'datasource|migrate|error' "${TMP}/build-web.log" | tail -8 | sed 's/^/          /'
fi
if dcb build migrate >"${TMP}/build-migrate.log" 2>&1; then
  ok_ "'migrate' constrói sem DATABASE_URL"
else
  bad_ "'migrate' NÃO constrói sem DATABASE_URL"
  grep -iE 'datasource|migrate|error' "${TMP}/build-migrate.log" | tail -8 | sed 's/^/          /'
fi

# A mensagem exacta que matou a fase 1 na VPS.
if grep -qi 'datasource.url property is required' "${TMP}/build-web.log" "${TMP}/build-migrate.log" 2>/dev/null; then
  bad_ "o erro 'datasource.url property is required' voltou"
else
  ok_ "sem 'datasource.url property is required' em nenhum build"
fi
# E nenhum build pode ter tentado aplicar migrações.
if grep -qiE 'Applying migration|migrate deploy|migrations found' "${TMP}/build-web.log" "${TMP}/build-migrate.log" 2>/dev/null; then
  bad_ "houve actividade de migração DURANTE o build"
  grep -inE 'Applying migration|migrate deploy|migrations found' "${TMP}/build-web.log" "${TMP}/build-migrate.log" | head -4 | sed 's/^/          /'
else
  ok_ "nenhuma migração foi aplicada durante os builds"
fi
# O Prisma Client tem de ter sido gerado — senão a aplicação não arranca.
if grep -qiE 'Generated Prisma Client' "${TMP}/build-web.log" 2>/dev/null; then
  ok_ "o Prisma Client foi gerado no build"
else
  note "sem linha 'Generated Prisma Client' no log (pode vir de cache de camadas)"
fi

echo
echo "2. depois de construídas, as migrações continuam a aplicar-se"
dcb up -d postgres >/dev/null 2>&1
h=""; for _ in $(seq 1 60); do
  h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "pg-${TAG}" 2>/dev/null || echo none)
  [ "$h" = healthy ] && break; sleep 2
done
[ "$h" = healthy ] && ok_ "postgres healthy" || bad_ "postgres não ficou healthy"

if dcb run --rm migrate >"${TMP}/migrate.log" 2>&1; then
  ok_ "o serviço 'migrate' aplicou as migrações"
else
  bad_ "o serviço 'migrate' falhou"
  tail -12 "${TMP}/migrate.log" | sed 's/^/          /'
fi

# Prova pelo lado da base: as tabelas existem mesmo.
T=$(docker exec "pg-${TAG}" psql -U postgres -d spharmmt_control -tAc \
      "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null | tr -d '\r\n ')
if [ -n "$T" ] && [ "$T" -gt 0 ] 2>/dev/null; then
  ok_ "control plane com ${T} tabelas — as migrações correram de facto"
else
  bad_ "o control plane não tem tabelas (obtido: '${T}')"
fi
# Idempotência: segunda passagem não pode falhar.
if dcb run --rm migrate >"${TMP}/migrate2.log" 2>&1; then
  ok_ "segunda passagem do 'migrate' também OK (idempotente)"
else
  bad_ "segunda passagem do 'migrate' falhou"
  tail -8 "${TMP}/migrate2.log" | sed 's/^/          /'
fi

echo
printf 'build sem DATABASE_URL: %d ok, %d falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
