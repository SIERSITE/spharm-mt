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
- **Tipografia**: TUDO na tabela (corpo e cabeçalhos) a **10,7 px = 8,025 pt** (o PDF mede 8,02 pt; ≥ 8,0 pt). CNP e Descrição = valores mensais. Tipo de letra fixo
  `Arial, "Liberation Sans"` (métricas Arial; o contentor tem `fonts-liberation`), por isso a largura calcula-se com larguras reais de glifo (`metricas-fonte.ts`).
  (Decisão revista: o corpo esteve a 8,25 pt; baixou-se a 8,025 pt para garantir os 14 meses nos limites abaixo. Os meses ficam 0,23 pt abaixo dos 8,25 pt da solução A3 rejeitada.)
- **Colunas da tabela**: CNP · Descrição · Farmácia · PVP €* · Custo unit. €* · N meses «Out/25» (uma linha) · **Total unid.** · **Stock** (*opções de preços).
- **«€» no cabeçalho**: as células de PVP e custo unitário mostram «9999,99» sem « €»; o símbolo está no cabeçalho («PVP €», «Custo unit. €»). Só HTML/PDF/impressão
  (`ReportColumn.semSimbolo` + `htmlLabel`); o Excel continua com o formato monetário e os rótulos de sempre.
- **Totais financeiros fora da tabela**: «Custo total est.» e «Valor Vendas (s/IVA)» são `excelOnly` e os seus totais vão para o **RESUMO FINANCEIRO** no fim (`meta.resumoFinal`, uma só
  vez): Unidades vendidas, Stock total, Custo total estimado (só com preços de compra; «PARCIAL: N linha(s) sem custo conhecido»), Valor total de vendas s/IVA (só com preços de venda).
  Sem preços → título «Resumo» só com unidades e stock. `aplicarPrivacidade` retira os itens sensíveis (também no servidor).
- **TOTAL ARTIGO**: só com > 1 farmácia; só totais mensais, total de unidades e stock; PVP/custo vazios no HTML/PDF; o rótulo quebra em duas linhas («TOTAL / ARTIGO»).
- **Farmácia**: coluna elástica que quebra linha (`ReportColumn.quebra`): conteúdo ≤ 54 px (cabe «Silveirense»); nomes longos (até 32 caracteres testados) quebram entre palavras e dentro da palavra.
- **Excel idêntico a a012428** (12 cenários, célula a célula). Para > 13 meses `a012428` trazia «Período: …» e os totais depois do Stock; essa folha mantém-se exatamente.
- **Excesso e GARANTIA DOS 14 MESES** (`lib/reporting/layout-largura.ts`, função pura `capacidadeA4`):
  - **Até 14 meses** a decisão NÃO depende de heurística sobre os dados: dentro dos **limites numéricos fixos** abaixo, 14 meses (e menos) CABEM SEMPRE, com preços de venda E de compra,
    corpo ≥ 8 pt, Descrição ≥ 45 mm e sem cortar nada. A prova é o orçamento de largura do pior caso simultâneo (`orcamentoPiorCaso`, teste «PROVA POR CÁLCULO») e uma grelha de 13 824 combinações.
  - **Só se recusa (HTTP 422)** quando algum valor ultrapassa um limite; a mensagem diz o valor e o limite concretos, p.ex.
    «PVP de 12 345,67 € excede o limite de 9 999,99 € do PDF A4 legível. Reduza a seleção, retire preços ou use o Excel.» (idem custo unitário, valor mensal, total de unidades, stock).
    Com «Incluir preços de venda/compra» desligado o respetivo limite não se aplica.
  - **Acima de 14 meses** a capacidade depende dos DADOS (largura do maior texto de cada coluna) e a mensagem é
    **«O período de N meses não cabe numa página A4 legível (máximo M meses com estas opções). Reduza o período, retire preços ou use o Excel.»**
  - Onde: `ReportActions` (aviso ao clicar Imprimir/PDF e no diálogo de email; o aviso é `pointer-events-none` e desaparece em 8 s), `printReport`, `renderReportHtml` (só a mensagem — é o que a pré-visualização
    mostra), `buildReportPdfBuffer` (`RelatorioNaoCabeA4Error`), rotas `/api/reports/pdf` e `/api/reports/email` (422). `components/vendas/vendas-client.tsx` **não foi alterado**.
- Períodos de 24/27 meses: **análise e proposta** em `notes/vendas-periodos-longos-proposta.md` — sem decisão.

