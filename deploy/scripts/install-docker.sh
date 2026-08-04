#!/usr/bin/env bash
# deploy/scripts/install-docker.sh
#
# Instala o Docker Engine + Compose v2 a partir do repositório OFICIAL da
# Docker (não o `docker.io` da Ubuntu, que fica versões atrás) e aplica a
# configuração de daemon exigida por um servidor de produção.
#
# Idempotente: correr duas vezes não reinstala, não reinicia containers
# desnecessariamente e não perde dados. A única acção destrutiva possível
# (remover pacotes conflituosos) só toca em pacotes que o Docker oficial
# substitui, e só quando o Docker oficial ainda não está instalado.
#
# Uso:
#   sudo ./install-docker.sh [--user <nome>] [--no-restart] [flags comuns]
#
# Saída: 0 ok · 2 pré-condição · 3 pós-condição · 5 lock

set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

DOCKER_USER=""
NO_RESTART=0

usage() {
  cat <<EOF
Uso: sudo $0 [opções]

  --user <nome>     Utilizador a adicionar ao grupo docker (default: \$SPHARMMT_USER = ${SPHARMMT_USER})
  --no-restart      Não reinicia o daemon mesmo que o daemon.json mude
                    (usar quando há containers de produção a correr e se
                     quer escolher a janela de restart)
$(common_flags_help)

Notas:
  · O daemon.json aplicado limita os logs (50MB x 5 por container). Sem isto,
    um container verboso enche o disco — a causa nº1 de disco cheio em hosts Docker.
  · live-restore mantém os containers a correr durante um restart do daemon.
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --user) DOCKER_USER=${2:-}; shift 2 ;;
    --no-restart) NO_RESTART=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die_usage "opção desconhecida: $1" ;;
  esac
done

[ -n "$DOCKER_USER" ] || DOCKER_USER="$SPHARMMT_USER"

# ─── Pré-condições ───────────────────────────────────────────────────────
preflight() {
  step "Pré-condições"
  require_root
  require_ubuntu 24.04
  require_cmd curl gpg install apt-get systemctl
  require_free_space / 4096
  # A instalação altera regras de iptables; sem systemd não há como gerir.
  [ -d /run/systemd/system ] || die_precond "systemd não está a correr (container/WSL?)"
  ok "pré-condições satisfeitas"
}

# ─── 1. Remover pacotes conflituosos ─────────────────────────────────────
remove_conflicts() {
  step "Pacotes conflituosos"
  if is_installed docker-ce; then
    ok "docker-ce já instalado — nada a remover"
    return 0
  fi
  local conflicts=(docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc)
  local found=()
  for p in "${conflicts[@]}"; do is_installed "$p" && found+=("$p"); done
  if [ ${#found[@]} -eq 0 ]; then ok "sem pacotes conflituosos"; return 0; fi
  warn "a remover pacotes que o Docker oficial substitui: ${found[*]}"
  run_quiet env DEBIAN_FRONTEND=noninteractive apt-get remove -y "${found[@]}"
  ok "removidos: ${found[*]}"
}

# ─── 2. Repositório oficial ──────────────────────────────────────────────
setup_repo() {
  step "Repositório oficial Docker"
  apt_ensure ca-certificates curl gnupg

  ensure_dir /etc/apt/keyrings 0755 root:root

  local key=/etc/apt/keyrings/docker.asc
  if [ -s "$key" ] && grep -q "BEGIN PGP PUBLIC KEY BLOCK" "$key"; then
    ok "chave GPG já presente"
  else
    info "a descarregar a chave GPG oficial..."
    local tmp; tmp=$(mktemp)
    if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 60 \
         https://download.docker.com/linux/ubuntu/gpg -o "$tmp"; then
      rm -f "$tmp"; die "falha a descarregar a chave GPG do Docker (sem rede? proxy?)"
    fi
    grep -q "BEGIN PGP PUBLIC KEY BLOCK" "$tmp" || { rm -f "$tmp"; die "a chave descarregada não é uma chave PGP válida"; }
    run install -m 0644 "$tmp" "$key"
    rm -f "$tmp"
    ok "chave GPG instalada"
  fi

  local codename arch
  # shellcheck disable=SC1091
  codename=$(. /etc/os-release && printf '%s' "${VERSION_CODENAME}")
  arch=$(dpkg --print-architecture)
  write_file /etc/apt/sources.list.d/docker.list 0644 root:root <<EOF
# Repositório oficial Docker — gerido por deploy/scripts/install-docker.sh
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable
EOF

  # Se o ficheiro mudou, o índice tem de ser relido. A variável é definida
  # e lida por apt_update_once() em lib/common.sh.
  # shellcheck disable=SC2034
  APT_UPDATED=0
  apt_update_once
  ok "repositório configurado (${codename}/${arch})"
}

# ─── 3. Instalação ───────────────────────────────────────────────────────
install_engine() {
  step "Docker Engine + plugins"
  apt_ensure docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if ! svc_enabled docker; then run systemctl enable docker; ok "docker activado no boot"; fi
  if ! svc_active docker; then run systemctl start docker; ok "docker iniciado"; fi
}

# ─── 4. Configuração do daemon ───────────────────────────────────────────
configure_daemon() {
  step "Configuração do daemon"
  ensure_dir /etc/docker 0755 root:root

  local before=""
  [ -f /etc/docker/daemon.json ] && before=$(sha256sum /etc/docker/daemon.json | cut -d' ' -f1)

  write_file /etc/docker/daemon.json 0644 root:root <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5",
    "compress": "true"
  },
  "live-restore": true,
  "no-new-privileges": true,
  "userland-proxy": false,
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Hard": 65536, "Soft": 65536 }
  },
  "metrics-addr": "127.0.0.1:9323"
}
EOF

  local after=""
  [ -f /etc/docker/daemon.json ] && after=$(sha256sum /etc/docker/daemon.json | cut -d' ' -f1)

  if [ "$before" = "$after" ]; then
    ok "daemon.json já correcto — sem restart"
    return 0
  fi

  # Valida ANTES de reiniciar: um daemon.json inválido impede o arranque
  # do Docker e derruba tudo o que estiver a correr.
  if [ "$DRY_RUN" != "1" ]; then
    if ! dockerd --validate --config-file=/etc/docker/daemon.json >/dev/null 2>&1; then
      err "daemon.json inválido — a reverter para a versão anterior"
      # find + sort em vez de `ls -t`: não depende de parsing de output e
      # lida com qualquer nome de ficheiro.
      local bak
      bak=$(find /etc/docker -maxdepth 1 -name 'daemon.json.spharmmt-bak-*' -printf '%T@ %p\n' 2>/dev/null \
              | sort -rn | head -1 | cut -d' ' -f2- || true)
      if [ -n "$bak" ]; then cp -a "$bak" /etc/docker/daemon.json; else rm -f /etc/docker/daemon.json; fi
      die "configuração de daemon rejeitada pelo dockerd (nada foi alterado em produção)"
    fi
    ok "daemon.json validado por dockerd --validate"
  fi

  if [ "$NO_RESTART" = "1" ]; then
    warn "daemon.json mudou mas --no-restart foi pedido — aplica com: systemctl restart docker"
    return 0
  fi
  info "a reiniciar o daemon (live-restore mantém os containers a correr)..."
  run systemctl restart docker
  ok "daemon reiniciado"
}

