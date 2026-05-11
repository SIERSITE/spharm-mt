# Infra Strategy — Operational Decision

**Data:** 2026-05-11 · **Estado:** Decisão recomendada para RC

## Recomendação executiva

**Neon (managed Postgres)** + DB-per-tenant dentro de **1 projecto Neon partilhado**.

| Decisão | Valor |
|---|---|
| Provider | **Neon** |
| Tenant isolation | DB-per-tenant (1 projecto Neon, N databases) |
| Backups | Neon point-in-time recovery (7 dias free / 30 dias pago) |
| Pooling | Neon pooler (já configurado via `PrismaPg`) |
| Estimativa custo (≤10 tenants pequenos) | **0–25 €/mês** (Free + Launch) |
| Tempo provisioning novo tenant | **<30s** (script idempotente já existe) |

Esta é a opção **mais pragmática** dado:
- O projecto já corre `DATABASE_URL` em Neon
- Operacionalmente menos coisas para gerir (1 provider)
- Permite multi-tenant real sem self-hosting
- Permite scale-up gradual sem migração de provider

---

## Comparação de opções

### Neon (recomendado)

**Pros:**
- Postgres puro, sem proprietary (compatível com Prisma sem hacks)
- Branches/snapshots gratuitos — bom para dev e recovery
- Auto-suspend de DBs idle (poupança em tenants pouco activos)
- Free tier generoso: 500 MB armazenamento, branches ilimitados
- Pricing previsível (storage + compute hours)
- Suporta `CREATE DATABASE` via role com privilégios adequados → o nosso `provision-tenant.ts` funciona out-of-the-box

**Contras:**
- Cold-start (~1s) em DBs auto-suspendidas — mitigado pelo Vercel Cron que mantém quente
- Limit de 10 databases no free tier (Pro: 50; Scale: ilimitado)
- Region-locked por projecto (mas Neon tem eu-central já disponível)

**Pricing real (2026):**
- Free: 0,5 GB storage, 191 compute hours/mês, 10 branches
- Launch (€19/mês): 10 GB, 300 ch/mês, projects-ilimitados
- Scale (€69/mês): 50 GB, 1000 ch/mês, RBAC

Para **10 tenants pequenos (cada ~50 MB stock+vendas) ≈ 500 MB total**, fica no Free ou Launch. Para 20+ tenants ou volumes maiores, Scale.

### Supabase (alternativa)

**Pros:**
- Postgres + auth + storage + realtime num só painel
- Edge functions e PostgREST grátis

**Contras:**
- Não tem o conceito "1 projecto = N databases independentes" sem hacks (cada projecto Supabase tem 1 DB principal)
- Para multi-tenant DB-per-tenant precisas de 1 Supabase project por tenant ($25/mo cada após free) → 10 tenants = $250+/mês
- Ou usar schema-per-tenant numa única DB (não bate com o nosso modelo `Tenant.dbName`)
- Mais lock-in: features extra (auth, storage) criam dependência

**Veredicto:** mais caro e operacionalmente mais complexo para o modelo DB-per-tenant que já temos.

### Self-hosted (Postgres em VM)

**Pros:**
- Controle total
- Custo previsível por VM

**Contras:**
- Tu fazes backups, point-in-time recovery, monitoring, failover
- Tu fazes patches, upgrades, security
- Tu fazes pooler (PgBouncer / pgpool)
- Tu fazes HA se quiseres multi-AZ
- Custo "humano" alto

**Veredicto:** só faz sentido com volume real (>50 tenants ou regulatório forte que exige soberania de dados). Não justificado para RC piloto.

---

## Arquitectura recomendada

```
                    ┌────────────────────────┐
                    │  Neon Project (eu-central) │
                    │  Single shared project       │
                    └────────────────────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
  ┌─────────┐           ┌──────────┐         ┌──────────┐
  │ spharmmt│           │  tenant_ │         │  tenant_ │
  │ _control│           │   braga  │         │   porto  │
  │   DB    │           │    DB    │         │    DB    │
  └─────────┘           └──────────┘         └──────────┘
       ▲                      ▲                      ▲
       │                      │                      │
       └─ CONTROL_DATABASE_URL  └─ provisionada via ../scripts/tenancy/provision-tenant.ts
```

### Vantagens deste layout

1. **1 projecto Neon = 1 facturação** — pricing previsível.
2. **DBs físicas isoladas** — um bug numa BD não afecta outras. Tenant CRUD ao nível Postgres CREATE DATABASE / DROP DATABASE.
3. **Branches Neon disponíveis por DB** — recovery point-in-time independente por tenant.
4. **Compute pooler partilhado** — não pagamos compute por tenant.
5. **Encryption-at-rest** automática Neon.
6. **Backups automáticos** Neon (PITR window configurável).

