# Operational Consolidation Batch — Relatório Executivo

**Data:** 2026-05-11

## Fechou neste batch

| # | Item | Estado | Evidência |
|---|---|---|---|
| 1 | DCI-equivalente em /encomendas | **Já shipado** (commit `d797fca`) | Same-CNP wins · badge amber cautelar |
| 2 | 3 catalog corrections aplicadas | **APPLIED + IDEMPOTENT** | `scripts/apply-catalog-corrections-2026-05.ts --apply` · re-execução confirmou já-ok=3 |
| 3 | ATC/DCI visíveis em encomendas/stock/transferências | **APPLIED** | Chip ATC mono + DCI text + tooltip title em cada UI |
| 4 | IPF freshness no /admin | **APPLIED** | Panel verde/âmbar com rows · coverage% · ageH · razões |
| 5 | `forEachActiveTenant` com `parallelLimit` | **APPLIED** | Helper pronto para futuros consumers; `migrate-all-tenants` mantém runner próprio (precisa connection string raw, não PrismaClient) |
| 6 | IPF follow-through | **Verificado: nada a migrar** | Loaders `stock-data`/`transferencias-data`/`encomendas-data` já usam `loadIpfBatch`+`resolveAvgDaily90d`. `proposal.ts` tem contrato diferente (janela escolhida pelo utilizador) — não é caso IPF. |

## Validações

- `tsc --noEmit` ✅ limpo
- 7 suites / 252 asserts ✅ verdes
- HTTP smoke: `/encomendas`, `/stock`, `/transferencias` → 200 em dev
- `/admin` → 500 **pré-existente** (`CONTROL_DATABASE_URL` não provisionado nesta env). Painel IPF é `try/catch` + render condicional — gracefully ausente quando control plane offline.

## Catalog corrections aplicadas (item 2)

| CNP | Campo | Antes → Depois |
|---|---|---|
| 9774109 (Psodermil) | `dci` | "Betametasona + Ácido salicílico" → **"Ácido salicílico"** |
| 5359567 (Momendol gel) | `codigoATC` | "M01AE02" (oral) → **"M02AA12"** (tópico) |
| 5752811 (Vibrocil spray) | `codigoATC` | "D03AX03" (cicatrizante) → **"R01AB06"** (descongestionante nasal) |

Script idempotente — `--apply` muda só o que diverge; sem flag faz dry-run; re-executar é no-op.

## Impacto operacional directo

- **Visibilidade clínica em todas as listagens core.** ATC+DCI passam a aparecer compactamente em encomendas/stock/transferências (chip mono + texto + tooltip). Operador deixa de precisar abrir a ficha do artigo para validar substituições/equivalências.
- **Catálogo com menos ruído.** 3 mis-classificações conhecidas corrigidas. Pares Momendol↔Reuxen (naproxeno gel) e Vibrocil↔Septanazal/Nasex (descongestionantes) destrancados estruturalmente para o detector DCI-equivalente.
- **Saúde IPF visível ao admin.** Estado actual do read-model (rows, coverage, idade) num cartão no topo de `/admin` — sem nova infra, consome `getIpfFreshness` já existente.
- **Throughput de scripts multi-tenant.** `forEachActiveTenant` ganhou `parallelLimit` configurável; próximos jobs daily/weekly tenant-aware podem adoptar sem reescrever runners de concorrência ad-hoc.

## O que continua pendente

- **`CONTROL_DATABASE_URL` não provisionado.** Bloqueia: `/admin`, `--all-tenants` no scheduler IPF, multi-tenant real. Decisão operacional, não código.
- **Catálogo regulatório ~28% coverage.** `RegulatoryAcquisitionJob` pipeline existe mas sem fetchers reais; universo DCI-equivalente cresce 3× quando atingir 80%+.
- **Acceptance logging.** Não logamos quando o operador aceita/rejeita uma sugestão (same-CNP ou DCI). Sem dados não há feedback loop.

## Próximos 3 bottlenecks reais

1. **Catálogo regulatório.** Sem mais cobertura DCI/ATC nada disto escala. Fetcher real para `RegulatoryAcquisitionJob` é o maior unlock — multiplicador ~3× no universo de equivalência.
2. **Compras agregadas vazias.** `Compra` table sem pipeline produtivo → IPF tem 3 campos a NULL (`diasSemVenda`, `ultimoPrecoCompra`, `ultimoFornecedorId`). Encomendas mostra "0 compras" em `movimentos6M.compras`. Ingest real desbloqueia cobertura completa do read-model.
3. **Multi-tenant production.** `CONTROL_DATABASE_URL` por provisionar; sem isso o resto da plataforma é single-tenant na prática. Painel admin não arranca, scheduler limitado a legacy, helpers prontos mas inúteis. Decisão de infra, não código.

---

_Ficheiros tocados: `lib/transferencias-data.ts`, `lib/stock-data.ts`, `lib/stock-shared.ts`, `lib/encomendas-data.ts`, `lib/admin/tenant-data.ts`, `lib/tenancy/for-each-tenant.ts`, `components/stock/stock-client.tsx`, `components/transferencias/transferencias-client.tsx`, `components/encomendas/encomendas-client.tsx`, `app/admin/page.tsx`, `scripts/apply-catalog-corrections-2026-05.ts`. 252 asserts verdes._
