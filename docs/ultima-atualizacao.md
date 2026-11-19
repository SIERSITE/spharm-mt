# «Última atualização» — menu lateral

Base: `e7db04071af7edbedc001bf75c73ef3e0bc4e808` (produção). **Sem migrations, sem alteração ao agent.**

## O que o utilizador vê
No fundo do menu lateral, antes da identificação do utilizador:

    ÚLTIMA ATUALIZAÇÃO
    Farmácia Central
    19/11/2026 às 08:24
    Farmácia do Mercado
    Sem atualização disponível

* Uma linha por farmácia ATIVA a que o utilizador tem acesso (Administrador/Gestor de grupo: todas; os restantes: a sua).
* Só nome, data e hora. Sem clique, painel ou tooltip. Não há data global nem «a mais antiga».
* Independente da seleção nos mapas: não toca em nenhum ecrã de relatório.
* Muitas farmácias: a lista desloca-se (máx. 34 % da altura do ecrã) e as opções do menu também se deslocam; nada sai do ecrã.
* Telemóvel: o menu abre por um botão no cabeçalho (ícone de menu) e o bloco aparece no fundo do menu aberto. Fecha com Esc, ao tocar fora, no X, ou ao navegar.

## Fonte
`PipelineRun` do tenant com `kind` ∈ {`daily-pipeline`, `daily-sync`} e `status = OK`; instante = `updatedAt`
(relógio do servidor ao gravar o fecho da corrida). Por farmácia, a mais recente.
Não contam: `sync-now`, `PARTIAL`/`ERROR`/`ABORTED`, `aggregate-month`, `SyncRequest`, heartbeat.
O `OK` é recalculado pelo servidor (`estadoDoDia`) a partir dos passos que o agent reporta.

## Ficheiros
`lib/ultima-atualizacao-core.ts` (regra pura) · `lib/ultima-atualizacao.ts` (só SELECT) ·
`app/api/ultima-atualizacao/route.ts` (exige sessão do tenant do host; `no-store`; devolve só `farmacias[{id,nome,ate}]`) ·
`components/layout/ultima-atualizacao.tsx` · `components/layout/app-shell.tsx` (conteúdo do menu partilhado entre
desktop e menu móvel; menu lateral com altura do ecrã).

## Testes
`npm run test:ultima-atualizacao` (define `TEST_DB_ATUALIZACAO` para o loader contra Postgres local) e
`npm run e2e:ultima-atualizacao` (browser real; ver o cabeçalho do ficheiro). Capturas em `docs/validacao-ultima-atualizacao/`.

## Instalação e rollback
Deploy normal; sem variáveis novas. Rollback: voltar a `e7db040`.
