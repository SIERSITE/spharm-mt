#!/usr/bin/env bash
# deploy/scripts/deploy-app.sh
#
# Deploy RÁPIDO da aplicação. Só `web` e `worker`, sem migrations e sem
# tocar em infraestrutura.
#
# ── Porque existe ────────────────────────────────────────────────────
#
# Para publicar uma correcção de front-end estava a correr-se
# `install-stack.sh --skip-up --skip-migrations`, que faz muito mais do
# que isso: exporta a árvore inteira do repositório para
# ${SPHARMMT_ROOT}/app, reinstala compose, init do PostgreSQL e
# configuração do nginx, redeeriva segredos, reescreve o stack.env,
# revalida o compose e constrói DUAS imagens (`web` e `migrate`) com
# `--pull`. O `--pull` é o mais caro dos passos escondidos: vai ao
# registo buscar `node:24-bookworm-slim` a cada corrida e, se o digest
# tiver mudado, invalida TODO o cache de camadas — incluindo o `npm ci`
# e o `apt-get install chromium`, que de outra forma nunca se repetem.
#
# Este script faz o mínimo: constrói UMA imagem a partir do clone e
# recria dois containers.
#
# ── O que NÃO faz, e é deliberado ────────────────────────────────────
#
#   · não corre migrations, e RECUSA-SE a correr se existirem;
#   · não constrói `postgres` nem `proxy`;
#   · não SOBE o `migrate` nem corre nada dentro dele.
#
# ── A imagem de ferramentas ──────────────────────────────────────────
#
# `web` e `worker` partilham uma imagem; o perfil `tools` (`migrate`) tem
# outra, a `-migrator`. Durante algum tempo este script construía só a
# primeira, e o resultado era silencioso e mau: depois de dois ou três
# deploys rápidos, `tenant:create`, `catalog:*`, `tenancy:*` e os
# diagnósticos corriam com o `lib/` de uma revisão antiga contra uma base
# de dados gerida por código novo. Ninguém dava por isso até um
# `Cannot find module` — e esse é o desfecho BOM. O mau é a função que
# ainda existe com a assinatura antiga e devolve outro número.
#
# Agora o script compara a revisão da imagem de tools com a revisão alvo
# e olha SÓ para os caminhos que entram nessa imagem (ver
# CAMINHOS_TOOLS). Se nada relevante mudou, não constrói nada — o deploy
# rápido continua rápido. Se mudou, constrói TAMBÉM a `-migrator`, e mais
# nada: sem migrations, sem `up`, sem tocar em serviço nenhum.
#   · não usa `down`, `down -v`, `prune`, `install-stack.sh` nem
#     `update-platform.sh`;
#   · não escreve em /data/postgres, nos backups, nos segredos, no
#     compose instalado nem na configuração do nginx.
#
# Para tudo o resto — migrations, alterações ao compose, ao nginx, aos
# segredos ou ao PostgreSQL — o caminho continua a ser o
# `install-stack.sh`. Este script é ADICIONAL, não substitui nenhum.
#
# Uso:
#   sudo ./deploy-app.sh                 # HEAD do clone detectado
#   sudo ./deploy-app.sh 2a95208         # uma revisão concreta
#   sudo ./deploy-app.sh --clone /srv/spharmmt 2a95208
#
# Saída: 0 ok · 1 falha (com rollback aplicado) · 2 pré-condição
#        3 aplicação publicada mas imagem de tools incoerente · 5 lock
set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

# O common.sh define os containers do postgres, da app e do proxy, mas
# nao o do worker (esse vive no stack.env). Com `set -u`, referencia-lo
# sem default rebentava o script.
: "${SPHARMMT_WORKER_CONTAINER:=spharmmt-worker}"

ALVO=""
CLONE="${SPHARMMT_CLONE:-}"
HEALTH_TIMEOUT=150
NO_CACHE=0
SKIP_MIGRATOR=0
FORCE_MIGRATOR=0
PUBLIC_URL_HEALTH="${SPHARMMT_PUBLIC_HEALTH_URL:-https://app.spharmmt.com/api/health}"
STATE_DIR="${SPHARMMT_ROOT}/monitoring/state"
STATE_FILE="${STATE_DIR}/last-app-image.txt"
# Ficheiro SEPARADO, e nao mais duas linhas no de cima: o rollback da
# aplicacao e o da imagem de tools sao decisoes independentes, e
# guarda-los juntos convida a repor os dois quando so' um esta' mal.
STATE_FILE_MIGRATOR="${STATE_DIR}/last-migrator-image.txt"

# O PGDATA que este servidor TEM de estar a usar. Não é configurável de
# propósito: o incidente de 2026-09-03 foi um container arrancado sem os
# env-files, que caiu no default `/opt/spharmmt/postgres/data` e fez
# initdb sobre um directório vazio. Se o valor não for este, algo está
# errado e este script não é a ferramenta para o resolver.
PGDATA_ESPERADO="/data/postgres/data"

