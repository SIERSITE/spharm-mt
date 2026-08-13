#!/usr/bin/env bash
# deploy/tests/test-proxy-admin-allowlist.sh
#
# Prova que só as três agregações do Agent passam por /api/admin/ no
# domínio dos Agents, e que todo o resto continua a devolver 404.
#
# O defeito que isto fixa: o full-sync parava em 6/9. As fases 7-9 chamam
# /api/admin/pipeline/aggregate-*, que autenticam com a ingest key do
# agent e não com o token administrativo, mas vivem sob um prefixo que o
# vhost dos Agents bloqueia por inteiro. O agent recebia 404 e as fases
# seguintes não corriam.
#
# O risco do lado oposto — abrir /api/admin/pipeline/ inteiro — é o que
# a segunda metade deste teste guarda: uma rota administrativa nova
# acrescentada a esse prefixo ficaria exposta ao domínio por onde entram
# os agents, sem ninguém decidir isso.
#
# nginx real, configuração real, upstream que ecoa. Sem base de dados.
#
# Uso: bash deploy/tests/test-proxy-admin-allowlist.sh

set -uo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROXY="${REPO}/deploy/docker/proxy"
NAME="spharmmt-adminallow-$$"
PORT=18289
SLUG="grupo-silveira"
KEY="ba0dd0dc0ffee0123456789abcdef012"

pass=0; fail=0
ok_()  { pass=$((pass+1)); printf '  [OK]    %s\n' "$1"; }
bad_() { fail=$((fail+1)); printf '  [FALHA] %s\n' "$1"; }

TMP=$(mktemp -d)
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

# O vhost TLS é o que tem a separação de domínios. Serve-se aqui em texto
# simples: o que se testa é o roteamento, não o TLS.
#
# Duas adaptações, ambas de transporte e nenhuma de roteamento:
#   · 443 passa a 80 e o TLS sai (não há certificados neste teste);
#   · o server que redirecciona :80 para https deixa de responder por
#     estes nomes — senão apanhava todos os pedidos antes de chegarem ao
#     vhost da aplicação, e o teste media o redireccionamento.
# As `location` ficam exactamente como estão em produção.
sed -e 's/listen 443 ssl;/listen 80;/' \
    -e 's/server_name admin.spharmmt.com app.spharmmt.com;/server_name so-para-redireccionar.invalid;/' \
    -e '/http2 on;/d' \
    -e '/ssl_certificate/d' -e '/ssl_protocols/d' -e '/ssl_ciphers/d' \
    -e '/ssl_prefer_server_ciphers/d' -e '/ssl_session/d' \
    "${PROXY}/spharmmt-tls.conf" > "${TMP}/spharmmt-tls.conf"
cp "${PROXY}/spharmmt-proxy-common.inc" "$TMP/"
# O map $forwarded_proto vive no vhost não-TLS e é usado pelo .inc que os
# dois partilham. Sem ele o nginx recusa arrancar.
awk '/^map /,/^}/' "${PROXY}/spharmmt.conf" > "${TMP}/00-maps.conf"

cat >"${TMP}/zz-upstream-echo.conf" <<'EOF'
upstream spharmmt_web { server 127.0.0.1:3000; }
server {
    listen 3000;
    server_name _;
    default_type text/plain;
    location / { return 200 "uri=[$request_uri] slug=[$http_x_tenant_slug] auth=[$http_authorization] host=[$http_host] proto=[$http_x_forwarded_proto]\n"; }
}
EOF

TMPW=$TMP
command -v cygpath >/dev/null 2>&1 && TMPW=$(cygpath -w "$TMP")
export MSYS_NO_PATHCONV=1

docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:80" \
  -v "${TMPW}:/etc/nginx/conf.d:ro" nginx:alpine >/dev/null 2>&1 \
  || { echo "falha a arrancar o nginx"; exit 1; }

for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: app.spharmmt.com' \
         "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | tr -d '\r\n')
  [ "$code" = "200" ] && break
  sleep 1
done
if [ "${code:-}" != "200" ]; then
  echo "nginx não respondeu; logs:"; docker logs "$NAME" 2>&1 | tail -20; exit 1
fi

codigo() {
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: $1" \
    "http://127.0.0.1:${PORT}$2" 2>/dev/null | tr -d '\r\n'
}

echo "=== as rotas do Agent PASSAM no domínio dos Agents ==="
# O critério da allowlist, escrito no spharmmt-tls.conf: autentica por
# `withIntegrationAuth` (a ingest key, não o token administrativo) E é o
# agent que a invoca. Quatro rotas sob /api/admin/ cumprem-no.
#
# `record` foi acrescentado depois das três agregações. Estava a devolver
# 404 e ninguém dava por isso, porque o agent apanha a excepção, escreve
# um aviso no log local e termina com OK — deixando `PipelineRun` vazio.
# É essa tabela que diz que dias já correram, e sem ela o catch-up do
# pipeline diário não tem fonte de verdade.
for r in aggregate-month aggregate-compras aggregate-devolucoes record; do
  c=$(codigo app.spharmmt.com "/api/admin/pipeline/${r}")
  if [ "$c" != "404" ]; then ok_ "${r} chega à aplicação (${c})"
  else bad_ "${r} devolve 404 no domínio dos Agents"; fi
