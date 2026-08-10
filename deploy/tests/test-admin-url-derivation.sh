#!/usr/bin/env bash
# deploy/tests/test-admin-url-derivation.sh
#
# Fixa a derivação do domínio administrativo, de onde sai o
# AGENT_BASE_ZIP_URL.
#
# Porque existe: o nginx serve /agent-base/ e /api/admin/ SÓ no domínio
# administrativo e devolve 404 a ambos no domínio da aplicação. Enquanto
# o AGENT_BASE_ZIP_URL foi derivado do URL público, o Wizard apanhava 404
# — e a instalação não dava erro nenhum. A falha só aparecia à frente do
# cliente, na altura de gerar o ZIP do agent.
#
# Testa a função REAL de lib/common.sh, não uma cópia.
#
# Uso: bash deploy/tests/test-admin-url-derivation.sh

set -uo pipefail
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# common.sh liga `set -Eeuo pipefail` e instala traps: num script de teste
# isso abortaria à primeira asserção falhada, escondendo as restantes.
# shellcheck source=../scripts/lib/common.sh
. "${REPO_ROOT}/deploy/scripts/lib/common.sh" >/dev/null 2>&1 || true
set +Eeuo pipefail
trap - ERR

pass=0; fail=0
check() {
  local label="$1" publico="$2" explicito="$3" esperado="$4"
  local obtido; obtido=$(derive_admin_url "$publico" "$explicito")
  if [ "$obtido" = "$esperado" ]; then
    pass=$((pass+1)); printf '  [OK]    %s\n' "$label"
  else
    fail=$((fail+1))
    printf '  [FALHA] %s\n' "$label"
    printf '            público=%s explícito=%s\n' "${publico:-(vazio)}" "${explicito:-(vazio)}"
    printf '            obtido=%s esperado=%s\n' "$obtido" "$esperado"
  fi
}

echo "=== convenção: primeiro rótulo passa a 'admin' ==="
check "app -> admin"            "https://app.spharmmt.com"  "" "https://admin.spharmmt.com"
check "preserva o esquema http" "http://app.spharmmt.com"   "" "http://admin.spharmmt.com"
check "outro subdomínio"        "https://www.spharmmt.com"  "" "https://admin.spharmmt.com"
check "quatro rótulos"          "https://app.pt.exemplo.com" "" "https://admin.pt.exemplo.com"
check "ignora o caminho"        "https://app.spharmmt.com/x" "" "https://admin.spharmmt.com"

echo
echo "=== já administrativo: não vira admin.admin ==="
check "idempotente" "https://admin.spharmmt.com" "" "https://admin.spharmmt.com"

echo
echo "=== sem rótulo a substituir: não se inventa domínio ==="
# "admin.exemplo.pt" pode não existir nem ter certificado. Ficar no URL
# público é honesto; inventar seria uma falha só visível em produção.
check "apex de dois rótulos" "https://exemplo.pt" "" "https://exemplo.pt"

echo
echo "=== sem domínio: admin e aplicação são o mesmo endereço ==="
check "IP"                 "http://164.132.85.211"      "" "http://164.132.85.211"
check "IP com porta"       "http://164.132.85.211:8080" "" "http://164.132.85.211:8080"
check "localhost"          "http://127.0.0.1:8080"      "" "http://127.0.0.1:8080"
check "vazio"              ""                           "" ""

echo
echo "=== explícito vence sempre ==="
check "--admin-url"            "https://app.spharmmt.com" "https://gestao.spharmmt.com" "https://gestao.spharmmt.com"
check "explícito mesmo com IP" "http://164.132.85.211"    "https://admin.spharmmt.com"  "https://admin.spharmmt.com"

echo
echo "=== o URL gerado nunca traz revisão ==="
# A revisão vive no manifest e no `agent --version`. Um URL versionado
# obrigaria a reconfigurar a plataforma a cada release, e os Wizards já
# instalados ficariam presos à revisão do dia em que foram configurados.
admin=$(derive_admin_url "https://app.spharmmt.com" "")
url="${admin}/agent-base/spharmmt-agent-base.zip"
if printf '%s' "$url" | grep -qE 'rev[0-9]+'; then
  fail=$((fail+1)); printf '  [FALHA] URL contém revisão: %s\n' "$url"
else
  pass=$((pass+1)); printf '  [OK]    URL estável: %s\n' "$url"
fi

echo
echo "=== o valor gerado bate com o que o nginx serve ==="
# O vhost administrativo serve /agent-base/<ficheiro>.zip; o da aplicação
# devolve 404. Se o host derivado não for o administrativo, o Wizard
# apanha 404 — é exactamente a regressão que este teste impede.
tls="${REPO_ROOT}/deploy/docker/proxy/spharmmt-tls.conf"
if [ -r "$tls" ]; then
  host_admin=$(awk '/server_name[[:space:]]+admin\./ {print $2; exit}' "$tls" | tr -d ';')
  derivado=$(derive_admin_url "https://app.spharmmt.com" "")
  derivado_host=${derivado#*://}
  if [ "$derivado_host" = "$host_admin" ]; then
    pass=$((pass+1)); printf '  [OK]    host derivado (%s) = server_name do vhost admin\n' "$derivado_host"
  else
    fail=$((fail+1))
    printf '  [FALHA] host derivado=%s mas o nginx serve /agent-base/ em %s\n' "$derivado_host" "$host_admin"
  fi
  if awk '/server_name[[:space:]]+app\./,/^}/' "$tls" | grep -q 'location \^~ /agent-base/'; then
    pass=$((pass+1)); printf '  [OK]    vhost da aplicação recusa /agent-base/\n'
  else
    fail=$((fail+1)); printf '  [FALHA] vhost da aplicação já não recusa /agent-base/\n'
  fi
else
  printf '  [aviso] %s não encontrado — verificação contra o nginx saltada\n' "$tls"
fi

echo
printf '%d ok, %d falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
