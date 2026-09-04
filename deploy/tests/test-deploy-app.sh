#!/usr/bin/env bash
#
# deploy/tests/test-deploy-app.sh
#
# Prova o que o deploy rápido FAZ e, sobretudo, o que ele NUNCA faz.
#
# ─────────────────────────────────────────────────────────────────────
# PORQUE É QUE METADE DISTO NÃO É UM TESTE DE `grep`
#
# Um script que recria containers em produção não se valida a ler o
# código. A segunda metade corre o script INTEIRO com um `docker`, um
# `git`, um `curl` e um `id` falsos à frente no PATH, e verifica as
# DECISÕES: que comandos foram emitidos, com que argumentos, e por que
# razão parou quando parou.
#
# A propriedade que se está a guardar é uma só: ISTO NUNCA TOCA NO
# POSTGRES. O incidente de 2026-09-03 — um cluster vazio criado por um
# container arrancado sem os `--env-file` — custou uma tarde. Um script
# de deploy frequente é exactamente o sítio onde esse erro voltaria.
#
# A primeira metade é estática de propósito: a ausência de `down -v` ou
# de `prune` não se demonstra correndo o script uma vez.
#
# Sem docker, sem base de dados, sem rede.
#
# Uso: bash deploy/tests/test-deploy-app.sh
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ALVO="${REPO}/deploy/scripts/deploy-app.sh"

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  [OK]    %s\n' "$1"
  else fail=$((fail+1)); printf '  [FALHA] %s: obtido "%s", esperado "%s"\n' "$1" "$2" "$3"; fi
}
contem() {
  if printf '%s' "$2" | grep -q -e "$3"; then pass=$((pass+1)); printf '  [OK]    %s\n' "$1"
  else fail=$((fail+1)); printf '  [FALHA] %s: nao encontrei "%s"\n' "$1" "$3"; fi
}
nao_contem() {
  if printf '%s' "$2" | grep -q -e "$3"; then
    fail=$((fail+1)); printf '  [FALHA] %s: encontrei "%s" e nao devia\n' "$1" "$3"
  else pass=$((pass+1)); printf '  [OK]    %s\n' "$1"; fi
}

[ -f "$ALVO" ] || { echo "deploy-app.sh nao encontrado em $ALVO"; exit 1; }
CORPO=$(cat "$ALVO")

# ═════════════════════════════════════════════════════════════════════
# A · O que o script NUNCA pode conter
# ═════════════════════════════════════════════════════════════════════
echo
echo "A · comandos proibidos"
# O corpo sem comentarios: a documentacao CITA os comandos proibidos para
# explicar porque nao os usa, e uma procura ingenua encontrava a citacao.
CODIGO=$(printf '%s\n' "$CORPO" | sed 's/#.*//')

nao_contem "sem 'compose down'"        "$CODIGO" 'compose down'
nao_contem "sem 'down -v'"             "$CODIGO" 'down -v'
nao_contem "sem 'system prune'"        "$CODIGO" 'system prune'
nao_contem "sem 'image prune'"         "$CODIGO" 'image prune'
nao_contem "sem 'volume rm'"           "$CODIGO" 'volume rm'
# `install-stack.sh` E' citado de proposito na mensagem de recusa das
# migrations. O que nao pode existir e' uma INVOCACAO: um `install-stack`
# precedido de `./`, `bash `, `sh ` ou `run ` FORA de uma string.
EXECUCOES=$(printf '%s\n' "$CORPO" \
  | grep -E '^[^"#]*(\./|bash |sh |exec |run )(install-stack|update-platform)\.sh' || true)
check "nao invoca install-stack nem update-platform" "$EXECUCOES" ""
contem "mas manda usar install-stack quando ha migrations" "$CORPO" 'install-stack.sh'
nao_contem "sem 'prisma migrate'"      "$CODIGO" 'prisma migrate'
nao_contem "sem 'run --rm migrate'"    "$CODIGO" 'run --rm migrate'
nao_contem "sem 'initdb'"              "$CODIGO" 'initdb'
nao_contem "sem 'docker-entrypoint-initdb'" "$CODIGO" 'docker-entrypoint-initdb'
nao_contem "sem --profile tools"       "$CODIGO" 'profile tools'
nao_contem "sem chown/chmod ao PGDATA" "$CODIGO" 'chown.*postgres'

