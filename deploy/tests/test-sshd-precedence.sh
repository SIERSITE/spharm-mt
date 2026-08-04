#!/usr/bin/env bash
# deploy/tests/test-sshd-precedence.sh
#
# Teste de regressão para a falha real numa VPS Ubuntu 24.04 cloud image:
#
#   /etc/ssh/sshd_config.d/50-cloud-init.conf         PasswordAuthentication yes
#   /etc/ssh/sshd_config.d/60-cloudimg-settings.conf  PasswordAuthentication no
#   /etc/ssh/sshd_config.d/99-spharmmt-hardening.conf PasswordAuthentication no
#
#   $ sshd -T | grep -i passwordauthentication
#   passwordauthentication yes        ← o endurecimento estava INERTE
#
# O `Include /etc/ssh/sshd_config.d/*.conf` está no TOPO do sshd_config, os
# ficheiros são lidos por ordem lexicográfica, e em SSH o PRIMEIRO valor
# obtido para cada palavra-chave vence. Com o prefixo 99- o nosso ficheiro
# chegava depois do 50- da cloud image e não tinha efeito nenhum.
#
# Este teste usa o `sshd` REAL da imagem para provar as duas metades:
#   · com 99- o resultado efectivo é `yes`  (reproduz a falha)
#   · com 00- o resultado efectivo é `no`   (confirma a correcção)
#
# Verifica ainda que o bootstrap gera o ficheiro com prefixo 00- e que o
# verificador testa `sshd -T`, não o conteúdo dos ficheiros.
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

set -uo pipefail

SCRIPTS_DIR=${SCRIPTS_DIR:-/work/deploy/scripts}
WORK=/tmp/spharmmt-sshtest

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
eq_()  { # eq_ <desc> <esperado> <obtido>
  if [ "$2" = "$3" ]; then ok_ "$1 → ${3}"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi
}
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok_ "$d"; else bad_ "$d"; fi; }

