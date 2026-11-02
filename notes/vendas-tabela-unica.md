# Mapa de Vendas numa só tabela contínua (sem blocos temporais) — papel A4/A3 automático

Base: `a012428d5409defadac93782b3193890f4ed211f`. Branch `feat/vendas-tabela-unica-sem-blocos`. **Sem migrations. Sem alterações a cálculos, filtros, seleção, ordenação, stock, Excel (`buildReportWorkbook`), e-mail, tabela interativa «Tabela» (`components/vendas`) nem a Margens/Inventário/Stock/restantes relatórios.**

## 1. O problema (PDF real do cliente) e a causa raiz

PDF do cliente (Garantia, 2025-10-01 a 2026-11-02 = 14 meses, 326 artigos, 2 farmácias): **57 páginas**; «Parte 1 de 2 · Meses Out/25 a Abr/26» (págs. 1-28) e «Parte 2 de 2 · Meses Mai/26 a Nov/26» (págs. 29-57); cada artigo (CNP, descrição, farmácias, PVP, custo, stock) duas vezes; «Total unid. do bloco» ×2; «Período: Total unid.»; colunas «Período: custo total» e «Período: valor vendas» só na parte 2; TOTAL GERAL só no fim.

Causa (código em `a012428`):

| Onde | O quê |
|---|---|
| `lib/reporting/adapters/vendas.ts:239` | `MAX_MESES_POR_BLOCO = 13` |
| `vendas.ts:290-296` | `repartirMeses(n)`: acima de 13 meses → `⌈n/13⌉` blocos (14 → 7+7; 27 → 9+9+9) |
| `vendas.ts:330,340-345,388-401,408-421` | `emBlocos`: rótulos «Período: …», colunas «Total unid. do bloco» (`tb_i`, `htmlOnly`) |
| `vendas.ts:775-797` | `columnBlocks` (título «Meses X a Y · «Total unid. do bloco» soma apenas estes meses…» e lista `omitir`) |
| `vendas.ts:815-817` | nota de rodapé «Período de N meses em K blocos…» |
| `lib/reporting/report-types.ts:294` | `ReportMeta.columnBlocks` |
| `lib/reporting/report-html.ts:333-334,552-564,1193` | `renderBloco` por bloco, «Parte i de n», `.bloco-novo { break-before: page }` |
| `lib/reporting/privacidade.ts:83` | propagava `columnBlocks` |
| `report-html.ts:589,1217` · `report-pdf-server.ts:200` · `report-print.ts:12,56-57` | papel fixo **A4** (`@page`, `format: "A4"`, iframe 297×210 mm) — sem forma de usar A3 |

A falta de largura (muitos meses × PVP/custos/valor) era resolvida repetindo cada artigo por «blocos» de meses. Reprodução fiel antes da correção (326 artigos sintéticos, mesmas condições): **56 páginas A4 (14 meses) e 105 páginas A4 (27 meses)** — ver as capturas «antes».

## 2. O que mudou

Ficheiros novos: `lib/reporting/layout-largura.ts` (regra pura de largura/papel), `lib/reporting/pdf-opcoes.ts` (opções do `page.pdf()` partilhadas pelo endpoint e pelos testes).
Alterados: `adapters/vendas.ts` (sem blocos; usa `decidirLayout`), `report-types.ts` (sem `columnBlocks`; novos `paperSize`, `pageMarginMm`, `contentZoom`, `compactMonths`, `layoutMinWidthMm`, `layoutFitsA4`), `report-html.ts` (uma só tabela; `@page` A3 e margem por meta; largura mínima de ecrã; sem CSS/HTML de blocos), `privacidade.ts`, `report-pdf-server.ts`, `report-print.ts`. Excel (`report-excel-buffer.ts`), e-mail (`app/api/reports/email`), endpoint (`app/api/reports/pdf`) **intocados** — usam o mesmo `buildReportPdfBuffer`, que agora lê o papel de `meta.paperSize`.

Layout (uma tabela, todos os meses): `CNP · Descrição · Farmácia · PVP · Custo unit. est. · Custo total est. · N meses · Total Unid. (período completo) · Stock · Valor Vendas (s/IVA)` — a mesma sequência de sempre para ≤ 13 meses. `PVP`/`Custo…`/`Valor…` só existem com as respetivas opções (preços de venda/compra) e as larguras recalculam-se por combinação. Rodapé: sem explicação de blocos; só no limite absoluto (ver §3) acrescenta uma frase sobre a escala.

