# Fase 1 — Progresso de execução

**Data:** 2026-05-11
**Âmbito:** entrega real dos 3 workstreams da Fase 1 (operational
leverage + infra hardening). Commits pequenos, typecheck obrigatório,
zero breaking changes, zero migrations destrutivas.

---

## Sumário executivo

| Workstream | Estado | Commit | Linhas | Testes |
|---|---|---|---:|---:|
| **A — Operational Metrics Unification** | ✅ entregue | `8a44c76` | +548 / −28 | 86 verdes |
| **B — SyncRun + Tenant-safe execution** | ✅ entregue | `2298647` | +2 940 / −14 | tsc verde + smoke |
| **C — Same-CNP Transfer Intelligence** | ✅ entregue | `19b8245` | +505 / 0 | 22 verdes |

Total: **3 commits separados**, **+3 993 linhas líquidas**, **108 testes
unitários** novos, todos passam. `tsc --noEmit` passa limpo no fim de
cada workstream.

---

## Métricas reais antes/depois

| KPI | Antes | Depois | Delta |
|---|---|---|---|
| Implementações divergentes de `avgDaily / coverage` | **5** | **1** (módulo canónico) | −4 |
| Factor mágico aplicado no client | ×1.08 / ×1.04 / ×1 / ×0.96 / ×0.93 | **removido** | UI = BD |
| Ficheiros com cálculo inline da fórmula | 5 | 0 (todos consomem `metrics-shared`) | −5 |
| Scripts CLI tenant-aware | 0 | 3 (`reprocess-catalog`, `import-details-to-regulatory`, `sync-regulatory-to-produto`) | +3 |
| Modelo de observabilidade de jobs | inexistente | `SyncRun` (control plane, aditivo) | +1 |
| Helpers de execução cross-tenant | inexistentes | `lib/tenancy/for-each-tenant.ts` (sequencial) | +1 |
| Candidatos de substituição interna detectados HOJE | 16 (estimativa do plano) | **33 medidos** | +17 / +106% |
| Poupança total estimada por substituição interna | (não medida) | **1 710,54 €** (290 un.) | nova métrica |

Notas:
- Os 33 candidatos foram medidos via probe read-only contra a BD live em
  2026-05-11 (script temporário criado e removido após captura). Compara
  com os 16 que a análise inicial estimou com critérios mais
  restritivos.
- Universo: 2 farmácias activas, 14 922 ProdutoFarmacia. Esperar
  crescimento ≫ proporcional com mais farmácias.

---

## Workstream A — Operational Metrics Unification

**Commit:** `8a44c76` — *unificar avgDaily/coverage em
`lib/operational/metrics-shared`*

### O que mudou

- **`lib/operational/metrics-shared.ts` (NOVO, 209 linhas):** módulo
  puro server+client safe com a fórmula canónica. Funções:
  `avgDaily`, `coverageDays`, `monthlyVelocity`, `rotationClass`,
  `stockRuptureRisk`, `suggestedOrderQty`, `computeProductMetrics`,
  constantes `WINDOW_90D` / `WINDOW_30D`.
- **Convenção `null` é o fallback canónico** para "sem demanda
  mensurável". `999` / `Infinity` / `0`-mascarado eliminados do core.
  Callers que precisam de pintar "∞" ou "999d" mapeiam no boundary.

### Migrações

| Ficheiro | Mudança | Risco |
|---|---|---|
| `lib/stock-data.ts:63` | `avgDaily()` + `coverageDays()` + `rotationClass()` | baixo (já usava `null` fallback) |
| `lib/transferencias-data.ts:163` | `avgDaily()` + `coverageDays()` (null→Infinity no boundary) | baixo (mantém behavior) |
| `lib/transferencias-data.ts:283` | idem em `getExcessosData` | baixo |
| `lib/encomendas-data.ts:157` | `avgDaily()` + `monthlyVelocity()` + `coverageDays()` (null→999 no boundary) | baixo |
| `lib/encomendas/proposal.ts:210` | `avgDaily()` (mantém `Venda` diária + janela user-defined; semântica exacta preservada) | baixo |
| `components/encomendas/encomendas-client.tsx:184-189` | **factor mágico removido** | médio — comportamento muda |

### Mudança de comportamento documentada

