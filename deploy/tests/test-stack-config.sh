#!/usr/bin/env bash
# deploy/tests/test-stack-config.sh
#
# Invariantes da stack aplicacional. Todos correspondem a uma falha que
# custa caro e que NÃO se manifesta como erro no arranque:
#
#   · um `ports:` no PostgreSQL publica a base na Internet — e a UFW não
#     a fecha, porque as regras iptables do Docker são avaliadas antes;
#   · o proxy a ouvir em 0.0.0.0 antes de a stack estar validada;
#   · o scheduler ligado por defeito, a correr jobs sobre dados a meio
#     de uma migração;
#   · `pg_restore -j` a partir do stdin, que falha SEMPRE e só se
#     descobre no dia do desastre;
#   · segredos derivados a dar a cada serviço mais do que ele precisa;
#   · migrations no `build`, que tornam cada build irreversível e
#     dependente de ter a base acessível.
#
# São verificações ESTRUTURAIS sobre os ficheiros: correm sem Docker,
# sem rede e sem base de dados, que é o que as torna úteis num pre-commit.
# O comportamento em execução foi validado contra uma stack a correr.
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

# Os padrões de grep deste ficheiro procuram texto LITERAL no
# código-fonte dos scripts: as variáveis NÃO podem expandir. SC2016 é
# exactamente o comportamento pretendido, em todo o ficheiro.
# Directiva no topo, antes do primeiro comando — é o único sítio onde o
# ShellCheck a aplica ao ficheiro inteiro.
# shellcheck disable=SC2016

set -uo pipefail

DEPLOY_DIR=${DEPLOY_DIR:-/tmp/deploy}
SCRIPTS_DIR=${SCRIPTS_DIR:-${DEPLOY_DIR}/scripts}
DOCKER_DIR=${DOCKER_DIR:-${DEPLOY_DIR}/docker}
COMPOSE="${DOCKER_DIR}/docker-compose.yml"
DOCKERFILE="${DOCKER_DIR}/Dockerfile"
ENTRYPOINT="${DOCKER_DIR}/entrypoint.sh"
PG_INIT="${DOCKER_DIR}/postgres/init/10-databases.sh"
NGINX="${DOCKER_DIR}/proxy/spharmmt.conf"

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok_ "$d"; else bad_ "$d"; fi; }
refute(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then bad_ "$d"; else ok_ "$d"; fi; }
eq_()   { if [ "$2" = "$3" ]; then ok_ "$1 → ${3}"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi; }

# Extrai o bloco de um serviço do compose: da linha `  <nome>:` até ao
# início do serviço seguinte (outra chave com dois espaços de indentação).
service_block() {
  awk -v svc="  $1:" '
    $0 == svc { inside = 1; next }
    inside && /^  [a-zA-Z_-]+:$/ { exit }
    inside { print }
  ' "$COMPOSE"
}
# Os asserts correm os comandos com `bash -c`, portanto num processo novo.
# Sem exportar, a função não existe lá: os `assert` falhavam todos e — pior
# — os `refute` passavam por a função não existir, não por o invariante se
# verificar. Um teste que passa pela razão errada é pior do que não ter teste.
export COMPOSE
export -f service_block

# ═════════════════════════════════════════════════════════════════════════
test_files() {
  printf '\n1. Ficheiros da stack\n'
  assert "compose presente"        test -f "$COMPOSE"
  assert "Dockerfile presente"     test -f "$DOCKERFILE"
  assert "entrypoint presente"     test -f "$ENTRYPOINT"
  assert "init do postgres"        test -f "$PG_INIT"
  assert "configuração do nginx"   test -f "$NGINX"
  assert "install-stack.sh"        test -f "${SCRIPTS_DIR}/install-stack.sh"
  assert "compose é YAML sintacticamente plausível" \
    bash -c "grep -q '^services:' '$COMPOSE'"
}

