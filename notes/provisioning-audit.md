# Provisioning + Ingestão + Sync — Auditoria

**Data:** 2026-05-11 · **Modo:** read-only, sem alterações de código.

Objectivo: mapear concretamente o que existe, o que funciona, o que
está partido, o que está morto. Decisão sobre o que reaproveitar vs
eliminar **antes** de qualquer nova implementação.

---

## Sumário executivo

A plataforma tem **um pilar sólido** (tenancy lifecycle + outbox
downstream + jobs IPF) e **um buraco crítico** (ingest upstream
inexistente). Há também **vestígios de um pipeline anterior**
(`LoteIngestao` no schema sem nenhum código que o use).

**Para o piloto, falta convergir 3 coisas, todas a 1–2 dias:**

1. **Ingest upstream API** — endpoint `/api/ingest/v1/*` simplesmente não existe. Sem isto, dados só entram via `npx tsx scripts/import-excel.ts` (manual, single-DB).
2. **`issue-ingest-key.ts`** — referenciado em 3 sítios (onboard wrapper, checklist, docs) mas o ficheiro NÃO EXISTE. Onboarding completo é impossível hoje.
3. **Cron entries para enrichment/reverify** — `daily-enrich.ts` e `weekly-reverify.ts` existem mas não estão em `vercel.json`.

**Não há pipelines paralelos para fundir.** Há um único caminho semi-completo. Decisão simples: **completar, não recomeçar**.

---

## 1. Tenancy lifecycle — FUNCIONAL

### Inventário

```
scripts/tenancy/
├── _shared.ts                — helpers (env validation, pg admin, slug→dbName)
├── provision-tenant.ts       — CREATE ROLE + DB + migrate + seed admin + ACTIVE
├── onboard-tenant.ts         — wrapper: provision + smoke + checklist (NEW)
├── list-tenants.ts           — read-only
├── migrate-all-tenants.ts    — prisma migrate deploy em paralelo
├── health-check-tenants.ts   — SELECT 1 + counts em cada tenant
├── deactivate-tenant.ts      — ACTIVE → SUSPENDED
├── reactivate-tenant.ts      — SUSPENDED → ACTIVE
└── smoke-test-resolver.ts    — valida tenant-registry + tenant-context
```

### Estado

| Item | Estado | Notas |
|---|---|---|
| `provision-tenant.ts` (236 linhas) | ✅ funcional, idempotente | Rollback parcial em CREATE ROLE/DB; tenant fica `FAILED` em erros pós-DB |
| `onboard-tenant.ts` (recente) | ⚠️ **parcial** — invoca `issue-ingest-key.ts` que não existe | Imprime checklist com comando inválido |
| `migrate-all-tenants.ts` | ✅ funcional, paraleliza com `runWithLimit` | Pode usar agora `forEachActiveTenant.parallelLimit` (não fez ainda — duplicação fica) |
| `health-check-tenants.ts` | ✅ | npm script `tenancy:health` |
| `forEachActiveTenant` (lib/tenancy/) | ✅ com `parallelLimit` | Single source of truth para iteração tenant-aware |

### Modelo de dados (`prisma-control/schema.prisma`)

`Tenant`:
- `id`, `slug`, `nome`, `estado` (PROVISIONING/ACTIVE/SUSPENDED/DEACTIVATED/FAILED)
- DB conn: `dbHost`, `dbPort`, `dbName`, `dbUser`, `dbPassEncrypted`
- Observability: `schemaVersion`, `provisionedAt`, `lastMigratedAt`, `lastHealthCheckAt`, `lastHealthStatus`, `lastBackupAt`
- Agent auth: `ingestApiKeyHash`, `ingestApiKeyIssuedAt`
- Agent telemetry: `lastAgentHeartbeatAt`, `lastAgentIp`, `lastAgentVersion`

`TenantEvent`: log imutável de acções (created, migrated, suspended, etc.). Usado em provision/deactivate/reactivate.

`GlobalAdmin`: utilizadores cross-tenant. Tabela existe; UI ainda não consome.

### Veredicto Tenancy

