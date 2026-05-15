# SPharm.MT — Pilot baseline snapshot (2026-05-14)

Estado funcional congelado no início do piloto real. Este documento serve
como **baseline oficial** — qualquer divergência operacional posterior é
medida contra este snapshot.

Não editar este ficheiro após o freeze; criar novo `pilot-state-<data>.md`
se houver necessidade de re-snapshot.

## 1. Arquitectura actual

Multi-tenant SaaS pharmacy management com per-DB tenant isolation:

- **SaaS** (Vercel, Next.js 16 App Router) — UI + APIs ingestão + outbox
- **Control plane DB** (Neon Postgres único) — registry de tenants
- **Tenant DBs** (Neon Postgres, 1 por grupo de farmácias) — dados
  operacionais isolados por tenant
- **Agent local on-prem** (Windows, Node 20 portable) — instalado no
  servidor SQL Server de cada farmácia; lê SPharm ERP (read-only) +
  escreve encomendas SaaS (insert mode)

**Direccionalidade estrita do fluxo de escrita:**

```
SaaS → OrderOutbox (PENDENTE) → agent.pullPendingOrders → writeInsert
                                                            → SQL Server local
                                                            → agent.ackOrder → SaaS
```

SaaS nunca toca SQL Server directamente. Apenas o agent tem credenciais
SQL Server.

## 2. Pipelines em produção

| Pipeline | Trigger | Comando | Frequência | Owner |
|---|---|---|---|---|
| Ingestão diária | Task Scheduler | `agent.cjs daily-pipeline` (via `run-daily-pipeline-auto.bat`) | Diária 3h AM | Agent on-prem |
| Bootstrap inicial | Manual | `agent.cjs bootstrap-upload` | Uma vez por farmácia | Operador SPharm |
| Export encomendas SaaS→SPharm | Task Scheduler | `agent.cjs export-orders` (via `run-export-orders-auto.bat`) | A cada 5-10min | Agent on-prem (rev20+) |
| Aggregate mensal | Embebido em daily-pipeline | `agent.cjs daily-pipeline` chama `/api/admin/pipeline/aggregate-month` | Diária | SaaS server-side |
| Classify TipoDocs | Manual quando necessário | `npm run ingest:classify-tipodoc` | Ad-hoc | Admin SaaS |
| Reclassify vendas | Manual quando necessário | `npm run ingest:reclassify-vendas` | Ad-hoc | Admin SaaS |

## 3. Comandos oficiais (npm scripts SaaS)

Tenancy (control plane):
- `npm run tenancy:list`
- `npm run tenancy:create`
- `npm run tenancy:add-farmacia`
- `npm run tenancy:add-user` (rev17+)
- `npm run tenancy:status`
- `npm run tenancy:migrate-all`
- `npm run tenancy:deactivate` / `tenancy:reactivate`
- `npm run tenancy:cleanup-failed`
- `npm run tenancy:debug-ingest-auth`

Admin operations:
- `npm run admin:package-agent` (gera ZIP tenant-specific)
- `npm run pilot:precheck`
- `npm run pipeline:health`
- `npm run env:doctor`

Ingest/aggregate utilities (não diárias):
- `npm run ingest:classify-tipodoc`
- `npm run ingest:reclassify-vendas`
- `npm run aggregate:vendamensal`
- `npm run report:vendamensal`

Onboarding wizard interactivo:
- `onboarding-wizard.bat` (PowerShell, na raiz do repo)

## 4. BATs oficiais (ZIP rev21)

Distribuídos em `dist-agent/SPharmMT-Agent-2026-05-14-rev21.zip`:

| BAT | Propósito | Quando correr |
|---|---|---|
| `run-test-connection.bat` | Valida config + SQL + SaaS | Sempre após install ou mudança de config |
| `run-discover.bat` | Lê schema SPharm read-only | Primeira instalação |
| `run-discover-products.bat`, `-stock.bat`, `-sales.bat` | Probes dirigidos | Inspecção dirigida durante mapping |
| `run-probe-table.bat` | Probe genérico (`--table`) | Inspecção ad-hoc |
| `run-products-preview.bat`, `-stock-preview.bat`, `-sales-preview.bat`, `-sales-summary-preview.bat` | Preview joins TOP 20 | Validação do mapping antes do bootstrap |
| `run-inspect-codigoid.bat` | Diagnose de CodigoIDs órfãos | Quando aparecem orphans no operational |
| `run-inspect-orders-schema.bat` | Probe tabelas encomendas | Antes de activar ordersWriteMode=insert |
| `run-inspect-product-identifiers.bat` | Identificar coluna real do CNP | Antes de activar ordersWriteMode=insert |
| `run-setup-orders-write-log.bat` | Cria `dbo.SPharmMT_OrderWriteLog` | Antes de activar ordersWriteMode=insert |
| `run-test-order-write.bat` | Smoke test INSERT (DRY-RUN/COMMIT) | Validação antes de produção |
| `run-bootstrap-dry-run.bat` | Preview da 1ª ingestão | Antes de bootstrap real |
| `run-bootstrap-upload.bat` | Bootstrap real para SaaS | Uma vez por farmácia |
| `run-daily-sync-dry-run.bat` | Dry-run do daily-sync | Validação ad-hoc |
| `run-daily-sync.bat` | Daily-sync manual | Quando preciso de re-correr 1 dia |
| `run-daily-pipeline-auto.bat` | Pipeline diário (Task Scheduler) | Agendado diariamente |
| `run-export-orders-auto.bat` | Export encomendas (Task Scheduler) | Agendado a cada 5-10min (rev16+) |
| `run-export-orders-once.bat` | Export manual interactivo | Debug ou primeira validação |
| `run-health.bat` | Diagnóstico verboso | Quando há suspeita de problema |

## 5. Tabelas auxiliares criadas pelo agent

Criadas por nós no SPharm SQL Server local (não pertencem ao schema SPharm):

| Tabela | Schema | Criada por | Propósito |
|---|---|---|---|
| `dbo.SPharmMT_OrderWriteLog` | `outboxId varchar(32) PK, encomendaId int, createdAt datetime, payloadHash varchar(64), status varchar(20)` | `agent.cjs setup-orders-write-log` (rev17+) | Idempotência de INSERTs de encomendas SaaS — mapping `outboxId → Encomenda ID` |

Outras estruturas nossas no SaaS (Postgres tenant DB):
- `OrderOutbox` + `OrderExportAudit` (modelo Prisma)
- `PipelineRun` (audit de execuções)
- Tabelas operacionais e de catálogo (Produto, Farmacia, ListaEncomenda, VendaMensal, etc.) — não documentadas exaustivamente aqui; ver `prisma/schema.prisma`

## 6. Schemas SPharm tocados pelo agent

**Leitura (SELECT, `db_datareader`):**
- `dbo.Stocks` — produtos + preços + flags
- `dbo.ArmazensStocks` — stock por armazém
- `dbo.Fornecedores` — fornecedores
- `dbo.Armazens` — armazéns
- `dbo.Atendimento` + `dbo.[Atendimento Detalhe]` — vendas
- `dbo.[Tipo Documento]` — classificação documental
- `dbo.Utilizadores` — utilizadores SPharm (consulta de FK em probes)
- `dbo.Encomendas` + `dbo.[Encomendas Detalhe]` + `dbo.EncomendasFaltas` + `dbo.Encomendas_Prepara` — probes de schema apenas (read-only) durante inspect

**Escrita (INSERT, requer permissão adicional):**
- `dbo.Encomendas` — header de encomenda nova
- `dbo.[Encomendas Detalhe]` — linhas
- `dbo.SPharmMT_OrderWriteLog` — write-log auxiliar (nossa)

Permissões mínimas para escrita:
```sql
GRANT SELECT, INSERT ON [dbo].[Encomendas]              TO [<sql-login>];
GRANT SELECT, INSERT ON [dbo].[Encomendas Detalhe]      TO [<sql-login>];
GRANT SELECT, INSERT ON [dbo].[SPharmMT_OrderWriteLog]  TO [<sql-login>];
GRANT VIEW DEFINITION  ON SCHEMA::dbo                   TO [<sql-login>];  -- para sys.columns probes
```

## 7. Campos usados em `dbo.Encomendas` (INSERT)

Apenas estes 10 campos são populados; restantes ficam com default ou NULL:

