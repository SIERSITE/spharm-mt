# Fabricantes do Garantia: o que é um grupo, como se resolve, e porquê «por CNP»

Resposta à pergunta «porque disseste "selecção resolvida por CNP"?». Escrito depois de auditar o código real (commit 44356b5 e seguintes).
Provas executáveis: `scripts/tests/test-fabricantes-grupo-resolucao-db.ts` (73 verificações) e `scripts/tests/test-auditoria-fabricantes-grupos-db.ts` (58).

## 1. O que é um «grupo»

Um `GrupoLaboratorial` é uma etiqueta curada e pesquisável (ex.: «Viatris»). **Não** é fabricante nem identidade legal e **nunca** altera `Produto.fabricanteId`.

Há duas camadas de prova, e uma tabela de resultado:

| Tabela | Significado |
|---|---|
| `GrupoLaboratorialFabricante` | O fabricante legal **inteiro** pertence ao grupo (`fabricanteId` é `@unique`: um fabricante só está num grupo). É isto que o filtro mostra como «variantes» do grupo («Viatris (3 variantes)»). |
| `FabricanteAlias` | Outras grafias de **um** fabricante; só servem para pesquisar (o alias encontra o grupo do fabricante), nunca criam pertença. |
| `GrupoLaboratorialAlias` | Termos de pesquisa do próprio grupo («Upjohn»). Também só pesquisa, excepto o nível «alias inequívoco» abaixo. |
| `RegraGrupoLaboratorialPorCnp` | Sucessão **parcial**: só este CNP pertence ao grupo, seja qual for o fabricante legal. |
| `ProdutoGrupoLaboratorial` | Resultado **já resolvido por produto** (`produtoId @unique`, um grupo por produto) e o **único** que o filtro lê. |

`ProdutoGrupoLaboratorial.origem` diz por que razão o produto está no grupo (`lib/catalog/resolver-grupo-laboratorial.ts`, por ordem de precedência):

1. `MANUAL` — prova humana (`validadoManualmente`), nunca substituída;
2. `REGRA_CNP` — regra por CNP activa e validada;
3. `FABRICANTE_INEQUIVOCO` — o `fabricanteId` do produto é membro (`GrupoLaboratorialFabricante`) do grupo;
4. `SNAPSHOT_CNP` — só **proposta** do catálogo nacional; nunca é escrita sem validação humana (passa a `MANUAL`);
5. `ALIAS_INEQUIVOCO` — o nome do fabricante bate com exactamente um alias de grupo.

O reconciliador (`lib/catalog/reconciliar-grupos-laboratoriais-garantia.ts`) escreve só 2, 3 e 5, nunca toca em `MANUAL`, e apaga/actualiza linhas automáticas desactualizadas (1/20 dos CNP por dia).

## 2. Porque falei de «CNP» e o que isso significa

**O critério de pertença é o grupo do produto (`ProdutoGrupoLaboratorial`), nunca o CNP.** O CNP é só a chave com que uma *linha* de Excessos/Transferências/Devoluções identifica o produto: a linha traz `cnp` e o nome do fabricante, não o `grupoLaboratorialId`. O resolvedor devolve CNP porque é o formato de saída já usado para filtrar linhas; é o mesmo resolvedor de Vendas/Margens/Inventário (`resolverProdutoIdsPorLaboratoriosSelecionados`), por isso as quatro listas e os três relatórios não podem divergir. «Seleção resolvida por CNP» era um atalho de linguagem enganador: o conceito é «o produto pertence ao grupo»; o CNP é a chave técnica da linha.

Antes desta mudança isso implicava **uma ida ao servidor por cada alteração da selecção** (server action) e, enquanto resolvia, `cnps=null` escondia todas as linhas. Isso foi removido (secção 5).

## 3. Consulta e nº de queries

SQL (Prisma, uma por tipo de valor seleccionado):

* `grupo:<id>` → `SELECT produtoId FROM ProdutoGrupoLaboratorial WHERE grupoLaboratorialId IN (…)`  (índice em `grupoLaboratorialId`);
* `fabricante:<id>` → `SELECT id FROM Produto WHERE fabricanteId IN (…)` (índice em `fabricanteId`) — só o fabricante, nunca os irmãos do grupo nem regras CNP;
* nome solto antigo → +1 query para o nome do grupo e, se não for grupo, +1 para fabricante;
* passagem a CNP (só no caminho de reserva do servidor): `SELECT DISTINCT cnp FROM Produto WHERE id = ANY($1) ORDER BY cnp` — **uma** query, sem lotes.

Medido com contador de eventos SQL (Postgres descartável, grupo de 10 produtos/2 fabricantes vs grupo de 1000 produtos/40 fabricantes):