# ═════════════════════════════════════════════════════════════════════
# B · O que tem obrigatoriamente de conter
# ═════════════════════════════════════════════════════════════════════
echo
echo "B · invariantes obrigatorios"
contem "usa o platform.env"  "$CORPO" 'env-file "\$SPHARMMT_ENV_FILE"'
contem "usa o stack.env"     "$CORPO" 'env-file "\$SPHARMMT_STACK_ENV_FILE"'
contem "falha se faltar um env-file" "$CORPO" 'env-file ausente'
contem "constroi so o servico web"   "$CORPO" 'dcapp build .*web'
contem "sobe so web e worker"        "$CORPO" 'up -d --no-deps web worker'
contem "exige /data/postgres/data"   "$CORPO" 'PGDATA_ESPERADO="/data/postgres/data"'
contem "guarda a imagem anterior"    "$CORPO" 'docker tag "\$IMAGEM_ANTERIOR"'
contem "compara migrations entre revisoes" "$CORPO" 'prisma/migrations prisma-control/migrations'

# `up` nomeia exactamente web e worker — nunca postgres nem proxy.
UPS=$(printf '%s\n' "$CODIGO" | grep -c 'dcapp up ')
check "so ha 2 invocacoes de 'up' (deploy + rollback)" "$UPS" "2"
nao_contem "nenhum 'up' nomeia o postgres" "$CODIGO" 'up .*postgres'
nao_contem "nenhum 'up' nomeia o proxy"    "$CODIGO" 'up .*proxy'
nao_contem "o build nunca nomeia migrate"  "$CODIGO" 'build .*migrate'

# ═════════════════════════════════════════════════════════════════════
# C · Instalado como script operacional
# ═════════════════════════════════════════════════════════════════════
echo
echo "C · integracao"
contem "esta' na lista de scripts operacionais" \
  "$(cat "${REPO}/deploy/scripts/lib/common.sh")" 'SPHARMMT_OPERATIONAL_SCRIPTS=.*deploy-app.sh'
check "sintaxe bash valida" "$(bash -n "$ALVO" 2>&1; echo $?)" "0"

# `install-stack.sh` nao pode ter sido alterado para depender deste
# script — o mecanismo oficial mantem-se autonomo.
nao_contem "install-stack nao chama o deploy rapido" \
  "$(cat "${REPO}/deploy/scripts/install-stack.sh")" 'deploy-app'

# ── O bit de execucao, no INDICE do git ─────────────────────────────
#
# `chmod +x` numa maquina com `core.filemode=false` (Windows) nao chega
# ao indice: o ficheiro segue como 100644 e, no clone da VPS, um
# `sudo .../deploy-app.sh` responde "command not found" — que nao parece
# um problema de permissoes e faz perder tempo a procurar noutro sitio.
# O modo tem de ser gravado, e e' o git que o guarda.
MODO=$(git -C "$REPO" ls-files -s deploy/scripts/deploy-app.sh 2>/dev/null | awk '{print $1}')
check "deploy-app.sh esta' 100755 no indice do git" "$MODO" "100755"

# Os restantes scripts operacionais ja' estavam executaveis; este tem de
# acompanhar, senao a lista tem uma excepcao silenciosa.
for s_ in install-stack.sh update-platform.sh verify-platform.sh; do
  m=$(git -C "$REPO" ls-files -s "deploy/scripts/${s_}" 2>/dev/null | awk '{print $1}')
  check "referencia: ${s_} tambem 100755" "$m" "100755"
done

# ── Deteccao do clone a partir da localizacao do script ─────────────
#
# Correr `<clone>/deploy/scripts/deploy-app.sh` tem de descobrir esse
# clone sozinho. A lista de caminhos conhecidos nao chega: um checkout em
# /tmp/spharmmt nao estava la', e o script abortava com "clone nao
# encontrado" logo na primeira utilizacao real.
contem "deduz o clone de SCRIPT_DIR/../.." "$CORPO" 'aqui=$(cd "${SCRIPT_DIR}/../.."'
contem "so' aceita se for mesmo um repositorio" "$CORPO" '\[ -d "${aqui}/.git" \]'

# ═════════════════════════════════════════════════════════════════════
# D · Comportamento, com docker/git/curl falsos
# ═════════════════════════════════════════════════════════════════════
BASE=$(mktemp -d)
trap 'rm -rf "$BASE"' EXIT

