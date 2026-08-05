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
# PRECEDÊNCIA DOS DROP-INS DO SSHD — a razão de ser do prefixo 00-.
#
# `/etc/ssh/sshd_config` tem `Include /etc/ssh/sshd_config.d/*.conf` NO TOPO,
# os ficheiros são lidos por ordem lexicográfica, e em SSH o PRIMEIRO valor
# obtido para cada palavra-chave é o que vence. Numa imagem cloud da Ubuntu
# existe tipicamente:
#
#   50-cloud-init.conf         PasswordAuthentication yes    ← vencia
#   60-cloudimg-settings.conf  PasswordAuthentication no
#   99-spharmmt-hardening.conf PasswordAuthentication no     ← chegava tarde
#
# Com o prefixo 99- o nosso ficheiro era lido em último e não tinha efeito
# nenhum: `sshd -T` devolvia `passwordauthentication yes`. O prefixo 00-
# garante que somos lidos primeiro e que os nossos valores ganham.
SSH_DROPIN=/etc/ssh/sshd_config.d/00-spharmmt-hardening.conf
# Ficheiro da versão anterior, removido só depois de o novo estar validado.
SSH_DROPIN_LEGACY=/etc/ssh/sshd_config.d/99-spharmmt-hardening.conf

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
# ═════════════════════════════════════════════════════════════════════════
# Swap — isolada em funções próprias para ser testável sem tocar no sistema.
# FSTAB_FILE (em lib/common.sh) e SWAP_FILE são sobreponíveis para esse fim.
# ═════════════════════════════════════════════════════════════════════════
: "${SWAP_FILE:=/swapfile}"

# Ver fstab_verify_ok() em lib/common.sh para as duas armadilhas do
# `findmnt --verify`. Deliberadamente multi-linha, com `}` na coluna 0: o
# teste extrai esta função por gama de sed até `^}` e um one-liner faria a
# gama estender-se até ao fim da função seguinte.
fstab_is_valid() {
  fstab_verify_ok
}

# Garante a entrada persistente, sem duplicar, e com rollback limitado à
# linha que este script escreveu.
ensure_swap_fstab_entry() {
  if grep -qE "^[[:space:]]*${SWAP_FILE}[[:space:]]" "$FSTAB_FILE" 2>/dev/null; then
    ok "${FSTAB_FILE} já tem a entrada de swap (não duplicada)"
    return 0
  fi

  # Estado ANTES de mexer. Sem esta referência não é possível distinguir
  # "a nossa linha partiu o ficheiro" de "o ficheiro já tinha problemas" —
  # e reverteríamos uma linha correcta por causa de um aviso alheio.
  local baseline_ok=0
  if fstab_is_valid; then baseline_ok=1; fi

  backup_file "$FSTAB_FILE"
  printf '%s none swap sw 0 0\n' "$SWAP_FILE" >> "$FSTAB_FILE"

  if fstab_is_valid; then
    ok "swap persistente; ${FSTAB_FILE} validado"
    return 0
  fi

  if [ "$baseline_ok" = "0" ]; then
    # Já estava assim antes. A entrada de swap fica — removê-la não corrige
    # nada e deixaria a swap sem persistência por uma razão que não é nossa.
    warn "${FSTAB_FILE} já tinha problemas ANTES desta alteração"
    warn "entrada de swap mantida. Inspecciona com: findmnt --verify"
    return 0
  fi

  # O ficheiro estava bom e passou a estar mau: a responsabilidade é da
  # linha que acabámos de escrever.
  err "${FSTAB_FILE} ficou inválido por causa da entrada de swap — a reverter APENAS essa linha"
  sed -i "\|^[[:space:]]*${SWAP_FILE}[[:space:]]|d" "$FSTAB_FILE"
  if fstab_is_valid; then
    warn "entrada removida e ${FSTAB_FILE} está válido."
    warn "A swap fica ACTIVA mas NÃO sobrevive a um reboot. Diagnostica com: findmnt --verify"
    return 0
  fi
  die "${FSTAB_FILE} continua inválido depois do rollback — inspecciona manualmente antes de reiniciar"
}

