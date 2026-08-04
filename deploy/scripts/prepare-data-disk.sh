#!/usr/bin/env bash
# deploy/scripts/prepare-data-disk.sh
#
# Detecção e preparação de um disco dedicado aos dados.
#
# ESTE É O ÚNICO SCRIPT DO PACOTE QUE PODE DESTRUIR DADOS DE FORMA
# IRREVERSÍVEL. Formatar o disco errado numa VPS é indistinguível de perder
# o servidor. Por isso:
#
#   · SEM ARGUMENTOS, é apenas um relatório read-only. Não toca em nada.
#   · Nunca escolhe um disco sozinho — o dispositivo é sempre explícito.
#   · Recusa qualquer disco que tenha partições, filesystem, assinatura de
#     LVM/RAID/swap, que esteja montado, que tenha holders, ou que contenha
#     a raiz do sistema.
#   · Exige confirmação escrevendo o caminho exacto do dispositivo. A flag
#     --yes NÃO chega para formatar: é precisa também --confirm-erase, para
#     que nenhuma automação apague um disco por arrastamento.
#   · É idempotente: se o disco já estiver preparado e montado, limita-se a
#     garantir os subdirectórios e a reportar.
#
# Fases da preparação (só com --device):
#   1. detecção e validação exaustiva do dispositivo
#   2. tabela de partições GPT
#   3. uma única partição, a ocupar o disco todo
#   4. ext4 com label spharmmt-data
#   5. montagem em /data
#   6. entrada persistente em /etc/fstab, por UUID (nunca por /dev/sdX,
#      que muda de nome entre arranques)
#   7. validação do mount e da persistência
#   8. criação de /data/postgres, /data/docker, /data/backups
#
# Uso:
#   sudo ./prepare-data-disk.sh                          # relatório, não altera nada
#   sudo ./prepare-data-disk.sh --device /dev/sdb        # prepara (pergunta)
#   sudo ./prepare-data-disk.sh --device /dev/sdb --yes --confirm-erase
#
# Saída: 0 ok · 1 falha · 2 pré-condição · 3 pós-condição · 4 uso · 5 lock
#        · 6 abortado

set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

DEVICE=""
MOUNT_POINT="/data"
FS_LABEL="spharmmt-data"
CONFIRM_ERASE=0
REPORT_ONLY=1

usage() {
  cat <<EOF
Uso: sudo $0 [opções]

  (sem opções)          Relatório dos discos. NÃO altera nada.
  --device <dev>        Disco a preparar (ex.: /dev/sdb). APAGA TUDO no disco.
  --mount <path>        Ponto de montagem (default: ${MOUNT_POINT})
  --label <nome>        Label do filesystem (default: ${FS_LABEL})
  --confirm-erase       Obrigatório, em conjunto com --yes, para formatar sem
                        confirmação interactiva. Existe para que --yes sozinho
                        nunca chegue para apagar um disco.
$(common_flags_help)

O disco só é preparado se estiver COMPLETAMENTE vazio: sem partições, sem
filesystem, sem LVM/RAID/swap, não montado e sem holders. Qualquer sinal de
conteúdo aborta a operação — este script não sabe se o que lá está é lixo ou
o backup de alguém.
EOF
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --device) DEVICE=${2:?}; REPORT_ONLY=0; shift 2 ;;
    --mount) MOUNT_POINT=${2:?}; shift 2 ;;
    --label) FS_LABEL=${2:?}; shift 2 ;;
    --confirm-erase) CONFIRM_ERASE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die_usage "opção desconhecida: $1" ;;
  esac
done

# ═════════════════════════════════════════════════════════════════════════
# Detecção
# ═════════════════════════════════════════════════════════════════════════

# Disco que contém a raiz do sistema — nunca elegível.
root_disk() {
  local src
  src=$(findmnt -rno SOURCE / 2>/dev/null || true)
  [ -n "$src" ] || return 0
  lsblk -rno PKNAME "$src" 2>/dev/null | head -1
}

