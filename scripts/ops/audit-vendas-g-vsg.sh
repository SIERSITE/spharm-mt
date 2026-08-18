#!/usr/bin/env bash
#
# scripts/ops/audit-vendas-g-vsg.sh
#
# Auditoria READ-ONLY do universo de vendas: series G e VSG.
#
# ── PORQUE EXISTE ────────────────────────────────────────────────────
#
# O relatorio de Vendas nao mostra facturas da serie VSG. O leitor de
# vendas do agent (agent/src/commands/daily-sync-runner.ts, SALES_SQL)
# le exclusivamente:
#
#     FROM [dbo].[Atendimento] a
#     JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
#
# enquanto o pipeline de movimentos le dbo.StocksMov — o livro-razao
# universal de stock — e apanha tambem as linhas cuja FK e
# [Atendimento Susp Detalhe ID] ou [Atendimento Credito Detalhe ID].
# Dai a assimetria: o movimento VSG existe no ledger e a venda nao
# existe no raw.
#
# Este script NAO corrige nada. Estabelece, a partir dos dados, a
# correspondencia entre serie documental e tabela de origem — que NAO e
# assumida em lado nenhum aqui — e mede o impacto.
#
# REGRA FUNCIONAL CONFIRMADA pelo negocio, e que o modelo canonico tera
# de respeitar (nao esta implementada):
#
#     Factura G      = VENDA
#     Factura VSG    = VENDA
#     NC/anulacao G  = DEVOLUCAO_ANULACAO
#     NC/anulacao VSG= DEVOLUCAO_ANULACAO
#
# "Suspensa" e o nome do circuito documental, nao uma exclusao do
# universo de vendas.
#
# ── GARANTIAS ────────────────────────────────────────────────────────
#
#   . so SELECT — nenhum INSERT/UPDATE/DELETE/ALTER
#   . default_transaction_read_only=on imposto pelo servidor
#   . SEM transaccao: uma query que falhe NAO trava as seguintes
#     (foi um BEGIN implicito que travou uma auditoria anterior no
#     primeiro erro de sintaxe)
#   . nao mexe em feature flags, nao corre ingestao, nao corre migrations
#
# ── USO ──────────────────────────────────────────────────────────────
#
#   bash scripts/ops/audit-vendas-g-vsg.sh
#
# Sem argumentos. A base e fixa (ver DB_NOME abaixo) e o script recusa
# correr se ela nao existir — uma auditoria que acerta na base errada e
# pior do que nenhuma.

set -u

DB_NOME="spharmmt_t_silveira"
CARIMBO="$(date +%F-%H%M%S)"
OUT="/tmp/spharmmt-vendas-g-vsg-${CARIMBO}.txt"

# Janela de analise. Alteravel por ambiente para repetir a auditoria
# noutro periodo sem editar o ficheiro.
DIA="${DIA:-2026-08-01}"
DIA_SEGUINTE="${DIA_SEGUINTE:-2026-08-02}"
MES_INICIO="${MES_INICIO:-2026-08-01}"
MES_FIM="${MES_FIM:-2026-09-01}"
ANO_INICIO="${ANO_INICIO:-2026-01-01}"

# ── 1. Container do PostgreSQL ───────────────────────────────────────
PGC="$(docker ps --format '{{.Names}}\t{{.Image}}' \
        | awk -F'\t' '$2 ~ /^postgres:/ {print $1; exit}')"
if [ -z "${PGC}" ]; then
  PGC="spharmmt-postgres"
fi
if ! docker ps --format '{{.Names}}' | grep -qx "${PGC}"; then
  echo "X container PostgreSQL nao encontrado (tentei '${PGC}')."
  echo "  Containers a correr:"
  docker ps --format '  {{.Names}}  {{.Image}}'
  exit 1
fi

# ── 2. A base tem de existir ─────────────────────────────────────────
EXISTE="$(docker exec -i "${PGC}" psql -U postgres -tAc \
          "SELECT 1 FROM pg_database WHERE datname = '${DB_NOME}'" \
          | tr -d '[:space:]')"
if [ "${EXISTE}" != "1" ]; then
  echo "X a base '${DB_NOME}' nao existe neste cluster."
  echo "  Bases disponiveis:"
  docker exec -i "${PGC}" psql -U postgres -tAc \
    "SELECT '  ' || datname FROM pg_database WHERE datname LIKE 'spharmmt%' ORDER BY 1"
  exit 1
fi

echo "container : ${PGC}"
echo "base      : ${DB_NOME}"
echo "dia       : ${DIA} (ate ${DIA_SEGUINTE}, exclusivo)"
echo "mes       : ${MES_INICIO} .. ${MES_FIM} (exclusivo)"
echo "output    : ${OUT}"
echo

