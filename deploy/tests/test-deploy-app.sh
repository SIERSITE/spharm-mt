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
# `--profile tools` passou a ser permitido — e' o unico modo de o
# compose ver o servico `migrate` para o CONSTRUIR. O que continua
# proibido e' toca-lo de qualquer outra forma: sem ele o `migrate` era
# invisivel e a proibicao era gratuita; com ele, tem de ser explicita.
nao_contem "'--profile tools' nunca aparece com 'run'" "$CODIGO" 'profile tools.*run'
nao_contem "'--profile tools' nunca aparece com 'up'"  "$CODIGO" 'profile tools.* up'
PROFILES=$(printf '%s\n' "$CODIGO" | grep -c 'profile tools')
check "'--profile tools' aparece uma unica vez" "$PROFILES" "1"
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

# ── O clone e' SO' DE LEITURA ────────────────────────────────────────
#
# O script corre com sudo. Um unico comando git de escrita deixa
# `.git/index` e `.git/HEAD` como root e o utilizador `deploy` perde o
# clone:  "fatal: .git/index: index file open failed: Permission denied".
# As mensagens ao operador CITAM comandos ("falta um git fetch?", "repara
# com chown"), e uma procura ingenua encontrava a citacao. O que nao pode
# existir e' uma INVOCACAO: o comando fora de qualquer string.
ESCRITAS=$(printf '%s\n' "$CORPO" \
  | grep -E '^[^"#]*git( --[a-z-]+)*( -C [^ ]+)? +(checkout|fetch|reset|restore|clean|switch|pull|merge|rebase|stash|gc|worktree)' \
  || true)
check "nenhum comando git que escreva no clone" "$ESCRITAS" ""
contem "le' o git com --no-optional-locks" "$CORPO" 'git --no-optional-locks -C "\$CLONE"'
contem "extrai a arvore com git archive"   "$CORPO" 'gitro archive --format=tar'
contem "constroi de um temporario"         "$CORPO" 'CTX=$(mktemp -d)'
contem "e apaga-o no fim"                  "$CORPO" 'rm -rf "$CTX"'

# Todos os comandos git passam pelo wrapper de leitura: nenhum `git -C`
# solto, que seria um caminho a escapar ao --no-optional-locks.
GIT_SOLTO=$(printf '%s\n' "$CODIGO" | grep -c 'git -C "\$CLONE"')
check "nenhum 'git -C \$CLONE' fora do wrapper" "$GIT_SOLTO" "0"

# Deteccao e reparacao de ficheiros de root deixados por versoes antigas.
contem "detecta ficheiros de root no clone" "$CORPO" 'find "$CLONE" -user 0'
contem "sugere reparacao dirigida, sem chown -R" "$CORPO" 'find ${CLONE} -user root -exec chown'
CHOWN_R=$(printf '%s\n' "$CORPO" | grep -E '^[^"#]*chown +-R' || true)
check "nunca executa chown -R" "$CHOWN_R" ""

# `up` nomeia exactamente web e worker — nunca postgres nem proxy.
UPS=$(printf '%s\n' "$CODIGO" | grep -c 'dcapp up ')
check "so ha 2 invocacoes de 'up' (deploy + rollback)" "$UPS" "2"
nao_contem "nenhum 'up' nomeia o postgres" "$CODIGO" 'up .*postgres'
nao_contem "nenhum 'up' nomeia o proxy"    "$CODIGO" 'up .*proxy'
nao_contem "nenhum 'up' nomeia o migrate"   "$CODIGO" 'up .*migrate'
contem "o migrate e' construido, e so' construido" "$CODIGO" 'build .*migrate'
# A distincao que interessa: `build` cria a imagem, `run` arrancaria um
# container e correria as migrations. So' o primeiro existe aqui.
MIGRATE_RUN=$(printf '%s\n' "$CODIGO" | grep -c 'run --rm migrate' || true)
check "nunca corre nada dentro do migrate" "$MIGRATE_RUN" "0"