# Um disco é "livre" quando não tem partições, nem filesystem, nem
# assinaturas de LVM/RAID/swap, nem está a ser usado por nada.
disk_is_free() {
  local dev=$1 name; name=$(basename "$dev")

  # Nó inacessível — não é candidato e não deve abortar a análise.
  [ -b "$dev" ] || return 1
  # Tem partições?
  [ "$(lsblk -rno NAME "$dev" 2>/dev/null | tail -n +2 | wc -l || echo 1)" -eq 0 ] || return 1
  # Tem filesystem ou assinatura conhecida?
  [ -z "$(lsblk -rno FSTYPE "$dev" 2>/dev/null | tr -d '[:space:]' || echo busy)" ] || return 1
  # blkid detecta assinaturas que o lsblk pode não reportar.
  blkid -p "$dev" >/dev/null 2>&1 && return 1
  # Está montado?
  findmnt -rno TARGET -S "$dev" >/dev/null 2>&1 && return 1
  # Alguém a usar (LVM, mdraid, LUKS, mapper)?
  [ -z "$(ls -A "/sys/block/${name}/holders" 2>/dev/null)" ] || return 1
  # É swap?
  grep -q "^${dev}" /proc/swaps 2>/dev/null && return 1
  return 0
}

disk_size() { lsblk -bdno SIZE "$1" 2>/dev/null | head -1 || true; }

report_disks() {
  step "Discos do sistema"
  local rootd; rootd=$(root_disk)

  printf '  %-12s %8s  %-10s %-12s %s\n' DISPOSITIVO TAMANHO TIPO ESTADO NOTA
  printf '  %s\n' "-------------------------------------------------------------------------"

  local dev name size sizeh fstype parts state note SHOW_PARTS
  FREE_DISKS=()
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    dev="/dev/${name}"
    SHOW_PARTS=""
    # Ver nota em disk_is_free: um nó inacessível faz o lsblk devolver 32 e,
    # com pipefail, abortaria o relatório.
    [ -b "$dev" ] || continue
    size=$(disk_size "$dev"); sizeh=$(numfmt --to=iec "${size:-0}" 2>/dev/null || echo '?')
    fstype=$(lsblk -rno FSTYPE "$dev" 2>/dev/null | tr -d '[:space:]' || true)
    parts=$(lsblk -rno NAME "$dev" 2>/dev/null | tail -n +2 | wc -l || echo 0)

    if [ "$name" = "$rootd" ]; then
      state="sistema"; note="raiz do SO — NUNCA tocar"
    elif findmnt -rno TARGET -S "$dev" >/dev/null 2>&1; then
      state="montado"; note="em uso: $(findmnt -rno TARGET -S "$dev" | tr '\n' ' ')"
    elif [ "$parts" -gt 0 ]; then
      state="particionado"; note="${parts} partição(ões) — conteúdo desconhecido"
      # As partições são impressas a seguir à linha do disco (ver abaixo).
      SHOW_PARTS="$dev"
    elif disk_is_free "$dev"; then
      state="LIVRE"; note="sem filesystem — candidato a disco de dados"
      FREE_DISKS+=("$dev")
    else
      state="ocupado"; note="assinatura/holder detectado"
    fi
    printf '  %-12s %8s  %-10s %-12s %s\n' "$dev" "$sizeh" "${fstype:-—}" "$state" "$note"

    # Detalhe das partições, para o operador poder decidir com informação.
    if [ -n "$SHOW_PARTS" ]; then
      local pn pf ps pm
      while read -r pn pf ps pm; do
        [ -z "$pn" ] && continue
        printf '  %-12s %8s  %-10s %-12s %s\n' "  └ ${pn}" \
          "$(numfmt --to=iec "${ps:-0}" 2>/dev/null || printf '%s' "${ps:-?}")" \
          "${pf:-—}" "" "${pm:-não montado}"
      done < <(lsblk -rbno NAME,FSTYPE,SIZE,MOUNTPOINT "$SHOW_PARTS" | tail -n +2)
    fi
  done < <(lsblk -dno NAME --nodeps 2>/dev/null | grep -vE '^(loop|sr|ram|fd)')

  printf '\n'
  if [ "${#FREE_DISKS[@]}" -eq 0 ]; then
    info "nenhum disco livre detectado"
  else
    ok "${#FREE_DISKS[@]} disco(s) livre(s): ${FREE_DISKS[*]}"
  fi
}

