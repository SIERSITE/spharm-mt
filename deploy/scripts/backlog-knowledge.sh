#!/usr/bin/env bash
#
# deploy/scripts/backlog-knowledge.sh
#
# Encadeia lotes de `catalog:knowledge-enrich` até o backlog PROCESSÁVEL
# de um tenant chegar a zero.
#
# ─────────────────────────────────────────────────────────────────────
# O QUE ISTO É, E O QUE NÃO É
#
# Não é código da aplicação: é ferramenta de operação. Não decide nada
# sobre produtos, não fala com o modelo, não toca em SQL de escrita. Só
# lança o MESMO comando validado, lê o relatório dele, e decide se pode
# lançar o seguinte.
#
# A regra que governa tudo: PARAR É O COMPORTAMENTO POR OMISSÃO. Qualquer
# coisa que não se consiga ler do relatório é motivo para parar, não para
# continuar. Uma série automática que não sabe porque continua é pior do
# que nove comandos à mão.
#
# ─────────────────────────────────────────────────────────────────────
# PORQUE É QUE A RETOMA É GRÁTIS
#
# O residual exclui quem tem linha em `KnowledgeEnrichmentCache` desta
# versão, INDEPENDENTEMENTE de `persistido`. Uma recusa documentada é
# uma decisão, e sai do residual tal como uma escrita. Por isso:
#
#   · voltar a correr este script continua onde ficou;
#   · nenhuma chamada já paga é repetida;
#   · não há estado a limpar entre execuções.
#
# O único trabalho que se perde ao matar um lote a meio são os lotes de
# 25 em voo (até 4, ~100 produtos, cêntimos).
#
# ─────────────────────────────────────────────────────────────────────
# Instalado por `install_operational_scripts` em
# ${SPHARMMT_ROOT}/scripts/backlog-knowledge.sh, como os restantes
# scripts operacionais. Nao se copia a mao: o postflight do
# install-stack.sh compara a copia instalada com a do checkout, e uma
# copia desactualizada reprova ali.
#
# Uso:
#   sudo ${SPHARMMT_ROOT}/scripts/backlog-knowledge.sh --tenant=silveira
#   backlog-knowledge.sh --tenant=silveira [--tecto-total=200]
#                        [--limite=1500] [--tecto-lote=25] [--max-lotes=40]
#                        [--dry-run]
#
# Saída: 0 backlog concluído · 1 erro de uso/ambiente
#        2 parou por condição de segurança (o motivo está no ecrã e no índice)
set -uo pipefail

# ─── Parâmetros ──────────────────────────────────────────────────────
TENANT=""
LIMITE=1500
TECTO_LOTE=25
TECTO_TOTAL=200
MAX_LOTES=40
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --tenant=*)      TENANT="${arg#*=}" ;;
    --limite=*)      LIMITE="${arg#*=}" ;;
    --tecto-lote=*)  TECTO_LOTE="${arg#*=}" ;;
    --tecto-total=*) TECTO_TOTAL="${arg#*=}" ;;
    --max-lotes=*)   MAX_LOTES="${arg#*=}" ;;
    --dry-run)       DRY_RUN=1 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 1 ;;
  esac
done
[ -n "$TENANT" ] || { echo "falta --tenant=<slug>" >&2; exit 1; }

RAIZ="${SPHARMMT_ROOT:-/opt/spharmmt}"
COMPOSE_DIR="${RAIZ}/docker/compose"
ENV_PLATFORM="${RAIZ}/docker/env/platform.env"
ENV_STACK="${RAIZ}/docker/env/stack.env"
LOG_DIR="${RAIZ}/logs/backlog-${TENANT}-$(date -u +%Y%m%d)"
INDICE="${LOG_DIR}/indice.tsv"
DB="spharmmt_t_${TENANT}"

for f in "${COMPOSE_DIR}/docker-compose.yml" "$ENV_PLATFORM" "$ENV_STACK"; do
  [ -r "$f" ] || { echo "não consigo ler $f" >&2; exit 1; }
