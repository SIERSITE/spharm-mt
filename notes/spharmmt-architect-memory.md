# SPharm.MT — Snapshot Operacional (memória "SPharm.MT Architect")

> Estado **exato** após commits `ca3d0aa`, `5fcabd5`, `18dd4a9`, `a6794d2`.
> Data: 2026-05-20. Documento de memória persistente — não é visão idealizada.
> **Não contém segredos** (keys/passwords/tokens vivem fora deste doc).

---

## 1. Estado geral do projeto

SPharm.MT é uma plataforma SaaS multi-tenant para grupos de farmácias:
- **SaaS**: Next.js 16 (App Router) em **Vercel**. Dashboard, análise
  operacional, ingestão, outbox de encomendas, admin console.
- **Agent local** (Windows, self-contained com `node.exe` portátil): corre
  no PC da farmácia, lê o ERP **SPharm (SQL Server)** read-only, faz
  ingestão para o SaaS e escreve encomendas de volta no SPharm.
- **Control plane** (Postgres dedicado, `spharmmt_control`): registo de
  tenants, ingest keys, eventos, sync runs. Cada tenant tem **BD própria**.
- Fase atual: **PILOTO** sob freeze de produção (ver §2). Cliente real:
  **Grupo Silveira** (ver §3/§20). Tenant de teste canónico: **demo-neon**.

Stack/runtimes: Next 16.2.2, Node (app) + Node v20.18.0 (pinned no agent),
Prisma (2 schemas: tenant `prisma/` + control `prisma-control/`), Postgres
Neon (`eu-west-2`), Vercel (deploy + cron + Blob).

---

## 2. Freeze ativo

`docs/production-freeze.md` — em vigor desde **2026-05-14**. Princípio:
**sem novos módulos durante o piloto**.

**Pode mudar sem autorização**: bugfixes, mensagens/logs/UI text, docs,
defaults inseguros, campos adicionais a outputs existentes, índices Prisma,
grants SQL do agent.

**NÃO pode sem autorização explícita documentada**: schema BD (qualquer
migration), schema tabelas SPharm escritas, conjunto de campos do INSERT,
**endpoints públicos `/api/ingest/*` `/api/outbox/*` `/api/admin/*`**,
modelo de auth, tenant resolution, orquestração de pipeline, modelo de
outbox, `ordersWriteMode`, `productLookupColumn`, **deps runtime
(package.json, major de Node/Prisma/Next)**, novos workers/queues/websockets.

Kill switches: `ordersWriteMode:"stub"`, desativar Task Scheduler,
`FEATURE_<NAME>=0`+redeploy, `npm run tenancy:deactivate -- --tenant <slug>`.

Exceção registada: **2026-05-15 — Admin Wizard v1** (scoped a UI + shell-out
aos scripts, **sem novos endpoints, sem novas deps**).

> ⚠️ **GAP DE GOVERNAÇÃO (risco):** o trabalho standalone (commits abaixo)
> foi **além** dessa exceção: adicionou endpoints `/api/admin/v1/*`, um novo
> modelo de auth (`ADMIN_API_TOKENS`) e a dep `@vercel/blob`. Todos estão na
> lista "exige autorização explícita". Foi autorizado verbalmente pelo admin
> em sessão, mas **falta uma nova entrada de exceção em
> `docs/production-freeze.md`** a documentá-lo. Acção pendente.

---

## 3. Estado do piloto Grupo Silveira

- Tenant slug: **`grupo-silveira`** · tenant id: `cmp6vbipp0000j4lqyqnkvhyc`.
- Admin email: `grp.cc.sw@sier.pt` (também `grp.cc.spharm@sier.pt`).
- Farmácias com pacote de agent já gerado: **Silveirense**, **Segurado**
  (ZIPs em `dist-agent/clients/Silveirense.zip`, `Segurado.zip` e pastas
  `grupo-silveira-2026-05-15-*`).
- **Migrations phase-1ab (compras/devoluções/fornecedores) NÃO aplicadas a
  `grupo-silveira`** — só `demo-neon` está migrado para essas tabelas
  (`notes/phase-1ab-ingest-checkpoint.md`). Aplicar a grupo-silveira exige
  autorização explícita (freeze).