setup_swap() {
  if [ "$SWAP_SIZE" = "0" ] || [ "$SWAP_SIZE" = "none" ]; then
    info "swap ignorada (--swap-size 0)"
    return 0
  fi

  local active
  active=$(swapon --show=NAME --noheadings 2>/dev/null | tr '\n' ' ' || true)

  if [ -n "${active// /}" ]; then
    ok "swap já activa: ${active}"
    # Reparação: swap activa sem entrada no fstab não sobrevive ao reboot.
    # É o estado em que fica uma execução que falhou entre o `swapon` e a
    # persistência — exactamente o que o bug do `findmnt --quiet` provocava.
    if printf '%s' "$active" | grep -qw -- "$SWAP_FILE"; then
      ensure_swap_fstab_entry
    fi
    return 0
  fi

  info "a criar swap de ${SWAP_SIZE} em ${SWAP_FILE}..."
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] criaria ${SWAP_FILE} e a respectiva entrada em ${FSTAB_FILE}"
    return 0
  fi

  # Reaproveita um swapfile deixado por uma execução interrompida: recriá-lo
  # desperdiça I/O e pode falhar por falta de espaço.
  if [ -f "$SWAP_FILE" ]; then
    warn "${SWAP_FILE} já existe (execução anterior interrompida?) — reaproveitado"
  else
    # fallocate falha em alguns filesystems (btrfs); dd é o fallback.
    if ! fallocate -l "$SWAP_SIZE" "$SWAP_FILE" 2>/dev/null; then
      local mb; mb=$(numfmt --from=iec "$SWAP_SIZE" | awk '{print int($1/1048576)}')
      dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$mb" status=none
    fi
  fi
  chmod 600 "$SWAP_FILE"

  # mkswap apenas se ainda não for uma área de swap válida — repetir mkswap
  # sobre uma área já formatada muda o UUID sem necessidade.
  if [ "$(blkid -o value -s TYPE "$SWAP_FILE" 2>/dev/null || true)" != "swap" ]; then
    mkswap "$SWAP_FILE" >/dev/null
  fi
  swapon "$SWAP_FILE"
  ok "swap activa (${SWAP_SIZE})"

  ensure_swap_fstab_entry
}

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

  setup_swap

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

  if group_exists "$DEPLOY_GROUP"; then
    ok "grupo ${DEPLOY_GROUP} já existe"
  else
    run groupadd "$DEPLOY_GROUP"
    sim_group_created "$DEPLOY_GROUP"
    ok "grupo ${DEPLOY_GROUP} criado"
  fi

  if user_exists "$DEPLOY_USER"; then
    ok "utilizador ${DEPLOY_USER} já existe — será reutilizado, não recriado"
  else
    run adduser --disabled-password --gecos "SPharm.MT deploy" "$DEPLOY_USER"
    sim_user_created "$DEPLOY_USER"
    ok "utilizador ${DEPLOY_USER} criado (sem password — acesso só por chave)"
  fi

  # Resolve o home e o grupo primário REAIS (podem não ser os convencionais
  # se o utilizador já existia). Tudo o que se segue usa estes valores.
  # Em dry-run o utilizador não existe mesmo: ficam os defaults, que é o
  # que `adduser` teria criado.
  local resolved_home resolved_group
  resolved_home=$(getent passwd "$DEPLOY_USER" 2>/dev/null | cut -d: -f6 || true)
  resolved_group=$(id -gn "$DEPLOY_USER" 2>/dev/null || true)
  if [ -n "$resolved_home" ]; then DEPLOY_HOME="$resolved_home"; fi
  if [ -n "$resolved_group" ]; then DEPLOY_PGROUP="$resolved_group"; fi
  ok "home=${DEPLOY_HOME} grupo primário=${DEPLOY_PGROUP}"

  for g in sudo "$DEPLOY_GROUP"; do
    if user_in_group "$DEPLOY_USER" "$g"; then
      dbg "${DEPLOY_USER} já em ${g}"
    else
      run usermod -aG "$g" "$DEPLOY_USER"
      sim_user_in_group "$DEPLOY_USER" "$g"
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
  if [ -n "$SSH_KEY" ]; then printf '%s\n' "$SSH_KEY" >> "$out"; fi
  if [ -n "$SSH_KEY_FILE" ]; then cat "$SSH_KEY_FILE" >> "$out"; fi
  if [ ! -s "$out" ] && [ -s /root/.ssh/authorized_keys ]; then
    grep -vE '^\s*(#|$)' /root/.ssh/authorized_keys >> "$out" || true
    if [ -s "$out" ]; then
      info "sem --ssh-key: reutilizadas as chaves de /root/.ssh/authorized_keys"
    fi
  fi
  return 0
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

# ─────────────────────────────────────────────────────────────────────────
# Valores EFECTIVOS do sshd
# ─────────────────────────────────────────────────────────────────────────
#
# O conteúdo dos ficheiros não diz nada sobre o que o sshd vai fazer: com
# vários drop-ins e a regra "primeiro valor vence", só `sshd -T` sabe. Foi
# precisamente por confiar no ficheiro que o endurecimento ficou inerte
# numa VPS com 50-cloud-init.conf a activar a password.

