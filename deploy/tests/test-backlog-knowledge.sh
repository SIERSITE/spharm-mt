#!/usr/bin/env bash
#
# deploy/tests/test-backlog-knowledge.sh
#
# Prova que o encadeamento de lotes PÁRA quando tem de parar.
#
# ─────────────────────────────────────────────────────────────────────
# PORQUE É QUE ISTO NÃO É UM TESTE DE `grep`
#
# Um script que lança lotes pagos sozinho não se valida a ler o código.
# Aqui corre-se o script INTEIRO, com um `docker` falso à frente no PATH
# que devolve exactamente o que o `docker` verdadeiro devolveria — o
# relatório do lote no stdout e o código de saída — e verifica-se o que
# ele DECIDE fazer a seguir.
#
# O que se está a guardar é uma única propriedade: PARAR É O
# COMPORTAMENTO POR OMISSÃO. Um script que continue por não ter percebido
# o relatório gasta dinheiro em silêncio, e é o modo de falha que a série
# automática torna possível.
#
# Sem docker, sem base de dados, sem rede.
#
# Uso: bash deploy/tests/test-backlog-knowledge.sh
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ALVO="${REPO}/deploy/scripts/backlog-knowledge.sh"
BASE=$(mktemp -d)
trap 'rm -rf "$BASE"' EXIT

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  [OK]    %s\n' "$1"
  else fail=$((fail+1)); printf '  [FALHA] %s: obtido "%s", esperado "%s"\n' "$1" "$2" "$3"; fi
}
contem() {
  if printf '%s' "$2" | grep -q -e "$3"; then pass=$((pass+1)); printf '  [OK]    %s\n' "$1"
  else fail=$((fail+1)); printf '  [FALHA] %s: nao encontrei "%s"\n' "$1" "$3"; fi
}

# ─── Relatórios canónicos ────────────────────────────────────────────
# Copiados do formato real que o CLI imprime. Se o CLI mudar de formato,
# estes deixam de bater e o teste queixa-se — que é o ponto: o script lê
# texto, e texto muda.
relatorio_ok() {
  cat <<'FIM'
── pré-selecção (o que NÃO foi ao modelo) ─────────
       1  já conhecidos no catálogo global (resolvem o que faltava)
     121  CONDICIONAIS: subcategoria sem utilização plausível (<2%, pop>=30)
       0  CONDICIONAIS: designação opaca
     889  propagados do representante (decisão aceite OU recusada)
       0  dependentes sem decisão do representante — voltam ao residual
    1500  ENVIADOS AO MODELO  (de 2510 na janela)

  reconciliação: 2750 lidos = 1 global + 121 baixa-cobertura + 0 opacos + 1500 enviados + 889 propagados + 0 orfaos + 0 sem-contexto + 239 fora-da-janela
  ok  fecha: tudo o que foi lido tem destino nomeado.

── custo ──────────────────────────────────────────
  estimado: $11.5633
FIM
}

# ─── `docker` falso ──────────────────────────────────────────────────
# Um único executável que serve os três usos do script: `docker ps`,
# `docker compose run` e `docker exec ... psql`.
#
#   FAKE_EXIT      código com que o lote termina
#   FAKE_REL       ficheiro com o relatório a imprimir
#   FAKE_CONTAGENS contagens de processáveis, uma por linha, consumidas
#                  por ordem — é assim que se simula o backlog a descer
#   FAKE_PS        o que `docker ps` devolve (vazio = nada em voo)
montar_docker() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "${dir}/docker" <<'FIM'
#!/usr/bin/env bash
case "$1" in
  ps)
    printf '%s' "${FAKE_PS:-}"
    [ -n "${FAKE_PS:-}" ] && echo
    exit 0 ;;
  exec)
    # psql: devolve a contagem seguinte da lista e avança o cursor.
    cat >/dev/null
    n=$(head -1 "$FAKE_CONTAGENS_CURSOR" 2>/dev/null)
    if [ -n "$n" ]; then
      sed -i '1d' "$FAKE_CONTAGENS_CURSOR"
      echo "$n"
    fi
    exit 0 ;;
  compose)
    [ -n "${FAKE_REL:-}" ] && cat "$FAKE_REL"
    exit "${FAKE_EXIT:-0}" ;;