| Operação | 10 produtos | 1000 produtos |
|---|---:|---:|
| `resolverProdutoIds` (grupo) | 1 | 1 |
| `resolverCnps` (grupo) | 2 | 2 |
| `resolverCnps` (2 fabricantes) | 2 | 2 |
| `resolverCnps` (40 fabricantes + grupo) | 3 | 3 |
| `resolverCnps` (nome solto de grupo) | 3 | 3 |
| pertença local de TODOS os grupos | 1 | 1 (1021 CNP) |
| opções do filtro (todas) | 8 | 8 |
| proposta de Encomenda: filtro de grupo | +1 | +1 |

Constante, independente do nº de produtos e de fabricantes: **não há N+1** (o antigo `resolverCnps` fazia `ceil(n/5000)` queries; agora 1). Nunca há uma ida ao servidor por produto.

## 4. Pontos provados (teste `…-resolucao-db.ts`)

* **Todos os produtos dos fabricantes membros entram** (A1, A5) e uma variante isolada dá só os seus (A6).
* **Produto de fabricante fora do grupo, sem regra, não entra** (A2); **fabricante de nome parecido sem prova não entra** e continua opção própria (A3, A10); nada é fuzzy.
* **Várias farmácias**: o filtro depende do produto, não da farmácia; o mesmo produto em 3 farmácias é uma linha de CNP (C1) e a proposta por farmácia traz cada produto uma vez, só os vendidos naquela farmácia (C2–C4, C6–C7).
* **Opção estável e ordenada**: ids `tipo:id`, ordem total por nome (pt-PT) → tipo → id, variantes por nome → id, sem depender da ordem da BD nem de empates (D1–D8). Acrescentei `orderBy` a todas as leituras em `carregarLaboratoriosGarantia` e o desempate em `agruparOpcoesLaboratorio` (antes, empates dependiam da ordem devolvida pela BD).
* **Outros tenants inalterados**: `laboratorios` e `pertencaGrupos` só existem em garantia; silveira/sier recebem exactamente o que recebiam.

## 5. Latência e corrida: resolução local (implementada)

A pertença é por produto (`ProdutoGrupoLaboratorial`), logo é calculável **no carregamento da página**:

* `lib/catalog/pertenca-grupos-laboratoriais.ts` → `carregarPertencaGruposPorCnp`: **um** SELECT (`ProdutoGrupoLaboratorial` ⨝ `Produto` ⨝ `GrupoLaboratorial` activo) devolve `grupoId → CNP[]` ordenado. Só as páginas de **Excessos, Transferências e Devoluções** o pedem (`getReportingFilterOptions({ comPertencaGrupos: true })`); Vendas/Margens/Inventário/Encomenda nova não pagam nada.
* `lib/reporting/filtro-laboratorio-linhas.ts` → `construirEstadoFiltroLaboratorio` (pura, síncrona): `grupo:<id>` → CNP do grupo; `fabricante:<id>` → nome do fabricante (`nomeNormalizado`, único) igual ao da linha, que vem desse mesmo campo; nome solto antigo → grupo pelo nome, senão fabricante. União (OR).
* `components/reporting/use-cnps-laboratorios.ts`: com `pertencaGrupos` presente o estado é um `useMemo`, **sem pedidos, sem estado «a resolver» e sem corrida possível** (o estado nunca é `null`). Seleccionar e limpar filtros custa 0 idas ao servidor; a página custa +1 query.
* Equivalência provada (F): para grupo, variante, fabricante fora do grupo, união, nome solto de grupo/fabricante, grupo de 1000 e id removido, as linhas que passam localmente são **exactamente** as da resolução no servidor.

**Caminho de reserva mantido** (quando a página não traz `pertencaGrupos`, p.ex. falha de carga): a server action continua a existir, mas sequenciada: `cancelado` descarta a resposta de uma selecção antiga e o resultado só vale para a `chave` actual (G2–G3). Enquanto resolve, `cnps=null` esconde linhas (comportamento antigo, só neste caminho).

**Proposta de Encomenda nova** continua a resolver no servidor porque filtra **no SQL** a proposta (`p.id = ANY(ids)`), mas só uma vez por «Gerar», nunca por clique de selecção (G10–G11): +1 query constante (10 ou 1000 produtos). O componente `encomendas-client.tsx` está órfão (nenhuma página o usa); recebeu a mesma ligação por coerência.

Custo de payload: `pertencaGrupos` envia um CNP (≈8 bytes) por produto classificado, só nas 3 páginas operacionais; para ~40 mil produtos classificados no máximo seria ~320 KB no pior caso, na prática bem menos (só produtos com grupo).

## 6. Ponto crítico: produtos de fabricantes **fora** do grupo que entram

