# Auditoria técnica — Migração SPharm.MT para VPS dedicada

**Data:** 2026-08-04 · **Âmbito:** auditoria read-only. Nada foi alterado em produção, DNS, Vercel, bases de dados ou dados.
**Método:** leitura do repositório + queries `SELECT`-only ao control plane, às 3 BDs de tenant, à BD legacy e listagem (read-only) do Vercel Blob.
**Nota:** nenhum segredo ou connection string aparece neste documento.

---

## 0. Sumário executivo

| Dimensão | Estado |
|---|---|
| Dependências Vercel **bloqueantes** | 0 (todas resolvem-se com configuração ou alterações pequenas) |
| Dependências Neon **bloqueantes** | 1 — `sslmode=require` forçado para hosts não-locais em `buildTenantConnectionString` |
| Dados totais | **≈ 4,23 GB** (control 8,6 MB + 3 tenants 4,01 GB + legacy 216 MB) |
| Crescimento real medido | **≈ 70–80 MB/mês** para o único tenant com dados reais (Grupo Silveira, 2 farmácias) |
| Backups | **inexistentes** — `Tenant.lastBackupAt = NULL` nos 3 tenants; depende 100% de PITR da Neon |
| Ingestão | **parada desde 2026-05-20** (último heartbeat de agent; último `MovimentoArtigo` em 2026-05) |
| Objecto no Blob | 17 ZIPs, **451,8 MB** — apenas o último (rev44) é necessário |

**Observação crítica não relacionada com a migração mas que a afecta:** os agentes on-prem não reportam heartbeat há ~2,5 meses. Migrar com os agentes parados é mais seguro (menos risco de escrita dupla), mas é preciso saber se estão desligados ou avariados **antes** de planear a janela de cutover.

---

## 1. Dependências da Vercel

### 1.1 `vercel.json` e cron jobs

`vercel.json` (5 crons, todos UTC):

| Schedule | Path | Multi-tenant | Guarda anti-duplicação |
|---|---|---|---|
| `0 2 * * *` | `/api/jobs/enqueue-regulatory` | sim (`forEachActiveTenant`) | sim (`SyncRun` + `isSyncRunAlreadyRunning`) |
| `30 2 * * *` | `/api/jobs/acquire-regulatory` | sim | sim |
| `0 3 * * *` | `/api/jobs/refresh-ipf` | **não — só `legacyPrisma`/`DATABASE_URL`** | **não** |
| `0 4 * * *` | `/api/jobs/enrich-catalog` | sim | sim |
| `0 5 * * *` | `/api/jobs/enrich-retail` | sim | **não** |

- Auth: `lib/jobs/cron-auth.ts` aceita `Authorization: Bearer $CRON_SECRET` **ou** `?secret=`. Não depende de nada específico da Vercel — um `curl` de um systemd timer funciona igual.
- `refresh-ipf` escreve na BD legacy, não nos tenants. Migrar isto para VPS mantém o mesmo comportamento (não é regressão, mas é uma lacuna já existente).

### 1.2 Vercel Blob

- Uso único: **template base do agente**. Upload por `scripts/admin/upload-agent-base.ts` (`@vercel/blob`, `BLOB_READ_WRITE_TOKEN`); leitura por URL pública `AGENT_BASE_ZIP_URL` devolvida por `lib/admin/ops/agent-package.ts` ao Admin Wizard, que descarrega e injecta o `agent.config.json` localmente.
- Nenhum upload de utilizador, nenhum ficheiro de negócio no Blob.
- Conteúdo actual: 17 ficheiros `agent-base/spharmmt-agent-base-revNN.zip`, 26,6 MB cada, **451,8 MB** total (rev26, rev29–rev44).

### 1.3 Runtime / Route Handlers

- **41 Route Handlers**. Todos os que declaram runtime usam `runtime = "nodejs"` — **zero Edge runtime nas rotas**.
- Único código Edge: `middleware.ts` (só parsing de Host/cookie/query; sem Prisma). Corre igual em `next start`.
- `maxDuration` declarado em 20+ rotas (30 / 60 / 120 / 300) — comentários explicam que 300 s é o tecto do plano Hobby. Em `next start` estes valores são **ignorados** (não há limite de função). Ganho, não risco — mas os jobs deixam de ter tecto e passam a precisar de timeout próprio no reverse proxy.
- `serverExternalPackages: ["puppeteer", "nodemailer"]` em `next.config.ts`.
- `export const dynamic = "force-dynamic"` generalizado → praticamente nada é pré-renderizado; sem dependência de ISR/cache da Vercel.

