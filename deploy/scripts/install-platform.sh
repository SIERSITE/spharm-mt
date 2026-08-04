#!/usr/bin/env bash
# deploy/scripts/install-platform.sh
#
# Instala a camada de plataforma do SPharm.MT sobre uma VPS já preparada
# por bootstrap-vps.sh:
#
#   · garante a estrutura /opt/spharmmt (idempotente)
#   · escreve /etc/spharmmt/platform.conf — configuração central lida por
#     TODOS os scripts, para que uma VPS com layout diferente não exija
#     editar código
#   · gera os segredos que ainda não existam (nunca sobrepõe os existentes)
#   · renderiza docker/env/platform.env com a configuração não-secreta
#   · instala os scripts operacionais em /opt/spharmmt/scripts
#   · instala e activa o timer de backup
#   · se já existir um docker-compose.yml da plataforma, valida-o e sobe a stack
#
# IDEMPOTÊNCIA — a regra mais importante deste script:
# os segredos NUNCA são regenerados. TENANT_ENCRYPTION_SECRET decifra as
# passwords de todas as bases de tenant; regenerá-lo tornaria os tenants
# existentes inacessíveis de forma irreversível. Se o ficheiro de segredos
# existir, só são acrescentadas as chaves em falta.
#
# Uso:
#   sudo ./install-platform.sh [--public-url https://app.exemplo.pt] [flags comuns]
#
# Saída: 0 ok · 2 pré-condição · 3 pós-condição · 4 uso · 5 lock

set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

PUBLIC_URL=""
DEPLOY_USER="$SPHARMMT_USER"
DEPLOY_GROUP="$SPHARMMT_GROUP"
SKIP_COMPOSE=0
ROTATE_CRON_SECRET=0

usage() {
  cat <<EOF
Uso: sudo $0 [opções]

  --public-url <url>       URL público da plataforma (ex.: https://app.spharmmt.app).
                           Sem domínio ainda? Deixa em branco — fica http://<ip>
                           e o cookie de sessão continua não-secure (correcto para HTTP).
  --deploy-user <nome>     Default: ${DEPLOY_USER}
  --skip-compose           Não tenta subir a stack mesmo que o compose exista
  --rotate-cron-secret     Regenera CRON_SECRET (seguro: não afecta dados)
$(common_flags_help)

Segredos: gerados em ${SPHARMMT_SECRETS_FILE} (0600 root:root).
NUNCA são regenerados numa segunda execução — só as chaves em falta são
acrescentadas. TENANT_ENCRYPTION_SECRET em particular decifra as passwords
de todas as bases de tenant: perdê-lo ou rodá-lo torna-as inacessíveis.
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --public-url) PUBLIC_URL=${2:?}; shift 2 ;;
    --deploy-user) DEPLOY_USER=${2:?}; shift 2 ;;
    --skip-compose) SKIP_COMPOSE=1; shift ;;
    --rotate-cron-secret) ROTATE_CRON_SECRET=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die_usage "opção desconhecida: $1" ;;
  esac
done

OWNER="${DEPLOY_USER}:${DEPLOY_GROUP}"

# ═════════════════════════════════════════════════════════════════════════
preflight() {
  step "Pré-condições"
  require_root
  require_ubuntu 24.04
  require_cmd docker openssl install systemctl awk sed
  docker compose version >/dev/null 2>&1 || die_precond "docker compose v2 ausente — corre install-docker.sh"
  require_data_root_mounted
  id "$DEPLOY_USER" >/dev/null 2>&1 || die_precond "utilizador ${DEPLOY_USER} não existe — corre bootstrap-vps.sh"
  getent group "$DEPLOY_GROUP" >/dev/null || die_precond "grupo ${DEPLOY_GROUP} não existe — corre bootstrap-vps.sh"
  require_free_space / 10240
  ok "pré-condições satisfeitas"
}

