# Multi-Tenant DB Strategy — Estado Actual + Plano

**Data:** 2026-05-11
**Fase:** análise apenas (zero migrations, zero criação de DBs, zero alterações em produção)
**Scope:** auditar tenant-registry, getPrisma, isolamento, estratégia DB-per-tenant
vs schema-per-tenant, impacto em scripts/workers/cron/backups, Neon/Vercel
constraints, onboarding, custos.

## 1. Resumo executivo

SPharm.MT **já implementou DB-per-tenant**. O modelo actual é **híbrido**:
- **Isolamento físico:** cada tenant tem a sua base PostgreSQL Neon (`spharmmt_t_<slug>`)
- **Catálogo replicado dentro de cada tenant DB:** tabelas globais (Produto,
  RegulatoryRecord, Classificacao, Fabricante) coexistem com tabelas
  per-farmácia (Venda, ProdutoFarmacia, etc.) na mesma DB do tenant
- **Control plane** (`CONTROL_DATABASE_URL`) em DB separada com Tenant +
  TenantEvent + GlobalAdmin
- **Resolution:** subdomain → middleware edge → header `x-tenant-slug` →
  `getPrisma()` cached per-tenant

**O que está bem:** runtime web é tenant-aware (`getPrisma()`), scripts de
provisão/health/migração já existem, encriptação AES-256-GCM das credenciais,
JWT bindado a tenant. **O que falta:** jobs/workers (`legacyPrisma`) não
iteram tenants, sem cron Vercel, backups não automatizados, sem
documentação operacional de custo per-tenant.

## 2. Estado actual mapeado

### Arquitectura

```
Browser (subdomain: farmacia-X.spharmmt.app)
  ↓
middleware.ts (edge)        ← extrai slug do subdomain
  ↓ injecta header x-tenant-slug
  ↓
app/* (server components, actions, API routes)
  ↓ getPrisma() async
  ↓
lib/tenant-context.ts       ← lê header
  ↓
lib/tenant-registry.ts      ← Map<slug, PrismaClient> cache, lazy warm-up
  ↓ lookup
PostgreSQL Neon (DB do tenant)
  · catálogo replicado (Produto, RegulatoryRecord)
  · dados per-farmácia (Venda, ProdutoFarmacia)

CONTROL_DATABASE_URL (DB separada)
  · Tenant table (slug, dbHost, dbPassEncrypted, estado, schemaVersion, ...)
  · TenantEvent (audit imutável)
  · GlobalAdmin (preparado para Fase 2)
```

### Componentes confirmados (paths reais)

| Componente | Path | Função |
|---|---|---|
| Registry | [lib/tenant-registry.ts](../lib/tenant-registry.ts) | Cache `Map<slug, PrismaClient>`, lazy warm-up, fallback to legacy |
| Context resolver | [lib/tenant-context.ts](../lib/tenant-context.ts) | `resolveCurrentTenantSlug()` lê header `x-tenant-slug` |
| Prisma client | [lib/prisma.ts](../lib/prisma.ts) | `getPrisma()` async (runtime) + `legacyPrisma` (scripts) |
| Control plane | [lib/control-plane.ts](../lib/control-plane.ts) | `controlPrisma`, `getTenantBySlug`, `buildTenantConnectionString` |
| Tenant crypto | [lib/tenant-crypto.ts](../lib/tenant-crypto.ts) | AES-256-GCM para `dbPassEncrypted` |
| Middleware | [middleware.ts](../middleware.ts) | subdomain → header injection (edge) |
| Auth | [lib/auth.ts](../lib/auth.ts) | JWT claim `tenant` validation |
| Integration auth | [lib/integracao/auth.ts](../lib/integracao/auth.ts) | Bearer API key (agent Windows) |
| Scripts tenancy | [scripts/tenancy/](../scripts/tenancy/) | provision, list, migrate-all, health, deactivate, reactivate, smoke-resolver |
| Scripts control | [scripts/control/](../scripts/control/) | migrate-deploy, generate (control plane schema) |
| Control schema | [prisma-control/schema.prisma](../prisma-control/schema.prisma) | Tenant, TenantEvent, GlobalAdmin |

### Estratégia adoptada: DB-per-Tenant

**Não é schema-per-tenant** — cada tenant tem **role + database PostgreSQL
distintos**. Isto significa:

