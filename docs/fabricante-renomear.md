# Editar nome do fabricante (ficha do artigo) — Silveira e Garantia

Base: `f35ea5706aa45217205cb8a2b55e8471d5120999` (produção). Sem migrations.

## O que faz
Na ficha do artigo (Stock › Artigo, e o painel lateral), na célula **Fabricante**,
por baixo do nome, aparece «Editar nome do fabricante» — só para quem tem
`catalog.write` (ADMINISTRADOR, GESTOR_GRUPO) e só nos tenants `silveira` e
`garantia`. O editor que já existia («Editar»: pesquisar/criar outro fabricante
para ESTE artigo) fica exatamente como estava.

1. Escreve-se o nome novo → «Continuar» (nada é gravado).
2. Confirmação: nome atual, nome novo, nº de artigos e
   «Esta alteração irá mudar o nome do fabricante em X artigos deste tenant.»
3. «Confirmar e guardar» grava. «Cancelar» não altera nada.
4. Se o nome (ou equivalente por normalização) já existe no tenant, não se cria
   duplicado: pergunta-se se quer **consolidar** nesse fabricante. Nunca automático.
5. Recusados: nome vazio/ilegível; igual ao atual (espaços, maiúsculas, acentos,
   pontuação); contagem de artigos mudada entretanto (pede nova confirmação).

## Tenants e permissões
* Sem lista nova: reutiliza `catalogoManutencaoAtiva` / `TENANTS_CATALOGO_MANUTENCAO`
  (`lib/tenant-constants.ts`) = **`silveira`** e **`garantia`**. (`silveirense` NÃO existe.)
* `lib/catalogo/fabricante-renomear-scope.ts → podeRenomearFabricante(session, tenantDoPedido)`:
  tenant do pedido na lista **e** `session.tenant === tenant do pedido` **e** `catalog.write`.
  Usada na página (mostra o botão) e na server action (recusa) — a mesma função.
* O tenant vem do servidor (claim assinado da sessão + `x-tenant-slug` escrito pelo
  middleware). Nada do browser decide tenant ou fabricante: o fabricante é o do **CNP**.

## Isolamento
Uma BD por tenant; o cliente Prisma é o de `getPrisma()` do pedido. Um alias só
existe na BD do seu tenant, logo nunca resolve um fabricante de outro.

## Protecção contra sincronizações (o que se reutiliza e o que se acrescenta)
* **Renomear não muda `fabricanteId`.** Silveira: o ERP nunca reescreve um
  fabricante já definido (`decidirFabricanteSilveira`). Garantia: baseline por
  farmácia+CNP (`decidirFabricanteBaseline`) — o ERP a repetir o nome antigo não é «mudança».
* **Nome antigo → `FabricanteAlias`** do fabricante que fica (renomear e consolidar).
* **Ingest** (`applyErpCatalogFields`): nova opção `resolverFabricantePorAlias`
  (default `false` = comportamento de `f35ea57` byte a byte). O endpoint
  `/bootstrap/products` liga-a com `catalogoManutencaoAtiva(ctx.tenant.slug)` — o tenant
  autenticado do agent, nunca o payload. Só alias **inequívoco** (um único fabricante).
  Cobre o caso «CNP novo do ERP com o nome antigo».
* `getOrCreateFabricante` **não foi alterado** (usa o cliente legacy, não é tenant-aware).
* **Não** se marca `validadoManualmente` em massa: congelaria classificação,
  enriquecimento e catálogo global de centenas de artigos (a Garantia está a classificar).
  O editor de UM artigo continua a usá-la, como sempre.

## Consolidação
Move todos os artigos (por `fabricanteId`, num UPDATE), passa nome + aliases da origem
para o destino, origem fica `INATIVO` (nunca apagada), destino `INATIVO` é reativado.
**Garantia:** recusada (`GRUPO`) se origem e destino pertencem a grupos laboratoriais
diferentes (ou só um tem grupo) — alteraria a classificação; dentro do mesmo grupo é permitida.

## Auditoria (mesma transação)
`AuditLog`: `fabricante.renomeado` | `fabricante.consolidado`, `actorId`, `entity=Fabricante`,
`entityId`, `createdAt`; `metaJson`: `origem, tenant, modo, fabricanteAnterior, fabricanteNovo,
artigosAfetados, cnpOrigem, em` (+ `fabricanteOrigemId/DestinoId`, `produtoIdsMovidos` na consolidação).

## Ficheiros
| | |
|---|---|
| `lib/catalogo/fabricante-renomear.ts` | lógica (avaliar / pré-visualizar / aplicar), Prisma injetado |
| `lib/catalogo/fabricante-renomear-scope.ts` | tenant + permissão |
| `app/stock/artigo/renomear-fabricante-actions.ts` | server actions (guarda antes de qualquer BD) |
| `components/stock/renomear-fabricante.tsx` | botão + diálogo |
| `components/stock/editor-fabricante.tsx`, `artigo-ficha.tsx`, `lib/stock/artigo-ficha-data.ts` | encaixe mínimo (prop `podeRenomear`) |
| `lib/ingest/catalog-from-erp.ts`, `app/api/ingest/v1/bootstrap/products/route.ts` | opção de alias por tenant |

## Migrations
Nenhuma.

## Instalação
Deploy normal da app. Sem variáveis novas, sem passos de dados, sem alteração do agent.

## Rollback
* Código: voltar à versão anterior (`f35ea57`). Nada a desfazer na BD.
* Renomeação: renomear de volta pela funcionalidade, ou `UPDATE "Fabricante" SET "nomeNormalizado"=<fabricanteAnterior> WHERE id=<entityId>` + apagar o alias criado.
* Consolidação: `metaJson.produtoIdsMovidos` + `fabricanteOrigemId`:
  `UPDATE "Produto" SET "fabricanteId"=<origem> WHERE id IN (…)`; origem `ATIVO`; mover de volta os aliases.

## Testes
```
TEST_DB_SILVEIRA=… TEST_DB_GARANTIA=… TEST_DB_OUTRO=… npm run test:fabricante-renomear   # 101 asserções (3 BDs locais, com todas as migrations)
E2E_DB_*=… npm run e2e:fabricante-renomear                                                 # browser real, 3 tenants por subdomínio
```
Ambos recusam hosts que não sejam localhost. O E2E precisa do build de produção a correr
(ver o cabeçalho do ficheiro). Nota: Postgres local tem de ser UTF8 (a migration
`20260413110000` falha em bases WIN1252).

## Limitações
* O nome fica na forma canónica do sistema (`normalizeFabricanteCanonico`: maiúsculas, sem acentos/pontuação).
* Uma **mudança real e posterior do ERP para um nome diferente** continua a poder atualizar artigos
  não protegidos individualmente (Garantia); na Silveira nunca reescreve. Para fixar um artigo use o editor existente.
* Fluxos que usam `getOrCreateFabricante` (revisão admin, script xlsx, enriquecimento) não resolvem pelo nome antigo.
* Origem de uma consolidação fica `INATIVO` (some dos filtros que só listam `ATIVO`).
* O catálogo global do control plane não é tocado.