# ═════════════════════════════════════════════════════════════════════════
# 1. Estrutura (idempotente — repete o que o bootstrap fez, sem destruir)
# ═════════════════════════════════════════════════════════════════════════
ensure_structure() {
  step "1. Estrutura"

  # ── Código, configuração e segredos: sempre em $SPHARMMT_ROOT ────────
  ensure_dir "$SPHARMMT_ROOT" 2750 "$OWNER"
  # `secrets` fica FORA desta lista: 2750 dar-lhe-ia setgid e permissões de
  # grupo, precisamente o que não pode ter.
  local dirs=(
    app
    logs logs/app logs/postgres logs/proxy logs/monitoring logs/backups
    docker docker/compose docker/env docker/build
    scripts scripts/lib monitoring monitoring/checks monitoring/state
    proxy proxy/conf proxy/certs
  )
  for d in "${dirs[@]}"; do ensure_dir "${SPHARMMT_ROOT}/${d}" 2750 "$OWNER"; done
  ensure_dir "${SPHARMMT_ROOT}/secrets" 0700 root:root
  ok "aplicação e configuração em ${SPHARMMT_ROOT}"

  # ── Dados: em $SPHARMMT_DATA_ROOT ────────────────────────────────────
  local ddirs=(
    "${SPHARMMT_PG_DIR}" "${SPHARMMT_PG_DIR}/conf" "${SPHARMMT_PG_DIR}/init"
    "${SPHARMMT_BACKUP_DIR}" "${SPHARMMT_BACKUP_DIR}/postgres"
    "${SPHARMMT_BACKUP_DIR}/postgres/daily" "${SPHARMMT_BACKUP_DIR}/postgres/weekly"
    "${SPHARMMT_BACKUP_DIR}/postgres/monthly"
    "${SPHARMMT_BACKUP_DIR}/files" "${SPHARMMT_BACKUP_DIR}/tmp"
  )
  for d in "${ddirs[@]}"; do ensure_dir "$d" 2750 "$OWNER"; done
  # 2700: o PostgreSQL só recusa bits de grupo/others (S_IRWXG|S_IRWXO); o
  # setgid não entra nessa máscara e mantém a herança de grupo.
  ensure_dir "${SPHARMMT_PG_DIR}/data" 2700 "$OWNER"
  ensure_dir "${SPHARMMT_BACKUP_DIR}/postgres" 2700 "$OWNER"

  if data_disk_in_use; then
    ensure_dir "$SPHARMMT_DOCKER_DATA_DIR" 2750 root:root
    ok "dados no disco dedicado ${SPHARMMT_DATA_ROOT} ($(df -Ph "$SPHARMMT_DATA_ROOT" | awk 'NR==2 {print $4}') livres)"
    check_legacy_data
  else
    ok "dados em ${SPHARMMT_DATA_ROOT} (mesmo volume do sistema)"
    local free; free=$(df -Ph "$SPHARMMT_ROOT" | awk 'NR==2 {print $4}')
    info "espaço livre: ${free}. Há disco livre por usar? corre prepare-data-disk.sh"
  fi
}

# Detecta dados deixados para trás no layout antigo. NUNCA os move: mover
# dados exige a stack parada e uma decisão consciente sobre o que é fonte de
# verdade. Aqui limitamo-nos a tornar o problema visível.
check_legacy_data() {
  local legacy_pg="${SPHARMMT_ROOT}/postgres/data"
  local legacy_bk="${SPHARMMT_ROOT}/backups/postgres"
  local found=0

  if [ -d "$legacy_pg" ] && [ -n "$(ls -A "$legacy_pg" 2>/dev/null)" ]; then
    warn "EXISTEM DADOS em ${legacy_pg} (layout antigo), mas a configuração aponta agora para ${SPHARMMT_PG_DIR}/data"
    found=1
  fi
  if [ -d "$legacy_bk" ] && [ -n "$(ls -A "$legacy_bk" 2>/dev/null)" ]; then
    warn "EXISTEM BACKUPS em ${legacy_bk}, mas a configuração aponta agora para ${SPHARMMT_BACKUP_DIR}/postgres"
    found=1
  fi

  if [ "$found" = "1" ]; then
    warn "Nada foi movido — este script nunca move dados automaticamente."
    warn "Para migrar, com a stack PARADA e depois de um backup verificado:"
    warn "    sudo systemctl stop spharmmt-backup.timer"
    warn "    sudo rsync -aHAX --info=progress2 ${SPHARMMT_ROOT}/postgres/data/ ${SPHARMMT_PG_DIR}/data/"
    warn "    # validar, e só depois remover a origem"
  fi
}

