# Evidências — Garantia (catálogo, fabricantes), Margens e filtro de forma farmacêutica

Dados 100% sintéticos, browser real (Chromium) contra o build de produção de um clone limpo, PostgreSQL descartável.
Pasta das capturas: `docs/validacao-visual/2026-10-garantia-catalogo-classificacao-margens/`.
Cada captura é gravada por um E2E (indicado entre parênteses); os PDFs são os reais devolvidos por `/api/reports/pdf`.
Nota: o nome da pasta mantém «classificacao» por histórico (os E2E gravam nela); esta entrega não inclui classificação ERP e não há capturas dela.

## 1. Manutenção do catálogo, fabricantes e forma (`tenants-catalogo-browser.ts`, 16 OK)

| Captura | O que prova |
|---|---|
| `garantia-manutencao-catalogo.png` | O tenant Garantia tem «Manutenção do catálogo» (menu e página). |
| `silveira-manutencao-catalogo.png` | O Silveira mantém a manutenção como antes. |
| `sier-manutencao-catalogo.png` | Outro tenant (sier) recebe 404 real: a página não existe. |
| `garantia-filtro-fabricante-agrupado.png` | No Garantia o filtro de fabricante é agrupado por grupo laboratorial (comparar com `silveira-filtro-fabricante-inalterado.png`, plano, no Silveira). |
| `silveira-filtro-fabricante-inalterado.png`, `sier-filtro-fabricante-inalterado.png` | Nos outros tenants o filtro de fabricante não mudou. |
| `*-catalogo-filtro-forma.png` | Filtro de forma farmacêutica no Catálogo. |

## 2. Margens sem geração automática (`margens-sem-geracao-automatica-browser.ts`, 56 OK)

| Captura | O que prova |
|---|---|
| `margens-1-gerado.png` | Relatório gerado (botão passa a «Atualizar»). |
| `margens-2-alterado-aviso-por-aplicar.png` | Depois de alterar o filtro, o relatório anterior mantém-se e aparece «Existem alterações por aplicar»; 0 pedidos de geração. |
| `margens-3-atualizado.png` | Depois de «Atualizar» (duplo clique = 1 geração): tabela e totais recalculados com o filtro novo. |
| `margens-4-forma-aplicada.png` | A forma farmacêutica só é aplicada com «Atualizar» (só A e B, «Comprimido»). |
| `margens-5-duas-analises.png` | Duas análises independentes (workspace). |

O E2E conta os pedidos de Server Action: escrever/apagar o nome, selecionar/remover fabricante ou forma e «Limpar filtros» = 0 gerações;
mudar de separador e voltar = 0 gerações novas; «Atualizar» = exatamente 1; PDF/Excel usam os filtros aplicados, nunca o draft.

## 3. Stock no mapa de Margens (`margens-stock-browser.ts`, 77 OK)

| Captura | O que prova |
|---|---|
| `margens-stock-1920x1080.png`, `margens-stock-1536x864.png`, `margens-stock-1366x768.png` | Coluna «Stock» logo a seguir a «Qtd», sem cabeçalho truncado, alinhada; em 1536 e 1366 há scroll horizontal com CNP/Descrição fixos. |
| `margens-stock-valores.png` | Stock positivo, zero (caixa), negativo (escuro) e desconhecido («—», nunca 0); «Stock total» = soma das linhas. |
| `margens-stock-expansao-cnpem-so-ecra.png` | A expansão CNPEM mostra o stock no ecrã sem alterar o «Stock total». |

No mesmo E2E, com a expansão CNPEM aberta no ecrã: impressão (iframe capturado), PDF real, Excel real (lido com xlsx) e email real
(servidor SMTP de ensaio, anexos recebidos) trazem o Stock e nunca as linhas do CNPEM. O mapa de Margens não tem separador «Relatório»
(esse existe só em Vendas, coberto por `vendas-opcoes-browser.ts`): a saída de Margens é PDF, impressão, Excel e email.

### Stock nos modos agregados (categoria, farmácia, grupo, fabricante)

| Captura | O que prova |
|---|---|
| `margens-stock-modo-categoria.png`, `-farmacia.png`, `-grupo.png`, `-fabricante.png` | Ecrã: coluna «Stock» a seguir a «Qtd», nota «artigos com vendas no período», «Sem stock conhecido» só quando existe; Σ da coluna = «Stock total» do mapa por produto. |

