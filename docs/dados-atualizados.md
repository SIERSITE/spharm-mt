# «Dados atualizados até» — cabeçalho da aplicação

Base: `e7db04071af7edbedc001bf75c73ef3e0bc4e808` (produção). **Sem migrations, sem alteração ao agent.**

## O que o utilizador vê
No cabeçalho, junto de «Sair», em todos os ecrãs autenticados:

> Dados atualizados até 19/11/2026, 08:24

* Clicar abre «Última atualização de cada farmácia» (nome + data/hora de cada uma).
* Farmácia sem informação: **Atualização ainda não disponível**.
* Telemóvel: «Até 19/11/2026, 08:24»; o detalhe ocupa a largura do ecrã.
* Esc ou clique fora fecha o detalhe. Não há termos técnicos em lado nenhum.
* Data/hora em fuso de Lisboa (verão/inverno corretos).

## Regras
* **Cabeçalho = a data MAIS ANTIGA entre as farmácias ativas** (as que têm informação). É essa que
  representa até quando o conjunto está atualizado.
* Farmácias contadas: `ATIVO`, sem a «Farmácia Teste» (mesma convenção do resto da app), e só as que o perfil
  pode ver (ADMINISTRADOR/GESTOR_GRUPO: todas; GESTOR_FARMACIA/OPERADOR: a sua).
* Nenhuma farmácia com informação → «Atualização ainda não disponível».

## Fonte exata
`PipelineRun` (tabela de cada tenant, já existente) com:

| Critério | Valor | Porquê |
|---|---|---|
| `kind` | `daily-pipeline` ou `daily-sync` | são as corridas que trazem stock/vendas |
| `status` | `OK` | `PARTIAL`/`ERROR`/`ABORTED` = dados incompletos. O servidor recalcula o estado (`estadoDoDia`) e nunca confia no que o agent afirma |
| instante | `updatedAt` | relógio do **servidor**, escrito quando o SaaS grava o fecho da corrida. Não é `finishedAt` (relógio da máquina da farmácia, pode estar errado) nem a data do último movimento (não avança numa farmácia sem vendas) |
| por farmácia | máximo | a corrida mais recente |

**Não contam:** `sync-now` (é a hora do pedido do utilizador, «Sincronizar agora»), `aggregate-month`,
`SyncRequest`, heartbeat do agent (prova que o agent está vivo, não que chegaram dados).

Código: `lib/dados-atualizados-core.ts` (regra pura), `lib/dados-atualizados.ts` (só SELECT),
`app/api/dados-atualizados/route.ts` (exige sessão do tenant do host; `no-store`),
`components/layout/dados-atualizados.tsx` (cabeçalho), encaixe em `components/layout/app-shell.tsx`.
O componente volta a ler ao mudar de ecrã e ao regressar ao separador do browser.

## Limitações assumidas
* Uma farmácia que só fez carga inicial/`full-sync` (sem corrida diária registada) aparece sem informação até à
  primeira corrida diária.
* Um dia `PARTIAL` não avança a data até a corrida seguinte o fechar (o catch-up volta a propô-lo). Deliberado:
  é preferível mostrar uma data mais antiga a afirmar dados completos que não o são.
* Com uma farmácia sem informação e outra com, o cabeçalho mostra a data da que tem e o detalhe assinala a outra.

## Provas (ver `docs/validacao-dados-atualizados/`)
`npm run test:dados-atualizados` (32 asserções; define `TEST_DB_DADOS` para o loader contra Postgres local) e
`npm run e2e:dados-atualizados` (45 asserções, browser real). O E2E entrega a data pelo MESMO endpoint que o agent
(`POST /api/admin/pipeline/record`, com chave de ingestão) e prova: data = relógio do servidor (o agent
afirmava 2020); `sync-now`, `PARTIAL`, `ERROR`, agregação, pedido «Sincronizar agora» e heartbeat NÃO mexem na
data; mais antiga entre duas farmácias; âmbito por perfil; dois tenants/dois separadores sem fuga; sessão de um
tenant no host de outro → 401; 14 ecrãs com o cabeçalho; telemóvel 390×844 sem scroll horizontal.

## Instalação e rollback
Deploy normal; sem variáveis novas. Rollback: voltar a `e7db040` (nada a desfazer na BD).