### 1.4 Variáveis de ambiente

Usadas em código (fonte, excluindo `node_modules`):

`DATABASE_URL`, `CONTROL_DATABASE_URL`, `TENANT_ENCRYPTION_SECRET`, `AUTH_SECRET`, `PLATFORM_ADMIN_EMAILS`, `CRON_SECRET`, `EMAIL_CONFIG_SECRET`, `ADMIN_API_TOKEN(S)`, `TENANT_FALLBACK_ENABLED`, `AGENT_BASE_ZIP_URL`, `BLOB_READ_WRITE_TOKEN`, `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_DEFAULT_REGION`, `NEON_API_BASE_URL`, `POSTGRES_ADMIN_URL`, `TENANT_DB_HOST`, `TENANT_DB_PORT`, `OUTBOX_MAX_ATTEMPTS`, `ENABLE_AGENT_BOOTSTRAP`, `FEATURE_*`, `ERP_SQLSERVER_*` (só agent/CLI), `SPHARMMT_ENDPOINT` / `SPHARMMT_PUBLIC_ENDPOINT`, `SPHARM_DEBUG_BROWSE`, `NODE_ENV`.

Específicas da Vercel (só cosmética): `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_REF` — usadas em `app/admin/pipeline/page.tsx`, `app/api/admin/pilot/summary/route.ts`, `app/api/admin/v1/ping/route.ts`, **todas com fallback** para `SAAS_GIT_COMMIT` / `SAAS_GIT_BRANCH` / `NODE_ENV`. Nenhuma alteração de código obrigatória.

`lib/env.ts` é o catálogo central e valida por scope (`web` / `cron` / `cli` / `ingest`). Está desactualizado face à realidade (não cataloga `ADMIN_API_TOKENS`, `AGENT_BASE_ZIP_URL`, `TENANT_FALLBACK_ENABLED`, `FEATURE_*`).

### 1.5 Domínio, headers, cookies, redirects

- Nenhum `redirects()`/`headers()` no `next.config.ts`. Os headers de diagnóstico (`x-tenant-mw`, `x-tenant-fallback`, `x-tenant-resolved`, `x-tenant-source`) vêm do middleware — independentes da Vercel.
- **Resolução de tenant por subdomínio** (`middleware.ts`), com `RESERVED_LABELS` a incluir literalmente `spharm-mt` porque o host de produção é `spharm-mt.vercel.app`. Numa VPS com domínio próprio esta lista tem de ser revista.
- **Fallback `?__tenant=` + cookie `__tenant`** activado por `TENANT_FALLBACK_ENABLED` — existe precisamente porque `*.vercel.app` não permite wildcard DNS (`docs/tenant-fallback.md`). Numa VPS com wildcard DNS + certificado wildcard, este fallback pode ser desligado.
- Cookie de sessão: `app/login/actions.ts:158` — `httpOnly: true, sameSite: "lax", secure: **false**, path: "/"`, sem `domain`. Funciona por IP e por HTTP; é inseguro em produção e não é partilhado entre subdomínios.
- Hostnames hardcoded: `https://app.spharmmt.app` como default de endpoint em `lib/admin/ops/agent-package.ts:106`, `scripts/admin/package-agent.ts:184`, `scripts/onboarding-wizard.ps1`, `admin-wizard/SPharmMT-Admin-Wizard.ps1:1046,1498`. `spharm-mt.vercel.app` só em comentários/docs.

### 1.6 Image optimization

Sem dependência. `next/image` é usado em 3 sítios (`components/catalogo/catalogo-list-client.tsx`, `app/catalogo/artigo/[cnp]/page.tsx`, `app/stock/artigo/[cnp]/page.tsx`) e **todos passam `unoptimized`** — por isso não há `images.remotePatterns` no `next.config.ts` e não é preciso `sharp` nem loader externo.

### 1.7 Limites e timeouts assumidos

- `maxDuration` (ver 1.3) — os comentários assumem tecto Hobby 300 s.
- Corpo dos pedidos de ingest: o agent faz batching (default 500 → 100 desde rev35, com auto-shrink até 25 e retry/backoff em 502/503/504) precisamente por causa dos limites de função da Vercel. Numa VPS os batches podem voltar a crescer, mas nada obriga a mexer.
- `agent/src/http-client.ts`: timeout 30 s por chamada, sem retry interno (o retry vive nos comandos).
- Cold start da Neon é referido em vários comentários como justificação para timeouts largos.

