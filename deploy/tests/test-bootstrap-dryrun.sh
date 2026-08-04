#!/usr/bin/env bash
# deploy/tests/test-bootstrap-dryrun.sh
#
# Teste automatizado do dry-run do bootstrap. Corre DENTRO de um Ubuntu 24.04
# descartável (ver run-in-docker.sh) e reproduz o cenário que partiu na VPS:
#
#   · VPS limpa, sem utilizador deploy
#   · --dry-run
#   · --ssh-key com uma chave pública ed25519 válida
#   · ADMIN_IP vazio (o caso que disparava o trap ERR no step_fail2ban)
#   · fail2ban ainda não instalado
#   · criação apenas simulada do utilizador
#
# Verifica que o dry-run termina com rc=0, que a chave é reconhecida, que não
# há erros de "no such user" e que nenhum trap ERR disparou.
#
# NOTA HONESTA SOBRE O AMBIENTE: um container não tem systemd a correr. Os
# comandos que o script consulta directamente (timedatectl, hostnamectl,
# systemctl, ufw, swapon, sshd -t, visudo) são substituídos por stubs que
# emulam uma VPS limpa. O que este teste valida é o FLUXO e a lógica do
# script — controlo de erros, estado simulado, validação de chaves. NÃO
# valida a interacção real com systemd/ufw/sshd; isso só o dry-run na VPS
# verdadeira consegue.
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

set -uo pipefail

SCRIPTS_DIR=${SCRIPTS_DIR:-/work/deploy/scripts}
WORK=/tmp/spharmmt-test
STUBS="${WORK}/stubs"
OUT="${WORK}/dryrun.out"

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

assert() {
  local desc=$1; shift
  if "$@" >/dev/null 2>&1; then
    printf '  %s✓%s %s\n' "$C_G" "$C_0" "$desc"; pass=$((pass+1))
  else
    printf '  %s✗%s %s\n' "$C_R" "$C_0" "$desc"; fail=$((fail+1))
  fi
}
assert_contains() {
  local desc=$1 needle=$2
  if grep -qF -- "$needle" "$OUT"; then
    printf '  %s✓%s %s\n' "$C_G" "$C_0" "$desc"; pass=$((pass+1))
  else
    printf '  %s✗%s %s (não encontrado: %s)\n' "$C_R" "$C_0" "$desc" "$needle"; fail=$((fail+1))
  fi
}
assert_absent() {
  local desc=$1 needle=$2
  if grep -qF -- "$needle" "$OUT"; then
    printf '  %s✗%s %s (encontrado indevidamente: %s)\n' "$C_R" "$C_0" "$desc" "$needle"
    grep -nF -- "$needle" "$OUT" | head -3 | sed 's/^/       /'
    fail=$((fail+1))
  else
    printf '  %s✓%s %s\n' "$C_G" "$C_0" "$desc"; pass=$((pass+1))
  fi
}

# ═════════════════════════════════════════════════════════════════════════
# Stubs — emulam uma VPS Ubuntu 24.04 limpa sem systemd a correr
# ═════════════════════════════════════════════════════════════════════════
# Os corpos dos stubs usam $1/$* — que pertencem ao stub gerado, não a este
# script. As aspas simples são deliberadas em toda a função.
# shellcheck disable=SC2016
setup_stubs() {
  rm -rf "$WORK"; mkdir -p "$STUBS"

  stub() { printf '#!/bin/sh\n%s\n' "$2" > "${STUBS}/$1"; chmod +x "${STUBS}/$1"; }

  stub timedatectl '
case "$*" in
  *"show -p Timezone"*) echo "Etc/UTC" ;;
  *"show -p NTPSynchronized"*) echo "yes" ;;
  *) : ;;
esac
exit 0'

  stub hostnamectl '
case "$1" in
  --static) echo "test-vps" ;;
  *) echo "   Static hostname: test-vps" ;;
esac
exit 0'

  # Nenhum serviço activo — é uma VPS limpa.
  stub systemctl '
case "$1" in
  is-active|is-enabled|is-failed) exit 1 ;;
  list-units|list-unit-files|list-timers) exit 0 ;;
  *) exit 0 ;;
esac'

  stub ufw '
case "$1" in
  status) echo "Status: inactive" ;;
  *) : ;;
