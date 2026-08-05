#!/usr/bin/env bash
# deploy/tests/live-pgdata.sh
#
# Regressão do crash do PostgreSQL, com um cluster a sério.
#
# O que aconteceu na VPS: a política genérica de estrutura repunha
# `2700 deploy:spharmmt` no PGDATA. A imagem corre o PostgreSQL como
# uid/gid 999, mas o entrypoint arranca como root — o cluster inicializa
# e o container fica healthy. A falha só aparece na primeira escrita
# séria:
#
#     PANIC: could not open control file "pg_control": Permission denied
#     FATAL: could not stat data directory
#
# Uma base que arranca bem e morre a meio do primeiro checkpoint é o pior
# modo de falha possível: a mensagem não aponta para permissões e já há
# tráfego em cima.
#
# O ciclo testado é o do relatório:
#   1. PostgreSQL arranca com o PGDATA correcto
#   2. CHECKPOINT explícito
#   3. install-platform (simulado: ensure_pgdata_dir com a stack de pé)
#   4. o ownership MANTÉM-SE
#   5. novo CHECKPOINT
#   6. o container continua healthy
#
# Mais dois casos que fecham a regressão: com o dono errado o CHECKPOINT
# tem mesmo de falhar (senão o teste não prova nada), e com o servidor
# parado o ensure_pgdata_dir tem de corrigir.
#
# NÃO faz parte da suite `test-*.sh`: precisa de Docker. Corre-se à mão:
#
#     ./deploy/tests/live-pgdata.sh
#
# NUNCA toca no PGDATA da VPS: usa um volume Docker descartável.
#
# Saída: 0 tudo passou · 1 pelo menos um caso falhou · 2 sem Docker

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPTS_DIR=${SCRIPTS_DIR:-${REPO_ROOT}/deploy/scripts}
PG_IMAGE=${PG_IMAGE:-postgres:17.6-bookworm}
VOL=spharmmt-livepg-data
PG=spharmmt-livepg
PGPASS=livepgtest

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
eq_()  { if [ "$2" = "$3" ]; then ok_ "$1 → ${3}"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi; }

if [ -n "${MSYSTEM:-}" ] || uname -s 2>/dev/null | grep -qE 'MINGW|MSYS'; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
fi

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ═════════════════════════════════════════════════════════════════════════
# Helpers — tudo dentro de containers, para as permissões serem reais.
# ═════════════════════════════════════════════════════════════════════════

# O volume é montado em /pg e o PGDATA é /pg/data — assim consegue-se
# mexer no dono do PGDATA a partir de outro container, tal como o
# install-platform.sh faz no host.
vol_sh() { docker run --rm -v "${VOL}:/pg" "$PG_IMAGE" sh -c "$1"; }

pgdata_ownership() { vol_sh 'stat -c "%a %u:%g" /pg/data' 2>/dev/null | tr -d '\r\n'; }

start_pg() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" \
    -e POSTGRES_PASSWORD="$PGPASS" \
    -e PGDATA=/pg/data \
    --security-opt no-new-privileges:true \
    --health-cmd 'pg_isready -U postgres -q' \
    --health-interval 5s --health-timeout 3s --health-retries 10 --health-start-period 30s \
    -v "${VOL}:/pg" \
    "$PG_IMAGE" >/dev/null 2>&1
}

wait_health() {
  local want=$1 deadline=$(( $(date +%s) + ${2:-90} )) h=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$PG" 2>/dev/null || echo missing)
    [ "$h" = "$want" ] && { printf '%s' "$h"; return 0; }
    sleep 3
  done
  printf '%s' "${h:-missing}"
  return 1
}

checkpoint() {
  docker exec "$PG" psql -U postgres -d postgres -Atc 'CHECKPOINT' >/dev/null 2>&1
}

# Reproduz o que o install-platform.sh fazia: repor o dono do PGDATA.
# Feito de outro container, porque no host o volume não é acessível.
force_owner() { vol_sh "chown ${1} /pg/data && chmod ${2} /pg/data" >/dev/null; }

