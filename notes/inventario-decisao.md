# Inventário — decisão sobre a alteração de «filtros aplicados» (branch feat/garantia-catalogo-classificacao-margens)

## O que a entrega anterior tinha alterado

`components/inventario/inventario-client.tsx` passou a ter: filtros em edição (draft) vs aplicados (`filtrosResultado`),
saídas (PDF/Excel/email/cabeçalho) calculadas com os aplicados, botão «Atualizar», aviso «Existem alterações por
aplicar», gerações com sequência (`iniciarGeracao` / `geracaoAtual`) e bloqueio de duplo clique.

## Causa concreta que a motivou (e que existe no base a69cbc5)

No base, o Inventário gera **só** em «Gerar» (`handleGerar` → `runInventarioReport(filters)`; nenhum `useEffect` gera).
Mas `buildReport()` (PDF, impressão, Excel, email) e o cabeçalho da organização liam `filters`, o formulário **vivo**.
Logo, depois de gerar, quem alterasse um filtro e exportasse sem voltar a «Gerar» obtinha linhas do relatório antigo
com o rótulo de filtros/farmácias do formulário novo. É a mesma classe de defeito que em Margens, mas em Margens
estava acoplada a uma geração automática (que é um dos seis pontos); no Inventário **não há geração automática**.

## Decisão

A correção **não é indispensável** a nenhum dos seis pontos desta branch:

| Ponto | Precisa de mexer no comportamento do Inventário? |
|---|---|
| Manutenção do catálogo Garantia | não |
| Fabricantes agrupados Garantia | não |
| Classificação ERP | fora desta branch |
| Margens sem geração automática | não — o Inventário já só gera em «Gerar»; Margens usa `lib/reporting/filtros-aplicados.ts` por si só |
| Stock em Margens | não |
| Filtro de forma farmacêutica em todos os mapas | só precisa de a barra partilhada mostrar o filtro e de o valor chegar ao servidor/relatório |

Por isso foi **retirada** do Inventário toda a alteração de comportamento de geração. O Inventário fica igual ao
base (a69cbc5), exceto a forma farmacêutica:

* `components/inventario/inventario-client.tsx`: apenas duas linhas — `formas: filterOptions.formas` (opções para a
  barra) e `formas: universe.formas` (rótulo da forma nas saídas). Nada de draft/aplicado, «Atualizar», aviso ou sequência.
* `lib/reporting/adapters/inventario.ts`: só o rótulo do filtro de forma (já entregue).
* `lib/inventario-data.ts`: idêntico ao base — o servidor aplica a forma pelo pré-filtro de catálogo partilhado
  (`lib/reporting/catalog-prefilter.ts`, `formasFarmaceuticas`).
* `components/reporting/report-filters-bar.tsx`: mostra o filtro de forma quando recebe `options.formas`; **não**
  conhece «por aplicar» (essa indicação pertence ao cliente de cada mapa; só Margens a usa).

## Risco residual aceite (defeito pré-existente, fora de âmbito)

O Inventário continua, como no base, a exportar com o rótulo dos filtros **vivos** se o utilizador os alterar depois de
gerar e antes de exportar. Se se quiser corrigir, deve ser uma alteração própria, pedida e testada à parte
(reintroduzir o par draft/aplicado e `iniciarGeracao`/`geracaoAtual` como em Margens), não misturada nesta branch.

## Testes

* `npx tsx scripts/tests/test-inventario-inalterado.ts` — estrutural: só gera em «Gerar» (um único `runInventarioReport`,
  nenhum `useEffect` gera, botão «Gerar» nunca «Atualizar», sem aviso, sem `filtrosResultado`); diff contra o base:
  o cliente não remove nada e só acrescenta as duas linhas de forma; o adapter só ganha código de forma;
  `lib/inventario-data.ts` idêntico; a barra partilhada não conhece «por aplicar».
* `scripts/tests/test-margens-sem-geracao-automatica.ts` (secção D) agora afirma que o Inventário **não** tem
  draft/aplicado/«Atualizar»/aviso.
* `scripts/e2e/forma-farmaceutica-browser.ts` (secção 3): botão «Gerar», mudar a forma = 0 pedidos, só «Gerar» aplica.
