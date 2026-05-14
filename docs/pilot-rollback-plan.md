# Pilot Rollback Plan

Procedimento para reverter o piloto em produção. Aplicar **na ordem
indicada**. Não combinar steps — cada um é reversível.

---

## Severidade — escolher resposta

### Severidade 1 — Corrupção de dados na BD do tenant

Sinais: VendaMensal com totais negativos absurdos, produtos com
preços a zero em massa, queries que devolvem rows fantasma.

**Acção imediata:**

1. **Parar Task Scheduler no PC da farmácia.** (TeamViewer → Task
   Scheduler → right-click → Disable na task `SPharm.MT — Daily
   Pipeline`)
2. **Toggle feature flag SaaS para off:**
   ```
   Vercel → spharm-mt → Settings → Environment Variables →
   ENABLE_AGENT_BOOTSTRAP = 0 (Production) → Redeploy
   ```
3. **Backup imediato da BD do tenant** (Neon → Branch from current
   point in time). Anota o branch para forensic.
4. Avisa o operador: "agente em pausa, dados a investigar".

**Recuperação:**

- Identifica a row corrupta + quando entrou (`PipelineRun.startedAt`).
- Faz `git revert <commit>` do código se necessário.
- Limpa rows corruptas:
  ```sql
  -- Exemplo: agregação errada no mês X
  DELETE FROM "VendaMensal"
   WHERE ano = X AND mes = Y
     AND "origemAgregacao" = 'agent-bootstrap-staging';
  ```
- Re-corre agregação com a versão fixed:
  ```bash
  npm run aggregate:vendamensal -- --tenant <slug> --month YYYY-MM --write
  ```
- Reactiva pipeline (Task Scheduler + flag) só depois de confirmar.

### Severidade 2 — Daily pipeline aborta repetidamente

Sinais: 3+ runs seguidos com status ERROR ou ABORTED no `/admin/pipeline`.

**Não é urgência crítica.** Diagnose primeiro, rollback se necessário.

1. `npm run pipeline:health -- --tenant <slug>` para ver a causa.
2. Se `UNKNOWN > 0` ou `operational orphans > 0`: corrigir staging
   sem rollback. Ver [pilot-support-runbook.md](pilot-support-runbook.md).
3. Se erro de rede / HTTP 5xx: investigar Vercel logs antes de rollback.
4. Se for o nosso código que está errado:
   - Re-deploy do último commit estável:
     ```bash
     git log --oneline | head
     # identifica o sha do último OK
     git revert <bad-sha>
     git push origin main
     ```
   - Vercel faz auto-deploy. Confirma com `pilot:precheck`.

### Severidade 3 — Bug numa página UI (não afecta dados)

Sinais: `/admin/pipeline`, `/relatorios/vendas-mensais` ou
`/analise-operacional` mostra erro 500 ou layout partido.

**Sem impacto operacional imediato.** Dados continuam ingeridos
correctamente.

1. Captura o erro do Vercel logs.
2. Reverte o commit problemático:
   ```bash
   git revert <bad-sha>
   git push origin main
   ```
3. Verifica HTTP 200 após deploy.

### Severidade 4 — Feature regression (ex: agent envia campo deprecated)

Sinais: avisos no log do agent, mas o pipeline corre OK.

**Sem urgência.** Adicionar ao próximo ciclo de fix.

---

## Componentes — como desactivar

### A. Task Scheduler (PC da farmácia)

```
Via RDP/TeamViewer ao PC:
  Win+R → taskschd.msc
  → Task Scheduler Library
  → right-click "SPharm.MT — Daily Pipeline"
  → Disable
```

Re-activar: `Enable`.

### B. Feature flag SaaS

```
Vercel dashboard → spharm-mt → Settings → Environment Variables
  → ENABLE_AGENT_BOOTSTRAP
  → editar para 0 (mantendo a key) → Save
  → Deploy → Redeploy production
```

Effeito: endpoints `/api/ingest/v1/bootstrap/*` e
`/api/admin/pipeline/aggregate-month` passam a responder HTTP 503
imediatamente. Outros endpoints (UI, relatórios) **não afectados**.

### C. Tenant inteiro

Última linha de defesa. Aplica quando a infra do tenant precisa de
inspeção profunda.

```bash
npm run tenancy:deactivate -- --slug <slug>
```

Bloqueia todos os endpoints autenticados desse tenant (HTTP 401 com
estado != ACTIVE). UI fica inacessível via subdomain.

Re-activar:

```bash
npm run tenancy:reactivate -- --slug <slug>
```

---

## Rollback de dados — recipes prontos

### Desfazer 1 agregação de mês

```sql
DELETE FROM "VendaMensal"
 WHERE ano = 2026 AND mes = 5
   AND "farmaciaId" = '<cuid>'
   AND "origemAgregacao" = 'agent-bootstrap-staging';
```

Idempotente: re-correr `aggregate:vendamensal --write` repõe o estado.

### Desfazer 1 dia de daily-sync

```sql
DELETE FROM "IngestVendaLinhaRaw"
 WHERE "farmaciaId" = '<cuid>'
   AND "dataVenda" >= '2026-05-12T00:00:00Z'
   AND "dataVenda" <  '2026-05-13T00:00:00Z';
```

Depois re-correr `daily-sync --date 2026-05-12` ou `daily-pipeline
--date 2026-05-12` no PC.

### Reverter backfill de isNonStockService

Se foi marcado erradamente (ex: ID foi confundido):

```sql
UPDATE "IngestVendaLinhaRaw"
   SET "isNonStockService" = false
 WHERE "externalProductId" IN (12345, 23456)
   AND "farmaciaId" = '<cuid>';
```

Depois re-correr `aggregate:vendamensal` para refresh.

---

## Rollback de código

Convenção: o `main` é deployable. Cada commit deve passar `tsc` +
build sem erros. Rollback = `revert` puro.

```bash
# 1. Identifica último commit OK
git log --oneline -20

# 2. Revert
git revert <sha-do-commit-mau>

# 3. Push
git push origin main

# 4. Aguarda Vercel deploy (~2 min)

# 5. Confirma
npm run pilot:precheck -- --tenant <slug>
```

**Nunca usar `git push --force` em main.** Sempre revert.

---

## Comunicação ao operador

Template de mensagem (telefone ou email):

> Olá [Nome], detectámos um problema no sistema SPharm.MT. Vamos
> pôr o agente em pausa durante [tempo]. Não precisas de fazer nada
> — os teus dados ficam tal como estão. Avisamos quando estiver
> resolvido. Para qualquer dúvida liga ao [contacto admin].

Se severidade 1 → telefone obrigatório.
Se severidade 2/3/4 → email aceitável.

---

## Pós-mortem (obrigatório)

Após qualquer rollback, escrever pós-mortem curto em
`notes/incident-YYYY-MM-DD-<slug>.md`:

- Cronologia (timestamps)
- Causa raíz
- Tempo até detecção
- Tempo até mitigação
- O que falhou (codigo? processo?)
- O que vai mudar para impedir recorrência

Manter histórico para revisão trimestral.
