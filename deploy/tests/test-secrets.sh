#!/usr/bin/env bash
# deploy/tests/test-secrets.sh
#
# Teste de regressão para a falha real do install-platform.sh:
#
#   rc=141
#   common.sh:640  head -c "${1:-40}"
#   install-platform.sh:240  value=$($value_cmd)
#
# CAUSA: `LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40`.
# O `head` fecha o pipe ao fim de 40 bytes; o `tr`, que lê de uma fonte
# INFINITA, recebe SIGPIPE e morre com 141. Com `set -o pipefail` a pipeline
# devolve 141, a substituição de comando falha e o `set -e` aborta.
#
# Cobre:
#   · comprimento exacto dos geradores, com muitas repetições
#   · execução sob `set -Eeuo pipefail` sem rc=141
#   · auditoria: nenhuma pipeline lê de fonte não-limitada para um
#     consumidor que termina cedo
#   · recuperação de execução parcial: ficheiro inexistente, ficheiro
#     truncado, chave válida, chave vazia, segunda passagem idempotente
#   · nenhum segredo escrito nos logs
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

set -uo pipefail

SCRIPTS_DIR=${SCRIPTS_DIR:-/work/deploy/scripts}
WORK=/tmp/spharmmt-sectest

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok_ "$d"; else bad_ "$d"; fi; }
refute(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then bad_ "$d"; else ok_ "$d"; fi; }
eq_()   { if [ "$2" = "$3" ]; then ok_ "$1 → ${3}"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi; }

# ═════════════════════════════════════════════════════════════════════════
# 1. O padrão antigo falha mesmo; o novo não
# ═════════════════════════════════════════════════════════════════════════
test_sigpipe() {
  printf '\n1. SIGPIPE sob pipefail\n'

  # Reproduz a implementação antiga, isolada.
  local rc=0
  bash -c 'set -Eeuo pipefail; v=$(LC_ALL=C tr -dc "A-Za-z0-9" < /dev/urandom | head -c 40); echo "$v"' \
    >/dev/null 2>&1 || rc=$?
  eq_ "implementação antiga devolve 141 (SIGPIPE)" "141" "$rc"

  rc=0
  bash -c "set -Eeuo pipefail
           . '${SCRIPTS_DIR}/lib/common.sh'
           v=\$(gen_password 40); [ \${#v} -eq 40 ]" >/dev/null 2>&1 || rc=$?
  eq_ "implementação nova devolve 0 sob pipefail" "0" "$rc"
}

# ═════════════════════════════════════════════════════════════════════════
# 2. Geradores: comprimento exacto e alfabeto seguro para .env
# ═════════════════════════════════════════════════════════════════════════
test_generators() {
  printf '\n2. Geradores\n'
  # shellcheck disable=SC1091
  . "${SCRIPTS_DIR}/lib/common.sh"

  local n bad=0 v
  for n in 1 8 16 40 64 100; do
    v=$(gen_password "$n")
    [ "${#v}" -eq "$n" ] || { bad_ "gen_password ${n} → comprimento ${#v}"; bad=1; }
  done
  [ "$bad" = "0" ] && ok_ "gen_password devolve o comprimento exacto (1,8,16,40,64,100)"

  # 200 amostras: apanha o caso em que uma volta do laço encurta o resultado.
  bad=0
  local _i
  for _i in $(seq 1 200); do
    v=$(gen_password 40)
    [ "${#v}" -eq 40 ] || { bad=1; break; }
    case "$v" in *[!A-Za-z0-9]*) bad=2; break ;; esac
  done
  case "$bad" in
    0) ok_ "200 amostras: sempre 40 chars, sempre [A-Za-z0-9]" ;;
    1) bad_ "200 amostras: comprimento errado numa delas" ;;
    2) bad_ "200 amostras: caractere fora de [A-Za-z0-9]" ;;
  esac

  v=$(gen_hex 32);    eq_ "gen_hex 32 → 64 chars"    "64" "${#v}"
  case "$v" in *[!0-9a-f]*) bad_ "gen_hex fora de [0-9a-f]" ;; *) ok_ "gen_hex só [0-9a-f]" ;; esac

  v=$(gen_base64 32)
  assert "gen_base64 sem newlines" bash -c "case '$v' in *\$'\n'*) exit 1;; *) exit 0;; esac"
  if [ "${#v}" -ge 40 ]; then ok_ "gen_base64 com comprimento razoável (${#v})"; else bad_ "gen_base64 curto"; fi

  # Entropia: duas chamadas nunca dão o mesmo.
  if [ "$(gen_password 40)" != "$(gen_password 40)" ]; then
    ok_ "duas gerações dão valores diferentes"
  else
    bad_ "gerador repetiu valor"
  fi
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Auditoria: fontes não-limitadas em pipelines
# ═════════════════════════════════════════════════════════════════════════
test_audit() {
  printf '\n3. Auditoria de pipelines\n'
  # O padrão fatal: fonte infinita + consumidor que termina cedo.
  refute "nenhuma pipeline lê /dev/urandom para head/tail" \
    bash -c "grep -rn '/dev/urandom' '${SCRIPTS_DIR}' | grep -v '^[^:]*:[0-9]*: *#' | grep -qE '\\|[[:space:]]*(head|tail)'"
  refute "nenhuma pipeline lê /dev/random para head/tail" \
    bash -c "grep -rn '/dev/random' '${SCRIPTS_DIR}' | grep -qE '\\|[[:space:]]*(head|tail)'"
  # `--yes|-y)` num case não é o comando `yes` — daí o filtro.
  refute "nenhum 'yes |' (gerador infinito)" \
    bash -c "grep -rnE '(^|[;&(]|[[:space:]])yes[[:space:]]+\\|' '${SCRIPTS_DIR}' | grep -v -- '--yes' | grep -q ."

  # Sondas de existência: -print -quit em vez de `| head -1`, que remove a
  # possibilidade de SIGPIPE em vez de a mitigar.
  assert "verificador usa find -print -quit" \
    grep -q 'print -quit' "${SCRIPTS_DIR}/verify-platform.sh"
  assert "healthcheck usa find -print -quit" \
    grep -q 'print -quit' "${SCRIPTS_DIR}/healthcheck.sh"

  # As restantes pipelines com head/tail leem saídas pequenas e finitas,
  # mas têm de ter guarda para o rc não escapar sob pipefail.
  local unguarded
  unguarded=$(grep -rnE '\|[[:space:]]*(head|tail)[[:space:]]' "${SCRIPTS_DIR}" \
              | grep -v '|| true' | grep -v '|| echo' | grep -v '^[^:]*:[0-9]*: *#' \
              | grep -vE 'done <|< <\(' || true)
  if [ -z "$unguarded" ]; then
    ok_ "todas as pipelines head/tail restantes têm guarda de rc"
  else
    bad_ "pipelines head/tail sem guarda:"
    printf '%s\n' "$unguarded" | sed 's/^/       /'
  fi
}

