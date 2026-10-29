# Margens — coluna «Stock» modo a modo

## Regra de base

* O motor (`getMargensData`) calcula as vendas por **(produto, farmácia)** somando todos os meses do período
  (`GROUP BY 1, 2` sobre `VendaMensal`) e junta `ProdutoFarmacia.stockAtual` do mesmo par. Logo cada linha do mapa é
  **um par produto × farmácia**, com **um** stock — nunca multiplicado por meses, por linhas de venda nem pela expansão CNPEM.
* Os quatro modos agregados (`aggregate(porProduto, chave)`) agrupam essas mesmas linhas por categoria, farmácia, grupo ou
  fabricante. Cada atributo é **uma só chave por linha** (categoria/grupo vêm das classificações do produto, fabricante do
  produto, farmácia é a do par). Portanto os agregados **particionam** as linhas: nenhum par entra em dois agregados e
  Σ agregados = total = Σ do modo produto. A soma é não ambígua em **todos** os modos.
* Universo: artigos **com vendas no período** (os do mapa), não o stock integral da categoria/farmácia. Está escrito na nota.
* Soma = stock atual **conhecido** de cada par, uma vez; negativo desconta; zero é zero; **desconhecido** (`null`) fica fora
  da soma e conta-se em «linhas sem stock conhecido» (total PARCIAL). Um agregado cujos pares são todos desconhecidos
  mostra «—» (`stockDaLinhaAgregada`), nunca 0.
* TOTAL ARTIGO (modo produto) = soma das farmácias selecionadas; a comparação CNPEM é só de ecrã e nunca entra em
  `porProduto` nem nos totais (vem de `getMargensComparacaoCnpem`, outra consulta).
* Todas as saídas (ecrã de impressão, PDF, email, Excel) usam o **mesmo** `Report`; o ecrã usa as mesmas funções
  (`stockDaLinhaAgregada`, `stockTotalDosAgregados`).

## Tabela por modo

| Modo | Granularidade da linha | Origem do stock | Somável? | Risco de duplicação | Coluna / total | Ecrã | PDF / impressão / email | Excel |
|---|---|---|---|---|---|---|---|---|
| Detalhe por produto | produto × farmácia (+ TOTAL ARTIGO por artigo com ≥ 2 farmácias) | `ProdutoFarmacia.stockAtual` do par | sim, por par | TOTAL ARTIGO não é somado de novo no total geral; meses/vendas não multiplicam; CNPEM fora do Report | «Stock» por linha; TOTAL ARTIGO = Σ farmácias conhecidas; resumo «Stock total» + «Linhas sem stock conhecido» | coluna ordenável + KPI «Stock total» | coluna, total geral, resumo e nota | coluna e linha de total |
| Totais por categoria | agregado de pares da categoria | Σ `stockAtual` dos pares | sim (partição) | nenhum: cada par tem 1 categoria | «Stock» (Σ pares distintos), «Sem stock conhecido» (só se houver), total geral, resumo, nota | coluna + nota + KPI | idem | idem |
| Totais por farmácia | agregado de pares da farmácia | idem | sim (partição) | nenhum: o par pertence a 1 farmácia | idem | idem | idem | idem |
| Totais por grupo | agregado de pares do grupo (N2 ou categoria) | idem | sim (partição) | nenhum: 1 grupo por produto | idem | idem | idem | idem |
| Totais por fabricante | agregado de pares do fabricante canónico | idem | sim (partição) | nenhum: 1 fabricante por produto | idem | idem | idem | idem |
| Comparação CNPEM (expansão) | artigo × farmácia do mesmo CNPEM | idem | não entra em totais | só ecrã (`print:hidden`) | stock da farmácia por linha, sem total | sim | nunca | nunca |
| Distribuidor | — | — | — | não é um modo de Margens (`DimensaoAgregada` exclui-o) | — | — | — | — |

Nenhum modo ficou sem a coluna: não existe nenhum caso em que um par possa entrar em mais de uma linha. Se um dia se
acrescentar uma dimensão multivalor (p.ex. um produto em vários fornecedores/grupos CNPEM), **não** se deve somar por essa
dimensão: o total teria de ser a soma de pares distintos do relatório, e a coluna omitida com justificação.

## Casos testados

`scripts/tests/test-margens-stock.ts` (secção G, puro) e `scripts/tests/test-margens-stock-db.ts` (PostgreSQL real, motor
verdadeiro): positivo, zero, negativo, desconhecido, uma farmácia, várias, mesmo produto em várias farmácias, 1 vs 12 meses,
universo (produto com stock mas sem vendas fica fora), expansão CNPEM sem contaminar, e cada modo agregado com valores exatos
em `Report`, HTML e Excel lido. E2E (escrito, por executar): `scripts/e2e/margens-stock-browser.ts`, secção «modos agregados».
