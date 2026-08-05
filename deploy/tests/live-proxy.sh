#!/usr/bin/env bash
# deploy/tests/live-proxy.sh
#
# Teste REAL do reverse proxy, com containers a sério. Reproduz a falha
# que deixou o proxy em baixo na VPS e prova que a correcção a resolve.
#
#     /opt/spharmmt/proxy/conf  2750 deploy:spharmmt
#
# O bind mount preserva dono e modo. Dentro do container o nginx corre
# como utilizador `nginx` (uid 101), que não é o dono nem pertence ao
# grupo: com 2750 não há bits para "others", o `ls /etc/nginx/conf.d`
# devolve "Permission denied", nenhum `server {}` é carregado, e o nginx
# ARRANCA na mesma — sem escutar na porta 80. O único sintoma é
# "Connection refused" no healthcheck, que não aponta para permissões.
#
# A configuração vive num VOLUME Docker, não num bind mount do host. É
# deliberado: em Docker Desktop (Windows/macOS) os bind mounts não
# preservam uid/gid nem modo — tudo aparece como root e world-readable
# dentro do container, e a falha que se quer reproduzir torna-se
# invisível. Num volume, o sistema de ficheiros é Linux nativo em
# qualquer host, e as permissões são as verdadeiras.
#
# NÃO faz parte da suite `test-*.sh`: precisa de Docker e de rede, e a
# suite corre dentro de um container sem acesso ao daemon. Corre-se à
# mão, a partir da raiz do repositório:
#
#     ./deploy/tests/live-proxy.sh
#
# Não toca em /opt, em /data, nem em nada da VPS: tudo acontece num
# directório temporário e numa rede Docker descartável.
#
# Saída: 0 tudo passou · 1 pelo menos um caso falhou · 2 sem Docker

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CONF_SRC="${REPO_ROOT}/deploy/docker/proxy/spharmmt.conf"
NGINX_IMAGE=${NGINX_IMAGE:-nginx:1.29-alpine}
NET=spharmmt-liveproxy-net
VOL=spharmmt-liveproxy-conf
# uid/gid do `deploy`/`spharmmt` na VPS. O nginx do container é uid 101,
# portanto nem dono nem membro do grupo — é essa a situação a reproduzir.
DEPLOY_UID=${DEPLOY_UID:-1000}
DEPLOY_GID=${DEPLOY_GID:-1001}
UPSTREAM=spharmmt-liveproxy-web
PROXY=spharmmt-liveproxy
PORT=${PORT:-18080}
WORK=""

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
eq_()  { if [ "$2" = "$3" ]; then ok_ "$1 → ${3}"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi; }

# Git Bash converte caminhos tipo Unix nos argumentos do docker.
if [ -n "${MSYSTEM:-}" ] || uname -s 2>/dev/null | grep -qE 'MINGW|MSYS'; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
fi

host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

cleanup() {
  docker rm -f "$PROXY" "$UPSTREAM" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [ -n "$WORK" ] && rm -rf "$WORK"
}
trap cleanup EXIT

# ═════════════════════════════════════════════════════════════════════════
# Upstream de mentira: responde ao /api/health como a aplicação real.
# ═════════════════════════════════════════════════════════════════════════
start_upstream() {
  mkdir -p "$WORK/upstream"
  cat > "$WORK/upstream/stub.conf" <<'EOF'
server {
    listen 3000;
    location = /api/health {
        add_header content-type application/json always;
        return 200 '{"status":"ok","checks":[]}';
    }
    location / { return 200 'stub\n'; }
}
EOF
  chmod 0755 "$WORK/upstream"; chmod 0644 "$WORK/upstream/stub.conf"
  docker run -d --name "$UPSTREAM" --network "$NET" --network-alias web \
    -v "$(host_path "$WORK/upstream"):/etc/nginx/conf.d:ro" \
    "$NGINX_IMAGE" >/dev/null
}