| Aspecto | DB-per-Tenant (actual) | Schema-per-tenant | Shared DB scoping |
|---|---|---|---|
| Isolamento dados | físico (separate DB) | lógico (separate schema, mesma DB) | aplicacional (FK farmaciaId) |
| Restore granular | ✅ trivial | ⚠ manual | ❌ inviável |
| Connection limit | linear no nº de tenants | 1 connection serve N tenants | 1 connection global |
| Backup individual | ✅ Neon snapshot per DB | ⚠ pg_dump por schema | ❌ — |
| Custo Neon | linear no nº de tenants | 1 DB | 1 DB |
| Cross-tenant queries | ❌ inviável | ✅ JOIN entre schemas | ✅ JOIN com WHERE farmaciaId |
| Cross-farmácia analytics (dentro do tenant) | ✅ via `farmaciaId` FK | ✅ idem | ✅ |

**Por que DB-per-tenant foi escolhido:** isolation garantido (LGPD/RGPD para
dados de saúde), restore granular se uma farmácia tiver corruption, e
**unhappy-path por tenant** (uma DB partir não afecta outras). Trade-off:
custo Neon linear com nº de tenants.

## 3. Lacunas identificadas

### L1. Scripts/jobs/workers não são tenant-aware

Todos os scripts em `scripts/` usam `legacyPrisma` (singleton ligado a
`DATABASE_URL`). Implicação:

- `scripts/jobs/daily-enrich.ts` corre contra UMA DB (legacy ou tenant default)
- `scripts/workers/enrichment-worker.ts` idem
- `scripts/import-excel.ts` idem
- Pipeline INFOMED (browse, fetch-details, import, sync, reprocess) idem

**Para multi-tenant real:** estes scripts precisam de **iterar tenants ACTIVE**:
1. Buscar lista de tenants do control plane
2. Para cada um, abrir client via `buildTenantConnectionString`
3. Executar o trabalho
4. Logar resultado por tenant em TenantEvent ou SyncRun

Hoje **não há helper para isto** — cada script teria de re-implementar a
iteração. Padrão `iterateActiveTenants(callback)` seria útil em
`lib/tenant-iter.ts` (não existe).

### L2. Sem cron/scheduler

`vercel.json` não existe. Workers (`enrichment-worker.ts`,
`regulatory-acquisition-worker.ts`) são long-running rodáveis manualmente.

Para SaaS multi-tenant, há 3 opções de scheduler:
- **Vercel Cron** (limitação: max 24 schedules no plan Pro; serverless)
- **GitHub Actions cron** (gratuito, mas exige secret config + connection do agent)
- **Daemon container** (próprio host com cron OS-level + um worker que itera tenants)

Cadências expectáveis quando multi-tenant amadurece:
- ERP import: trigger-on-upload (webhook) — n/a para cron
- INFOMED browse: mensal (1× DB compartilhada, depois replicar para tenants)
- daily-enrich: diário POR TENANT
- weekly-reverify: semanal POR TENANT
- health-check: cada 5min POR TENANT
- backup verify: diário POR TENANT

### L3. Backups não automatizados

`Tenant.lastBackupAt` existe mas nenhum script o populates. Estratégia
recomendada:

- **Neon PITR** (Point-In-Time Recovery): activado por default, retention
  depende do plan
- **Snapshot semanal explícito** por tenant via API Neon (script seria
  `scripts/tenancy/snapshot-all-tenants.ts`)
- **Verificar restore** trimestralmente (script seria
  `scripts/tenancy/verify-restore.ts` — provisiona DB temporária a partir
  de snapshot, valida, descarta)

Hoje **nada disto está implementado** — risco operacional médio se um
tenant tiver corruption.

### L4. Sem rate-limit nem connection budgeting

Cada tenant abre o seu PrismaClient (Map cached). Neon pooler tem limite
de conexões por plan:
- Free: ~100 conexões
- Pro/Scale: ~10000 conexões

Com 50 tenants × 10 conexões/PrismaClient = 500 conexões — viável.
Com 500 tenants × 10 = 5000 — close to limit, precisamos pooler.

**Não há observabilidade** de quantas conexões cada tenant está a usar nem
alerts quando aproxima do limit.

### L5. Iteração over-tenants não tem pattern

Para jobs batch (e.g., "rodar daily-enrich em todos os tenants"), faltam:
- Helper `forEachActiveTenant(callback, options)` com options para
  paralelismo, retry, error handling
- Tracking per-tenant de "última execução com sucesso"
- Capacidade de pausar/retomar (se 3 tenants falham, não correr 4-X)

### L6. Sem visibilidade per-tenant custo / utilização

Métricas faltantes:
- Storage por tenant (Neon API)
- Compute hours por tenant
- Rows count em tabelas chave por tenant
- Estimated monthly cost por tenant

Sem isto, **pricing por farmácia/grupo é cego**.

## 4. Onboarding de nova farmácia — fluxo actual

[scripts/tenancy/provision-tenant.ts](../scripts/tenancy/provision-tenant.ts)
faz:

