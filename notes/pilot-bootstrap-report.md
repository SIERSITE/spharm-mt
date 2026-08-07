# Pilot Bootstrap Report

**Data início:** 2026-05-12 · **Status:** TEMPLATE — preencher à medida que executas

Este documento serve dois propósitos:
1. **Pré-bootstrap (preenchido pelo Claude):** estado de pre-flight, comandos exactos, blockers conhecidos antes de tocar em infra real.
2. **Pós-bootstrap (preenchido por ti):** timings reais, atritos, problemas, fixes aplicados.

---

## 0. Pre-flight (state do código, automaticamente preenchido)

### 0.1 Estado actual das envs (`npm run env:doctor`)

```
[web] ❌ NOT ready
     · missing: CONTROL_DATABASE_URL
     · missing: TENANT_ENCRYPTION_SECRET

[cron] ❌ NOT ready
     · missing: CRON_SECRET

[cli] ❌ NOT ready
     · missing: CONTROL_DATABASE_URL
     · missing: TENANT_ENCRYPTION_SECRET
     · missing: TENANT_DB_HOST
     · missing: POSTGRES_ADMIN_URL

[ingest] ✅ ready (DATABASE_URL set)
```

**Envs já configuradas:** `DATABASE_URL`, `AUTH_SECRET`, `PLATFORM_ADMIN_EMAILS`.

**5 envs em falta** para todos os scopes ficarem ready. Lista executável em §1.2 abaixo.

### 0.2 Neon project actual

`DATABASE_URL` aponta para `ep-polished-lake-abw2ul5z-pooler.eu-west-2.aws.neon.tech/neondb`.
**Já tens um projecto Neon real em `eu-west-2`.** Recomendação: **reutilizar este projecto** para o control plane + tenant DBs em vez de criar um novo. Menos contas, mesma facturação, mais simples.

### 0.3 Componentes prontos (verificados por code-review)

| Componente | Caminho | Estado |
|---|---|---|
| Control plane schema (3 migrations) | `prisma-control/migrations/` | ✅ |
| `npm run control:migrate:deploy` | `scripts/control/migrate-deploy.ts` | ✅ |
| `npm run tenant:onboard` | `scripts/tenancy/onboard-tenant.ts` | ✅ (checklist actualizado) |
| `npm run tenancy:issue-ingest-key` | `scripts/tenancy/issue-ingest-key.ts` | ✅ |
| Ingest endpoints | `app/api/ingest/v1/{snapshot/*,farmacias}/route.ts` | ✅ |
| Agent CLI | `scripts/agent/ingest-folder.ts` | ✅ |
| IPF cron | `/api/jobs/refresh-ipf` + `vercel.json` | ✅ |
| Fixtures para 1º upload | `example_files/{stock_Atual,MapaEvolucaoVendas}.xlsx` | ✅ |

---

## 1. FASE 1 — Infra Real (a executar por ti)

### 1.1 Provisionar control DB + tenant DB(s) no Neon

No dashboard Neon (`https://console.neon.tech/`), projecto existente:

**Control plane:**
- Criar database `spharmmt_control` (via Neon UI ou `CREATE DATABASE spharmmt_control;`)

**Tenant piloto (Neon não suporta CREATE ROLE + SET ROLE para outros roles do projecto, por isso o script `--create-db` falha com `42501`):**
1. Cria database: ex `spharmmt_t_piloto_demo`
2. Cria role: ex `spharmmt_piloto_demo` + password (UI Neon)
3. Atribui essa role como OWNER do DB criado (UI Neon)
4. Copia a connection string completa (com `sslmode=require`) — vai passar ao script via `--database-url`

### 1.2 Popular `.env` (local) ou Vercel env (prod)

Adicionar ao `.env`:

```bash
# Já existem (não tocar)
DATABASE_URL="<existente, legacy>"
AUTH_SECRET="<existente>"
PLATFORM_ADMIN_EMAILS="<existente>"

# Novos — copiar e adaptar
CONTROL_DATABASE_URL="postgresql://<role>:<pw>@ep-polished-lake-abw2ul5z-pooler.eu-west-2.aws.neon.tech/spharmmt_control?sslmode=require&channel_binding=require"

# POSTGRES_ADMIN_URL e TENANT_DB_HOST só são necessários para o modo
# legacy --create-db (self-hosted Postgres). Em Neon usa-se --database-url
# e estes ficam opcionais. Deixa em branco se só vais usar Neon.
# POSTGRES_ADMIN_URL=""
# TENANT_DB_HOST=""

# Chave de cifra para Tenant.dbPassEncrypted.
# Gerar com: openssl rand -hex 32
TENANT_ENCRYPTION_SECRET="<64 hex chars>"

# Cron secret para /api/jobs/refresh-ipf.
# Gerar com: openssl rand -hex 24
CRON_SECRET="<48 hex chars>"
```