# set_conf_modes <modo_dir> <modo_ficheiro> — repõe o volume com o dono e
# os modos pedidos, feito de dentro de um container Linux para as
# permissões serem reais em qualquer host.
set_conf_modes() {
  local dmode=$1 fmode=$2
  docker run --rm -v "${VOL}:/c" -v "$(host_path "$WORK/src"):/src:ro" "$NGINX_IMAGE" \
    sh -c "cp /src/spharmmt.conf /c/spharmmt.conf \
        && chown ${DEPLOY_UID}:${DEPLOY_GID} /c /c/spharmmt.conf \
        && chmod ${dmode} /c \
        && chmod ${fmode} /c/spharmmt.conf" >/dev/null
}

conf_modes() {
  docker run --rm -v "${VOL}:/c" "$NGINX_IMAGE" \
    sh -c 'stat -c "%a %u:%g" /c; stat -c "%a %u:%g" /c/spharmmt.conf' 2>/dev/null | tr '\n' ' '
}

# O endurecimento tem de ser IGUAL ao do compose, e é o que fecha o
# mecanismo da falha.
#
# O processo master do nginx arranca como root. Num container normal, o
# root tem a capability DAC_OVERRIDE e ignora os bits de permissão — com
# 2750 leria a configuração à mesma e o problema não existiria.
#
# O nosso compose faz `cap_drop: ALL`, e DAC_OVERRIDE vai nesse lote. Sem
# ela, o root fica sujeito às permissões normais: sobre um directório
# 2750 pertencente ao uid 1000, o uid 0 é "others" e não tem nada. Daí o
# "Permission denied" e o nginx a carregar zero server{}.
#
# É por isso que a política genérica 2750 é fatal AQUI e passaria
# despercebida num container sem endurecimento.
start_proxy() {
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker run -d --name "$PROXY" --network "$NET" \
    -p "127.0.0.1:${PORT}:80" \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add NET_BIND_SERVICE \
    --health-cmd 'wget -q -O /dev/null http://127.0.0.1/healthz || exit 1' \
    --health-interval 5s --health-timeout 3s --health-retries 3 --health-start-period 5s \
    -v "${VOL}:/etc/nginx/conf.d:ro" \
    "$NGINX_IMAGE" >/dev/null 2>&1
}

wait_health() {
  local want=$1 deadline=$(( $(date +%s) + ${2:-45} )) h
  while [ "$(date +%s)" -lt "$deadline" ]; do
    h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$PROXY" 2>/dev/null || echo missing)
    [ "$h" = "$want" ] && { printf '%s' "$h"; return 0; }
    sleep 2
  done
  printf '%s' "${h:-missing}"
  return 1
}