| Coluna | Tipo | Origem do valor |
|---|---|---|
| `Fornecedor ID` | int NOT NULL | `ordersInsert.fornecedorIdForOrders` (config) |
| `Data Encomenda` | smalldatetime | `GETDATE()` no servidor |
| `NEncomenda` | int | `MAX([NEncomenda]) + 1` sob `TABLOCKX HOLDLOCK` |
| `User ID` | smallint | `ordersInsert.userIdForInsert` (config) |
| `EncomendaSituacaoID` | char(1) NOT NULL | `ordersInsert.encomendaSituacaoInitial` (default `'A'`) |
| `ArmazemID` | tinyint NOT NULL | `ordersInsert.armazemId` (default `1`) |
| `EncNegociada` | bit NOT NULL | hardcoded `0` |
| `EncAprovacaoSitID` | tinyint NOT NULL | hardcoded `1` |
| `EncCentralCompras` | bit NOT NULL | hardcoded `0` |
| `TipoEncomendaID` | tinyint NOT NULL | `ordersInsert.tipoEncomendaId` (default `2`) |

**Campos que ficam intactos** (ver write contract em `agent/src/spharm-orders-writer.ts`):
- `Encomenda ID` (IDENTITY, atribuído pelo SQL Server)
- `Confirmado_UserID` + `Confirmado_Data` (preenchidos pelo operador)
- `Data Entrega` (preenchido pelo módulo Recepção)
- `VVM_ID` (Via Verde do Medicamento — fluxo diferente, NÃO TOCAR)

## 8. Campos usados em `dbo.[Encomendas Detalhe]` (INSERT)

Por linha de encomenda:

| Coluna | Tipo | Origem |
|---|---|---|
| `Encomenda ID` | int NOT NULL | FK para o header recém-criado (via `SCOPE_IDENTITY()`) |
| `CodigoID` | int NOT NULL | Lookup `SELECT TOP 1 [CodigoID] FROM Stocks WHERE [<productLookupColumn>] = @cnp` |
| `Quantidade` | int NOT NULL | `payload.linhas[i].quantidadeAjustada ?? quantidadeSugerida` (inteira) |
| `Bonus` | smallint NOT NULL | hardcoded `0` |
| `Enc Fornecedor ID` | int NULL | `ordersInsert.fornecedorIdForOrders` (mesmo que header) |
| `Confirmada` | bit NOT NULL | hardcoded `0` |
| `Preco Venda Publico_EUR` | decimal(8,2) | Lido de `Stocks` no mesmo SELECT do lookup |
| `PMC_EUR` | decimal(8,2) | Lido de `Stocks` no mesmo SELECT do lookup |
| `PrecoCusto` | decimal(8,2) NULL | Lido de `Stocks.[Preco Ultima Compra_EUR]` (pode ser NULL) |
| `LinhaInactiva` | bit NOT NULL | hardcoded `0` |

**Campos não populados** (NULL ou default):
- `Detalhe  Enc ID` (IDENTITY — note: **duas espaços** no nome real)
- `OrigemDetalhe  Enc ID` (NULL — usado para tracking de origem em re-encomendas internas)

## 9. Known limitations (v1 piloto)

- **Mapeamento Fornecedor SaaS↔SPharm**: 1 fornecedor por farmácia via config.
  Encomendas multi-fornecedor não suportadas — toda a encomenda vai para
  o `fornecedorIdForOrders` configurado.
- **Single-instance agent**: `NEncomenda` é computado `MAX + 1` sob
  `TABLOCKX HOLDLOCK`. Múltiplos agents a escrever simultaneamente para o
  mesmo SPharm não suportados.
- **Sem stored procedure**: INSERT directo. Se SPharm tiver SP
  `usp_CriarEncomenda` com regras de negócio, este caminho NÃO as dispara.
- **`Encomenda ID` deve ser IDENTITY**: agent verifica em runtime via
  `sys.columns`. Se schema SPharm mudar, agent recusa correr.
- **Idempotência tabela auxiliar separada**: `dbo.SPharmMT_OrderWriteLog`
  tem de existir antes do primeiro INSERT.
