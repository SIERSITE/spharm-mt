#!/usr/bin/env bash
# deploy/scripts/bootstrap-vps.sh
#
# Transforma uma VPS Ubuntu 24.04 limpa num servidor de produção endurecido,
# pronto a receber a stack Docker do SPharm.MT. Uma execução, zero perguntas
# (com --yes), totalmente idempotente.
#
# O que faz, por ordem — a ordem importa e não deve ser alterada:
#    1. actualização completa do sistema
#    2. timezone, locale, hostname
#    3. pacotes base, swap, sysctl
#    4. unattended-upgrades (só security, sem reboot automático)
#    5. utilizador deploy + sudo
#    6. firewall UFW (default-deny)          ← ANTES do SSH
#    7. SSH por chave                        ← ANTES de desactivar o root
#    8. fail2ban
#    9. desactivar login root                ← só com --disable-root-login
#   10. Docker (delega em install-docker.sh)
#   11. discos — DETECÇÃO APENAS, nunca particiona nem formata
#   12. estrutura /opt/spharmmt (+ /data, se houver disco dedicado)
#   13. permissões, owners, umask
#   14. rotação de logs (journald + logrotate + docker)
#   15. monitorização (healthcheck + systemd timer)
#   16. directórios de backup
#   17. validação e relatório final
#
# SEGURANÇA CONTRA LOCKOUT — regras que este script nunca quebra:
#   · a regra de SSH entra na firewall ANTES de a firewall ser activada;
#   · a autenticação por password só é desligada depois de existir pelo
#     menos uma chave pública válida em authorized_keys;
#   · o login de root só é desactivado com a flag explícita
#     --disable-root-login E depois de o utilizador deploy ter chave + sudo;
#   · qualquer alteração ao sshd é validada com `sshd -t` e revertida
#     automaticamente se inválida;
#   · usa-se `reload` e não `restart`, para nunca derrubar a sessão actual.
#
# Uso típico (primeira execução, a partir da sessão root do provedor):
#   sudo ./bootstrap-vps.sh --ssh-key "ssh-ed25519 AAAA... eu@portatil" --yes
#
# Saída: 0 ok · 2 pré-condição · 3 validação final falhou · 4 uso · 5 lock

set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

# ─── Parâmetros ──────────────────────────────────────────────────────────
DEPLOY_USER="$SPHARMMT_USER"
DEPLOY_GROUP="$SPHARMMT_GROUP"
SSH_KEY=""
SSH_KEY_FILE=""
SSH_PORT=22
TIMEZONE="UTC"
LOCALE="en_US.UTF-8"
NEW_HOSTNAME=""
SWAP_SIZE="4G"
ADMIN_IP=""
SKIP_DOCKER=0
SKIP_SSH_HARDENING=0
DISABLE_ROOT_LOGIN=0
SKIP_UPGRADE=0

usage() {
  cat <<EOF
Uso: sudo $0 [opções]

  Utilizador e acesso
    --deploy-user <nome>     Utilizador de serviço (default: ${DEPLOY_USER})
    --ssh-key "<chave>"      Chave pública a instalar (ssh-ed25519 ... / ssh-rsa ...)
    --ssh-key-file <path>    Ficheiro com uma ou mais chaves públicas
    --ssh-port <porta>       Porta do SSH (default: 22)
    --admin-ip <ip|cidr>     Restringe o SSH a esta origem e isenta-a do fail2ban
    --disable-root-login     Desactiva o login de root por SSH (ver avisos abaixo)
    --skip-ssh-hardening     Não toca na configuração do sshd

  Sistema
    --timezone <tz>          Default: ${TIMEZONE}
    --locale <locale>        Default: ${LOCALE}
    --hostname <nome>        Muda o hostname (default: mantém o actual)
    --swap-size <tam>        Ex.: 4G, 2G, 0 para não criar swap (default: ${SWAP_SIZE})
    --skip-upgrade           Não corre apt upgrade (útil em re-execuções)
    --skip-docker            Não instala Docker

$(common_flags_help)

Se não for passada nenhuma chave SSH, o script reutiliza as chaves já
presentes em /root/.ssh/authorized_keys (o caso normal numa VPS acabada de
criar). Sem chave nenhuma disponível, o endurecimento do SSH é IGNORADO com
aviso — o script nunca te deixa sem forma de entrar.

--disable-root-login só é aplicado se o utilizador deploy tiver chave válida
e sudo funcional. Garante que tens consola de emergência no painel do
provedor antes de o usar.
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --deploy-user) DEPLOY_USER=${2:?}; shift 2 ;;
    --ssh-key) SSH_KEY=${2:?}; shift 2 ;;
    --ssh-key-file) SSH_KEY_FILE=${2:?}; shift 2 ;;
    --ssh-port) SSH_PORT=${2:?}; shift 2 ;;
    --admin-ip) ADMIN_IP=${2:?}; shift 2 ;;
    --timezone) TIMEZONE=${2:?}; shift 2 ;;
    --locale) LOCALE=${2:?}; shift 2 ;;
    --hostname) NEW_HOSTNAME=${2:?}; shift 2 ;;
    --swap-size) SWAP_SIZE=${2:?}; shift 2 ;;
    --disable-root-login) DISABLE_ROOT_LOGIN=1; shift ;;
    --skip-ssh-hardening) SKIP_SSH_HARDENING=1; shift ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --skip-upgrade) SKIP_UPGRADE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die_usage "opção desconhecida: $1" ;;
  esac
done

REBOOT_REQUIRED=0
SSH_HARDENED=0
SSH_DROPIN=/etc/ssh/sshd_config.d/99-spharmmt-hardening.conf

# Home e grupo primário reais do utilizador. NÃO assumir /home/<user> nem
# grupo homónimo: um utilizador `deploy` pré-existente pode ter sido criado
# com outro home ou outro grupo primário, e instalar a chave no sítio errado
# — logo antes de desligar a autenticação por password — seria lockout.
# São resolvidos em step_user() a partir de /etc/passwd.
DEPLOY_HOME="/home/${DEPLOY_USER}"
DEPLOY_PGROUP="${DEPLOY_USER}"

# Discos livres detectados em step_disks(), para o relatório final.
DISK_HINT=""

# ═════════════════════════════════════════════════════════════════════════
# 0. Pré-condições
# ═════════════════════════════════════════════════════════════════════════
preflight() {
  step "0. Pré-condições"
  require_root
  require_ubuntu 24.04
  require_cmd apt-get systemctl hostnamectl timedatectl awk sed grep df install openssl
  [ -d /run/systemd/system ] || die_precond "systemd não está a correr"
  require_free_space / 5120

  case "$SSH_PORT" in
    ''|*[!0-9]*) die_usage "--ssh-port tem de ser numérico: ${SSH_PORT}" ;;
  esac
  [ "$SSH_PORT" -ge 1 ] && [ "$SSH_PORT" -le 65535 ] || die_usage "--ssh-port fora do intervalo: ${SSH_PORT}"

  if [ -n "$SSH_KEY_FILE" ]; then require_file "$SSH_KEY_FILE"; fi

  # Aviso explícito quando não há forma de recuperar acesso.
  if [ ! -s /root/.ssh/authorized_keys ] && [ -z "$SSH_KEY" ] && [ -z "$SSH_KEY_FILE" ]; then
    warn "não há chave SSH disponível (nem --ssh-key, nem --ssh-key-file, nem /root/.ssh/authorized_keys)"
    warn "o endurecimento do SSH será IGNORADO para não te trancar fora"
  fi

  ok "pré-condições satisfeitas (Ubuntu 24.04, root, systemd, espaço)"
}

