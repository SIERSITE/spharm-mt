# IPF — Scheduler real (Vercel Cron)

**Data:** 2026-05-11
**Âmbito:** activar refresh diário automático do read-model
`IndicadoresProdutoFarmacia` via Vercel Cron. Sem UI, sem
DCI-equivalente, sem alterar lógica de encomendas.

---

## 1. Executive summary

IPF tornou-se um read-model operacional em Fase 1 (commit
`5b0428d`), mas o `dataCalculo` continuava a depender de invocação
manual do CLI. Esta fase fecha o ciclo:

1. **Lógica canónica extraída** de
   `scripts/populate-indicadores-produto-farmacia.ts` para
   `lib/operational/ipf-populate.ts` (função pura `runIpfPopulate`).
   CLI e endpoint HTTP partilham agora o mesmo path — zero duplicação.
2. **Endpoint serverless** `/api/jobs/refresh-ipf` com auth via
   `CRON_SECRET` (Bearer header **ou** `?secret=` query).
3. **Vercel Cron** configurado em `vercel.json` para correr
   diariamente às **03:00 UTC** (04:00 PT inverno / 04:00 WEST verão —
   tráfego mínimo).
4. **Health post-check** integrado: após o populate, o endpoint corre
   `getIpfFreshness` e devolve HTTP 503 se o read-model continuar
   stale/subcoberto (accionável para alerta operacional).
5. **Fallback CLI mantido**: `scripts/jobs/refresh-ipf.ts` continua
   utilizável manualmente; agora também invoca a lib directamente
   (deixou de fazer child-process spawn) e inclui health post-check
   próprio.

**156 testes verdes + 16 novos (cron-auth) = 172 verdes.**
**Typecheck limpo.**
**Smoke HTTP validado em dev:** 4/4 cenários OK (no-auth → 401,
wrong-secret → 401, valid `?secret=` → 200, valid `Authorization:
Bearer` → 200). Payload em ~2.9s.

---

## 2. Arquitectura

```
                              ┌────────────────────────┐
        Vercel Cron 03:00 UTC │ GET /api/jobs/refresh-ipf │
                              │   Authorization: Bearer  │
                              │       ${CRON_SECRET}     │
                              └────────────┬──────────────┘
                                           │
                                           ▼
                              ┌────────────────────────┐
                              │ authorizeCronRequest   │
                              │ (lib/jobs/cron-auth.ts)│
                              └────────────┬──────────────┘
                                  401  ◄───┤  ok
                                           ▼
                              ┌────────────────────────┐
                              │ runIpfPopulate(prisma) │  ← canónico
                              │ (lib/operational/      │
                              │  ipf-populate.ts)      │
                              └────────────┬──────────────┘
                                           │
                                           ▼
                              ┌────────────────────────┐
                              │ getIpfFreshness(prisma)│
                              │ (lib/operational/      │
                              │  ipf-freshness.ts)     │
                              └────────────┬──────────────┘
                                           │
                                  200 ok ◄─┼─► 503 unhealthy
                                           │
                                 JSON { populate, health }

       ┌──────────────────────────────────────────────────────────┐
       │ Manual paths (mesma lib canónica, zero duplicação):     │
       │  · scripts/populate-indicadores-produto-farmacia.ts     │
       │  · scripts/jobs/refresh-ipf.ts                          │
       │  · curl ?secret=... ao endpoint                         │
       └──────────────────────────────────────────────────────────┘
```

---

## 3. Ficheiros

| Ficheiro | Mudança | Linhas |
|---|---|---:|
| `lib/operational/ipf-populate.ts` | **NEW** — orquestração extraída, `runIpfPopulate(prisma, opts, log)` | 318 |
| `scripts/populate-indicadores-produto-farmacia.ts` | **REFACTOR** — thin-wrap sobre lib (parse argv, SyncRun, stdout) | 156 |
| `scripts/jobs/refresh-ipf.ts` | **REFACTOR** — chama lib directamente, drop child-spawn, adiciona health post-check | 195 |
| `lib/jobs/cron-auth.ts` | **NEW** — verificação timing-safe do `CRON_SECRET` (header + query) | 78 |
| `app/api/jobs/refresh-ipf/route.ts` | **NEW** — endpoint serverless | 119 |
| `vercel.json` | **NEW** — cron schedule | 9 |
| `scripts/tests/test-cron-auth.ts` | **NEW** — 16 cenários / 25 asserts (puro) | 162 |