- Credenciais vivas (ingest key, admin password, tenant id) estão em
  **`Slveirense.txt` na raiz do repo, em texto claro** → ver risco em §14.
- **Estado runtime exato (ACTIVE? nº farmácias ATIVO? dados ingeridos?
  último pipeline?) não está fixado neste repo** — confirmar com:
  `npm run tenancy:status -- --tenant grupo-silveira` (ou wizard → Status).

---

## 4. Multi-tenant status

- **Control plane** (`lib/control-plane.ts`, `prisma-control/`): tabela
  `Tenant` (estado PROVISIONING/ACTIVE/SUSPENDED/DEACTIVATED/FAILED,
  dbHost/dbName/dbUser/`dbPassEncrypted`, ingestApiKeyHash, heartbeat) +
  `TenantEvent` (audit) + `SyncRun`. `CONTROL_DATABASE_URL` aponta para BD
  `spharmmt_control` (Neon, mesmo projeto do `DATABASE_URL` legacy).
- Cada tenant: **BD Postgres própria**; password cifrada AES-256-GCM com
  `TENANT_ENCRYPTION_SECRET` (`lib/tenant-crypto.ts`). Connection string
  reconstruída em runtime (`buildTenantConnectionString`).
- Resolver de tenant em runtime + fallback `LEGACY_TENANT`.
- Tenants conhecidos: **`demo-neon`** (teste canónico, totalmente migrado
  incl. phase-1ab) e **`grupo-silveira`** (piloto real, base migrada,
  phase-1ab não). Lista completa: `npm run tenancy:list`.
- Provisionamento Neon: `--database-url` é o caminho primário (Neon bloqueia
  `CREATE ROLE/SET ROLE` partilhado → `--create-db` legacy só self-hosted).

---

## 5. Admin Wizard — arquitetura final

App desktop Windows (PowerShell + WinForms, compilada para `.exe` via
ps2exe) para o admin operar o piloto sem terminal. Fonte única de verdade:
`admin-wizard/SPharmMT-Admin-Wizard.ps1`; build copia para `dist-admin/`.

Dois modos (detecção automática no arranque):
- **STANDALONE** (default fora do repo): cliente **HTTPS** contra endpoints
  admin do SaaS. **Não precisa de repo/Node/npm/Git.** É a versão
  replicável para PC de instalação/cliente.
- **DEV** (dentro do repo): shell-out `npm run ...` aos scripts existentes
  (para developers). Único modo onde **Criar tenant** está disponível.

Tabs: A=Criar tenant (DEV only), B=Farmácias, C=Utilizadores, D=Agent ZIP,
E=Status/Precheck. Cabeçalho com dropdown de tenant + Refresh.

Config persistente: `%APPDATA%\SPharmMT\AdminWizard\config.json`
(`repoRoot`, `saasBaseUrl`, `adminToken`; merge-aware). Em STANDALONE os
ZIPs gerados e logs ficam em `%APPDATA%\SPharmMT\AdminWizard\{output,logs}`.

---

## 6. STANDALONE mode vs DEV mode

| | STANDALONE | DEV |
|---|---|---|
| Default | `.exe` fora do repo | dentro do repo |
| Trabalho | HTTPS → `/api/admin/v1/*` | `npm run <script>` |
| Precisa repo/Node/npm/Git | **NÃO** | sim |
| Criar tenant | não (dev/trusted) | sim |
| Segredos (control DB, encrypt key, Neon) | **só no servidor** | locais (.env) |
| Diálogo a pedir repo | **nunca** | só se forçado a DEV sem repo |

Detecção: `SPHARMMT_WIZARD_MODE=dev|standalone` (override) → senão repo
encontrado (`SPHARMMT_REPO_ROOT` ou walk-up por `package.json`) ⇒ DEV →
senão STANDALONE. 1.ª execução standalone pede endpoint SaaS + admin token,
testa via `/ping`, guarda.

---

## 7. Admin API endpoints (`/api/admin/v1/*`)

Auth: `Authorization: Bearer <ADMIN_API_TOKENS>`. Runtime nodejs,
`force-dynamic`. Lógica em `lib/admin/ops/*` (reutiliza
`lib/control-plane`, `lib/admin/tenant-client`, crypto — sem duplicar
provisioning).