> **⚠️ TENANT_ENCRYPTION_SECRET:** uma vez gerado, **anotar em vault**.
> Perder esta chave = impossível recuperar as DBs tenant cifradas.

### 1.3 Validar

```bash
npm run env:doctor
```

**Esperado:** 4/4 scopes `✅ ready`. Não continuar até estar OK.

### 1.4 Aplicar schema do control plane

```bash
npm run control:migrate:deploy
```

**Esperado:** `All migrations have been applied`. As 3 migrations existentes (init, ingest-key-heartbeat, sync-run) ficam aplicadas.

### 1.5 Smoke do resolver

```bash
npm run tenancy:smoke-resolver
```

**Esperado:** todos os steps passam (legacy fallback funcional + listagem do control plane com 0 tenants ok).

### 1.6 Preencher (durante execução):

```
Tempo total Fase 1:       _____ min
Atritos:                  _____
Problemas:                _____
Fixes aplicados:          _____
```

---

## 2. FASE 2 — Tenant Piloto Real

### 2.1 Onboard (modo Neon `--database-url`)

Pré-requisito: DB+role já criados no Neon (§1.1) e URL completa anotada.

```bash
npm run tenant:onboard -- \
  --slug piloto-demo \
  --nome "Grupo Piloto Demo" \
  --admin-email admin@piloto.pt \
  --database-url "postgresql://spharmmt_piloto_demo:PW@HOST/spharmmt_t_piloto_demo?sslmode=require" \
  --farmacia-inicial "Farmácia Principal"
```

**Esperado:**
- `[1/2] Provisioning` → OK em <30s (testa conectividade + migra schema + seed admin + farmácia inicial)
- `[2/2] Smoke test` → OK em <5s
- Imprime admin password UMA VEZ (anotar)
- Imprime cuid da farmácia inicial (anotar)
- Imprime checklist de 7 passos pós-onboard

> Notas:
>  · O flag `--database-url` é o caminho primário para Neon. O alternativo `--create-db` só funciona em Postgres self-hosted com permissões de super-user (Neon partilhado bloqueia com `42501 must be able to SET ROLE`).
>  · O flag `--farmacia-inicial` foi adicionado durante a preparação do piloto. Sem ele o tenant fica sem farmácias e o primeiro upload falha com 404.
>  · Se um tenant ficar em `PROVISIONING`/`FAILED` (ex: erro de URL, network blip):
>    `npm run tenancy:cleanup-failed -- --slug piloto-demo` (dry-run)
>    `npm run tenancy:cleanup-failed -- --slug piloto-demo --confirm` (apaga)

### 2.2 Issue ingest key

```bash
npm run tenancy:issue-ingest-key -- --slug=<slug>
```

**Esperado:** Key em claro 64 chars hex impressa UMA VEZ.

### 2.3 Smoke heartbeat (valida key + slug)

```bash
curl -X POST \
  -H "Authorization: Bearer <key>" \
  -H "X-Tenant-Slug: <slug>" \
  http://localhost:3000/api/outbox/v1/heartbeat   # ou URL produção
```

**Esperado:** HTTP 200 `{ ok: true, serverTime, tenantSlug }`.

### 2.4 (Resolvido) Criar farmácia inicial

Resolvido por `--farmacia-inicial` em §2.1. Não é mais um passo manual.

Se precisares de adicionar mais farmácias ao tenant depois:

```sql
-- Via Neon SQL editor ou psql à DB do tenant
INSERT INTO "Farmacia" (id, nome, "dataCriacao", "dataAtualizacao", estado)
VALUES (
  'c' || lower(substr(md5(random()::text), 1, 24)),
  '<Nome da farmácia>',
  NOW(), NOW(), 'ATIVO'
);
```

> Backlog futuro: `npm run tenancy:add-farmacia -- --slug=<slug> --nome="<Nome>"`. ~15 min de scaffolding quando for necessário ter >1 farmácia por tenant em produção.

### 2.5 Preencher (durante execução):

```
Tempo onboard CLI:        _____ s
Tempo issue-key:          _____ s
Tempo criar farmácia:     _____ s (manual!)
Tempo TOTAL Fase 2:       _____ min

Falhas encontradas:
  - _____
Atritos operacionais:
  - _____
Passos manuais excessivos:
  - Criar farmácia inicial via SQL (registar como blocker)
  - _____
```

---

## 3. FASE 3 — Ingestão Real

### 3.1 Pré-condições