# Corre o ensure_pgdata_dir real, extraído do common.sh, contra o volume.
# É a mesma implementação que corre na VPS — não uma cópia.
run_ensure_pgdata() {
  local running=$1   # 1 = simula PostgreSQL a correr
  docker run --rm -v "${VOL}:/pg" -v "$(cygpath -w "$SCRIPTS_DIR" 2>/dev/null || printf '%s' "$SCRIPTS_DIR"):/s:ro" \
    "$PG_IMAGE" bash -c "
      set -uo pipefail
      SPHARMMT_POSTGRES_DATA_DIR=/pg/data
      SPHARMMT_PG_UID=999; SPHARMMT_PG_GID=999
      DRY_RUN=0; CHANGES_MADE=0
      die()  { printf 'die: %s\n' \"\$*\"; exit 1; }
      ok()   { printf '  [ok] %s\n' \"\$*\"; }
      warn() { printf '  [warn] %s\n' \"\$*\"; }
      info() { printf '  [info] %s\n' \"\$*\"; }
      dbg()  { :; }
      run()  { \"\$@\"; }
      # Definida aqui, e não extraída: o \`pg_is_running\` do common.sh é
      # um one-liner, e um range de sed \`/^pg_is_running()/,/^}/\` não
      # encontra o \`}\` na própria linha — continuava a imprimir até ao
      # \`}\` seguinte e partia o ensure_pgdata_dir ao meio.
      pg_is_running() { [ '${running}' = '1' ]; }
      SPHARMMT_PG_CONTAINER=x
      eval \"\$(sed -n '/^ensure_pgdata_dir()/,/^}/p' /s/lib/common.sh)\"
      ensure_pgdata_dir
    " 2>&1
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste real: dono do PGDATA e checkpoints ===\n'

  command -v docker >/dev/null 2>&1 || { printf '  docker não encontrado\n'; return 2; }
  docker info >/dev/null 2>&1 || { printf '  daemon docker não responde\n'; return 2; }
  [ -f "${SCRIPTS_DIR}/lib/common.sh" ] || { printf '  common.sh não encontrado\n'; return 2; }

  cleanup
  docker volume create "$VOL" >/dev/null

  # ── 0. O uid/gid vem da IMAGEM, não é assumido ─────────────────────
  printf '\n0. Utilizador postgres da imagem\n'
  local ids
  ids=$(docker run --rm --entrypoint sh "$PG_IMAGE" -c 'id -u postgres; id -g postgres' 2>/dev/null | tr '\n' ':' | sed 's/:$//')
  eq_ "uid:gid de ${PG_IMAGE}" "999:999" "$ids"

  # ── 1. Arranque com o PGDATA correcto ──────────────────────────────
  printf '\n1. PostgreSQL arranca\n'
  start_pg
  local h; h=$(wait_health healthy 120 || true)
  eq_ "container healthy" "healthy" "$h"
  printf '   PGDATA: %s\n' "$(pgdata_ownership)"

  # ── 2. CHECKPOINT explícito ────────────────────────────────────────
  printf '\n2. CHECKPOINT explícito\n'
  if checkpoint; then ok_ "CHECKPOINT escreve no pg_control"; else bad_ "CHECKPOINT falhou já no estado bom"; fi

  # ── 3. install-platform outra vez, com a stack DE PÉ ───────────────
  printf '\n3. ensure_pgdata_dir com o PostgreSQL a correr\n'
  local before; before=$(pgdata_ownership)
  local out; out=$(run_ensure_pgdata 1)
  printf '%s\n' "$out" | sed 's/^/   /'
  local after; after=$(pgdata_ownership)

  # ── 4. O ownership mantém-se ───────────────────────────────────────
  printf '\n4. Ownership mantém-se\n'
  eq_ "PGDATA inalterado" "$before" "$after"
  # Só o uid conta: o entrypoint faz `chown postgres` SEM grupo, portanto
  # um cluster criado de raiz fica 999:0 e um corrigido à mão fica
  # 999:999. Com 0700, o grupo não tem acesso nenhum.
  if printf '%s' "$after" | grep -qE ' 999:'; then ok_ "owner continua uid 999"; else bad_ "dono mudou: ${after}"; fi

  # ── 5. Novo CHECKPOINT ─────────────────────────────────────────────
  printf '\n5. Novo CHECKPOINT\n'
  if checkpoint; then ok_ "CHECKPOINT continua a funcionar"; else bad_ "CHECKPOINT falhou depois do install-platform"; fi

  # ── 6. Container continua healthy ──────────────────────────────────
  printf '\n6. Estado do container\n'
  h=$(docker inspect -f '{{.State.Health.Status}}' "$PG" 2>/dev/null || echo missing)
  eq_ "continua healthy" "healthy" "$h"
  eq_ "sem reinícios" "0" "$(docker inspect -f '{{.RestartCount}}' "$PG" 2>/dev/null || echo '?')"
  if docker logs "$PG" 2>&1 | grep -q 'PANIC'; then bad_ "há PANIC nos logs"; else ok_ "nenhum PANIC nos logs"; fi

  # ── 7. A falha, para provar que o teste testa alguma coisa ─────────
  printf '\n7. Com o dono errado, o CHECKPOINT TEM de falhar\n'
  force_owner "1002:1001" "2700"
  printf '   PGDATA forçado a: %s\n' "$(pgdata_ownership)"
  # SEM restart, de propósito, e é isto que reproduz a falha real: o
  # entrypoint da imagem corre `find "$PGDATA" \! -user postgres -exec
  # chown postgres` a cada arranque, portanto um restart CORRIGE o dono
  # sozinho. Foi por isso que a avaria só apareceu em execução — o
  # install-platform.sh mudou o dono com o servidor de pé, e o servidor
  # só descobriu no checkpoint seguinte.
  sleep 3
  if checkpoint; then
    bad_ "CHECKPOINT funcionou com o dono errado — a reprodução não é fiel"
  else
    ok_ "CHECKPOINT falha com 1002:1001 (é a causa reproduzida)"
  fi
  if docker logs "$PG" 2>&1 | grep -qiE 'permission denied|PANIC|could not'; then
    ok_ "logs mostram o erro de permissões"
  else
    bad_ "logs não mostram erro de permissões"
  fi

  # ── 7b. A guarda, exercitada a sério ───────────────────────────────
  # Aqui o estado ESTÁ errado e o PostgreSQL ESTÁ a correr. É o caso em
  # que a tentação de "corrigir já" é maior — e é exactamente onde não se
  # pode tocar: um chown a quente troca uma configuração errada por uma
  # base em baixo. Tem de avisar e não mexer.
  printf '\n7b. Guarda: não corrigir a quente\n'
  local wrong_before; wrong_before=$(pgdata_ownership)
  out=$(run_ensure_pgdata 1)
  printf '%s\n' "$out" | sed 's/^/   /'
  eq_ "PGDATA NÃO foi alterado com o servidor de pé" "$wrong_before" "$(pgdata_ownership)"
  if printf '%s' "$out" | grep -qi 'A CORRER'; then
    ok_ "avisa que o PostgreSQL está a correr"
  else
    bad_ "não avisou — corrigiu em silêncio ou calou-se"
  fi
  if printf '%s' "$out" | grep -qi 'parar a stack'; then
    ok_ "diz ao operador o que fazer"
  else
    bad_ "não diz como corrigir"
  fi

  # ── 8. Com o servidor PARADO, ensure_pgdata_dir corrige ────────────
  printf '\n8. Correcção com o PostgreSQL parado\n'
  docker rm -f "$PG" >/dev/null 2>&1 || true
  out=$(run_ensure_pgdata 0)
  printf '%s\n' "$out" | sed 's/^/   /'
  local fixed; fixed=$(pgdata_ownership)
  eq_ "PGDATA corrigido" "700 999:999" "$fixed"
  if printf '%s' "$fixed" | grep -qE '^700 999:'; then ok_ "modo 0700 e owner uid 999"; else bad_ "estado inesperado: ${fixed}"; fi

  start_pg
  h=$(wait_health healthy 120 || true)
  eq_ "PostgreSQL volta a arrancar" "healthy" "$h"
  if checkpoint; then ok_ "CHECKPOINT volta a funcionar"; else bad_ "CHECKPOINT continua a falhar"; fi

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
