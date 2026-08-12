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
# Segundo ficheiro de ambiente, com dono diferente e por isso separado:
#   platform.env  — install-platform.sh. Configuração de RUNTIME, entregue
#                   dentro dos containers (env_file do compose).
#   stack.env     — install-stack.sh. Só INTERPOLAÇÃO do compose (caminho
#                   do contexto de build, tag da imagem, bind do proxy).
# Estavam os dois no mesmo ficheiro e o install-platform.sh, que o
# reescreve por inteiro a cada execução, apagava as chaves da stack — a
# stack deixava de subir depois de uma reinstalação da plataforma.
: "${SPHARMMT_STACK_ENV_FILE:=${SPHARMMT_ROOT}/docker/env/stack.env}"
: "${SPHARMMT_SECRETS_FILE:=${SPHARMMT_ROOT}/secrets/platform.secrets.env}"
# Configuração do nginx. CAMINHO CANÓNICO ÚNICO — quem escreve, quem
# valida, quem monta e quem verifica leem todos daqui.
#
# O directório é o que o compose monta em /etc/nginx/conf.d. Se o
# ficheiro não estiver LÁ DENTRO, o nginx arranca sem nenhum `server {}`,
# não escuta em porto nenhum, e o único sintoma é um healthcheck com
# "Connection refused" — que não diz nada sobre montagens.
: "${SPHARMMT_PROXY_CONF_DIR:=${SPHARMMT_ROOT}/proxy/conf}"
: "${SPHARMMT_PROXY_CONF_FILE:=${SPHARMMT_PROXY_CONF_DIR}/spharmmt.conf}"
# Caminho ANTIGO, fora do mount. Existe só para ser detectado e removido.
: "${SPHARMMT_PROXY_CONF_LEGACY:=${SPHARMMT_ROOT}/proxy/spharmmt.conf}"

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

# is_mountpoint <path> — true só se `path` for ELE PRÓPRIO um ponto de
# montagem, não uma pasta dentro de outro.
#
# `findmnt --target <p>` resolve o ponto de montagem que CONTÉM `p`: para
# uma pasta normal em `/` devolve `/`. Comparar esse resultado com o próprio
# caminho é o que distingue "disco montado em /data" de "pasta /data no
# disco do sistema" — a diferença que decide onde os dados vão parar.
is_mountpoint() {
  local p=$1 target
  [ -d "$p" ] || return 1
  target=$(findmnt -no TARGET --target "$p" 2>/dev/null) || return 1
  [ "$target" = "$p" ]
}

# Ficheiro de tabela de montagens. Variável apenas para os testes poderem
# exercitar a lógica sem tocar no sistema real.
: "${FSTAB_FILE:=/etc/fstab}"

# Verifica a tabela de montagens.
#
# ATENÇÃO a duas armadilhas, ambas já responsáveis por falhas reais:
#   1. `findmnt` NÃO tem opção `--quiet` — em versão nenhuma do util-linux.
#      Usá-la faz o comando sair com erro de sintaxe SEMPRE, o que era lido
#      como "fstab inválido". Silenciar faz-se por redirecção.
#   2. O resultado é ABSOLUTO: sinaliza qualquer problema do ficheiro,
#      incluindo os que já lá estavam. Nunca usar como veredicto isolado
#      para decidir reverter uma linha nossa — comparar antes/depois.
fstab_verify_ok() {
  findmnt --verify --tab-file "$FSTAB_FILE" >/dev/null 2>&1
}

: "${SPHARMMT_DATA_MOUNT:=/data}"

# data_root_candidate — imprime o ponto de montagem do disco de dados, ou
# nada. Exige montagem REAL: uma pasta `/data` no disco do sistema não
# serve, e aceitá-la mandaria os dados para o volume errado.
data_root_candidate() {
  local p="$SPHARMMT_DATA_MOUNT" fstype
  is_mountpoint "$p" || return 0
  # Pseudo-filesystems não são volumes de dados.
  fstype=$(findmnt -no FSTYPE --target "$p" 2>/dev/null || true)
  case "$fstype" in
    ''|tmpfs|overlay|squashfs|ramfs|devtmpfs) return 0 ;;
  esac
  printf '%s' "$p"
}