# ═════════════════════════════════════════════════════════════════════════
# Ambiente para secret_ensure
# ═════════════════════════════════════════════════════════════════════════
load_secret_logic() {
  rm -rf "$WORK"; mkdir -p "$WORK"
  export SPHARMMT_SECRETS_FILE="${WORK}/platform.secrets.env"
  export DRY_RUN=0 NO_COLOR=1
  # shellcheck disable=SC1091
  . "${SCRIPTS_DIR}/lib/common.sh"
  log_init
  eval "$(sed -n '/^secret_value() {/,/^}/p;/^secret_ensure() {/,/^}/p' \
            "${SCRIPTS_DIR}/install-platform.sh")"
}

key_count() {
  local n
  n=$(grep -cE "^${1}=" "$SPHARMMT_SECRETS_FILE" 2>/dev/null) || n=0
  printf '%s' "${n:-0}"
}

# ═════════════════════════════════════════════════════════════════════════
# 4. Ficheiro inexistente
# ═════════════════════════════════════════════════════════════════════════
test_missing_file() {
  printf '\n4. Ficheiro de segredos inexistente\n'
  rm -f "$SPHARMMT_SECRETS_FILE"
  install -m 0600 -o root -g root /dev/null "$SPHARMMT_SECRETS_FILE"

  local rc=0
  secret_ensure AUTH_SECRET "gen_base64 32" "sessoes" >/dev/null 2>&1 || rc=$?
  eq_ "secret_ensure termina com 0"       "0" "$rc"
  eq_ "chave escrita uma única vez"       "1" "$(key_count AUTH_SECRET)"
  assert "valor não vazio"                test -n "$(secret_value AUTH_SECRET)"
  eq_ "modo preservado"                   "600 root:root" "$(stat -c '%a %U:%G' "$SPHARMMT_SECRETS_FILE")"
}

# ═════════════════════════════════════════════════════════════════════════
# 5. Chave válida existente → nunca regenerada
# ═════════════════════════════════════════════════════════════════════════
test_existing_valid() {
  printf '\n5. Chave existente e válida\n'
  local before after rc=0
  before=$(secret_value AUTH_SECRET)
  secret_ensure AUTH_SECRET "gen_base64 32" "sessoes" >/dev/null 2>&1 || rc=$?
  after=$(secret_value AUTH_SECRET)
  eq_ "termina com 0"                     "0" "$rc"
  assert "valor PRESERVADO (nunca regenerado)" test "$before" = "$after"
  eq_ "continua uma única linha"          "1" "$(key_count AUTH_SECRET)"
}

