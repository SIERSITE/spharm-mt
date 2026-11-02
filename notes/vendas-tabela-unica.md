# Mapa de Vendas numa só tabela contínua — A4 horizontal sempre (segundo desenho)

Base: `a012428`. Branch `feat/vendas-tabela-unica-sem-blocos`. O primeiro desenho (commits `6317430..4d4ef19`: papel **A3 automático**, tipografia reduzida,
escala) foi **rejeitado pelo utilizador** («não foi isso que pretendi») e está removido por commits novos. **Sem migrations. Sem alterações a cálculos,
filtros, seleção, ordenação, Excel (`buildReportWorkbook`), tabela interativa do ecrã (`components/vendas`), nem a Margens/Inventário/restantes relatórios.**

## 1. Causa raiz (PDF real do cliente: 14 meses, 326 artigos, 57 páginas)

O PDF de `a012428` repartia o período em «blocos temporais» (Parte 1 de 2 / Parte 2 de 2) repetindo cada artigo; ficava com letra de 6-7,5 pt:

| Onde (`a012428`) | O quê |
|---|---|
| `lib/reporting/adapters/vendas.ts:239` | `MAX_MESES_POR_BLOCO = 13` |
| `vendas.ts:290-296` | `repartirMeses(n)`: > 13 meses → `⌈n/13⌉` blocos |
| `vendas.ts:330,340-345,388-401,408-421` | `emBlocos`: rótulos «Período: …», «Total unid. do bloco» (`tb_i`, `htmlOnly`) |
| `vendas.ts:775-797,815-817` | `columnBlocks`; nota «Período de N meses em K blocos…» |
| `report-types.ts:294` · `report-html.ts:333-334,552-564,1193` · `privacidade.ts:83` | `ReportMeta.columnBlocks`; `renderBloco`, «Parte i de n», `.bloco-novo { break-before: page }` |
| `report-html.ts` (colunas `Custo total est.` e `Valor Vendas`) | colunas monetárias largas («1 234 567,89 €») dentro da tabela principal: obrigavam a reduzir letra/repartir |
| `report-html.ts` `mes-alt` | um `linear-gradient` por célula de mês: Chromium grava um padrão por célula (PDF de 12 MB, 3,5 s/página a abrir) |

## 2. Decisões (o que mudou face ao 1.º desenho)

- **Formato**: A4 horizontal (297×210 mm) SEMPRE — PDF, impressão, PDF do email, pré-visualização. Sem A3, sem escala, sem blocos.
- **Tipografia** (`lib/reporting/layout-largura.ts`): corpo da tabela (CNP, Descrição, Farmácia, PVP, custo, **meses**, total, stock) **8,25 pt** (11 px;
  o mesmo que os números da solução A3 rejeitada); cabeçalhos a negrito **8 pt**; CNP e Descrição = valores mensais. Nunca abaixo de 8 pt. Tipo de letra
  fixo `Arial, "Liberation Sans"` (métricas Arial; o contentor tem `fonts-liberation`), por isso a largura calcula-se com larguras reais de glifo
  (`metricas-fonte.ts`, validado contra o PDF: «Nov/26» 34,96 px medido vs 35,0 calculado).
- **Colunas da tabela**: CNP · Descrição · Farmácia · PVP* · Custo unit. est.* · N meses «Out/25» (uma linha) · **Total unid.** · **Stock** (*opções de preços).
- **Totais financeiros fora da tabela**: «Custo total est.» e «Valor Vendas (s/IVA)» passam a `excelOnly` (semântica confirmada: só no Excel, nunca em
  HTML/PDF/impressão) e os seus totais vão para o **RESUMO FINANCEIRO** no fim (`meta.resumoFinal`, uma só vez): Unidades vendidas, Stock total, Custo total
  estimado (só com preços de compra; «PARCIAL: N linha(s) sem custo conhecido» — a lógica de `custoTotalDoRelatorio`), Valor total de vendas s/IVA (só com
  preços de venda). Sem preços → título «Resumo» só com unidades e stock. `aplicarPrivacidade` retira os itens sensíveis (também no servidor).