# ─── 5. Grupo docker ─────────────────────────────────────────────────────
configure_group() {
  step "Grupo docker"
  if ! id "$DOCKER_USER" >/dev/null 2>&1; then
    check_skip "utilizador ${DOCKER_USER} no grupo docker" "utilizador não existe ainda"
    warn "utilizador ${DOCKER_USER} não existe — cria-o com bootstrap-vps.sh e volta a correr"
    return 0
  fi
  if id -nG "$DOCKER_USER" | tr ' ' '\n' | grep -qx docker; then
    ok "${DOCKER_USER} já pertence ao grupo docker"
  else
    run usermod -aG docker "$DOCKER_USER"
    ok "${DOCKER_USER} adicionado ao grupo docker (efectivo no próximo login)"
    warn "pertencer ao grupo docker equivale a root — é aceitável porque ${DOCKER_USER} já tem sudo"
  fi
}

# ─── 6. Rede interna ─────────────────────────────────────────────────────
configure_network() {
  step "Rede interna"
  [ "$DRY_RUN" = "1" ] && { info "[dry-run] criaria a rede ${SPHARMMT_NETWORK}"; return 0; }
  if docker network inspect "$SPHARMMT_NETWORK" >/dev/null 2>&1; then
    ok "rede ${SPHARMMT_NETWORK} já existe"
  else
    run_quiet docker network create --driver bridge "$SPHARMMT_NETWORK"
    ok "rede ${SPHARMMT_NETWORK} criada"
  fi
}

# ─── Pós-condições ───────────────────────────────────────────────────────
postflight() {
  step "Validação"
  check "docker instalado"              has_cmd docker
  check "docker do repositório oficial" bash -c "apt-cache policy docker-ce | grep -q download.docker.com"
  check "serviço docker activo"         svc_active docker
  check "docker arranca no boot"        svc_enabled docker
  check "containerd activo"             svc_active containerd
  check "docker compose v2 disponível"  docker compose version
  check "buildx disponível"             docker buildx version
  check "daemon.json presente"          test -f /etc/docker/daemon.json
  check "rotação de logs configurada"   grep -q '"max-size"' /etc/docker/daemon.json
  check "live-restore activo"           bash -c "docker info 2>/dev/null | grep -q 'Live Restore Enabled: true'"
  check "rede ${SPHARMMT_NETWORK}"      docker network inspect "$SPHARMMT_NETWORK"

  if [ "$DRY_RUN" = "1" ]; then
    check_skip "container de teste corre" "dry-run"
  else
    # Teste funcional end-to-end: pull + run + exit. Usa a imagem oficial
    # mais pequena que existe.
    check "container de teste corre" docker run --rm hello-world
    docker image rm -f hello-world >/dev/null 2>&1 || true
  fi

  report "Docker — validação"
}

main() {
  log_init
  acquire_lock docker
  banner "install-docker"
  preflight
  remove_conflicts
  setup_repo
  install_engine
  configure_daemon
  configure_group
  configure_network
  local rc=0
  postflight || rc=$?
  if [ "$rc" -eq 0 ]; then
    info ""
    info "Docker pronto. $( [ "$CHANGES_MADE" = "1" ] && echo "Alterações aplicadas." || echo "Nada a alterar (já estava conforme)." )"
    info "Regra permanente: publica SEMPRE em 127.0.0.1 (ex.: -p 127.0.0.1:5432:5432)."
    info "O Docker escreve regras de iptables ANTES do UFW; publicar em 0.0.0.0 expõe o porto à internet"
    info "mesmo com o UFW a negar."
  fi
  finish "$rc"
}

main "$@"