usage() {
  cat <<EOF
Uso: sudo $0 [revisão] [opções]

  revisão              Commit/tag a publicar. Default: HEAD do clone.
  --clone <dir>        Clone git de onde construir. Default: detectado.
  --health-timeout <s> Espera máxima pelo healthcheck. Default: ${HEALTH_TIMEOUT}
  --no-cache           Constrói sem cache de camadas (lento; diagnóstico).
  --skip-migrator      Não constrói a imagem de tools, mesmo que precise.
                       Sai com 3 se isso deixar as revisões incoerentes.
  --force-migrator     Constrói a imagem de tools mesmo sem alterações.
$(common_flags_help)

Publica web/worker e, quando as alterações lhe tocam, reconstrói a
imagem do perfil tools (`-migrator`) — sem a subir e sem migrations.
Recusa-se a correr se houver migrations entre a revisão em produção e a
revisão alvo — nesse caso usa install-stack.sh.
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --clone) CLONE=${2:?}; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT=${2:?}; shift 2 ;;
    --no-cache) NO_CACHE=1; shift ;;
    --skip-migrator) SKIP_MIGRATOR=1; shift ;;
    --force-migrator) FORCE_MIGRATOR=1; shift ;;
    --help|-h) usage; exit 0 ;;
    -*) usage >&2; die_usage "opção desconhecida: $1" ;;
    *)
      [ -n "$ALVO" ] && { usage >&2; die_usage "revisão indicada duas vezes"; }
      ALVO=$1; shift ;;
  esac
done

# Estado partilhado entre as fases.
REV_ALVO=""        # sha curto do commit a publicar
REV_ANTERIOR=""    # APP_REVISION do container em produção
IMAGEM_ANTERIOR="" # id da imagem que serve web/worker agora
TAG_RESGATE=""     # tag dada à imagem anterior para o prune não a levar
CTX=""             # árvore temporária de onde se constrói (NUNCA o clone)
PG_ID_ANTES=""
PG_ARRANQUE_ANTES=""
APP_IMAGE_ACTUAL=""      # nome da imagem (stack.env, default spharmmt-app)
APP_TAG_ACTUAL=""        # tag da imagem (stack.env, default local)
IMAGEM_MIGRATOR=""       # <imagem>:<tag>-migrator
REV_MIGRATOR=""          # APP_REVISION carimbado nessa imagem
IMAGEM_MIGRATOR_ANTERIOR="" # id, para o rollback proprio
TAG_RESGATE_MIGRATOR=""
CONSTRUIR_MIGRATOR=0     # decidido em `portao_migrator`
MOTIVO_MIGRATOR=""

# ═════════════════════════════════════════════════════════════════════════
# O que entra na imagem do perfil `tools`.
#
# Nao e' uma lista de "coisas importantes" — e' a lista dos COPY do estagio
# `migrator` do deploy/docker/Dockerfile, mais o que os influencia. Se
# nenhum destes caminhos mudou entre a revisao da imagem e a revisao alvo,
# reconstrui-la produziria bit por bit a mesma coisa.
#
# `deploy/docker/Dockerfile` esta' ca' porque um COPY novo muda o conteudo
# sem que nenhum ficheiro de codigo tenha mudado — foi assim que os
# diagnosticos entraram na imagem.
#
# `generated/` NAO esta': o estagio faz `COPY --from=builder /app/generated`
# e o builder regenera-o com `prisma generate`. O que manda e' `prisma/`,
# que ja' esta' na lista; incluir `generated/` so' provocaria builds por
# causa de ficheiros que o proprio build reescreve.
# ═════════════════════════════════════════════════════════════════════════
CAMINHOS_TOOLS=(
  lib
  scripts
  prisma
  prisma-control
  prisma.config.ts
  prisma-control.config.ts
  package.json
  package-lock.json
  tsconfig.json
  deploy/docker/Dockerfile
  deploy/docker/entrypoint.sh
  deploy/docker/tools-scripts.txt
  deploy/docker/audit-tools-entrypoints.mjs
)

# A revisao carimbada DENTRO de uma imagem. Vazio se a imagem nao existe
# ou se nao tem carimbo — e essas duas respostas sao diferentes de "esta'
# actualizada", o que e' precisamente o ponto.
revisao_da_imagem() {
  # A saida e' capturada ANTES do pipe, e nao encadeada nele. Com
  # `pipefail`, `docker image inspect | sed | head` propaga o insucesso
  # do docker quando a imagem NAO EXISTE, e o `set -e` matava o script
  # a meio do portao — sem rollback, sem mensagem, com exit 1. Uma
  # imagem ausente e' uma resposta valida a esta pergunta, nao um erro.
  local saida
  saida=$(docker image inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null) \
    || return 0
  printf '%s\n' "$saida" | sed -n 's/^APP_REVISION=//p' | head -1
}

# Ficheiros que entram na imagem de tools e mudaram entre duas revisoes.
tools_afectados() {
  gitro diff --name-only "$1" "$2" -- "${CAMINHOS_TOOLS[@]}" 2>/dev/null || true
}

# ═════════════════════════════════════════════════════════════════════════
# Git SEMPRE de leitura.
#
# Este script corre com sudo. Qualquer comando git que ESCREVA no clone
# deixa ficheiros de root la' dentro — e o clone e' do utilizador
# `deploy`, que a partir daí nao consegue sequer correr `git status`:
#
#     fatal: .git/index: index file open failed: Permission denied
#
# `--no-optional-locks` existe exactamente para isto: impede o git de
# refrescar o indice em comandos de leitura (`status` fa-lo por omissao,
# e um `status` corrido por root reescrevia `.git/index` como root).
#
# Nao ha' `git checkout` nenhum: a arvore a construir sai por
# `git archive` para um directorio temporario. Ver `construir`.
# ═════════════════════════════════════════════════════════════════════════
gitro() {
  git --no-optional-locks -C "$CLONE" "$@"
}

# Ficheiros de root dentro do clone — de uma execucao anterior, antes de
# este script deixar de escrever la'. Torna o problema visivel e da' o
# comando exacto para o reparar, em vez de um `chown -R` as cegas.
diagnosticar_dono() {
  local encontrado dono
  encontrado=$(find "$CLONE" -user 0 -print -quit 2>/dev/null || true)
  [ -n "$encontrado" ] || return 1
  dono=$(stat -c '%U:%G' "$CLONE" 2>/dev/null || echo "")
  err "existem ficheiros de ROOT dentro de ${CLONE}"
  err "(primeiro encontrado: ${encontrado})"
  if [ -n "$dono" ]; then
    err "repara SO' esses ficheiros — sem chown -R indiscriminado — com:"
    err "    sudo find ${CLONE} -user root -exec chown ${dono} {} +"
  fi
  return 0
}