### Limites numéricos fixos (valores em módulo)
| Valor | Limite |
|---|---|
| PVP e custo unitário | **9 999,99 €** |
| Qualquer valor mensal (célula, TOTAL ARTIGO, TOTAL GERAL), positivo ou negativo | **99 999** (inclui «−99 999») |
| Total unid. e Stock (linhas, TOTAL ARTIGO, TOTAL GERAL) | **999 999** (inclui negativos) |
| Descrição | qualquer comprimento (quebra); largura garantida **≥ 45 mm** |
| Farmácia | qualquer nome (quebra); 2 e 3 farmácias por artigo |
| Meses garantidos | **14** |

### Orçamento de largura do pior caso (mm; 14 meses; padding 1,5 px; margens laterais de 6 mm ⇒ útil 285 mm)
Larguras de glifo reais (Arial Bold 10,7 px, +1 % e +1 px de segurança); pior caso simultâneo: PVP/custo «9999,99», mensal «-99 999», total/stock «-999 999», CNP de 7 dígitos, «Silveirense».

| venda | compra | CNP | Farmácia | PVP € | Custo € | Total unid. | Stock | 14 × mês (11,28 cada) | fixos + meses | sobra para a Descrição |
|---|---|---|---|---|---|---|---|---|---|---|
| sim | sim | 12,2 | 15,1 | 11,4 | 11,4 | 12,9 | 13,9 | 158,0 | 234,8 | **50,2** |
| sim | não | 12,2 | 15,1 | 11,4 | — | 12,9 | 13,9 | 158,0 | 223,5 | 61,5 |
| não | sim | 12,2 | 15,1 | — | 11,4 | 12,9 | 13,9 | 158,0 | 223,5 | 61,5 |
| não | não | 12,2 | 15,1 | — | — | 12,9 | 13,9 | 158,0 | 212,1 | 72,9 |

Poupanças de largura aplicadas por esta ordem (sem baixar de 8 pt): cabeçalhos compactos («PVP €», «Custo unit. €», «Out/25»), «€» fora das células, margens de 6 mm, padding 5 → 1,5 px
(quando os dados reais deixam espaço o padding sobe; com o pior caso fica em 1,5 px), Farmácia a quebrar linha, larguras por dígitos máximos dos limites, Descrição como coluna elástica.
Mês: «-99 999» = 37,3 px vs «Nov/26» a negrito = 35 px.
## 3. Regra final de paginação (só vertical)
- Cada artigo (farmácias + TOTAL ARTIGO) é um `<tbody class="row-group">` com `break-inside: avoid`: **nunca dividido** (verificado em PDFs de 12-56 artigos e no PDF de 31 páginas).
- `thead { display: table-header-group }` repete o cabeçalho completo (os 14 meses…) em todas as páginas; sem `<tfoot>`.
- **TOTAL GERAL + resumo financeiro + notas** formam um único bloco (`tbody.totals-tbody`, indivisível) com `break-before: avoid`, e o último artigo tem `break-after: avoid`:
  ficam **com o fim do último artigo** quando cabe; senão o último artigo desce com eles para a última página, que começa com o cabeçalho da tabela. Nunca páginas órfãs
  só com totais (varrimento de 12 a 56 artigos, `test-vendas-tabela-unica` C5). Filete de 2 px entre artigos (borda inferior da última linha) e separadores verticais
  de mês de 1 px mantêm-se.

## 4. Capacidade acima de 14 meses (depende dos dados; margens de 6 mm, útil 285 mm)

| Preços de venda | Preços de compra | dados moderados (≤ 1 077 por mês; PVP ≤ 91,80 €) | pior caso dos limites |
|---|---|---|---|
| sim | sim | 15 | 14 |
| sim | não | 16 | 15 |
| não | sim | 16 | 15 |
| não | não | 17 | 16 |

Até 14 meses: **sempre cabe** dentro dos limites (ver §2). 24 e 27 meses não cabem em nenhuma combinação → mensagem.
## 5. Testes (comandos e resultados)

`export TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres; npx tsx scripts/tests/<teste>.ts` — resultados finais no relatório de entrega (SHA final).

