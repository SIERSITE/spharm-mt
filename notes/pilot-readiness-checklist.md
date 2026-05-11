# Pilot Readiness Checklist

**Data:** 2026-05-11 · **Estado:** validação RC para piloto multi-grupo.

Checklist concreto: cada linha tem **comando**, **expected**, e
**estimativa de tempo**. Para um operador novo, fazer esta sequência
do zero deve demorar **45–90 minutos** com infra Neon nova.

---

## Fase 0 — Bootstrap da plataforma (uma vez)

### 0.1 Provisionar Neon project (~15 min)
- [ ] Criar projecto Neon `spharmmt-rc` em região `eu-central-1`
- [ ] Criar role `spharmmt_admin` com `CREATEDB CREATEROLE`
- [ ] Criar DB `spharmmt_control` (control plane)
- [ ] Anotar pooler host + admin password

### 0.2 Configurar envs (~5 min)
```bash
# .env (local) ou Vercel env (produção)
DATABASE_URL=postgres://...
CONTROL_DATABASE_URL=postgres://.../spharmmt_control
TENANT_DB_HOST=ep-xxx-pooler.eu-central-1.aws.neon.tech
TENANT_DB_PORT=5432
POSTGRES_ADMIN_URL=postgres://.../postgres
TENANT_ENCRYPTION_SECRET=<openssl rand -hex 32>
AUTH_SECRET=<openssl rand -base64 32>
CRON_SECRET=<openssl rand -hex 24>
PLATFORM_ADMIN_EMAILS=admin@spharm.mt
```

- [ ] **Validar:** `npm run env:doctor` → todos os scopes `✅ ready`

### 0.3 Aplicar schema control plane (~2 min)
```bash
npx tsx scripts/control/migrate-deploy.ts
```
- [ ] Output mostra "All migrations have been applied"
- [ ] Tabelas `Tenant`, `TenantEvent`, `GlobalAdmin`, `SyncRun` existem

### 0.4 Smoke test do resolver (~1 min)
```bash
npm run tenancy:smoke-resolver
```
- [ ] Todos os steps passam

### 0.5 Deploy da app (~10 min)
```bash
vercel deploy --prod
```
- [ ] `/login` carrega
- [ ] `/admin` mostra "Sem tenants registados"
- [ ] Painel IPF freshness ainda não aparece (sem dados)

---

## Fase 1 — Onboard primeiro grupo (~15 min)

### 1.1 Provision automático (~30s)
```bash
npm run tenant:onboard -- \
  --slug farmacias-braga \
  --nome "Grupo Farmácias de Braga" \
  --admin-email admin@braga.pt
```
- [ ] Output mostra `✓ Provision (4.x s)`
- [ ] Output mostra `✓ Smoke test (2.x s)`
- [ ] Output imprime checklist accionável de 6 passos

### 1.2 Issue ingest key (~30s)
```bash
npx tsx scripts/tenancy/issue-ingest-key.ts --slug=farmacias-braga
```
- [ ] Key em claro mostrada **uma vez**
- [ ] Anotar em vault seguro

### 1.3 Configurar agent Windows do grupo (~5 min)
No PC do grupo:
- [ ] Instalar agent
- [ ] Configurar headers HTTP:
  - `X-Tenant-Slug: farmacias-braga`
  - `Authorization: Bearer <key emitida>`
- [ ] Apontar para `https://<deploy>.vercel.app/api/ingest/v1/`
- [ ] Iniciar agent

### 1.4 Confirmar heartbeat (~2 min)
- [ ] Abrir `/admin` no portal
- [ ] Linha do tenant `farmacias-braga` mostra:
  - Estado: `ACTIVE` ✅
  - Heartbeat: `<30m` (verde)
  - Key: `ok`

### 1.5 Validar primeiros dados (~5 min depois de primeira ingest)
```bash
npm run tenancy:health -- --slug=farmacias-braga
```
- [ ] `Farmacia` count > 0
- [ ] `Produto` count > 0
- [ ] `ProdutoFarmacia` count > 0
- [ ] `VendaMensal` count > 0

---

## Fase 2 — Validação operacional (~10 min)

### 2.1 Refresh IPF (~30s)
```bash
# Via cron endpoint
curl -i \
  -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deploy>.vercel.app/api/jobs/refresh-ipf"
```
- [ ] HTTP 200
- [ ] Payload mostra `populate.rowsUpserted > 0`
- [ ] Payload mostra `health.healthy: true`

Alternativa CLI:
```bash
npx tsx scripts/jobs/refresh-ipf.ts
```

### 2.2 Validar dashboard (~2 min)
- [ ] Abrir `/dashboard`
- [ ] Tile **Critical Alerts** mostra produtos at risk
- [ ] Tile **Transferências** mostra sugestões
- [ ] Tile **Excessos** mostra valor parado
- [ ] Tile **Encomendas evitáveis** (substituição interna) mostra count + €