### 1.8 Ficheiros / scripts de deploy

- `.vercel/repo.json` (projeto `spharm-mt`, org `team_242OaV9Ek…`) — deploy por integração Git (`github.com/SIERSITE/spharm-mt`).
- `package.json` → `"build": "prisma generate && prisma migrate deploy && next build"`. **O build aplica migrações à `DATABASE_URL` (a BD legacy) e a mais nenhuma.** Os tenants só migram via `npm run tenancy:migrate-all`.
- Sem Dockerfile, sem `output: "standalone"` no `next.config.ts`.

---

## 2. Dependências do Neon

### 2.1 Connection strings

Três origens, nenhuma delas com URL de tenant em ficheiro:

1. `DATABASE_URL` — BD legacy / fallback (`lib/prisma.ts`, `lib/tenant-registry.ts`, todos os scripts CLI via `legacyPrisma`).
2. `CONTROL_DATABASE_URL` — control plane (`lib/control-plane.ts`).
3. Por tenant — construída em runtime por `buildTenantConnectionString()` a partir de `Tenant.dbHost/dbPort/dbName/dbUser/dbPassEncrypted`, com a password decifrada (AES-256-GCM, `TENANT_ENCRYPTION_SECRET`, `lib/tenant-crypto.ts`).

Ficheiros `.env`, `.env.local`, `.env.production.local` contêm apenas as duas primeiras (+ tokens). Todas usam `sslmode=require&channel_binding=require` e hosts `-pooler`.

### 2.2 Control plane

- Schema próprio (`prisma-control/schema.prisma`, 4 migrações), cliente gerado em `generated/prisma-control`.
- Modelos: `Tenant`, `TenantEvent`, `SyncRun`, `GlobalAdmin`, `GlobalAdminTenant`.
- Tamanho: **8,6 MB**. `Tenant`=3 linhas, `TenantEvent`=27, `SyncRun`=3.

### 2.3 Bases por tenant

| slug | estado | dbName | tamanho | último heartbeat de agent |
|---|---|---|---|---|
| `demo-neon` | ACTIVE | `spharmmt_t_demo_neon` | 44 MB | 2026-05-18 |
| `grupo-silveira` | ACTIVE | `spharmmt_t_grupo_silveira` | **3 955 MB** | 2026-05-20 |
| `piloto-demo` | ACTIVE | `spharmmt_t_piloto_demo` | 10 MB | nunca |

Todos com `schemaVersion = 0000_produto_farmacia_taxa_iva`, `lastMigratedAt = 2026-06-01`, `ingestApiKeyHash` presente, `lastBackupAt = NULL`.

### 2.4 Pooling

- Os 3 tenants têm `dbHost` com sufixo `-pooler` (PgBouncer transaction mode da Neon), porta 5432.
- `lib/pipeline/advisory-lock.ts` usa deliberadamente `pg_try_advisory_xact_lock` (transaction-scoped) por compatibilidade com o pooler — continua correcto com PgBouncer self-hosted ou com ligação directa.
- Não há `connection_limit` nem `pgbouncer=true` nas URLs.

### 2.5 Adapters Prisma

- `@prisma/adapter-pg` (`PrismaPg`) em **todos** os pontos: `lib/prisma.ts`, `lib/tenant-registry.ts`, `lib/control-plane.ts`, `lib/integracao/auth.ts`, scripts. **Não há `@prisma/adapter-neon` nem driver WebSocket da Neon** → o transporte já é `pg` TCP puro, compatível com Postgres self-hosted sem alteração de código.

### 2.6 Scripts que assumem Neon

- `lib/db-providers/neon.ts` + `select.ts`: com `NEON_API_KEY`+`NEON_PROJECT_ID` presentes, o auto-detect escolhe **sempre** `NeonProvider` para provisionar novos tenants. Com `POSTGRES_ADMIN_URL`+`TENANT_DB_HOST` e sem as chaves Neon, escolhe `LocalPostgresProvider` — **o provider self-hosted já existe e está implementado** (`lib/db-providers/local-postgres.ts`: `CREATE ROLE` + `CREATE DATABASE` + `GRANT`).
- Consumidores: `scripts/tenancy/provision-tenant.ts`, `scripts/tenancy/onboard-tenant.ts`, `scripts/admin/create-client.ts`, `lib/admin/create-client-workflow.ts`.
- ~40 scripts CLI usam `legacyPrisma` (`DATABASE_URL`) e não iteram tenants — ver `notes/infra-hardening-plan.md` §5.

