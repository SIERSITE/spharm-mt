# Ingestion API Completion — Relatório

**Data:** 2026-05-11 · **Commits:** `a8addbc` → `95354d7` (4 commits pequenos)

## Fechou

| # | Item | Commit |
|---|---|---|
| 1 | `scripts/tenancy/issue-ingest-key.ts` (referência partida resolvida) | `a8addbc` |
| 2 | `lib/importer.ts` aceita PrismaClient injectado (tenant-aware) | `980bab8` |
| 3 | `lib/ingest/lote-ingestao.ts` — ressuscita LoteIngestao como ledger oficial | `3cb6341` |
| 4 | `/api/ingest/v1/snapshot/{stock,sales-monthly}` — endpoints thin | `95354d7` |

**Zero modelos novos. Zero pipelines paralelos. Apenas convergência.**

## Validações

- `tsc --noEmit` ✅ limpo após cada commit
- **9 suites / 290+ asserts** ✅ verdes (test-env, test-lote-ingestao-hash novos)
- Endpoints `/api/ingest/v1/*` reachable em dev (4/4 smokes)
- Happy-path requer `CONTROL_DATABASE_URL` provisionado (P0 infra blocker pré-existente — não introduzido por este batch)

## Arquitectura final — caminho oficial único

```
Agent / cliente da farmácia
  │
  │ POST /api/ingest/v1/snapshot/stock              ← Excel binary
  │ POST /api/ingest/v1/snapshot/sales-monthly      ← Excel binary
  │ Authorization: Bearer <ingest-key>              ← issue-ingest-key.ts
  │ X-Tenant-Slug: <slug>
  │
  ▼
withIntegrationAuth                                  ← existing
  │  · bcrypt.compare key ↔ Tenant.ingestApiKeyHash
  │  · resolve tenant + Prisma client
  ▼
handleSnapshotUpload                                 ← NEW (thin wrapper)
  │
  ├─ Validar file + farmaciaId no form-data
  ├─ Validar farmaciaId existe no tenant
  ├─ sha256(file bytes)  ← hashFileContent
  │
  ├─ startLote                                       ← LoteIngestao
  │   ├─ findFirst({ farmaciaId, tipo, hash, estado: 'PROCESSADO' })
  │   ├─ se existe   → return 200 skipped_duplicate
  │   └─ caso contrário → create LoteIngestao(RECEBIDO)
  │
  ├─ startSyncRun (control plane)                    ← SyncRun (best-effort)
  │
  ├─ markLoteProcessing → write tmp → importer fn
  │   importer fn = importStockFromExcel(prisma, path, farmaciaId)
  │              OU importSalesFromExcel(prisma, path, farmaciaId)
  │
  ├─ Sucesso:  completeLote + completeSyncRun + return 200 processed
  └─ Erro:     failLote + failSyncRun + return 500 failed
  finally:     unlink(tmp)
```

Cada peça reaproveita componente existente. Não há lógica duplicada.

## Idempotência — comportamento garantido

| Cenário | Detector | Resultado |
|---|---|---|
| Reupload do **mesmo ficheiro** (mesmo hash, mesma farmácia, mesmo tipo) | `findProcessedLoteByHash` em `startLote` | HTTP 200 `skipped_duplicate` · zero escritas |
| Ficheiro **diferente** (hash diferente) | Hash diverge | Cria novo lote PROCESSADO; reescreve VendaMensal dos meses presentes |
| Tentativa anterior **FALHOU** com mesmo hash | `estado: PROCESSADO` é o lock | Permite retry — nova tentativa cria novo lote, audit trail de tentativas |
| Concorrência (2 agents simultâneos com mesmo ficheiro) | Race window pequena entre `findFirst` e `create` | Ambos passam o check; ambos chamam o importer; importers fazem upsert; **eventualmente consistent**. Para garantia hard, adicionar UNIQUE index `(farmaciaId, tipo, hashConteudo, estado='PROCESSADO')` em migration futura. Não bloqueador para piloto. |

## Response shapes

### 200 — processado (novo)
```json
{
  "ok": true,
  "status": "processed",
  "loteIngestaoId": "clxxxxxxx",
  "hashConteudo": "e3b0c44298fc...",
  "nomeFicheiro": "stock_2026-05.xlsx",
  "farmaciaId": "fcuid...",
  "farmaciaNome": "Farmácia Castelo",
  "records": { "read": 7345, "inserted": 7335, "failed": 10 },
  "durationMs": 4123
}
```

### 200 — skipped (duplicado)
```json
{
  "ok": true,
  "status": "skipped_duplicate",
  "loteIngestaoId": "clxxxxxxx",
  "hashConteudo": "e3b0c44298fc...",
  "nomeFicheiro": "stock_2026-05.xlsx",
  "durationMs": 32,
  "message": "Ficheiro já processado em 2026-05-11T...Z."
}
```

### 400 / 401 / 404 / 500 — erros explícitos
- `missing_file` / `missing_farmacia_id` (400)
- `unauthorized` (401, do `withIntegrationAuth`)
- `farmacia_not_found` (404)
- `import_failed` (500 com `message`)

## Auditoria operacional disponível

- **`LoteIngestao` por farmácia** — `prisma.loteIngestao.findMany({ where: { farmaciaId } })` mostra ficheiros, datas, contagens, estados, mensagens de erro.
- **`SyncRun` cross-tenant** — `/admin` tab "Last sync" mostra agora ingest jobs (não só IPF refresh).
- **`TenantEvent` com `ingest_key_issued`/`rotated`** — quando se emitiu/rotou a chave.

