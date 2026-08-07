#!/usr/bin/env bash
# deploy/tests/live-admin-api.sh
#
# Percorre a API de administração contra uma stack self-hosted a sério,
# pela MESMA sequência de chamadas HTTP que o Admin Wizard faz:
#
#   POST /api/admin/v1/tenants                        (criar cliente)
#   POST /api/admin/v1/tenants/{slug}/farmacias
#   POST /api/admin/v1/tenants/{slug}/users
#   POST /api/admin/v1/tenants/{slug}/agent-package
#   GET  /agent-base/spharmmt-agent-base.zip          (descarregar template)
#
# Porque não a GUI: o wizard é WinForms e não se automatiza sem sessão
# gráfica. O que se testa aqui é tudo o que ele envia e recebe — a
# camada onde os problemas aparecem. A GUI em si fica por verificar, e
# está dito.
#
# Verifica também a fronteira de privilégio e o silêncio dos logs:
#   · sem token → 401; token errado → 401
#   · criação repetida → 409 (não 500)
#   · limite de taxa → 429
#   · senha e ingest key aparecem UMA vez, na resposta, e em log nenhum
#   · o web e o worker não têm credenciais de superutilizador
#
# Cluster descartável em /tmp, project name e rede próprios. Não toca em
# /opt/spharmmt, em tenants reais, na Vercel nem no Neon.
#
# Saída: 0 tudo verificado · 1 alguma verificação falhou · 2 sem Docker

set -uo pipefail

REPO_ROOT=${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
COMPOSE_FILE="${REPO_ROOT}/deploy/docker/docker-compose.yml"
TAG="e2eadminapi"
PROJECT="spharmmt-${TAG}"
NET="spharmmt-${TAG}"
HTTP_PORT=18096

SLUG="api-teste"
ADMIN_EMAIL="admin@api.teste"
TOKEN="token-de-teste-descartavel-0123456789"

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }
ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
note() { printf '      %s\n' "$1"; }

command -v docker >/dev/null 2>&1 || { echo "docker não encontrado" >&2; exit 2; }
docker info >/dev/null 2>&1        || { echo "daemon docker não responde" >&2; exit 2; }

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
  echo "cluster descartável destruído"
}
trap cleanup EXIT

mkdir -p "${TMP}/env" "${TMP}/secrets" "${TMP}/proxy/conf" "${TMP}/proxy/certs" \
         "${TMP}/pg/init" "${TMP}/pg/data" "${TMP}/backups" "${TMP}/agent-base"