| Método | Rota | Operação |
|---|---|---|
| GET | `/ping` | teste auth/ligação (+ `agentBaseConfigured`) |
| GET | `/tenants` | listar tenants (sem segredos) |
| GET | `/tenants/{slug}/status` | status estruturado |
| GET | `/tenants/{slug}/precheck` | checks go-live |
| POST | `/tenants/{slug}/farmacias` | add farmácia |
| POST | `/tenants/{slug}/users` | criar utilizador (devolve pwd se gerada) |
| POST | `/tenants/{slug}/agent-package` | emite/rotaciona key + config |

**Não há endpoint de criar-tenant** (provisioning fica dev/trusted: usa
prisma migrate + DB-admin + minutos, incompatível com função Vercel).

---

## 8. ADMIN_API_TOKENS — modelo de auth

- `lib/admin/api-token.ts`. Lê `ADMIN_API_TOKENS` (lista separada por
  vírgulas; fallback `ADMIN_API_TOKEN`). Bearer; comparação **tempo
  constante** (sha256 + `timingSafeEqual`). Sem tokens → 503 `not_configured`.
- **Distinto** da auth de sessão do `/admin` console
  (`isPlatformAdmin`: sessão ADMINISTRADOR + `PLATFORM_ADMIN_EMAILS` +
  contexto LEGACY_TENANT). O wizard usa **token**, não sessão.
- Rotação sem downtime: adicionar novo token à lista, atualizar wizards,
  remover o antigo. Gerar token: `openssl rand -hex 32`.
- Wizard guarda o token em `%APPDATA%\...\config.json`. Se inválido →
  Refresh oferece reconfigurar.

---

## 9. Agent ZIP standalone — fluxo

1. Wizard (STANDALONE) → `POST /api/admin/v1/tenants/{slug}/agent-package`
   com farmácia, endpoint, key (existente) ou `rotate`, pré-fill SQL.
2. Servidor: **resolve a farmácia na BD do tenant** (404 se não existir),
   **emite/rotaciona** a ingest key no control plane, e devolve:
   `baseAgentUrl`, `tenantSlug`, `farmaciaId`, `farmaciaNome`, `endpoint`,
   `key` (claro, se issued/rotated) + `keyAction`, `config`
   (`agent.config.json` pronto), `suggestedName`, `sqlPasswordIsPlaceholder`.
3. Wizard: **descarrega `baseAgentUrl`**, **injeta `agent.config.json`**,
   **zipa localmente** em
   `%APPDATA%\SPharmMT\AdminWizard\output\<slug>-<data>-<rand>.zip`.
   (PowerShell `Invoke-WebRequest`/`Expand-Archive`/`Compress-Archive`.)

Contrato `agent.config.json` **inalterado** (saas/sqlServer/options;
`saas.farmacia` = nome canónico da BD). O `node.exe`/runtime nunca passa
pela função Vercel.

---

## 10. Vercel Blob — arquitetura de storage

- O artefacto base (~27 MB com `node.exe`) **não cabe** numa função Vercel
  nem no limite de 25 MB do GitHub Releases → storage oficial = **Vercel
  Blob**.
- `scripts/admin/upload-agent-base.ts` (`npm run agent:publish-base`): faz
  `put()` **directo Node → Blob** (não passa por serverless, sem limite de
  4.5 MB; multipart). `access: public`, `addRandomSuffix: false`,
  `allowOverwrite: true` → **URL estável** (mesma rev sobrescreve).
- Path no blob: `agent-base/spharmmt-agent-base-rev<N>.zip`.
- Env de release: `BLOB_READ_WRITE_TOKEN` (= `vercel_blob_rw_...`), só na
  máquina que publica; o SaaS runtime **não** precisa dele.
- **Upload validado** (confirmado pelo admin: `agent:publish-base`
  operacional).

---

## 11. AGENT_BASE_ZIP_URL final

```
AGENT_BASE_ZIP_URL=https://pitdmdnei0envk00.public.blob.vercel-storage.com/agent-base/spharmmt-agent-base-rev26.zip
```

- Definir no Vercel → projeto SPharm.MT → **Settings → Environment
  Variables** → **Redeploy**.
- Consumido por `lib/admin/ops/agent-package.ts` (devolvido como
  `baseAgentUrl`). Se ausente, o endpoint devolve `baseAgentUrl=null` e o
  wizard falha a montagem com mensagem clara.