**Existe**, e é consequência directa da semântica já aprovada (grupos-laboratoriais-garantia), não um erro novo.

Mecanismo: `ProdutoGrupoLaboratorial` inclui o produto mesmo que o seu fabricante **não** seja membro (`GrupoLaboratorialFabricante`) quando a base é:

| Origem | Base | Fabricante membro? |
|---|---|---|
| `REGRA_CNP` | regra por CNP activa e validada (sucessão parcial, ex.: um CNP da Pfizer que passou para a Viatris) | não |
| `MANUAL` | prova humana | não |
| `ALIAS_INEQUIVOCO` | nome do fabricante = um alias do grupo | não |
| `SNAPSHOT_CNP` | só se promovida a `MANUAL` | não |

Isto contraria literalmente «produtos de fabricantes fora do grupo não entram», mas é o desenho aprovado e idêntico em Vendas, Margens, Inventário e no catálogo (teste B2–B4). **Não alterei a semântica.** O teste B1/B2 demonstra-o (REGRA_CNP, MANUAL e ALIAS_INEQUIVOCO entram) e B3 prova que todos os mapas dão o mesmo conjunto.

Decisão (opção segura): comportamento por omissão **inalterado** (coerência entre mapas); a auditoria read-only passa a listar, por grupo, «incluídos cujo fabricante não é membro», com origem, validação manual e se o fabricante é membro de outro grupo, para decisão do utilizador. Se quiser excluí-los, a decisão tem de ser tomada para os 4 relatórios e o catálogo ao mesmo tempo (filtrar `ProdutoGrupoLaboratorial` por membro), porque senão as listas deixam de bater com Vendas/Margens/Inventário.

### Caso SEM base actual (transitório)

Uma linha `FABRICANTE_INEQUIVOCO` cujo fabricante **já não é membro** (membro removido, ou `fabricanteId` do produto mudou) continua a incluir o produto até a reconciliação diária por shard (1/20 dos CNP por dia) a apagar. Isto é «sem base actual», não aprovado, mas é auto-corrigido em ≤ 20 dias, e não existe na semântica de Vendas/Margens/Inventário um filtro diferente. Não o escondi no filtro (mudaria silenciosamente os três relatórios); está **identificado** no teste (B5) e a auditoria classifica-o como `obsoleto_sem_base_atual`, separado de `incluido_por_regra`. Recomendação: correr a reconciliação completa (`{ tipo: "lote" }` com todos os shards) antes de dar o assunto por fechado, ou confirmar com a auditoria na base real que o número é 0.

O caso inverso (produto de fabricante membro **fora** do grupo: sem linha, ou com prova manual/regra para outro grupo) também é listado: «produtos de membros que não estão no grupo».

## 7. Auditoria read-only para a base real

`scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts` corre **no contentor `migrate`** (comando exato em `notes/auditoria-fabricantes-garantia-comando.md`):

```
npx tsx scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts --confirmo-read-only [--tenant garantia] [--out-dir /relatorios] [--top 15]
```

* Exige `--confirmo-read-only`. **Não recebe URL** (`--url`/posicional são recusados): a ligação ao tenant vem do control plane (`CONTROL_DATABASE_URL` + `TENANT_ENCRYPTION_SECRET`, como o `tenancy:*`).
* Control plane e tenant com `default_transaction_read_only=on`, transacção `READ ONLY` (tenant em `REPEATABLE READ`), `SHOW transaction_read_only = on` antes de consultar; só SELECT; nunca imprime URL/host/password (mascarados também em erros). Grava `.md` e `.json` em `--out-dir` (por omissão `/relatorios`, que tem de existir).
* Produz: fabricantes antes/depois, top de grupos e quantos têm >10 variantes; por grupo nome, membros (id, tipo de associação, `validadoManualmente`, aliases), produtos abrangidos por origem, incluídos por regra com fabricante fora do grupo, regras CNP e produtos manuais (CNP), e produtos de membros fora do grupo; listas completas das opções antes/depois; candidatos por semelhança (**só listagem para revisão humana**); ambiguidades (alias de grupo partilhado, alias de fabricante partilhado entre grupos, alias de grupo = fabricante de outro grupo, regra CNP não reflectida / contra o grupo do fabricante, produto com grupo ≠ grupo do fabricante, membro de grupo inactivo); e a secção «casos com mais de dez nomes» a confirmar se todas as variantes estão agrupadas (e se todos os produtos dos membros estão no grupo).
* Provado em Postgres descartável (xmin/ctid e contagens de 8 tabelas iguais antes/depois; escrita rejeitada pela sessão; execução real por CLI (control plane + tenant descartáveis) com role só de SELECT e com superutilizador; password, host:porta, URLs e chaves nunca aparecem em consola nem ficheiros, nem em erros).