**Reaproveitar tudo.** Só precisa de:
1. Criar o `issue-ingest-key.ts` em falta.
2. (Opcional) Migrar `migrate-all-tenants` para usar `forEachActiveTenant.parallelLimit` — elimina `runWithLimit` duplicado. Low priority.

---

## 2. Ingest upstream (agent → SPharm) — **NÃO EXISTE**

### O que devia haver

`/api/ingest/v1/*` para o agent Windows fazer upload de:
- Stock snapshots (xlsx → JSON ou direct JSON)
- Vendas diárias / mensais
- Compras
- Devoluções
- Ajustes de stock

### O que existe

**NADA**. `app/api/ingest/` não existe. Confirmação: `find app/api -type d` mostra apenas `outbox/`, `jobs/`, `reports/`, `settings/`.

### O que existe parcialmente (ingest manual)

`scripts/import-excel.ts` + `lib/importer.ts`:
- Lê `example_files/*.xlsx`
- Cria farmácias (`ensureFarmacia`)
- Importa vendas (`importSalesFromExcel`)
- Importa stock (`importStockFromExcel`)
- **Usa `legacyPrisma` directamente** — não tenant-aware
- Idempotente para stock (upsert); destrói VendaMensal antes de inserir
- Não popula `loteIngestaoId` (modelo morto)

### Vestígios de pipeline anterior

| Componente | Estado |
|---|---|
| `LoteIngestao` model (prisma/schema.prisma:1055) | **MORTO** — schema-only, 0 callers |
| Colunas `loteIngestaoId` em 7 tabelas (ProdutoFarmacia, Venda, VendaMensal, Compra, Devolucao, HistoricoStock, AjusteStock, ProdutoInterno) | **MORTOS** — sempre null em runtime |
| Enums `TipoLoteIngestao`, `EstadoLoteIngestao` | **MORTOS** — só referenciados pelo model dead |
| `hashConteudo` na `LoteIngestao` (idempotência de ingest) | **DESENHADO mas não implementado** |
| `nomeFicheiro`, `blobUrl` na `LoteIngestao` | **DESENHADO mas não implementado** |

### Veredicto Ingest

**Pipeline anterior morreu antes de ser ligado.** O modelo `LoteIngestao` é scaffolding vazio — exactamente o tipo de coisa que o user disse para evitar.

**Recomendação:**
- **Eliminar `LoteIngestao` + colunas `loteIngestaoId` + enums** OU **completar** o pipeline. Não há meio-termo útil.
- Para piloto: aproveitar `lib/importer.ts` (que funciona) e expor via API tenant-aware. Cerca de **0.5 dia**.
- Decidir se `LoteIngestao` é re-aproveitada (audit trail de cada batch) ou eliminada. Razão a manter: rastrear ficheiros importados para troubleshooting. Razão a eliminar: 0 callers há meses, schema ruído.

---

## 3. Downstream — agent recebe ordens (outbox) — FUNCIONAL

### Inventário

```
app/api/outbox/v1/
├── heartbeat/route.ts                          POST — agent says alive
├── orders/list/route.ts                        GET  — paginated read of OrderOutbox state
├── orders/pending/route.ts                     GET  — claim lease (skip locked, 5min TTL)
├── orders/[outboxId]/ack/route.ts              POST — exported OK
├── orders/[outboxId]/nack/route.ts             POST — failure, backoff
├── orders/[outboxId]/cancel/route.ts           POST — admin cancel
├── orders/[outboxId]/release/route.ts          POST — lease abandoned
└── orders/[outboxId]/retry/route.ts            POST — admin manual retry

lib/integracao/
├── auth.ts            — bcrypt-hashed key + X-Tenant-Slug header → AuthenticatedContext
├── outbox-admin.ts    — server actions para UI admin
├── outbox-data.ts     — loaders read-only
└── outbox-schedule.ts — backoff/retry policy

lib/ingest/orders.ts (mal nomeado — não é ingest, é EXPORT):
└── createEncomendaWithOutbox — quando user finaliza encomenda, cria
                                OrderOutbox que o agent puxa
```