## 3. Regra de LARGURA e PAPEL (`lib/reporting/layout-largura.ts`, função pura `decidirLayout`)

Entrada: nº de meses, opções de preços e os **textos já formatados de cada coluna** (maior nº de dígitos por coluna, negativos e valores elevados incluídos; os totais de cada mês, linhas e TOTAL GERAL entram na medição). Métrica de texto conservadora (fonte larga, DejaVu bold ×1,1, +4 %).

Valores (mm; 1 px CSS = 25,4/96 mm):

| Parâmetro | Valor |
|---|---|
| Área útil A4 horizontal | 297 − 2×8 = **281 mm** |
| Área útil A3 horizontal | 420 − 2×8 = **404 mm** (A3 degradado: margens de 6 mm → 408 mm) |
| Folga exigida para escolher um papel | 2 mm |
| Tipografia mínima (px CSS) | números 9,5 px = **7,1 pt** (texto 8,5 + 1); texto 8,5 px = 6,4 pt; cabeçalhos 7,5 px = 5,6 pt (densidade `ultratight`, o piso) |
| Densidades | `cozy` (10/9 px, pad 5), `tight` (9/8, pad 4), `ultratight` (8,5/7,5, pad 3) |
| Coluna de mês | mínimo 7,5 mm e a largura do SEU texto mais largo; confortável 11,8 mm (17,4 mm até 6 meses) |
| Descrição | mínimo 34 mm (31 mm na degradação); alvo 40 mm (62 mm até 6 meses) |

Algoritmo (primeiro candidato que cabe com 2 mm de folga):
1. **A4** horizontal, densidade natural pelo nº de meses (≤ 6 `cozy`, ≤ 10 `tight`, senão `ultratight` — igual ao que havia para ≤ 13 meses) e, se não couber, as mais apertadas.
2. **A3** horizontal, da densidade mais arejada (`cozy`) para a mais apertada (o papel maior paga o conforto).
3. **Degradação controlada (A3)**: meses abreviados à inicial («J\n26»), margens de 6 mm, células dos meses com 1,5 px de padding lateral e números a 8,5 px (`meta.compactMonths`).
4. **Limite absoluto**: nem isso chega → `zoom = útil/necessário` (< 1) sobre a página inteira, com aviso no rodapé. **Nunca** blocos, nunca repetir artigos, nunca cortar um número.

Propagação: `report.meta.paperSize` ("A4"/"A3"), `pageMarginMm`, `contentZoom`, `compactMonths`, `layoutMinWidthMm`, `layoutFitsA4`.
- HTML: `@page { size: A3 landscape }` (e `margin: 10mm 6mm` na degradação); a pré-visualização «Relatório» (iframe) tem `min-width` = largura útil do papel + padding (scroll horizontal se a janela for mais estreita, nunca colunas espremidas/cortadas).
- PDF (endpoint e anexo de e-mail — mesmo `buildReportPdfBuffer`): `format` e margens de `opcoesPdfDoRelatorio(report)` (`preferCSSPageSize` mantém-se).
- Impressão (`printReport`): o iframe tem o tamanho real do papel (A3 → 420×297 mm); o `@page` do HTML pede o mesmo papel ao diálogo do browser.
- Outros relatórios (sem `meta.paperSize`): `@page` A4, margens 8 mm, iframe 297×210 mm — exatamente como antes (um teste fixa a string de `report-html.ts`).

### Máximo de meses suportado
O mapa **não impõe limite** de meses (a janela é qualquer intervalo de datas; `bucketsDaJanela` devolve um mês por mês civil; não há tecto na UI/servidor/adapter — o único «máximo» que existia era o dos blocos, `MAX_MESES_POR_BLOCO = 13`, agora removido). O limite é de **leitura**, depende dos dados e das opções (nº máximo de meses que ainda cabem em cada nível, calculado por `decidirLayout`):

| Textos de coluna / opções | A4 normal | A3 normal | A3 degradado (meses abreviados, margens 6 mm) |
|---|---|---|---|
| moderados (totais mensais ≤ 4 dígitos) · todos os preços | 11 | 22 | **27** |
| moderados · só venda ou só compra | 14 | 25 | 31 |
| moderados · sem preços | 17 | 28 | 34 |
| extremos (123 456 un., 12 345,67 €, −12 345 por mês) · todos os preços | 6 | 14 | 17 |
| extremos · só venda ou só compra | 9 | 17 | 21 |
| extremos · sem preços | 12 | 20 | 24 |