done
mkdir -p "$LOG_DIR" || exit 1
[ -s "$INDICE" ] || printf 'lote\tinicio\tfim\texit\tcusto\tenviados\tpropagados\tcondicionais\torfaos\treconc\tprocessaveis_depois\n' > "$INDICE"

# ─── A consulta dos processáveis ─────────────────────────────────────
#
# É a MESMA regra que a pré-selecção aplica, escrita em SQL: residual
# bruto menos os condicionais de baixa cobertura. Validada contra a
# pré-selecção real do silveira — deu 16 223 dos dois lados.
#
# Os opacos fora de SEM_UTILIZACOES não são calculáveis em SQL
# (`nomeOpaco()` é código) e ficam por subtrair. Eram 7 em 16 223. Por
# isso o critério de paragem é `<= MARGEM_OPACOS`, e não `= 0`: exigir
# zero exacto a um número que sabemos ter um resto conhecido seria
# programar um ciclo infinito.
MARGEM_OPACOS=25

sql_processaveis() {
  cat <<'SQL'
with cob as (
  select c1.nome as n1, c2.nome as n2, count(*) as pop,
         count(*) filter (where exists (select 1 from "ProdutoUtilizacao" pu where pu."produtoId"=p.id)) as com
    from "Produto" p join "Classificacao" c2 on c2.id=p."classificacaoNivel2Id"
    left join "Classificacao" c1 on c1.id=p."classificacaoNivel1Id"
   where p.cnp>=2000000 and c2.nome not ilike 'Outros %' group by 1,2),
excl as (select n1||' > '||n2 as chave from cob where pop>=30 and 100.0*com/pop < 2),
res as (
  select coalesce(c1.nome,'-')||' > '||coalesce(c2.nome,'-') as chave,
         case when p."classificacaoNivel2Id" is null then 'NAO_CLASSIFICADO'
              when c2.nome ilike 'Outros %' then 'OUTROS_MEDICAMENTOS' else 'SEM_UTILIZACOES' end as estrato
    from "Produto" p
    left join "Classificacao" c1 on c1.id=p."classificacaoNivel1Id"
    left join "Classificacao" c2 on c2.id=p."classificacaoNivel2Id"
   where p.cnp>=2000000 and p."validadoManualmente"=false
     and (p."classificacaoNivel2Id" is null or c2.nome ilike 'Outros %'
          or not exists (select 1 from "ProdutoUtilizacao" pu where pu."produtoId"=p.id))
     and not exists (select 1 from "KnowledgeEnrichmentCache" k
                      where k.cnp=p.cnp and k.versao='ke-2.0' and k.modelo='claude-opus-5'))
select count(*) - count(*) filter (where estrato='SEM_UTILIZACOES' and chave in (select chave from excl))
  from res;
SQL
}

processaveis() {
  sql_processaveis | docker exec -i spharmmt-postgres psql -U postgres -d "$DB" -tAc "$(cat)" 2>/dev/null | tr -d ' \r'
}

# ─── Extracção do relatório ──────────────────────────────────────────
#
# Um valor que não se consiga ler devolve "?" — e "?" pára a série. Nunca
# devolver 0 por omissão: um zero inventado passa por todas as guardas.
extrai() { grep -oE "$2" "$1" | head -1 | grep -oE '[0-9]+([.][0-9]+)?' | head -1; }
num_ou_interrogacao() { local v; v=$(extrai "$1" "$2"); [ -n "$v" ] && printf '%s' "$v" || printf '?'; }

# ─── Trava de concorrência ───────────────────────────────────────────
#
# Dois `knowledge-enrich` do mesmo tenant ao mesmo tempo não corrompem
# nada — os upserts são idempotentes — mas duplicam chamadas pagas sobre
# os mesmos produtos, porque ambos leem o residual antes de qualquer um
# escrever. É dinheiro deitado fora, e é evitável com um ficheiro.
LOCK="${LOG_DIR}/.lock"
if ! ( set -o noclobber; echo "$$ $(date -u +%FT%TZ)" > "$LOCK" ) 2>/dev/null; then
  echo "JÁ HÁ UMA SÉRIE A CORRER (lock: $LOCK — $(cat "$LOCK" 2>/dev/null))" >&2
  echo "Se tiveres a certeza de que não, apaga o ficheiro e volta a correr." >&2
  exit 1
