# Pre-pilot functional audit — 2026-05-14

Quatro frentes funcionais fechadas antes da primeira farmácia real:
menu encomendas, finalização → SPharm via outbox, pesquisa de stock,
isolamento de utilizadores por tenant.

## Checklist

- [x] **Menu encomendas limpo** — entrada única `Encomendas` na sidebar
      (AppShell), aterra em `/encomendas` (listagem com botão primário
      "+ Nova encomenda"). `/encomendas/lista` redireccion­a para
      `/encomendas`. Antigo dashboard analítico preservado em
      `/encomendas/analise` (não exposto na sidebar).

- [x] **Finalização encomenda cria outbox** — confirmado: o caminho já
      existia. `createEncomendaWithOutbox` e `finalizeAndQueueOrder`
      criam `OrderOutbox` na mesma transação Prisma. Não foi tocado.

- [x] **Agent envia ao ERP (modo stub)** — comando `export-orders` no
      agent:
      1. GET /api/outbox/v1/orders/pending (lease atómico 5min)
      2. Para cada order: writeOrderToSpharm
      3. POST .../ack ou .../nack
      Modo `stub` (default): escreve JSON por encomenda em
      `<outputDir>/orders-export/YYYY-MM-DD/<outboxId>.json` e ack com
      `spharmDocumentId=STUB-...`. Modo `insert` bloqueado até schema
      SPharm consolidado — falha deliberada com mensagem clara.

- [x] **Stock search server-side** — `lib/stock-data.ts` agora aceita
      `StockSearchParams` (q, pharmacies[], coverageBuckets[],
      statusBuckets[], filter, page, pageSize). Carrega o universo
      enriched, filtra/ordena/pagina servidor-side, retorna total +
      slice da página. Cliente é URL-driven com debounce de 300ms;
      sem `.filter()` local sobre 300 rows.

- [x] **Utilizadores isolados por tenant** — `lib/auth.ts:74` já
      verifica `session.tenant === currentTenant` (cross-tenant tokens
      são rejeitados como sessão inexistente). Novo comando
      `npm run tenancy:add-user -- --tenant <slug> --email <email>
      --nome "<Nome>" --role <ADMINISTRADOR|GESTOR_GRUPO|
      GESTOR_FARMACIA|OPERADOR> [--farmacia <id|nome>] [--password]`.
      Gera password (impressa uma vez), bcrypt 10 rounds,
      `mustChangePassword=true`. Para perfis não-ADMIN cria também
      entry em `UtilizadorFarmacia` se `--farmacia` for indicada.

