# Matriz do filtro «Forma farmacêutica» — todas as áreas que apresentam ou filtram produtos

Estado: implementado (sem commit). Chave, rótulo, componente e predicado são os de `notes/forma-farmaceutica-filtro.md`
(`lib/catalog/forma-farmaceutica-filtro.ts` / `-sql.ts`, `components/reporting/filtro-forma-farmaceutica.tsx`, ponto único
`lib/reporting/catalog-prefilter.ts`). Auditoria feita sobre todas as rotas de `app/**/page.tsx` e os componentes que
listam produtos.

## 1. Áreas COM o filtro

| Área (rota) | Aplicado | Onde corre | Antes de paginação / totais | PDF / impressão / Excel / email | Estado por separador |
|---|---|---|---|---|---|
| Vendas (`/vendas`) | sim | servidor (`resolverPrefiltroProdutos` → `restringirPorCatalogo`) + refinamento cliente sobre `row.formaChave` | sim — antes dos totais e das linhas | sim — linha «Forma farmacêutica: …» (rótulos) | workspace (`criterios.formasSelecionadas`) |
| Margens (`/relatorios/margens`) | sim | servidor (idem) | sim | sim — usa o filtro APLICADO (`filtrosResultado`) | workspace; draft ≠ aplicado, **não regenera** (só «alterações por aplicar») |
| Inventário (`/relatorios/inventario`) | sim | servidor | sim | sim — filtro aplicado | workspace |
| Stock (`/stock`) | sim | servidor, antes da paginação | sim (total e página) | n/a (sem exportação) | URL `forma` repetido |
| Catálogo (`/catalogo`) | sim | servidor (`wherePrismaPorFormas`, valores crus) | sim | n/a (sem exportação) | URL `forma` repetido |
| Encomendas — proposta (`/encomendas/nova`) | sim | servidor (`sqlCondicaoForma` no SQL da proposta) | sim — antes do corte de linhas | n/a (a proposta gera um documento; o filtro fica no contexto do rascunho) | `useEstadoSeparador` + `PropostaContexto.filters.formas` |
| Encomendas — mapa por farmácia (`/encomendas`) | sim | cliente (`row.formaChave`) | sim — as linhas filtradas alimentam totais e exportação | sim | `useState` local (como os restantes filtros dessa página) |
| Excessos (`/excessos`) | sim | cliente (`row.formaChave`, vinda do SELECT existente) | sim | sim — filtro APLICADO (`snapshot`) | workspace |
| Transferências (`/transferencias`) | sim | cliente | sim | sim | workspace |
| **Devoluções (`/devolucoes`)** — NOVO | sim | cliente (`row.formaChave`; ver decisão) | sim — `filteredRows` alimenta agrupamento por fornecedor, totais e exportação | sim — «Forma farmacêutica: …» nos filtros aplicados (PDF/impressão/Excel/email partilham o `Report`) | `useEstadoSeparador` (forma, restantes filtros e resultado) |
| **Manutenção em massa do catálogo (`/catalogo/manutencao`)** — NOVO | sim | servidor (aditivo em `resolverPrefiltroProdutos`; também no período via `getVendasData`) | sim — total e páginas calculados depois do filtro; a selecção «todos» alcança só o que o filtro lista | n/a (não há relatório; o resumo «Filtros utilizados» do preview inclui a forma) | estado local da aba; mudar o filtro limpa a selecção com aviso |

## 2. Áreas SEM o filtro — motivo técnico

