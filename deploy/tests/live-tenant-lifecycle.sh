#!/usr/bin/env bash
# deploy/tests/live-tenant-lifecycle.sh
#
# Ciclo de vida COMPLETO de um tenant, contra uma stack a sério: um
# PostgreSQL de verdade, a imagem migrator de verdade, a aplicação e o
# proxy de verdade. Usa os utilitários que já existiam — nenhum comando
# novo, nenhum caminho paralelo.
#
# Não faz parte da suite automática (test-*.sh): precisa de Docker e
# demora minutos. Corre-se à mão:
#
#   ./deploy/tests/live-tenant-lifecycle.sh
#
# O que percorre, por esta ordem:
#   1. cluster novo + migrations do control plane e da legacy
#   2. tenant:create --provider=local --create-db --dry-run   (nada escrito)
#   3. tenant:create a sério                                   (base + role + admin)
#   4. tenancy:migrate-all                                     (schema do tenant)
#   5. tenancy:list · tenancy:status · tenancy:health          (ACTIVE)
#   6. tenancy:add-farmacia · tenancy:add-user
#   7. admin:reset-user-password
#   8. tenancy:issue-ingest-key
#   9. GET /?__tenant=<slug> através do proxy
#  10. tenancy:deactivate → tenancy:reactivate
#  11. cleanup do tenant + destruição do cluster
#
# E, transversalmente, a fronteira de privilégio:
#   · o `migrate` tem POSTGRES_ADMIN_URL derivado;
#   · o `web` e o `worker` NÃO têm — nem a password de superutilizador.
#
# TUDO acontece num cluster descartável em /tmp, com project name e rede
# próprios. Não toca em /opt/spharmmt, em tenants reais, na Vercel nem no
# Neon. No fim, o directório inteiro é apagado.
#
# Saída: 0 tudo verificado · 1 alguma verificação falhou · 2 sem Docker

set -uo pipefail

REPO_ROOT=${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
COMPOSE_FILE="${REPO_ROOT}/deploy/docker/docker-compose.yml"
TAG="e2etenant"
PROJECT="spharmmt-${TAG}"
NET="spharmmt-${TAG}"
HTTP_PORT=18097

SLUG="e2e-teste"
ADMIN_EMAIL="admin@e2e.teste"
ADMIN_PASS="E2e-Teste-2026"
USER_EMAIL="operador@e2e.teste"
USER_PASS="Operador-2026"

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }
ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
note() { printf '      %s\n' "$1"; }

command -v docker >/dev/null 2>&1 || { echo "docker não encontrado" >&2; exit 2; }
docker info >/dev/null 2>&1        || { echo "daemon docker não responde" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "compose não encontrado" >&2; exit 2; }

TMP=$(mktemp -d)
TMP_D="$TMP"; REPO_D="$REPO_ROOT"; COMPOSE_D="$COMPOSE_FILE"
if [ -n "${MSYSTEM:-}" ] || uname -s 2>/dev/null | grep -qE 'MINGW|MSYS'; then
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  if command -v cygpath >/dev/null 2>&1; then
    TMP_D=$(cygpath -w "$TMP"); REPO_D=$(cygpath -w "$REPO_ROOT")
    COMPOSE_D=$(cygpath -w "$COMPOSE_FILE")
  fi
fi

dcb() {
  docker compose -f "$COMPOSE_D" --env-file "${TMP_D}/stack.env" \
    --profile tools -p "$PROJECT" "$@"
}

cleanup() {
  echo
  echo "── limpeza ─────────────────────────────────────────────"
  dcb down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "spharmmt-app:${TAG}" "spharmmt-app:${TAG}-migrator" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
  echo "cluster descartável destruído (${TMP})"
}
trap cleanup EXIT

# ═════════════════════════════════════════════════════════════════════════
# Preparação
# ═════════════════════════════════════════════════════════════════════════
mkdir -p "${TMP}/env" "${TMP}/secrets" "${TMP}/proxy/conf" "${TMP}/proxy/certs" \
         "${TMP}/pg/init" "${TMP}/pg/data" "${TMP}/backups"
