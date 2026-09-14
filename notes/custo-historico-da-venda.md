# Custo à data da venda — o que existe, e o caminho que fica registado

**Estado:** análise. Nada activado. Registado a 2026-09-15.

O relatório de Vendas mostra **custo estimado** — o PMC/PUC actual da
ficha. Este documento diz porque não é possível fazer melhor hoje, e
qual é o caminho quando for.

---

## Porque é estimado

A cadeia que alimenta o relatório não tem custo em lado nenhum:

```
IngestVendaLinhaRaw   quantidade · pvpUnitario · valorLinha · ivaValor
                      descontoValor · comparticipacao1/2
                      ── sem coluna de custo ──
        ↓
VendaMensal           quantidade · valorTotal · valorBruto · valorPagoUtente
                      ── sem custo ──
```

`Venda.custoUnitario` existe no schema e está **morto**: nenhum caminho
da aplicação escreve na tabela `Venda`, e em produção tem **0 linhas**.
É resíduo da era do import por Excel.

---

## O que se mediu no ledger de movimentos

`MovimentoArtigo` traz do ERP três colunas de custo — `custoUnitario`,
`pmcAnterior`, `pmcNovo` — e liga-se às linhas de venda por
`externalDetalheId` com **99,97 % de match** (272 903 de 272 988 linhas
nos últimos 90 dias, tenant garantia).

Mas o custo não está onde faria falta:

| tipo | movimentos | com `custoUnitario > 0` |
|---|---:|---:|
| **VENDA** | 3 380 464 | **0** — 0,0 % |
| COMPRA | 1 240 505 | 1 239 889 — 100 % |
| ACERTO_STOCK | 182 229 | 181 408 — 99,5 % |
| DEVOLUCAO_FORNECEDOR | 14 481 | 14 418 — 99,6 % |
| RESERVA_SUSPENSA | 218 853 | **0** |
| DEVOLUCAO_CLIENTE | 168 180 | **0** |
| VENDA_CREDITO | 1 054 | **0** |

**O ERP regista custo nas entradas e não nas saídas.** Nas 3 548 644
linhas ligadas a venda, `custoUnitario = 0` e `pmcAnterior = 0` em todas.

---

## O caminho: `pmcNovo`

```
2026-09-13  VENDA  −2   custoUnitario 0   pmcAnterior 0   pmcNovo 5.9700
2026-09-13  VENDA  −1   custoUnitario 0   pmcAnterior 0   pmcNovo 3.1200
```

`pmcNovo` está preenchido em **3 479 007 de 3 548 644 — 98,0 %** dos
movimentos de venda, com histórico desde **2024-01-01**.

Não é o custo daquelas unidades. É o **PMC que vigorava na ficha naquele
dia**, gravado pelo ERP no próprio movimento. Para a pergunta «quanto
custou o que vendi em Janeiro», é incomparavelmente melhor do que o PMC
de Setembro — e é a melhor aproximação que estes dados permitem.

### O que falta para o usar

`Farmacia.useMovimentosCanonical` está **`false` nas cinco farmácias**
do tenant garantia. Os dados estão ingeridos; o pipeline canónico nunca
foi activado aqui.

Activá-lo tem gates próprios, definidos quando o pipeline foi construído:

- `DESCONHECIDO < 1 %` na classificação de movimentos
- reconcile ≤ 1 % contra o extrato do ERP

São gates de outra natureza e outro risco. **Não se misturam com uma
coluna de relatório.**

### Se um dia se avançar

O custo por (produto × farmácia × mês) sairia de:

```sql
SELECT "farmaciaId", "produtoId",
       date_trunc('month', "dataMovimento") AS mes,
       SUM(ABS(quantidade) * "pmcNovo")     AS custo,
       SUM(ABS(quantidade))                 AS unidades
FROM "MovimentoArtigo"
WHERE tipo = 'VENDA' AND "pmcNovo" > 0
GROUP BY 1, 2, 3
```

Materializado ao lado de `VendaMensal`, com a mesma granularidade, o
relatório trocaria a coluna estimada pela real sem mudar mais nada — e
o nome deixaria de precisar do `est.`.

Os 2 % sem `pmcNovo` continuariam a cair no estimado, e a coluna teria
de dizer qual dos dois está a mostrar. É o mesmo problema de
proveniência que `custoDaFarmacia` já resolve para o PMC/PUC.