# _sshd_get <chave> [-C <spec>] — valor efectivo de uma directiva.
_sshd_get() {
  local key=$1; shift
  sshd -T "$@" 2>/dev/null | awk -v k="$key" 'tolower($1)==k {print tolower($2); exit}'
}

# _ssh_effective_ok <permit_root> [-C <spec>] — confirma o conjunto mínimo.
# Devolve 0 se TODOS os valores efectivos são os pretendidos.
_ssh_effective_ok() {
  local want_root=$1; shift
  local -a ctx=("$@")
  local bad=0

  # Bash tem âmbito dinâmico: esta função vê `ctx` e `bad` da chamadora.
  _chk() {
    local key=$1 want=$2 got
    got=$(_sshd_get "$key" "${ctx[@]}")
    if [ "$got" != "$want" ]; then
      err "  ${key}: esperado '${want}', efectivo '${got:-<vazio>}'"
      bad=1
    fi
  }

  _chk passwordauthentication      no
  _chk kbdinteractiveauthentication no
  _chk pubkeyauthentication        yes
  _chk usepam                      yes
  _chk permitemptypasswords        no

  # PermitRootLogin: o `sshd -T` NORMALIZA `prohibit-password` para o
  # sinónimo legado `without-password`. Comparar literalmente fazia esta
  # validação falhar sempre — e o bootstrap revertia um endurecimento
  # perfeitamente correcto.
  _norm_root() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
      without-password) printf 'prohibit-password' ;;
      *) printf '%s' "$1" | tr '[:upper:]' '[:lower:]' ;;
    esac
  }
  local got_root
  got_root=$(_sshd_get permitrootlogin "${ctx[@]}")
  if [ "$(_norm_root "$got_root")" != "$(_norm_root "$want_root")" ]; then
    err "  permitrootlogin: esperado '${want_root}', efectivo '${got_root:-<vazio>}'"
    bad=1
  fi

  # AllowUsers tem de conter o utilizador de deploy: sem isso o login é
  # recusado mesmo com chave válida. O `sshd -T` imprime UMA LINHA POR
  # UTILIZADOR (`allowusers deploy` + `allowusers root`), portanto não se
  # pode parar na primeira.
  local allow
  allow=$(sshd -T "${ctx[@]}" 2>/dev/null \
          | awk 'tolower($1)=="allowusers"{for (i=2; i<=NF; i++) printf "%s ", $i}')
  case " ${allow}" in
    *" ${DEPLOY_USER} "*) ;;
    *) err "  allowusers: '${allow% }' não inclui ${DEPLOY_USER}"; bad=1 ;;
  esac

  return "$bad"
}