```bash
# Copiar fixtures para uma pasta de teste
mkdir -p /tmp/pilot-inbox
cp example_files/stock_Atual.xlsx /tmp/pilot-inbox/
cp example_files/MapaEvolucaoVendas.xlsx /tmp/pilot-inbox/
```

### 3.2 Upload primeiro

```bash
npm run agent:ingest-folder -- \
  --tenant=<slug> \
  --farmacia="Farmácia Principal" \
  --input=/tmp/pilot-inbox \
  --endpoint=http://localhost:3000 \
  --key=<key da §2.2> \
  --once
```

**Esperado:**
- Nome resolvido via `/api/ingest/v1/farmacias`
- Ambos ficheiros detectados, uploaded, status `processed`
- Movidos para `/tmp/pilot-inbox/processed/`
- JSONL em `/tmp/pilot-inbox/ingest-agent.log`

### 3.3 Validar dedup (segundo upload do mesmo ficheiro)

```bash
# Re-copiar os fixtures para o input
cp example_files/stock_Atual.xlsx /tmp/pilot-inbox/
cp example_files/MapaEvolucaoVendas.xlsx /tmp/pilot-inbox/
sleep 3   # esperar estabilidade mtime

npm run agent:ingest-folder -- ... --once
```

**Esperado:**
- Detectados, uploaded, **status `skipped_duplicate`**
- Movidos para `/tmp/pilot-inbox/processed/duplicates/`
- HTTP 200 com `loteIngestaoId` apontando ao lote anterior

### 3.4 Validar retry (forçar uma falha + retry)

```bash
# Forçar falha: usar key inválida no upload
npm run agent:ingest-folder -- ... --key=INVALID --once
# Esperado: ficheiros vão para failed/ com HTTP 401

# Retry com key correcta
npm run agent:ingest-folder -- ... --key=<key correcta> --retry-failed
# Esperado: re-upload com sucesso → move para processed/
# OU se já era duplicate → move para processed/duplicates/
```

### 3.5 Validar LoteIngestao + SyncRun

```bash
# LoteIngestao na BD do tenant
npx tsx -e "
import {legacyPrisma} from './lib/prisma';
import {getTenantPrismaOrLegacy} from './lib/tenant-registry';
getTenantPrismaOrLegacy('<slug>').then(async (p) => {
  const lotes = await p.loteIngestao.findMany({ orderBy: { dataCriacao: 'desc' }, take: 10 });
  console.table(lotes.map(l => ({ id: l.id.slice(0,8), tipo: l.tipo, estado: l.estado, totalRegistos: l.totalRegistos, totalAceites: l.totalAceites })));
  await p.\$disconnect();
});"

# SyncRun no control plane
npx tsx -e "
import {controlPrisma} from './lib/control-plane';
controlPrisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 10 }).then(r => {
  console.table(r.map(s => ({ id: s.id.slice(0,8), tenant: s.tenantSlug, source: s.source, status: s.status, durationMs: s.durationMs })));
  controlPrisma.\$disconnect();
});"
```

### 3.6 Refresh IPF + dashboard

```bash
npx tsx scripts/jobs/refresh-ipf.ts --tenant=<slug>
# Esperado: ~22k rows / coverage 100% / dataCalculo NOW

# Validar UI
# Abrir https://<deploy>/admin → Last sync + IPF freshness verde
# Abrir https://<deploy>/dashboard → KPIs reais
# Abrir https://<deploy>/oportunidades → feed populado
```

### 3.7 Preencher (durante execução):

```
Tempo upload stock:       _____ s   (records read/inserted: _____)
Tempo upload sales:       _____ s   (records read/inserted: _____)
Tempo dedup verificação:  _____ s
Tempo retry verificação:  _____ s
Tempo refresh-ipf:        _____ s

Throughput stock:         _____ records/s
Throughput sales:         _____ records/s

LoteIngestao rows criados: _____
SyncRun rows criados:     _____

Problemas encontrados:
  - _____
Bugs corrigidos:
  - _____
```

---

## 4. FASE 4 — Operational Readiness

### 4.1 Infra final usada

| Campo | Valor |
|---|---|
| Provider | Neon |
| Projecto | _____ |
| Região | eu-west-2 |
| Plano | _____ (Free / Launch / Scale) |
| Compute hours usadas | _____ |
| Storage | _____ GB |

### 4.2 Tenant criado

| Campo | Valor |
|---|---|
| Slug | _____ |
| Nome | _____ |
| DB name | _____ |
| Provisioned at | _____ |
| Farmácias criadas | _____ |
| Ingest key emitida | sim / não |

### 4.3 Tempos reais (resumo)

