# IPF Fase 1.5 — Operationalization

**Data:** 2026-05-11
**Âmbito:** colocar IPF em modo operacional — freshness guard,
wrapper scheduler-ready, health CLI com exit code. Sem UI, sem cron
real, sem remover legacy.

---

## 1. Executive summary

A Fase 1 populou IPF com 22 016 rows e activou dual-read em 3
loaders. Esta fase 1.5 fecha o ciclo operacional: detector de
staleness, wrapper pronto para scheduler externo, health check
adequado para monitoring.

**Entregue:**
- `lib/operational/ipf-freshness.ts` — pure `analyzeFreshness` +
  async `getIpfFreshness`. Defaults: stale > 26h, low-coverage <
  98%.
- `scripts/jobs/refresh-ipf.ts` — wrapper que spawn-chama
  `populate-indicadores-produto-farmacia`. Suporta `--tenant=<slug>`,
  `--all-tenants`, `--record-sync-run`, `--dry-run`. Falha rápido se
  `--all-tenants` for usado sem `CONTROL_DATABASE_URL`.
- `scripts/ipf-health.ts` — CLI com exit code: 0 healthy, 1 stale ou
  low-coverage, 2 erro técnico. Imprime sumário + top 20 capital
  parado + top 20 ruptura iminente.
- `scripts/tests/test-ipf-freshness.ts` — 33 testes verdes sobre o
  pure `analyzeFreshness`.

**Validado live:**
- `ipf-health` contra a BD legacy: HEALTHY · 22 016 rows · cobertura
  100,00% · idade 0,3h · 2,8s elapsed.
- Exit codes confirmados (sem pipe, que mascarava): healthy=0,
  stale=1, low-coverage=0 (cobertura=100%, threshold≤1), wrapper sem
  CONTROL=2.
- `refresh-ipf --dry-run` legacy: passa-through ao populate, 0
  exit code, 3,6s end-to-end.

---

## 2. Freshness / staleness guard

### 2.1 API

`lib/operational/ipf-freshness.ts` expõe duas funções:

```ts
export function analyzeFreshness(
  snapshot: FreshnessSnapshot,
  options?: FreshnessOptions,
  now?: Date,
): IpfFreshness;

export async function getIpfFreshness(
  prisma: PrismaClient,
  options?: FreshnessOptions,
): Promise<IpfFreshness>;
```

- `FreshnessSnapshot`: contagens + timestamps brutos (`totalIpfRows`,
  `totalPfRows`, `maxDataCalculo`, `minDataCalculo`).
- `FreshnessOptions`: `thresholdHours` (default 26),
  `thresholdCoverage` (default 0,98).
- `IpfFreshness`: snapshot + thresholds aplicados + flags
  (`isStale`, `isLowCoverage`, `healthy`) + `reasons` legíveis.

### 2.2 Regras (pure)

```
ageHours    = max(0, (now - maxDataCalculo) / 3600s)
coverage    = totalPfRows === 0 ? 1 : totalIpfRows / totalPfRows
missingRows = max(0, totalPfRows - totalIpfRows)

isStale       = maxDataCalculo === null ? true : ageHours > thresholdHours
isLowCoverage = coverage < thresholdCoverage
healthy       = !isStale && !isLowCoverage
```

### 2.3 Justificação dos defaults

- **26h**: O populate corre em 6s. Qualquer atraso superior a um dia
  (24h + 2h de margem) significa job parado, não atraso operacional.
- **98%**: Acomoda novas `ProdutoFarmacia` ingeridas entre dois
  populates (cresce ~0-50 PFs/dia em ambiente real, sobre 22 016 →
  ~0,2%/dia). Threshold mais apertado dispararia falsos positivos
  pós-ingestão.

### 2.4 Testes (`scripts/tests/test-ipf-freshness.ts`)

10 cenários × 33 assertivas, todos verdes:

```
1. healthy completo (cobertura 100% + idade 1h)
2. stale por idade (30h > 26h)
3. low coverage (90,8% < 98%)
4. stale + low coverage (ambos os reasons populados)
5. IPF vazia (totalIpfRows=0, maxDataCalculo=null)
6. sem ProdutoFarmacia (coverage=1 trivialmente, mas isStale=true)
7. custom thresholds (4h, 99%)
8. ageHours exactamente == threshold (não estritamente > → não stale)
9. ageHours não vai negativo (data futura clamped a 0)
10. coverage > 100% permitido (rows IPF residuais > PFs vivos)
```

Casos críticos: cancellation correcta entre stale, low-coverage,
healthy; comportamento determinístico face a edges (`null`,
intervalos futuros, totalPfRows=0).

---

## 3. Scheduler-ready wrapper

### 3.1 Design

`scripts/jobs/refresh-ipf.ts` não duplica lógica de cálculo. Faz
spawn do `scripts/populate-indicadores-produto-farmacia.ts` como
child process (stdio inherited). Isolamento por processo:
cada chamada tem o seu próprio PrismaClient + ciclo de vida.