---

## 12. Release/build workflow

```powershell
# 1. Build do agent + artefacto base único (deriva rev de AGENT_REV)
npm run agent:package
#    → dist-agent/SPharmMT-Agent/  +  dist-agent/spharmmt-agent-base-rev26.zip

# 2. Publicar o base no Vercel Blob (precisa BLOB_READ_WRITE_TOKEN)
npm run agent:publish-base
#    → imprime URL pública → colar em AGENT_BASE_ZIP_URL (Vercel) + Redeploy

# 3. Build do Admin Wizard (.exe)
npm run admin-wizard:build
#    → dist-admin/SPharmMT-Admin-Wizard.exe (+ .bat fallback + .ps1 copy)

# Distribuir: copiar SÓ a pasta dist-admin/ para o PC de instalação.
```

`AGENT_REV` vive em `agent/build.mjs` (atualmente **26**). Bumpar a cada rev
que vai para farmácia real (checklist em production-freeze.md). Node pinned
v20.18.0. O base zip **não** contém dados de tenant/farmácia (só template +
`agent.config.example.json`).

---

## 13. O que está validado E2E

- `npx tsc --noEmit` → **exit 0** (backend admin completo type-checa).
- Wizard: parse-check limpo (PowerShell AST), nenhum erro de sintaxe.
- Config merge (`Save-Saas`/`Save-RepoRoot` preservam-se mutuamente) —
  round-trip testado em sandbox `%APPDATA%`.
- Cliente HTTP `Invoke-AdminApi` contra `HttpListener` local: GET+POST com
  JSON+Bearer OK; erro **401** lê corpo via `$_.ErrorDetails.Message`;
  not-configured devolve erro cedo.
- `spharmmt-agent-base-rev26.zip` gerado de facto (27 MB; conteúdo:
  node.exe, agent.cjs, wrappers, `agent.config.example.json`; **sem**
  `agent.config.json` real).
- Montagem local do ZIP por farmácia testada ponta-a-ponta:
  `New-AgentZipLocal` descarrega o base, injeta config, re-zipa → ZIP final
  26.6 MB com node.exe + agent.cjs + `agent.config.json` correto.
- **Upload Vercel Blob validado** (admin confirmou `agent:publish-base`
  operacional + URL pública em §11).

---

## 14. O que ainda falta validar

- **E2E contra o SaaS deployado**: nenhum endpoint `/api/admin/v1/*` foi
  ainda exercido contra a Vercel real (Claude não tem credenciais live).
  Requer: `ADMIN_API_TOKENS` definido no Vercel + **redeploy** com os
  commits novos, depois wizard → ping/list/status/precheck/add-farmacia/
  add-user/agent-package contra o endpoint live.
- **Confirmar que a Vercel já redeployou** o `main` com os endpoints novos.
- **Fluxo agent-package live completo** (endpoint → download do Blob real →
  montagem → ZIP) num PC de instalação limpo.
- Estado runtime do `grupo-silveira` (ACTIVE, farmácias, dados, pipeline) —
  `npm run tenancy:status -- --tenant grupo-silveira`.
- `AGENT_BASE_ZIP_URL` efetivamente definido no Vercel + redeploy aplicado.

---

## 15. Fora de scope (explícito)

- Dashboard (UI/lógica de análise).
- Ingest de produtos/stock/vendas (pipeline `/api/ingest/*`).
- Export-orders / outbox de encomendas (`/api/outbox/*`).
- Contrato agent↔SaaS (shape de `agent.config.json`, headers de auth do
  agent, endpoints de ingest/outbox).
- Workers/queues/websockets/serviços assíncronos novos.
- Criar tenant em STANDALONE (fica dev/trusted).
- Schema Prisma / migrations (sem novas; phase-1ab não aplicar a
  grupo-silveira sem autorização).

---

## 16. Regras arquiteturais obrigatórias

1. **Additive-only** durante o piloto; respeitar `docs/production-freeze.md`
   (incl. checklists migration/agent/SPharm-write + secção Rollback no PR).
2. **Reutilizar libs, não duplicar** lógica de provisioning/validação/
   segurança (endpoints e scripts chamam `lib/admin/*` + `lib/control-plane`).
