#!/usr/bin/env bash
# deploy/tests/test-swap-fstab.sh
#
# Teste de regressão para a falha real na VPS Ubuntu 24.04:
#
#   findmnt: unrecognized option '--quiet'
#   /etc/fstab ficou inválido — a reverter a entrada de swap
#
# `findmnt` não tem opção `--quiet` em versão nenhuma do util-linux. A
# validação do fstab falhava SEMPRE, o rollback disparava SEMPRE, e a VPS
# ficava com swap activa mas não persistente.
#
# Cobre:
#   · o util-linux desta imagem rejeita mesmo `findmnt --quiet` (reprodução)
#   · nenhum script do pacote volta a usar essa opção
#   · swap inexistente → criada, activada e persistida sem duplicar
#   · falha na validação do fstab → rollback só da linha escrita
#   · segunda execução idempotente (nem duplica, nem recria)
#   · swap activa sem entrada no fstab → reparada (o estado deixado pelo bug)
#
# Corre em Ubuntu 24.04 (ver run-in-docker.sh). Não activa swap a sério:
# `swapon` num container é bloqueado pelo kernel. O que se exercita é a
# lógica de decisão e a manipulação do fstab, com fallocate/mkswap/swapon/
# blkid substituídos por stubs e FSTAB_FILE/SWAP_FILE apontados para /tmp.
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

set -uo pipefail

SCRIPTS_DIR=${SCRIPTS_DIR:-/work/deploy/scripts}
WORK=/tmp/spharmmt-swaptest
STUBS="${WORK}/stubs"

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok_ "$d"; else bad_ "$d"; fi; }
refute(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then bad_ "$d"; else ok_ "$d"; fi; }

# Nº de linhas de swap para SWAP_FILE no fstab de teste.
# `grep -c` já imprime 0 quando não há match — e sai com 1. Um `|| echo 0`
# acrescentaria um SEGUNDO zero e o `test -eq` rebentava com "integer
# expression expected".
swap_lines() {
  local n
  n=$(grep -cE "^[[:space:]]*${SWAP_FILE}[[:space:]]" "$FSTAB_FILE" 2>/dev/null) || n=0
  printf '%s' "${n:-0}"
}

# ═════════════════════════════════════════════════════════════════════════
# 1. Reprodução: o util-linux real rejeita --quiet
# ═════════════════════════════════════════════════════════════════════════
test_findmnt_option() {
  printf '\n1. Compatibilidade do findmnt (util-linux desta imagem)\n'
  printf '   versão: %s\n' "$(findmnt --version 2>&1 | head -1)"

  refute "findmnt --verify --quiet é REJEITADO (reproduz a falha da VPS)" \
    findmnt --verify --quiet
  assert "findmnt --verify (sem --quiet) é aceite" \
    bash -c 'findmnt --verify >/dev/null 2>&1; [ $? -le 1 ]'
  assert "findmnt --verify --tab-file <f> é aceite" \
    bash -c 'printf "" > /tmp/empty.fstab; findmnt --verify --tab-file /tmp/empty.fstab >/dev/null 2>&1; [ $? -le 1 ]'
}

# ═════════════════════════════════════════════════════════════════════════
# 2. Auditoria: a opção não pode voltar ao código
# ═════════════════════════════════════════════════════════════════════════
test_no_bad_options() {
  printf '\n2. Auditoria dos scripts\n'
  # Só linhas de código — comentários que expliquem o bug são legítimos.
  refute "nenhum script invoca 'findmnt ... --quiet'" \
    bash -c "grep -rn 'findmnt' '${SCRIPTS_DIR}' | grep -v '^[^:]*:[0-9]*: *#' | grep -q -- '--quiet'"
  refute "nenhum script invoca 'swapon --quiet'" \
    bash -c "grep -rn 'swapon .*--quiet' '${SCRIPTS_DIR}' | grep -q ."

  # Opções que este pacote assume existirem no util-linux/coreutils do alvo.
  printf '   opções assumidas, verificadas contra os binários reais:\n'
  assert "swapon --show=NAME --noheadings"  bash -c 'swapon --show=NAME --noheadings >/dev/null 2>&1'
  assert "lsblk -dno NAME --nodeps"         bash -c 'lsblk -dno NAME --nodeps >/dev/null 2>&1'
  assert "findmnt -rno TARGET /"            bash -c 'findmnt -rno TARGET / >/dev/null 2>&1'
  # $( ) tem de expandir dentro do bash -c, não aqui.
  # shellcheck disable=SC2016
  assert "numfmt --from=iec / --to=iec"     bash -c '[ "$(numfmt --from=iec 4G)" = 4294967296 ] && numfmt --to=iec 4294967296 >/dev/null'
  assert "sha256sum -c --quiet"             bash -c 'cd /tmp && echo x > s.txt && sha256sum s.txt > s.sha && sha256sum -c --quiet s.sha'
  assert "find -printf"                     bash -c 'find /tmp -maxdepth 0 -printf "%T@\n" >/dev/null'
  assert "stat -c %a"                       bash -c 'stat -c "%a" /tmp >/dev/null'
  assert "blkid -o value -s TYPE"           bash -c 'blkid -o value -s TYPE /dev/null >/dev/null 2>&1 || true'
}