### 3.2 Modos

| Modo | Trigger | Comportamento |
|---|---|---|
| Legacy | sem flag | spawn 1× contra `DATABASE_URL` |
| Tenant único | `--tenant=<slug>` | spawn 1× com flag propagada |
| Todos tenants | `--all-tenants` | itera ACTIVE via `forEachActiveTenant`; spawn por tenant |

Outras flags propagadas: `--record-sync-run`, `--dry-run`,
`--farmacia=<id>`, `--parado-threshold=<dias>`.

### 3.3 Fail-fast paths

`--all-tenants` sem `CONTROL_DATABASE_URL`:

```
[fatal] --all-tenants requer CONTROL_DATABASE_URL configurado. Define
no .env ou usa --tenant=<slug> / sem flag (legacy).
```

Exit code **2**. Comportamento idêntico ao do legado
`scripts/control/migrate-deploy.ts`.

Tenant individual falha (exit ≠ 0 do populate) durante
`--all-tenants`: registado em `summary.failures`, mas iteração
continua. No fim, se `summary.failed > 0`, exit code **1** com lista
de falhas. Não é all-or-nothing — falhas isoladas não bloqueiam o
batch.

### 3.4 Validado

```bash
# legacy dry-run
$ npx tsx scripts/jobs/refresh-ipf.ts --dry-run
... [populate output] ...
refresh-ipf concluído. exitCode=0 elapsed=3.6s
# exit: 0

# all-tenants sem CONTROL
$ npx tsx scripts/jobs/refresh-ipf.ts --all-tenants
[fatal] --all-tenants requer CONTROL_DATABASE_URL configurado...
# exit: 2
```

### 3.5 Não fez

- Não criou cron. O wrapper é o ponto de entrada que o scheduler
  externo chamaria. Decisão deliberada — cron real é fase
  posterior (ver `notes/infra-hardening-plan.md`).
- Não refactorou `populate-indicadores-produto-farmacia.ts`. Continua
  como script CLI standalone. Spawn é mais isolado que
  module-import.

---

## 4. Read-model health CLI

### 4.1 Output

`scripts/ipf-health.ts` produz:

1. **[1] Freshness**: rows IPF, rows PF, coverage, missing,
   dataCalculo max/min, ageHours, isStale, isLowCoverage.
2. **[2] Top 20 capital parado**: ordenado por `valorStockParado`
   desc.
3. **[3] Top 20 ruptura iminente**: `diasStockRestante < 7` e
   `mediaVendasDiarias90d > 0.05`, ordenado asc.
4. **Veredicto final** uma linha: `✅ HEALTHY ...` ou
   `❌ UNHEALTHY ...` + lista de `reasons`.

### 4.2 Exit codes

| Code | Significado |
|---|---|
| 0 | healthy (todos os thresholds passados) |
| 1 | stale OU low-coverage |
| 2 | erro técnico (DB inacessível, exception) |

Pronto a usar em CI / monitoring / pre-flight checks.

### 4.3 Flags

```bash
# Default (top 20, threshold 26h / 98%)
npx tsx scripts/ipf-health.ts

# Top maior / menor
npx tsx scripts/ipf-health.ts --top=10

# Thresholds custom
npx tsx scripts/ipf-health.ts --threshold-hours=12 --threshold-coverage=0.99

# Quiet (só linha final + exit code)
npx tsx scripts/ipf-health.ts --quiet
```

### 4.4 Live run (2026-05-11, BD legacy)

```
[1] Freshness:
    IPF rows:              22 016
    ProdutoFarmacia rows:  22 016
    coverage:              100,00%
    missing rows:          0
    dataCalculo (max):     2026-05-11T14:01:22.371Z
    dataCalculo (min):     2026-05-11T14:01:16.652Z
    ageHours (max):        0,32h
    isStale:               false
    isLowCoverage:         false

[2] Top 10 CAPITAL PARADO:
      727,35 €  CNP=5826912  stock=  5  ABC=NAO_CLASSIFICADO  "Paliperidona Alter 150 Mg" (Castelo)
      690,13 €  CNP=5887005  stock=  7  ABC=NAO_CLASSIFICADO  "Rybelsus 4 Mg" (Castelo)
      ...

[3] Top 10 RUPTURA IMINENTE:
     0,8d  CNP=5632062  stock=  1  vel=1,33/d  ABC=A  "Amoxi+Clav 875 Mg" (Castelo)
     1,3d  CNP=2898096  stock=  1  vel=0,77/d  ABC=A  "Metoclopramida Labesfal" (Principal)
     ...

✅ HEALTHY · 22 016 rows · coverage 100,00% · age 0,3h · elapsed 2,8s
```

Exit code **0**.

### 4.5 Caveat encontrado durante validação

Pipes mascaram exit codes em bash (último comando do pipe ganha).
Para CI: usar redirect (`>/dev/null`) ou `set -o pipefail`. Não é
problema do CLI — é comportamento standard de shell.