### 2.7 Migrações

- Tenant: `prisma/migrations` — **28 migrações**, última `20260601120000_produto_farmacia_taxa_iva`.
- Control: `prisma-control/migrations` — 4, última `20260804083752_add_sync_run_heartbeat`.
- Configs separadas (`prisma.config.ts` / `prisma-control.config.ts`) com `migrations.path` distinto — necessário no Prisma 7 para não aplicar migrações da app ao control plane.
- Aplicação em todos os tenants: `npm run tenancy:migrate-all` (paralelo, não aborta no 1.º erro, regista `TenantEvent`).

### 2.8 Backups / branches

Nenhuma automação no repositório. `lastBackupAt` é `NULL` nos 3 tenants; o campo existe mas ninguém o escreve. O único mecanismo de recuperação hoje é o PITR da Neon — **que desaparece na VPS**.

---

## 3. Serviços externos

| Serviço | Onde | Direcção | Nota para VPS |
|---|---|---|---|
| SMTP (nodemailer) | `lib/email-config.ts`, `lib/reporting/report-email-transport.ts`, `/api/reports/email`, `/api/settings/email` | saída 465/587 | Credenciais em BD (`EmailConfig`) cifradas com `EMAIL_CONFIG_SECRET`. Sem vendor. Muitos providers de VPS bloqueiam 25/465/587 por omissão. |
| INFOMED / INFARMED | `extranet.infarmed.pt/INFOMED-fo/*` — `lib/regulatory-sources/*`, `lib/jobs/regulatory-acquisition.ts`, ~15 scripts, Puppeteer | saída HTTPS | Rate-limit 1,5 s/CNP + cooldown 30 s. O IP muda → reputação/bloqueios possíveis. |
| Open Food Facts / Open Beauty Facts | `world.openfoodfacts.org`, `world.openbeautyfacts.org` — `lib/jobs/retail-enrichment.ts`, `lib/catalog-connectors.ts` | saída HTTPS | Sem chave. |
| lojadafarmacia.com | `lib/catalog-connectors.ts` (imagens/retail) | saída HTTPS | — |
| DuckDuckGo HTML | scripts de enriquecimento | saída HTTPS | — |
| EUDAMED (`ec.europa.eu/tools/eudamed`) | conector regulatório | saída HTTPS | — |
| Vercel Blob | `scripts/admin/upload-agent-base.ts` (escrita), Admin Wizard (leitura via `AGENT_BASE_ZIP_URL`) | ambos | Substituível por ficheiro estático servido pelo nginx. |
| Neon API | `lib/db-providers/neon.ts` (`console.neon.tech/api/v2`) | saída HTTPS | Só em provisionamento. |
| healthchecks.io (`hc-ping.com`) | `healthcheckUrl` no `agent.config.json` | saída, do PC da farmácia | Não passa pelo SaaS. |
| **Agentes Windows on-prem** | `POST` para `SPHARMMT_ENDPOINT` → `/api/ingest/v1/*`, `/api/outbox/v1/*` | **entrada** | **A dependência inbound crítica.** |
| SQL Server das farmácias | `agent/src/sql-client.ts` (mssql) | LAN da farmácia | Nunca toca no SaaS directamente. |

Webhooks/callbacks entrantes de terceiros: **nenhum**. A única entrada autenticada é a dos agentes (`Authorization: Bearer <ingestKey>` + `X-Tenant-Slug`, bcrypt contra `Tenant.ingestApiKeyHash`, `lib/integracao/auth.ts`) e a do Admin Wizard (`ADMIN_API_TOKENS`, `lib/admin/api-token.ts`).

---

## 4. Processos da aplicação

