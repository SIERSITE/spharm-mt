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
# Avisa quando a working tree diverge de HEAD. Não bloqueia: pode ser
# perfeitamente legítimo ter trabalho por commitar num checkout. Mas o
# que vai para o servidor é HEAD, e a diferença tem de ser VISÍVEL —
# descobri-la através de um `COPY: not found` a meio de um build de 10
# minutos é a pior forma possível.
warn_uncommitted() {
  local staged untracked modified
  staged=$(git -C "$REPO_ROOT" diff --cached --name-only HEAD --diff-filter=A 2>/dev/null | wc -l)
  modified=$(git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null | wc -l)
  untracked=$(git -C "$REPO_ROOT" ls-files --others --exclude-standard 2>/dev/null | wc -l)

  if [ "$staged" -eq 0 ] && [ "$modified" -eq 0 ] && [ "$untracked" -eq 0 ]; then
    ok "working tree limpa — HEAD é exactamente o que vai ser instalado"
    return 0
  fi

  warn "a working tree DIVERGE de HEAD, e é HEAD que vai para o servidor:"
  [ "$staged" -gt 0 ]    && warn "  ${staged} ficheiro(s) em stage mas por COMMITAR — NÃO serão instalados"
  [ "$modified" -gt 0 ]  && warn "  ${modified} ficheiro(s) alterado(s) face a HEAD — a versão de HEAD é que conta"
  [ "$untracked" -gt 0 ] && warn "  ${untracked} ficheiro(s) não versionado(s) — ignorados"

  if [ "$staged" -gt 0 ]; then
    warn "  em stage por commitar (primeiros 10):"
    # Sem `| head`: o git é um produtor que pode ter muitas linhas e o
    # head fecha o pipe cedo — SIGPIPE, rc=141 sob pipefail. É a mesma
    # classe de falha que rebentou a geração de segredos. A lista é
    # pequena e finita: lê-se inteira e conta-se aqui.
    local listed=0 f
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      listed=$((listed + 1))
      [ "$listed" -le 10 ] && warn "    ${f}"
    done < <(git -C "$REPO_ROOT" diff --cached --name-only HEAD --diff-filter=A 2>/dev/null)
    [ "$listed" -gt 10 ] && warn "    ... e mais $((listed - 10))"
  fi
  warn "Se algum destes for necessário ao build, commita-o antes de continuar."
  return 0
}

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
    #
    # A CONSEQUÊNCIA, que já custou um build falhado: um ficheiro que
    # existe no disco mas ainda não foi commitado NÃO chega aqui. O
    # `prisma-control.config.ts` estava em `git add` sem commit — o build
    # local passava (usa a working tree) e o da VPS falhava com
    # "/prisma-control.config.ts: not found", sem qualquer indicação de
    # que o problema era o commit em falta.
    warn_uncommitted
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

  # ── Proxy ────────────────────────────────────────────────────────────
  # Instalação EXPLÍCITA, sem glob. Um `for f in .../*.conf` que não casa
  # com nada não instala ficheiro nenhum e não diz nada: o nginx arranca
  # sem `server {}`, não escuta em porto algum, e o sintoma é um
  # "Connection refused" que não aponta para a configuração em falta.
  # 0755/0644, nunca a política genérica 2750 — ver ensure_proxy_dirs em
  # lib/common.sh para a razão (o nginx do container é outro uid).
  ensure_proxy_dirs "$OWNER"

  local src="${DOCKER_SRC}/proxy/spharmmt.conf"
  [ -f "$src" ] || die_precond "configuração do nginx não encontrada em ${src}"
  run install -m 0644 -o "$SPHARMMT_USER" -g "$SPHARMMT_GROUP" "$src" "$SPHARMMT_PROXY_CONF_FILE"
  ok "proxy → ${SPHARMMT_PROXY_CONF_FILE}"
  # Reafirmado depois de instalar: o `install` acima já põe 0644, mas
  # ficheiros de execuções anteriores podem estar noutro modo.
  ensure_proxy_dirs "$OWNER"

  # ── Scripts operacionais ─────────────────────────────────────────────
  # Refrescados AQUI também, e não só pelo install-platform.sh. O
  # operador corre `sudo /opt/spharmmt/scripts/verify-platform.sh`, não o
  # do checkout: sem isto, um `git pull` seguido de install-stack.sh
  # deixava o verificador a validar com as regras da versão anterior — foi
  # assim que ele reprovou um PGDATA que este mesmo script tinha acabado
  # de pôr correcto.
  install_operational_scripts "$SCRIPT_DIR" "$OWNER"

  # Caminho antigo, FORA do que o compose monta. Um ficheiro lá dá a
  # impressão de que a configuração está instalada quando o nginx nunca
  # a chega a ver.
  if [ -f "$SPHARMMT_PROXY_CONF_LEGACY" ] && [ "$DRY_RUN" != "1" ]; then
    backup_file "$SPHARMMT_PROXY_CONF_LEGACY"
    rm -f "$SPHARMMT_PROXY_CONF_LEGACY"
    warn "removido ${SPHARMMT_PROXY_CONF_LEGACY} — estava fora do mount e nunca foi lido pelo nginx"
  fi
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
# 2b. Validação do proxy — ANTES de lhe tocar
# ═════════════════════════════════════════════════════════════════════════
#
# Corre antes do `up`, e não depois: recriar o proxy com o conf.d vazio
# derruba o que estava a servir e substitui-o por um nginx sem
# `server {}`. Descobrir isso pelo healthcheck é descobrir tarde.
validate_proxy_conf() {
  step "2b. Configuração do nginx"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] validaria ${SPHARMMT_PROXY_CONF_FILE} e correria nginx -t"
    return 0
  fi

  [ -d "$SPHARMMT_PROXY_CONF_DIR" ] \
    || die "${SPHARMMT_PROXY_CONF_DIR} não existe — é este o directório montado em /etc/nginx/conf.d"
  [ -s "$SPHARMMT_PROXY_CONF_FILE" ] \
    || die "${SPHARMMT_PROXY_CONF_FILE} ausente ou vazio — o nginx arrancaria sem nenhum server{}"

  # O directório não pode estar vazio de .conf: é literalmente o que o
  # nginx carrega com `include /etc/nginx/conf.d/*.conf`.
  local nconf=0 f
  for f in "$SPHARMMT_PROXY_CONF_DIR"/*.conf; do
    [ -f "$f" ] && nconf=$((nconf + 1))
  done
  [ "$nconf" -gt 0 ] || die "${SPHARMMT_PROXY_CONF_DIR} não tem nenhum .conf — conf.d ficaria vazio"
  ok "${nconf} ficheiro(s) .conf em ${SPHARMMT_PROXY_CONF_DIR}"

  # Conteúdo mínimo. Um .conf sintacticamente válido mas sem `server` nem
  # `proxy_pass` passa no `nginx -t` e serve 404 a tudo.
  # `missing_directives` e não `missing`: o `require_cmd` do common.sh usa
  # `missing` como ARRAY e, com `-x`, o ShellCheck vê os dois nomes no
  # mesmo âmbito (SC2178/SC2128).
  local directive missing_directives=""
  for directive in 'server' 'listen' 'location' 'proxy_pass'; do
    grep -qE "^[[:space:]]*${directive}[[:space:]{]" "$SPHARMMT_PROXY_CONF_FILE" \
      || missing_directives="${missing_directives} ${directive}"
  done
  [ -z "${missing_directives// /}" ] \
    || die "configuração do nginx sem directivas essenciais:${missing_directives}"
  ok "server · listen · location · proxy_pass presentes"

  # Permissões vistas de FORA do dono. O bind mount preserva dono e modo,
  # e o nginx do container é outro uid: um directório sem bits para
  # "others" dá "Permission denied" no `ls /etc/nginx/conf.d` e o nginx
  # carrega zero `server {}` sem se queixar.
  local dmode fmode
  dmode=$(stat -c '%a' "$SPHARMMT_PROXY_CONF_DIR")
  fmode=$(stat -c '%a' "$SPHARMMT_PROXY_CONF_FILE")
  info "modos: ${SPHARMMT_PROXY_CONF_DIR}=${dmode} · $(basename "$SPHARMMT_PROXY_CONF_FILE")=${fmode}"
  [ -z "$(find "$SPHARMMT_PROXY_CONF_DIR" -maxdepth 0 ! -perm -o+rx 2>/dev/null)" ] \
    || die "${SPHARMMT_PROXY_CONF_DIR} está a ${dmode}: sem r-x para others o nginx do container não a consegue ler"
  [ -z "$(find "$SPHARMMT_PROXY_CONF_DIR" -maxdepth 1 -name '*.conf' ! -perm -o+r -print -quit 2>/dev/null)" ] \
    || die "há .conf sem leitura para others em ${SPHARMMT_PROXY_CONF_DIR} — o nginx não os carregaria"
  ok "conf.d atravessável e legível por qualquer uid (é configuração pública)"

  # Prova prática, com o utilizador real do container: `ls` como `nginx`.
  # Um teste feito como root passaria sempre e não diria nada.
  local image
  image=$(awk -F'image: ' '/image: nginx:/ {print $2; exit}' "$SPHARMMT_COMPOSE_FILE" | tr -d '\r')
  image=${image:-nginx:1.29-alpine}
  if docker run --rm --network none --user nginx \
       -v "${SPHARMMT_PROXY_CONF_DIR}:/etc/nginx/conf.d:ro" \
       "$image" ls /etc/nginx/conf.d >/dev/null 2>&1; then
    ok "utilizador nginx consegue listar /etc/nginx/conf.d"
  else
    die "o utilizador nginx NÃO consegue listar /etc/nginx/conf.d (dir a ${dmode}) — era isto que deixava o proxy sem server{}"
  fi

  # `nginx -t` com EXACTAMENTE o mount do compose. Um teste que use outro
  # caminho valida um cenário que não é o que vai correr.
  local image
  image=$(awk -F'image: ' '/image: nginx:/ {print $2; exit}' "$SPHARMMT_COMPOSE_FILE" | tr -d '\r')
  image=${image:-nginx:1.29-alpine}
  info "nginx -t (${image}) com ${SPHARMMT_PROXY_CONF_DIR} → /etc/nginx/conf.d"

  # `--add-host web:127.0.0.1`: o nginx resolve os nomes dos `upstream`
  # ao CARREGAR a configuração, e `web` ainda não está de pé nesta fase.
  # Sem isto, o `nginx -t` falhava com "host not found in upstream" — um
  # problema de ordem de arranque, não de configuração.
  # `--network none`: isto valida sintaxe e estrutura, não conectividade.
  local out rc=0
  out=$(docker run --rm --network none --add-host "web:127.0.0.1" \
          -v "${SPHARMMT_PROXY_CONF_DIR}:/etc/nginx/conf.d:ro" \
          "$image" nginx -t 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$out" | sed 's/^/    /'
    die "nginx -t falhou — o proxy NÃO foi tocado"
  fi
  ok "nginx -t: configuração válida"
  return 0
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
           TENANT_ENCRYPTION_SECRET EMAIL_CONFIG_SECRET CRON_SECRET ADMIN_API_TOKEN \
           POSTGRES_PROVISIONER_PASSWORD; do
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
    # Com esta, o script de init cria o role de aprovisionamento
    # (CREATEDB + CREATEROLE, SEM superuser) que a API de administração
    # usa para criar a base de um cliente novo.
    printf 'POSTGRES_PROVISIONER_PASSWORD=%s\n' "$POSTGRES_PROVISIONER_PASSWORD"
  } >> "$pg_file"
  chmod 0600 "$pg_file"; chown root:root "$pg_file"
  ok "postgres.secrets.env (3 chaves, 0600 root:root)"

  # ── Ferramentas administrativas ──────────────────────────────────────
  # Ficheiro TERCEIRO, montado SÓ pelo serviço `migrate`. Leva a password
  # de superutilizador porque `tenant:create --provider=local --create-db`
  # tem de fazer CREATE ROLE e CREATE DATABASE — coisas que o utilizador
  # da aplicação não pode (e não deve poder) fazer.
  #
  # Não vai para o app.secrets.env porque esse é montado pelo web e pelo
  # worker, que servem tráfego. Um RCE na aplicação passaria a valer o
  # superutilizador da base inteira em vez de uma base só.
  #
  # O POSTGRES_ADMIN_URL não é escrito aqui nem em lado nenhum: é
  # derivado em memória pelo entrypoint, nos modos de ferramentas.
  local tools_file="${SPHARMMT_ROOT}/secrets/tools.secrets.env"
  install -m 0600 -o root -g root /dev/null "$tools_file"
  {
    printf '# %s\n' "$tools_file"
    printf '# DERIVADO de %s por install-stack.sh. Não editar à mão.\n' "$SPHARMMT_SECRETS_FILE"
    printf '# Montado APENAS pelo serviço `migrate` (perfil tools).\n'
    printf '# NUNCA pelo web nem pelo worker.\n'
    printf 'POSTGRES_SUPERUSER_PASSWORD=%s\n' "$POSTGRES_SUPERUSER_PASSWORD"
  } >> "$tools_file"
  chmod 0600 "$tools_file"; chown root:root "$tools_file"
  ok "tools.secrets.env (1 chave, 0600 root:root, só o migrate)"

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
    # NÃO é a password de superutilizador. É um role que só pode criar
    # bases e roles, e existe porque a criação de clientes passou a ser
    # feita pela API — que corre no `web`. O entrypoint descarta-a no
    # worker: só o web precisa dela.
    printf 'POSTGRES_PROVISIONER_PASSWORD=%s\n' "$POSTGRES_PROVISIONER_PASSWORD"
  } >> "$app_file"
  chmod 0600 "$app_file"; chown root:root "$app_file"
  ok "app.secrets.env (7 chaves, 0600 root:root)"

  enforce_secret_file_modes
}

# persist_conf_key <chave> <valor> — grava em /etc/spharmmt/platform.conf.
#
# O platform.conf é escrito pelo install-platform.sh; aqui só se
# acrescentam ou actualizam chaves individuais, sem lhe tocar no resto.
# É o que faz o uid/gid do PostgreSQL sobreviver a uma reinstalação da
# plataforma — sem isso, o install-platform.sh voltava a assumir o
# default e a repor o dono errado no PGDATA.
persist_conf_key() {
  local key=$1 value=$2
  [ -f "$SPHARMMT_CONF_FILE" ] || return 0
  [ "$DRY_RUN" = "1" ] && return 0
  if grep -qE "^${key}=" "$SPHARMMT_CONF_FILE"; then
    sed -i "s|^${key}=.*|${key}=\"${value}\"|" "$SPHARMMT_CONF_FILE"
  else
    printf '%s="%s"\n' "$key" "$value" >> "$SPHARMMT_CONF_FILE"
  fi
  return 0
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

  # Lidas do platform.env, que é onde o operador as edita. Sem elas o
  # `next build` falha (em produção não há default seguro) — o que é
  # melhor do que entregar uma imagem onde ninguém consegue autenticar-se.
  local SERVER_ACTIONS_ALLOWED_ORIGINS PUBLIC_APP_URL_VALUE
  SERVER_ACTIONS_ALLOWED_ORIGINS=$(awk -F= '/^SERVER_ACTIONS_ALLOWED_ORIGINS=/ {sub(/^[^=]*=/,""); print; exit}' "$SPHARMMT_ENV_FILE" 2>/dev/null || true)
  PUBLIC_APP_URL_VALUE=$(awk -F= '/^PUBLIC_APP_URL=/ {sub(/^[^=]*=/,""); print; exit}' "$SPHARMMT_ENV_FILE" 2>/dev/null || true)

  if [ -z "$SERVER_ACTIONS_ALLOWED_ORIGINS" ] && [ -z "$PUBLIC_APP_URL_VALUE" ]; then
    err "nem SERVER_ACTIONS_ALLOWED_ORIGINS nem PUBLIC_APP_URL estão em ${SPHARMMT_ENV_FILE}"
    err "sem uma delas o build falha: o Next recusa Server Actions quando o Origin"
    err "do browser não bate com o Host, e é sempre esse o caso atrás do proxy."
    DIE_CODE=$EX_PRECOND die "origens das Server Actions por definir"
  fi
  case ",${SERVER_ACTIONS_ALLOWED_ORIGINS}," in
    *,\*,*) DIE_CODE=$EX_PRECOND die "SERVER_ACTIONS_ALLOWED_ORIGINS contém um curinga global (*) — recusado" ;;
  esac

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

# ── Build args que TÊM de entrar no bundle ───────────────────────────
# O Next fixa experimental.serverActions.allowedOrigins no bundle do
# servidor: não há forma de a ler em runtime. Copiadas do platform.env
# (onde o operador as edita) para aqui, que é o que o compose interpola
# como build arg. Mudar o platform.env exige reconstruir a imagem.
SERVER_ACTIONS_ALLOWED_ORIGINS=${SERVER_ACTIONS_ALLOWED_ORIGINS}
PUBLIC_APP_URL=${PUBLIC_APP_URL_VALUE}

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

# Directório montado em /etc/nginx/conf.d. É daqui que o nginx carrega os
# server{}; se estiver vazio, arranca e não escuta em porto nenhum.
PROXY_CONF_DIR=${SPHARMMT_PROXY_CONF_DIR}
PROXY_CERTS_DIR=${SPHARMMT_ROOT}/proxy/certs
# Montado em só-leitura no nginx e servido em /agent-base/. É daqui que o
# Admin Wizard descarrega o template do agent — sem passar por object
# storage externo.
AGENT_BASE_DIR=${SPHARMMT_ROOT}/agent-base
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

  assert_build_args_propagated
  return 0
}

# build_arg_value <serviço> <chave>
#
# Lê o valor JÁ INTERPOLADO de um build arg no `docker compose config`.
# É de propósito que não usa `--no-env-resolution`: o que interessa aqui
# é precisamente o valor depois da interpolação do stack.env — ver o
# `${VAR:-}` no ficheiro do compose é ver a sintaxe, não a propagação.
#
# O output do compose NUNCA é impresso (resolve os env_file e traria as
# passwords com ele): fica em variável e sai daqui só o campo pedido.
build_arg_value() {
  local svc=$1 key=$2
  dct config 2>/dev/null | awk -v svc="$svc" -v key="$key" '
    /^services:/            { in_services = 1; next }
    in_services && /^  [A-Za-z0-9._-]+:[[:space:]]*$/ {
      cur = $1; sub(/:$/, "", cur)
      in_svc = (cur == svc); in_build = 0; in_args = 0; next
    }
    in_svc && /^    build:/     { in_build = 1; in_args = 0; next }
    in_svc && /^    [A-Za-z]/   { in_build = 0; in_args = 0 }
    in_build && /^      args:/  { in_args = 1; next }
    in_build && /^      [A-Za-z]/ { in_args = 0 }
    in_args && /^        [A-Za-z0-9_]+:/ {
      line = $0; sub(/^[[:space:]]+/, "", line)
      k = line; sub(/:.*$/, "", k)
      if (k == key) {
        v = line; sub(/^[^:]*:[[:space:]]*/, "", v)
        gsub(/^"|"$/, "", v)
        print v; found = 1; exit 0
      }
    }
    # rc=1 = a chave NÃO existe naquele serviço. Distinto de "existe e
    # está vazia", que sai com rc=0 e linha vazia — confundir os dois
    # daria uma verificação que aprova um compose sem o build arg.
    END { if (!found) exit 1 }
  '
}

