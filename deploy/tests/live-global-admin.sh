#!/usr/bin/env bash
# deploy/tests/live-global-admin.sh
#
# Teste real do scripts/control/create-global-admin.ts, contra um
# PostgreSQL a sério com o schema do control plane aplicado.
#
# Cobre os dez cenários exigidos:
#   1. criação inicial
#   2. tabela já não vazia
#   3. email duplicado
#   4. password fraca
#   5. confirmação diferente
#   6. hash bcrypt válido
#   7. login com a password correcta
#   8. a password não aparece no stdout nem no stderr
#   9. ausência de CONTROL_DATABASE_URL
#  10. prova de que não toca na base legacy
#
# A prova do ponto 10 é a mais forte que consigo montar: o DATABASE_URL
# aponta para uma base que NÃO EXISTE. Se o script lhe tocasse, falhava.
# Como cria o administrador na mesma, fica provado que nunca a usou.
#
# NÃO faz parte da suite `test-*.sh`: precisa de Docker, de rede e do
# toolchain Node do repositório. Corre-se à mão, da raiz:
#
#     ./deploy/tests/live-global-admin.sh
#
# Não toca em /opt, em /data, nem em nenhuma base da VPS: PostgreSQL
# descartável num porto alto.
#
# Saída: 0 tudo passou · 1 pelo menos um caso falhou · 2 pré-requisitos

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PG_IMAGE=${PG_IMAGE:-postgres:17.6-bookworm}
PG=spharmmt-gatest-pg
PGPORT=${PGPORT:-15499}
PGPASS=gatest
CONTROL_DB=spharmmt_control_test

# A password de teste. Aparece neste ficheiro de propósito — é um valor
# descartável de um container que morre no fim — e é precisamente o que
# se procura no stdout/stderr para provar que o script não a imprime.
TEST_PASSWORD='S3nh4-De-Teste-Longa'

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
eq_()  { if [ "$2" = "$3" ]; then ok_ "$1 → ${3}"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi; }

if [ -n "${MSYSTEM:-}" ] || uname -s 2>/dev/null | grep -qE 'MINGW|MSYS'; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
fi

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  [ -n "${EMPTY_ENV:-}" ] && rm -f "$EMPTY_ENV"
  return 0
}
trap cleanup EXIT

CONTROL_URL=""
# Base legacy que NÃO EXISTE. Qualquer tentativa de lhe tocar falha.
LEGACY_URL=""
# Ficheiro .env VAZIO. Sem isto, o `import "dotenv/config"` do script
# carrega o .env do repositório — que numa máquina de desenvolvimento
# aponta para o control plane de PRODUÇÃO. Este teste chegou a criar uma
# linha lá antes de o isolamento existir.
EMPTY_ENV=""

psql_c() { docker exec -e PGPASSWORD="$PGPASS" "$PG" psql -U postgres -d "$CONTROL_DB" -Atc "$1" 2>/dev/null; }