# ── 3. A auditoria ───────────────────────────────────────────────────
#
# `-v` passa os limites da janela ao psql; dentro do SQL usam-se como
# :'dia' (com plicas), que o psql expande como literal.
docker exec -i \
  -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=300000' \
  "${PGC}" psql -U postgres -d "${DB_NOME}" \
  --no-psqlrc -P pager=off \
  -v dia="${DIA}" -v dia_seg="${DIA_SEGUINTE}" \
  -v mes_ini="${MES_INICIO}" -v mes_fim="${MES_FIM}" \
  -v ano_ini="${ANO_INICIO}" <<'SQL' 2>&1 | tee "${OUT}"

\echo '\n=== B0 . contexto e prova de read-only ==========================='
SHOW default_transaction_read_only;
SELECT current_database() AS base, current_user AS utilizador, now() AS agora;
SELECT nome, estado, "useMovimentosCanonical" AS flag_canonica
  FROM "Farmacia" ORDER BY nome;

\echo '\n=== B1 . O MAPA . farmacia x serie x tipoDoc x tabela de origem ==='
\echo '    Nada aqui assume correspondencia serie <-> tabela: e esta'
\echo '    query que a estabelece. Por farmacia, porque as duas'
\echo '    instalacoes ERP podem numerar e classificar de forma diferente.'
SELECT f.nome                                             AS farmacia,
       split_part(m."documentoNumero",'/',1)              AS serie,
       COALESCE(m."tipoDocumentoId"::text,'(nulo)')       AS tipo_doc_erp,
       CASE
         WHEN m."externalDetalheId"          IS NOT NULL THEN 'Atendimento Detalhe'
         WHEN m."externalCreditoDetalheId"   IS NOT NULL THEN 'Atendimento Credito Detalhe'
         WHEN m."externalSuspDetalheId"      IS NOT NULL THEN 'Atendimento Susp Detalhe'
         WHEN m."externalRecpDetalheId"      IS NOT NULL THEN 'Recepcao Detalhe'
         WHEN m."externalDevolucaoDetalheId" IS NOT NULL THEN 'Devolucao Detalhe'
         WHEN m."externalMovStocksDetId"     IS NOT NULL THEN 'tblMovStocksDet'
         ELSE '(sem FK)' END                              AS tabela_origem,
       m.tipo::text                                       AS tipo_atribuido,
       m."documentoTipo"                                  AS doc_tipo,
       count(*)                                           AS movimentos,
       count(*) FILTER (WHERE m.quantidade > 0)           AS n_positivos,
       count(*) FILTER (WHERE m.quantidade < 0)           AS n_negativos,
       SUM(m.quantidade)                                  AS unidades_assinadas,
       SUM(COALESCE(m."valorLinha",0))                    AS valor
  FROM "MovimentoArtigo" m
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."dataMovimento" >= :'mes_ini'::timestamp
   AND m."dataMovimento" <  :'mes_fim'::timestamp
 GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4;

\echo '\n=== B2 . SEMANTICA DOS SINAIS . por farmacia, desde o ano ========='
\echo '    Estabelece empiricamente o que cada tipoDocumentoId faz ao'
\echo '    saldo, ANTES de se chamar NC/anulacao a seja o que for.'
SELECT f.nome                                        AS farmacia,
       split_part(m."documentoNumero",'/',1)         AS serie,
       COALESCE(m."tipoDocumentoId"::text,'(nulo)')  AS tipo_doc_erp,
       m."documentoTipo"                             AS doc_tipo,
       m.tipo::text                                  AS tipo_atribuido,
       CASE WHEN m.quantidade >= 0 THEN 'ENTRADA' ELSE 'SAIDA' END AS sinal,
       count(*)                                      AS movimentos,
       SUM(m.quantidade)                             AS unidades,
       min(m."documentoNumero")                      AS exemplo_min,
       max(m."documentoNumero")                      AS exemplo_max
  FROM "MovimentoArtigo" m
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."dataMovimento" >= :'ano_ini'::timestamp
   AND (m."externalDetalheId" IS NOT NULL
     OR m."externalCreditoDetalheId" IS NOT NULL
     OR m."externalSuspDetalheId" IS NOT NULL)
 GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,6;