limpar_contexto() {
  [ -n "$CTX" ] && [ -d "$CTX" ] && rm -rf "$CTX"
  CTX=""
}
trap limpar_contexto EXIT

# ═════════════════════════════════════════════════════════════════════════
# Wrapper do compose.
#
# Os dois `--env-file`, sempre e sem excepção. `dc()` (lib/common.sh) já
# os acrescenta; esta função existe só para FALHAR se algum faltar, em vez
# de o compose cair nos defaults do próprio ficheiro — que é exactamente
# como se criou um cluster PostgreSQL vazio em /opt/spharmmt.
#
# Note-se a ausência de `--profile tools`: sem ele o compose finge que o
# serviço `migrate` não existe, e um `build` sem nome de serviço nunca lhe
# poderia tocar.
# ═════════════════════════════════════════════════════════════════════════
dcapp() {
  [ -f "$SPHARMMT_ENV_FILE" ] || die_precond "env-file ausente: ${SPHARMMT_ENV_FILE}"
  [ -f "$SPHARMMT_STACK_ENV_FILE" ] || die_precond "env-file ausente: ${SPHARMMT_STACK_ENV_FILE}"
  docker compose \
    -f "$SPHARMMT_COMPOSE_FILE" -p spharmmt \
    --env-file "$SPHARMMT_ENV_FILE" \
    --env-file "$SPHARMMT_STACK_ENV_FILE" \
    "$@"
}

# ═════════════════════════════════════════════════════════════════════════
# 1. Pré-condições
# ═════════════════════════════════════════════════════════════════════════
# Descobre de que clone construir.
#
# A PRIMEIRA resposta e' o clone que contem ESTE script. Quem corre
# `<clone>/deploy/scripts/deploy-app.sh` quer publicar a revisao desse
# clone, e nao a de outro qualquer que exista na maquina. E' tambem como
# o `install-stack.sh` resolve o `REPO_ROOT` (SCRIPT_DIR/../..), portanto
# os dois concordam sobre o que e' "o repositorio".
#
# A lista de fallback so' interessa quando o script corre INSTALADO, a
# partir de ${SPHARMMT_ROOT}/scripts — que nao e' um repositorio git.
localizar_clone() {
  [ -n "$CLONE" ] && return 0

  local aqui
  aqui=$(cd "${SCRIPT_DIR}/../.." 2>/dev/null && pwd) || aqui=""
  if [ -n "$aqui" ] && [ -d "${aqui}/.git" ]; then
    CLONE=$aqui
    dbg "clone deduzido da localizacao do script: ${CLONE}"
    return 0
  fi

  local c
  for c in "${SPHARMMT_ROOT}/src" /tmp/spharmmt /tmp/spharm-mt \
           /home/*/spharm-mt /home/*/spharmmt-mt /srv/spharm-mt /opt/spharm-mt; do
    [ -d "${c}/.git" ] && { CLONE=$c; return 0; }
  done
  return 1
}

