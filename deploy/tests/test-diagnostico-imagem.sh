#!/usr/bin/env bash
# deploy/tests/test-diagnostico-imagem.sh
#
# Um diagnóstico só é válido se o código E as bibliotecas vierem da MESMA
# revisão. Este teste prova isso com docker a sério, reproduzindo o modo
# de falha que apareceu em produção.
#
# ── O que falhou lá ──────────────────────────────────────────────────
# `deploy-app.sh` constrói deliberadamente só `web`. A imagem do migrator
# (`spharmmt-app:local-migrator`) é construída apenas pelo
# install-stack.sh e pelo update-platform.sh, portanto fica para trás a
# cada deploy rápido. Montar `scripts/diagnostics` de um commit novo
# sobre um `/app/lib` antigo dá:
#
#     Error: Cannot find module '../../lib/operational/motor-stock'
#
# E se por acaso não desse erro seria pior: o diagnóstico correria com
# metade das regras de uma revisão e metade de outra, e o número que
# imprimisse não seria de revisão nenhuma.
#
# ── O que este teste faz ─────────────────────────────────────────────
#   1. constrói uma imagem migrator OBSOLETA a partir de REV_VELHA e
#      publica-a na tag de produção — é a VPS reproduzida;
#   2. confirma que o truque do mount falha exactamente com aquele erro;
#   3. constrói a imagem de diagnóstico a partir de REV_NOVA com
#      APP_IMAGE/APP_TAG próprios;
#   4. confirma que a tag de produção NÃO mudou de id;
#   5. corre o diagnóstico sem mounts e confirma que carregou tudo;
#   6. confirma que nenhum serviço da stack foi criado ou tocado.
#
# Corre com:  bash deploy/tests/test-diagnostico-imagem.sh
# Variáveis:  REV_VELHA (default 0e523dc) · REV_NOVA (default HEAD)
#
# Custo: dois builds completos da imagem. É lento de propósito — a
# alternativa é descobrir o mesmo na VPS.
set -uo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
export DOCKER_BUILDKIT=1

# 0e523dc e' a ultima revisao que chegou a producao por um caminho que
# construiu a imagem do migrator. E' anterior a 2a95208, que introduziu
# lib/operational/motor-stock.ts — dai o desfasamento ser real e nao
# encenado.
REV_VELHA=${REV_VELHA:-0e523dc}
REV_NOVA=${REV_NOVA:-$(git rev-parse --short HEAD)}

# Dois builds completos custam quinze minutos. Quando o que se esta' a
# afinar sao as asseroes de execucao e nao as de build, MANTER=1 deixa
# as imagens no sitio e REUTILIZAR=1 salta o build das que ja' existem.
# Nenhuma das duas e' o modo por omissao: o teste completo constroi
# sempre de raiz.
MANTER=${MANTER:-0}
REUTILIZAR=${REUTILIZAR:-0}

RAIZ=$(git rev-parse --show-toplevel)
BASE=$(mktemp -d)

# O docker desta maquina pode ser um binario Windows a receber caminhos
# de um bash MSYS: `/tmp/x` chega-lhe como `C:\tmp\x`, que nao
# existe. Tudo o que atravessa a fronteira — env-file, contexto de build,
# mounts — passa por aqui. Em Linux e' a identidade.
win() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}
REDE=spharmmt-net-teste
DIAG=scripts/diagnostics/funil-rotura-transferencias.ts
BANNER='diagnóstico read-only'

ok=0; ko=0
check() { if [ "$1" = "0" ]; then ok=$((ok+1)); echo "  [OK]    $2"; else ko=$((ko+1)); echo "  [FALHA] $2"; [ -n "${3:-}" ] && echo "            ${3}"; fi; }

limpar() {
  if [ "$MANTER" != "1" ]; then
    docker rmi -f spharmmt-diag:teste-migrator >/dev/null 2>&1
    docker rmi -f spharmmt-app:teste-migrator  >/dev/null 2>&1
  fi
  docker network rm "$REDE" >/dev/null 2>&1
  rm -rf "$BASE"
}
trap limpar EXIT

# ══════════════════════════════════════════════════════════════════════
# Uma stack de mentira: o compose exige env_files existentes e uma rede
# externa. Nenhum destes ficheiros tem segredos — o teste nunca liga a
# base de dados nenhuma.
# ══════════════════════════════════════════════════════════════════════
mkdir -p "$BASE/secrets" "$BASE/env"
# TODOS os que o compose refere, e não só os do `migrate`: o compose lê o
# modelo inteiro antes de correr um serviço, e um env_file em falta em
# QUALQUER serviço rebenta o `run` — mesmo com `--no-deps`, mesmo sendo
# do postgres, que este teste nunca arranca.
for f in $(grep -o 'secrets/[a-z-]*\.secrets\.env' "$RAIZ/deploy/docker/docker-compose.yml" | sort -u); do
  : > "$BASE/$f"