1. Valida slug (regex `^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$`)
2. Confirma slug livre em control plane
3. Gera credenciais: `dbUser = spharmmt_<slug>`, dbPassword random 24B base64url, `dbName = spharmmt_t_<slug>`
4. **CREATE ROLE** + **CREATE DATABASE** + **GRANT CONNECT** via `POSTGRES_ADMIN_URL`
5. Insere `Tenant(estado=PROVISIONING)` no control plane
6. `prisma migrate deploy` contra nova DB
7. Seed: cria 1 `Utilizador ADMINISTRADOR` com `mustChangePassword=true`
8. Marca `Tenant(estado=ACTIVE)`
9. Audit log `created`
10. Imprime admin password UMA VEZ

**Rollback:** se passos 4-5 falham → DROP DB, DROP ROLE; se passos 6-8 →
tenant fica `FAILED` para debug manual.

**Lacunas no onboarding:**
- Falta passo de "seed catálogo inicial" (Produto/Fabricante/Classificacao
  vão começar vazios) — tenant não tem dados até primeiro import
- Falta integração com Stripe/billing — provision é técnico, não comercial
- Falta notification ao admin do tenant (email com instruções)
- Falta health-check pós-provision (smoke test que valida que tenant está
  realmente operacional, não só "created OK")

## 5. Estratégia recomendada (em fases, NÃO executar)

### Fase A — Helpers tenant-aware (3-5 dias)

A.1. **`lib/tenant-iter.ts`** — utility com:
```ts
forEachActiveTenant<T>(
  callback: (ctx: { tenant: TenantRecord; prisma: PrismaClient }) => Promise<T>,
  options: { concurrency?: number; onError?: "continue" | "halt"; logTo?: "console" | "TenantEvent" }
): Promise<{ ok: number; failed: number; results: Array<{slug, result?, error?}> }>
```

A.2. **Reescrever 3 scripts críticos** para usar `forEachActiveTenant`:
- `scripts/jobs/daily-enrich.ts` — itera tenants ACTIVE
- `scripts/workers/enrichment-worker.ts` — claim jobs cross-tenant
- Pipeline INFOMED — actualmente single-tenant; estratégia: dataset INFOMED
  é GLOBAL (mesmos medicamentos para todos), logo browse+fetch corre 1×
  na DB central; **sync+reprocess corre por tenant**

A.3. **Tabela `SyncRun`** (mencionada em data-sync-architecture.md) —
adicionar `tenantSlug` para tracking per-tenant

### Fase B — Cron e observabilidade (3-5 dias)

B.1. **Adoptar Vercel Cron** se SaaS, ou **daemon dedicated**:
- `0 2 * * *` → `npx tsx scripts/cron/daily-cron.ts` que executa
  `forEachActiveTenant(runDailyEnrich)`
- `0 3 * * 0` → weekly-reverify cross-tenant

B.2. **Endpoint `/api/admin/tenant-health`** (admin global):
- Lista tenants com `lastHealthCheckAt` desfasado > 1h
- Mostra connection count, storage, error rate por tenant

B.3. **Métricas custo:**
- Job mensal que regista Neon usage por DB (script `scripts/admin/snapshot-tenant-costs.ts`)
- Output em `TenantUsageMonthly` table (NOVA opcional)

### Fase C — Backups e restore (5-7 dias)

C.1. **Snapshots periódicos:**
- `scripts/tenancy/snapshot-all-tenants.ts` — chama Neon API, regista
  `Tenant.lastBackupAt`
- Cadência: diário + retenção 30 dias (Pro plan)

C.2. **Restore script:**
- `scripts/tenancy/restore-tenant.ts <slug> <snapshot-id>`
- Cria DB temporária a partir do snapshot, valida, swap atomic (ou pinned-name)
- Audit em `TenantEvent`

C.3. **Verify-restore quarterly:**
- Job trimestral pega 1 tenant random, restora para DB temp, executa
  smoke tests, descarta. Alerta se falha.

### Fase D — Onboarding melhorado (3-5 dias)

D.1. **`scripts/tenancy/seed-catalog-from-source.ts`** — copia Produto +
RegulatoryRecord da DB legacy/central para nova DB do tenant

D.2. **Webhook pós-provision** — envia email ao admin com instruções

D.3. **Smoke test integrado** — provision termina apenas se smoke passes

D.4. **Integração billing** (Stripe) — opcional, fica para quando go-to-market
estiver definido

## 6. Tabelas afectadas pelo plano

**Sem migrations destrutivas em qualquer fase.**

