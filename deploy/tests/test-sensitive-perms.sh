#!/usr/bin/env bash
# deploy/tests/test-sensitive-perms.sh
#
# A varredura de "nada acessível a others" tem de distinguir duas coisas
# que se parecem: um ficheiro legivelmente público e um segredo exposto.
#
# O caso real que motivou esta separação, reportado da VPS:
#
#   2755 deploy:spharmmt  /data/postgres/init
#   755  deploy:spharmmt  /data/postgres/init/10-databases.sh
#
# São scripts de inicialização, não são segredos, e TÊM de ser legíveis:
# o entrypoint do container do PostgreSQL corre-os como utilizador
# `postgres`, que não é o dono deles no host. Acusá-los treinava qualquer
# pessoa a ignorar o check — que é como um check deixa de servir.
#
# O risco da exclusão é óbvio: excluir demais. Por isso metade destes
# casos verifica que a varredura CONTINUA a apanhar o que interessa,
# incluindo dentro dos directórios excluídos.
#
# Corre sem root: cria uma árvore falsa em /tmp e aponta-lhe as variáveis.
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

set -uo pipefail

SCRIPTS_DIR=${SCRIPTS_DIR:-/work/deploy/scripts}
WORK=/tmp/spharmmt-permscan

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok_ "$d"; else bad_ "$d"; fi; }
refute(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then bad_ "$d"; else ok_ "$d"; fi; }

# ═════════════════════════════════════════════════════════════════════════
# As funções vêm do próprio verify-platform.sh, extraídas para não haver
# duas implementações a divergir. O ficheiro é `source`-ado com as
# variáveis apontadas à árvore de teste; o `main` dele não corre porque
# está atrás do parsing de argumentos.
# ═════════════════════════════════════════════════════════════════════════
extract_functions() {
  sed -n '/^sensitive_paths() {/,/^conf_dir_has_no_credentials() .*$/p' \
    "${SCRIPTS_DIR}/verify-platform.sh"
}

build_tree() {
  rm -rf "$WORK"
  mkdir -p "$WORK/opt/secrets" "$WORK/opt/docker/env" \
           "$WORK/data/postgres/data" "$WORK/data/postgres/init" \
           "$WORK/data/postgres/conf" "$WORK/data/backups/postgres"

  # Reproduz a VPS: init legível e executável, tal como reportado.
  printf '#!/usr/bin/env bash\necho init\n' > "$WORK/data/postgres/init/10-databases.sh"
  chmod 0755 "$WORK/data/postgres/init/10-databases.sh"
  chmod 2755 "$WORK/data/postgres/init"

  # conf: ficheiro de configuração público.
  printf 'shared_buffers = 512MB\n' > "$WORK/data/postgres/conf/tuning.conf"
  chmod 0644 "$WORK/data/postgres/conf/tuning.conf"
  chmod 0755 "$WORK/data/postgres/conf"

  # Sensível, fechado como deve ser.
  printf 'AUTH_SECRET=x\n' > "$WORK/opt/secrets/platform.secrets.env"
  chmod 0600 "$WORK/opt/secrets/platform.secrets.env"
  chmod 0700 "$WORK/opt/secrets"
  printf 'NODE_ENV=production\n' > "$WORK/opt/docker/env/platform.env"
  chmod 0640 "$WORK/opt/docker/env/platform.env"
  chmod 0750 "$WORK/opt/docker/env"
  chmod 0700 "$WORK/data/postgres/data" "$WORK/data/backups" "$WORK/data/backups/postgres"
}