# ═════════════════════════════════════════════════════════════════════════
# Ambiente: um sshd_config isolado que replica a cloud image
# ═════════════════════════════════════════════════════════════════════════
setup() {
  rm -rf "$WORK"; mkdir -p "${WORK}/sshd_config.d"

  # O sshd recusa arrancar (mesmo com -t/-T) sem o directório de separação
  # de privilégios. Numa VPS é criado pelo serviço ssh; num container não
  # existe.
  mkdir -p /run/sshd

  # O sshd exige uma chave de host para `-T`.
  ssh-keygen -q -t ed25519 -N '' -f "${WORK}/host_ed25519" </dev/null

  cat > "${WORK}/sshd_config" <<EOF
# Réplica mínima do /etc/ssh/sshd_config da Ubuntu 24.04: o Include vem no
# TOPO, que é precisamente o que dá precedência aos drop-ins.
Include ${WORK}/sshd_config.d/*.conf

HostKey ${WORK}/host_ed25519
Port 22
PidFile ${WORK}/sshd.pid
EOF

  # Ficheiros que a imagem cloud da Ubuntu instala.
  cat > "${WORK}/sshd_config.d/50-cloud-init.conf" <<'EOF'
PasswordAuthentication yes
EOF
  cat > "${WORK}/sshd_config.d/60-cloudimg-settings.conf" <<'EOF'
PasswordAuthentication no
EOF
  chmod 600 "${WORK}/sshd_config" "${WORK}/sshd_config.d"/*.conf
}

# Ordem de leitura dos drop-ins — é ela que determina quem vence.
dropin_order() {
  find "${WORK}/sshd_config.d" -maxdepth 1 -name '*.conf' -printf '%f\n' 2>/dev/null \
    | sort | tr '\n' ' '
}

# Conteúdo do nosso drop-in, com os valores que o bootstrap escreve.
write_hardening() {
  cat > "${WORK}/sshd_config.d/$1" <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
AllowUsers deploy root
UsePAM yes
EOF
  chmod 600 "${WORK}/sshd_config.d/$1"
}

# Valor efectivo de uma directiva, como o bootstrap o lê.
effective() {
  local key=$1; shift
  sshd -T -f "${WORK}/sshd_config" "$@" 2>/dev/null \
    | awk -v k="$key" 'tolower($1)==k {print tolower($2); exit}'
}

# ═════════════════════════════════════════════════════════════════════════
# 1. Sem o nosso ficheiro: manda o 50-cloud-init.conf
# ═════════════════════════════════════════════════════════════════════════
test_baseline() {
  printf '\n1. Cloud image sem endurecimento\n'
  printf '   ordem: %s\n' "$(dropin_order)"
  assert "sshd aceita esta configuração" sshd -t -f "${WORK}/sshd_config"
  eq_ "passwordauthentication (50- vence)" "yes" "$(effective passwordauthentication)"
}

# ═════════════════════════════════════════════════════════════════════════
# 2. Com 99-: REPRODUZ a falha da VPS
# ═════════════════════════════════════════════════════════════════════════
test_99_is_inert() {
  printf '\n2. Com 99-spharmmt-hardening.conf (o que estava na VPS)\n'
  write_hardening 99-spharmmt-hardening.conf
  printf '   ordem: %s\n' "$(dropin_order)"
  assert "sshd aceita esta configuração" sshd -t -f "${WORK}/sshd_config"
  # É ESTA a falha: o ficheiro diz `no` e o sshd faz `yes`.
  eq_ "passwordauthentication continua yes (endurecimento INERTE)" \
      "yes" "$(effective passwordauthentication)"
  rm -f "${WORK}/sshd_config.d/99-spharmmt-hardening.conf"
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Com 00-: a correcção
# ═════════════════════════════════════════════════════════════════════════
test_00_wins() {
  printf '\n3. Com 00-spharmmt-hardening.conf (a correcção)\n'
  write_hardening 00-spharmmt-hardening.conf
  printf '   ordem: %s\n' "$(dropin_order)"
  assert "sshd aceita esta configuração" sshd -t -f "${WORK}/sshd_config"

  eq_ "passwordauthentication"       "no"   "$(effective passwordauthentication)"
  eq_ "kbdinteractiveauthentication" "no"   "$(effective kbdinteractiveauthentication)"
  eq_ "pubkeyauthentication"         "yes"  "$(effective pubkeyauthentication)"
  eq_ "usepam"                       "yes"  "$(effective usepam)"
  eq_ "permitemptypasswords"         "no"   "$(effective permitemptypasswords)"

  # ARMADILHA 1: o sshd -T normaliza `prohibit-password` para o sinónimo
  # legado `without-password`. Quem comparar literalmente conclui que o
  # endurecimento falhou quando está correcto.
  eq_ "permitrootlogin (normalizado pelo sshd -T)" \
      "without-password" "$(effective permitrootlogin)"

  # ARMADILHA 2: `AllowUsers deploy root` sai em DUAS linhas, uma por
  # utilizador. Um awk com `exit` na primeira só vê o primeiro nome.
  local allow
  allow=$(sshd -T -f "${WORK}/sshd_config" 2>/dev/null \
          | awk 'tolower($1)=="allowusers"{for (i=2; i<=NF; i++) printf "%s ", $i}')
  eq_ "allowusers (todas as linhas)" "deploy root " "$allow"
  assert "allowusers inclui deploy"  bash -c "case ' ${allow}' in *' deploy '*) exit 0;; *) exit 1;; esac"
  assert "allowusers inclui root"    bash -c "case ' ${allow}' in *' root '*) exit 0;; *) exit 1;; esac"
}

# ═════════════════════════════════════════════════════════════════════════
# 4. Contexto de ligação concreto (-C)
# ═════════════════════════════════════════════════════════════════════════
test_connection_context() {
  printf '\n4. Contexto de ligação (sshd -T -C)\n'
  local ctx
  ctx="user=deploy,host=$(hostname),addr=127.0.0.1"
  assert "sshd -T -C é aceite" \
    bash -c "sshd -T -f '${WORK}/sshd_config' -C '${ctx}' >/dev/null 2>&1"
  eq_ "passwordauthentication com user=deploy" \
      "no" "$(effective passwordauthentication -C "$ctx")"

  # Um bloco Match posterior pode repor a password só para certos casos —
  # é exactamente o que o `-C` apanha e o `sshd -T` simples não vê.
  cat > "${WORK}/sshd_config.d/70-match-trap.conf" <<'EOF'
Match User deploy
    PasswordAuthentication yes
Match all
EOF
  chmod 600 "${WORK}/sshd_config.d/70-match-trap.conf"
  eq_ "sshd -T simples NÃO vê o bloco Match" \
      "no" "$(effective passwordauthentication)"
  eq_ "sshd -T -C APANHA o bloco Match (por isso é obrigatório)" \
      "yes" "$(effective passwordauthentication -C "$ctx")"
  rm -f "${WORK}/sshd_config.d/70-match-trap.conf"
}

# ═════════════════════════════════════════════════════════════════════════
# 5. O que o bootstrap e o verificador fazem
# ═════════════════════════════════════════════════════════════════════════
test_scripts() {
  printf '\n5. Scripts do pacote\n'
  local bs="${SCRIPTS_DIR}/bootstrap-vps.sh" vp="${SCRIPTS_DIR}/verify-platform.sh"

  assert "bootstrap escreve o drop-in com prefixo 00-" \
    grep -q 'SSH_DROPIN=/etc/ssh/sshd_config.d/00-spharmmt-hardening.conf' "$bs"
  assert "bootstrap conhece o ficheiro antigo para o remover" \
    grep -q 'SSH_DROPIN_LEGACY=/etc/ssh/sshd_config.d/99-spharmmt-hardening.conf' "$bs"
  assert "remoção do antigo vem depois das validações" \
    bash -c "[ \$(grep -n '_ssh_effective_ok' '$bs' | head -1 | cut -d: -f1) -lt \$(grep -n 'rm -f \"\\\$SSH_DROPIN_LEGACY\"' '$bs' | head -1 | cut -d: -f1) ]"
  # Padrão de grep — não pode expandir aqui.
  # shellcheck disable=SC2016
  assert "bootstrap valida com sshd -T -C" \
    grep -q 'sshd -T -C\|_ssh_effective_ok "\$permit_root" "-C"' "$bs"
  assert "bootstrap usa reload, nunca restart do ssh" \
    bash -c "! grep -E 'systemctl restart (ssh|sshd)\b' '$bs' | grep -qv 'ssh.socket'"
  assert "verificador lê o valor efectivo (sshd -T), não o ficheiro" \
    grep -q 'PasswordAuthentication no (efectivo)' "$vp"
  assert "verificador testa também o contexto -C" \
    grep -q 'sshd -T -C' "$vp"
  # Regressões das duas armadilhas de normalização do sshd -T.
  assert "bootstrap tolera without-password" grep -q 'without-password) printf' "$bs"
  assert "bootstrap lê TODAS as linhas de allowusers" \
    grep -q 'for (i=2; i<=NF; i++)' "$bs"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: precedência dos drop-ins do sshd ===\n'
  if ! command -v sshd >/dev/null 2>&1; then
    printf '  %s✗%s sshd não instalado — o teste precisa de openssh-server\n' "$C_R" "$C_0"
    return 1
  fi
  printf '   %s\n' "$(sshd -V 2>&1 | head -1 || sshd --version 2>&1 | head -1 || true)"

  setup
  test_baseline
  test_99_is_inert
  test_00_wins
  test_connection_context
  test_scripts

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