`test-vendas-tabela-unica` cobre: capacidade pura (limites, orçamento do pior caso, grelha de 13 824 combinações, mensagens com o limite concreto, capacidade > 14 meses); estrutura (colunas,
«€» no cabeçalho, resumo financeiro por combinação, TOTAL ARTIGO, Excel); PDFs reais (Chromium → PyMuPDF + geometria no DOM) de 1/3/6/12/13/14 meses, capacidade máxima, 1/2/3 farmácias,
**«PDF real ×1 e ×10»** (326 artigos, 326 CNP distintos = 326 ocorrências, 1 TOTAL GERAL, 1 resumo, 14 cabeçalhos de mês por página), PVP/custo de 9,99 / 99,99 / 999,99 / 9 999,99 €,
valores mensais de 9 … 99 999 (±), total/stock até 999 000, **pior caso simultâneo** com 2 e 3 farmácias e as 4 combinações de preços, varrimento de paginação, impressão = PDF, Excel idêntico a a012428,
24/27 meses → mensagem, rotas HTTP reais (200/422), HTML/CSS de outros relatórios idênticos a a012428, controlo negativo.
Em cada PDF: A4 horizontal, 14 meses na mesma tabela, corpo ≥ 8 pt, nenhuma célula a transbordar (Range vs caixa), nenhum token fora da sua coluna, nenhum CNP repetido, nenhum artigo dividido, um TOTAL GERAL e um resumo.

Testes antigos alterados (afirmavam o desenho anterior; comentário «2026-11»): `test-vendas-pdf-layout`, `test-vendas-precos-pvp-stock` (sentinelas ≤ 9 999,99 €: os de 11 111,11 € ultrapassam o limite), `test-reporting-redesign`,
`test-vendas-mapa-visual` (idem; «TOTAL ARTIGO» em duas linhas), `test-vendas-separadores-meses`. E2E: `vendas-tabela-unica-browser`, `vendas-mapa-visual-browser` (custos de teste ≤ 9 999,99 €), `vendas-opcoes-browser`,
`vendas-separador-browser`, `vendas-separadores-meses-browser`.

**Falhas pré-existentes** (idênticas em `a012428`): `test-fase1-economia-ordenacao` (3), `test-excessos-transferencias` (2).
## 6. Evidência
- **No Git** (`docs/validacao-visual/2026-11-vendas-tabela-unica/`, só dados SINTÉTICOS): `montagem-comparacao-escala-fisica.png` (A: a012428, B: A3 rejeitado, C: nova, mesma escala), `medidas-comparacao.md`,
  `depois-A4-x10-p1/-pmid/-ultima.png` (cenário «real ×10»), `depois-A4-pior-caso-3f-p1.png` (pior caso, 3 farmácias), `depois-excesso-27m-mensagem.png`, `antes-*` (a012428).
- **Fora do Git** (`C:\projetos\_entregas\vendas-a4-evidencia\`): páginas do PDF REAL (1, 29, 57) e do novo (1, intermédia, última) a 100 dpi (= escala física 100 %: 1 px = 0,254 mm; A4 horizontal = 1169 × 827 px),
  `montagem-real-vs-novo.png`, `medidas-e-provas.md` (fontes, 326 = 326 CNP, 1 TOTAL GERAL, 1 resumo, 14 cabeçalhos por página). Análise agregada do PDF real: `notes/vendas-pdf-real-analise.md`.
- Medidas A/B/C sintéticas: A (a012428) CNP/Descrição 6,75 pt, meses 7,5 pt, cabeçalhos 6,0 pt; B (A3) 7,5 / 8,25 / 6,75 pt; C (nova) **8,02 pt em tudo**.
## 7. Riscos
- Os 14 meses só são garantidos DENTRO dos limites (PVP/custo ≤ 9 999,99 €, mensal ≤ 99 999, total/stock ≤ 999 999); acima, 422 com o limite concreto.
- Padding de 1,5 px nos casos extremos: valores adjacentes («9999,99 9999,99») ficam separados só pelo padding (legíveis, ver `depois-A4-pior-caso-3f-p1.png`).
- Acima de 14 meses a capacidade depende dos dados do resultado selecionado.
- Larguras assumem Arial/Liberation Sans; num browser sem nenhuma das duas a pré-visualização/impressão pode quebrar; o PDF do servidor usa o Chromium do contentor (`fonts-liberation`).
- O Excel de > 13 meses conserva as etiquetas «Período: …» de a012428. PDF «tagged» (~200 KB/página) inalterado.

## 8. A validar no clone limpo (coordenador)
1. `npx tsc --noEmit`; `npx eslint lib/reporting components/reporting app/api/reports scripts/tests scripts/e2e/vendas-*.ts`.
2. `npx next build` (com `SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100"`) e, com o Postgres descartável: `vendas-tabela-unica-browser.ts` (novo desenho: 1/3/14 meses A4; 27 meses mensagem; email com PDF recusado e só Excel),
   `vendas-mapa-visual-browser.ts`, `vendas-opcoes-browser.ts`, `vendas-separador-browser.ts`, `vendas-separadores-meses-browser.ts`.
3. Abrir um PDF real de 14 meses da farmácia e imprimir em A4 sem ampliação.
4. Worktree temporário usado para a comparação: `C:\projetos\_clean\tmpB` (removido no fim).
