#!/usr/bin/env bash
# deploy/scripts/verify-platform.sh
#
# Checklist automática do servidor. É a fonte de verdade sobre "está pronto?"
# e o único comando que deve ser corrido depois de qualquer alteração à
# infraestrutura — bootstrap, instalação, actualização, restauro ou reboot.
#
# Cobre, por secção: sistema · segurança · Docker · volumes e permissões ·
# segredos · stack · PostgreSQL · proxy · healthchecks · backups · logs ·
# recursos.
#
# Tudo o que ainda não existe é reportado como SKIP, não como falha — o
# mesmo script serve a fase de preparação e a operação corrente.
#
# Uso:
#   sudo ./verify-platform.sh              # checklist completa
#   sudo ./verify-platform.sh --json <f>   # escreve também o resultado em JSON
#   sudo ./verify-platform.sh --section seguranca
#
# Saída: 0 = tudo verde (avisos permitidos) · 3 = pelo menos uma falha
#        · 2 = pré-condição

set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

JSON_OUT=""
ONLY_SECTION=""

usage() {
  cat <<EOF
Uso: sudo $0 [opções]

  --json <ficheiro>   Escreve o resultado em JSON (para monitorização)
  --section <nome>    Só uma secção: sistema | seguranca | docker | volumes |
                      segredos | stack | postgres | proxy | monitorizacao |
                      backups | logs | recursos
$(common_flags_help)

Correr sem sudo funciona, mas várias verificações (sshd -T, ufw, fail2ban,
segredos) ficam em SKIP por falta de permissões.
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --json) JSON_OUT=${2:?}; shift 2 ;;
    --section) ONLY_SECTION=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die_usage "opção desconhecida: $1" ;;
  esac
done

# ─────────────────────────────────────────────────────────────────────────
# Secções
# ─────────────────────────────────────────────────────────────────────────
#
# `--section monitoring` (em inglês) não correspondia a nenhuma secção: o
# `want` devolvia falso em todas, zero verificações corriam, e o relatório
# declarava sucesso. Um filtro que não corresponde a nada é um erro do
# operador, não um servidor saudável.
SECTIONS="sistema seguranca docker volumes segredos stack postgres proxy monitorizacao backups logs recursos"

# Aceita o nome em inglês e algumas variantes óbvias.
normalize_section() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    sistema|system)                       printf 'sistema' ;;
    seguranca|segurança|security)         printf 'seguranca' ;;
    docker)                               printf 'docker' ;;
    volumes|permissoes|permissões|permissions) printf 'volumes' ;;
    segredos|secrets)                     printf 'segredos' ;;
    stack|compose)                        printf 'stack' ;;
    postgres|postgresql|pg)               printf 'postgres' ;;
    proxy)                                printf 'proxy' ;;
    monitorizacao|monitorização|monitoring|monitor) printf 'monitorizacao' ;;
    backups|backup)                       printf 'backups' ;;
    logs|log)                             printf 'logs' ;;
    recursos|resources)                   printf 'recursos' ;;
    *)                                    return 1 ;;
  esac
  return 0
}

if [ -n "$ONLY_SECTION" ]; then
  if ! ONLY_SECTION=$(normalize_section "$ONLY_SECTION"); then
    err "secção desconhecida: '${ONLY_SECTION}'"
    err "secções válidas: ${SECTIONS}"
    err "(os nomes em inglês também são aceites: monitoring, security, secrets, resources, ...)"
    finish "$EX_USAGE"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# Permissões — o que é sensível e o que não é
# ─────────────────────────────────────────────────────────────────────────
#
# A varredura começou por ser a árvore inteira, o que acusava ficheiros
# legitimamente legíveis (um README.md a 0644) e treinava qualquer pessoa
# a ignorar o check. Foi reduzida ao que é mesmo sensível — e depois
# ainda acusava dois casos correctos:
#
#   2755 deploy:spharmmt  /data/postgres/init
#   755  deploy:spharmmt  /data/postgres/init/10-databases.sh
#
# Esses scripts NÃO são segredos e TÊM de ser legíveis e executáveis: o
# entrypoint do container do PostgreSQL corre-os como utilizador
# `postgres`, que não é o dono deles no host. Fechá-los partiria a
# inicialização. `postgres/conf` está no mesmo caso.
#
# A exclusão é do DIRECTÓRIO, nunca do conteúdo sensível: qualquer
# ficheiro com cara de credencial (*.env, chave privada, certificado)
# continua a ser apanhado onde quer que esteja, incluindo dentro de
# init/ e conf/. É isso que torna seguro excluí-los.

# NOTA sobre o ShellCheck: as funções desta secção são invocadas
# INDIRECTAMENTE, como argumento de `check "<label>" <fn>` — o
# ShellCheck não segue essa indirecção e reporta SC2329 ("never
# invoked"). Suprimido aqui, com esta justificação, e nunca globalmente.
# O test-sensitive-perms.sh exercita todas elas.

# Árvores onde NADA pode ser acessível a others.
# shellcheck disable=SC2329
sensitive_paths() {
  local p
  for p in "${SPHARMMT_ROOT}/secrets" \
           "${SPHARMMT_ROOT}/docker/env" \
           "${SPHARMMT_BACKUP_DIR}" \
           "${SPHARMMT_POSTGRES_DATA_DIR}"; do
    [ -e "$p" ] && printf '%s\n' "$p"
  done
  return 0
}

# `${SPHARMMT_PG_DIR}` (=/data/postgres) NÃO entra na lista acima: contém
# `init/` e `conf/`, que são configuração pública. O que dela é sensível é
# `postgres/data`, e esse está listado explicitamente.
# shellcheck disable=SC2329
no_world_access_in_sensitive() {
  local roots=() p
  while IFS= read -r p; do [ -n "$p" ] && roots+=("$p"); done < <(sensitive_paths)
  [ "${#roots[@]}" -gt 0 ] || return 0
  [ -z "$(find "${roots[@]}" -perm /o+rwx -print -quit 2>/dev/null)" ]
}

# Nomes que denunciam uma credencial. Procurados em TODA a árvore da
# plataforma e dos dados — a exclusão de init/ e conf/ do check acima não
# se aplica aqui, de propósito: uma chave privada esquecida em conf/ é
# exactamente o caso que isto tem de apanhar.
# shellcheck disable=SC2329
credential_names() {
  printf '%s\n' '*.env' '*.key' '*.pem' '*.p12' '*.pfx' '*.jks' '*.crt.key' \
                '.pgpass' 'id_rsa' 'id_rsa*' 'id_ed25519' 'id_ed25519*' \
                '*.keystore' 'privkey*.pem' '*-key.pem'
}

