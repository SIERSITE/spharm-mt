# Local Agent — Arquitectura

**Versão:** 2026-05-12 · **Status:** design doc, pré-implementação

Documento canónico do **agent que corre on-premise** no servidor da farmácia/grupo. Substitui [`ingestion-agent-folder-mode.md`](ingestion-agent-folder-mode.md) como ponto de entrada arquitectural (esse doc fica como referência operacional do modo folder).

---

## 1. Missão

Recolher dados do **SPharm ERP** (SQL Server local) — ou de ficheiros exportados como fallback — e enviá-los para a SaaS SPharm.MT por HTTPS contra os endpoints `/api/ingest/v1/*`, autenticando-se com uma ingest key emitida pela plataforma.

> Não confundir com a Platform Admin Tool — esta vive do nosso lado, conhece Neon/control plane e gere tenants. O Local Agent **não conhece nada disso**.

---

## 2. Boundaries — o que o agent NÃO faz / NÃO sabe

| Não sabe | Porquê |
|---|---|
| Que tenants existem além do seu | O agent só tem `tenantSlug` próprio na config |
| Que database o seu tenant usa | Resolução fica do lado do servidor SaaS |
| O endereço do Neon / control plane | Só conhece a base URL pública da SaaS |
| Schema de outros tenants | Endpoints tenant-aware filtram automaticamente |
| Credenciais cross-tenant | A ingest key é bound ao tenant (e no futuro à farmácia) |

Regra dura: **toda a saída do agent passa pelos endpoints `/api/ingest/v1/*` e `/api/outbox/v1/heartbeat`**, autenticados com `Authorization: Bearer <ingestKey>` + `X-Tenant-Slug: <slug>`. Sem ligações directas a Neon nem a recursos de outro tenant. Garantia enforced server-side em `withIntegrationAuth`.

---

## 3. Dois modos de operação

### 3.1 Modo A — SQL Server direct (primário para SPharm ERP)

Caminho principal quando temos acesso à BD ERP. Conecta ao SQL Server local, lê metadata/dados via `sys.*` e tabelas de negócio, mapeia para entidades SPharm.MT, faz POST aos endpoints de ingest.

**Sub-comandos:**

| Comando | Função |
|---|---|
| `spharmmt-agent discover` | Introspecciona schema do ERP (executa `scripts/erp/spharm-sqlserver-discover.ts`). Output local em JSON + Markdown. Não chama a SaaS. |
| `spharmmt-agent bootstrap` | Importa histórico inicial (default últimos 24 meses). Iterates entidades (produtos → stock → vendas → compras → devoluções → ajustes → inventário). Idempotente: re-correr é seguro. |
| `spharmmt-agent daily-sync` | Incremental: lê apenas alterações desde `--since` ou desde o último SyncRun completado com sucesso. Refresca IPF no fim. |

**Idempotência:**
- Cada lote envia hash `sha256` do conteúdo no body → servidor recusa se já estava `PROCESSADO` (`LoteIngestao` table)
- `SyncRun` no control plane regista início + fim de cada execução
- Daily-sync usa cursor por entidade (max(dataModificacao) do último run com sucesso)

**Read-only contra ERP:**
- Conta SQL Server dedicada com permissão `db_datareader` apenas
- Sem `INSERT`/`UPDATE`/`DELETE` em nenhuma path
- Validação em CI: grep nos imports do agent para verificar que não importa nenhuma função de escrita

### 3.2 Modo B — Folder mode (fallback)

Quando não temos acesso à BD ERP, o operador exporta para uma pasta e o agent processa esses ficheiros. Já implementado — ver [`ingestion-agent-folder-mode.md`](ingestion-agent-folder-mode.md).

Permanece útil para:
- ERPs que não são SPharm (clientes legados, ad-hoc)
- Diagnóstico (operador exporta um snapshot manual)
- Bootstrap inicial enquanto modo SQL Server está a ser validado

**Não é o caminho principal** mas continua suportado, sem deprecação.

---

## 4. Configuração

### 4.1 Config sempre necessária (qualquer modo)

| Env | Obrigatória | Notas |
|---|---|---|
| `SPHARMMT_ENDPOINT` | sim | Base URL pública da SaaS (ex: `https://app.spharmmt.pt`). Sem trailing slash. |
| `SPHARMMT_TENANT_SLUG` | sim | Slug do tenant ao qual este agent pertence. Header `X-Tenant-Slug`. |
| `SPHARMMT_INGEST_KEY` | sim | API key emitida pela Platform Admin Tool. Header `Authorization: Bearer <key>`. |
| `SPHARMMT_AGENT_VERSION` | opcional | Identificador da versão do binário, reportado no heartbeat. |

### 4.2 Config adicional — modo SQL Server