# data_disk_prepared <root> — tem a estrutura que o prepare-data-disk.sh cria.
data_disk_prepared() {
  [ -d "${1}/postgres" ] && [ -d "${1}/backups" ]
}

# data_root_real_data <root> — lista os caminhos com dados REAIS (não
# directórios vazios). Vazio significa "seguro converger".
data_root_real_data() {
  local root=$1 out=""
  [ -n "$(find "${root}/postgres/data" -mindepth 1 -print -quit 2>/dev/null)" ] \
    && out="${out}${root}/postgres/data "
  [ -n "$(find "${root}/backups/postgres" -mindepth 2 -print -quit 2>/dev/null)" ] \
    && out="${out}${root}/backups/postgres "
  printf '%s' "${out% }"
}

# Resolução do data root.
#
# ATENÇÃO À ORDEM: o platform.conf é carregado ACIMA e, se definir
# SPHARMMT_DATA_ROOT, esta detecção era saltada. Uma instalação feita antes
# de o disco existir gravava "/opt/spharmmt" no conf; a partir daí a
# detecção nunca mais corria e o write_conf regravava o mesmo valor — um
# ciclo que se auto-perpetuava e ignorava um /data montado.
#
# Agora regista-se a PROVENIÊNCIA do valor, e é o install-platform.sh que
# decide converger (ver converge_data_root lá).
# Lido pelo install-platform.sh (convergência) e pelo verificador.
# shellcheck disable=SC2034
if [ -n "${SPHARMMT_DATA_ROOT:-}" ]; then
  SPHARMMT_DATA_ROOT_SOURCE=conf
else
  SPHARMMT_DATA_ROOT=$(data_root_candidate)
  if [ -n "$SPHARMMT_DATA_ROOT" ]; then
    SPHARMMT_DATA_ROOT_SOURCE=detectado
  else
    SPHARMMT_DATA_ROOT="$SPHARMMT_ROOT"
    SPHARMMT_DATA_ROOT_SOURCE=default
  fi
fi

# Directórios de dados derivados. Sobreponíveis individualmente em
# platform.conf para migrações parciais (ex.: backups noutro volume).
: "${SPHARMMT_PG_DIR:=${SPHARMMT_DATA_ROOT}/postgres}"
: "${SPHARMMT_POSTGRES_DATA_DIR:=${SPHARMMT_PG_DIR}/data}"
: "${SPHARMMT_BACKUP_DIR:=${SPHARMMT_DATA_ROOT}/backups}"
: "${SPHARMMT_DOCKER_DATA_DIR:=${SPHARMMT_DATA_ROOT}/docker}"

