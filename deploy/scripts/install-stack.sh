#!/usr/bin/env bash
# deploy/scripts/install-stack.sh
#
# Instala a stack aplicacional (PostgreSQL + web + worker + proxy) sobre
# uma VPS já preparada por bootstrap-vps.sh e install-platform.sh.
#
# Sequência, e a ordem importa:
#
#   1. pré-condições — plataforma instalada, segredos presentes, disco montado
#   2. código        — árvore do repositório para ${SPHARMMT_ROOT}/app
#   3. artefactos    — compose, init do PostgreSQL, configuração do nginx
#   4. segredos      — ficheiros derivados POR SERVIÇO (least privilege)
#   5. configuração  — stack.env (interpolação do compose)
#   6. build         — imagem da aplicação (web/worker) e do migrator
#   7. postgres      — sobe sozinho e espera-se que fique healthy
#   8. migrations    — container próprio, uma vez, ANTES da aplicação
#   9. stack         — web, worker e proxy
#  10. validação     — healthchecks, exposição, scheduler desligado
#
# IDEMPOTENTE: correr duas vezes não destrói nada. Os segredos nunca são
# regenerados (só derivados dos existentes), os dados do PostgreSQL nunca
# são tocados, e as migrations são `deploy` — aplicam o que falta e não
# mais do que isso.
#
# NÃO cria tenants, não importa catálogo e não liga o scheduler.
#
# Uso:
#   sudo ./install-stack.sh [--no-build] [--skip-migrations] [flags comuns]
#
# Saída: 0 ok · 1 falha · 2 pré-condição · 3 pós-condição · 4 uso · 5 lock

set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd)
APP_DIR="${SPHARMMT_ROOT}/app"
DOCKER_SRC="${REPO_ROOT}/deploy/docker"

NO_BUILD=0
SKIP_MIGRATIONS=0
SKIP_UP=0
HEALTH_TIMEOUT=240
APP_TAG="local"