# Preenche CRED_EXPR com `( -name A -o -name B ... )` para o find.
#
# Um ARRAY, e não uma string passada a `eval`. A primeira versão montava
# a expressão como texto: os parênteses ficavam sem aspas (o bash lia-os
# como subshell) e os `*.env` eram expandidos pelo shell antes de o find
# os ver. O comando rebentava, o stderr ia para /dev/null, e a função
# devolvia "limpo" — um check que passava SEMPRE, incluindo com segredos
# expostos. Com o array, cada padrão chega intacto ao find, que é quem
# tem de fazer o glob.
# shellcheck disable=SC2329
_credential_expr() {
  CRED_EXPR=( '(' )
  local first=1 n
  while IFS= read -r n; do
    [ -z "$n" ] && continue
    if [ "$first" = "1" ]; then first=0; else CRED_EXPR+=( '-o' ); fi
    CRED_EXPR+=( -name "$n" )
  done < <(credential_names)
  CRED_EXPR+=( ')' )
}

# shellcheck disable=SC2329
no_world_readable_credentials() {
  local roots=() p
  for p in "$SPHARMMT_ROOT" "$SPHARMMT_DATA_ROOT"; do
    [ -d "$p" ] && roots+=("$p")
  done
  [ "${#roots[@]}" -gt 0 ] || return 0

  local CRED_EXPR=(); _credential_expr
  [ -z "$(find "${roots[@]}" -type f "${CRED_EXPR[@]}" -perm /o+rwx -print -quit 2>/dev/null)" ]
}

# shellcheck disable=SC2329
_dir_has_no_credentials() {
  local d=$1
  [ -d "$d" ] || return 0
  local CRED_EXPR=(); _credential_expr
  [ -z "$(find "$d" -type f "${CRED_EXPR[@]}" -print -quit 2>/dev/null)" ]
}

# O directório de init é legível de propósito. Estas verificações
# garantem que continua a ser SÓ scripts — se alguém lá deixar um .env ou
# uma chave, a exclusão deixaria de ser segura e isto acusa-o.
# shellcheck disable=SC2329
init_dir_has_no_credentials() { _dir_has_no_credentials "${SPHARMMT_PG_DIR}/init"; }

# `conf/` só pode ser excluído ENQUANTO não tiver credenciais. Um
# `.pgpass`, um certificado de cliente ou uma chave de replicação lá
# dentro mudam-lhe a natureza, e a exclusão passa a ser um buraco.
# shellcheck disable=SC2329
conf_dir_has_no_credentials() { _dir_has_no_credentials "${SPHARMMT_PG_DIR}/conf"; }

IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1
HAS_STACK=0; [ -f "$SPHARMMT_COMPOSE_FILE" ] && HAS_STACK=1
HAS_PG=0; container_exists "$SPHARMMT_PG_CONTAINER" 2>/dev/null && HAS_PG=1

want() { [ -z "$ONLY_SECTION" ] || [ "$ONLY_SECTION" = "$1" ]; }

# ═════════════════════════════════════════════════════════════════════════
sec_sistema() {
  want sistema || return 0
  step "1. Sistema"
  check "Ubuntu 24.04 LTS"              bash -c "grep -q 'VERSION_ID=\"24.04\"' /etc/os-release"
  check "sem pacotes por actualizar"    bash -c "[ \$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst') -eq 0 ]"
  check_warn "sem reboot pendente"      bash -c "[ ! -f /var/run/reboot-required ]"
  check "unattended-upgrades instalado" is_installed unattended-upgrades
  check "timer apt-daily-upgrade activo" svc_active apt-daily-upgrade.timer
  check "política de security aplicada" test -f /etc/apt/apt.conf.d/52spharmmt-unattended
  check "relógio sincronizado (NTP)"    bash -c "timedatectl show -p NTPSynchronized --value | grep -q yes"
  check "timezone definida"             bash -c "[ -n \"\$(timedatectl show -p Timezone --value)\" ]"
  check "hostname resolve localmente"   bash -c "getent hosts \$(hostnamectl --static) >/dev/null"
  check_warn "swap activa"              bash -c "[ \$(free -m | awk '/^Swap:/ {print \$2}') -gt 0 ]"
  check "vm.swappiness <= 20"           bash -c "[ \$(sysctl -n vm.swappiness) -le 20 ]"
  check "sysctl do SPharm.MT aplicado"  test -f /etc/sysctl.d/60-spharmmt.conf
}