# ═════════════════════════════════════════════════════════════════════════
# Ambiente: carrega só a lógica de swap do bootstrap, sem correr o main
# ═════════════════════════════════════════════════════════════════════════
load_swap_logic() {
  rm -rf "$WORK"; mkdir -p "$STUBS"

  # Stubs mínimos. `mkswap`, `chmod` e `blkid` ficam REAIS: o findmnt
  # --verify inspecciona mesmo o ficheiro de swap, e um stub que não cria
  # nada faria a validação reprovar — com razão — mascarando o que se testa.
  #
  # fallocate: cria um ficheiro pequeno em vez dos GB pedidos.
  # $3 é o argumento do stub gerado, não deste script.
  # shellcheck disable=SC2016
  printf '#!/bin/sh\ntruncate -s 8M "$3"\n' > "${STUBS}/fallocate"
  # swapon: o kernel bloqueia swapon dentro de um container.
  printf '#!/bin/sh\nexit 0\n' > "${STUBS}/swapon"
  chmod +x "${STUBS}/fallocate" "${STUBS}/swapon"
  export PATH="${STUBS}:${PATH}"

  export FSTAB_FILE="${WORK}/fstab"
  export SWAP_FILE="${WORK}/swapfile"
  export DRY_RUN=0 ASSUME_YES=1 NO_COLOR=1 SWAP_SIZE=4G

  # shellcheck disable=SC1091
  . "${SCRIPTS_DIR}/lib/common.sh"
  log_init
  # Extrai as três funções de swap do bootstrap sem executar o resto.
  # As gamas de sed são delimitadas por `^}`, portanto cada função TEM de
  # ser multi-linha; com um one-liner a gama estende-se até ao `}` seguinte,
  # sobrepõe-se à gama da função a seguir e o eval recebe linhas duplicadas.
  # Esta verificação torna essa falha visível em vez de silenciosa.
  local extracted
  extracted=$(sed -n '/^fstab_is_valid() {/,/^}/p;/^ensure_swap_fstab_entry() {/,/^}/p;/^setup_swap() {/,/^}/p' \
                "${SCRIPTS_DIR}/bootstrap-vps.sh")
  if printf '%s\n' "$extracted" | sort | uniq -d | grep -q '() {$'; then
    printf '  %s✗%s extracção das funções de swap saiu duplicada (gamas de sed sobrepostas)\n' "$C_R" "$C_0"
    fail=$((fail+1))
  fi
  eval "$extracted"
}

# fstab limpo — `findmnt --verify` aceita-o sem reservas. NÃO usar UUIDs
# inventados: o findmnt sinaliza-os como problema e o baseline deixaria de
# ser "limpo", mascarando o que se quer testar.
fresh_fstab() {
  cat > "$FSTAB_FILE" <<'EOF'
# /etc/fstab de teste
EOF
  rm -f "$SWAP_FILE"
}

