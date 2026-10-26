# Vendas: preços de venda/compra · Total unid. e stock · PVP diferente · designação na ficha

Base: `feat/encomenda-excel-vendas-precos-fabricante` @ 85553f2b19c323bc58145a973f7692cfbde9b33a. **Sem migrations** (só se reutilizam
`Produto.designacao`, `Produto.camposManuais`, `Produto.validadoManualmente`, `Fabricante`, `FabricanteAlias`, `AuditLog`). Agent intocado.

## 1. «Incluir preços de venda» / «Incluir preços de compra»
- Substituem a opção única «Incluir preços». Independentes, ambas ligadas por omissão, guardadas **por análise** (`useEstadoSeparador`:
  `vendas:incluirPrecosVenda`, `vendas:incluirPrecosCompra`). «Nova análise» nasce com ambas ligadas; fechar o separador liberta o estado.
- **Venda** controla PVP, Valor Vendas (s/IVA), «Valor PVP estimado» e totais de venda. **Compra** controla custo unitário/total, totais
  de custo, «PARCIAL», contagem de linhas sem custo e a nota do PMC/PUC.
- Aplicam-se a: Relatório (pré-visualização), impressão, PDF, **Excel de Vendas**, PDF anexado ao email, **Excel anexado ao email**.
  *Esta regra substitui deliberadamente a anterior em que o Excel de Vendas era sempre completo.*
- A tabela do ecrã (uso interno) mostra sempre tudo; quando uma opção está desligada aparece o aviso
  «… A tabela abaixo (uso interno) continua a mostrar todos os valores.»
- **Privacidade validada no servidor** (`lib/reporting/privacidade.ts`): o `Report` leva `meta.privacidade` e cada coluna/resumo
  monetário leva `sensivel: "venda" | "compra"`. `renderReportHtml`, `buildReportWorkbook` e as rotas `/api/reports/pdf` e
  `/api/reports/email` reaplicam `aplicarPrivacidade` — um relatório adulterado ou incompleto sai sem a informação retirada
  (**falha-seguro**: só `=== true` mantém a classe). O `Report` que viaja já não contém os valores retirados.
- O diálogo de email indica «Preços de venda: incluídos/NÃO incluídos · Preços de compra (custos): incluídos/NÃO incluídos».
- O diálogo passou a ser renderizado em *portal* no `<body>` (os cartões usam `backdrop-filter`, que prendia o `position: fixed`).

## 2. «Total unid.» destacado e stock
- Coluna «Total unid.» (e «Total unid. do bloco»/«Período: Total unid.» nos períodos longos) com fundo azul-acinzentado próprio e dois
  filetes laterais, distinta dos meses, do stock, dos subtotais e do TOTAL GERAL; lê-se em cinzentos (≥ 15 níveis face aos meses).
  Ecrã, Relatório, impressão e PDF. O Excel não tem estilos (biblioteca sem suporte): sem destaque, o cabeçalho identifica a coluna.
  Ordem: meses → total do bloco → total do período → stock (também nos 14/27 meses).
- **Stock por artigo**: «TOTAL ARTIGO» soma o stock das farmácias do artigo. **Stock total**: soma do stock atual de cada
  combinação produto/farmácia, uma vez, nunca por mês; no resumo superior, na faixa «Unidades vendidas · Stock total» do PDF/impressão,
  no TOTAL GERAL, no Excel e nos anexos.
- **Stock desconhecido existe** (`ProdutoFarmacia.stockAtual` é nulo-able e o carregador convertia-o em 0). Agora
  `existenciaConhecida=false`: a célula mostra «—», o total é declarado **PARCIAL** e as linhas em falta são contadas à parte.

## 3. «Apenas artigos com PVP diferente entre farmácias»
- Critério de `lib/reporting/vendas-pvp-diferente.ts`: ≥ 2 farmácias selecionadas associadas, ≥ 2 PVP conhecidos (nulo/≤ 0 não conta),
  ≥ 2 valores diferentes. Compara o **PVP atual** (`ProdutoFarmacia.pvp`, sem a cascata para o PMC) à precisão da base (4 casas, em
  inteiros). O carregador devolve `pvpPorFarmacia` — por isso um artigo que só uma farmácia vendeu é comparado com a outra.
- Aplicado a montante de tudo (`linhasBase`): tabela, agrupamento, Grupo, Comparativo, seleção, totais, Relatório, PDF, Excel, email.
  (Vendas não tem paginação de tabela; a «paginação» é a do PDF/impressão, que parte destas linhas.)
- Desligado por omissão; com uma só farmácia fica desativado e explica-se. Por análise (critério do workspace), retirado por
  «Limpar filtros». A frase «Apenas artigos com PVP diferente entre farmácias» consta dos filtros das saídas, mesmo sem preços de venda.
  Com o filtro ativo aparece um «≠» discreto ao lado do PVP (tooltip com os PVP por farmácia); a linha não é pintada como alerta.

## 4. Designação do produto na ficha (Stock e Catálogo)
- «Editar designação» para `catalog.write`; valida (obrigatória, trim, 3–300 caracteres, acentos/maiúsculas preservados), confirma com
  «Esta designação será utilizada no SPharm.MT para este artigo em todas as farmácias deste grupo.» e atualiza a ficha de imediato.
  Igual à atual (normalizando espaços) → não escreve nem audita.
- Proteção = `Produto.camposManuais ∋ "designacao"` (a que `bulkUpsertProdutosByCnp`, `decidirDesignacao`,
  `aplicarDesignacoesAutoritativas` e o caminho de recurso do endpoint de produtos consultam). **A Silveirense deixou de ter a exceção**
  (antes substituía a designação mesmo marcada como manual). Independente da do fabricante (`validadoManualmente` + marcador).
- «Voltar a permitir atualização automática» retira só `"designacao"`; o nome não muda; auditoria própria
  (`produto.designacao.protecao_removida`). Auditoria da alteração: `produto.designacao.alterada` (origem `FICHA_ARTIGO`, tenant,
  produto, CNP, anterior/nova, proteção antes/depois) na mesma transação.
- Não existe snapshot ERP da designação por farmácia escrito pela ingestão (`ProdutoFarmacia.designacaoLocal` só é lido) —
  por isso não há «Aplicar agora a designação do ERP».
- Reflexo: tudo o que lê `Produto.designacao` ao vivo (Stock, Vendas, Margens, Inventário, Excessos, Transferências, Catálogo, relatórios,
  PDF, Excel, emails) mostra o nome novo. **Mantêm o nome original** os documentos históricos com `designacaoSnapshot`
  (`LinhaEncomenda` de encomendas finalizadas e `LinhaTransferencia`).

## 5. Workspace
- Editores de fabricante e designação declaram «alterações pendentes» por **fonte** (`lib/workspace/pendentes.ts`): o separador está
  sujo se qualquer editor tiver pendentes (antes o último a declarar `false` apagava o `true` do outro).
- Formulários preservados ao trocar de separador, fechar pede confirmação, fechar/reabrir começa limpo; sem segundo sistema de persistência.

## Testes
`test:vendas-precos-pvp-stock` (matriz 4 combinações em Report/HTML/XLSX por zip, privacidade, stock, PVP), `test-vendas-mapa-visual`
(PDF real das 4 combinações, A4, 27 meses, cores da coluna), `test:vendas-loader-pvp-stock-db`, `test:designacao-ficha-db`,
`test:fabricante-ficha-db`, `test-workspace-separadores`, `e2e:vendas-opcoes`, `e2e:ficha-editores`, `e2e:encomenda-excel`.