---

## 4. Configuração de environment

| Variável | Obrigatória | Onde | Conteúdo |
|---|---|---|---|
| `CRON_SECRET` | **Sim** (em produção) | Vercel env (Project Settings → Environment Variables) | Random string ≥ 32 chars. Ex: `openssl rand -hex 24` |
| `DATABASE_URL` | Sim (já existia) | Vercel env | URL Neon legacy |
| `CONTROL_DATABASE_URL` | Não | Vercel env | Quando existir, evolui-se o endpoint para multi-tenant (ver §10) |

### 4.1 Gerar `CRON_SECRET` localmente

```bash
# Gerar:
openssl rand -hex 24
# Exemplo de output (usar uma vez, descartar):
# 0d9c6f6b2c1a4d4f9d6e1f7a8b0c9e2f3a5d7c1b6e0f4a2c

# .env local (apenas para dev):
echo 'CRON_SECRET=<valor-gerado>' >> .env
```

### 4.2 Configurar em produção (Vercel)

```bash
# Via CLI Vercel
vercel env add CRON_SECRET production
# (cola o valor quando perguntar)

# Ou via dashboard:
#   Project → Settings → Environment Variables
#   Name:        CRON_SECRET
#   Value:       <valor>
#   Environments: Production (mínimo); Preview e Development opcional
```

> **⚠️ Importante:** Vercel injecta `Authorization: Bearer
> ${CRON_SECRET}` automaticamente quando dispara o cron. **Não é
> preciso configurar nada além de definir a env.** O endpoint
> verifica que `Authorization` (ou `?secret=`) bate com `CRON_SECRET`
> de env via comparação timing-safe.

---

## 5. Cron schedule (`vercel.json`)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    {
      "path": "/api/jobs/refresh-ipf",
      "schedule": "0 3 * * *"
    }
  ]
}
```

| Campo | Valor | Justificação |
|---|---|---|
| `path` | `/api/jobs/refresh-ipf` | Endpoint deste deliverable |
| `schedule` | `0 3 * * *` | Diário, 03:00 UTC — 04:00 PT inverno / 04:00 WEST verão. Janela de baixo tráfego operacional |

### 5.1 Ajustar o horário

Editar `vercel.json` (cron syntax standard). Exemplos:

| Quando | Schedule |
|---|---|
| Todas as horas | `0 * * * *` |
| Duas vezes/dia (03:00 e 15:00 UTC) | `0 3,15 * * *` |
| Apenas dias úteis 03:00 UTC | `0 3 * * 1-5` |
| Cada 6 horas | `0 */6 * * *` |

> **Nota:** plano Vercel Hobby tem cron mensal/diário; plano Pro
> permite minutos. Confirmar plano antes de mudar para granularidade
> sub-diária.

---

## 6. Resposta do endpoint (HTTP contract)

### 6.1 Sucesso healthy — HTTP 200

```json
{
  "ok": true,
  "status": "healthy",
  "invokedAt": "2026-05-11T03:00:00.000Z",
  "durationMs": 2851,
  "populate": {
    "dryRun": false,
    "farmacias": 2,
    "produtoFarmacia": 22016,
    "rowsCalculated": 22016,
    "rowsUpserted": 22016,
    "rowsFailed": 0,
    "batches": 45
  },
  "health": {
    "coverage": 1,
    "ageHours": 0.05,
    "totalIpfRows": 22016,
    "isStale": false,
    "isLowCoverage": false,
    "reasons": []
  }
}
```

### 6.2 Populate corre mas health falha — HTTP 503

```json
{
  "ok": true,
  "status": "unhealthy",
  "durationMs": 2851,
  "populate": { "...": "..." },
  "health": {
    "coverage": 0.97,
    "isLowCoverage": true,
    "reasons": ["coverage=97.0% < threshold=98.0% (660 ProdutoFarmacia sem IPF)"]
  }
}
```

### 6.3 Não autorizado — HTTP 401

```json
{ "ok": false, "error": "unauthorized" }
```

### 6.4 Server mal-configurado (sem `CRON_SECRET`) — HTTP 503

```json
{ "ok": false, "error": "server_misconfigured", "message": "CRON_SECRET not configured" }
```

### 6.5 Erro técnico — HTTP 500

```json
{ "ok": false, "error": "internal_error", "message": "<exception message>" }
```

---

## 7. Como testar manualmente

### 7.1 Local (dev server)

```bash
# 1. Definir secret em .env:
echo 'CRON_SECRET=test-local-secret-32-chars-xxxxxxx' >> .env