Acima da última coluna aplica-se o `zoom` (limite absoluto): moderados, todos os preços — 30 meses ≈ 95 %, 36 meses ≈ 84 %, 60 meses ≈ 58 % (a letra já não cumpre o piso; aviso no rodapé). Nunca há blocos.

## 4. Paginação (só vertical)
- Cada artigo (CNP + farmácias + TOTAL ARTIGO) é um `<tbody class="row-group">` com `break-inside: avoid`; `tr { page-break-inside: avoid }`; `tr.subtotal-row { break-before: avoid }`.
- `thead { display: table-header-group }` repete o cabeçalho **completo** (todos os meses, Total Unid., Stock, preços) em cada página; **sem** `<tfoot>` (o TOTAL GERAL aparece uma só vez).
- O último artigo leva `row-group-ultimo { break-after: avoid }` e `.totals-tbody { break-before: avoid }`: o TOTAL GERAL fica sempre com o último artigo. O separador de 2 px entre artigos é a borda inferior da última linha de cada artigo (não o topo da seguinte): nenhum filete isolado no topo de uma página nem antes do 1.º artigo.
- Confirmado nos PDFs reais (§6): nunca um artigo dividido entre páginas; TOTAL GERAL na página do último artigo; uma só linha de cabeçalho por página; páginas A4/A3 com a mesma dimensão (nenhuma página «parte» de meses).
- Restrição conhecida (já existia): um artigo com mais de 14 linhas (farmácias) não usa `rowspan` e pode, por si só, atravessar uma página.

## 5. Testes (comandos e números)

Novo: `npx tsx scripts/tests/test-vendas-tabela-unica.ts` — **164 OK, 0 falhas** (≈ 45 PDFs reais; `TABELA_UNICA_RAPIDO=1` corre um subconjunto).
- A — `decidirLayout`: determinismo; A4 ⇔ cabe com folga; monotonia e **ponto de transição A4→A3 exato** para cada combinação de preços (textos moderados e extremos); 12/13/14 meses × 4 combinações; valores muito longos; mínimos por coluna; degradação (27 meses → A3 abreviado, margens 6 mm); limite (60 meses → escala 58 % + aviso); máximos sem degradar.
- B — sem blocos no adapter/tipos/HTML/privacidade/pdf/print (`git grep`), uma só `<table>`/`<thead>`/TOTAL GERAL, ordem de colunas, rótulos de mês, `aplicarPrivacidade` idempotente, larguras recalculadas por combinação.
- C — **PDFs reais** (Chromium → PDF → PyMuPDF; as opções do endpoint vêm de `pdf-opcoes.ts`): 1, 3, 6, 12, 13, 14, 24, 27 e 36 meses (todos os preços), 3 combinações de preços restantes em 1/3/14/27 meses, 1 e 3 farmácias, valores elevados/negativos (1/6/12/14/24 meses + 3 combinações em 14), relatórios com 150 artigos (várias páginas, 2 e 3 farmácias, e sem preços). Em CADA PDF: papel certo (A4/A3 horizontal em todas as páginas); um só cabeçalho por página com N meses; **cada CNP uma só vez**; sequência de linhas igual à do relatório (uma linha por farmácia, TOTAL ARTIGO só se > 1 farmácia, nunca repetido); **todos os valores por linha** (PVP, custo unit., custo total, N meses, Total Unid., Stock, Valor) iguais aos dados brutos; soma dos meses = Total Unid.; TOTAL ARTIGO = soma das farmácias; **TOTAL GERAL** (totais mensais, do período, custo, stock, valor) = soma dos dados; um só TOTAL GERAL; nenhum texto «Parte/bloco/Período:»; artigo nunca dividido entre páginas e TOTAL GERAL com o último artigo; nenhum token fora da área útil, sem reticências, sem sobreposição de caixas; fonte mínima medida (pt) contra o piso.
- D — impressão (HTML do iframe + `emulateMediaType('print')`): mesmo papel, mesmas verificações e **conteúdo idêntico** ao do PDF.
- E — pré-visualização «Relatório» a 1366/1920 px (3 e 14 meses A4; 27 meses A3): tabela ≥ largura do papel, scroll horizontal, nada cortado.
- F — Excel (`buildReportWorkbook` lido com `xlsx`): todos os meses, valores e soma por linha corretos, um só «Total Unid.»/«Stock».
- G — e-mail/endpoint usam o mesmo `buildReportPdfBuffer`/`opcoesPdfDoRelatorio`; outros relatórios continuam A4.
- H — separadores: filetes verticais dos meses (contínuos do cabeçalho ao TOTAL GERAL, N+1 por página, 0,67–0,83 pt) e filete de 2 px entre artigos, em PDFs **A4 e A3** (1.ª e última páginas).

