#!/usr/bin/env bash
# deploy/tests/test-permissions.sh
#
# Teste de regressão para a divergência real encontrada na VPS:
#
#   /opt/spharmmt/secrets       → 2700 root:root      (esperado 0700)
#   /opt/spharmmt/postgres/data → 2700 deploy:spharmmt
#
# CAUSA: o GNU chmod PRESERVA setuid/setgid em DIRECTÓRIOS quando o modo é
# numérico — mesmo com 4 dígitos. Sobre um directório 2750, `chmod 0700`
# deixa 2700. E um directório criado dentro de um pai com setgid herda-o
# logo no mkdir. Como `secrets` era criado no mesmo laço que os restantes
# (2750) e só depois ajustado para 0700, ficava com setgid para sempre.
#
# Política reconciliada, e deliberadamente DIFERENTE para cada um:
#   secrets       0700 root:root, sem setgid, ficheiros 0600 root:root
#   postgres/data 0700 ou 2700, owner deploy:spharmmt, nada para others
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

set -uo pipefail

SCRIPTS_DIR=${SCRIPTS_DIR:-/work/deploy/scripts}
WORK=/tmp/spharmmt-permtest

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok_ "$d"; else bad_ "$d"; fi; }
refute(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then bad_ "$d"; else ok_ "$d"; fi; }
eq_()   { if [ "$2" = "$3" ]; then ok_ "$1 → ${3}"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi; }

# ═════════════════════════════════════════════════════════════════════════
# As duas regras da política, tal como o verificador as aplica.
# ═════════════════════════════════════════════════════════════════════════

# secrets: 0700 root:root exacto, sem setgid, sem bits de grupo.
secrets_ok() {
  local d=$1
  [ "$(stat -c '%a %U:%G' "$d")" = "700 root:root" ] || return 1
  [ -z "$(find "$d" -maxdepth 0 -perm /g+rwx 2>/dev/null)" ] || return 1
  [ -z "$(find "$d" -type f \( ! -perm 600 -o ! -user root -o ! -group root \) 2>/dev/null | head -1)" ]
}

# postgres/data: 0700 OU 2700, owner correcto, nada para others.
pgdata_ok() {
  local d=$1 owner=$2
  case "$(stat -c '%a' "$d")" in 700|2700) ;; *) return 1 ;; esac
  [ "$(stat -c '%U:%G' "$d")" = "$owner" ] || return 1
  [ -z "$(find "$d" -maxdepth 0 -perm /o+rwx 2>/dev/null)" ]
}

setup() {
  rm -rf "$WORK"; mkdir -p "$WORK"
  getent group spharmmt >/dev/null 2>&1 || groupadd spharmmt
  id deploy >/dev/null 2>&1 || useradd -M -g spharmmt deploy
}

# ═════════════════════════════════════════════════════════════════════════
# 1. Reproduz a causa: chmod numérico não limpa setgid em directórios
# ═════════════════════════════════════════════════════════════════════════
test_chmod_semantics() {
  printf '\n1. Semântica do chmod (a causa)\n'
  printf '   %s\n' "$(chmod --version | head -1)"
  local d="${WORK}/parent"
  mkdir -p "$d"; chmod 2750 "$d"
  mkdir -p "${d}/child"
  eq_ "dir criado dentro de pai 2750 herda setgid" "2755" "$(stat -c '%a' "${d}/child")"
  chmod 0700 "${d}/child"
  eq_ "chmod 0700 NÃO limpa o setgid (a armadilha)" "2700" "$(stat -c '%a' "${d}/child")"
  chmod a-s "${d}/child"; chmod 0700 "${d}/child"
  eq_ "a-s seguido de 0700 limpa mesmo" "700" "$(stat -c '%a' "${d}/child")"
}

# ═════════════════════════════════════════════════════════════════════════
# 2. ensure_dir corrigido produz o modo pedido, exactamente
# ═════════════════════════════════════════════════════════════════════════
test_ensure_dir() {
  printf '\n2. ensure_dir\n'
  export DRY_RUN=0 NO_COLOR=1
  # shellcheck disable=SC1091
  . "${SCRIPTS_DIR}/lib/common.sh"
  log_init

  local root="${WORK}/opt"
  ensure_dir "$root" 2750 "deploy:spharmmt" >/dev/null 2>&1
  eq_ "raiz com setgid pedido" "2750" "$(stat -c '%a' "$root")"

  ensure_dir "${root}/secrets" 0700 root:root >/dev/null 2>&1
  eq_ "0700 dentro de pai com setgid dá mesmo 0700" "700" "$(stat -c '%a' "${root}/secrets")"
  eq_ "owner de secrets" "root:root" "$(stat -c '%U:%G' "${root}/secrets")"

  ensure_dir "${root}/pgdata" 2700 "deploy:spharmmt" >/dev/null 2>&1
  eq_ "2700 pedido explicitamente é respeitado" "2700" "$(stat -c '%a' "${root}/pgdata")"

  # Idempotência: repetir não altera nada.
  local before; before=$(stat -c '%a %U:%G' "${root}/secrets")
  ensure_dir "${root}/secrets" 0700 root:root >/dev/null 2>&1
  eq_ "segunda passagem é idempotente" "$before" "$(stat -c '%a %U:%G' "${root}/secrets")"
}

