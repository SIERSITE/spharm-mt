#!/usr/bin/env bash
# deploy/scripts/backup-platform.sh
#
# Backup do PostgreSQL do SPharm.MT + configuração da plataforma.
#
# Para cada base (control plane, legacy e uma por tenant) produz um dump
# `pg_dump -Fc` (formato custom: comprimido, restaurável selectivamente e
# em paralelo), mais os globals do cluster (roles e permissões — sem eles
# o restore cria as bases mas ninguém consegue autenticar-se).
#
# Cada ficheiro leva um SHA-256 ao lado e entra num MANIFEST com as
# contagens por base. O restore RECUSA qualquer ficheiro cujo checksum não
# bata certo — um backup corrompido que restaura em silêncio é pior do que
# um backup em falta.
#
# Retenção: daily/ (14), weekly/ (8, domingos), monthly/ (12, dia 1).
#
# Enquanto o PostgreSQL não existir, o script sai com 0 e a nota
# "sem stack" — para que o timer systemd não fique em estado falhado
# durante a fase de preparação.
#
# Uso:
#   sudo ./backup-platform.sh [--only <base>] [--label <nome>] [--quiet] [flags comuns]
#
# Saída: 0 ok (ou nada a fazer) · 1 falha · 2 pré-condição · 3 verificação
#        pós-backup falhou · 5 lock

set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

ONLY_DB=""
LABEL=""
QUIET=0
KEEP_DAILY=${BACKUP_KEEP_DAILY:-14}
KEEP_WEEKLY=${BACKUP_KEEP_WEEKLY:-8}
KEEP_MONTHLY=${BACKUP_KEEP_MONTHLY:-12}
MAX_DISK_PCT=${BACKUP_MAX_DISK_PCT:-85}

usage() {
  cat <<EOF
Uso: sudo $0 [opções]

  --only <base>     Só esta base de dados
  --label <nome>    Sufixo no nome do conjunto (ex.: pre-update)
  --quiet           Menos output (usado pelo timer systemd)
  --keep-daily <n>  Default: ${KEEP_DAILY}
$(common_flags_help)

O backup local é STAGING, não é backup: só conta quando existe fora desta
máquina. Configurar o envio externo continua por fazer.
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --only) ONLY_DB=${2:?}; shift 2 ;;
    --label) LABEL=${2:?}; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    --keep-daily) KEEP_DAILY=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die_usage "opção desconhecida: $1" ;;
  esac
done

STAMP=$(date -u '+%Y%m%d-%H%M%S')
SET_NAME="${STAMP}${LABEL:+-${LABEL}}"
DAILY_DIR="${SPHARMMT_BACKUP_DIR}/postgres/daily"
WORK_DIR="${SPHARMMT_BACKUP_DIR}/tmp/${SET_NAME}"
DEST_DIR="${DAILY_DIR}/${SET_NAME}"
PG_SUPERUSER="postgres"
DUMPED=0
TOTAL_BYTES=0

qinfo() { [ "$QUIET" = "1" ] || info "$@"; }

