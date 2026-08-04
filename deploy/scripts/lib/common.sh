#!/usr/bin/env bash
# deploy/scripts/lib/common.sh
#
# Biblioteca partilhada por todos os scripts de infraestrutura do SPharm.MT.
# Não é executável — é sempre carregada com `source`.
#
# Fornece:
#   · modo estrito (errexit/nounset/pipefail) + trap ERR com linha e comando
#   · logging com nível, cor condicional a TTY e ficheiro de log persistente
#   · helpers idempotentes de filesystem (write_file, ensure_dir, ensure_line)
#   · verificação de pré/pós-condições com relatório final
#   · lock por script (execuções concorrentes falham em vez de corromper)
#   · códigos de saída consistentes
#
# Convenção de códigos de saída (usada por TODOS os scripts):
#   0  sucesso
#   1  erro genérico / falha de execução
#   2  pré-condição não satisfeita
#   3  pós-condição não satisfeita (o script correu mas o resultado não valida)
#   4  uso incorrecto (argumentos inválidos)
#   5  já existe outra instância a correr
#   6  abortado pelo operador
#
# shellcheck shell=bash

# Guarda contra duplo source.
if [ -n "${_SPHARMMT_COMMON_LOADED:-}" ]; then return 0; fi
_SPHARMMT_COMMON_LOADED=1

set -Eeuo pipefail
# Propaga errexit para command substitutions e subshells (bash >= 4.4).
shopt -s inherit_errexit 2>/dev/null || true

# Estas constantes são consumidas pelos scripts que carregam esta
# biblioteca (backup-platform.sh, update-platform.sh, ...), não aqui — o
# ShellCheck não consegue ver esse uso ao analisar o ficheiro isolado.
# shellcheck disable=SC2034
readonly EX_OK=0
readonly EX_FAIL=1
readonly EX_PRECOND=2
readonly EX_POSTCOND=3
readonly EX_USAGE=4
readonly EX_LOCKED=5
readonly EX_ABORTED=6

# ─────────────────────────────────────────────────────────────────────────
# Configuração global (sobreponível por /etc/spharmmt/platform.conf)
# ─────────────────────────────────────────────────────────────────────────

: "${SPHARMMT_ROOT:=/opt/spharmmt}"
: "${SPHARMMT_LOG_DIR:=/var/log/spharmmt}"
: "${SPHARMMT_CONF_FILE:=/etc/spharmmt/platform.conf}"
: "${SPHARMMT_USER:=deploy}"
: "${SPHARMMT_GROUP:=spharmmt}"
: "${SPHARMMT_COMPOSE_FILE:=${SPHARMMT_ROOT}/docker/compose/docker-compose.yml}"
: "${SPHARMMT_ENV_FILE:=${SPHARMMT_ROOT}/docker/env/platform.env}"
: "${SPHARMMT_SECRETS_FILE:=${SPHARMMT_ROOT}/secrets/platform.secrets.env}"
: "${SPHARMMT_PG_CONTAINER:=spharmmt-postgres}"
: "${SPHARMMT_APP_CONTAINER:=spharmmt-app}"
: "${SPHARMMT_PROXY_CONTAINER:=spharmmt-proxy}"
: "${SPHARMMT_NETWORK:=spharmmt-net}"

# Flags globais, controladas por parse_common_flag().
: "${DRY_RUN:=0}"
: "${ASSUME_YES:=0}"
: "${VERBOSE:=0}"
: "${NO_COLOR:=0}"

# Carrega configuração persistente do servidor, se existir. Permite que
# uma VPS com layout diferente (ex.: volume dedicado noutro mount) seja
# servida pelos mesmos scripts sem editar código.
if [ -r "$SPHARMMT_CONF_FILE" ]; then
  # shellcheck disable=SC1090
  . "$SPHARMMT_CONF_FILE"
fi