\echo '\n=== B3 . VSG/54688 e VSG/54684, campo a campo ===================='
SELECT f.nome AS farmacia, m."documentoNumero", m."documentoTipo", m."dataMovimento",
       p.cnp, p.designacao,
       m.quantidade, m."existenciaApos", m."precoUnitario", m."valorLinha",
       m."tipoDocumentoId", m.tipo::text AS tipo_atribuido,
       m."externalSaleId", m."externalDetalheId",
       m."externalSuspDetalheId", m."externalCreditoDetalheId",
       m."contraparteNome"
  FROM "MovimentoArtigo" m
  JOIN "Produto" p  ON p.id = m."produtoId"
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."documentoNumero" IN ('VSG/54688','VSG/54684')
 ORDER BY m."documentoNumero";

\echo '\n=== B3b . uma factura G do mesmo dia, para comparar =============='
SELECT f.nome AS farmacia, m."documentoNumero", m."dataMovimento", p.cnp,
       m.quantidade, m."tipoDocumentoId", m.tipo::text AS tipo_atribuido,
       m."externalSaleId", m."externalDetalheId",
       m."externalSuspDetalheId", m."externalCreditoDetalheId"
  FROM "MovimentoArtigo" m
  JOIN "Produto" p  ON p.id = m."produtoId"
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
 WHERE m."documentoNumero" LIKE 'G/%'
   AND m."dataMovimento" >= :'dia'::timestamp
   AND m."dataMovimento" <  :'dia_seg'::timestamp
 ORDER BY m."dataMovimento" LIMIT 5;

\echo '\n=== B4 . COBERTURA DA CHAVE RAW ACTUAL ==========================='
\echo '    Tres estados, e a distincao importa:'
\echo '      CORRELACIONADO      - a chave alcanca e encontrou linha raw'
\echo '      AUSENTE_NO_RAW      - a chave alcanca e NAO encontrou (perda real)'
\echo '      NAO_CORRELACIONAVEL - externalDetalheId e NULL: a chave actual'
\echo '                            (farmaciaId, externalSaleLineId) e incapaz'
\echo '                            por construcao. Nao afirma ausencia;'
\echo '                            afirma que por aqui nao se sabe.'
SELECT to_char(m."dataMovimento",'YYYY-MM')          AS mes,
       f.nome                                        AS farmacia,
       split_part(m."documentoNumero",'/',1)         AS serie,
       CASE
         WHEN m."externalCreditoDetalheId" IS NOT NULL THEN 'Credito Detalhe'
         WHEN m."externalSuspDetalheId"    IS NOT NULL THEN 'Susp Detalhe'
         WHEN m."externalDetalheId"        IS NOT NULL THEN 'Atendimento Detalhe'
         ELSE '(outro)' END                          AS tabela_origem,
       CASE
         WHEN m."externalDetalheId" IS NULL THEN 'NAO_CORRELACIONAVEL'
         WHEN r.id IS NOT NULL              THEN 'CORRELACIONADO'
         ELSE                                    'AUSENTE_NO_RAW'
       END                                           AS estado,
       count(*)                                      AS linhas,
       SUM(ABS(m.quantidade))                        AS unidades,
       SUM(COALESCE(m."valorLinha",0))               AS euros,
       count(DISTINCT m."produtoId")                 AS produtos,
       count(DISTINCT m."externalSaleId")            AS documentos
  FROM "MovimentoArtigo" m
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
  LEFT JOIN "IngestVendaLinhaRaw" r
         ON r."farmaciaId" = m."farmaciaId"
        AND r."externalSaleLineId" = m."externalDetalheId"
 WHERE (m."externalDetalheId" IS NOT NULL
     OR m."externalCreditoDetalheId" IS NOT NULL
     OR m."externalSuspDetalheId" IS NOT NULL)
 GROUP BY 1,2,3,4,5 ORDER BY 1 DESC, 2, 3, 5;

\echo '\n=== B5 . COLISAO DE IDs entre namespaces . a chave chega? ========='
SELECT 'externalDetalheId' AS namespace, count(*) AS linhas,
       min("externalDetalheId") AS id_min, max("externalDetalheId") AS id_max
  FROM "MovimentoArtigo" WHERE "externalDetalheId" IS NOT NULL
UNION ALL SELECT 'externalSuspDetalheId', count(*),
       min("externalSuspDetalheId"), max("externalSuspDetalheId")
  FROM "MovimentoArtigo" WHERE "externalSuspDetalheId" IS NOT NULL
UNION ALL SELECT 'externalCreditoDetalheId', count(*),
       min("externalCreditoDetalheId"), max("externalCreditoDetalheId")
  FROM "MovimentoArtigo" WHERE "externalCreditoDetalheId" IS NOT NULL;