### 2.3 Validar oportunidades (~2 min)
- [ ] Abrir `/oportunidades`
- [ ] Feed Same-CNP populado (se houver oportunidades)
- [ ] Feed DCI-equivalente populado (se houver)
- [ ] KPI IPF freshness `saudável` em verde

### 2.4 Criar transferência interna (~1 min)
- [ ] Clicar `[Criar transferência]` em qualquer linha do feed
- [ ] Confirmar pop-up
- [ ] Browser redirecciona para `/encomendas/[id]`
- [ ] `ListaEncomenda` aparece em RASCUNHO com 1 linha
- [ ] Notas contém origem, kind, motivo

### 2.5 Validar enriquecimento clínico visível (~1 min)
- [ ] `/stock` mostra chip ATC + DCI no produto
- [ ] `/transferencias` idem
- [ ] `/encomendas` idem

### 2.6 Backup (~5 min, manual)
- [ ] No dashboard Neon, verificar que PITR window cobre últimas 24h
- [ ] (Manual) Update `Tenant.lastBackupAt` no control plane
- [ ] `/admin` mostra "Backup: hoje" em verde para o tenant

### 2.7 Restore path conhecido (~documentation only)
- [ ] Em Neon dashboard → Branches → Create branch from timestamp
- [ ] Confirmar que o branch fica acessível via novo endpoint
- [ ] Em emergência: swap `Tenant.dbName` para o branch e re-provision o resolver

---

## Fase 3 — Cron real (~5 min)

### 3.1 Vercel Cron configurado
- [ ] `vercel.json` tem `crons: [{ path: "/api/jobs/refresh-ipf", schedule: "0 3 * * *" }]`
- [ ] Vercel project tem `CRON_SECRET` em env de prod
- [ ] Vercel CLI: `vercel cron list` mostra a entry

### 3.2 Smoke trigger manual
```bash
# Trigger manual sem esperar 24h
curl -i -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deploy>.vercel.app/api/jobs/refresh-ipf"
```
- [ ] HTTP 200 + payload com populate + health
- [ ] Vercel dashboard mostra `refresh-ipf` na History

### 3.3 Health visibility
- [ ] `/admin` mostra IPF freshness atualizada
- [ ] Idade `<1h` em verde
- [ ] Cron job aparece em `Last sync` por tenant

---

## Tempos reais estimados

| Fase | Componente | Tempo |
|---|---|---:|
| 0 | Bootstrap Neon + envs + deploy | **~30 min** |
| 1 | Onboard 1º grupo | **~15 min** |
| 2 | Validação operacional ponta-a-ponta | **~10 min** |
| 3 | Cron real (uma vez) | **~5 min** |
| **TOTAL** | — | **~60 min** |

Grupos subsequentes: **~10 min cada** (Fase 1 + smoke da Fase 2.4).

---

## "Tem-de-funcionar" — fail-fast scenarios

Estes têm de **falhar com mensagem accionável**, não silenciosamente:

| Cenário | Comando que detecta | Mensagem esperada |
|---|---|---|
| `CONTROL_DATABASE_URL` falta | `npm run env:doctor` | `[web] NOT ready · missing: CONTROL_DATABASE_URL` |
| Slug já em uso | `npm run tenant:onboard -- --slug X ...` | `Slug já usado pelo tenant id=... (estado=ACTIVE)` |
| Pooler down | qualquer query | Prisma error com host + reason |
| Migration falha | `npm run tenancy:migrate-all -- --only=X` | Tenant fica em `FAILED`; stderr mostrado |
| Cron endpoint sem secret | `curl /api/jobs/refresh-ipf` (sem header) | `HTTP 401 { error: unauthorized }` |
| Cron endpoint mal-configurado | `curl ...` (sem CRON_SECRET em env) | `HTTP 503 { error: server_misconfigured }` |
| Smoke test resolver falha | `npm run tenancy:smoke-resolver` | Step name + erro literal |

Todos testados durante o desenvolvimento.

---

## Anti-checklist (o que não está pronto)

Itens que não invalidam o piloto mas têm de ser feitos antes de produção pesada:

- [ ] Logs estruturados centralizados (Vercel Logs cobre piloto; futuro: Datadog/Logflare)
- [ ] Alerting em IPF unhealthy (cron 503 hoje não dispara alerta — operador valida manualmente)
- [ ] Rate-limit no `/api/ingest/v1/*` (bcrypt protege auth; sem throttling em ingest endpoints)
- [ ] CSP headers + security headers de produção
- [ ] Catálogo regulatório enriquecido (28% DCI hoje → ~80% após pipeline `RegulatoryAcquisitionJob` activado)
- [ ] `Compra` ingest real → IPF preenche `diasSemVenda`, `ultimoPrecoCompra`, `ultimoFornecedorId`
- [ ] Backup automático schedule (cron diário que escreve `Tenant.lastBackupAt`)
- [ ] Email transaccional configurado (`EMAIL_CONFIG_SECRET` é `recommended` não `required`)