# ─────────────────────────────────────────────────────────────────────────
# Data root — separação entre código/configuração e dados
# ─────────────────────────────────────────────────────────────────────────
#
# Numa VPS com disco dedicado aos dados, `/data` é o ponto de montagem desse
# disco e é lá que vivem os dados que crescem (PostgreSQL, backups, volumes
# Docker). `$SPHARMMT_ROOT` fica só com aplicação, configuração, scripts e
# segredos — coisas pequenas, versionáveis e recriáveis.
#
# Resolução, por ordem:
#   1. SPHARMMT_DATA_ROOT definido em platform.conf (fonte de verdade após
#      install-platform.sh — explícito, não adivinhado)
#   2. /data se for um ponto de montagem real
#   3. $SPHARMMT_ROOT (comportamento de sempre — VPS de disco único)
#
# O caso 3 garante retrocompatibilidade total: sem disco dedicado, todos os
# caminhos ficam exactamente onde estavam.

is_mountpoint() {
  findmnt -rno TARGET "$1" >/dev/null 2>&1
}

if [ -z "${SPHARMMT_DATA_ROOT:-}" ]; then
  if is_mountpoint /data; then
    SPHARMMT_DATA_ROOT=/data
  else
    SPHARMMT_DATA_ROOT="$SPHARMMT_ROOT"
  fi
fi

# Directórios de dados derivados. Sobreponíveis individualmente em
# platform.conf para migrações parciais (ex.: backups noutro volume).
: "${SPHARMMT_PG_DIR:=${SPHARMMT_DATA_ROOT}/postgres}"
: "${SPHARMMT_BACKUP_DIR:=${SPHARMMT_DATA_ROOT}/backups}"
: "${SPHARMMT_DOCKER_DATA_DIR:=${SPHARMMT_DATA_ROOT}/docker}"

# `true` quando os dados vivem num volume separado de $SPHARMMT_ROOT.
data_disk_in_use() { [ "$SPHARMMT_DATA_ROOT" != "$SPHARMMT_ROOT" ]; }

# Guarda contra a falha mais perniciosa desta arquitectura: o volume de
# dados não montar num arranque. O directório /data continua a existir (é o
# ponto de montagem), as escritas passam a ir para o disco de sistema sem
# erro nenhum, e no arranque seguinte — com o volume montado — esses dados
# ficam invisíveis por baixo da montagem. Entretanto o disco de sistema
# encheu. Qualquer escrita de dados tem de passar por aqui primeiro.
require_data_root_mounted() {
  data_disk_in_use || return 0
  is_mountpoint "$SPHARMMT_DATA_ROOT" && return 0
  err "${SPHARMMT_DATA_ROOT} está configurado como volume de dados mas NÃO está montado."
  err "Escrever agora encheria o disco de sistema e os dados desapareceriam"
  err "quando o volume voltasse a montar."
  err "Diagnostica com:  findmnt ${SPHARMMT_DATA_ROOT} ; lsblk ; journalctl -b | grep -i mount"
  err "Monta com:        sudo mount ${SPHARMMT_DATA_ROOT}"
  die_precond "volume de dados não montado"
}

# ─────────────────────────────────────────────────────────────────────────
# Estado interno
# ─────────────────────────────────────────────────────────────────────────

SCRIPT_NAME="$(basename "${BASH_SOURCE[-1]}" .sh)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[-1]}")" && pwd)"
readonly SCRIPT_NAME SCRIPT_DIR
export SCRIPT_DIR

LOG_FILE=""
LOCK_FD=""
LOCK_FILE=""
CHANGES_MADE=0

# Resultados acumulados por check() — arrays paralelos.
declare -a _CHK_LABEL=()
declare -a _CHK_STATUS=()   # PASS | FAIL | WARN | SKIP
declare -a _CHK_DETAIL=()

# ─────────────────────────────────────────────────────────────────────────
# Cor
# ─────────────────────────────────────────────────────────────────────────

_setup_colors() {
  if [ "$NO_COLOR" = "1" ] || [ ! -t 1 ] || [ -n "${CI:-}" ]; then
    C_RESET="" C_RED="" C_GRN="" C_YLW="" C_BLU="" C_DIM="" C_BOLD=""
  else
    C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'
    C_YLW=$'\033[33m'; C_BLU=$'\033[36m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  fi
}
_setup_colors