# ═════════════════════════════════════════════════════════════════════════
preflight() {
  step "Pré-condições"
  require_root
  require_cmd docker sha256sum find awk

  # Antes de qualquer escrita: se os dados vivem num volume dedicado, ele
  # tem mesmo de estar montado.
  require_data_root_mounted

  if ! container_running "$SPHARMMT_PG_CONTAINER"; then
    if container_exists "$SPHARMMT_PG_CONTAINER"; then
      die_precond "container ${SPHARMMT_PG_CONTAINER} existe mas está parado — arranca-o antes do backup"
    fi
    warn "PostgreSQL ainda não instalado (container ${SPHARMMT_PG_CONTAINER} inexistente)"
    info "nada a copiar nesta fase — a sair com 0 para não falhar o timer"
    finish "$EX_OK"
  fi

  docker exec "$SPHARMMT_PG_CONTAINER" pg_isready -q \
    || die_precond "PostgreSQL não aceita ligações (pg_isready falhou)"

  require_file "$SPHARMMT_SECRETS_FILE"
  # Ficheiro de segredos gerado em runtime — o caminho não é constante.
  set -a
  # shellcheck disable=SC1090
  . "$SPHARMMT_SECRETS_FILE"
  set +a
  [ -n "${POSTGRES_SUPERUSER_PASSWORD:-}" ] \
    || die_precond "POSTGRES_SUPERUSER_PASSWORD ausente em ${SPHARMMT_SECRETS_FILE}"

  # Um backup que enche o disco derruba o PostgreSQL.
  local pct; pct=$(df -P "${SPHARMMT_BACKUP_DIR}" | awk 'NR==2 {gsub("%","",$5); print $5}')
  if [ "${pct:-0}" -ge "$MAX_DISK_PCT" ]; then
    die_precond "disco a ${pct}% (limite ${MAX_DISK_PCT}%) — a abortar antes de escrever"
  fi
  qinfo "disco a ${pct}% · limite ${MAX_DISK_PCT}%"

  ensure_dir "$DAILY_DIR" 0700 "${SPHARMMT_USER}:${SPHARMMT_GROUP}"
  ensure_dir "$WORK_DIR" 0700 "${SPHARMMT_USER}:${SPHARMMT_GROUP}"
  ok "pré-condições satisfeitas"
}

pgx() { docker exec -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" "$SPHARMMT_PG_CONTAINER" "$@"; }

list_databases() {
  if [ -n "$ONLY_DB" ]; then printf '%s\n' "$ONLY_DB"; return 0; fi
  pgx psql -U "$PG_SUPERUSER" -d postgres -Atc \
    "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname"
}

# ═════════════════════════════════════════════════════════════════════════
do_backup() {
  step "Backup (${SET_NAME})"

  # Globals primeiro: sem roles, o restore cria as bases mas ninguém
  # consegue autenticar-se nelas.
  qinfo "a exportar roles e permissões do cluster..."
  if [ "$DRY_RUN" != "1" ]; then
    pgx pg_dumpall -U "$PG_SUPERUSER" --globals-only > "${WORK_DIR}/globals.sql"
    [ -s "${WORK_DIR}/globals.sql" ] || die "pg_dumpall --globals-only produziu ficheiro vazio"
  fi
  ok "globals.sql"

  local dbs; dbs=$(list_databases)
  [ -n "$dbs" ] || die "nenhuma base encontrada para copiar"

  local db
  while IFS= read -r db; do
    [ -z "$db" ] && continue
    case "$db" in postgres|template*) qinfo "ignorada: ${db}"; continue ;; esac

    local out="${WORK_DIR}/${db}.dump"
    qinfo "a copiar ${db}..."
    if [ "$DRY_RUN" = "1" ]; then ok "[dry-run] ${db}"; DUMPED=$((DUMPED+1)); continue; fi

    # -Fc: formato custom (comprimido, restauro selectivo e paralelo).
    # Escreve primeiro para .partial: um ficheiro truncado por falha nunca
    # chega a parecer um backup válido.
    if ! pgx pg_dump -U "$PG_SUPERUSER" -d "$db" -Fc --no-owner --no-acl > "${out}.partial"; then
      rm -f "${out}.partial"
      die "pg_dump falhou para a base ${db} — conjunto abortado, nada foi promovido"
    fi
    [ -s "${out}.partial" ] || { rm -f "${out}.partial"; die "dump vazio para ${db}"; }
    mv "${out}.partial" "$out"

    local size; size=$(stat -c '%s' "$out")
    TOTAL_BYTES=$((TOTAL_BYTES + size))
    DUMPED=$((DUMPED+1))
    ok "${db} → $(numfmt --to=iec "$size")"
  done <<< "$dbs"

  # Configuração da plataforma: sem isto, um restore devolve os dados mas
  # não o servidor. Os segredos ficam de fora deliberadamente — vão para
  # cofre, não para o mesmo tarball dos dados.
  if [ "$DRY_RUN" != "1" ]; then
    tar czf "${WORK_DIR}/platform-config.tar.gz" \
      -C "$SPHARMMT_ROOT" \
      --exclude='secrets' --exclude='postgres/data' --exclude='backups' --exclude='logs' \
      docker proxy monitoring scripts README.md 2>/dev/null || true
    [ -f /etc/spharmmt/platform.conf ] && \
      cp /etc/spharmmt/platform.conf "${WORK_DIR}/platform.conf" || true
  fi
  ok "configuração da plataforma incluída (segredos excluídos por design)"
}