done

echo
echo "=== o resto de /api/admin/ continua 404 ==="
# Estas usam o token ADMINISTRATIVO, não a ingest key. Nunca devem estar
# acessíveis pelo domínio por onde entram os Agents.
for p in /api/admin/v1/tenants /api/admin/enrichment-health \
         /api/admin/v1/tenants/x/agent-package; do
  c=$(codigo app.spharmmt.com "$p")
  if [ "$c" = "404" ]; then ok_ "${p} → 404"
  else bad_ "${p} EXPOSTO ao domínio dos Agents (${c})"; fi
done

echo
echo "=== a allowlist cobre TODAS as rotas admin que o agent autentica ==="
# A asserção que impede a próxima ocorrência. Em vez de manter à mão a
# lista de rotas permitidas, deriva-se do código: toda a rota sob
# /api/admin/ que use `withIntegrationAuth` é, por definição, chamada
# pelo agent com a ingest key — e portanto tem de estar na allowlist.
# Uma rota nova desse tipo falha aqui em vez de falhar em produção com
# um erro que o agent engole.
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONF="${REPO_ROOT}/deploy/docker/proxy/spharmmt-tls.conf"
while IFS= read -r rota_file; do
  rota=$(printf '%s' "$rota_file" | sed "s|${REPO_ROOT}/app||; s|/route.ts$||")
  if grep -qF "location = ${rota} {" "$CONF"; then
    ok_ "${rota} está na allowlist do nginx"
  else
    bad_ "${rota} usa withIntegrationAuth mas NÃO está na allowlist — o agent vai receber 404"
  fi
done < <(grep -rl "withIntegrationAuth" "${REPO_ROOT}/app/api/admin/" 2>/dev/null || true)

echo
echo "=== a allowlist é exacta, não um prefixo ==="
# Se alguém trocar as três location por `^~ /api/admin/pipeline/`, estes
# caminhos passam a responder — e é isso que este bloco impede.
for p in /api/admin/pipeline/ /api/admin/pipeline/qualquer-coisa \
         /api/admin/pipeline/aggregate-month/extra; do
  c=$(codigo app.spharmmt.com "$p")
  if [ "$c" = "404" ]; then ok_ "${p} → 404 (prefixo não foi aberto)"
  else bad_ "${p} respondeu ${c} — a allowlist virou prefixo"; fi
done

echo
echo "=== as tres agregacoes preservam a CREDENCIAL COMPLETA ==="
# O 404 estava resolvido e mesmo assim davam 401 missing_credentials: o
# include poe X-Tenant-Slug a partir de $spharmmt_tenant_slug, que o
# server poe a "". Uma location que nao reponha a variavel entrega o
# pedido sem o slug, e a ingest key e comparada por bcrypt contra o hash
# DAQUELE tenant. Metade da credencial chegava.
corpo() {
  curl -s -X POST -H "Host: app.spharmmt.com" \
    -H "Authorization: Bearer ${KEY}" -H "X-Tenant-Slug: ${SLUG}" \
    "http://127.0.0.1:${PORT}$1" 2>/dev/null
}
for r in aggregate-month aggregate-compras aggregate-devolucoes record; do
  b=$(corpo "/api/admin/pipeline/${r}")
  if printf '%s' "$b" | grep -q "slug=\[${SLUG}\]"; then ok_ "${r} - X-Tenant-Slug chega"
  else bad_ "${r} - X-Tenant-Slug PERDIDO: ${b}"; fi
  if printf '%s' "$b" | grep -q "auth=\[Bearer ${KEY}\]"; then ok_ "${r} - Authorization chega"
  else bad_ "${r} - Authorization perdida: ${b}"; fi
  # A armadilha do nginx: um proxy_set_header dentro da location
  # cancelaria a heranca de todos os do nivel acima.
  if printf '%s' "$b" | grep -q 'host=\[app.spharmmt.com\]'; then ok_ "${r} - Host preservado"
  else bad_ "${r} - Host perdido (heranca cancelada): ${b}"; fi
done

echo
echo "=== o slug NAO se propaga para onde deve ficar vazio ==="
# O simetrico do teste acima: a aplicacao web nunca pode aceitar o tenant
# do cliente, senao qualquer um escolhe o seu.
for caminho in / /login /dashboard /stock; do
  b=$(corpo "$caminho")
  if printf '%s' "$b" | grep -q 'slug=\[\]'; then ok_ "${caminho} - slug descartado"
  else bad_ "${caminho} - cliente impos o tenant: ${b}"; fi
done
# E as rotas de ingestao continuam a receber, como sempre receberam.
for caminho in /api/ingest/v1/farmacias /api/outbox/v1/heartbeat; do
  b=$(corpo "$caminho")
  if printf '%s' "$b" | grep -q "slug=\[${SLUG}\]"; then ok_ "${caminho} - slug preservado"
  else bad_ "${caminho} - slug perdido: ${b}"; fi
done

echo
printf '%d ok, %d falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