# Constroi um ambiente completo: raiz do SPharm, clone git e binarios
# falsos. `cenario` parametriza o que cada falso responde.
#
#   $1 diretorio do cenario
#   PG_HEALTH / PG_MOUNT / PGDATA_CFG / GIT_SUJO / MIGRATIONS / REV_PROD
#   WEB_HEALTH / HTTP_CODE  controlam as respostas.
preparar() {
  local dir=$1
  mkdir -p "$dir/bin" "$dir/root/docker/compose" "$dir/root/docker/env" \
           "$dir/root/monitoring/state" "$dir/clone/.git" "$dir/log"
  : > "$dir/root/docker/compose/docker-compose.yml"
  printf 'POSTGRES_DATA_DIR=%s\n' "${PGDATA_CFG:-/data/postgres/data}" > "$dir/root/docker/env/platform.env"
  printf 'APP_TAG=local\nPROXY_HTTP_PORT=8080\n' > "$dir/root/docker/env/stack.env"
  : > "$dir/registo"

  cat > "$dir/bin/id" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = "-u" ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
SH

  cat > "$dir/bin/docker" <<SH
#!/usr/bin/env bash
printf 'docker %s\n' "\$*" >> "$dir/registo"
case "\$1" in
  inspect)
    fmt=""; alvo=""
    while [ \$# -gt 0 ]; do
      case "\$1" in -f) fmt=\$2; shift 2 ;; *) alvo=\$1; shift ;; esac
    done
    case "\$fmt" in
      *State.Running*)  echo true ;;
      *Health.Status*)
        if [ "\$alvo" = "spharmmt-postgres" ]; then echo "${PG_HEALTH:-healthy}"
        else echo "${WEB_HEALTH:-healthy}"; fi ;;
      *State.Status*)   echo running ;;
      *Destination*)    echo "${PG_MOUNT:-/data/postgres/data}" ;;
      *.Id*)            echo "sha256:pg-fixo" ;;
      *StartedAt*)      echo "2026-09-04T08:00:00Z" ;;
      *.Image*)         echo "sha256:imagem-antiga" ;;
      *) echo "" ;;
    esac ;;
  exec)
    if grep -q "compose .* up " "$dir/registo" 2>/dev/null; then
      echo "\${REV_NOVA:-bbbbbbb}"
    else
      echo "\${REV_PROD:-aaaaaaa}"
    fi ;;
  compose|tag|logs) exit 0 ;;
  *) exit 0 ;;
esac
SH

  cat > "$dir/bin/git" <<SH
#!/usr/bin/env bash
printf 'git %s\n' "\$*" >> "$dir/registo"
args="\$*"
case "\$args" in
  *"status --porcelain"*) [ -n "${GIT_SUJO:-}" ] && echo " M lib/x.ts"; exit 0 ;;
  *"rev-parse --abbrev-ref"*) echo main; exit 0 ;;
  *"rev-parse --verify"*)
     case "\$args" in
       *"${REV_PROD:-aaaaaaa}"*) exit 0 ;;
       *bbbbbbb*) exit 0 ;;
       *) exit 1 ;;
     esac ;;
  *"rev-parse --short"*) echo bbbbbbb; exit 0 ;;
  *"rev-parse HEAD"*)    echo bbbbbbb; exit 0 ;;
  *"diff --name-only"*)  [ -n "${MIGRATIONS:-}" ] && echo "prisma/migrations/20260904_x/migration.sql"; exit 0 ;;
  *) exit 0 ;;
esac
SH

  cat > "$dir/bin/curl" <<SH
#!/usr/bin/env bash
printf 'curl %s\n' "\$*" >> "$dir/registo"
echo "${HTTP_CODE:-200}"
SH

  chmod +x "$dir/bin/"*
}

correr() {
  local dir=$1; shift
  ( PATH="$dir/bin:$PATH" \
    SPHARMMT_ROOT="$dir/root" \
    SPHARMMT_LOG_DIR="$dir/log" \
    SPHARMMT_CLONE="$dir/clone" \
    bash "$ALVO" "$@" 2>&1 )
}

echo
echo "D · recusas"

# ── árvore suja ──────────────────────────────────────────────────────
D1="$BASE/sujo"; ( GIT_SUJO=1 preparar "$D1" )
OUT=$(GIT_SUJO=1 correr "$D1"); RC=$?
check "arvore suja: exit 2" "$RC" "2"
contem "arvore suja: diz porque"  "$OUT" 'árvore de trabalho suja'
nao_contem "arvore suja: nao constroi" "$(cat "$D1/registo")" 'compose.*build'