# ═════════════════════════════════════════════════════════════════════════
sec_seguranca() {
  want seguranca || return 0
  step "2. Segurança"

  # ── Utilizadores
  check "utilizador ${SPHARMMT_USER} existe"  id "$SPHARMMT_USER"
  check "${SPHARMMT_USER} tem sudo"           bash -c "id -nG ${SPHARMMT_USER} | grep -qw sudo"
  check "grupo ${SPHARMMT_GROUP} existe"      getent group "$SPHARMMT_GROUP"
  if [ "$IS_ROOT" = "1" ]; then
    check "sudoers válido"                    visudo -c
  else
    check_skip "sudoers válido" "requer root"
  fi

  # ── SSH
  #
  # TUDO aqui é verificado pelo valor EFECTIVO (`sshd -T`), nunca pelo
  # conteúdo dos ficheiros. Com vários drop-ins e a regra "primeiro valor
  # vence", um ficheiro correcto pode estar completamente inerte — foi
  # assim que o endurecimento passou despercebido numa VPS cujo
  # 50-cloud-init.conf reactivava a password.
  if [ "$IS_ROOT" = "1" ] && has_cmd sshd; then
    local ctx
    ctx="user=${SPHARMMT_USER},host=$(hostname),addr=127.0.0.1"
    check "configuração sshd válida"          sshd -t
    check "PasswordAuthentication no (efectivo)" \
      bash -c "[ \"\$(sshd -T 2>/dev/null | awk 'tolower(\$1)==\"passwordauthentication\"{print tolower(\$2);exit}')\" = no ]"
    check "PubkeyAuthentication yes (efectivo)" \
      bash -c "[ \"\$(sshd -T 2>/dev/null | awk 'tolower(\$1)==\"pubkeyauthentication\"{print tolower(\$2);exit}')\" = yes ]"
    check "KbdInteractiveAuthentication no (efectivo)" \
      bash -c "[ \"\$(sshd -T 2>/dev/null | awk 'tolower(\$1)==\"kbdinteractiveauthentication\"{print tolower(\$2);exit}')\" = no ]"
    check "PermitEmptyPasswords no (efectivo)" \
      bash -c "[ \"\$(sshd -T 2>/dev/null | awk 'tolower(\$1)==\"permitemptypasswords\"{print tolower(\$2);exit}')\" = no ]"
    check "UsePAM yes (efectivo)" \
      bash -c "[ \"\$(sshd -T 2>/dev/null | awk 'tolower(\$1)==\"usepam\"{print tolower(\$2);exit}')\" = yes ]"
    check "MaxAuthTries <= 3"                 bash -c "[ \$(sshd -T 2>/dev/null | awk '/^maxauthtries/ {print \$2}') -le 3 ]"
    check_warn "PermitRootLogin no"           bash -c "sshd -T 2>/dev/null | grep -qi '^permitrootlogin no'"
    check "AllowUsers inclui ${SPHARMMT_USER}" \
      bash -c "sshd -T 2>/dev/null | awk 'tolower(\$1)==\"allowusers\"' | grep -qw '${SPHARMMT_USER}'"
    # Contexto de ligação concreto: apanha blocos Match que só se aplicam a
    # certos utilizadores ou origens e que poderiam repor a password.
    check "PasswordAuthentication no também em contexto de ligação" \
      bash -c "[ \"\$(sshd -T -C '${ctx}' 2>/dev/null | awk 'tolower(\$1)==\"passwordauthentication\"{print tolower(\$2);exit}')\" = no ]"
    # O nosso drop-in tem de ser lido ANTES dos da imagem cloud.
    check "drop-in do SPharm.MT tem precedência (00-)" \
      bash -c "[ -f /etc/ssh/sshd_config.d/00-spharmmt-hardening.conf ]"
    check_warn "drop-in antigo 99- já não existe" \
      bash -c "[ ! -f /etc/ssh/sshd_config.d/99-spharmmt-hardening.conf ]"
  else
    check_skip "endurecimento SSH" "requer root"
  fi
  # Home real do utilizador — não assumir /home/<user>.
  local uhome
  uhome=$(getent passwd "$SPHARMMT_USER" 2>/dev/null | cut -d: -f6)
  uhome=${uhome:-/home/${SPHARMMT_USER}}
  check "chave em authorized_keys"            bash -c "[ -s '${uhome}/.ssh/authorized_keys' ]"
  check "authorized_keys em modo 600"         bash -c "[ \$(stat -c '%a' '${uhome}/.ssh/authorized_keys' 2>/dev/null) = 600 ]"

  # ── Firewall
  if has_cmd ufw && [ "$IS_ROOT" = "1" ]; then
    check "UFW activa"                        bash -c "ufw status | grep -q '^Status: active'"
    check "UFW arranca no boot"               svc_enabled ufw
    check "default deny incoming"             bash -c "ufw status verbose | grep -q 'deny (incoming)'"
    check "SSH permitido"                     bash -c "ufw status | grep -qE '22/tcp|ssh'"
    if [ "$HAS_STACK" = "1" ]; then
      check_warn "80/443 abertos (proxy no ar)" bash -c "ufw status | grep -qE '^(80|443)/tcp .*ALLOW'"
    else
      check "80 fechado (sem proxy ainda)"    bash -c "! ufw status | grep -qE '^80/tcp .*ALLOW'"
      check "443 fechado (sem proxy ainda)"   bash -c "! ufw status | grep -qE '^443/tcp .*ALLOW'"
    fi
  else
    check_skip "firewall" "requer root e ufw"
  fi

  # ── fail2ban
  check "fail2ban activo"                     svc_active fail2ban
  check "fail2ban arranca no boot"            svc_enabled fail2ban
  if [ "$IS_ROOT" = "1" ] && has_cmd fail2ban-client; then
    check "jail sshd activa"                  fail2ban-client status sshd
    check "banaction = ufw"                   grep -q 'banaction *= *ufw' /etc/fail2ban/jail.local
  else
    check_skip "jails do fail2ban" "requer root"
  fi

  # ── Exposição de portos: a verificação que mais importa neste servidor.
  # O Docker escreve regras de iptables ANTES do UFW; um container
  # publicado em 0.0.0.0 fica acessível da internet apesar da firewall.
  if has_cmd ss; then
    check "PostgreSQL NÃO exposto em 0.0.0.0" \
      bash -c "! ss -tulpnH 2>/dev/null | grep -E '0\.0\.0\.0:5432|\[::\]:5432' | grep -q ."
    check "sem portos inesperados em 0.0.0.0" \
      bash -c "! ss -tulpnH 2>/dev/null | awk '{print \$5}' | grep -E '^0\.0\.0\.0:' | grep -vE ':(22|80|443)\$' | grep -q ."
  else
    check_skip "exposição de portos" "ss indisponível"
  fi
}

# ═════════════════════════════════════════════════════════════════════════
sec_docker() {
  want docker || return 0
  step "3. Docker"
  check "docker instalado"                has_cmd docker
  check "docker do repositório oficial"   bash -c "apt-cache policy docker-ce 2>/dev/null | grep -q download.docker.com"
  check "serviço docker activo"           svc_active docker
  check "docker arranca no boot"          svc_enabled docker
  check "containerd activo"               svc_active containerd
  check "docker compose v2"               docker compose version
  check "buildx disponível"               docker buildx version
  check "daemon responde"                 docker info
  check "daemon.json presente"            test -f /etc/docker/daemon.json
  check "rotação de logs de container"    grep -q '"max-size"' /etc/docker/daemon.json
  check "live-restore activo"             bash -c "docker info 2>/dev/null | grep -q 'Live Restore Enabled: true'"
  check "no-new-privileges activo"        grep -q '"no-new-privileges": true' /etc/docker/daemon.json
  check "rede ${SPHARMMT_NETWORK} existe" docker network inspect "$SPHARMMT_NETWORK"
  check "${SPHARMMT_USER} no grupo docker" bash -c "id -nG ${SPHARMMT_USER} | grep -qw docker"
  # Imagens órfãs acumulam-se silenciosamente e são a segunda causa de
  # disco cheio em hosts Docker, a seguir aos logs.
  check_warn "menos de 20 imagens locais" bash -c "[ \$(docker images -q | wc -l) -lt 20 ]"
}

