# Operational Reporting v1

> **Antes de go-live:** correr [pilot-go-live-checklist.md](pilot-go-live-checklist.md)
> e `npm run pilot:precheck -- --tenant <slug>`. Em caso de problemas
> consultar [pilot-support-runbook.md](pilot-support-runbook.md) e
> [pilot-rollback-plan.md](pilot-rollback-plan.md). Documentação de
> operador em [pilot-operator-guide.md](pilot-operator-guide.md).

---


Pipeline operacional ponta-a-ponta para relatórios mensais de vendas
baseado em `VendaMensal`, alimentado pelo agent local SPharm.MT.

Estado: **produção** (demo-neon validado com 2024-01 + 2024-04).

A partir desta iteração, o ciclo daily-sync → aggregate → reports é
autónomo via **daily-pipeline** (agent on-prem disparado por Windows
Task Scheduler). Ver §"Pipeline autónomo" abaixo.

---

## Pipeline autónomo (daily-pipeline)

Um único comando, disparado em Windows Task Scheduler:

```
run-daily-pipeline-auto.bat
```

Fluxo:

1. Calcula `ontem` (UTC) automaticamente
2. Adquire lockfile (`run/pipeline.lock`) — abort se já corre
3. Corre **daily-sync** (ERP → SaaS staging)
4. Corre **aggregate-month** server-side via `/api/admin/pipeline/aggregate-month`
5. Valida safety conditions (UNKNOWN=0, operationalOrphans=0, valorBruto≥0)
6. Grava resumo em `PipelineRun` (SaaS) + logs locais
7. Release lockfile

Logs locais (relativos ao directorio do agent):

```
logs/
  pipeline-YYYY-MM-DD.log    # resumo do orquestrador
  daily-sync-YYYY-MM-DD.log  # output dos 3 pipelines
  aggregate-YYYY-MM.log      # resposta da agregação server-side
```

Resumo operacional impresso no fim de cada run:

```
DAILY PIPELINE OK
Date: 2024-04-02

Products synced: X
Stock rows synced: Y
Sales lines synced: Z

VendaMensal:
  rows inserted: N
  valorBruto: EUR
  devoluções: M

Unknown TipoDocs: 0
Operational orphans: 0

Duration total: 00:01:42
```

### Safety aborts

O daily-pipeline aborta sem escrever resultados quando:

- Lockfile presente (outro pipeline ainda a correr)
- Tenant não resolvível
- daily-sync HTTP error (qualquer batch falha)
- `UNKNOWN > 0` em staging do mês (classifier incompleto)
- `operationalOrphans > 0` (produtos legítimos sem upsert)
- Total `valorBruto` agregado é negativo (provavelmente data quality)

Cada aborto regista `status='ABORTED'` em `PipelineRun.details` com o
`abortCode` específico — visível em `/admin/pipeline` e `pipeline:health`.

### Observabilidade

**Health check via terminal:**

```
npm run pipeline:health -- --tenant <slug>
```

Exit codes semânticos: 0=OK, 2=último run não OK, 3=UNKNOWN presente,
4=orphans presentes. Útil para watchdog externo.

**UI:** `/admin/pipeline` (platform admin only). Mostra:
- Últimas execuções (daily-pipeline, aggregate, daily-sync)
- Métricas: rows VendaMensal, UNKNOWN, orphans, services
- 10 últimas execuções
- Últimas falhas (ERROR + ABORTED)

---

## Pipeline em três fases

```
┌───────────┐   agent      ┌───────────────┐  aggregate  ┌────────────┐  report  ┌──────────────┐
│ SQL Server│ ───────────► │IngestVendaLin │ ──────────► │VendaMensal │ ───────► │ /relatorios/ │
│ (Softreis)│  daily-sync  │     haRaw     │ idempotent  │            │  page    │vendas-mensais│
└───────────┘  bootstrap   └───────────────┘             └────────────┘          └──────────────┘
```

1. **Ingest** — agent (Windows on-prem) faz `bootstrap-upload` (1ª vez)
   ou `daily-sync` (diário) contra a SaaS. Linhas raw escrevem em
   `IngestVendaLinhaRaw` via `/api/ingest/v1/bootstrap/sales-lines`.
2. **Agregação** — script server-side `aggregate:vendamensal`
   transforma staging em `VendaMensal` por (farmaciaId, produtoId,
   ano, mes). Idempotente.
3. **Report** — página `/relatorios/vendas-mensais` (Server Component)
   e CLI `report:vendamensal` consomem `VendaMensal`.

---

## Comandos canónicos

### 1. Daily-sync (agent on-prem)

No PC da farmácia, descompacta o ZIP `SPharmMT-Agent-YYYY-MM-DD-revN.zip`
e corre:

```
run-daily-sync.bat            # Pergunta --date
run-daily-sync-dry-run.bat    # Mesmo SQL sem POST
```

CLI directa:

```
node.exe agent.cjs daily-sync --date 2026-05-13
```

O comando lê apenas alterações desse dia (produtos com venda/compra,
stock movimentado, atendimentos com data venda = @date) e POSTa para
`/api/ingest/v1/bootstrap/*`. Idempotente — re-correr o mesmo dia é
seguro.

### 2. Agregação mensal (SaaS)

```
npm run aggregate:vendamensal -- --tenant <slug> --month 2026-04 --dry-run
npm run aggregate:vendamensal -- --tenant <slug> --month 2026-04 --write
```

Validações automáticas antes de escrever:
- aborta se `UNKNOWN > 0` → caracteriza tipo doc primeiro
- aborta se `operational orphans > 0` → investiga ou usa `--allow-orphans`
- `non-stock services` (Processa_Stocks=0) excluídos automaticamente