# 2. Arrancar dev server:
npx next dev -p 3737

# 3. Testar dry-run (não escreve):
curl -i "http://localhost:3737/api/jobs/refresh-ipf?secret=test-local-secret-32-chars-xxxxxxx&dry=1"

# 4. Testar Bearer (forma que o Vercel usa):
curl -i -H "Authorization: Bearer test-local-secret-32-chars-xxxxxxx" \
  "http://localhost:3737/api/jobs/refresh-ipf?dry=1"

# 5. Testar sem auth (deve devolver 401):
curl -i "http://localhost:3737/api/jobs/refresh-ipf"

# 6. Live (escreve — usar com cautela):
curl -i "http://localhost:3737/api/jobs/refresh-ipf?secret=test-local-secret-32-chars-xxxxxxx"
```

### 7.2 Produção (Vercel)

```bash
# Disparar manualmente o cron em prod (Vercel CLI):
vercel cron trigger refresh-ipf --prod

# Ou via curl autenticado (Vercel CLI lê o secret do env):
curl -i \
  -H "Authorization: Bearer $(vercel env pull --environment=production --plain | grep CRON_SECRET | cut -d= -f2)" \
  "https://<seu-deploy>.vercel.app/api/jobs/refresh-ipf?dry=1"

# Ver últimos runs no dashboard:
# Vercel → Project → Cron Jobs → refresh-ipf → History
```

### 7.3 CLI fallback (sem internet, dev)

```bash
# Caminho legacy continua a funcionar idêntico ao Fase 1:
npx tsx scripts/jobs/refresh-ipf.ts --dry-run
npx tsx scripts/jobs/refresh-ipf.ts --record-sync-run
```

---

## 8. Como desligar

### 8.1 Pausar temporariamente (mantém código)

Editar `vercel.json` e remover ou comentar o objecto em `crons[]`:

```json
{ "$schema": "...", "crons": [] }
```

Commit + push → novo deploy → cron desactivado. **Sem alterar
endpoint** — fica disponível para invocação manual via curl.

### 8.2 Desligar endpoint completamente

```bash
# Remover o secret força recusa imediata:
vercel env rm CRON_SECRET production
```

Após o próximo deploy o endpoint devolve 503 com
`server_misconfigured` em todas as chamadas — Vercel Cron e manual.

### 8.3 Desligar populate (manter agendamento mas vazio)

Não recomendado. Se for preciso, alterar `vercel.json` para apontar a
um endpoint dummy (ex: `/api/health`).

---

## 9. Riscos operacionais

| Risco | Impacto | Mitigação |
|---|---|---|
| **Neon cold-start excede `maxDuration`** | Cron 504, IPF fica stale 24h | `maxDuration=300s`. Populate típico <15s. Folga >20×. Se sustained, aumentar para 600s ou pre-warm via /api/outbox/v1/heartbeat |
| **Concurrent runs** (cron + manual + CLI) | Race em upsert; resultado: linhas sobrepostas mas idempotentes (ON CONFLICT DO UPDATE com mesmos dados de input) | Idempotência garante consistência. SyncRun não é escrito em deletes; só vai ter duplicado na ledger. Aceitável. |
| **`CRON_SECRET` leak** | Atacante consegue disparar refresh à vontade | Refresh é idempotente e read-only sobre outras tabelas. Pior caso: DoS no Neon connection pool. Rotação do secret resolve. Não dá acesso a dados sensíveis. |
| **`CRON_SECRET` rotation** | Cron quebra silenciosamente até o secret bater | Vercel propaga env em ~30s após `vercel env add`. Rotação: `vercel env rm` + `vercel env add` + redeploy. Próximo cron já usa o novo. |
| **Schema drift** (novas farmácias activas, novos produtos) | Populate continua a correr; `getIpfFreshness` detecta low-coverage | Health threshold 98% absorve novos ProdutoFarmacia entre dois populates. Diários < threshold é alarmístico. |
| **Vercel Cron skip** (down-time, deploy em curso) | IPF fica stale >26h | `getIpfFreshness` marca isStale=true; próxima invocação 24h depois actualiza. UI pode mostrar idade no futuro. |
| **Falha parcial** (alguns batches falham) | Coverage cai, isLowCoverage=true | Cron devolve 503; alerta operacional opcional. Próxima execução tenta de novo (idempotente). |
| **Auth: comparação não timing-safe** | Timing attack revela prefixo do secret | `lib/jobs/cron-auth.ts` usa `crypto.timingSafeEqual` quando comprimentos batem; senão recusa sem comparar |

---

## 10. Próximos passos multi-tenant (quando `CONTROL_DATABASE_URL` existir)

Esta passagem deliberadamente fica **legacy-only**. Quando o control
plane estiver provisionado:

### 10.1 Opção A — Cron único, body com `tenant`

```json
{
  "crons": [
    { "path": "/api/jobs/refresh-ipf?tenant=castelo", "schedule": "0 3 * * *" },
    { "path": "/api/jobs/refresh-ipf?tenant=demo",     "schedule": "5 3 * * *" }
  ]
}
```

Cada tenant tem cron próprio com offset de 5min. Endpoint extende-se
para ler `?tenant=` da query, resolver via control plane, instanciar
PrismaClient correcto. Vantagem: failure isolada por tenant; observa-se
cada cron em separado no dashboard.

### 10.2 Opção B — Cron único, iteração interna

```json
{ "crons": [{ "path": "/api/jobs/refresh-ipf-all", "schedule": "0 3 * * *" }] }
```

Novo endpoint `/api/jobs/refresh-ipf-all` itera `forEachActiveTenant`
in-process. Vantagem: configuração de cron uma vez. Desvantagem: 1
timeout em ambient = todos os tenants perdem o slot.

**Recomendação:** começar com Opção A quando `CONTROL_DATABASE_URL`
existir. É mais resiliente e dá visibilidade per-tenant no dashboard
do Vercel.

### 10.3 Pré-requisitos

| Item | Estado |
|---|---|
| `CONTROL_DATABASE_URL` configurado em Vercel | **Pendente** — bloqueio actual |
| `getTenantPrismaOrLegacy(slug)` no endpoint | Existe (`lib/tenant-registry.ts`) |
| `forEachActiveTenant` para Opção B | Existe (`lib/tenancy/for-each-tenant.ts`) |
| Idempotência cross-tenant | Garantido — schema isolation per-tenant |

---

## 11. Tests / typecheck

| Suite | Resultado |
|---|---|
| `test-cron-auth.ts` (16 cenários, 25 asserts) | ✅ NEW |
| `test-operational-metrics.ts` (86) | ✅ |
| `test-internal-substitution.ts` (22) | ✅ |
| `test-encomendas-substitution.ts` (15) | ✅ |
| `test-ipf-freshness.ts` (33) | ✅ |
| **Total** | **172 verdes** (156 anteriores + 16 cron-auth) |
| `tsc --noEmit` | ✅ limpo |
| Dry-run CLI (`populate-indicadores-...`) | ✅ 22 016 linhas, 120 407,14 € — idêntico ao baseline Fase 1 |
| Dry-run wrapper (`refresh-ipf.ts`) | ✅ idêntico |
| Smoke HTTP (`/api/jobs/refresh-ipf`) | ✅ no-auth → 401, wrong → 401, ?secret= → 200, Bearer → 200 |
| Smoke HTTP latência | ✅ ~2.9s (dry, dev cold-start) |

### 11.1 O que os testes de `cron-auth` cobrem

1. `verifyCronSecret` match correcto
2. mismatch trivial
3. comprimentos diferentes
4. expected vazio (env não configurado) → `missing_env`
5. received vazio → `missing_credential`
6. comprimento incorrecto também devolve `invalid_credential` (não revela info)
7. `extractCronCredential` Bearer header
8. Bearer case-insensitive + trim
9. fallback para `?secret=` query
10. header tem prioridade sobre query
11. sem nenhum canal → null
12. scheme não-Bearer ignorado
13. `authorizeCronRequest` env não configurado → recusa
14. header válido → ok
15. query válida → ok
16. header inválido → recusa

---

## 12. Regras respeitadas

| Regra | Estado |
|---|---|
| Usar `scripts/jobs/refresh-ipf.ts` | ✅ — mantido + chama lib directamente (drop child-spawn) |
| Compatível com Vercel Cron | ✅ — `vercel.json` + endpoint serverless |
| Sem lógica duplicada | ✅ — orquestração canónica em `lib/operational/ipf-populate.ts`; CLI e route partilham |
| Endpoint protegido por secret/header | ✅ — `CRON_SECRET` timing-safe via header OU query |
| JSON com status, duration, rows, coverage, age | ✅ — payload completo em §6 |
| Cron diário, baixo tráfego | ✅ — `0 3 * * *` (03:00 UTC) |
| Legacy-only por agora | ✅ — sem multi-tenant; preparado em §10 |
| Multi-tenant fica preparado mas não activado | ✅ — `runIpfPopulate(prisma, ...)` aceita qualquer cliente |
| Health check após refresh | ✅ — `getIpfFreshness` integrado; 503 se unhealthy |
| Sem UI nova | ✅ |
| Sem DCI-equivalente | ✅ |
| Sem alterar lógica de encomendas | ✅ |
| Sem migrações destrutivas | ✅ — sem migração nenhuma |
| Fallback manual via CLI | ✅ — `populate-indicadores-produto-farmacia.ts` e `refresh-ipf.ts` continuam idênticos para o utilizador |

---

## 13. Comandos de validação

```bash
# Typecheck
npx tsc --noEmit

