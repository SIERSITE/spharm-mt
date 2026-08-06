#!/usr/bin/env bash
# deploy/tests/test-wizard-build.sh
#
# O Admin Wizard é distribuído como `.exe`. Um binário é opaco: ninguém,
# a olhar para o repositório, consegue dizer de que `.ps1` saiu.
#
# O que se encontrou na auditoria: `dist-admin/SPharmMT-Admin-Wizard.exe`
# estava em HEAD e o `.ps1` ao lado dele NÃO — só em staging. E o `.exe`
# é precisamente o que o técnico executa por duplo-clique. Não havia
# forma de saber se correspondia ao código actual.
#
# Este teste recusa esse estado. Verifica, contra HEAD (o que a VPS e o
# técnico recebem, não a working tree):
#
#   1. a fonte, o .exe e o BUILD-INFO.json estão todos em HEAD;
#   2. o SHA-256 da fonte em HEAD bate com o registado no BUILD-INFO;
#   3. o SHA-256 do .exe em HEAD bate com o registado no BUILD-INFO.
#
# Mudar o `.ps1` sem reconstruir o `.exe` falha em (2). Commitar um
# `.exe` diferente falha em (3).
#
# LIMITE, e convém ser claro: isto NÃO prova que o `.exe` foi compilado
# a partir daquela fonte. O ps2exe embute timestamps e não é
# reprodutível, portanto recompilar dá um binário diferente byte a byte.
# O que se prova é que o PAR (fonte, binário) em HEAD é o par que existia
# no momento do build — que é o que apanha a divergência real: fonte
# alterada, binário esquecido.
#
# Saída: 0 correspondência verificável · 1 divergência · 2 sem git

set -uo pipefail

REPO_ROOT=${REPO_ROOT:-/work}
SRC="admin-wizard/SPharmMT-Admin-Wizard.ps1"
EXE="dist-admin/SPharmMT-Admin-Wizard.exe"
INFO="dist-admin/BUILD-INFO.json"

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }
ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }

echo "=== Teste: correspondência fonte ↔ EXE do Admin Wizard ==="
echo

command -v git >/dev/null 2>&1 || { echo "sem git — não é possível verificar HEAD" >&2; exit 2; }
cd "$REPO_ROOT" 2>/dev/null || { echo "REPO_ROOT inválido: ${REPO_ROOT}" >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "não é um repositório git" >&2; exit 2; }

# in_head <caminho> — 0 se existe como blob em HEAD.
in_head() { git cat-file -e "HEAD:$1" 2>/dev/null; }

missing=0
for f in "$SRC" "$EXE" "$INFO"; do
  if in_head "$f"; then
    ok_ "em HEAD: ${f}"
  else
    bad_ "AUSENTE em HEAD: ${f}"
    missing=1
  fi
done

if [ "$missing" = "1" ]; then
  echo
  echo "  Um .exe em HEAD sem a fonte e o BUILD-INFO ao lado não é verificável."
  echo "  Reconstruir no Windows e commitar os três:"
  echo "      powershell -File admin-wizard\\build.ps1"
  echo
  printf 'wizard: %s%d ok%s, %s%d falhas%s\n' "$C_G" "$pass" "$C_0" "$C_R" "$fail" "$C_0"
  exit 1
fi

# ── Hashes registados ────────────────────────────────────────────────
# `git show` e não o disco: o que interessa é o que HEAD entrega. Um
# ficheiro alterado na working tree e não commitado tem de falhar aqui,
# não passar por acidente.
info_json=$(git show "HEAD:${INFO}")

# Extracção sem jq: o campo é uma string hex numa linha. `grep -o` chega
# e não acrescenta uma dependência à imagem de teste.
json_field() {
  printf '%s' "$info_json" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[a-f0-9]*\"" \
    | head -1 | sed 's/.*"\([a-f0-9]*\)"$/\1/'
}

want_src=$(json_field sourceSha256)
want_exe=$(json_field exeSha256)

if [ -z "$want_src" ] || [ -z "$want_exe" ]; then
  bad_ "BUILD-INFO.json não tem sourceSha256/exeSha256 legíveis"
  printf 'wizard: %s%d ok%s, %s%d falhas%s\n' "$C_G" "$pass" "$C_0" "$C_R" "$fail" "$C_0"
  exit 1
fi
ok_ "BUILD-INFO.json declara os dois hashes"

have_src=$(git show "HEAD:${SRC}" | sha256sum | cut -d' ' -f1)
have_exe=$(git show "HEAD:${EXE}" | sha256sum | cut -d' ' -f1)

if [ "$have_src" = "$want_src" ]; then
  ok_ "fonte em HEAD corresponde ao BUILD-INFO (${have_src:0:12}…)"
else
  bad_ "a FONTE mudou desde o último build do .exe"
  printf '        BUILD-INFO : %s\n' "$want_src"
  printf '        HEAD       : %s\n' "$have_src"
  printf '        → reconstruir:  powershell -File admin-wizard\\build.ps1\n'
fi

if [ "$have_exe" = "$want_exe" ]; then
  ok_ "EXE em HEAD corresponde ao BUILD-INFO (${have_exe:0:12}…)"
else
  bad_ "o EXE em HEAD não é o que o BUILD-INFO regista"
  printf '        BUILD-INFO : %s\n' "$want_exe"
  printf '        HEAD       : %s\n' "$have_exe"
fi

echo
printf 'wizard: %s%d ok%s, %s%d falhas%s\n' "$C_G" "$pass" "$C_0" "$C_R" "$fail" "$C_0"
[ "$fail" -eq 0 ] || exit 1
exit 0
