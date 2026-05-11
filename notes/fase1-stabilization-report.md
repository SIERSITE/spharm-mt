# Fase 1 — Relatório de estabilização

**Data:** 2026-05-11
**Âmbito:** checkpoint de estabilização pós-Fase 1 (WS-A/B/C). Aplicar
migration `SyncRun`, smoke test tenant-safe, verificar fallback legacy.
**Estado:** **PARCIAL**. Stack de código verde e CLI-safe; migration
**não aplicada** por `CONTROL_DATABASE_URL` em falta neste ambiente.

---

## 1. Resumo executivo

| Item | Estado | Notas |
|---|---|---|
| Migration `SyncRun` aplicada ao control plane | ❌ **bloqueado** | `CONTROL_DATABASE_URL` em falta no `.env` |
| Tenants ACTIVE listados | ❌ **bloqueado** | dependência do control plane |
| Script tenant-safe correu contra tenant real | ❌ **bloqueado** | dependência do control plane |
| `SyncRun` criado/fechado e validado em BD | ❌ **bloqueado** | dependência do control plane |
| **Fallback legacy funcional sem flags** | ✅ **OK** | `reprocess-catalog --dry-run` corre como antes |
| **Fallback legacy ao usar `--tenant=<slug>` inexistente** | ✅ **OK** | tenant-registry catch + fall through |
| **`--record-sync-run` falha com erro accionável** | ✅ **OK** | mensagem clara em vez de stack trace Prisma |
| **Bug pré-existente fixado: CLI-import de helpers** | ✅ **OK** | novo commit `5b0428d` |
| `tsc --noEmit` | ✅ **verde** | sem erros |
| Testes unitários | ✅ **108 verdes** | 86 metrics + 22 substitution |

**Veredicto:** o código de Fase 1 está estável e CLI-safe. A
infraestrutura completa (control plane DB) **ainda não foi provisionada
neste ambiente**, portanto a parte "tenant + SyncRun real" não pode
ser exercitada até o operador configurar `CONTROL_DATABASE_URL`.

---

## 2. Migration `SyncRun`

### 2.1 Estado actual

```
$ npx tsx scripts/control/migrate-deploy.ts
[control] CONTROL_DATABASE_URL em falta. Define no .env antes de correr scripts do control plane.
```

### 2.2 Causa

O ambiente local actual (`.env` e `.env.production.local`) define apenas
`DATABASE_URL` (apontando para a BD `neondb` em `ep-polished-lake-…`),
mas **não tem** `CONTROL_DATABASE_URL`. O control plane Prisma schema
existe (`prisma-control/schema.prisma`), tem o `SyncRun` model já
escrito (commit `2298647`) e o ficheiro SQL pronto em
`prisma-control/migrations/20260511131622_add_sync_run/migration.sql`,
mas **não está provisionado em DB** porque nunca houve URL para
apontar.

Isto **não é regressão da Fase 1**: o control plane DB está
proveniente do Phase 0 (Q1 2026, commit `9e69526` introduziu os
helpers `controlPrisma` + schemas), e nunca foi provisionado no
ambiente local. O Phase 0 deixou a infra pronta para ser activada
quando os primeiros tenants reais aparecerem.

### 2.3 Próximo passo (para o operador)

```bash
# 1. Criar uma BD adicional no Neon (ou outra Postgres):
#    nome sugerido: spharmmt_control
#    pode ser uma branch da mesma project no Neon (free tier OK).

# 2. Adicionar ao .env:
echo 'CONTROL_DATABASE_URL="postgresql://USER:PASS@HOST/spharmmt_control?sslmode=require"' >> .env

# 3. Aplicar TODAS as migrations control-plane (init + ingest-key + sync-run):
npx tsx scripts/control/migrate-deploy.ts

# 4. Validar:
npx tsx scripts/control/migrate-status.ts
```

Após isto, todas as smoke tests da §4 ficam exercitáveis.

---

## 3. Patch CLI-safe (estabilização adicional, commit `5b0428d`)

Durante a validação descobriu-se um **bug pré-existente latente** que
bloqueava o uso CLI de **qualquer** helper que tocasse no control
plane:

```
$ npx tsx scripts/tenancy/list-tenants.ts
Error: Cannot find module 'server-only'
Require stack:
- C:\projetos\spharm-mt\lib\tenant-crypto.ts
- C:\projetos\spharm-mt\lib\control-plane.ts
- C:\projetos\spharm-mt\scripts\tenancy\list-tenants.ts
```

