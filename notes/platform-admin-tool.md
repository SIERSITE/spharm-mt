# Platform Admin Tool

**Versão:** 2026-05-12 · **Status:** design doc, pré-implementação

Ferramenta CLI que corre **do nosso lado** (operadores SPharm.MT) para criar e gerir clientes/grupos sem ter de tocar manualmente no dashboard Neon nem em SQL admin.

> Distinto do [Local Agent](local-agent-architecture.md). O Local Agent corre **na farmácia** e não conhece Neon. A Platform Admin Tool corre **na SaaS / no laptop do operador** e conhece tudo.

---

## 1. Missão

Comando único que onboards um novo cliente:

```bash
spharmmt-admin create-client \
  --slug farmacias-braga \
  --nome "Grupo Farmácias de Braga" \
  --admin-email admin@braga.pt \
  --farmacias "Farmácia Central,Farmácia Norte,Farmácia Sul" \
  --region eu-west-2
```

E recebe no output:
- URL do dashboard do cliente
- Credenciais iniciais do admin (mostradas UMA VEZ)
- Ingest key para o agent local (mostrada UMA VEZ)
- Resumo do smoke test

Tudo sem abrir o browser Neon.

---

## 2. Boundaries — o que a Platform Admin Tool faz / NÃO faz

| Faz | Não faz |
|---|---|
| Cria BD Neon via Neon API | Lê dados de negócio dos tenants |
| Regista tenant no control plane | Executa queries da app (use a UI) |
| Aplica migrations à BD do tenant | Substitui o `/admin` web UI — esse fica para gestão recorrente |
| Cria utilizador admin + farmácias iniciais | Conhece o agent local ou config do SQL Server do cliente |
| Emite ingest key + smoke test | Faz ingest de dados — isso é o agent |
| Comandos de gestão (suspend/rotate-key/list) | Modifica schema de tenants (delegado a `tenancy:migrate-all`) |

---

## 3. Provider abstraction

Para não ficar acoplado a Neon, todas as operações de provisão de BD passam por uma interface:

```ts
// lib/db-providers/types.ts
export interface DatabaseProvider {
  readonly name: string;             // "neon" | "manual" | "rds-postgres" | ...
  createDatabase(opts: {
    slug: string;
    region?: string;
  }): Promise<{
    host: string;
    port: number;
    dbName: string;
    dbUser: string;
    dbPassword: string;
    connectionUrl: string;          // já com sslmode/etc.
  }>;
  destroyDatabase(opts: { dbName: string; dbUser: string }): Promise<void>;
  isReachable(): Promise<boolean>;
}
```

Implementações na v1:

| Provider | Quando |
|---|---|
| `NeonProvider` | Default em produção. Usa Neon API (`api.neon.tech/api/v2/projects/{project_id}/databases`). |
| `ManualUrlProvider` | Fallback. Operador passa `--database-url` explícito (já hoje funciona). Compatibilidade com providers que ainda não temos abstraction (RDS, Supabase…). |
| `LocalPostgresProvider` (dev) | Para tests E2E sem chamar Neon. Cria via `pg.Client` admin local. |

A escolha do provider é automática:
- `NEON_API_KEY` definido → `NeonProvider`
- `--database-url` passado → `ManualUrlProvider`
- `LOCAL_PG_ADMIN_URL` definido + `--use-local-pg` flag → `LocalPostgresProvider`
- Senão → erro accionável "configura NEON_API_KEY ou passa --database-url"

### 3.1 Neon API — chamadas usadas

| Chamada | Quando |
|---|---|
| `POST /projects/{pid}/databases` | Criar BD do tenant |
| `POST /projects/{pid}/roles` | Criar role com password gerada |
| `GET /projects/{pid}/connection_uri?database_name=…&role_name=…` | Obter URL completa (com pooler + sslmode) |
| `DELETE /projects/{pid}/databases/{db_name}` | Rollback / destroy |
| `DELETE /projects/{pid}/roles/{role_name}` | Rollback |
| `GET /projects/{pid}` | Sanity check no startup do `doctor` |

Project ID é fixo por ambiente (vive em `NEON_PROJECT_ID`). Permite ter projectos separados dev / staging / prod sem cross-talk.

### 3.2 Envs novas