Testes antigos (só no que concerne a blocos; cada alteração tem comentário «2026-11»):

| Teste | Antes | Depois | Alteração e justificação |
|---|---|---|---|
| `test-vendas-mapa-visual.ts` | 5 secções afirmavam blocos (`MAX_MESES_POR_BLOCO`, `repartirMeses`, `columnBlocks`, «Parte i de n», «Total unid. do bloco», «Período:», 27 meses = 3 blocos, TOTAL GERAL no fim do último bloco) | **324 → 316 OK** (menos asserções: as secções de blocos encolheram) | A e D passam a afirmar o contrário (uma tabela, cada artigo 1×, N meses por página, um só «Total Unid.», TOTAL GERAL no fim); secção de preços: soma de larguras = 100 em vez de «≤ 100 por bloco»; o helper de PDF usa `opcoesPdfDoRelatorio` (A4/A3). |
| `test-vendas-pdf-layout.ts` | soma por bloco (41 OK) | 41 OK | soma única = 100 até 36 meses. |
| `test-vendas-separadores-meses.ts` | meses por bloco/página (54 OK) | 54 OK | todos os meses em cada página (14 e 27 meses sem blocos), PDF com `opcoesPdfDoRelatorio`. |
| `test-vendas-precos-pvp-stock.ts` | afirmava «do bloco» e «Período: Total unid.» com 27 meses (130 OK) | 130 OK | uma só coluna destacada «Total Unid.», sem `tb_*`. |
| `test-reporting-redesign.ts` | `repartirMeses` e soma por bloco; secção H lia as opções do PDF em `report-pdf-server.ts` (132 OK) | 133 OK | soma = 100; densidade válida (≤ 6 meses ⇒ `cozy`; A3 permite tipografia mais arejada); as opções do `page.pdf()` vivem agora em `pdf-opcoes.ts` (verifica-se que `report-pdf-server.ts` as usa). |
| E2E `vendas-mapa-visual-browser.ts`, `vendas-separadores-meses-browser.ts`, `vendas-separador-browser.ts` | blocos/«Parte»/A4 fixo | escritos, não executados | idem; o `@page` do HTML manda (A4/A3). |
| `test-vendas-impressao-hierarquia.ts` (26), `test-reporting-uniformizacao.ts` (107), `test-margens.ts` (118), `test-margens-pdf-modos.ts` (382), `test-workspace-separadores.ts` (37), `test-export-cabecalho-laboratorio.ts` (27) | idem | idem | **sem alterações** — passam tal como estavam. |

Outros testes que importam o relatório/adapter (correr no worktree): `test-correccoes-2026-09` 87 OK, `test-export-mesma-ordem-do-ecra` 28, `test-forma-farmaceutica-filtro` 72, `test-margens-stock` 159, `test-ordenacao-custo-selecao` 43, `test-forma-devolucoes-manutencao-db` 70, `test-forma-farmaceutica-db` 131, `test-vendas-loader-pvp-stock-db` 24 — todos sem falhas.

**Falhas pré-existentes (idênticas em `a012428`, não relacionadas)**: `test-fase1-economia-ordenacao.ts` 149 OK / 3 falhas («Ficha: custo por farmácia», «custo de referência do grupo», «…ao lado do PVP de referência») e `test-excessos-transferencias.ts`: 159 OK / 2 falhas (também em `a012428`: «Transferências envia dataInicio/dataFim…», «a janela é usada na query de vendas») — não relacionadas.

## 6. Evidência (`docs/validacao-visual/2026-11-vendas-tabela-unica/`)

Dados sintéticos: 326 artigos (1/3 só numa farmácia), 2 farmácias, totais mensais em milhares — o mesmo gerador (`scripts/e2e/gerar-evidencia-tabela-unica.ts`) nas duas árvores.