- **TOTAL ARTIGO**: só com > 1 farmácia; só totais mensais, total de unidades e stock; PVP/custo unit. **vazios** no HTML/PDF (`ReportColumn.vazioNoSubtotal`);
  no Excel a linha mantém-se como estava.
- **Excel idêntico a a012428** (comparação célula a célula, ver §5): para > 13 meses `a012428` trazia «Período: …» e os totais depois do Stock; essa folha mantém-se
  exatamente (posições e rótulos), só no Excel (`label`; o HTML usa `htmlLabel`).
- **Larguras (ordem de prioridade)**: meses abreviados «Out/25» → margens laterais **6,5 mm** (≥ 5 mm de segurança) → padding horizontal 5→4→3→2,5→2 px **antes**
  de tocar na letra → mês com a largura do seu maior texto (dados: dígitos, sinal, separador) → Descrição com quebra (mín. 32 mm, preferida 48 mm) →
  PVP/custo compactos → totais financeiros fora. Nunca truncar nem reticências.
- **Excesso**: `capacidadeA4(dados, opcoes)` (função pura) → `{cabe, mesesMax, padPx, pct…, mensagem}`; `capacidadeDoRelatorio(report)` (lib/reporting/layout-vendas.ts) usa-a
  no adapter, no servidor e na UI. Se não cabe: **não há PDF/impressão/PDF de email/pré-visualização**; mensagem
  **«O período de N meses não cabe numa página A4 legível (máximo M meses com estas opções). Reduza o período, retire preços ou use o Excel.»**;
  `/api/reports/pdf` e `/api/reports/email` (com PDF) → **HTTP 422** com o mesmo texto; o Excel e a tabela do ecrã continuam sem limite. Onde: `ReportActions`
  (aviso ao clicar Imprimir/PDF, aviso no diálogo de email), `printReport`, `renderReportHtml` (devolve só a mensagem — é o que a pré-visualização «Relatório» mostra),
  `buildReportPdfBuffer` (erro tipado `RelatorioNaoCabeA4Error`). `components/vendas/vendas-client.tsx` **não foi alterado**.
- Período > capacidade: **análise e proposta** (trimestres, por farmácia, etc.) em `notes/vendas-periodos-longos-proposta.md` — sem decisão.

## 3. Regra final de paginação (só vertical)
- Cada artigo (farmácias + TOTAL ARTIGO) é um `<tbody class="row-group">` com `break-inside: avoid`: **nunca dividido** (verificado em PDFs de 12-56 artigos e no PDF de 31 páginas).
- `thead { display: table-header-group }` repete o cabeçalho completo (os 14 meses…) em todas as páginas; sem `<tfoot>`.
- **TOTAL GERAL + resumo financeiro + notas** formam um único bloco (`tbody.totals-tbody`, indivisível) com `break-before: avoid`, e o último artigo tem `break-after: avoid`:
  ficam **com o fim do último artigo** quando cabe; senão o último artigo desce com eles para a última página, que começa com o cabeçalho da tabela. Nunca páginas órfãs
  só com totais (varrimento de 12 a 56 artigos, `test-vendas-tabela-unica` C5). Filete de 2 px entre artigos (borda inferior da última linha) e separadores verticais
  de mês de 1 px mantêm-se.

## 4. Capacidade (nº máximo de meses numa página A4 horizontal, corpo 8,25 pt)

Largura útil 284 mm. Larguras mínimas com os dados do cliente (pad 2 px): CNP 12,8 · Farmácia 23,4 · PVP 11,1 · Custo unit. 13,0 · Total unid. 10,8 · Stock 10,0 mm · **mês 11,4 mm** · Descrição ≥ 32 mm.

| Preços de venda | Preços de compra | dados moderados (totais mensais até 4 dígitos, PVP ≤ 91,80 €) | extremos (123 456 un., −12 345, 12 345,67 €, 1 234 567 total) |
|---|---|---|---|
| sim | sim | **14** | 10 |
| sim | não | 16 | 11 |
| não | sim | 15 | 11 |
| não | não | 17 | 12 |

(O requisito de 14 meses cumpre-se, com folga mínima, só com todos os preços ligados e dados moderados; com os dados do cliente: 14 meses, Descrição 43,9 mm.) 24 e 27 meses
**não cabem em nenhuma combinação** → mensagem.