# ═════════════════════════════════════════════════════════════════════════
# 3. secrets — a regra estrita
# ═════════════════════════════════════════════════════════════════════════
test_secrets_policy() {
  printf '\n3. Política de secrets/\n'
  local d="${WORK}/secrets"
  mkdir -p "$d"

  chmod 2700 "$d"; chown root:root "$d"
  refute "2700 root:root deve FALHAR (setgid não é aceite)"  secrets_ok "$d"

  chmod a-s "$d"; chmod 0700 "$d"
  assert "0700 root:root deve PASSAR"                        secrets_ok "$d"

  chmod 0750 "$d"
  refute "0750 deve FALHAR (permissões de grupo)"            secrets_ok "$d"

  chmod 0707 "$d"
  refute "0707 deve FALHAR (permissões para others)"         secrets_ok "$d"

  chmod 0700 "$d"; chown root:root "$d"
  printf 'x\n' > "${d}/platform.secrets.env"
  chmod 0600 "${d}/platform.secrets.env"; chown root:root "${d}/platform.secrets.env"
  assert "ficheiro a 0600 root:root deve PASSAR"             secrets_ok "$d"

  chmod 0640 "${d}/platform.secrets.env"
  refute "ficheiro a 0640 deve FALHAR"                       secrets_ok "$d"

  chmod 0600 "${d}/platform.secrets.env"
  chown deploy:spharmmt "${d}/platform.secrets.env"
  refute "ficheiro com owner errado deve FALHAR"             secrets_ok "$d"

  # enforce_secret_file_modes repõe a política.
  chown root:root "${d}/platform.secrets.env"
  chmod 0644 "${d}/platform.secrets.env"
  SPHARMMT_ROOT="$WORK" enforce_secret_file_modes >/dev/null 2>&1
  assert "enforce_secret_file_modes repõe 0600 root:root"    secrets_ok "$d"
}

# ═════════════════════════════════════════════════════════════════════════
# 4. postgres/data — a regra tolerante ao setgid
# ═════════════════════════════════════════════════════════════════════════
test_pgdata_policy() {
  printf '\n4. Política de postgres/data\n'
  local d="${WORK}/pgdata"
  mkdir -p "$d"; chown deploy:spharmmt "$d"

  chmod 2700 "$d"
  assert "2700 deploy:spharmmt deve PASSAR"                  pgdata_ok "$d" "deploy:spharmmt"

  chmod a-s "$d"; chmod 0700 "$d"
  assert "0700 deploy:spharmmt também deve PASSAR"           pgdata_ok "$d" "deploy:spharmmt"

  chmod 2707 "$d"
  refute "2707 deve FALHAR (bits para others)"               pgdata_ok "$d" "deploy:spharmmt"

  chmod 2750 "$d"
  refute "2750 deve FALHAR (bits de grupo, PostgreSQL recusa)" pgdata_ok "$d" "deploy:spharmmt"

  chmod 2700 "$d"; chown root:root "$d"
  refute "owner errado deve FALHAR"                          pgdata_ok "$d" "deploy:spharmmt"
  chown deploy:spharmmt "$d"

  # As duas políticas são MESMO diferentes: o que passa numa falha na outra.
  chmod 2700 "$d"
  assert "2700 passa em postgres/data"                       pgdata_ok "$d" "deploy:spharmmt"
  refute "o MESMO 2700 falha em secrets"                     secrets_ok "$d"
}

# ═════════════════════════════════════════════════════════════════════════
# 5. Os scripts do pacote aplicam esta política
# ═════════════════════════════════════════════════════════════════════════
test_scripts() {
  printf '\n5. Scripts do pacote\n'
  local bs="${SCRIPTS_DIR}/bootstrap-vps.sh" ip="${SCRIPTS_DIR}/install-platform.sh"
  local vp="${SCRIPTS_DIR}/verify-platform.sh" cm="${SCRIPTS_DIR}/lib/common.sh"

  assert "ensure_dir limpa bits especiais em modos sem eles" grep -q 'chmod a-s' "$cm"
  assert "existe enforce_secret_file_modes"                  grep -q 'enforce_secret_file_modes()' "$cm"
  refute "bootstrap NÃO cria secrets no laço 2750" \
    bash -c "sed -n '/local dirs=(/,/^  )/p' '$bs' | grep -qw secrets"
  refute "install-platform NÃO cria secrets no laço 2750" \
    bash -c "sed -n '/local dirs=(/,/^  )/p' '$ip' | grep -qw secrets"
  # Padrões de grep sobre o código-fonte — as variáveis não podem expandir.
  # shellcheck disable=SC2016
  assert "bootstrap fixa secrets a 0700 root:root" \
    grep -q 'ensure_dir "${SPHARMMT_ROOT}/secrets" 0700 root:root' "$bs"
  # shellcheck disable=SC2016
  assert "bootstrap fixa postgres/data a 2700" \
    grep -q 'ensure_dir "${SPHARMMT_PG_DIR}/data" 2700' "$bs"
  assert "verificador exige 700 root:root em secrets" \
    grep -q "700 root:root' \]" "$vp"
  assert "verificador aceita 700 ou 2700 em postgres/data" \
    grep -q 'in 700|2700)' "$vp"
  assert "verificador limita o check de others a conteúdo sensível" \
    grep -q 'nada acessível a others em conteúdo sensível' "$vp"
  refute "verificador já não varre a árvore inteira" \
    grep -q 'nada world-readable na árvore' "$vp"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: política de permissões ===\n'
  [ "$(id -u)" -eq 0 ] || { printf '  precisa de root\n'; return 1; }
  setup
  test_chmod_semantics
  test_ensure_dir
  test_secrets_policy
  test_pgdata_policy
  test_scripts

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