fi
limpar() { rm -f "$LOCK"; }
trap limpar EXIT INT TERM

# Um lote do MESMO tenant já em voo, lançado à mão, é o outro caminho
# para a mesma duplicação.
if docker ps --filter name=spharmmt-migrate-run --format '{{.Names}}' | grep -q .; then
  echo "HÁ UM CONTAINER migrate A CORRER. Esperar que termine." >&2
  exit 1
fi

# ─── Custo já gasto hoje ─────────────────────────────────────────────
# Somado dos ÍNDICES, não dos logs: o índice só recebe um custo depois de
# o lote ter fechado bem, portanto um lote abortado não conta duas vezes.
custo_acumulado() {
  awk -F'\t' 'NR>1 && $5 ~ /^[0-9.]+$/ {s+=$5} END {printf "%.4f", s+0}' "$INDICE"
}

echo "═══════════════════════════════════════════════════════════════"
echo " backlog ${TENANT} · lotes de ${LIMITE} · tecto/lote \$${TECTO_LOTE} · tecto total \$${TECTO_TOTAL}"
echo " logs: ${LOG_DIR}"
echo " já gasto nesta série: \$$(custo_acumulado)"
echo "═══════════════════════════════════════════════════════════════"

RESTAM=$(processaveis)
case "$RESTAM" in ''|*[!0-9]*) echo "não consegui contar os processáveis — parar." >&2; exit 1 ;; esac
echo "processáveis agora: ${RESTAM}"

LOTE=$(awk -F'\t' 'NR>1 && $1 ~ /^[0-9]+$/ {n=$1} END {print n+0}' "$INDICE")