# fstab com um problema PRÉ-EXISTENTE (dispositivo inexistente).
dirty_fstab() {
  cat > "$FSTAB_FILE" <<'EOF'
# /etc/fstab de teste com problema anterior
UUID=deadbeef-0000-0000-0000-000000000000 /nao-existe ext4 defaults 0 2
EOF
  rm -f "$SWAP_FILE"
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Swap inexistente → criada e persistida
# ═════════════════════════════════════════════════════════════════════════
test_create_swap() {
  printf '\n3. Swap inexistente\n'
  fresh_fstab
  # Sem swap activa: o stub `swapon --show` devolve vazio (exit 0, sem saída).
  local rc=0
  setup_swap >/dev/null 2>&1 || rc=$?
  assert "setup_swap termina com 0"          test "$rc" -eq 0
  assert "entrada de swap escrita no fstab"  test "$(swap_lines)" -eq 1
  assert "fstab continua válido"             fstab_is_valid
  assert "entrada bem formada"               grep -qE "^${SWAP_FILE} none swap sw 0 0$" "$FSTAB_FILE"
  assert "comentário original preservado"    grep -q '^# /etc/fstab de teste' "$FSTAB_FILE"
  assert "swapfile existe e é área de swap"  bash -c "[ \"\$(blkid -o value -s TYPE '${SWAP_FILE}')\" = swap ]"
}

# ═════════════════════════════════════════════════════════════════════════
# 4. Segunda execução: idempotente
# ═════════════════════════════════════════════════════════════════════════
test_idempotent() {
  printf '\n4. Segunda execução\n'
  local before after rc=0
  before=$(sha256sum "$FSTAB_FILE" | cut -d' ' -f1)
  ensure_swap_fstab_entry >/dev/null 2>&1 || rc=$?
  after=$(sha256sum "$FSTAB_FILE" | cut -d' ' -f1)
  assert "termina com 0"                     test "$rc" -eq 0
  assert "fstab inalterado"                  test "$before" = "$after"
  assert "sem entradas duplicadas"           test "$(swap_lines)" -eq 1
}

# ═════════════════════════════════════════════════════════════════════════
# 5. Falha na validação → rollback só da linha escrita
# ═════════════════════════════════════════════════════════════════════════
test_rollback() {
  printf '\n5. Falha na validação do fstab\n'
  fresh_fstab
  local original; original=$(cat "$FSTAB_FILE")

  # Cenário: o ficheiro estava BOM e a nossa linha partiu-o.
  #
  # Não basta fazer fstab_is_valid falhar sempre: isso significaria "o
  # ficheiro já estava mau", e nesse caso a lógica mantém a entrada de
  # propósito (ver caso 8). Só a verificação IMEDIATAMENTE a seguir à
  # escrita é que falha:
  #   1ª chamada = baseline  → válido
  #   2ª chamada = pós-escrita → inválido  (dispara o rollback)
  #   3ª chamada = pós-rollback → válido   (confirma a recuperação)
  # shellcheck disable=SC2329
  _fiv_calls=0
  # shellcheck disable=SC2329
  fstab_is_valid() {
    _fiv_calls=$((_fiv_calls + 1))
    [ "$_fiv_calls" -ne 2 ]
  }
  local rc=0
  ensure_swap_fstab_entry >/dev/null 2>&1 || rc=$?

  # Repõe a validação real para inspeccionar o resultado.
  unset -f fstab_is_valid
  eval "$(sed -n '/^fstab_is_valid() {/,/^}/p' "${SCRIPTS_DIR}/bootstrap-vps.sh")"

  assert "não aborta o bootstrap (rc=0, sistema consistente)" test "$rc" -eq 0
  assert "entrada de swap revertida"          test "$(swap_lines)" -eq 0
  assert "fstab restaurado ao original"       test "$(cat "$FSTAB_FILE")" = "$original"
  assert "fstab válido depois do rollback"    fstab_is_valid
  assert "backup do fstab foi criado"         bash -c "ls ${FSTAB_FILE}.spharmmt-bak-* >/dev/null 2>&1"
}

# ═════════════════════════════════════════════════════════════════════════
# 6. Nova execução após a falha: sucesso
# ═════════════════════════════════════════════════════════════════════════
test_recovery() {
  printf '\n6. Nova execução após a falha\n'
  local rc=0
  ensure_swap_fstab_entry >/dev/null 2>&1 || rc=$?
  assert "termina com 0"                      test "$rc" -eq 0
  assert "entrada de swap reposta"            test "$(swap_lines)" -eq 1
  assert "sem duplicados"                     test "$(swap_lines)" -eq 1
  assert "fstab válido"                       fstab_is_valid
}

# ═════════════════════════════════════════════════════════════════════════
# 7. Swap activa sem fstab — o estado deixado pelo bug na VPS
# ═════════════════════════════════════════════════════════════════════════
test_repair_active_without_fstab() {
  printf '\n7. Reparação: swap activa mas não persistente\n'
  fresh_fstab
  # `swapon --show=NAME --noheadings` passa a devolver o nosso swapfile,
  # reproduzindo a VPS depois da falha: swap ligada, fstab sem entrada.
  # $1 pertence ao stub gerado, não a este script — aspas simples deliberadas.
  # shellcheck disable=SC2016
  printf '#!/bin/sh\nif [ "$1" = "--show=NAME" ]; then echo "%s"; fi\nexit 0\n' \
    "$SWAP_FILE" > "${STUBS}/swapon"
  chmod +x "${STUBS}/swapon"

  assert "cenário: fstab sem entrada de swap" test "$(swap_lines)" -eq 0
  local rc=0
  setup_swap >/dev/null 2>&1 || rc=$?
  assert "setup_swap termina com 0"           test "$rc" -eq 0
  assert "persistência REPARADA no fstab"     test "$(swap_lines)" -eq 1
  assert "fstab válido"                       fstab_is_valid

  printf '#!/bin/sh\nexit 0\n' > "${STUBS}/swapon"; chmod +x "${STUBS}/swapon"
}

# ═════════════════════════════════════════════════════════════════════════
# 8. Problema pré-existente no fstab → a nossa entrada NÃO é revertida
# ═════════════════════════════════════════════════════════════════════════
test_preexisting_problem() {
  printf '\n8. fstab com problema anterior à nossa alteração\n'
  dirty_fstab
  refute "cenário: findmnt já reprova este fstab" fstab_is_valid

  local rc=0
  ensure_swap_fstab_entry >/dev/null 2>&1 || rc=$?
  assert "termina com 0 (não aborta o bootstrap)" test "$rc" -eq 0
  # O ponto do teste: um aviso alheio não pode fazer reverter uma linha
  # correcta nossa — foi essa confusão que causou a falha original.
  assert "entrada de swap MANTIDA"                test "$(swap_lines)" -eq 1
  assert "linha problemática preservada intacta"  grep -q '^UUID=deadbeef' "$FSTAB_FILE"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: swap e /etc/fstab (regressão findmnt --quiet) ===\n'
  test_findmnt_option
  test_no_bad_options
  load_swap_logic
  test_create_swap
  test_idempotent
  test_rollback
  test_recovery
  test_repair_active_without_fstab
  test_preexisting_problem

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
