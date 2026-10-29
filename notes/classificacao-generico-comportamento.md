# Comportamento do `Generico` (agent -> SaaS -> Produto)

Analise estatica (sem SQL, sem ERP). Worktree `classificacao-erp`, branch
`feat/classificacao-erp-produtos`. Caminhos reais: o agent vive em
`agent/src/commands/` (nao `agent/src/`). "nao verificado" = nao provado pelo codigo.

## 1. Agent

- Leitura SQL: `s.[Generico] AS generico` em
  `agent/src/commands/bootstrap-upload.ts:759` (bootstrap/products-upload),
  `agent/src/commands/daily-sync-runner.ts:347` (sync diario) e
  `agent/src/commands/bootstrap-dry-run.ts:286` (dry-run).
- Conversao: `boolOrNull` (`bootstrap-upload.ts:210-215`, `daily-sync-runner.ts:168`,
  `bootstrap-dry-run.ts:120`): `null/undefined -> null`, boolean -> igual,
  numero -> `!== 0`, qualquer outro tipo -> `null`.
- Payload: `generico: boolOrNull(r.generico)` em `bootstrap-upload.ts:804`,
  `daily-sync-runner.ts:472` (`rowToProductPayload`, usado em `:512`) e
  `bootstrap-dry-run.ts:313`. A chave `generico` e SEMPRE incluida; NULL do ERP
  vai como `null` (nao e omitida, nao e `false`). Que o serializador
  (`agent/src/http-client.ts:473-478`) mantem `null` no JSON: nao verificado
  (JSON.stringify mantem null; so descartaria `undefined`).
- Os dois caminhos (bootstrap e diario) chamam `client.bootstrapProducts`
  -> `POST /api/ingest/v1/bootstrap/products` (`bootstrap-upload.ts:818`,
  `daily-sync-runner.ts:518`). Nao ha outra rota de produtos que leia `generico`
  (grep `flagGenerico`/`generico` em `app/` e `lib/ingest`).
- `agent/src/classificacao-auditoria.ts` (auditoria, nao ingestao) ja le a
  coluna com perfil NULL/0/1 (`:1003-1025`).

## 2. Servidor

- Rota `app/api/ingest/v1/bootstrap/products/route.ts`:
  `flagGenerico: asBoolOrFalse(raw.generico)` (`:265`). `asBoolOrFalse`
  (`lib/ingest/bootstrap.ts:219-228`): `null/undefined -> false`. Logo, para
  `flagGenerico`, NULL e AUSENTE colapsam em `false`.
- Em paralelo, `lerClassificacaoErpDoPayload(raw)` (`route.ts:280`;
  `lib/ingest/classificacao-erp.ts:67-71`) le a MESMA chave `generico` em
  tri-estado: ausente -> nao toca; `null`/"" -> NULL; 0/1/true/false -> bool;
  resto -> NULL e conta em `valoresDesconhecidos`.
- Escrita de `flagGenerico`: `lib/ingest/bulk.ts:223-226` (ON CONFLICT):
  `CASE WHEN 'flagGenerico' = ANY("Produto"."camposManuais") THEN atual ELSE
  EXCLUDED."flagGenerico" END`. Sem COALESCE: `false` (vindo de NULL, ausente
  ou 0) sobrescreve um `true` existente, salvo camposManuais. INSERT em `:206-211`.
  Chamado por `lib/ingest/designacao-silveira.ts:379` e `:402`
  (`upsertProdutosComDesignacao`), sem tratamento proprio de `flagGenerico`.
- Caminho de recurso (bulk falhou): `route.ts:521`
  `flagGenerico: manual.has("flagGenerico") ? undefined : a.flagGenerico`
  (camposManuais lido em `:493-497`). Mesma protecao.
- Escrita de `genericoErp` (coluna nova, `prisma/schema.prisma:369`, migration
  `20261028120000_produto_classificacao_erp/migration.sql:19`):
  `lib/ingest/classificacao-erp.ts:107-115`, `UPDATE ... WHERE NOT
  ('genericoErp' = ANY(p."camposManuais")) AND p."genericoErp" IS DISTINCT FROM
  v.val`. Invocada em `route.ts:359` (bulk) e `:588` (recurso); falha nao derruba o
  lote (`route.ts:673-692`).