| Tabela | Fase A | Fase B | Fase C | Fase D |
|---|---|---|---|---|
| `Tenant` (control plane) | leitura | + métricas opcional | + `lastSnapshotId` opcional | inalterada |
| `TenantEvent` (control plane) | escritas via helper | leituras | escritas (snapshot, restore) | escritas |
| `SyncRun` (NOVA, ver data-sync-architecture.md) | + `tenantSlug` | usado | usado | usado |
| `TenantUsageMonthly` (NOVA opcional) | — | NOVA (Fase B.3) | — | — |
| Catálogo (Produto, RR, etc.) | leitura ou idêntica por tenant | — | — | seed em onboarding |
| Per-farmácia (Venda, ProdutoFarmacia) | inalteradas | — | — | — |

## 7. Neon / Vercel constraints

**Neon:**
- Plan Free: 3 projetos, ~100 conexões, 5GB storage total → **insuficiente** para multi-tenant a sério
- Plan Pro/Scale: 100+ projetos, 10k+ conexões, storage scalable → **adequado**
- **Branches:** Neon suporta branches por DB — útil para staging
- **Pooler:** activado por default no URL (`pooler.eu-west-2.aws.neon.tech`) → recomendado
- **Connection string per tenant** já encriptada em control plane

**Vercel:**
- Functions serverless → cold starts; sem persistent connections (Prisma cria connections per invocation)
- **Vercel Postgres**: alternativa a Neon, mas mais cara e menos flexível
- **Cron jobs** limitados no plan Pro (24 schedules)
- **Edge middleware** OK (ex.: actual middleware.ts)
- **Function timeout:** 60s no Hobby, 300s no Pro, 900s no Enterprise — backups longos podem precisar de worker container externo

**Workers daemons (alternativa):**
- Container num cloud provider (Railway, Fly.io, Render)
- Mantém persistent state, conexões de longo prazo
- Custo extra mas necessário para iteração lenta cross-tenant

## 8. Custo operacional — estimativa preliminar

**Por tenant (Neon Pro plan, ~5€/mês/DB estimado):**
- Storage: ~50 MB inicial → 1-2 GB depois de 1 ano de operação (vendas+stock)
- Compute: ~0.05 vCPU/h × utilização
- Custo Neon: ~3-8 €/mês/tenant em regime estacionário

**Fixed overhead:**
- Control DB: ~5 €/mês
- Workers daemon (se adoptado): ~10 €/mês (Railway hobby)
- Vercel Pro: 20 €/mês

**Break-even point:**
- 10 tenants: ~80 €/mês ÷ 10 = 8 €/tenant
- 100 tenants: ~600 €/mês ÷ 100 = 6 €/tenant
- 1000 tenants: ~5000 €/mês ÷ 1000 = 5 €/tenant

**Decisão de pricing:** se a oferta SaaS é ≥ 30 €/mês/farmácia, margem
saudável a partir de ~5 tenants. Se ≤ 15 €/mês, precisa de 20+ tenants
para break-even.

**Caveat:** estes números são extrapolações sem dados reais. Antes de
definir pricing, recomendado um piloto com 3-5 tenants para medir
storage/compute reais.

## 9. Decisões pendentes

1. **Migrar jobs/workers para tenant-aware** (Fase A) — quando começar?
2. **Cron platform** — Vercel (lock-in mas integrado) ou daemon container
   (independente mas mais ops)?
3. **Backup strategy** — confiar em Neon PITR ou implementar snapshots
   explícitos?
4. **Seed catalog em onboarding** — replicar da DB central ou criar vazio
   e popular via imports/INFOMED?
5. **Billing integration** — necessário antes de release público; quando?
6. **Quantos tenants** se prevê no primeiro ano? Influencia escolha de plan
   Neon e arquitectura de cron.

## 10. Não-objectivos

- Sem migrations
- Sem criação de DBs reais (control nem tenant)
- Sem alterações em produção
- Sem integração com Stripe ou outros billing
- Sem touch no pipeline INFOMED em curso

## 11. Riscos transversais

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Migrar jobs para tenant-aware quebra runs existentes | média | manter `legacyPrisma` como fallback durante transição |
| Adopção de Vercel Cron limita escala (24 schedules max) | média | usar 1 schedule master que itera tenants |
| Backup explícito duplica custo Neon | baixa | Neon PITR já cobre 7d; snapshots explícitos só para auditing |
| Connection exhaustion com muitos tenants | média | adoptar pgbouncer / Neon pooler agressivo |
| Custo Neon explode > expectativa | média | piloto com 3-5 tenants e medição real antes de scale |
| Restauro de tenant tem corner cases | média | testar restore quarterly; documentar runbook |

---

_Análise read-only. Sem código, sem migrations, sem criação de DBs. Estado
actual está mais maduro que esperado — DB-per-tenant já está implementado.
Falta sobretudo: jobs tenant-aware, cron, backups automatizados._