| Env | Obrigatória | Notas |
|---|---|---|
| `ERP_SQLSERVER_HOST` | sim | Hostname/IP do SQL Server. Para instância nomeada, ver §4.3. |
| `ERP_SQLSERVER_PORT` | opcional | Default 1433. |
| `ERP_SQLSERVER_DATABASE` | sim | Nome da BD SPharm (ex: `SPHARM`). |
| `ERP_SQLSERVER_USER` | sim | Login dedicado read-only (`db_datareader`). |
| `ERP_SQLSERVER_PASSWORD` | sim | Mascarada em logs. Nunca enviada para a SaaS. |
| `ERP_SQLSERVER_ENCRYPT` | opcional | `1` ⇒ TLS. Default `0` (LAN). |
| `ERP_SQLSERVER_TRUST_CERT` | opcional | `1` ⇒ aceita self-signed. Default `1` (LAN). |

### 4.3 Config adicional — modo folder

Ver [`ingestion-agent-folder-mode.md`](ingestion-agent-folder-mode.md) §Comando.

### 4.4 Multi-farmácia dentro do mesmo tenant

Um grupo (= 1 tenant = 1 BD Neon) pode ter várias farmácias. O ERP SQL Server normalmente identifica a loja com uma coluna (`idLoja`, `armazem`, etc — a confirmar pelo discovery). Duas opções:

| Estratégia | Quando usar |
|---|---|
| **Um agent por farmácia** (process único) | Cada farmácia tem o seu PC com SQL Server isolado. Config define `SPHARMMT_FARMACIA_SLUG` ou `SPHARMMT_FARMACIA_ID` para mapear o output. |
| **Um agent central** que itera múltiplas farmácias | Grupo com servidor central + BD ERP partilhada. Agent lê a coluna de loja, faz pivot por farmácia, envia em lotes separados. |

A decisão depende da topologia real do cliente. **Default na v1: um agent por farmácia** (mais simples, mais isolado, mais alinhado com binding key→farmácia futura).

### 4.5 Binding ingest key → farmácia (futuro)

Hoje a ingest key é bound apenas ao tenant. Quando o piloto provar valor, adicionar:

- Coluna nova no control plane: `IngestKey.farmaciaId` (nullable)
- Validação no `withIntegrationAuth`: se key tem `farmaciaId`, payload tem de bater
- Endpoint `tenancy:issue-ingest-key -- --slug <tenant> --farmacia <cuid|nome>`

Isto impede um agent comprometido de escrever em farmácias do mesmo grupo onde não devia.

**Não é P0** — alarga após o primeiro grupo estar a operar. Mencionado para que o design da Platform Admin Tool já assuma o slot.

---

## 5. Comandos — shape final

```bash
spharmmt-agent discover                          # introspecciona SQL Server
spharmmt-agent bootstrap --months=24             # histórico 24 meses
spharmmt-agent bootstrap --since=2024-01-01      # ou data explícita
spharmmt-agent daily-sync                        # incremental desde último run
spharmmt-agent daily-sync --since=2026-05-10     # override
spharmmt-agent folder --once --input=C:\inbox    # modo folder (fallback)
spharmmt-agent status                            # mostra config + ping ao endpoint + último SyncRun
spharmmt-agent doctor                            # valida config + conectividade SQL Server + conectividade SaaS
```

Aliases npm durante dev (até empacotar como binário):

| npm script | Equivalente |
|---|---|
| `npm run agent:discover` | `spharmmt-agent discover` |
| `npm run agent:bootstrap` | `spharmmt-agent bootstrap` |
| `npm run agent:daily-sync` | `spharmmt-agent daily-sync` |
| `npm run agent:ingest-folder` | `spharmmt-agent folder` (já existe) |

---

## 6. Pipeline interno (modo SQL Server)

```
┌──────────────────────────────────────────────────────────────────┐
│                       spharmmt-agent bootstrap                    │
├──────────────────────────────────────────────────────────────────┤
│ 1. Validate config (env + endpoint reachable + SQL ping)          │
│ 2. Start SyncRun via POST /api/outbox/v1/sync-run/start           │
│ 3. For each entity in [produtos, stock, vendas, compras, …]:      │
│      a. Query SQL Server (cursor: dataMov ≥ since)                │
│      b. Map ERP rows → SPharm.MT schema                           │
│      c. Compute sha256 of normalized payload                      │
│      d. POST /api/ingest/v1/snapshot/<entity>                     │
│         Headers: Authorization, X-Tenant-Slug                     │
│         Body: { farmaciaId, hash, rows: [...] }                   │
│      e. Server returns { status: processed | duplicate | failed } │
│      f. Append to local JSONL                                     │
│ 4. POST /api/outbox/v1/sync-run/complete (SyncRun final state)    │
│ 5. Trigger IPF refresh (POST /api/jobs/refresh-ipf?tenant=<slug>) │
└──────────────────────────────────────────────────────────────────┘
```

Em `daily-sync`, o passo 3a usa `dataMov > lastSuccessfulCursor` em vez de range absoluto. O cursor vive **no servidor** (via `SyncRun.metaJson.cursors`) — o agent é stateless excepto pela config + JSONL local.

---

## 7. Observabilidade

