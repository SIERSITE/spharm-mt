#!/usr/bin/env bash
# deploy/scripts/update-platform.sh
#
# Actualização segura da plataforma. A sequência é sempre a mesma e não
# deve ser encurtada:
#
#   1. pré-condições (stack válida, disco, sem backup/restauro a correr)
#   2. BACKUP antes de tocar em nada          ← nunca opcional por defeito
#   3. registo das imagens actuais            ← é isto que torna o rollback possível
#   4. pull / build das imagens novas
#   5. up -d com recreação apenas do que mudou
#   6. espera activa pelos healthchecks
#   7. se algo falhar → rollback automático para as imagens registadas em 3
#   8. validação final
#
# Uso:
#   sudo ./update-platform.sh                 # actualiza a stack
#   sudo ./update-platform.sh --os            # actualiza também o SO
#   sudo ./update-platform.sh --service app   # só um serviço
#   sudo ./update-platform.sh --rollback      # volta ao estado registado
#
# Saída: 0 ok · 1 falha (com rollback tentado) · 2 pré-condição
#        · 3 validação pós-update · 5 lock

set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

DO_OS=0
DO_ROLLBACK=0
SKIP_BACKUP=0
SKIP_MIGRATIONS=0
NO_BUILD=0
SERVICE=""
HEALTH_TIMEOUT=180
STATE_FILE="${SPHARMMT_ROOT}/monitoring/state/last-good-images.txt"

# Wrapper do compose com o perfil `tools`, onde vive o serviço `migrate`.
# Sem o perfil, o compose finge que esse serviço não existe — o `build`
# ignora-o e o `run` responde "no such service".
dct() {
  local args=(-f "$SPHARMMT_COMPOSE_FILE" -p spharmmt --profile tools)
  [ -f "$SPHARMMT_ENV_FILE" ] && args+=(--env-file "$SPHARMMT_ENV_FILE")
  [ -f "$SPHARMMT_STACK_ENV_FILE" ] && args+=(--env-file "$SPHARMMT_STACK_ENV_FILE")
  docker compose "${args[@]}" "$@"
}

usage() {
  cat <<EOF
Uso: sudo $0 [opções]

  --os                 Actualiza também os pacotes do sistema (security)
  --service <nome>     Actualiza apenas este serviço do compose
  --no-build           Não reconstrói imagens locais (só pull)
  --skip-backup        NÃO faz backup antes (desaconselhado)
  --skip-migrations    Não aplica migrations (a app pode ficar sobre schema velho)
  --rollback           Repõe as imagens do último update bem sucedido
  --health-timeout <s> Espera máxima pelos healthchecks (default: ${HEALTH_TIMEOUT})
$(common_flags_help)
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --os) DO_OS=1; shift ;;
    --service) SERVICE=${2:?}; shift 2 ;;
    --no-build) NO_BUILD=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --skip-migrations) SKIP_MIGRATIONS=1; shift ;;
    --rollback) DO_ROLLBACK=1; shift ;;
    --health-timeout) HEALTH_TIMEOUT=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die_usage "opção desconhecida: $1" ;;
  esac
done

# ═════════════════════════════════════════════════════════════════════════
preflight() {
  step "Pré-condições"
  require_root
  require_cmd docker
  docker compose version >/dev/null 2>&1 || die_precond "docker compose v2 ausente"

  if [ ! -f "$SPHARMMT_COMPOSE_FILE" ]; then
    warn "não existe ${SPHARMMT_COMPOSE_FILE} — a stack ainda não foi instalada"
    if [ "$DO_OS" = "1" ]; then
      info "a prosseguir apenas com a actualização do SO (--os)"
      return 0
    fi
    info "nada a actualizar. Usa --os para actualizar só o sistema."
    finish "$EX_OK"
  fi

  dc config >/dev/null 2>&1 || die_precond "docker compose config inválido — corrige antes de actualizar"
  ok "compose válido"

  require_free_space / 5120
  ensure_dir "$(dirname "$STATE_FILE")" 2750 "${SPHARMMT_USER}:${SPHARMMT_GROUP}"
  ok "pré-condições satisfeitas"
}