usage() {
  cat <<EOF
Uso: sudo $0 [opções]

  --no-build            Não reconstrói a imagem (usa a existente)
  --skip-migrations     Não corre \`prisma migrate deploy\` (raramente correcto)
  --skip-up             Prepara tudo mas não sobe a stack
  --tag <nome>          Tag da imagem. Default: ${APP_TAG}
  --health-timeout <s>  Espera máxima pelos healthchecks. Default: ${HEALTH_TIMEOUT}
$(common_flags_help)

Pré-requisitos: bootstrap-vps.sh e install-platform.sh já corridos.
Não cria tenants, não importa catálogo, não liga o scheduler.
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --no-build) NO_BUILD=1; shift ;;
    --skip-migrations) SKIP_MIGRATIONS=1; shift ;;
    --skip-up) SKIP_UP=1; shift ;;
    --tag) APP_TAG=${2:?}; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die_usage "opção desconhecida: $1" ;;
  esac
done

OWNER="${SPHARMMT_USER}:${SPHARMMT_GROUP}"
APP_REVISION="unknown"

# Wrapper do compose com o perfil `tools` activo — é o que torna o
# serviço `migrate` visível ao `build` e ao `run`.
dct() {
  local args=(-f "$SPHARMMT_COMPOSE_FILE" -p spharmmt --profile tools)
  [ -f "$SPHARMMT_ENV_FILE" ] && args+=(--env-file "$SPHARMMT_ENV_FILE")
  [ -f "$SPHARMMT_STACK_ENV_FILE" ] && args+=(--env-file "$SPHARMMT_STACK_ENV_FILE")
  docker compose "${args[@]}" "$@"
}

# ═════════════════════════════════════════════════════════════════════════
preflight() {
  step "Pré-condições"
  require_root
  require_cmd docker install awk sed tar
  docker compose version >/dev/null 2>&1 || die_precond "docker compose v2 ausente — corre install-docker.sh"

  [ -f "$SPHARMMT_CONF_FILE" ] || die_precond "${SPHARMMT_CONF_FILE} não existe — corre install-platform.sh primeiro"
  [ -f "$SPHARMMT_SECRETS_FILE" ] || die_precond "${SPHARMMT_SECRETS_FILE} não existe — corre install-platform.sh primeiro"
  [ -f "$SPHARMMT_ENV_FILE" ] || die_precond "${SPHARMMT_ENV_FILE} não existe — corre install-platform.sh primeiro"

  # O volume de dados TEM de estar montado antes de o PostgreSQL escrever
  # o que quer que seja: um cluster inicializado sobre o ponto de montagem
  # vazio fica escondido assim que o disco montar, e a base "perde" tudo.
  require_data_root_mounted

  id "$SPHARMMT_USER" >/dev/null 2>&1 || die_precond "utilizador ${SPHARMMT_USER} não existe"
  docker network inspect "$SPHARMMT_NETWORK" >/dev/null 2>&1 \
    || die_precond "rede docker ${SPHARMMT_NETWORK} não existe — corre install-platform.sh"

  # Este script tem de correr a partir do CHECKOUT do repositório: precisa
  # do Dockerfile, do compose e dos scripts de init que estão ao lado dele.
  # A partir de /opt/spharmmt/scripts nada disto existe — e é por isso que
  # o install-platform.sh não o instala lá.
  if [ ! -f "${DOCKER_SRC}/docker-compose.yml" ] || [ ! -f "${DOCKER_SRC}/Dockerfile" ]; then
    err "não encontro os artefactos da stack em ${DOCKER_SRC}"
    err "este script corre a partir do repositório, não de ${SPHARMMT_ROOT}/scripts:"
    err "    cd /tmp/spharmmt/deploy/scripts && sudo ./install-stack.sh"
    DIE_CODE=$EX_PRECOND die "artefactos da stack não encontrados"
  fi

  # O build da imagem descomprime node_modules e o Chromium; 10 GB é o
  # mínimo com que isto passa sem encher o disco a meio.
  require_free_space / 10240

  if [ -d "${REPO_ROOT}/.git" ] && has_cmd git; then
    APP_REVISION=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
  fi
  ok "pré-condições satisfeitas · revisão ${APP_REVISION}"
}

# ═════════════════════════════════════════════════════════════════════════
# 1. Código
# ═════════════════════════════════════════════════════════════════════════
#
# A imagem é construída a partir de ${SPHARMMT_ROOT}/app e não do sítio
# onde este script está. Razão: o `build.context` do compose é relativo ao
# compose instalado, e o update-platform.sh reconstrói a partir dele sem
# saber onde o repositório foi clonado.
install_source() {
  step "1. Código da aplicação"
  ensure_dir "$APP_DIR" 2750 "$OWNER"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] copiaria ${REPO_ROOT} → ${APP_DIR}"
    return 0
  fi

  if [ -d "${REPO_ROOT}/.git" ] && has_cmd git; then
    # `git archive` exporta exactamente o que está versionado em HEAD:
    # sem node_modules, sem .next, sem ficheiros locais por commitar.
    # Uma cópia recursiva traria centenas de MB e, pior, artefactos de
    # build da máquina de origem que não correspondem a este servidor.
    info "a exportar HEAD (${APP_REVISION}) para ${APP_DIR}..."
    rm -rf "${APP_DIR:?}"/*
    git -C "$REPO_ROOT" archive --format=tar HEAD | tar -x -C "$APP_DIR"
  elif has_cmd rsync; then
    warn "${REPO_ROOT} não é um repositório git — a copiar com rsync e exclusões"
    rsync -a --delete \
      --exclude='node_modules' --exclude='.next' --exclude='logs' \
      --exclude='dist-agent' --exclude='dist-admin' --exclude='.env*' \
      "${REPO_ROOT}/" "${APP_DIR}/"
  else
    die_precond "sem git nem rsync — não consigo instalar o código de forma previsível"
  fi

  chown -R "$OWNER" "$APP_DIR"
  # `git archive` não preserva o bit de execução em todos os casos e o
  # entrypoint tem de o ter dentro da imagem.
  chmod 0755 "${APP_DIR}/deploy/docker/entrypoint.sh" 2>/dev/null || true

  local n; n=$(find "$APP_DIR" -type f | wc -l)
  ok "${n} ficheiros em ${APP_DIR}"
}

# ═════════════════════════════════════════════════════════════════════════
# 2. Artefactos da stack
# ═════════════════════════════════════════════════════════════════════════
install_artifacts() {
  step "2. Artefactos da stack"

  ensure_dir "$(dirname "$SPHARMMT_COMPOSE_FILE")" 2750 "$OWNER"
  run install -m 0640 -o "$SPHARMMT_USER" -g "$SPHARMMT_GROUP" \
    "${DOCKER_SRC}/docker-compose.yml" "$SPHARMMT_COMPOSE_FILE"
  ok "compose → ${SPHARMMT_COMPOSE_FILE}"

  # Init do PostgreSQL. 0755: o entrypoint do container corre-os como
  # utilizador `postgres`, que não é o dono destes ficheiros no host.
  ensure_dir "${SPHARMMT_PG_DIR}/init" 2755 "$OWNER"
  local f
  for f in "${DOCKER_SRC}"/postgres/init/*.sh; do
    [ -f "$f" ] || continue
    run install -m 0755 -o "$SPHARMMT_USER" -g "$SPHARMMT_GROUP" "$f" "${SPHARMMT_PG_DIR}/init/$(basename "$f")"
    ok "init postgres → $(basename "$f")"
  done

  ensure_dir "${SPHARMMT_ROOT}/proxy/conf" 2755 "$OWNER"
  ensure_dir "${SPHARMMT_ROOT}/proxy/certs" 2750 "$OWNER"
  for f in "${DOCKER_SRC}"/proxy/*.conf; do
    [ -f "$f" ] || continue
    run install -m 0644 -o "$SPHARMMT_USER" -g "$SPHARMMT_GROUP" "$f" "${SPHARMMT_ROOT}/proxy/conf/$(basename "$f")"
    ok "proxy → $(basename "$f")"
  done
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Segredos derivados, por serviço
# ═════════════════════════════════════════════════════════════════════════
#
# NENHUM segredo é gerado aqui. Os valores saem todos de
# ${SPHARMMT_SECRETS_FILE}, que é a fonte de verdade e nunca é reescrito
# por este script.
#
# Porquê derivar em vez de montar o ficheiro mestre em todos os
# serviços: o PostgreSQL não tem nada que ver com TENANT_ENCRYPTION_SECRET
# (que decifra as credenciais de TODOS os tenants), nem a aplicação com a
# password de superutilizador da base. Um `docker inspect` a um container,
# ou um dump do seu ambiente num log de erro, expõe só o subconjunto
# daquele serviço.
derive_secrets() {
  step "3. Segredos por serviço"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] derivaria postgres.secrets.env e app.secrets.env"
    return 0
  fi

  # Ficheiro de segredos gerado em runtime — o caminho não é constante.
  set -a
  # shellcheck disable=SC1090
  . "$SPHARMMT_SECRETS_FILE"
  set +a

  # `printenv` e não `${!k}`: as variáveis vêm de `set -a` + source,
  # portanto estão exportadas, e a expansão indirecta faz o ShellCheck
  # confundir a variável com um array (SC2178/SC2128).
  local missing_secrets=""
  local k
  for k in POSTGRES_SUPERUSER_PASSWORD POSTGRES_APP_PASSWORD AUTH_SECRET \
           TENANT_ENCRYPTION_SECRET EMAIL_CONFIG_SECRET CRON_SECRET ADMIN_API_TOKEN; do
    [ -n "$(printenv "$k" 2>/dev/null || true)" ] || missing_secrets="${missing_secrets} ${k}"
  done
  [ -z "${missing_secrets// /}" ] || die_precond "segredos em falta em ${SPHARMMT_SECRETS_FILE}:${missing_secrets}"

  local pg_file="${SPHARMMT_ROOT}/secrets/postgres.secrets.env"
  local app_file="${SPHARMMT_ROOT}/secrets/app.secrets.env"

  # `install -m 0600 /dev/null` cria o ficheiro já com o modo certo: um
  # `> ficheiro` seguido de `chmod` deixa uma janela em que o conteúdo
  # está escrito e ainda legível por outros.
  install -m 0600 -o root -g root /dev/null "$pg_file"
  {
    printf '# %s\n' "$pg_file"
    printf '# DERIVADO de %s por install-stack.sh. Não editar à mão.\n' "$SPHARMMT_SECRETS_FILE"
    printf '# Só o que o container do PostgreSQL precisa.\n'
    # A imagem oficial do PostgreSQL espera POSTGRES_PASSWORD; o nome
    # canónico nos nossos segredos é POSTGRES_SUPERUSER_PASSWORD. É o
    # mesmo valor, com o nome que cada lado exige.
    printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_SUPERUSER_PASSWORD"
    printf 'POSTGRES_APP_PASSWORD=%s\n' "$POSTGRES_APP_PASSWORD"
  } >> "$pg_file"
  chmod 0600 "$pg_file"; chown root:root "$pg_file"
  ok "postgres.secrets.env (2 chaves, 0600 root:root)"

  install -m 0600 -o root -g root /dev/null "$app_file"
  {
    printf '# %s\n' "$app_file"
    printf '# DERIVADO de %s por install-stack.sh. Não editar à mão.\n' "$SPHARMMT_SECRETS_FILE"
    printf '# Só o que a aplicação, o worker e as migrations precisam.\n'
    printf '# SEM a password de superutilizador do PostgreSQL.\n'
    printf 'POSTGRES_APP_PASSWORD=%s\n' "$POSTGRES_APP_PASSWORD"
    printf 'AUTH_SECRET=%s\n' "$AUTH_SECRET"
    printf 'TENANT_ENCRYPTION_SECRET=%s\n' "$TENANT_ENCRYPTION_SECRET"
    printf 'EMAIL_CONFIG_SECRET=%s\n' "$EMAIL_CONFIG_SECRET"
    printf 'CRON_SECRET=%s\n' "$CRON_SECRET"
    printf 'ADMIN_API_TOKENS=%s\n' "$ADMIN_API_TOKEN"
  } >> "$app_file"
  chmod 0600 "$app_file"; chown root:root "$app_file"
  ok "app.secrets.env (6 chaves, 0600 root:root)"

  enforce_secret_file_modes
}

# ═════════════════════════════════════════════════════════════════════════
# 4. stack.env — configuração de interpolação do compose
# ═════════════════════════════════════════════════════════════════════════
#
# Ficheiro SEPARADO do platform.env, e não é arrumação: o
# install-platform.sh reescreve o platform.env por inteiro a cada
# execução. Chaves da stack escritas lá desapareciam na reinstalação
# seguinte da plataforma e a stack deixava de subir, com um erro
# ("build context não encontrado") que não aponta para a causa.
#
# Aqui só entra o que o compose INTERPOLA — caminhos, tags e binds. A
# configuração que os containers recebem continua no platform.env.
# Nenhum segredo, nem aqui nem lá.
write_stack_env() {
  step "4. Configuração da stack"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] escreveria ${SPHARMMT_STACK_ENV_FILE}"
    return 0
  fi

  # A exposição do proxy é uma decisão do operador: se já a mudou, é
  # preservada. Reabrir o 127.0.0.1 por cima seria desfazer-lhe o
  # trabalho; fechá-lo por cima seria uma paragem não anunciada.
  local bind="127.0.0.1" port="8080"
  if [ -f "$SPHARMMT_STACK_ENV_FILE" ]; then
    local prev_bind prev_port
    prev_bind=$(awk -F= '/^PROXY_BIND=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" || true)
    prev_port=$(awk -F= '/^PROXY_HTTP_PORT=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" || true)
    [ -n "$prev_bind" ] && bind="$prev_bind"
    [ -n "$prev_port" ] && port="$prev_port"
  fi

  write_file "$SPHARMMT_STACK_ENV_FILE" 0640 "$OWNER" <<EOF
# ${SPHARMMT_STACK_ENV_FILE}
# Gerido por install-stack.sh. Só variáveis de INTERPOLAÇÃO do compose —
# nada disto é entregue dentro dos containers, e nada disto é segredo.
# A configuração de runtime da aplicação está em ${SPHARMMT_ENV_FILE}.

# ── Build ────────────────────────────────────────────────────────────
# Onde vive a árvore de código a partir da qual a imagem é construída.
APP_BUILD_CONTEXT=${APP_DIR}
APP_IMAGE=spharmmt-app
APP_TAG=${APP_TAG}
APP_REVISION=${APP_REVISION}
INSTALL_CHROMIUM=1

# ── Caminhos e nomes ─────────────────────────────────────────────────
SPHARMMT_ROOT=${SPHARMMT_ROOT}
SPHARMMT_ENV_FILE=${SPHARMMT_ENV_FILE}
SPHARMMT_NETWORK=${SPHARMMT_NETWORK}
SPHARMMT_PG_CONTAINER=${SPHARMMT_PG_CONTAINER}
SPHARMMT_APP_CONTAINER=${SPHARMMT_APP_CONTAINER}
SPHARMMT_WORKER_CONTAINER=spharmmt-worker
SPHARMMT_PROXY_CONTAINER=${SPHARMMT_PROXY_CONTAINER}
PORT=3000

# ── Dados (bind mounts do PostgreSQL) ────────────────────────────────
POSTGRES_DATA_DIR=${SPHARMMT_POSTGRES_DATA_DIR}
POSTGRES_INIT_DIR=${SPHARMMT_PG_DIR}/init
# Montado em /backups:ro dentro do PostgreSQL — é o que permite ao
# restore-platform.sh usar pg_restore com -j (impossível a partir do stdin).
BACKUP_DIR=${SPHARMMT_BACKUP_DIR}

# ── Exposição do proxy ───────────────────────────────────────────────
# 127.0.0.1 = FECHADO ao exterior. A UFW não chega para fechar um porto
# publicado pelo Docker (as regras dele são avaliadas antes), portanto o
# que fecha isto é mesmo o endereço de bind.
#
# Para abrir, depois de a stack estar validada:
#   PROXY_BIND=0.0.0.0
#   PROXY_HTTP_PORT=80
#   sudo ufw allow 80/tcp
#   sudo ${SPHARMMT_ROOT}/scripts/update-platform.sh --no-build
PROXY_BIND=${bind}
PROXY_HTTP_PORT=${port}
EOF

  ok "configuração da stack em ${SPHARMMT_STACK_ENV_FILE}"
  info "  contexto de build : ${APP_DIR}"
  info "  imagem            : spharmmt-app:${APP_TAG} (rev ${APP_REVISION})"
  info "  proxy             : ${bind}:${port}"
  if [ "$bind" = "127.0.0.1" ]; then
    info "  exposição         : FECHADA ao exterior"
  else
    warn "  exposição         : ${bind} — acessível fora do servidor"
  fi
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
# 5. Validação do compose
# ═════════════════════════════════════════════════════════════════════════
validate_compose() {
  step "5. Validação do compose"
  if ! dct config >/dev/null 2>&1; then
    dct config >/dev/null || true
    die "docker compose config inválido — nada foi alterado na stack"
  fi
  ok "docker compose config válido"

  # Rede de segurança contra a falha mais cara desta arquitectura: um
  # `ports:` no PostgreSQL publica a base na Internet, porque as regras
  # iptables do Docker são avaliadas ANTES das da UFW.
  #
  # `--no-env-resolution`: sem esta flag o compose lê os `env_file` e
  # imprime as passwords no output. Aqui só interessa a estrutura.
  if dct config --no-env-resolution | awk '/^  postgres:/,/^  [a-z]/' | grep -qE '^\s+ports:'; then
    die "o serviço postgres tem \`ports:\` — a base ficaria exposta. Recusado."
  fi
  ok "postgres sem portos publicados"
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
# 6. Build
# ═════════════════════════════════════════════════════════════════════════
build_images() {
  step "6. Imagem da aplicação"
  if [ "$NO_BUILD" = "1" ]; then info "ignorado (--no-build)"; return 0; fi
  info "a construir (a primeira vez demora — npm ci + next build + chromium)..."
  run dct build --pull web migrate
  ok "imagens construídas"
}

# ═════════════════════════════════════════════════════════════════════════
# 7. PostgreSQL
# ═════════════════════════════════════════════════════════════════════════
start_postgres() {
  step "7. PostgreSQL"
  [ "$SKIP_UP" = "1" ] && { info "ignorado (--skip-up)"; return 0; }

  local first_run=0
  [ -d "${SPHARMMT_POSTGRES_DATA_DIR}/pgdata" ] || first_run=1

  run dct up -d postgres
  if [ "$DRY_RUN" = "1" ]; then return 0; fi

  if [ "$first_run" = "1" ]; then
    info "primeira inicialização: initdb + criação das bases (pode demorar ~1 min)"
  fi

  wait_container_healthy "$SPHARMMT_PG_CONTAINER" "$HEALTH_TIMEOUT" \
    || die "PostgreSQL não ficou healthy em ${HEALTH_TIMEOUT}s (docker logs ${SPHARMMT_PG_CONTAINER})"
  ok "PostgreSQL healthy"

  # Numa instalação sobre um cluster já existente, o init do entrypoint
  # não corre (só corre com PGDATA vazio). Correr o script à mão fecha
  # essa lacuna — e é idempotente de propósito para isto ser seguro.
  if [ "$first_run" = "0" ]; then
    info "cluster pré-existente — a reaplicar o init idempotente..."
    if dct exec -T postgres bash /docker-entrypoint-initdb.d/10-databases.sh; then
      ok "init reaplicado"
    else
      warn "o init devolveu erro — ver acima. As bases existentes NÃO foram alteradas."
    fi
  fi
  return 0
}

# wait_container_healthy <nome> <timeout_s>
wait_container_healthy() {
  local name=$1 timeout=$2
  local deadline=$(( $(date +%s) + timeout )) state health
  while [ "$(date +%s)" -lt "$deadline" ]; do
    state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo none)
    case "${state}:${health}" in
      running:healthy|running:none) return 0 ;;
      exited:*|dead:*) return 1 ;;
    esac
    sleep 3
  done
  return 1
}

# ═════════════════════════════════════════════════════════════════════════
# 8. Migrations
# ═════════════════════════════════════════════════════════════════════════
run_migrations() {
  step "8. Migrations"
  if [ "$SKIP_MIGRATIONS" = "1" ]; then
    warn "ignoradas (--skip-migrations) — a aplicação vai falhar se o schema não estiver aplicado"
    return 0
  fi
  [ "$SKIP_UP" = "1" ] && { info "ignorado (--skip-up)"; return 0; }
  if [ "$DRY_RUN" = "1" ]; then info "[dry-run] correria as migrations"; return 0; fi

  # Container efémero, separado do build e do arranque da web. O código
  # de saída decide se a stack sobe: uma aplicação servida sobre um
  # schema desactualizado falha nos sítios mais difíceis de diagnosticar.
  if dct run --rm migrate; then
    ok "migrations aplicadas (control plane + legacy + tenants)"
  else
    die "migrations falharam — a aplicação NÃO foi arrancada"
  fi
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
# 9. Stack
# ═════════════════════════════════════════════════════════════════════════
start_stack() {
  step "9. Aplicação, worker e proxy"
  [ "$SKIP_UP" = "1" ] && { info "ignorado (--skip-up)"; return 0; }

  # Sem `--profile tools`: o `migrate` é um trabalho pontual e não pode
  # ficar de pé com a stack.
  run dc up -d --remove-orphans postgres web worker proxy
  if [ "$DRY_RUN" = "1" ]; then return 0; fi

  local c
  for c in "$SPHARMMT_APP_CONTAINER" spharmmt-worker "$SPHARMMT_PROXY_CONTAINER"; do
    if wait_container_healthy "$c" "$HEALTH_TIMEOUT"; then
      ok "${c} healthy"
    else
      err "${c} não ficou healthy em ${HEALTH_TIMEOUT}s"
      docker logs --tail 40 "$c" 2>&1 | sed 's/^/    /' || true
      die "stack incompleta"
    fi
  done
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
postflight() {
  step "Validação"

  check "compose config válido"            dct config --no-env-resolution
  check "código instalado"                 test -f "${APP_DIR}/package.json"
  check "compose instalado"                test -f "$SPHARMMT_COMPOSE_FILE"
  check "stack.env instalado"              test -f "$SPHARMMT_STACK_ENV_FILE"
  check "stack.env sem segredos"     bash -c "! grep -qE '^(AUTH_SECRET|TENANT_ENCRYPTION_SECRET|POSTGRES_[A-Z_]*PASSWORD|CRON_SECRET)=' $SPHARMMT_STACK_ENV_FILE"
  check "init do postgres instalado"       test -x "${SPHARMMT_PG_DIR}/init/10-databases.sh"
  check "configuração do proxy instalada"  test -f "${SPHARMMT_ROOT}/proxy/conf/spharmmt.conf"

  for f in postgres.secrets.env app.secrets.env; do
    check "segredo derivado ${f}"          test -f "${SPHARMMT_ROOT}/secrets/${f}"
    check "${f} a 0600 root:root" \
      bash -c "[ \"\$(stat -c '%a %U:%G' ${SPHARMMT_ROOT}/secrets/${f})\" = '600 root:root' ]"
  done
  check "app.secrets.env SEM a password de superutilizador" \
    bash -c "! grep -q '^POSTGRES_PASSWORD=' ${SPHARMMT_ROOT}/secrets/app.secrets.env"
  check "postgres.secrets.env SEM a chave dos tenants" \
    bash -c "! grep -q '^TENANT_ENCRYPTION_SECRET=' ${SPHARMMT_ROOT}/secrets/postgres.secrets.env"

  if [ "$SKIP_UP" = "1" ]; then
    check_skip "stack a correr" "--skip-up"
    report "Stack — validação"
    return 0
  fi

  check "postgres a correr"                container_running "$SPHARMMT_PG_CONTAINER"
  check "postgres aceita ligações"         docker exec "$SPHARMMT_PG_CONTAINER" pg_isready -q
  check "postgres NÃO publica portos" \
    bash -c "[ -z \"\$(docker port ${SPHARMMT_PG_CONTAINER} 2>/dev/null)\" ]"
  check "web a correr"                     container_running "$SPHARMMT_APP_CONTAINER"
  check "web NÃO publica portos" \
    bash -c "[ -z \"\$(docker port ${SPHARMMT_APP_CONTAINER} 2>/dev/null)\" ]"
  check "worker a correr"                  container_running spharmmt-worker
  check "proxy a correr"                   container_running "$SPHARMMT_PROXY_CONTAINER"

  # O scheduler tem de estar desligado nesta fase. Verificado no ambiente
  # REAL do container, não no ficheiro — é o que o processo vê.
  check "scheduler DESLIGADO" \
    bash -c "[ \"\$(docker exec spharmmt-worker printenv SCHEDULER_ENABLED 2>/dev/null || echo 0)\" != '1' ]"

  local bind; bind=$(awk -F= '/^PROXY_BIND=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" 2>/dev/null || echo "")
  if [ "${bind:-127.0.0.1}" = "127.0.0.1" ]; then
    check "proxy fechado ao exterior (bind 127.0.0.1)" \
      bash -c "docker port ${SPHARMMT_PROXY_CONTAINER} 2>/dev/null | grep -q '127.0.0.1'"
  else
    check_warn "proxy publicado em ${bind} — exposto à rede" true
  fi

  local port; port=$(awk -F= '/^PROXY_HTTP_PORT=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" 2>/dev/null || echo 8080)
  check "proxy responde"                   bash -c "curl -fsS -o /dev/null -m 10 http://127.0.0.1:${port:-8080}/healthz"
  check "aplicação responde através do proxy" \
    bash -c "curl -fsS -m 20 http://127.0.0.1:${port:-8080}/api/health | grep -q '\"status\"'"

  check "postgres com healthcheck" \
    bash -c "[ \"\$(docker inspect ${SPHARMMT_PG_CONTAINER} -f '{{if .State.Health}}yes{{end}}')\" = yes ]"
  check "limites de memória em todos os containers" \
    bash -c "! dc ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{.HostConfig.Memory}}' | grep -q ' 0\$'"
  check "no-new-privileges em todos os containers" \
    bash -c "! dc ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{.HostConfig.SecurityOpt}}' | grep -qv 'no-new-privileges'"

  report "Stack — validação"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  log_init
  acquire_lock stack
  banner "install-stack"
  preflight
  install_source
  install_artifacts
  derive_secrets
  write_stack_env
  validate_compose
  build_images
  start_postgres
  run_migrations
  start_stack

  local rc=0
  postflight || rc=$?

  printf '\n'
  if [ "$rc" -eq 0 ]; then
    local port; port=$(awk -F= '/^PROXY_HTTP_PORT=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" 2>/dev/null || echo 8080)
    ok "stack instalada e validada."
    printf '\n'
    info "Acesso local:      curl http://127.0.0.1:${port:-8080}/api/health"
    info "Acesso remoto:     ssh -L ${port:-8080}:127.0.0.1:${port:-8080} ${SPHARMMT_USER}@<ip>"
    info "                   e abrir http://127.0.0.1:${port:-8080} no browser"
    info "Estado:            sudo ${SPHARMMT_ROOT}/scripts/verify-platform.sh"
    info "Logs:              docker compose -f ${SPHARMMT_COMPOSE_FILE} -p spharmmt logs -f web"
    printf '\n'
    warn "O scheduler está DESLIGADO (SCHEDULER_ENABLED=0) e nenhum tenant foi criado."
    warn "As portas 80/443 continuam fechadas: o proxy só ouve em 127.0.0.1."
  fi
  finish "$rc"
}

main "$@"