# ═════════════════════════════════════════════════════════════════════════
sec_volumes() {
  want volumes || return 0
  step "4. Volumes e permissões"
  local d
  # Aplicação e configuração
  for d in app logs docker docker/compose docker/env scripts monitoring secrets proxy; do
    check "${SPHARMMT_ROOT}/${d}"         test -d "${SPHARMMT_ROOT}/${d}"
  done
  # Dados — em /data com disco dedicado, senão no mesmo sítio de sempre
  check "dados: ${SPHARMMT_DATA_ROOT}"    test -d "$SPHARMMT_DATA_ROOT"
  check "${SPHARMMT_POSTGRES_DATA_DIR}"   test -d "$SPHARMMT_POSTGRES_DATA_DIR"
  check "${SPHARMMT_BACKUP_DIR}/postgres" test -d "${SPHARMMT_BACKUP_DIR}/postgres"

  # Coerência entre o que está configurado e o que está montado. Uma
  # instalação feita antes de o disco existir gravava /opt/spharmmt no
  # platform.conf e nunca mais convergia — o disco ficava montado e vazio.
  local detected; detected=$(data_root_candidate)
  if [ -n "$detected" ] && [ "$detected" != "$SPHARMMT_DATA_ROOT" ]; then
    check "data root coerente com o disco montado (${detected})" false
    info "  configurado: ${SPHARMMT_DATA_ROOT} · montado: ${detected}"
    info "  corrige com: sudo ${SPHARMMT_ROOT}/scripts/install-platform.sh --yes"
  else
    check "data root coerente com o que está montado" true
  fi

  if data_disk_in_use; then
    # Um volume de dados configurado mas desmontado é a falha mais
    # perniciosa desta arquitectura: as escritas vão para o disco de
    # sistema e desaparecem quando o volume voltar a montar.
    check "volume de dados MONTADO"       is_mountpoint "$SPHARMMT_DATA_ROOT"
    check "${SPHARMMT_DATA_MOUNT} é mountpoint real (não pasta)" \
      bash -c "[ \"\$(findmnt -no TARGET --target '${SPHARMMT_DATA_MOUNT}' 2>/dev/null)\" = '${SPHARMMT_DATA_MOUNT}' ]"
    check "montagem persistente (fstab)"  bash -c "grep -qE '^[^#]*[[:space:]]${SPHARMMT_DATA_ROOT}[[:space:]]' /etc/fstab"
    check "fstab por UUID (não /dev/sdX)" bash -c "grep -E '[[:space:]]${SPHARMMT_DATA_ROOT}[[:space:]]' /etc/fstab | grep -q '^UUID='"
    check "fstab válido"                  bash -c "findmnt --verify >/dev/null 2>&1"
    check "volume abaixo de 80%"          bash -c "[ \$(df -P '${SPHARMMT_DATA_ROOT}' | awk 'NR==2 {gsub(\"%\",\"\",\$5); print \$5}') -lt 80 ]"
    check "volume gravável"               bash -c "touch '${SPHARMMT_DATA_ROOT}/.spharmmt-wt' && rm -f '${SPHARMMT_DATA_ROOT}/.spharmmt-wt'"
    check_warn "sem dados órfãos no layout antigo" \
      bash -c "[ -z \"\$(ls -A '${SPHARMMT_ROOT}/postgres/data' 2>/dev/null)\" ]"
  else
    check_skip "volume de dados dedicado" "dados no mesmo volume do sistema"
  fi
  check "owner ${SPHARMMT_USER}:${SPHARMMT_GROUP}" \
    bash -c "[ \"\$(stat -c '%U:%G' ${SPHARMMT_ROOT})\" = '${SPHARMMT_USER}:${SPHARMMT_GROUP}' ]"

  # ── secrets ──────────────────────────────────────────────────────────
  # Regra estrita e distinta da dos dados: 0700 root:root, SEM setgid,
  # sem qualquer bit de grupo. Não há grupo a herdar aqui — o setgid só
  # alargaria a superfície sem servir nada.
  check "secrets = 0700 root:root (sem setgid)" \
    bash -c "[ \"\$(stat -c '%a %U:%G' ${SPHARMMT_ROOT}/secrets)\" = '700 root:root' ]"
  check "secrets sem qualquer permissão de grupo" \
    bash -c "[ -z \"\$(find ${SPHARMMT_ROOT}/secrets -maxdepth 0 -perm /g+rwx 2>/dev/null)\" ]"
  check "ficheiros em secrets a 0600 root:root" \
    bash -c "[ -z \"\$(find ${SPHARMMT_ROOT}/secrets -type f \\( ! -perm 600 -o ! -user root -o ! -group root \\) -print -quit 2>/dev/null)\" ]"

  # ── postgres/data ────────────────────────────────────────────────────
  # Expectativa DIFERENTE, de propósito: 2700 é aceite (o setgid mantém a
  # herança de grupo) desde que o owner seja o correcto e não haja bits
  # para "others". O PostgreSQL verifica S_IRWXG|S_IRWXO, e o setgid não
  # entra nessa máscara. UID/GID serão revistos quando o container existir.
  # Dono do PGDATA: uid NUMÉRICO do utilizador `postgres` da imagem (999),
  # e não `deploy:spharmmt`. Comparar nomes não serve — o uid 999 do
  # container pode nem ter nome no host, ou ter outro.
  #
  # Exigir `deploy:spharmmt` aqui era o que validava a configuração que
  # punha o PostgreSQL em PANIC no primeiro checkpoint.
  #
  # Só o UID é comparado. O entrypoint da imagem faz `chown postgres` SEM
  # grupo (`find "$PGDATA" \! -user postgres -exec chown postgres`), pelo
  # que um cluster criado de raiz fica 999:0 e um corrigido à mão fica
  # 999:999 — os dois funcionam. Com o modo a 0700 o grupo não tem acesso
  # nenhum, portanto o seu valor não pode influenciar nada. Exigir gid 999
  # reprovaria qualquer instalação nova.
  local pgdata_gid; pgdata_gid=$(stat -c '%g' "${SPHARMMT_PG_DIR}/data" 2>/dev/null || echo '?')
  info "PGDATA: $(stat -c '%a %u:%g' "${SPHARMMT_PG_DIR}/data" 2>/dev/null || echo '?') · gid ${pgdata_gid} é indiferente com modo 0700"
  check "postgres/data owner uid ${SPHARMMT_PG_UID} (postgres da imagem)" \
    bash -c "[ \"\$(stat -c '%u' ${SPHARMMT_PG_DIR}/data)\" = '${SPHARMMT_PG_UID}' ]"
  # Confronta a configuração com a imagem que está mesmo a correr.
  if container_running "$SPHARMMT_PG_CONTAINER"; then
    check "uid configurado bate com o da imagem em execução" \
      bash -c "[ \"\$(docker exec ${SPHARMMT_PG_CONTAINER} id -u postgres 2>/dev/null)\" = '${SPHARMMT_PG_UID}' ]"
    # O teste decisivo, e o único que distingue "configurado bem" de
    # "consegue mesmo escrever": um CHECKPOINT explícito toca no
    # pg_control, que é exactamente onde aparecia o
    # `PANIC: could not open control file "pg_control": Permission denied`.
    # Pelo socket local o utilizador postgres não precisa de password.
    check "CHECKPOINT escreve no PGDATA" \
      docker exec "$SPHARMMT_PG_CONTAINER" psql -U postgres -d postgres -Atc "CHECKPOINT"
  fi
  check "postgres/data em 0700 ou 2700" \
    bash -c "case \"\$(stat -c '%a' ${SPHARMMT_PG_DIR}/data)\" in 700|2700) exit 0;; *) exit 1;; esac"
  check "postgres/data sem bits para others (exigido pelo PostgreSQL)" \
    bash -c "[ -z \"\$(find ${SPHARMMT_PG_DIR}/data -maxdepth 0 -perm /o+rwx 2>/dev/null)\" ]"

  check "backups/postgres em 0700 ou 2700" \
    bash -c "case \"\$(stat -c '%a' ${SPHARMMT_BACKUP_DIR}/postgres)\" in 700|2700) exit 0;; *) exit 1;; esac"

  # ── Conteúdo sensível ────────────────────────────────────────────────
  check "nada acessível a others em conteúdo sensível" no_world_access_in_sensitive
  check "nenhuma credencial legível por others"        no_world_readable_credentials

  # ── Excluídos, e porquê ──────────────────────────────────────────────
  # Ficam de fora do check acima por serem configuração pública que o
  # container tem de conseguir ler. A exclusão é declarada aqui, com
  # verificações próprias, em vez de ficar implícita numa lista.
  if [ -d "${SPHARMMT_PG_DIR}/init" ]; then
    check "init do PostgreSQL sem ficheiros de credenciais" init_dir_has_no_credentials
    # Legível sim, escrivível por others não: um init writable deixaria
    # qualquer utilizador local executar SQL como superutilizador na
    # próxima inicialização.
    check "init do PostgreSQL não escrivível por others" \
      bash -c "[ -z \"\$(find ${SPHARMMT_PG_DIR}/init -perm /o+w -print -quit 2>/dev/null)\" ]"
    check_skip "init do PostgreSQL legível" "por design — corrido pelo container como utilizador postgres"
  fi
  if [ -d "${SPHARMMT_PG_DIR}/conf" ]; then
    check "conf do PostgreSQL sem ficheiros de credenciais" conf_dir_has_no_credentials
    check "conf do PostgreSQL não escrivível por others" \
      bash -c "[ -z \"\$(find ${SPHARMMT_PG_DIR}/conf -perm /o+w -print -quit 2>/dev/null)\" ]"
  fi

  check "umask 027 em login.defs"        bash -c "grep -qE '^UMASK\\s+027' /etc/login.defs"
  check "setgid na raiz (herança de grupo)" \
    bash -c "[ \$(stat -c '%a' ${SPHARMMT_ROOT}) -ge 2000 ]"
}