3. **Segredos só no servidor**: o PC de instalação nunca recebe control DB,
   `TENANT_ENCRYPTION_SECRET` nem Neon API key. STANDALONE = HTTPS + token.
4. **Não mudar o contrato agent↔SaaS** nem o shape de respostas públicas.
5. **Confirmações destrutivas** no wizard (`CONFIRMO`/`ROTACIONAR`); secrets
   só em modal, nunca no log.
6. **Bumpar `AGENT_REV`** a cada release de agent; um único `agent-base.zip`
   por release.
7. Qualquer endpoint público novo / dep runtime / migration ⇒ **autorização
   documentada** (atualizar production-freeze.md).

---

## 17. Commits importantes e objetivo

| Commit | Objetivo |
|---|---|
| `ca3d0aa` | Admin Wizard arranca de **qualquer pasta** (resolução de repo: env `SPHARMMT_REPO_ROOT` → walk-up → config persistida → selector → erro c/ retry). Introduziu a infra de config em `%APPDATA%`. Em grande parte **superado** pelo modo STANDALONE de `5fcabd5`, mas o merge de config persiste. |
| `5fcabd5` | **Modo STANDALONE** (cliente HTTPS) + DEV; endpoints `/api/admin/v1/*` (ping + 6 ops); auth `ADMIN_API_TOKENS`; `lib/admin/ops/*`. Sem repo/Node/npm no PC. |
| `18dd4a9` | **Agent ZIP standalone fechado**: `npm run agent:package` emite `spharmmt-agent-base-rev<N>.zip` único (sem dados de tenant); endpoint resolve farmácia → `farmaciaId`/`farmaciaNome`; wizard mostra farmácia resolvida. |
| `a6794d2` | **Upload do base para Vercel Blob** (`npm run agent:publish-base`, `@vercel/blob`); storage oficial do `AGENT_BASE_ZIP_URL`. |

Branch: `main` (origin `SIERSITE/spharm-mt`). Todos pushed.

---

## 18. Onboarding de um NOVO GRUPO (tenant) — fluxo real

**Operação dev/trusted (NÃO standalone).** Pré: control plane envs OK
(`CONTROL_DATABASE_URL`, `TENANT_ENCRYPTION_SECRET`), e BD+role Neon criados
(Neon UI) para o tenant.

```powershell
# Validar ambiente
npm run env:doctor

# Criar tenant (wizard DEV tab A faz shell-out a isto):
npm run tenancy:create -- --slug <slug> --name "<Nome Grupo>" `
  --admin-email <admin@grupo.pt> --provider neon `
  --database-url "postgresql://<role>:<pw>@<host>/<db>?sslmode=require" `
  --farmacias "<Farmácia Inicial>" --json --quiet