# Falha ANTES do build — que é o ponto: um `npm ci` seguido de um
# `next build` são minutos, e descobrir só no fim que a imagem saiu sem
# origens autorizadas custa esses minutos duas vezes.
#
# Os DOIS serviços são verificados. O `migrate` também constrói o
# `builder` (COPY --from=builder), portanto também precisa das duas.
assert_build_args_propagated() {
  local svc key value origins pub bad=0

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] verificação dos build args ignorada (stack.env não foi escrito)"
    return 0
  fi

  for svc in web migrate; do
    local declared=1
    for key in SERVER_ACTIONS_ALLOWED_ORIGINS PUBLIC_APP_URL; do
      if ! build_arg_value "$svc" "$key" >/dev/null; then
        err "o serviço ${svc} não declara o build arg ${key} em build.args"
        declared=0; bad=1
      fi
    done
    [ "$declared" = "1" ] || continue

    origins=$(build_arg_value "$svc" SERVER_ACTIONS_ALLOWED_ORIGINS)
    pub=$(build_arg_value "$svc" PUBLIC_APP_URL)

    # Vazias as duas = o `next build` vai falhar em produção. Mais vale
    # dizê-lo aqui, com o nome do ficheiro que se edita, do que deixar
    # rebentar dentro do Docker com um stack trace do Next.
    if [ -z "$origins" ] && [ -z "$pub" ]; then
      err "serviço ${svc}: SERVER_ACTIONS_ALLOWED_ORIGINS e PUBLIC_APP_URL chegam vazios ao build"
      err "corrigir em ${SPHARMMT_ENV_FILE} e voltar a correr este script"
      bad=1
    else
      ok "${svc}: origens no build = ${origins:-(derivadas de ${pub})}"
    fi
  done

  [ "$bad" = "0" ] || DIE_CODE=$EX_PRECOND die "build args por propagar — build não iniciado"
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

  # ── Dono do PGDATA, lido da IMAGEM ───────────────────────────────────
  # Não assumido: perguntado à imagem que o compose vai correr. Se um dia
  # a imagem mudar de uid, isto acompanha sem ninguém ter de saber de cor
  # que era 999.
  local pg_image ids
  pg_image=$(awk -F'image: ' '/image: postgres:/ {print $2; exit}' "$SPHARMMT_COMPOSE_FILE" | tr -d '\r')
  pg_image=${pg_image:-postgres:17.6-bookworm}
  if ids=$(pg_image_uid_gid "$pg_image"); then
    SPHARMMT_PG_UID=${ids%%:*}
    SPHARMMT_PG_GID=${ids##*:}
    ok "utilizador postgres da imagem ${pg_image}: ${SPHARMMT_PG_UID}:${SPHARMMT_PG_GID}"
    persist_conf_key SPHARMMT_PG_UID "$SPHARMMT_PG_UID"
    persist_conf_key SPHARMMT_PG_GID "$SPHARMMT_PG_GID"
  else
    warn "não consegui ler o uid/gid de ${pg_image} — a usar ${SPHARMMT_PG_UID}:${SPHARMMT_PG_GID}"
  fi

  # Aplicado ANTES do arranque, e só com o servidor parado. Com o
  # PostgreSQL de pé, ensure_pgdata_dir recusa-se a tocar e avisa.
  ensure_pgdata_dir

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
  # A cópia que o operador corre tem de ser a deste checkout. Uma
  # desactualizada valida com regras antigas e reprova o que está bem.
  check "scripts em ${SPHARMMT_ROOT}/scripts iguais aos do checkout" \
    installed_scripts_current "$SCRIPT_DIR"
  check "stack.env sem segredos"     bash -c "! grep -qE '^(AUTH_SECRET|TENANT_ENCRYPTION_SECRET|POSTGRES_[A-Z_]*PASSWORD|CRON_SECRET)=' $SPHARMMT_STACK_ENV_FILE"
  check "init do postgres instalado"       test -x "${SPHARMMT_PG_DIR}/init/10-databases.sh"
  check "configuração do proxy no caminho canónico" test -f "$SPHARMMT_PROXY_CONF_FILE"
  check "conf.d não vazio"                 bash -c "ls ${SPHARMMT_PROXY_CONF_DIR}/*.conf >/dev/null 2>&1"
  check "caminho antigo do proxy removido" bash -c "[ ! -f '$SPHARMMT_PROXY_CONF_LEGACY' ]"

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
  validate_proxy_conf
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
