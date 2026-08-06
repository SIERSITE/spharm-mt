#!/usr/bin/env bash
# deploy/tests/live-build-args.sh
#
# CONSTRÓI MESMO os dois targets, com o Docker, pelo compose real.
#
# Não faz parte da suite automática (test-*.sh): precisa de Docker, de
# rede e de vários minutos. Corre-se à mão:
#
#   ./deploy/tests/live-build-args.sh
#
# Porquê um teste destes, havendo já asserções estáticas:
#
# A propagação SERVER_ACTIONS_ALLOWED_ORIGINS → stack.env → build arg do
# compose → ARG/ENV do Dockerfile → bundle do Next tem cinco elos, e um
# grep a cada ficheiro confirma cinco elos existentes, não uma corrente
# ligada. Já falhou duas vezes por causa disso: uma com o valor a nunca
# ser escrito (crase num heredoc matou o instalador antes), outra com o
# serviço `migrate` sem os args. As duas passavam nos testes de texto.
#
# O que se verifica aqui, com imagens verdadeiras:
#   1. `docker compose build web` produz uma imagem cujo
#      required-server-files.json contém as origens pedidas;
#   2. `docker compose build migrate` também constrói (o stage `migrator`
#      faz COPY --from=builder, portanto corre lá o `npm run build`);
#   3. com as duas variáveis vazias, os DOIS builds FALHAM — a rede de
#      segurança em produção é essa, e um build que passasse a vazio
#      entregaria uma imagem onde ninguém consegue autenticar-se.
#
# Nada é instalado no host: contexto em /tmp, imagens com tag própria,
# tudo removido no fim. Não toca em /opt/spharmmt nem em stack nenhuma.
#
# Saída: 0 tudo verificado · 1 alguma verificação falhou · 2 sem Docker

set -uo pipefail

REPO_ROOT=${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
COMPOSE_FILE="${REPO_ROOT}/deploy/docker/docker-compose.yml"
TAG="livebuildargs"
ORIGINS="127.0.0.1:8080,164.132.85.211"
PUBURL="http://164.132.85.211"

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }
ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }

command -v docker >/dev/null 2>&1 || { echo "docker não encontrado" >&2; exit 2; }
docker info >/dev/null 2>&1        || { echo "daemon docker não responde" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "compose não encontrado: ${COMPOSE_FILE}" >&2; exit 2; }

TMP=$(mktemp -d)

# O Docker no Windows não entende caminhos /tmp/... do Git Bash: o
# compose recusa o --env-file com "couldn't find env file". Os caminhos
# que vão PARA o docker (env-file, contexto, binds) passam a formato
# nativo; os que o próprio script usa ficam como estão.
TMP_D="$TMP"; REPO_D="$REPO_ROOT"; COMPOSE_D="$COMPOSE_FILE"
if [ -n "${MSYSTEM:-}" ] || uname -s 2>/dev/null | grep -qE 'MINGW|MSYS'; then
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  if command -v cygpath >/dev/null 2>&1; then
    TMP_D=$(cygpath -w "$TMP"); REPO_D=$(cygpath -w "$REPO_ROOT")
    COMPOSE_D=$(cygpath -w "$COMPOSE_FILE")
  fi
fi