esac
exit 0
FIM
  chmod +x "${dir}/docker"
}

# ─── Raiz falsa ──────────────────────────────────────────────────────
montar_raiz() {
  local raiz="$1"
  mkdir -p "${raiz}/docker/compose" "${raiz}/docker/env" "${raiz}/logs"
  echo "services: {}" > "${raiz}/docker/compose/docker-compose.yml"
  : > "${raiz}/docker/env/platform.env"
  : > "${raiz}/docker/env/stack.env"
}

# Corre o script num ambiente isolado. Ecoa a saída; o código fica em $?.
correr() {
  local caso="$1"; shift
  local raiz="${BASE}/${caso}"
  montar_raiz "$raiz"
  montar_docker "${raiz}/bin"
  printf '%s\n' "${CONTAGENS:-0}" > "${raiz}/contagens"
  PATH="${raiz}/bin:$PATH" \
  SPHARMMT_ROOT="$raiz" \
  FAKE_EXIT="${EXITC:-0}" \
  FAKE_REL="${REL:-}" \
  FAKE_PS="${PS:-}" \
  FAKE_CONTAGENS_CURSOR="${raiz}/contagens" \
    bash "$ALVO" --tenant=teste "$@" 2>&1
}

# ═════════════════════════════════════════════════════════════════════
echo "=== sintaxe e contrato de argumentos ==="
bash -n "$ALVO" && check "bash -n passa" "0" "0" || check "bash -n passa" "1" "0"
out=$(bash "$ALVO" 2>&1); check "sem --tenant sai 1" "$?" "1"
contem "…e diz porquê" "$out" "falta --tenant"
out=$(bash "$ALVO" --tenant=x --disparate 2>&1); check "argumento desconhecido sai 1" "$?" "1"

echo
echo "=== sucesso: o lote reduz e a série pára quando chega ao fim ==="
{
  REL="${BASE}/rel-ok"; relatorio_ok > "$REL"
  # Tres leituras: a inicial, a de depois do lote 1, a de depois do
  # lote 2. A ultima cai abaixo da margem e a serie conclui.
  CONTAGENS=$'13834\n11445\n10'
  EXITC=0 PS="" out=$(correr sucesso); rc=$?
  check "série conclui com 0" "$rc" "0"
  contem "…anuncia CONCLUÍDO" "$out" "CONCLUÍDO"
  contem "…e diz que os condicionais não são backlog" "$out" "condicionais ficam no residual"
  contem "…registou o custo do lote" "$out" 'custo=\$11.5633'
  contem "…e a redução" "$out" "13834 → 11445"
  idx="${BASE}/sucesso/logs/backlog-teste-$(date -u +%Y%m%d)/indice.tsv"
  check "índice tem cabeçalho + 2 lotes" "$(wc -l < "$idx" | tr -d ' ')" "3"
  check "coluna exit do lote 1" "$(awk -F'\t' 'NR==2{print $4}' "$idx")" "0"
  check "coluna custo do lote 1" "$(awk -F'\t' 'NR==2{print $5}' "$idx")" "11.5633"
  check "coluna enviados" "$(awk -F'\t' 'NR==2{print $6}' "$idx")" "1500"
  check "coluna propagados" "$(awk -F'\t' 'NR==2{print $7}' "$idx")" "889"
  check "coluna condicionais" "$(awk -F'\t' 'NR==2{print $8}' "$idx")" "121"
  check "coluna órfãos" "$(awk -F'\t' 'NR==2{print $9}' "$idx")" "0"
  check "coluna reconciliação" "$(awk -F'\t' 'NR==2{print $10}' "$idx")" "ok"
  check "coluna processáveis depois" "$(awk -F'\t' 'NR==2{print $11}' "$idx")" "11445"
  check "log próprio do lote 1" "$(test -s "${BASE}/sucesso/logs/backlog-teste-$(date -u +%Y%m%d)/lote01.log" && echo sim)" "sim"
  check "log próprio do lote 2" "$(test -s "${BASE}/sucesso/logs/backlog-teste-$(date -u +%Y%m%d)/lote02.log" && echo sim)" "sim"
}