---

## Provisionamento concreto

### Setup inicial (uma vez)

```bash
# 1. Criar projecto Neon (via dashboard)
#    Region: eu-central-1 (Frankfurt)
#    Nome: spharmmt-rc

# 2. No projecto, criar 1 role admin
#    Nome: spharmmt_admin
#    Permissões: CREATEDB, CREATEROLE
#    Anotar password

# 3. Criar a primeira DB (control plane)
#    Via dashboard ou:
#    psql "<admin url>" -c 'CREATE DATABASE spharmmt_control;'

# 4. Configurar .env (ou Vercel env):
DATABASE_URL=postgres://spharmmt_admin:<pw>@ep-xxx-pooler.eu-central-1.aws.neon.tech/spharmmt_control?sslmode=require
CONTROL_DATABASE_URL=postgres://spharmmt_admin:<pw>@ep-xxx-pooler.eu-central-1.aws.neon.tech/spharmmt_control?sslmode=require
TENANT_DB_HOST=ep-xxx-pooler.eu-central-1.aws.neon.tech
TENANT_DB_PORT=5432
POSTGRES_ADMIN_URL=postgres://spharmmt_admin:<pw>@ep-xxx-pooler.eu-central-1.aws.neon.tech/postgres?sslmode=require
TENANT_ENCRYPTION_SECRET=<openssl rand -hex 32>
AUTH_SECRET=<openssl rand -base64 32>
CRON_SECRET=<openssl rand -hex 24>
PLATFORM_ADMIN_EMAILS=admin@spharm.mt

# 5. Aplicar schema no control plane
npx tsx scripts/control/migrate-deploy.ts

# 6. Validar
npm run env:doctor          # Todos os scopes ready
npm run tenancy:smoke-resolver
```

### Onboarding novo tenant (uma vez por grupo)

```bash
npm run tenant:onboard -- \
  --slug farmacias-braga \
  --nome "Grupo Farmácias de Braga" \
  --admin-email admin@braga.pt
```

Demora **<30s**. O script:
1. Conecta ao Postgres admin
2. `CREATE ROLE tenant_farmacias_braga LOGIN PASSWORD <random>`
3. `CREATE DATABASE tenant_farmacias_braga OWNER tenant_farmacias_braga`
4. `prisma migrate deploy` contra a nova DB
5. Cria utilizador admin com bcrypt hash
6. Cria record `Tenant` no control plane (state=ACTIVE)
7. Corre smoke test resolver
8. Imprime checklist dos 6 passos manuais restantes (ver `notes/tenant-onboarding.md`)

### Backups / restore

**Neon point-in-time recovery (PITR):**
- Free: 7 dias de retenção
- Launch+: 30 dias
- Restore via branch: `neon branch create --parent main --timestamp "2026-05-10 14:00"`
- Cost: zero adicional (incluído no plano)

**Para Tenant.lastBackupAt:**
- Manual no início — operador valida que Neon retém ≥7 dias
- Futuro: cron diário verifica existência de branch backup; actualiza `lastBackupAt` automaticamente

### Limites realistas

| Limite | Valor | Bloqueio em |
|---|---|---|
| DBs por projecto Neon | 10 free / 50 pro / unlimited scale | Free é OK até 9 tenants (1 é control) |
| Connections simultâneas (pooler) | ~10000 | Não atingível com <100 tenants |
| Compute hours mês | 191 free / 300+ pro | Suficiente para apps web normais |
| Storage por DB | sem limite hard; pago por GB-mês | Tenants pequenos <100 MB cada |

**Realistic suporte hoje (com config Free):** **5–8 tenants em produção comfortavelmente.** Para >10 → upgrade Launch (€19/mês).

---

## Mitigação de riscos operacionais

| Risco | Mitigação |
|---|---|
| Neon outage prolongado | Branches PITR garantem recovery; SLA pago: 99.9% |
| Vendor lock-in | É Postgres puro; pg_dump funciona; migrar para outro Postgres é straightforward |
| Cold-start mata UX | Vercel Cron mantém quente; user-facing pages usam `getPrisma()` cached |
| Compute hours esgota | Auto-suspend de tenants idle compensa; monitor via dashboard Neon |
| Custos imprevisíveis | Neon pricing é tier-based, sem surprise billing |

---

## Decisão pragmática

Para o RC:

1. **Adoptar Neon (projecto único partilhado)** já hoje.
2. **DB-per-tenant** como já planeado — provision script funciona.
3. **Free tier** até primeiros 5 tenants em piloto.
4. **Upgrade Launch (€19/mês)** quando atingir 6+ tenants ou >300 MB.
5. **Scale (€69/mês)** quando >20 tenants ou load consistente.

Não vamos provisionar mais do que isto. Sem theatre.