# ─────────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────────

_ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Escreve no ficheiro de log (sem cor) e no stdout/stderr (com cor).
_emit() {
  local level=$1 color=$2 msg=$3 stream=${4:-1}
  local plain
  plain="[$(_ts)] [$level] $msg"
  if [ -n "$LOG_FILE" ]; then printf '%s\n' "$plain" >> "$LOG_FILE" 2>/dev/null || true; fi
  if [ "$stream" = "2" ]; then
    printf '%s%s%s\n' "$color" "$msg" "$C_RESET" >&2
  else
    printf '%s%s%s\n' "$color" "$msg" "$C_RESET"
  fi
}

info() { _emit INFO  ""        "  $*"; }
ok()   { _emit OK    "$C_GRN"  "  ✓ $*"; }
warn() { _emit WARN  "$C_YLW"  "  ! $*" 2; }
err()  { _emit ERROR "$C_RED"  "  ✗ $*" 2; }
dbg()  { [ "$VERBOSE" = "1" ] && _emit DEBUG "$C_DIM" "    $*" || true; }

step() {
  _emit STEP "$C_BLU$C_BOLD" ""
  _emit STEP "$C_BLU$C_BOLD" "── $* ──────────────────────────────────────────"
}

banner() {
  printf '%s\n' "${C_BOLD}${C_BLU}"
  printf '%s\n' "══════════════════════════════════════════════════════════════"
  printf '  SPharm.MT · %s\n' "$*"
  printf '  host=%s  utc=%s\n' "$(hostname)" "$(_ts)"
  [ -n "$LOG_FILE" ] && printf '  log=%s\n' "$LOG_FILE"
  [ "$DRY_RUN" = "1" ] && printf '  MODO: DRY-RUN (nada é alterado)\n'
  printf '%s\n' "══════════════════════════════════════════════════════════════"
  printf '%s' "${C_RESET}"
  if [ -n "$LOG_FILE" ]; then
    printf '[%s] [START] %s (dry_run=%s, user=%s)\n' "$(_ts)" "$*" "$DRY_RUN" "$(id -un)" >> "$LOG_FILE"
  fi
}

# Termina o script com o código dado SEM accionar o trap ERR.
# Necessário porque `exit N` com N≠0 dispara o ERR trap e imprimiria uma
# "falha" fantasma por cima de uma saída perfeitamente intencional.
finish() { trap - ERR; exit "${1:-0}"; }

die() { err "$*"; finish "${DIE_CODE:-$EX_FAIL}"; }
die_precond() { DIE_CODE=$EX_PRECOND die "pré-condição falhou: $*"; }
die_usage()   { DIE_CODE=$EX_USAGE die "uso incorrecto: $*"; }

