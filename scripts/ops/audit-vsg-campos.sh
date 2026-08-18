#!/usr/bin/env bash
#
# scripts/ops/audit-vsg-campos.sh
#
# O que o ledger REALMENTE guarda nas linhas de venda suspensa.
#
# ── PORQUE EXISTE ────────────────────────────────────────────────────
#
# O agent chega ao cabecalho `Atendimento` por um caminho unico
# (agent/src/commands/stocksmov.ts:727-730):
#
#     LEFT JOIN dbo.[Atendimento Detalhe] ad ON ad.[Detalhe ID] = sm.[Detalhe ID]
#     LEFT JOIN dbo.Atendimento at_        ON at_.[Atendimento ID] = ad.[Atendimento ID]
#
# Numa linha de venda suspensa, `sm.[Detalhe ID]` e NULL. Logo `ad` e
# NULL, `at_` e NULL, e TUDO o que vem do cabecalho vem vazio: serie,
# numero de documento, [Tipo Documento], entidade/cliente.
#
# As medidas, essas, vem do proprio StocksMov e devem estar la:
# quantidade, data/hora, produto, existencia, e o par
# [Preco Venda]/[Valor Venda] (stocksmov.ts:435-436) — que e o valor
# HISTORICO da linha, nao o PVP de hoje.
#
# Este script mede exactamente isso, para se decidir com numeros:
#   . o que temos para reconstruir uma venda VSG
#   . o que falta e obriga a ir ao ERP
#
# NAO corrige nada. So SELECT.
#
# ── GARANTIAS ────────────────────────────────────────────────────────
#   . default_transaction_read_only=on imposto pelo servidor
#   . SEM transaccao: uma query que falhe nao trava as seguintes
#   . nao mexe em flags, nao corre ingestao, nao corre migrations
#
# ── USO ──────────────────────────────────────────────────────────────
#   bash scripts/ops/audit-vsg-campos.sh
#
# Janela alteravel por ambiente:
#   DIA=2026-08-05 DIA_SEGUINTE=2026-08-06 bash scripts/ops/audit-vsg-campos.sh

set -u

DB_NOME="spharmmt_t_silveira"
CARIMBO="$(date +%F-%H%M%S)"
OUT="/tmp/spharmmt-vsg-campos-${CARIMBO}.txt"

DIA="${DIA:-2026-08-01}"
DIA_SEGUINTE="${DIA_SEGUINTE:-2026-08-02}"
ANO_INICIO="${ANO_INICIO:-2024-01-01}"

PGC="$(docker ps --format '{{.Names}}\t{{.Image}}' \
        | awk -F'\t' '$2 ~ /^postgres:/ {print $1; exit}')"
if [ -z "${PGC}" ]; then
  PGC="spharmmt-postgres"
fi
if ! docker ps --format '{{.Names}}' | grep -qx "${PGC}"; then
  echo "X container PostgreSQL nao encontrado (tentei '${PGC}')."
  docker ps --format '  {{.Names}}  {{.Image}}'
  exit 1
fi

EXISTE="$(docker exec -i "${PGC}" psql -U postgres -tAc \
          "SELECT 1 FROM pg_database WHERE datname = '${DB_NOME}'" \
          | tr -d '[:space:]')"
if [ "${EXISTE}" != "1" ]; then
  echo "X a base '${DB_NOME}' nao existe neste cluster. Disponiveis:"
  docker exec -i "${PGC}" psql -U postgres -tAc \
    "SELECT '  ' || datname FROM pg_database WHERE datname LIKE 'spharmmt%' ORDER BY 1"
  exit 1
fi

echo "container : ${PGC}"
echo "base      : ${DB_NOME}"
echo "dia       : ${DIA} (ate ${DIA_SEGUINTE}, exclusivo)"
echo "output    : ${OUT}"
echo

