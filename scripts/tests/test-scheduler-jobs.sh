#!/usr/bin/env bash
# scripts/tests/test-scheduler-jobs.sh
#
# Prova que se pode ligar UM job do scheduler sem ligar os outros.
#
# Porque isto importa: ligar o scheduler por causa do job de Utilizações
# activava também os cinco nocturnos — enriquecimento e aquisição
# regulamentar incluídos — que podem não estar validados naquela
# instalação. "Ligar o scheduler" e "ligar todos os jobs" eram a mesma
# decisão, e não deviam ser.
#
# Corre o scheduler real com `--list`, que não dispara nada.
#
# Uso: bash scripts/tests/test-scheduler-jobs.sh

set -uo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
S="${REPO}/scripts/workers/scheduler.mjs"

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  [OK]    %s\n' "$1"
  else fail=$((fail+1)); printf '  [FALHA] %s: obtido "%s", esperado "%s"\n' "$1" "$2" "$3"; fi
}

# Quantos jobs aparecem ligados/desligados no plano.
ligados()    { printf '%s' "$1" | grep -c '\[on \]'; }
desligados() { printf '%s' "$1" | grep -c '\[off\]'; }
# O nome do job vem ANTES do caminho. Sem o `[^/]*`, procurar
# "enrich-catalog" acertava na linha do `enrich-fila`, cujo path e
# /api/jobs/enrich-catalog?apenasFila=1 — e o teste dizia que um job
# desligado estava ligado.
tem_ligado() { printf '%s' "$1" | grep -E "\\[on \\][^/]*\\b$2\\b" >/dev/null && echo sim || echo nao; }

echo "=== sem SCHEDULER_JOBS: todos activos (comportamento anterior) ==="
out=$(SCHEDULER_JOBS= node "$S" --list 2>&1)
check "7 jobs ligados"    "$(ligados "$out")"    "7"
check "0 jobs desligados" "$(desligados "$out")" "0"

echo
echo "=== SCHEDULER_JOBS=utilizacoes: só esse ==="
out=$(SCHEDULER_JOBS=utilizacoes node "$S" --list 2>&1)
check "1 job ligado"      "$(ligados "$out")"    "1"
check "6 desligados"      "$(desligados "$out")" "6"
check "é o utilizacoes"   "$(tem_ligado "$out" utilizacoes)" "sim"
# Os que o utilizador não quer activar agora.
for j in enrich-catalog enrich-retail acquire-regulatory refresh-ipf enrich-fila; do
  check "${j} fica desligado" "$(tem_ligado "$out" "$j")" "nao"
done

echo
echo "=== lista com dois ==="
out=$(SCHEDULER_JOBS=utilizacoes,refresh-ipf node "$S" --list 2>&1)
check "2 ligados" "$(ligados "$out")" "2"
check "utilizacoes ligado" "$(tem_ligado "$out" utilizacoes)" "sim"
check "refresh-ipf ligado" "$(tem_ligado "$out" refresh-ipf)" "sim"

echo
echo "=== espaços e nomes desconhecidos ==="
out=$(SCHEDULER_JOBS=" utilizacoes , nao-existe " node "$S" --list 2>&1)
check "espaços são ignorados" "$(tem_ligado "$out" utilizacoes)" "sim"
# Um nome errado não pode ligar nada por engano nem rebentar o plano.
check "nome desconhecido não liga nada" "$(ligados "$out")" "1"

echo
echo "=== utilizacoes,enrich-fila: a combinação que vamos activar ==="
# O backlog historico corre pelo CLI; o `enrich-fila` e' para os produtos
# que chegam por importacao, e so' toca no que esta' na EnriquecimentoFila.
# Ligar um nao pode ligar os cinco nocturnos por arrasto.
out=$(SCHEDULER_JOBS=utilizacoes,enrich-fila node "$S" --list 2>&1)
check "2 ligados"           "$(ligados "$out")" "2"
check "utilizacoes ligado"  "$(tem_ligado "$out" utilizacoes)" "sim"
check "enrich-fila ligado"  "$(tem_ligado "$out" enrich-fila)" "sim"
for j in enrich-catalog enrich-retail acquire-regulatory refresh-ipf enqueue-regulatory; do
  check "${j} continua desligado" "$(tem_ligado "$out" "$j")" "nao"
done

echo
echo "=== os desligados continuam VISÍVEIS no plano ==="
# Esconder um job desligado transformaria "não corre" em "não existe", e
# é essa a pergunta de quem corre --list.
out=$(SCHEDULER_JOBS=utilizacoes node "$S" --list 2>&1)
check "os 7 aparecem" "$(( $(ligados "$out") + $(desligados "$out") ))" "7"

echo
printf '%d ok, %d falhas\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
