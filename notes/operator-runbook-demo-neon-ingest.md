# Operator runbook — ingest demo-neon (Fase 1a + 1b)

**Aplicabilidade**: tenant `demo-neon`, farmácia configurada em `agent.config.json`.
**Agent shipped**: `SPharmMT-Agent-2026-05-18-rev26.zip`.
**Endpoints production**: `https://app.spharmmt.app/api/ingest/v1/bootstrap/{fornecedores,compras,devolucoes-fornecedor}`.

Este runbook cobre execução, validação e troubleshooting. **Não substitui** o checkpoint técnico — ver [phase-1ab-ingest-checkpoint.md](phase-1ab-ingest-checkpoint.md) para detalhe de mapping/arquitectura.

---

## Pré-requisitos (uma vez)

1. **ZIP extraído** numa pasta da máquina com acesso ao SPharm:
   ```
   C:\SPharmMT-Agent\
     ├── node.exe
     ├── agent.cjs
     ├── agent.config.json    ← copiar de agent.config.example.json e editar
     ├── run-*.bat
     └── ...
   ```

2. **`agent.config.json` editado** com:
   - `saas.endpoint`: `https://app.spharmmt.app`
   - `saas.tenantSlug`: `demo-neon`
   - `saas.ingestKey`: a key emitida via `npm run tenancy:issue-ingest-key`
   - `saas.farmacia`: nome da farmácia (ex: `"Batalha"`) OU o cuid
   - `sqlServer.*`: credenciais do SPharm read-only

3. **Connectivity**: `run-test-connection.bat` termina OK (SQL + SaaS).

4. **Feature flag**: `ENABLE_AGENT_BOOTSTRAP=1` nas environment variables do Vercel SaaS.

---

## Como correr: Fornecedores (Fase 1a)

**Quando**: uma vez para popular `Fornecedor` + `FornecedorErpRef`. **Pré-requisito** para compras/devoluções (linhas precisam de fornecedor resolvido).

### 1.1. Dry-run

```cmd
run-fornecedores-dry-run.bat
```

**Output esperado**:
- Sumário: total fornecedores, activos, inactivos, sem NIF
- Distribuição por tipo
- TOP 10 amostra
- Sem qualquer alteração ao SaaS

**O que validar**:
- Total fornecedores ≈ 138 (varia por farmácia)
- Activos ≈ total (Cotovia: todos 423/423 activos; Batalha: 138)
- TOP 10 mostra nomes legíveis (não vazios)

### 1.2. Upload

```cmd
run-fornecedores-upload.bat
```

Pede confirmação `CONFIRMO` antes de escrever no SaaS.

**Output esperado** (1ª passagem):
```
forn(c=138 u=0) refs(c=138 u=0) aliases+151 skipped=0 errors=0
```

**Se receberes timeout** (`This operation was aborted`):
- Para rev25: usa `--batch-size 50` directamente:
  ```cmd
  node.exe agent.cjs fornecedores-upload --batch-size 50
  ```
- Para rev26 e mais recente: já tem timeout 120s alinhado com bootstrap-upload (mas ainda há reset path se ocorrer)

### 1.3. Validar SaaS

Do lado do admin SPharm.MT (não do operador):
```cmd
npx tsx scripts/admin/smoke-fornecedor-schema.ts demo-neon
```

Esperado:
```
[demo-neon] FornecedorErpRef count = 138
[demo-neon] Fornecedor count       = 138
[demo-neon] sample Fornecedor      = { ... estado: "ATIVO" }
```

### 1.4. Validar idempotência

Re-correr `run-fornecedores-upload.bat`. Output esperado:
```
forn(c=0 u=138) refs(c=0 u=138) aliases+0 errors=0
```

`created=0` confirma que nenhuma row foi duplicada. `updated=138` confirma que o caminho de write está saudável.

---

## Como correr: Compras (Fase 1b)

**Quando**: depois de Fornecedores estar populated. Captura linhas de recepção de mercadoria.