# run_create <stdin> [args...] — corre o script e devolve
# "rc|stdout|stderr" em ficheiros, para se poder inspeccionar os dois.
OUT=""; ERR=""; RC=0
run_create() {
  local input=$1; shift
  OUT=$(mktemp); ERR=$(mktemp)
  printf '%s' "$input" | (
    cd "$REPO_ROOT" && \
    DOTENV_CONFIG_PATH="$EMPTY_ENV" \
    CONTROL_DATABASE_URL="$CONTROL_URL" \
    DATABASE_URL="$LEGACY_URL" \
    npx tsx scripts/control/create-global-admin.ts --yes "$@" \
      >"$OUT" 2>"$ERR"
  )
  RC=$?
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
setup() {
  printf '\nPreparação\n'
  EMPTY_ENV=$(mktemp)
  : > "$EMPTY_ENV"
  cleanup
  docker run -d --name "$PG" -e POSTGRES_PASSWORD="$PGPASS" \
    -p "127.0.0.1:${PGPORT}:5432" "$PG_IMAGE" >/dev/null

  local waited=0
  while [ "$waited" -lt 80 ]; do
    docker exec "$PG" pg_isready -U postgres -q 2>/dev/null && break
    sleep 2; waited=$((waited + 2))
  done
  docker exec -e PGPASSWORD="$PGPASS" "$PG" psql -U postgres -d postgres -Atc \
    "CREATE DATABASE ${CONTROL_DB}" >/dev/null 2>&1

  CONTROL_URL="postgresql://postgres:${PGPASS}@127.0.0.1:${PGPORT}/${CONTROL_DB}"
  LEGACY_URL="postgresql://postgres:${PGPASS}@127.0.0.1:${PGPORT}/base_legacy_que_nao_existe"
  printf '   control: %s\n' "${CONTROL_URL/${PGPASS}/***}"
  printf '   legacy : base inexistente, de propósito\n'

  printf '   a aplicar as migrations do control plane...\n'
  ( cd "$REPO_ROOT" && CONTROL_DATABASE_URL="$CONTROL_URL" \
      npx prisma migrate deploy --config prisma-control.config.ts >/dev/null 2>&1 )
  local n; n=$(psql_c "SELECT count(*) FROM information_schema.tables WHERE table_name='GlobalAdmin'")
  eq_ "tabela GlobalAdmin existe" "1" "${n:-0}"
  eq_ "tabela começa vazia" "0" "$(psql_c 'SELECT count(*) FROM "GlobalAdmin"')"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste real: create-global-admin ===\n'
  command -v docker >/dev/null 2>&1 || { printf '  docker não encontrado\n'; return 2; }
  docker info >/dev/null 2>&1 || { printf '  daemon docker não responde\n'; return 2; }
  [ -f "${REPO_ROOT}/scripts/control/create-global-admin.ts" ] || {
    printf '  script não encontrado\n'; return 2; }

  setup

  # ── 9. Sem CONTROL_DATABASE_URL ────────────────────────────────────
  # Primeiro de todos: se falhasse aqui, tudo o resto seria suspeito.
  printf '\n9. Ausência de CONTROL_DATABASE_URL\n'
  local out err rc
  out=$(mktemp); err=$(mktemp)
  # DOTENV_CONFIG_PATH para um ficheiro VAZIO: `env -u` sozinho não chega,
  # porque o `import "dotenv/config"` repõe a variável a partir do .env do
  # repositório — que numa máquina de desenvolvimento aponta para o
  # control plane de PRODUÇÃO. Sem este isolamento, este teste chegou a
  # criar uma linha lá.
  printf '%s\n%s\n' "$TEST_PASSWORD" "$TEST_PASSWORD" | (
    cd "$REPO_ROOT" && env -u CONTROL_DATABASE_URL \
      DOTENV_CONFIG_PATH="$EMPTY_ENV" DATABASE_URL="$LEGACY_URL" \
      npx tsx scripts/control/create-global-admin.ts --yes --email x@y.pt --nome X >"$out" 2>"$err"
  ); rc=$?
  eq_ "recusa com rc=2" "2" "$rc"
  if grep -q 'CONTROL_DATABASE_URL em falta' "$err"; then ok_ "diz o que falta"; else bad_ "mensagem pouco clara"; fi
  eq_ "nada foi criado" "0" "$(psql_c 'SELECT count(*) FROM "GlobalAdmin"')"
  rm -f "$out" "$err"

  # ── 9b. Sem --yes e sem terminal: recusa ───────────────────────────
  # O `dotenv` carrega o .env do repositório, que numa máquina de
  # desenvolvimento aponta para PRODUÇÃO. Escrever num control plane que
  # ninguém confirmou é como este teste criou, uma vez, um administrador
  # na base errada.
  printf '\n9b. Destino não confirmado (sem --yes, sem terminal)\n'
  out=$(mktemp); err=$(mktemp)
  printf '%s\n%s\n' "$TEST_PASSWORD" "$TEST_PASSWORD" | (
    cd "$REPO_ROOT" && DOTENV_CONFIG_PATH="$EMPTY_ENV" \
      CONTROL_DATABASE_URL="$CONTROL_URL" DATABASE_URL="$LEGACY_URL" \
      npx tsx scripts/control/create-global-admin.ts --email nope@spharm.pt --nome N >"$out" 2>"$err"
  ); rc=$?
  eq_ "recusa com rc=7" "7" "$rc"
  if grep -q 'não foi confirmado' "$err"; then ok_ "diz que falta confirmar"; else bad_ "não explica"; fi
  if grep -q "${CONTROL_DB}" "$err"; then ok_ "mostra o destino (host/base)"; else bad_ "não mostra o destino"; fi
  if grep -qF "$PGPASS" "$err"; then bad_ "CREDENCIAIS NO ECRÃ"; else ok_ "sem credenciais no ecrã"; fi
  eq_ "nada foi criado" "0" "$(psql_c 'SELECT count(*) FROM "GlobalAdmin"')"
  rm -f "$out" "$err"

  # ── 4. Password fraca ──────────────────────────────────────────────
  printf '\n4. Password fraca (< 8 caracteres)\n'
  run_create $'curta\ncurta\n' --email admin@spharm.pt --nome "Admin"
  eq_ "recusa com rc=4" "4" "$RC"
  if grep -q 'demasiado curta' "$ERR"; then ok_ "explica a política"; else bad_ "não explica"; fi
  eq_ "nada foi criado" "0" "$(psql_c 'SELECT count(*) FROM "GlobalAdmin"')"
  rm -f "$OUT" "$ERR"

  # ── 5. Confirmação diferente ───────────────────────────────────────
  printf '\n5. Confirmação diferente\n'
  run_create "${TEST_PASSWORD}"$'\n'"${TEST_PASSWORD}x"$'\n' --email admin@spharm.pt --nome "Admin"
  eq_ "recusa com rc=4" "4" "$RC"
  if grep -q 'não coincide' "$ERR"; then ok_ "explica porquê"; else bad_ "não explica"; fi
  eq_ "nada foi criado" "0" "$(psql_c 'SELECT count(*) FROM "GlobalAdmin"')"
  rm -f "$OUT" "$ERR"

  # ── 1. Criação inicial ─────────────────────────────────────────────
  printf '\n1. Criação inicial\n'
  run_create "${TEST_PASSWORD}"$'\n'"${TEST_PASSWORD}"$'\n' \
    --email '  Admin@SPharm.PT  ' --nome "Administrador Global"
  eq_ "rc=0" "0" "$RC"
  eq_ "uma linha criada" "1" "$(psql_c 'SELECT count(*) FROM "GlobalAdmin"')"
  eq_ "email normalizado" "admin@spharm.pt" "$(psql_c 'SELECT email FROM "GlobalAdmin"')"
  eq_ "nome guardado" "Administrador Global" "$(psql_c 'SELECT nome FROM "GlobalAdmin"')"
  eq_ "estado ACTIVE" "ACTIVE" "$(psql_c 'SELECT estado FROM "GlobalAdmin"')"
  eq_ "ultimoLogin vazio" "" "$(psql_c 'SELECT coalesce(to_char("ultimoLogin",'"'"'YYYY'"'"'),'"''"') FROM "GlobalAdmin"')"
  if grep -q '"ok":true' "$OUT"; then ok_ "stdout tem o registo de auditoria"; else bad_ "stdout sem registo"; fi

  # ── 8. A password não aparece em lado nenhum ───────────────────────
  printf '\n8. Password fora do stdout e do stderr\n'
  if grep -qF "$TEST_PASSWORD" "$OUT"; then bad_ "PASSWORD NO STDOUT"; else ok_ "stdout limpo"; fi
  if grep -qF "$TEST_PASSWORD" "$ERR"; then bad_ "PASSWORD NO STDERR"; else ok_ "stderr limpo"; fi
  local hash; hash=$(psql_c 'SELECT "passwordHash" FROM "GlobalAdmin"')
  if grep -qF "$hash" "$OUT" || grep -qF "$hash" "$ERR"; then
    bad_ "o passwordHash foi impresso"
  else
    ok_ "passwordHash não é impresso"
  fi
  rm -f "$OUT" "$ERR"

  # ── 6. Hash bcrypt válido ──────────────────────────────────────────
  printf '\n6. Hash bcrypt\n'
  # Padrões literais: o `$` faz parte do formato bcrypt, não é expansão.
  # shellcheck disable=SC2016
  case "$hash" in
    '$2a$10$'*|'$2b$10$'*|'$2y$10$'*) ok_ "prefixo bcrypt com custo 10: ${hash:0:7}" ;;
    *) bad_ "formato inesperado: ${hash:0:12}" ;;
  esac
  eq_ "comprimento 60" "60" "${#hash}"

  # ── 7. Login com a password correcta ───────────────────────────────
  printf '\n7. Verificação com bcrypt.compare\n'
  local verify vfile="${REPO_ROOT}/.verify-ga-tmp.ts"
  cat > "$vfile" <<'TS'