preflight() {
  step "1. Pré-condições"
  require_root

  has_cmd docker || die_precond "docker não encontrado"
  has_cmd git    || die_precond "git não encontrado"
  [ -f "$SPHARMMT_COMPOSE_FILE" ] || die_precond "compose não instalado em ${SPHARMMT_COMPOSE_FILE}"
  [ -f "$SPHARMMT_ENV_FILE" ]       || die_precond "falta ${SPHARMMT_ENV_FILE}"
  [ -f "$SPHARMMT_STACK_ENV_FILE" ] || die_precond "falta ${SPHARMMT_STACK_ENV_FILE}"
  ok "compose e os dois env-files no sítio"

  # Nome e tag das imagens. Lidos AQUI e nao a meio do deploy: tanto o
  # rollback como o portao da imagem de tools precisam deles antes de
  # qualquer build.
  APP_IMAGE_ACTUAL=$(awk -F= '/^APP_IMAGE=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" 2>/dev/null || true)
  APP_IMAGE_ACTUAL=${APP_IMAGE_ACTUAL:-spharmmt-app}
  APP_TAG_ACTUAL=$(awk -F= '/^APP_TAG=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" 2>/dev/null || true)
  APP_TAG_ACTUAL=${APP_TAG_ACTUAL:-local}
  IMAGEM_MIGRATOR="${APP_IMAGE_ACTUAL}:${APP_TAG_ACTUAL}-migrator"

  # ── O PGDATA configurado ───────────────────────────────────────────
  # Lido dos env-files (o stack.env ganha, como no compose) e confirmado
  # contra o que o container está MESMO a montar. As duas verificações
  # respondem a perguntas diferentes: a primeira diz o que aconteceria
  # num arranque, a segunda o que está a acontecer agora.
  local pgdata_cfg
  pgdata_cfg=$(awk -F= '/^POSTGRES_DATA_DIR=/ {v=$2} END {print v}' \
    "$SPHARMMT_ENV_FILE" "$SPHARMMT_STACK_ENV_FILE" 2>/dev/null || true)
  [ "$pgdata_cfg" = "$PGDATA_ESPERADO" ] \
    || die_precond "POSTGRES_DATA_DIR=${pgdata_cfg:-<vazio>}, esperado ${PGDATA_ESPERADO}"
  ok "POSTGRES_DATA_DIR = ${PGDATA_ESPERADO}"

  container_running "$SPHARMMT_PG_CONTAINER" \
    || die_precond "PostgreSQL não está a correr — este script não arranca infraestrutura"
  local saude
  saude=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$SPHARMMT_PG_CONTAINER" 2>/dev/null || echo desconhecido)
  [ "$saude" = "healthy" ] || die_precond "PostgreSQL está '${saude}', não 'healthy'"

  local pg_mount
  pg_mount=$(docker inspect -f \
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' \
    "$SPHARMMT_PG_CONTAINER" 2>/dev/null || true)
  [ "$pg_mount" = "$PGDATA_ESPERADO" ] \
    || die_precond "PostgreSQL está montado em '${pg_mount}', não em ${PGDATA_ESPERADO}"
  ok "PostgreSQL healthy sobre ${PGDATA_ESPERADO}"

  # Guardar identidade do postgres ANTES: é contra isto que se prova, no
  # fim, que ele não foi tocado.
  PG_ID_ANTES=$(docker inspect -f '{{.Id}}' "$SPHARMMT_PG_CONTAINER")
  PG_ARRANQUE_ANTES=$(docker inspect -f '{{.State.StartedAt}}' "$SPHARMMT_PG_CONTAINER")

  # ── O clone ────────────────────────────────────────────────────────
  localizar_clone || die_precond "clone git não encontrado — indica-o com --clone <dir>"
  [ -d "${CLONE}/.git" ] || die_precond "${CLONE} não é um repositório git"
  ok "clone: ${CLONE}"

  # Nenhum ficheiro de root pode estar la' dentro: se estiver, o
  # utilizador `deploy` ja' nao consegue usar o clone e a causa e'
  # sempre a mesma (um git de escrita corrido com sudo).
  if diagnosticar_dono; then
    die_precond "clone com ficheiros de root — repara-o antes de publicar"
  fi

  # Árvore limpa. O que se constroi e' o COMMIT (via `git archive`), nao
  # o directorio de trabalho — mas uma arvore suja significa que o que
  # se ve' no disco nao e' o que vai ser publicado, e isso merece parar.
  local sujo rc_status
  sujo=$(gitro status --porcelain 2>&1); rc_status=$?
  if [ "$rc_status" -ne 0 ]; then
    err "não consegui ler o estado de ${CLONE}:"
    printf '%s\n' "$sujo" | sed 's/^/      /'
    diagnosticar_dono || true
    die_precond "clone ilegível"
  fi
  [ -z "$sujo" ] || die_precond "árvore de trabalho suja em ${CLONE}:
$(printf '%s' "$sujo" | head -5)"
  ok "árvore de trabalho limpa"

  [ -z "$ALVO" ] && ALVO=$(gitro rev-parse HEAD)
  gitro rev-parse --verify --quiet "${ALVO}^{commit}" >/dev/null \
    || die_precond "revisão '${ALVO}' não existe em ${CLONE} (falta um git fetch?)"
  REV_ALVO=$(gitro rev-parse --short "${ALVO}^{commit}")
  ok "revisão alvo: ${REV_ALVO}"
}

# ═════════════════════════════════════════════════════════════════════════
# 2. Portão das migrations
#
# A pergunta certa NÃO é "o commit alvo traz migrations" — é "existe
# alguma migration entre o que está a servir e o que vai passar a servir".
# Um deploy que salte cinco commits pode trazer uma migration nenhum
# deles anuncia.
# ═════════════════════════════════════════════════════════════════════════
portao_migrations() {
  step "2. Migrations"

  REV_ANTERIOR=$(docker exec "$SPHARMMT_APP_CONTAINER" printenv APP_REVISION 2>/dev/null || echo "")
  [ -n "$REV_ANTERIOR" ] || die_precond "não consegui ler APP_REVISION de ${SPHARMMT_APP_CONTAINER}"
  [ "$REV_ANTERIOR" = "unknown" ] \
    && die_precond "a imagem em produção não sabe que revisão é ('unknown') — sem isso não posso provar que não há migrations. Usa install-stack.sh."

  gitro rev-parse --verify --quiet "${REV_ANTERIOR}^{commit}" >/dev/null \
    || die_precond "a revisão em produção (${REV_ANTERIOR}) não existe neste clone — sem ela não posso comparar migrations. Usa install-stack.sh."

  if [ "$REV_ANTERIOR" = "$REV_ALVO" ]; then
    warn "a revisão alvo já é a que está em produção (${REV_ALVO})"
  fi

  local mudou
  mudou=$(gitro diff --name-only "${REV_ANTERIOR}" "${REV_ALVO}" \
            -- prisma/migrations prisma-control/migrations 2>/dev/null || true)
  if [ -n "$mudou" ]; then
    err "existem migrations entre ${REV_ANTERIOR} e ${REV_ALVO}:"
    printf '%s\n' "$mudou" | sed 's/^/      /'
    err "este script NÃO aplica migrations. Usa:"
    err "    sudo ./install-stack.sh   (aplica-as antes de recriar a aplicação)"
    DIE_CODE=$EX_PRECOND die "deploy rápido recusado"
  fi
  ok "sem migrations entre ${REV_ANTERIOR} e ${REV_ALVO}"
}

# ═════════════════════════════════════════════════════════════════════════
# 2b. Portão da imagem de ferramentas
#
# A pergunta é a mesma do portão das migrations, aplicada a outra imagem:
# "entre o que a imagem de tools TEM e o que vai passar a haver, mudou
# alguma coisa que entre nessa imagem?"
#
# Só três respostas levam a NÃO construir, e todas são demonstráveis:
# a imagem já está na revisão alvo; nada em CAMINHOS_TOOLS mudou; ou o
# operador pediu explicitamente para saltar. Tudo o resto — imagem
# inexistente, sem carimbo, ou carimbada com uma revisão que este clone
# não conhece — constrói, porque não se pode PROVAR que não é preciso.
# Uma imagem que não sabe dizer o que traz não recebe o benefício da
# dúvida.
# ═════════════════════════════════════════════════════════════════════════
portao_migrator() {
  step "2b. Imagem de ferramentas"

  REV_MIGRATOR=$(revisao_da_imagem "$IMAGEM_MIGRATOR")

  if [ "$SKIP_MIGRATOR" = "1" ]; then
    CONSTRUIR_MIGRATOR=0
    MOTIVO_MIGRATOR="--skip-migrator"
    warn "imagem de tools NÃO será construída (--skip-migrator)"
    warn "se as alterações lhe tocarem, este deploy termina com código 3"
    return 0
  fi

  if [ "$FORCE_MIGRATOR" = "1" ]; then
    CONSTRUIR_MIGRATOR=1
    MOTIVO_MIGRATOR="--force-migrator"
    info "imagem de tools será construída (--force-migrator)"
    return 0
  fi

  if [ -z "$REV_MIGRATOR" ] || [ "$REV_MIGRATOR" = "unknown" ]; then
    CONSTRUIR_MIGRATOR=1
    MOTIVO_MIGRATOR="a imagem ${IMAGEM_MIGRATOR} não existe ou não diz que revisão é"
    warn "${MOTIVO_MIGRATOR} — vai ser construída"
    return 0
  fi

  if ! gitro rev-parse --verify --quiet "${REV_MIGRATOR}^{commit}" >/dev/null; then
    CONSTRUIR_MIGRATOR=1
    MOTIVO_MIGRATOR="a revisão da imagem de tools (${REV_MIGRATOR}) não existe neste clone"
    warn "${MOTIVO_MIGRATOR} — vai ser construída"
    return 0
  fi

  if [ "$REV_MIGRATOR" = "$REV_ALVO" ]; then
    CONSTRUIR_MIGRATOR=0
    MOTIVO_MIGRATOR="já está em ${REV_ALVO}"
    ok "imagem de tools já está em ${REV_ALVO} — nada a construir"
    return 0
  fi

  local mudou
  mudou=$(tools_afectados "$REV_MIGRATOR" "$REV_ALVO")
  if [ -z "$mudou" ]; then
    CONSTRUIR_MIGRATOR=0
    MOTIVO_MIGRATOR="nada que entre na imagem mudou entre ${REV_MIGRATOR} e ${REV_ALVO}"
    ok "imagem de tools em ${REV_MIGRATOR}: nada relevante mudou — não se constrói"
    return 0
  fi

  CONSTRUIR_MIGRATOR=1
  MOTIVO_MIGRATOR="alterações relevantes entre ${REV_MIGRATOR} e ${REV_ALVO}"
  info "a imagem de tools está em ${REV_MIGRATOR}; mudou o que ela leva:"
  printf '%s\n' "$mudou" | head -12 | sed 's/^/      /'
  local n; n=$(printf '%s\n' "$mudou" | grep -c . || true)
  [ "$n" -gt 12 ] && info "      (+ $((n - 12)) ficheiros)"
  ok "imagem de tools será reconstruída"
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Rollback guardado ANTES de construir
#
# A ordem é crítica: o build reescreve a tag `spharmmt-app:local` e a
# imagem antiga fica sem tag. Continua a existir pelo ID — mas um
# `docker image prune` levá-la-ia. Por isso ganha aqui uma tag própria.
# ═════════════════════════════════════════════════════════════════════════
guardar_rollback() {
  step "3. Rollback"

  IMAGEM_ANTERIOR=$(docker inspect -f '{{.Image}}' "$SPHARMMT_APP_CONTAINER" 2>/dev/null || true)
  [ -n "$IMAGEM_ANTERIOR" ] || die_precond "não consegui ler a imagem actual de ${SPHARMMT_APP_CONTAINER}"

  TAG_RESGATE="${APP_IMAGE_ACTUAL}:rollback-${REV_ANTERIOR}"
  if [ "$DRY_RUN" != "1" ]; then
    docker tag "$IMAGEM_ANTERIOR" "$TAG_RESGATE" \
      || die_precond "não consegui etiquetar a imagem anterior — sem rollback não avanço"
    # O ficheiro e' conveniencia para quem vier depois ler o estado.
    # Sem chown: na VPS o directorio ja' existe com o dono certo
    # (install-platform), e um deploy rapido nao e' sitio para andar a
    # corrigir permissoes. A ancora do rollback e' a TAG, que ja' foi
    # criada acima e cuja falha aborta o deploy.
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    printf 'rev=%s\nimage=%s\ntag=%s\n' \
      "$REV_ANTERIOR" "$IMAGEM_ANTERIOR" "$TAG_RESGATE" > "$STATE_FILE" 2>/dev/null \
      || warn "nao consegui escrever ${STATE_FILE} (o rollback continua garantido pela tag)"
  fi
  ok "imagem ${REV_ANTERIOR} guardada como ${TAG_RESGATE}"
  info "estado em ${STATE_FILE}"
}

# ═════════════════════════════════════════════════════════════════════════
# 4. Build — uma imagem, a partir do clone
#
# `web` e `worker` partilham a MESMA imagem (`${APP_IMAGE}:${APP_TAG}`) e
# só o `web` tem secção `build:`. Construir `web` é construir a imagem dos
# dois. O `migrate` é outra imagem (`-migrator`), vive no perfil `tools` e
# não é nomeado aqui.
#
# APP_BUILD_CONTEXT aponta para o CLONE e não para ${SPHARMMT_ROOT}/app: o
# `.dockerignore` já exclui node_modules, .next, .git e .env*, portanto o
# contexto enviado é o mesmo que o `git archive` produzia — sem o passo de
# exportar e escrever a árvore inteira em disco.
#
# Sem `--pull`: a imagem base local é reutilizada. É esta linha que
# preserva o cache do `npm ci` e do `apt-get install chromium`.
# ═════════════════════════════════════════════════════════════════════════
construir() {
  step "4. Imagem da aplicação"

  # ── A ARVORE SAI DO COMMIT, NAO DO CLONE ─────────────────────────
  #
  # `git archive` le' os objectos e escreve para stdout: nao mexe no
  # indice, nao mexe no HEAD, nao mexe em nada dentro de .git. A versao
  # anterior fazia `git checkout --detach` — corrido com sudo, isso
  # recriava `.git/index` e `.git/HEAD` como root e deixava o clone
  # inutilizavel para o utilizador `deploy`.
  #
  # Efeito lateral bem-vindo: o contexto passa a conter SO' o que esta'
  # commitado, exactamente como o install-stack.sh sempre fez.
  CTX=$(mktemp -d)
  info "a extrair ${REV_ALVO} para ${CTX}..."
  if [ "$DRY_RUN" != "1" ]; then
    gitro archive --format=tar "$REV_ALVO" | tar -x -C "$CTX" \
      || die "não consegui extrair ${REV_ALVO} do clone"
  fi
  export APP_BUILD_CONTEXT="$CTX"

  local extra=()
  [ "$NO_CACHE" = "1" ] && extra+=(--no-cache)

  info "a construir spharmmt-app (contexto: ${CTX})..."
  run dcapp build "${extra[@]+"${extra[@]}"}" web
  ok "imagem construída (rev ${REV_ALVO})"
}

# ═════════════════════════════════════════════════════════════════════════
# 4b. Imagem de ferramentas
#
# ANTES do `subir`, e nao depois, por uma razao so': se este build falhar,
# ainda nao se recriou container nenhum. O deploy aborta com a versao
# antiga a servir e nao ha' rollback a fazer — nada foi mudado.
#
# Constroi-se do MESMO contexto (`CTX`) que a imagem da aplicacao, o que
# garante que as duas saem da mesma revisao e faz o build reaproveitar os
# estagios `deps` e `builder` que o build anterior acabou de encher. O
# custo marginal e' o estagio `migrator` e a exportacao da imagem.
#
# `--profile tools` e' obrigatorio: sem ele o compose finge que o servico
# `migrate` nao existe e o build falharia a dizer que nao ha' tal servico.
# E' `build`, nunca `run` nem `up`: nada arranca, nada migra.
# ═════════════════════════════════════════════════════════════════════════
construir_migrator() {
  [ "$CONSTRUIR_MIGRATOR" = "1" ] || return 0
  step "4b. Imagem de ferramentas (${IMAGEM_MIGRATOR})"
  info "motivo: ${MOTIVO_MIGRATOR}"

  # Rollback PROPRIO, guardado antes de a tag ser reescrita. Nao entra no
  # STATE_FILE da aplicacao de proposito: sao duas decisoes separadas.
  IMAGEM_MIGRATOR_ANTERIOR=$(docker image inspect "$IMAGEM_MIGRATOR" --format '{{.Id}}' 2>/dev/null || true)
  if [ -n "$IMAGEM_MIGRATOR_ANTERIOR" ] && [ "$DRY_RUN" != "1" ]; then
    TAG_RESGATE_MIGRATOR="${APP_IMAGE_ACTUAL}:rollback-${REV_MIGRATOR:-sem-revisao}-migrator"
    if docker tag "$IMAGEM_MIGRATOR_ANTERIOR" "$TAG_RESGATE_MIGRATOR" 2>/dev/null; then
      mkdir -p "$STATE_DIR" 2>/dev/null || true
      printf 'rev=%s\nimage=%s\ntag=%s\n' \
        "${REV_MIGRATOR:-desconhecida}" "$IMAGEM_MIGRATOR_ANTERIOR" "$TAG_RESGATE_MIGRATOR" \
        > "$STATE_FILE_MIGRATOR" 2>/dev/null || true
      ok "imagem de tools anterior guardada como ${TAG_RESGATE_MIGRATOR}"
    else
      warn "não consegui etiquetar a imagem de tools anterior — sem rollback dela"
    fi
  fi

  local extra=()
  [ "$NO_CACHE" = "1" ] && extra+=(--no-cache)

  info "a construir ${IMAGEM_MIGRATOR} (contexto: ${CTX})..."
  run dcapp --profile tools build "${extra[@]+"${extra[@]}"}" migrate
  ok "imagem de tools construída (rev ${REV_ALVO})"
}

# ═════════════════════════════════════════════════════════════════════════
# 5. Subir — só web e worker
# ═════════════════════════════════════════════════════════════════════════
subir() {
  step "5. web + worker"
  # `--no-deps` é redundante com a nomeação explícita dos serviços, e está
  # aqui na mesma: é a diferença entre "não pretendo tocar no postgres" e
  # "o compose não pode tocar no postgres".
  run dcapp up -d --no-deps web worker
  ok "containers recriados"
}

# ═════════════════════════════════════════════════════════════════════════
# 6. Validação
# ═════════════════════════════════════════════════════════════════════════
esperar_healthy() {
  local nome=$1 limite=$2
  local fim=$(( $(date +%s) + limite )) estado saude
  while [ "$(date +%s)" -lt "$fim" ]; do
    estado=$(docker inspect -f '{{.State.Status}}' "$nome" 2>/dev/null || echo ausente)
    saude=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$nome" 2>/dev/null || echo none)
    case "${estado}:${saude}" in
      running:healthy|running:none) return 0 ;;
      exited:*|dead:*) return 1 ;;
    esac
    sleep 3
  done
  return 1
}

porta_proxy() {
  awk -F= '/^PROXY_HTTP_PORT=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" 2>/dev/null || true
}

postgres_intocado() {
  local id agora
  id=$(docker inspect -f '{{.Id}}' "$SPHARMMT_PG_CONTAINER" 2>/dev/null || echo "")
  agora=$(docker inspect -f '{{.State.StartedAt}}' "$SPHARMMT_PG_CONTAINER" 2>/dev/null || echo "")
  [ "$id" = "$PG_ID_ANTES" ] && [ "$agora" = "$PG_ARRANQUE_ANTES" ]
}

validar() {
  step "6. Validação"
  local falhou=0

  # ── PostgreSQL: o mesmo container, o mesmo arranque, o mesmo PGDATA ──
  if postgres_intocado; then
    ok "postgres intocado (mesmo container, mesmo arranque)"
  else
    err "o container do PostgreSQL MUDOU durante o deploy — isto é um bug deste script"
    falhou=1
  fi
  local pg_mount
  pg_mount=$(docker inspect -f \
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' \
    "$SPHARMMT_PG_CONTAINER" 2>/dev/null || true)
  if [ "$pg_mount" = "$PGDATA_ESPERADO" ]; then
    ok "postgres continua em ${PGDATA_ESPERADO}"
  else
    err "postgres montado em '${pg_mount}'"
    falhou=1
  fi

  # ── web saudável ────────────────────────────────────────────────────
  if esperar_healthy "$SPHARMMT_APP_CONTAINER" "$HEALTH_TIMEOUT"; then
    ok "web healthy"
  else
    err "web não ficou healthy em ${HEALTH_TIMEOUT}s"
    docker logs --tail 40 "$SPHARMMT_APP_CONTAINER" 2>&1 | sed 's/^/      /' || true
    falhou=1
  fi

  # ── HTTP local ──────────────────────────────────────────────────────
  local porta codigo
  porta=$(porta_proxy); porta=${porta:-8080}
  codigo=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    "http://127.0.0.1:${porta}/api/health" 2>/dev/null || echo 000)
  if [ "$codigo" = "200" ]; then
    ok "health local 200 (porta ${porta})"
  else
    err "health local devolveu ${codigo}"
    falhou=1
  fi

  # ── Revisão a servir ────────────────────────────────────────────────
  local rev_web rev_worker
  rev_web=$(docker exec "$SPHARMMT_APP_CONTAINER" printenv APP_REVISION 2>/dev/null || echo "")
  rev_worker=$(docker exec "$SPHARMMT_WORKER_CONTAINER" printenv APP_REVISION 2>/dev/null || echo "")
  if [ "$rev_web" = "$REV_ALVO" ]; then ok "web ${rev_web}"
  else err "web está em '${rev_web}', esperado ${REV_ALVO}"; falhou=1; fi
  if [ "$rev_worker" = "$REV_ALVO" ]; then ok "worker ${rev_worker}"
  else err "worker está em '${rev_worker}', esperado ${REV_ALVO}"; falhou=1; fi

  # ── HTTPS público ───────────────────────────────────────────────────
  #
  # Regra deliberada: um 5xx é da APLICAÇÃO e faz rollback; não conseguir
  # ligar (000) é DNS, certificado ou rede, e reverter uma aplicação que
  # está local e comprovadamente saudável não corrigia nada disso.
  local https
  https=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_URL_HEALTH" 2>/dev/null || echo 000)
  case "$https" in
    200) ok "https 200 (${PUBLIC_URL_HEALTH})" ;;
    000) warn "não consegui contactar ${PUBLIC_URL_HEALTH} — verifica DNS/certificado/proxy (não é motivo de rollback)" ;;
    5*)  err "https devolveu ${https} — erro da aplicação"; falhou=1 ;;
    *)   warn "https devolveu ${https} (não é 5xx — não é motivo de rollback)" ;;
  esac

  return "$falhou"
}