A escrita é `DELETE scoped (ano, mes, farmaciaId, origemAgregacao)` +
`INSERT MANY` em transaction. Re-execução produz o mesmo estado final.

### 3. Report visual

```
http://<tenant>.<host>/relatorios/vendas-mensais
```

Filtros via querystring:
- `?farmaciaId=<cuid>` — selecciona farmácia (default: 1ª activa)
- `?mes=YYYY-MM` — selecciona mês (default: mais recente)

Sem dependência de JS no cliente: filtros são `<form method="get">`
em Server Component.

### 4. Report CLI (audit/diff)

```
npm run report:vendamensal -- --tenant <slug> --month 2026-04
npm run report:vendamensal -- --tenant <slug> --month 2026-04 --farmacia "Nome"
npm run report:vendamensal -- --tenant <slug> --month 2026-04 --limit 50
```

Output stdout — útil para diff vs. UI, exportar para email, validar
em CI.

---

## Como validar

Após uma agregação:

```sql
-- Totais escritos para o mês
SELECT COUNT(*), SUM("valorBruto"), SUM("linhasVenda")
FROM "VendaMensal"
WHERE ano = 2026 AND mes = 4
  AND "origemAgregacao" = 'agent-bootstrap-staging';
```

Comparar com o output do `aggregate:vendamensal` (linha
`✓ WRITE concluído. inserted : N`).

Re-correr `aggregate:vendamensal --write` sem ter mudado staging
deve produzir `deleted = N, inserted = N` com os mesmos totais —
confirma idempotência.

---

## Páginas disponíveis

| Rota | Foco | Características |
|---|---|---|
| `/relatorios/vendas-mensais` | Reporting plano (o que aconteceu) | 8 tabelas compactas: totais, top valor, top qtd, devoluções, margem, vendeu sem stock, stock negativo, sem min/max |
| `/analise-operacional` | Accionável (o que fazer agora) | Inclui as 8 anteriores + 3 novas: candidatos a ruptura, candidatos a excesso, cobertura de stock. Banners colorimétricos por urgência. |
| `/admin/pipeline` | Estado do pipeline autónomo | Última execução, métricas, falhas recentes |

Loaders correspondentes (server-only, dedicated, zero share entre si):
- `lib/data/vendas-mensais-report.ts` → `/relatorios/vendas-mensais`
- `lib/data/operational-intelligence.ts` → `/analise-operacional`
- `lib/data/pipeline-status.ts` → `/admin/pipeline`

## Conteúdo do relatório

8 secções por farmácia + mês:

| Secção | Origem | O que mostra |
|---|---|---|
| Totais do mês | `VendaMensal` agregado | Σ qtd, Σ valor bruto, Σ pago utente, Σ compart., linhas, atend. |
| Top por valor bruto | `VendaMensal` | 20 produtos top por valor bruto DESC |
| Top por quantidade | `VendaMensal` | 20 produtos top por quantidade líquida DESC |
| Devoluções líquidas | `VendaMensal` | Produtos onde devolução > venda no mês |
| Margem aproximada | `VendaMensal` + `ProdutoFarmacia` | (PVP-PUC)/PVP × Qtd. Top "valor margem". |
| Vendeu sem stock | `VendaMensal` + `ProdutoFarmacia` | Vendeu mês, stockAtual=0/null hoje |
| Stock negativo | `ProdutoFarmacia` | stockAtual < 0 (anomalia ERP) |
| Sem stockMin/stockMax | `VendaMensal` + `ProdutoFarmacia` | Vendeu mas sem limites — bloqueia reposição auto |

---

## Backfill de non-stock services (cleanup)

Quando o agent envia uma linha de venda cujo produto não foi upserted
(porque tem `Processa_Stocks=0`), o endpoint marca
`IngestVendaLinhaRaw.isNonStockService = true` e o aggregator exclui
automaticamente. Para staging carregada **antes** da introdução desta
flag, usa o backfill manual:

```
npm run ingest:backfill-services -- --tenant <slug> --ids 35023,12551,34972,34993,38555,41905 --write
```

Dry-run sem `--write`. Listar órfãos antes:

```
npm run ingest:list-orphans -- --tenant <slug>
```

Inspeccionar no ERP (via agent on-prem):

```
run-inspect-codigoid.bat
```

---

## Guardrails

Esta v1 NÃO inclui (intencional):
- IPF / indicadores derivados
- forecasts de venda
- scheduler automático (Task Scheduler / cron)
- alteração do dashboard principal (`/dashboard`)
- substituição dos KPIs existentes
- histórico completo (importação massiva)

Tudo isso é deferred até este pipeline ter sido usado em produção
por algumas semanas e os edge cases estarem caracterizados.

---

## Arquitectura — separação de loaders

| Loader | Consumer | Fonte |
|---|---|---|
| `lib/data/vendas-mensais-report.ts` | `/relatorios/vendas-mensais` (page) | `VendaMensal` + `ProdutoFarmacia` |
| `scripts/report-vendamensal.ts` | CLI `report:vendamensal` | mesmas tabelas, queries duplicados (CLI corre fora de request context) |
| `lib/dashboard.ts` | `/dashboard` (existente) | NÃO TOCADO |
| `lib/stock-data.ts` | `/stock` (existente) | NÃO TOCADO |

Decisão: zero reutilização de loaders existentes para evitar risco de
regressão. A duplicação dos queries CLI vs. Server Component é
proposital — o CLI usa `PrismaClient` directo (sem `getPrisma()`
tenant-aware), o Server Component usa o loader server-only.