# Inicializa o ficheiro de log. Cai para /tmp se não houver permissões —
# um script de diagnóstico corrido sem sudo não deve falhar só por isso.
log_init() {
  local dir="$SPHARMMT_LOG_DIR"
  if ! mkdir -p "$dir" 2>/dev/null; then dir="${TMPDIR:-/tmp}/spharmmt-logs"; mkdir -p "$dir"; fi
  if [ ! -w "$dir" ]; then dir="${TMPDIR:-/tmp}/spharmmt-logs"; mkdir -p "$dir"; fi
  LOG_FILE="${dir}/${SCRIPT_NAME}-$(date -u '+%Y%m%d-%H%M%S').log"
  : > "$LOG_FILE" 2>/dev/null || LOG_FILE=""
  [ -n "$LOG_FILE" ] && chmod 0640 "$LOG_FILE" 2>/dev/null || true
  # Symlink estável para o último run — facilita `tail -f`.
  if [ -n "$LOG_FILE" ]; then
    ln -sfn "$LOG_FILE" "${dir}/${SCRIPT_NAME}-latest.log" 2>/dev/null || true
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# Traps
# ─────────────────────────────────────────────────────────────────────────

_on_err() {
  local rc=$? cmd=${BASH_COMMAND:-?} line=${BASH_LINENO[0]:-?}
  set +e
  err "FALHA (rc=${rc}) em ${BASH_SOURCE[1]:-?}:${line}"
  err "comando: ${cmd}"
  [ -n "$LOG_FILE" ] && err "log completo: ${LOG_FILE}"
  exit "$rc"
}

_on_exit() {
  local rc=$?
  set +e
  _release_lock
  if [ -n "$LOG_FILE" ]; then
    printf '[%s] [END] rc=%s\n' "$(_ts)" "$rc" >> "$LOG_FILE" 2>/dev/null
  fi
  return $rc
}

trap _on_err ERR
trap _on_exit EXIT
trap 'err "interrompido pelo utilizador (SIGINT)"; exit '"$EX_ABORTED" INT
trap 'err "terminado (SIGTERM)"; exit '"$EX_ABORTED" TERM

# ─────────────────────────────────────────────────────────────────────────
# Lock — impede duas execuções simultâneas do mesmo script
# ─────────────────────────────────────────────────────────────────────────

acquire_lock() {
  local name=${1:-$SCRIPT_NAME}
  # Sem flock (util-linux) não há lock possível. Em Ubuntu está sempre
  # presente; noutros ambientes é melhor avisar e continuar do que tratar
  # a ausência do binário como "lock ocupado" e recusar correr.
  if ! command -v flock >/dev/null 2>&1; then
    warn "flock indisponível — a continuar SEM protecção contra execuções concorrentes"
    LOCK_FD=""
    return 0
  fi
  local dir=/run/lock
  [ -w "$dir" ] || dir="${TMPDIR:-/tmp}"
  LOCK_FILE="${dir}/spharmmt-${name}.lock"
  exec {LOCK_FD}>"$LOCK_FILE" || { warn "não foi possível criar lock em $LOCK_FILE — a continuar sem lock"; LOCK_FD=""; return 0; }
  if ! flock -n "$LOCK_FD"; then
    err "já existe outra instância de ${name} a correr (lock: ${LOCK_FILE})"
    finish "$EX_LOCKED"
  fi
  printf '%s %s\n' "$$" "$(_ts)" >&"$LOCK_FD" || true
  dbg "lock adquirido: $LOCK_FILE"
}

_release_lock() {
  if [ -n "$LOCK_FD" ]; then
    flock -u "$LOCK_FD" 2>/dev/null || true
    eval "exec ${LOCK_FD}>&-" 2>/dev/null || true
    LOCK_FD=""
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# Execução
# ─────────────────────────────────────────────────────────────────────────

# run <cmd...> — executa respeitando DRY_RUN. Loga sempre o comando.
run() {
  dbg "\$ $*"
  if [ -n "$LOG_FILE" ]; then printf '[%s] [CMD] %s\n' "$(_ts)" "$*" >> "$LOG_FILE" 2>/dev/null || true; fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s    [dry-run] %s%s\n' "$C_DIM" "$*" "$C_RESET"
    return 0
  fi
  "$@"
}

# run_quiet <cmd...> — como run, mas silencia stdout (mantém no log).
run_quiet() {
  dbg "\$ $*"
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s    [dry-run] %s%s\n' "$C_DIM" "$*" "$C_RESET"
    return 0
  fi
  if [ -n "$LOG_FILE" ]; then "$@" >>"$LOG_FILE" 2>&1; else "$@" >/dev/null 2>&1; fi
}

confirm() {
  local prompt=$1
  [ "$ASSUME_YES" = "1" ] && { info "$prompt → sim (--yes)"; return 0; }
  if [ ! -t 0 ]; then
    err "$prompt — sem TTY e sem --yes; a abortar"
    finish "$EX_ABORTED"
  fi
  local reply
  printf '%s%s [s/N] %s' "$C_YLW" "$prompt" "$C_RESET"
  read -r reply
  case "$reply" in [sSyY]*) return 0 ;; *) err "abortado pelo operador"; finish "$EX_ABORTED" ;; esac
}