| Etapa | Tempo esperado | Tempo real |
|---|---:|---:|
| Bootstrap infra (Neon + envs) | 30 min | _____ |
| Onboard CLI | <30s | _____ |
| Issue key | <30s | _____ |
| Criar farmácia inicial | ~2 min (manual) | _____ |
| Upload stock (22k rows) | ~5 s | _____ |
| Upload sales (12k rows) | ~3 s | _____ |
| Dedup check | <1s | _____ |
| Refresh IPF | ~15s | _____ |
| **Total piloto end-to-end** | **~60 min** | **_____** |

### 4.4 Problemas encontrados

| # | Sintoma | Causa | Fix aplicado |
|---|---|---|---|
| 1 | _____ | _____ | _____ |

### 4.5 Bugs corrigidos no batch

(listar commits cirúrgicos feitos durante o piloto)

| Commit | Bug |
|---|---|
| _____ | _____ |

### 4.6 Passos ainda manuais (atritos operacionais)

| Atrito | Workaround actual | Esforço para automatizar |
|---|---|---|
| ~~Criar 1ª farmácia no tenant~~ | ~~SQL manual~~ | **SOLVED — `--farmacia-inicial` em `tenant:onboard`** |
| Criar 2ª+ farmácia no tenant | SQL/Prisma Studio | ~15 min: `npm run tenancy:add-farmacia` |
| Actualizar `Tenant.lastBackupAt` | Manual após backup Neon | ~30 min: cron diário que verifica branches Neon |
| Configurar Vercel Cron `CRON_SECRET` | Manual em `vercel env add` | N/A — operação 1× por env |
| Provisionar Neon project + envs | Manual no Neon dashboard | N/A — operação 1× por ambiente |

### 4.7 Checklist Go-Live

- [ ] `env:doctor` 4/4 scopes ready em PROD
- [ ] Control plane migrations aplicadas em PROD
- [ ] 1 tenant piloto criado e validado
- [ ] Pelo menos 1 farmácia criada no tenant
- [ ] Ingest key emitida e anotada
- [ ] Pelo menos 1 upload stock + 1 sales bem-sucedido
- [ ] Dedup confirmado (2º upload mesmo ficheiro = skipped_duplicate)
- [ ] Retry confirmado (failed → retry → processed)
- [ ] IPF refresh corrido para o tenant
- [ ] `/dashboard` carrega com KPIs reais
- [ ] `/oportunidades` mostra feed se houver oportunidades
- [ ] `/admin` mostra Last sync verde + IPF saudável
- [ ] `TENANT_ENCRYPTION_SECRET` em vault corporativo
- [ ] Admin password do tenant entregue ao cliente
- [ ] Operador do cliente tem acesso ao agent CLI

### 4.8 Blockers reais restantes (curtos)

| Blocker | Severidade | Estimativa para fix |
|---|---|---|
| _____ | _____ | _____ |

---

## 5. Diário de execução

Espaço livre — preencher cronologicamente à medida que executas. Tempo, observação, decisão.

```
HH:MM  __________________________________________
HH:MM  __________________________________________
HH:MM  __________________________________________
```

---

## Anexo A — Comandos de validação rápida

```bash
# Estado das envs
npm run env:doctor

# Estado do control plane
npm run tenancy:list
npm run tenancy:health

# Estado de 1 tenant específico
npm run tenancy:health -- --slug=<slug>

# Estado IPF
npx tsx scripts/ipf-health.ts

# Smoke do resolver
npm run tenancy:smoke-resolver

# Stop + restart agent em watch
Ctrl+C  &&  npm run agent:ingest-folder -- --watch ...
```

---

## Anexo B — Recovery em caso de bootstrap falhar

| Cenário | Recovery |
|---|---|
| Migration control plane falha | Verificar logs Neon, corrigir, re-correr `npm run control:migrate:deploy` |
| `tenant:onboard` falha no passo CREATE ROLE/DB | Verificar `POSTGRES_ADMIN_URL` tem privilégios CREATEDB/CREATEROLE |
| `tenant:onboard` falha em `migrate deploy` | Tenant fica em FAILED. Verificar com `npm run tenancy:list`; re-correr migrate-all com `--only=<slug>` após fix |
| `tenant:onboard` falha em seed admin | Verificar bcrypt funciona; provavelmente conflito de email |
| Agent não consegue resolver `--farmacia=<nome>` | Confirmar que farmácia existe no tenant (passo 2.4); ou usar cuid directamente |
| Upload retorna 401 | Re-emitir key com `--rotate`; confirmar `--tenant=<slug>` e `--key` corresponde à chave anotada |
| Upload retorna 404 farmacia_not_found | Confirmar cuid; listar farmácias com `GET /api/ingest/v1/farmacias` |

---

_Sair desta fase com: 1 grupo de farmácias funcional end-to-end em produção._
