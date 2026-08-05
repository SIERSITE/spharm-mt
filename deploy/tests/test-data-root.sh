#!/usr/bin/env bash
# deploy/tests/test-data-root.sh
#
# Teste de regressão para o bloqueador reproduzido na VPS:
#
#   /dev/sdb1 montado em /data, /data/postgres e /data/backups presentes,
#   e mesmo assim, depois de install-platform.sh --yes:
#       SPHARMMT_DATA_ROOT="/opt/spharmmt"
#       SPHARMMT_BACKUP_DIR="/opt/spharmmt/backups"
#
# CAUSA: o platform.conf é carregado no topo do common.sh e define
# SPHARMMT_DATA_ROOT. A detecção estava guardada por
#     if [ -z "${SPHARMMT_DATA_ROOT:-}" ]
# portanto NUNCA corria quando o conf existia — e o write_conf regravava o
# mesmo valor. Uma instalação feita antes de o disco existir ficava presa
# em /opt/spharmmt para sempre. Ciclo auto-perpetuante.
#
# Cobre:
#   1. sem /data montado                        → /opt/spharmmt
#   2. /data montado antes da 1ª instalação     → /data
#   3. /data montado depois, SEM dados          → converge para /data
#   4. configuração antiga COM dados reais      → recusa, não move
#   5. /data é apenas pasta, não mountpoint     → recusado
#   6. segunda execução idempotente
#
# Usa montagens REAIS (loop device com ext4) — a distinção entre "pasta" e
# "ponto de montagem" é precisamente o que se está a testar, e um stub não
# a exercitaria.
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

set -uo pipefail

SCRIPTS_DIR=${SCRIPTS_DIR:-/work/deploy/scripts}
WORK=/tmp/spharmmt-datatest
IMG="${WORK}/data.img"
MNT=/data

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok_ "$d"; else bad_ "$d"; fi; }
refute(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then bad_ "$d"; else ok_ "$d"; fi; }
eq_()   { if [ "$2" = "$3" ]; then ok_ "$1 → ${3}"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi; }

MOUNTED=0
mount_data() {
  [ "$MOUNTED" = "1" ] && return 0
  mkdir -p "$MNT"
  mount -o loop "$IMG" "$MNT" 2>/dev/null || return 1
  MOUNTED=1
}
umount_data() {
  [ "$MOUNTED" = "0" ] && return 0
  umount "$MNT" 2>/dev/null || true
  MOUNTED=0
}
cleanup() { umount_data; rm -rf "$WORK"; }
trap cleanup EXIT

setup() {
  rm -rf "$WORK"; mkdir -p "$WORK"
  getent group spharmmt >/dev/null 2>&1 || groupadd spharmmt
  id deploy >/dev/null 2>&1 || useradd -M -g spharmmt deploy
  truncate -s 64M "$IMG"
  mkfs.ext4 -q -F "$IMG" 2>/dev/null
  rm -rf "$MNT"; mkdir -p "$MNT"
}

# Resolve o data root como o common.sh o faz, com um platform.conf à escolha.
resolve_with_conf() {
  local conf=$1
  env -u SPHARMMT_DATA_ROOT -u SPHARMMT_PG_DIR -u SPHARMMT_BACKUP_DIR \
      -u SPHARMMT_POSTGRES_DATA_DIR -u SPHARMMT_DOCKER_DATA_DIR \
      SPHARMMT_CONF_FILE="$conf" \
    bash -c ". '${SCRIPTS_DIR}/lib/common.sh'
             printf '%s|%s|%s|%s\n' \"\$SPHARMMT_DATA_ROOT\" \"\$SPHARMMT_POSTGRES_DATA_DIR\" \
                    \"\$SPHARMMT_BACKUP_DIR\" \"\$SPHARMMT_DATA_ROOT_SOURCE\"" 2>/dev/null
}

write_conf() { printf 'SPHARMMT_DATA_ROOT="%s"\n' "$1" > "${WORK}/platform.conf"; }
no_conf()    { rm -f "${WORK}/platform.conf"; }

# Corre só a convergência do install-platform, sem instalar nada.
run_converge() {
  local conf=$1
  env -u SPHARMMT_DATA_ROOT -u SPHARMMT_PG_DIR -u SPHARMMT_BACKUP_DIR \
      -u SPHARMMT_POSTGRES_DATA_DIR -u SPHARMMT_DOCKER_DATA_DIR \
      SPHARMMT_CONF_FILE="$conf" DRY_RUN=0 NO_COLOR=1 \
    bash -c "
      . '${SCRIPTS_DIR}/lib/common.sh'
      log_init
      $(sed -n '/^converge_data_root() {/,/^}/p' "${SCRIPTS_DIR}/install-platform.sh")
      converge_data_root >/dev/null 2>&1 || exit \$?
      printf '%s|%s|%s\n' \"\$SPHARMMT_DATA_ROOT\" \"\$SPHARMMT_POSTGRES_DATA_DIR\" \"\$SPHARMMT_BACKUP_DIR\"
    "
}