# ═════════════════════════════════════════════════════════════════════════
write_manifest() {
  step "Manifesto e checksums"
  [ "$DRY_RUN" = "1" ] && { info "[dry-run] escreveria manifesto"; return 0; }

  ( cd "$WORK_DIR" && sha256sum ./* > SHA256SUMS 2>/dev/null ) || true

  local pgver; pgver=$(pgx psql -U "$PG_SUPERUSER" -d postgres -Atc "SHOW server_version" 2>/dev/null || echo '?')
  {
    printf 'SPharm.MT — manifesto de backup\n'
    printf 'set          : %s\n' "$SET_NAME"
    printf 'criado (UTC) : %s\n' "$(_ts)"
    printf 'host         : %s\n' "$(hostname)"
    printf 'postgres     : %s\n' "$pgver"
    printf 'bases        : %s\n' "$DUMPED"
    printf 'tamanho      : %s\n' "$(numfmt --to=iec "$TOTAL_BYTES" 2>/dev/null || printf '%s B' "$TOTAL_BYTES")"
    printf '\ncontagens por base (linhas por tabela, top 10)\n'
    local f db
    for f in "$WORK_DIR"/*.dump; do
      [ -f "$f" ] || continue
      db=$(basename "$f" .dump)
      printf '\n[%s]\n' "$db"
      pgx psql -U "$PG_SUPERUSER" -d "$db" -Atc \
        "SELECT relname || '=' || n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10" \
        2>/dev/null | sed 's/^/  /' || printf '  (indisponível)\n'
    done
    printf '\nficheiros\n'
    # `ls -la` é intencional: esta listagem é para leitura humana dentro do
    # manifesto, não é parseada por nada. Os nomes são gerados por nós
    # (<base>.dump), sem espaços nem caracteres especiais.
    # shellcheck disable=SC2012
    ( cd "$WORK_DIR" && ls -la | sed 's/^/  /' )
  } > "${WORK_DIR}/MANIFEST.txt"

  ok "manifesto escrito ($(wc -l < "${WORK_DIR}/MANIFEST.txt") linhas)"
}

# ═════════════════════════════════════════════════════════════════════════
# Verificação: um dump que não passa `pg_restore --list` é lixo. Vale muito
# mais descobri-lo agora do que no dia do desastre.
# ═════════════════════════════════════════════════════════════════════════
verify_set() {
  step "Verificação do conjunto"
  [ "$DRY_RUN" = "1" ] && { check_skip "verificação" "dry-run"; return 0; }

  local f
  for f in "$WORK_DIR"/*.dump; do
    [ -f "$f" ] || continue
    local base; base=$(basename "$f")
    # pg_restore --list lê o índice interno do dump: detecta truncagem
    # e corrupção sem escrever nada em lado nenhum.
    if docker exec -i "$SPHARMMT_PG_CONTAINER" pg_restore --list < "$f" >/dev/null 2>&1; then
      check "dump legível: ${base}" true
    else
      check "dump legível: ${base}" false
    fi
  done
  check "globals.sql não vazio" test -s "${WORK_DIR}/globals.sql"
  check "SHA256SUMS presente"   test -s "${WORK_DIR}/SHA256SUMS"
  check "checksums conferem"    bash -c "cd '${WORK_DIR}' && sha256sum -c --quiet SHA256SUMS"

  if [ "$(checks_failed)" -gt 0 ]; then
    err "verificação falhou — o conjunto NÃO será promovido"
    rm -rf "$WORK_DIR"
    finish "$EX_POSTCOND"
  fi
  ok "conjunto verificado"
}

# ═════════════════════════════════════════════════════════════════════════
promote() {
  step "Promoção e retenção"
  [ "$DRY_RUN" = "1" ] && { info "[dry-run] promoveria ${WORK_DIR} → ${DEST_DIR}"; return 0; }

  mv "$WORK_DIR" "$DEST_DIR"
  chown -R "${SPHARMMT_USER}:${SPHARMMT_GROUP}" "$DEST_DIR"
  chmod -R go-rwx "$DEST_DIR"
  ok "conjunto em ${DEST_DIR}"

  # Weekly (domingo) e monthly (dia 1) são hardlinks do conjunto diário:
  # custam zero bytes extra enquanto o diário existir, e sobrevivem-lhe
  # quando ele for removido pela retenção.
  local dow dom
  dow=$(date -u +%u); dom=$(date -u +%d)
  if [ "$dow" = "7" ]; then
    cp -al "$DEST_DIR" "${SPHARMMT_BACKUP_DIR}/postgres/weekly/${SET_NAME}" 2>/dev/null \
      || cp -a "$DEST_DIR" "${SPHARMMT_BACKUP_DIR}/postgres/weekly/${SET_NAME}"
    ok "promovido a weekly"
  fi
  if [ "$dom" = "01" ]; then
    cp -al "$DEST_DIR" "${SPHARMMT_BACKUP_DIR}/postgres/monthly/${SET_NAME}" 2>/dev/null \
      || cp -a "$DEST_DIR" "${SPHARMMT_BACKUP_DIR}/postgres/monthly/${SET_NAME}"
    ok "promovido a monthly"
  fi

  _prune() {
    local dir=$1 keep=$2 removed=0
    [ -d "$dir" ] || return 0
    local old
    while IFS= read -r old; do
      [ -z "$old" ] && continue
      rm -rf "$old"; removed=$((removed+1))
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n "+$((keep+1))")
    if [ "$removed" -gt 0 ]; then
      ok "retenção ${dir##*/}: ${removed} conjunto(s) antigo(s) removido(s)"
    else
      dbg "retenção ${dir##*/}: nada a remover"
    fi
  }
  _prune "$DAILY_DIR" "$KEEP_DAILY"
  _prune "${SPHARMMT_BACKUP_DIR}/postgres/weekly" "$KEEP_WEEKLY"
  _prune "${SPHARMMT_BACKUP_DIR}/postgres/monthly" "$KEEP_MONTHLY"

  # Restos de execuções interrompidas.
  find "${SPHARMMT_BACKUP_DIR}/tmp" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
}

summary() {
  local total
  total=$(du -sh "${SPHARMMT_BACKUP_DIR}/postgres" 2>/dev/null | cut -f1)
  printf '\n'
  ok "backup concluído: ${DUMPED} base(s), $(numfmt --to=iec "$TOTAL_BYTES" 2>/dev/null || echo "$TOTAL_BYTES B")"
  info "conjunto : ${DEST_DIR}"
  info "ocupação : ${total:-?} em backups/postgres"
  info "restaurar: sudo ${SPHARMMT_ROOT}/scripts/restore-platform.sh --set ${SET_NAME} --database <base>"
  printf '\n'
  warn "este backup está NA MESMA MÁQUINA que os dados. Não protege contra perda"
  warn "da VPS, falha de disco ou ransomware. Configurar o destino externo é a"
  warn "lacuna aberta mais séria da infraestrutura."
}

main() {
  log_init
  acquire_lock backup
  [ "$QUIET" = "1" ] || banner "backup-platform"
  preflight
  do_backup
  write_manifest
  verify_set
  promote
  [ "$QUIET" = "1" ] || summary
  return 0
}

main "$@"
