#!/usr/bin/env bash
# deploy/tests/live-tools-run.sh
#
# Corre A SÉRIO um comando do perfil `tools` dentro da imagem migrator.
#
# Não faz parte da suite automática (test-*.sh): precisa de Docker e de
# um build. Corre-se à mão:
#
#   ./deploy/tests/live-tools-run.sh
#
# A falha que motivou este ficheiro:
#
#   docker compose run --rm migrate npm run tenant:create
#   ERR_MODULE_NOT_FOUND: /app/scripts/admin/create-client.ts
#
# `tenant:create` é O comando oficial de criação de tenants. O
# package.json aponta-o para `scripts/admin/create-client.ts` e o
# Dockerfile só copiava `scripts/control` e `scripts/tenancy`. Nada no
# build acusava: descobria-se na VPS, a meio do onboarding do primeiro
# cliente.
#
# Verifica-se aqui:
#   1. o build corre a auditoria de entrypoints (deploy/docker/
#      audit-tools-entrypoints.mjs) e ela vê os ficheiros todos;
#   2. `npm run tenant:create -- --help` termina com rc=0 DENTRO do
#      container — que é a prova de que o módulo existe e carrega;
#   3. o alias `tenancy:create` faz o mesmo;
#   4. nenhum dos dois toca em base de dados: `--help` responde antes do
#      requireControlEnv(), e o Postgres nem sequer é arrancado.
#
# NÃO cria tenants nem escreve em base nenhuma: só `--help`, com
# `--no-deps` (sem PostgreSQL) e credenciais falsas que ninguém usa.
#
# Saída: 0 tudo verificado · 1 alguma verificação falhou · 2 sem Docker

set -uo pipefail

REPO_ROOT=${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
COMPOSE_FILE="${REPO_ROOT}/deploy/docker/docker-compose.yml"
TAG="livetools"

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }
ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }

command -v docker >/dev/null 2>&1 || { echo "docker não encontrado" >&2; exit 2; }
docker info >/dev/null 2>&1        || { echo "daemon docker não responde" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "compose não encontrado: ${COMPOSE_FILE}" >&2; exit 2; }

TMP=$(mktemp -d)

# O Docker no Windows não entende caminhos /tmp/... do Git Bash.
TMP_D="$TMP"; REPO_D="$REPO_ROOT"; COMPOSE_D="$COMPOSE_FILE"
if [ -n "${MSYSTEM:-}" ] || uname -s 2>/dev/null | grep -qE 'MINGW|MSYS'; then
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  if command -v cygpath >/dev/null 2>&1; then
    TMP_D=$(cygpath -w "$TMP"); REPO_D=$(cygpath -w "$REPO_ROOT")
    COMPOSE_D=$(cygpath -w "$COMPOSE_FILE")
  fi
fi