# ═════════════════════════════════════════════════════════════════════════
# 6. Execução parcial: chave presente mas VAZIA
# ═════════════════════════════════════════════════════════════════════════
test_empty_value() {
  printf '\n6. Chave presente com valor vazio (execução parcial)\n'
  printf 'CRON_SECRET=\n' >> "$SPHARMMT_SECRETS_FILE"
  eq_ "cenário: chave vazia presente"     "" "$(secret_value CRON_SECRET)"

  local rc=0
  secret_ensure CRON_SECRET "gen_hex 24" "cron" >/dev/null 2>&1 || rc=$?
  eq_ "termina com 0"                     "0" "$rc"
  assert "valor preenchido"               test -n "$(secret_value CRON_SECRET)"
  # O ponto do caso: substituir, não acrescentar uma segunda definição.
  eq_ "SEM duplicação da variável"        "1" "$(key_count CRON_SECRET)"
  eq_ "modo preservado"                   "600 root:root" "$(stat -c '%a %U:%G' "$SPHARMMT_SECRETS_FILE")"
}

# ═════════════════════════════════════════════════════════════════════════
# 7. Ficheiro truncado a meio de uma escrita
# ═════════════════════════════════════════════════════════════════════════
test_truncated_file() {
  printf '\n7. Ficheiro truncado a meio\n'
  # Simula a morte do script depois do comentário e antes do valor.
  printf '# Token do Admin Wizard\nADMIN_API_TOKEN=' >> "$SPHARMMT_SECRETS_FILE"

  local rc=0
  secret_ensure ADMIN_API_TOKEN "gen_hex 32" "Token do Admin Wizard" >/dev/null 2>&1 || rc=$?
  eq_ "termina com 0"                     "0" "$rc"
  assert "valor preenchido"               test -n "$(secret_value ADMIN_API_TOKEN)"
  eq_ "sem duplicação"                    "1" "$(key_count ADMIN_API_TOKEN)"
  eq_ "comentário não duplicado"          "1" "$(grep -c '^# Token do Admin Wizard$' "$SPHARMMT_SECRETS_FILE")"
  assert "chaves anteriores intactas"     bash -c "[ -n '$(secret_value AUTH_SECRET)' ] && [ -n '$(secret_value CRON_SECRET)' ]"
}

# ═════════════════════════════════════════════════════════════════════════
# 8. Segunda execução completa: idempotente
# ═════════════════════════════════════════════════════════════════════════
test_idempotent() {
  printf '\n8. Segunda execução completa\n'
  local before after
  before=$(sha256sum "$SPHARMMT_SECRETS_FILE" | cut -d' ' -f1)
  secret_ensure AUTH_SECRET     "gen_base64 32" "sessoes"              >/dev/null 2>&1
  secret_ensure CRON_SECRET     "gen_hex 24"    "cron"                 >/dev/null 2>&1
  secret_ensure ADMIN_API_TOKEN "gen_hex 32"    "Token do Admin Wizard" >/dev/null 2>&1
  after=$(sha256sum "$SPHARMMT_SECRETS_FILE" | cut -d' ' -f1)
  assert "ficheiro byte-a-byte inalterado" test "$before" = "$after"
  eq_ "sem duplicados (AUTH_SECRET)"      "1" "$(key_count AUTH_SECRET)"
  eq_ "sem duplicados (CRON_SECRET)"      "1" "$(key_count CRON_SECRET)"
  eq_ "sem duplicados (ADMIN_API_TOKEN)"  "1" "$(key_count ADMIN_API_TOKEN)"
}

# ═════════════════════════════════════════════════════════════════════════
# 9. Nenhum segredo nos logs
# ═════════════════════════════════════════════════════════════════════════
test_no_leak() {
  printf '\n9. Segredos fora dos logs\n'
  local v_auth v_cron v_admin leaked=0 f
  v_auth=$(secret_value AUTH_SECRET)
  v_cron=$(secret_value CRON_SECRET)
  v_admin=$(secret_value ADMIN_API_TOKEN)

  while IFS= read -r f; do
    [ -z "$f" ] && continue
    for v in "$v_auth" "$v_cron" "$v_admin"; do
      [ -n "$v" ] || continue
      if grep -qF -- "$v" "$f" 2>/dev/null; then
        bad_ "segredo encontrado em ${f}"; leaked=1
      fi
    done
  done < <(find /var/log/spharmmt /tmp/spharmmt-logs -type f -name '*.log' 2>/dev/null || true)

  [ "$leaked" = "0" ] && ok_ "nenhum segredo em qualquer ficheiro de log"

  # E também não pode aparecer no stdout do próprio secret_ensure.
  local out
  printf 'EMAIL_CONFIG_SECRET=\n' >> "$SPHARMMT_SECRETS_FILE"
  out=$(secret_ensure EMAIL_CONFIG_SECRET "gen_hex 32" "email" 2>&1)
  local v_email; v_email=$(secret_value EMAIL_CONFIG_SECRET)
  case "$out" in
    *"$v_email"*) bad_ "secret_ensure imprimiu o valor no stdout" ;;
    *) ok_ "secret_ensure não imprime o valor" ;;
  esac
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: geração e recuperação de segredos ===\n'
  [ "$(id -u)" -eq 0 ] || { printf '  precisa de root\n'; return 1; }
  test_sigpipe
  test_generators
  test_audit
  load_secret_logic
  test_missing_file
  test_existing_valid
  test_empty_value
  test_truncated_file
  test_idempotent
  test_no_leak

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