# ═════════════════════════════════════════════════════════════════════════
# 1. Sem /data montado
# ═════════════════════════════════════════════════════════════════════════
test_no_mount() {
  printf '\n1. Sem /data montado\n'
  umount_data
  no_conf
  local r; r=$(resolve_with_conf "${WORK}/platform.conf")
  eq_ "data root"        "/opt/spharmmt"                  "$(printf '%s' "$r" | cut -d'|' -f1)"
  eq_ "postgres data"    "/opt/spharmmt/postgres/data"    "$(printf '%s' "$r" | cut -d'|' -f2)"
  eq_ "backups"          "/opt/spharmmt/backups"          "$(printf '%s' "$r" | cut -d'|' -f3)"
  eq_ "origem"           "default"                        "$(printf '%s' "$r" | cut -d'|' -f4)"
}

# ═════════════════════════════════════════════════════════════════════════
# 2. /data montado antes da primeira instalação
# ═════════════════════════════════════════════════════════════════════════
test_mounted_first_install() {
  printf '\n2. /data montado antes da 1ª instalação (sem platform.conf)\n'
  if ! mount_data; then bad_ "não foi possível montar o loop device"; return; fi
  mkdir -p "${MNT}/postgres/data" "${MNT}/backups/postgres"
  no_conf
  local r; r=$(resolve_with_conf "${WORK}/platform.conf")
  eq_ "data root"     "/data"                 "$(printf '%s' "$r" | cut -d'|' -f1)"
  eq_ "postgres data" "/data/postgres/data"   "$(printf '%s' "$r" | cut -d'|' -f2)"
  eq_ "backups"       "/data/backups"         "$(printf '%s' "$r" | cut -d'|' -f3)"
  eq_ "origem"        "detectado"             "$(printf '%s' "$r" | cut -d'|' -f4)"
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Reprodução exacta da VPS: conf antigo + /data montado, sem dados
# ═════════════════════════════════════════════════════════════════════════
test_converge() {
  printf '\n3. Configuração antiga (/opt/spharmmt) com /data montado e vazio\n'
  mount_data
  mkdir -p "${MNT}/postgres/data" "${MNT}/backups/postgres"
  write_conf /opt/spharmmt

  # Antes: é exactamente o bug — o conf vence e a detecção nem corre.
  local r; r=$(resolve_with_conf "${WORK}/platform.conf")
  eq_ "conf tem precedência na leitura (esperado)" "conf" "$(printf '%s' "$r" | cut -d'|' -f4)"
  eq_ "leitura crua devolve o valor antigo"        "/opt/spharmmt" "$(printf '%s' "$r" | cut -d'|' -f1)"

  # Depois da convergência:
  local c rc=0
  c=$(run_converge "${WORK}/platform.conf") || rc=$?
  eq_ "convergência termina com 0"  "0" "$rc"
  eq_ "data root convergido"        "/data"               "$(printf '%s' "$c" | cut -d'|' -f1)"
  eq_ "postgres data convergido"    "/data/postgres/data" "$(printf '%s' "$c" | cut -d'|' -f2)"
  eq_ "backups convergido"          "/data/backups"       "$(printf '%s' "$c" | cut -d'|' -f3)"
}

# ═════════════════════════════════════════════════════════════════════════
# 4. Configuração antiga COM dados reais → recusa
# ═════════════════════════════════════════════════════════════════════════
test_refuses_with_data() {
  printf '\n4. Configuração antiga com dados reais\n'
  mount_data
  mkdir -p "${MNT}/postgres/data" "${MNT}/backups/postgres"
  write_conf /opt/spharmmt

  # Dados reais no caminho antigo.
  mkdir -p /opt/spharmmt/postgres/data
  printf '16\n' > /opt/spharmmt/postgres/data/PG_VERSION

  local rc=0
  run_converge "${WORK}/platform.conf" >/dev/null 2>&1 || rc=$?
  eq_ "recusa com rc=2 (pré-condição)" "2" "$rc"
  assert "os dados antigos continuam intactos" test -f /opt/spharmmt/postgres/data/PG_VERSION
  refute "NÃO copiou nada para o disco novo" test -f /data/postgres/data/PG_VERSION

  # A mensagem tem de dizer como migrar.
  local out
  out=$(env -u SPHARMMT_DATA_ROOT SPHARMMT_CONF_FILE="${WORK}/platform.conf" DRY_RUN=0 NO_COLOR=1 \
        bash -c "
          . '${SCRIPTS_DIR}/lib/common.sh'
          log_init
          $(sed -n '/^converge_data_root() {/,/^}/p' "${SCRIPTS_DIR}/install-platform.sh")
          converge_data_root" 2>&1 || true)
  assert "explica que a convergência foi recusada" \
    bash -c "printf '%s' \"\$1\" | grep -q 'CONVERGÊNCIA RECUSADA'" _ "$out"
  assert "inclui instruções de migração (rsync)" \
    bash -c "printf '%s' \"\$1\" | grep -q 'rsync'" _ "$out"
  assert "diz que nada foi movido" \
    bash -c "printf '%s' \"\$1\" | grep -q 'NENHUM dado foi movido'" _ "$out"

  rm -rf /opt/spharmmt/postgres/data
}

# ═════════════════════════════════════════════════════════════════════════
# 5. /data é apenas uma pasta, não um ponto de montagem
# ═════════════════════════════════════════════════════════════════════════
test_plain_directory() {
  printf '\n5. /data é apenas uma pasta no disco do sistema\n'
  umount_data
  mkdir -p "${MNT}/postgres" "${MNT}/backups"
  no_conf

  refute "is_mountpoint recusa uma pasta" \
    bash -c ". '${SCRIPTS_DIR}/lib/common.sh'; is_mountpoint /data"
  eq_ "findmnt --target devolve o mount que a CONTÉM" "/" \
      "$(findmnt -no TARGET --target /data 2>/dev/null)"

  local r; r=$(resolve_with_conf "${WORK}/platform.conf")
  eq_ "data root NÃO usa a pasta" "/opt/spharmmt" "$(printf '%s' "$r" | cut -d'|' -f1)"

  local c rc=0
  c=$(run_converge "${WORK}/platform.conf") || rc=$?
  eq_ "convergência não a adopta" "/opt/spharmmt" "$(printf '%s' "$c" | cut -d'|' -f1)"
  rm -rf "${MNT}/postgres" "${MNT}/backups"
}

# ═════════════════════════════════════════════════════════════════════════
# 6. Idempotência
# ═════════════════════════════════════════════════════════════════════════
test_idempotent() {
  printf '\n6. Segunda execução\n'
  mount_data
  mkdir -p "${MNT}/postgres/data" "${MNT}/backups/postgres"
  write_conf /data
  local a b
  a=$(run_converge "${WORK}/platform.conf")
  b=$(run_converge "${WORK}/platform.conf")
  eq_ "1ª passagem"           "/data|/data/postgres/data|/data/backups" "$a"
  assert "2ª passagem idêntica" test "$a" = "$b"
}

# ═════════════════════════════════════════════════════════════════════════
# 7. Os scripts consomem a variável canónica
# ═════════════════════════════════════════════════════════════════════════
test_scripts() {
  printf '\n7. Propagação nos scripts\n'
  assert "common.sh define SPHARMMT_POSTGRES_DATA_DIR" \
    grep -q 'SPHARMMT_POSTGRES_DATA_DIR' "${SCRIPTS_DIR}/lib/common.sh"
  assert "common.sh regista a proveniência do valor" \
    grep -q 'SPHARMMT_DATA_ROOT_SOURCE' "${SCRIPTS_DIR}/lib/common.sh"
  assert "install-platform persiste POSTGRES_DATA_DIR no conf" \
    grep -q 'SPHARMMT_POSTGRES_DATA_DIR="' "${SCRIPTS_DIR}/install-platform.sh"
  assert "platform.env exporta POSTGRES_DATA_DIR" \
    grep -q 'POSTGRES_DATA_DIR=' "${SCRIPTS_DIR}/install-platform.sh"
  assert "verificador compara configurado vs montado" \
    grep -q 'data root coerente' "${SCRIPTS_DIR}/verify-platform.sh"
  assert "healthcheck usa findmnt --target" \
    grep -q 'findmnt -no TARGET --target /data' "${SCRIPTS_DIR}/healthcheck.sh"
  assert "backup usa SPHARMMT_BACKUP_DIR" \
    grep -q 'SPHARMMT_BACKUP_DIR' "${SCRIPTS_DIR}/backup-platform.sh"
  assert "restore usa SPHARMMT_BACKUP_DIR" \
    grep -q 'SPHARMMT_BACKUP_DIR' "${SCRIPTS_DIR}/restore-platform.sh"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: resolução e convergência do data root ===\n'
  [ "$(id -u)" -eq 0 ] || { printf '  precisa de root\n'; return 1; }
  setup
  test_no_mount
  test_mounted_first_install
  test_converge
  test_refuses_with_data
  test_plain_directory
  test_idempotent
  test_scripts

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