### Estado

| Item | Estado | Notas |
|---|---|---|
| Auth bcrypt + X-Tenant-Slug | ✅ rigoroso | Header é vector de auth; cliente Prisma directo da TenantRecord, sem middleware path |
| Claim de lease (SKIP LOCKED + 5min TTL) | ✅ atómico | Suporta múltiplos agents simultâneos sem race |
| Backoff/retry | ✅ | `outbox-schedule.ts` configurável |
| Heartbeat | ✅ | Actualiza `Tenant.lastAgentHeartbeatAt` no control plane |
| Idempotency key + payload hash | ✅ sha256 | Defesa contra mutação acidental |
| Admin UI `/configuracoes/integracao` | ✅ | Mostra contadores, retry manual, ver falhas |

### Veredicto Outbox

**Reaproveitar tudo.** Único nit: o ficheiro `lib/ingest/orders.ts` está mal nomeado (é export upstream para o ERP, não ingest de dados). Refactor de nome opcional, baixa prioridade.

---

## 4. Jobs / cron / scheduler — PARCIAL

### Inventário

```
scripts/jobs/
├── refresh-ipf.ts        — wrapper CLI sobre runIpfPopulate. Suporta
│                           --tenant=, --all-tenants, --record-sync-run
├── daily-enrich.ts       — enriquecimento catálogo (PENDING + lastVerified)
└── weekly-reverify.ts    — reclassificação periódica

app/api/jobs/
└── refresh-ipf/route.ts  — endpoint cron-secret-protected

vercel.json (1 entry só):
  "crons": [{ "path": "/api/jobs/refresh-ipf", "schedule": "0 3 * * *" }]
```

### Estado

| Job | CLI | Endpoint web | Cron entry | SyncRun |
|---|---|---|---|---|
| `refresh-ipf` | ✅ | ✅ `/api/jobs/refresh-ipf` | ✅ daily 03:00 | ✅ |
| `daily-enrich` | ✅ | **❌** | **❌** | ⚠️ (alguns paths usam) |
| `weekly-reverify` | ✅ | **❌** | **❌** | ⚠️ |

### SyncRun adoption

`lib/sync/sync-run.ts` exporta `startSyncRun`/`completeSyncRun`/`failSyncRun`.

Callers:
- ✅ `scripts/jobs/refresh-ipf.ts` (via `--record-sync-run` flag)
- ✅ `scripts/populate-indicadores-produto-farmacia.ts`
- ✅ `scripts/import-details-to-regulatory.ts`
- ❌ `scripts/jobs/daily-enrich.ts`
- ❌ `scripts/jobs/weekly-reverify.ts`
- ❌ `scripts/import-excel.ts`
- ❌ `lib/importer.ts`

### Veredicto Jobs

- **Refresh IPF**: completo (CLI + endpoint + cron + observabilidade). Não tocar.
- **Daily enrich / Weekly reverify**: existem mas não correm automaticamente. Estão a 30 minutos de produção (criar 2 endpoints + 2 cron entries + SyncRun wrap).
- **`vercel.json`**: precisa de 2 entries adicionais quando os endpoints existirem.

---

## 5. Sync observability — FUNCIONAL

### Inventário

`lib/sync/sync-run.ts`:
- `startSyncRun({ tenantSlug, source, meta, triggerType, workerId })` → handle com id
- `completeSyncRun(id, { recordsRead, recordsInserted, recordsFailed })` → finishedAt + durationMs
- `failSyncRun(id, error)` → status FAILED + lastError truncated

`prisma-control/schema.prisma`:
- `SyncRun` table: id, tenantSlug, source, status (RUNNING/SUCCEEDED/FAILED), triggerType (CLI/CRON/UI), workerId, startedAt, finishedAt, durationMs, recordsRead, recordsInserted, recordsFailed, lastError, meta

`lib/admin/tenant-data.ts`:
- `loadLastSyncByTenant()` — última linha por tenantSlug via DISTINCT ON
- Surfaced em `/admin` como coluna "Last sync"

