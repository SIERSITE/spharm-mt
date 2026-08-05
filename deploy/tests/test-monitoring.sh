#!/usr/bin/env bash
# deploy/tests/test-monitoring.sh
#
# Duas anomalias reais, investigadas em separado.
#
# A) healthcheck: "CRIT UFW INACTIVA" pela unit systemd, "UFW activa, crit=0"
#    quando corrido à mão com sudo.
#
#    `ufw status` EXIGE root. A unit corre como `deploy`, o comando falha com
#    rc=1 e stderr "You need to be root to run this script" e NÃO escreve
#    nada no stdout. O código era:
#        ufw status 2>/dev/null | grep -q '^Status: active' || say CRIT "UFW INACTIVA"
#    — descartava o stderr, ignorava o rc, e concluía que a firewall estava
#    desligada. Não era PATH nem User=root: era a sonda a afirmar um estado
#    que não conseguiu ler.
#
# B) verify-platform.sh --section monitoring executava ZERO checks e
#    declarava sucesso. A secção chama-se `monitorizacao`; um nome que não
#    corresponde a nada era aceite em silêncio.
#
# Contrato de saída verificado: 0 saudável · 1 warning (aceite pelo systemd
# via SuccessExitStatus=0 1) · 2 crítico.
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

set -uo pipefail

SCRIPTS_DIR=${SCRIPTS_DIR:-/work/deploy/scripts}
WORK=/tmp/spharmmt-montest

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok_ "$d"; else bad_ "$d"; fi; }
refute(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then bad_ "$d"; else ok_ "$d"; fi; }
eq_()   { if [ "$2" = "$3" ]; then ok_ "$1 → ${3}"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi; }

setup() {
  rm -rf "$WORK"; mkdir -p "${WORK}/bin"
  getent group spharmmt >/dev/null 2>&1 || groupadd spharmmt
  id deploy >/dev/null 2>&1 || useradd -M -g spharmmt deploy
}

# ═════════════════════════════════════════════════════════════════════════
# A1. A reprodução: como é que o `ufw status` falha
# ═════════════════════════════════════════════════════════════════════════
test_ufw_reproduction() {
  printf '\nA1. Comportamento real do comando ufw status\n'
  if ! command -v ufw >/dev/null 2>&1; then
    bad_ "ufw não instalado na imagem de teste"; return
  fi

  local out rc err
  err=$(mktemp)
  out=$(runuser -u deploy -- ufw status 2>"$err") && rc=0 || rc=$?
  eq_ "como deploy: rc != 0"        "1" "$rc"
  eq_ "como deploy: stdout vazio"   ""  "$out"
  assert "como deploy: stderr explica que precisa de root" \
    grep -qi 'root' "$err"
  rm -f "$err"

  # É ESTA a inferência errada da versão antiga.
  local antigo=OK
  runuser -u deploy -- ufw status 2>/dev/null | grep -q '^Status: active' || antigo=CRIT
  eq_ "lógica antiga concluía (erradamente)" "CRIT" "$antigo"
}

# ═════════════════════════════════════════════════════════════════════════
# A2. A nova check_firewall, nos três cenários
# ═════════════════════════════════════════════════════════════════════════
load_firewall_check() {
  # Extrai só a função do healthcheck, sem correr o resto.
  say() { printf '%s %s\n' "$1" "$2"; }
  eval "$(sed -n '/^check_firewall() {/,/^}/p' "${SCRIPTS_DIR}/healthcheck.sh")"
}

