#!/usr/bin/env bash
# deploy/scripts/restore-platform.sh
#
# Restauro de um conjunto produzido por backup-platform.sh.
#
# ESTE SCRIPT É DESTRUTIVO. Substitui o conteúdo de uma base de dados.
# Por isso, e por esta ordem:
#   1. valida o SHA-256 de tudo o que vai usar — recusa se não bater;
#   2. valida a legibilidade do dump com `pg_restore --list`;
#   3. tira um dump de segurança da base actual ANTES de lhe tocar;
#   4. exige confirmação explícita (ou --yes) com o nome da base;
#   5. restaura numa transação por objecto (--exit-on-error) e valida
#      contagens no fim.
#
# Se o passo 5 falhar, o dump de segurança do passo 3 é o caminho de volta —
# e o script diz exactamente qual é o comando.
#
# Uso:
#   sudo ./restore-platform.sh --list
#   sudo ./restore-platform.sh --set 20260804-031500 --database spharmmt_control
#   sudo ./restore-platform.sh --set 20260804-031500 --all --yes
#
# Saída: 0 ok · 1 falha · 2 pré-condição · 3 validação pós-restauro · 4 uso
#        · 5 lock · 6 abortado

set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

SET_NAME=""
TARGET_DB=""
SOURCE_DB=""
DO_LIST=0
DO_ALL=0
DO_GLOBALS=0
SKIP_SAFETY=0
BACKUP_ROOT="${SPHARMMT_ROOT}/backups/postgres"
PG_SUPERUSER="postgres"

usage() {
  cat <<EOF
Uso: sudo $0 [opções]

  --list                 Lista os conjuntos disponíveis e sai
  --set <nome>           Conjunto a restaurar (ex.: 20260804-031500)
  --database <base>      Base de destino
  --from <base>          Base de origem dentro do conjunto (default: igual a --database)
  --all                  Restaura todas as bases do conjunto
  --globals              Restaura também roles/permissões (globals.sql)
  --skip-safety-dump     Não tira o dump de segurança (NÃO recomendado)
$(common_flags_help)

Sem --yes, cada base restaurada pede confirmação explícita.
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --list) DO_LIST=1; shift ;;
    --set) SET_NAME=${2:?}; shift 2 ;;
    --database) TARGET_DB=${2:?}; shift 2 ;;
    --from) SOURCE_DB=${2:?}; shift 2 ;;
    --all) DO_ALL=1; shift ;;
    --globals) DO_GLOBALS=1; shift ;;
    --skip-safety-dump) SKIP_SAFETY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die_usage "opção desconhecida: $1" ;;
  esac
done

SET_DIR=""

# ═════════════════════════════════════════════════════════════════════════
list_sets() {
  step "Conjuntos disponíveis"
  local tier dir found=0
  for tier in daily weekly monthly; do
    dir="${BACKUP_ROOT}/${tier}"
    [ -d "$dir" ] || continue
    local s
    while IFS= read -r s; do
      [ -z "$s" ] && continue
      found=1
      local name size ndb
      name=$(basename "$s")
      size=$(du -sh "$s" 2>/dev/null | cut -f1)
      ndb=$(find "$s" -maxdepth 1 -name '*.dump' | wc -l)
      printf '  %-8s %-28s %6s  %s base(s)\n' "$tier" "$name" "$size" "$ndb"
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d | sort -r)
  done
  [ "$found" = "0" ] && warn "nenhum conjunto de backup encontrado em ${BACKUP_ROOT}"
  return 0
}

resolve_set() {
  [ -n "$SET_NAME" ] || die_usage "--set é obrigatório (usa --list para ver os disponíveis)"
  local tier
  for tier in daily weekly monthly; do
    if [ -d "${BACKUP_ROOT}/${tier}/${SET_NAME}" ]; then
      SET_DIR="${BACKUP_ROOT}/${tier}/${SET_NAME}"
      return 0
    fi
  done
  # Também aceita um caminho absoluto (backup trazido de fora).
  if [ -d "$SET_NAME" ]; then SET_DIR="$SET_NAME"; return 0; fi
  die_precond "conjunto não encontrado: ${SET_NAME}"
}

