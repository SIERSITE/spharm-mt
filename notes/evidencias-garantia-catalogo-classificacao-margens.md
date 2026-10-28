# Evidências — Garantia (catálogo, classificação), Margens e filtro de forma farmacêutica

Dados 100% sintéticos, browser real (Chromium) contra o build de produção de um clone limpo, PostgreSQL descartável.
Pasta das capturas: `docs/validacao-visual/2026-10-garantia-catalogo-classificacao-margens/`.
Cada captura é gravada por um E2E (indicado entre parênteses); os PDFs são os reais devolvidos por `/api/reports/pdf`.

## 1. Manutenção do catálogo e classificação (`tenants-catalogo-browser.ts`)

| Captura | O que prova |
|---|---|
| `garantia-manutencao-catalogo.png` | O tenant Garantia tem «Manutenção do catálogo» (menu e página). |
| `silveira-manutencao-catalogo.png` | O Silveira mantém a manutenção como antes. |
| `sier-manutencao-catalogo.png` | Outro tenant (sier) recebe 404 real: a página não existe. |
| `garantia-filtro-fabricante-agrupado.png` | No Garantia o filtro de fabricante é agrupado por grupo laboratorial. |
| `silveira-filtro-fabricante-inalterado.png`, `sier-filtro-fabricante-inalterado.png` | Nos outros tenants o filtro de fabricante não mudou. |
| `garantia-ficha-classificacao.png` (e `silveira-`, `sier-`) | Ficha do artigo com Genérico e Ético (ERP) e NETT (ERP) visíveis na secção «Classificação» (o campo Serviço fica abaixo da dobra desta captura; é verificado pelo E2E). |
| `*-catalogo-filtro-etico.png` | Filtro de tipo «Ético» no Catálogo. |
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

## 3. Stock no mapa de Margens (`margens-stock-browser.ts`, 40 OK)

| Captura | O que prova |
|---|---|
| `margens-stock-1920x1080.png`, `margens-stock-1536x864.png`, `margens-stock-1366x768.png` | Coluna «Stock» logo a seguir a «Qtd», sem cabeçalho truncado, alinhada; em 1536 e 1366 há scroll horizontal com CNP/Descrição fixos. |
| `margens-stock-valores.png` | Stock positivo, zero (caixa), negativo (escuro) e desconhecido («—», nunca 0); «Stock total» = soma das linhas. |
| `margens-stock-expansao-cnpem-so-ecra.png` | A expansão CNPEM mostra o stock no ecrã sem alterar o «Stock total». |
| `margens-stock-pdf-real-p1.png`, `margens-stock-pdf-real.pdf` | PDF real com a coluna Stock e o resumo «Stock total», sem a expansão CNPEM. |

No mesmo E2E, com a expansão CNPEM aberta no ecrã: impressão (iframe capturado), PDF real, Excel real (lido com xlsx) e email real
(servidor SMTP de ensaio, anexos recebidos) trazem o Stock e nunca as linhas do CNPEM. O mapa de Margens não tem separador «Relatório»
(esse existe só em Vendas, coberto por `vendas-opcoes-browser.ts`): a saída de Margens é PDF, impressão, Excel e email.

## 4. Filtro de forma farmacêutica (`forma-farmaceutica-browser.ts`, 88 OK)

| Captura | O que prova |
|---|---|
| `forma-vendas.png`, `forma-margens.png`, `forma-inventario.png`, `forma-excessos.png`, `forma-transferências.png`, `forma-stock.png`, `forma-catalogo.png`, `forma-encomenda-nova.png` | O filtro existe e aplica-se em cada mapa (opções agrupadas, contagem, chip «Forma: …»). |
| `forma-resolucao-1920x1080.png`, `forma-resolucao-1536x864.png`, `forma-resolucao-1366x768.png` | O painel de filtros é utilizável nas 3 resoluções, sem scroll horizontal da página. |
| `forma-margens-pdf-real.pdf`, `forma-margens-forma-pdf-p1.png` | PDF real de Margens com «Forma farmacêutica: Comprimido» nos filtros aplicados. |

Capturas só nas resoluções 1920×1080, 1536×864 e 1366×768 para uma página (a de Margens); as restantes são a 1600×900.
No mesmo E2E, Margens com a forma aplicada: impressão, PDF real, Excel real e email recebido (PDF e Excel) trazem
«Forma farmacêutica: Comprimido» nos filtros e só os artigos dessa forma (A e B; nunca os «Comprimido revestido»).
Antes de «Atualizar», o PDF não traz a forma (usa os filtros aplicados, não o draft).