# ═════════════════════════════════════════════════════════════════════════
# 2. Exposição — a categoria de erro mais cara
# ═════════════════════════════════════════════════════════════════════════
test_exposure() {
  printf '\n2. Exposição de rede\n'

  refute "postgres NÃO tem ports:" \
    bash -c "service_block postgres | grep -qE '^\s+ports:'"
  refute "web NÃO tem ports:" \
    bash -c "service_block web | grep -qE '^\s+ports:'"
  refute "worker NÃO tem ports:" \
    bash -c "service_block worker | grep -qE '^\s+ports:'"

  assert "proxy tem ports:" \
    bash -c "service_block proxy | grep -qE '^\s+ports:'"
  # O default do bind TEM de ser 127.0.0.1: quem quiser abrir a porta
  # muda a variável, mas o valor por omissão nunca pode expor a stack.
  assert "bind do proxy tem default 127.0.0.1" \
    grep -q 'PROXY_BIND:-127.0.0.1' "$COMPOSE"
  refute "nenhum serviço faz bind em 0.0.0.0 por defeito" \
    grep -qE '"0\.0\.0\.0:[0-9]+:' "$COMPOSE"

  assert "install-stack recusa um postgres com ports" \
    grep -q 'a base ficaria exposta' "${SCRIPTS_DIR}/install-stack.sh"
  assert "stack.env nasce com PROXY_BIND=127.0.0.1" \
    grep -q 'PROXY_BIND=\${bind}' "${SCRIPTS_DIR}/install-stack.sh"
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Endurecimento dos containers
# ═════════════════════════════════════════════════════════════════════════
test_hardening() {
  printf '\n3. Endurecimento\n'
  assert "no-new-privileges definido"      grep -q 'no-new-privileges:true' "$COMPOSE"
  assert "limites de log definidos"        grep -q 'max-size:' "$COMPOSE"
  assert "restart policy definida"         grep -q 'restart: unless-stopped' "$COMPOSE"

  local svc
  for svc in postgres web worker proxy; do
    assert "${svc}: limite de memória" \
      bash -c "service_block ${svc} | grep -A4 'limits:' | grep -q 'memory:'"
    assert "${svc}: limite de CPU" \
      bash -c "service_block ${svc} | grep -A4 'limits:' | grep -q 'cpus:'"
    # O `migrate` fica de fora do laço de propósito: é um trabalho que
    # termina, e um healthcheck sobre um container que sai é ruído.
    assert "${svc}: healthcheck" \
      bash -c "service_block ${svc} | grep -q 'healthcheck:'"
  done

  assert "proxy larga todas as capabilities" \
    bash -c "service_block proxy | grep -A2 'cap_drop:' | grep -q 'ALL'"
  assert "imagem corre como utilizador não-root" grep -q '^USER nextjs' "$DOCKERFILE"
  assert "utilizador criado com UID fixo"        grep -q 'uid 10001' "$DOCKERFILE"

  # O `migrate` é um trabalho que termina; com restart automático
  # repetiria migrations em ciclo.
  assert "migrate com restart: no" \
    bash -c "service_block migrate | grep -q 'restart: \"no\"'"
  assert "migrate fora do up (profiles)" \
    bash -c "service_block migrate | grep -q 'profiles:'"
}

# ═════════════════════════════════════════════════════════════════════════
# 4. Versões fixas
# ═════════════════════════════════════════════════════════════════════════
test_pinning() {
  printf '\n4. Versões\n'
  # `postgres:17` ou `:latest` mudariam de major numa reconstrução, e o
  # PostgreSQL recusa arrancar sobre um PGDATA de outra major.
  assert "postgres com versão major.minor fixa" \
    grep -qE 'image: postgres:[0-9]+\.[0-9]+' "$COMPOSE"
  refute "postgres não usa :latest"  grep -q 'image: postgres:latest' "$COMPOSE"
  assert "nginx com versão fixa" \
    grep -qE 'image: nginx:[0-9]+\.[0-9]+' "$COMPOSE"
  refute "node não usa :latest"      grep -q 'node:latest' "$DOCKERFILE"
}

# ═════════════════════════════════════════════════════════════════════════
# 5. Segredos
# ═════════════════════════════════════════════════════════════════════════
test_secrets() {
  printf '\n5. Segredos\n'

  # Least privilege: cada serviço só vê o seu ficheiro derivado.
  assert "postgres usa postgres.secrets.env" \
    bash -c "service_block postgres | grep -q 'postgres.secrets.env'"
  refute "postgres NÃO recebe o ficheiro da aplicação" \
    bash -c "service_block postgres | grep -q 'app.secrets.env'"
  assert "web usa app.secrets.env" \
    bash -c "service_block web | grep -q 'app.secrets.env'"
  refute "web NÃO recebe os segredos do postgres" \
    bash -c "service_block web | grep -q 'postgres.secrets.env'"

  # ── Fronteira de privilégio das ferramentas ──────────────────────────
  # O `tools.secrets.env` leva a password de superutilizador, de que o
  # `tenant:create --provider=local --create-db` precisa para o CREATE
  # ROLE / CREATE DATABASE. Montá-lo no web ou no worker daria
  # superutilizador da base a processos que servem tráfego: um RCE na
  # aplicação passaria a valer o cluster inteiro em vez de uma base.
  assert "migrate recebe tools.secrets.env" \
    bash -c "service_block migrate | grep -q 'tools.secrets.env'"
  refute "web NÃO recebe tools.secrets.env" \
    bash -c "service_block web | grep -q 'tools.secrets.env'"
  refute "worker NÃO recebe tools.secrets.env" \
    bash -c "service_block worker | grep -q 'tools.secrets.env'"

  local istack2="${SCRIPTS_DIR}/install-stack.sh"
  assert "install-stack deriva tools.secrets.env" \
    grep -q 'tools.secrets.env' "$istack2"
  assert "tools.secrets.env nasce 0600 root:root" \
    bash -c "grep -A3 'local tools_file=' '$istack2' | grep -q 'install -m 0600 -o root -g root'"
  refute "POSTGRES_ADMIN_URL NÃO é escrito em ficheiro nenhum" \
    bash -c "grep -rq 'POSTGRES_ADMIN_URL=' '$istack2' '${SCRIPTS_DIR}/install-platform.sh'"

  # Derivado em memória, e só nos modos de ferramentas.
  local ep="${DOCKER_DIR}/entrypoint.sh"
  assert "entrypoint deriva POSTGRES_ADMIN_URL" \
    grep -q 'ensure_admin_url()' "$ep"
  assert "web larga as credenciais administrativas" \
    bash -c "awk '/^  web\)/,/;;/' '$ep' | grep -q 'drop_admin_credentials'"
  assert "worker larga as credenciais administrativas" \
    bash -c "awk '/^  worker\)/,/;;/' '$ep' | grep -q 'drop_admin_credentials'"
  refute "o entrypoint nunca regista o URL administrativo" \
    bash -c "grep -E 'log .*\\\$POSTGRES_ADMIN_URL|log .*\\\$\{POSTGRES_ADMIN_URL' '$ep' | grep -q ."

  # Nenhum segredo pode ser INTERPOLADO: ficaria escrito no ficheiro de
  # configuração renderizado.
  refute "nenhum segredo interpolado no compose" \
    grep -qE '\$\{(AUTH_SECRET|TENANT_ENCRYPTION_SECRET|POSTGRES_PASSWORD|POSTGRES_APP_PASSWORD|CRON_SECRET)' "$COMPOSE"

  # `docker compose config` LÊ os env_file e imprime os valores — o
  # comando seguro tem de estar documentado, e o script tem de o usar.
  assert "aviso sobre config e env_file documentado" \
    grep -q 'no-env-resolution' "$COMPOSE"
  assert "install-stack valida com --no-env-resolution" \
    grep -q 'config --no-env-resolution' "${SCRIPTS_DIR}/install-stack.sh"

  assert "install-stack NÃO gera segredos novos" \
    grep -q 'NENHUM segredo é gerado aqui' "${SCRIPTS_DIR}/install-stack.sh"
  assert "ficheiros derivados a 0600 root:root" \
    grep -q "install -m 0600 -o root -g root /dev/null" "${SCRIPTS_DIR}/install-stack.sh"
}

# ═════════════════════════════════════════════════════════════════════════
# 6. Migrations
# ═════════════════════════════════════════════════════════════════════════
test_migrations() {
  printf '\n6. Migrations\n'
  local pkg="${DEPLOY_DIR}/../package.json"

  if [ -f "$pkg" ]; then
    # Um build que aplica migrations exige a base acessível para compilar
    # e torna cada build um evento irreversível.
    refute "\`build\` NÃO corre migrate deploy" \
      bash -c "grep -E '\"build\":' '$pkg' | grep -q 'migrate deploy'"
    assert "existe um alvo dedicado de migrations" \
      grep -q '"db:migrate:deploy"' "$pkg"
  else
    printf '  (package.json fora do alcance — saltado)\n'
  fi

  assert "Dockerfile tem alvo migrator separado" grep -q 'AS migrator' "$DOCKERFILE"
  refute "Dockerfile NÃO corre migrations no build" \
    bash -c "grep -E '^RUN' '$DOCKERFILE' | grep -q 'migrate deploy'"
  assert "entrypoint tem modo migrate"           grep -qE '^\s+migrate\)' "$ENTRYPOINT"
  assert "migrations esperam pelo postgres"      grep -q 'wait_for_postgres' "$ENTRYPOINT"
  assert "control plane migra antes do resto" \
    bash -c "grep -n 'prisma-control.config.ts' '$ENTRYPOINT' | head -1 | cut -d: -f1 | xargs -I{} test {} -lt \$(grep -n 'config prisma.config.ts' '$ENTRYPOINT' | head -1 | cut -d: -f1)"
  assert "ausência de tenants não é erro"         grep -q 'MIGRATE_TENANTS' "$ENTRYPOINT"
}

# ═════════════════════════════════════════════════════════════════════════
# 7. Scheduler
# ═════════════════════════════════════════════════════════════════════════
test_scheduler() {
  printf '\n7. Scheduler\n'
  local sched="${DEPLOY_DIR}/../scripts/workers/scheduler.mjs"

  assert "worker instalado no compose" \
    bash -c "grep -q '^  worker:' '$COMPOSE'"
  assert "worker usa a MESMA imagem da web" \
    bash -c "[ \"\$(service_block worker | grep -c 'image: \${APP_IMAGE')\" = 1 ]"

  if [ -f "$sched" ]; then
    assert "default de SCHEDULER_ENABLED é falso" \
      grep -q 'boolEnv("SCHEDULER_ENABLED", false)' "$sched"
    # Regressão concreta: o intervalo do modo ocioso levava `unref()`, o
    # processo saía com 0 e o Docker reiniciava-o em ciclo — a parecer
    # avariado quando só estava desligado.
    refute "intervalo do modo ocioso NÃO leva unref" \
      grep -q 'setInterval(heartbeat, TICK_MS).unref' "$sched"
    assert "modo ocioso mantém o processo vivo" grep -q 'idleTimer' "$sched"
    assert "--once ignora SCHEDULER_ENABLED"    grep -q 'ignora SCHEDULER_ENABLED' "$sched"
    assert "recusa arrancar activo sem CRON_SECRET" \
      grep -q 'SCHEDULER_ENABLED=1 mas CRON_SECRET' "$sched"
  else
    printf '  (scheduler.mjs fora do alcance — saltado)\n'
  fi

  # ── Postflight do install-stack ──────────────────────────────────────
  # O postflight asseverava "scheduler DESLIGADO" e falhava contra uma
  # plataforma em produção onde ligá-lo tinha sido uma decisão registada
  # no platform.env — que o install-stack.sh nem sequer escreve. Um
  # falso negativo que convidava a mexer em produção para calar o
  # instalador. O que se verifica agora é coerência, não estado.
  local inst="${SCRIPTS_DIR}/install-stack.sh"
  refute "postflight NÃO exige o scheduler desligado" \
    grep -q 'check "scheduler DESLIGADO"' "$inst"
  assert "postflight aceita o scheduler ligado" \
    grep -q 'scheduler LIGADO — jobs:' "$inst"
  # Ligado sem CRON_SECRET é um worker que não dispara nada e ninguém
  # repara — é ISSO que merece falhar.
  assert "postflight exige CRON_SECRET com o scheduler ligado" \
    grep -q 'check "scheduler ligado tem CRON_SECRET"' "$inst"
  assert "postflight avisa se SCHEDULER_JOBS estiver vazio" \
    grep -q 'SCHEDULER_JOBS vazio' "$inst"
  # A nota final descrevia sempre uma primeira instalação, e numa
  # actualização dizia o contrário do que se acabou de instalar.
  refute "nota final NÃO afirma SCHEDULER_ENABLED=0 às cegas" \
    grep -q 'O scheduler está DESLIGADO (SCHEDULER_ENABLED=0)' "$inst"

  # ── Credencial do modelo ─────────────────────────────────────────────
  # A chave vive no mecanismo de segredos e é entregue APENAS ao serviço
  # que a usa. O job de enriquecimento corre dentro do `web`; o worker só
  # dispara o pedido HTTP e não precisa dela.
  local entry="${DOCKER_DIR}/entrypoint.sh"
  assert "a chave do modelo entra pelo ficheiro de segredos" \
    grep -q "printf 'ANTHROPIC_API_KEY=%s" "$inst"
  assert "…e é opcional (a plataforma instala sem ela)" \
    grep -q 'sem ANTHROPIC_API_KEY' "$inst"
  refute "a chave NÃO é escrita no platform.env (que é configuração, não segredo)" \
    grep -q '^ANTHROPIC_API_KEY=' "${SCRIPTS_DIR}/install-platform.sh"
  # ── QUEM MONTA A CHAVE ───────────────────────────────────────────────
  #
  # A regressão que isto fixa foi medida em produção. Com a chave no
  # app.secrets.env — que o web E o worker montam — o worker ficava com
  # ela em `Config.Env`, e portanto:
  #
  #   /proc/1/environ do worker    → ausente   (o `unset` funciona)
  #   docker exec ... printenv     → PRESENTE  (o env vem de Config.Env)
  #
  # O `unset` do entrypoint limpa o processo e não a configuração. O que
  # tira mesmo a chave ao worker é ela viver num ficheiro que o worker
  # não monta.
  assert "existe um ficheiro de segredos só para a credencial do modelo" \
    grep -q 'model.secrets.env' "$inst"
  refute "a chave NÃO vai para o app.secrets.env (que o worker monta)" \
    bash -c "awk '/app_file=\"/,/ok \"app.secrets.env/' '$inst' | grep -q ANTHROPIC"

  local monta
  monta=" $(awk '
    /^  [a-z][a-z0-9_-]*:[[:space:]]*$/ { svc = $1; sub(/:/, "", svc) }
    /model\.secrets\.env/ && $0 !~ /^[[:space:]]*#/ { print svc }
  ' "$COMPOSE" | sort -u | tr "\n" " ")"
  case "$monta" in
    *" worker "*) bad_ "o worker NÃO pode montar model.secrets.env (montam:${monta})" ;;
    *)            ok_  "o worker não monta model.secrets.env (montam:${monta})" ;;
  esac
  case "$monta" in
    *" web "*) ok_  "o web monta model.secrets.env" ;;
    *)         bad_ "o web TEM de montar model.secrets.env (montam:${monta})" ;;
  esac

  if [ -f "$entry" ]; then
    assert "o worker descarta a chave do modelo no arranque (defesa em profundidade)" \
      grep -q 'unset ANTHROPIC_API_KEY' "$entry"
    assert "…e o comentário diz que o unset não chega sozinho" \
      grep -q 'DEFESA EM PROFUNDIDADE' "$entry"
  fi

  # Um segredo em variável de ambiente do host apareceria em
  # `docker compose config` e no `ps` de quem estivesse a ver.
  refute "a chave NÃO passa pelo compose como variável de ambiente" \
    grep -qE '^[^#]*\$\{ANTHROPIC' "$COMPOSE"

  # ── Guarda do refresh-ipf ────────────────────────────────────────────
  # Sem a guarda, o disparo seguinte do refresh-ipf mudava de
  # comportamento sozinho e passava a escrever nas bases dos tenants em
  # vez da base actual. O default falso é o que torna a mudança uma
  # decisão e não um efeito secundário de um deploy.
  local rc="${DEPLOY_DIR}/../lib/runtime-config.ts"
  local route="${DEPLOY_DIR}/../app/api/jobs/refresh-ipf/route.ts"

  # Sem os ficheiros ao alcance, estas seis asserções seriam saltadas em
  # silêncio — e um teste que não corre parece um teste que passa. Falhar
  # é a única resposta honesta.
  if [ ! -f "$rc" ] || [ ! -f "$route" ]; then
    bad_ "ficheiros da guarda do refresh-ipf não alcançáveis (${rc}, ${route})"
    return 1
  fi

  assert "guarda do refresh-ipf tem default falso" \
    grep -q 'boolEnv("REFRESH_IPF_MULTI_TENANT_ENABLED", false)' "$rc"
  assert "refresh-ipf mantém o caminho legacy"    grep -q 'handleLegacy' "$route"
  assert "refresh-ipf tem o caminho multi-tenant" grep -q 'handleMultiTenant' "$route"
  # A negação é o que garante que o default cai no legacy.
  assert "multi-tenant só corre com a guarda ligada" \
    grep -q 'if (!refreshIpfMultiTenantEnabled())' "$route"
  assert "legacy continua a usar legacyPrisma"    grep -q 'runIpfPopulate(legacyPrisma' "$route"
  assert "resposta identifica o fluxo (mode)"     grep -q 'mode: "legacy"' "$route"

  assert "platform.env fixa a guarda a 0" \
    grep -q '^REFRESH_IPF_MULTI_TENANT_ENABLED=0$' "${SCRIPTS_DIR}/install-platform.sh"
  assert "platform.env fixa o scheduler a 0" \
    grep -q '^SCHEDULER_ENABLED=0$' "${SCRIPTS_DIR}/install-platform.sh"
  assert "platform.env fecha o fallback legacy" \
    grep -q '^ALLOW_LEGACY_DATABASE_FALLBACK=0$' "${SCRIPTS_DIR}/install-platform.sh"
}

