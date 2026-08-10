#!/usr/bin/env bash
# deploy/tests/test-proxy-certs-mode.sh
#
# Fixa o modo de /opt/spharmmt/proxy/certs em 0711.
#
# Já regressou a 0750 mais do que uma vez em reinstalações, e o sintoma
# não aponta para a causa: o nginx não arranca e a plataforma fica sem
# caminho de entrada. A razão é a mesma que obriga o proxy/conf a 0755 —
# com `cap_drop: ALL` o nginx não tem DAC_OVERRIDE, e sobre um directório
# do uid 1000 o uid do container conta como "others". Sem bit de execução
# em others não ATRAVESSA o directório, e o modo dos ficheiros lá dentro
# deixa de importar.
#
# 0711 dá travessia sem dar listagem. A protecção das chaves fica onde
# deve ficar: no modo dos próprios ficheiros.
#
# Uso: bash deploy/tests/test-proxy-certs-mode.sh

set -uo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export SPHARMMT_ROOT="$TMP"
export SPHARMMT_PROXY_CONF_DIR="${TMP}/proxy/conf"
export SPHARMMT_USER="$(id -un)"
export SPHARMMT_GROUP="$(id -gn 2>/dev/null || id -un)"

# shellcheck source=../scripts/lib/common.sh
. "${REPO}/deploy/scripts/lib/common.sh" >/dev/null 2>&1 || true
set +Eeuo pipefail
trap - ERR
DRY_RUN=0

# Este teste mede bits POSIX. Em NTFS via Git Bash o chmod é ignorado e
# tudo lê 755 — falhas que não são do código. Detectar e saltar é honesto;
# reportar 7 falhas falsas ensinaria a ignorar o teste.
mkdir -p "${TMP}/probe" && chmod 0711 "${TMP}/probe"
if [ "$(stat -c '%a' "${TMP}/probe" 2>/dev/null)" != "711" ]; then
  echo "SALTADO: este sistema de ficheiros não honra modos POSIX (chmod 0711 leu $(stat -c '%a' "${TMP}/probe" 2>/dev/null))."
  echo "Corre em Linux, ou:  docker run --rm -v \"\$PWD:/w\" -w /w bash:5 bash deploy/tests/test-proxy-certs-mode.sh"
  exit 0
fi

pass=0; fail=0
CERTS="${TMP}/proxy/certs"
modo() { stat -c '%a' "$1" 2>/dev/null || echo "?"; }
eq() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  [OK]    %s (%s)\n' "$1" "$2"
  else fail=$((fail+1)); printf '  [FALHA] %s: obtido %s, esperado %s\n' "$1" "$2" "$3"; fi
}

echo "=== instalação limpa ==="
ensure_proxy_dirs "${SPHARMMT_USER}:${SPHARMMT_GROUP}" >/dev/null 2>&1
eq "proxy/certs criado a 0711" "$(modo "$CERTS")" "711"

echo
echo "=== reinstalação sobre 0750 (a regressão observada) ==="
chmod 0750 "$CERTS"
eq "estado degradado reproduzido" "$(modo "$CERTS")" "750"
ensure_proxy_dirs "${SPHARMMT_USER}:${SPHARMMT_GROUP}" >/dev/null 2>&1
eq "reinstalação repõe 0711" "$(modo "$CERTS")" "711"

echo
echo "=== reinstalação repetida não afrouxa nem aperta ==="
for i in 1 2 3; do
  ensure_proxy_dirs "${SPHARMMT_USER}:${SPHARMMT_GROUP}" >/dev/null 2>&1
done
eq "estável ao fim de 3 corridas" "$(modo "$CERTS")" "711"

echo
echo "=== outros atravessam mas não listam ==="
m=$(modo "$CERTS"); o=${m: -1}
case "$o" in
  1|3|5|7) pass=$((pass+1)); printf '  [OK]    others tem bit de execução (travessia)\n' ;;
  *) fail=$((fail+1)); printf '  [FALHA] others sem execução — o nginx não atravessa (modo %s)\n' "$m" ;;
esac
case "$o" in
  4|5|6|7) fail=$((fail+1)); printf '  [FALHA] others tem leitura — directório listável (modo %s)\n' "$m" ;;
  *) pass=$((pass+1)); printf '  [OK]    others sem leitura (não listável)\n' ;;
esac

echo
echo "=== modo dos ficheiros ==="
: >"${CERTS}/fullchain.pem"; chmod 0644 "${CERTS}/fullchain.pem"
: >"${CERTS}/privkey.pem";   chmod 0644 "${CERTS}/privkey.pem"
enforce_tls_key_modes "${SPHARMMT_USER}:${SPHARMMT_GROUP}" >/dev/null 2>&1
eq "privkey.pem apertado para 0640" "$(modo "${CERTS}/privkey.pem")" "640"
eq "fullchain.pem fica legível a 0644" "$(modo "${CERTS}/fullchain.pem")" "644"

chmod 0600 "${CERTS}/privkey.pem"
enforce_tls_key_modes "${SPHARMMT_USER}:${SPHARMMT_GROUP}" >/dev/null 2>&1
eq "0600 não é afrouxado para 0640" "$(modo "${CERTS}/privkey.pem")" "600"

echo
echo "=== o directório continua a não ser 0750 em lado nenhum do código ==="
if grep -rn 'proxy/certs" 0750' "${REPO}/deploy/scripts/" >/dev/null 2>&1; then
  fail=$((fail+1)); printf '  [FALHA] ainda há um ensure_dir de proxy/certs a 0750\n'
else
  pass=$((pass+1)); printf '  [OK]    nenhum ensure_dir de proxy/certs a 0750\n'
fi

echo
printf '%d ok, %d falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
