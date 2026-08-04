#!/usr/bin/env bash
# deploy/scripts/healthcheck.sh
#
# Healthcheck do servidor SPharm.MT. Corre de 15 em 15 minutos via
# systemd timer (spharmmt-healthcheck.timer), como utilizador `deploy`.
#
# DELIBERADAMENTE AUTO-CONTIDO: não carrega lib/common.sh. Uma sonda que
# corre a cada 15 minutos não pode depender de traps, locks nem de o resto
# da árvore estar instalada — tem de funcionar mesmo com o sistema meio partido.
#
# Cobre: disco, inodes, RAM, swap, CPU/load, serviços, containers Docker,
# PostgreSQL, firewall, fail2ban, backups, certificados, reboot pendente,
# actualizações de segurança e relógio.
#
# Saída: 0 = tudo OK · 1 = pelo menos um WARN · 2 = pelo menos um CRIT.
# A unit systemd trata rc=1 como sucesso (SuccessExitStatus=0 1); só rc=2
# marca a unit como falhada.

set -uo pipefail

# ─── Limiares (sobreponíveis por /etc/spharmmt/platform.conf) ────────────
DISK_WARN=${DISK_WARN:-75};  DISK_CRIT=${DISK_CRIT:-90}
INODE_WARN=${INODE_WARN:-80}
MEM_WARN=${MEM_WARN:-85};    MEM_CRIT=${MEM_CRIT:-95}
SWAP_WARN=${SWAP_WARN:-50}
LOAD_WARN=${LOAD_WARN:-4};   LOAD_CRIT=${LOAD_CRIT:-8}   # 4 vCPU: load 4 = 100%
BACKUP_MAX_AGE_H=${BACKUP_MAX_AGE_H:-30}                 # backup diário + folga

SPHARMMT_ROOT=${SPHARMMT_ROOT:-/opt/spharmmt}
SPHARMMT_CONF_FILE=${SPHARMMT_CONF_FILE:-/etc/spharmmt/platform.conf}
SPHARMMT_PG_CONTAINER=${SPHARMMT_PG_CONTAINER:-spharmmt-postgres}
CORE_SERVICES=${CORE_SERVICES:-"ssh docker containerd fail2ban systemd-journald"}

# shellcheck disable=SC1090
[ -r "$SPHARMMT_CONF_FILE" ] && . "$SPHARMMT_CONF_FILE"

STATE_DIR="${SPHARMMT_ROOT}/monitoring/state"
mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="${TMPDIR:-/tmp}"

rc=0
warns=0
crits=0

say() {
  local level=$1 msg=$2
  printf '%-4s %s\n' "$level" "$msg"
  case "$level" in
    WARN) warns=$((warns+1)); [ "$rc" -lt 1 ] && rc=1 ;;
    CRIT) crits=$((crits+1)); rc=2 ;;
  esac
  return 0
}

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
printf '===== healthcheck %s host=%s =====\n' "$ts" "$(hostname)"

# ─── Disco ───────────────────────────────────────────────────────────────
while read -r use mnt; do
  u=${use%\%}
  case "$u" in ''|*[!0-9]*) continue ;; esac
  if   [ "$u" -ge "$DISK_CRIT" ]; then say CRIT "disco ${mnt} a ${u}% (limite ${DISK_CRIT}%)"
  elif [ "$u" -ge "$DISK_WARN" ]; then say WARN "disco ${mnt} a ${u}% (limite ${DISK_WARN}%)"
  else say OK "disco ${mnt} a ${u}%"; fi
done < <(df -P -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | awk 'NR>1 {print $5, $6}')

iu=$(df -Pi / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ -n "${iu:-}" ] && [ "$iu" -ge "$INODE_WARN" ]; then say WARN "inodes / a ${iu}%"
else say OK "inodes / a ${iu:-?}%"; fi