while :; do
  if [ "$RESTAM" -le "$MARGEM_OPACOS" ]; then
    echo ""
    echo "CONCLUÍDO: processáveis = ${RESTAM} (<= margem de ${MARGEM_OPACOS} opacos não calculáveis em SQL)."
    echo "Os condicionais ficam no residual por desenho e não são backlog."
    exit 0
  fi

  GASTO=$(custo_acumulado)
  if awk -v g="$GASTO" -v t="$TECTO_TOTAL" -v l="$TECTO_LOTE" 'BEGIN{exit !(g+l > t)}'; then
    echo ""
    echo "PARAR: \$${GASTO} gastos + \$${TECTO_LOTE} do lote seguinte passaria o tecto de \$${TECTO_TOTAL}."
    echo "Ainda faltam ${RESTAM} processáveis. Subir --tecto-total para continuar."
    exit 2
  fi

  LOTE=$((LOTE + 1))
  if [ "$LOTE" -gt "$MAX_LOTES" ]; then
    echo "PARAR: atingido --max-lotes=${MAX_LOTES} com ${RESTAM} processáveis por fazer." >&2
    exit 2
  fi

  N=$(printf '%02d' "$LOTE")
  LOG="${LOG_DIR}/lote${N}.log"
  INICIO=$(date -u +'%Y-%m-%d %H:%M:%S')
  echo ""
  echo "── lote ${N} ── ${INICIO}Z ── ${RESTAM} processáveis ── \$${GASTO} gastos ──"

  if [ "$DRY_RUN" = "1" ]; then
    echo "  (--dry-run: não lanço nada)"
    exit 0
  fi

  ( cd "$COMPOSE_DIR" && docker compose \
      -f docker-compose.yml -p spharmmt --profile tools \
      --env-file "$ENV_PLATFORM" --env-file "$ENV_STACK" \
      run --rm -T migrate \
      npm run catalog:knowledge-enrich -- \
        "--tenant=${TENANT}" --apply "--limite=${LIMITE}" "--tecto-usd=${TECTO_LOTE}" --sem-relatorio
  ) > "$LOG" 2>&1
  EXIT=$?
  FIM=$(date -u +'%Y-%m-%d %H:%M:%S')

  CUSTO=$(num_ou_interrogacao "$LOG" 'estimado: \$[0-9.]+')
  ENVIADOS=$(num_ou_interrogacao "$LOG" '[0-9]+  ENVIADOS AO MODELO')
  PROPAGADOS=$(num_ou_interrogacao "$LOG" '[0-9]+  propagados do representante')
  ORFAOS=$(num_ou_interrogacao "$LOG" '[0-9]+  dependentes sem decisão')
  CONDIC=$(awk '/CONDICIONAIS:/ {for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/) {s+=$i; break}} END {print s+0}' "$LOG")
  if grep -q 'ok  fecha: tudo o que foi lido tem destino nomeado' "$LOG"; then RECONC=ok; else RECONC=FALHOU; fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t' \
    "$LOTE" "$INICIO" "$FIM" "$EXIT" "$CUSTO" "$ENVIADOS" "$PROPAGADOS" "$CONDIC" "$ORFAOS" "$RECONC" >> "$INDICE"

  echo "  exit=${EXIT} custo=\$${CUSTO} enviados=${ENVIADOS} propagados=${PROPAGADOS} condicionais=${CONDIC} orfaos=${ORFAOS} reconc=${RECONC}"

  # ─── Guardas. Qualquer uma pára a série. ───────────────────────────
  PARAR=""
  case "$EXIT" in
    0) : ;;
    3) PARAR="falha de INFRAESTRUTURA (saldo, credencial, 429/5xx, rede) — ver o log" ;;
    2) PARAR="RECONCILIAÇÃO não fechou — há produtos lidos sem destino" ;;
    *) PARAR="exit code ${EXIT}" ;;
  esac
  [ -z "$PARAR" ] && [ "$RECONC" != "ok" ] && PARAR="reconciliação não confirmada no relatório"
  [ -z "$PARAR" ] && grep -q 'SEM destino contabilizado' "$LOG" && PARAR="o relatório acusa produtos sem destino"
  [ -z "$PARAR" ] && grep -q 'FALHA DE INFRAESTRUTURA' "$LOG" && PARAR="falha de infraestrutura no relatório"
  case "$CUSTO$ENVIADOS$PROPAGADOS$ORFAOS" in
    *'?'*) [ -z "$PARAR" ] && PARAR="não consegui ler um dos números do relatório" ;;
  esac
  if [ -z "$PARAR" ] && awk -v c="$CUSTO" -v t="$TECTO_LOTE" 'BEGIN{exit !(c > t)}'; then
    PARAR="custo do lote \$${CUSTO} acima do tecto \$${TECTO_LOTE}"
  fi
  # Órfãos só são aceitáveis com causa declarada: sem resposta do modelo
  # há-de haver um aviso ou um corte por tecto que o explique.
  if [ -z "$PARAR" ] && [ "$ORFAOS" != "0" ] && [ "$ORFAOS" != "?" ]; then
    if ! grep -qE 'CORTADA ao atingir o tecto|── avisos' "$LOG"; then
      PARAR="${ORFAOS} órfãos SEM causa declarada no relatório"
    else
      echo "  aviso: ${ORFAOS} órfãos, com causa declarada — voltam no lote seguinte"
    fi
  fi

  ANTES="$RESTAM"
  RESTAM=$(processaveis)
  case "$RESTAM" in ''|*[!0-9]*) RESTAM="$ANTES"; [ -z "$PARAR" ] && PARAR="não consegui recontar os processáveis" ;; esac
  printf '%s\n' "$RESTAM" >> "$INDICE"
  echo "  processáveis: ${ANTES} → ${RESTAM}  (−$((ANTES - RESTAM)))"

  # Um lote que não faz progresso e não se queixa é o modo de falha que
  # ninguém vê: a série ficaria a lançar lotes vazios até ao tecto.
  if [ -z "$PARAR" ] && [ "$RESTAM" -ge "$ANTES" ]; then
    PARAR="o lote não reduziu os processáveis (${ANTES} → ${RESTAM})"
  fi

  if [ -n "$PARAR" ]; then
    echo ""
    echo "═══ SÉRIE PARADA no lote ${N} ═══"
    echo "  motivo: ${PARAR}"
    echo "  log:    ${LOG}"
    echo "  índice: ${INDICE}"
    echo "  Nada ficou por retomar: voltar a correr continua nos processáveis que restam."
    exit 2
  fi
done