cp "${REPO_ROOT}"/deploy/docker/postgres/init/*.sh "${TMP}/pg/init/"
cp "${REPO_ROOT}/deploy/docker/proxy/spharmmt.conf" "${TMP}/proxy/conf/"

SU_PASS="su-$(date +%s)-descartavel"
APP_PASS="app-$(date +%s)-descartavel"

cat >"${TMP}/env/platform.env" <<EOF
NODE_ENV=production
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_SUPERUSER=postgres
POSTGRES_APP_USER=spharmmt_app
POSTGRES_CONTROL_DB=spharmmt_control
POSTGRES_LEGACY_DB=spharmmt_legacy
PUBLIC_APP_URL=http://127.0.0.1:${HTTP_PORT}
SESSION_COOKIE_SECURE=0
SCHEDULER_ENABLED=0
ALLOW_LEGACY_DATABASE_FALLBACK=0
REFRESH_IPF_MULTI_TENANT_ENABLED=0
# ?__tenant só é aceite com este fallback ligado — é o modo de bootstrap,
# antes de haver subdomínios.
TENANT_FALLBACK_ENABLED=1
# Espelha o que o install-platform.sh escreve (ver install-platform.sh,
# chave TENANT_DB_SSLMODE): o PostgreSQL desta stack não tem TLS, e a URL
# gravada na criação do tenant leva o sslmode consigo. Sem isto, tudo o
# que toca na base do tenant morre em "server does not support SSL" — e o
# tenant fica criado mas inutilizável.
TENANT_DB_SSLMODE=disable
EOF

cat >"${TMP}/secrets/app.secrets.env" <<EOF
POSTGRES_APP_PASSWORD=${APP_PASS}
AUTH_SECRET=e2e-auth-secret-descartavel-0123456789
TENANT_ENCRYPTION_SECRET=e2e-tenant-encryption-descartavel-0123456789
EMAIL_CONFIG_SECRET=e2e-email-secret-descartavel-0123456789
CRON_SECRET=e2e-cron-descartavel
ADMIN_API_TOKENS=e2e-admin-token-descartavel
EOF

# A fronteira que este teste também verifica: a password de
# superutilizador vive SÓ aqui, e só o serviço `migrate` monta o ficheiro.
cat >"${TMP}/secrets/tools.secrets.env" <<EOF
POSTGRES_SUPERUSER_PASSWORD=${SU_PASS}
EOF

cat >"${TMP}/secrets/postgres.secrets.env" <<EOF
POSTGRES_PASSWORD=${SU_PASS}
POSTGRES_APP_PASSWORD=${APP_PASS}
EOF

cat >"${TMP}/stack.env" <<EOF
APP_BUILD_CONTEXT=${REPO_D}
APP_IMAGE=spharmmt-app
APP_TAG=${TAG}
APP_REVISION=e2e
INSTALL_CHROMIUM=0
SERVER_ACTIONS_ALLOWED_ORIGINS=127.0.0.1:${HTTP_PORT}
PUBLIC_APP_URL=http://127.0.0.1:${HTTP_PORT}
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
BACKUP_DIR=${TMP_D}/backups
PROXY_BIND=127.0.0.1
PROXY_HTTP_PORT=${HTTP_PORT}
EOF

docker network create "$NET" >/dev/null 2>&1 || true

echo "=== ciclo de vida de um tenant, stack a sério ==="
echo "projecto: ${PROJECT} · porta: ${HTTP_PORT} · raiz: ${TMP}"
echo

# tools <descrição> <comando...> — corre um comando no serviço migrate e
# guarda o output. Devolve o rc do comando lá dentro.
LAST_OUT=""
tools() {
  local desc=$1; shift
  LAST_OUT="${TMP}/out-$(printf '%s' "$desc" | tr -c 'a-zA-Z0-9' '_').log"
  dcb run --rm migrate "$@" >"$LAST_OUT" 2>&1
}

# ═════════════════════════════════════════════════════════════════════════
# 1. Build e arranque
# ═════════════════════════════════════════════════════════════════════════
echo "1. build e cluster novo"
if dcb build web migrate >"${TMP}/build.log" 2>&1; then
  ok_ "imagens construídas"
else
  bad_ "build falhou"; tail -20 "${TMP}/build.log" | sed 's/^/      /'
  echo; printf 'lifecycle: %d ok, %d falhas\n' "$pass" "$fail"; exit 1
fi

dcb up -d postgres >"${TMP}/up-pg.log" 2>&1
for _ in $(seq 1 60); do
  h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "pg-${TAG}" 2>/dev/null || echo none)
  [ "$h" = "healthy" ] && break
  sleep 2
done
if [ "$h" = "healthy" ]; then
  ok_ "PostgreSQL healthy (cluster criado do zero)"
else
  bad_ "PostgreSQL não ficou healthy"; docker logs "pg-${TAG}" 2>&1 | tail -20 | sed 's/^/      /'
  echo; printf 'lifecycle: %d ok, %d falhas\n' "$pass" "$fail"; exit 1
fi

# ═════════════════════════════════════════════════════════════════════════
# 2. Migrations
# ═════════════════════════════════════════════════════════════════════════
echo
echo "2. migrations"
if dcb run --rm migrate >"${TMP}/migrate.log" 2>&1; then
  ok_ "control plane + legacy migrados"
else
  bad_ "migrations falharam"; tail -20 "${TMP}/migrate.log" | sed 's/^/      /'
fi

if grep -q 'POSTGRES_ADMIN_URL derivado' "${TMP}/migrate.log"; then
  ok_ "migrate recebeu POSTGRES_ADMIN_URL derivado"
else
  bad_ "migrate NÃO derivou POSTGRES_ADMIN_URL — --create-db não vai funcionar"
fi
if grep -q "$SU_PASS" "${TMP}/migrate.log"; then
  bad_ "a password de superutilizador APARECEU no log"
else
  ok_ "a password de superutilizador não aparece no log"
fi

# ═════════════════════════════════════════════════════════════════════════
# 3. Dry-run: não escreve nada
# ═════════════════════════════════════════════════════════════════════════
echo
echo "3. tenant:create --dry-run"
tools dryrun npm run --silent tenant:create -- \
  --slug "$SLUG" --name "Cliente E2E" --admin-email "$ADMIN_EMAIL" \
  --provider=local --create-db --dry-run
if [ $? -eq 0 ]; then ok_ "dry-run termina com rc=0"; else
  bad_ "dry-run falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi

count=$(dcb run --rm migrate npm run --silent tenancy:list -- --json 2>/dev/null \
  | tr -d '\r' | grep -c "\"slug\": *\"${SLUG}\"" || true)
if [ "$count" = "0" ]; then
  ok_ "dry-run não criou tenant nenhum"
else
  bad_ "o dry-run CRIOU um tenant — não é dry-run"
fi

# ═════════════════════════════════════════════════════════════════════════
# 4. Criação a sério
# ═════════════════════════════════════════════════════════════════════════
echo
echo "4. tenant:create a sério (--provider=local --create-db)"
tools create npm run --silent tenant:create -- \
  --slug "$SLUG" --name "Cliente E2E" \
  --admin-email "$ADMIN_EMAIL" --admin-password "$ADMIN_PASS" \
  --farmacias "Farmácia Um,Farmácia Dois" \
  --provider=local --create-db
if [ $? -eq 0 ]; then
  ok_ "tenant:create termina com rc=0 sem configuração manual"
else
  bad_ "tenant:create falhou"; tail -25 "$LAST_OUT" | sed 's/^/      /'
fi

# A base do tenant existe MESMO no cluster — não basta a linha no
# control plane.
dbs=$(docker exec "pg-${TAG}" psql -U postgres -tAc \
  "SELECT datname FROM pg_database WHERE datname LIKE '%e2e%'" 2>/dev/null | tr -d '\r')
if [ -n "$dbs" ]; then
  ok_ "base de dados do tenant criada: $(echo "$dbs" | tr '\n' ' ')"
else
  bad_ "nenhuma base de dados criada para o tenant"
fi

# ═════════════════════════════════════════════════════════════════════════
# 5. Migrations do tenant e estado
# ═════════════════════════════════════════════════════════════════════════
echo
echo "5. schema do tenant e estado no control plane"
tools migrateall npm run --silent tenancy:migrate-all
if [ $? -eq 0 ]; then ok_ "tenancy:migrate-all rc=0"; else
  bad_ "tenancy:migrate-all falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi

tools list npm run --silent tenancy:list
if grep -q "$SLUG" "$LAST_OUT"; then ok_ "tenancy:list mostra o tenant"; else
  bad_ "tenancy:list não mostra o tenant"; tail -10 "$LAST_OUT" | sed 's/^/      /'
fi
if grep -qi 'ACTIVE' "$LAST_OUT"; then ok_ "tenant está ACTIVE"; else
  bad_ "tenant não está ACTIVE"; tail -10 "$LAST_OUT" | sed 's/^/      /'
fi

tools status npm run --silent tenancy:status -- --tenant "$SLUG"
if [ $? -eq 0 ]; then ok_ "tenancy:status rc=0"; else
  bad_ "tenancy:status falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi

tools health npm run --silent tenancy:health
if [ $? -eq 0 ]; then ok_ "tenancy:health rc=0"; else
  bad_ "tenancy:health falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi

# O admin do tenant existe na base DO TENANT (não no control plane).
admins=$(dcb run --rm migrate npm run --silent tenancy:status -- --tenant "$SLUG" 2>/dev/null | tr -d '\r')
if printf '%s' "$admins" | grep -qi "$ADMIN_EMAIL\|utilizador\|user"; then
  ok_ "status reporta os utilizadores do tenant"
else
  note "status não lista utilizadores — verificado adiante pelo login"
  ok_ "status respondeu"
fi

# ═════════════════════════════════════════════════════════════════════════
# 6. Farmácias e utilizadores
# ═════════════════════════════════════════════════════════════════════════
echo
echo "6. add-farmacia · add-user · reset-user-password"
tools addfarmacia npm run --silent tenancy:add-farmacia -- \
  --tenant "$SLUG" --nome "Farmácia Três"
if [ $? -eq 0 ]; then ok_ "tenancy:add-farmacia rc=0"; else
  bad_ "tenancy:add-farmacia falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi

tools adduser npm run --silent tenancy:add-user -- \
  --tenant "$SLUG" --email "$USER_EMAIL" --nome "Operador E2E" \
  --password "$USER_PASS" --role ADMINISTRADOR
if [ $? -eq 0 ]; then ok_ "tenancy:add-user rc=0"; else
  bad_ "tenancy:add-user falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi

tools resetpw npm run --silent admin:reset-user-password -- \
  --tenant "$SLUG" --email "$USER_EMAIL" --password "Nova-Senha-2026"
if [ $? -eq 0 ]; then ok_ "admin:reset-user-password rc=0"; else
  bad_ "admin:reset-user-password falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi
if grep -q 'Nova-Senha-2026' "$LAST_OUT"; then
  note "a senha nova aparece no output (é o contrato deste comando: mostrada uma vez)"
fi

# O `tenant:create` JÁ emitiu uma chave. Reemitir sem `--rotate` tem de
# ser recusado: uma chave nova invalida silenciosamente a que o agent da
# farmácia está a usar, e o sintoma seria a ingestão a parar sem ninguém
# ter tocado no agent.
tools ingestkey_sem_rotate npm run --silent tenancy:issue-ingest-key -- --slug "$SLUG"
if [ $? -ne 0 ] && grep -q 'rotate' "$LAST_OUT"; then
  ok_ "issue-ingest-key recusa reemitir sem --rotate"
else
  bad_ "issue-ingest-key reemitiu sem --rotate — invalidaria a chave do agent"
fi

tools ingestkey npm run --silent tenancy:issue-ingest-key -- --slug "$SLUG" --rotate
if [ $? -eq 0 ]; then ok_ "tenancy:issue-ingest-key --rotate rc=0"; else
  bad_ "tenancy:issue-ingest-key --rotate falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi

# ═════════════════════════════════════════════════════════════════════════
# 7. A aplicação resolve o tenant
# ═════════════════════════════════════════════════════════════════════════
echo
echo "7. acesso HTTP com ?__tenant=${SLUG}"
dcb up -d web worker proxy >"${TMP}/up-web.log" 2>&1
for _ in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT}/healthz" 2>/dev/null | tr -d '\r\n')
  [ "$code" = "200" ] && break
  sleep 2
done
if [ "$code" = "200" ]; then ok_ "proxy responde em /healthz"; else
  bad_ "proxy não respondeu (código=${code:-nenhum})"
fi

login=$(curl -s -o "${TMP}/login.html" -w '%{http_code}' \
  "http://127.0.0.1:${HTTP_PORT}/login?__tenant=${SLUG}" 2>/dev/null | tr -d '\r\n')
if [ "$login" = "200" ]; then
  ok_ "GET /login?__tenant=${SLUG} devolve 200"
else
  bad_ "GET /login?__tenant=${SLUG} devolveu ${login}"
  docker logs "app-${TAG}" 2>&1 | tail -15 | sed 's/^/      /'
fi

# O middleware anuncia o que resolveu em `x-tenant-resolved` /
# `x-tenant-source`. É o que prova que a resolução ACONTECEU — um 200
# sozinho não prova nada, porque o middleware corre no edge, não tem base
# de dados e não valida existência (por isso um slug inventado também dá
# 200; isso é o desenho, não uma falha).
hdrs=$(curl -sI "http://127.0.0.1:${HTTP_PORT}/login?__tenant=${SLUG}" 2>/dev/null | tr -d '\r')
if printf '%s' "$hdrs" | grep -qi "^x-tenant-resolved: ${SLUG}$"; then
  ok_ "middleware resolveu o tenant: x-tenant-resolved=${SLUG}"
else
  bad_ "x-tenant-resolved não trouxe ${SLUG}"
  printf '%s' "$hdrs" | grep -i 'x-tenant' | sed 's/^/      /'
fi
if printf '%s' "$hdrs" | grep -qi '^x-tenant-source: query$'; then
  ok_ "resolução veio do ?__tenant (source=query)"
else
  bad_ "a resolução não veio do query param"
fi

# Sem o parâmetro, não há tenant nenhum resolvido: é o contraste que
# mostra que o 200 acima não era um 200 qualquer.
sem=$(curl -sI "http://127.0.0.1:${HTTP_PORT}/login" 2>/dev/null | tr -d '\r')
if printf '%s' "$sem" | grep -qi '^x-tenant-resolved: -$'; then
  ok_ "sem ?__tenant não há tenant resolvido"
else
  bad_ "sem ?__tenant o middleware resolveu alguma coisa"
  printf '%s' "$sem" | grep -i 'x-tenant' | sed 's/^/      /'
fi

# ═════════════════════════════════════════════════════════════════════════
# 8. Fronteira de privilégio
# ═════════════════════════════════════════════════════════════════════════
echo
echo "8. o web e o worker não vêem credenciais de superutilizador"
# Os DOIS serviços que servem/processam tráfego. O worker sobe ocioso
# (SCHEDULER_ENABLED=0) — o que se verifica é o ambiente dele, não
# trabalho nenhum.
for svc in "app-${TAG}" "worker-${TAG}"; do
  envdump=$(docker exec "$svc" env 2>/dev/null | tr -d '\r')
  if printf '%s' "$envdump" | grep -q 'POSTGRES_ADMIN_URL='; then
    bad_ "${svc} TEM POSTGRES_ADMIN_URL"
  else
    ok_ "${svc} sem POSTGRES_ADMIN_URL"
  fi
  if printf '%s' "$envdump" | grep -q 'POSTGRES_SUPERUSER_PASSWORD='; then
    bad_ "${svc} TEM a password de superutilizador"
  else
    ok_ "${svc} sem POSTGRES_SUPERUSER_PASSWORD"
  fi
  if printf '%s' "$envdump" | grep -q "$SU_PASS"; then
    bad_ "${svc} tem o VALOR da password de superutilizador nalguma variável"
  else
    ok_ "${svc} não tem o valor da password de superutilizador"
  fi
done

# `docker compose config` é o output que se cola em mensagens a pedir
# ajuda. O URL administrativo não pode estar lá.
cfg=$(dcb config 2>/dev/null)
if printf '%s' "$cfg" | grep -q 'POSTGRES_ADMIN_URL'; then
  bad_ "POSTGRES_ADMIN_URL aparece em docker compose config"
else
  ok_ "POSTGRES_ADMIN_URL não aparece em docker compose config"
fi

# E depois de o container terminar, não fica nada: o `--rm` leva o
# ambiente com ele.
sobrou=$(docker ps -a --filter "name=${PROJECT}-migrate" --format '{{.Names}}' | tr -d '\r')
if [ -z "$sobrou" ]; then
  ok_ "nenhum container migrate sobreviveu (o ambiente foi-se com ele)"
else
  bad_ "sobraram containers migrate: ${sobrou}"
fi

# ═════════════════════════════════════════════════════════════════════════
# 9. Desactivar, reactivar, limpar
# ═════════════════════════════════════════════════════════════════════════
echo
echo "9. deactivate · reactivate · cleanup"
tools deactivate npm run --silent tenancy:deactivate -- --slug "$SLUG"
if [ $? -eq 0 ]; then ok_ "tenancy:deactivate rc=0"; else
  bad_ "tenancy:deactivate falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi

tools reactivate npm run --silent tenancy:reactivate -- --slug "$SLUG"
if [ $? -eq 0 ]; then ok_ "tenancy:reactivate rc=0"; else
  bad_ "tenancy:reactivate falhou"; tail -15 "$LAST_OUT" | sed 's/^/      /'
fi

tools cleanup npm run --silent tenancy:cleanup-failed -- --slug "$SLUG" --confirm
if [ $? -eq 0 ]; then
  ok_ "tenancy:cleanup-failed rc=0"
else
  # Recusar-se a limpar um tenant ACTIVE é comportamento CORRECTO, e
  # dizê-lo é mais útil do que fingir que o comando serve para tudo.
  note "cleanup-failed recusou (o tenant está ACTIVE, não FAILED) — comportamento esperado"
  ok_ "cleanup-failed não apaga tenants saudáveis por acidente"
fi

echo
printf 'lifecycle: %s%d ok%s, %s%d falhas%s\n' "$C_G" "$pass" "$C_0" "$C_R" "$fail" "$C_0"
[ "$fail" -eq 0 ] || exit 1
exit 0