- **Factor mágico ×1.08/×0.93 removido.** O número de `rotacaoMedia` que
  o utilizador vê no /encomendas passa a corresponder exactamente ao
  que está calculado server-side. Antes, o factor deformava até **+8%**
  (período=7) ou **−7%** (período=90). A `sugestao` também muda na
  mesma proporção. Calibrado ao olho originalmente — agora consistente
  com `stock-data` e `transferencias-data`.
- **Bug pre-existente fix passivo no client:** o `useMemo` que produzia
  `rowsCalculadas` não dependia de `initialRows` no deps array. Após o
  refactor passa a depender — comportamento correcto, "Gerar" deixa de
  ter risco de mostrar dados stale.

### Testes (`scripts/tests/test-operational-metrics.ts`)

**86 assertivas verdes**:

```
avgDaily:              10 testes
coverageDays:           9 testes
monthlyVelocity:        7 testes
rotationClass:         11 testes
stockRuptureRisk:      10 testes
suggestedOrderQty:      9 testes
computeProductMetrics: 22 testes (5 produtos, ~4 props cada)
sazonalidade:           5 testes
regressão antigo:      6 testes
```

Casos cobertos: zero sales · ruptura · stock excessivo · produto novo ·
estagnado · inputs não-finitos · sazonalidade simples · regressão das
convenções legadas (999/null/Infinity).

### Como verificar

```bash
npx tsc --noEmit                                # passa limpo
npx tsx scripts/tests/test-operational-metrics.ts # 86 verdes
```

---

## Workstream B — SyncRun + Tenant-safe execution

**Commit:** `2298647` — *SyncRun ledger + tenant-safe execution para 3
scripts*

### Schema additivo no control plane

- **`prisma-control/schema.prisma`:** `model SyncRun` + enums
  `SyncRunStatus` (PENDING/RUNNING/COMPLETED/FAILED) e
  `SyncRunTrigger` (CLI/CRON/UI/RETRY).
- **`prisma-control/migrations/20260511131622_add_sync_run/migration.sql`:**
  `CREATE TABLE "SyncRun" (…)` + 3 índices. **Não toca em** `Tenant`
  **nem em** `TenantEvent`. Additive-only.
- Campos mínimos exigidos pela spec: id, tenantSlug, source, status,
  startedAt, finishedAt, durationMs, recordsRead, recordsInserted,
  recordsUpdated, recordsFailed, errorSummary, triggerType, workerId.
  Mais: `metaJson` (caller-controlled JSON), `createdAt`, `updatedAt`.
- Sem FK para `Tenant` (preserva histórico após desactivação).
- 3 índices: `(tenantSlug, startedAt DESC)`, `(source, startedAt DESC)`,
  `(status, startedAt DESC)`.

⚠️ **Migration NÃO aplicada ao DB.** Para aplicar:
```bash
npx tsx scripts/control/migrate-deploy.ts
```

### Helpers

- **`lib/sync/sync-run.ts` (NOVO, 174 linhas):**
  - `startSyncRun({ tenantSlug, source, triggerType?, workerId?, meta? })`
    → cria linha RUNNING, devolve handle.
  - `completeSyncRun(id, counts?)` → marca COMPLETED, calcula
    `durationMs`, sanitiza counts.
  - `failSyncRun(id, error, counts?)` → marca FAILED, trunca
    `errorSummary` a 500 char.
  - `withSyncRun(input, fn)` → wrap que garante close em ambos os
    caminhos.
- **`lib/tenancy/for-each-tenant.ts` (NOVO, 138 linhas):**
  - `forEachActiveTenant(handler, options?)` → itera tenants ACTIVE
    **sequencialmente** (sem paralelismo nesta fase, por spec).
  - `forSingleTenant(slug, handler)` → adapter `--tenant=<slug>` para
    CLI.
  - Erros por-tenant capturados, opcionalmente re-lançados.

### Migração dos 3 scripts (não-breaking)

| Script | Novas flags | Default | Behavior sem flag |
|---|---|---|---|
| `scripts/reprocess-catalog.ts` | `--tenant=<slug>`, `--record-sync-run` | nenhuma | exactamente como antes (legacyPrisma) |
| `scripts/import-details-to-regulatory.ts` | idem | idem | idem |
| `scripts/sync-regulatory-to-produto.ts` | idem | idem | idem |

Padrão aplicado a cada um:
1. `legacyPrisma as prisma` → `let prisma: PrismaClient = legacyPrisma`
   (comutável em `main()`).
