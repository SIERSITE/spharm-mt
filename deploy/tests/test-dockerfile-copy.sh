#!/usr/bin/env bash
# deploy/tests/test-dockerfile-copy.sh
#
# Cada `COPY` do Dockerfile tem de resolver no contexto de build REAL do
# servidor. E o contexto real não é a working tree: o install-stack.sh
# exporta o código com `git archive HEAD`, portanto o que conta é o
# conteúdo do ÚLTIMO COMMIT.
#
# A falha que motivou este ficheiro:
#
#   Dockerfile:137
#   COPY prisma.config.ts prisma-control.config.ts ./
#   "/prisma-control.config.ts": not found
#
# O ficheiro existia no disco e estava em `git add` — mas nunca tinha
# sido commitado. O build local passava (usa a working tree) e o da VPS
# falhava depois de dez minutos de `npm ci`, com uma mensagem que não
# aponta para "falta um commit".
#
# Um teste que verificasse o disco teria passado. Por isso este verifica
# HEAD, e sem git recusa-se a correr em vez de dar um verde enganador.
#
# Verifica, por cada origem de cada COPY:
#   1. existe em HEAD (ficheiro ou directório com conteúdo);
#   2. não é excluída pelo .dockerignore.
#
# `COPY --from=<stage>` é ignorado: refere-se a um estágio anterior do
# build, não ao contexto.
#
# Saída: 0 todos os COPY resolvem · 1 pelo menos um não resolve
#        · 2 sem git (não é possível verificar o que interessa)

set -uo pipefail

REPO_ROOT=${REPO_ROOT:-/work}
DOCKERFILE=${DOCKERFILE:-${REPO_ROOT}/deploy/docker/Dockerfile}
DOCKERIGNORE=${DOCKERIGNORE:-${REPO_ROOT}/.dockerignore}

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }

# ═════════════════════════════════════════════════════════════════════════
# Existência em HEAD
# ═════════════════════════════════════════════════════════════════════════

# in_head <caminho> — 0 se HEAD tem esse caminho como ficheiro (blob) ou
# directório (tree). Um directório vazio não existe em git, portanto um
# `tree` implica sempre conteúdo.
#
# `cat-file -t` resolve os dois casos sem pipeline nenhuma. A alternativa
# óbvia — `ls-tree -r | head -1` — reintroduzia a classe de falha do
# SIGPIPE que já custou a geração de segredos.
in_head() {
  local path=$1 kind
  # `COPY . .` copia o contexto inteiro. Em git, a raiz é `HEAD:` — com
  # `HEAD:.` o cat-file devolve erro e o teste acusava a raiz de não
  # existir.
  case "$path" in .|./) path="" ;; *) path=${path#./} ;; esac
  kind=$(git -C "$REPO_ROOT" cat-file -t "HEAD:${path}" 2>/dev/null) || return 1
  [ "$kind" = "blob" ] || [ "$kind" = "tree" ]
}