### Veredicto SyncRun

**Reaproveitar.** Migrar mais callers para escrever em SyncRun é hardening puro, não rewrite. Prioridade alta para os 2 jobs órfãos (daily-enrich, weekly-reverify).

---

## 6. Agent Windows / watcher / polling — **NÃO EXISTE NO REPO**

### O que devia haver

Um cliente Windows que:
1. Lê ficheiros Excel/CSV do ERP da farmácia (Sifarma, Glintt, etc.) numa pasta watched
2. Detecta novos ficheiros via fs.watch / inotify
3. Calcula hash (idempotência)
4. POST para `/api/ingest/v1/*` com headers de auth do tenant
5. Pull de `/api/outbox/v1/orders/pending` para receber encomendas a empurrar para o ERP
6. ACK / NACK das encomendas processadas
7. Envia heartbeat periódico

### O que existe

- `chokidar` / `fs.watch` / `inotify`: **0 referências** no código (`package-lock.json` não conta).
- Não há sub-projecto Electron, .NET, Python watcher, nada.
- Apenas o **lado servidor** das APIs (parcial — falta ingest upstream).

### Veredicto Agent

**O agent é um projecto à parte que não vive neste repo, ou nunca foi escrito.**

Para o piloto:
- **Opção A — full agent**: 3–5 dias de trabalho à parte. Fora de escopo RC se queremos 2–3 dias.
- **Opção B — manual import + ingest API**: o operador da farmácia (ou nós) corre `import-excel.ts` semanal/diariamente. Cobre piloto com baixo atrito.
- **Opção C — script de upload local**: 1 ficheiro Python/.NET pequeno que faz HTTP POST do Excel para `/api/ingest/v1/*`. ~0.5 dia depois do endpoint existir.

**Recomendação:** **Opção B + endpoint pronto para Opção C**. O endpoint upstream (passo seguinte) destranca C imediatamente quando quisermos.

---

## 7. Auto-provisioning anterior — só fragmentos

### O que existe

| Item | Estado |
|---|---|
| `provision-tenant.ts` | ✅ Funcional, idempotente (já coberto §1) |
| `onboard-tenant.ts` (recente) | ⚠️ partido (refere `issue-ingest-key.ts`) |
| Setup wizard / installer | ❌ não existe |
| First-run detection | ❌ não existe |

### Veredicto

**Não há tentativa anterior de auto-provision multi-tenant para ressuscitar.** O que existe é o caminho actual; não há código alternativo abandonado.

---

## Convergência arquitectural — uma só forma

### Forma oficial de criar tenants

**`npm run tenant:onboard`** → invoca `provision-tenant.ts` → `smoke-test-resolver.ts` → imprime checklist.

**Pendente para fechar:** criar `scripts/tenancy/issue-ingest-key.ts` (referenciado mas em falta).

### Forma oficial de ingerir dados (PROPOSTA — não há "oficial" hoje)

**Hoje:** `npx tsx scripts/import-excel.ts` (manual, single-DB legacy).

**Tem de ser:** **`POST /api/ingest/v1/{snapshots|sales|stock|compras}`** com auth `Bearer <key>` + `X-Tenant-Slug`, payload JSON ou multipart-form com Excel.

Internamente reusa `lib/importer.ts` (funções já validadas: `importSalesFromExcel`, `importStockFromExcel`, `ensureFarmacia`) — mas com um pequeno wrapper que aceita o cliente Prisma do tenant em vez do `legacyPrisma`.

**Não criar segundo pipeline.** Só:
1. Refactor `lib/importer.ts` para aceitar `prisma` como parâmetro em vez de importar `legacyPrisma`.
2. Criar 4 endpoints thin que chamam essas funções.
3. (Opcional) Decidir se `LoteIngestao` ganha vida ou desaparece.

### Forma oficial de correr sync/jobs

**Hoje:** `/api/jobs/refresh-ipf` + Vercel Cron (1 entry).

