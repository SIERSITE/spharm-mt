# Local Agent SQL Server — Execution Plan

**Versão:** 2026-05-12 · **Status:** v0.1 consolidação inicial entregue, mapping pendente do discovery real

Plano focado da consolidação do **Local Agent SQL Server** como caminho principal de sync para o piloto SPharm ERP. O folder/file mode permanece apenas como fallback ([`ingestion-agent-folder-mode.md`](ingestion-agent-folder-mode.md)).

Arquitectura conceptual: [`local-agent-architecture.md`](local-agent-architecture.md).

---

## 1. Decisões arquitecturais consolidadas

### 1.1 Standalone deliberado

Agent vive em `agent/` no monorepo durante dev, **sem importações de `lib/*`**. Garante:
- Deployable como pacote separado (`npm install @spharmmt/agent` ou binário Windows)
- Sem Next.js runtime, sem Prisma, sem React
- Apenas `mssql` + `dotenv` + node ≥ 20 (fetch nativo)

```
agent/
  package.json          # @spharmmt/agent v0.1.0
  tsconfig.json         # ES2022 + NodeNext
  README.md             # quick start
  .env.example          # template completo
  .gitignore            # output/, .env, node_modules
  src/
    cli.ts              # subcommand router
    config.ts           # env loading + ConfigError tipado
    http-client.ts      # SaasClient (fetch + auth headers)
    sql-client.ts       # mssql ConnectionPool wrapper
    commands/
      test-connection.ts
      discover.ts       # canónico — substitui scripts/erp/ legacy
      health.ts
  output/               # gitignored — ficheiros gerados (discovery, jsonl)
```

### 1.2 Boundary: o que o agent NÃO sabe

| Não sabe | Razão |
|---|---|
| Que tenants existem | Só conhece o seu `SPHARMMT_TENANT_SLUG` |
| Endereço de Neon / control plane | Falará apenas com a SaaS pública por HTTPS |
| Schema da BD tenant | Mapeia ERP → API; o SaaS escreve no DB |
| Outras farmácias do grupo | Cada agent ↔ uma farmácia (bind via `SPHARMMT_FARMACIA`) |
| Credenciais cross-tenant | Ingest key é bound ao tenant; futuramente à farmácia |

### 1.3 Read-only contra ERP

- Login SQL Server dedicado com role `db_datareader` apenas
- Sem `INSERT`/`UPDATE`/`DELETE` em nenhum code path
- mssql config com `enableArithAbort: true`, `requestTimeout: 30s`, `connectionTimeout: 15s`
- Discovery só toca em `sys.*` e `DATABASEPROPERTYEX`; sem `SELECT *` em tabelas de negócio (apenas `MIN(date)`/`MAX(date)` em candidatos)

### 1.4 Autenticação tenant-aware

Cada chamada HTTP à SaaS leva:
- `Authorization: Bearer <SPHARMMT_INGEST_KEY>`
- `X-Tenant-Slug: <SPHARMMT_TENANT_SLUG>`
- `User-Agent: spharmmt-agent/<version>` (rastreabilidade nos logs SaaS)

Server-side, `withIntegrationAuth` (PR1 anterior) verifica o hash bcrypt da key contra `Tenant.ingestApiKeyHash` E confirma que o slug bate. Falha → 401 ou 404 com mensagem genérica (sem leak de existência de outros tenants).

---

## 2. Comandos v0.1 (entregues)

| Comando | Estado | Função |
|---|---|---|
| `test-connection` | ✅ entregue | Pré-flight: envs + SQL `SELECT 1` + SaaS heartbeat + `/api/ingest/v1/farmacias`. Mensagens accionáveis por tipo de erro. Exit 0/1. |
| `discover` | ✅ entregue | Lê metadata SQL Server, classifica candidatos por nome, output JSON + Markdown em `agent/output/`. Substitui `scripts/erp/spharm-sqlserver-discover.ts` (removido). |
| `health` | ✅ entregue | Resumo verboso para diagnose remoto. Hostname, versão Node, config (mascarada), SQL version+collation+edition, SaaS heartbeat+farmacias. Não atira mesmo com falhas parciais. |