| Processo | Como corre hoje | Na VPS |
|---|---|---|
| Web Next.js 16.2.2 | Funções Vercel | `next start` (ou `output: "standalone"`) atrás de nginx |
| 5 crons | Vercel Cron → HTTP + `CRON_SECRET` | systemd timer / cron + `curl -H "Authorization: Bearer …"` |
| Workers longos | `scripts/workers/enrichment-worker.ts`, `scripts/workers/regulatory-acquisition-worker.ts` — **manuais**, com graceful shutdown SIGINT/SIGTERM | candidatos naturais a unidades systemd |
| Jobs one-shot | `scripts/jobs/daily-enrich.ts`, `weekly-reverify.ts`, `refresh-ipf.ts` — manuais | idem |
| Ingestão dos agentes | agentes Windows (Task Scheduler diário, `docs/daily-pipeline-task-scheduler.md`) → `/api/ingest/v1/*` | inalterada, desde que o endpoint continue a resolver |
| Outbox | agente faz pull a `/api/outbox/v1/orders/pending` a cada 5 min; ack/nack/retry/cancel/release; lease + `idempotencyKey`; `OUTBOX_MAX_ATTEMPTS` | inalterada |
| Enriquecimento | crons `enrich-catalog`, `enqueue/acquire-regulatory`, `enrich-retail` + workers | inalterada |
| Migrações | `prisma migrate deploy` no build (só legacy) + `tenancy:migrate-all` manual | separar do build |
| Relatórios | `/api/reports/pdf` (Puppeteer, browser singleton) e `/api/reports/email` (nodemailer) | Chromium precisa de libs do sistema |
| Scripts administrativos | ~50 scripts `tsx` + Admin Wizard PowerShell contra `/api/admin/v1/*` | inalterados (mudam envs) |

---

## 5. Dados e armazenamento

### 5.1 Tamanhos medidos (2026-08-04)

| Base | Tamanho | Maiores tabelas (total c/ índices) |
|---|---|---|
| Control plane | 8,6 MB | `SyncRun` 80 kB, `Tenant` 80 kB, `TenantEvent` 64 kB |
| `grupo-silveira` | **3 955 MB** | `IngestStocksMovRaw` 2 648 MB (2 089 785 linhas), `MovimentoArtigo` 594 MB (795 390), `IngestVendaLinhaRaw` 427 MB (544 118), `VendaMensal` 93 MB (145 217), `StagingCompraRawLine` 62 MB, `Compra` 56 MB, `ProdutoFarmacia` 32 MB, `Produto` 22 MB |
| `demo-neon` | 44 MB | `ProdutoFarmacia` 16 MB (31 120), `Produto` 14 MB (31 123), `IngestVendaLinhaRaw` 1,8 MB |
| `piloto-demo` | 10 MB | vazia (só 1 `Farmacia`) |
| Legacy (`DATABASE_URL`) | 216 MB | `RegulatoryRecord` 71 MB (283 337), `VendaMensal` 56 MB (147 914), `EnrichmentSourceLog` 20 MB, `ProdutoVerificacaoHistorico` 13 MB, `InfarmedSnapshot` 12 MB |
| **Total** | **≈ 4,23 GB** | |

### 5.2 Crescimento estimado com dados reais

Contagens mensais reais em `grupo-silveira`:

- `MovimentoArtigo` por `dataMovimento`: 2025-08 34 334 · 2025-09 28 481 · 2025-10 28 574 · 2025-11 24 167 · 2025-12 27 597 · 2026-01 28 845 · 2026-02 24 287 · 2026-03 28 411 · 2026-04 39 050 · 2026-05 15 180 (mês parcial — ingestão parou)
- `IngestVendaLinhaRaw` por `dataVenda`: ~17 000–25 000/mês, média ≈ 19 500
- `IngestStocksMovRaw`: 2 091 368 linhas todas com `ingestedAt` em 2026-05 → foi backfill histórico, não ritmo mensal

Densidade medida: `MovimentoArtigo` ≈ 780 B/linha, `IngestVendaLinhaRaw` ≈ 800 B/linha, `IngestStocksMovRaw` ≈ 1,33 kB/linha (tudo já com índices).

| Componente | Linhas/mês | MB/mês |
|---|---|---|
| `MovimentoArtigo` | ~29 000 | ~22 |
| `IngestStocksMovRaw` (raw correspondente) | ~29 000 | ~37 |
| `IngestVendaLinhaRaw` | ~19 500 | ~15 |
| `VendaMensal` + `Compra` + staging | — | ~5 |
| **Total por grupo de 2 farmácias** | | **≈ 75–80 MB/mês (≈ 0,9 GB/ano)** |