echo
echo "=== EXIT=3 (infraestrutura) impede o lote seguinte ==="
{
  REL="${BASE}/rel-ok"
  CONTAGENS=$'13834\n11445\n11445\n10'
  EXITC=3 PS="" out=$(correr infra); rc=$?
  check "série pára com 2" "$rc" "2"
  contem "…nomeia a infraestrutura" "$out" "INFRAESTRUTURA"
  contem "…e diz que é retomável" "$out" "Nada ficou por retomar"
  check "correu UM lote e mais nenhum" \
    "$(ls "${BASE}/infra/logs/backlog-teste-$(date -u +%Y%m%d)/" | grep -c '^lote')" "1"
}

echo
echo "=== EXIT=2 (reconciliação) impede o lote seguinte ==="
{
  REL="${BASE}/rel-recon"
  relatorio_ok | sed 's/  ok  fecha.*/  !! 4 produto(s) SEM destino contabilizado — é um defeito, não um arredondamento./' > "$REL"
  CONTAGENS=$'13834\n11445\n11445\n10'
  EXITC=2 PS="" out=$(correr recon); rc=$?
  check "série pára com 2" "$rc" "2"
  contem "…nomeia a reconciliação" "$out" "RECONCILIAÇÃO"
  check "correu UM lote" "$(ls "${BASE}/recon/logs/backlog-teste-$(date -u +%Y%m%d)/" | grep -c '^lote')" "1"
}

echo
echo "=== 'sem destino' no relatório pára, mesmo com EXIT=0 ==="
{
  # A cinta e os suspensórios: se um dia o CLI falhar a devolver 2, o
  # texto do relatório ainda pára a série.
  REL="${BASE}/rel-sd"
  relatorio_ok | sed 's/  ok  fecha.*/  !! 4 produto(s) SEM destino contabilizado/' > "$REL"
  CONTAGENS=$'13834\n11445\n11445\n10'
  EXITC=0 PS="" out=$(correr semdestino); rc=$?
  check "série pára com 2" "$rc" "2"
  contem "…pelo texto do relatório" "$out" "sem destino\|reconciliação não confirmada"
}

echo
echo "=== métrica obrigatória em falta pára a série ==="
{
  for campo in "estimado:" "ENVIADOS AO MODELO" "propagados do representante" "dependentes sem decisão"; do
    REL="${BASE}/rel-falta"
    relatorio_ok | grep -v "$campo" > "$REL"
    CONTAGENS=$'13834\n11445\n11445\n10'
    EXITC=0 PS="" out=$(correr "falta-$(echo "$campo" | tr -cd '[:alnum:]')"); rc=$?
    check "sem '${campo}' a série pára" "$rc" "2"
  done
  contem "…e diz que não conseguiu ler um número" "$out" "não consegui ler"
}

echo
echo "=== custo do lote acima do tecto pára a série ==="
{
  REL="${BASE}/rel-caro"
  relatorio_ok | sed 's/estimado: \$11.5633/estimado: $31.4159/' > "$REL"
  CONTAGENS=$'13834\n11445\n11445\n10'
  EXITC=0 PS="" out=$(correr caro); rc=$?
  check "série pára com 2" "$rc" "2"
  contem "…nomeia o tecto do lote" "$out" "acima do tecto"
}

echo
echo "=== sem redução dos processáveis pára a série ==="
{
  # O modo de falha que ninguém vê: lotes a correr, custo a subir, e o
  # backlog no mesmo sítio.
  REL="${BASE}/rel-ok"
  CONTAGENS=$'13834\n13834\n13834\n13834'
  EXITC=0 PS="" out=$(correr semprogresso); rc=$?
  check "série pára com 2" "$rc" "2"
  contem "…diz que não houve redução" "$out" "não reduziu os processáveis"
}