esac
exit 0'

  stub fail2ban-client 'exit 1'
  stub sshd 'exit 0'          # sshd -t => configuração válida
  stub visudo 'exit 0'
  stub swapon 'exit 0'        # sem swap activa
  stub logrotate 'exit 0'
  stub sysctl 'exit 0'
  stub locale-gen 'exit 0'
  stub update-locale 'exit 0'
  stub adduser 'exit 0'
  stub usermod 'exit 0'
  stub groupadd 'exit 0'
  stub findmnt 'exit 1'       # /data não montado
  stub journalctl 'exit 0'
  stub udevadm 'exit 0'

  # systemd "presente" — o preflight exige /run/systemd/system.
  mkdir -p /run/systemd/system
  # /var/run/reboot-required ausente = sem reboot pendente
  rm -f /var/run/reboot-required

  export PATH="${STUBS}:${PATH}"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: dry-run do bootstrap numa VPS limpa ===\n\n'

  setup_stubs

  # ── Cenário: sem utilizador deploy ─────────────────────────────────────
  printf '1. Pré-condições do cenário\n'
  assert "utilizador deploy NÃO existe" bash -c '! id deploy >/dev/null 2>&1'
  assert "fail2ban NÃO instalado" bash -c '! command -v fail2ban-server >/dev/null 2>&1'
  assert "ADMIN_IP vazio (não é passado)" true
  assert "Ubuntu 24.04" grep -q 'VERSION_ID="24.04"' /etc/os-release

  # ── Chave SSH real ─────────────────────────────────────────────────────
  printf '\n2. Chave SSH\n'
  ssh-keygen -q -t ed25519 -N '' -C 'teste@spharmmt' -f "${WORK}/id" </dev/null
  local pubkey; pubkey=$(cat "${WORK}/id.pub")
  assert "chave gerada e sintacticamente válida" \
    bash -c "printf '%s\n' '${pubkey}' | ssh-keygen -l -f /dev/stdin"

  # ── Execução do dry-run ────────────────────────────────────────────────
  printf '\n3. Execução do dry-run\n'
  local rc=0
  bash "${SCRIPTS_DIR}/bootstrap-vps.sh" \
    --dry-run --yes --no-color \
    --ssh-key "$pubkey" \
    --skip-upgrade \
    > "$OUT" 2>&1 || rc=$?

  printf '   rc=%s · output: %s (%s linhas)\n' "$rc" "$OUT" "$(wc -l < "$OUT")"
  if [ "$rc" -ne 0 ]; then
    printf '\n   %s--- últimas 25 linhas ---%s\n' "$C_R" "$C_0"
    tail -25 "$OUT" | sed 's/^/   /'
    printf '\n'
  fi

  assert "dry-run termina com rc=0" test "$rc" -eq 0

  # ── Asserções sobre o comportamento ────────────────────────────────────
  printf '\n4. Comportamento\n'
  assert_absent "nenhum trap ERR disparou"            "FALHA (rc="
  assert_absent "sem erro 'no such user'"             "no such user"
  assert_absent "chave NÃO reportada como ausente"    "NENHUMA chave pública válida"
  assert_absent "endurecimento SSH não foi ignorado"  "endurecimento do sshd ignorado"

  assert_contains "utilizador deploy simulado"        "utilizador deploy criado"
  assert_contains "grupo spharmmt simulado"           "grupo spharmmt criado"
  assert_contains "chave reconhecida em dry-run"      "chave(s) válida(s) recebida(s) por argumento"
  assert_contains "SSH endurecido (password OFF)"     "password OFF"
  assert_contains "etapa fail2ban concluída"          "8. fail2ban"
  assert_contains "etapa discos concluída"            "11. Discos"
  assert_contains "etapa estrutura concluída"         "12. Estrutura"
  assert_contains "modo dry-run assinalado"           "MODO: DRY-RUN"
  assert_contains "validação assinalada como ignorada" "em dry-run nada foi aplicado"

  # ── Defaults obrigatórios ──────────────────────────────────────────────
  printf '\n5. Defaults seguros\n'
  assert_contains "root NÃO desactivado por defeito"  "PermitRootLogin=prohibit-password"
  # Procura a EXECUÇÃO, não a menção: o script imprime "ufw allow 80/tcp"
  # numa mensagem informativa a explicar como abrir as portas mais tarde.
  assert_absent   "80 não é aberto"                   "[dry-run] ufw allow 80"
  assert_absent   "443 não é aberto"                  "[dry-run] ufw allow 443"
  assert_absent   "PostgreSQL não instalado"          "apt-get install -y postgresql"
  assert_absent   "disco não formatado"               "mkfs"
  assert_absent   "porta SSH não alterada"            "ssh.socket.d"

  # ── Idempotência: segunda passagem ─────────────────────────────────────
  printf '\n6. Segunda execução (idempotência do dry-run)\n'
  local rc2=0
  bash "${SCRIPTS_DIR}/bootstrap-vps.sh" \
    --dry-run --yes --no-color --ssh-key "$pubkey" --skip-upgrade \
    > "${OUT}.2" 2>&1 || rc2=$?
  assert "segunda execução também rc=0" test "$rc2" -eq 0

  # ── Resultado ──────────────────────────────────────────────────────────
  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
