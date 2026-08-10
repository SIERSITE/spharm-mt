#!/usr/bin/env bash
# deploy/tests/test-agent-auth-headers.sh
#
# Prova que as credenciais do Agent chegam à aplicação, e que continuam a
# NÃO chegar em todo o resto.
#
# O defeito que este teste fixa: o proxy fazia
#     proxy_set_header X-Tenant-Slug "";
# em todo o lado. A intenção estava certa para tráfego de browser — a
# resolução de tenant é feita pelo servidor e aceitá-la do cliente
# deixaria qualquer um escolher o seu tenant. Mas apanhava também a API
# dos Agents, onde o X-Tenant-Slug é CREDENCIAL e não privilégio: a
# ingest key é comparada por bcrypt contra o hash daquele tenant.
#
# Resultado: POST /api/outbox/v1/heartbeat e GET /api/ingest/v1/farmacias
# respondiam 401 missing_credentials com a chave correcta. A chave
# chegava; o tenant não.
#
# Estratégia: nginx real, com a configuração real da plataforma, e um
# upstream que devolve o que recebeu. Sem base de dados e sem aplicação —
# o defeito está no transporte, e é aí que tem de ser medido. Isto prova
# o contrato de cabeçalhos; a validação da chave (bcrypt contra o hash do
# tenant) é do lado da aplicação e não é o que aqui se testa.
#
# Uso: bash deploy/tests/test-agent-auth-headers.sh

set -uo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROXY="${REPO}/deploy/docker/proxy"
NAME="spharmmt-authtest-$$"
PORT=18288
SLUG="grupo-silveira"
KEY="ba0dd0dc0ffee0123456789abcdef012"

pass=0; fail=0
ok_()  { pass=$((pass+1)); printf '  [OK]    %s\n' "$1"; }
bad_() { fail=$((fail+1)); printf '  [FALHA] %s\n' "$1"; }

TMP=$(mktemp -d)
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

# Configuração real da plataforma, tal como é instalada na VPS.
cp "${PROXY}/spharmmt.conf" "${PROXY}/spharmmt-proxy-common.inc" "$TMP/"

# Upstream de teste: responde no porto 3000 e devolve o que recebeu. É o
# que permite ver o pedido pelos olhos da aplicação.
cat >"${TMP}/zz-upstream-echo.conf" <<'EOF'
server {
    listen 3000;
    server_name _;
    default_type text/plain;
    location / {
        return 200 "slug=[$http_x_tenant_slug] auth=[$http_authorization] host=[$http_host] proto=[$http_x_forwarded_proto]\n";
    }
}
EOF

if (exec 3<>/dev/tcp/127.0.0.1/${PORT}) 2>/dev/null; then
  exec 3<&- 3>&-; echo "RECUSADO: porta ${PORT} ocupada." >&2; exit 2
fi

TMPW=$TMP
command -v cygpath >/dev/null 2>&1 && TMPW=$(cygpath -w "$TMP")
export MSYS_NO_PATHCONV=1

docker run -d --name "$NAME" --add-host web:127.0.0.1 \
  -p "127.0.0.1:${PORT}:80" \
  -v "${TMPW}:/etc/nginx/conf.d:ro" \
  nginx:alpine >/dev/null 2>&1 || { echo "falha a arrancar o nginx"; exit 1; }

for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | tr -d '\r\n')
  [ "$code" = "200" ] && break
  sleep 1
done
if [ "${code:-}" != "200" ]; then
  echo "nginx não respondeu; logs:"; docker logs "$NAME" 2>&1 | tail -10; exit 1
fi

# Envia sempre AS MESMAS credenciais, como faz o agent rev46.
peek() {
  curl -s -X "$1" "http://127.0.0.1:${PORT}$2" \
    -H "Authorization: Bearer ${KEY}" \
    -H "X-Tenant-Slug: ${SLUG}" 2>/dev/null
}

echo "=== a API dos Agents recebe as duas metades da credencial ==="
for alvo in "POST /api/outbox/v1/heartbeat" "GET /api/ingest/v1/farmacias" "POST /api/ingest/v1/bootstrap/products"; do
  metodo=${alvo%% *}; caminho=${alvo#* }
  body=$(peek "$metodo" "$caminho")
  if printf '%s' "$body" | grep -q "slug=\[${SLUG}\]"; then
    ok_ "${alvo} — X-Tenant-Slug chega"
  else
    bad_ "${alvo} — X-Tenant-Slug perdido: ${body}"
  fi
  if printf '%s' "$body" | grep -q "auth=\[Bearer ${KEY}\]"; then
    ok_ "${alvo} — Authorization chega"
  else
    bad_ "${alvo} — Authorization perdida: ${body}"
  fi
done

echo
echo "=== o resto da aplicação continua a NÃO aceitar tenant do cliente ==="
for caminho in "/" "/login" "/dashboard" "/api/admin/v1/tenants"; do
  body=$(peek GET "$caminho")
  if printf '%s' "$body" | grep -q 'slug=\[\]'; then
    ok_ "${caminho} — X-Tenant-Slug descartado"
  else
    bad_ "${caminho} — cliente conseguiu impor o tenant: ${body}"
  fi
done

echo
echo "=== os cabeçalhos herdados não se perderam ==="
# A armadilha do nginx: um proxy_set_header dentro de uma location cancela
# a herança de TODOS os do nível acima. Se as novas location da API dos
# Agents a tivessem accionado, o pedido chegava sem Host nem
# X-Forwarded-Proto e a aplicação passava a resolver o tenant errado.
body=$(peek GET /api/ingest/v1/farmacias)
if printf '%s' "$body" | grep -q 'host=\[127.0.0.1'; then
  ok_ "Host preservado na API dos Agents"
else
  bad_ "Host perdido — herança de proxy_set_header cancelada: ${body}"
fi
if printf '%s' "$body" | grep -qE 'proto=\[(http|https)\]'; then
  ok_ "X-Forwarded-Proto preservado na API dos Agents"
else
  bad_ "X-Forwarded-Proto perdido: ${body}"
fi

echo
echo "=== sem cabeçalho do cliente, nada é inventado ==="
body=$(curl -s "http://127.0.0.1:${PORT}/api/ingest/v1/farmacias" 2>/dev/null)
if printf '%s' "$body" | grep -q 'slug=\[\]'; then
  ok_ "pedido sem X-Tenant-Slug chega sem slug"
else
  bad_ "slug apareceu do nada: ${body}"
fi

echo
printf '%d ok, %d falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