| Ficheiro | Conteúdo |
|---|---|
| `antes-vendas-14m-p1.png` / `-pmid.png` | `a012428`, 14 meses: **56 pág. A4**; pág. 1 = «Parte 1 de 2 · Meses Out/25 a Abr/26 · «Total unid. do bloco» soma apenas estes meses»; pág. 29 = «Parte 2 de 2» com «Período: Total unid.», «Período: custo total», «Período: valor vendas»; cada artigo ×2 |
| `depois-vendas-14m-p1.png` / `-pmid.png` | 14 meses: **20 pág. A3**, uma tabela, 14 meses + Total Unid. + Stock + Valor Vendas, cada artigo 1× |
| `antes-vendas-27m-p1.png` / `-pmid.png` | 27 meses: **105 pág. A4**, «Parte 1 de 3…» (9 meses por bloco; descrição a quebrar em 3-4 linhas) |
| `depois-vendas-27m-p1.png` / `-pmid.png` | 27 meses: **18 pág. A3** (dados moderados: papel A3, degradação: meses «O N D J F M…», margens 6 mm); cabeçalho completo repetido na pág. intermédia |
| `depois-extremos-12m-p1.png` | valores elevados e negativos (123 456 un., 12 345,67 €, −12 345, 1 524 900 121,39 € de custo): A3, nada cortado |
| `depois-extremos-24m-limite-escala-p1.png` | o LIMITE: 24 meses com valores extremos → A3 degradado + escala 82 % e frase de aviso no rodapé (tipografia abaixo do piso) |
| `antes-vendas-14m-24-artigos.pdf` / `depois-vendas-27m-24-artigos.pdf` | PDFs pequenos (24 artigos): «Parte 1/2» em A4 vs tabela única A3 de 27 meses |

Comparação com o PDF real descrito: o «antes» sintético dá 56 páginas (o real, 57), com «Parte 1 de 2 / Parte 2 de 2», cada artigo duas vezes e as colunas «Período:» só na 2.ª parte; o «depois» dá 20 páginas A3 com cada artigo uma vez, **sem** blocos, «Total unid. do bloco» nem «Período:». Visto a olho nas imagens: sem blocos, sem cortes, A3 quando as colunas não cabem, números legíveis (≥ 7,1 pt fora da degradação; 6,4 pt na degradação; 5,2 pt só no limite com escala).

## 7. Riscos e limitações
- O papel depende dos DADOS (textos mais largos de cada coluna): o mesmo período dá A4 numa farmácia pequena e A3 numa grande. É deliberado (nunca cortar) mas muda o formato entre relatórios.
- A3 exige impressora/papel A3 (ou «ajustar à página» no diálogo do browser, o que reduz a letra); o PDF é A3 e o e-mail anexa-o como tal.
- Acima do limite do A3 degradado (27 meses com dados moderados e todos os preços; 17 com valores extremos — ver §3) a tipografia desce abaixo do piso (escala) — há aviso no rodapé, mas a legibilidade piora de forma contínua (36 meses ≈ 84 %, 60 meses ≈ 58 %).
- O Python do PyMuPDF é lento em A3 (a verificação de filetes renderiza pixéis): `test-vendas-tabela-unica.ts` demora 20-25 min numa máquina carregada.
- A pré-visualização «Relatório» (iframe de ecrã) fica com largura mínima do papel: em janelas estreitas há scroll horizontal dentro do iframe (comportamento pretendido).
- Documentos antigos já gerados (PDF com «Parte i de n») não são alterados; só os novos.

## 8. A validar no clone limpo (coordenador)
1. `npx tsc --noEmit`, `npx eslint lib/reporting scripts/tests/test-vendas-tabela-unica.ts scripts/tests/_*tabela-unica.ts scripts/e2e/vendas-tabela-unica-browser.ts`.
2. `npx next build` com `SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100"` e, com o PostgreSQL descartável (`TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres`):
   - `npx tsx scripts/e2e/vendas-tabela-unica-browser.ts` (novo): Relatório a 3 resoluções, impressão (iframe do tamanho do papel), PDF real, PDF recebido por e-mail e Excel para 1/3/14/27 meses × com/sem preços.
   - `vendas-mapa-visual-browser.ts`, `vendas-separadores-meses-browser.ts`, `vendas-opcoes-browser.ts`, `vendas-separador-browser.ts` (atualizados).
3. Rever a olho, num PDF real da farmácia, o caso dos 14 meses (A3) e que o `Imprimir` do browser sugere A3 (o iframe e o `@page` dizem A3).