# ─────────────────────────────────────────────────────────────────────────
# Pré-condições
# ─────────────────────────────────────────────────────────────────────────

require_root() {
  [ "$(id -u)" -eq 0 ] || die_precond "este script tem de correr como root (usa sudo)"
}

require_not_root() {
  [ "$(id -u)" -ne 0 ] || die_precond "este script NÃO deve correr como root"
}

require_cmd() {
  local missing=()
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  [ ${#missing[@]} -eq 0 ] || die_precond "comandos em falta: ${missing[*]}"
}

require_ubuntu() {
  local want=${1:-24.04}
  [ -r /etc/os-release ] || die_precond "/etc/os-release ausente — SO não identificável"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || die_precond "SO=${ID:-desconhecido}; estes scripts suportam apenas Ubuntu"
  if [ "${VERSION_ID:-}" != "$want" ]; then
    if [ "${SPHARMMT_ALLOW_ANY_UBUNTU:-0}" = "1" ]; then
      warn "Ubuntu ${VERSION_ID} (esperado ${want}) — a continuar por SPHARMMT_ALLOW_ANY_UBUNTU=1"
    else
      die_precond "Ubuntu ${VERSION_ID}; esperado ${want}. Define SPHARMMT_ALLOW_ANY_UBUNTU=1 para forçar."
    fi
  fi
}

require_file()  { [ -f "$1" ] || die_precond "ficheiro necessário em falta: $1"; }
require_dir()   { [ -d "$1" ] || die_precond "directório necessário em falta: $1"; }

# Garante espaço livre mínimo (MB) no path dado.
require_free_space() {
  local path=$1 need_mb=$2
  local avail_mb
  avail_mb=$(df -Pm "$path" | awk 'NR==2 {print $4}')
  [ "${avail_mb:-0}" -ge "$need_mb" ] \
    || die_precond "espaço insuficiente em ${path}: ${avail_mb}MB livres, necessários ${need_mb}MB"
  dbg "espaço em ${path}: ${avail_mb}MB livres (mínimo ${need_mb}MB)"
}

has_cmd()      { command -v "$1" >/dev/null 2>&1; }
is_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "^install ok installed$"; }
svc_active()   { systemctl is-active --quiet "$1" 2>/dev/null; }
svc_enabled()  { systemctl is-enabled --quiet "$1" 2>/dev/null; }

container_running() {
  has_cmd docker || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

container_exists() {
  has_cmd docker || return 1
  docker inspect "$1" >/dev/null 2>&1
}

compose_available() {
  [ -f "$SPHARMMT_COMPOSE_FILE" ] && has_cmd docker && docker compose version >/dev/null 2>&1
}

# Wrapper do docker compose com o ficheiro e env-file do projecto.
dc() {
  local args=(-f "$SPHARMMT_COMPOSE_FILE" -p spharmmt)
  [ -f "$SPHARMMT_ENV_FILE" ] && args+=(--env-file "$SPHARMMT_ENV_FILE")
  docker compose "${args[@]}" "$@"
}

# ─────────────────────────────────────────────────────────────────────────
# Filesystem idempotente
# ─────────────────────────────────────────────────────────────────────────

# ensure_dir <path> [mode] [owner:group]
# Cria se não existir; corrige modo/owner sempre. Nunca apaga conteúdo.
ensure_dir() {
  local path=$1 mode=${2:-0750} owner=${3:-}
  if [ -e "$path" ] && [ ! -d "$path" ]; then
    die "$path existe e NÃO é um directório — intervenção manual necessária"
  fi
  if [ ! -d "$path" ]; then
    run mkdir -p "$path"
    ok "criado dir ${path}"
    CHANGES_MADE=1
  fi
  [ "$DRY_RUN" = "1" ] && return 0
  chmod "$mode" "$path"
  if [ -n "$owner" ]; then chown "$owner" "$path"; fi
  return 0
}

# backup_file <path> — cópia .bak-<ts> antes de alterar. Só uma por execução.
backup_file() {
  local path=$1
  [ -f "$path" ] || return 0
  [ "$DRY_RUN" = "1" ] && return 0
  local bak
  bak="${path}.spharmmt-bak-$(date -u '+%Y%m%d%H%M%S')"
  cp -a "$path" "$bak"
  dbg "backup: $bak"
}

# write_file <path> [mode] [owner:group] < conteúdo
# Idempotente e não-destrutivo: se o conteúdo for idêntico, só reafirma
# modo/owner e devolve 0 sem tocar no mtime. Se diferir, guarda backup.
write_file() {
  local path=$1 mode=${2:-0644} owner=${3:-root:root}
  local tmp; tmp=$(mktemp)
  cat > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    if [ "$DRY_RUN" != "1" ]; then
      chmod "$mode" "$path" 2>/dev/null || true
      chown "$owner" "$path" 2>/dev/null || true
    fi
    dbg "inalterado: $path"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s    [dry-run] escreveria %s (%s %s)%s\n' "$C_DIM" "$path" "$mode" "$owner" "$C_RESET"
    rm -f "$tmp"; return 0
  fi
  [ -f "$path" ] && backup_file "$path"
  # mkdir -p apenas: usar ensure_dir aqui alargaria as permissões do
  # directório-pai (ex.: /opt/spharmmt passaria de 2750 a 0755).
  [ -d "$(dirname "$path")" ] || mkdir -p "$(dirname "$path")"
  install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"
  rm -f "$tmp"
  ok "escrito ${path}"
  CHANGES_MADE=1
}

# ensure_line <file> <line> — acrescenta a linha se ainda não existir literalmente.
ensure_line() {
  local file=$1 line=$2
  if [ -f "$file" ] && grep -qxF "$line" "$file"; then dbg "já presente em $file: $line"; return 0; fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s    [dry-run] acrescentaria a %s: %s%s\n' "$C_DIM" "$file" "$line" "$C_RESET"; return 0
  fi
  [ -f "$file" ] && backup_file "$file"
  printf '%s\n' "$line" >> "$file"
  ok "acrescentado a ${file}: ${line}"
  CHANGES_MADE=1
}

# ensure_kv <file> <chave> <valor> [separador] — garante `chave<sep>valor`,
# substituindo a linha existente (mesmo comentada) ou acrescentando.
ensure_kv() {
  local file=$1 key=$2 value=$3 sep=${4:-=}
  local line="${key}${sep}${value}"
  if [ -f "$file" ] && grep -qxF "$line" "$file"; then dbg "já correcto em $file: $line"; return 0; fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s    [dry-run] definiria %s em %s%s\n' "$C_DIM" "$line" "$file" "$C_RESET"; return 0
  fi
  [ -f "$file" ] || : > "$file"
  backup_file "$file"
  if grep -qE "^[#[:space:]]*${key}${sep}" "$file"; then
    sed -i -E "s|^[#[:space:]]*${key}${sep}.*|${line}|" "$file"
  else
    printf '%s\n' "$line" >> "$file"
  fi
  ok "definido em ${file}: ${line}"
  CHANGES_MADE=1
}

# ─────────────────────────────────────────────────────────────────────────
# apt helpers
# ─────────────────────────────────────────────────────────────────────────

APT_UPDATED=0
apt_update_once() {
  [ "$APT_UPDATED" = "1" ] && return 0
  info "a actualizar índices apt..."
  run_quiet env DEBIAN_FRONTEND=noninteractive apt-get update
  APT_UPDATED=1
}

# apt_ensure <pacote...> — instala apenas os que faltam.
apt_ensure() {
  local missing=()
  for p in "$@"; do is_installed "$p" || missing+=("$p"); done
  if [ ${#missing[@]} -eq 0 ]; then dbg "pacotes já instalados: $*"; return 0; fi
  apt_update_once
  info "a instalar: ${missing[*]}"
  run_quiet env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "${missing[@]}"
  ok "instalados: ${missing[*]}"
  # Lido pelos scripts consumidores no relatório final.
  # shellcheck disable=SC2034
  CHANGES_MADE=1
}

# ─────────────────────────────────────────────────────────────────────────
# Segredos
# ─────────────────────────────────────────────────────────────────────────

gen_hex()    { openssl rand -hex "${1:-32}"; }
gen_base64() { openssl rand -base64 "${1:-32}" | tr -d '\n'; }
# Password segura para Postgres: sem caracteres que exijam escaping em
# URLs/YAML (@ : / ? # % & = ' " \ espaço). Alfanumérico é suficiente
# com 40 chars (~238 bits de entropia).
gen_password() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "${1:-40}"; }

# ─────────────────────────────────────────────────────────────────────────
# Checks e relatório
# ─────────────────────────────────────────────────────────────────────────

# check <label> <cmd...> — regista PASS/FAIL. Nunca aborta o script.
check() {
  local label=$1; shift
  if "$@" >/dev/null 2>&1; then
    _CHK_LABEL+=("$label"); _CHK_STATUS+=("PASS"); _CHK_DETAIL+=("")
    printf '  %s✓%s %s\n' "$C_GRN" "$C_RESET" "$label"
    [ -n "$LOG_FILE" ] && printf '[%s] [CHECK] PASS %s\n' "$(_ts)" "$label" >> "$LOG_FILE"
    return 0
  fi
  local rc=$?
  _CHK_LABEL+=("$label"); _CHK_STATUS+=("FAIL"); _CHK_DETAIL+=("rc=$rc")
  printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$label"
  [ -n "$LOG_FILE" ] && printf '[%s] [CHECK] FAIL %s (rc=%s: %s)\n' "$(_ts)" "$label" "$rc" "$*" >> "$LOG_FILE"
  return 0
}

# check_warn <label> <cmd...> — falha reporta WARN (não conta para o rc final).
check_warn() {
  local label=$1; shift
  if "$@" >/dev/null 2>&1; then
    _CHK_LABEL+=("$label"); _CHK_STATUS+=("PASS"); _CHK_DETAIL+=("")
    printf '  %s✓%s %s\n' "$C_GRN" "$C_RESET" "$label"
  else
    _CHK_LABEL+=("$label"); _CHK_STATUS+=("WARN"); _CHK_DETAIL+=("")
    printf '  %s!%s %s\n' "$C_YLW" "$C_RESET" "$label"
    [ -n "$LOG_FILE" ] && printf '[%s] [CHECK] WARN %s\n' "$(_ts)" "$label" >> "$LOG_FILE"
  fi
  return 0
}

check_skip() {
  local label=$1 reason=${2:-}
  _CHK_LABEL+=("$label"); _CHK_STATUS+=("SKIP"); _CHK_DETAIL+=("$reason")
  printf '  %s-%s %s %s(%s)%s\n' "$C_DIM" "$C_RESET" "$label" "$C_DIM" "${reason:-não aplicável}" "$C_RESET"
  return 0
}

checks_failed() {
  local n=0 i
  for i in "${!_CHK_STATUS[@]}"; do [ "${_CHK_STATUS[$i]}" = "FAIL" ] && n=$((n+1)); done
  printf '%s' "$n"
}

checks_warned() {
  local n=0 i
  for i in "${!_CHK_STATUS[@]}"; do [ "${_CHK_STATUS[$i]}" = "WARN" ] && n=$((n+1)); done
  printf '%s' "$n"
}

# report [titulo] — imprime resumo. Devolve 0 se não houver FAIL, senão 3.
report() {
  local title=${1:-Resultado}
  local total=${#_CHK_STATUS[@]} pass=0 fail=0 warnc=0 skip=0 i
  for i in "${!_CHK_STATUS[@]}"; do
    case "${_CHK_STATUS[$i]}" in
      PASS) pass=$((pass+1)) ;;
      FAIL) fail=$((fail+1)) ;;
      WARN) warnc=$((warnc+1)) ;;
      SKIP) skip=$((skip+1)) ;;
    esac
  done

  printf '\n%s══════════════════════════════════════════════════════════════%s\n' "$C_BOLD" "$C_RESET"
  printf '%s %s%s\n' "$C_BOLD" "$title" "$C_RESET"
  printf '  total=%s  %sok=%s%s  %sfalhas=%s%s  %savisos=%s%s  ignorados=%s\n' \
    "$total" "$C_GRN" "$pass" "$C_RESET" "$C_RED" "$fail" "$C_RESET" "$C_YLW" "$warnc" "$C_RESET" "$skip"

  if [ "$fail" -gt 0 ]; then
    printf '\n%s  Falhas:%s\n' "$C_RED" "$C_RESET"
    for i in "${!_CHK_STATUS[@]}"; do
      [ "${_CHK_STATUS[$i]}" = "FAIL" ] && printf '    · %s\n' "${_CHK_LABEL[$i]}"
    done
  fi
  if [ "$warnc" -gt 0 ]; then
    printf '\n%s  Avisos:%s\n' "$C_YLW" "$C_RESET"
    for i in "${!_CHK_STATUS[@]}"; do
      [ "${_CHK_STATUS[$i]}" = "WARN" ] && printf '    · %s\n' "${_CHK_LABEL[$i]}"
    done
  fi

  [ -n "$LOG_FILE" ] && printf '  log: %s\n' "$LOG_FILE"
  printf '%s══════════════════════════════════════════════════════════════%s\n' "$C_BOLD" "$C_RESET"

  if [ -n "$LOG_FILE" ]; then
    printf '[%s] [REPORT] total=%s pass=%s fail=%s warn=%s skip=%s\n' \
      "$(_ts)" "$total" "$pass" "$fail" "$warnc" "$skip" >> "$LOG_FILE"
  fi

  [ "$fail" -eq 0 ] || return "$EX_POSTCOND"
  return 0
}