cp "${REPO_ROOT}"/deploy/docker/postgres/init/*.sh "${TMP}/pg/init/"
cp "${REPO_ROOT}/deploy/docker/proxy/spharmmt.conf" "${TMP}/proxy/conf/"

# ZIP base de mentira. O que se testa é o TRANSPORTE — que o nginx serve
# o ficheiro em /agent-base/ e que o URL devolvido pela API aponta lá.
# Usar o base verdadeiro (~30 MB) tornava o teste lento sem provar mais
# nada: o conteúdo do pacote é assunto do build do agent.
printf 'PK\003\004conteudo-de-teste-nao-e-um-agent-real' >"${TMP}/agent-base/spharmmt-agent-base.zip"
printf 'nao-devia-ser-servido' >"${TMP}/agent-base/segredo.txt"

SU_PASS="su-$(date +%s)-descartavel"
APP_PASS="app-$(date +%s)-descartavel"
PROV_PASS="prov-$(date +%s)-descartavel"

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
TENANT_FALLBACK_ENABLED=1
TENANT_DB_SSLMODE=disable
TENANT_DB_HOST=postgres
TENANT_DB_PORT=5432
AGENT_BASE_ZIP_URL=http://127.0.0.1:${HTTP_PORT}/agent-base/spharmmt-agent-base.zip
# Escrita pelo install-platform.sh numa VPS real. É daqui que sai o
# `saas.endpoint` do agent.config.json quando o operador não indica um.
# Sem ela o `agent-package` responde 500 endpoint_not_configured — de
# propósito: um ZIP com o endereço errado só dá sintoma na farmácia,
# semanas depois, como "os dados não aparecem".
SPHARMMT_PUBLIC_ENDPOINT=http://127.0.0.1:${HTTP_PORT}
EOF

cat >"${TMP}/secrets/app.secrets.env" <<EOF
POSTGRES_APP_PASSWORD=${APP_PASS}
AUTH_SECRET=e2e-auth-secret-descartavel-0123456789
TENANT_ENCRYPTION_SECRET=e2e-tenant-encryption-descartavel-0123456789
EMAIL_CONFIG_SECRET=e2e-email-secret-descartavel-0123456789
CRON_SECRET=e2e-cron-descartavel
ADMIN_API_TOKENS=${TOKEN}
# Role CREATEDB+CREATEROLE (sem superuser): e com ele que o `web` cria a
# base de um cliente novo quando o pedido chega pela API.
POSTGRES_PROVISIONER_PASSWORD=${PROV_PASS}
EOF
printf 'POSTGRES_SUPERUSER_PASSWORD=%s\n' "$SU_PASS" >"${TMP}/secrets/tools.secrets.env"
cat >"${TMP}/secrets/postgres.secrets.env" <<EOF
POSTGRES_PASSWORD=${SU_PASS}
POSTGRES_APP_PASSWORD=${APP_PASS}
POSTGRES_PROVISIONER_PASSWORD=${PROV_PASS}
EOF

cat >"${TMP}/stack.env" <<EOF
APP_BUILD_CONTEXT=${REPO_D}
APP_IMAGE=spharmmt-app
APP_TAG=${TAG}
APP_REVISION=e2e-api
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
AGENT_BASE_DIR=${TMP_D}/agent-base
BACKUP_DIR=${TMP_D}/backups
PROXY_BIND=127.0.0.1
PROXY_HTTP_PORT=${HTTP_PORT}
EOF

docker network create "$NET" >/dev/null 2>&1 || true

BASE="http://127.0.0.1:${HTTP_PORT}"

# api <método> <caminho> [corpo] [token]
# Escreve o corpo em $API_BODY e devolve o código HTTP em $API_CODE.
API_BODY=""; API_CODE=""
api() {
  # `${4-$TOKEN}` e NAO `${4:-$TOKEN}`: com dois-pontos, passar ""
  # explicitamente devolvia o default e o teste "sem token" ia
  # autenticado -- deu um 200 que parecia falha de seguranca e era bug
  # do teste.
  local method=$1 path=$2 body=${3:-} tok=${4-$TOKEN}
  # Corpo e código na MESMA resposta, sem passar por ficheiro. O `-o
  # ficheiro` não servia: o script exporta MSYS_NO_PATHCONV=1 (preciso
  # para o docker), e com ele o curl do Windows escrevia num caminho que
  # o MSYS depois não lia. Resultado: TODOS os corpos vinham vazios, e
  # quatro asserções falhavam a acusar a API de não devolver campos que
  # ela devolvia.
  local args=(-s -w $'\n%{http_code}' -X "$method" "${BASE}${path}" --max-time 300)
  [ -n "$tok" ] && args+=(-H "Authorization: Bearer ${tok}")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  local resp; resp=$(curl "${args[@]}" 2>/dev/null)
  API_CODE=$(printf '%s' "$resp" | tail -1 | tr -d '\r\n')
  API_BODY=$(printf '%s' "$resp" | sed '$d')
}

# Parsing JSON a sério, com o Node. O `grep -o` anterior não lidava com
# espaços, quebras de linha nem escapes — e um campo não encontrado é
# indistinguível de um campo vazio, que é precisamente a distinção que
# aqui interessa.
json_str() {
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const v = process.argv[1].split(".").reduce((a, k) => (a == null ? a : a[k]), JSON.parse(s));
        process.stdout.write(v == null ? "" : String(v));
      } catch { process.stdout.write(""); }
    });
  ' "$2" 2>/dev/null
}

echo "=== API de administração contra stack self-hosted ==="
echo "projecto: ${PROJECT} · ${BASE}"
echo

# ═════════════════════════════════════════════════════════════════════════
echo "1. stack"
if dcb build web migrate >"${TMP}/build.log" 2>&1; then
  ok_ "imagens construídas"
else
  bad_ "build falhou"; tail -20 "${TMP}/build.log" | sed 's/^/      /'
  printf 'admin-api: %d ok, %d falhas\n' "$pass" "$fail"; exit 1
fi

dcb up -d postgres >/dev/null 2>&1
h=""
for _ in $(seq 1 60); do
  h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "pg-${TAG}" 2>/dev/null || echo none)
  [ "$h" = "healthy" ] && break
  sleep 2
done
[ "$h" = "healthy" ] && ok_ "PostgreSQL healthy" || bad_ "PostgreSQL não ficou healthy"

if dcb run --rm migrate >"${TMP}/migrate.log" 2>&1; then
  ok_ "migrations aplicadas"
else
  bad_ "migrations falharam"; tail -15 "${TMP}/migrate.log" | sed 's/^/      /'
fi

dcb up -d web worker proxy >/dev/null 2>&1
code=""
for _ in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/healthz" 2>/dev/null | tr -d '\r\n')
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] && ok_ "proxy e aplicação de pé" || bad_ "stack não respondeu (${code:-nada})"

# ═════════════════════════════════════════════════════════════════════════
echo
echo "2. autenticação"
api GET /api/admin/v1/ping "" ""
[ "$API_CODE" = "401" ] && ok_ "sem token → 401" || bad_ "sem token devolveu ${API_CODE} (esperava 401)"

api GET /api/admin/v1/ping "" "token-errado"
[ "$API_CODE" = "401" ] && ok_ "token errado → 401" || bad_ "token errado devolveu ${API_CODE}"

api GET /api/admin/v1/ping
[ "$API_CODE" = "200" ] && ok_ "token válido → 200" || bad_ "token válido devolveu ${API_CODE}: ${API_BODY}"

# ═════════════════════════════════════════════════════════════════════════
echo
echo "3. validação de entrada"
api POST /api/admin/v1/tenants '{"slug":"","name":"x","adminEmail":"a@b.pt"}'
[ "$API_CODE" = "400" ] && ok_ "slug vazio → 400" || bad_ "slug vazio devolveu ${API_CODE}"

api POST /api/admin/v1/tenants '{"slug":"MAIUSCULAS","name":"x","adminEmail":"a@b.pt","provider":"local"}'
[ "$API_CODE" = "400" ] && ok_ "slug inválido → 400" || bad_ "slug inválido devolveu ${API_CODE}"

api POST /api/admin/v1/tenants '{"slug":"ok-slug","name":"x","adminEmail":"nao-e-email","provider":"local"}'
[ "$API_CODE" = "400" ] && ok_ "email inválido → 400" || bad_ "email inválido devolveu ${API_CODE}"

api POST /api/admin/v1/tenants '{"slug":"ok-slug","name":"x","adminEmail":"a@b.pt","provider":"inventado"}'
[ "$API_CODE" = "400" ] && ok_ "provider inválido → 400" || bad_ "provider inválido devolveu ${API_CODE}"

# ═════════════════════════════════════════════════════════════════════════
echo
echo "4. dry-run"
api POST /api/admin/v1/tenants \
  "{\"slug\":\"${SLUG}\",\"name\":\"Cliente API\",\"adminEmail\":\"${ADMIN_EMAIL}\",\"provider\":\"local\",\"createDb\":true,\"dryRun\":true}"
if [ "$API_CODE" = "200" ]; then ok_ "dry-run → 200"; else
  bad_ "dry-run devolveu ${API_CODE}: ${API_BODY}"
fi
api GET /api/admin/v1/tenants
if printf '%s' "$API_BODY" | grep -q "\"${SLUG}\""; then
  bad_ "o dry-run CRIOU o tenant"
else
  ok_ "dry-run não criou nada"
fi

# ═════════════════════════════════════════════════════════════════════════
echo
echo "5. criação"
api POST /api/admin/v1/tenants \
  "{\"slug\":\"${SLUG}\",\"name\":\"Cliente API\",\"adminEmail\":\"${ADMIN_EMAIL}\",\"provider\":\"local\",\"createDb\":true,\"farmacias\":[\"Farmácia Um\"]}"
CREATED_BODY="$API_BODY"
if [ "$API_CODE" = "201" ]; then ok_ "criação → 201"; else
  bad_ "criação devolveu ${API_CODE}: ${API_BODY}"
  # Um 500 com corpo vazio não diz nada. O log da aplicação diz — e sem
  # isto o diagnóstico obrigava a repetir a montagem toda da stack.
  note "── log da aplicação ──"
  docker logs "app-${TAG}" 2>&1 | tail -30 | sed 's/^/      /'
fi

ADMIN_PW=$(json_str "$CREATED_BODY" adminPassword)
INGEST_KEY=$(json_str "$CREATED_BODY" ingestKey)
if [ -n "$ADMIN_PW" ]; then ok_ "resposta traz a senha do admin (uma vez)"; else
  bad_ "resposta sem senha do admin"; note "corpo: ${CREATED_BODY}"
fi
if [ -n "$INGEST_KEY" ]; then ok_ "resposta traz a ingest key (uma vez)"; else
  bad_ "resposta sem ingest key"; note "corpo: ${CREATED_BODY}"
fi

dbs=$(docker exec "pg-${TAG}" psql -U postgres -tAc \
  "SELECT datname FROM pg_database WHERE datname LIKE '%api_teste%'" 2>/dev/null | tr -d '\r')
[ -n "$dbs" ] && ok_ "base do tenant criada: $(echo "$dbs" | tr '\n' ' ')" || bad_ "base do tenant não foi criada"

api GET "/api/admin/v1/tenants/${SLUG}/status"
if [ "$API_CODE" = "200" ] && printf '%s' "$API_BODY" | grep -qi 'ACTIVE'; then
  ok_ "tenant ACTIVE no control plane"
else
  bad_ "status devolveu ${API_CODE}"; note "corpo: ${API_BODY}"
fi

# ═════════════════════════════════════════════════════════════════════════
echo
echo "6. operação repetida"
api POST /api/admin/v1/tenants \
  "{\"slug\":\"${SLUG}\",\"name\":\"Cliente API\",\"adminEmail\":\"${ADMIN_EMAIL}\",\"provider\":\"local\",\"createDb\":true}"
if [ "$API_CODE" = "409" ]; then
  ok_ "criação repetida → 409 (recusa clara, não 500)"
else
  bad_ "criação repetida devolveu ${API_CODE} — devia ser 409"
fi

# ═════════════════════════════════════════════════════════════════════════
echo
echo "7. farmácia e utilizador"
api POST "/api/admin/v1/tenants/${SLUG}/farmacias" '{"nome":"Farmácia Dois"}'
[ "$API_CODE" = "200" ] || [ "$API_CODE" = "201" ] \
  && ok_ "farmácia criada (${API_CODE})" || bad_ "farmácia devolveu ${API_CODE}: ${API_BODY}"

api POST "/api/admin/v1/tenants/${SLUG}/users" \
  '{"email":"operador@api.teste","nome":"Operador","role":"ADMINISTRADOR"}'
USER_BODY="$API_BODY"
[ "$API_CODE" = "200" ] || [ "$API_CODE" = "201" ] \
  && ok_ "utilizador criado (${API_CODE})" || bad_ "utilizador devolveu ${API_CODE}: ${API_BODY}"
USER_PW=$(json_str "$USER_BODY" password)

# ═════════════════════════════════════════════════════════════════════════
echo
echo "8. pacote do agent"
api POST "/api/admin/v1/tenants/${SLUG}/agent-package" \
  '{"farmacia":"Farmácia Um","rotate":true}'
PKG_BODY="$API_BODY"
if [ "$API_CODE" = "200" ] || [ "$API_CODE" = "201" ]; then
  ok_ "agent-package → ${API_CODE}"
else
  bad_ "agent-package devolveu ${API_CODE}: ${API_BODY}"
fi

BASE_URL=$(json_str "$PKG_BODY" baseAgentUrl)
if [ -n "$BASE_URL" ]; then
  ok_ "servidor devolveu baseAgentUrl: ${BASE_URL}"
else
  bad_ "baseAgentUrl vazio — o wizard não conseguiria montar o ZIP"
  note "corpo: ${PKG_BODY}"
fi

if [ -n "$BASE_URL" ]; then
  # Sem `-o ficheiro`, pela mesma razão do `api()`: com MSYS_NO_PATHCONV
  # o curl escrevia num caminho que o MSYS não lia, e o teste dizia
  # "download falhou (200)" — código certo, ficheiro invisível.
  # `%{size_download}` responde à pergunta real: veio conteúdo?
  dl=$(curl -s "$BASE_URL" -w $'\n%{http_code} %{size_download}' 2>/dev/null | tail -1 | tr -d '\r')
  dl_code=${dl%% *}
  dl_size=${dl##* }
  if [ "$dl_code" = "200" ] && [ "${dl_size:-0}" -gt 0 ]; then
    ok_ "template base descarregado do próprio servidor (${dl_size} bytes)"
  else
    bad_ "download do template falhou (código=${dl_code} bytes=${dl_size})"
  fi
fi

# A pasta é servida por nginx: só .zip. Um ficheiro deixado lá por engano
# não pode ficar na Internet.
leak=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/agent-base/segredo.txt" 2>/dev/null | tr -d '\r\n')
[ "$leak" != "200" ] && ok_ "não-ZIP em /agent-base/ não é servido (${leak})" \
                     || bad_ "/agent-base/segredo.txt foi servido — fuga de ficheiros"

trav=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/agent-base/../etc/passwd" 2>/dev/null | tr -d '\r\n')
[ "$trav" != "200" ] && ok_ "travessia de directório recusada (${trav})" \
                     || bad_ "travessia de directório serviu conteúdo"

# ═════════════════════════════════════════════════════════════════════════
echo
echo "9. limite de taxa"
# Já foram gastos 2 pedidos (dry-run + criação) + 1 (repetida) = 3 de 5.
rl=""
for i in 1 2 3 4; do
  api POST /api/admin/v1/tenants \
    "{\"slug\":\"rl-${i}\",\"name\":\"RL\",\"adminEmail\":\"rl@t.pt\",\"provider\":\"local\",\"createDb\":true,\"dryRun\":true}"
  rl="$API_CODE"
  [ "$rl" = "429" ] && break
done
if [ "$rl" = "429" ]; then
  ok_ "limite de taxa activo → 429"
else
  bad_ "não houve 429 depois de 7 criações (último: ${rl})"
fi

# ═════════════════════════════════════════════════════════════════════════
echo
echo "10. segredos fora dos logs"
logs_web=$(docker logs "app-${TAG}" 2>&1 | tr -d '\r')
logs_worker=$(docker logs "worker-${TAG}" 2>&1 | tr -d '\r')
all_logs="${logs_web}${logs_worker}"

check_absent() {
  local what=$1 value=$2
  if [ -z "$value" ]; then note "sem ${what} para verificar (não foi devolvido)"; return; fi
  if printf '%s' "$all_logs" | grep -qF "$value"; then
    bad_ "${what} APARECE nos logs"
  else
    ok_ "${what} não aparece nos logs"
  fi
}
check_absent "senha do admin" "$ADMIN_PW"
check_absent "ingest key"     "$INGEST_KEY"
check_absent "senha do utilizador" "$USER_PW"
check_absent "password de superutilizador" "$SU_PASS"

if printf '%s' "$all_logs" | grep -q '"at":"admin.tenants.create"'; then
  ok_ "há registo de auditoria da criação"
else
  bad_ "não há registo de auditoria da criação"
fi
if printf '%s' "$all_logs" | grep -qE 'postgresql://[^ ]*:[^@ ]+@'; then
  bad_ "há connection string com password nos logs"
else
  ok_ "sem connection strings com password nos logs"
fi

# ═════════════════════════════════════════════════════════════════════════
echo
echo "11. fronteira de privilégio"
for svc in "app-${TAG}" "worker-${TAG}"; do
  envdump=$(docker exec "$svc" env 2>/dev/null | tr -d '\r')
  printf '%s' "$envdump" | grep -q 'POSTGRES_ADMIN_URL=' \
    && bad_ "${svc} tem POSTGRES_ADMIN_URL" || ok_ "${svc} sem POSTGRES_ADMIN_URL"
  printf '%s' "$envdump" | grep -qF "$SU_PASS" \
    && bad_ "${svc} tem a password de superutilizador" || ok_ "${svc} sem password de superutilizador"
done

echo
printf 'admin-api: %s%d ok%s, %s%d falhas%s\n' "$C_G" "$pass" "$C_0" "$C_R" "$fail" "$C_0"
[ "$fail" -eq 0 ] || exit 1
exit 0