| Env | Scope | Level | Notas |
|---|---|---|---|
| `NEON_API_KEY` | cli | optional | Trigger para usar `NeonProvider`. Sem isto, cai em `ManualUrlProvider`. |
| `NEON_PROJECT_ID` | cli | optional | Project Neon onde criar BDs. Obrigatório se `NEON_API_KEY` presente. |
| `NEON_DEFAULT_REGION` | cli | optional | Default `eu-west-2` (Londres). Override por flag `--region`. |

`POSTGRES_ADMIN_URL` continua válido — agora só usado pelo `LocalPostgresProvider` e pelo modo legacy `--create-db`.

---

## 4. Workflow — `create-client`

```
┌────────────────────────────────────────────────────────────────┐
│ Step 0  PRE-FLIGHT                                              │
│   · Valida CLI args                                             │
│   · Valida slug (regex)                                         │
│   · Confirma slug livre no control plane                        │
│   · Confirma provider configurado (NEON_API_KEY ou flag URL)    │
│   · Confirma control plane reachable                            │
├────────────────────────────────────────────────────────────────┤
│ Step 1  PROVISION BD                                            │
│   · provider.createDatabase({ slug, region })                   │
│   · → { host, port, dbName, dbUser, dbPassword, connectionUrl } │
│   · Rollback handler armado (provider.destroyDatabase)          │
├────────────────────────────────────────────────────────────────┤
│ Step 2  REGISTER NO CONTROL PLANE                               │
│   · INSERT Tenant (estado=PROVISIONING, dbPassEncrypted)        │
├────────────────────────────────────────────────────────────────┤
│ Step 3  APLICAR MIGRATIONS                                      │
│   · prisma migrate deploy DATABASE_URL=connectionUrl            │
│   · Confirmar schemaVersion via `_prisma_migrations`            │
├────────────────────────────────────────────────────────────────┤
│ Step 4  SEED (admin + farmácias)                                │
│   · Cria 1 Utilizador ADMINISTRADOR                             │
│   · Para cada nome em --farmacias: cria Farmacia (estado=ATIVO) │
│   · Emite logs com cuid de cada farmácia                        │
├────────────────────────────────────────────────────────────────┤
│ Step 5  EMITIR INGEST KEY                                       │
│   · randomBytes(32).toString('hex')                             │
│   · Hash bcrypt → Tenant.ingestApiKeyHash                       │
│   · Key em claro guardada para output final                     │
├────────────────────────────────────────────────────────────────┤
│ Step 6  SMOKE TEST                                              │
│   · GET <SaaS>/api/ingest/v1/farmacias com nova key + slug      │
│   · Esperado: 200 + lista das farmácias criadas no step 4       │
│   · GET <SaaS>/api/outbox/v1/heartbeat (POST sem payload)       │
│   · Esperado: 200                                               │
│   · Falha aqui → marca Tenant=FAILED, mantém DB para inspecção  │
├────────────────────────────────────────────────────────────────┤
│ Step 7  ACTIVATE                                                │
│   · Tenant.estado = ACTIVE                                      │
│   · provisionedAt = now()                                       │
│   · TenantEvent action='created' meta={ provider, region, … }   │
├────────────────────────────────────────────────────────────────┤
│ Step 8  OUTPUT FINAL                                            │
│   · URL do dashboard cliente: https://<slug>.spharmmt.pt        │
│   · Admin email + password (UMA VEZ)                            │
│   · Ingest key em claro (UMA VEZ)                               │
│   · Lista de farmácias com cuid                                 │
│   · Checklist para o operador (enviar credenciais ao cliente)   │
└────────────────────────────────────────────────────────────────┘
```

### 4.1 Rollback

| Step que falhou | Acção |
|---|---|
| 0 (pre-flight) | Nada a desfazer |
| 1 (provision BD) | `provider.destroyDatabase` (best-effort) |
| 2 (register) | DELETE Tenant + provider.destroyDatabase |
| 3 (migrations) | Marca Tenant=FAILED · **não** destrói BD (operador inspecciona) |
| 4-6 (seed/key/smoke) | Marca Tenant=FAILED · BD preservada · TenantEvent action='provision_failed' |
| 7 (activate) | Não há rollback — está activo, usa `tenancy:deactivate` |