**Filtro automático**: `RecepcaoSituacaoID = 'N'` (apenas normais; anuladas e resumos excluídos).

### 2.1. Dry-run

```cmd
run-compras-dry-run.bat
```

Pede `--from` e `--to` em formato `YYYY-MM-DD`. Sugestão para 1ª passagem: **1 dia recente** (ex: `2024-04-01` a `2024-04-02`).

**Output esperado** (read-only, sem POST):
```
Sumário:
  Headers (Recepcao)         : 14
  Linhas total                : 312
  Fornecedores distintos      : 5
  Produtos distintos          : 178
  Linhas com Bonus > 0        : 0

Distribuição por estado (deveria ser 100% 'N'):
  N    : 14

Reconciliação per-header (SUM(qt × valorEurUnit) vs Total Incidencia_EUR):
  Headers conferem         : 14
  Headers divergentes      : 0

Orphan checks locais:
  Linhas sem dbo.Stocks       : 0
  Headers sem dbo.Fornecedores: 0

Estimativa upload (batch-size 200): 2 batch(es)
```

**O que validar**:
- Total linhas faz sentido para a janela
- `Headers divergentes = 0` (ou ≤ 2, raros casos de IVA invertido tolerados)
- `Orphan locais = 0` (deveria sempre ser 0 — integridade SPharm)
- Distribuição de estado é 100% `N`

### 2.2. Upload

```cmd
run-compras-upload.bat
```

Pede `--from`, `--to`, `--batch-size` (default 200), e `CONFIRMO`. Usa mesmo intervalo do dry-run.

**Output esperado** (1ª passagem):
```
batch 1 (3500ms/120000ms): read=200 accepted=200 c=200 u=0 warn=0 skipped=0 errors=0
batch 2 (2100ms/120000ms): read=112 accepted=112 c=112 u=0 warn=0 skipped=0 errors=0

RESUMO
  Batches enviados              : 2
  Upserted (created+updated)    : 312
    novos                       : 312
    actualizados                : 0
  Reconciliation warnings       : 0
  Skipped                       : 0
  Errors                        : 0
  Batch ID                      : cmp-xxxxxxxx-xxxxxxxx
```

### 2.3. Validar SaaS

```cmd
npx tsx scripts/admin/smoke-compras-devolucoes-staging.ts demo-neon
```

Esperado:
```
[demo-neon] StagingCompraRawLine              count = 312
[demo-neon] StagingDevolucaoFornecedorRawLine count = 0    (ainda não corrido)
```

### 2.4. Validar idempotência

Re-correr `run-compras-upload.bat` (mesmo intervalo, mesma confirmação). Esperado:
```
RESUMO
  novos                       : 0
  actualizados                : 312
  Errors                      : 0
```

Count no SaaS continua 312 — nenhuma duplicação.

---

## Como correr: Devoluções fornecedor (Fase 1b)

**Quando**: depois de Fornecedores populated. Captura linhas de devolução AO fornecedor.

**Filtro automático**: `DevolucaoSituacaoID <> 'A'` (exclui anuladas; aceita P/E/R/X).

### 3.1. Dry-run

```cmd
run-devolucoes-fornecedor-dry-run.bat
```

Mesmo input `--from`/`--to`. Output esperado:
```
Sumário:
  Headers (Devolucao)         : 3
  Linhas total                 : 12
  Fornecedores distintos       : 2
  Linhas P com QtRec=0         : 8

Distribuição por estado (P/E/R/X — 'A' excluído no SQL):
  P    : 8
  R    : 4

Reconciliação per-header (SUM(valorEurTotal) vs Total_Incidencia_EUR):
  Headers conferem         : 3
  Headers divergentes      : 0

Orphan checks locais:
  Linhas sem dbo.Stocks       : 0
  Headers sem dbo.Fornecedores: 0
```