# ═════════════════════════════════════════════════════════════════════════
sec_segredos() {
  want segredos || return 0
  step "5. Segredos"
  if [ "$IS_ROOT" != "1" ]; then check_skip "segredos" "requer root"; return 0; fi
  check "ficheiro de segredos existe"     test -f "$SPHARMMT_SECRETS_FILE"
  [ -f "$SPHARMMT_SECRETS_FILE" ] || return 0
  check "modo 0600 root:root" \
    bash -c "[ \"\$(stat -c '%a %U:%G' ${SPHARMMT_SECRETS_FILE})\" = '600 root:root' ]"
  local k
  for k in POSTGRES_SUPERUSER_PASSWORD POSTGRES_APP_PASSWORD AUTH_SECRET \
           TENANT_ENCRYPTION_SECRET EMAIL_CONFIG_SECRET CRON_SECRET ADMIN_API_TOKEN; do
    check "segredo ${k} definido"         grep -qE "^${k}=.+" "$SPHARMMT_SECRETS_FILE"
  done
  check "TENANT_ENCRYPTION_SECRET com 64 hex" \
    grep -qE '^TENANT_ENCRYPTION_SECRET=[0-9a-f]{64}$' "$SPHARMMT_SECRETS_FILE"
  check "nenhum segredo vazio" \
    bash -c "! awk -F= '/^[A-Z_]+=/ && \$2 == \"\" {print}' ${SPHARMMT_SECRETS_FILE} | grep -q ."
  # Segredos em git seria comprometimento total.
  check "segredos fora de /opt/spharmmt/app" \
    bash -c "! find ${SPHARMMT_ROOT}/app -maxdepth 2 -name '*.secrets.env' 2>/dev/null | grep -q ."
  check "env da stack existe"             test -f "$SPHARMMT_ENV_FILE"
  check "env não legível por outros" \
    bash -c "[ \$(stat -c '%a' ${SPHARMMT_ENV_FILE} 2>/dev/null || echo 777) -le 640 ]"
  check "configuração central existe"     test -f "$SPHARMMT_CONF_FILE"
}