import bcrypt from "bcryptjs";
const h = process.env.HASH as string;
const p = process.env.PW as string;
Promise.all([bcrypt.compare(p, h), bcrypt.compare(p + "x", h)]).then(([ok, no]) => {
  process.stdout.write(`${ok}:${no}`);
});
TS
  verify=$( cd "$REPO_ROOT" && HASH="$hash" PW="$TEST_PASSWORD" npx tsx .verify-ga-tmp.ts 2>/dev/null )
  rm -f "$vfile"
  eq_ "password correcta valida, errada não" "true:false" "$verify"

  # ── 2. Tabela já não vazia ─────────────────────────────────────────
  printf '\n2. Tabela já não vazia\n'
  run_create "${TEST_PASSWORD}"$'\n'"${TEST_PASSWORD}"$'\n' --email outro@spharm.pt --nome "Outro"
  eq_ "recusa com rc=3" "3" "$RC"
  if grep -q 'allow-existing' "$ERR"; then ok_ "indica a flag explícita"; else bad_ "não indica como prosseguir"; fi
  eq_ "continua com uma linha" "1" "$(psql_c 'SELECT count(*) FROM "GlobalAdmin"')"
  rm -f "$OUT" "$ERR"

  # ── 3. Email duplicado ─────────────────────────────────────────────
  printf '\n3. Email duplicado (com --allow-existing)\n'
  run_create "${TEST_PASSWORD}"$'\n'"${TEST_PASSWORD}"$'\n' \
    --email ADMIN@spharm.pt --nome "Duplicado" --allow-existing
  eq_ "recusa com rc=5" "5" "$RC"
  eq_ "continua com uma linha" "1" "$(psql_c 'SELECT count(*) FROM "GlobalAdmin"')"
  # A password do admin existente NÃO pode ter mudado.
  eq_ "hash do admin existente inalterado" "$hash" "$(psql_c 'SELECT "passwordHash" FROM "GlobalAdmin"')"
  eq_ "nome do admin existente inalterado" "Administrador Global" "$(psql_c 'SELECT nome FROM "GlobalAdmin"')"
  rm -f "$OUT" "$ERR"

  # ── --allow-existing com email novo funciona ───────────────────────
  printf '\n3b. Segundo admin, explicitamente pedido\n'
  run_create "${TEST_PASSWORD}"$'\n'"${TEST_PASSWORD}"$'\n' \
    --email segundo@spharm.pt --nome "Segundo" --allow-existing
  eq_ "rc=0" "0" "$RC"
  eq_ "duas linhas" "2" "$(psql_c 'SELECT count(*) FROM "GlobalAdmin"')"
  rm -f "$OUT" "$ERR"

  # ── 10. Não toca na base legacy ────────────────────────────────────
  printf '\n10. A base legacy nunca é usada\n'
  # O DATABASE_URL usado em TODAS as execuções acima aponta para uma base
  # inexistente. Se o script lhe tocasse, teria falhado a ligar — e no
  # entanto criou os administradores. Isto é a prova.
  local legacy_exists
  legacy_exists=$(docker exec -e PGPASSWORD="$PGPASS" "$PG" psql -U postgres -d postgres -Atc \
    "SELECT count(*) FROM pg_database WHERE datname='base_legacy_que_nao_existe'" 2>/dev/null)
  eq_ "a base legacy não existe mesmo" "0" "$legacy_exists"
  ok_ "administradores criados com DATABASE_URL inválido — a legacy nunca foi tocada"
  # E o código não importa o cliente da app em lado nenhum.
  if grep -qE 'from "@/lib/prisma"|generated/prisma/client' "${REPO_ROOT}/scripts/control/create-global-admin.ts"; then
    bad_ "o script importa o cliente da base da app"
  else
    ok_ "o script não importa o cliente da base da app"
  fi
  if grep -q 'getControlPrismaCli' "${REPO_ROOT}/scripts/control/create-global-admin.ts"; then
    ok_ "usa o cliente do control plane"
  else
    bad_ "não usa o cliente do control plane"
  fi

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