report_data_mount() {
  step "Estado de ${MOUNT_POINT}"
  if is_mountpoint "$MOUNT_POINT"; then
    local src fstype size used avail pct
    src=$(findmnt -rno SOURCE "$MOUNT_POINT")
    fstype=$(findmnt -rno FSTYPE "$MOUNT_POINT")
    read -r size used avail pct <<<"$(df -Ph "$MOUNT_POINT" | awk 'NR==2 {print $2, $3, $4, $5}')"
    ok "${MOUNT_POINT} montado — ${src} (${fstype}) ${used}/${size} usados, ${avail} livres (${pct})"
    if grep -qE "[[:space:]]${MOUNT_POINT}[[:space:]]" /etc/fstab 2>/dev/null; then
      ok "entrada persistente em /etc/fstab presente"
    else
      warn "montado mas SEM entrada em /etc/fstab — desaparece no próximo reboot"
    fi
    local d
    for d in postgres docker backups; do
      if [ -d "${MOUNT_POINT}/${d}" ]; then ok "${MOUNT_POINT}/${d} existe"; else warn "${MOUNT_POINT}/${d} em falta"; fi
    done
  else
    info "${MOUNT_POINT} não está montado — os dados ficam em ${SPHARMMT_ROOT}"
    info "layout actual: postgres=${SPHARMMT_PG_DIR}  backups=${SPHARMMT_BACKUP_DIR}"
  fi
}

# ═════════════════════════════════════════════════════════════════════════
# Validação do dispositivo — a parte que impede um desastre
# ═════════════════════════════════════════════════════════════════════════
validate_device() {
  local dev=$1
  step "Validação de ${dev}"

  [ -b "$dev" ] || die_precond "${dev} não é um dispositivo de bloco"

  # Tem de ser um disco inteiro, não uma partição: particionar /dev/sdb1
  # destruiria a partição-mãe de forma confusa.
  local devtype; devtype=$(lsblk -dno TYPE "$dev" 2>/dev/null | head -1)
  [ "$devtype" = "disk" ] || die_precond "${dev} é do tipo '${devtype}', esperado 'disk' (passa o disco inteiro, não uma partição)"

  local rootd; rootd=$(root_disk)
  [ "$(basename "$dev")" != "$rootd" ] || die_precond "${dev} contém a raiz do sistema — recusado"

  # Cada motivo de recusa é reportado individualmente: o operador tem de
  # perceber PORQUE o disco não é elegível, para decidir com conhecimento.
  local parts fstype holders
  parts=$(lsblk -rno NAME "$dev" 2>/dev/null | tail -n +2 | wc -l)
  if [ "$parts" -gt 0 ]; then
    err "${dev} tem ${parts} partição(ões):"
    lsblk -o NAME,FSTYPE,SIZE,LABEL,MOUNTPOINT "$dev" | sed 's/^/    /' >&2
    die_precond "disco não está vazio — este script nunca apaga partições existentes"
  fi

  fstype=$(lsblk -rno FSTYPE "$dev" 2>/dev/null | tr -d '[:space:]')
  [ -z "$fstype" ] || die_precond "${dev} já tem um filesystem (${fstype}) — recusado"

  if blkid -p "$dev" >/dev/null 2>&1; then
    err "assinatura detectada em ${dev}:"
    blkid -p "$dev" 2>/dev/null | sed 's/^/    /' >&2 || true
    die_precond "${dev} tem assinatura de dados (LVM/RAID/LUKS/filesystem) — recusado"
  fi

  findmnt -rno TARGET -S "$dev" >/dev/null 2>&1 \
    && die_precond "${dev} está montado — recusado"

  holders=$(ls -A "/sys/block/$(basename "$dev")/holders" 2>/dev/null || true)
  [ -z "$holders" ] || die_precond "${dev} está a ser usado por: ${holders} — recusado"

  grep -q "^${dev}" /proc/swaps 2>/dev/null \
    && die_precond "${dev} está em uso como swap — recusado"

  local size; size=$(disk_size "$dev")
  [ "${size:-0}" -ge 10737418240 ] \
    || die_precond "${dev} tem apenas $(numfmt --to=iec "${size:-0}") — mínimo 10 GiB para dados"

  ok "${dev} validado: disco inteiro, $(numfmt --to=iec "$size"), vazio e não utilizado"
}

