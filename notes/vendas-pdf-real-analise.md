# PDF real do cliente (Mapa de Vendas, 57 páginas) — análise agregada

Só números e padrões. **Nenhum CNP, descrição ou nome real** está neste ficheiro nem no Git; o PDF real é dado comercial e fica fora do repositório
(as páginas usadas como evidência estão em `C:\projetos\_entregas\vendas-a4-evidencia\`). Medido com PyMuPDF
(`scripts/e2e/_analisar_pdf_real.py`, que só escreve agregados) sobre `C:\Users\Farm\Downloads\SPharm.MT.pdf` (14,9 MB).

## Formato e tipografia
- 57 páginas A4 horizontal, 841,9 × 595,0 pt. «Parte 1 de 2» = págs. 1-28 (Out/25…Abr/26), «Parte 2 de 2» = págs. 29-57 (Mai/26…Nov/26): cada artigo duas vezes.
- Caracteres por tamanho de letra (103 217 no total): **6,75 pt 46,2 %** (Segoe UI), **7,5 pt 39,7 %**, **6,0 pt 8,1 %**, 7,99 pt 5,6 % (Arial: cabeçalho de página «Pág. X / Y» e notas), 7,12 pt 0,2 %.
  Ou seja, **95 % do documento está entre 6,0 e 7,5 pt** (Segoe UI): CNP e Descrição a 6,75 pt, valores mensais a 7,5 pt, cabeçalhos a 6,0 pt.
- Ficheiro de 14,9 MB por causa de um `linear-gradient` por célula de mês (Chromium grava um padrão por célula).

## Estrutura dos dados
- 326 artigos (os mesmos nos dois blocos); farmácias Segurado e Silveirense; 14 meses (7 + 7).
- Artigos com 1 farmácia: 116 (35,6 %); com 2 farmácias (+ linha TOTAL ARTIGO): 210 (64,4 %); ≈ 536 linhas de farmácia.
- Por página (bloco 1): mediana 11 artigos (máx. 15), 26 linhas de dados (máx. 30).
- Descrições: mediana **49 caracteres**, p90 84, máximo **99**. Linhas de descrição por artigo (com a coluna estreita do PDF antigo): 1 linha 107 artigos, 2 linhas 159, 3 linhas 60.

## Valores (por linha de farmácia, salvo indicação)
| | mediana | p90 | p99 | máximo |
|---|---|---|---|---|
| PVP (€) | 6,70 | 19,06 | 50,20 | **91,80** |
| Custo unitário (€) | 3,52 | 9,10 | 31,89 | **48,18** |
| Célula mensal não nula (unidades) | 2 | 8 | 49 | **86** |
| Célula mensal do TOTAL ARTIGO | 3 | 15 | 65 | **145** |
| Stock por farmácia | 1 | 6 | 20 | **72** |
| Stock do TOTAL ARTIGO | 3 | 13 | 49 | **133** |
| Total de unidades no período, por farmácia | 8 | 57 | 349 | **916** |
| Total de unidades no período, por artigo | 23 | 139 | 702 | **1 641** |

- Células mensais de farmácia: 7 518, das quais **56 % a zero («·»)**; nenhum valor negativo neste PDF.
- Custo total por artigo até 2 930,14 €; valor de vendas por artigo até 5 792,73 €.
- TOTAL GERAL: meses 1 077, 1 110, 1 303, 1 503, 1 227, 1 119, … e 15 (Nov/26, mês incompleto); período: **14 350 unidades**, stock **1 492**, custo 45 768,53 €, vendas 96 067,10 €.

## Cenário de teste «igual ou mais exigente» (`scripts/tests/_cliente-real.ts`, `dadosRealMult`)
Mesma distribuição de linhas (116 + 210 artigos), 56 % de zeros, quantis dos valores acima (interpolados em log), descrições de 14 a 99 caracteres, 326 artigos,
2 farmácias, 14 meses, preços de venda e de compra; **×1** reproduz o PDF real e **×10** multiplica quantidades, stock, PVP e custo por 10 (PVP até 918 €,
custo até 481,80 €, mensal até 860, total do período de dezenas de milhares). Os testes de pior caso (`dadosPiorCaso`) vão muito além: PVP/custo 9 999,99 €,
±99 999 num mês, 990 000 de total e de stock, nome de farmácia de 32 caracteres, 3 farmácias, descrições de 100 caracteres.