Pendentes (próxima iteração, após mapping):

| Comando | Quando | Função |
|---|---|---|
| `bootstrap` | Após mapping | Importa histórico completo (default 24 meses). Itera entidades. Idempotente via hash sha256 + `LoteIngestao` server-side. |
| `daily-sync` | Após bootstrap validado | Incremental usando cursor server-side em `SyncRun.metaJson`. Refresh IPF no fim. |

---

## 3. Variáveis de ambiente

Tudo em `.env` local do servidor on-premise. **Nunca commitar.**

### 3.1 Obrigatórias (qualquer comando que fale com a SaaS ou SQL)

| Env | Scope | Notas |
|---|---|---|
| `SPHARMMT_ENDPOINT` | SaaS | URL pública, formato `https://...`. Validado no startup. |
| `SPHARMMT_TENANT_SLUG` | SaaS | Slug do tenant (header `X-Tenant-Slug`). |
| `SPHARMMT_INGEST_KEY` | SaaS | 64 chars hex. Mascarada em todos os logs. |
| `ERP_SQLSERVER_HOST` | SQL | Hostname/IP. Para instâncias nomeadas, expor TCP/IP e usar porta. |
| `ERP_SQLSERVER_DATABASE` | SQL | Nome da BD SPharm. |
| `ERP_SQLSERVER_USER` | SQL | Login dedicado read-only. |
| `ERP_SQLSERVER_PASSWORD` | SQL | Mascarada nos logs. |

### 3.2 Opcionais

| Env | Default | Função |
|---|---|---|
| `ERP_SQLSERVER_PORT` | `1433` | Porta. |
| `ERP_SQLSERVER_ENCRYPT` | `0` | `1` liga TLS no SQL Server. |
| `ERP_SQLSERVER_TRUST_CERT` | `1` | `1` aceita self-signed (LAN). |
| `SPHARMMT_FARMACIA` | unset | CUID OR nome legível. Resolução automática para CUID via `/api/ingest/v1/farmacias` na primeira chamada. |
| `SPHARMMT_AGENT_OUTPUT_DIR` | `agent/output/` | Override do directório de output. |
| `SPHARMMT_AGENT_VERSION` | `0.1.0` | Versão reportada no User-Agent. |

### 3.3 Validação

`config.ts:loadConfig(scope)` aceita `scope = "saas" | "sql" | "both"` e atira `ConfigError` listando **todas** as envs em falta (não na primeira). Mensagens incluem hint para `.env.example`.

---

## 4. Pipeline conceptual (futuro `bootstrap`)

```
┌──────────────────────────────────────────────────────────────────┐
│                      spharmmt-agent bootstrap                     │
├──────────────────────────────────────────────────────────────────┤
│ 1. test-connection (reusa o comando v0.1)                         │
│ 2. POST /api/outbox/v1/sync-run/start → syncRunId                 │
│ 3. Para cada entidade no mapping (ordem: produtos → stock →       │
│                    vendas → compras → devoluções → ajustes →      │
│                    inventário):                                   │
│      a. Query SQL Server: SELECT … FROM <table> WHERE <date> >=   │
│         <since> (cursor server-side se daily-sync)                │
│      b. Mapear ERP rows → SPharm.MT payload schema                │
│      c. Particionar em chunks de 5k linhas                        │
│      d. Para cada chunk:                                          │
│           sha256(JSON canónico) → hash                            │
│           POST /api/ingest/v1/snapshot/<entity>                   │
│           body: { farmaciaId, hash, syncRunId, rows: [...] }      │
│           Server responde: { status: processed|duplicate|failed } │
│      e. Append JSONL local em output/agent.log.jsonl              │
│ 4. POST /api/outbox/v1/sync-run/complete                          │
│ 5. POST /api/jobs/refresh-ipf?tenant=<slug> (best-effort)         │
└──────────────────────────────────────────────────────────────────┘
```

