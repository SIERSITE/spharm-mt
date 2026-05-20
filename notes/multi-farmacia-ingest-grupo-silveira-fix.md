# Fix: ingest multi-farmácia (grupo-silveira) — colisão externalProductId

**Data:** 2026-05-20 · **Tenant afectado:** `grupo-silveira` (piloto real,
farmácias **Silveirense** + **Segurado**).

## Sintoma

Bootstrap PRODUTOS da 2.ª farmácia (Segurado, após Silveirense) falha em
massa:

```
Unique constraint failed on fields: ("externalProductId")
batch 1 ext=23 upsert_failed
batch 3 ext=183,185,186
...
```

## Diagnóstico confirmado (schema + código)

**O schema e o código já estão corretos** — o desenho pedido já existe:

- `prisma/schema.prisma` → `model Produto`:
  - `cnp Int @unique` — **identidade canónica do catálogo** (intacta).
  - `externalProductId Int?` — **não-unique** + `@@index([externalProductId])`
    (era `@unique` global; foi despromovido no commit `6eb01ff`).
- `model ProdutoFarmacia`:
  - `@@unique([produtoId, farmaciaId])` — identidade per-farmácia.
  - `externalProductId Int?` (denormalizado, scoped) +
    `@@index([farmaciaId, externalProductId])`.
- `app/api/ingest/v1/bootstrap/products/route.ts` já faz:
  1. `upsert Produto where { cnp }` (canónico);
  2. `upsert ProdutoFarmacia where { produtoId_farmaciaId }`;
  3. guarda `externalProductId` em ambos (scoped por farmácia no
     ProdutoFarmacia).
  - Sem CNP → item **skipped** (`reason: "missing_cnp"`), não entra no
    catálogo (ver "Limitação conhecida" abaixo).
- Nenhum outro caminho (sales-lines, stock, aggregate-compras) usa
  `Produto.externalProductId` como chave única — todos usam
  `ProdutoFarmacia` com `{ farmaciaId, externalProductId: { in } }`.

**Causa raiz REAL = migration não deployada.** A migration
`prisma/migrations/20260518200000_drop_produto_external_product_id_unique`
(DROP `Produto_externalProductId_key` → CREATE índice não-unique) foi
aplicada **só a `demo-neon`** (ver corpo do commit `6eb01ff`). O tenant
`grupo-silveira` **ainda tem o índice unique antigo**. Como o ERP SPharm
recicla o `CodigoID`/`externalProductId` por base (namespace per-farmácia),
Silveirense e Segurado partilham os mesmos ext IDs para produtos
diferentes → ao criar o 2.º Produto com ext já usado, o INSERT viola o
unique global ainda presente nesse tenant.

→ **Não é preciso alterar código, schema nem criar migration nova.** A
correção é aplicar a migration existente a `grupo-silveira` e reconciliar
o import parcial.

## Correção (operacional, dev/trusted)

Pré: `.env` com `CONTROL_DATABASE_URL` + `TENANT_ENCRYPTION_SECRET`
(scope `cli` ready). Confirma com `npm run env:doctor`.

```bash
# 1. Ver o que está pendente em grupo-silveira (migrate status)
npm run tenancy:migrate-all -- --only grupo-silveira --dry-run

# 2. Aplicar migrations pendentes (deploy). Aplica em ordem:
#    add_compras_devolucoes_staging + aggregation_columns (aditivas) +
#    drop_produto_external_product_id_unique. Todas aditivas/seguras.
npm run tenancy:migrate-all -- --only grupo-silveira

# 3. Smoke: confirmar que o unique caiu e o cnp_key continua intacto
npx tsx scripts/admin/smoke-produto-external-product-id-index.ts grupo-silveira
#    Esperado: Produto_externalProductId_key AUSENTE,
#              Produto_externalProductId_idx presente (não-unique),
#              Produto_cnp_key presente. "OK".
```

> Nota: `prisma migrate deploy` aplica **todas** as migrations pendentes
> (não dá para escolher uma). As de compras/devoluções são aditivas (novas
> tabelas/colunas) e apenas põem `grupo-silveira` a par — sem risco.

## Reconciliar o import parcial

A colisão é **consistente** (os items que falharam não criaram nada — o
P2002 foi apanhado e reportado em `errors[]`; os que passaram criaram
Produtos corretos). Os upserts são **idempotentes**. Logo:

### Opção A — re-bootstrap idempotente (recomendada, sem wipe)

Após o passo 2 acima, voltar a correr o bootstrap de produtos das **duas**
farmácias (via agent no PC, ou `agent:ingest-folder`). O upsert reconcilia:
- Silveirense: re-run é no-op/update.
- Segurado: insere agora os que antes colidiram.
- Mesmo CNP nas duas farmácias → **mesmo Produto canónico** + 2
  ProdutoFarmacia distintos.

### Opção B — reset limpo do catálogo (piloto, slate pristina)

Se preferires recomeçar o catálogo do tenant do zero (aceitável no piloto).
Correr na BD do tenant `grupo-silveira` (Neon SQL editor ou psql):

```sql
-- ⚠️ CASCADE apaga também dados derivados (ProdutoFarmacia, staging de
-- vendas/compras, agregados que referenciam Produto). Só no piloto.
TRUNCATE TABLE "Produto" RESTART IDENTITY CASCADE;
```

Depois re-bootstrap das duas farmácias (Silveirense, depois Segurado).

> Reset TOTAL do tenant (recriar BD) não é necessário aqui e perderia
> tenant id/ingest key — evitar.

## Validação (aceitação)

1. Importar **Silveirense** (produtos) → sem erros.
2. Importar **Segurado** (produtos) → **sem** `Unique constraint failed on
   ("externalProductId")`.
3. Repetir ambas → idempotente (0 duplicados; `upserted` reflecte updates).
4. Confirmar CNP partilhado aponta ao mesmo Produto:

```sql
-- Um CNP presente nas duas farmácias deve ter 1 Produto e 2 ProdutoFarmacia
SELECT p.cnp, COUNT(DISTINCT p.id) AS produtos, COUNT(pf.id) AS produto_farmacia
FROM "Produto" p
JOIN "ProdutoFarmacia" pf ON pf."produtoId" = p.id
GROUP BY p.cnp
HAVING COUNT(pf.id) > 1
ORDER BY produto_farmacia DESC
LIMIT 5;
-- Esperado: produtos=1, produto_farmacia=2 (mesmo Produto, 2 farmácias).
```

## Redeploy

**Nenhum redeploy do SaaS é necessário** — o código de ingest já está
correto e deployado (a rota faz upsert por CNP desde 2026-05-13; `6eb01ff`
só mexeu em schema/migration). A "correção" é a migration na BD do tenant
`grupo-silveira` (passos acima), feita a partir do ambiente dev/trusted.

## Limitação conhecida (req #6 — fallback sem CNP) — DIFERIDO

Produtos sem CNP válido são **skipped** (`missing_cnp`), não entram no
catálogo. Implementar um fallback determinístico scoped à farmácia exigiria
tornar `Produto.cnp` nullable + uma identidade sintética per-farmácia — uma
alteração à identidade canónica do catálogo, **não-segura como hotfix** e
fora do âmbito desta correção. No ERP, produtos de stock têm sempre CNP
(serviços non-stock são tratados à parte via `isNonStockService`), por isso
o skip é aceitável no piloto. Tratar como mudança separada e autorizada se
o dataso real exigir.
