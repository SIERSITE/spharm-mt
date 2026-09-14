# Lista importada de CNP — os três módulos que ainda não a consomem

**Estado:** análise. Nada implementado. Registado a 2026-09-14.

A importação de listas de CNP/códigos está ligada a **Inventário**,
**Margens**, **Vendas** e **Encomendas**. Não está ligada a
**Devoluções**, **Excessos** e **Transferências**.

Este documento diz porquê, o que seria preciso, e — a parte que
interessa — como o fazer sem criar uma segunda implementação do parser
ou do resolvedor.

---

## O que já é partilhado, e que não muda

```
ficheiro → parseListaCodigos()        lib/produtos/lista-codigos.ts
         → resolverListaCodigos()     lib/produtos/resolver-lista-codigos.ts
         → { cnps: number[] }
                │
       ┌────────┴────────┐
  filters.cnps      ProposalFilters.cnps
       │                 │
 restringirPorCatalogo   p.cnp = ANY(...)
```

Qualquer módulo que venha a ganhar a lista usa **este** caminho. O
parser é um, o resolvedor é um, o componente de UI é um, e o campo
chama-se `cnps` nos dois tipos de filtro que já existem. Nada disso
precisa de mudar para acomodar os três módulos em falta.

O que falta é **o eixo de produto do lado do servidor** — e é diferente
em cada um dos três.

---

## 1 · Devoluções

**Porque não consome hoje.**
`getDevolucoesData(period)` recebe **um período e mais nada**
([lib/devolucoes-data.ts:48](../lib/devolucoes-data.ts)). Não tem tipo
de filtros, não tem `produtoIdFilter`, não conhece `SharedReportFilters`.
A consulta é `prisma.devolucao.findMany` por `farmaciaId` e `data`; o
filtro de artigo que a UI oferece é feito no browser sobre as linhas já
carregadas.

**O que seria preciso.**
O menor passo honesto: dar-lhe um parâmetro de filtros em vez de um
período solto.

```ts
// antes
getDevolucoesData(period: DevolucoesPeriod)
// depois
getDevolucoesData(filtros: DevolucoesFilters)   // estende SharedReportFilters
```

`Devolucao` tem `produtoId`, portanto a restrição é directa:
`where: { produtoId: { in: produtoIdFilter } }`. O trabalho não é a
consulta — é a assinatura e os seus chamadores.

**Dimensão.** Pequena. Um tipo novo, um `where`, e os dois chamadores
(a página e o adaptador de relatório).

---

## 2 · Excessos e 3 · Transferências

Tratam-se juntos porque **partilham o loader**: os dois chamam
`carregarEstadosOperacionais()`, que chama `loadPfAndSales()`
([lib/transferencias-data.ts](../lib/transferencias-data.ts)).

**Porque não consomem hoje.**
`OpcoesOperacionais` tem `thresholdDays`, `targetDays`, `dataInicio`,
`dataFim` — parâmetros do **motor de stock**, não filtros de catálogo.
Nunca houve um eixo de produto: `loadPfAndSales` carrega **todas** as
linhas de `ProdutoFarmacia` com stock > 0 das farmácias activas, e o
filtro de artigo da UI corre no browser.

**A razão pela qual não é só acrescentar um `where`** — e é esta que
interessa:

> Os Excessos e as Transferências são cálculos **de grupo**. Uma
> transferência precisa das linhas de **todas** as farmácias do mesmo
> produto para saber quem tem a mais e quem tem a menos. O
> `emparelhar(origem, grupo)` percorre o grupo inteiro.

Restringir `loadPfAndSales` por CNP restringe os **produtos**, não as
farmácias — e isso é seguro, porque o grupo de um produto continua
completo. Mas restringir por qualquer outro eixo que corte **linhas
dentro** do mesmo produto partiria o emparelhamento em silêncio: a
origem apareceria sem o destino, e o ecrã diria «sem destino possível»
quando o destino existe e foi filtrado.

Ou seja: **`cnps` é precisamente o eixo que se pode aplicar aqui com
segurança**, porque corta produtos inteiros. É uma boa notícia e vale a
pena não a perder.

**O que seria preciso.**

```ts
export type OpcoesOperacionais = {
  thresholdDays?: number;
  targetDays?: number;
  dataInicio?: string;
  dataFim?: string;
  /** NOVO — mesma semântica de SharedReportFilters.cnps. */
  cnps?: number[];
};
```

e em `loadPfAndSales`, uma condição ao lado do `stockClause`:

```sql
AND (${semLista} OR p.cnp = ANY(${cnps}))
```

com o cuidado de `[]` significar **zero produtos** e não «sem filtro» —
a regra de `temListaCodigos`, que tem teste dedicado.

**Dimensão.** Média. Duas linhas de SQL e um campo; o cuidado está em
garantir que o corte é por produto e nunca por linha dentro do produto.

---

## O que NÃO fazer

Três armadilhas, pela ordem em que são tentadoras:

1. **Filtrar no cliente.** Os três módulos já filtram artigos no
   browser, e seria o caminho de menor resistência: passar `cnps` ao
   cliente e filtrar o array. Funciona — e mente nos totais. Os cartões
   de resumo dos Excessos (unidades em excesso, referências, valor)
   são calculados sobre o dataset carregado; com um filtro só na
   tabela, a tabela mostra 40 linhas e o cartão continua a dizer
   33 000 unidades.

2. **Um `produtoIdFilter` próprio em cada um.** Foi o que já aconteceu
   uma vez nesta base de código, com o `where` do «sem classificação»
   escrito em três loaders e a faltar-lhe a mesma condição nos três
   — está documentado em
   [lib/reporting/catalog-prefilter.ts](../lib/reporting/catalog-prefilter.ts).
   Os Excessos e as Transferências partilham loader: a restrição entra
   **uma vez**, em `loadPfAndSales`.

3. **Reutilizar o `restringirPorCatalogo` dos relatórios.** É tentador
   porque já existe, mas ele devolve `produtoId[]` e o loader
   operacional filtra por `p.cnp` em SQL bruto. Traduzir CNP → ids para
   voltar a traduzir ids → SQL é um round-trip a mais por uma
   conversão que a consulta faz sozinha. O que se partilha é a
   **semântica** (`temListaCodigos`), não o helper.

---

## Ordem sugerida, quando chegar a vez

1. **Excessos e Transferências** primeiro: um campo em
   `OpcoesOperacionais`, uma condição em `loadPfAndSales`, e os dois
   módulos ganham-na ao mesmo tempo — o mesmo padrão que fez o
   Inventário, as Margens e as Vendas ganharem a lista sem nenhum deles
   ser tocado.
2. **Devoluções** depois, porque o trabalho ali é mudar uma assinatura
   e não acrescentar um filtro, e não há razão para o misturar.

Nenhum dos dois passos toca no parser, no resolvedor, no endpoint ou no
componente de UI.