## 5. Testes (comandos e resultados)

`TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/<teste>.ts`

| Teste | Resultado |
|---|---|
| `test-vendas-tabela-unica` (reescrito: capacidade pura, estrutura, ~45 PDFs reais, impressão, Excel vs a012428, 24/27 meses, rotas HTTP reais 200/422, outros relatórios, controlo negativo) | **189 OK, 0 falhas** |
| `test-vendas-mapa-visual` | 316 OK |
| `test-vendas-pdf-layout` | 42 OK |
| `test-vendas-impressao-hierarquia` | 26 OK |
| `test-vendas-separadores-meses` | 55 OK |
| `test-vendas-precos-pvp-stock` | 134 OK |
| `test-reporting-redesign` | 133 OK |
| `test-reporting-uniformizacao` | 107 OK |
| `test-margens` / `test-margens-pdf-modos` / `test-margens-stock` | 118 / 382 / 159 OK |
| `test-workspace-separadores` / `test-export-cabecalho-laboratorio` / `test-export-mesma-ordem-do-ecra` | 37 / 27 / 28 OK |
| `test-vendas-loader-pvp-stock-db` (Postgres descartável) | 24 OK |
| `tsc --noEmit`, `eslint` (lib/reporting, components/reporting, app/api/reports, testes novos) | 0 erros |

Falhas pré-existentes (idênticas em `a012428`, não relacionadas): `test-fase1-economia-ordenacao` (3), `test-excessos-transferencias` (2).

O que o `test-vendas-tabela-unica` prova (sobre PDFs REAIS lidos com PyMuPDF e a geometria das colunas no DOM em mídia print): A4 horizontal em todas as páginas (841,9×595 pt); 14 meses
«Out/25…Nov/26» na MESMA tabela e página; cada CNP uma só vez, em sequência; cada valor por linha = o do relatório (PVP, custo, meses, total, stock); PVP/custo vazios no TOTAL ARTIGO;
letra do corpo 8,25 pt (7,99 pt os cabeçalhos = 8 pt, arredondamento do Chromium), CNP/Descrição ≥ meses; nenhuma célula a transbordar (Range vs caixa de conteúdo) nem token fora da sua coluna;
um só «Total unid.», um só «Stock», um só TOTAL GERAL e um só resumo, no fim e com artigos; artigo nunca dividido; sem «Parte/bloco/Período:»; separadores verticais dos meses (15 por página); impressão = PDF
do endpoint (mesmo texto página a página); pré-visualização = impressão = PDF = email (mesmo HTML); Excel **idêntico** a `a012428` em 12 cenários (todas as células, tipos, formatos, larguras, fusões, filtro;
1/3/6/12/13/14/24/27 meses, 4 combinações de preços, valores extremos, agrupar por farmácia); 1, 3, 6, 12, 13, 14 meses e capacidade máxima por combinação, 1/2/3 farmácias, valores elevados/negativos;
24 e 27 meses: mensagem exata, sem tabela, Excel completo, rotas reais 422; HTML e CSS de outros relatórios byte a byte iguais aos de a012428; controlo negativo (a análise acusa letra de 7 pt e colunas erradas).

Testes antigos alterados (afirmavam o desenho anterior; cada alteração tem comentário «2026-11»): `test-vendas-pdf-layout` (meses «Jan/26» numa linha, «Total unid.»), `test-vendas-precos-pvp-stock`
(cabeçalhos sem «Valor Vendas»/«Custo total», resumo financeiro por combinação, 27 meses lidos nas colunas), `test-reporting-redesign` (sem densidade; TOTAL ARTIGO com células vazias em vez de «—»),
`test-vendas-mapa-visual` (custo total por linha só no Excel; totais no resumo; sem «+1 px»; tom de mês sólido; 27 meses → mensagem), `test-vendas-separadores-meses` (27 meses → capacidade máxima).
E2E escritos e **não executados**: `vendas-tabela-unica-browser` (reescrito), `vendas-mapa-visual-browser`, `vendas-opcoes-browser`, `vendas-separador-browser`, `vendas-separadores-meses-browser`.

## 6. Evidência (`docs/validacao-visual/2026-11-vendas-tabela-unica/`)

