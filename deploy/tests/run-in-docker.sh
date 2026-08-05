#!/usr/bin/env bash
# deploy/tests/run-in-docker.sh
#
# Corre a suite de testes num Ubuntu 24.04 descartável. Não toca no host
# nem em nenhuma VPS — o container é criado, usado e destruído.
#
# Uso (a partir da raiz do repositório, ou de qualquer sítio):
#   ./deploy/tests/run-in-docker.sh
#   ./deploy/tests/run-in-docker.sh --shell     # entra no container para depurar
#
# Requisitos: Docker com containers Linux.

set -Eeuo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
BASE_IMAGE="ubuntu:24.04"
IMAGE="spharmmt-test:24.04"     # imagem local com o ambiente já preparado
INTERACTIVE=0
REBUILD=0

case "${1:-}" in
  --shell)   INTERACTIVE=1 ;;
  --rebuild) REBUILD=1 ;;
esac

command -v docker >/dev/null 2>&1 || { echo "docker não encontrado" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "daemon docker não responde" >&2; exit 2; }

# Git Bash / MSYS no Windows converte automaticamente caminhos tipo Unix nos
# argumentos ("/work" vira "C:/Program Files/Git/work"). Desligar a conversão
# e passar a origem do bind mount em formato Windows.
MOUNT_SRC="$REPO_ROOT"
if [ -n "${MSYSTEM:-}" ] || uname -s 2>/dev/null | grep -qE 'MINGW|MSYS'; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
  command -v cygpath >/dev/null 2>&1 && MOUNT_SRC=$(cygpath -w "$REPO_ROOT")
fi

echo "repositório: ${REPO_ROOT}"
echo "bind mount:  ${MOUNT_SRC} -> /work"
echo "imagem:      ${IMAGE}"
echo

# ── Imagem de teste ──────────────────────────────────────────────────────
# O ambiente é construído UMA VEZ e reutilizado. Sem isto, cada execução
# repete um `apt-get update` que, com a rede instável, fica minutos pendurado
# e faz parecer que o teste bloqueou quando o problema é ambiental.
#
# Os pacotes instalados são os que os scripts consultam directamente; o resto
# é substituído por stubs dentro do teste (ver test-bootstrap-dryrun.sh).
# tzdata e locales existem sempre numa VPS Ubuntu real — a imagem base é mais
# magra do que isso.
build_image() {
  echo "a construir ${IMAGE} (só na primeira vez; usa --rebuild para refazer)..."
  docker build -t "$IMAGE" -f - . <<EOF
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
      -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=3 \
 && apt-get install -y -qq --no-install-recommends \
      -o Acquire::http::Timeout=30 -o Acquire::Retries=3 \
      ca-certificates openssh-client openssh-server ufw coreutils util-linux findutils grep sed gawk \
      procps file tzdata locales curl gnupg \
 && rm -rf /var/lib/apt/lists/*
EOF
}

if [ "$REBUILD" = "1" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  build_image || { echo "falha a construir a imagem de teste (rede?)" >&2; exit 2; }
else
  echo "imagem de teste já existe (--rebuild para refazer)"
fi

echo "--- ambiente ---"
docker run --rm "$IMAGE" bash -c '. /etc/os-release; echo "SO: $PRETTY_NAME"; echo "bash: $(bash --version | head -1)"'
echo

if [ "$INTERACTIVE" = "1" ]; then
  exec docker run --rm -it -v "${MOUNT_SRC}:/work:ro" -w /work "$IMAGE" bash
fi

# --privileged: o test-data-root.sh monta um loop device com ext4 para
# exercitar a distinção entre "pasta /data" e "volume montado em /data" —
# que é precisamente o que se está a testar e um stub não reproduziria.
# O container é descartável e não monta nada do host.
rc=0
docker run --rm --privileged -v "${MOUNT_SRC}:/work:ro" -w /work "$IMAGE" bash -c '
set -e
# O repositório é montado read-only; os scripts precisam de escrever em /tmp.
cp -r /work/deploy /tmp/deploy
chmod +x /tmp/deploy/scripts/*.sh /tmp/deploy/tests/*.sh
export SCRIPTS_DIR=/tmp/deploy/scripts
suite_rc=0
for t in /tmp/deploy/tests/test-*.sh; do
  bash "$t" || suite_rc=1
done
exit $suite_rc
' || rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "RESULTADO: todos os testes passaram (rc=0)"
else
  echo "RESULTADO: falhou (rc=${rc})"
fi
exit "$rc"