# ═════════════════════════════════════════════════════════════════════════
# .dockerignore
# ═════════════════════════════════════════════════════════════════════════
#
# Implementa o subconjunto que este repositório usa: padrões literais,
# globs simples, e negação com `!`. A última regra que casa é a que
# decide, como no Docker. Não cobre `**` no meio do padrão — se alguém o
# introduzir, este teste passa a ser optimista e a nota fica aqui.
excluded_by_dockerignore() {
  local path=$1 verdict=1 line pattern negate
  [ -f "$DOCKERIGNORE" ] || return 1

  while IFS= read -r line; do
    line=${line%$'\r'}
    case "$line" in ''|\#*) continue ;; esac
    negate=0
    pattern=$line
    if [ "${pattern#!}" != "$pattern" ]; then negate=1; pattern=${pattern#!}; fi
    pattern=${pattern#./}
    pattern=${pattern%/}
    [ -z "$pattern" ] && continue

    # shellcheck disable=SC2254  # o padrão É um glob, de propósito
    case "$path" in
      $pattern|$pattern/*)
        if [ "$negate" = "1" ]; then verdict=1; else verdict=0; fi
        ;;
    esac
    # Um padrão sem barra também casa com qualquer segmento do caminho.
    if [ "${pattern#*/}" = "$pattern" ]; then
      local seg rest="$path"
      while [ -n "$rest" ]; do
        seg=${rest%%/*}
        # shellcheck disable=SC2254
        case "$seg" in
          $pattern) if [ "$negate" = "1" ]; then verdict=1; else verdict=0; fi ;;
        esac
        [ "$rest" = "$seg" ] && break
        rest=${rest#*/}
      done
    fi
  done < "$DOCKERIGNORE"

  return "$verdict"
}

# ═════════════════════════════════════════════════════════════════════════
# Extracção dos COPY
# ═════════════════════════════════════════════════════════════════════════
#
# Junta continuações de linha (`\`), descarta comentários, e devolve
# "<linha>|<origem>" para cada origem de cada COPY do contexto.
copy_sources() {
  awk '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/\r$/, "", line)
      if (buf != "") { line = buf " " line; buf = "" }
      if (line ~ /\\[[:space:]]*$/) {
        sub(/\\[[:space:]]*$/, "", line)
        buf = line
        if (start == 0) start = NR
        next
      }
      n = (start ? start : NR); start = 0
      if (line !~ /^[[:space:]]*(COPY|ADD)[[:space:]]/) next
      # --from= refere um estágio do build, não o contexto.
      if (line ~ /--from=/) next
      sub(/^[[:space:]]*(COPY|ADD)[[:space:]]+/, "", line)
      # Descarta outras flags (--chown, --chmod, --link).
      while (line ~ /^--[a-z]+=[^ ]+[[:space:]]+/) sub(/^--[a-z]+=[^ ]+[[:space:]]+/, "", line)
      c = split(line, parts, /[[:space:]]+/)
      # O último argumento é o destino.
      for (i = 1; i < c; i++) {
        if (parts[i] == "") continue
        printf "%s|%s\n", n, parts[i]
      }
    }
  ' "$DOCKERFILE"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: COPY do Dockerfile vs HEAD ===\n'

  if [ ! -f "$DOCKERFILE" ]; then
    printf '  Dockerfile não encontrado em %s\n' "$DOCKERFILE"
    return 2
  fi
  if ! command -v git >/dev/null 2>&1; then
    printf '  %sgit ausente%s — este teste verifica HEAD e sem git não\n' "$C_R" "$C_0"
    printf '  verificaria o que interessa. A recusar em vez de passar.\n'
    return 2
  fi
  if ! git -C "$REPO_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
    printf '  %s não é um repositório git com HEAD\n' "$REPO_ROOT"
    return 2
  fi

  printf '\nDockerfile : %s\n' "$DOCKERFILE"
  printf 'HEAD       : %s\n\n' "$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

  local total=0 entry line src
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    line=${entry%%|*}
    src=${entry#*|}
    total=$((total + 1))

    if ! in_head "$src"; then
      bad_ "linha ${line}: '${src}' NÃO existe em HEAD"
      if [ -e "${REPO_ROOT}/${src}" ]; then
        printf '      existe no disco mas não está commitado. O install-stack.sh\n'
        printf '      exporta com "git archive HEAD", que não o inclui: o build\n'
        printf '      falha na VPS e passa localmente.\n'
      fi
      continue
    fi

    if excluded_by_dockerignore "$src"; then
      bad_ "linha ${line}: '${src}' existe em HEAD mas o .dockerignore exclui-o"
      continue
    fi

    ok_ "linha ${line}: ${src}"
  done < <(copy_sources)

  if [ "$total" -eq 0 ]; then
    bad_ "nenhum COPY encontrado — o parser não está a ler o Dockerfile"
  fi

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas  (%s COPY analisados)\n' "$pass" "$fail" "$total"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