# Testes (172 verdes)
npx tsx scripts/tests/test-cron-auth.ts
npx tsx scripts/tests/test-operational-metrics.ts
npx tsx scripts/tests/test-internal-substitution.ts
npx tsx scripts/tests/test-encomendas-substitution.ts
npx tsx scripts/tests/test-ipf-freshness.ts

# Dry-run via CLI
npx tsx scripts/populate-indicadores-produto-farmacia.ts --dry-run
npx tsx scripts/jobs/refresh-ipf.ts --dry-run

# Smoke HTTP (dev server com CRON_SECRET na .env):
CRON_SECRET=<seu-secret> npx next dev -p 3737
# noutra shell:
curl -i "http://localhost:3737/api/jobs/refresh-ipf?secret=<seu-secret>&dry=1"
curl -i -H "Authorization: Bearer <seu-secret>" "http://localhost:3737/api/jobs/refresh-ipf?dry=1"
curl -i "http://localhost:3737/api/jobs/refresh-ipf"          # → 401
```

---

## 14. Decisão pendente (próximo passo natural)

Esta fase fecha o ciclo operacional do IPF. Quanto à decisão entre os
dois caminhos discutidos na Fase A (`dashboard tile`):

- **DCI-equivalente** continua adiada (~1,5-2 dias, requer validação
  clínica)
- **Scheduler real** → **FEITO neste deliverable**

Próximos caminhos naturais agora:

**A. Activar `CONTROL_DATABASE_URL`** + estender cron para
multi-tenant per §10. Esforço: ~0,5 dia depois de provisionar a BD.

**B. DCI-equivalente.** Universo de oportunidades de substituição
3-5× maior. Esforço: ~1,5-2 dias + validação clínica.

**C. Alerta operacional sobre 503.** Quando o cron devolver
unhealthy, enviar email/Slack. Esforço: ~0,5 dia. Requer
infrastructure de notificação (Resend/Slack webhook).

Não inicio nenhum sem aprovação.

---

_Cron diário · auth timing-safe · health post-check · payload JSON
estruturado · fallback CLI preservado · multi-tenant preparado mas
desactivado · zero lógica duplicada._
