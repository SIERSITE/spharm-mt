# Tenant onboarding — checklist operacional

**Data:** 2026-05-11 · **Estado:** Batch 1 (Multi-Grupo Ready)

Comando único para criar um novo grupo de farmácias:

```bash
npm run tenant:onboard -- \
  --slug farmacias-braga \
  --nome "Grupo Farmácias de Braga" \
  --admin-email admin@braga.pt
```

Este comando encadeia:
1. **Provision** — `CREATE ROLE` + `CREATE DATABASE` + `prisma migrate deploy` + seed do admin + estado=ACTIVE no control plane
2. **Smoke test** — valida resolver tenant via `getPrisma()` e `SELECT 1`

Saída: imprime checklist accionável dos passos manuais restantes.

---

## Pré-requisitos de env

Antes do primeiro onboard, garantir:

| Variável | Para que serve |
|---|---|
| `CONTROL_DATABASE_URL` | Connection ao control plane (registo de tenants) |
| `TENANT_ENCRYPTION_SECRET` | AES-256-GCM para `Tenant.dbPassEncrypted` |
| `TENANT_DB_HOST`, `TENANT_DB_PORT` | Host/port onde as BDs por-tenant são criadas |
| `PGADMIN_USER`, `PGADMIN_PASSWORD` | Credenciais com `CREATE ROLE`/`CREATE DATABASE` |

`provision-tenant.ts` falha-rápido se algum estiver em falta.

---

## Pós-onboard — checklist accionável

Após `npm run tenant:onboard` completar com sucesso, executar manualmente:

### 1. Emitir ingest API key
```bash
npx tsx scripts/tenancy/issue-ingest-key.ts --slug=<slug>
```
A key em claro é mostrada **uma única vez** — anotar e guardar em vault.

### 2. Configurar o agent Windows do grupo
Headers em cada request HTTP:
- `X-Tenant-Slug: <slug>`
- `Authorization: Bearer <key>`

Endpoints relevantes:
- Upstream (ingest): `/api/ingest/v1/*`
- Downstream (outbox): `/api/outbox/v1/*` + heartbeat

### 3. Confirmar primeiro heartbeat
Abrir `/admin` no portal e verificar a linha do tenant:
- Coluna **Heartbeat** deve mostrar `<30m` em verde
- Coluna **Key** deve mostrar `ok`

### 4. Validar primeiros dados ingeridos
```bash
npm run tenancy:health -- --slug=<slug>
```
Output: linhas em `ProdutoFarmacia`, `VendaMensal`, etc.

### 5. Registar primeiro backup
- Snapshot manual no provider (Neon Branch ou backup tool da BD).
- Actualizar `Tenant.lastBackupAt` manualmente (ou via cron de backup, quando estiver activado).

### 6. Comunicar ao cliente
- URL de acesso: `https://<slug>.spharmmt.app` (ou domínio equivalente)
- Credencial admin: entregue pelo CLI no momento do provision

---

## Failure modes & recovery

| Falha | Diagnóstico | Recuperação |
|---|---|---|
| Provision falha no passo 4 (CREATE ROLE/DB) | Erro Postgres `permission denied` ou role já existe | Verificar `PGADMIN_*`; se role existe, dropar manualmente e re-correr |
| Provision falha no passo 6 (`prisma migrate deploy`) | Migration corrompida ou conexão falhou | Tenant fica em `FAILED` no control plane. Investigar, corrigir, e re-correr `npm run tenancy:migrate-all -- --only=<slug>` |
| Provision falha no passo 7 (seed admin) | Conflito de email já em uso | `FAILED` no control plane. Verificar `Utilizador` na BD do tenant, limpar manualmente |
| Smoke test falha (mas provision OK) | Resolver não consegue ligar à nova BD | Tenant fica `ACTIVE` mas inacessível. Verificar `TENANT_ENCRYPTION_SECRET` e `lib/tenant-registry.ts`. |
| Agent não envia heartbeat após 24h | Key errada, slug errado, ou agent não arrancou | Re-emitir key, confirmar config Windows |

---

## Acompanhamento operacional

A página `/admin` mostra, por tenant, em linha única:
- Estado (`ACTIVE` / `SUSPENDED` / `FAILED`)
- DB (host/name)
- Last sync (idade do último `SyncRun` em qualquer source)
- Backup (idade em dias; amber se >2d)
- Heartbeat (idade em min; amber se >30m)
- Key (ok/em falta)

Painel global no topo:
- Control plane: OK / indisponível
- **IPF read-model freshness** (legacy DB): rows + coverage% + idade
- Contadores globais

---

## Comandos úteis pós-onboard

```bash
# Listar todos os tenants
npm run tenancy:list

# Health check de todos
npm run tenancy:health

# Health de 1 específico
npm run tenancy:health -- --slug=<slug>

# Migrar schema em todos os tenants
npm run tenancy:migrate-all

# Migrar 1 só
npm run tenancy:migrate-all -- --only=<slug>

# Smoke test do resolver
npm run tenancy:smoke-resolver

# Suspender (read-only — bloqueia ingest)
npm run tenancy:deactivate -- --slug=<slug>

# Reactivar
npm run tenancy:reactivate -- --slug=<slug>
```

---

_Pronto para piloto: 1 comando, 1 checklist, 1 página admin com visibilidade total por tenant._