| Área | Aplicado | Motivo |
|---|---|---|
| Encomendas — histórico (`/encomendas/lista`) | não | Lista de DOCUMENTOS emitidos (nº, farmácia, estado, data); filtros por documento, não por produto. Filtrar por forma exigiria juntar linhas de encomenda e mudaria o que foi emitido. |
| Encomenda — detalhe (`/encomendas/[id]`) | não | Linhas imutáveis de um documento já criado; a pesquisa serve para ADICIONAR uma linha (picker), não para listar. |
| Picker de produtos (`components/encomendas/product-picker.tsx`) | não | Pesquisa-para-escolher-um-artigo (CNP/designação/fabricante). Uma forma não acrescenta precisão a uma escolha individual e aumentaria o ruído no ecrã de criação. |
| Transferências — manutenção (`/transferencias/manutencao`) | não | Lista de transferências registadas (por número, farmácia, estado, data) — documentos. |
| Manutenção de vendas (`/vendas/manutencao` + `nova` + `[id]`) | não | Lista de manutenções (documentos, filtro por estado). O formulário pesquisa produtos para ADICIONAR linhas a um documento (`pesquisarProdutosManutencaoAction`), não é uma listagem filtrável. |
| Oportunidades (`/oportunidades`) | não | Caixa de entrada de sugestões (same-CNP e DCI-equivalente) calculadas no servidor, sem nenhum controlo de filtro; o conjunto é fixo e pequeno. Não há filtros para estender. |
| Dashboard (`/dashboard`) | não | Indicadores agregados por farmácia e tendências; não lista produtos filtráveis. |
| Ficha de artigo (`/stock/artigo/[cnp]`, `/catalogo/artigo/[cnp]`) | não | Um único produto (por CNP). |
| Criar produto (`/produtos/criar`) | não | Formulário de criação; a forma é um CAMPO de edição, não um filtro. |
| Revisão de catálogo (`/admin/catalogo/**`, `/admin/infarmed`) | não | Consola de plataforma, cross-tenant (control plane): as formas são por tenant e nunca partilhadas; filtrar aí misturaria tenants. |
| Ajustes de stock / contagem de inventário | n/a | Não existem rotas próprias no `app/` desta versão; a contagem vive no Inventário (coberto). |
| Compras | n/a | Não existe rota própria; as compras entram em Encomendas (coberto). |

## 3. Decisões

**Devoluções — client-side, sem impossibilidade técnica.** A página já carregava o dataset do período por Server Action («Gerar») e
aplicava TODOS os filtros no cliente sobre essas linhas. A forma segue o mesmo padrão dos eixos de catálogo (categoria,
fabricante): `getDevolucoesData` acrescenta `formaFarmaceutica` ao `select` da relação `produto` que já existia
(**0 consultas novas, sem N+1** — medido: 0 chamadas a `produto`, 1 a `devolucao`) e calcula `formaChave` com a MESMA função.
`filteredRows` aplica `passaFiltroForma` e dele derivam `groupedBySupplier`, `totals` e `rowsParaExportacao`, por isso totais,
agrupamento e exportações são sempre os da selecção. Mudar a forma não faz pedidos. «Limpar filtros» (novo botão; a página não
tinha) repõe todos os eixos. Os filtros e o resultado passaram a viver em `useEstadoSeparador` (o mecanismo do módulo; mesma
assinatura que `useState`), pelo que mudar de separador e voltar preserva a selecção, e duas análises não se contaminam.

**Manutenção em massa do catálogo — aplicado (servidor, aditivo).** A listagem de produtos é filtrável (os filtros são os de
Vendas), por isso o eixo entra pelo mesmo ponto (`resolverPrefiltroProdutos`, e `getVendasData` quando há período) via o novo campo
opcional `ManutencaoMassaFiltro.formasFarmaceuticas` (chaves). Garantias: vazio/omitido ⇒ o filtro canónico e o hash do
snapshot NÃO mudam (previews anteriores continuam válidos); o servidor re-normaliza e limita a 60 chaves; mudar a forma depois
do preview invalida o snapshot (`PREVIEW_DESACTUALIZADO`); no cliente muda o `filtroKey` ⇒ a selecção é limpa com aviso; a
manutenção do fabricante não toca em `formaFarmaceutica`. O gate do tenant (silveira + garantia) e as guardas das server actions
ficaram intactos.

## 4. Testes que provam isto

* `scripts/tests/test-forma-devolucoes-manutencao-db.ts` — 70 verificações: Devoluções (D1–D24), Manutenção (M1–M32), requisitos
  transversais (Q1–Q14).
* `scripts/tests/test-forma-farmaceutica-db.ts` (131) e `-filtro.ts` (72) — os mapas já existentes.
* `scripts/tests/test-manutencao-massa-filtros-db.ts` (107), `-silveira.ts` (65), `test-catalogo-manutencao-tenants.ts` (61),
  `test-margens-sem-geracao-automatica.ts` (41) — regressões sem alteração.
* `scripts/tests/test-auditoria-forma-db.ts` (47) — a auditoria só de leitura.
* `scripts/e2e/forma-farmaceutica-browser.ts` (escrito, **não executado**): passos 8b (Devoluções) e 8c (Manutenção).