test_firewall_states() {
  printf '\nA2. check_firewall com privilégios insuficientes\n'
  load_firewall_check
  mkdir -p "${WORK}/etc/ufw"

  # Stub de ufw que reproduz a falha por falta de privilégios.
  printf '#!/bin/sh\necho "ERROR: You need to be root to run this script" >&2\nexit 1\n' \
    > "${WORK}/bin/ufw"
  chmod +x "${WORK}/bin/ufw"

  # UFW_CONF aponta para um ficheiro de teste — a configuração real do
  # sistema não é tocada.
  local conf="${WORK}/etc/ufw/ufw.conf"
  run_check() {
    PATH="${WORK}/bin:$PATH" UFW_CONF="$conf" bash -c "
      $(declare -f say)
      $(declare -f check_firewall)
      check_firewall" 2>&1 || true
  }

  # ── ENABLED=yes + serviço activo → OK, nunca CRIT ────────────────────
  printf 'ENABLED=yes\n' > "$conf"
  printf '#!/bin/sh\ncase "$*" in *is-active*ufw*) exit 0;; esac\nexit 1\n' \
    > "${WORK}/bin/systemctl"
  chmod +x "${WORK}/bin/systemctl"
  local out; out=$(run_check)
  case "$out" in
    OK*) ok_ "sem privilégios mas com sinais positivos → OK" ;;
    *) bad_ "esperado OK pelos sinais alternativos, obtido: ${out}" ;;
  esac
  refute "não afirma 'INACTIVA' sem conseguir ler o estado" \
    bash -c "printf '%s' \"\$1\" | grep -q 'INACTIVA'" _ "$out"

  # ── Estado indeterminado (serviço não activo, ENABLED ausente) → WARN ─
  printf '#!/bin/sh\nexit 1\n' > "${WORK}/bin/systemctl"; chmod +x "${WORK}/bin/systemctl"
  printf '# sem ENABLED\n' > "$conf"
  out=$(run_check)
  case "$out" in
    CRIT*) bad_ "estado indeterminado reportado como CRIT: ${out}" ;;
    WARN*) ok_ "estado indeterminado → WARN (rc=1, não CRIT)" ;;
    *) bad_ "saída inesperada: ${out}" ;;
  esac
  assert "a mensagem inclui o rc do ufw" \
    bash -c "printf '%s' \"\$1\" | grep -q 'rc=1'" _ "$out"

  # ── ENABLED=no → CRIT legítimo (está mesmo desligada) ────────────────
  printf 'ENABLED=no\n' > "$conf"
  out=$(run_check)
  case "$out" in
    CRIT*ENABLED=no*) ok_ "ENABLED=no → CRIT (correcto, está mesmo desligada)" ;;
    *) bad_ "ENABLED=no não deu CRIT: ${out}" ;;
  esac

  # ── ufw responde e diz que está mesmo inactiva → CRIT legítimo ───────
  printf '#!/bin/sh\necho "Status: inactive"\nexit 0\n' > "${WORK}/bin/ufw"
  chmod +x "${WORK}/bin/ufw"
  out=$(PATH="${WORK}/bin:$PATH" bash -c "
    $(declare -f say)
    $(declare -f check_firewall)
    check_firewall" 2>&1 || true)
  case "$out" in
    CRIT*INACTIVA*) ok_ "firewall mesmo desligada → CRIT (correcto)" ;;
    *) bad_ "firewall desligada não deu CRIT: ${out}" ;;
  esac

  # ── ufw responde activa, em português (locale traduzido) ─────────────
  printf '#!/bin/sh\necho "Estado: activo"\nexit 0\n' > "${WORK}/bin/ufw"
  chmod +x "${WORK}/bin/ufw"
  out=$(PATH="${WORK}/bin:$PATH" bash -c "
    $(declare -f say)
    $(declare -f check_firewall)
    check_firewall" 2>&1 || true)
  case "$out" in
    OK*) ok_ "aceita output traduzido ('Estado: activo')" ;;
    *) bad_ "output traduzido não reconhecido: ${out}" ;;
  esac
}

