#!/usr/bin/env bash
# deploy/tests/test-env-value-or-keep.sh
#
# Prova que uma feature flag ligada em produção sobrevive a uma
# reinstalação.
#
# O defeito que isto fixa: o install-platform.sh reescreve o platform.env
# INTEIRO a cada execução, e só a SERVER_ACTIONS_ALLOWED_ORIGINS era
# preservada. O ENABLE_AGENT_BOOTSTRAP voltava sempre a 0. O cabeçalho do
# ficheiro chega a dizer "seguro editar à mão" — não era, para esta chave.
#
# A falha não aparece ao lado da causa: o instalador corre por uma razão
# qualquer, tudo passa, e dias depois o agent da farmácia apanha 503 no
# products-upload sem nada que ligue as duas coisas.
#
# Testa a função REAL de lib/common.sh.
#
# Uso: bash deploy/tests/test-env-value-or-keep.sh

set -uo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# shellcheck source=../scripts/lib/common.sh
. "${REPO}/deploy/scripts/lib/common.sh" >/dev/null 2>&1 || true
set +Eeuo pipefail
trap - ERR

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ENVF="${TMP}/platform.env"

pass=0; fail=0
eq() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  [OK]    %s (%s)\n' "$1" "$2"
  else fail=$((fail+1)); printf '  [FALHA] %s: obtido "%s", esperado "%s"\n' "$1" "$2" "$3"; fi
}

echo "=== primeira instalação: não há ficheiro ==="
unset ENABLE_AGENT_BOOTSTRAP
eq "usa o default" "$(env_value_or_keep "$ENVF" ENABLE_AGENT_BOOTSTRAP 0)" "0"

echo
echo "=== operador liga a flag pelo ambiente ==="
eq "o ambiente manda" "$(ENABLE_AGENT_BOOTSTRAP=1 env_value_or_keep "$ENVF" ENABLE_AGENT_BOOTSTRAP 0)" "1"

echo
echo "=== reinstalação: o valor no ficheiro é preservado ==="
cat >"$ENVF" <<'EOF'
NODE_ENV=production
ENABLE_AGENT_BOOTSTRAP=1
TENANT_FALLBACK_ENABLED=1
EOF
unset ENABLE_AGENT_BOOTSTRAP
eq "1 sobrevive à reinstalação" "$(env_value_or_keep "$ENVF" ENABLE_AGENT_BOOTSTRAP 0)" "1"

echo
echo "=== desligar também tem de funcionar ==="
# Sem isto, a preservação seria uma armadilha ao contrário: uma flag
# ligada por engano nunca mais se desligava sem editar o ficheiro.
eq "0 explícito desliga" "$(ENABLE_AGENT_BOOTSTRAP=0 env_value_or_keep "$ENVF" ENABLE_AGENT_BOOTSTRAP 0)" "0"

echo
echo "=== não confunde chaves parecidas ==="
cat >"$ENVF" <<'EOF'
NAO_ENABLE_AGENT_BOOTSTRAP=9
ENABLE_AGENT_BOOTSTRAP_EXTRA=8
ENABLE_AGENT_BOOTSTRAP=1
EOF
unset ENABLE_AGENT_BOOTSTRAP
eq "âncora no início da linha" "$(env_value_or_keep "$ENVF" ENABLE_AGENT_BOOTSTRAP 0)" "1"

echo
echo "=== valores com '=' não são truncados ==="
cat >"$ENVF" <<'EOF'
SERVER_ACTIONS_ALLOWED_ORIGINS=127.0.0.1:8080,x.pt/a=b
EOF
eq "preserva o valor inteiro" \
   "$(env_value_or_keep "$ENVF" SERVER_ACTIONS_ALLOWED_ORIGINS "")" \
   "127.0.0.1:8080,x.pt/a=b"

echo
echo "=== chave ausente do ficheiro cai no default ==="
printf 'OUTRA=1\n' >"$ENVF"
eq "default quando não existe" "$(env_value_or_keep "$ENVF" ENABLE_AGENT_BOOTSTRAP 0)" "0"

echo
echo "=== o instalador usa mesmo a função ==="
# Uma regressão provável: alguém volta a pôr o literal no heredoc. Aqui
# o teste falha em vez de o valor voltar a 0 na próxima reinstalação.
IP="${REPO}/deploy/scripts/install-platform.sh"
if grep -qE '^ENABLE_AGENT_BOOTSTRAP=0$' "$IP"; then
  fail=$((fail+1)); printf '  [FALHA] install-platform.sh voltou a escrever o literal 0\n'
else
  pass=$((pass+1)); printf '  [OK]    sem literal ENABLE_AGENT_BOOTSTRAP=0 no instalador\n'
fi
if grep -q 'env_value_or_keep "$SPHARMMT_ENV_FILE" ENABLE_AGENT_BOOTSTRAP' "$IP"; then
  pass=$((pass+1)); printf '  [OK]    instalador resolve a flag por env_value_or_keep\n'
else
  fail=$((fail+1)); printf '  [FALHA] instalador já não usa env_value_or_keep para a flag\n'
fi

echo
printf '%d ok, %d falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

echo
echo "=== o heredoc do platform.env não executa nada ==="
# `<<EOF` sem aspas faz expansão: uma crase por escapar dentro do bloco é
# substituição de comando. `agent --version` no meio de um comentário
# fazia o instalador imprimir "agent: command not found" E gravava o
# comentário truncado no ficheiro gerado.
IPF="${REPO}/deploy/scripts/install-platform.sh"
inicio=$(grep -n 'write_file "\$SPHARMMT_ENV_FILE" 0640 "\$OWNER" <<EOF' "$IPF" | cut -d: -f1)
fim=$(awk -v i="$inicio" 'NR>i && $0=="EOF" {print NR; exit}' "$IPF")
soltas=$(awk -v a="$inicio" -v b="$fim" 'NR>a && NR<b' "$IPF" | grep '`' | grep -cv '\`')
if [ "${soltas:-0}" -eq 0 ]; then
  pass=$((pass+1)); printf '  [OK]    nenhuma crase por escapar entre as linhas %s e %s\n' "$inicio" "$fim"
else
  fail=$((fail+1)); printf '  [FALHA] %s crase(s) por escapar no heredoc — o instalador vai executá-las\n' "$soltas"
  awk -v a="$inicio" -v b="$fim" 'NR>a && NR<b' "$IPF" | grep '`' | grep -v '\`'
fi

echo
printf '%d ok, %d falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