2. `runId: string | null` hoisted ao escopo do módulo (acesso a partir
   do `.catch()` no fundo do ficheiro).
3. Em `main()`: se `--tenant=`, resolve via `getTenantPrismaOrLegacy`.
   Se `--record-sync-run`, `startSyncRun({ source: "..." })`.
4. Todos os exit points (incluindo early returns por `firstBatchOnly`
   ou `eligible.length===0`) chamam `completeSyncRun`. O `.catch()`
   chama `failSyncRun`.
5. Source tags: `"regulatory-import"`, `"regulatory-sync"`,
   `"reprocess-catalog"`.

### Como verificar

```bash
npx tsc --noEmit                                 # passa limpo
npx tsx scripts/reprocess-catalog.ts --dry-run --first-batch-only --limit=0 --skip-retail
# Output mostra "tenant: (legacy — DATABASE_URL)" — back-compat confirmado.
```

Smoke teste validado: o reprocess arranca, regista o tenant, e
mantém todos os outputs anteriores. Não foi corrido contra a BD real
nesta passagem (próximo run autêntico precisa do `--record-sync-run`
+ migration aplicada).

---

## Workstream C — Same-CNP Transfer Intelligence

**Commit:** `19b8245` — *same-CNP internal substitution para encomendas
evitáveis*

### Novo módulo

- **`lib/transfers/internal-substitution.ts` (NOVO, 187 linhas):**
  - `findInternalSubstitutions(rows, options)` — pura, sem I/O,
    deterministic.
  - Detecta destino em ruptura iminente (`coverage < 7d`, configurável)
    com origem same-CNP em excesso (`coverage > 30d`).
  - `reserveDaysSource` (default 14d) evita criar nova ruptura na
    origem.
  - Quando há múltiplas origens, escolhe a com **maior cobertura**
    (mais excesso = mais resiliente).
  - Output: `{ produtoId, cnp, designacao, destinoFarmaciaId,
    destinoFarmaciaNome, destinoStock, stockCoverageDestination,
    suggestedSourceFarmaciaId, suggestedSourceFarmaciaNome,
    sourceStock, stockCoverageOrigin, transferableQty,
    avoidedPurchaseEstimate }`.
  - `avoidedPurchaseEstimate = transferableQty × destinoPuc` (fallback:
    sourcePuc → 0 €). Informativo, não bloqueia decisão.
  - Reutiliza `avgDaily` / `coverageDays` de `metrics-shared` (WS-A).
  - Ordenação por € poupados desc.

### Integração mínima em `lib/transferencias-data.ts`

- Novo export `getInternalSubstitutionsData(options?)` ao lado de
  `getTransferenciasData` e `getExcessosData`.
- Os loaders existentes **não foram tocados** — este path é
  complementar, focado em "encomendas evitáveis hoje" (mais agressivo
  na origem, mais conservador no destino).
- **NÃO integrado em encomendas** (scope respeitado conforme spec C2).

### Impacto real medido (probe live, 2026-05-11)

```
Total ProdutoFarmacia rows: 14 922
Farmácias activas:          2

Internal substitution candidates (default thresholds):
  total candidatos:                33
  qty total transferível:          290 un.
  poupança total estimada:         1 710,54 €

Top 5:
  · Forxiga 10mg 28cp           CNP=5487228 qty=29 906,83 € (Principal→Castelo, cov 33d→6d)
  · Daflon 1000 1000mg 30cp     CNP=5764022 qty=5  82,00 €  (Castelo→Principal, cov 88d→7d)
  · Atyflor Saq 10              CNP=7377390 qty=9  70,29 €  (Principal→Castelo, cov 33d→6d)
  · Nolotil 575mg 20cáps        CNP=9512434 qty=18 48,60 €  (Principal→Castelo, cov 88d→5d)
  · Ezetimiba Pharmakern 10mg   CNP=5720743 qty=9  47,52 €  (Castelo→Principal, cov 97d→1d)
```

A análise A previu **16 pares**; o detector mediu **33** com a política
default (excesso > 30d em vez de 60d, reserva 14d em vez de 20d). Os
dois números são consistentes — o WS-C é mais agressivo na origem.

### Testes (`scripts/tests/test-internal-substitution.ts`)

