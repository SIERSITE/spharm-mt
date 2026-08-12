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
    location / { return 200 "upstream:$request_uri\n"; }
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

echo "=== as três agregações do Agent PASSAM no domínio dos Agents ==="
for r in aggregate-month aggregate-compras aggregate-devolucoes; do
  c=$(codigo app.spharmmt.com "/api/admin/pipeline/${r}")
  if [ "$c" != "404" ]; then ok_ "${r} chega à aplicação (${c})"
  else bad_ "${r} continua a devolver 404 — o full-sync volta a parar em 6/9"; fi
done

echo
echo "=== o resto de /api/admin/ continua 404 ==="
for p in /api/admin/v1/tenants /api/admin/enrichment-health /api/admin/pipeline/record \
         /api/admin/v1/tenants/x/agent-package; do
  c=$(codigo app.spharmmt.com "$p")
  if [ "$c" = "404" ]; then ok_ "${p} → 404"
  else bad_ "${p} EXPOSTO ao domínio dos Agents (${c})"; fi
done

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
printf '%d ok, %d falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