# ── CAMINHOS_TOOLS vs os COPY do Dockerfile ─────────────────────────
#
# A lista que decide se a imagem de tools precisa de ser reconstruída não
# é uma opinião sobre o que é importante: é a lista dos COPY do estágio
# `migrator`. Se alguém acrescentar um COPY lá e não acrescentar aqui, a
# imagem deixa de ser reconstruída quando esse caminho muda — e a falha
# aparece semanas depois, num comando administrativo, longe da causa.
#
# `--from=builder` fica de fora: esse conteúdo é PRODUZIDO pelo build
# (é o `generated/` do prisma generate), não copiado do repositório.
DOCKERFILE="${REPO}/deploy/docker/Dockerfile"
LISTA=$(printf '%s\n' "$CORPO" \
  | sed -n '/^CAMINHOS_TOOLS=(/,/^)/p' | sed '1d;$d' | tr -d ' \r')
COPIAS=$(sed -n '/^FROM deps AS migrator/,$p' "$DOCKERFILE" \
  | grep -E '^COPY ' | grep -v -- '--from=' \
  | sed 's/^COPY //' | sed 's/[^ ]*$//' | tr ' ' '\n' | grep -v '^$' \
  | sed 's|^\./||' | sort -u)

# Guarda contra vacuidade: se a extraccao nao devolvesse nada, o teste
# passava sem ter olhado para coisa nenhuma. (Linhas COPY continuadas com
# barra invertida perdem os ficheiros das linhas seguintes — todos eles
# vivem sob `scripts`, que ja' esta' na lista.)
N_COPIAS=$(printf '%s
' "$COPIAS" | grep -c . || true)
if [ "$N_COPIAS" -ge 10 ]; then
  pass=$((pass+1)); printf '  [OK]    extrai %s caminhos do Dockerfile (nao e vacuo)
' "$N_COPIAS"
else
  fail=$((fail+1)); printf '  [FALHA] so extrai %s caminhos do Dockerfile
' "$N_COPIAS"
fi
DESCOBERTOS=""
for c in $COPIAS; do
  coberto=0
  for base in $LISTA; do
    case "$c" in "$base"|"$base"/*) coberto=1; break ;; esac
  done
  [ "$coberto" = "1" ] || DESCOBERTOS="${DESCOBERTOS}${c} "
done
check "CAMINHOS_TOOLS cobre todos os COPY do estagio migrator" "$DESCOBERTOS" ""
# E o contrario tambem interessa, mas so' como aviso: a lista pode ter
# caminhos que nao sao COPY directos (o proprio Dockerfile, o
# package-lock) e isso e' deliberado.
contem "a lista inclui o proprio Dockerfile" "$LISTA" 'deploy/docker/Dockerfile'
contem "a lista inclui o lockfile"           "$LISTA" 'package-lock.json'
nao_contem "a lista NAO inclui generated/ (e' produzido pelo build)" "$LISTA" '^generated$'

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
      *Config.Env*)
        # A revisao carimbada na imagem de tools. Vazia por omissao —
        # que e' o estado real da VPS antes de bc6d585.
        [ -n "${REV_MIGRATOR:-}" ] && echo "APP_REVISION=\${REV_MIGRATOR}" ;;
      *) echo "" ;;
    esac ;;
  exec)
    if grep -q "compose .* up " "$dir/registo" 2>/dev/null; then
      echo "\${REV_NOVA:-bbbbbbb}"
    else
      echo "\${REV_PROD:-aaaaaaa}"
    fi ;;
  image)
    # docker image inspect <img> --format <fmt>. Duas perguntas: o id da
    # imagem de tools e a revisao carimbada nela.
    shift
    [ "\${1:-}" = "inspect" ] && shift
    fmt=""; alvo=""
    while [ \$# -gt 0 ]; do
      case "\$1" in
        --format|-f) fmt=\$2; shift 2 ;;
        *) alvo=\$1; shift ;;
      esac
    done
    # Sem REV_MIGRATOR o cenario e' "a imagem nao existe" — e ai o
    # inspect FALHA, que e' diferente de existir sem carimbo.
    [ -n "${REV_MIGRATOR:-}" ] || exit 1
    # Depois de a imagem ser construida ela passa a trazer a revisao
    # nova. Sem isto, a validacao final leria a revisao ANTIGA de uma
    # imagem que acabou de ser reconstruida, e o teste acusava uma
    # incoerencia que so' existia no falso.
    rev_img="${REV_MIGRATOR:-}"
    grep -q "profile tools build migrate" "$dir/registo" 2>/dev/null \
      && rev_img="${REV_NOVA:-bbbbbbb}"
    case "\$fmt" in
      *Config.Env*) echo "APP_REVISION=\${rev_img}" ;;
      *.Id*)        echo "sha256:migrator-antigo" ;;
      *) echo "" ;;
    esac ;;
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
  *"diff --name-only"*)
     # Dois diffs diferentes, distinguidos pelo pathspec: o das
     # migrations e o dos caminhos que entram na imagem de tools.
     case "\$args" in
       *"prisma/migrations"*)
          [ -n "${MIGRATIONS:-}" ] && echo "prisma/migrations/20260904_x/migration.sql" ;;
       *)
          [ -n "${TOOLS_MUDOU:-}" ] && echo "lib/operational/motor-stock.ts" ;;
     esac
     exit 0 ;;
  *archive*) tar -cf - -T /dev/null; exit 0 ;;
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

# REV_MIGRATOR=bbbbbbb: a imagem de tools ja' esta' na revisao alvo, que
# e' o estado depois de um deploy que a construiu. Nada a fazer.
D6="$BASE/ok"; ( REV_MIGRATOR=bbbbbbb preparar "$D6" )
OUT=$(REV_MIGRATOR=bbbbbbb correr "$D6"); RC=$?
REG=$(cat "$D6/registo")

check "deploy bem sucedido: exit 0" "$RC" "0"
contem "diz o tempo que demorou" "$OUT" 'deploy concluído em'

# ── as garantias sobre o postgres ────────────────────────────────────
nao_contem "NENHUM comando docker nomeia o postgres como alvo de up"  "$REG" 'up .*postgres'
nao_contem "nunca constroi o postgres"                                "$REG" 'build .*postgres'
nao_contem "nunca constroi o proxy"                                   "$REG" 'build .*proxy'
nao_contem "imagem de tools ja' actual: nao a reconstroi"             "$REG" 'build .*migrate'
nao_contem "nunca faz down"                                           "$REG" 'down'
nao_contem "nunca faz prune"                                          "$REG" 'prune'

# ── e as que dizem respeito ao que ele DEVE fazer ────────────────────
contem "constroi o servico web"        "$REG" 'compose .*build web'
contem "sobe web e worker com --no-deps" "$REG" 'up -d --no-deps web worker'
contem "guarda a imagem anterior por tag" "$REG" 'tag sha256:imagem-antiga spharmmt-app:rollback'
contem "verifica a saude por HTTP"     "$REG" 'api/health'

# ── O clone sai como entrou ─────────────────────────────────────────
#
# Nao e' o codigo que se le' aqui: e' a lista dos comandos que o `git`
# falso recebeu durante uma execucao completa. Um `checkout` corrido por
# root recria `.git/index` e `.git/HEAD` como root, e o utilizador
# `deploy` perde o clone.
GIT_ESCRITAS=$(printf '%s\n' "$REG" \
  | grep -E '^git .*(checkout|fetch|reset|restore|clean|switch|pull|merge|rebase|stash|gc|worktree)' \
  || true)
check "o git nunca recebeu um comando de escrita" "$GIT_ESCRITAS" ""
contem "extraiu a arvore com git archive" "$REG" 'git .*archive --format=tar'
contem "leu sempre com --no-optional-locks" "$REG" 'git --no-optional-locks'

# E nenhuma leitura escapou ao wrapper.
GIT_SEM_FLAG=$(printf '%s\n' "$REG" | grep '^git ' | grep -vc -- '--no-optional-locks' || true)
check "nenhuma invocacao de git sem o flag de leitura" "$GIT_SEM_FLAG" "0"

# Todas as invocacoes do compose levam os DOIS env-files.
COMPOSES=$(printf '%s\n' "$REG" | grep -c 'docker compose ')
COM_ENV=$(printf '%s\n' "$REG" | grep 'docker compose ' \
          | grep -c -- '--env-file .*platform.env --env-file .*stack.env')
check "todas as chamadas ao compose levam os dois env-files" "$COM_ENV" "$COMPOSES"

# ── rollback quando o health falha ───────────────────────────────────
# ═════════════════════════════════════════════════════════════════════
# G · A imagem do perfil `tools`
#
# `deploy-app.sh` publica web/worker, mas o perfil `tools` corre noutra
# imagem. Enquanto este script só construía a primeira, cada deploy
# rápido afastava a segunda do código em produção — e os comandos
# administrativos passavam a correr `lib/` antigo contra uma base gerida
# por código novo, sem nada a dizê-lo.
#
# O que se testa aqui são as DUAS decisões, e que a "não" continua a ser
# a decisão barata: um deploy de UI não pode passar a pagar um build de
# 2 GB.
# ═════════════════════════════════════════════════════════════════════
echo
echo "G · imagem de ferramentas"

# ── G1 · só UI mudou → NÃO constrói ─────────────────────────────────
# A imagem de tools está numa revisão anterior (aaaaaaa) e nada em
# CAMINHOS_TOOLS mudou. Ficar atrás não é, por si, um problema.
DG1="$BASE/tools-ui"; ( REV_MIGRATOR=aaaaaaa preparar "$DG1" )
OUT=$(REV_MIGRATOR=aaaaaaa correr "$DG1"); RC=$?
REG=$(cat "$DG1/registo")
check "só UI: exit 0" "$RC" "0"
nao_contem "só UI: NÃO constrói a imagem de tools" "$REG" 'build .*migrate'
contem    "só UI: constrói na mesma a da aplicação" "$REG" 'compose .*build web'
contem    "só UI: diz que nada relevante mudou" "$OUT" 'nada relevante mudou'
contem    "só UI: e diz que a imagem está atrás, sem consequências" "$OUT" 'nada que ela leve mudou'

# ── G2 · lib/ mudou → constrói ──────────────────────────────────────
DG2="$BASE/tools-lib"; ( REV_MIGRATOR=aaaaaaa TOOLS_MUDOU=1 preparar "$DG2" )
OUT=$(REV_MIGRATOR=aaaaaaa TOOLS_MUDOU=1 correr "$DG2"); RC=$?
REG=$(cat "$DG2/registo")
check "lib mudou: exit 0" "$RC" "0"
contem "lib mudou: constrói a imagem de tools" "$REG" 'profile tools build migrate'
contem "lib mudou: nomeia o ficheiro que obrigou" "$OUT" 'lib/operational/motor-stock.ts'
contem "lib mudou: guarda rollback próprio da imagem de tools" "$REG" 'tag sha256:migrator-antigo .*rollback-aaaaaaa-migrator'

# O que NÃO pode acontecer nem sequer neste caminho.
nao_contem "lib mudou: não sobe o migrate"        "$REG" 'up .*migrate'
nao_contem "lib mudou: não corre nada no migrate" "$REG" 'run .*migrate'
nao_contem "lib mudou: não toca no postgres"      "$REG" 'up .*postgres'
nao_contem "lib mudou: não constrói o proxy"      "$REG" 'build .*proxy'
contem     "lib mudou: web e worker sobem na mesma" "$REG" 'up -d --no-deps web worker'

# A ordem importa: a imagem de tools e' construida ANTES de recriar os
# containers, para que uma falha dela nao apanhe a stack a meio.
POS_BUILD_MIGRATE=$(printf '%s\n' "$REG" | grep -n 'build migrate' | head -1 | cut -d: -f1)
POS_UP=$(printf '%s\n' "$REG" | grep -n 'up -d --no-deps web worker' | head -1 | cut -d: -f1)
if [ -n "$POS_BUILD_MIGRATE" ] && [ -n "$POS_UP" ] && [ "$POS_BUILD_MIGRATE" -lt "$POS_UP" ]; then
  pass=$((pass+1)); printf '  [OK]    constrói a imagem de tools ANTES de recriar containers\n'
else
  fail=$((fail+1)); printf '  [FALHA] a imagem de tools foi construída depois do up\n'
fi

# ── G3 · imagem sem carimbo → constrói, por não poder provar ────────
# É o estado real da VPS antes de bc6d585: a imagem existe mas não diz
# que revisão é. Não recebe o benefício da dúvida.
DG3="$BASE/tools-sem-carimbo"; ( preparar "$DG3" )
OUT=$(correr "$DG3"); RC=$?
REG=$(cat "$DG3/registo")
contem "sem carimbo: constrói a imagem de tools" "$REG" 'profile tools build migrate'
contem "sem carimbo: explica que não sabe a revisão" "$OUT" 'não existe ou não diz que revisão é'

# ── G4 · --skip-migrator com alterações → exit 3, sem rollback ──────
# A aplicação fica publicada e saudável; o que falha é a coerência. Um
# rollback aqui tirava do ar o que funciona.
DG4="$BASE/tools-skip"; ( REV_MIGRATOR=aaaaaaa TOOLS_MUDOU=1 preparar "$DG4" )
OUT=$(REV_MIGRATOR=aaaaaaa TOOLS_MUDOU=1 correr "$DG4" --skip-migrator); RC=$?
REG=$(cat "$DG4/registo")
check "--skip-migrator com alterações: exit 3" "$RC" "3"
nao_contem "--skip-migrator: não constrói a imagem de tools" "$REG" 'build .*migrate'
contem "--skip-migrator: sobe a aplicação na mesma" "$REG" 'up -d --no-deps web worker'
nao_contem "--skip-migrator: NÃO faz rollback da aplicação" "$REG" 'force-recreate'
contem "--skip-migrator: diz que a aplicação ficou publicada" "$OUT" 'publicada e saudável'
contem "--skip-migrator: dá o comando exacto para corrigir" "$OUT" 'force-migrator'

# ── G5 · --force-migrator sem alterações → constrói na mesma ────────
DG5="$BASE/tools-force"; ( REV_MIGRATOR=bbbbbbb preparar "$DG5" )
OUT=$(REV_MIGRATOR=bbbbbbb correr "$DG5" --force-migrator); RC=$?
REG=$(cat "$DG5/registo")
check "--force-migrator: exit 0" "$RC" "0"
contem "--force-migrator: constrói mesmo sem alterações" "$REG" 'profile tools build migrate'

# ── G6 · o rollback da aplicação não mexe na imagem de tools ────────
DG6="$BASE/tools-rb"; ( REV_MIGRATOR=aaaaaaa TOOLS_MUDOU=1 HTTP_CODE=500 preparar "$DG6" )
OUT=$(REV_MIGRATOR=aaaaaaa TOOLS_MUDOU=1 HTTP_CODE=500 correr "$DG6"); RC=$?
REG=$(cat "$DG6/registo")
check "rollback com imagem de tools nova: exit 1" "$RC" "1"
contem "rollback: repõe a imagem da aplicação" "$REG" 'tag sha256:imagem-antiga'
nao_contem "rollback: NÃO repõe a imagem de tools" "$REG" 'tag .*rollback-aaaaaaa-migrator .*-migrator$'
contem "rollback: diz que a de tools ficou por reverter" "$OUT" 'NÃO foi revertida'

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
GIT_ESCRITAS_RB=$(printf '%s\n' "$REG" \
  | grep -E '^git .*(checkout|fetch|reset|restore|clean|switch)' || true)
check "o rollback tambem nao escreve no clone" "$GIT_ESCRITAS_RB" ""

echo
echo "${pass} ok, ${fail} falhas"
[ "$fail" -eq 0 ] || exit 1