# ═════════════════════════════════════════════════════════════════════════
preflight() {
  step "Pré-condições"
  require_root
  require_cmd docker sha256sum

  container_running "$SPHARMMT_PG_CONTAINER" \
    || die_precond "container ${SPHARMMT_PG_CONTAINER} não está a correr — arranca a stack primeiro"
  docker exec "$SPHARMMT_PG_CONTAINER" pg_isready -q \
    || die_precond "PostgreSQL não aceita ligações"

  require_file "$SPHARMMT_SECRETS_FILE"
  # Ficheiro de segredos gerado em runtime — o caminho não é constante.
  set -a
  # shellcheck disable=SC1090
  . "$SPHARMMT_SECRETS_FILE"
  set +a
  [ -n "${POSTGRES_SUPERUSER_PASSWORD:-}" ] || die_precond "POSTGRES_SUPERUSER_PASSWORD ausente"

  resolve_set
  ok "conjunto: ${SET_DIR}"

  [ -f "${SET_DIR}/MANIFEST.txt" ] && qcat_manifest

  # A integridade é verificada ANTES de tocar em qualquer base.
  if [ -f "${SET_DIR}/SHA256SUMS" ]; then
    if ( cd "$SET_DIR" && sha256sum -c --quiet SHA256SUMS ); then
      ok "checksums SHA-256 conferem"
    else
      die_precond "CHECKSUM INVÁLIDO — o conjunto está corrompido. Restauro recusado."
    fi
  else
    die_precond "SHA256SUMS ausente em ${SET_DIR} — restauro recusado (backup não verificável)"
  fi

  require_free_space "${SPHARMMT_ROOT}/backups" 2048
  ok "pré-condições satisfeitas"
}

qcat_manifest() {
  info "manifesto:"
  head -8 "${SET_DIR}/MANIFEST.txt" | sed 's/^/    /'
}