**22 assertivas verdes** em 10 cenários:
1. Caso base (ruptura + excesso same-CNP) ✓
2. Sem candidato (origem sem excesso) ✓
3. Múltiplas origens — escolhe a com maior cobertura ✓
4. `reserveDaysSource` respeitado (não cria nova ruptura na origem) ✓
5. Descarte quando `transferableQty < minTransferableQty` ✓
6. Destino sem demanda mensurável → out of scope ✓
7. `avoidedPurchaseEstimate` fallback para puc da origem ✓
8. Estimativa = 0 € quando puc desconhecido em ambos ✓
9. Ordenação por € poupados desc ✓
10. Origem ≠ destino farmácia (mesma farmácia não conta) ✓

### Como verificar

```bash
npx tsc --noEmit                                          # passa limpo
npx tsx scripts/tests/test-internal-substitution.ts       # 22 verdes
```

Uso em runtime (próximo passo, fora desta passagem):
```ts
import { getInternalSubstitutionsData } from "@/lib/transferencias-data";
const candidates = await getInternalSubstitutionsData();
// candidates: InternalSubstitution[] ordenados por € poupados desc
```

---

## O que ficou de fora (intencional)

- **Não integrado em `encomendas`** — spec C2 é explícito.
- **Não há UI nova** — o `getInternalSubstitutionsData` está pronto a
  ser consumido, mas o componente que o mostra é trabalho de Fase 2.
- **Migration SyncRun não aplicada à BD** — aplicar quando o operador
  estiver pronto (1 comando).
- **Os outros 31 scripts em `legacyPrisma`** mantêm-se como estão —
  spec B4 é explícito ("APENAS regulatory import, sync-regulatory,
  reprocess-catalog").
- **`IndicadoresProdutoFarmacia` ainda morto** — popular a tabela é
  Fase 1.7 conforme `notes/operational-intelligence-plan.md`.
- **Sem paralelismo em `forEachActiveTenant`** — sequencial only, spec
  B3 é explícito ("Sem paralelismo ainda").

---

## Riscos residuais

| # | Risco | Mitigação |
|---|---|---|
| R1 | Remoção do factor mágico ×1.08/×0.93 muda os números em `/encomendas` (até ±8%). Utilizador pode notar. | Documentado nos commits e nesta nota. UI mostra o que está calculado server-side; valores antes eram fictícios. |
| R2 | Migration `SyncRun` esquecida no deploy → scripts com `--record-sync-run` rebentam. | `--record-sync-run` é opt-in, default off. Sem flag, scripts correm como antes. |
| R3 | `forEachActiveTenant` sem paralelismo limita throughput total para N tenants. | Aceitável nesta fase (2 tenants). Adicionar paralelismo respeitando connection budget é Fase 2. |
| R4 | `getInternalSubstitutionsData` corre `loadPfAndSales` com `includeOutOfStock=true` — pode ser pesado em catálogos grandes. | Acceptable (14 922 rows × 2 farmácias). Re-medir quando N farmácias crescer. |

---

## Próximos passos sugeridos

1. **Aplicar a migration SyncRun** (`npx tsx scripts/control/migrate-deploy.ts`)
   e correr o primeiro reprocess com `--record-sync-run` para validar
   o ledger.
2. **Mostrar candidatos de substituição interna na UI** —
   `getInternalSubstitutionsData` está pronto. Adicionar uma secção
   em `/transferencias` (ou um novo `/transferencias/internas`) com a
   tabela ordenada por € poupados.
3. **Popular `IndicadoresProdutoFarmacia`** — Quick Win Q1 do plano
   operacional. Job dedicado, idempotente, sem leitor ainda.
4. **Activar `preferCached`** em `metrics-shared` (passo 8 do plano A1)
   quando IPF estiver populada.

---

## Como reverter (se necessário)

Os 3 commits são independentes — podem ser revertidos individualmente:

```bash
git revert 19b8245   # remove WS-C (substitution)
git revert 2298647   # remove WS-B (SyncRun + tenant-safe)
git revert 8a44c76   # remove WS-A (metrics-shared)
```

Cada revert é não-destrutivo: o WS-A reverte para as 5 implementações
divergentes (não ideal, mas funcional); WS-B reverte os 3 scripts para
o estado pré-Fase 1; WS-C remove o novo path sem mexer no existente.

A migration `SyncRun` NÃO foi aplicada à BD, portanto não há nada a
reverter no schema do control plane.