# ═════════════════════════════════════════════════════════════════════════
snapshot_images() {
  step "Registo do estado actual"
  [ "$DRY_RUN" = "1" ] && { info "[dry-run] registaria as imagens actuais"; return 0; }
  local tmp; tmp=$(mktemp)
  # Guarda o ID da imagem (não a tag): uma tag pode passar a apontar para
  # outro digest, o ID não muda. É isto que torna o rollback fiável.
  dc ps --format '{{.Service}}' 2>/dev/null | while IFS= read -r svc; do
    [ -z "$svc" ] && continue
    local cid img
    cid=$(dc ps -q "$svc" 2>/dev/null | head -1 || true)
    [ -z "$cid" ] && continue
    img=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)
    [ -n "$img" ] && printf '%s %s\n' "$svc" "$img"
  done > "$tmp"
  if [ -s "$tmp" ]; then
    install -m 0640 -o "$SPHARMMT_USER" -g "$SPHARMMT_GROUP" "$tmp" "$STATE_FILE"
    ok "$(wc -l < "$STATE_FILE") serviço(s) registados em ${STATE_FILE}"
  else
    warn "nenhum container a correr — sem estado para registar (primeira subida?)"
  fi
  rm -f "$tmp"
}

# ═════════════════════════════════════════════════════════════════════════
backup_first() {
  step "Backup pré-actualização"
  if [ "$SKIP_BACKUP" = "1" ]; then
    warn "backup ignorado (--skip-backup) — sem rede de segurança para os dados"
    return 0
  fi
  local bk="${SCRIPT_DIR}/backup-platform.sh"
  [ -x "$bk" ] || bk="${SPHARMMT_ROOT}/scripts/backup-platform.sh"
  if [ ! -x "$bk" ]; then warn "backup-platform.sh não encontrado — a continuar sem backup"; return 0; fi

  local args=(--yes --label pre-update)
  [ "$DRY_RUN" = "1" ] && args+=(--dry-run)
  # O lock do backup é distinto do lock do update, portanto não colidem.
  if bash "$bk" "${args[@]}"; then
    ok "backup pré-actualização concluído"
  else
    die "backup pré-actualização falhou — actualização abortada (nada foi tocado)"
  fi
}

# ═════════════════════════════════════════════════════════════════════════
update_os() {
  [ "$DO_OS" = "1" ] || return 0
  step "Actualização do sistema"
  apt_update_once
  run_quiet env DEBIAN_FRONTEND=noninteractive apt-get -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
  run_quiet env DEBIAN_FRONTEND=noninteractive apt-get -y autoremove --purge
  ok "pacotes do sistema actualizados"
  [ -f /var/run/reboot-required ] && warn "reboot pendente — agenda-o fora de horas"
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
pull_and_deploy() {
  step "Actualização da stack"
  local svc=()
  [ -n "$SERVICE" ] && svc=("$SERVICE")

  info "a descarregar imagens..."
  run dc pull --ignore-buildable "${svc[@]+"${svc[@]}"}" || warn "pull parcial (imagens locais não têm origem remota)"

  if [ "$NO_BUILD" != "1" ]; then
    info "a reconstruir imagens locais..."
    run dc build --pull "${svc[@]+"${svc[@]}"}"
    # A imagem do migrator vive no perfil `tools` e o `dc build` não lhe
    # toca. Deixá-la para trás significaria aplicar as migrations da
    # versão ANTERIOR sobre o código novo — a pior combinação possível.
    if [ -z "$SERVICE" ] && dct config --services 2>/dev/null | grep -qx migrate; then
      run dct build --pull migrate
    fi
  fi

  # Migrations ANTES de recriar a aplicação, e num container próprio.
  # Se falharem, a versão antiga continua a servir sobre o schema que
  # conhece; se corressem depois, haveria uma janela com código novo
  # sobre schema velho.
  if [ "$SKIP_MIGRATIONS" != "1" ] && [ -z "$SERVICE" ] \
     && dct config --services 2>/dev/null | grep -qx migrate; then
    info "a aplicar migrations..."
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] correria as migrations"
    elif dct run --rm migrate; then
      ok "migrations aplicadas"
    else
      err "migrations falharam — a aplicação NÃO foi actualizada"
      return 1
    fi
  fi

  info "a aplicar..."
  # Sem `--profile tools`: o `migrate` é um trabalho pontual e não pode
  # ficar de pé com a stack.
  run dc up -d --remove-orphans "${svc[@]+"${svc[@]}"}"
  ok "containers recriados"
}

