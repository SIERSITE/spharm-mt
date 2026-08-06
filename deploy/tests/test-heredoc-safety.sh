#!/usr/bin/env bash
# deploy/tests/test-heredoc-safety.sh
#
# Um heredoc com delimitador NÃO citado (<<EOF, e não <<'EOF') é
# interpolado pelo shell. Isso é quase sempre o que se quer — é assim que
# ${SPHARMMT_ROOT} entra no ficheiro gerado. Mas interpolação inclui
# SUBSTITUIÇÃO DE COMANDO: uma crase no meio do texto deixa de ser
# pontuação e passa a ser um comando a executar.
#
# A falha que motivou este ficheiro, em install-stack.sh:518:
#
#   write_file "$SPHARMMT_STACK_ENV_FILE" 0640 "$OWNER" <<EOF
#   ...
#   # O Next fixa `experimental.serverActions.allowedOrigins` no bundle
#
# O shell tentou executar `experimental.serverActions.allowedOrigins`.
# Debaixo de `set -e` o instalador morria ali — no passo 4, antes de
# escrever o stack.env — e o build seguinte corria sem os build args, com
# um erro cujo texto não tem nada que ver com heredocs.
#
# O detalhe cruel: era um COMENTÁRIO. Prosa em português a documentar a
# variável, escrita no estilo do resto do ficheiro, onde as crases são
# só ênfase. O ShellCheck não a apanhou (SC2006 olha para código, não
# para corpos de heredoc).
#
# Este teste varre TODOS os scripts de deploy/ e recusa CRASES NÃO
# ESCAPADAS dentro de heredoc não citado.
#
# Só essa classe, e não «tudo o que interpola», por uma razão prática:
#   · \` é literal e correcto — é assim que estes scripts citam comandos
#     nos textos de --help e nos README que geram;
#   · $( ) é usado de propósito ($(common_flags_help), $(_ts)), e proibi-lo
#     obrigaria a marcar dez sítios legítimos, o que treina quem lê a
#     ignorar as marcas;
#   · a crase NUA nunca é intencional aqui. É sempre prosa que se pensou
#     literal e o shell leu como comando.
#
# Quando uma crase nua for mesmo desejada, marca-se a linha com
# «# heredoc-exec-ok».
#
# Saída: 0 nenhum heredoc executa comandos · 1 pelo menos um executa
#        · 2 não há scripts para verificar (não dar verde por vazio)

set -uo pipefail

REPO_ROOT=${REPO_ROOT:-/work}
SCRIPTS_DIR=${SCRIPTS_DIR:-${REPO_ROOT}/deploy/scripts}

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()  { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_() { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }

echo "=== heredocs que executam comandos ==="
echo

# scan_file <ficheiro> — imprime uma linha por ocorrência suspeita, no
# formato «linha:texto». rc=0 sempre; quem chama conta as linhas.
#
# O parser é deliberadamente simples e conservador: reconhece
# `<<DELIM`, `<<-DELIM`, `<<"DELIM"` e `<<'DELIM'` e segue até ao
# terminador. Delimitador citado (as duas últimas formas) = corpo
# literal = seguro, e é saltado sem olhar.
scan_file() {
  awk '
    # Dentro de um heredoc: procurar o terminador, senão inspeccionar.
    in_doc {
      line = $0
      t = line
      sub(/^[[:space:]]+/, "", t)          # <<- permite terminador indentado
      if (t == delim) { in_doc = 0; next }
      if (!interp) next
      if (line ~ /# heredoc-exec-ok/) next
      # Crase NUA. Uma precedida de barra (\`) é literal e legítima —
      # removem-se as escapadas primeiro e vê-se o que sobra.
      probe = line
      gsub(/\\`/, "", probe)
      if (probe ~ /`/) printf "%d:crase nua: %s\n", FNR, line
      next
    }

    # Fora de heredoc: detectar a abertura. Ignora `<<<` (here-string) e
    # `<<` dentro de comentário — nenhum dos dois abre corpo.
    {
      line = $0
      if (line ~ /^[[:space:]]*#/) next
      if (line !~ /<</) next
      if (line ~ /<<</) next
      if (match(line, /<<-?[[:space:]]*("[^"]+"|'"'"'[^'"'"']+'"'"'|[A-Za-z_][A-Za-z0-9_]*)/)) {
        tok = substr(line, RSTART, RLENGTH)
        sub(/^<<-?[[:space:]]*/, "", tok)
        interp = 1
        if (tok ~ /^"/ || tok ~ /^'"'"'/) { interp = 0; gsub(/["'"'"']/, "", tok) }
        delim = tok
        in_doc = 1
      }
    }
  ' "$1"
}

shopt -s nullglob
files=( "${SCRIPTS_DIR}"/*.sh "${SCRIPTS_DIR}"/lib/*.sh )
shopt -u nullglob

if [ "${#files[@]}" -eq 0 ]; then
  echo "sem scripts em ${SCRIPTS_DIR} — nada verificado" >&2
  exit 2
fi

for f in "${files[@]}"; do
  hits=$(scan_file "$f")
  if [ -z "$hits" ]; then
    ok_ "$(basename "$f") — heredocs sem execução de comandos"
  else
    while IFS= read -r h; do
      [ -n "$h" ] || continue
      bad_ "$(basename "$f"):${h}"
    done <<<"$hits"
  fi
done

# ═════════════════════════════════════════════════════════════════════════
# O parser apanha mesmo o caso real?
# ═════════════════════════════════════════════════════════════════════════
#
# Um scanner que não detecta nada dá exactamente o mesmo verde que um
# código limpo. Estas amostras separam as duas coisas.
echo
echo "--- auto-verificação do detector ---"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Reprodução literal do bug de install-stack.sh:518.
cat >"${tmp}/mau.sh" <<'SAMPLE'
write_file "$X" 0640 "$O" <<EOF
# O Next fixa `experimental.serverActions.allowedOrigins` no bundle.
VAR=${VALOR}
EOF
SAMPLE

# O mesmo texto, com delimitador citado: literal, portanto seguro.
cat >"${tmp}/bom.sh" <<'SAMPLE'
write_file "$X" 0640 "$O" <<'EOF'
# O Next fixa `experimental.serverActions.allowedOrigins` no bundle.
EOF
cat <<EOF
sem crases, só ${INTERPOLACAO}
EOF
SAMPLE

if [ -n "$(scan_file "${tmp}/mau.sh")" ]; then
  ok_ "detecta crase em heredoc não citado (o bug real)"
else
  bad_ "NÃO detecta o bug real — este teste estaria a dar verde por nada"
fi

if [ -z "$(scan_file "${tmp}/bom.sh")" ]; then
  ok_ "não acusa heredoc citado nem interpolação legítima de variáveis"
else
  bad_ "falso positivo em heredoc citado"
fi

echo
printf 'heredocs: %s%d ok%s, %s%d falhas%s\n' "$C_G" "$pass" "$C_0" "$C_R" "$fail" "$C_0"
[ "$fail" -eq 0 ] || exit 1
exit 0