| Sinal | Onde | Visível a quem |
|---|---|---|
| Heartbeat | POST `/api/outbox/v1/heartbeat` cada 5 min em watch / 1× por run em batch | Operador SaaS via `/admin` |
| SyncRun | Linha no control plane com start/end/status/recordCounts | Operador SaaS |
| LoteIngestao | Tabela tenant — 1 linha por upload | Admin do grupo + Operador SaaS |
| JSONL local | `agent.log.jsonl` na pasta do agent | Operador da farmácia (debug) |
| Doctor command | `spharmmt-agent doctor` imprime check-list local | Operador da farmácia |

---

## 8. Distribuição

### v1 — dev (já hoje)
- Repo monolítico SPharm.MT
- Operador faz `git clone` + `npm install` + `tsx scripts/agent/*.ts`
- Aceitável para piloto técnico com 1 farmácia

### v2 — npm package separado
- Extrair `scripts/agent/*` para `@spharmmt/agent` (npm scoped package)
- Operador: `npm install -g @spharmmt/agent`
- Comando: `spharmmt-agent <subcomando>`
- Config via `.env` no working directory ou via flags

### v3 — binário standalone
- Empacotar com `bun build --compile` ou `pkg`
- Distribuir como `spharmmt-agent-windows-x64.exe`
- Instalador MSI/NSIS que cria o serviço Windows (via `nssm` ou `node-windows`)
- Auto-update opt-in (GET `<endpoint>/api/agent/latest-version`)

**Não é P0.** v1 chega para o piloto. v2 quando 2+ clientes pedirem. v3 quando 5+ clientes.

---

## 9. Failure modes

| Erro | Causa | Acção do agent |
|---|---|---|
| Endpoint SaaS HTTP 401 | Key revogada ou tenant slug errado | Falha-rápido, mensagem accionável, sai com exit 1 |
| Endpoint SaaS HTTP 503 | SaaS down ou control plane degraded | Retry exponencial até 5×, depois falha. SyncRun marcado FAILED no próximo doctor. |
| SQL Server unreachable | ERP down / firewall / credenciais erradas | Falha-rápido com diagnóstico (SQL state + checklist) |
| SQL Server SELECT falha numa entidade | Coluna mudou de nome, schema drift | Marca essa entidade FAILED, continua outras, reporta no resumo final |
| Mapping ERP→SPharm.MT falha | Tipo inesperado, registo malformado | Skip da linha, contabiliza em `recordsFailed`, prossegue |
| Disco cheio (JSONL local) | Operador não fez rotate | Falha o write, mas continua o envio (degraded mode) |

---

## 10. Segurança

- **Read-only SQL Server:** login dedicado com permissão `db_datareader` apenas
- **Ingest key bound ao tenant** — uma key comprometida só dá acesso ao grupo dela
- **TLS sempre na comunicação SaaS** — `SPHARMMT_ENDPOINT` deve ser `https://` (validado no doctor)
- **Sem secrets em logs** — password SQL e ingest key são mascaradas em todos os outputs
- **Sem upload de credenciais ERP** — a password SQL Server fica só no `.env` local; nunca enviada para a SaaS
- **Audit trail server-side** — cada chamada produz `LoteIngestao` + `SyncRun` no control plane / tenant DB

---

## 11. Decisões abertas (a resolver antes de implementar)

| Decisão | Opções | Recomendação inicial |
|---|---|---|
| Cursor de daily-sync vive onde | (a) server-side em `SyncRun.metaJson` (b) `.cursor.json` local | (a) — server-side, source of truth única, sobrevive a reinstalação do agent |
| Lote: um POST por entidade ou batch encadeado | (a) 1 POST por entidade × 1 chunk grande (b) chunks de 5k linhas | (b) — chunks 5k linhas, menor blast radius por falha, hash por chunk |
| ERPs com >1 farmácia partilhando BD | (a) 1 agent multiplexa (b) 1 agent por farmácia (config separada) | (b) v1, (a) quando piloto provar |
| Schedule do daily-sync | (a) Windows Task Scheduler (b) `--watch` no agent (c) systemd-like service | (a) para piloto — operacionalmente trivial, não exige serviço |

Estas ficam abertas até confirmar com o output do `erp:discover` + topologia real do cliente.

---

## 12. Roadmap de implementação

1. ✅ **Discovery script SQL Server** — `scripts/erp/spharm-sqlserver-discover.ts` (entregue 2026-05-12, aguarda execução do operador na farmácia)
2. ⏳ **Mapping doc** — `notes/erp-direct-sync-mapping.md` (escrito após o operador colar output do discovery)
3. ⏳ **Connectores por entidade** — uma função puro `mapErp<Entity>Row → SPharmMT<Entity>Payload` testável em isolation
4. ⏳ **Comando `agent:bootstrap`** — itera entidades, envia lotes, idempotente
5. ⏳ **Comando `agent:daily-sync`** — cursor server-side, refresh IPF
6. ⏳ **Comando `agent:doctor`** — validação local de config + conectividade
7. ⏳ **Empacotamento npm package separado** — após primeiro piloto operacional

Cada passo é uma PR isolada, smoke-testada antes de avançar.