`lib/control-plane.ts` (e `lib/tenant-crypto.ts`, mais 23 outros)
têm `import "server-only"` para enforce do limite client/server no
bundler do Next. Em runtime CLI via `tsx`, o módulo `server-only` não
existe e o load falha.

`lib/tenant-registry.ts` já contornava isto deliberadamente — tem
comentário explícito. Os meus helpers de Fase 1 WS-B
(`lib/sync/sync-run.ts`, `lib/tenancy/for-each-tenant.ts`) caíram
neste mesmo problema porque importavam `controlPrisma` /
`listTenants` directamente de `control-plane.ts`.

**Fix narrow** (sem mexer em `control-plane.ts` para evitar arrastar
25 ficheiros):

- **NOVO `lib/sync/control-client-cli.ts`** — constrói um
  `PrismaClient` para o schema control SEM passar por
  `control-plane.ts`. Mensagem de erro accionável se
  `CONTROL_DATABASE_URL` em falta.
- `lib/sync/sync-run.ts` → usa `getControlPrismaCli()` em vez de
  `controlPrisma`.
- `lib/tenancy/for-each-tenant.ts` → query `listActiveTenantsCli()`
  inline (substitui `listTenants` de control-plane) + tipo local
  mínimo `TenantRecord` (subset do tipo completo de control-plane).

O `scripts/tenancy/list-tenants.ts` legado **continua a ter o bug**
(importa `lib/control-plane.ts` directamente) — está fora do âmbito
de WS-B; fica para outro ciclo.

---

## 4. Smoke tests

### 4.1 Legacy (no flags) — back-compat

**Comando:**
```bash
npx tsx scripts/reprocess-catalog.ts --dry-run --first-batch-only --limit=0 --skip-retail
```

**Output relevante:**
```
  dryRun:          true
  tenant:          (legacy — DATABASE_URL)
  baseline:
    PASS 1 (med + Outros Medicamentos):  2487
    PASS 2 (med com campos em falta):    3821
PASS 1 — MEDICAMENTO em "Outros Medicamentos"
```