# ═════════════════════════════════════════════════════════════════════════
# 2. Configuração central
# ═════════════════════════════════════════════════════════════════════════
write_conf() {
  step "2. Configuração central"
  ensure_dir /etc/spharmmt 0755 root:root

  # Preserva valores já definidos numa instalação anterior.
  local existing_url=""
  [ -r "$SPHARMMT_CONF_FILE" ] && existing_url=$(awk -F= '/^SPHARMMT_PUBLIC_URL=/ {gsub(/"/,"",$2); print $2}' "$SPHARMMT_CONF_FILE" || true)
  [ -z "$PUBLIC_URL" ] && PUBLIC_URL="$existing_url"

  write_file "$SPHARMMT_CONF_FILE" 0644 root:root <<EOF
# /etc/spharmmt/platform.conf
# Configuração central lida por TODOS os scripts de deploy do SPharm.MT.
# Gerido por install-platform.sh — editável à mão; as chaves aqui vencem
# sobre os defaults dos scripts.

SPHARMMT_ROOT="${SPHARMMT_ROOT}"
SPHARMMT_USER="${DEPLOY_USER}"
SPHARMMT_GROUP="${DEPLOY_GROUP}"
SPHARMMT_LOG_DIR="${SPHARMMT_LOG_DIR}"

SPHARMMT_COMPOSE_FILE="${SPHARMMT_ROOT}/docker/compose/docker-compose.yml"
SPHARMMT_ENV_FILE="${SPHARMMT_ROOT}/docker/env/platform.env"
SPHARMMT_SECRETS_FILE="${SPHARMMT_ROOT}/secrets/platform.secrets.env"

# ── Dados ────────────────────────────────────────────────────────────
# SPHARMMT_ROOT guarda aplicação, configuração e segredos (pequeno,
# recriável). SPHARMMT_DATA_ROOT guarda o que cresce: PostgreSQL, backups
# e, no futuro, volumes Docker.
#
# Quando são iguais, é uma VPS de disco único — comportamento de sempre.
# Quando diferem, os dados vivem num volume dedicado montado por UUID.
#
# Estes valores são EXPLÍCITOS de propósito: depois de instalada, a
# plataforma não deve mudar de sítio por o /data ter falhado a montar num
# arranque. Se editares isto à mão, os dados NÃO são movidos.
SPHARMMT_DATA_ROOT="${SPHARMMT_DATA_ROOT}"
SPHARMMT_PG_DIR="${SPHARMMT_PG_DIR}"
SPHARMMT_BACKUP_DIR="${SPHARMMT_BACKUP_DIR}"
SPHARMMT_DOCKER_DATA_DIR="${SPHARMMT_DOCKER_DATA_DIR}"

SPHARMMT_NETWORK="${SPHARMMT_NETWORK}"
SPHARMMT_PG_CONTAINER="${SPHARMMT_PG_CONTAINER}"
SPHARMMT_APP_CONTAINER="${SPHARMMT_APP_CONTAINER}"
SPHARMMT_PROXY_CONTAINER="${SPHARMMT_PROXY_CONTAINER}"

SPHARMMT_PUBLIC_URL="${PUBLIC_URL}"

# Retenção de backups (ver backup-platform.sh)
BACKUP_KEEP_DAILY=14
BACKUP_KEEP_WEEKLY=8
BACKUP_KEEP_MONTHLY=12
# Aborta o backup acima desta ocupação de disco — um backup que enche o
# disco derruba o PostgreSQL.
BACKUP_MAX_DISK_PCT=85

# Limiares do healthcheck
DISK_WARN=75
DISK_CRIT=90
MEM_WARN=85
MEM_CRIT=95
LOAD_WARN=4
LOAD_CRIT=8
BACKUP_MAX_AGE_H=30
EOF
  ok "configuração em ${SPHARMMT_CONF_FILE}"
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Segredos — gerados uma vez, nunca regenerados
# ═════════════════════════════════════════════════════════════════════════

# secret_ensure <chave> <gerador> [descrição]
# Acrescenta a chave ao ficheiro de segredos apenas se ainda não existir.
secret_ensure() {
  local key=$1 value_cmd=$2 desc=${3:-}
  if grep -qE "^${key}=" "$SPHARMMT_SECRETS_FILE" 2>/dev/null; then
    dbg "${key} já definido — preservado"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then info "[dry-run] geraria ${key}"; return 0; fi
  local value; value=$($value_cmd)
  [ -n "$desc" ] && printf '# %s\n' "$desc" >> "$SPHARMMT_SECRETS_FILE"
  printf '%s=%s\n' "$key" "$value" >> "$SPHARMMT_SECRETS_FILE"
  ok "${key} gerado"
  # Lida no relatório final; declarada em lib/common.sh.
  # shellcheck disable=SC2034
  CHANGES_MADE=1
}

gen_secrets() {
  step "3. Segredos"

  if [ -f "$SPHARMMT_SECRETS_FILE" ]; then
    ok "ficheiro de segredos já existe — valores existentes PRESERVADOS"
  else
    if [ "$DRY_RUN" != "1" ]; then
      install -m 0600 -o root -g root /dev/null "$SPHARMMT_SECRETS_FILE"
      cat >> "$SPHARMMT_SECRETS_FILE" <<EOF
# ${SPHARMMT_SECRETS_FILE}
# Gerado por install-platform.sh em $(_ts).
#
# NUNCA versionar. NUNCA copiar para um backup não cifrado.
# Modo 0600 root:root — o utilizador ${DEPLOY_USER} lê com sudo.
#
# AVISO CRÍTICO: TENANT_ENCRYPTION_SECRET decifra as passwords de TODAS as
# bases de tenant (Tenant.dbPassEncrypted, AES-256-GCM). Perder este valor
# torna os tenants inacessíveis; rodá-lo exige re-cifrar todas as entradas
# do control plane antes da troca. Guarda uma cópia offline.

EOF
    fi
    ok "ficheiro de segredos criado (0600 root:root)"
  fi

  secret_ensure POSTGRES_SUPERUSER_PASSWORD "gen_password 40" "Superutilizador do PostgreSQL (role postgres)"
  secret_ensure POSTGRES_APP_PASSWORD       "gen_password 40" "Role da aplicação (owner das bases legacy/control)"
  secret_ensure AUTH_SECRET                 "gen_base64 32"   "Assinatura das sessões JWT (lib/session)"
  secret_ensure TENANT_ENCRYPTION_SECRET    "gen_hex 32"      "AES-256-GCM de Tenant.dbPassEncrypted — NAO RODAR"
  secret_ensure EMAIL_CONFIG_SECRET         "gen_hex 32"      "Cifra das credenciais SMTP por farmácia"
  secret_ensure ADMIN_API_TOKEN             "gen_hex 32"      "Token do Admin Wizard (ADMIN_API_TOKENS)"

  if [ "$ROTATE_CRON_SECRET" = "1" ] && [ "$DRY_RUN" != "1" ]; then
    backup_file "$SPHARMMT_SECRETS_FILE"
    sed -i '/^CRON_SECRET=/d' "$SPHARMMT_SECRETS_FILE"
    warn "CRON_SECRET removido para rotação"
  fi
  secret_ensure CRON_SECRET "gen_hex 24" "Bearer dos endpoints /api/jobs/* (scheduler local)"

  if [ "$DRY_RUN" != "1" ]; then
    chmod 0600 "$SPHARMMT_SECRETS_FILE"
    chown root:root "$SPHARMMT_SECRETS_FILE"
    enforce_secret_file_modes
    # Um segredo vazio passa despercebido e falha só em produção.
    local empty
    empty=$(awk -F= '/^[A-Z_]+=/ && ($2 == "" ) {print $1}' "$SPHARMMT_SECRETS_FILE" | tr '\n' ' ')
    [ -n "${empty// /}" ] && die "segredos com valor vazio: ${empty}"
  fi
  ok "segredos completos e protegidos"
}

# ═════════════════════════════════════════════════════════════════════════
# 4. Configuração não-secreta da stack
# ═════════════════════════════════════════════════════════════════════════
write_env() {
  step "4. Configuração da stack"

  # Sem domínio ainda: o cookie de sessão NÃO pode ser secure, senão o
  # browser recusa-o em HTTP e o login entra em loop. Passa a 1 quando
  # houver TLS — é exactamente o que a flag SESSION_COOKIE_SECURE controla.
  local cookie_secure=0
  case "$PUBLIC_URL" in https://*) cookie_secure=1 ;; esac

  local public_url="$PUBLIC_URL"
  if [ -z "$public_url" ]; then
    local ip; ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    public_url="http://${ip:-127.0.0.1}"
  fi

  write_file "$SPHARMMT_ENV_FILE" 0640 "$OWNER" <<EOF
# ${SPHARMMT_ENV_FILE}
# Configuração NÃO-SECRETA da stack. Os segredos vivem em
# ${SPHARMMT_SECRETS_FILE} e são carregados em separado pelo compose.
# Gerido por install-platform.sh — seguro editar à mão.

# ── Identidade e URLs ────────────────────────────────────────────────
NODE_ENV=production
SPHARMMT_PUBLIC_ENDPOINT=${public_url}
NEXT_PUBLIC_APP_URL=${public_url}

# Cookie de sessão: só pode ser secure sobre HTTPS. Com acesso por IP em
# HTTP, secure=1 faz o browser descartar o cookie e o login entra em loop.
SESSION_COOKIE_SECURE=${cookie_secure}
SESSION_COOKIE_SAMESITE=lax

# ── Caminhos de dados no host (bind mounts do compose, fase seguinte) ─
# Separação deliberada: SPHARMMT_ROOT tem aplicação e configuração,
# DATA_ROOT tem o que cresce. Numa VPS de disco único são o mesmo sítio.
DATA_ROOT=${SPHARMMT_DATA_ROOT}
POSTGRES_DATA_DIR=${SPHARMMT_PG_DIR}/data
POSTGRES_CONF_DIR=${SPHARMMT_PG_DIR}/conf
POSTGRES_INIT_DIR=${SPHARMMT_PG_DIR}/init
BACKUP_DIR=${SPHARMMT_BACKUP_DIR}

# ── PostgreSQL (container interno, nunca exposto) ────────────────────
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_SUPERUSER=postgres
POSTGRES_APP_USER=spharmmt_app
POSTGRES_LEGACY_DB=spharmmt_legacy
POSTGRES_CONTROL_DB=spharmmt_control

# TLS entre a aplicação e o Postgres. Na mesma rede Docker privada, o
# tráfego não sai do host: disable é adequado e evita gerir certificados.
# Passa a require se o Postgres passar a viver noutra máquina.
DATABASE_SSLMODE=disable
TENANT_DB_SSLMODE=disable
TENANT_DB_HOST=postgres
TENANT_DB_PORT=5432

# ── Scheduler local (substitui o Vercel Cron) ────────────────────────
# DESLIGADO por defeito. Activa só depois de os dados estarem migrados e
# validados — um cron a correr contra uma base meio-migrada é pior do que
# cron nenhum.
SCHEDULER_ENABLED=0

# ── Feature flags ────────────────────────────────────────────────────
ENABLE_AGENT_BOOTSTRAP=0
TENANT_FALLBACK_ENABLED=1

# ── Recursos ─────────────────────────────────────────────────────────
# 8 GB de RAM no total: ~2 GB Postgres, ~3 GB app, resto para SO e picos.
NODE_OPTIONS=--max-old-space-size=2048
EOF
  ok "configuração da stack em ${SPHARMMT_ENV_FILE}"
  # if explícito e não `[ ... ] && cmd`: como última instrução da função,
  # um teste falso devolveria 1 e o `set -e` abortaria o script.
  if [ "$cookie_secure" = "0" ]; then
    warn "SESSION_COOKIE_SECURE=0 (sem HTTPS). Passa a 1 assim que houver domínio e certificado."
  fi
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
# 5. Scripts operacionais
# ═════════════════════════════════════════════════════════════════════════
install_scripts() {
  step "5. Scripts operacionais"
  local dst="${SPHARMMT_ROOT}/scripts"
  ensure_dir "$dst" 2750 "$OWNER"
  ensure_dir "${dst}/lib" 2750 "$OWNER"

  local scripts=(
    bootstrap-vps.sh install-docker.sh install-platform.sh prepare-data-disk.sh
    verify-platform.sh update-platform.sh backup-platform.sh restore-platform.sh
    healthcheck.sh
  )
  for s in "${scripts[@]}"; do
    if [ -f "${SCRIPT_DIR}/${s}" ]; then
      run install -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "${SCRIPT_DIR}/${s}" "${dst}/${s}"
    else
      warn "script ausente na origem: ${s}"
    fi
  done
  run install -m 0640 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "${SCRIPT_DIR}/lib/common.sh" "${dst}/lib/common.sh"

  # O healthcheck vive também em monitoring/checks (é o caminho que a unit
  # systemd usa).
  run install -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" \
    "${SCRIPT_DIR}/healthcheck.sh" "${SPHARMMT_ROOT}/monitoring/checks/healthcheck.sh"

  ok "scripts instalados em ${dst}"
}

# ═════════════════════════════════════════════════════════════════════════
# 6. Timer de backup
# ═════════════════════════════════════════════════════════════════════════
install_backup_timer() {
  step "6. Agendamento de backups"
  local logf="${SPHARMMT_ROOT}/logs/backups/backup.log"
  if [ "$DRY_RUN" != "1" ]; then
    touch "$logf"; chown "$OWNER" "$logf"; chmod 0640 "$logf"
  fi

  write_file /etc/systemd/system/spharmmt-backup.service 0644 root:root <<EOF
[Unit]
Description=SPharm.MT backup do PostgreSQL
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
# root: precisa de ler ${SPHARMMT_SECRETS_FILE} (0600 root:root).
User=root
ExecStart=${SPHARMMT_ROOT}/scripts/backup-platform.sh --yes --quiet
StandardOutput=append:${logf}
StandardError=append:${logf}
TimeoutStartSec=3600
Nice=10
IOSchedulingClass=idle
EOF

  write_file /etc/systemd/system/spharmmt-backup.timer 0644 root:root <<'EOF'
[Unit]
Description=Backup diário do SPharm.MT (03:20 UTC)

[Timer]
OnCalendar=*-*-* 03:20:00
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
EOF

  run systemctl daemon-reload
  run systemctl enable --now spharmmt-backup.timer >/dev/null 2>&1 || true
  ok "backup diário agendado (03:20 UTC)"
  info "até o PostgreSQL existir, o backup corre e reporta 'sem stack' — sem falhar"
}

# ═════════════════════════════════════════════════════════════════════════
# 7. Stack (se já existir)
# ═════════════════════════════════════════════════════════════════════════
bring_up_stack() {
  step "7. Stack Docker"
  if [ "$SKIP_COMPOSE" = "1" ]; then info "ignorado (--skip-compose)"; return 0; fi

  if [ ! -f "$SPHARMMT_COMPOSE_FILE" ]; then
    info "ainda não existe ${SPHARMMT_COMPOSE_FILE}"
    info "esta é a fase seguinte: PostgreSQL + aplicação + reverse proxy."
    info "O servidor fica pronto a recebê-la — nada mais é preciso aqui."
    return 0
  fi

  info "compose encontrado — a validar..."
  if ! dc config >/dev/null 2>&1; then
    dc config >/dev/null || true
    die "docker compose config inválido — a stack NÃO foi alterada"
  fi
  ok "docker compose config válido"

  run docker network inspect "$SPHARMMT_NETWORK" >/dev/null 2>&1 || \
    run docker network create "$SPHARMMT_NETWORK" >/dev/null

  info "a subir a stack..."
  run dc up -d --remove-orphans
  ok "stack no ar"
}

# ═════════════════════════════════════════════════════════════════════════
postflight() {
  step "Validação"
  check "estrutura ${SPHARMMT_ROOT}"          test -d "$SPHARMMT_ROOT"
  check "configuração central"                test -f "$SPHARMMT_CONF_FILE"
  check "data root ${SPHARMMT_DATA_ROOT}"     test -d "$SPHARMMT_DATA_ROOT"
  check "postgres em ${SPHARMMT_PG_DIR}/data" test -d "${SPHARMMT_PG_DIR}/data"
  check "backups em ${SPHARMMT_BACKUP_DIR}"   test -d "${SPHARMMT_BACKUP_DIR}/postgres"
  check "data root gravado na conf"           grep -qE '^SPHARMMT_DATA_ROOT=' "$SPHARMMT_CONF_FILE"
  if data_disk_in_use; then
    check "volume de dados montado"           is_mountpoint "$SPHARMMT_DATA_ROOT"
    check "montagem persistente (fstab)"      bash -c "grep -qE '^[^#]*[[:space:]]${SPHARMMT_DATA_ROOT}[[:space:]]' /etc/fstab"
  else
    check_skip "volume de dados dedicado" "dados no mesmo volume do sistema"
  fi
  check "ficheiro de segredos"                test -f "$SPHARMMT_SECRETS_FILE"
  check "segredos 0600 root:root"             bash -c "[ \"\$(stat -c '%a %U:%G' ${SPHARMMT_SECRETS_FILE})\" = '600 root:root' ]"
  check "env da stack"                        test -f "$SPHARMMT_ENV_FILE"
  check "env não legível por outros"          bash -c "[ \$(stat -c '%a' ${SPHARMMT_ENV_FILE}) -le 640 ]"
  for k in POSTGRES_SUPERUSER_PASSWORD POSTGRES_APP_PASSWORD AUTH_SECRET \
           TENANT_ENCRYPTION_SECRET EMAIL_CONFIG_SECRET CRON_SECRET ADMIN_API_TOKEN; do
    check "segredo ${k} presente"             grep -qE "^${k}=.+" "$SPHARMMT_SECRETS_FILE"
  done
  check "TENANT_ENCRYPTION_SECRET com 64 hex" grep -qE '^TENANT_ENCRYPTION_SECRET=[0-9a-f]{64}$' "$SPHARMMT_SECRETS_FILE"
  check "scripts operacionais instalados"     test -x "${SPHARMMT_ROOT}/scripts/verify-platform.sh"
  check "healthcheck instalado"               test -x "${SPHARMMT_ROOT}/monitoring/checks/healthcheck.sh"
  check "timer de healthcheck activo"         svc_active spharmmt-healthcheck.timer
  check "timer de backup activo"              svc_active spharmmt-backup.timer
  check "rede docker ${SPHARMMT_NETWORK}"     docker network inspect "$SPHARMMT_NETWORK"

  if [ -f "$SPHARMMT_COMPOSE_FILE" ]; then
    check "docker compose config válido"      dc config
  else
    check_skip "stack docker" "compose ainda não existe (fase seguinte)"
  fi

  report "Plataforma — validação"
}

main() {
  log_init
  acquire_lock platform
  banner "install-platform"
  preflight
  ensure_structure
  write_conf
  gen_secrets
  write_env
  install_scripts
  install_backup_timer
  bring_up_stack
  local rc=0
  postflight || rc=$?

  printf '\n'
  if [ "$rc" -eq 0 ]; then
    ok "plataforma instalada."
    info "Segredos:        sudo cat ${SPHARMMT_SECRETS_FILE}"
    info "Configuração:    ${SPHARMMT_ENV_FILE}  ·  ${SPHARMMT_CONF_FILE}"
    info "Validar:         sudo ${SPHARMMT_ROOT}/scripts/verify-platform.sh"
    info "Backup manual:   sudo ${SPHARMMT_ROOT}/scripts/backup-platform.sh"
    printf '\n'
    warn "FAZ UMA CÓPIA OFFLINE DE ${SPHARMMT_SECRETS_FILE} AGORA."
    warn "Sem TENANT_ENCRYPTION_SECRET, nenhuma base de tenant volta a ser acessível."
  fi
  finish "$rc"
}

main "$@"