Projecção de disco: hoje 4,2 GB; com 10 grupos do tamanho do Grupo Silveira ≈ 40 GB + ~9 GB/ano. Com retenção de backups comprimidos (~30 %) e WAL, **um volume de 200 GB dá folga confortável** para 3–4 anos ao ritmo actual. O `IngestStocksMovRaw` é 67 % da maior base e é staging — uma política de retenção (ex.: 90 dias) corta o crescimento para menos de metade.

### 5.3 Ficheiros fora da base

- **Vercel Blob**: 17 ZIPs de agente, 451,8 MB. Só o `rev44` é necessário; os restantes são histórico descartável.
- **Repositório**: `scripts/data/*.json` (mapeamentos INFOMED e capturas de spike), `public/` 663 kB, `dist-agent/`, `dist-admin/`.
- **Logs**: `logs/` local com 53 kB (2 ficheiros de 2026-05, de execuções do wizard). Não há logs persistidos em produção — a Vercel não os retém para lá da consola e nada escreve para disco a partir das rotas.
- **Volumes persistentes**: nenhum. Nada na aplicação web escreve no filesystem excepto o Puppeteer (temporários).

---

## 6. Compatibilidade com VPS

Legenda: **A** = funciona sem alterações · **B** = necessita configuração · **C** = necessita alteração de código · **D** = bloqueador

| # | Componente | Cl. | Justificação |
|---|---|:--:|---|
| 1 | Next.js 16 / Route Handlers (`runtime = nodejs`) | A | `next start` cobre tudo; nada de Edge nas rotas |
| 2 | `middleware.ts` | A | só Host/cookie/query; corre em `next start` |
| 3 | `RESERVED_LABELS` com `spharm-mt` | C | rever para o novo domínio |
| 4 | Prisma + `@prisma/adapter-pg` | A | TCP puro, sem driver Neon |
| 5 | Control plane (schema + migrações) | A | `pg_dump`/`pg_restore` directo |
| 6 | BDs por tenant | B | restore + `UPDATE Tenant.dbHost/dbUser` + re-cifrar passwords |
| 7 | `buildTenantConnectionString` (`sslmode=require` para hosts não-locais) | **D** | com Postgres na VPS sem TLS e `dbHost` ≠ localhost, **todas** as ligações de tenant falham. Ou se activa TLS no Postgres, ou se usa `127.0.0.1` (`LOCAL_HOST_REGEX` já isenta), ou se torna o modo SSL configurável |
| 8 | Pooling (hosts `-pooler`) | B | instalar PgBouncer (transaction mode) ou ligar directo; `pg_try_advisory_xact_lock` é compatível com ambos |
| 9 | Provisionamento de tenants | B | `LocalPostgresProvider` já existe; basta remover `NEON_API_KEY`/`NEON_PROJECT_ID` e definir `POSTGRES_ADMIN_URL` + `TENANT_DB_HOST` |
| 10 | 5 crons | B | systemd timers + `curl` com `CRON_SECRET`; endpoints não mudam |
| 11 | Single-flight de `refresh-ipf` e `enrich-retail` | C | sem `SyncRun`; sobreposição possível se cron duplicar |
| 12 | Workers longos | B | unidades systemd (já têm graceful shutdown) |
| 13 | Ingestão dos agentes | B | depende só do hostname/TLS resolver para a VPS |
| 14 | Outbox | A | mesma auth, mesmos endpoints |
| 15 | Vercel Blob | B/C | B se se mantiver o Blob; C se se servir o ZIP do nginx (mudar `AGENT_BASE_ZIP_URL` + `upload-agent-base.ts`) |
| 16 | Puppeteer (`/api/reports/pdf`) | B | Chromium + libs (`libnss3`, `libatk`, fontes) e `--no-sandbox` já activo |
| 17 | nodemailer | B | portas SMTP de saída abertas |
| 18 | `next/image` | A | tudo `unoptimized` |
| 19 | Cookie de sessão `secure: false` | C | com TLS deve passar a `secure: true` (via env) |
| 20 | Multi-tenant por subdomínio | B | wildcard DNS + certificado wildcard; ou manter o fallback `?__tenant`+cookie |
| 21 | `build` com `prisma migrate deploy` | C | separar migração do build |
| 22 | `VERCEL_ENV` / `VERCEL_GIT_*` | A | já têm fallback `SAAS_GIT_*` |
| 23 | Endpoint default `app.spharmmt.app` hardcoded | C | passar a env em 2 ficheiros TS + wizard PS1 |
| 24 | Backups | **D** | perde-se o PITR da Neon sem substituto |
| 25 | Deploy (integração Git Vercel) | B | build+restart na VPS (systemd/PM2/Docker); considerar `output: "standalone"` |