echo
echo "=== tecto acumulado impede o lote seguinte ==="
{
  REL="${BASE}/rel-ok"
  # A guarda é CONSERVADORA: trava quando `gasto + tecto do lote` passa
  # o total, e não quando o gasto real passa. Assume que o lote seguinte
  # pode custar o tecto inteiro, porque enquanto não correr não há
  # maneira de saber. O orçamento útil é `total - tecto do lote`.
  #
  # Com total de $30: o lote 1 arranca (0 + 25 <= 30) e gasta $11.5633;
  # o lote 2 já não (11.5633 + 25 = 36.56 > 30).
  CONTAGENS=$'13834\n11445\n11445\n9000'
  EXITC=0 PS="" out=$(correr tecto --tecto-total=30); rc=$?
  check "série pára com 2" "$rc" "2"
  contem "…nomeia o tecto total" "$out" "passaria o tecto"
  contem "…e diz quantos faltam" "$out" "Ainda faltam"
  check "correu UM lote e travou antes do segundo" \
    "$(ls "${BASE}/tecto/logs/backlog-teste-$(date -u +%Y%m%d)/" | grep -c '^lote')" "1"
}

echo "=== tecto total abaixo do tecto do lote nao deixa arrancar nada ==="
{
  # E é o comportamento certo: um lote pode custar até ao seu tecto, e
  # arrancá-lo seria autorizar uma despesa que o total não cobre.
  REL="${BASE}/rel-ok"
  CONTAGENS=$(printf %s "13834")
  EXITC=0 PS="" out=$(correr tectobaixo --tecto-total=20); rc=$?
  check "sai 2 sem lançar nada" "$rc" "2"
  contem "…nomeia o tecto" "$out" "passaria o tecto"
  check "zero lotes" "$(ls "${BASE}/tectobaixo/logs/backlog-teste-$(date -u +%Y%m%d)/" | grep -c '^lote')" "0"
}

echo
echo "=== lock impede uma segunda série ==="
{
  raiz="${BASE}/lock"
  montar_raiz "$raiz"; montar_docker "${raiz}/bin"
  dia=$(date -u +%Y%m%d)
  mkdir -p "${raiz}/logs/backlog-teste-${dia}"
  echo "99999 ontem" > "${raiz}/logs/backlog-teste-${dia}/.lock"
  printf '13834\n' > "${raiz}/contagens"
  out=$(PATH="${raiz}/bin:$PATH" SPHARMMT_ROOT="$raiz" FAKE_EXIT=0 FAKE_REL="${BASE}/rel-ok" \
        FAKE_CONTAGENS_CURSOR="${raiz}/contagens" bash "$ALVO" --tenant=teste 2>&1); rc=$?
  check "segunda série sai 1" "$rc" "1"
  contem "…nomeia o lock" "$out" "JÁ HÁ UMA SÉRIE A CORRER"
  check "e não lançou lote nenhum" "$(ls "${raiz}/logs/backlog-teste-${dia}/" | grep -c '^lote')" "0"
  check "o lock alheio NÃO foi apagado" "$(cat "${raiz}/logs/backlog-teste-${dia}/.lock")" "99999 ontem"
}

echo
echo "=== container migrate em voo impede a série ==="
{
  REL="${BASE}/rel-ok"
  CONTAGENS=$'13834\n11445'
  EXITC=0 PS="spharmmt-migrate-run-abc" out=$(correr emvoo); rc=$?
  check "sai 1" "$rc" "1"
  contem "…nomeia o container" "$out" "migrate A CORRER"
  check "e não lançou lote nenhum" \
    "$(ls "${BASE}/emvoo/logs/backlog-teste-$(date -u +%Y%m%d)/" 2>/dev/null | grep -c '^lote')" "0"
}