## Como usar agora (dev local com control plane configurado)

```bash
# 1. Configurar tenant (requer Neon + envs já provisionados)
npm run tenant:onboard -- \
  --slug farmacias-braga \
  --nome "Grupo Farmácias de Braga" \
  --admin-email admin@braga.pt

# 2. Emitir ingest key
npm run tenancy:issue-ingest-key -- --slug=farmacias-braga
# → imprime KEY EM CLARO uma vez

# 3. Smoke heartbeat (valida key + slug)
curl -X POST \
  -H "Authorization: Bearer <key>" \
  -H "X-Tenant-Slug: farmacias-braga" \
  https://<deploy>/api/outbox/v1/heartbeat

# 4. Listar farmácias do tenant para descobrir farmaciaId
npm run tenancy:health -- --slug=farmacias-braga

# 5. Upload de stock
curl -X POST \
  -H "Authorization: Bearer <key>" \
  -H "X-Tenant-Slug: farmacias-braga" \
  -F "file=@stock_Atual.xlsx" \
  -F "farmaciaId=<id da farmácia>" \
  https://<deploy>/api/ingest/v1/snapshot/stock

# 6. Reupload do MESMO ficheiro
# → devolve 200 skipped_duplicate (idempotência confirmada)

# 7. Upload de vendas
curl -X POST \
  -H "Authorization: Bearer <key>" \
  -H "X-Tenant-Slug: farmacias-braga" \
  -F "file=@MapaEvolucaoVendas.xlsx" \
  -F "farmaciaId=<id>" \
  https://<deploy>/api/ingest/v1/snapshot/sales-monthly

# 8. Validar
#   /admin           → "Last sync" actualizado, kind=ingest-stock / ingest-sales-monthly
#   /dashboard       → KPIs reais (dependem do IPF refresh subsequente)
#   /oportunidades   → feed populado se houver oportunidades
```

## Limitações conhecidas

| Limitação | Mitigação | Quando importa |
|---|---|---|
| Race window em `startLote` (find + create) | Não impede ingest, só permite linha duplicada em LoteIngestao se 2 uploads idênticos em <100ms | Baixa prob em piloto; adicionar UNIQUE index é trivial quando crítico |
| Importer existente apaga e re-insere VendaMensal por mês | Comportamento legacy do `lib/importer.ts` — não toquei | Dados ficam consistentes; mas se 2 ficheiros diferentes cobrem o mesmo mês, o último vence. Aceitável para snapshot mensal. |
| Endpoint não popula `loteIngestaoId` nas VendaMensal | Importer não foi alterado para receber loteId (manter "refactor mínimo") | Audit não consegue dizer "estas VendaMensal vieram deste ficheiro". Trade-off consciente. Adicionar é 1h se necessário. |
| `multipart/form-data` parser usa `req.formData()` nativo do Next 16 | OK até ~50 MB por ficheiro; acima disso pode precisar de stream parser | Excel típico de farmácia: <5 MB. Não bloqueador. |
| Sem rate-limit no endpoint | Por agora, key auth + bcrypt + maxDuration 300s é suficiente | Adicionar throttling antes de produção pesada |

## Convergência arquitectural — checklist final

- [x] **Uma forma oficial de criar tenants** → `npm run tenant:onboard`
- [x] **Uma forma oficial de emitir credencial** → `npm run tenancy:issue-ingest-key`
- [x] **Uma forma oficial de ingerir dados** → `POST /api/ingest/v1/snapshot/*`
- [x] **Uma forma oficial de correr sync/jobs** → `/api/jobs/*` + Vercel Cron + CLI fallback
- [x] **Um ledger oficial de cada ficheiro** → `LoteIngestao` (já não está dormente)
- [x] **Um ledger oficial de cada sync** → `SyncRun` (control plane)
- [x] **Mesma auth para ingest e outbox** → `withIntegrationAuth`

## O que continua pendente para go-live

1. **P0 INFRA** — Provisionar Neon + envs (`infra-strategy.md`). 30 min humano. **Bloqueador real do piloto.**
2. **`daily-enrich` + `weekly-reverify` sem cron entries em `vercel.json`** — 30 min para criar `/api/jobs/daily-enrich` + `/api/jobs/weekly-reverify` espelhando `refresh-ipf`. Não bloqueia piloto (CLI funciona); operacional desejável.
3. **Agent Windows** — fora do scope deste batch. Em piloto: usar `curl` ou um script de upload simples no PC da farmácia.
4. **`/api/ingest/v1/snapshot/compras`** — quando o pipeline de Compras estiver definido. Adicionar é 1h (mesmo padrão).

## ETA realista para piloto

| Item | Tempo |
|---|---:|
| Infra Neon + envs | 30 min |
| `tenant:onboard` primeiro grupo | 15 min |
| `issue-ingest-key` + smoke heartbeat | 5 min |
| Primeiro upload stock + sales-monthly | 5 min |
| Refresh IPF + validar `/dashboard` | 5 min |
| **TOTAL para primeiro tenant em produção** | **~60 min** |

Grupos subsequentes: **~15 min cada** (tenant:onboard + issue-key + primeiros uploads).

---

_Foco go-live · 4 commits pequenos e focados · zero pipelines paralelos · zero modelos novos · LoteIngestao ressuscitado como ledger oficial · ingest API thin sobre componentes existentes · 9 suites verdes._