Para cada modo o E2E confirma também a impressão (iframe), o Excel (total da coluna Stock) e, no fabricante, o email real.
Correção desta fase: o relatório agregado não tinha a faixa de resumo, logo a impressão/PDF dos modos agregados não mostrava o «Stock total»
(só o ecrã). Passou a trazer a faixa (`resumoFaixa`). A faixa estava SEM estilo nos modos agregados e no mapa por produto (os itens colavam:
«Unidades vendidas: 478Stock total: 329»); ver a secção seguinte, que fixa o desenho e prova cada modo.

### PDF e impressão de Margens nos 5 modos (`scripts/tests/test-margens-pdf-modos.ts`, dados sintéticos)

Decisão (opção B, corrigir): a faixa de resumo passa a ter o MESMO desenho (as mesmas declarações) em todos os relatórios compactos que
não são o mapa de Vendas (`.page.density-compact:not(.hierarchy-clean)`); a regra de Vendas (clean) fica literalmente como era, por
isso o mapa de Vendas não muda (os 4 testes de Vendas passam sem alterações). No modo Produto os cabeçalhos longos («Custo unit. est.»,
«IVA %») passavam cortados com «…» (já no base a69cbc5): passam a quebrar em 2 linhas (regra só em `hierarchy-strong`), sem alterar larguras. As capturas são a 1.ª página (PDF com as opções reais do endpoint; impressão com o `@page` do iframe, sem fundos nem cabeçalho
do Chromium), 3 farmácias, stock positivo/zero/negativo/desconhecido; o teste confirma também 1 farmácia e as restantes páginas.

| Captura | O que prova |
|---|---|
| `margens-pdf-modo-produto.png` | Produto, PDF (4 páginas): faixa «Unidades vendidas: 478 · Stock total: 329 · Linhas sem stock conhecido: 8» separada e acima da tabela; coluna Stock (positivo, 0 em caixa, negativo escuro, «—»), TOTAL ARTIGO e cabeçalhos inteiros; nada cortado à direita. |
| `margens-pdf-modo-categoria.png`, `-farmacia.png`, `-grupo.png`, `-fabricante.png` | Agregados, PDF: a mesma faixa bem formada, coluna Stock + «Sem stock conhecido», TOTAL GERAL 329/8 igual ao do modo Produto, sem colunas cortadas nem duplicadas. |
| `margens-impressao-modo-produto.png` | Produto, impressão: igual ao PDF salvo a numeração «Pág.»; a faixa, o Stock e os totais saem com os fundos desligados por omissão. |
| `margens-impressao-modo-categoria.png`, `-farmacia.png`, `-grupo.png`, `-fabricante.png` | Agregados, impressão: faixa, coluna Stock e TOTAL GERAL idênticos ao PDF; nada passa a margem de 8 mm. |

## 4. Filtro de forma farmacêutica (`forma-farmaceutica-browser.ts`, 102 OK)

| Captura | O que prova |
|---|---|
| `forma-vendas.png`, `forma-margens.png`, `forma-inventario.png`, `forma-excessos.png`, `forma-transferências.png`, `forma-stock.png`, `forma-catalogo.png`, `forma-encomenda-nova.png` | O filtro existe e aplica-se em cada mapa (opções agrupadas, contagem, chip «Forma: …»). |
| `forma-resolucao-1920x1080.png`, `forma-resolucao-1536x864.png`, `forma-resolucao-1366x768.png` | O painel de filtros é utilizável nas 3 resoluções, sem scroll horizontal da página. |
| `forma-devolucoes.png` | Devoluções: filtro «Forma farmacêutica» no cliente (0 pedidos), 2 linhas com «Comprimido». |
| `forma-manutencao-catalogo.png` | Manutenção do catálogo (Silveira/Garantia): filtro de forma no servidor, «Limpar filtros» repõe forma e pesquisa. |
| `forma-margens-pdf-real.pdf`, `forma-margens-forma-pdf-p1.png` | PDF real de Margens com «Forma farmacêutica: Comprimido» nos filtros aplicados. |

Capturas só nas resoluções 1920×1080, 1536×864 e 1366×768 para uma página (a de Margens); as restantes são a 1600×900.
No mesmo E2E, Margens com a forma aplicada: impressão, PDF real, Excel real e email recebido (PDF e Excel) trazem
«Forma farmacêutica: Comprimido» nos filtros e só os artigos dessa forma (A e B; nunca os «Comprimido revestido»).
Antes de «Atualizar», o PDF não traz a forma (usa os filtros aplicados, não o draft).