cleanup() {
  docker image rm -f "spharmmt-app:${TAG}-migrator" "spharmmt-app:${TAG}" >/dev/null 2>&1 || true
  docker network rm "spharmmt-${TAG}" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "${TMP}/env" "${TMP}/secrets" "${TMP}/proxy/conf" "${TMP}/proxy/certs" \
         "${TMP}/pg/init" "${TMP}/pg/data" "${TMP}/backups"

# Credenciais FALSAS. O entrypoint monta os URLs a partir destas partes
# antes de executar o comando; com `--help` nada se liga a lado nenhum.
# Um host inexistente é de propósito: se algum dia este teste começar a
# abrir ligações, falha em vez de tocar numa base a sério.
cat >"${TMP}/env/platform.env" <<'EOF'
POSTGRES_HOST=postgres-inexistente.invalid
POSTGRES_PORT=5432
POSTGRES_APP_USER=teste
POSTGRES_LEGACY_DB=teste_legacy
POSTGRES_CONTROL_DB=teste_control
EOF
printf 'POSTGRES_APP_PASSWORD=teste\n' >"${TMP}/secrets/app.secrets.env"
# Montado só pelo `migrate` — é daqui que sai o POSTGRES_ADMIN_URL.
printf 'POSTGRES_SUPERUSER_PASSWORD=teste\n' >"${TMP}/secrets/tools.secrets.env"
: >"${TMP}/secrets/postgres.secrets.env"

cat >"${TMP}/stack.env" <<EOF
APP_BUILD_CONTEXT=${REPO_D}
APP_IMAGE=spharmmt-app
APP_TAG=${TAG}
APP_REVISION=teste
INSTALL_CHROMIUM=0
SERVER_ACTIONS_ALLOWED_ORIGINS=127.0.0.1:8080
PUBLIC_APP_URL=http://127.0.0.1:8080
SPHARMMT_ROOT=${TMP_D}
SPHARMMT_ENV_FILE=${TMP_D}/env/platform.env
SPHARMMT_NETWORK=spharmmt-${TAG}
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
PROXY_HTTP_PORT=18098
EOF

dcb() {
  docker compose -f "$COMPOSE_D" --env-file "${TMP_D}/stack.env" \
    --profile tools -p "spharmmt-${TAG}" "$@"
}

# A rede do compose e declarada `external`: existe porque o
# install-platform.sh a cria, e nao e o compose que a gere. Aqui e criada
# a mao, com nome proprio, e removida no fim.
docker network create "spharmmt-${TAG}" >/dev/null 2>&1 || true

echo "=== comandos do perfil tools dentro da imagem migrator ==="
echo

# ═════════════════════════════════════════════════════════════════════════
# 1. Build, com a auditoria de entrypoints lá dentro
# ═════════════════════════════════════════════════════════════════════════
echo "1. build do migrator"
log="${TMP}/build.log"
# `--progress plain` para que o output do RUN da auditoria apareça: com o
# progresso interactivo o texto é apagado e não haveria o que verificar.
if dcb build --progress plain migrate >"$log" 2>&1; then
  ok_ "imagem migrator construída"
else
  bad_ "build falhou — últimas linhas:"
  tail -25 "$log" | sed 's/^/      /'
fi

if grep -q 'RUN node deploy/docker/audit-tools-entrypoints.mjs' "${REPO_ROOT}/deploy/docker/Dockerfile"; then
  ok_ "o estágio migrator declara a auditoria de entrypoints"
else
  bad_ "o Dockerfile não corre a auditoria de entrypoints"
fi

# Prova de que a guarda MORDE. Verificar o log do build não serve: com a
# layer em cache o output do RUN nem aparece, e a asserção passaria sem
# nada ter corrido. Aqui muda-se o Dockerfile — o que invalida a cache
# por construção — e exige-se que o build FALHE.
echo
echo "1b. o build falha quando falta um COPY (guarda a morder)"
mut="${TMP}/Dockerfile.mutado"
grep -v 'scripts/admin/create-client.ts' "${REPO_ROOT}/deploy/docker/Dockerfile" >"$mut"
mut_d="$mut"; [ "$TMP_D" != "$TMP" ] && mut_d="${TMP_D}\\Dockerfile.mutado"
if docker build -f "$mut_d" --target migrator \
     --build-arg INSTALL_CHROMIUM=0 \
     --build-arg SERVER_ACTIONS_ALLOWED_ORIGINS=127.0.0.1:8080 \
     --build-arg PUBLIC_APP_URL=http://127.0.0.1:8080 \
     -t "spharmmt-app:${TAG}-mutado" "$REPO_D" >"${TMP}/mut.log" 2>&1; then
  bad_ "o build PASSOU sem scripts/admin/create-client.ts — a auditoria não morde"
  docker image rm -f "spharmmt-app:${TAG}-mutado" >/dev/null 2>&1 || true
else
  if grep -q 'audit-tools' "${TMP}/mut.log"; then
    ok_ "build falha e a auditoria diz porquê: $(grep -o '· tenant:create.*' "${TMP}/mut.log" | head -1)"
  else
    bad_ "o build falhou, mas não foi a auditoria a apanhá-lo:"
    tail -12 "${TMP}/mut.log" | sed 's/^/      /'
  fi
fi

# ═════════════════════════════════════════════════════════════════════════
# 2. O comando oficial responde
# ═════════════════════════════════════════════════════════════════════════
# `--no-deps`: o `--help` não fala com base nenhuma, e arrancar um
# PostgreSQL só para isto seria trocar um teste rápido por um lento — e
# criar estado onde este teste promete não criar nenhum.
echo
echo "2. npm run <comando> -- --help"
for cmd in tenant:create tenancy:create; do
  out="${TMP}/${cmd//:/_}.out"
  dcb run --rm --no-deps migrate npm run --silent "$cmd" -- --help >"$out" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    ok_ "${cmd} -- --help termina com rc=0"
  else
    bad_ "${cmd} -- --help terminou com rc=${rc}:"
    tail -12 "$out" | sed 's/^/      /'
  fi

  # rc=0 com output vazio seria um verde falso: um `npm run` que não
  # encontra o comando também pode sair com 0 em certas versões.
  if grep -q 'admin-email' "$out"; then
    ok_ "${cmd} imprimiu a ajuda verdadeira"
  else
    bad_ "${cmd} saiu com 0 mas sem ajuda no output"
    tail -12 "$out" | sed 's/^/      /'
  fi

  if grep -qi 'ERR_MODULE_NOT_FOUND\|Cannot find module' "$out"; then
    bad_ "${cmd}: módulo em falta na imagem (a regressão original)"
  else
    ok_ "${cmd}: sem ERR_MODULE_NOT_FOUND"
  fi
done

# ═════════════════════════════════════════════════════════════════════════
# 3. Os ficheiros dos comandos auditados estão mesmo lá
# ═════════════════════════════════════════════════════════════════════════
# A auditoria corre no build; isto verifica a IMAGEM FINAL. São coisas
# diferentes — um COPY posterior podia, em teoria, apagar caminhos.
echo
echo "3. entrypoints presentes na imagem final"
# O rc do `docker compose run` é o do comando lá dentro. Um `[ -z "$out" ]`
# daria verde quando o container NEM ARRANCASSE — que foi o que esta
# verificação fez à primeira, e teria escondido a falha toda.
audit_out="${TMP}/audit-image.out"
dcb run --rm --no-deps --entrypoint sh migrate -c \
  'node deploy/docker/audit-tools-entrypoints.mjs /app' >"$audit_out" 2>&1
audit_rc=$?
if [ "$audit_rc" -eq 0 ] && grep -q 'módulos verificados' "$audit_out"; then
  ok_ "auditoria repetida na imagem final: $(grep -o '\[audit-tools\].*' "$audit_out" | tail -1)"
else
  bad_ "auditoria na imagem final falhou (rc=${audit_rc}):"
  tail -12 "$audit_out" | sed 's/^/      /'
fi

# ═════════════════════════════════════════════════════════════════════════
# 4. Nada foi criado
# ═════════════════════════════════════════════════════════════════════════
echo
echo "4. sem efeitos"
if [ -z "$(ls -A "${TMP}/pg/data" 2>/dev/null)" ]; then
  ok_ "nenhum cluster PostgreSQL foi arrancado"
else
  bad_ "apareceram dados em ${TMP}/pg/data — algo arrancou o PostgreSQL"
fi

echo
printf 'tools: %s%d ok%s, %s%d falhas%s\n' "$C_G" "$pass" "$C_0" "$C_R" "$fail" "$C_0"
[ "$fail" -eq 0 ] || exit 1
exit 0