echo
echo "=== retoma: o índice do dia soma o custo já gasto ==="
{
  raiz="${BASE}/retoma"
  montar_raiz "$raiz"; montar_docker "${raiz}/bin"
  dia=$(date -u +%Y%m%d)
  d="${raiz}/logs/backlog-teste-${dia}"; mkdir -p "$d"
  printf 'lote\tinicio\tfim\texit\tcusto\tenviados\tpropagados\tcondicionais\torfaos\treconc\tprocessaveis_depois\n' > "${d}/indice.tsv"
  printf '1\ta\tb\t0\t180.0000\t1500\t889\t121\t0\tok\t13834\n' >> "${d}/indice.tsv"
  printf '13834\n' > "${raiz}/contagens"
  out=$(PATH="${raiz}/bin:$PATH" SPHARMMT_ROOT="$raiz" FAKE_EXIT=0 FAKE_REL="${BASE}/rel-ok" \
        FAKE_CONTAGENS_CURSOR="${raiz}/contagens" bash "$ALVO" --tenant=teste 2>&1); rc=$?
  contem "lê o custo já gasto do índice" "$out" 'já gasto nesta série: \$180.0000'
  check "e trava antes do lote seguinte (180+25 > 200)" "$rc" "2"
  check "sem lançar nada" "$(ls "$d" | grep -c '^lote')" "0"
  # E o número do lote continua a contar de onde ficou.
  contem "…o índice não foi reescrito" "$(cat "${d}/indice.tsv")" "180.0000"
}

echo
echo "=== --dry-run não lança nada ==="
{
  REL="${BASE}/rel-ok"
  CONTAGENS=$'13834'
  EXITC=0 PS="" out=$(correr seco --dry-run); rc=$?
  check "sai 0" "$rc" "0"
  contem "…diz que não lançou" "$out" "não lanço nada"
  check "e não há log de lote" \
    "$(ls "${BASE}/seco/logs/backlog-teste-$(date -u +%Y%m%d)/" | grep -c '^lote')" "0"
}

echo
echo "=== o comando lançado é o validado, e não outro ==="
{
  # O que o script manda ao docker tem de ser exactamente o comando que
  # passou os canaries. Um `--limite` ou um `--tecto-usd` trocados aqui
  # não dariam erro nenhum — dariam uma factura diferente.
  raiz="${BASE}/args"; montar_raiz "$raiz"; mkdir -p "${raiz}/bin"
  # A contagem desce de 13834 para 0: sem isso o script concluiria antes
  # de lancar seja o que for, e o teste passaria sem medir nada.
  printf %s "13834" > "${raiz}/contagens"
  cat > "${raiz}/bin/docker" <<'FIM'
#!/usr/bin/env bash
case "$1" in
  ps) exit 0 ;;
  exec)
    cat >/dev/null
    n=$(cat "$FAKE_CONTAGENS_CURSOR" 2>/dev/null)
    echo "${n:-0}"
    echo 0 > "$FAKE_CONTAGENS_CURSOR"
    exit 0 ;;
  compose) printf "%s" "$*" > "$FAKE_ARGS"; exit 0 ;;
esac
FIM
  chmod +x "${raiz}/bin/docker"
  PATH="${raiz}/bin:$PATH" SPHARMMT_ROOT="$raiz" FAKE_ARGS="${raiz}/args.txt" \
    FAKE_CONTAGENS_CURSOR="${raiz}/contagens" \
    bash "$ALVO" --tenant=silveira >/dev/null 2>&1
  args=$(cat "${raiz}/args.txt" 2>/dev/null)
  contem "usa o perfil tools"        "$args" "--profile tools"
  contem "corre no projecto spharmmt" "$args" "-p spharmmt"
  contem "passa os dois env-file"    "$args" "platform.env --env-file"
  contem "no serviço migrate"        "$args" "run --rm -T migrate"
  contem "com --apply"               "$args" "--apply"
  contem "limite de 1500"            "$args" "--limite=1500"
  contem "tecto de 25"               "$args" "--tecto-usd=25"
  contem "e o tenant certo"          "$args" "--tenant=silveira"
}

echo
printf '%s ok, %s falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