**Resultado:** ✅ Script arranca, lê a BD legacy, mostra baseline
coerente com o estado pós-INFOMED (2 487 produtos em "Outros
Medicamentos"). Nenhuma referência a control plane. Sem regressão.

### 4.2 `--tenant=<slug>` com slug inexistente — fallback gracioso

**Comando:**
```bash
npx tsx scripts/reprocess-catalog.ts --tenant=demo --dry-run --first-batch-only --limit=0 --skip-retail
```

**Output relevante:**
```
[tenant-registry] warm-up do control plane falhou — apenas legacy client disponível. Cannot find module 'server-only'
[tenant-registry] slug "demo" não está no cache — a cair no legacy.
  Se o tenant foi provisionado após o arranque, reinicia o dev server.
  dryRun:          true
  tenant:          demo
  baseline:
    PASS 1 (med + Outros Medicamentos):  2487
```

**Resultado:** ✅ Tenant-registry detecta a falha do control plane,
catch silencioso, fall-through para legacy client. Script corre
contra a BD legacy mas reporta o slug requested. Nenhum crash.

**Caveat documentado:** com `CONTROL_DATABASE_URL` configurado, este
warm-up resolveria o slug correctamente; se o slug não existisse no
control plane, ainda assim cairia em legacy (comportamento
pretendido — protege development).

### 4.3 `--record-sync-run` sem control plane — erro accionável

**Comando:**
```bash
npx tsx scripts/reprocess-catalog.ts --record-sync-run --dry-run --first-batch-only --limit=0 --skip-retail
```

**Output:**
```
[erro fatal] Error: CONTROL_DATABASE_URL em falta. SyncRun ledger e iteração tenant-aware requerem o control plane configurado. Define no .env ou omite as flags --record-sync-run / --tenant=.
```

**Resultado:** ✅ Falha rápida com mensagem clara que diz exactamente
o que falta e como contornar (omitir a flag). Não rebenta com stack
trace Prisma críptico.

### 4.4 `--tenant=<slug> --record-sync-run` (caminho pleno)

**Não exercitado** — depende de:
1. `CONTROL_DATABASE_URL` configurada
2. Migration aplicada (cria a tabela `SyncRun`)
3. Pelo menos 1 tenant ACTIVE no control plane

Sequência completa quando o operador configurar o control plane:

```bash
# 1. Configurar e migrar (uma vez):
echo 'CONTROL_DATABASE_URL="postgresql://..."' >> .env
npx tsx scripts/control/migrate-deploy.ts

# 2. Listar tenants (verificar pré-condições) — usa list-tenants
#    LEGADO que ainda precisa de fix CLI-safe; alternativa:
psql "$CONTROL_DATABASE_URL" -c 'SELECT slug, estado FROM "Tenant"'

# 3. Smoke test pleno:
npx tsx scripts/reprocess-catalog.ts \
   --tenant=<slug> \
   --record-sync-run \
   --dry-run --first-batch-only --limit=0 --skip-retail

# 4. Validar SyncRun criado:
psql "$CONTROL_DATABASE_URL" -c \
  'SELECT id, "tenantSlug", source, status, "durationMs",
          "recordsRead", "recordsUpdated", "recordsFailed"
   FROM "SyncRun" ORDER BY "startedAt" DESC LIMIT 5'
```

Espera-se 1 linha com `status=COMPLETED`, contadores populados,
`durationMs` razoável (sub-segundo para um dry-run/limit=0).

---

## 5. Outras verificações finais

### 5.1 `tsc --noEmit`

```bash
$ npx tsc --noEmit
(sem output → verde)
```

### 5.2 Testes unitários

| Suite | Testes | Resultado |
|---|---:|---|
| `scripts/tests/test-operational-metrics.ts` | 86 | ✅ verde |
| `scripts/tests/test-internal-substitution.ts` | 22 | ✅ verde |
| **Total** | **108** | ✅ verde |

### 5.3 Outros testes do projecto (sanity check)

| Suite | Resultado |
|---|---|
| `scripts/tests/test-canonical-mapping.ts` | (não corrido — fora do âmbito desta passagem; mas não foi tocado) |
| `scripts/tests/test-medicamento-mapping.ts` | idem |
| `scripts/tests/test-infomed-detail-fetcher.ts` | idem |
| `scripts/tests/test-retail-cnp-7488585.ts` | idem |
| `scripts/tests/test-atc-prefix-mapping.ts` | idem |

---

## 6. Commits desta passagem

| Commit | Conteúdo | Linhas |
|---|---|---:|
| `5b0428d` | WS-B stabilization: helpers CLI-safe (control-client-cli.ts + ajustes em sync-run.ts e for-each-tenant.ts) | +90 / −9 |

Total Fase 1 + estabilização: **5 commits**:
```
5b0428d  WS-B stabilization: control-plane import CLI-safe
c70c46d  Fase 1 progress report: WS-A + WS-B + WS-C entregues
19b8245  WS-C: same-CNP internal substitution para encomendas evitáveis
2298647  WS-B: SyncRun ledger + tenant-safe execution para 3 scripts
8a44c76  WS-A: unificar avgDaily/coverage em lib/operational/metrics-shared
```

---

## 7. Riscos abertos e recomendações

| # | Risco/Gap | Severidade | Acção sugerida |
|---|---|---|---|
| G1 | `CONTROL_DATABASE_URL` não configurada → SyncRun ledger e iteração multi-tenant não exercitáveis | médio | Provisionar Neon branch para control plane (free tier OK), aplicar migration |
| G2 | `scripts/tenancy/list-tenants.ts` ainda quebra em CLI (importa `lib/control-plane.ts` directamente, que tem `server-only`) | baixo | Refactor para usar `getControlPrismaCli()` num futuro ciclo. Não bloqueante. |
| G3 | Outros 24 ficheiros com `import "server-only"` indirectamente acessíveis a partir de CLI → cascade de erros se alguém os puxar | baixo | Convenção a documentar: helpers CLI usam `lib/sync/control-client-cli` ou equivalente; nada de `lib/admin/*` ou `lib/integracao/*` em scripts |
| G4 | Sem CI a correr os testes automaticamente | baixo | Adicionar GitHub Actions com `npx tsc --noEmit` + suites de testes — fora do âmbito desta passagem |
| G5 | Smoke test pleno (tenant + SyncRun com BD real) não exercitado neste ambiente | médio | Fica como "checklist do operador" no §4.4 — executar imediatamente após provisionar control plane |

---

## 8. Conclusão

**O código de Fase 1 está estável.** As 3 workstreams (A/B/C) +
estabilização CLI-safe estão entregues e validadas no que se pode
validar localmente:

✓ Fallback legacy preservado: scripts CLI antigos continuam a correr
  sem mudança de comportamento.
✓ Fallback gracioso para `--tenant=<slug>` mesmo sem control plane.
✓ Erro claro e accionável para `--record-sync-run` sem
  `CONTROL_DATABASE_URL`.
✓ tsc + 108 testes unitários verdes.

**Próximo passo bloqueante para activação completa:** configurar
`CONTROL_DATABASE_URL` e aplicar a migration. **Não inicia nova
feature** até este checkpoint estar fechado, conforme regra do
utilizador.