# As variáveis são lidas pelas funções extraídas do verify-platform.sh e
# avaliadas em runtime — o ShellCheck não vê essa ligação (SC2034).
point_at_tree() {
  # shellcheck disable=SC2034
  SPHARMMT_ROOT="$WORK/opt"
  # shellcheck disable=SC2034
  SPHARMMT_DATA_ROOT="$WORK/data"
  # shellcheck disable=SC2034
  SPHARMMT_PG_DIR="$WORK/data/postgres"
  # shellcheck disable=SC2034
  SPHARMMT_POSTGRES_DATA_DIR="$WORK/data/postgres/data"
  # shellcheck disable=SC2034
  SPHARMMT_BACKUP_DIR="$WORK/data/backups"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: varredura de permissões sensíveis ===\n'

  if [ ! -f "${SCRIPTS_DIR}/verify-platform.sh" ]; then
    printf '  verify-platform.sh não encontrado em %s\n' "$SCRIPTS_DIR"
    return 1
  fi

  local fns; fns=$(extract_functions)
  if ! printf '%s' "$fns" | grep -q 'no_world_readable_credentials'; then
    bad_ "não consegui extrair as funções do verify-platform.sh"
    return 1
  fi
  # shellcheck disable=SC1090  # código extraído em runtime, sem ficheiro
  eval "$fns"

  build_tree
  point_at_tree

  # ── 1. O caso reportado ────────────────────────────────────────────
  printf '\n1. O caso reportado da VPS\n'
  printf '   init: %s · script: %s\n' \
    "$(stat -c '%a' "$WORK/data/postgres/init")" \
    "$(stat -c '%a' "$WORK/data/postgres/init/10-databases.sh")"
  assert "árvore sensível limpa com init/ a 2755 e script a 755" \
    no_world_access_in_sensitive
  assert "nenhuma credencial legível por others"      no_world_readable_credentials
  assert "init sem ficheiros de credenciais"          init_dir_has_no_credentials
  assert "conf sem ficheiros de credenciais"          conf_dir_has_no_credentials

  # ── 2. O que TEM de continuar a falhar ─────────────────────────────
  printf '\n2. Continua a apanhar o que interessa\n'

  chmod 0644 "$WORK/opt/secrets/platform.secrets.env"
  refute "segredo a 0644 é apanhado"                  no_world_access_in_sensitive
  refute "  e também pelo nome (*.env)"               no_world_readable_credentials
  chmod 0600 "$WORK/opt/secrets/platform.secrets.env"
  assert "  reposto a 0600, volta a passar"           no_world_access_in_sensitive

  chmod 0644 "$WORK/opt/docker/env/platform.env"
  refute "platform.env a 0644 é apanhado"             no_world_access_in_sensitive
  chmod 0640 "$WORK/opt/docker/env/platform.env"

  printf 'x' > "$WORK/data/backups/postgres/set.dump"; chmod 0644 "$WORK/data/backups/postgres/set.dump"
  refute "dump de backup a 0644 é apanhado"           no_world_access_in_sensitive
  rm -f "$WORK/data/backups/postgres/set.dump"

  printf 'x' > "$WORK/data/postgres/data/PG_VERSION"; chmod 0644 "$WORK/data/postgres/data/PG_VERSION"
  refute "ficheiro em postgres/data a 0644 é apanhado" no_world_access_in_sensitive
  rm -f "$WORK/data/postgres/data/PG_VERSION"
  assert "  removido, volta a passar"                 no_world_access_in_sensitive

  # ── 3. A exclusão não pode virar um buraco ─────────────────────────
  printf '\n3. Credenciais DENTRO dos directórios excluídos\n'

  # Este é o cenário que torna a exclusão perigosa se for cega.
  printf 'PGPASSWORD=x\n' > "$WORK/data/postgres/init/99-secrets.env"
  chmod 0644 "$WORK/data/postgres/init/99-secrets.env"
  refute ".env dentro de init/ é apanhado pelo nome"  no_world_readable_credentials
  refute "  e o init deixa de estar limpo"            init_dir_has_no_credentials
  rm -f "$WORK/data/postgres/init/99-secrets.env"
  assert "  removido, init volta a estar limpo"       init_dir_has_no_credentials

  printf 'KEY\n' > "$WORK/data/postgres/conf/server.key"
  chmod 0644 "$WORK/data/postgres/conf/server.key"
  refute "chave privada em conf/ é apanhada"          no_world_readable_credentials
  refute "  e o conf deixa de estar limpo"            conf_dir_has_no_credentials
  chmod 0600 "$WORK/data/postgres/conf/server.key"
  assert "  a 0600 já não é legível por others"       no_world_readable_credentials
  refute "  mas o conf continua a NÃO estar limpo"    conf_dir_has_no_credentials
  rm -f "$WORK/data/postgres/conf/server.key"

  printf 'CERT\n' > "$WORK/opt/privkey.pem"; chmod 0644 "$WORK/opt/privkey.pem"
  refute "privkey.pem a 0644 é apanhado"              no_world_readable_credentials
  rm -f "$WORK/opt/privkey.pem"

  printf 'x\n' > "$WORK/opt/.pgpass"; chmod 0644 "$WORK/opt/.pgpass"
  refute ".pgpass a 0644 é apanhado"                  no_world_readable_credentials
  rm -f "$WORK/opt/.pgpass"

  assert "árvore limpa outra vez"                     no_world_readable_credentials

  # ── 4. Legível sim, escrivível não ─────────────────────────────────
  printf '\n4. Escrita por others nunca é aceitável\n'
  chmod 0757 "$WORK/data/postgres/init"
  refute "init escrivível por others é apanhado" \
    bash -c "[ -z \"\$(find '$WORK/data/postgres/init' -perm /o+w -print -quit 2>/dev/null)\" ]"
  chmod 2755 "$WORK/data/postgres/init"
  assert "  reposto a 2755, volta a passar" \
    bash -c "[ -z \"\$(find '$WORK/data/postgres/init' -perm /o+w -print -quit 2>/dev/null)\" ]"

  # ── 5. postgres/ NÃO pode estar na lista sensível ──────────────────
  printf '\n5. A lista sensível é a certa\n'
  local list; list=$(sensitive_paths | tr '\n' ' ')
  printf '   %s\n' "$list"
  assert "inclui postgres/data"    bash -c "printf '%s' '$list' | grep -q 'postgres/data'"
  assert "inclui backups"          bash -c "printf '%s' '$list' | grep -q 'backups'"
  assert "inclui secrets"          bash -c "printf '%s' '$list' | grep -q 'secrets'"
  assert "inclui docker/env"       bash -c "printf '%s' '$list' | grep -q 'docker/env'"
  refute "NÃO inclui postgres/init"  bash -c "printf '%s' '$list' | grep -q 'postgres/init'"
  refute "NÃO inclui postgres/conf"  bash -c "printf '%s' '$list' | grep -q 'postgres/conf'"

  rm -rf "$WORK"

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