# `-o "$WORK/curl.out"` e não /dev/null: o curl do Git Bash falha a
# escrever em /dev/null (exit 23) e o `|| printf 000` acrescentava lixo
# ao código HTTP — "200000" em vez de "200".
http_code() {
  local code
  code=$(curl -sS -o "$WORK/curl.out" -m 10 -w '%{http_code}' "http://127.0.0.1:${PORT}$1" 2>/dev/null)
  printf '%s' "${code:-000}"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste real: reverse proxy com containers ===\n'

  command -v docker >/dev/null 2>&1 || { printf '  docker não encontrado\n'; return 2; }
  docker info >/dev/null 2>&1 || { printf '  daemon docker não responde\n'; return 2; }
  [ -f "$CONF_SRC" ] || { printf '  configuração não encontrada: %s\n' "$CONF_SRC"; return 2; }

  WORK=$(mktemp -d)
  mkdir -p "$WORK/src"
  cp "$CONF_SRC" "$WORK/src/spharmmt.conf"

  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network create "$NET" >/dev/null
  docker volume create "$VOL" >/dev/null
  start_upstream
  sleep 3

  # ── 1. A FALHA: conf.d a 2750 ──────────────────────────────────────
  printf '\n1. Reprodução da falha (conf.d a 2750, a política genérica)\n'
  set_conf_modes 2750 0644
  printf '   %s\n' "$(conf_modes)"
  start_proxy
  sleep 6

  local ls_rc=0
  docker exec --user nginx "$PROXY" ls /etc/nginx/conf.d >/dev/null 2>&1 || ls_rc=$?
  if [ "$ls_rc" -ne 0 ]; then
    ok_ "utilizador nginx NÃO consegue listar conf.d (é a causa)"
  else
    bad_ "com 2750 o nginx conseguiu listar — a reprodução não é fiel"
  fi

  local nserver
  nserver=$(docker exec "$PROXY" nginx -T 2>/dev/null | grep -c 'server {' || true)
  eq_ "nenhum server{} carregado" "0" "${nserver:-0}"
  eq_ "porta 80 não responde" "000" "$(http_code /healthz)"
  local h; h=$(wait_health healthy 20 || true)
  if [ "$h" != "healthy" ]; then ok_ "proxy NÃO fica healthy (estado: ${h})"; else bad_ "proxy ficou healthy com conf.d ilegível"; fi

  # ── 2. A CORRECÇÃO: conf.d a 0755 ──────────────────────────────────
  printf '\n2. Correcção (conf.d a 0755, ficheiro a 0644)\n'
  set_conf_modes 0755 0644
  printf '   %s\n' "$(conf_modes)"
  start_proxy

  h=$(wait_health healthy 60 || true)
  eq_ "proxy fica healthy" "healthy" "$h"

  if docker exec --user nginx "$PROXY" ls /etc/nginx/conf.d >/dev/null 2>&1; then
    ok_ "utilizador nginx consegue listar conf.d"
  else
    bad_ "utilizador nginx continua sem conseguir listar conf.d"
  fi

  if docker exec --user nginx "$PROXY" test -r /etc/nginx/conf.d/spharmmt.conf; then
    ok_ "utilizador nginx consegue LER o ficheiro"
  else
    bad_ "utilizador nginx não consegue ler o ficheiro"
  fi

  local conf; conf=$(docker exec "$PROXY" nginx -T 2>/dev/null || true)
  nserver=$(printf '%s' "$conf" | grep -c 'server {' || true)
  if [ "${nserver:-0}" -gt 0 ]; then ok_ "nginx -T carrega ${nserver} server{}"; else bad_ "nginx -T sem server{}"; fi
  local d
  for d in listen location proxy_pass; do
    if printf '%s' "$conf" | grep -qE "^[[:space:]]*${d}[[:space:]]"; then
      ok_ "nginx -T contém ${d}"
    else
      bad_ "nginx -T sem ${d}"
    fi
  done

  eq_ "GET /healthz"    "200" "$(http_code /healthz)"
  eq_ "GET /api/health" "200" "$(http_code /api/health)"

  local body; body=$(curl -sS -m 10 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)
  if printf '%s' "$body" | grep -q '"status"'; then
    ok_ "corpo de /api/health vem do upstream"
  else
    bad_ "corpo inesperado de /api/health: ${body}"
  fi

  # Cabeçalhos de segurança e limpeza dos headers de tenant.
  local hdrs; hdrs=$(curl -sS -m 10 -D - -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null || true)
  for d in X-Content-Type-Options X-Frame-Options Referrer-Policy; do
    if printf '%s' "$hdrs" | grep -qi "^${d}:"; then ok_ "cabeçalho ${d}"; else bad_ "sem cabeçalho ${d}"; fi
  done

  # ── 3. Recriação do container ──────────────────────────────────────
  printf '\n3. Recriação do container (force recreate)\n'
  start_proxy
  h=$(wait_health healthy 60 || true)
  eq_ "continua healthy depois de recriado" "healthy" "$h"
  eq_ "  /healthz"    "200" "$(http_code /healthz)"
  eq_ "  /api/health" "200" "$(http_code /api/health)"

  # ── 4. Ficheiro a 0640: o dir é atravessável, o ficheiro não é lido ─
  printf '\n4. Ficheiro .conf a 0640 (dir correcto, ficheiro fechado)\n'
  set_conf_modes 0755 0640
  printf '   %s
' "$(conf_modes)"
  start_proxy
  sleep 6
  nserver=$(docker exec "$PROXY" nginx -T 2>/dev/null | grep -c 'server {' || true)
  eq_ "nenhum server{} carregado" "0" "${nserver:-0}"
  eq_ "porta 80 não responde" "000" "$(http_code /healthz)"

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