# Escreve o relatório em JSON — consumível por monitorização.
report_json() {
  local out=$1 i
  local tmp; tmp=$(mktemp)
  {
    printf '{\n  "script": "%s",\n  "host": "%s",\n  "timestamp": "%s",\n  "checks": [\n' \
      "$SCRIPT_NAME" "$(hostname)" "$(_ts)"
    for i in "${!_CHK_STATUS[@]}"; do
      local sep=","; [ "$i" -eq $(( ${#_CHK_STATUS[@]} - 1 )) ] && sep=""
      printf '    {"label": %s, "status": "%s"}%s\n' \
        "$(printf '%s' "${_CHK_LABEL[$i]}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')" \
        "${_CHK_STATUS[$i]}" "$sep"
    done
    printf '  ],\n  "failed": %s,\n  "warned": %s\n}\n' "$(checks_failed)" "$(checks_warned)"
  } > "$tmp"
  if [ "$DRY_RUN" != "1" ]; then
    install -m 0640 "$tmp" "$out" 2>/dev/null || cp "$tmp" "$out"
  fi
  rm -f "$tmp"
}

# ─────────────────────────────────────────────────────────────────────────
# Flags comuns
# ─────────────────────────────────────────────────────────────────────────

# parse_common_flag <arg> — devolve 0 se consumiu a flag, 1 se não é comum.
parse_common_flag() {
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --yes|-y)    ASSUME_YES=1 ;;
    --verbose|-v) VERBOSE=1 ;;
    --no-color)  NO_COLOR=1; _setup_colors ;;
    *) return 1 ;;
  esac
  return 0
}

common_flags_help() {
  cat <<'EOF'
  Flags comuns:
    --dry-run        Mostra o que faria sem alterar nada
    --yes, -y        Não pergunta confirmações (obrigatório em modo não-interactivo)
    --verbose, -v    Output detalhado
    --no-color       Desliga cores
    --help, -h       Esta ajuda
EOF
}
