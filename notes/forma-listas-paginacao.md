# Filtro «Forma farmacêutica» — Excessos, Transferências, Devoluções e lista de Encomendas: limite, paginação e totais

Auditoria feita sobre o código (ficheiro:linha, estado após a correcção) e provada por
`scripts/tests/test-forma-paginacao-server-db.ts` (PostgreSQL descartável, SQL real, 76 verificações) e
`scripts/e2e/forma-listas-paginacao-browser.ts` (escrito, NÃO executado).

## Tabela por área

| Área | (i) Limite/corte no servidor antes do browser? | (ii) Paginação | (iii) Totais/KPI/contagens | Decisão |
|---|---|---|---|---|
| Excessos (`/excessos`) | **SIM**: `result.slice(0, 200)` (`lib/transferencias-data.ts:704`), depois de ordenar por cobertura da origem desc; mais a janela de datas e `stockAtual > 0` no SQL de `loadPfAndSales`. | Não há paginação: tabela única com scroll (`components/excessos/excessos-client.tsx`). | Cliente, a partir das linhas carregadas (`resumo`, `totalCustoExcesso`, `totalPvpExcesso`: `excessos-client.tsx:457-467`). | **Filtro passado para o SERVIDOR**: `formasFarmaceuticas` em `OpcoesOperacionais` (`transferencias-data.ts:410`) -> `loadPfAndSales({ formas })` -> `sqlFiltroForma` no SQL de `pfRows` (`:340`, `:512`), ANTES do agrupamento e do corte de 200. `handleGerar` envia as formas (`excessos-client.tsx:298`); o snapshot fixa as mesmas. O refinamento cliente (`:378`) mantém-se (idempotente). |
| Transferências (`/transferencias`) | **SIM**: `result.slice(0, 200)` (`transferencias-data.ts:651`), ordenado por prioridade e cobertura do destino. | Não há paginação servidor. | Cliente (`transferencias-client.tsx:483`). | Idem: `transferencias-client.tsx:284` envia as formas; mesmo caminho SQL. O emparelhamento origem/destino é por produto, por isso o filtro por produto não o altera. |
| Devoluções (`/devolucoes`) | **NÃO**: `getDevolucoesData` devolve o período completo (`lib/devolucoes-data.ts:54-93`, sem `take/skip/slice`; só `gte/lte` de data, que é o período pedido, não o filtro). | Nenhuma. | Cliente a partir de `filteredRows` (`devolucoes-client.tsx:80`, `:105`, `:161`). | **Filtro cliente é correcto** (o conjunto completo está no browser). Prova: D1-D10 (300 linhas, 9 «tarde», totais exactos). Sem alteração de código. |
| Lista de Encomendas (`/encomendas`, `OrderListClient`) | Sim, por PÁGINA: `skip/take` (`lib/encomendas/orders-data.ts:161-162`), 25 por defeito, máx. 200. | **Servidor** (`skip/take` + `count`, `:173`; navegação por URL). | Total/nº de páginas/«x–y de N» calculados no servidor (`:246`); `linhasCount` e `valorEstimado` são do documento. | Esta rota **não tinha filtro de forma** (a entrega anterior pôs-no em `encomendas-client.tsx`, que **não é renderizado por nenhuma rota**, e na proposta `/encomendas/nova`). Passa a existir: parâmetro `forma` (repetido) -> `OrderListFilters.formas` -> `where.linhas.some.produto` (`:152`), partilhado por `findMany` e `count`, antes da paginação. Mudar a forma é uma navegação (o mecanismo desta lista: todos os filtros são searchParams). |
| Encomendas — proposta (`/encomendas/nova`) | Sim (`LIMIT MAX_LINHAS_PROPOSTA`, `lib/encomendas/proposal.ts:548,567`) | n/a | Servidor | Já server-side desde a entrega anterior (`sqlCondicaoForma`, `proposal.ts:411`), antes do `LIMIT`. Sem alteração. |
| Encomendas — `encomendas-client.tsx` | n/a: componente sem rota (`encomendas/actions.ts` -> `getEncomendasData`, sem limite). | n/a | Cliente | Código morto; mantém-se o filtro cliente. Não se investiu mais. |

## Semântica do filtro na lista de Encomendas

A lista é de DOCUMENTOS: «forma = X» mostra as encomendas que têm PELO MENOS UMA linha com um produto dessa forma (união entre
formas; «Sem forma farmacêutica» = produto com forma nula/vazia). A encomenda aparece inteira — `linhasCount` e o valor estimado
são do documento, não só das linhas que casam. «Limpar filtros» (já existia) navega para o `pathname` sem parâmetros.

## Mecanismo de re-pesquisa

* Excessos / Transferências: são mapas com «Gerar/Atualizar». A forma NÃO regenera ao mudar (regra do repo): o rascunho muda,
  o resultado visível é o do último «Gerar/Atualizar» e o snapshot fixa as formas desse pedido. Foi acrescentado «Limpar filtros»
  (antes não existia nestes dois ecrãs): repõe os critérios (farmácias todas, restantes eixos vazios, incl. a forma) sem regenerar;
  o conjunto completo volta no «Atualizar» seguinte.
* Lista de Encomendas: carrega ao abrir; filtrar é `router.push` com `transition` (como os restantes filtros), volta à página 1.

## Riscos / limitações conhecidas

1. O corte de 200 linhas de Excessos/Transferências continua a existir (pré-existente): com a forma já no SQL, o corte age sobre o
   conjunto filtrado, mas se o filtrado tiver > 200 artigos os totais cobrem só as 200 mais relevantes. O ecrã não avisa do corte.
2. Os OUTROS filtros destes dois mapas (fabricante, grupo, categoria, fornecedor, prioridade, pesquisa, farmácia) continuam no
   cliente, sobre as linhas já cortadas — a mesma limitação, fora do âmbito pedido. Combinados com a forma, são aplicados sobre o
   conjunto já filtrado por forma (provado em E18-E22, T10-T11).
3. `scripts/tests/test-ui-catalogo.ts` tem 7 falhas em `VendasClient`/ficha de stock (rótulos Categoria/Subcategoria/Utilização…)
   que não tocam nos ficheiros alterados aqui.