# ═════════════════════════════════════════════════════════════════════════
# 8. Backup e restauro
# ═════════════════════════════════════════════════════════════════════════
test_backup_restore() {
  printf '\n8. Backup e restauro\n'
  local restore="${SCRIPTS_DIR}/restore-platform.sh"

  # A regressão que motivou este bloco: `pg_restore -j` a partir do
  # stdin devolve sempre "parallel restore from standard input is not
  # supported". O restauro falhava em 100% dos casos.
  refute "pg_restore -j NUNCA a partir do stdin" \
    bash -c "grep -E 'pgx_in pg_restore' '$restore' | grep -q '\-j '"
  assert "restauro paralelo usa um ficheiro" \
    bash -c "grep -A2 'restauro paralelo' '$restore' | grep -q 'in_container'"
  assert "existe fallback sequencial"        grep -q 'restauro sequencial' "$restore"
  assert "backups montados no postgres"      grep -q '/backups:ro' "$COMPOSE"
  assert "montagem dos backups é read-only" \
    bash -c "service_block postgres | grep -q ':/backups:ro'"
  assert "BACKUP_DIR exportado para o compose" \
    grep -q 'BACKUP_DIR=\${SPHARMMT_BACKUP_DIR}' "${SCRIPTS_DIR}/install-stack.sh"
}