# Recalcula os derivados depois de SPHARMMT_DATA_ROOT mudar (convergência).
recompute_data_paths() {
  SPHARMMT_PG_DIR="${SPHARMMT_DATA_ROOT}/postgres"
  SPHARMMT_POSTGRES_DATA_DIR="${SPHARMMT_PG_DIR}/data"
  SPHARMMT_BACKUP_DIR="${SPHARMMT_DATA_ROOT}/backups"
  SPHARMMT_DOCKER_DATA_DIR="${SPHARMMT_DATA_ROOT}/docker"
}

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
  if [ ${#missing[@]} -eq 0 ]; then return 0; fi
  # Em dry-run, um comando em falta é normalmente um pacote que um passo
  # ANTERIOR simulou instalar (curl e gpg, por exemplo, são instalados pelo
  # step_base e depois exigidos pelo install-docker). Abortar aqui faria o
  # dry-run falhar por uma razão que não existe na execução real.
  if [ "$DRY_RUN" = "1" ]; then
    warn "[dry-run] comandos em falta: ${missing[*]} — em execução real teriam sido instalados antes"
    return 0
  fi
  die_precond "comandos em falta: ${missing[*]}"
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

# ─────────────────────────────────────────────────────────────────────────
# Estado simulado (--dry-run)
# ─────────────────────────────────────────────────────────────────────────
#
# Em dry-run nada é criado, mas os passos seguintes precisam de saber o que
# TERIA sido criado. Sem isto, um passo simula `adduser deploy` e o passo
# seguinte pergunta ao sistema se o utilizador existe, não encontra nada, e
# o dry-run diverge da execução real — além de despejar erros espúrios como
# `id: 'deploy': no such user`.
#
# Estes registos só têm efeito quando DRY_RUN=1. Em execução real as
# funções consultam sempre o sistema.

_SIM_USERS=" "
_SIM_GROUPS=" "
_SIM_USER_GROUPS=" "

sim_user_created()  { _SIM_USERS="${_SIM_USERS}${1} "; }
sim_group_created() { _SIM_GROUPS="${_SIM_GROUPS}${1} "; }
sim_user_in_group() { _SIM_USER_GROUPS="${_SIM_USER_GROUPS}${1}:${2} "; }

_sim_has() { [ "$DRY_RUN" = "1" ] && case "$1" in *" $2 "*) return 0 ;; esac; return 1; }

user_exists() {
  if id "$1" >/dev/null 2>&1; then return 0; fi
  _sim_has "$_SIM_USERS" "$1"
}

group_exists() {
  if getent group "$1" >/dev/null 2>&1; then return 0; fi
  _sim_has "$_SIM_GROUPS" "$1"
}

user_in_group() {
  if id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qx "$2"; then return 0; fi
  _sim_has "$_SIM_USER_GROUPS" "${1}:${2}"
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

# Wrapper do docker compose com o ficheiro e env-files do projecto.
#
# A ordem dos `--env-file` conta: o compose funde-os e o último ganha.
# O stack.env vem depois porque é o que sabe onde está o contexto de
# build e como o proxy está exposto neste servidor concreto.
#
# NENHUM destes dois ficheiros tem segredos: os segredos entram por
# `env_file:` dentro de cada serviço.
#
# Isso NÃO torna o `docker compose config` seguro de partilhar — ele lê
# os `env_file` e imprime os valores em `environment:`. Para inspeccionar
# ou colar num relatório: `dc config --no-env-resolution`.
dc() {
  local args=(-f "$SPHARMMT_COMPOSE_FILE" -p spharmmt)
  [ -f "$SPHARMMT_ENV_FILE" ] && args+=(--env-file "$SPHARMMT_ENV_FILE")
  [ -f "$SPHARMMT_STACK_ENV_FILE" ] && args+=(--env-file "$SPHARMMT_STACK_ENV_FILE")
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

  # O GNU chmod PRESERVA setuid/setgid em DIRECTÓRIOS quando o modo é
  # numérico — mesmo com 4 dígitos. Sobre um directório 2750, `chmod 0700`
  # deixa 2700, não 0700. E um directório criado dentro de um pai com
  # setgid herda-o logo no mkdir.
  #
  # Como os modos deste pacote são absolutos ("quero exactamente isto"),
  # limpamos os bits especiais sempre que o modo pedido não os inclui.
  # Sem isto, `ensure_dir .../secrets 0700` produzia 2700 e o directório de
  # segredos ficava com setgid sem ninguém perceber porquê.
  case "$mode" in
    [0-7][0-7][0-7]|0[0-7][0-7][0-7]) chmod a-s "$path" ;;
  esac
  chmod "$mode" "$path"
  if [ -n "$owner" ]; then chown "$owner" "$path"; fi
  return 0
}

# Política de ficheiros em secrets/: 0600 root:root, sem excepções.
# Qualquer excepção futura tem de ser documentada AQUI — o verificador
# aplica exactamente esta regra.
enforce_secret_file_modes() {
  local dir="${SPHARMMT_ROOT}/secrets"
  [ -d "$dir" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] aplicaria 0600 root:root aos ficheiros de ${dir}"
    return 0
  fi
  local n=0 f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    chmod 0600 "$f" 2>/dev/null || true
    chown root:root "$f" 2>/dev/null || true
    n=$((n + 1))
  done < <(find "$dir" -type f 2>/dev/null)
  if [ "$n" -gt 0 ]; then
    ok "${n} ficheiro(s) em secrets/ a 0600 root:root"
  else
    dbg "sem ficheiros em ${dir}"
  fi
  return 0
}

# ─────────────────────────────────────────────────────────────────────────
# Permissões do reverse proxy
# ─────────────────────────────────────────────────────────────────────────
#
# Definida UMA vez, aqui, porque o install-platform.sh e o install-stack.sh
# criam ambos estes directórios — e duas cópias da mesma política divergem
# assim que uma delas for corrigida.
#
# A POLÍTICA GENÉRICA 2750 NÃO SERVE PARA proxy/conf. Foi exactamente isso
# que deixou o proxy em baixo numa instalação real:
#
#   /opt/spharmmt/proxy/conf  2750 deploy:spharmmt
#
# O bind mount preserva dono e modo do host, e com 2750 não há bits para
# "others". O `ls /etc/nginx/conf.d` devolve "Permission denied", o nginx
# não carrega nenhum `server {}`, arranca na mesma, não escuta na porta
# 80, e o único sintoma é "Connection refused" no healthcheck.
#
# Porque é que o root do container não passa por cima disto: o processo
# master do nginx arranca como root, mas o nosso compose faz
# `cap_drop: ALL` — e DAC_OVERRIDE, a capability que permite ao root
# ignorar os bits de permissão, vai nesse lote. Sem ela, o uid 0 é
# tratado como "others" sobre um directório do uid 1000. É por isso que a
# política genérica 2750 é fatal AQUI e passaria despercebida num
# container sem endurecimento. Reproduzido em deploy/tests/live-proxy.sh.
#
#   proxy/conf   0755  — configuração PÚBLICA. Legível e atravessável por
#                        qualquer uid; não tem nada de secreto.
#   *.conf       0644
#   proxy/certs  0711  — atravessável, NÃO listável. Ver abaixo.
#   fullchain    0644
#   privkey      0640 ou mais restrito.
#
# Sem setgid em proxy/conf: os ficheiros lá dentro não precisam de herdar
# grupo e o bit só tornaria o modo mais difícil de ler.
ensure_proxy_dirs() {
  local owner="${1:-${SPHARMMT_USER}:${SPHARMMT_GROUP}}"

  ensure_dir "$SPHARMMT_PROXY_CONF_DIR" 0755 "$owner"
  # 0711 e não 0750. Pela mesma razão que o `proxy/conf` é 0755: com
  # `cap_drop: ALL` o nginx não tem DAC_OVERRIDE, e sobre um directório
  # do uid 1000 o uid do container conta como "others". Sem bit de
  # execução em others não ATRAVESSA o directório, e nem chega a tentar
  # abrir os ficheiros — o modo de fullchain.pem e privkey.pem passa a
  # ser irrelevante. O nginx recusa arrancar e a plataforma fica sem
  # caminho de entrada.
  #
  # 0711 dá travessia sem dar listagem: sem bit de leitura em others,
  # ninguém enumera o conteúdo do directório. A protecção das chaves fica
  # onde deve ficar, no modo dos próprios ficheiros (0640, garantido por
  # enforce_tls_key_modes).
  #
  # 0750 já regressou aqui mais do que uma vez em reinstalações e o
  # sintoma — nginx que não arranca — não aponta para as permissões.
  # Fixado em deploy/tests/test-proxy-certs-mode.sh.
  ensure_dir "${SPHARMMT_ROOT}/proxy/certs" 0711 "$owner"
  # ZIP base do agent, montado no nginx em só-leitura e servido em
  # /agent-base/. 0755 pela mesma razão que o conf: o utilizador do
  # container (uid 101) tem de atravessar o directório, e com
  # `cap_drop: ALL` nem o root lá dentro tem DAC_OVERRIDE para
  # contornar um bit em falta.
  ensure_dir "${SPHARMMT_ROOT}/agent-base" 0755 "$owner"
  [ "$DRY_RUN" = "1" ] && return 0

  # Modo reafirmado a cada execução: uma configuração instalada antes
  # desta política pode ter ficado a 0640 e continuar invisível ao nginx.
  local f
  for f in "$SPHARMMT_PROXY_CONF_DIR"/*.conf; do
    [ -f "$f" ] || continue
    chmod 0644 "$f"
    chown "$owner" "$f" 2>/dev/null || true
  done

  enforce_tls_key_modes "$owner"
  return 0
}

# Chaves privadas TLS a 0640 ou mais restrito. O nginx lê-as como root (o
# processo master arranca root e só os workers largam privilégios), por
# isso não precisam de bits para others — e não os podem ter.
enforce_tls_key_modes() {
  local owner="${1:-${SPHARMMT_USER}:${SPHARMMT_GROUP}}"
  local dir="${SPHARMMT_ROOT}/proxy/certs"
  [ -d "$dir" ] || return 0
  [ "$DRY_RUN" = "1" ] && return 0

  local f n=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Só aperta quando está mais aberto do que 0640 — nunca afrouxa uma
    # chave que o operador tenha deixado a 0600.
    case "$(stat -c '%a' "$f" 2>/dev/null || echo 000)" in
      600|400|640|440) ;;
      *) chmod 0640 "$f"; chown "$owner" "$f" 2>/dev/null || true; n=$((n + 1)) ;;
    esac
  done < <(find "$dir" -maxdepth 1 -type f \
             \( -name '*.key' -o -name 'privkey*.pem' -o -name '*-key.pem' \) 2>/dev/null)

  [ "$n" -gt 0 ] && ok "${n} chave(s) TLS restringida(s) a 0640"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────
# PGDATA — dono e modo
# ─────────────────────────────────────────────────────────────────────────
#
# O PGDATA NÃO pertence ao `deploy`. Pertence ao utilizador `postgres` da
# imagem, que é uid/gid 999 em postgres:17-bookworm.
#
# O que aconteceu por não ser assim: a política genérica de estrutura
# repunha `2700 deploy:spharmmt` no PGDATA. O entrypoint do container
# arranca como root e consegue inicializar o cluster à mesma, portanto o
# arranque parecia bem — mas os processos que escrevem depois correm como
# uid 999 e ficam sem acesso ao directório. O resultado aparece só mais
# tarde, no primeiro checkpoint:
#
#     PANIC: could not open control file "pg_control": Permission denied
#     FATAL: could not stat data directory
#
# Uma base de dados que arranca e morre a meio da primeira escrita é o
# pior modo de falha possível: o erro não aponta para permissões e o
# operador já tem tráfego em cima.
#
# Estes valores são sobreponíveis em platform.conf, e o install-stack.sh
# escreve-os lá depois de os LER DA IMAGEM configurada — se um dia a
# imagem mudar de uid, a configuração acompanha sem ninguém ter de saber
# de cor que era 999.
: "${SPHARMMT_PG_UID:=999}"
: "${SPHARMMT_PG_GID:=999}"

# pg_image_uid_gid <imagem> — imprime "uid:gid" do utilizador postgres
# dessa imagem. Devolve 1 se não conseguir perguntar.
pg_image_uid_gid() {
  local image=$1 out
  has_cmd docker || return 1
  out=$(docker run --rm --entrypoint sh "$image" -c 'id -u postgres; id -g postgres' 2>/dev/null) || return 1
  local uid gid
  uid=$(printf '%s\n' "$out" | sed -n '1p')
  gid=$(printf '%s\n' "$out" | sed -n '2p')
  case "${uid}${gid}" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s:%s' "$uid" "$gid"
}

# `true` quando o PostgreSQL está a servir. Enquanto estiver, NINGUÉM
# mexe no PGDATA.
pg_is_running() { container_running "$SPHARMMT_PG_CONTAINER"; }

# ─────────────────────────────────────────────────────────────────────────
# A POLÍTICA, num sítio só
# ─────────────────────────────────────────────────────────────────────────
#
# `pgdata_owner_ok` é a ÚNICA definição de "o PGDATA está bem". Quem
# corrige (ensure_pgdata_dir) e quem valida (verify-platform.sh) chamam
# esta função — não podem ter cada um a sua leitura.
#
# Porquê: o install-stack.sh já aplicava uid 999 e o PostgreSQL passava
# CHECKPOINT, e o verificador continuava a reprovar com "owner
# deploy:spharmmt". Duas implementações da mesma regra divergem sempre;
# a que valida acabou a reprovar o que a que corrige tinha acabado de
# fazer bem.
#
# A regra:
#   · owner uid == SPHARMMT_PG_UID (o utilizador postgres da imagem);
#   · modo 0700 ou 2700.
#
# O GID é ignorado de propósito. O entrypoint da imagem faz
# `chown postgres` SEM grupo, portanto um cluster criado de raiz fica
# 999:0 e um corrigido à mão fica 999:999 — os dois funcionam, e com 0700
# o grupo não tem acesso nenhum. Exigir gid 999 reprovaria qualquer
# instalação nova.
pgdata_owner_ok() {
  local path="${1:-$SPHARMMT_POSTGRES_DATA_DIR}"
  [ -d "$path" ] || return 1
  local uid mode
  uid=$(stat -c '%u' "$path" 2>/dev/null) || return 1
  mode=$(stat -c '%a' "$path" 2>/dev/null) || return 1
  [ "$uid" = "$SPHARMMT_PG_UID" ] || return 1
  case "$mode" in 700|2700) return 0 ;; *) return 1 ;; esac
}

# pgdata_state [path] — "modo uid:gid", para mensagens e relatórios.
pgdata_state() {
  local path="${1:-$SPHARMMT_POSTGRES_DATA_DIR}"
  stat -c '%a %u:%g' "$path" 2>/dev/null || printf '? ?:?'
}

# ensure_pgdata_dir — cria/corrige o PGDATA, com uma regra absoluta:
# NUNCA lhe toca com o PostgreSQL em execução.
#
# Um `chown` do directório com o servidor de pé não dá erro nenhum na
# altura; o servidor só descobre no checkpoint seguinte, e aí entra em
# PANIC. Alterar isto a quente troca uma configuração errada por uma base
# de dados em baixo.
ensure_pgdata_dir() {
  local path="${1:-$SPHARMMT_POSTGRES_DATA_DIR}"
  local want="${SPHARMMT_PG_UID}:${SPHARMMT_PG_GID}"

  if [ -e "$path" ] && [ ! -d "$path" ]; then
    die "$path existe e NÃO é um directório — intervenção manual necessária"
  fi
  if [ ! -d "$path" ]; then
    run mkdir -p "$path"
    ok "criado PGDATA ${path}"
    CHANGES_MADE=1
  fi
  [ "$DRY_RUN" = "1" ] && { info "[dry-run] PGDATA ficaria 0700 ${want}"; return 0; }

  # A avaliação é a de `pgdata_owner_ok` — a MESMA que o verificador usa.
  local state; state=$(pgdata_state "$path")

  if pg_is_running; then
    if pgdata_owner_ok "$path"; then
      dbg "PGDATA correcto (${state}) e PostgreSQL a correr — não é tocado"
    else
      warn "PGDATA está ${state}, esperado 0700 com uid ${SPHARMMT_PG_UID} — e o PostgreSQL está A CORRER"
      warn "NÃO vai ser alterado: um chown/chmod do PGDATA com o servidor de pé"
      warn "não falha na altura, mas leva-o a PANIC no checkpoint seguinte."
      warn "Para corrigir: parar a stack, correr este script outra vez, e voltar a subir."
    fi
    return 0
  fi

  # PostgreSQL parado: já está bem? não se toca — evita reescrever o gid
  # de um cluster criado pelo entrypoint (999:0), que é válido.
  if pgdata_owner_ok "$path"; then
    dbg "PGDATA já conforme (${state})"
    return 0
  fi

  # Só o directório — o conteúdo é do cluster e não se lhe toca.
  chmod a-s "$path" 2>/dev/null || true
  chmod 0700 "$path"
  chown "$want" "$path"
  ok "PGDATA ${path}: ${state} → $(pgdata_state "$path") (utilizador postgres da imagem)"
  CHANGES_MADE=1
  return 0
}

# ─────────────────────────────────────────────────────────────────────────
# Scripts operacionais instalados em ${SPHARMMT_ROOT}/scripts
# ─────────────────────────────────────────────────────────────────────────
#
# O operador corre `sudo /opt/spharmmt/scripts/verify-platform.sh`, não o
# do checkout. Se essa cópia não for refrescada, valida com regras de uma
# versão anterior — foi assim que o verificador reprovou "postgres/data
# owner deploy:spharmmt" depois de o install-stack.sh já ter posto o
# PGDATA correcto: o repositório estava certo, a cópia instalada não.
#
# Definida aqui para que o install-platform.sh E o install-stack.sh
# instalem exactamente o mesmo conjunto, da mesma maneira.
#
# `install-stack.sh` fica DE FORA de propósito: precisa da árvore do
# repositório ao lado (Dockerfile, compose, init do PostgreSQL) e a partir
# de /opt/spharmmt não a encontraria.
SPHARMMT_OPERATIONAL_SCRIPTS="bootstrap-vps.sh install-docker.sh install-platform.sh prepare-data-disk.sh verify-platform.sh update-platform.sh backup-platform.sh restore-platform.sh healthcheck.sh"

# install_operational_scripts <src_dir> <owner>
install_operational_scripts() {
  local src=$1 owner=$2
  local dst="${SPHARMMT_ROOT}/scripts"
  local user=${owner%%:*} group=${owner##*:}

  ensure_dir "$dst" 2750 "$owner"
  ensure_dir "${dst}/lib" 2750 "$owner"

  local s n=0
  for s in $SPHARMMT_OPERATIONAL_SCRIPTS; do
    if [ -f "${src}/${s}" ]; then
      run install -m 0750 -o "$user" -g "$group" "${src}/${s}" "${dst}/${s}"
      n=$((n + 1))
    else
      warn "script ausente na origem: ${s}"
    fi
  done
  run install -m 0640 -o "$user" -g "$group" "${src}/lib/common.sh" "${dst}/lib/common.sh"

  # O healthcheck vive também em monitoring/checks — é o caminho que a
  # unit systemd usa.
  ensure_dir "${SPHARMMT_ROOT}/monitoring/checks" 2750 "$owner"
  run install -m 0750 -o "$user" -g "$group" \
    "${src}/healthcheck.sh" "${SPHARMMT_ROOT}/monitoring/checks/healthcheck.sh"

  ok "${n} script(s) operacionais instalados em ${dst}"
  return 0
}

# installed_scripts_current <src_dir> — 0 quando a cópia instalada é
# byte-a-byte igual à do checkout. Torna a desactualização VISÍVEL em vez
# de a deixar manifestar-se como uma validação com regras antigas.
installed_scripts_current() {
  local src=$1 dst="${SPHARMMT_ROOT}/scripts" s
  [ -d "$dst" ] || return 1
  for s in $SPHARMMT_OPERATIONAL_SCRIPTS; do
    [ -f "${src}/${s}" ] || continue
    cmp -s "${src}/${s}" "${dst}/${s}" || return 1
  done
  cmp -s "${src}/lib/common.sh" "${dst}/lib/common.sh" || return 1
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

# NENHUM gerador pode usar uma pipeline com consumidor que termina cedo.
#
# A versão anterior era:
#     LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40
# O `head` fecha o pipe ao fim de 40 bytes, o `tr` — que lê de uma fonte
# INFINITA — recebe SIGPIPE e morre com 141. Com `set -o pipefail` a
# pipeline devolve 141, a substituição de comando falha e o `set -e` aborta
# o script. Foi assim que a geração de segredos rebentou com rc=141.
#
# Todos os geradores abaixo consomem saídas FINITAS: o produtor termina de
# escrever antes de o consumidor sair, portanto não há SIGPIPE possível.

gen_hex() { openssl rand -hex "${1:-32}"; }

gen_base64() {
  # `tr -d` lê o input todo — o openssl termina primeiro. Sem early exit.
  openssl rand -base64 "${1:-32}" | tr -d '\n'
}

# Password para o Postgres: alfanumérica, para não exigir escaping em URLs
# de ligação nem em YAML (@ : / ? # % & = ' " \ espaço). 40 caracteres de
# [A-Za-z0-9] ≈ 238 bits de entropia.
#
# Cada volta consome uma saída finita do openssl; o filtro `tr` remove os
# caracteres não-alfanuméricos do base64 (+ / = e newlines), o que encurta o
# resultado — daí o laço até haver comprimento suficiente. O corte final é
# feito em bash, sem processos, portanto o comprimento é exacto.
gen_password() {
  local len=${1:-40} out=""
  while [ "${#out}" -lt "$len" ]; do
    out="${out}$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${out:0:len}"
}

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

  # Zero verificações NÃO é sucesso. Acontecia com `--section <nome inválido>`:
  # nenhuma secção correspondia, nada corria, e o relatório dava rc=0 —
  # exactamente o resultado que um operador leria como "está tudo bem".
  if [ "$total" -eq 0 ]; then
    printf '\n%s══════════════════════════════════════════════════════════════%s\n' "$C_BOLD" "$C_RESET"
    err "${title}: NENHUMA verificação foi executada"
    err "Isto não é sucesso — é um filtro que não corresponde a nada, ou um bug."
    printf '%s══════════════════════════════════════════════════════════════%s\n' "$C_BOLD" "$C_RESET"
    return "$EX_POSTCOND"
  fi
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

# ── Domínio administrativo ───────────────────────────────────────────
#
# derive_admin_url <url_publico> [url_admin_explicito]
#
# O nginx serve /api/admin/ e /agent-base/ SÓ no domínio administrativo e
# devolve 404 a ambos no domínio da aplicação. Derivar o ZIP base do agent
# a partir do URL público dava um 404 ao Wizard — sem erro na instalação,
# só um Wizard que não gera ZIPs.
#
# Ordem: explícito > convenção > URL público.
#
# A convenção troca o primeiro rótulo do host por "admin":
#   https://app.spharmmt.com  ->  https://admin.spharmmt.com
# Só se aplica a hosts com três ou mais rótulos. Em "exemplo.pt" não há
# rótulo a substituir, e inventar "admin.exemplo.pt" seria adivinhar um
# domínio que pode não existir nem ter certificado.
#
# Sem domínio (instalação por IP, túnel SSH, teste) não há separação de
# domínios: admin e aplicação são o mesmo endereço e o /agent-base/ é
# servido pelo vhost de diagnóstico. Devolver o URL público é aqui a
# resposta certa, não um fallback defensivo.
# Valor de uma chave num ficheiro de ambiente, com precedência explícita:
#
#   1. variável de ambiente com o mesmo nome  → intenção do operador AGORA
#   2. valor já no ficheiro                   → decisão tomada antes
#   3. default                                → primeira instalação
#
# Existe porque `write_file` reescreve o platform.env inteiro a cada
# execução. Sem preservação, uma feature flag ligada por alguém volta a
# 0 na reinstalação seguinte — em silêncio, e a falha aparece longe da
# causa (o agent a apanhar 503 dias depois).
#
# A ordem importa: o ambiente ganha ao ficheiro para que se possa MUDAR o
# valor sem editar nada à mão. `ENABLE_AGENT_BOOTSTRAP=1 ./install-platform.sh`
# liga; `ENABLE_AGENT_BOOTSTRAP=0 ./install-platform.sh` desliga; sem
# variável, fica como estava.
#
# Uso: env_value_or_keep <ficheiro> <CHAVE> <default>
env_value_or_keep() {
  local file="$1" key="$2" default="${3:-}"

  # `${!key}` lê a variável cujo NOME está em $key. Distingue "definida a
  # vazio" de "não definida": a primeira é uma escolha, a segunda não.
  if [ -n "${!key+x}" ] && [ -n "${!key}" ]; then
    printf '%s' "${!key}"
    return 0
  fi

  if [ -r "$file" ]; then
    local atual
    # sub() em vez de -F=: preserva valores que contenham '='.
    atual=$(awk -v k="^${key}=" '$0 ~ k {sub(/^[^=]*=/, ""); print; exit}' "$file" || true)
    if [ -n "$atual" ]; then
      printf '%s' "$atual"
      return 0
    fi
  fi

  printf '%s' "$default"
}

derive_admin_url() {
  local public_url="${1:-}" explicit="${2:-}"
  if [ -n "$explicit" ]; then printf '%s
' "$explicit"; return 0; fi
  case "$public_url" in
    http://*|https://*) ;;
    *) printf '%s
' "$public_url"; return 0 ;;
  esac
  local scheme rest host hostname
  scheme=${public_url%%://*}
  rest=${public_url#*://}
  host=${rest%%/*}
  hostname=${host%%:*}   # sem porta

  # Um IPv4 tem três pontos e casaria com o padrão de subdomínio:
  # 164.132.85.211 viraria "admin.132.85.211", um endereço que não existe.
  # Numa instalação por IP não há domínios nem separação de vhosts.
  case "$hostname" in
    *[!0-9.]*) ;;                                  # tem letras: é um nome
    *) printf '%s
' "$public_url"; return 0 ;;   # só dígitos e pontos: IP
  esac

  case "$hostname" in
    admin.*) printf '%s
' "$public_url" ;;
    *.*.*)   printf '%s
' "${scheme}://admin.${hostname#*.}${host#"$hostname"}" ;;
    *)       printf '%s
' "$public_url" ;;
  esac
}
