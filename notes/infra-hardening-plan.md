## Infrastructure Hardening Plan — SPharm.MT

**Data:** 2026-05-11
**Estado:** análise / desenho (read-only — sem migrations, sem scheduler real, sem cloud calls)
**Stack referência:** Next.js 16.2.2, Prisma 7.6 (PrismaPg adapter), Neon Postgres, Vercel
**Predecessores (não duplicar — citar):** [`notes/multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md), [`notes/data-sync-architecture.md`](./data-sync-architecture.md), [`notes/scaling-throughput-design.md`](./scaling-throughput-design.md), [`notes/infomed-pipeline-final-report.md`](./infomed-pipeline-final-report.md)

---

## 1. Executive Summary

- A SPharm.MT já tem **DB-per-tenant** activo no control plane ([`prisma-control/schema.prisma:50-114`](../prisma-control/schema.prisma)) e runtime tenant-aware via `getPrisma()` ([`lib/prisma.ts:81-84`](../lib/prisma.ts)). O bloqueio actual de hardening **não é arquitectural** — é operacional: 41 scripts dependem do singleton `legacyPrisma` ([`lib/prisma.ts:57-61`](../lib/prisma.ts)), zero deles iteram tenants, **nenhum cron está agendado** (não existe `vercel.json`) e o pipeline INFOMED — fresh-closed em [`notes/infomed-pipeline-final-report.md`](./infomed-pipeline-final-report.md) — corre via CLI manual.
- O **scheduler architecture** recomendado é híbrido: Vercel Cron como timer trigger (limite assumido ≈40 schedules/projecto no Pro plan — **a verificar** nos docs Vercel 2026) que invoca handlers `app/api/cron/*` curtos; jobs longos (>5 min, ex. reprocess full do catálogo) num daemon container externo (Railway/Fly/Render). Identifico **12 jobs candidatos** prioritários (tabela em §3).
- **`SyncRun` ledger** (novo modelo) consolida observabilidade cross-source: completa `LoteIngestao` (transacional per-farmácia, [`prisma/schema.prisma:1055`](../prisma/schema.prisma)) e `EnrichmentSourceLog` (per-produto-conector, [`prisma/schema.prisma:467`](../prisma/schema.prisma)). Schema proposto em §4 com idempotência via `(source, idempotencyKey)` único + checkpoint resumível.
- A migração **scripts → tenant-aware** afecta 41 ficheiros mas só ~12 são críticos. A regra de decisão (catálogo central vs per-tenant) está em §5. `forEachActiveTenant` (helper proposto em [`notes/multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §5 Fase A.1) é pré-requisito.
- **Custo & connection budget** (§6): no cenário 100 tenants estimo **~600 €/mês** de DB + Vercel + daemon (consistente com [`notes/multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §8). O recurso que esgota primeiro **não é storage nem compute, é o connection budget** — DB-per-tenant escala connections linearmente, e o pooler do Neon (PgBouncer transaction-mode embutido no host `*-pooler.*`) é o que torna 1000 tenants viáveis. **A verificar** com tier Scale ($69/mês) ou Business antes de ultrapassar 200 tenants.
- O caminho crítico para SaaS multi-cliente é uma sequência de **3 fases** (§7): Fase 1 = `SyncRun` + `forEachActiveTenant` (5-7 dias); Fase 2 = scheduler real + 5 endpoints `/api/cron/*` (3-5 dias); Fase 3 = backups automatizados + cost dashboards (5-7 dias). Total ≈3 semanas focadas.

---

## 2. Contexto e premissas

### 2.1 O que está estável (não tocar)

- Provisioning multi-tenant (`scripts/tenancy/provision-tenant.ts`) — fluxo de 10 passos validado, ver [`notes/multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §4.
- Outbox downstream `OrderOutbox`/`OrderExportAudit` — [`prisma/schema.prisma:1110-1193`](../prisma/schema.prisma). Inclui lease com `leasedUntil`, retry schedule explícito em [`lib/integracao/outbox-schedule.ts:17-23`](../lib/integracao/outbox-schedule.ts), e `idempotencyKey` determinístico per-lista. **Este é o blueprint a replicar** para outras pipelines.
- Pipeline INFOMED — fechado e 0-failure ([`notes/infomed-pipeline-final-report.md`](./infomed-pipeline-final-report.md)). Pode ficar manual até que justifiquemos automação.

### 2.2 O que falta (alvo deste plano)

| Lacuna | Notas vizinhas que mapearam | Owner deste doc |
|---|---|---|
| L1: Scripts não tenant-aware (41 files) | [`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §3 L1 | §5 |
| L2: Sem scheduler | [`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §3 L2; [`data-sync-architecture.md`](./data-sync-architecture.md) §5 L1 | §3 |
| L3: Sem `SyncRun` ledger cross-source | [`data-sync-architecture.md`](./data-sync-architecture.md) §5 L2 | §4 |
| L4: Connection / cost budget cego | [`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §3 L4, L6 | §6 |
| L5: Backups não automatizados | [`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §3 L3 | §6 + §7 Fase 3 |

### 2.3 Convenções

- "Verificar" = consultei mas não testei em produção.
- "Assumir" = valor plausível pela documentação pública / experiência; **deve ser confirmado** antes de gastar tempo de engenharia ou dinheiro.
- "Confirmado" = lido directamente no repo / executado / documentado num relatório vizinho.

---

## 3. B1 — Scheduler Architecture

### 3.1 Inventário do que é "agendado" hoje

| Item | Onde | Estado actual | Observação |
|---|---|---|---|
| `vercel.json` | — | **NÃO EXISTE** (confirmado via `Glob`) | Não há crons em produção |
| `app/api/cron/*` | — | **NÃO EXISTE** | Idem |
| `app/api/jobs/*` | — | **NÃO EXISTE** | Idem |
| `setInterval` em código de produção | `lib/`, `app/` | **0 ocorrências** (confirmado via `Grep`) | Bom — nada accidental |
| `setTimeout` em código de produção | — | apenas em scripts CLI (sleep helpers nos workers, ex. [`scripts/workers/enrichment-worker.ts:34`](../scripts/workers/enrichment-worker.ts)) | OK |
| Workers contínuos (long-running) | `scripts/workers/enrichment-worker.ts`, `scripts/workers/regulatory-acquisition-worker.ts` | rodados **manualmente** via `npx tsx`; ambos têm graceful shutdown SIGINT/SIGTERM | Prontos para um daemon container |
| Jobs (one-shot) | `scripts/jobs/daily-enrich.ts`, `scripts/jobs/weekly-reverify.ts` | manuais | "daily"/"weekly" no nome ≠ executados (confirmado em [`data-sync-architecture.md`](./data-sync-architecture.md) §5 L1) |
| Outbox agent | Agent Windows externo (fora deste repo) faz `--pull-downstream` cada 5min via `/api/outbox/v1/orders/pending` | **NÃO é um cron Vercel** — é um scheduled task no Windows da farmácia. Funcional. | OK; é o único agendamento real |
| Outbox heartbeat | `Tenant.lastAgentHeartbeatAt` em [`prisma-control/schema.prisma:100`](../prisma-control/schema.prisma) | populado pelo agent | Base já existe para alerting "agent offline" |
| Tenant health-check | `scripts/tenancy/health-check-tenants.ts` | docstring diz "cada 5 min" mas não está agendado | Candidato directo para Vercel Cron |

**Conclusão:** SPharm.MT tem **0 crons activos**. Tudo o que tem nome "daily"/"weekly" é manual. Esta é a maior alavanca operacional.

### 3.2 Limites a verificar antes de implementar

> **A VERIFICAR nos docs Vercel/Neon vigentes (Jan 2026):**

- **Vercel Cron — Hobby plan:** assumido 2 schedules max, frequência ≥24h. Hobby **não é viável** para SaaS multi-tenant.
- **Vercel Cron — Pro plan:** assumido ≈40 schedules max, frequência mínima 1min, **timeout default ≤60s** (extensível para 300s em runtime `nodejs`). **A confirmar nos docs vigentes — números mudaram historicamente.**
- **Vercel function maxDuration:** Hobby 10s, Pro 60s (configurável até 300s), Enterprise 900s. Hoje no repo só vejo `runtime = "nodejs"` em 4 routes ([`app/api/reports/pdf/route.ts:18`](../app/api/reports/pdf/route.ts), `email/route.ts`, `settings/email/*`). Nenhuma usa `maxDuration` explícito.
- **Edge runtime:** middleware já em Edge ([`middleware.ts`](../middleware.ts)). Cron handlers **devem ficar em `nodejs`** porque precisam do PrismaPg adapter.
- **Neon — Free tier:** assumido ≈100 conexões totais, 0.5GB storage por DB, 5GB total. **Insuficiente para multi-tenant** ([`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §7).
- **Neon — Launch ($19/mês):** assumido pooler ilimitado, 10GB storage, retention 7d. Boa entrada para piloto 1-10 tenants.
- **Neon — Scale ($69/mês):** assumido suporte para múltiplos projects, RBAC, 50GB. Adequado para 50-200 tenants.
- **Neon — Business / Enterprise:** custom. Provavelmente necessário >500 tenants.

Estas premissas **devem ser revistas** consultando `vercel.com/docs/cron-jobs` e `neon.tech/pricing` antes de qualquer implementação concreta.

### 3.3 Matriz de jobs candidatos

Doze jobs candidatos identificados. Cada tem cadência, timeout esperado, e infraestrutura recomendada. Distinguir **cron-master** (1 schedule itera N tenants) vs **per-tenant cron** (1 schedule × N tenants = 1×N agendamentos, **inviável** com limite de ~40).

| # | Job | Frequência ideal | Timeout esperado | Infra recomendada | Retry | DLQ |
|---|---|---|---|---|---|---|
| 1 | **Tenant health-check** (`scripts/tenancy/health-check-tenants.ts`) | a cada 5min | <30s por tenant, total <2min | Vercel Cron → `/api/cron/tenant-health` (itera tenants ACTIVE, paralelismo 10) | imediato 1× retry; depois marca `Tenant.lastHealthStatus="error"` | `TenantEvent` action="health_check_failed" — já implementado em [`scripts/tenancy/health-check-tenants.ts:52-57`](../scripts/tenancy/health-check-tenants.ts) |
| 2 | **Daily enrich** (`scripts/jobs/daily-enrich.ts`) | diário 03:00 PT | varia: 100 produtos ~5min; full catalog ~1h | **Daemon externo** — invocado por cron OS, itera tenants ACTIVE com `forEachActiveTenant` | exponential backoff 3 tentativas | row em `SyncRun` com status=FAILED + alert email |
| 3 | **Weekly reverify** (`scripts/jobs/weekly-reverify.ts`) | semanal Dom 02:00 | 500 produtos ~30min; full ~5h | Daemon externo | idem | idem |
| 4 | **Enrichment worker** (`scripts/workers/enrichment-worker.ts`) | contínuo (loop, sleep 30s quando idle) | long-running infinito | Daemon container persistente | embutido (BACKOFF_BASE_MS exponencial — [`scripts/workers/enrichment-worker.ts:38`](../scripts/workers/enrichment-worker.ts)) | embutido (estado `FALHOU` na `EnriquecimentoFila`) |
| 5 | **Regulatory acquisition worker** (`scripts/workers/regulatory-acquisition-worker.ts`) | a cada 1h (stateless, 4min cap) | maxDuration=240s — desenhado para cron ([`scripts/workers/regulatory-acquisition-worker.ts:40-41`](../scripts/workers/regulatory-acquisition-worker.ts)) | **Vercel Cron** → `/api/cron/regulatory-acquisition` é viável (cabe em 300s Pro plan) | embutido (BACKOFF_HOURS — [`scripts/workers/regulatory-acquisition-worker.ts:61`](../scripts/workers/regulatory-acquisition-worker.ts) `[1,4,24,72,168]`) | status=FAILED após 6 tentativas |
| 6 | **Outbox stuck-lease release** (não existe ainda) | a cada 10min | <30s | Vercel Cron → `/api/cron/outbox-release-stale` | nenhum (idempotente) | — |
| 7 | **INFOMED browse mensal** (`scripts/browse-infomed-listagem.ts`) | mensal dia 1 03:00 | ~15min ([`infomed-pipeline-final-report.md`](./infomed-pipeline-final-report.md) §3.1) | Daemon externo (>5min) | manual review; pipeline já 0-failure | row em `SyncRun` |
| 8 | **INFOMED fetch detalhes** (`scripts/fetch-details-by-medid.ts`) | mensal após #7 | ~25min ([`infomed-pipeline-final-report.md`](./infomed-pipeline-final-report.md) §3.2) | Daemon externo | rate-limited internamente | row em `SyncRun` |
| 9 | **INFOMED import + sync + reprocess** | mensal após #8 | ~1h45 (12 + 3 + 90 min) | Daemon externo | manual review | row em `SyncRun` |
| 10 | **ERP Excel import** (`scripts/import-excel.ts`) | trigger-on-upload (webhook) — n/a cron | varia | API route `POST /api/import/excel` (~5min, Pro plan) | manual | `LoteIngestao` estado=REJEITADO |
| 11 | **Backup snapshot per tenant** (não existe — proposta [`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) Fase C) | diário 04:00 | <2min por tenant (chamada Neon API) | Vercel Cron → `/api/cron/snapshot-tenants` (itera tenants ACTIVE) | 2× retry depois alerta | `TenantEvent` action="snapshot_failed" |
| 12 | **Catalog quality report snapshot** (`scripts/catalog-quality-report.ts`) | semanal | <2min global | Vercel Cron → `/api/cron/quality-snapshot` | n/a (idempotente) | log apenas |

**Padrão recorrente:** todos os jobs que **iteram tenants** seguem o mesmo molde — 1 schedule master invoca handler curto que faz `forEachActiveTenant(callback)`. Limite de schedules nunca atingido porque a multiplicação acontece dentro do handler.

### 3.4 Vercel Cron vs Daemon — critério de decisão

| Critério | Vercel Cron | Daemon externo (Railway/Fly/Render) |
|---|---|---|
| Job dura <5min | ✅ adequado | overkill |
| Job dura 5-15min | ⚠ requer Enterprise (900s) | ✅ adequado |
| Job dura >15min | ❌ impossível | ✅ |
| Worker contínuo (loop) | ❌ não é o modelo | ✅ |
| Stateful (sessões HTTP longas) | ❌ cold starts matam | ✅ |
| Custo fixo mensal | embutido no Vercel Pro | +10-20 €/mês extra |
| Ops complexity | mínima | médio (deploy separado, env separado, monitoring separado) |
| Cold-start latency | ~500-1500ms (Pro), maior em Edge | nenhum |

**Recomendação:** **híbrido**. Use Vercel Cron para os jobs ≤4min (#1, #5, #6, #11, #12). Use daemon externo para os jobs longos (#2, #3, #4, #7-9). O daemon corre com cron OS-level e partilha o mesmo repo (`tsx scripts/...`).

### 3.5 Retry e DLQ — política transversal

**Retry model recomendado (3 patterns):**

1. **Outbox-style** (já implementado em [`lib/integracao/outbox-schedule.ts`](../lib/integracao/outbox-schedule.ts)): `[1min, 5min, 30min, 2h, 8h, MAX]`. Persistente em DB, sobrevive a crashes.
2. **Acquisition-style** (já em [`scripts/workers/regulatory-acquisition-worker.ts:61`](../scripts/workers/regulatory-acquisition-worker.ts)): `[1h, 4h, 24h, 72h, 168h]`. Para jobs que não são tempo-críticos.
3. **In-memory exponential** (já em [`scripts/workers/enrichment-worker.ts:38`](../scripts/workers/enrichment-worker.ts)): 1m·2m·4m·8m·16m. Para retentar dentro de uma execução do worker.

**Recomendado:** padronizar nos patterns #1 e #2 (persistentes). Eliminar #3 da nova `SyncRun`-aware versão. Razão: in-memory retries perdem-se quando o daemon reinicia.

**Dead-Letter strategy:**

- Status terminal `FAILED` ou `BLOCKED` na tabela da queue (existem hoje em `RegulatoryAcquisitionJob.status`, `EnriquecimentoFila.estado`, `OrderOutbox.state`).
- Sem reinjecção automática. Reentry só por acção humana (UI admin ou CLI `--retry-failed`).
- Alert (`TenantEvent` + email) quando uma DLQ cresce >X% num período (regra a definir empiricamente — assumir `>10 jobs FAILED em 24h` como gatilho inicial).

---

## 4. B2 — SyncRun Ledger

### 4.1 Justificação

Hoje a observabilidade "última sync por fonte" é zero (confirmado em [`data-sync-architecture.md`](./data-sync-architecture.md) §5 L2). Os modelos existentes cobrem **fatias** mas não o todo:

- `LoteIngestao` ([`prisma/schema.prisma:1055`](../prisma/schema.prisma)) — cobre só ingestão transacional per-farmácia (Excel, vendas, stock).
- `EnrichmentSourceLog` ([`prisma/schema.prisma:467`](../prisma/schema.prisma)) — granularidade por (produto × conector × tentativa). Demasiado fino para observabilidade de "saúde do sync".
- `ProdutoVerificacaoHistorico` ([`prisma/schema.prisma:437`](../prisma/schema.prisma)) — per-produto, semelhante.
- `RegulatoryAcquisitionJob` ([`prisma/schema.prisma:404`](../prisma/schema.prisma)) — queue, não ledger histórico.
- `TenantEvent` ([`prisma-control/schema.prisma:118`](../prisma-control/schema.prisma)) — eventos infra-tenant (created/migrated/health-check). **Não para syncs aplicacionais.**

`SyncRun` preenche o slot **"uma row por execução de job, qualquer que seja a fonte"**.

### 4.2 Schema SQL proposto (NÃO para correr — apenas desenho)

```sql
-- VIVE NO TENANT DB (não no control plane).
-- Razão: cada tenant tem o seu próprio histórico de syncs.
-- O cron master itera tenants e escreve N rows (uma por tenant).
-- Esta tabela deve ser adicionada a `prisma/schema.prisma` numa migration
-- aditiva (sem destruir nada) — depois Fase 1 inicial.

CREATE TABLE "SyncRun" (
  id              TEXT       PRIMARY KEY,                    -- cuid
  source          TEXT       NOT NULL,                       -- ex: "infomed_browse", "daily_enrich", "tenant_health"
  jobKind         TEXT       NOT NULL,                       -- "cron" | "manual" | "webhook"
  tenantSlug      TEXT,                                      -- null para jobs globais (catalog enrichment)
  farmaciaId      TEXT,                                      -- null para jobs cross-farmacia dentro do tenant
  idempotencyKey  TEXT       NOT NULL,                       -- determinístico, ver §4.3
  contentHash     TEXT,                                      -- hash do input quando aplicável (file hash, watermark)

  -- Status / lifecycle
  status          TEXT       NOT NULL DEFAULT 'STARTED',     -- STARTED|RUNNING|SUCCESS|PARTIAL|FAILED|CANCELLED
  startedAt       TIMESTAMP  NOT NULL DEFAULT NOW(),
  finishedAt      TIMESTAMP,
  durationMs      INTEGER,

  -- Outcome
  rowsProcessed   INTEGER    DEFAULT 0,
  rowsInserted    INTEGER    DEFAULT 0,
  rowsUpdated     INTEGER    DEFAULT 0,
  rowsSkipped     INTEGER    DEFAULT 0,
  rowsRejected    INTEGER    DEFAULT 0,
  errorMessage    TEXT,                                       -- truncado a 1000 chars
  errorStackHash  TEXT,                                       -- group similar errors

  -- Checkpoint / recovery
  checkpointJson  JSONB,                                      -- ver §4.4
  watermarkBefore TEXT,                                       -- ex: "2026-05-10T00:00:00Z" (timestamp do último sucesso)
  watermarkAfter  TEXT,                                       -- após este run

  -- Observabilidade
  metaJson        JSONB,                                      -- contexto livre (file paths, params CLI, etc.)
  triggerActor    TEXT,                                       -- "cron" | "admin:cm123abc" | "agent:windows-xy"
  hostId          TEXT,                                       -- nome do container/worker (debug)

  createdAt       TIMESTAMP  NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT syncrun_idempotency UNIQUE (source, idempotencyKey)
);

CREATE INDEX idx_syncrun_source_started     ON "SyncRun"(source, startedAt DESC);
CREATE INDEX idx_syncrun_tenantSlug_started ON "SyncRun"(tenantSlug, startedAt DESC) WHERE tenantSlug IS NOT NULL;
CREATE INDEX idx_syncrun_status_started     ON "SyncRun"(status, startedAt DESC) WHERE status IN ('STARTED', 'RUNNING', 'FAILED');
CREATE INDEX idx_syncrun_farmacia_source    ON "SyncRun"(farmaciaId, source, startedAt DESC) WHERE farmaciaId IS NOT NULL;
```

### 4.3 Idempotência

**Princípio:** correr a mesma sync 2× nunca dobra dados nem cria estado inconsistente.

| Tipo de sync | Estratégia de idempotency key |
|---|---|
| **File upload** (ERP Excel) | `sha256(file_content)` — re-import do mesmo ficheiro hit no UNIQUE, retorna no-op |
| **Pull-based** (INFOMED browse) | `dataSlot:YYYY-MM` — corre 1× por mês; segunda chamada no mesmo slot é no-op |
| **Time-window** (daily-enrich) | `dataSlot:YYYY-MM-DD` |
| **Watermarked** (incremental, ex. "novos produtos desde X") | `watermark:<iso8601-do-cursor-anterior>` |
| **Manual** (admin trigger) | `manual:<adminId>:<unix-ms>` (sempre único — não dedup) |
| **Webhook** (futuro) | `webhook:<webhookEventId>` |

**Pattern de uso (pseudocódigo):**

```ts
async function runSync(opts: { source: string; idempotencyKey: string; ... }) {
  const existing = await prisma.syncRun.findFirst({
    where: { source: opts.source, idempotencyKey: opts.idempotencyKey },
  });
  if (existing && (existing.status === 'SUCCESS' || existing.status === 'RUNNING')) {
    return { skipped: true, reason: existing.status === 'RUNNING' ? 'in_progress' : 'already_done' };
  }
  const run = await prisma.syncRun.create({
    data: { ...opts, status: 'RUNNING' },
  });
  try {
    const result = await doTheWork(run);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: 'SUCCESS', finishedAt: new Date(), ...result },
    });
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: String(err).slice(0, 1000) },
    });
    throw err;
  }
}
```

Onde a **content hash** (`contentHash`) é distinta da `idempotencyKey`: a key controla "já corri isto?", o hash detecta corruption ("este ficheiro chama-se igual mas o conteúdo mudou — ALERTA").

### 4.4 Recovery e resumable batches

`checkpointJson` é populado periodicamente durante a execução para permitir retomar.

**Exemplo — INFOMED fetch detalhes (3 workers, 5242 MED_IDs):**

```json
{
  "kind": "infomed_fetch_details",
  "totalItems": 5242,
  "processedItems": 3120,
  "lastProcessedMedId": "INFOMED-9876543",
  "failedItems": [],
  "workersState": { "worker1": "INFOMED-A", "worker2": "INFOMED-B", "worker3": "idle" }
}
```

Recovery: ao reiniciar, o job lê `checkpointJson.lastProcessedMedId` e continua. O `idempotencyKey` mantém-se (`dataSlot:2026-05`), evitando re-tentar tudo.

**Quando NÃO usar checkpoint:**

- Jobs <30s — overhead não compensa.
- Jobs que escrevem em tabelas com `@@unique` natural — o upsert idempotente por linha já cobre.
- Workers contínuos — usam a sua própria queue (`EnriquecimentoFila`, `RegulatoryAcquisitionJob`).

### 4.5 Observabilidade — campos a expor à UI

Endpoint hipotético `/admin/sync-health` (proposto em [`data-sync-architecture.md`](./data-sync-architecture.md) §8 B.2):

| Painel | Query SQL aproximada |
|---|---|
| "Última sync OK por fonte" | `SELECT source, MAX(finishedAt) FROM SyncRun WHERE status='SUCCESS' GROUP BY source` |
| "Falhas nas últimas 24h" | `SELECT source, COUNT(*) FROM SyncRun WHERE status='FAILED' AND startedAt > NOW()-INTERVAL '24h' GROUP BY source` |
| "Throughput médio (rows/min)" | `SELECT source, AVG(rowsProcessed * 60000.0 / durationMs) FROM SyncRun WHERE status='SUCCESS' AND startedAt > NOW()-INTERVAL '7d' GROUP BY source` |
| "Tenants com sync atrasada" | `SELECT tenantSlug FROM SyncRun WHERE source='daily_enrich' AND startedAt > NOW()-INTERVAL '48h' GROUP BY tenantSlug HAVING MAX(finishedAt) IS NULL` |
| "Jobs presos (RUNNING > 1h)" | `SELECT * FROM SyncRun WHERE status='RUNNING' AND startedAt < NOW()-INTERVAL '1h'` |

### 4.6 Métricas a recolher (não na DB, em logs/metrics)

- `sync_runs_total{source,status}` — counter
- `sync_duration_ms{source}` — histogram (p50, p95, p99)
- `sync_rows_processed{source}` — gauge
- `sync_error_rate{source}` — rolling 1h / 24h / 7d

Sem Prometheus na stack actual; alternativa pragmática é um JSONL append-only em [`scripts/data/metrics/`](../scripts/data/) (padrão já discutido em [`scaling-throughput-design.md`](./scaling-throughput-design.md) §2 P6).

---

## 5. B3 — Multi-tenant Scripts Migration

### 5.1 Inventário grep — quem usa o quê

**Confirmado:** 41 ficheiros importam `legacyPrisma` (todos em `scripts/`). 7 ficheiros importam `controlPrisma` (todos em `scripts/tenancy/`). **Zero scripts** importam `getPrisma()` — é exclusivamente runtime web.

### 5.2 Triagem por criticidade

Classificação:
- **C (catálogo central)**: opera em catálogo global (Produto, RegulatoryRecord, Classificacao, Fabricante). Pode ficar single-DB-shared até decisão estratégica de federar catálogo.
- **T (per-tenant)**: opera em dados per-farmácia (Venda, ProdutoFarmacia, VendaMensal, LoteIngestao, FilaRevisao, etc.). **Precisa migrar para tenant-aware**.
- **H (híbrido)**: toca em ambos. Avaliar caso a caso.
- **O (ops)**: scripts utilitários (diagnose, check, audit) — read-only ou descartáveis.

### 5.3 Top 10 críticos para migração

| # | Script | Tipo | Função | Última actividade (git) | Frequência real | Acção recomendada |
|---|---|---|---|---|---|---|
| 1 | [`scripts/import-excel.ts`](../scripts/import-excel.ts) | **T** | Importa Excels do ERP (VendaMensal, ProdutoFarmacia, Venda, Stock) por farmácia | `4c0f8e2 2026-04-10` | quando há novo Excel | **Migrar urgente** — aceitar `--tenant=<slug>`, abrir client via `buildTenantConnectionString` |
| 2 | [`scripts/jobs/daily-enrich.ts`](../scripts/jobs/daily-enrich.ts) | C (mas executado per-tenant) | Enriquecimento incremental do catálogo | `60f9c75 2026-04-27` | diário (desejado) | Refactor → invocável via `forEachActiveTenant(slug => runDailyEnrich(prismaFor(slug)))` |
| 3 | [`scripts/jobs/weekly-reverify.ts`](../scripts/jobs/weekly-reverify.ts) | C | Re-verificação semanal de produtos antigos | (mesmo commit) | semanal | Idem #2 |
| 4 | [`scripts/workers/enrichment-worker.ts`](../scripts/workers/enrichment-worker.ts) | T (queue per-tenant) | Worker contínuo a drenar `EnriquecimentoFila` | (mesmo commit) | contínuo | Refactor para receber `PrismaClient` como param + iterar tenants em rotação ou worker-per-tenant |
| 5 | [`scripts/workers/regulatory-acquisition-worker.ts`](../scripts/workers/regulatory-acquisition-worker.ts) | C (catálogo global) | Drena `RegulatoryAcquisitionJob` | `a727892 2026-05-08` | a cada 1h | **Pode ficar single-DB** (catálogo é global) |
| 6 | [`scripts/import-regulatory-record.ts`](../scripts/import-regulatory-record.ts) | C | Importa snapshots CEDIME-ANF | manual ad-hoc | trimestral | Pode ficar single-DB |
| 7 | [`scripts/import-infarmed-snapshot.ts`](../scripts/import-infarmed-snapshot.ts) | C | Importa snapshot INFARMED | manual | mensal | Single-DB OK |
| 8 | [`scripts/sync-rr-to-produto-broad.ts`](../scripts/sync-rr-to-produto-broad.ts) | H | RR → Produto sync. **Produto vive em cada tenant DB.** | recente (INFOMED pipeline) | mensal | **Tenant-aware** — itera tenants e copia RR (do central?) para cada Produto |
| 9 | [`scripts/reprocess-catalog.ts`](../scripts/reprocess-catalog.ts) | T | Reclassifica Produto.classificacaoNivel2 | recente | mensal (após import) | Idem #8 |
| 10 | [`scripts/seed-enrichment-queue.ts`](../scripts/seed-enrichment-queue.ts) | T | Popula `EnriquecimentoFila` per-tenant | `4c0f8e2 2026-04-10` | manual / on-deploy | Tenant-aware com `forEachActiveTenant` |

### 5.4 Restantes 31 — classificação rápida

- **O (descartáveis ou one-shot):** `analyze-review-queue.ts`, `audit-infomed-divergencies.ts`, `check-mapping-vs-produto.ts`, `check-outros-count.ts`, `check-reprocess-distribution.ts`, `check-taxonomy-expansion.ts`, `cleanup-technical-categories.ts`, `coverage-report-infomed-details.ts`, `db-check.ts`, `dedup-fila-revisao.ts`, `delete-farmacia-teste.ts`, `diagnose-*` (3), `diff-mapping-vs-regulatory.ts`, `release-metrics.ts`, `rule-gap-detail-query.ts`, `sample-rule-gaps.ts`, `test-atc-prefix-mapping.ts`, `validate-pipeline.ts`, `write-candidates-report.ts`, `crawl-infomed-search.ts`, `spike-pesquisa-avancada*.ts` (4). **Acção: deixar como estão** — usam catálogo central ou são one-shot diagnósticos.
- **C (catálogo central, manter single-DB):** `browse-infomed-listagem.ts`, `fetch-details-by-medid.ts`, `import-details-to-regulatory.ts`, `import-mapping-to-regulatory-record.ts`, `sync-regulatory-to-produto.ts`, `sync-enriched-fields.ts`, `seed-taxonomy.ts`, `enqueue-regulatory-acquisition.ts`, `enrich-products.ts`, `update-fabricantes-from-xlsx.ts`, `catalog-quality-report.ts`. **Acção: ficam single-DB. Documentar formalmente.**
- **T (per-tenant):** `backfill-produto-farmacia-origem.ts`. **Acção: migrar.**

### 5.5 Catálogo central vs per-tenant — regra de decisão

A pergunta "este script deve migrar para tenant-aware?" responde-se com:

```
Lê/escreve em Venda, Compra, Devolucao, AjusteStock,
            ProdutoFarmacia, VendaMensal, HistoricoStock,
            LinhaEncomenda, ListaEncomenda, FilaRevisao,
            EnriquecimentoFila, LoteIngestao, Utilizador, Farmacia?
   → SIM (per-tenant). Tem de migrar.

Lê/escreve apenas em Produto, RegulatoryRecord, InfarmedSnapshot,
            Classificacao, Fabricante, FabricanteAlias,
            EnrichmentSourceLog, ProdutoVerificacaoHistorico,
            RegulatoryAcquisitionJob?
   → NÃO (catálogo central — mas atenção: hoje o catálogo está REPLICADO em cada tenant DB,
       ver multi-tenant-db-strategy.md §2). Continua single-DB legacy ATÉ haver decisão de federar.

Toca em ambos?
   → Híbrido. Refactor para receber dois clients (catálogo + tenant). Raro.
```

### 5.6 Estratégia de migração sem partir scripts em uso

1. **Manter `legacyPrisma` como fallback** (já é a estratégia em [`lib/prisma.ts:57-61`](../lib/prisma.ts)). Sem deprecation warning ainda.
2. **Criar `lib/tenant-iter.ts`** com `forEachActiveTenant(callback, options)` (especificado em [`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §5 Fase A.1). É o "ponto único" que cada script novo importa.
3. **Migrar 1 script por vez**, começando pelo #1 (`import-excel.ts`). Validar com smoke contra `farmacia-teste` antes de prod.
4. **Adicionar arg `--tenant=<slug>`** opcional aos scripts. Sem flag: `legacyPrisma` (comportamento actual). Com flag: abre client via `buildTenantConnectionString`. Cron master sempre passa o slug.
5. **Após 6 meses** com todos os 10 críticos migrados, podemos remover `legacyPrisma` (mas só depois de o catálogo central também estar federado, o que não é objectivo desta fase).

---

## 6. B4 — Cost & Connection Budget

### 6.1 Tier reference (valores assumidos — A VERIFICAR antes de comprometer)

> **Atenção:** os valores abaixo foram extrapolados de [`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §7 e §8 e da estrutura geral de pricing Neon/Vercel. **Devem ser confirmados** nos pricing pages vigentes em 2026 antes de qualquer compromisso financeiro ou de arquitectura.

| Plano | Neon | Vercel |
|---|---|---|
| Free | 0.5 GB storage / 5 GB total · ~100 conexões via pooler · 1 project · 7d retention | Hobby: 100 GB-h fn · 10s maxDuration · 2 crons |
| Launch / Pro | $19/mês: ~10 GB · pooler ilimitado · retention 7d · multi-project | Pro $20/mês: 1000 GB-h · 60-300s maxDuration · ~40 crons (a confirmar) |
| Scale | $69/mês: ~50 GB · multi-region · branches · 30d retention | Pro inclui |
| Enterprise | custom | custom |

### 6.2 Connection budget — o recurso que esgota primeiro

**Confirmado** ([`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §3 L4): cada tenant abre o seu PrismaClient no registry ([`lib/tenant-registry.ts:113-129`](../lib/tenant-registry.ts)). Implicação de pool default Prisma (`connection_limit` = `num_physical_cpus * 2 + 1`, ≈10):

| Tenants | Pool por client | Pool total (sem PgBouncer) | Pool total (com Neon pooler transaction-mode) |
|---|---|---|---|
| 10 | 10 | 100 conexões | ~10 conexões efectivas no Postgres |
| 100 | 10 | 1 000 | ~50-100 |
| 1 000 | 10 | 10 000 → **esgota Neon** | ~200-500 |

**Conclusão:** **PgBouncer / Neon pooler é obrigatório** acima de ~50 tenants. A connection string vigente (host `*-pooler.*` — ver [`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §7) já o usa por defeito. Há que confirmar que **todos os tenants** são provisionados com host pooler (e não direct host).

**Alternativas a Neon pooler:**

| Opção | Pros | Contras |
|---|---|---|
| **Neon built-in pooler** (status quo) | zero-config, transaction-mode | sem visibilidade de pool stats |
| **Prisma Accelerate** | global edge, query cache, observabilidade | $$/mês adicional; vendor lock-in extra |
| **PgBouncer self-hosted** | controlo total | ops complexity; precisa de container externo |
| **Prisma Data Proxy** (legacy, descontinuado) | — | descontinuado pela Prisma — **não usar** |

**Recomendação:** ficar no Neon pooler até >200 tenants ou até precisarmos de query cache. Documentar a decisão.

### 6.3 Cenários de custo (mensal, em €/EUR — câmbio assumido 1 USD = 1 EUR para round-trip; **a recalcular** com câmbio real)

#### Cenário A: 10 tenants (piloto / early SaaS)

| Item | Custo | Notas |
|---|---|---|
| Neon — 10 tenant DBs no plan Launch shared | ~$19 | 1 project, 10 databases dentro. Storage <100MB cada. |
| Neon — control plane DB | $0 | partilha o mesmo plan |
| Vercel Pro | $20 | suficiente |
| Daemon container (Railway hobby) | $5-10 | opcional inicialmente — jobs longos podem viver no Mac do dev |
| **Total** | **~$44/mês (≈40 €)** | $4.40/tenant — break-even >$10 SaaS |

Connection budget: ≤100 conexões — folgado.

#### Cenário B: 100 tenants (early scale)

| Item | Custo | Notas |
|---|---|---|
| Neon — 100 tenant DBs no plan Scale | ~$69-150 | dependendo do split storage/compute. Storage ~1-2GB cada (extrapolação) = 100-200GB total. Pode requerer 2× Scale plans. |
| Neon — control plane | included | |
| Vercel Pro | $20 | crons cabem no limite |
| Vercel function executions | $0-20 | depende do tráfego — ainda dentro do Pro |
| Daemon container (Railway/Fly) | $10-20 | obrigatório (jobs longos × 100 tenants) |
| Monitoring (Sentry / equivalente) | $0-26 | dev plan free, recomendado |
| **Total** | **~$100-220/mês (90-200 €)** | $1-2/tenant — confortável >$10 SaaS |

Connection budget: 100 tenants × pool 10 = 1000 client connections → Neon pooler reduz para ~50-100 reais. **OK.**

#### Cenário C: 1000 tenants (scale target)

| Item | Custo | Notas |
|---|---|---|
| Neon — 1000 tenant DBs | $$$ — **negociar Business/Enterprise plan** | Sem visibilidade pública: assumir $500-2000/mês. |
| Vercel Enterprise | $500+/mês | Cron limit + maxDuration 900s + concurrency |
| Daemon containers (multi-region, redundância) | $50-200 | provavelmente migrar de Railway para Fly multi-region |
| Monitoring (Sentry / Datadog / equivalente) | $100-500 | obrigatório |
| Backups storage (snapshots Neon retention 30d) | $50-200 | varia |
| **Total** | **~$1500-3500/mês (1400-3300 €)** | $1.5-3.5/tenant — sustentável a $10+ SaaS |

Connection budget: **gargalo crítico**. 1000 tenants × 10 = 10 000 — bate no limite "Scale" public-tier. Mitigação:
1. Pooler agressivo (já implementado por default).
2. Reduzir `connection_limit` per-client de 10 → 3 (configurável via URL param `?connection_limit=3`). Sufficient para SaaS read-heavy.
3. Negociar Business/Enterprise plan.
4. Considerar sharding cross-region: tenants UE-PT → eu-west-2, internacionais → us-east-1.

### 6.4 Storage projection

Por tenant (extrapolação de [`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §8, **a validar com dados de piloto**):

| Idade tenant | Storage estimado |
|---|---|
| 0-30 dias | ~50 MB (catálogo seed + estrutura) |
| 6 meses | ~500 MB-1 GB |
| 12 meses | ~1-2 GB |
| 36 meses | ~3-5 GB |

Tabelas dominantes (`Venda`, `Compra`, `HistoricoStock`) crescem ~linearmente com nº de transacções diárias. Sem TTL definido — **considerar archival** após 5 anos (legislação fiscal PT exige 10 anos para vendas; estratégia: archive table com partition por ano + drop de partitions antigas).

### 6.5 Concurrency safety

| Risco | Como surge | Mitigação |
|---|---|---|
| 2 cron runs do mesmo job no mesmo tenant ao mesmo tempo | restart de daemon + cron Vercel a disparar em paralelo | `SyncRun` com `UNIQUE(source, idempotencyKey)` — o segundo run vê o primeiro `RUNNING` e aborta (§4.3) |
| Race em writes ao mesmo Produto (enrichment paralelo) | dois workers a tocar o mesmo CNP | Já mitigado: claim via `EnriquecimentoFila` com `FOR UPDATE SKIP LOCKED` (padrão visível em [`scripts/workers/regulatory-acquisition-worker.ts`](../scripts/workers/regulatory-acquisition-worker.ts)) |
| Cron Vercel a tentar processar tenant a meio de migração | tenant `estado=PROVISIONING` | `forEachActiveTenant` filtra `estado=ACTIVE` apenas — já é o padrão em `health-check-tenants.ts` |
| Outbox: agent A e agent B a fazerem claim simultâneo | dois agents de uma farmácia (improvável mas possível) | Lease `leasedUntil` em [`prisma/schema.prisma:1147`](../prisma/schema.prisma) + state transitions atómicas |
| Connection pool exhaustion durante cron master | 100 tenants × cliente Prisma com pool 10 = 1000 conexões abertas em rajada | Limitar paralelismo no `forEachActiveTenant` (default proposto: concurrency=10); reduzir `connection_limit` na URL para 3 |

---

## 7. Roadmap faseado

### Fase 1 — Ledger e iteração tenant-aware (5-7 dias)

**Objectivo:** ganhar observabilidade e capacidade de iterar tenants sem mexer em cron.

| Tarefa | Esforço | Dependências | Outputs |
|---|---|---|---|
| 1.1 Migration aditiva: `SyncRun` table em `prisma/schema.prisma` | 0.5d | nenhuma | migration `add_sync_run.sql` (não aplicar ainda) |
| 1.2 `lib/sync-run.ts` — wrapper `runSync({source, idempotencyKey, ...})` | 1d | 1.1 | helper API |
| 1.3 `lib/tenant-iter.ts` — `forEachActiveTenant(cb, opts)` | 1d | nenhuma | helper API |
| 1.4 Refactor `scripts/jobs/daily-enrich.ts` para aceitar `--tenant=<slug>` e usar `runSync` | 1d | 1.2 | script pronto para cron |
| 1.5 Idem para `scripts/jobs/weekly-reverify.ts` | 0.5d | idem | |
| 1.6 Smoke test num tenant de teste (provision → daily-enrich) | 1d | 1.4 | confidence go/no-go |
| 1.7 Documentar pattern em `notes/sync-run-pattern.md` | 0.5d | tudo acima | doc operacional |

**Saída da fase:** capacidade de correr "daily-enrich em todos os tenants" via CLI (sem cron) com ledger completo.

### Fase 2 — Scheduler real e endpoints cron (3-5 dias)

**Objectivo:** automatização.

| Tarefa | Esforço | Dependências | Outputs |
|---|---|---|---|
| 2.1 `vercel.json` — definir 5 schedules iniciais (#1, #5, #6, #11, #12 da tabela §3.3) | 0.5d | Fase 1 | config |
| 2.2 `app/api/cron/tenant-health/route.ts` — invoca `forEachActiveTenant` + ping | 0.5d | 2.1 | endpoint |
| 2.3 `app/api/cron/regulatory-acquisition/route.ts` — chama lógica do worker stateless | 0.5d | 2.1 | endpoint |
| 2.4 `app/api/cron/outbox-release-stale/route.ts` — limpa leases expiradas | 0.5d | 2.1 | endpoint |
| 2.5 Daemon externo: Dockerfile + entry `scripts/cron/daily.ts` que invoca jobs longos | 1d | Fase 1 | container deployable |
| 2.6 Deploy daemon em Railway/Fly piloto | 1d | 2.5 | URL + cron OS configurado |
| 2.7 Verify: aguardar 24h e confirmar `SyncRun` populado | 1d | 2.6 | confidence |

**Saída da fase:** SaaS funciona sem intervenção humana diária.

### Fase 3 — Backups, dashboards, cost visibility (5-7 dias)

**Objectivo:** preparar onboarding de tenants reais.

| Tarefa | Esforço | Dependências | Outputs |
|---|---|---|---|
| 3.1 `scripts/tenancy/snapshot-all-tenants.ts` — chama Neon API per tenant | 1d | Fase 1 | script |
| 3.2 `app/api/cron/snapshot-tenants/route.ts` — schedule diário | 0.5d | 3.1 | endpoint |
| 3.3 `scripts/tenancy/verify-restore.ts` — quarterly check (1 tenant random, restore para temp DB, smoke) | 2d | 3.1 | script |
| 3.4 Página admin `/admin/sync-health` — UI sobre `SyncRun` | 1d | Fase 1 | UI |
| 3.5 Página admin `/admin/tenant-costs` — Neon usage API per tenant | 1.5d | nenhuma | UI |
| 3.6 Documentar runbook `notes/runbook-incidentes.md` (cron parado, tenant down, restore) | 1d | tudo acima | doc |

**Saída da fase:** ops humanos têm visibilidade e podem responder a incidentes sem leitura de logs raw.

### Total: ≈3 semanas focadas. Cada fase é entregável independente — pode-se parar entre fases sem regressão.

---

## 8. Risk register

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | Limites Vercel Cron (assumidos 40 schedules, 300s maxDuration) revelarem-se mais apertados em 2026 | **média** | médio (força mais carga para daemon externo) | Confirmar nos docs **antes** de Fase 2.1. Plano B: tudo em daemon externo (mais complexidade ops mas zero lock-in Vercel). |
| R2 | Connection pool exhaustion com >100 tenants | média | alto (DB indisponível) | (i) Verificar host pooler em todos os tenants (audit `Tenant.dbHost LIKE '%pooler%'`); (ii) `connection_limit=3` nas URLs do registry; (iii) limitar `concurrency` em `forEachActiveTenant` (default 10). |
| R3 | `SyncRun` cresce sem bound (1 row × execução × tenant × ano) | média | médio (storage no tenant DB) | TTL 90 dias para rows status=SUCCESS via job de cleanup; keep todas SUCCESS<7d + todas FAILED indef.; documentar como tarefa Fase 3.x. |
| R4 | Migração de scripts (top 10) parte runs manuais já em uso | média | alto (catalogue degrade) | Estratégia incremental §5.6: `legacyPrisma` fallback mantido; cada script aceita `--tenant=` opcional; smoke contra `farmacia-teste` antes de prod. |
| R5 | Daemon externo (Railway/Fly) cai e ninguém repara durante 48h | média | alto (catalog enrichment para de correr) | (i) Heartbeat semelhante ao agent (`Tenant.lastAgentHeartbeatAt`); (ii) endpoint `/api/cron/check-daemon-alive` no Vercel que alerta se sem heartbeat >2h; (iii) UI `/admin/sync-health` torna visível ao operador. |

Riscos secundários (probabilidade baixa, mas registados):
- **R6**: custo Neon explode acima da projecção §6.3 — mitigação: piloto com 3-5 tenants reais para medir antes de scale.
- **R7**: cron-master-style (1 schedule itera N tenants) tem 1 falha tenant a contagiar os outros — mitigação: `onError: "continue"` por defeito no `forEachActiveTenant`.
- **R8**: snapshots Neon explícitos duplicam custo — mitigação: confiar em PITR built-in até 50 tenants, snapshots explícitos só >50.

---

## 9. Não-objectivos desta fase

- Não migrar tudo — só os 10 críticos.
- Não introduzir Prometheus / Datadog — observabilidade é JSONL + `SyncRun` table.
- Não rescrever workers contínuos como serverless — mantém-se daemon.
- Não decidir billing/Stripe — fora do âmbito ([`multi-tenant-db-strategy.md`](./multi-tenant-db-strategy.md) §9.5).
- Não tocar pipeline INFOMED ([`infomed-pipeline-final-report.md`](./infomed-pipeline-final-report.md)) — ficou estável, só ganha SyncRun rows quando re-executado.
- Não desenhar UI admin completa — só os 2 dashboards minimos `/admin/sync-health` e `/admin/tenant-costs`.

---

## 10. Decisões pendentes

1. **Aprovar Fase 1** (5-7 dias, sem qualquer impacto em produção)?
2. **Vercel Pro vs daemon externo Railway/Fly** — preferência declarada para Fase 2? (Recomendo híbrido.)
3. **Catálogo central vs federar para cada tenant DB** — decisão estratégica que afecta §5. Hoje está replicado, o que evita federação prematura mas força N× custo.
4. **Quando começar onboarding de tenants reais** — Fase 3 é pré-requisito ou aceitável onboardar com backups manuais inicialmente?
5. **Pricing target SaaS** — define a folga económica para os cenários §6.3.

---

_Análise read-only. Sem migrations, sem scheduler real, sem cloud calls. Os números de Neon/Vercel pricing 2026 estão marcados como "a verificar" — não comprometer custo sem confirmação._