Limpeza posterior: `npm run tenancy:cleanup-failed -- --slug <slug>` (já existe). Para destruir a BD ao mesmo tempo, futuro `--destroy-db` flag delegado ao provider.

---

## 5. CLI shape

### 5.1 Comandos finais (binary `spharmmt-admin`)

| Comando | Função |
|---|---|
| `create-client` | Step 0-8 acima |
| `list-clients` | Lista tenants no control plane (table view) |
| `get-client <slug>` | Detalhe + último heartbeat + SyncRun recente |
| `rotate-ingest-key <slug>` | Emite nova key, invalida antiga, mostra em claro |
| `migrate-all-clients` | `prisma migrate deploy` em todos os tenants ACTIVE |
| `suspend-client <slug>` | Estado SUSPENDED |
| `reactivate-client <slug>` | Estado ACTIVE |
| `destroy-client <slug>` | DEACTIVATED + provider.destroyDatabase com double confirm |
| `health` | Smoke test multi-tenant: list + ping a cada |
| `doctor` | Validar config local (envs + provider + control plane) |

### 5.2 Aliases npm (dev até empacotar)

| npm | Equivalente |
|---|---|
| `npm run tenant:create` | `spharmmt-admin create-client` |
| `npm run tenant:list` | `spharmmt-admin list-clients` |
| `npm run tenant:rotate-key` | `spharmmt-admin rotate-ingest-key` |
| `npm run tenancy:cleanup-failed` (já existe) | continua a existir como helper de baixo nível |
| `npm run tenancy:provision` (já existe) | mantido como wrapper raw — usa o mesmo workflow interno |
| `npm run tenancy:list` (já existe) | alias para `tenant:list` |

Os scripts já existentes (`tenancy:provision`, `tenancy:list`, etc.) continuam funcionais; o `spharmmt-admin` é a **fachada unificada** que os encadeia.

---

## 6. Flags de `create-client`

| Flag | Obrigatória | Default | Notas |
|---|---|---|---|
| `--slug` | sim | — | Regex `/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/` |
| `--nome` | sim | — | Nome legível do grupo |
| `--admin-email` | sim | — | Email do administrador inicial |
| `--admin-nome` | não | "Administrador" | Nome legível do admin |
| `--admin-password` | não | gera | Se omisso, gera 12-char base64url e mostra no output |
| `--farmacias` | não | — | CSV de nomes. Exemplo: `"Central,Norte,Sul"`. Cria N farmácias. |
| `--region` | não | `NEON_DEFAULT_REGION` ou `eu-west-2` | Aplicável só ao Neon provider |
| `--database-url` | não | — | Override do provider para `ManualUrlProvider` |
| `--use-local-pg` | não | false | Force `LocalPostgresProvider` (dev/test) |
| `--no-smoke` | não | false | Skip step 6 — útil em dev sem SaaS online |
| `--dry-run` | não | false | Imprime o plano sem executar nenhum side-effect |
| `--json` | não | false | Output final em JSON em vez de texto (para piping) |

---

## 7. Segurança

- **NEON_API_KEY** é um secret do mesmo nível que a master password. Vive só em vault (1Password / Bitwarden) + máquina do operador. Nunca commitada.
- **Ingest keys** geradas pela tool são mostradas UMA VEZ — repetição requer `rotate-ingest-key`.
- **Admin passwords** geradas são `mustChangePassword=true` no primeiro login.
- **Audit trail**: cada operação escreve `TenantEvent` com `actorId` do operador (futuro: SSO; v1 é o user OS local, `process.env.USER`).
- **Confirmação dupla** em comandos destrutivos (`destroy-client`, `rotate-ingest-key`): operador tem de escrever o slug exacto.

---

## 8. Estrutura de código proposta