- [x] **typecheck** — `npx tsc --noEmit` repo + agent: clean.
- [x] **lint** — sem erros novos. Stock-client passou de error a OK
      (substituí `useEffect` por padrão React "adjust state on prop
      change"). Apenas 3 warnings em `spharm-orders-writer.ts:133-135`
      (params `_order`/`_cfg`/`_pool` em `writeInsert` stub —
      intencionais).
- [x] **Sem regressão pipeline ingest/daily-sync** — não foi alterado
      `daily-pipeline`, `daily-sync`, `bootstrap-*`, `aggregate-month`
      ou qualquer rota `/api/ingest/*`. Única alteração relacionada
      foi o enrichment opcional adicionado a
      `/api/outbox/v1/orders/pending` (CNP + designação por linha),
      sem afectar payloadJson nem hash.

## Ficheiros alterados

### Frente 1 — menu encomendas
- `app/encomendas/page.tsx` (substituído pela listagem)
- `app/encomendas/analise/page.tsx` (novo — dashboard analítico
  movido aqui, fora da sidebar)
- `app/encomendas/lista/page.tsx` (redirect para `/encomendas`)
- `components/layout/app-shell.tsx` (removidas entradas "Lista
  encomendas" e "Nova encomenda" da nav)
- Hrefs + revalidatePath: `app/encomendas/{nova,[id],lista}/actions.ts`,
  `components/encomendas/order-detail-client.tsx`,
  `lib/encomendas/orders-data.ts`

### Frente 2 — agent + outbox export
- `app/api/outbox/v1/orders/pending/route.ts` (enrichment com CNP/
  designação por linha; payloadJson e hash intactos)
- `agent/src/http-client.ts` (3 métodos novos: pullPendingOrders,
  ackOrder, nackOrder + tipos PendingOrder*)
- `agent/src/config.ts` (campo ordersWriteMode, env
  `SPHARMMT_ORDERS_WRITE_MODE`)
- `agent/agent.config.example.json` (doc do novo campo)
- `agent/src/spharm-orders-writer.ts` (novo — writer stub|insert)
- `agent/src/commands/export-orders.ts` (novo — comando CLI)
- `agent/src/cli.ts` (registo)

### Frente 3 — stock server-side
- `lib/stock-data.ts` (nova signature `getStockData(params)`,
  paginação server-side, filtros e métricas sobre universo completo)
- `app/stock/page.tsx` (parsing URL → StockSearchParams)
- `components/stock/stock-client.tsx` (URL-driven, debounce,
  paginação Anterior/Próxima, sem `.filter()` local)

### Frente 4 — tenancy add-user
- `scripts/tenancy/add-user.ts` (novo)
- `package.json` (script `tenancy:add-user`)

## Migrations
Nenhuma migration Prisma necessária. Não foram alterados modelos.

## Comandos de validação

```bash
# Typecheck
npx tsc --noEmit                                   # repo
npx tsc --noEmit  # cwd=agent/                     # agent

# CLI smoke tests
npx tsx scripts/tenancy/add-user.ts                # expects "--tenant obrigatório"
npx tsx agent/src/cli.ts                           # lista comandos, inclui "export-orders"

# Manual (requer demo-neon up):
npm run tenancy:add-user -- --tenant demo-neon \
  --email teste@spharmmt.test \
  --nome "Maria Teste" \
  --role OPERADOR \
  --farmacia "Farmácia Internacional Sede"

# Stock — testar pesquisa server-side:
#   /stock?q=paracetamol      → procura na BD inteira
#   /stock?q=...&page=2       → paginação
#   /stock?status=Parado      → filter facet em todos os 3000 produtos

# Encomendas — confirmar:
#   /encomendas               → listagem com "+ Nova encomenda"
#   /encomendas/lista         → 308 redirect para /encomendas
#   /encomendas/analise       → antigo dashboard (não está na sidebar)

# Outbox flow (smoke test em dev contra demo-neon):
#   1. Criar encomenda em /encomendas → finalizar (estado=FINALIZADA,
#      outbox=PENDENTE)
#   2. SPHARMMT_ORDERS_WRITE_MODE=stub npm run agent export-orders
#   3. Output: /api/outbox/v1/orders/pending lease + JSON file gerado
#      em <outputDir>/orders-export/2026-05-14/<outboxId>.json
#   4. Verificar /encomendas que outbox passou para EXPORTADO com
#      spharmDocumentId=STUB-... e lista para EXPORTADA
```

## Não fechado nesta sessão

- **`ordersWriteMode=insert`** — falha deliberada. Para activar é
  preciso:
  1. Mapear schema-alvo SPharm (qual a tabela header? linhas? como é o
     PK dado pelo ERP? quais constraints de integridade?)
  2. Decidir lookup CNP → CodigoArtigo (qual tabela, qual coluna)
  3. Substituir corpo de `writeInsert` em
     `agent/src/spharm-orders-writer.ts:130`
  4. Upgrade do SQL login de `db_datareader` para `db_datawriter` (ou
     EXECUTE permission em SP dedicada) na tabela-alvo
- **Permissão SQL Server**: agent continua a correr com `db_datareader`
  para o existing pipeline; o modo insert vai requerer permissões
  adicionais. Decisão deve ser tomada com o operador SPharm.