---

## 7. Riscos

| Risco | Prob. | Impacto | Mitigação |
|---|:--:|:--:|---|
| **Perda de dados no restore** — 4 GB, `IngestStocksMovRaw` com 2,1 M linhas | média | crítico | `pg_dump -Fc` por base + verificação de contagens por tabela antes do cutover; manter Neon intacta até validação |
| **Escrita simultânea Neon + VPS** (agentes a apontar para o endpoint antigo durante a migração) | **alta** | crítico | freeze: desligar as Tasks nos PCs das farmácias **ou** pôr os endpoints de ingest a 503 (`ENABLE_AGENT_BOOTSTRAP=0`) antes do dump; só reactivar depois do cutover de DNS |
| **Cron duplicado** — crons Vercel a continuar durante o período de coexistência | alta | alto | remover `vercel.json` (ou pausar os crons) **no mesmo passo** em que se activam os timers da VPS; `refresh-ipf` e `enrich-retail` não têm guarda de concorrência |
| **Tenant errado** — `getTenantPrismaOrLegacy` cai silenciosamente no legacy quando o slug não resolve; `DATABASE_URL` na VPS a apontar para a base errada escreve dados no sítio errado sem erro | média | crítico | validar `x-tenant-resolved` por tenant antes de abrir ao público; considerar falhar em vez de cair no legacy em produção |
| **Cache de tenants desactualizada** — o registry só carrega tenants ACTIVE no arranque | média | médio | reiniciar o serviço após cada provisionamento |
| **Indisponibilidade dos agentes** — endpoint gravado no `agent.config.json` de cada PC | média | alto | manter o mesmo hostname e mudar só o DNS; TTL baixo antes do cutover; nunca migrar para IP nu |
| **Login por IP sem domínio** — cookie `secure:false` e sem `domain`; sessão vinculada ao slug do tenant | alta se se testar por IP | alto | testar sempre por hostname com TLS; activar `secure` por env quando houver HTTPS |
| **Builds pesados na VPS** — `next build` + `prisma generate` + `puppeteer` (Chromium ~170 MB) na mesma máquina que serve tráfego e Postgres | alta | médio | build fora de horas ou noutra máquina/CI; ≥4 GB RAM; `PUPPETEER_SKIP_DOWNLOAD` com Chromium do sistema |
| **Falta de backups** — hoje já não existem (`lastBackupAt` NULL); na VPS deixa de haver PITR | **certa** | crítico | `pg_dump` diário + WAL archiving (`pgBackRest`/`wal-g`) + cópia fora da máquina **antes** de desligar a Neon |
| **Segredos** — `.env`, `.env.local`, `.env.production.local` no disco de dev; `TENANT_ENCRYPTION_SECRET` decifra as passwords de todas as BDs de tenant | média | crítico | ficheiro de env com `0600` e owner do serviço; rotação de `CRON_SECRET`/`ADMIN_API_TOKENS` no cutover; **`TENANT_ENCRYPTION_SECRET` não pode ser rodado sem re-cifrar `Tenant.dbPassEncrypted`** |
| **Ingestão parada desde 2026-05-20** | confirmada | alto | apurar a causa antes de migrar — se os agentes forem reactivados a meio da migração, cai-se no risco de escrita dupla |

---

## 8. Entrega

### 8.1 Bloqueadores (a resolver antes de qualquer cutover)

1. **`sslmode=require` forçado** em `lib/control-plane.ts` para hosts não-locais → decidir entre TLS no Postgres da VPS, `dbHost=127.0.0.1`, ou tornar o modo SSL configurável.
2. **Ausência de estratégia de backups** → sem PITR da Neon, um restore falhado é perda definitiva.
3. **Controlo do hostname dos agentes** → sem manter `app.spharmmt.app` (ou o domínio que os `agent.config.json` já têm), o cutover exige tocar em cada PC de farmácia.

### 8.2 Alterações mínimas necessárias