```
scripts/admin/                     # entrypoints CLI (sucessores de scripts/tenancy/*)
   ├── _spharmmt-admin.ts          # router de subcomandos (futuro bin)
   ├── create-client.ts
   ├── list-clients.ts
   ├── rotate-ingest-key.ts
   ├── migrate-all-clients.ts
   ├── destroy-client.ts
   └── doctor.ts

lib/db-providers/
   ├── types.ts                    # interface DatabaseProvider
   ├── neon.ts                     # NeonProvider (fetch contra api.neon.tech)
   ├── manual-url.ts               # ManualUrlProvider (parse URL + connectivity test)
   ├── local-postgres.ts           # LocalPostgresProvider (pg.Client admin)
   └── select.ts                   # selectProvider({ flags, env }) → DatabaseProvider

lib/admin/
   ├── workflow.ts                 # createClient(opts) — chamado por CLI e por testes
   ├── rollback.ts                 # rollback handlers tipados
   └── smoke.ts                    # smoke test pós-provision
```

Os scripts actuais `scripts/tenancy/*.ts` permanecem como compatibility shims (`scripts/tenancy/provision-tenant.ts` chama `lib/admin/workflow.createClient` por baixo). Nada quebra.

---

## 9. Failure modes

| Erro | Causa | Acção |
|---|---|---|
| Neon API HTTP 401 | API key revogada / errada | Falha-rápido com link para gerar nova key |
| Neon API rate limit | Provision em paralelo de muitos clientes | Retry exponencial até 3× |
| Neon project sem quota | Atingiu limite de DBs no plano | Falha + sugere upgrade ou destroy de tenants DEACTIVATED |
| Migration falha | Schema com erro / pre-condição não satisfeita | Tenant marcado FAILED, BD preservada para debug |
| Smoke test 500 | SaaS down ou control plane com lag | Retry 3×, depois Tenant=FAILED com instrução de retry manual |
| Rollback parcial falha | API Neon down a meio do rollback | Mensagem accionável: lista de recursos para limpar manualmente |

---

## 10. Roadmap de implementação

1. ⏳ **Provider abstraction** — `lib/db-providers/{types,manual-url,neon,select}.ts`. Migrar `provision-tenant.ts` actual a usar `ManualUrlProvider` por baixo (preserva backward compat).
2. ⏳ **`lib/admin/workflow.ts`** — função `createClient(opts)` pura, testável, encadeia steps 1-8 com rollback tipado.
3. ⏳ **`scripts/admin/create-client.ts`** — CLI thin que valida flags e chama `workflow.createClient`.
4. ⏳ **NeonProvider** real — `fetch` contra `api.neon.tech/api/v2`. Smoke test contra projecto dev.
5. ⏳ **list/rotate/destroy/doctor** — comandos restantes, cada um numa PR isolada.
6. ⏳ **Empacotamento bin** — `package.json#bin: { "spharmmt-admin": "..." }` quando vier o npm package separado.

---

## 11. Decisões abertas

| Decisão | Opções | Recomendação |
|---|---|---|
| Onde corre o `spharmmt-admin` | (a) laptop do operador (b) endpoint admin server-side `/admin/api/create-client` | (a) v1, (b) futuro (UI web) |
| Auth do operador | (a) sem auth (machine local) (b) SSO Google Workspace | (a) v1, (b) quando 2+ operadores |
| Limite de farmácias por chamada | (a) ilimitado (b) cap 50 com confirm | (a) — bottleneck é Neon API |
| Quota Neon por cliente | Hard-coded no plano global | aceitar — não worth abstrair v1 |
| Multi-region | `--region` aceita qualquer Neon region | aceitar — Neon trata da disponibilidade |

---

## 12. Relação com a arquitectura geral

| Camada | Componente | Owner | Conhece |
|---|---|---|---|
| **SaaS web** | Next.js app | Plataforma | Control plane + tenant DBs (via resolver) |
| **SaaS background** | Cron + outbox + agent backend | Plataforma | Mesmo que web |
| **Platform Admin Tool** | CLI `spharmmt-admin` | Plataforma | Neon API + Control plane |
| **Local Agent (folder ou SQL)** | CLI `spharmmt-agent` | Cliente | Endpoint SaaS + tenant key + SQL Server local |
| **ERP do cliente** | SPharm (SQL Server) | Cliente | — (read-only consumer) |

A regra de isolamento dura:

- O **Local Agent nunca vê NEON_API_KEY nem control plane**
- A **Platform Admin Tool nunca vê dados de negócio dos tenants** (só metadata: slug, estado, schemaVersion, heartbeat)
- O **web SaaS resolve tenants por slug** via control plane; usuários autenticados só vêm dados do seu tenant (enforced via `withTenantPrisma`)