cleanup() {
  docker image rm -f "spharmmt-app:${TAG}" "spharmmt-app:${TAG}-migrator" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# ── Ambiente mínimo para o compose resolver ──────────────────────────────
# O compose lê os `env_file` mesmo para construir. São ficheiros vazios de
# propósito: nada aqui precisa de credenciais, e é bom que não precise.
mkdir -p "${TMP}/env" "${TMP}/secrets" "${TMP}/proxy/conf" "${TMP}/proxy/certs" \
         "${TMP}/pg/init" "${TMP}/pg/data" "${TMP}/backups"
: >"${TMP}/env/platform.env"
: >"${TMP}/secrets/app.secrets.env"
: >"${TMP}/secrets/postgres.secrets.env"

# write_stack_env <origens> <public_app_url>
write_stack_env() {
  cat >"${TMP}/stack.env" <<EOF
APP_BUILD_CONTEXT=${REPO_D}
APP_IMAGE=spharmmt-app
APP_TAG=${TAG}
APP_REVISION=teste
INSTALL_CHROMIUM=0
SERVER_ACTIONS_ALLOWED_ORIGINS=$1
PUBLIC_APP_URL=$2
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
PROXY_HTTP_PORT=18099
EOF
}

dcb() {
  docker compose -f "$COMPOSE_D" --env-file "${TMP_D}/stack.env" \
    --profile tools -p "spharmmt-${TAG}" "$@"
}

echo "=== build real dos targets runner e migrator ==="
echo "repositório: ${REPO_ROOT}"
echo "contexto   : ${TMP}"
echo

# ═════════════════════════════════════════════════════════════════════════
# 1. Os build args chegam ao compose resolvido
# ═════════════════════════════════════════════════════════════════════════
echo "1. compose resolvido"
write_stack_env "$ORIGINS" "$PUBURL"

resolved=$(dcb config 2>/dev/null)
if [ -z "$resolved" ]; then
  bad_ "docker compose config falhou — nada mais pode ser verificado"
  echo; printf 'build args: %d ok, %d falhas\n' "$pass" "$fail"; exit 1
fi

# Por SERVIÇO. Um grep ao output inteiro passaria com o `web` a tê-lo e o
# `migrate` não — que foi a segunda falha real.
for svc in web migrate; do
  block=$(printf '%s\n' "$resolved" | awk -v s="  ${svc}:" '
    $0 == s { inb = 1; next }
    inb && /^  [a-z]/ { exit }
    inb { print }')
  for key in SERVER_ACTIONS_ALLOWED_ORIGINS PUBLIC_APP_URL; do
    if printf '%s\n' "$block" | grep -q "^ *${key}: "; then
      ok_ "${svc}: ${key} resolvido no compose"
    else
      bad_ "${svc}: ${key} AUSENTE ou vazio no compose resolvido"
    fi
  done
done

# ═════════════════════════════════════════════════════════════════════════
# 2. Build a sério dos dois targets
# ═════════════════════════════════════════════════════════════════════════
echo
echo "2. build (demora — npm ci + next build)"
build_log="${TMP}/build.log"
if dcb build web migrate >"$build_log" 2>&1; then
  ok_ "docker compose build web migrate concluiu"
else
  bad_ "o build falhou — últimas linhas:"
  tail -25 "$build_log" | sed 's/^/      /'
fi

for img in "spharmmt-app:${TAG}" "spharmmt-app:${TAG}-migrator"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    ok_ "imagem existe: ${img}"
  else
    bad_ "imagem NÃO foi produzida: ${img}"
  fi
done

# ═════════════════════════════════════════════════════════════════════════
# 3. As origens estão MESMO dentro do bundle
# ═════════════════════════════════════════════════════════════════════════
# Este é o ponto do teste todo. Tudo o resto pode estar certo e o valor
# não chegar ao artefacto — foi o sintoma na VPS.
echo
echo "3. conteúdo do bundle"
if docker image inspect "spharmmt-app:${TAG}" >/dev/null 2>&1; then
  # `tr -d ' \n'` primeiro: o required-server-files.json vem FORMATADO,
  # com espaço depois dos dois pontos e a lista partida por linhas. Um
  # grep de uma linha não casa e devolve vazio — que é indistinguível de
  # "o valor não entrou no bundle". Foi o que esta sonda fez à primeira,
  # e teria acusado um build correcto.
  allowed=$(docker run --rm --entrypoint sh "spharmmt-app:${TAG}" -c \
    'tr -d " \n" < .next/required-server-files.json | grep -o "\"allowedOrigins\":\[[^]]*\]"' 2>/dev/null)
  echo "      ${allowed:-(nada encontrado)}"

  # A sonda tem de conseguir LER o ficheiro. Sem isto, uma imagem sem
  # required-server-files.json daria os mesmos ✗ de uma imagem sem
  # origens, e a causa ficaria por descobrir.
  if [ -z "$allowed" ]; then
    bad_ "não foi possível ler allowedOrigins do bundle (sonda ou artefacto?)"
    docker run --rm --entrypoint sh "spharmmt-app:${TAG}" -c \
      'ls -l .next/required-server-files.json' 2>&1 | sed 's/^/      /'
  fi

  for want in "127.0.0.1:8080" "164.132.85.211"; do
    case "$allowed" in
      *"\"${want}\""*) ok_ "bundle autoriza ${want}" ;;
      *) bad_ "bundle NÃO autoriza ${want}" ;;
    esac
  done
  case "$allowed" in
    *'"*"'*) bad_ "bundle contém curinga global" ;;
    *) ok_ "bundle sem curinga global" ;;
  esac
  case "$allowed" in
    *intruso*) bad_ "bundle autoriza origem não pedida" ;;
    *) ok_ "bundle não inventa origens" ;;
  esac
else
  bad_ "sem imagem runner — conteúdo do bundle não verificável"
fi

# ═════════════════════════════════════════════════════════════════════════
# 4. Sem origens, os DOIS builds falham
# ═════════════════════════════════════════════════════════════════════════
# A camada de npm ci já está em cache, portanto isto é rápido. Falhar é o
# comportamento correcto: uma imagem sem origens é uma imagem onde
# nenhuma Server Action passa.
echo
echo "4. fail-fast com as variáveis vazias"
write_stack_env "" ""
for svc in web migrate; do
  if dcb build "$svc" >"${TMP}/fail-${svc}.log" 2>&1; then
    bad_ "${svc}: o build PASSOU sem origens — a imagem seria inutilizável"
  else
    if grep -qi 'SERVER_ACTIONS_ALLOWED_ORIGINS' "${TMP}/fail-${svc}.log"; then
      ok_ "${svc}: build falha e a mensagem nomeia a variável"
    else
      bad_ "${svc}: build falha, mas a mensagem não diz porquê"
      tail -12 "${TMP}/fail-${svc}.log" | sed 's/^/      /'
    fi
  fi
done

echo
printf 'build args: %s%d ok%s, %s%d falhas%s\n' "$C_G" "$pass" "$C_0" "$C_R" "$fail" "$C_0"
[ "$fail" -eq 0 ] || exit 1
exit 0