# ═════════════════════════════════════════════════════════════════════════
# 9. PostgreSQL
# ═════════════════════════════════════════════════════════════════════════
test_postgres() {
  printf '\n9. PostgreSQL\n'
  assert "role da aplicação sem superuser"  grep -q 'NOSUPERUSER' "$PG_INIT"
  assert "role sem CREATEDB"                grep -q 'NOCREATEDB' "$PG_INIT"
  assert "role sem CREATEROLE"              grep -q 'NOCREATEROLE' "$PG_INIT"
  assert "init verifica o que fez"          grep -q 'não é superutilizador' "$PG_INIT"
  assert "init é idempotente (verifica antes)" grep -q 'exists_db' "$PG_INIT"
  assert "base do control plane criada"     grep -q 'POSTGRES_CONTROL_DB' "$PG_INIT"
  assert "PUBLIC revogado nas bases"        grep -q 'REVOKE ALL ON DATABASE' "$PG_INIT"
  # ── Dono do PGDATA ───────────────────────────────────────────────────
  # O PGDATA é do utilizador `postgres` DA IMAGEM (999), não do `deploy`.
  # Repor deploy:spharmmt levava o servidor a
  #   PANIC: could not open control file "pg_control": Permission denied
  # no primeiro checkpoint — depois de arrancar bem, porque o entrypoint
  # é root. Reproduzido em deploy/tests/live-pgdata.sh.
  local common="${SCRIPTS_DIR}/lib/common.sh"
  local platform="${SCRIPTS_DIR}/install-platform.sh"
  local bootstrap="${SCRIPTS_DIR}/bootstrap-vps.sh"
  local prepare="${SCRIPTS_DIR}/prepare-data-disk.sh"
  local verify="${SCRIPTS_DIR}/verify-platform.sh"

  assert "uid/gid do postgres definidos em common.sh" grep -q 'SPHARMMT_PG_UID:=999' "$common"
  assert "existe ensure_pgdata_dir"                   grep -q '^ensure_pgdata_dir()' "$common"
  assert "uid/gid lidos da imagem"                    grep -q '^pg_image_uid_gid()' "$common"
  assert "guarda de servidor em execução"             grep -q '^pg_is_running()' "$common"
  assert "recusa mexer com o PostgreSQL a correr" \
    grep -q 'NÃO vai ser alterado' "$common"

  # Nenhum script de estrutura pode voltar a chownar o PGDATA para o deploy.
  local s
  for s in "$platform" "$bootstrap" "$prepare"; do
    refute "$(basename "$s"): não chowna o PGDATA para o deploy" \
      grep -qE 'ensure_dir "\$\{?SPHARMMT_POSTGRES_DATA_DIR\}?" [0-9]+ "\$(owner|OWNER)"' "$s"
    assert "$(basename "$s"): usa ensure_pgdata_dir" grep -q 'ensure_pgdata_dir' "$s"
  done
  refute "prepare-data-disk não chowna postgres/data para o deploy" \
    grep -qE 'ensure_dir "\$\{MOUNT_POINT\}/postgres/data" [0-9]+ "\$owner"' "$prepare"

  # O install-stack lê o uid da imagem e persiste-o.
  assert "install-stack lê o uid da imagem"     grep -q 'pg_image_uid_gid "\$pg_image"' "${SCRIPTS_DIR}/install-stack.sh"
  assert "install-stack persiste no platform.conf" grep -q 'persist_conf_key SPHARMMT_PG_UID' "${SCRIPTS_DIR}/install-stack.sh"
  assert "install-stack aplica antes do arranque" \
    bash -c "[ \$(grep -n 'ensure_pgdata_dir' '${SCRIPTS_DIR}/install-stack.sh' | head -1 | cut -d: -f1) -lt \$(grep -n 'dct up -d postgres' '${SCRIPTS_DIR}/install-stack.sh' | head -1 | cut -d: -f1) ]"

  # ── FONTE ÚNICA DE VERDADE ───────────────────────────────────────────
  # A regra do PGDATA vive só em `pgdata_owner_ok`. Duas implementações
  # divergiram uma vez — o install-stack.sh punha uid 999, o PostgreSQL
  # passava CHECKPOINT, e o verificador reprovava com
  # "postgres/data owner deploy:spharmmt".
  assert "pgdata_owner_ok definida em common.sh"  grep -q '^pgdata_owner_ok()' "$common"
  assert "ensure_pgdata_dir usa pgdata_owner_ok"  \
    bash -c "sed -n '/^ensure_pgdata_dir()/,/^}/p' '$common' | grep -q 'pgdata_owner_ok'"
  assert "verify usa pgdata_owner_ok"             grep -q 'check .* pgdata_owner_ok' "$verify"

  # O verificador NÃO pode ter a sua própria leitura da regra.
  refute "verify NÃO exige deploy:spharmmt no PGDATA" \
    grep -q "postgres/data owner \${SPHARMMT_USER}" "$verify"
  refute "verify NÃO compara o uid por sua conta" \
    bash -c "grep -E \"stat -c '%u' \\\$\\{SPHARMMT_PG_DIR\\}/data\" '$verify' | grep -q ."
  refute "verify NÃO reimplementa o teste de modo do PGDATA" \
    bash -c "grep -E \"stat -c '%a' \\\$\\{SPHARMMT_PG_DIR\\}/data\" '$verify' | grep -q ."
  assert "verify corre um CHECKPOINT real"        grep -q 'CHECKPOINT escreve no PGDATA' "$verify"

  # ── A cópia instalada não pode ficar para trás ───────────────────────
  # O operador corre /opt/spharmmt/scripts/verify-platform.sh. Se só o
  # install-platform.sh a refrescasse, um `git pull` + install-stack.sh
  # deixava-a a validar com regras antigas — que foi o que aconteceu.
  assert "instalação dos scripts numa função partilhada" \
    grep -q '^install_operational_scripts()' "$common"
  assert "install-platform usa-a"  grep -q 'install_operational_scripts' "$platform"
  assert "install-stack TAMBÉM a usa" \
    grep -q 'install_operational_scripts' "${SCRIPTS_DIR}/install-stack.sh"
  assert "install-stack valida que a cópia está actualizada" \
    grep -q 'installed_scripts_current' "${SCRIPTS_DIR}/install-stack.sh"
  assert "verify-platform.sh está na lista instalada" \
    grep -q 'SPHARMMT_OPERATIONAL_SCRIPTS=.*verify-platform.sh' "$common"

  # ── Origens das Server Actions ───────────────────────────────────────
  # Entram no BUILD: o Next fixa allowedOrigins no bundle do servidor.
  # Sem elas, atrás do proxy o Origin do browser não bate com o Host e
  # cada submissão de formulário morre em "Invalid Server Actions request".
  # Sem o ficheiro ao alcance, estas asserções seriam saltadas em
  # silêncio — e um teste que não corre parece um teste que passa.
  local nextconf="${DEPLOY_DIR}/../next.config.ts"
  if [ ! -f "$nextconf" ]; then
    bad_ "next.config.ts não alcançável em ${nextconf}"
  else
    assert "next.config define allowedOrigins" grep -q 'allowedOrigins' "$nextconf"
    refute "next.config NÃO tem curinga global escrito à mão" \
      bash -c "grep -E 'allowedOrigins.*\[\s*\"\*\"' '$nextconf' | grep -q ."
  fi
  assert "Dockerfile recebe a origem como ARG" \
    grep -q 'ARG SERVER_ACTIONS_ALLOWED_ORIGINS' "$DOCKERFILE"
  assert "ARG é exportado como ENV antes do build" \
    bash -c "[ \$(grep -n 'ENV SERVER_ACTIONS_ALLOWED_ORIGINS' '$DOCKERFILE' | head -1 | cut -d: -f1) -lt \$(grep -n 'RUN npm run build' '$DOCKERFILE' | head -1 | cut -d: -f1) ]"
  # POR SERVIÇO, e não um grep ao ficheiro inteiro. A versão global
  # («o compose menciona SERVER_ACTIONS_ALLOWED_ORIGINS algures») passava
  # com o `web` a tê-lo e o `migrate` não — que foi exactamente o que
  # aconteceu. E o `migrate` precisa mesmo: o stage `migrator` faz
  # COPY --from=builder, portanto constrói o builder e corre lá o
  # `npm run build`.
  local svc key
  for svc in web migrate; do
    for key in SERVER_ACTIONS_ALLOWED_ORIGINS PUBLIC_APP_URL; do
      assert "compose: ${svc} passa ${key} como build arg" \
        bash -c "service_block ${svc} | awk '/^    build:/{b=1;next} b&&/^    [a-z]/{b=0} b' | grep -q '^ *${key}:'"
    done
  done
  assert "migrator depende mesmo do builder (por isso precisa dos args)" \
    grep -q 'COPY --from=builder' "$DOCKERFILE"
  assert "platform.env declara a variável" \
    grep -q '^SERVER_ACTIONS_ALLOWED_ORIGINS=' "$platform"
  assert "install-platform inclui o túnel 127.0.0.1 por defeito" \
    grep -q 'server_actions_origins="127.0.0.1:' "$platform"
  assert "install-stack propaga para o stack.env" \
    grep -q 'SERVER_ACTIONS_ALLOWED_ORIGINS=${SERVER_ACTIONS_ALLOWED_ORIGINS}' "${SCRIPTS_DIR}/install-stack.sh"
  assert "install-stack recusa curinga global" \
    grep -q 'curinga global' "${SCRIPTS_DIR}/install-stack.sh"
  assert "install-stack exige a lista ou PUBLIC_APP_URL" \
    grep -q 'origens das Server Actions por definir' "${SCRIPTS_DIR}/install-stack.sh"

  # A propagação é verificada CONTRA O COMPOSE RESOLVIDO, antes do build.
  # Um `npm ci` + `next build` são minutos; descobrir no fim que a imagem
  # saiu sem origens custa-os duas vezes.
  local istack="${SCRIPTS_DIR}/install-stack.sh"
  assert "install-stack verifica os build args no compose resolvido" \
    grep -q 'assert_build_args_propagated()' "$istack"
  assert "a verificação é chamada" \
    bash -c "grep -c '^ *assert_build_args_propagated\$' '$istack' | grep -qv '^0\$'"
  assert "verificação ANTES do build (validate_compose precede build_images)" \
    bash -c "[ \$(grep -n '^ *validate_compose\$' '$istack' | tail -1 | cut -d: -f1) -lt \$(grep -n '^ *build_images\$' '$istack' | tail -1 | cut -d: -f1) ]"
  assert "distingue 'chave ausente' de 'chave vazia'" \
    grep -q 'if (!found) exit 1' "$istack"

  # ── Comandos do perfil tools ─────────────────────────────────────────
  # A imagem migrator só copia sub-directórios escolhidos de scripts/.
  # `tenant:create` aponta para scripts/admin/create-client.ts e faltava:
  # o comando oficial de criação de tenants morria com
  # ERR_MODULE_NOT_FOUND, e só na VPS.
  local manifest="${DOCKER_DIR}/tools-scripts.txt"
  local auditor="${DOCKER_DIR}/audit-tools-entrypoints.mjs"
  assert "manifesto dos comandos operacionais existe" test -f "$manifest"
  assert "auditor de entrypoints existe"              test -f "$auditor"
  assert "o build corre a auditoria" \
    grep -q 'RUN node deploy/docker/audit-tools-entrypoints.mjs' "$DOCKERFILE"
  assert "a auditoria corre DEPOIS dos COPY do migrator" \
    bash -c "[ \$(grep -n 'RUN node deploy/docker/audit-tools' '$DOCKERFILE' | cut -d: -f1) -gt \$(grep -n 'COPY scripts/admin' '$DOCKERFILE' | cut -d: -f1) ]"
  # Uma continuação de linha escrita como `\n` LITERAL em vez de `\` no
  # fim da linha. Aconteceu num COPY multi-linha do migrator e passou
  # despercebido: a verificação genérica lá em baixo parte as linhas por
  # espaços, portanto continuava a ver os dois ficheiros como copiados.
  # Quem apanhava era o `docker build`, que ninguém corre a cada commit.
  #
  # Vale para o ficheiro todo. Se um dia um `RUN printf` precisar mesmo de
  # um `\n`, é esta asserção que se estreita — não o hábito de a ignorar.
  refute "Dockerfile sem '\\n' literal (continuação de linha partida)" \
    grep -qF '\n' "$DOCKERFILE"
  assert "tenant:create está no manifesto" \
    grep -qx 'tenant:create' "$manifest"
  assert "o Dockerfile copia o entrypoint do tenant:create" \
    grep -q 'scripts/admin/create-client.ts' "$DOCKERFILE"
  assert "o Dockerfile copia o entrypoint do reset-user-password" \
    grep -q 'scripts/admin/reset-user-password.ts' "$DOCKERFILE"
  # Copiar a pasta inteira traria 43 scripts ad-hoc de investigação.
  refute "NÃO copia scripts/admin inteiro" \
    bash -c "grep -qE '^COPY scripts/admin \./scripts/admin\$' '$DOCKERFILE'"

  # Todo o comando do manifesto tem de existir no package.json — senão o
  # manifesto deixa de descrever o que a imagem serve.
  local pkg="${DEPLOY_DIR}/../package.json" cmdname
  if [ ! -f "$pkg" ]; then
    bad_ "package.json não alcançável em ${pkg}"
  else
    while read -r cmdname; do
      [ -n "$cmdname" ] || continue
      assert "package.json define ${cmdname}" \
        grep -q "\"${cmdname}\":" "$pkg"
    done < <(sed 's/#.*$//' "$manifest" | tr -d ' \t' | grep .)

    # ── …e um COPY do migrator que o cobra ────────────────────────────
    #
    # As asserções acima são por nome e só cobrem o que alguém se lembrou
    # de lá pôr. Foi essa a lacuna: `catalog:knowledge-enrich` entrou no
    # manifesto, o Dockerfile não copiava o ficheiro, e nada aqui reparou.
    # A auditoria do build apanhava-o — mas só corre para quem constrói a
    # imagem, e o sintoma chegou à VPS na mesma:
    #   npm run catalog:knowledge-enrich → ERR_MODULE_NOT_FOUND
    #
    # Esta verificação é genérica: vale para o comando seguinte, que ainda
    # ninguém escreveu. Um COPY cobre um entrypoint quando o copia
    # directamente ou quando copia um directório acima dele.
    #
    # Cobre o ENTRYPOINT, não os imports dele — o fecho transitivo é caro
    # em bash e já é o trabalho do audit-tools-entrypoints.mjs, que corre
    # dentro do build com o sistema de ficheiros real da imagem.
    local mig_copies entry cmdline covered src
    # Origens dos COPY do estágio migrator. `--from=` refere-se a outro
    # estágio e não ao contexto; destinos (`./x`, `/x`) não são origens.
    mig_copies=$(awk '
      # Defensivo: o Dockerfile está em LF hoje, mas o repositório é
      # editado em Windows e o .gitattributes já mudou. Com CRLF, o `\` de
      # continuação deixa de estar em fim de linha, as linhas seguintes de
      # um COPY multi-linha caem da lista, e o teste passava a dar por não
      # copiado exactamente o que está copiado.
      { sub(/\r$/, "") }
      /^FROM .* AS migrator/ { inmig = 1; next }
      /^FROM /               { inmig = 0 }
      inmig && /^COPY /      { cont = 1 }
      cont {
        line = $0
        more = (line ~ /\\$/)
        sub(/\\$/, "", line)
        sub(/^COPY /, "", line)
        if (line !~ /--from=/) print line
        cont = more
      }
    ' "$DOCKERFILE" | tr ' ' '\n' | grep -vE '^(\./|/|$)' | sort -u)

    while read -r cmdname; do
      [ -n "$cmdname" ] || continue
      cmdline=$(sed -n "s/.*\"${cmdname}\": *\"\([^\"]*\)\".*/\1/p" "$pkg" | head -1)
      entry=$(printf '%s\n' "$cmdline" | tr ' ' '\n' | grep -E '\.(ts|tsx|mjs|cjs|js)$' | head -1)
      # Comando sem ficheiro (o CLI do Prisma) não exige COPY nenhum.
      [ -n "$entry" ] || continue

      covered=0
      while read -r src; do
        [ -n "$src" ] || continue
        case "$entry" in
          "$src"|"${src%/}"/*) covered=1; break ;;
        esac
      done <<< "$mig_copies"

      assert "migrator copia o entrypoint de ${cmdname} (${entry})" \
        test "$covered" -eq 1
    done < <(sed 's/#.*$//' "$manifest" | tr -d ' \t' | grep .)
  fi

  # O fixture do live-tenant-lifecycle.sh assume TENANT_DB_SSLMODE=disable
  # porque é o que o install-platform.sh escreve. Se um deixar de o fazer,
  # o outro passa a testar uma configuração que ninguém tem.
  assert "install-platform escreve TENANT_DB_SSLMODE" \
    grep -q '^TENANT_DB_SSLMODE=' "$platform"

  assert "afinação conservadora presente"   grep -q 'shared_buffers=' "$COMPOSE"
  assert "max_connections limitado"         grep -q 'max_connections=100' "$COMPOSE"
  assert "checksums de dados no initdb"     grep -q 'data-checksums' "$COMPOSE"
}

# ═════════════════════════════════════════════════════════════════════════
# 10. Proxy
# ═════════════════════════════════════════════════════════════════════════
test_proxy() {
  printf '\n10. Reverse proxy\n'
  assert "healthz não toca no upstream" \
    bash -c "grep -A4 'location = /healthz' '$NGINX' | grep -q 'return 200'"
  # Reescrever o Host faria todos os pedidos resolverem para o mesmo
  # tenant — ou para nenhum.
  assert "Host original preservado"         grep -q 'proxy_set_header Host              \$host' "$NGINX"
  assert "cabeçalhos de tenant limpos na entrada" \
    grep -q 'proxy_set_header X-Tenant-Slug   ""' "$NGINX"
  assert "corpo grande permitido (ingest)"  grep -q 'client_max_body_size 64m' "$NGINX"
  assert "timeout acomoda jobs de 300s"     grep -q 'proxy_read_timeout 310s' "$NGINX"
  assert "cabeçalhos de segurança"          grep -q 'X-Content-Type-Options' "$NGINX"
  # Anunciar HSTS sobre HTTP tranca o browser em HTTPS contra um servidor
  # que ainda não o tem.
  refute "HSTS ainda NÃO activo (acesso em HTTP)" \
    bash -c "grep -E '^\s*add_header Strict-Transport-Security' '$NGINX' | grep -qv '^#'"
  assert "bloco HTTPS preparado"            grep -q 'ssl_certificate' "$NGINX"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: configuração da stack ===\n'
  if [ ! -f "$COMPOSE" ]; then
    printf '  compose não encontrado em %s — nada a testar\n' "$COMPOSE"
    return 1
  fi
  test_files
  test_exposure
  test_hardening
  test_pinning
  test_secrets
  test_migrations
  test_scheduler
  test_backup_restore
  test_postgres
  test_proxy

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