# ═════════════════════════════════════════════════════════════════════════
sec_stack() {
  want stack || return 0
  step "6. Stack aplicacional"
  if [ "$HAS_STACK" != "1" ]; then
    check_skip "docker-compose da plataforma" "ainda não instalado (fase seguinte)"
    return 0
  fi
  check "compose config válido"           dc config --no-env-resolution
  local total running
  total=$(dc config --services 2>/dev/null | wc -l)
  running=$(dc ps -q 2>/dev/null | wc -l)
  check "todos os serviços a correr (${running}/${total})" bash -c "[ ${running} -ge ${total} ]"
  check "sem containers unhealthy"        bash -c "[ -z \"\$(docker ps --filter health=unhealthy -q)\" ]"
  check "sem containers parados"          bash -c "[ -z \"\$(docker ps -a --filter status=exited -q)\" ]"
  check "restart policy definida em todos" \
    bash -c "! dc ps -q 2>/dev/null | xargs -r docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' | grep -qx 'no'"
  check "limites de memória definidos" \
    bash -c "! dc ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{.HostConfig.Memory}}' | grep -q ' 0\$'"
  check "no-new-privileges em todos" \
    bash -c "! dc ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{.HostConfig.SecurityOpt}}' | grep -qv 'no-new-privileges'"
  check "limites de log definidos (json-file com rotação)" \
    bash -c "! dc ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{index .HostConfig.LogConfig.Config \"max-size\"}}' | grep -qE ' \$'"

  # ── Aplicação ────────────────────────────────────────────────────────
  if container_exists "$SPHARMMT_APP_CONTAINER"; then
    check "web a correr"                  container_running "$SPHARMMT_APP_CONTAINER"
    check "web NÃO publica portos directamente" \
      bash -c "[ -z \"\$(docker port ${SPHARMMT_APP_CONTAINER} 2>/dev/null)\" ]"
    check "web corre como não-root" \
      bash -c "[ \"\$(docker exec ${SPHARMMT_APP_CONTAINER} id -u 2>/dev/null)\" != '0' ]"
    check "health endpoint responde" \
      bash -c "docker exec ${SPHARMMT_APP_CONTAINER} node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
  else
    check_skip "aplicação web" "container ainda não existe"
  fi

  # ── Worker / scheduler ───────────────────────────────────────────────
  local worker=${SPHARMMT_WORKER_CONTAINER:-spharmmt-worker}
  if container_exists "$worker"; then
    check "worker a correr"               container_running "$worker"
    check "worker corre como não-root" \
      bash -c "[ \"\$(docker exec ${worker} id -u 2>/dev/null)\" != '0' ]"
    # O estado do scheduler é lido no ambiente REAL do processo, não no
    # ficheiro: é o que o worker vê que decide se dispara jobs.
    if [ "$(docker exec "$worker" printenv SCHEDULER_ENABLED 2>/dev/null || echo 0)" = "1" ]; then
      check_warn "scheduler LIGADO — confirma que é intencional" true
    else
      check "scheduler desligado (SCHEDULER_ENABLED≠1)" true
    fi
  else
    check_skip "worker" "container ainda não existe"
  fi
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
sec_postgres() {
  want postgres || return 0
  step "7. PostgreSQL"
  if [ "$HAS_PG" != "1" ]; then
    check_skip "PostgreSQL" "ainda não instalado (fase seguinte)"
    return 0
  fi
  check "container a correr"              container_running "$SPHARMMT_PG_CONTAINER"
  check "aceita ligações (pg_isready)"    docker exec "$SPHARMMT_PG_CONTAINER" pg_isready -q
  check "NÃO publicado em 0.0.0.0" \
    bash -c "! docker port ${SPHARMMT_PG_CONTAINER} 2>/dev/null | grep -q '0.0.0.0'"
  check "dados em volume persistente" \
    bash -c "docker inspect ${SPHARMMT_PG_CONTAINER} -f '{{range .Mounts}}{{.Destination}} {{end}}' | grep -q '/var/lib/postgresql'"
  check "healthcheck definido" \
    bash -c "[ \"\$(docker inspect ${SPHARMMT_PG_CONTAINER} -f '{{if .State.Health}}yes{{end}}')\" = yes ]"
  if [ "$IS_ROOT" = "1" ] && [ -f "$SPHARMMT_SECRETS_FILE" ]; then
    # Ficheiro de segredos gerado em runtime — o caminho não é constante.
    set -a
    # shellcheck disable=SC1090
    . "$SPHARMMT_SECRETS_FILE"
    set +a
    check "autenticação do superutilizador" \
      bash -c "docker exec -e PGPASSWORD='${POSTGRES_SUPERUSER_PASSWORD:-}' ${SPHARMMT_PG_CONTAINER} psql -U postgres -d postgres -c 'SELECT 1'"
    check_warn "conexões abaixo de 80%" \
      bash -c "c=\$(docker exec -e PGPASSWORD='${POSTGRES_SUPERUSER_PASSWORD:-}' ${SPHARMMT_PG_CONTAINER} psql -U postgres -tAc 'SELECT count(*) FROM pg_stat_activity'); m=\$(docker exec -e PGPASSWORD='${POSTGRES_SUPERUSER_PASSWORD:-}' ${SPHARMMT_PG_CONTAINER} psql -U postgres -tAc 'SHOW max_connections'); [ \$((c*100/m)) -lt 80 ]"
  else
    check_skip "autenticação do PostgreSQL" "requer root e ficheiro de segredos"
  fi
}

# ═════════════════════════════════════════════════════════════════════════
sec_proxy() {
  want proxy || return 0
  step "8. Reverse proxy"
  if ! container_exists "$SPHARMMT_PROXY_CONTAINER"; then
    check_skip "reverse proxy" "ainda não instalado (fase seguinte)"
    return 0
  fi
  check "container a correr"              container_running "$SPHARMMT_PROXY_CONTAINER"

  # ── Configuração: o elo que falhou em silêncio ───────────────────────
  # O nginx com o conf.d vazio arranca, passa no `nginx -t`, e não escuta
  # em porto nenhum. Verificar só que o container corre — ou até que o
  # ficheiro existe no HOST — não distingue esse caso de um proxy a
  # funcionar. É preciso olhar para o que está DENTRO do container.
  check "ficheiro no caminho canónico (host)" test -f "$SPHARMMT_PROXY_CONF_FILE"

  # Permissões: o bind mount preserva dono e modo, e o nginx do container
  # é outro uid. Sem r-x para others, `ls /etc/nginx/conf.d` dá
  # "Permission denied", zero server{} são carregados, e o nginx arranca
  # na mesma sem escutar em porto nenhum.
  check "conf.d atravessável por others (0755)" \
    bash -c "[ -z \"\$(find ${SPHARMMT_PROXY_CONF_DIR} -maxdepth 0 ! -perm -o+rx 2>/dev/null)\" ]"
  check "ficheiros .conf legíveis por others (0644)" \
    bash -c "[ -z \"\$(find ${SPHARMMT_PROXY_CONF_DIR} -maxdepth 1 -name '*.conf' ! -perm -o+r -print -quit 2>/dev/null)\" ]"
  check "conf.d NÃO escrivível por others" \
    bash -c "[ -z \"\$(find ${SPHARMMT_PROXY_CONF_DIR} -perm /o+w -print -quit 2>/dev/null)\" ]"
  # certs é o oposto: restrito.
  check "proxy/certs sem acesso para others" \
    bash -c "[ ! -d ${SPHARMMT_ROOT}/proxy/certs ] || [ -z \"\$(find ${SPHARMMT_ROOT}/proxy/certs -maxdepth 0 -perm /o+rwx 2>/dev/null)\" ]"
  check "chaves privadas TLS a 0640 ou mais restrito" \
    bash -c "[ -z \"\$(find ${SPHARMMT_ROOT}/proxy/certs -maxdepth 1 -type f \\( -name '*.key' -o -name 'privkey*.pem' -o -name '*-key.pem' \\) -perm /o+rwx -print -quit 2>/dev/null)\" ]"

  # A prova que interessa, feita com o utilizador real do container.
  check "utilizador nginx consegue listar /etc/nginx/conf.d" \
    docker exec --user nginx "$SPHARMMT_PROXY_CONTAINER" ls /etc/nginx/conf.d

  # Fonte real do bind mount, lida do container. Se alguém mudar o
  # compose ou o PROXY_CONF_DIR, é aqui que se vê.
  local mount_src
  mount_src=$(docker inspect "$SPHARMMT_PROXY_CONTAINER" \
    -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/conf.d"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)
  if [ -n "$mount_src" ]; then
    info "conf.d montado a partir de: ${mount_src}"
    check "mount de conf.d aponta para ${SPHARMMT_PROXY_CONF_DIR}" \
      bash -c "[ '${mount_src}' = '${SPHARMMT_PROXY_CONF_DIR}' ]"
  else
    check "conf.d montado no container" false
  fi

  check "ficheiro presente DENTRO do container" \
    docker exec "$SPHARMMT_PROXY_CONTAINER" test -f /etc/nginx/conf.d/spharmmt.conf
  # `nginx -T` imprime a configuração efectiva já resolvida. Zero blocos
  # `server {}` é exactamente o estado "arranca e não serve nada".
  check "nginx -T contém pelo menos um server {}" \
    bash -c "[ \"\$(docker exec ${SPHARMMT_PROXY_CONTAINER} nginx -T 2>/dev/null | grep -c 'server {')\" -gt 0 ]"
  check "nginx -T contém proxy_pass para a aplicação" \
    bash -c "docker exec ${SPHARMMT_PROXY_CONTAINER} nginx -T 2>/dev/null | grep -q 'proxy_pass'"

  # O porto publicado vem da configuração, não é assumido: enquanto a
  # stack não estiver validada, o proxy ouve em 127.0.0.1:8080 e o 80
  # continua fechado. Exigir o 80 aqui reportava uma falha onde está o
  # comportamento pretendido.
  local bind port
  bind=$(awk -F= '/^PROXY_BIND=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" 2>/dev/null || true)
  port=$(awk -F= '/^PROXY_HTTP_PORT=/ {print $2; exit}' "$SPHARMMT_STACK_ENV_FILE" 2>/dev/null || true)
  bind=${bind:-127.0.0.1}; port=${port:-8080}

  check "porto ${port} publicado" \
    bash -c "docker port ${SPHARMMT_PROXY_CONTAINER} 2>/dev/null | grep -q ':${port}\$'"

  if [ "$bind" = "127.0.0.1" ]; then
    check "fechado ao exterior (bind ${bind})" \
      bash -c "! docker port ${SPHARMMT_PROXY_CONTAINER} 2>/dev/null | grep -q '0.0.0.0'"
    check_skip "TLS (porto 443)" "acesso ainda por IP em HTTP"
  else
    check_warn "publicado em ${bind} — acessível fora do servidor" true
    check_warn "porto 443 publicado (TLS)" \
      bash -c "docker port ${SPHARMMT_PROXY_CONTAINER} 2>/dev/null | grep -q '^443/tcp'"
  fi

  # Códigos HTTP explícitos: um `curl -f` distingue 200 de erro, mas não
  # distingue 200 de 204 nem diz o que veio. Aqui interessa o 200.
  check "/healthz responde 200" \
    bash -c "[ \"\$(curl -sS -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:${port}/healthz)\" = 200 ]"
  check "/api/health responde 200 através do proxy" \
    bash -c "[ \"\$(curl -sS -o /dev/null -m 20 -w '%{http_code}' http://127.0.0.1:${port}/api/health)\" = 200 ]"
  check "corpo de /api/health tem status" \
    bash -c "curl -fsS -m 20 http://127.0.0.1:${port}/api/health | grep -q '\"status\"'"
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
sec_monitorizacao() {
  want monitorizacao || return 0
  step "9. Monitorização"
  check "healthcheck instalado"           test -x "${SPHARMMT_ROOT}/monitoring/checks/healthcheck.sh"
  check "timer do healthcheck activo"     svc_active spharmmt-healthcheck.timer
  check "timer do healthcheck no boot"    svc_enabled spharmmt-healthcheck.timer
  check "unit do healthcheck não falhada" bash -c "[ \"\$(systemctl is-failed spharmmt-healthcheck.service 2>/dev/null)\" != failed ]"
  if [ -x "${SPHARMMT_ROOT}/monitoring/checks/healthcheck.sh" ]; then
    # rc<=1 significa OK ou apenas avisos; rc=2 é crítico.
    check "healthcheck corre sem CRIT" \
      bash -c "${SPHARMMT_ROOT}/monitoring/checks/healthcheck.sh >/dev/null 2>&1; [ \$? -le 1 ]"
  fi
  check_warn "última execução há < 1h" \
    bash -c "[ -f ${SPHARMMT_ROOT}/monitoring/state/last-run ] && [ \$(( \$(date +%s) - \$(stat -c %Y ${SPHARMMT_ROOT}/monitoring/state/last-run) )) -lt 3600 ]"
  check "sysstat a recolher histórico"    svc_active sysstat
}

# ═════════════════════════════════════════════════════════════════════════
sec_backups() {
  want backups || return 0
  step "10. Backups"
  check "script de backup instalado"      test -x "${SPHARMMT_ROOT}/scripts/backup-platform.sh"
  check "script de restauro instalado"    test -x "${SPHARMMT_ROOT}/scripts/restore-platform.sh"
  check "timer de backup activo"          svc_active spharmmt-backup.timer
  check "timer de backup no boot"         svc_enabled spharmmt-backup.timer
  check "unit de backup não falhada"      bash -c "[ \"\$(systemctl is-failed spharmmt-backup.service 2>/dev/null)\" != failed ]"
  local d
  for d in daily weekly monthly; do
    check "backups/postgres/${d}"         test -d "${SPHARMMT_BACKUP_DIR}/postgres/${d}"
  done
  check "política documentada"            test -f "${SPHARMMT_BACKUP_DIR}/POLICY.md"

  if [ "$HAS_PG" = "1" ]; then
    local n
    n=$(find "${SPHARMMT_BACKUP_DIR}/postgres/daily" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    check "existe pelo menos um conjunto" bash -c "[ ${n} -gt 0 ]"
    if [ "$n" -gt 0 ]; then
      local newest
      # `|| true`: sob pipefail, o `head -1` fecha o pipe e o `sort` pode
      # apanhar SIGPIPE (141) quando a listagem é grande.
      newest=$(find "${SPHARMMT_BACKUP_DIR}/postgres/daily" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)
      check "conjunto mais recente < 30h" \
        bash -c "[ \$(( ( \$(date +%s) - \$(stat -c %Y '${newest}') ) / 3600 )) -lt 30 ]"
      check "checksums do último conjunto conferem" \
        bash -c "cd '${newest}' && sha256sum -c --quiet SHA256SUMS"
      check "manifesto presente"          test -f "${newest}/MANIFEST.txt"
    fi
  else
    check_skip "conjuntos de backup" "PostgreSQL ainda não instalado"
  fi

  # Regra 3-2-1: enquanto não houver destino externo, isto é staging.
  check_warn "destino externo configurado" \
    bash -c "grep -qE '^BACKUP_REMOTE_(TARGET|URL)=.+' ${SPHARMMT_CONF_FILE} 2>/dev/null"
}

# ═════════════════════════════════════════════════════════════════════════
sec_logs() {
  want logs || return 0
  step "11. Logs"
  check "journald persistente"            bash -c "grep -q 'Storage=persistent' /etc/systemd/journald.conf.d/99-spharmmt.conf 2>/dev/null"
  check "journald com limite de uso"      bash -c "grep -q 'SystemMaxUse' /etc/systemd/journald.conf.d/99-spharmmt.conf 2>/dev/null"
  # SystemMaxUse=2G — se o journal passou disso, a configuração não pegou.
  check "journald abaixo de 3GB"          bash -c "[ \$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)?[KMG]' | head -1 | numfmt --from=iec --suffix=B 2>/dev/null | tr -d 'B' || echo 0) -lt 3221225472 ]"
  check "logrotate do SPharm.MT"          test -f /etc/logrotate.d/spharmmt
  check "logrotate sem erros"             logrotate -d /etc/logrotate.d/spharmmt
  check "timer do logrotate activo"       svc_active logrotate.timer
  check "directório de logs existe"       test -d "${SPHARMMT_ROOT}/logs"
  check "logs de scripts em ${SPHARMMT_LOG_DIR}" test -d "$SPHARMMT_LOG_DIR"
  check_warn "nenhum log acima de 200MB" \
    bash -c "[ -z \"\$(find ${SPHARMMT_ROOT}/logs /var/log -size +200M -name '*.log' -print -quit 2>/dev/null)\" ]"
}

# ═════════════════════════════════════════════════════════════════════════
sec_recursos() {
  want recursos || return 0
  step "12. Recursos"
  check "disco / abaixo de 80%"           bash -c "[ \$(df -P / | awk 'NR==2 {gsub(\"%\",\"\",\$5); print \$5}') -lt 80 ]"
  check "inodes / abaixo de 80%"          bash -c "[ \$(df -Pi / | awk 'NR==2 {gsub(\"%\",\"\",\$5); print \$5}') -lt 80 ]"
  check "pelo menos 2GB de RAM livre"     bash -c "[ \$(free -m | awk '/^Mem:/ {print \$7}') -gt 2048 ]"
  check "load1 abaixo de nproc x2"        bash -c "[ \$(awk '{print int(\$1)}' /proc/loadavg) -lt \$(( \$(nproc) * 2 )) ]"
  check_warn "swap abaixo de 50%"         bash -c "t=\$(free -m | awk '/^Swap:/ {print \$2}'); u=\$(free -m | awk '/^Swap:/ {print \$3}'); [ \"\$t\" -eq 0 ] || [ \$(( u * 100 / t )) -lt 50 ]"
  check "4 vCPU disponíveis"              bash -c "[ \$(nproc) -ge 4 ]"
  check "pelo menos 7GB de RAM total"     bash -c "[ \$(free -m | awk '/^Mem:/ {print \$2}') -ge 7000 ]"
  check_warn "espaço para 30 dias de crescimento" \
    bash -c "[ \$(df -Pm ${SPHARMMT_ROOT} | awk 'NR==2 {print \$4}') -gt 20480 ]"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  log_init
  banner "verify-platform"

  [ "$IS_ROOT" = "1" ] || warn "sem sudo: verificações de SSH, firewall e segredos ficam em SKIP"

  sec_sistema
  sec_seguranca
  sec_docker
  sec_volumes
  sec_segredos
  sec_stack
  sec_postgres
  sec_proxy
  sec_monitorizacao
  sec_backups
  sec_logs
  sec_recursos

  local rc=0
  report "Checklist da plataforma" || rc=$?

  [ -n "$JSON_OUT" ] && { report_json "$JSON_OUT"; info "JSON: ${JSON_OUT}"; }

  printf '\n'
  if [ "$rc" -eq 0 ]; then
    if [ "$HAS_STACK" = "1" ]; then
      ok "plataforma operacional."
    else
      ok "servidor preparado e pronto a receber a stack (PostgreSQL + app + proxy)."
    fi
  else
    err "há falhas a corrigir — detalhe acima e em ${LOG_FILE}"
  fi
  finish "$rc"
}

main "$@"