# ── migrations entre revisões ────────────────────────────────────────
D2="$BASE/migr"; ( MIGRATIONS=1 preparar "$D2" )
OUT=$(MIGRATIONS=1 correr "$D2"); RC=$?
check "com migrations: exit 2" "$RC" "2"
contem "com migrations: nomeia o ficheiro" "$OUT" '20260904_x/migration.sql'
contem "com migrations: manda usar install-stack" "$OUT" 'install-stack.sh'
nao_contem "com migrations: nao constroi" "$(cat "$D2/registo")" 'compose.*build'
nao_contem "com migrations: nao sobe nada" "$(cat "$D2/registo")" 'compose.*up'

# ── PGDATA errado ────────────────────────────────────────────────────
D3="$BASE/pgdata"; ( PGDATA_CFG=/opt/spharmmt/postgres/data preparar "$D3" )
OUT=$(PGDATA_CFG=/opt/spharmmt/postgres/data correr "$D3"); RC=$?
check "PGDATA errado: exit 2" "$RC" "2"
contem "PGDATA errado: diz o valor" "$OUT" '/opt/spharmmt/postgres/data'
nao_contem "PGDATA errado: nao constroi" "$(cat "$D3/registo")" 'compose.*build'

# ── postgres não healthy ─────────────────────────────────────────────
D4="$BASE/pgdoente"; ( PG_HEALTH=starting preparar "$D4" )
OUT=$(PG_HEALTH=starting correr "$D4"); RC=$?
check "postgres nao healthy: exit 2" "$RC" "2"
contem "postgres nao healthy: diz o estado" "$OUT" "starting"

# ── montagem do postgres fora de /data ───────────────────────────────
D5="$BASE/pgmount"; ( PG_MOUNT=/opt/spharmmt/postgres/data preparar "$D5" )
OUT=$(PG_MOUNT=/opt/spharmmt/postgres/data correr "$D5"); RC=$?
check "postgres montado fora de /data: exit 2" "$RC" "2"

echo
echo "E · caminho feliz"

D6="$BASE/ok"; ( preparar "$D6" )
OUT=$(correr "$D6"); RC=$?
REG=$(cat "$D6/registo")

check "deploy bem sucedido: exit 0" "$RC" "0"
contem "diz o tempo que demorou" "$OUT" 'deploy concluído em'

# ── as garantias sobre o postgres ────────────────────────────────────
nao_contem "NENHUM comando docker nomeia o postgres como alvo de up"  "$REG" 'up .*postgres'
nao_contem "nunca constroi o postgres"                                "$REG" 'build .*postgres'
nao_contem "nunca constroi o proxy"                                   "$REG" 'build .*proxy'
nao_contem "nunca constroi o migrate"                                 "$REG" 'build .*migrate'
nao_contem "nunca faz down"                                           "$REG" 'down'
nao_contem "nunca faz prune"                                          "$REG" 'prune'

# ── e as que dizem respeito ao que ele DEVE fazer ────────────────────
contem "constroi o servico web"        "$REG" 'compose .*build web'
contem "sobe web e worker com --no-deps" "$REG" 'up -d --no-deps web worker'
contem "guarda a imagem anterior por tag" "$REG" 'tag sha256:imagem-antiga spharmmt-app:rollback'
contem "verifica a saude por HTTP"     "$REG" 'api/health'

# Todas as invocacoes do compose levam os DOIS env-files.
COMPOSES=$(printf '%s\n' "$REG" | grep -c 'docker compose ')
COM_ENV=$(printf '%s\n' "$REG" | grep 'docker compose ' \
          | grep -c -- '--env-file .*platform.env --env-file .*stack.env')
check "todas as chamadas ao compose levam os dois env-files" "$COM_ENV" "$COMPOSES"

# ── rollback quando o health falha ───────────────────────────────────
echo
echo "F · rollback automatico"
D7="$BASE/mau"; ( HTTP_CODE=500 preparar "$D7" )
OUT=$(HTTP_CODE=500 correr "$D7"); RC=$?
REG=$(cat "$D7/registo")
check "health 500: exit 1" "$RC" "1"
contem "anuncia a reversao" "$OUT" 'a reverter'
contem "repoe a tag da imagem antiga" "$REG" 'tag sha256:imagem-antiga spharmmt-app:local'
contem "recria com --force-recreate"  "$REG" 'up -d --no-deps --force-recreate web worker'
nao_contem "o rollback tambem nao toca no postgres" "$REG" 'up .*postgres'

echo
echo "${pass} ok, ${fail} falhas"
[ "$fail" -eq 0 ] || exit 1
