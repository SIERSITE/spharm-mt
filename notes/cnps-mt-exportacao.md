# Exportacao dos CNP do MT (so leitura)

Estado: NAO foi executado; e so SELECT (transacao READ ONLY, termina em ROLLBACK).
Script: `scripts/diagnostics/cnps-mt-readonly.sql`.

## Objetivo

Dar ao diagnostico v2 a lista dos produtos que existem no MT numa farmacia
(Produto com ProdutoFarmacia dessa farmacia), para cruzar com o ERP
(`Stocks.Generico`) sem o diagnostico ligar ao Postgres.

## Comando

Uma base por tenant (`spharmmt_t_<slug>`, ver `lib/db-providers/local-postgres.ts`
e `scripts/tenancy/_shared.ts:59`); ligar a do tenant certo.

    psql "$DATABASE_URL" -v farmacia="Nome Exato" -At -f scripts/diagnostics/cnps-mt-readonly.sql > cnps-mt-silveirense.txt

`-v farmacia=` aceita o nome exato ou o id (`Farmacia.id`, cuid). Sem
correspondencia, ou com mais de uma, o script falha sem escrever linhas.

Variante `\copy` (uma linha so; `\copy` nao aceita multi-linha):

    \copy (SELECT p."cnp"::text || ';' || (COALESCE(p."flagGenerico",false))::int::text || ';' || (COALESCE('flagGenerico' = ANY(p."camposManuais"),false))::int::text FROM "Produto" p WHERE EXISTS (SELECT 1 FROM "ProdutoFarmacia" pf JOIN "Farmacia" f ON f."id"=pf."farmaciaId" WHERE pf."produtoId"=p."id" AND f."nome"='Nome Exato') ORDER BY p."cnp") TO 'cnps-mt-silveirense.txt'

A variante `\copy` NAO tem a verificacao de 0/varias farmacias: confirmar
antes que o nome e unico. Escrever `Nome Exato` literal (sem `:'farmacia'`).

## Formato do ficheiro

Sem cabecalho, ordenado por cnp. Formatos aceites pelo diagnostico:
`cnp` | `cnp;flagGenerico` | `cnp;flagGenerico;manual`. O script gera o
terceiro: `1234567;1;0`.

- `flagGenerico`: 0/1 (`Produto.flagGenerico`, NOT NULL default false).
- `manual`: 1 se `'flagGenerico'` esta em `Produto."camposManuais"` (TEXT[]).

## Uso com o diagnostico

    ... --cnps-mt-ficheiro cnps-mt-silveirense.txt

Copiar o ficheiro para a pasta do diagnostico na maquina da farmacia e correr
`.\Run-ClassificationAudit.ps1 -CnpsMtFicheiro .\cnps-mt-silveirense.txt`
(a opcao existe no pacote v2). O diagnostico NAO chama o MT: so le este ficheiro
local, consulta o ERP em blocos de ate 1000 CNPs (so SELECT agregado) e nao grava
o nome do ficheiro no relatorio. Cada farmacia = um ficheiro = um diagnostico (cada ERP e uma
farmacia). Tenants com varias farmacias: correr uma vez por farmacia.

## Suposicoes nao verificadas

- SQL nunca testado num Postgres (sintaxe revista a mao).
- Nomes de tabelas/colunas sem `@@map`/`@map` no schema, logo `"Produto"`,
  `"ProdutoFarmacia"`, `"Farmacia"` com colunas camelCase entre aspas.
- A farmacia e identificada por `Farmacia.id` ou `Farmacia.nome` (nao ha slug).
- Requer psql >= 10 (`\if`); `\gset` e `set_config` permitidos em READ ONLY.
- Protecao so de `flagGenerico`; `genericoErp` em camposManuais nao e lido.
- A base real do tenant (ex.: `spharmmt_t_silveira`) vem da memoria do projeto.