# ═════════════════════════════════════════════════════════════════════════
# 1. Actualização do sistema
# ═════════════════════════════════════════════════════════════════════════
step_update() {
  step "1. Actualização do sistema"
  if [ "$SKIP_UPGRADE" = "1" ]; then info "ignorado (--skip-upgrade)"; return 0; fi
  apt_update_once
  info "a aplicar upgrades (pode demorar vários minutos)..."
  run_quiet env DEBIAN_FRONTEND=noninteractive apt-get -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
  run_quiet env DEBIAN_FRONTEND=noninteractive apt-get -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade
  run_quiet env DEBIAN_FRONTEND=noninteractive apt-get -y autoremove --purge
  run_quiet apt-get -y autoclean
  ok "sistema actualizado"
  if [ -f /var/run/reboot-required ]; then
    REBOOT_REQUIRED=1
    warn "reboot pendente: $(tr '\n' ' ' < /var/run/reboot-required.pkgs 2>/dev/null || echo 'kernel/libc')"
  fi
}

# ═════════════════════════════════════════════════════════════════════════
# 2. Timezone, locale, hostname
# ═════════════════════════════════════════════════════════════════════════
step_identity() {
  step "2. Timezone, locale, hostname"

  # Timezone — UTC por defeito: evita saltos de DST em cron e backups.
  local cur_tz; cur_tz=$(timedatectl show -p Timezone --value)
  if [ "$cur_tz" = "$TIMEZONE" ]; then
    ok "timezone já é ${TIMEZONE}"
  else
    [ -f "/usr/share/zoneinfo/${TIMEZONE}" ] || die "timezone inválida: ${TIMEZONE}"
    run timedatectl set-timezone "$TIMEZONE"
    ok "timezone ${cur_tz} → ${TIMEZONE}"
  fi
  run timedatectl set-ntp true
  svc_active systemd-timesyncd || run systemctl restart systemd-timesyncd || true

  # Locale.
  apt_ensure locales
  local lc_short=${LOCALE%%.*}
  if locale -a 2>/dev/null | grep -qiE "^${lc_short}\.?(utf8|UTF-8)?$"; then
    ok "locale ${LOCALE} já gerado"
  else
    info "a gerar locale ${LOCALE}..."
    run locale-gen "$LOCALE" pt_PT.UTF-8
    ok "locales gerados (${LOCALE} + pt_PT.UTF-8)"
  fi
  run update-locale LANG="$LOCALE"

  # Hostname — só muda se pedido explicitamente.
  local cur_host; cur_host=$(hostnamectl --static)
  if [ -n "$NEW_HOSTNAME" ] && [ "$NEW_HOSTNAME" != "$cur_host" ]; then
    run hostnamectl set-hostname "$NEW_HOSTNAME"
    ok "hostname ${cur_host} → ${NEW_HOSTNAME}"
    cur_host="$NEW_HOSTNAME"
  else
    ok "hostname mantido: ${cur_host}"
  fi

  # /etc/hosts — sem esta entrada, `sudo` e o envio de mail sofrem
  # timeouts de DNS reverso.
  if ! grep -qE "^127\.0\.1\.1[[:space:]]+.*\b${cur_host}\b" /etc/hosts; then
    if grep -qE "^127\.0\.1\.1" /etc/hosts; then
      backup_file /etc/hosts
      run sed -i -E "s|^127\.0\.1\.1.*|127.0.1.1\t${cur_host}|" /etc/hosts
    else
      ensure_line /etc/hosts "$(printf '127.0.1.1\t%s' "$cur_host")"
    fi
    ok "/etc/hosts actualizado para ${cur_host}"
  else
    ok "/etc/hosts já resolve ${cur_host}"
  fi

  # Impede o cloud-init de reescrever o hostname no reboot.
  if [ -d /etc/cloud/cloud.cfg.d ]; then
    write_file /etc/cloud/cloud.cfg.d/99-spharmmt-hostname.cfg 0644 root:root <<'EOF'
# Gerido por bootstrap-vps.sh — impede o cloud-init de repor o hostname do provedor.
preserve_hostname: true
EOF
  fi
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Pacotes base, swap, sysctl
# ═════════════════════════════════════════════════════════════════════════
step_base() {
  step "3. Pacotes base, swap e kernel"

  # rsyslog é deliberado: a 24.04 pode vir sem ele, e sem /var/log/auth.log
  # a configuração default do fail2ban parte.
  apt_ensure \
    curl wget ca-certificates gnupg lsb-release apt-transport-https \
    git vim nano jq unzip rsync \
    htop iotop sysstat ncdu tree \
    net-tools dnsutils \
    rsyslog logrotate \
    openssl acl

  # sysstat — histórico de CPU/IO para diagnóstico posterior.
  if [ -f /etc/default/sysstat ]; then
    ensure_kv /etc/default/sysstat ENABLED '"true"'
    svc_enabled sysstat || run systemctl enable --now sysstat || true
  fi

  # Swap: 8GB de RAM sem swap = OOM killer em vez de degradação.
  if [ "$SWAP_SIZE" = "0" ] || [ "$SWAP_SIZE" = "none" ]; then
    info "swap ignorada (--swap-size 0)"
  elif [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
    ok "swap já activa: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
  else
    info "a criar swapfile de ${SWAP_SIZE}..."
    if [ "$DRY_RUN" != "1" ]; then
      # fallocate falha em alguns filesystems (btrfs); dd é o fallback.
      if ! fallocate -l "$SWAP_SIZE" /swapfile 2>/dev/null; then
        local mb; mb=$(numfmt --from=iec "$SWAP_SIZE" | awk '{print int($1/1048576)}')
        dd if=/dev/zero of=/swapfile bs=1M count="$mb" status=none
      fi
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
      swapon /swapfile
      backup_file /etc/fstab
      grep -q '^/swapfile' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
      # Um /etc/fstab inválido impede o boot — validar sempre.
      if ! findmnt --verify --quiet; then
        err "/etc/fstab ficou inválido — a reverter a entrada de swap"
        sed -i '/^\/swapfile/d' /etc/fstab
        die "fstab inválido após adicionar swap (nada partido, entrada removida)"
      fi
    fi
    ok "swapfile ${SWAP_SIZE} activo e persistente"
  fi

  write_file /etc/sysctl.d/60-spharmmt.conf 0644 root:root <<'EOF'
# Gerido por bootstrap-vps.sh
# Swap só sob pressão real de memória (o disco é NVMe, mas swap é último recurso).
vm.swappiness = 10
vm.vfs_cache_pressure = 50
# Postgres e Node com muitas conexões: mais ficheiros abertos e backlog maior.
fs.file-max = 2097152
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
# Endurecimento de rede básico.
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.tcp_syncookies = 1
kernel.kptr_restrict = 2
EOF
  run sysctl --system >/dev/null 2>&1 || true
  ok "parâmetros de kernel aplicados"
}

# ═════════════════════════════════════════════════════════════════════════
# 4. unattended-upgrades
# ═════════════════════════════════════════════════════════════════════════
step_unattended() {
  step "4. Actualizações automáticas de segurança"
  apt_ensure unattended-upgrades apt-listchanges

  write_file /etc/apt/apt.conf.d/52spharmmt-unattended 0644 root:root <<'EOF'
// Gerido por bootstrap-vps.sh — política de actualização automática.
//
// Só security: minimiza alterações inesperadas num servidor de produção.
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

// O Docker NUNCA actualiza sozinho: reiniciaria o daemon e todos os
// containers a meio do dia. Upgrade de Docker é sempre planeado.
Unattended-Upgrade::Package-Blacklist {
    "docker-ce";
    "docker-ce-cli";
    "containerd.io";
    "docker-buildx-plugin";
    "docker-compose-plugin";
};

Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
// Sem reboot automático: derrubaria a aplicação sem aviso. O healthcheck
// sinaliza reboots pendentes; a janela é decidida pelo operador.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::SyslogEnable "true";
Unattended-Upgrade::MinimalSteps "true";
EOF

  write_file /etc/apt/apt.conf.d/20auto-upgrades 0644 root:root <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

  run systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
  ok "unattended-upgrades activo (só security, sem reboot automático)"
}

# ═════════════════════════════════════════════════════════════════════════
# 5. Utilizador deploy
# ═════════════════════════════════════════════════════════════════════════
step_user() {
  step "5. Utilizador ${DEPLOY_USER}"

  getent group "$DEPLOY_GROUP" >/dev/null || { run groupadd "$DEPLOY_GROUP"; ok "grupo ${DEPLOY_GROUP} criado"; }

  if id "$DEPLOY_USER" >/dev/null 2>&1; then
    ok "utilizador ${DEPLOY_USER} já existe — será reutilizado, não recriado"
  else
    run adduser --disabled-password --gecos "SPharm.MT deploy" "$DEPLOY_USER"
    ok "utilizador ${DEPLOY_USER} criado (sem password — acesso só por chave)"
  fi

  # Resolve o home e o grupo primário REAIS (podem não ser os convencionais
  # se o utilizador já existia). Tudo o que se segue usa estes valores.
  if id "$DEPLOY_USER" >/dev/null 2>&1; then
    local resolved_home resolved_group
    resolved_home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
    resolved_group=$(id -gn "$DEPLOY_USER")
    [ -n "$resolved_home" ] && DEPLOY_HOME="$resolved_home"
    [ -n "$resolved_group" ] && DEPLOY_PGROUP="$resolved_group"
    ok "home=${DEPLOY_HOME} grupo primário=${DEPLOY_PGROUP}"
  fi

  for g in sudo "$DEPLOY_GROUP"; do
    if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx "$g"; then
      dbg "${DEPLOY_USER} já em ${g}"
    else
      run usermod -aG "$g" "$DEPLOY_USER"
      ok "${DEPLOY_USER} adicionado ao grupo ${g}"
    fi
  done

  # sudo com password é o default seguro. A conta é criada com
  # --disabled-password, portanto sem password definida o sudo não passa —
  # por isso o acesso é por chave e o sudo fica NOPASSWD apenas se o
  # operador definir SPHARMMT_SUDO_NOPASSWD=1 conscientemente.
  local sudoers=/etc/sudoers.d/90-spharmmt-deploy
  if [ "${SPHARMMT_SUDO_NOPASSWD:-0}" = "1" ]; then
    write_file "$sudoers" 0440 root:root <<EOF
# Gerido por bootstrap-vps.sh (SPHARMMT_SUDO_NOPASSWD=1)
# ATENÇÃO: comprometer a chave SSH de ${DEPLOY_USER} passa a dar root imediato.
${DEPLOY_USER} ALL=(ALL:ALL) NOPASSWD:ALL
EOF
    warn "sudo NOPASSWD activo para ${DEPLOY_USER} — chave SSH comprometida = root imediato"
  else
    write_file "$sudoers" 0440 root:root <<EOF
# Gerido por bootstrap-vps.sh
${DEPLOY_USER} ALL=(ALL:ALL) ALL
EOF
  fi

  # Um ficheiro inválido em /etc/sudoers.d/ parte o sudo para toda a gente.
  if [ "$DRY_RUN" != "1" ]; then
    if ! visudo -c >/dev/null 2>&1; then
      err "sudoers ficou inválido — a remover o ficheiro que acabámos de escrever"
      rm -f "$sudoers"
      die "configuração sudo rejeitada (revertida; sudo continua funcional)"
    fi
    ok "sudoers validado (visudo -c)"
  fi

  ensure_dir "$DEPLOY_HOME" 0750 "${DEPLOY_USER}:${DEPLOY_PGROUP}"
}

# ═════════════════════════════════════════════════════════════════════════
# 6. Firewall — ANTES do SSH
# ═════════════════════════════════════════════════════════════════════════
step_firewall() {
  step "6. Firewall (UFW)"
  apt_ensure ufw

  run ufw --force default deny incoming >/dev/null
  run ufw --force default allow outgoing >/dev/null
  run ufw --force default deny routed >/dev/null

  # A regra de SSH entra SEMPRE antes do enable.
  if [ -n "$ADMIN_IP" ]; then
    run ufw allow from "$ADMIN_IP" to any port "$SSH_PORT" proto tcp comment 'SSH admin' >/dev/null
    ok "SSH ${SSH_PORT}/tcp permitido apenas de ${ADMIN_IP}"
    warn "se o teu IP mudar, perdes o acesso — usa a consola do provedor para corrigir"
  else
    run ufw limit "${SSH_PORT}/tcp" comment 'SSH rate-limited' >/dev/null
    ok "SSH ${SSH_PORT}/tcp permitido com rate-limit (6 ligações / 30s por IP)"
  fi

  if ufw status 2>/dev/null | grep -q '^Status: active'; then
    ok "UFW já activa"
  else
    info "a activar a UFW..."
    run ufw --force enable >/dev/null
    ok "UFW activa (default deny incoming)"
  fi
  run systemctl enable ufw >/dev/null 2>&1 || true

  info "80/443 ficam FECHADOS nesta fase — abrem quando o reverse proxy existir:"
  info "  ufw allow 80/tcp comment 'HTTP' && ufw allow 443/tcp comment 'HTTPS'"
}

# ═════════════════════════════════════════════════════════════════════════
# 7. SSH por chave
# ═════════════════════════════════════════════════════════════════════════

# Reúne as chaves a instalar: --ssh-key, --ssh-key-file e, em último
# recurso, as que já estão em /root/.ssh/authorized_keys.
_collect_keys() {
  local out=$1
  : > "$out"
  [ -n "$SSH_KEY" ] && printf '%s\n' "$SSH_KEY" >> "$out"
  [ -n "$SSH_KEY_FILE" ] && cat "$SSH_KEY_FILE" >> "$out"
  if [ ! -s "$out" ] && [ -s /root/.ssh/authorized_keys ]; then
    grep -vE '^\s*(#|$)' /root/.ssh/authorized_keys >> "$out" || true
    [ -s "$out" ] && info "sem --ssh-key: reutilizadas as chaves de /root/.ssh/authorized_keys"
  fi
}

# Conta as chaves públicas sintacticamente válidas de um ficheiro.
_valid_key_count() {
  local file=$1 n=0 line
  [ -s "$file" ] || { printf '0'; return 0; }
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    if printf '%s\n' "$line" | ssh-keygen -l -f /dev/stdin >/dev/null 2>&1; then n=$((n+1)); fi
  done < "$file"
  printf '%s' "$n"
}

step_ssh() {
  step "7. SSH por chave"

  local tmpkeys; tmpkeys=$(mktemp)
  _collect_keys "$tmpkeys"
  local nkeys; nkeys=$(_valid_key_count "$tmpkeys")

  if [ "$nkeys" -gt 0 ]; then
    local ssh_dir="${DEPLOY_HOME}/.ssh"
    local auth="${ssh_dir}/authorized_keys"
    ensure_dir "$ssh_dir" 0700 "${DEPLOY_USER}:${DEPLOY_PGROUP}"
    if [ "$DRY_RUN" != "1" ]; then
      # Merge idempotente: acrescenta só as chaves que ainda não existem.
      touch "$auth"
      local added=0 line
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        case "$line" in \#*) continue ;; esac
        if ! grep -qxF "$line" "$auth"; then printf '%s\n' "$line" >> "$auth"; added=$((added+1)); fi
      done < "$tmpkeys"
      chown "${DEPLOY_USER}:${DEPLOY_PGROUP}" "$auth"
      chmod 600 "$auth"
      if [ "$added" -gt 0 ]; then ok "${added} chave(s) instalada(s) em ${auth}"; else ok "chaves já presentes em ${auth}"; fi
    fi
  fi
  rm -f "$tmpkeys"

  if [ "$SKIP_SSH_HARDENING" = "1" ]; then
    warn "endurecimento do sshd ignorado (--skip-ssh-hardening)"
    return 0
  fi

  # Contagem final sobre o ficheiro real — é esta que decide.
  local installed=0
  [ -f "${DEPLOY_HOME}/.ssh/authorized_keys" ] && \
    installed=$(_valid_key_count "${DEPLOY_HOME}/.ssh/authorized_keys")
  local root_keys=0
  [ -f /root/.ssh/authorized_keys ] && root_keys=$(_valid_key_count /root/.ssh/authorized_keys)

  if [ "$installed" -eq 0 ] && [ "$root_keys" -eq 0 ]; then
    warn "NENHUMA chave pública válida encontrada — autenticação por password NÃO será desligada"
    warn "instala uma chave e volta a correr:  sudo $0 --ssh-key \"ssh-ed25519 AAAA...\""
    return 0
  fi

  # PermitRootLogin: por defeito prohibit-password (root ainda entra por
  # chave — rede de segurança). Só passa a "no" com a flag explícita e se
  # o deploy tiver mesmo chave.
  local permit_root="prohibit-password"
  local allow_users="${DEPLOY_USER} root"
  if [ "$DISABLE_ROOT_LOGIN" = "1" ]; then
    if [ "$installed" -gt 0 ]; then
      permit_root="no"
      allow_users="${DEPLOY_USER}"
    else
      warn "--disable-root-login ignorado: ${DEPLOY_USER} não tem chave válida instalada"
    fi
  fi

  write_file "$SSH_DROPIN" 0644 root:root <<EOF
# Gerido por bootstrap-vps.sh — SPharm.MT
# Em SSH a PRIMEIRA directiva vence; este drop-in é lido antes do
# sshd_config principal por causa do prefixo 99- e do Include no topo.
PermitRootLogin ${permit_root}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitEmptyPasswords no

AllowUsers ${allow_users}
MaxAuthTries 3
MaxSessions 5
LoginGraceTime 30

X11Forwarding no
AllowAgentForwarding no
# TcpForwarding fica ligado de propósito: é o que permite chegar ao
# Postgres por túnel (ssh -L 5432:127.0.0.1:5432) sem expor o porto.
AllowTcpForwarding yes
PermitTunnel no

ClientAliveInterval 300
ClientAliveCountMax 2
UsePAM yes
PrintMotd no
EOF

  # Porta não-standard: na 24.04 mudar `Port` não chega se o ssh.socket
  # estiver activo — quem escuta é o socket.
  if [ "$SSH_PORT" != "22" ]; then
    ensure_dir /etc/systemd/system/ssh.socket.d 0755 root:root
    write_file /etc/systemd/system/ssh.socket.d/port.conf 0644 root:root <<EOF
[Socket]
ListenStream=
ListenStream=${SSH_PORT}
EOF
    ensure_line "$SSH_DROPIN" "Port ${SSH_PORT}"
    run systemctl daemon-reload
    if svc_active ssh.socket; then run systemctl restart ssh.socket; fi
  fi

  # Validação obrigatória: config inválida = sshd não arranca.
  if [ "$DRY_RUN" != "1" ]; then
    if ! sshd -t 2>/dev/null; then
      err "configuração sshd inválida — a remover o drop-in"
      rm -f "$SSH_DROPIN"
      sshd -t || die "sshd continua inválido depois do rollback — inspecciona /etc/ssh/sshd_config manualmente"
      die "endurecimento do SSH revertido (a sessão actual não foi afectada)"
    fi
    ok "configuração sshd validada (sshd -t)"
    # reload, nunca restart: a sessão actual sobrevive mesmo se algo correr mal.
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || \
      systemctl restart ssh.socket 2>/dev/null || true
  fi

  SSH_HARDENED=1
  ok "SSH endurecido: password OFF, PermitRootLogin=${permit_root}, AllowUsers='${allow_users}'"
  warn "NÃO FECHES esta sessão. Abre outra e confirma:  ssh ${DEPLOY_USER}@<ip>"
}

# ═════════════════════════════════════════════════════════════════════════
# 8. fail2ban
# ═════════════════════════════════════════════════════════════════════════
step_fail2ban() {
  step "8. fail2ban"
  apt_ensure fail2ban

  local ignore="127.0.0.1/8 ::1"
  [ -n "$ADMIN_IP" ] && ignore="${ignore} ${ADMIN_IP}"

  write_file /etc/fail2ban/jail.local 0644 root:root <<EOF
# Gerido por bootstrap-vps.sh — SPharm.MT
[DEFAULT]
# backend=systemd lê do journal: não depende de /var/log/auth.log existir,
# que é precisamente o que parte a configuração default na Ubuntu 24.04.
backend  = systemd
bantime  = 1h
findtime = 10m
maxretry = 5
# banaction=ufw mantém os bans dentro da UFW em vez de criar cadeias
# iptables paralelas — um só sistema a gerir a mesma coisa.
banaction = ufw
ignoreip = ${ignore}

[sshd]
enabled  = true
port     = ${SSH_PORT}
maxretry = 3
bantime  = 2h

[recidive]
enabled  = true
logpath  = /var/log/fail2ban.log
bantime  = 1w
findtime = 1d
maxretry = 3
EOF

  run systemctl enable fail2ban >/dev/null 2>&1 || true
  if [ "$DRY_RUN" != "1" ]; then
    systemctl restart fail2ban || die "fail2ban não arrancou — verifica: journalctl -u fail2ban -n 50"
    sleep 2
    if fail2ban-client status >/dev/null 2>&1; then
      ok "fail2ban activo — jails: $(fail2ban-client status | awk -F: '/Jail list/ {print $2}' | xargs)"
    else
      warn "fail2ban arrancou mas não responde ainda; verifica com: fail2ban-client status"
    fi
  fi
  [ -n "$ADMIN_IP" ] && ok "${ADMIN_IP} isento de bans (ignoreip)"
}

# ═════════════════════════════════════════════════════════════════════════
# 9. Docker
# ═════════════════════════════════════════════════════════════════════════
step_docker() {
  step "9. Docker"
  if [ "$SKIP_DOCKER" = "1" ]; then info "ignorado (--skip-docker)"; return 0; fi
  local installer="${SCRIPT_DIR}/install-docker.sh"
  require_file "$installer"
  local args=(--user "$DEPLOY_USER")
  [ "$DRY_RUN" = "1" ] && args+=(--dry-run)
  [ "$VERBOSE" = "1" ] && args+=(--verbose)
  [ "$ASSUME_YES" = "1" ] && args+=(--yes)
  # Corre em subshell: o install-docker.sh tem os seus próprios traps e lock.
  if bash "$installer" "${args[@]}"; then
    ok "Docker instalado e validado"
  else
    die "install-docker.sh falhou (rc=$?) — ver o log respectivo em ${SPHARMMT_LOG_DIR}"
  fi
}

# ═════════════════════════════════════════════════════════════════════════
# 10-11. Estrutura, permissões e umask
# ═════════════════════════════════════════════════════════════════════════
# ═════════════════════════════════════════════════════════════════════════
# 10. Discos — DETECÇÃO APENAS. Nunca particiona, nunca formata, nunca monta.
# ═════════════════════════════════════════════════════════════════════════
step_disks() {
  step "11. Discos"

  local rootd free_disks=() name dev size fstype parts
  rootd=$(lsblk -rno PKNAME "$(findmnt -rno SOURCE / 2>/dev/null)" 2>/dev/null | head -1 || true)

  while IFS= read -r name; do
    [ -z "$name" ] && continue
    dev="/dev/${name}"
    size=$(numfmt --to=iec "$(lsblk -bdno SIZE "$dev" 2>/dev/null | head -1)" 2>/dev/null || echo '?')
    fstype=$(lsblk -rno FSTYPE "$dev" 2>/dev/null | tr -d '[:space:]')
    parts=$(lsblk -rno NAME "$dev" 2>/dev/null | tail -n +2 | wc -l)

    if [ "$name" = "$rootd" ]; then
      info "${dev} (${size}) — disco de sistema"
    elif [ "$parts" -eq 0 ] && [ -z "$fstype" ] && ! blkid -p "$dev" >/dev/null 2>&1; then
      free_disks+=("$dev")
      ok "${dev} (${size}) — LIVRE, sem filesystem"
    else
      info "${dev} (${size}) — ${parts} partição(ões)${fstype:+, ${fstype}}"
    fi
  done < <(lsblk -dno NAME --nodeps 2>/dev/null | grep -vE '^(loop|sr|ram|fd)' || true)

  if data_disk_in_use; then
    ok "disco de dados já em uso: ${SPHARMMT_DATA_ROOT} ($(df -Ph "$SPHARMMT_DATA_ROOT" | awk 'NR==2 {print $4}') livres)"
    return 0
  fi

  if [ "${#free_disks[@]}" -gt 0 ]; then
    printf '\n'
    warn "${#free_disks[@]} disco(s) livre(s) detectado(s): ${free_disks[*]}"
    warn "NÃO foram tocados — este script nunca particiona nem formata."
    info "Para dedicar um deles aos dados (PostgreSQL, backups), depois do bootstrap:"
    info "    sudo ${SCRIPT_DIR}/prepare-data-disk.sh                    # relatório"
    info "    sudo ${SCRIPT_DIR}/prepare-data-disk.sh --device ${free_disks[0]}   # prepara"
    info "Sem isso, os dados ficam em ${SPHARMMT_ROOT} — perfeitamente válido."
    DISK_HINT="${free_disks[*]}"
  else
    info "nenhum disco livre — dados em ${SPHARMMT_ROOT}"
  fi
}

step_structure() {
  step "12. Estrutura ${SPHARMMT_ROOT}"

  local owner="${DEPLOY_USER}:${DEPLOY_GROUP}"
  ensure_dir "$SPHARMMT_ROOT" 2750 "$owner"

  # Código, configuração e segredos — sempre em $SPHARMMT_ROOT.
  # setgid (2xxx) faz herdar o grupo spharmmt — evita ficheiros criados por
  # um membro do grupo ficarem inacessíveis aos outros.
  local dirs=(
    app
    logs logs/app logs/postgres logs/proxy logs/monitoring logs/backups
    docker docker/compose docker/env docker/build
    scripts scripts/lib
    monitoring monitoring/checks monitoring/state
    secrets
    proxy proxy/conf proxy/certs
  )
  for d in "${dirs[@]}"; do ensure_dir "${SPHARMMT_ROOT}/${d}" 2750 "$owner"; done

  # Dados — em $SPHARMMT_DATA_ROOT, que é /data quando existe disco dedicado
  # e $SPHARMMT_ROOT quando não existe. Sem disco dedicado os caminhos ficam
  # exactamente onde sempre estiveram.
  if data_disk_in_use; then
    info "disco de dados dedicado activo: ${SPHARMMT_DATA_ROOT}"
  fi
  local ddirs=(
    "${SPHARMMT_PG_DIR}" "${SPHARMMT_PG_DIR}/conf" "${SPHARMMT_PG_DIR}/init"
    "${SPHARMMT_BACKUP_DIR}" "${SPHARMMT_BACKUP_DIR}/postgres"
    "${SPHARMMT_BACKUP_DIR}/postgres/daily" "${SPHARMMT_BACKUP_DIR}/postgres/weekly"
    "${SPHARMMT_BACKUP_DIR}/postgres/monthly"
    "${SPHARMMT_BACKUP_DIR}/files" "${SPHARMMT_BACKUP_DIR}/tmp"
  )
  for d in "${ddirs[@]}"; do ensure_dir "$d" 2750 "$owner"; done

  step "13. Permissões, owners e umask"

  # secrets: só root. O deploy lê com sudo; os containers recebem só o que
  # o compose montar explicitamente.
  ensure_dir "${SPHARMMT_ROOT}/secrets" 0700 root:root
  # dados do Postgres: 0700 é exigido pelo próprio Postgres, que recusa
  # arrancar com permissões mais largas.
  ensure_dir "${SPHARMMT_PG_DIR}/data" 0700 "$owner"
  ensure_dir "${SPHARMMT_BACKUP_DIR}/postgres" 0700 "$owner"
  ensure_dir "${SPHARMMT_ROOT}/docker/env" 0750 "$owner"

  # umask 027: ficheiros 640, directórios 750 — nada legível por "others".
  if [ -f /etc/login.defs ]; then ensure_kv /etc/login.defs UMASK "027" " "; fi
  if [ -f "${DEPLOY_HOME}/.bashrc" ]; then
    ensure_line "${DEPLOY_HOME}/.bashrc" "umask 027"
  fi
  if [ -f /etc/pam.d/common-session ] && ! grep -q 'pam_umask' /etc/pam.d/common-session; then
    ensure_line /etc/pam.d/common-session "session optional pam_umask.so umask=0027"
  fi
  ok "umask 027 aplicado (login.defs + PAM + bashrc)"

  write_file "${SPHARMMT_ROOT}/README.md" 0640 "$owner" <<EOF
# ${SPHARMMT_ROOT}

Servidor de produção SPharm.MT. Estrutura criada por \`bootstrap-vps.sh\`.

    app/         código/artefactos da aplicação
    postgres/    data (volume), conf, init — PostgreSQL em container
    backups/     postgres/{daily,weekly,monthly}, files, tmp
    logs/        app, postgres, proxy, monitoring, backups
    docker/      compose/, env/, build/
    proxy/       conf/, certs/
    scripts/     operação: install/verify/update/backup/restore
    monitoring/  checks/, state/
    secrets/     0700 root:root — NUNCA em git, NUNCA em backup não cifrado

## Regras

1. Serviços internos publicam SEMPRE em 127.0.0.1 — o Docker escreve
   regras de iptables antes do UFW, e publicar em 0.0.0.0 expõe o porto
   à internet mesmo com a firewall a negar.
2. Nada em secrets/ ou docker/env/ entra em controlo de versões.
3. Backup local é staging, não é backup: só conta quando existe fora
   desta máquina.

## Comandos

    sudo ${SPHARMMT_ROOT}/scripts/verify-platform.sh
    sudo ${SPHARMMT_ROOT}/scripts/backup-platform.sh
    sudo ${SPHARMMT_ROOT}/scripts/update-platform.sh

Gerado em $(_ts) por bootstrap-vps.sh.
EOF
}

# ═════════════════════════════════════════════════════════════════════════
# 12. Logs
# ═════════════════════════════════════════════════════════════════════════
step_logs() {
  step "14. Rotação de logs"

  ensure_dir /etc/systemd/journald.conf.d 0755 root:root
  write_file /etc/systemd/journald.conf.d/99-spharmmt.conf 0644 root:root <<'EOF'
# Gerido por bootstrap-vps.sh
[Journal]
Storage=persistent
SystemMaxUse=2G
SystemKeepFree=5G
SystemMaxFileSize=100M
MaxRetentionSec=30day
MaxFileSec=1day
Compress=yes
ForwardToSyslog=yes
EOF
  run systemctl restart systemd-journald 2>/dev/null || true

  ensure_dir "$SPHARMMT_LOG_DIR" 0750 "root:${DEPLOY_GROUP}"

  write_file /etc/logrotate.d/spharmmt 0644 root:root <<EOF
# Gerido por bootstrap-vps.sh
# copytruncate: os processos que escrevem podem não reabrir o ficheiro
# após rotação. Perde-se, no limite, uma linha escrita durante a cópia —
# aceitável para logs operacionais, não para auditoria.
${SPHARMMT_ROOT}/logs/*/*.log {
    daily
    rotate 30
    size 50M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    dateext
    dateformat -%Y%m%d
    su ${DEPLOY_USER} ${DEPLOY_GROUP}
    create 0640 ${DEPLOY_USER} ${DEPLOY_GROUP}
}

${SPHARMMT_LOG_DIR}/*.log {
    weekly
    rotate 12
    missingok
    notifempty
    compress
    copytruncate
    su root ${DEPLOY_GROUP}
    create 0640 root ${DEPLOY_GROUP}
}
EOF

  if [ "$DRY_RUN" != "1" ]; then
    if logrotate -d /etc/logrotate.d/spharmmt >/dev/null 2>&1; then
      ok "logrotate validado"
    else
      warn "logrotate -d devolveu avisos; verifica: logrotate -d /etc/logrotate.d/spharmmt"
    fi
  fi
  ok "journald persistente (2G máx, 30 dias) + logrotate configurados"
  info "logs de containers já limitados pelo daemon.json (50MB x 5 por container)"
}

# ═════════════════════════════════════════════════════════════════════════
# 13. Monitorização
# ═════════════════════════════════════════════════════════════════════════
step_monitoring() {
  step "15. Monitorização"

  local owner="${DEPLOY_USER}:${DEPLOY_GROUP}"
  local hc_src="${SCRIPT_DIR}/healthcheck.sh"
  local hc_dst="${SPHARMMT_ROOT}/monitoring/checks/healthcheck.sh"
  require_file "$hc_src"

  # healthcheck.sh é deliberadamente auto-contido (não carrega common.sh):
  # corre de 15 em 15 minutos como unit systemd e não deve depender de
  # traps, locks nem de o resto da árvore estar instalada.
  if [ "$DRY_RUN" != "1" ]; then
    install -m 0750 -o "${DEPLOY_USER}" -g "${DEPLOY_GROUP}" "$hc_src" "$hc_dst"
  fi
  ok "healthcheck instalado em ${hc_dst}"

  local logf="${SPHARMMT_ROOT}/logs/monitoring/healthcheck.log"
  if [ "$DRY_RUN" != "1" ]; then
    touch "$logf"; chown "$owner" "$logf"; chmod 0640 "$logf"
  fi

  write_file /etc/systemd/system/spharmmt-healthcheck.service 0644 root:root <<EOF
[Unit]
Description=SPharm.MT healthcheck do servidor
After=docker.service
Documentation=file://${SPHARMMT_ROOT}/README.md

[Service]
Type=oneshot
User=${DEPLOY_USER}
Group=${DEPLOY_GROUP}
ExecStart=${hc_dst}
StandardOutput=append:${logf}
StandardError=append:${logf}
# rc=1 é WARN (não deve marcar a unit como falhada); rc=2 é CRIT.
SuccessExitStatus=0 1
TimeoutStartSec=120
EOF

  write_file /etc/systemd/system/spharmmt-healthcheck.timer 0644 root:root <<'EOF'
[Unit]
Description=Executa o healthcheck do SPharm.MT a cada 15 minutos

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
EOF

  run systemctl daemon-reload
  run systemctl enable --now spharmmt-healthcheck.timer >/dev/null 2>&1 || true
  ok "healthcheck agendado (15 em 15 min, com histórico em ${logf})"
  warn "os alertas ficam LOCAIS — se a VPS cair, ninguém é notificado."
  warn "fecha essa lacuna com um monitor externo (Healthchecks.io / Uptime Kuma noutro host)."
}

# ═════════════════════════════════════════════════════════════════════════
# 14. Backups (só preparação)
# ═════════════════════════════════════════════════════════════════════════
step_backups() {
  step "16. Directórios de backup"
  local owner="${DEPLOY_USER}:${DEPLOY_GROUP}"
  write_file "${SPHARMMT_BACKUP_DIR}/POLICY.md" 0640 "$owner" <<'EOF'
# Política de backups — SPharm.MT

## Retenção (implementada em scripts/backup-platform.sh)
- daily/    14 dias
- weekly/   8 semanas (domingo)
- monthly/  12 meses (dia 1)

## Regras
- Este directório é STAGING, não é backup. Um backup só conta quando
  existe fora desta máquina (regra 3-2-1). Destino externo por configurar.
- Todo o ficheiro tem .sha256 ao lado; o restore recusa sem checksum válido.
- Teste de restauro mensal obrigatório para uma base descartável.
  Backup nunca testado = backup inexistente.
- Abortar se o disco estiver acima de 85%.

## Estado
Directórios e scripts prontos. Envio para destino externo: POR FAZER.
EOF
  ok "estrutura de backups pronta (política em backups/POLICY.md)"
  info "backup-platform.sh corre e reporta 'sem stack' até o PostgreSQL existir"
}

# ═════════════════════════════════════════════════════════════════════════
# 15. Validação final
# ═════════════════════════════════════════════════════════════════════════
validate() {
  step "17. Validação"

  check "Ubuntu 24.04"                  bash -c "grep -q '24.04' /etc/os-release"
  check "sem pacotes por actualizar"    bash -c "[ \$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst') -eq 0 ]"
  check "timezone = ${TIMEZONE}"        bash -c "[ \"\$(timedatectl show -p Timezone --value)\" = '${TIMEZONE}' ]"
  check "relógio sincronizado (NTP)"    bash -c "timedatectl show -p NTPSynchronized --value | grep -q yes"
  check "locale ${LOCALE} disponível"   bash -c "locale -a | grep -qi '${LOCALE%%.*}'"
  check "hostname resolve"              bash -c "getent hosts \$(hostnamectl --static) >/dev/null"
  check "unattended-upgrades activo"    bash -c "systemctl is-active --quiet apt-daily-upgrade.timer"
  check "política de security aplicada" test -f /etc/apt/apt.conf.d/52spharmmt-unattended

  if [ "$SWAP_SIZE" = "0" ]; then
    check_skip "swap activa" "--swap-size 0"
  else
    check "swap activa"                 bash -c "[ \$(free -m | awk '/^Swap:/ {print \$2}') -gt 0 ]"
  fi
  check "vm.swappiness = 10"            bash -c "[ \$(sysctl -n vm.swappiness) -eq 10 ]"

  check "utilizador ${DEPLOY_USER}"     id "$DEPLOY_USER"
  check "${DEPLOY_USER} tem sudo"       bash -c "id -nG ${DEPLOY_USER} | grep -qw sudo"
  check "${DEPLOY_USER} no grupo ${DEPLOY_GROUP}" bash -c "id -nG ${DEPLOY_USER} | grep -qw ${DEPLOY_GROUP}"
  check "sudoers válido"                visudo -c

  check "UFW activa"                    bash -c "ufw status | grep -q '^Status: active'"
  check "UFW default deny incoming"     bash -c "ufw status verbose | grep -q 'deny (incoming)'"
  check "SSH permitido na UFW"          bash -c "ufw status | grep -qE '(^|\\s)${SSH_PORT}/tcp'"
  check "80 fechado nesta fase"         bash -c "! ufw status | grep -qE '^80/tcp .*ALLOW'"
  check "443 fechado nesta fase"        bash -c "! ufw status | grep -qE '^443/tcp .*ALLOW'"

  check "fail2ban activo"               svc_active fail2ban
  check "fail2ban arranca no boot"      svc_enabled fail2ban
  check "jail sshd activa"              bash -c "fail2ban-client status sshd >/dev/null"

  check "sshd com configuração válida"  sshd -t
  if [ "$SSH_HARDENED" = "1" ]; then
    check "PasswordAuthentication no"   bash -c "sshd -T 2>/dev/null | grep -qi '^passwordauthentication no'"
    check "PubkeyAuthentication yes"    bash -c "sshd -T 2>/dev/null | grep -qi '^pubkeyauthentication yes'"
    check "chave instalada em ${DEPLOY_USER}" bash -c "[ -s '${DEPLOY_HOME}/.ssh/authorized_keys' ]"
    check "authorized_keys com modo 600" bash -c "[ \$(stat -c '%a' '${DEPLOY_HOME}/.ssh/authorized_keys') = 600 ]"
    if [ "$DISABLE_ROOT_LOGIN" = "1" ]; then
      check "PermitRootLogin no"        bash -c "sshd -T 2>/dev/null | grep -qi '^permitrootlogin no'"
    else
      check_skip "PermitRootLogin no" "sem --disable-root-login (root ainda entra por chave)"
    fi
  else
    check_skip "endurecimento SSH" "sem chave disponível ou --skip-ssh-hardening"
  fi

  if [ "$SKIP_DOCKER" = "1" ]; then
    check_skip "Docker" "--skip-docker"
  else
    check "docker activo"               svc_active docker
    check "docker compose v2"           docker compose version
    check "rotação de logs do docker"   bash -c "grep -q 'max-size' /etc/docker/daemon.json"
    check "rede ${SPHARMMT_NETWORK}"    docker network inspect "$SPHARMMT_NETWORK"
  fi

  for d in app postgres backups logs docker scripts monitoring secrets; do
    check "${SPHARMMT_ROOT}/${d}"       test -d "${SPHARMMT_ROOT}/${d}"
  done
  check "owner ${DEPLOY_USER}:${DEPLOY_GROUP}" bash -c "[ \"\$(stat -c '%U:%G' ${SPHARMMT_ROOT})\" = '${DEPLOY_USER}:${DEPLOY_GROUP}' ]"
  check "dados em ${SPHARMMT_DATA_ROOT}" test -d "$SPHARMMT_DATA_ROOT"
  check "postgres em ${SPHARMMT_PG_DIR}" test -d "${SPHARMMT_PG_DIR}/data"
  check "backups em ${SPHARMMT_BACKUP_DIR}" test -d "${SPHARMMT_BACKUP_DIR}/postgres"
  if data_disk_in_use; then
    check "disco de dados montado"      is_mountpoint "$SPHARMMT_DATA_ROOT"
    check "montagem persistente (fstab)" bash -c "grep -qE '^[^#]*[[:space:]]${SPHARMMT_DATA_ROOT}[[:space:]]' /etc/fstab"
  else
    check_skip "disco de dados dedicado" "dados no mesmo volume do sistema"
  fi
  check "secrets = 0700 root:root"      bash -c "[ \"\$(stat -c '%a %U:%G' ${SPHARMMT_ROOT}/secrets)\" = '700 root:root' ]"
  check "postgres/data = 0700"          bash -c "[ \$(stat -c '%a' ${SPHARMMT_PG_DIR}/data) = 700 ]"
  check "nada world-readable"           bash -c "[ -z \"\$(find ${SPHARMMT_ROOT} -perm -o+r -o -perm -o+w 2>/dev/null)\" ]"
  check "umask 027 em login.defs"       bash -c "grep -qE '^UMASK\\s+027' /etc/login.defs"

  check "journald persistente"          bash -c "grep -q 'Storage=persistent' /etc/systemd/journald.conf.d/99-spharmmt.conf"
  check "logrotate configurado"         test -f /etc/logrotate.d/spharmmt
  check "healthcheck instalado"         test -x "${SPHARMMT_ROOT}/monitoring/checks/healthcheck.sh"
  check "timer do healthcheck activo"   svc_active spharmmt-healthcheck.timer

  # O que NÃO deve existir nesta fase.
  # A app e a BD correm em containers; tê-las também no host é sinal de
  # instalação acidental, mas não impede nada — daí aviso e não falha.
  check_warn "PostgreSQL não instalado no host" bash -c "! systemctl list-units --all 2>/dev/null | grep -q 'postgresql.service'"
  check_warn "Node não instalado no host" bash -c "! command -v node >/dev/null"
}

# ═════════════════════════════════════════════════════════════════════════
# Relatório
# ═════════════════════════════════════════════════════════════════════════
final_report() {
  local rc=$1
  local dir="${SPHARMMT_ROOT}/logs/monitoring"
  [ -d "$dir" ] || dir="${TMPDIR:-/tmp}"
  local rpt
  rpt="${dir}/bootstrap-report-$(date -u '+%Y%m%d-%H%M%S').txt"

  {
    printf 'SPharm.MT — relatório de bootstrap\n'
    printf '=================================\n\n'
    printf 'host          : %s\n' "$(hostname)"
    printf 'data (UTC)    : %s\n' "$(_ts)"
    # /etc/os-release só existe no alvo (Ubuntu), não no ambiente de análise.
    # shellcheck disable=SC1091
    printf 'SO            : %s\n' "$(. /etc/os-release && printf '%s %s' "$PRETTY_NAME" "$(uname -r)")"
    printf 'CPU / RAM     : %s vCPU / %s\n' "$(nproc)" "$(free -h | awk '/^Mem:/ {print $2}')"
    printf 'disco /       : %s usados de %s (%s)\n' \
      "$(df -h / | awk 'NR==2 {print $3}')" "$(df -h / | awk 'NR==2 {print $2}')" "$(df -h / | awk 'NR==2 {print $5}')"
    printf 'swap          : %s\n' "$(free -h | awk '/^Swap:/ {print $2}')"
    printf '\n'
    printf 'utilizador    : %s (grupos: %s)\n' "$DEPLOY_USER" "$(id -nG "$DEPLOY_USER" 2>/dev/null || echo '-')"
    printf 'SSH           : porta %s · endurecido=%s · root_desactivado=%s\n' \
      "$SSH_PORT" "$([ "$SSH_HARDENED" = 1 ] && echo sim || echo NAO)" \
      "$([ "$DISABLE_ROOT_LOGIN" = 1 ] && echo sim || echo nao)"
    printf 'firewall      : %s\n' "$(ufw status 2>/dev/null | head -1)"
    printf 'fail2ban      : %s\n' "$(fail2ban-client status 2>/dev/null | awk -F: '/Jail list/ {print $2}' | xargs || echo 'n/d')"
    printf 'docker        : %s\n' "$(docker --version 2>/dev/null || echo 'não instalado')"
    printf 'compose       : %s\n' "$(docker compose version --short 2>/dev/null || echo 'n/d')"
    printf 'estrutura     : %s\n' "$SPHARMMT_ROOT"
    printf 'dados         : %s%s\n' "$SPHARMMT_DATA_ROOT" \
      "$(data_disk_in_use && printf ' (disco dedicado)' || printf ' (mesmo volume do sistema)')"
    [ -n "$DISK_HINT" ] && printf 'discos livres : %s (NAO tocados)\n' "$DISK_HINT"
    printf 'reboot pend.  : %s\n' "$([ -f /var/run/reboot-required ] && echo SIM || echo nao)"
    printf '\nVerificações\n-----------\n'
    local i
    for i in "${!_CHK_STATUS[@]}"; do
      printf '  [%-4s] %s\n' "${_CHK_STATUS[$i]}" "${_CHK_LABEL[$i]}"
    done
    printf '\nresultado: %s (falhas=%s, avisos=%s)\n' \
      "$([ "$rc" -eq 0 ] && echo OK || echo FALHOU)" "$(checks_failed)" "$(checks_warned)"
    printf '\nPróximos passos\n---------------\n'
    printf '  1. Numa NOVA sessão, confirmar acesso:  ssh %s@<ip>\n' "$DEPLOY_USER"
    printf '  2. Reboot e revalidar:                  sudo reboot && %s/scripts/verify-platform.sh\n' "$SPHARMMT_ROOT"
    if [ -n "$DISK_HINT" ]; then
      printf '  3. Dedicar um disco aos dados (opcional): sudo ./prepare-data-disk.sh --device %s\n' "${DISK_HINT%% *}"
      printf '  4. Instalar a plataforma:               sudo ./install-platform.sh\n'
      printf '  5. Configurar destino de backup externo (a lacuna aberta mais séria)\n'
    else
      printf '  3. Instalar a plataforma:               sudo ./install-platform.sh\n'
      printf '  4. Configurar destino de backup externo (a lacuna aberta mais séria)\n'
    fi
  } > "$rpt" 2>/dev/null || rpt=""

  if [ -n "$rpt" ]; then
    chown "${DEPLOY_USER}:${DEPLOY_GROUP}" "$rpt" 2>/dev/null || true
    chmod 0640 "$rpt" 2>/dev/null || true
    info "relatório: ${rpt}"
    report_json "${dir}/bootstrap-report-latest.json" 2>/dev/null || true
  fi
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  log_init
  acquire_lock bootstrap
  banner "bootstrap-vps"

  preflight
  step_update
  step_identity
  step_base
  step_unattended
  step_user
  step_firewall
  step_ssh
  step_fail2ban
  step_docker
  step_disks
  step_structure
  step_logs
  step_monitoring
  step_backups

  local rc=0
  validate
  report "Bootstrap — validação final" || rc=$?
  final_report "$rc"

  printf '\n'
  if [ "$rc" -eq 0 ]; then
    ok "VPS preparada. $( [ "$CHANGES_MADE" = "1" ] && echo "Alterações aplicadas." || echo "Já estava conforme (execução idempotente)." )"
  else
    err "bootstrap terminou com falhas de validação — corrige antes de avançar"
  fi
  if [ "$SSH_HARDENED" = "1" ]; then
    warn "ANTES DE FECHAR ESTA SESSÃO: abre outra e confirma  ssh ${DEPLOY_USER}@<ip>"
  fi
  if [ "$REBOOT_REQUIRED" = "1" ]; then
    warn "reboot pendente (kernel/libc). Agenda-o e revalida com verify-platform.sh."
  fi
  finish "$rc"
}

main "$@"