# ═════════════════════════════════════════════════════════════════════════
confirm_erase() {
  local dev=$1
  printf '\n'
  warn "════════════════════════════════════════════════════════════════"
  warn " TODO O CONTEÚDO DE ${dev} ($(numfmt --to=iec "$(disk_size "$dev")")) SERÁ APAGADO"
  warn " A operação é IRREVERSÍVEL e não há forma de a desfazer."
  warn "════════════════════════════════════════════════════════════════"
  printf '\n'

  if [ "$ASSUME_YES" = "1" ]; then
    # --yes sozinho NÃO chega. Uma automação que passe --yes por hábito não
    # pode acabar a formatar um disco.
    [ "$CONFIRM_ERASE" = "1" ] \
      || die_usage "--yes não é suficiente para formatar. Acrescenta --confirm-erase se é mesmo isso que queres."
    warn "a prosseguir sem perguntar (--yes --confirm-erase)"
    return 0
  fi

  [ -t 0 ] || die_usage "sem TTY: usa --yes --confirm-erase para preparar o disco de forma não-interactiva"

  local reply
  printf '%sEscreve o caminho exacto do dispositivo para confirmar (%s): %s' "$C_YLW" "$dev" "$C_RESET"
  read -r reply
  [ "$reply" = "$dev" ] || { err "resposta '${reply}' não corresponde a '${dev}'"; finish "$EX_ABORTED"; }
  ok "confirmado pelo operador"
}

# ═════════════════════════════════════════════════════════════════════════
# Preparação
# ═════════════════════════════════════════════════════════════════════════
partition_disk() {
  local dev=$1
  step "Tabela de partições GPT"
  if [ "$DRY_RUN" = "1" ]; then info "[dry-run] criaria GPT + 1 partição em ${dev}"; return 0; fi

  # GPT em vez de MBR: sem limite de 2 TiB e é o que o UEFI espera.
  parted -s "$dev" mklabel gpt
  # Alinhado a 1 MiB (optimal) — desalinhamento custa desempenho em NVMe/SSD.
  parted -s -a optimal "$dev" mkpart primary ext4 1MiB 100%
  partprobe "$dev" 2>/dev/null || true
  udevadm settle 2>/dev/null || sleep 2
  ok "GPT criada com uma partição a ocupar o disco"
}

# Nome da partição: /dev/sdb → /dev/sdb1 · /dev/nvme0n1 → /dev/nvme0n1p1
partition_name() {
  local dev=$1
  case "$dev" in
    *[0-9]) printf '%sp1' "$dev" ;;
    *) printf '%s1' "$dev" ;;
  esac
}

format_partition() {
  local part=$1
  step "Filesystem ext4"
  if [ "$DRY_RUN" = "1" ]; then info "[dry-run] formataria ${part} em ext4"; return 0; fi
  [ -b "$part" ] || die "partição ${part} não apareceu após o particionamento"

  # -m 1: reserva só 1% para root em vez dos 5% default. Num disco de dados
  # de 50 GB isso são 2 GB recuperados, e a reserva só existe para evitar
  # fragmentação em filesystems de sistema.
  mkfs.ext4 -q -m 1 -L "$FS_LABEL" "$part"
  ok "ext4 criado em ${part} (label=${FS_LABEL}, reserva 1%)"
}

