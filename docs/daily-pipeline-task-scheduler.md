# Daily Pipeline — setup do Windows Task Scheduler

Guia operacional para configurar o pipeline autónomo no PC da farmácia.

## Pré-requisitos

1. ZIP `SPharmMT-Agent-YYYY-MM-DD-revN.zip` descompactado (ex.: em
   `C:\spharmmt\agent\`).
2. `agent.config.json` configurado nesse directorio (copiado de
   `agent.config.example.json`), com:
   - `sqlHost`, `sqlPort`, `sqlDatabase`, `sqlUser`, `sqlPassword`
   - `saasEndpoint`, `tenantSlug`, `ingestKey`
   - `farmacia` (nome ou cuid)
3. SaaS com `ENABLE_AGENT_BOOTSTRAP=1` no ambiente.
4. Bootstrap inicial já corrido (manual via `run-bootstrap-upload.bat`).

## Configurar a Task

1. Abrir **Task Scheduler** (taskschd.msc)
2. **Create Task** (não "Basic Task" — precisamos das opções avançadas)
3. Tab **General**:
   - Name: `SPharm.MT — Daily Pipeline`
   - Run whether user is logged on or not
   - Run with highest privileges: opcional (recomendado se SQL Server requer)
4. Tab **Triggers** → **New**:
   - Begin the task: On a schedule
   - Daily, recur every 1 day
   - Start: `2026-05-15 03:00:00` (escolher hora fora de horas comerciais)
   - **Stop task if it runs longer than: 30 minutes** (safety)
5. Tab **Actions** → **New**:
   - Action: Start a program
   - Program/script: `C:\spharmmt\agent\run-daily-pipeline-auto.bat`
   - Start in: `C:\spharmmt\agent\` (CRITICAL — sem isto, logs e
     lockfile ficam noutro sítio)
6. Tab **Conditions**:
   - Wake the computer to run this task: SIM (se PC pode hibernar)
   - Start only on AC power: NÃO (servidor)
7. Tab **Settings**:
   - Allow task to be run on demand: SIM (para testes manuais)
   - If the task is already running: **Do not start a new instance**
   - If the task fails, restart every 15 min, up to 2 times

## Validação inicial

1. **Right-click → Run**. Confirma:
   - `logs/pipeline-YYYY-MM-DD.log` criado
   - `logs/daily-sync-YYYY-MM-DD.log` criado
   - `logs/aggregate-YYYY-MM.log` criado
   - Última linha do pipeline.log: `DAILY PIPELINE OK`
2. No SaaS: abrir `/admin/pipeline` ou correr `npm run pipeline:health --
   --tenant <slug>`. Confirma:
   - "Último daily-pipeline (auto)" mostra a run com status OK
   - Operational orphans = 0
   - UNKNOWN = 0

## Diagnóstico de falhas

### Pipeline aborts (status=ABORTED)

| Código | Causa | Ação |
|---|---|---|
| `unknowns_present` | `UNKNOWN` em staging | `npm run ingest:classify-tipodoc -- ...` + `npm run ingest:reclassify-vendas -- ...` |
| `operational_orphans_present` | Produtos legítimos sem upsert | `run-inspect-codigoid.bat` no PC + `npm run ingest:backfill-services` ou re-bootstrap permissivo |
| `totals_negative` | Devoluções > vendas no mês | Investigar data quality. Forçar com flag custom só após análise |

### Pipeline errors (status=ERROR)

- Network (`SaasApiError` HTTP 5xx): re-correr task manualmente
- SQL Server timeout: aumentar `--date` ou aguardar
- `ENABLE_AGENT_BOOTSTRAP not enabled` (503): verificar variável de
  ambiente Vercel

### Lock stuck

Se `run/pipeline.lock` ficar a mais de 6h, próximo run apaga
automaticamente (warning logado). Para forçar manualmente:

```
del C:\spharmmt\agent\run\pipeline.lock
```

Ou correr `run-daily-pipeline-auto.bat` com `--force` injectado no .bat.

## Manutenção

- Logs antigos não são apagados — limpar `logs/*` mensalmente se
  espaço em disco for crítico.
- ZIPs novos do agent: parar a task, substituir `agent.cjs` + `*.bat`
  (mantendo `agent.config.json` e `logs/`), retomar a task.

## Não fazer

- Não correr `daily-pipeline` em paralelo (o lockfile bloqueia, mas é
  feio falhar).
- Não fazer trigger automático no minuto seguinte ao login — usa
  schedule fixo para horários previsíveis.
- Não ignorar 2 abortos seguidos do mesmo tipo. É sinal de drift no
  ERP que precisa de classificação manual.