---

## 5. Relação com componentes pré-existentes

| Componente | Reusado | Como |
|---|---|---|
| `scripts/populate-indicadores-produto-farmacia` | sim | spawn from refresh-ipf |
| `lib/operational/ipf-calculator` | indirectamente | populate usa, freshness não toca |
| `lib/operational/ipf-reader` | não | freshness usa Prisma client directamente (não server-only) |
| `lib/tenancy/for-each-tenant` | sim | refresh-ipf `--all-tenants` |
| `lib/sync/sync-run` | sim | refresh-ipf propaga `--record-sync-run` ao populate |

Sem duplicação. Sem alteração de superficies existentes.

---

## 6. O que NÃO foi feito (conforme regras)

- ❌ Sem UI nova.
- ❌ Sem cron real. O wrapper está pronto; scheduler externo é
  decisão de produto (ver §10).
- ❌ Sem remover fallback legacy. `lib/operational/ipf-reader.resolveAvgDaily90d`
  continua a cair para live computation quando IPF row ausente.
- ❌ Sem tocar em `lib/encomendas/proposal.ts` (depende de `Venda`
  diária, fora do scope IPF).

---

## 7. Riscos e limitações

| # | Item | Severidade | Notas |
|---|---|---|---|
| L1 | Counters in-process do `ipf-metrics` resetam entre cold starts serverless | baixa | Aceitável; persistência em SyncRun é next iteration |
| L2 | Wrapper `--all-tenants` precisa de `CONTROL_DATABASE_URL` configurado | baixa | Fail-fast com mensagem clara; exit 2 |
| L3 | Health CLI `--threshold-coverage=1.0` não força unhealthy quando coverage=100% (não é estritamente <) | baixa | Comportamento correcto, semântica matches `analyzeFreshness` |
| L4 | Pipes (`\| tail`) mascaram exit code em bash | baixa | Padrão shell; usar `>/dev/null` ou `pipefail` em CI |
| L5 | Spawn por tenant em `--all-tenants` adiciona ~500ms de startup × N tenants | baixa | Aceitável para job diário com poucos tenants; reconsiderar a > 50 tenants |

---

## 8. Comandos de operação

### 8.1 Health check periódico

```bash
# Sanity check rápido (CI / cron-check)
npx tsx scripts/ipf-health.ts --quiet
echo $?   # 0=healthy, 1=stale/low-coverage, 2=erro
```

### 8.2 Refresh (sem scheduler)

```bash
# Único tenant (manual)
npx tsx scripts/jobs/refresh-ipf.ts --dry-run             # preview
npx tsx scripts/jobs/refresh-ipf.ts --record-sync-run     # live + ledger

# Todos tenants ACTIVE (requer CONTROL_DATABASE_URL)
npx tsx scripts/jobs/refresh-ipf.ts --all-tenants --record-sync-run
```

### 8.3 Diagnóstico exploratório

```bash
# Snapshot detalhado + micro-benchmark
npx tsx scripts/ipf-stats.ts --top=20 --bench-iterations=10
```

---

## 9. Testes

- 33 testes para `analyzeFreshness` (pure) — 10 cenários.
- 86 testes pré-existentes para `metrics-shared` — continuam verdes.
- 22 testes pré-existentes para `internal-substitution` — continuam
  verdes.
- **Total 141 testes unitários verdes.**
- `tsc --noEmit` passa limpo.

---

## 10. Próxima decisão (do utilizador)

Após este checkpoint, há 3 caminhos:

**A. Expor IPF na UI operacional.** Tile no dashboard com:
- "X € em capital parado" (link → top 20)
- "N produtos em ruptura iminente" (link → top 20)
- "Última actualização IPF" (idade em horas; vermelho se > 26h)

Esforço: ~1 dia. Pode ser feito imediatamente.

**B. Integrar substituição inteligente em encomendas.** Modificar
`/encomendas` para mostrar "↻ transferir de Farmácia X (excesso)"
no contexto de cada linha sugerida. Reusa o `getInternalSubstitutionsData`
do WS-C.

Esforço: ~1-1,5 dias. Maior impacto operacional (encomendas
evitáveis).

**C. Activar scheduler real.** Vercel Cron (≤ 5min) ou daemon
externo (Railway/Fly) — chamando `refresh-ipf.ts` diariamente.
Inclui:
- Alerta operacional quando `ipf-health` falha.
- Métrica de runs históricos em SyncRun (já wired).

Esforço: ~0,5-1 dia. Requer decisão sobre infra hosting (já
documentada em `notes/infra-hardening-plan.md`).

Recomendação técnica (não decisão): **B → A → C**. B usa o pipeline
agora (impacto), A torna o sinal visível ao gestor (UX), C automatiza
(infra). Não inicio nenhuma destas sem aprovação.

---

_Sem UI. Sem cron. Sem mexer em `proposal.ts`. Sem remover legacy.
Tudo o que mudou: 1 helper + 2 scripts + 1 suite de testes._