mount_and_persist() {
  local part=$1
  step "Montagem em ${MOUNT_POINT}"
  ensure_dir "$MOUNT_POINT" 0755 root:root
  if [ "$DRY_RUN" = "1" ]; then info "[dry-run] montaria ${part} em ${MOUNT_POINT} e escreveria no fstab"; return 0; fi

  local uuid; uuid=$(blkid -s UUID -o value "$part")
  [ -n "$uuid" ] || die "não foi possível obter o UUID de ${part}"

  # SEMPRE por UUID: /dev/sdb pode passar a /dev/sdc entre arranques
  # (ordem de detecção), e um fstab a apontar para o disco errado é um
  # servidor que não arranca.
  # Estado antes de mexer — ver fstab_verify_ok() em lib/common.sh: o
  # veredicto é absoluto e inclui problemas pré-existentes.
  local baseline_ok=0
  if fstab_verify_ok; then baseline_ok=1; fi

  if grep -qE "^[^#]*[[:space:]]${MOUNT_POINT}[[:space:]]" /etc/fstab; then
    warn "já existe uma entrada para ${MOUNT_POINT} em /etc/fstab — preservada"
  else
    backup_file /etc/fstab
    printf 'UUID=%s  %s  ext4  defaults,noatime,nofail  0  2\n' "$uuid" "$MOUNT_POINT" >> /etc/fstab
    ok "entrada adicionada ao /etc/fstab por UUID=${uuid}"
  fi

  # nofail é deliberado: se o disco falhar, o servidor arranca na mesma e
  # dá para diagnosticar por SSH. Sem nofail, um disco de dados com problema
  # deixa a máquina presa no boot, sem acesso.

  # Um fstab inválido impede o arranque — validar antes de qualquer reboot.
  if fstab_verify_ok; then
    ok "/etc/fstab validado (findmnt --verify)"
  elif [ "$baseline_ok" = "0" ]; then
    # Já tinha problemas antes de mexermos: reverter a nossa linha não os
    # corrige e deixaria o disco de dados sem persistência sem razão.
    warn "/etc/fstab já tinha problemas ANTES desta alteração — entrada mantida"
    warn "inspecciona com: findmnt --verify"
  else
    err "/etc/fstab ficou inválido por causa da entrada nova — a revertê-la"
    sed -i "\|UUID=${uuid}|d" /etc/fstab
    die "fstab inválido (entrada revertida, sistema continua a arrancar)"
  fi

  if is_mountpoint "$MOUNT_POINT"; then
    ok "${MOUNT_POINT} já montado"
  else
    mount "$MOUNT_POINT"
    ok "${MOUNT_POINT} montado"
  fi
}

