# externalProductId ambíguo — regra canónica + rollout seguro (FASE B)

## Problema (medido em grupo-silveira, 2026-05-25)

`externalProductId` (CodigoID do ERP) **não é único por farmácia** — o ERP recicla
o código entre CNPs ao longo do tempo. Estado real:

| Farmácia | códigos distintos | colisões (>1 produto) | % |
|---|---|---|---|
| Segurado | 26.332 | 1.243 | 4,7% |
| Silveirense | 18.038 | 3.902 | **21,6%** |
| **Total** | — | **5.145** | — |

- 10.290 ProdutoFarmacia rows envolvidas (~21% do total); 2.751 produtos com vendas reais.
- **Todas multi-CNP** → reciclagem real do CodigoID.
- Resolução antiga (`Map` last-wins em JS) era **não-determinística** (dependia da
  ordem de carregamento) → atribuição silenciosamente errada e irreproduzível.

## Regra canónica (determinística) — `lib/aggregate/resolve-produto.ts`

Um `produtoId` por `(farmaciaId, externalProductId)`, escolhido por:

1. `flagRetirado ASC` — activo antes de retirado
2. `dataUltimaVenda DESC NULLS LAST` — sinal mais forte (desambigua ~43% dos grupos)
3. `stockAtual DESC NULLS LAST`
4. `produtoId ASC` — desempate estável (≈19% dos grupos; arbitrário mas REPRODUZÍVEL)

Resolve 100% dos grupos; ~81% por sinal forte, ~19% pelo desempate estável.
**Não altera dados armazenados** — é resolução em tempo de query.

## Estado actual (já aplicado)

- ✅ **Agregação compras/devoluções** (`lib/aggregate/compras.ts`, `devolucoes.ts`) já usa
  a CTE canónica no JOIN. Como `Compra`/`Devolucao` estavam vazias, não há atribuição
  antiga a perturbar — é seguro e não-breaking.

## Residual (a resolver pelo rollout)

`bootstrap/stock` e `bootstrap/sales-lines` (e `reprocess-ingest-produto-mapping`) ainda
resolvem o código com **last-wins** (arbitrário). Para os 5.145 códigos colidentes, a
atribuição de **stock/vendas** pode divergir da de **compras** (que já é canónica) →
ficha de produto inconsistente para esses códigos. Nenhuma das resoluções actuais é
"correcta" (last-wins é arbitrário), por isso adoptar a regra em todo o lado é
estritamente uma melhoria.

## Rollout seguro (sem breaking migration)

**Passo 1 — alinhar a resolução de ingest (additive, baixo risco)**
Aplicar a mesma regra canónica nos resolvers de:
- `app/api/ingest/v1/bootstrap/stock/route.ts`
- `app/api/ingest/v1/bootstrap/sales-lines/route.ts`
- `scripts/reprocess-ingest-produto-mapping.ts`
(substituir o `Map` last-wins / o `UPDATE ... FROM ProdutoFarmacia` ambíguo por
`DISTINCT ON (...)` com o mesmo `ORDER BY`). Só muda a escolha do produtoId; idempotente.

**Passo 2 — reprocessar grupo-silveira (recuperação, idempotente)**
1. `npm run ingest:reprocess-produto-mapping -- --tenant grupo-silveira --apply` (com a regra nova)
2. re-agregar VendaMensal (aggregate-month) — re-deriva vendas para o produtoId canónico
3. re-correr `stock-upload` (re-resolve stock para o canónico)
→ stock/vendas passam a coincidir com compras nos 5.145 códigos.

**Passo 3 (FUTURO, com plano próprio — NÃO agora)**
Materializar o canónico, p. ex. coluna `ProdutoFarmacia.canonicalProdutoId` ou um índice
único parcial em `(farmaciaId, externalProductId)`. Exige **dedupe prévio** (decidir o que
fazer aos PF perdedores: marcar `flagRetirado` / fundir). É a única parte potencialmente
"breaking" — fica para uma migração planeada e validada, não para este rollout.

## Verificação pós-rollout
- 0 divergências entre o produtoId de stock/vendas e de compras para códigos colidentes.
- Ficha de produto dos 2.751 produtos colidentes-com-vendas mostra stock+vendas+compras no
  mesmo Produto.