Dados sintéticos calibrados (`scripts/tests/_cliente-real.ts`): 326 artigos, Segurado + Silveirense, 14 meses, TOTAL GERAL 980…15 por mês (máx. 1 077), 13 613 unidades (o real: 14 350 — inconciliável com
máx. 1 077/mês), stock 1 492 (máx. 133), PVP ≤ 91,80 €, custo ≤ 48,18 €.

| Ficheiro | Conteúdo |
|---|---|
| `montagem-comparacao-escala-fisica.png` | linha 1: 1.ª página de A (a012428, 57 pág.), B (A3 rejeitado, 20 pág.) e C (nova, 31 pág.) ao mesmo DPI; linha 2: recorte de 297×210 mm do mesmo canto de cada, a 100 dpi |
| `medidas-comparacao.md` | tamanhos de letra e altura de algarismo medidos nas spans (A, B, C) |
| `comparacao-A-…-p1.png`, `comparacao-B-A3-p1.png`, `comparacao-C-A4-p1.png` | 1.ª página de cada um |
| `depois-A4-14m-p1.png`, `-pmid.png`, `-ultima.png` | A4 horizontal, 14 meses numa tabela; última página com o fim do último artigo, TOTAL GERAL e resumo financeiro |
| `depois-excesso-27m-mensagem.png` | pré-visualização/PDF para 27 meses: só a mensagem |
| `antes-vendas-14m-*`, `antes-vendas-27m-*`, `antes-vendas-14m-24-artigos.pdf` | mantidos (a012428: blocos) |

Medidas (PyMuPDF; mm = pt × 0,3528; algarismo = tamanho × 0,716):

| | papel | pág. | CNP | Descrição | valores mensais | cabeçalhos |
|---|---|---|---|---|---|---|
| A · a012428 | A4 | 57 | 6,75 pt (1,71 mm) | 6,75 pt | 7,5 pt (1,89 mm) | 6,0 pt (1,52 mm) |
| B · A3 rejeitado | **A3** | 20 | 7,5 pt (1,89 mm) | 7,5 pt | 8,25 pt (2,08 mm) | 6,75 pt (1,71 mm) |
| C · nova | A4 | 31 | **8,25 pt (2,08 mm)** | 8,25 pt | **8,25 pt (2,08 mm)** | **8,0 pt (2,02 mm)** |

Logo, fisicamente a letra de C ≥ B (mesmo A3) e > A em todas as categorias, e a tabela cabe num único A4.

## 7. Riscos
- Capacidade com folga mínima: 14 meses com todos os preços e dados moderados cabem (Descrição 43,9 mm no caso do cliente), mas valores muito largos (PVP ≥ 100 €, 6 dígitos num mês) reduzem a capacidade para 10-13 meses → mensagem. É deliberado (nunca letra < 8 pt).
- A capacidade (e o «máximo M») depende dos dados do resultado selecionado, não só do período.
- Larguras assumem Arial/Liberation Sans. Num browser sem nenhuma das duas, a pré-visualização/impressão pode quebrar; o PDF do servidor usa o Chromium do contentor (fonts-liberation instalado — `deploy/docker/Dockerfile`).
- O Excel de > 13 meses conserva as etiquetas «Período: …» de a012428 (decisão para não mudar o Excel).
- PDF: o Chromium gera PDFs «tagged» (~200 KB/página); inalterado (opção do endpoint).
- E2E de browser não executados; ver §8.

## 8. A validar no clone limpo (coordenador)
1. `npx tsc --noEmit`; `npx eslint lib/reporting components/reporting app/api/reports scripts/tests scripts/e2e/vendas-*.ts`.
2. `npx next build` (com `SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100"`) e, com o Postgres descartável: `vendas-tabela-unica-browser.ts` (novo desenho: 1/3/14 meses A4; 27 meses mensagem; email com PDF recusado e só Excel),
   `vendas-mapa-visual-browser.ts`, `vendas-opcoes-browser.ts`, `vendas-separador-browser.ts`, `vendas-separadores-meses-browser.ts`.
3. Abrir um PDF real de 14 meses da farmácia e imprimir em A4 sem ampliação.
4. Worktree temporário usado para a comparação: `C:\projetos\_clean\tmpB` (removido no fim).