**Tem de ser:** **mesmo padrão** para enrich e reverify:
1. Criar `app/api/jobs/daily-enrich/route.ts` e `app/api/jobs/weekly-reverify/route.ts`.
2. Reusar `authorizeCronRequest` + `runJob` patterns existentes.
3. Adicionar entries em `vercel.json`.
4. Wrap em `startSyncRun`/`completeSyncRun` para ledger.

CLI continua a funcionar (mesma lib) — não há divergência.

---

## Classificação: reaproveitar / completar / eliminar

### Reaproveitar (tocar com cuidado)

- `provision-tenant.ts` + todo o resto de `scripts/tenancy/` (sem `issue-ingest-key.ts` em falta)
- `lib/tenancy/for-each-tenant.ts` (com parallelLimit já)
- `lib/integracao/auth.ts` (bcrypt + tenant resolution)
- Todo `/api/outbox/v1/*` + `lib/integracao/outbox-*.ts`
- `lib/sync/sync-run.ts` + `SyncRun` table
- `app/api/jobs/refresh-ipf/route.ts` + `vercel.json` cron pattern
- `lib/operational/ipf-*` (read-model, freshness, populate, calculator)
- `lib/importer.ts` (refactor mínimo de prisma injection)
- `lib/env.ts` + `env-doctor` (recente, central)
- `lib/admin/tenant-data.ts` (admin overview já com IPF freshness)

### Completar (parcial → funcional)

| Gap | Esforço | Bloqueia? |
|---|---:|---|
| **`scripts/tenancy/issue-ingest-key.ts`** | **~30 min** | Sim — onboard incompleto |
| **`/api/ingest/v1/*`** (4 endpoints thin sobre `importer.ts`) | **~0.5 dia** | Sim — sem ingest, agent não pode subir dados |
| **`lib/importer.ts` aceita `prisma` injectado** | **~30 min** | Sim — sem isto, ingest API só funciona em legacy |
| **`/api/jobs/daily-enrich` + `/api/jobs/weekly-reverify`** | **~1h** | Não — CLI funciona; sem cron, manual |
| **`vercel.json` + 2 cron entries** | **~5 min** | Não — quando os endpoints existirem |
| **`migrate-all-tenants.ts` usar `forEachActiveTenant.parallelLimit`** | **~30 min** | Não — duplicação benigna |
| **SyncRun em `daily-enrich`/`weekly-reverify`** | **~30 min** | Não — ledger incompleto |

### Eliminar (morto / scaffolding vazio)

| Item | Razão |
|---|---|
| `LoteIngestao` model + relations + enums | Schema-only, 0 callers, decisão pode ser feita já |
| `loteIngestaoId` em 7 tabelas | Sempre null em runtime |
| `TipoLoteIngestao` enum | Só usado pelo dead model |
| `EstadoLoteIngestao` enum | Só usado pelo dead model |
| Spike scripts (`spike-pesquisa-avancada-v[234].ts`) | Investigação concluída; podem ficar mas são noise |

**Decisão pendente do utilizador:** eliminar `LoteIngestao` agora (migration destrutiva mas safe — 0 callers) ou ressuscitar para audit trail real de ingest API. **Recomendação: ressuscitar** — encaixa naturalmente no `/api/ingest/v1/*` que vai existir, e dá free idempotência via `hashConteudo`.

---

## Blockers reais para go-live

Ordenados por **bloqueio operacional**, não por esforço:

1. **`CONTROL_DATABASE_URL` + `TENANT_DB_HOST` + `POSTGRES_ADMIN_URL` não provisionados** (P0 infra — `notes/infra-strategy.md`). Sem isto, `/admin` em 500 e `provision-tenant` falha. ~30 min infra.
2. **`issue-ingest-key.ts` não existe**. Sem isto, agent não tem credencial para autenticar. ~30 min.
3. **`/api/ingest/v1/*` não existe**. Sem isto, agent não pode fazer upload de dados. ~0.5 dia (depende de §3).
4. **`lib/importer.ts` não é tenant-aware**. Sem isto, ingest API só serve a BD legacy. ~30 min.

**Após (1)+(2)+(3)+(4)**: piloto funcional. Total operacional: **~1 dia útil de dev + ~30 min infra**.