**O que validar**:
- `Linhas P com QtRec=0` = nº de linhas pendentes (esperado: maioria das `P` tem QtRec=0)
- Estados são apenas P/E/R/X (nunca `A`)
- Divergências ≤ 2

### 3.2. Upload

```cmd
run-devolucoes-fornecedor-upload.bat
```

Pede mesmo input + `CONFIRMO`. Output esperado:
```
batch 1 (1800ms/120000ms): read=12 accepted=12 c=12 u=0 P=8 E=0 R=4 X=0 warn=0 skipped=0 errors=0

RESUMO
  Upserted (created+updated)    : 12
    novos                       : 12
    actualizados                : 0
  Estados: P=8 E=0 R=4 X=0
  Reconciliation warnings       : 0
```

### 3.3. Validar SaaS

```cmd
npx tsx scripts/admin/smoke-compras-devolucoes-staging.ts demo-neon
```

Confirma `StagingDevolucaoFornecedorRawLine count = 12`.

### 3.4. Validar idempotência + captura P→R

Re-correr `run-devolucoes-fornecedor-upload.bat` mesmo intervalo. Esperado:
```
  novos          : 0
  actualizados   : 12
```

**Caso especial**: se uma devolução `P` foi resolvida no SPharm entre as duas passagens, o re-run captura a transição:
- Estado da row no SaaS muda `P` → `R`
- `quantidadeRecebida` muda `0` → valor real
- `quantidadeEnviada` mantém-se

Detectável no log:
```
batch 1: ... P=7 E=0 R=5 X=0 ...   (em vez de P=8 R=4)
```

---

## Como validar idempotência (resumo)

| Passo | Comando | Esperado |
|---|---|---|
| 1 | Run upload 1ª vez | `created=N, updated=0` |
| 2 | Smoke counts | `count = N` |
| 3 | Re-run upload mesmo intervalo | `created=0, updated=N` |
| 4 | Smoke counts novamente | `count = N` (inalterado) |

Qualquer divergência (count cresce, `created > 0` na 2ª passagem) é **bug** — reportar imediatamente, não tentar mais uploads.

---

## Como validar smoke SaaS

### Schema check (estrutura)
```cmd
npx tsx scripts/admin/smoke-fornecedor-schema.ts demo-neon
npx tsx scripts/admin/smoke-compras-devolucoes-staging.ts demo-neon
```

Confirma:
- Tabelas existem e são acessíveis via Prisma
- Counts esperados
- Constraints (PK, FK, UNIQUE) presentes
- Indexes operacionais presentes

### Endpoint check (auth)
```cmd
curl -i -X POST https://app.spharmmt.app/api/ingest/v1/bootstrap/fornecedores
```

Esperado: **HTTP 401** com `{"error":"missing_credentials"}`. Confirma endpoint deployed.

Se receberes **HTTP 404**: deploy ainda não terminou, ou commit não chegou a `origin/main`.
Se receberes **HTTP 503**: `ENABLE_AGENT_BOOTSTRAP` não está a `1` no Vercel.

---

## O que fazer em timeout

Mensagem típica:
```
SaaS POST /api/ingest/v1/bootstrap/compras — falha de rede: This operation was aborted
```

**Causa**: timeout client-side do agent (não rede externa). O `AbortController` cortou a request porque o SaaS demorou mais que `BATCH_TIMEOUT_MS`.

**Acções por ordem**:

1. **Confirma idempotência**: o endpoint pode ter completado server-side antes do abort. Re-correr o upload é seguro — UPSERT não duplica.

2. **Reduz batch size**:
   ```cmd
   node.exe agent.cjs compras-upload --from 2024-04-01 --to 2024-04-02 --batch-size 50
   ```
   200 → 100 → 50 → 25.

3. **Reduz janela temporal**: em vez de 1 mês, fazer 1 semana de cada vez.