# ─── Memória e swap ──────────────────────────────────────────────────────
read -r mem_total mem_used <<<"$(free -m | awk '/^Mem:/ {print $2, $3}')"
if [ "${mem_total:-0}" -gt 0 ]; then
  mp=$(( mem_used * 100 / mem_total ))
  if   [ "$mp" -ge "$MEM_CRIT" ]; then say CRIT "RAM a ${mp}% (${mem_used}/${mem_total} MB)"
  elif [ "$mp" -ge "$MEM_WARN" ]; then say WARN "RAM a ${mp}% (${mem_used}/${mem_total} MB)"
  else say OK "RAM a ${mp}% (${mem_used}/${mem_total} MB)"; fi
fi

read -r sw_total sw_used <<<"$(free -m | awk '/^Swap:/ {print $2, $3}')"
if [ "${sw_total:-0}" -gt 0 ]; then
  sp=$(( sw_used * 100 / sw_total ))
  # Swap muito usada com RAM alta = pressão real de memória, não ruído.
  if [ "$sp" -ge "$SWAP_WARN" ]; then say WARN "swap a ${sp}% — pressão de memória"
  else say OK "swap a ${sp}%"; fi
else
  say OK "sem swap configurada"
fi

# ─── CPU / load ──────────────────────────────────────────────────────────
l1=$(awk '{print $1}' /proc/loadavg)
li=${l1%.*}
ncpu=$(nproc)
if   [ "${li:-0}" -ge "$LOAD_CRIT" ]; then say CRIT "load1 ${l1} (${ncpu} vCPU)"
elif [ "${li:-0}" -ge "$LOAD_WARN" ]; then say WARN "load1 ${l1} (${ncpu} vCPU)"
else say OK "load1 ${l1} (${ncpu} vCPU)"; fi

# ─── Serviços ────────────────────────────────────────────────────────────
for s in $CORE_SERVICES; do
  if systemctl is-active --quiet "$s" 2>/dev/null; then
    say OK "serviço ${s} activo"
  elif systemctl list-unit-files 2>/dev/null | grep -q "^${s}\.service"; then
    say CRIT "serviço ${s} INACTIVO"
  else
    say OK "serviço ${s} não instalado (ignorado)"
  fi
done

# ─── Firewall ────────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q '^Status: active'; then say OK "UFW activa"
  else say CRIT "UFW INACTIVA"; fi
fi

# ─── fail2ban ────────────────────────────────────────────────────────────
if command -v fail2ban-client >/dev/null 2>&1; then
  jails=$(fail2ban-client status 2>/dev/null | awk -F: '/Jail list/ {print $2}' | xargs)
  if [ -n "$jails" ]; then
    banned=$(fail2ban-client status sshd 2>/dev/null | awk -F: '/Currently banned/ {print $2}' | xargs)
    say OK "fail2ban jails: ${jails} (sshd banidos: ${banned:-0})"
  else
    say WARN "fail2ban sem jails activas"
  fi
fi