_ssh_dump_effective() {
  err "valores efectivos relevantes:"
  sshd -T "$@" 2>/dev/null | grep -iE '^(passwordauthentication|kbdinteractive|pubkeyauth|permitrootlogin|usepam|permitempty|allowusers|authenticationmethods) ' \
    | sed 's/^/    /' >&2 || true
  err "ordem de leitura dos drop-ins (o primeiro valor de cada chave vence):"
  find /etc/ssh/sshd_config.d -maxdepth 1 -name '*.conf' 2>/dev/null | sort | sed 's/^/    /' >&2 || true
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

  # Contagem final — é esta que decide se se desliga a autenticação por
  # password.
  local installed=0
  if [ -f "${DEPLOY_HOME}/.ssh/authorized_keys" ]; then
    installed=$(_valid_key_count "${DEPLOY_HOME}/.ssh/authorized_keys")
  fi
  # Em dry-run o authorized_keys não chegou a ser escrito. Sem isto, o
  # dry-run reportava "NENHUMA chave pública válida encontrada" mesmo com
  # --ssh-key fornecida, e simulava um resultado diferente do real. A
  # decisão passa a assentar nas chaves efectivamente RECEBIDAS ($nkeys),
  # que é o que a execução real teria instalado.
  if [ "$DRY_RUN" = "1" ] && [ "$nkeys" -gt "$installed" ]; then
    installed="$nkeys"
    info "[dry-run] ${nkeys} chave(s) válida(s) recebida(s) por argumento — seriam instaladas em ${DEPLOY_HOME}/.ssh/authorized_keys"
  fi
  local root_keys=0
  if [ -f /root/.ssh/authorized_keys ]; then
    root_keys=$(_valid_key_count /root/.ssh/authorized_keys)
  fi

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

  # Guarda o estado anterior dos DOIS ficheiros, para poder repor exactamente
  # o que estava se qualquer validação falhar.
  local sshbak; sshbak=$(mktemp -d)
  if [ "$DRY_RUN" != "1" ]; then
    [ -f "$SSH_DROPIN" ] && cp -a "$SSH_DROPIN" "${sshbak}/new" || true
    [ -f "$SSH_DROPIN_LEGACY" ] && cp -a "$SSH_DROPIN_LEGACY" "${sshbak}/legacy" || true
  fi

  write_file "$SSH_DROPIN" 0644 root:root <<EOF
# Gerido por bootstrap-vps.sh — SPharm.MT
#
# PREFIXO 00- É DELIBERADO. O Include está no topo do sshd_config, os
# drop-ins são lidos por ordem lexicográfica e em SSH o PRIMEIRO valor
# vence. Com 99- este ficheiro era lido depois do 50-cloud-init.conf da
# imagem cloud (que traz PasswordAuthentication yes) e não tinha efeito.
# Confirmar sempre com \`sshd -T\`, nunca pelo conteúdo dos ficheiros.
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

  if [ "$DRY_RUN" = "1" ]; then
    rm -rf "$sshbak"
    info "[dry-run] validaria com sshd -t, sshd -T e sshd -T -C user=${DEPLOY_USER},host=$(hostname),addr=127.0.0.1"
    info "[dry-run] removeria ${SSH_DROPIN_LEGACY} e faria systemctl reload ssh"
    SSH_HARDENED=1
    ok "SSH endurecido: password OFF, PermitRootLogin=${permit_root}, AllowUsers='${allow_users}'"
    return 0
  fi

  # ── Validação em três níveis, ANTES de qualquer reload ────────────────
  # Enquanto não houver reload, o sshd em execução mantém a configuração
  # antiga: a sessão actual está a salvo aconteça o que acontecer aqui.
  _ssh_restore() {
    rm -f "$SSH_DROPIN"
    [ -f "${sshbak}/new" ] && cp -a "${sshbak}/new" "$SSH_DROPIN" || true
    [ -f "${sshbak}/legacy" ] && cp -a "${sshbak}/legacy" "$SSH_DROPIN_LEGACY" || true
    rm -rf "$sshbak"
  }

  if ! sshd -t 2>/dev/null; then
    err "sshd -t rejeitou a configuração"
    sshd -t 2>&1 | sed 's/^/    /' >&2 || true
    _ssh_restore
    die "endurecimento revertido. NENHUM reload foi feito — a sessão actual não foi afectada."
  fi
  ok "sshd -t: sintaxe válida"

  if ! _ssh_effective_ok "$permit_root"; then
    err "os valores EFECTIVOS do sshd não são os pretendidos"
    _ssh_dump_effective
    _ssh_restore
    die "endurecimento revertido. NENHUM reload foi feito."
  fi
  ok "sshd -T: valores efectivos correctos"

  # `-C` avalia a configuração no contexto de uma ligação concreta, o que
  # inclui blocos Match que só se aplicam a certos utilizadores/origens.
  # Sem isto, um `Match User deploy` noutro drop-in podia repor a password.
  if ! _ssh_effective_ok "$permit_root" "-C" "user=${DEPLOY_USER},host=$(hostname),addr=127.0.0.1"; then
    err "no contexto user=${DEPLOY_USER} os valores efectivos divergem (bloco Match?)"
    _ssh_dump_effective "-C" "user=${DEPLOY_USER},host=$(hostname),addr=127.0.0.1"
    _ssh_restore
    die "endurecimento revertido. NENHUM reload foi feito."
  fi
  ok "sshd -T -C user=${DEPLOY_USER}: valores efectivos correctos"

  # ── Só agora o ficheiro antigo pode sair ──────────────────────────────
  if [ -f "$SSH_DROPIN_LEGACY" ]; then
    rm -f "$SSH_DROPIN_LEGACY"
    # Remover um ficheiro também muda a configuração efectiva — revalidar.
    if sshd -t 2>/dev/null && _ssh_effective_ok "$permit_root"; then
      ok "${SSH_DROPIN_LEGACY} removido (substituído por ${SSH_DROPIN##*/})"
    else
      err "a remoção do ficheiro antigo degradou a configuração — a repô-lo"
      _ssh_restore
      die "endurecimento revertido. NENHUM reload foi feito."
    fi
  fi
  rm -rf "$sshbak"

  # reload, NUNCA restart: a sessão actual sobrevive mesmo se algo correr mal.
  if ! systemctl reload ssh 2>/dev/null && ! systemctl reload sshd 2>/dev/null; then
    warn "systemctl reload ssh falhou — a configuração está no disco mas não activa"
    warn "aplica manualmente com: systemctl reload ssh"
  else
    ok "systemctl reload ssh aplicado (sem restart)"
  fi

  SSH_HARDENED=1
  ok "SSH endurecido: password OFF, PermitRootLogin=${permit_root}, AllowUsers='${allow_users}'"
  warn "NÃO FECHES esta sessão. Abre outra e confirma:  ssh ${DEPLOY_USER}@<ip>"
  return 0
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
  # NUNCA terminar uma função com `[ ... ] && cmd`: se o teste for falso a
  # função devolve 1 e, como é chamada directamente do main, o `set -e`
  # aborta o script. Foi exactamente isto que partiu o primeiro dry-run.
  if [ -n "$ADMIN_IP" ]; then
    ok "${ADMIN_IP} isento de bans (ignoreip)"
  fi
  return 0
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
    # O nó pode não estar acessível (container, dispositivo removido entre a
    # listagem e a consulta). Sem esta guarda o lsblk devolve 32, o pipefail
    # propaga e o `set -e` aborta o bootstrap inteiro numa etapa que é
    # meramente informativa.
    [ -b "$dev" ] || continue
    size=$(lsblk -bdno SIZE "$dev" 2>/dev/null | head -1 || true)
    size=$(numfmt --to=iec "${size:-0}" 2>/dev/null || echo '?')
    fstype=$(lsblk -rno FSTYPE "$dev" 2>/dev/null | tr -d '[:space:]' || true)
    parts=$(lsblk -rno NAME "$dev" 2>/dev/null | tail -n +2 | wc -l || echo 0)

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
  # `secrets` NÃO entra nesta lista: aplicar-lhe 2750 dava-lhe setgid e
  # permissões de grupo, que é exactamente o que não pode ter. É criado à
  # parte, com o modo definitivo.
  local dirs=(
    app
    logs logs/app logs/postgres logs/proxy logs/monitoring logs/backups
    docker docker/compose docker/env docker/build
    scripts scripts/lib
    monitoring monitoring/checks monitoring/state
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

  # ── secrets: 0700 root:root, SEM setgid ──────────────────────────────
  # Só root. O deploy lê com sudo; os containers recebem apenas o que o
  # compose montar explicitamente. Não há grupo a herdar aqui, logo o
  # setgid não serve nada e só alarga a superfície.
  ensure_dir "${SPHARMMT_ROOT}/secrets" 0700 root:root
  enforce_secret_file_modes

  # ── postgres/data: 2700 deploy:spharmmt ──────────────────────────────
  # O PostgreSQL exige que o data directory não tenha bits para grupo nem
  # para others (verifica S_IRWXG|S_IRWXO); o setgid não entra nessa
  # máscara, portanto 2700 é aceite e mantém a herança de grupo para o
  # conteúdo criado por membros do grupo spharmmt.
  # A revisão de UID/GID fica para quando o container PostgreSQL existir.
  ensure_dir "${SPHARMMT_POSTGRES_DATA_DIR}" 2700 "$owner"
  ensure_dir "${SPHARMMT_BACKUP_DIR}/postgres" 2700 "$owner"
  ensure_dir "${SPHARMMT_ROOT}/docker/env" 2750 "$owner"

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

  # Em dry-run nada foi aplicado: validar o estado do sistema devolveria
  # falhas em tudo e o dry-run terminaria com rc=3. O que o dry-run valida
  # é o FLUXO do script, não o resultado — esse só existe na execução real.
  if [ "$DRY_RUN" = "1" ]; then
    info "validação ignorada: em dry-run nada foi aplicado, não há estado para verificar"
    check_skip "validação final do servidor" "dry-run"
    return 0
  fi

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
    # Swap activa mas ausente do fstab não sobrevive ao reboot — é
    # exactamente o estado meio-configurado que o bug do findmnt deixava.
    check "swap persistente no fstab"   bash -c "grep -qE '^[^#]*[[:space:]]swap[[:space:]]' ${FSTAB_FILE}"
    check "sem entradas de swap duplicadas" \
      bash -c "[ \$(grep -cE '^[[:space:]]*${SWAP_FILE}[[:space:]]' ${FSTAB_FILE}) -le 1 ]"
  fi
  check "fstab válido"                  bash -c "findmnt --verify >/dev/null 2>&1"
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
  check "postgres em ${SPHARMMT_POSTGRES_DATA_DIR}" test -d "$SPHARMMT_POSTGRES_DATA_DIR"
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
    printf 'firewall      : %s\n' "$(ufw status 2>/dev/null | head -1 || true)"
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