# ═════════════════════════════════════════════════════════════════════════
# 6b. Coerência entre a aplicação e as ferramentas
#
# SEPARADA da `validar` de propósito, e sem poder de rollback. Se a
# aplicação está saudável a servir a revisão alvo, reverter tudo porque
# uma imagem de comandos manuais ficou para trás seria uma resposta
# desproporcionada: tirava do ar o que funciona para corrigir o que só é
# usado quando alguém corre um comando à mão.
#
# Estar ATRASADA não é, por si, um erro — é o caso normal quando o deploy
# só mexeu em UI. O erro é estar atrasada EM RELAÇÃO A ALGO QUE LHE TOCA,
# e é isso que se mede.
# ═════════════════════════════════════════════════════════════════════════
validar_coerencia_tools() {
  step "6b. Coerência das ferramentas"

  local rev; rev=$(revisao_da_imagem "$IMAGEM_MIGRATOR")

  if [ "$rev" = "$REV_ALVO" ]; then
    ok "imagem de tools em ${REV_ALVO} — igual a web/worker"
    return 0
  fi

  if [ -z "$rev" ] || [ "$rev" = "unknown" ]; then
    err "a imagem ${IMAGEM_MIGRATOR} não existe ou não diz que revisão é"
    err "sem isso não posso afirmar que os comandos de tools correm código actual"
    err "corrige com:  sudo $0 ${REV_ALVO} --force-migrator"
    return 1
  fi

  if ! gitro rev-parse --verify --quiet "${rev}^{commit}" >/dev/null; then
    err "a imagem de tools diz-se ${rev}, revisão que este clone não conhece"
    err "corrige com:  sudo $0 ${REV_ALVO} --force-migrator"
    return 1
  fi

  local mudou; mudou=$(tools_afectados "$rev" "$REV_ALVO")
  if [ -z "$mudou" ]; then
    ok "imagem de tools em ${rev} (atrás de ${REV_ALVO}), mas nada que ela leve mudou"
    return 0
  fi

  err "web/worker em ${REV_ALVO} e a imagem de tools em ${rev}, com alterações que lhe tocam:"
  printf '%s\n' "$mudou" | head -12 | sed 's/^/      /'
  err "os comandos do perfil tools (tenant:*, catalog:*, tenancy:*, diagnósticos)"
  err "correriam código antigo. A aplicação está publicada e saudável; isto NÃO é rollback."
  err "corrige com:  sudo $0 ${REV_ALVO} --force-migrator"
  return 1
}