create_data_dirs() {
  step "Directórios de dados"
  local owner="${SPHARMMT_USER}:${SPHARMMT_GROUP}"
  if ! id "$SPHARMMT_USER" >/dev/null 2>&1; then
    warn "utilizador ${SPHARMMT_USER} ainda não existe — directórios ficam root:root"
    owner="root:root"
  elif ! getent group "$SPHARMMT_GROUP" >/dev/null; then
    owner="${SPHARMMT_USER}:$(id -gn "$SPHARMMT_USER")"
  fi

  ensure_dir "${MOUNT_POINT}/postgres" 2750 "$owner"
  # 0700 é exigido pelo próprio PostgreSQL, que recusa arrancar com
  # permissões mais largas no data directory.
  ensure_dir "${MOUNT_POINT}/postgres/data" 0700 "$owner"
  ensure_dir "${MOUNT_POINT}/postgres/conf" 2750 "$owner"
  ensure_dir "${MOUNT_POINT}/postgres/init" 2750 "$owner"
  ensure_dir "${MOUNT_POINT}/docker" 2750 root:root
  ensure_dir "${MOUNT_POINT}/backups" 2750 "$owner"
  ensure_dir "${MOUNT_POINT}/backups/postgres" 0700 "$owner"
  for d in daily weekly monthly; do
    ensure_dir "${MOUNT_POINT}/backups/postgres/${d}" 0700 "$owner"
  done
  ensure_dir "${MOUNT_POINT}/backups/files" 2750 "$owner"
  ensure_dir "${MOUNT_POINT}/backups/tmp" 2750 "$owner"

  write_file "${MOUNT_POINT}/README.md" 0644 root:root <<EOF
# ${MOUNT_POINT} — disco de dados do SPharm.MT

Volume dedicado aos dados que crescem. Preparado por prepare-data-disk.sh
em $(_ts).

    postgres/   data/ (volume do PostgreSQL, 0700) · conf/ · init/
    docker/     reservado para o data-root do Docker (NÃO aplicado ainda)
    backups/    postgres/{daily,weekly,monthly} · files/ · tmp/

O código, a configuração e os segredos ficam em ${SPHARMMT_ROOT} — este
volume tem apenas dados.

## Avisos

- Montado por UUID com \`nofail\`: se o disco falhar, o servidor arranca na
  mesma e dá para diagnosticar por SSH.
- \`docker/\` está criado mas o Docker continua a usar /var/lib/docker.
  Mudar o data-root implica parar o daemon e mover dados — operação
  deliberada, nunca automática.
- Este volume não é backup: está na mesma máquina que a aplicação.
EOF
  ok "estrutura de dados criada em ${MOUNT_POINT}"
}

# ═════════════════════════════════════════════════════════════════════════
postflight() {
  local dev=$1 part=$2
  step "Validação"
  if [ "$DRY_RUN" = "1" ]; then check_skip "validação do disco" "dry-run"; report "Disco de dados"; return 0; fi

  check "partição ${part} existe"          test -b "$part"
  check "filesystem ext4"                  bash -c "[ \"\$(lsblk -rno FSTYPE '${part}')\" = ext4 ]"
  check "label ${FS_LABEL}"                bash -c "[ \"\$(lsblk -rno LABEL '${part}')\" = '${FS_LABEL}' ]"
  check "${MOUNT_POINT} montado"           is_mountpoint "$MOUNT_POINT"
  check "montado a partir de ${part}"      bash -c "[ \"\$(findmnt -rno SOURCE '${MOUNT_POINT}')\" = '${part}' ]"
  check "entrada no /etc/fstab por UUID"   bash -c "grep -qE '^UUID=.*[[:space:]]${MOUNT_POINT}[[:space:]]' /etc/fstab"
  check "fstab válido"                     bash -c "findmnt --verify >/dev/null 2>&1"
  check "escrita funciona"                 bash -c "touch '${MOUNT_POINT}/.spharmmt-write-test' && rm -f '${MOUNT_POINT}/.spharmmt-write-test'"
  for d in postgres postgres/data docker backups backups/postgres; do
    check "${MOUNT_POINT}/${d}"            test -d "${MOUNT_POINT}/${d}"
  done
  check "postgres/data em 0700"            bash -c "[ \$(stat -c '%a' '${MOUNT_POINT}/postgres/data') = 700 ]"
  check "espaço disponível > 10GB"         bash -c "[ \$(df -Pm '${MOUNT_POINT}' | awk 'NR==2 {print \$4}') -gt 10240 ]"

  report "Disco de dados — validação"
}

# ═════════════════════════════════════════════════════════════════════════
declare -a FREE_DISKS=()

main() {
  log_init
  banner "prepare-data-disk"
  require_cmd lsblk findmnt

  # ── Modo relatório: read-only, é o default e não pede root ────────────
  if [ "$REPORT_ONLY" = "1" ]; then
    report_disks
    report_data_mount
    printf '\n'
    if [ "${#FREE_DISKS[@]}" -gt 0 ] && ! is_mountpoint "$MOUNT_POINT"; then
      info "Para dedicar um destes discos aos dados (APAGA TUDO no disco escolhido):"
      info "    sudo $0 --device ${FREE_DISKS[0]}"
      printf '\n'
      warn "nada foi alterado. Este script nunca prepara um disco sem --device."
    else
      ok "nada a fazer — relatório apenas, nada foi alterado"
    fi
    finish 0
  fi

  # ── Modo preparação ───────────────────────────────────────────────────
  acquire_lock data-disk
  require_root
  require_cmd parted mkfs.ext4 blkid partprobe numfmt

  report_disks
  validate_device "$DEVICE"

  local part; part=$(partition_name "$DEVICE")

  confirm_erase "$DEVICE"

  partition_disk "$DEVICE"
  format_partition "$part"
  mount_and_persist "$part"
  create_data_dirs

  local rc=0
  postflight "$DEVICE" "$part" || rc=$?

  printf '\n'
  if [ "$rc" -eq 0 ]; then
    ok "disco de dados pronto em ${MOUNT_POINT}"
    info "Passo seguinte — fazer a plataforma passar a usá-lo:"
    info "    sudo ${SCRIPT_DIR}/install-platform.sh --yes"
    printf '\n'
    warn "Os dados que já existam em ${SPHARMMT_ROOT} NÃO foram movidos."
    warn "Mover dados é sempre uma operação deliberada, com a stack parada."
  fi
  finish "$rc"
}

main "$@"