docker exec -i \
  -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=300000' \
  "${PGC}" psql -U postgres -d "${DB_NOME}" \
  --no-psqlrc -P pager=off \
  -v dia="${DIA}" -v dia_seg="${DIA_SEGUINTE}" -v ano_ini="${ANO_INICIO}" <<'SQL' 2>&1 | tee "${OUT}"

\echo '\n=== V0 . contexto ================================================'
SHOW default_transaction_read_only;
SELECT current_database() AS base, now() AS agora;

\echo '\n=== V1 . AS LINHAS SUSP DO DIA, campo a campo ===================='
\echo '    Se documentoNumero e tipoDocumentoId vierem NULL, o ledger nao'
\echo '    sabe nem a serie nem o estado fiscal — e o desenho tem de ir'
\echo '    buscar o cabecalho ao ERP.'
SELECT f.nome AS farmacia, m."dataMovimento", p.cnp, p.designacao,
       m.quantidade, m."existenciaApos",
       m."precoUnitario", m."valorLinha",
       m."documentoNumero", m."documentoTipo", m."tipoDocumentoId",
       m."externalSaleId", m."externalDetalheId", m."externalSuspDetalheId",
       m."contraparteNome", m.tipo::text AS tipo_atribuido
  FROM "MovimentoArtigo" m
  JOIN "Produto" p  ON p.id = m."produtoId"
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."externalSuspDetalheId" IS NOT NULL
   AND m."dataMovimento" >= :'dia'::timestamp
   AND m."dataMovimento" <  :'dia_seg'::timestamp
 ORDER BY f.nome, m."dataMovimento";

\echo '\n=== V2 . COMPLETUDE dos campos nas linhas Susp (desde 2024) ======'
\echo '    Quantos NAO sao nulos. E a lista do que da para reconstruir.'
SELECT f.nome                                                        AS farmacia,
       count(*)                                                      AS linhas_susp,
       count(m."documentoNumero")                                    AS com_documento,
       count(m."tipoDocumentoId")                                    AS com_tipo_doc,
       count(m."externalSaleId")                                     AS com_atendimento_id,
       count(m."contraparteNome")                                    AS com_contraparte,
       count(m."precoUnitario")                                      AS com_preco_unit,
       count(m."valorLinha")                                         AS com_valor_linha,
       count(m.quantidade)                                           AS com_quantidade,
       count(m."existenciaApos")                                     AS com_existencia,
       count(*) FILTER (WHERE m.quantidade < 0)                      AS saidas,
       count(*) FILTER (WHERE m.quantidade > 0)                      AS entradas
  FROM "MovimentoArtigo" m
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."externalSuspDetalheId" IS NOT NULL
   AND m."dataMovimento" >= :'ano_ini'::timestamp
 GROUP BY 1 ORDER BY 1;

\echo '\n=== V2b . o mesmo para as linhas de Atendimento Detalhe (G) ======'
\echo '    Serve de controlo: mostra o que o caminho que FUNCIONA tem.'
SELECT f.nome                                    AS farmacia,
       count(*)                                  AS linhas_detalhe,
       count(m."documentoNumero")                AS com_documento,
       count(m."tipoDocumentoId")                AS com_tipo_doc,
       count(m."externalSaleId")                 AS com_atendimento_id,
       count(m."contraparteNome")                AS com_contraparte,
       count(m."precoUnitario")                  AS com_preco_unit,
       count(m."valorLinha")                     AS com_valor_linha
  FROM "MovimentoArtigo" m
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."externalDetalheId" IS NOT NULL
   AND m."dataMovimento" >= :'ano_ini'::timestamp
 GROUP BY 1 ORDER BY 1;

