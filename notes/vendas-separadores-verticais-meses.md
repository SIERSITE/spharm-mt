# Mapa de Vendas — separadores verticais entre os meses (leitura em papel)

Base: `287cd9026432b49e375b8f064e7b79b885089692` (inclui o separador entre artigos de `fa41978`). **Sem migrations. Agent, Excel, cálculos, totais, blocos temporais, paginação e regras de proposta intocados.**

## Causa
Na hierarquia limpa os meses distinguiam-se só por uma película de fundo (~3 %) em meses alternados (`mes-alt`). Em papel a preto e branco, ou com «Imprimir gráficos de fundo» desligado, essa película some-se e as colunas dos meses ficam sem qualquer delimitação: não se vê onde acaba um mês e começa o seguinte.

## Solução (só `lib/reporting/report-html.ts`, hierarquia `clean`)
Bordas (não fundos) nas células de mês, as mesmas classes no cabeçalho, no corpo, no «TOTAL ARTIGO» e no «TOTAL GERAL» — por isso coincidem e são contínuas de ponta a ponta:

| Onde | CSS | Cor |
|---|---|---|
| entre meses (`.mes`) | `border-left: 1px` (0,75pt) | `#b4bac4` |
| antes do 1.º mês (`.mes-ini`) | `border-left: 1px` | `#9aa4b2` |
| depois do último mês (`.mes-fim`; ou `.apos-mes` na coluna «Total unid.» seguinte) | 1px | `#9aa4b2` |
| separador entre artigos (inalterado) | 2px | `#8493a6` |

Dois filetes nunca ficam lado a lado (`.tint-total + .tint-total`; limite final desenhado pela coluna de totais quando é ela a seguinte). Sem grelha em CNP, Descrição, Farmácia, PVP, custos, Stock, Valor Vendas. «Total unid.» (e «Total unid. do bloco»/«Período: Total unid.») mantêm o tom e os filetes próprios — não se confundem com meses. Cada bloco (14/27 meses) tem os seus limites.

O Relatório (iframe), a impressão, o PDF (endpoint e anexo de email) e a pré-visualização usam todos `renderReportHtml`, logo herdam a mudança. A tabela interactiva do ecrã («Tabela») não foi alterada (não é o que se imprime). Excel não tem estilos: igual.

## Testes
- `scripts/tests/test-vendas-separadores-meses.ts` (PDF real, pixéis medidos com `scripts/e2e/_verticais_pdf.py`; **sem fundos** = `printBackground:false` + `print-color-adjust: economy`, porque o relatório pede `exact`): 1/3/6/13/14/27 meses; 4 combinações de preços; várias páginas; com fundos para 3 e 13. Verifica: nº de filetes = meses do bloco + 1 por página; contínuos do cabeçalho ao TOTAL GERAL (incl. TOTAL ARTIGO); cada mês entre dois filetes; nenhum filete corta texto; nada à esquerda do 1.º mês nem em Stock/Valor Vendas; largura real (escuridão integrada) 0,75–0,84pt < separador de artigos; cinzento visível. Sem a alteração: 2 OK / 52 falhas (o teste detecta a regressão).
- `scripts/e2e/vendas-separadores-meses-browser.ts` (build de produção, PostgreSQL descartável): Relatório 1920×1080/1536×864/1366×768, impressão (HTML + PDF com e sem fundos) 3/13/14/27 meses, PDF do endpoint, 4 combinações de preços, várias páginas. `SO_CAPTURA=antes` gera as capturas «antes» no SHA base.
- `test-vendas-mapa-visual.ts`: o teste estrutural «nenhuma linha vertical no corpo clean» passa a excluir, além de «Total unid.», as regras `.mes/.mes-ini/.mes-fim/.apos-mes` (exceção deliberada, coberta a fundo pelo teste novo). Mais nada foi adaptado.

Evidência: `docs/validacao-visual/2026-10-vendas-separadores-meses/` (`antes-*` / `depois-*`: PDF cor e cinzento, impressão com e sem fundos, Relatório em 3 resoluções, 3/13/14/27 meses).

## Limitações reais
- Uma linha de 0,75pt cai a cavalo de 2 píxeis a 150 dpi: a espessura medida é uma estimativa (integral de escuridão), não um valor exacto; o Chromium arredonda bordas a píxeis inteiros do dispositivo.
- No cruzamento com o filete horizontal fino entre linhas o canto da célula pode «aclarar» 1 píxel (≤ 0,5pt); o filete permanece contínuo à vista e nos testes (tolerância de 3 px).
- Impressoras que ignorem bordas de 0,75pt (rasterização muito grosseira) podem apagar o filete mais claro; os limites (mais escuros) são mais resistentes.
- A coluna «Total unid.» continua com os filetes próprios que já tinha.