\echo '    ...e as colisoes REAIS, por farmacia (os tres pares):'
SELECT f.nome AS farmacia,
       (SELECT count(*) FROM (
          SELECT "externalDetalheId" AS id FROM "MovimentoArtigo"
           WHERE "farmaciaId" = f.id AND "externalDetalheId" IS NOT NULL
          INTERSECT
          SELECT "externalSuspDetalheId" FROM "MovimentoArtigo"
           WHERE "farmaciaId" = f.id AND "externalSuspDetalheId" IS NOT NULL) x)
         AS detalhe_x_susp,
       (SELECT count(*) FROM (
          SELECT "externalDetalheId" AS id FROM "MovimentoArtigo"
           WHERE "farmaciaId" = f.id AND "externalDetalheId" IS NOT NULL
          INTERSECT
          SELECT "externalCreditoDetalheId" FROM "MovimentoArtigo"
           WHERE "farmaciaId" = f.id AND "externalCreditoDetalheId" IS NOT NULL) x)
         AS detalhe_x_credito,
       (SELECT count(*) FROM (
          SELECT "externalSuspDetalheId" AS id FROM "MovimentoArtigo"
           WHERE "farmaciaId" = f.id AND "externalSuspDetalheId" IS NOT NULL
          INTERSECT
          SELECT "externalCreditoDetalheId" FROM "MovimentoArtigo"
           WHERE "farmaciaId" = f.id AND "externalCreditoDetalheId" IS NOT NULL) x)
         AS susp_x_credito
  FROM "Farmacia" f WHERE f.estado = 'ATIVO' ORDER BY 1;

\echo '\n=== B6 . os 11 CNPs do dia, com origem e estado =================='
WITH alvo(cnp) AS (VALUES (3626884),(3742780),(5002639),(5304472),(5667761),
  (5674239),(5736335),(7888784),(7888800),(9599258),(9629113))
SELECT p.cnp, f.nome AS farmacia, m."documentoNumero",
       split_part(m."documentoNumero",'/',1) AS serie,
       m."tipoDocumentoId" AS tipo_doc, m.tipo::text AS tipo_atribuido,
       m.quantidade, m."valorLinha",
       CASE
         WHEN m."externalCreditoDetalheId" IS NOT NULL THEN 'Credito Detalhe'
         WHEN m."externalSuspDetalheId"    IS NOT NULL THEN 'Susp Detalhe'
         WHEN m."externalDetalheId"        IS NOT NULL THEN 'Atendimento Detalhe'
         ELSE '(outro)' END AS tabela_origem,
       CASE
         WHEN m."externalDetalheId" IS NULL THEN 'NAO_CORRELACIONAVEL'
         WHEN r.id IS NOT NULL              THEN 'CORRELACIONADO'
         ELSE                                    'AUSENTE_NO_RAW'
       END AS estado
  FROM alvo a
  JOIN "Produto" p ON p.cnp = a.cnp
  JOIN "MovimentoArtigo" m ON m."produtoId" = p.id
  JOIN "Farmacia" f ON f.id = m."farmaciaId"
  LEFT JOIN "IngestVendaLinhaRaw" r
         ON r."farmaciaId" = m."farmaciaId"
        AND r."externalSaleLineId" = m."externalDetalheId"
 WHERE m."dataMovimento" >= :'dia'::timestamp
   AND m."dataMovimento" <  :'dia_seg'::timestamp
 ORDER BY p.cnp, f.nome;

\echo '\n=== B6b . os mesmos 11 CNPs, pelo lado do raw ===================='
WITH alvo(cnp) AS (VALUES (3626884),(3742780),(5002639),(5304472),(5667761),
  (5674239),(5736335),(7888784),(7888800),(9599258),(9629113))
SELECT p.cnp, f.nome AS farmacia, count(r.id) AS linhas_raw,
       string_agg(DISTINCT COALESCE(r."tipoDocumento"::text,'(nulo)'), ',') AS tipo_doc,
       string_agg(DISTINCT r."tipoDocumentoClass", ',')                     AS classe_gravada,
       bool_or(r."isNonStockService")                                       AS algum_servico,
       SUM(COALESCE(r.quantidade,0))                                        AS quantidade
  FROM alvo a
  JOIN "Produto" p ON p.cnp = a.cnp
  LEFT JOIN "IngestVendaLinhaRaw" r
         ON r."produtoId" = p.id
        AND r."dataVenda" >= :'dia'::timestamp
        AND r."dataVenda" <  :'dia_seg'::timestamp
  LEFT JOIN "Farmacia" f ON f.id = r."farmaciaId"
 GROUP BY p.cnp, f.nome ORDER BY p.cnp, f.nome;

\echo '\n=== FIM =========================================================='
SQL

echo
echo "Guardado em: ${OUT}"