---

## Delta exacto até go-live operacional

```
┌─ INFRA (humano, ~30 min) ─────────────────────────────────────────┐
│ 1. Provisionar Neon project + 8 envs em Vercel/.env              │
│ 2. npm run env:doctor → todos os scopes ready                    │
│ 3. Aplicar schema control plane                                  │
└──────────────────────────────────────────────────────────────────┘

┌─ DEV (~1 dia) ───────────────────────────────────────────────────┐
│ 4. Criar scripts/tenancy/issue-ingest-key.ts                     │
│    · gera key random, bcrypt hash, UPDATE Tenant.ingestApiKeyHash│
│    · imprime key em claro UMA VEZ                                │
│    · 30 min                                                       │
│                                                                   │
│ 5. Refactor lib/importer.ts para receber prisma injectado        │
│    · ensureFarmacia(prisma, nome)                                │
│    · importSalesFromExcel(prisma, path, farmaciaId)              │
│    · 30 min                                                       │
│                                                                   │
│ 6. Decidir + acção sobre LoteIngestao:                           │
│    · OPÇÃO A: criar helpers em lib/ingest/lote-ingestao.ts       │
│      que populam o modelo a cada call de import. Dá idempotência │
│      via hashConteudo. ~1h                                        │
│    · OPÇÃO B: eliminar modelo + colunas via migration. Limpa,   │
│      mas decisão final. ~30 min                                  │
│    DECIDIR antes de avançar.                                     │
│                                                                   │
│ 7. Criar /api/ingest/v1/* (4 endpoints):                         │
│    · POST /api/ingest/v1/snapshot/stock                          │
│    · POST /api/ingest/v1/snapshot/sales-monthly                  │
│    · POST /api/ingest/v1/snapshot/sales-daily (opcional)         │
│    · POST /api/ingest/v1/snapshot/compras (opcional)             │
│    · Cada um: withIntegrationAuth → parser → importer fn →       │
│      SyncRun start/complete → JSON response                      │
│    · ~3h                                                          │
│                                                                   │
│ 8. Criar /api/jobs/daily-enrich + weekly-reverify (espelha       │
│    refresh-ipf): ~1h                                              │
│ 9. Adicionar entries em vercel.json: ~5 min                       │
└──────────────────────────────────────────────────────────────────┘

┌─ VALIDAÇÃO (~30 min) ────────────────────────────────────────────┐
│ 10. tenant:onboard de um piloto                                   │
│ 11. issue-ingest-key + anotar                                     │
│ 12. curl POST /api/ingest/v1/snapshot/stock com Excel real        │
│ 13. /admin mostra "Last sync" actualizado                         │
│ 14. /dashboard mostra dados                                       │
│ 15. /oportunidades mostra sugestões                                │
└──────────────────────────────────────────────────────────────────┘
```

**Total realista:** **1 dia de dev + 30 min infra + 30 min validação = ~1.5 dias úteis.**

Sem agente Windows neste delta. Opção C (upload script local) é trivial depois dos endpoints existirem (~2h pelo cliente).

---

## Regras de execução para a próxima passagem

- **Não criar pipelines paralelos.** Há um caminho semi-completo; completa-se.
- **Não criar modelos novos.** Reaproveita `LoteIngestao` ou elimina.
- **Não criar wrappers sobre wrappers.** O endpoint chama directamente a função do importer.
- **Reaproveitar `withIntegrationAuth`** para auth no `/api/ingest/v1/*` (mesma que outbox).
- **Reaproveitar `SyncRun`** para observabilidade (mesma helpers).
- **Reaproveitar `lib/importer.ts`** após refactor mínimo.
- **Não tocar em outbox / refresh-ipf / dashboard / oportunidades** — estão funcionais.

---

_Audit-only · sem alterações de código · objectivo: convergir num único caminho oficial antes de implementar. Próxima passagem: completar as 4 lacunas críticas (issue-ingest-key, importer prisma injection, decisão LoteIngestao, /api/ingest/v1/*) num delta total de ~1 dia útil._