| # | Alteração | Ficheiros |
|---|---|---|
| 1 | Modo SSL / host configurável na connection string dos tenants | `lib/control-plane.ts` |
| 2 | Cookie de sessão `secure` por env | `app/login/actions.ts` |
| 3 | Endpoint default do agente vindo de env | `lib/admin/ops/agent-package.ts:106`, `scripts/admin/package-agent.ts:184`, `admin-wizard/SPharmMT-Admin-Wizard.ps1`, `scripts/onboarding-wizard.ps1` |
| 4 | `RESERVED_LABELS` para o novo domínio | `middleware.ts` |
| 5 | Separar `prisma migrate deploy` do `build` | `package.json` |
| 6 | `output: "standalone"` (opcional, simplifica o deploy) | `next.config.ts` |
| 7 | Guarda `SyncRun` em `refresh-ipf` e `enrich-retail` | `app/api/jobs/refresh-ipf/route.ts`, `app/api/jobs/enrich-retail/route.ts` |
| 8 | Substituir Blob por ficheiro estático (se se largar o Blob) | `scripts/admin/upload-agent-base.ts`, `lib/admin/ops/agent-package.ts` |
| 9 | Catálogo de env actualizado + `env:doctor` para o perfil VPS | `lib/env.ts`, `scripts/env-doctor.ts` |
| 10 | Remover/pausar crons da Vercel ao activar os timers | `vercel.json` (apagar) |
| **Novos** | unidades systemd (web + 2 workers + 5 timers), `nginx.conf`, script de backup, `.env` do serviço | `deploy/` (a criar) |

Sem alterações: Prisma/adapters, `lib/integracao/auth.ts`, todos os endpoints de ingest/outbox, agentes, `next/image`, `lib/db-providers/local-postgres.ts`.

### 8.3 Sequência recomendada

1. **Preparar a VPS** — Postgres 17 + PgBouncer + nginx + Node 24; volume ≥ 200 GB; firewall (443 aberto; 5432 fechado ao exterior).
2. **Backup verificado da Neon** — `pg_dump -Fc` das 3 BDs de tenant + control + legacy, guardado fora da VPS, com contagens por tabela registadas.
3. **Aplicar as alterações mínimas** (8.2) em branch, com o comportamento actual preservado por defeito (envs novas com defaults iguais aos de hoje).
4. **Dry-run em staging na VPS** — restaurar as bases, apontar o serviço, correr `tenancy:migrate-all --dry-run`, `tenancy:health`, `pipeline:health`, login, dashboard, `/api/admin/v1/ping`. **A Neon continua a ser a fonte de verdade.**
5. **Testar ingestão contra a VPS** com um agente de teste apontado ao host novo (nunca a produção).
6. **Freeze** — parar as Tasks dos agentes, pausar os crons da Vercel, confirmar zero `SyncRun` RUNNING.
7. **Dump final e restore** com a produção quieta; `UPDATE Tenant` (host/user/password re-cifrada) no control plane novo; verificar contagens tabela a tabela.
8. **Cutover de DNS** com TTL previamente baixado; certificado emitido (wildcard se se quiser subdomínio por tenant); Vercel fica de pé mas com ingest a 503 para impedir escritas.
9. **Reactivar** timers, workers e Tasks dos agentes; observar 48 h (`/admin/pipeline`, `SyncRun`, heartbeats).
10. **Desligar a Vercel e a Neon** só depois de 7–14 dias estáveis e com o primeiro ciclo de backups da VPS validado por um restore de teste.

### 8.4 Plano de rollback

- **Até ao passo 7**: rollback é não fazer nada — a Neon nunca deixou de ser a fonte de verdade.
- **Entre 8 e 9** (janela crítica): reverter o DNS para a Vercel, repor `ENABLE_AGENT_BOOTSTRAP=1`, re-activar os crons. Os agentes reenviam o dia em falta (a ingestão é idempotente por `ingestRunId`/UPSERT). Perda máxima = escritas feitas na VPS durante a janela; para as recuperar, exportar as tabelas afectadas antes de reverter.
- **Depois do passo 9**: rollback deixa de ser gratuito — há dados novos só na VPS. Nesse ponto o caminho é corrigir na VPS, não voltar atrás; por isso os passos 4–7 têm de ser exaustivos.
- **Condições de aborto**: divergência de contagens no restore, `tenancy:health` a falhar em qualquer tenant, agentes com 4xx/5xx persistentes, ou primeiro backup da VPS não restaurável.