Daily-sync: igual mas (a) usa `WHERE <date> > <cursor>` onde cursor vem do último SyncRun completado com sucesso para esta entidade+farmácia.

---

## 5. Operacionalização Windows

### 5.1 Instalação inicial

```bash
cd /caminho/para/spharmmt-agent
npm install                  # uma vez
copy .env.example .env       # editar com credenciais
notepad .env                 # preencher 7 obrigatórias + 1 farmacia
npm run test-connection      # valida tudo
```

### 5.2 Discovery one-shot

```bash
npm run discover
# → agent/output/spharm-sqlserver-discovery.json
# → agent/output/spharm-sqlserver-discovery.md
```

Output Markdown contém:
- Top 20 tabelas por row count
- Tabelas classificadas por categoria candidata (produtos, stocks, vendas, …)
- Detalhe das 4 primeiras tabelas por categoria com PK, colunas, índices, date ranges
- FKs declaradas (relações pode ser implícitas no app code do SPharm)
- Triggers de utilizador

### 5.3 Agendamento (futuro daily-sync)

| Opção | Quando |
|---|---|
| Windows Task Scheduler | Piloto. Trigger uma vez por dia (3:00 AM local) chamando `npm run agent daily-sync`. |
| Serviço Windows via `nssm` | Quando piloto provar valor — uptime garantido. |
| Binário standalone com `pkg`/`bun build --compile` | Distribuição em escala (PR futuro). |

---

## 6. Roadmap

| Passo | Estado | Notas |
|---|---|---|
| 1. Estrutura `agent/` standalone | ✅ entregue | `package.json`, `tsconfig`, `.env.example`, README |
| 2. Comandos `test-connection`, `discover`, `health` | ✅ entregue | Validados via tsc; smoke real requer SQL Server da farmácia |
| 3. Discovery real na farmácia | ⏳ aguarda operador | Operador corre `npm run discover` no servidor on-premise + cola output |
| 4. Mapping ERP → SPharm.MT por entidade | ⏳ depende de #3 | `notes/erp-direct-sync-mapping.md` (futuro) |
| 5. Comando `bootstrap` | ⏳ depende de #4 | Itera entidades, particiona em chunks, idempotente |
| 6. Comando `daily-sync` | ⏳ depende de #5 | Cursor server-side, refresh IPF |
| 7. Empacotar como pacote npm separado (`@spharmmt/agent`) | Backlog | Quando 2+ clientes precisarem |
| 8. Binário Windows + serviço | Backlog | Quando 5+ clientes |

---

## 7. Regras invariantes

1. **Não voltar ao folder/file mode** para o fluxo principal. Folder mode é fallback documentado, não caminho principal.
2. **Não fazer exports manuais Excel** para alimentar o agent — defeats o propósito de direct sync.
3. **Read-only no SQL Server** sempre. Login do agent tem `db_datareader` apenas.
4. **Credentials SQL ficam locais.** Nunca enviadas para a SaaS.
5. **Ingest key autentica o tenant correcto.** Hash bcrypt server-side; key em claro só na issue ou rotação.
6. **Nada de novas features web.** Trabalho é todo no agent + endpoints existentes da SaaS.
7. **Sem reset de Neon / control plane.** A infraestrutura está estável; manter.

---

## 8. Smoke local validado

| Validação | Resultado |
|---|---|
| `tsc --noEmit` (config + commands + cli) | ✅ verde |
| `npx tsx agent/src/cli.ts --help` | ✅ lista 3 comandos |
| `npx tsx agent/src/cli.ts test-connection` sem `.env` | ✅ fail-fast com lista completa de envs em falta |
| `npx tsx agent/src/cli.ts discover` sem `.env` | ✅ fail-fast pedindo apenas envs SQL |
| Output paths resolvem para `agent/output/` mesmo correndo do repo root | ✅ via `import.meta.url` |

Smoke real contra SPharm ERP requer o servidor on-premise com SQL Server acessível — depende do operador.