done
# O entrypoint recusa-se a correr seja o que for sem DATABASE_URL, e sai
# com 2 — o MESMO código com que o diagnóstico assinala `--tenant` em
# falta. Sem esta linha, a secção D passava por coincidência: media o
# entrypoint a desistir e chamava-lhe "o diagnóstico correu".
#
# O destino é deliberadamente inexistente (porto 1). O diagnóstico sem
# `--tenant` desiste antes de abrir ligação nenhuma; se algum dia a
# abrisse, esta linha fá-lo-ia falhar em vez de o deixar tocar numa base
# a sério.
#
# São precisos os DOIS: `ensure_db_urls` exige tanto DATABASE_URL como
# CONTROL_DATABASE_URL antes de deixar passar qualquer comando.
cat > "$BASE/secrets/app.secrets.env" <<'EOF'
DATABASE_URL=postgresql://naoexiste:naoexiste@127.0.0.1:1/naoexiste
CONTROL_DATABASE_URL=postgresql://naoexiste:naoexiste@127.0.0.1:1/naoexiste
EOF
cat > "$BASE/env/platform.env" <<'EOF'
SERVER_ACTIONS_ALLOWED_ORIGINS=teste.local
PUBLIC_APP_URL=https://teste.local
INSTALL_CHROMIUM=0
EOF
docker network create "$REDE" >/dev/null 2>&1

# Contextos de build limpos, um por revisão. `git archive` e não
# `checkout`: não mexe no worktree e não deixa nada root-owned.
ctx_de() {
  local rev=$1 destino="$BASE/ctx-$1"
  mkdir -p "$destino"
  git -C "$RAIZ" archive --format=tar "$rev" | tar -x -C "$destino"
  echo "$destino"
}

dc() {
  docker compose \
    -f "$RAIZ/deploy/docker/docker-compose.yml" \
    -p spharmmt-teste \
    --env-file "$(win "$BASE/env/platform.env")" \
    "$@"
}
# O ambiente que o compose interpola. SPHARMMT_ROOT/ENV_FILE redirigem os
# env_file para a stack de mentira; SPHARMMT_NETWORK para a rede do teste.
export SPHARMMT_ROOT="$(win "$BASE")"
export SPHARMMT_ENV_FILE="$(win "$BASE/env/platform.env")"
export SPHARMMT_NETWORK="$REDE"

echo
echo "revisão obsoleta: $REV_VELHA   ·   revisão do diagnóstico: $REV_NOVA"

# ══════════════════════════════════════════════════════════════════════
# A · A VPS reproduzida: imagem migrator parada na revisão antiga
# ══════════════════════════════════════════════════════════════════════
echo
echo "A · imagem migrator obsoleta (${REV_VELHA})"

CTX_VELHO=$(ctx_de "$REV_VELHA")
check "$([ -f "$CTX_VELHO/lib/operational/motor-stock.ts" ] && echo 1 || echo 0)" \
  "a revisão antiga NÃO tem lib/operational/motor-stock.ts (é este o desfasamento)"

construir() {   # <imagem> <contexto> <revisao> <log>
  if [ "$REUTILIZAR" = "1" ] && docker image inspect "$1:teste-migrator" >/dev/null 2>&1; then
    echo "  [~~]    $1:teste-migrator reutilizada (REUTILIZAR=1)"
    return 0
  fi
  APP_IMAGE="$1" APP_TAG=teste \
  APP_BUILD_CONTEXT="$(win "$2")" APP_REVISION="$3" \
    dc --profile tools build migrate > "$4" 2>&1
}

construir spharmmt-app "$CTX_VELHO" "$REV_VELHA" "$BASE/build-velho.log"
check "$?" "build da imagem obsoleta" "$(tail -5 "$BASE/build-velho.log" 2>/dev/null)"

ID_PRODUCAO_ANTES=$(docker image inspect spharmmt-app:teste-migrator --format '{{.Id}}' 2>/dev/null)
check "$([ -n "$ID_PRODUCAO_ANTES" ] && echo 0 || echo 1)" "a tag de produção existe e tem id"

# ══════════════════════════════════════════════════════════════════════
# B · O truque do mount falha — e falha com o erro exacto de produção
# ══════════════════════════════════════════════════════════════════════
echo
echo "B · montar só scripts/diagnostics sobre libs antigas"

CTX_NOVO=$(ctx_de "$REV_NOVA")
check "$([ -f "$CTX_NOVO/lib/operational/motor-stock.ts" ] && echo 0 || echo 1)" \
  "a revisão nova TEM lib/operational/motor-stock.ts"