pgx() { docker exec -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" "$SPHARMMT_PG_CONTAINER" "$@"; }
pgx_in() { docker exec -i -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" "$SPHARMMT_PG_CONTAINER" "$@"; }

db_exists() {
  [ "$(pgx psql -U "$PG_SUPERUSER" -d postgres -Atc \
      "SELECT 1 FROM pg_database WHERE datname = '$1'" 2>/dev/null)" = "1" ]
}

count_tables() {
  pgx psql -U "$PG_SUPERUSER" -d "$1" -Atc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo 0
}

# ═════════════════════════════════════════════════════════════════════════
restore_globals() {
  step "Roles e permissões (globals)"
  local f="${SET_DIR}/globals.sql"
  [ -f "$f" ] || { warn "globals.sql ausente no conjunto"; return 0; }
  confirm "Aplicar globals.sql (roles/permissões do cluster)?"
  if [ "$DRY_RUN" = "1" ]; then info "[dry-run] aplicaria globals.sql"; return 0; fi
  # Os globals são idempotentes na prática (CREATE ROLE falha se existir);
  # os erros de "já existe" são esperados e não devem abortar.
  pgx_in psql -U "$PG_SUPERUSER" -d postgres < "$f" >/dev/null 2>&1 || \
    warn "globals aplicados com avisos (roles já existentes são normais)"
  ok "globals aplicados"
}

# ═════════════════════════════════════════════════════════════════════════
restore_one() {
  local src_db=$1 dst_db=$2
  local dump="${SET_DIR}/${src_db}.dump"

  step "Restauro: ${src_db} → ${dst_db}"
  [ -f "$dump" ] || die "dump não encontrado no conjunto: ${dump}"

  # Legibilidade do dump antes de mexer no destino.
  local nobj
  nobj=$(pgx_in pg_restore --list < "$dump" 2>/dev/null | grep -c ';' || true)
  if [ "${nobj:-0}" -eq 0 ]; then
    die "dump ilegível ou vazio (pg_restore --list não devolveu entradas): ${dump}"
  fi
  ok "dump legível — ${nobj} entradas no índice"

  local existed=0 before_tables=0
  if db_exists "$dst_db"; then
    existed=1
    before_tables=$(count_tables "$dst_db")
    warn "a base ${dst_db} JÁ EXISTE com ${before_tables} tabela(s) em public — o conteúdo será SUBSTITUÍDO"
  else
    info "a base ${dst_db} não existe — será criada"
  fi

  confirm "Confirmas o restauro de ${src_db} para ${dst_db}? (destrutivo)"

  if [ "$DRY_RUN" = "1" ]; then info "[dry-run] restauraria ${src_db} → ${dst_db}"; return 0; fi

  # Rede de segurança: dump da base actual antes de lhe tocar.
  if [ "$existed" = "1" ] && [ "$SKIP_SAFETY" != "1" ]; then
    local safety
    safety="${SPHARMMT_ROOT}/backups/postgres/daily/pre-restore-$(date -u '+%Y%m%d-%H%M%S')-${dst_db}.dump"
    info "a tirar dump de segurança de ${dst_db}..."
    if pgx pg_dump -U "$PG_SUPERUSER" -d "$dst_db" -Fc --no-owner --no-acl > "${safety}.partial"; then
      mv "${safety}.partial" "$safety"
      sha256sum "$safety" > "${safety}.sha256"
      chown "${SPHARMMT_USER}:${SPHARMMT_GROUP}" "$safety" "${safety}.sha256" 2>/dev/null || true
      ok "dump de segurança: ${safety}"
      SAFETY_DUMP="$safety"
    else
      rm -f "${safety}.partial"
      die "não foi possível tirar o dump de segurança — restauro abortado (nada foi alterado)"
    fi
  fi

  if [ "$existed" = "0" ]; then
    pgx psql -U "$PG_SUPERUSER" -d postgres -c "CREATE DATABASE \"${dst_db}\"" >/dev/null
    ok "base ${dst_db} criada"
  fi

  # Termina ligações activas: pg_restore --clean falha se houver locks.
  pgx psql -U "$PG_SUPERUSER" -d postgres -Atc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dst_db}' AND pid <> pg_backend_pid()" \
    >/dev/null 2>&1 || true

  info "a restaurar (pode demorar — 4 GB levam vários minutos)..."
  local rc=0
  # --clean --if-exists: substitui o conteúdo sem exigir DROP DATABASE.
  # -j 3: paraleliza em 3 workers (4 vCPU, deixando um livre).
  pgx_in pg_restore -U "$PG_SUPERUSER" -d "$dst_db" \
    --clean --if-exists --no-owner --no-acl --exit-on-error -j 3 < "$dump" >/dev/null 2>&1 || rc=$?

  if [ "$rc" -ne 0 ]; then
    err "pg_restore falhou (rc=${rc}) para ${dst_db}"
    if [ -n "${SAFETY_DUMP:-}" ]; then
      err "reverter com:"
      err "  sudo $0 --set \$(dirname ${SAFETY_DUMP}) --from \$(basename ${SAFETY_DUMP} .dump) --database ${dst_db}"
      err "ou directamente:"
      err "  docker exec -i ${SPHARMMT_PG_CONTAINER} pg_restore -U postgres -d ${dst_db} --clean --if-exists < ${SAFETY_DUMP}"
    fi
    die "restauro de ${dst_db} falhou"
  fi

  local after_tables; after_tables=$(count_tables "$dst_db")
  ok "restaurado: ${dst_db} com ${after_tables} tabela(s) em public"
  check "base ${dst_db} tem tabelas" bash -c "[ ${after_tables} -gt 0 ]"
  RESTORED=$((RESTORED+1))
}

# ═════════════════════════════════════════════════════════════════════════
RESTORED=0
SAFETY_DUMP=""

main() {
  log_init
  if [ "$DO_LIST" = "1" ]; then banner "restore-platform (listagem)"; list_sets; exit 0; fi

  acquire_lock restore
  banner "restore-platform"

  preflight

  [ "$DO_GLOBALS" = "1" ] && restore_globals

  if [ "$DO_ALL" = "1" ]; then
    local f db
    for f in "$SET_DIR"/*.dump; do
      [ -f "$f" ] || continue
      db=$(basename "$f" .dump)
      case "$db" in pre-restore-*) continue ;; esac
      restore_one "$db" "$db"
    done
  else
    [ -n "$TARGET_DB" ] || die_usage "--database é obrigatório (ou usa --all)"
    restore_one "${SOURCE_DB:-$TARGET_DB}" "$TARGET_DB"
  fi

  [ "$RESTORED" -gt 0 ] || die "nenhuma base restaurada"

  local rc=0
  report "Restauro — validação" || rc=$?

  printf '\n'
  if [ "$rc" -eq 0 ]; then
    ok "${RESTORED} base(s) restaurada(s) a partir de ${SET_NAME}"
    info "Passo seguinte OBRIGATÓRIO: comparar contagens com o MANIFEST.txt do conjunto:"
    info "  grep -A12 '\\[<base>\\]' ${SET_DIR}/MANIFEST.txt"
    info "Um restauro que corre sem erros mas com menos linhas é perda de dados silenciosa."
  fi
  finish "$rc"
}

main "$@"