# ═════════════════════════════════════════════════════════════════════════
# 7. Rollback
#
# SÓ da aplicação. A imagem de tools tem rollback próprio, deliberadamente
# separado: são duas imagens com ciclos de vida diferentes, e repor as
# duas por causa de uma é como reinstalar o sistema para corrigir um
# atalho. Se for mesmo preciso repor a de tools, o comando está no fim
# desta função e o estado em ${STATE_FILE_MIGRATOR}.
# ═════════════════════════════════════════════════════════════════════════
rollback() {
  step "Rollback"
  [ -n "$IMAGEM_ANTERIOR" ] || { err "sem imagem anterior registada — rollback impossível"; return 1; }

  warn "a repor ${REV_ANTERIOR} (${IMAGEM_ANTERIOR:0:19})..."
  # A tag que o compose espera volta a apontar para a imagem antiga.
  run docker tag "$IMAGEM_ANTERIOR" "${APP_IMAGE_ACTUAL}:${APP_TAG_ACTUAL}"
  run dcapp up -d --no-deps --force-recreate web worker

  if esperar_healthy "$SPHARMMT_APP_CONTAINER" "$HEALTH_TIMEOUT"; then
    local porta codigo
    porta=$(porta_proxy); porta=${porta:-8080}
    codigo=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
      "http://127.0.0.1:${porta}/api/health" 2>/dev/null || echo 000)
    if [ "$codigo" = "200" ]; then
      ok "rollback concluído — ${REV_ANTERIOR} a servir, health 200"
    else
      err "rollback aplicado mas health devolveu ${codigo} — INTERVENÇÃO MANUAL"
    fi
  else
    err "a versão anterior TAMBÉM não ficou healthy — INTERVENÇÃO MANUAL"
    err "estado guardado em ${STATE_FILE}"
  fi

  # A imagem de tools NAO e' revertida aqui. Se este deploy chegou a
  # construi-la e for preciso repo-la, e' um comando separado e explicito.
  if [ -n "$TAG_RESGATE_MIGRATOR" ]; then
    info "a imagem de tools NÃO foi revertida (é uma decisão separada). Para a repor:"
    info "    docker tag ${TAG_RESGATE_MIGRATOR} ${IMAGEM_MIGRATOR}"
  fi

  # Não há nada a repor no clone: este script nunca lhe escreve.
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  local t0; t0=$(date +%s)
  log_init
  acquire_lock deploy-app
  banner "deploy-app"

  preflight
  portao_migrations
  portao_migrator
  guardar_rollback

  # ── A sobreposicao dos valores que mudam a cada deploy ────────────
  #
  # EXPORTADA, e nao passada como prefixo de comando: a interpolacao do
  # compose da' precedencia ao ambiente do shell sobre os `--env-file`, e
  # e' assim que a revisao chega ao build sem escrever no stack.env.
  # (`APP_BUILD_CONTEXT` e' exportado dentro de `construir`, quando a
  # arvore temporaria ja' existe.)
  #
  # O stack.env fica com o APP_REVISION antigo. Nao e' esquecimento: quem
  # manda e' a variavel ENV gravada DENTRO da imagem, e e' essa que a
  # validacao le' do container. O stack.env volta a acertar no proximo
  # install-stack.
  export APP_REVISION="$REV_ALVO"

  construir
  construir_migrator
  subir

  # O clone tem de sair exactamente como entrou. Esta verificacao nao
  # corrige nada — grita, que e' o que faltava da primeira vez.
  if diagnosticar_dono; then
    err "este deploy deixou ficheiros de root no clone — isto é um bug deste script"
    rollback
    finish "$EX_FAIL"
  fi

  if validar; then
    local t1; t1=$(date +%s)
    printf '\n'
    ok "deploy concluído em $((t1 - t0))s · ${REV_ANTERIOR} → ${REV_ALVO}"
    info "rollback disponível: docker tag ${TAG_RESGATE} ${APP_IMAGE_ACTUAL}:${APP_TAG_ACTUAL}"
    [ -n "$TAG_RESGATE_MIGRATOR" ] \
      && info "rollback da imagem de tools (separado): docker tag ${TAG_RESGATE_MIGRATOR} ${IMAGEM_MIGRATOR}"

    # A aplicacao esta' publicada e saudavel. Se a imagem de tools ficou
    # incoerente, isso muda o CODIGO DE SAIDA e nao o estado da stack.
    if validar_coerencia_tools; then
      finish 0
    fi
    warn "a aplicação ficou publicada e saudável; o que falhou foi a imagem de tools"
    finish "$EX_POSTCOND"
  fi

  err "validação falhou — a reverter"
  rollback
  finish "$EX_FAIL"
}

main "$@"