\echo '\n=== V3 . existe ALGUM documento com serie VSG no ledger? ========='
\echo '    E, se existir, por que FK entrou.'
SELECT split_part(m."documentoNumero",'/',1) AS serie,
       CASE
         WHEN m."externalDetalheId"        IS NOT NULL THEN 'Atendimento Detalhe'
         WHEN m."externalCreditoDetalheId" IS NOT NULL THEN 'Credito Detalhe'
         WHEN m."externalSuspDetalheId"    IS NOT NULL THEN 'Susp Detalhe'
         WHEN m."externalMovStocksDetId"   IS NOT NULL THEN 'tblMovStocksDet'
         ELSE '(outro)' END                 AS tabela_origem,
       m.tipo::text                         AS tipo_atribuido,
       count(*)                             AS movimentos,
       min(m."dataMovimento")::date         AS desde,
       max(m."dataMovimento")::date         AS ate
  FROM "MovimentoArtigo" m
 WHERE m."documentoNumero" IS NOT NULL
   AND m."dataMovimento" >= :'ano_ini'::timestamp
 GROUP BY 1,2,3 ORDER BY 1,2;

\echo '\n=== V4 . os 11 CNPs do dia, so pelo lado Susp ===================='
WITH alvo(cnp) AS (VALUES (3626884),(3742780),(5002639),(5304472),(5667761),
  (5674239),(5736335),(7888784),(7888800),(9599258),(9629113))
SELECT p.cnp, f.nome AS farmacia, m."dataMovimento",
       m.quantidade, m."precoUnitario", m."valorLinha",
       m."externalSuspDetalheId", m."documentoNumero", m."tipoDocumentoId",
       m.tipo::text AS tipo_atribuido
  FROM alvo a
  JOIN "Produto" p ON p.cnp = a.cnp
  JOIN "MovimentoArtigo" m ON m."produtoId" = p.id
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."dataMovimento" >= :'dia'::timestamp
   AND m."dataMovimento" <  :'dia_seg'::timestamp
 ORDER BY p.cnp, f.nome;

\echo '\n=== V5 . IMPACTO . vendas suspensas por mes x farmacia ==========='
\echo '    Unidades e euros que nunca entraram no universo de vendas.'
SELECT to_char(m."dataMovimento",'YYYY-MM')      AS mes,
       f.nome                                    AS farmacia,
       count(*)                                  AS linhas,
       count(*) FILTER (WHERE m.quantidade < 0)  AS saidas,
       count(*) FILTER (WHERE m.quantidade > 0)  AS entradas,
       SUM(ABS(m.quantidade))                    AS unidades_abs,
       SUM(-m.quantidade)                        AS unidades_como_venda,
       SUM(COALESCE(m."valorLinha",0))           AS euros,
       count(DISTINCT m."produtoId")             AS produtos
  FROM "MovimentoArtigo" m
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."externalSuspDetalheId" IS NOT NULL
   AND m."dataMovimento" >= :'ano_ini'::timestamp
 GROUP BY 1,2 ORDER BY 1 DESC, 2;

\echo '\n=== V6 . total do dia: quanto muda o universo de vendas =========='
SELECT f.nome AS farmacia,
       SUM(CASE WHEN m."externalDetalheId"     IS NOT NULL THEN -m.quantidade ELSE 0 END) AS unid_detalhe,
       SUM(CASE WHEN m."externalSuspDetalheId" IS NOT NULL THEN -m.quantidade ELSE 0 END) AS unid_susp,
       SUM(CASE WHEN m."externalCreditoDetalheId" IS NOT NULL THEN -m.quantidade ELSE 0 END) AS unid_credito,
       SUM(CASE WHEN m."externalDetalheId"     IS NOT NULL THEN COALESCE(m."valorLinha",0) ELSE 0 END) AS eur_detalhe,
       SUM(CASE WHEN m."externalSuspDetalheId" IS NOT NULL THEN COALESCE(m."valorLinha",0) ELSE 0 END) AS eur_susp
  FROM "MovimentoArtigo" m
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."dataMovimento" >= :'dia'::timestamp
   AND m."dataMovimento" <  :'dia_seg'::timestamp
 GROUP BY 1 ORDER BY 1;

\echo '\n=== FIM =========================================================='
SQL

echo
echo "Guardado em: ${OUT}"