4. **Verifica health do SaaS**:
   ```cmd
   curl -i https://app.spharmmt.app/api/outbox/v1/heartbeat -X POST -H "Authorization: Bearer YOUR_KEY" -H "X-Tenant-Slug: demo-neon"
   ```
   Esperado HTTP 200. Se 504/502, problema do lado SaaS — não tentar uploads.

5. **Vercel cold start**: 1º batch após período idle pode demorar mais (≈10-15s). Batches subsequentes ficam rápidos (~2s/batch). Se só o 1º batch falhou e os outros passaram, é cold start — re-run apanha tudo.

6. **Se persistir após reduzir batch size**: reportar ao admin com:
   - Output completo do upload (especialmente `elapsedMs/timeoutMs` por batch)
   - Janela temporal usada
   - `ingestBatchId` da última passagem

---

## O que NÃO fazer

| Acção | Razão |
|---|---|
| ❌ Editar `agent.cjs` ou `*.ts` | Bundle é gerado, não fonte. Mudanças locais não persistem após re-build |
| ❌ Tentar correr `compras-upload` antes de `fornecedores-upload` | Sem `FornecedorErpRef`, agregação a jusante não terá lookup. Upload aceitaria mas é estado inconsistente para Fase 1c+ |
| ❌ Saltar o `CONFIRMO` invocando node directamente em produção crítica | Excepção: confirma 1 vez, depois pode usar CLI directo para batch-size custom |
| ❌ Apagar manualmente rows de `StagingCompraRawLine` / `StagingDevolucaoFornecedorRawLine` | A não ser por `DELETE WHERE ingestBatchId=?`. Cleanup ad-hoc parte a idempotência |
| ❌ Aplicar migrations a `grupo-silveira` ou outros tenants | Requer autorização explícita. `demo-neon` é o canónico de teste |
| ❌ Modificar `agent.config.json` para apontar para outro tenant durante upload | Identidade do tenant é validada server-side via Bearer key. Mismatch dá 401 |
| ❌ Correr uploads concorrentes da mesma farmácia | Pode causar conflitos de UNIQUE. UPSERT é seguro mas serializar é mais previsível |
| ❌ Tentar usar `bootstrap-dry-run.bat` (legado de vendas) para compras | Comandos diferentes — `bootstrap-dry-run` cobre products/stock/sales, não compras/devoluções |
| ❌ Reconciliation warnings > 0 → ignorar | Investigar: rev24 mostrou que dados reais reconciliam 100%. Warnings indicam IVA invertido, descontos cascade, ou linha duplicada |
| ❌ Esperar que `Compra` ou `Devolucao` finais fiquem populated | Fase 1b é **só staging**. Agregação requer Fase 1c (não autorizada) |

---

## Limite operacional: scope desta runbook

Esta runbook cobre **apenas**:
- Bootstrap fornecedores (range completo)
- Bootstrap compras (range `--from`/`--to`)
- Bootstrap devoluções fornecedor (range `--from`/`--to`)
- Smoke validation read-only contra `demo-neon`

**NÃO cobre**:
- Daily-sync incremental (não existe ainda)
- Aggregation para `Compra`/`Devolucao` finais (Fase 1c+)
- Dashboard/UI consumers (futuro)
- `grupo-silveira` ou outros tenants (autorização separada)
- Cleanup automatizado de staging stale

Em caso de dúvida sobre scope: parar, perguntar ao admin antes de prosseguir.

---

## Quem contactar

- **Build failure / 404 endpoint** → admin (verificar push + Vercel deploy)
- **HTTP 401 com auth correcto** → admin (re-emitir ingest key)
- **HTTP 503** → admin (ENABLE_AGENT_BOOTSTRAP env var)
- **HTTP 5xx persistente** → admin + log batch detalhado
- **Timeout repetido** → seguir secção "O que fazer em timeout"
- **Reconciliation warnings recorrentes** → admin com `ingestBatchId` para inspecção
- **Dúvida sobre mapping ERP** → ver [phase-1ab-ingest-checkpoint.md § 8](phase-1ab-ingest-checkpoint.md)