# ═════════════════════════════════════════════════════════════════════════
# A3. O healthcheck completo no ambiente da unit systemd
# ═════════════════════════════════════════════════════════════════════════
test_healthcheck_as_unit() {
  printf '\nA3. healthcheck no ambiente da unit (User=deploy, env limpo)\n'
  local hc="${SCRIPTS_DIR}/healthcheck.sh" out rc

  # `env -i` + o PATH que o systemd usa por omissão = o ambiente da unit.
  out=$(runuser -u deploy -- env -i \
          PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
          bash "$hc" 2>&1) && rc=0 || rc=$?

  # A mesma sonda como root, para comparação.
  local out_root
  out_root=$(env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
               bash "$hc" 2>&1) || true

  local crit_deploy crit_root
  crit_deploy=$(printf '%s\n' "$out" | grep -c '^CRIT' || true)
  crit_root=$(printf '%s\n' "$out_root" | grep -c '^CRIT' || true)

  printf '   rc=%s · CRIT como deploy=%s · CRIT como root=%s\n' "$rc" "$crit_deploy" "$crit_root"

  refute "não reporta 'UFW INACTIVA' por falta de privilégios" \
    bash -c "printf '%s' \"\$1\" | grep -q 'UFW INACTIVA'" _ "$out"
  assert "contrato de saída respeitado (rc <= 2)" test "$rc" -le 2

  # A pergunta é se a FALTA DE PRIVILÉGIOS acrescenta CRITs — não se o
  # ambiente tem algum. Comparar com `rc != 2` amarrava o teste ao estado
  # do host: um disco a 90% (limite de CRIT) fazia-o falhar por uma razão
  # que nada tem que ver com privilégios, e passava só enquanto a máquina
  # de quem o corre estivesse folgada.
  assert "sem privilégios NÃO acrescenta CRITs (${crit_deploy} <= ${crit_root})" \
    test "$crit_deploy" -le "$crit_root"
  assert "produz linhas de estado"      bash -c "printf '%s' \"\$1\" | grep -qE '^(OK|WARN|CRIT)' " _ "$out"
  assert "termina com o resumo"         bash -c "printf '%s' \"\$1\" | grep -q 'resultado: rc='" _ "$out"
}

# ═════════════════════════════════════════════════════════════════════════
# B. verify-platform --section
# ═════════════════════════════════════════════════════════════════════════
test_section_handling() {
  printf '\nB. verify-platform.sh --section\n'
  local vp="${SCRIPTS_DIR}/verify-platform.sh" out rc

  # O caso reportado: nome em inglês, zero checks, sucesso.
  out=$(bash "$vp" --no-color --section monitoring 2>&1) && rc=0 || rc=$?
  assert "--section monitoring executa verificações" \
    bash -c "printf '%s' \"\$1\" | grep -q 'Monitoriza'" _ "$out"
  refute "--section monitoring NÃO diz 'nenhuma verificação'" \
    bash -c "printf '%s' \"\$1\" | grep -q 'NENHUMA verificação'" _ "$out"
  assert "--section monitorizacao (nome canónico) também funciona" \
    bash -c "bash '$vp' --no-color --section monitorizacao 2>&1 | grep -q 'Monitoriza'"

  # Nome inválido → erro de uso, nunca sucesso silencioso.
  rc=0; out=$(bash "$vp" --no-color --section naoexiste 2>&1) || rc=$?
  eq_ "--section inválida devolve rc=4 (uso incorrecto)" "4" "$rc"
  assert "--section inválida lista as secções válidas" \
    bash -c "printf '%s' \"\$1\" | grep -q 'secções válidas'" _ "$out"

  # Outros aliases em inglês.
  local s
  for s in security secrets resources system; do
    assert "alias '${s}' é aceite" \
      bash -c "bash '$vp' --no-color --section '$s' >/dev/null 2>&1; [ \$? -ne 4 ]"
  done

  # E a garantia de fundo: zero verificações nunca é sucesso.
  out=$(bash -c "
    . '${SCRIPTS_DIR}/lib/common.sh'
    log_init
    report 'Teste sem checks'" 2>&1) && rc=0 || rc=$?
  eq_ "report() com zero checks devolve rc=3" "3" "$rc"
  assert "report() com zero checks explica porquê" \
    bash -c "printf '%s' \"\$1\" | grep -q 'NENHUMA verificação'" _ "$out"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: monitorização (UFW sob systemd + --section) ===\n'
  [ "$(id -u)" -eq 0 ] || { printf '  precisa de root\n'; return 1; }
  setup
  test_ufw_reproduction
  test_firewall_states
  test_healthcheck_as_unit
  test_section_handling

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