- camposManuais: `Produto.camposManuais String[] @default([])`
  (`prisma/schema.prisma:410`, TEXT[] NOT NULL DEFAULT '{}'; migration
  `20260915090000_ficha_manual_proveniencia`). A marca e o nome do campo como
  elemento do array. Fichas manuais marcam `"flagGenerico"` quando
  `flagGenerico === true` (`lib/produtos/criar-produto.ts:178`); nao se
  verificou nenhum codigo que escreva `"genericoErp"` em camposManuais (so o
  comentario do schema e a protecao no UPDATE).
- Idempotencia: `genericoErp` -> reenvio identico nao escreve nada (IS DISTINCT
  FROM). `flagGenerico` -> reenvio reescreve o mesmo valor, e o upsert faz sempre
  `"dataAtualizacao" = now()` (`bulk.ts:240`): idempotente nos dados, nao no timestamp.
- Agent ANTIGO sem `generico`: `asBoolOrFalse(undefined)=false` -> `bulk.ts:225`
  poe `flagGenerico=false` (apaga um `true`, exceto camposManuais). `genericoErp`
  nao e tocado (chave ausente, `classificacao-erp.ts:69`). Se algum agent em
  producao omite a chave: nao verificado (rev dos agents instalados).

## 3. Conclusao

Factos de codigo: `Produto.flagGenerico` e NOT NULL e o servidor converte NULL/ausente em
`false` (`route.ts:265`), por isso, a nivel de CODIGO, `flagGenerico` nao distingue NULL de 0
e um agent antigo que omita `generico` apagaria um `true` (salvo camposManuais). Existe na
branch um `Produto.genericoErp` tri-estado PROVISORIO (commit 63d27e6, `schema.prisma:369`),
que a decisao funcional actual NAO exige.

Factos de dados (diagnostico v1, Silveirense; dado fornecido pelo utilizador, nao deste
codigo): `Stocks.Generico` e `bit` com NULL = 0 linhas, 0 = 15 406, 1 = 3 960. Ou seja, o
ERP da Silveirense NAO devolve NULL: o caminho `null` do agent nunca e usado ali, e
NULL-vs-0 nao se perde porque nao ha NULL. Com os agents actuais a enviarem sempre
`generico`, NAO ha lacuna demonstrada que justifique armazenamento novo (genericoErp) alem de
`Produto.flagGenerico`.

Condicoes em que HAVERIA lacuna (a medir noutras farmacias e com a matriz MT x ERP do v2):
(a) o ERP de alguma farmacia devolve NULL em `Generico` E esse NULL tem significado distinto de
0; (b) algum agent instalado omite a chave `generico` (nao verificado: rev dos agents em
producao); (c) divergencias MT.flagGenerico x ERP.Generico NAO explicaveis por `manual`
(camposManuais) nem por desfasamento de sincronizacao; (d) algum caminho de escrita ignora a
proteccao de camposManuais (nao encontrado nos caminhos lidos).
Se (a)-(d) nao se verificarem, `Produto.flagGenerico` chega e o `genericoErp` provisorio e
desnecessario.

## O que o diagnostico v2 mede para fechar isto

1. Matriz MT.flagGenerico (0/1) x ERP.Generico (NULL/0/1) por CNP existente no MT
   (ficheiro de `scripts/diagnostics/cnps-mt-readonly.sql`).
2. Contagem de NULL em `dbo.Stocks.Generico` e em `Stocks_Histo` (esta tabela nao
   e referida em `agent/src`: existencia nao verificada).
3. Dos desacordos, quantos explicados por manual (`manual=1`) e quantos nao.
4. Quantos NULL sao tratados como 0 no MT hoje (ERP NULL com `flagGenerico=0`),
   para decidir se `genericoErp` tem valor funcional na Silveirense.