#  → cria BD/seed/migrations + admin + ingest key. Mostra credenciais 1×.
```

Depois: anotar `TENANT_ENCRYPTION_SECRET` em vault; entregar admin password.
A partir daqui, farmácias/utilizadores/agent ZIP podem ser feitos via wizard
STANDALONE. (Provisioning não é standalone porque corre prisma migrate +
DB-admin + Neon.)

---

## 19. Onboarding de uma NOVA FARMÁCIA — fluxo real (STANDALONE)

PC de instalação, só com `dist-admin/`:

1. Abrir `SPharmMT-Admin-Wizard.exe`. 1.ª vez: endpoint SaaS + admin token.
2. Selecionar o tenant no cabeçalho.
3. **Tab B — Farmácias** → nome (+ código ANF/morada/contacto) → confirma.
   (→ `POST /api/admin/v1/tenants/{slug}/farmacias`)
4. **Tab C — Utilizadores** (opcional) → email/nome/role/farmácia → password
   gerada mostrada 1×.
5. **Tab D — Agent ZIP** → farmácia (nome exato, tem de existir) + endpoint +
   key existente **ou** `ROTACIONAR` + pré-fill SQL → **Gerar**. O wizard
   descarrega o base do Blob, injeta config e grava o ZIP em
   `%APPDATA%\SPharmMT\AdminWizard\output\`. Se rotacionou, mostra a key 1×.
6. **Tab E** → Status/Precheck para validar antes de entregar.
7. Levar o ZIP ao PC da farmácia: extrair → completar `sqlServer.password`
   no `agent.config.json` → `run-test-connection.bat` → Task Scheduler com
   `run-daily-pipeline-auto.bat`.

Equivalente DEV (CLI): `npm run tenancy:add-farmacia`, `tenancy:add-user`,
`admin:package-agent`.

---

## 20. Estado atual real do Grupo Silveira

- **Existe no control plane**: slug `grupo-silveira`, id
  `cmp6vbipp0000j4lqyqnkvhyc`, admin `grp.cc.sw@sier.pt`. Ingest key emitida
  (guardada em `Slveirense.txt`, local, claro).
- **Farmácias com agent empacotado**: **Silveirense** e **Segurado** (ZIPs
  em `dist-agent/clients/`, gerados 2026-05-15).
- **Schema phase-1ab (compras/devoluções/fornecedores) NÃO migrado** neste
  tenant — só `demo-neon` o tem. Os fluxos de compras do agent **não
  funcionam** em grupo-silveira até migrar (requer autorização — freeze).
- **Não confirmado neste repo** (precisa de runtime): estado ACTIVE,
  nº de farmácias ATIVO, se houve upload de stock/vendas, último
  daily-pipeline, dashboard populado. Verificar:
  `npm run tenancy:status -- --tenant grupo-silveira` e `pilot:precheck`.
- O `pilot-bootstrap-report.md` é um **template não preenchido** → não há
  registo de tempos/atritos reais do bootstrap do Silveira.

---

## Apêndice — Env vars (reais)

**SaaS runtime (Vercel):**
- `DATABASE_URL` (legacy/tenant default), `AUTH_SECRET`,
  `PLATFORM_ADMIN_EMAILS` — já configuradas.
- `CONTROL_DATABASE_URL` (Neon `spharmmt_control`), `TENANT_ENCRYPTION_SECRET`
  (AES, **vault**), `CRON_SECRET` (`/api/jobs/refresh-ipf`).
- **`ADMIN_API_TOKENS`** (admin API; `openssl rand -hex 32`).
- **`AGENT_BASE_ZIP_URL`** (= URL Blob em §11).
- `SPHARMMT_PUBLIC_ENDPOINT` (opcional; default do agente).
- Para criar-tenant em dev: `NEON_API_KEY`, `NEON_PROJECT_ID` (opcionais);
  legacy self-host: `POSTGRES_ADMIN_URL`, `TENANT_DB_HOST`.

**Release (máquina que publica):** `BLOB_READ_WRITE_TOKEN` (`vercel_blob_rw_…`).

**Wizard STANDALONE (PC instalação):** nenhuma env obrigatória — só o
`config.json` em `%APPDATA%` (endpoint + token, introduzidos na 1.ª vez).
Override opcional: `SPHARMMT_WIZARD_MODE`, `SPHARMMT_REPO_ROOT`.

---

## Apêndice — Riscos conhecidos

1. **Governação/freeze**: novos endpoints `/api/admin/v1/*` + `ADMIN_API_TOKENS`
   + dep `@vercel/blob` ainda **não documentados** como exceção em
   `production-freeze.md` (estão na lista que exige aprovação). → adicionar
   entrada de exceção.
2. **Segredos em claro**: `Slveirense.txt` (raiz) tem tenant id, **ingest
   key**, **admin password** e o **admin API token** em texto. Confirmar que
   está gitignored, mover para vault, e **rotacionar** o admin token (foi
   também exposto em chat). Não commitar.
3. **Sem E2E live** dos endpoints admin (ver §14). Risco de divergência
   entre o testado localmente e o comportamento na Vercel (params async,
   limites de função, env em falta).
4. **`grupo-silveira` parcialmente migrado**: compras/devoluções indisponíveis
   até migração autorizada.
5. **Dependência de `AGENT_BASE_ZIP_URL`**: se não estiver no Vercel (ou
   redeploy não feito), agent-package devolve baseAgentUrl null e o wizard
   não gera ZIP.
6. **create-tenant manual**: continua a exigir dev/trusted + Neon UI; não
   há caminho standalone (decisão deliberada).
7. **Token admin partilhado**: um token dá acesso a todas as operações admin
   de todos os tenants; usar lista de tokens (1 por instalador) para
   revogação granular.