SAIDA_MOUNT=$(APP_IMAGE=spharmmt-app APP_TAG=teste \
  dc --profile tools run --rm --no-deps \
    -v "$(win "$CTX_NOVO")/scripts/diagnostics:/app/scripts/diagnostics:ro" \
    migrate npx tsx "$DIAG" --tenant=x 2>&1)

echo "$SAIDA_MOUNT" | grep -q "Cannot find module.*motor-stock"
check "$?" "reproduz o erro de produção: Cannot find module … motor-stock" \
  "$(echo "$SAIDA_MOUNT" | tail -3)"

# ══════════════════════════════════════════════════════════════════════
# C · Imagem de diagnóstico, revisão inteira, tag própria
# ══════════════════════════════════════════════════════════════════════
echo
echo "C · imagem de diagnóstico (${REV_NOVA})"

construir spharmmt-diag "$CTX_NOVO" "$REV_NOVA" "$BASE/build-novo.log"
check "$?" "build da imagem de diagnóstico" "$(tail -5 "$BASE/build-novo.log" 2>/dev/null)"

check "$(docker image inspect spharmmt-diag:teste-migrator >/dev/null 2>&1 && echo 0 || echo 1)" \
  "a imagem saiu na tag própria spharmmt-diag:teste-migrator"

# Requisito 6: as tags de produção não podem ter sido tocadas.
ID_PRODUCAO_DEPOIS=$(docker image inspect spharmmt-app:teste-migrator --format '{{.Id}}' 2>/dev/null)
check "$([ "$ID_PRODUCAO_ANTES" = "$ID_PRODUCAO_DEPOIS" ] && echo 0 || echo 1)" \
  "spharmmt-app:teste-migrator continua com o MESMO id — a tag de produção não foi reescrita"
check "$(docker image inspect spharmmt-app:teste >/dev/null 2>&1 && echo 1 || echo 0)" \
  "a imagem de web/worker nem sequer foi construída"

# A imagem tem de saber dizer de que revisão é. Sem isto, a única forma
# de descobrir o desfasamento era ir procurar um ficheiro lá dentro.
rev_da_imagem() {
  docker image inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n 's/^APP_REVISION=//p' | head -1
}
check "$([ "$(rev_da_imagem spharmmt-diag:teste-migrator)" = "$REV_NOVA" ] && echo 0 || echo 1)" \
  "a imagem de diagnóstico carimba APP_REVISION=${REV_NOVA}" \
  "veio '$(rev_da_imagem spharmmt-diag:teste-migrator)'"
check "$([ "$(rev_da_imagem spharmmt-app:teste-migrator)" != "$REV_NOVA" ] && echo 0 || echo 1)" \
  "e a obsoleta carimba outra — o desfasamento fica legível sem adivinhar"

# ══════════════════════════════════════════════════════════════════════
# D · Correr sem mounts: o grafo inteiro carrega
# ══════════════════════════════════════════════════════════════════════
echo
echo "D · execução na imagem de diagnóstico, sem mounts"

SAIDA=$(APP_IMAGE=spharmmt-diag APP_TAG=teste \
  dc --profile tools run --rm --no-deps migrate npx tsx "$DIAG" 2>&1)
ESTADO=$?

echo "$SAIDA" | grep -q "Cannot find module"
check "$([ $? -eq 0 ] && echo 1 || echo 0)" "nenhum módulo em falta" \
  "$(echo "$SAIDA" | grep 'Cannot find module' | head -2)"
echo "$SAIDA" | grep -q "$BANNER"
check "$?" "a linha de arranque saiu — carregou tudo" "$(echo "$SAIDA" | tail -3)"
check "$([ "$ESTADO" = "2" ] && echo 0 || echo 1)" \
  "saiu com 2 (falta --tenant), e não com erro de carregamento" "estado=$ESTADO"

# O diagnóstico é read-only: sem --tenant não abre ligação nenhuma.
echo "$SAIDA" | grep -qi "prisma migrate\|migration"
check "$([ $? -eq 0 ] && echo 1 || echo 0)" "não menciona migrations"

# ══════════════════════════════════════════════════════════════════════
# E · A stack não foi tocada
# ══════════════════════════════════════════════════════════════════════
echo
echo "E · a stack não foi tocada"

for svc in postgres web worker proxy; do
  n=$(docker ps -a --filter "label=com.docker.compose.project=spharmmt-teste" \
                   --filter "label=com.docker.compose.service=$svc" -q | wc -l)
  check "$([ "$n" -eq 0 ] && echo 0 || echo 1)" "nenhum container de ${svc} foi criado"
done

# `run --rm` não deixa nada para trás.
n=$(docker ps -a --filter "label=com.docker.compose.project=spharmmt-teste" -q | wc -l)
check "$([ "$n" -eq 0 ] && echo 0 || echo 1)" "nenhum container ficou para trás"

echo
echo "${ok} ok, ${ko} falhas"
[ "$ko" -eq 0 ] || exit 1