# ─── Docker ──────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    say OK "docker daemon responde"

    unhealthy=$(docker ps --filter health=unhealthy --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
    if [ -n "${unhealthy// /}" ]; then say CRIT "containers unhealthy: ${unhealthy}"; else say OK "sem containers unhealthy"; fi

    # Containers que deviam estar a correr mas terminaram.
    exited=$(docker ps -a --filter status=exited --filter status=dead --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
    if [ -n "${exited// /}" ]; then say WARN "containers parados: ${exited}"; else say OK "sem containers parados"; fi

    # Reinícios em ciclo — sinal de crashloop.
    while read -r name restarts; do
      [ -z "${name:-}" ] && continue
      [ "${restarts:-0}" -ge 5 ] && say WARN "container ${name} reiniciou ${restarts}x"
    done < <(docker ps -q 2>/dev/null | xargs -r docker inspect --format '{{.Name}} {{.RestartCount}}' 2>/dev/null | sed 's|^/||')

    running=$(docker ps -q 2>/dev/null | wc -l)
    say OK "containers a correr: ${running}"

    # Espaço ocupado pelo Docker — cresce silenciosamente com imagens órfãs.
    dsize=$(docker system df --format '{{.Size}}' 2>/dev/null | head -1)
    [ -n "${dsize:-}" ] && say OK "docker ocupa ${dsize}"
  else
    say CRIT "docker daemon NAO responde"
  fi
fi

# ─── PostgreSQL ──────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker inspect "$SPHARMMT_PG_CONTAINER" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$SPHARMMT_PG_CONTAINER" 2>/dev/null)" = "true" ]; then
    if docker exec "$SPHARMMT_PG_CONTAINER" pg_isready -q 2>/dev/null; then
      say OK "postgres aceita ligações (pg_isready)"
      conns=$(docker exec "$SPHARMMT_PG_CONTAINER" psql -U "${POSTGRES_USER:-postgres}" -tAc \
        "SELECT count(*) FROM pg_stat_activity" 2>/dev/null | tr -d ' ')
      maxc=$(docker exec "$SPHARMMT_PG_CONTAINER" psql -U "${POSTGRES_USER:-postgres}" -tAc \
        "SHOW max_connections" 2>/dev/null | tr -d ' ')
      if [ -n "${conns:-}" ] && [ -n "${maxc:-}" ] && [ "$maxc" -gt 0 ]; then
        pct=$(( conns * 100 / maxc ))
        if [ "$pct" -ge 80 ]; then say WARN "postgres a ${pct}% das conexões (${conns}/${maxc})"
        else say OK "postgres conexões ${conns}/${maxc}"; fi
      fi
    else
      say CRIT "postgres a correr mas NAO aceita ligações"
    fi
  else
    say CRIT "container ${SPHARMMT_PG_CONTAINER} existe mas está parado"
  fi
else
  say OK "postgres ainda não instalado (fase de preparação)"
fi

# ─── Backups ─────────────────────────────────────────────────────────────
bdir="${SPHARMMT_ROOT}/backups/postgres/daily"
if [ -d "$bdir" ]; then
  # Os dumps vivem em daily/<conjunto>/*.dump — daí a profundidade 2.
  last=$(find "$bdir" -mindepth 1 -maxdepth 2 -type f -name '*.dump' 2>/dev/null | head -1)
  if [ -z "$last" ]; then
    if docker inspect "$SPHARMMT_PG_CONTAINER" >/dev/null 2>&1; then
      say WARN "sem backups em ${bdir} apesar de o postgres existir"
    else
      say OK "sem backups ainda (postgres não instalado)"
    fi
  else
    newest=$(find "$bdir" -mindepth 1 -maxdepth 2 -type f -name '*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1)
    age_h=$(( ( $(date +%s) - ${newest%%.*} ) / 3600 ))
    if [ "$age_h" -gt "$BACKUP_MAX_AGE_H" ]; then
      say CRIT "backup mais recente tem ${age_h}h (limite ${BACKUP_MAX_AGE_H}h)"
    else
      say OK "backup mais recente há ${age_h}h"
    fi
  fi
fi

# ─── Manutenção do SO ────────────────────────────────────────────────────
if [ -f /var/run/reboot-required ]; then
  say WARN "reboot pendente: $(tr '\n' ' ' < /var/run/reboot-required.pkgs 2>/dev/null | head -c 120)"
else
  say OK "sem reboot pendente"
fi

sec=$(apt-get -s upgrade 2>/dev/null | grep -ci '^Inst.*security' || true)
if [ "${sec:-0}" -gt 0 ]; then say WARN "${sec} actualizações de segurança pendentes"
else say OK "sem actualizações de segurança pendentes"; fi

if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
  say OK "relógio sincronizado"
else
  say WARN "relógio NAO sincronizado"
fi

# ─── Resumo ──────────────────────────────────────────────────────────────
printf '===== resultado: rc=%s (crit=%s warn=%s) =====\n\n' "$rc" "$crits" "$warns"
printf '%s rc=%s crit=%s warn=%s\n' "$ts" "$rc" "$crits" "$warns" > "${STATE_DIR}/last-run" 2>/dev/null || true
exit "$rc"