# ═════════════════════════════════════════════════════════════════════════
wait_healthy() {
  step "Espera pelos healthchecks"
  [ "$DRY_RUN" = "1" ] && { info "[dry-run] esperaria pelos healthchecks"; return 0; }

  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  local pending=1
  while [ "$(date +%s)" -lt "$deadline" ]; do
    pending=0
    local cid state health
    while IFS= read -r cid; do
      [ -z "$cid" ] && continue
      state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)
      health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)
      case "$state:$health" in
        running:healthy|running:none) ;;
        running:starting) pending=$((pending+1)) ;;
        *) pending=$((pending+1)) ;;
      esac
    done < <(dc ps -q 2>/dev/null)
    [ "$pending" -eq 0 ] && { ok "todos os containers saudáveis"; return 0; }
    sleep 5
  done

  err "${pending} container(s) não ficaram saudáveis em ${HEALTH_TIMEOUT}s"
  dc ps || true
  return 1
}

# ═════════════════════════════════════════════════════════════════════════
rollback() {
  step "Rollback"
  if [ ! -s "$STATE_FILE" ]; then
    err "sem estado registado em ${STATE_FILE} — rollback automático impossível"
    err "os dados continuam intactos; o backup pré-actualização está em backups/postgres/daily/"
    return 1
  fi
  warn "a repor as imagens do último estado bom conhecido..."
  local svc img
  while read -r svc img; do
    [ -z "$svc" ] && continue
    if docker image inspect "$img" >/dev/null 2>&1; then
      info "  ${svc} → ${img:0:19}"
      # Reetiqueta a imagem antiga como a que o compose espera e recria.
      docker tag "$img" "spharmmt-${svc}:rollback" 2>/dev/null || true
    else
      warn "  imagem de ${svc} já não existe localmente (docker image prune?) — não recuperável"
    fi
  done < "$STATE_FILE"
  dc up -d --force-recreate 2>/dev/null || true
  warn "rollback aplicado com base nas imagens locais. Valida com verify-platform.sh."
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
postflight() {
  step "Validação"
  if [ -f "$SPHARMMT_COMPOSE_FILE" ]; then
    check "compose config válido" dc config --no-env-resolution
    local total running
    total=$(dc config --services 2>/dev/null | wc -l)
    running=$(dc ps -q 2>/dev/null | wc -l)
    check "containers a correr (${running}/${total})" bash -c "[ ${running} -ge ${total} ]"
    check "sem containers unhealthy" bash -c "[ -z \"\$(docker ps --filter health=unhealthy -q)\" ]"
    if container_running "$SPHARMMT_PG_CONTAINER"; then
      check "postgres aceita ligações" docker exec "$SPHARMMT_PG_CONTAINER" pg_isready -q
    else
      check_skip "postgres" "container ausente"
    fi
  else
    check_skip "stack docker" "compose ainda não instalado"
  fi
  check "docker daemon responde" docker info
  report "Actualização — validação"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  log_init
  acquire_lock update
  banner "update-platform"

  if [ "$DO_ROLLBACK" = "1" ]; then
    preflight
    rollback
    local rc=0; postflight || rc=$?
    finish "$rc"
  fi

  preflight
  backup_first
  snapshot_images
  update_os

  if [ -f "$SPHARMMT_COMPOSE_FILE" ]; then
    if ! pull_and_deploy; then
      err "falha ao aplicar a nova versão — a tentar rollback"
      rollback || true
      die "actualização falhou (rollback tentado; ver ${LOG_FILE})"
    fi
    if ! wait_healthy; then
      err "a nova versão não ficou saudável — a fazer rollback"
      rollback || true
      DIE_CODE=$EX_FAIL die "actualização revertida por falha de healthcheck"
    fi
    # Limpa imagens órfãs, mas mantém as do estado registado para o rollback.
    if [ "$DRY_RUN" != "1" ]; then
      docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true
      ok "imagens órfãs com mais de 7 dias removidas"
    fi
  fi

  local rc=0
  postflight || rc=$?
  printf '\n'
  if [ "$rc" -eq 0 ]; then ok "actualização concluída"; else err "actualização terminou com falhas de validação"; fi
  info "rollback disponível: sudo $0 --rollback"
  finish "$rc"
}

main "$@"