- **Permissões SPharm SQL login**: agent precisa de INSERT em 3 tabelas
  específicas; `db_datawriter` global é uma simplificação aceitável mas
  não recomendada.
- **Janela de orphans**: produtos vendidos que ainda não foram upserted
  via bootstrap aparecem como UNKNOWN no staging — reclassify manual.
- **TipoDoc UNKNOWN**: documentos com tipo não classificado ficam
  pendentes até `npm run ingest:classify-tipodoc` ser corrido.

## 10. Rollback rápido (cenários comuns)

| Cenário | Comando |
|---|---|
| Encomendas a serem escritas mal no SPharm | `agent.config.json` → `"ordersWriteMode": "stub"`; próximo run começa a gerar JSON sem tocar SPharm |
| Daily-pipeline a fazer asneira | Desactivar tarefa no Task Scheduler local |
| Tenant inteiro tem de ser pausado | `npm run tenancy:deactivate -- --tenant <slug>` |
| Agent rev N tem bug; voltar a rev N-1 | Operador extrai ZIP rev N-1, copia ficheiros, mantém `agent.config.json`, reinicia Task Scheduler |
| Migration Prisma errada já aplicada | `prisma migrate resolve --rolled-back <migration>` + manual SQL para reverter mudanças |

## 11. Troubleshooting crítico

Ver [docs/pilot-operator-guide.md](pilot-operator-guide.md#troubleshooting) secção "Activação produção encomendas" para tabela detalhada (9 cenários com onde olhar + acção).

Resumo dos 3 mais prováveis na primeira semana:

1. **"CNP não encontrado em dbo.Stocks"** — produto SaaS não existe no
   ERP local. Catálogo dessincronizado. Acção: re-correr bootstrap ou
   cancelar encomenda no SaaS.

2. **"match ambíguo: N produtos"** — `productLookupColumn` apanha vários
   produtos com o mesmo valor. Configuração errada. Acção: re-correr
   `inspect-product-identifiers` e reconfigurar.

3. **"SQL Server connect falhou"** — rede instável ou SQL caiu. Agent
   marca como retryable; tenta de novo no próximo ciclo. Acção: só
   investigar se persistir > 30min.

## 12. Riscos conhecidos aceites para o piloto

- **Sem disaster recovery automatizado** — backup do tenant DB depende
  do snapshot Neon (RPO ~24h). Aceitável para 5-10 farmácias piloto;
  inaceitável para 50+.
- **Vercel cold start** — primeira invocação do dia a uma rota pode
  demorar ~3s. Agent já tolera (timeout 30s).
- **Sem rate limiting** — agent pode flood `/api/outbox/v1/orders/pending`
  se o operador configurar Task Scheduler com intervalo absurdo.
  Aceitável: SaaS está atrás de Vercel edge; agent é single-instance
  por farmácia (≤ 20 RPS no pior caso).
- **Sem alerting automatizado** — falhas detectadas via revisão manual
  do log + Healthchecks.io ping no daily-pipeline. Resposta humana
  esperada em 24h, não em minutos.
- **Sem teste de carga formal** — pilot scale (5-10 farmácias,
  100-500 encomendas/dia agregadas) está muito abaixo dos limites
  arquitecturais teóricos. Re-avaliar a 50+ farmácias.

## 13. Versão oficial do piloto

- **Agent**: rev21 (`SPharmMT-Agent-2026-05-14-rev21.zip`)
- **SaaS**: ver commit/tag identificado por `git log -1 --format='%h %s'`
  no momento do deploy de produção (Vercel `VERCEL_GIT_COMMIT_SHA`)
- **Prisma migrations aplicadas**: todas as migrations sob
  `prisma/migrations/` confirmadas via `npm run tenancy:migrate-all`
  contra todos os tenants ACTIVE

Documentos de referência (este snapshot é a baseline; ver para detalhe):
- [pilot-operator-guide.md](pilot-operator-guide.md) — guia operador
- [production-freeze.md](production-freeze.md) — governance
- [onboarding-real-pharmacy.md](onboarding-real-pharmacy.md) — onboarding
- [agent/INSTALL_WINDOWS.md](../agent/INSTALL_WINDOWS.md) — instalação agent

Snapshot capturado em: **2026-05-14**.
