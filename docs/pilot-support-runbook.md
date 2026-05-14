# Pilot Support Runbook

Playbook do admin quando o agente / pipeline falha. Cada problema
tem uma checklist accionável.

---

## Diagnose inicial (sempre)

```bash
# 1. Estado geral do pipeline server-side
npm run pipeline:health -- --tenant <slug>

# 2. Estado completo (envs + tenant + DB + migrations + dados)
npm run pilot:precheck -- --tenant <slug>

# 3. UI
abrir https://<slug>.<domain>/admin/pipeline
```

Se `pipeline:health` exit code = 0 → o problema é local (agente).
Se exit code ≠ 0 → o problema está no SaaS ou nos dados.

---

## P1. "O daily-pipeline nunca correu / não vejo runs"

Sintoma: `/admin/pipeline` mostra "(sem execuções)" em todos os tipos.

**Causas possíveis:**

1. **Task Scheduler não está activo no PC.** Pedir ao operador para
   abrir Task Scheduler e confirmar status `Ready`.
2. **PC esteve desligado às 03:00.** Olhar histórico recente —
   "Last Run Time" no Task Scheduler.
3. **Bat falha imediatamente.** Pedir para correr `run-daily-pipeline-auto.bat`
   manualmente. Captura o exit code e o conteúdo de
   `logs\pipeline-YYYY-MM-DD.log`.
4. **Conexão SaaS bloqueada.** Pedir `run-test-connection.bat`. Se
   falha, é firewall/DNS.

**Resolução:**

- Se task disabled → re-enable
- Se PC desligado → confirmar política de power (não pode hibernar)
- Se bat falha → ler logs, escalar
- Se conexão falha → contactar IT da farmácia

---

## P2. "Daily-pipeline aborta com `unknowns_present`"

Sintoma: status=ABORTED, errorMessage contém "linhas com
tipoDocumentoClass='UNKNOWN'".

**Causa:** o ERP introduziu um valor novo em `Atendimento.[Tipo
Documento]` que ainda não está classificado em
`TipoDocumentoClassificacao`.

**Diagnose:**

```bash
# Lista tipos não classificados que apareceram em staging
npm run -s exec tsx -- - <<'EOF'
import "dotenv/config";
import { controlPrisma, getTenantBySlug, buildTenantConnectionString } from "./lib/control-plane";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const t = await getTenantBySlug("<slug>");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: buildTenantConnectionString(t!) }) });
const r = await p.ingestVendaLinhaRaw.groupBy({
  by: ["tipoDocumento"],
  where: { tipoDocumentoClass: "UNKNOWN" },
  _count: { _all: true },
});
console.log(r);
await p.$disconnect(); await controlPrisma.$disconnect();
EOF
```

**Resolução:**

1. Identificar o novo tipoDocumento (ex: 99).
2. Confirmar com o operador o que significa esse tipo (consulta?
   anulação? consulta especial?).
3. Classificar:
   ```bash
   npm run ingest:classify-tipodoc -- \
     --tenant <slug> --tipo 99 --classe VENDA --descricao "..." --by "admin@email"
   ```
4. Reclassificar staging:
   ```bash
   npm run ingest:reclassify-vendas -- --tenant <slug>
   ```
5. Re-correr o aggregate:
   ```bash
   npm run aggregate:vendamensal -- --tenant <slug> --month YYYY-MM --write
   ```

---

## P3. "Daily-pipeline aborta com `operational_orphans_present`"

Sintoma: status=ABORTED, errorMessage contém "operational orphans".

**Causa:** linhas de venda referenciam `externalProductId` (CodigoID
ERP) que não foi upserted em `Produto`. Tipicamente porque o produto
está `Retirado=1` ou `Processa_Stocks=0` no ERP, mas tem vendas
históricas.

**Diagnose:**

```bash
# Lista CodigoIDs órfãos com nº de vendas
npm run ingest:list-orphans -- --tenant <slug>
```

Depois, pedir ao operador para correr no PC:

```
run-inspect-codigoid.bat
# inserir os CodigoIDs identificados, separados por vírgulas
```

O output mostra `Processa_Stocks` + nome dos produtos.

**Resolução (dois caminhos):**

A. **Se são serviços/taxas (Processa_Stocks=0):**

```bash
npm run ingest:backfill-services -- \
  --tenant <slug> --ids 12345,23456,34567 --write
```

B. **Se são produtos legítimos retirados:**

Re-correr bootstrap permissivo para esses produtos (não há flag
hoje — abrir issue). Workaround: marcar como serviços de momento
e abrir ticket interno.

Depois re-correr aggregate:

```bash
npm run aggregate:vendamensal -- --tenant <slug> --month YYYY-MM --write
```

---

## P4. "Daily-pipeline aborta com `totals_negative`"

Sintoma: status=ABORTED, errorMessage contém "Total valorBruto
agregado é negativo".

**Causa:** numa farmácia real não acontece num mês completo. Quase
sempre indica:
- Mês com apenas devoluções importadas (raro mas possível em piloto)
- Erro na classificação de `tipoDocumento`
- Erro no bootstrap inicial (linhas duplicadas como devoluções)

**Diagnose:**

```sql
SELECT "tipoDocumentoClass", COUNT(*), SUM("valorLinha")
  FROM "IngestVendaLinhaRaw"
 WHERE "dataVenda" >= '2026-05-01' AND "dataVenda" < '2026-06-01'
 GROUP BY 1;
```

Se DEVOLUCAO_ANULACAO domina valor: investigar tipo doc. Se o
balanço genuíno é negativo, forçar (com extremo cuidado):

```bash
# Adicionar --allow-negative-totals (não implementado ainda — abrir
# issue se acontecer)
```

---

## P5. "HTTP 503 do agent"

Sintoma: agent log com "feature_disabled" ou HTTP 503.

**Causa:** `ENABLE_AGENT_BOOTSTRAP` não está a `1` no Vercel.

**Resolução:**

```
Vercel → spharm-mt → Settings → Environment Variables →
  ENABLE_AGENT_BOOTSTRAP → editar para 1 → Save → Redeploy
```

Confirmar com `npm run pilot:precheck -- --tenant <slug>`.

---

## P6. "HTTP 401 do agent"

Sintoma: agent log com "tenant_not_found" ou 401.

**Causas:**

1. `tenantSlug` no agent.config.json não bate com a BD
2. `ingestKey` não é a que está em hash em `Tenant.ingestApiKeyHash`
3. Tenant em estado != ACTIVE

**Resolução:**

```bash
# Confirma tenant e estado
npm run tenancy:list

# Debug auth com a key real
npm run tenancy:debug-ingest-auth -- --slug <slug> --key "<key>"

# Se key se perdeu — gerar nova (invalida a anterior)
npm run tenancy:issue-ingest-key -- --slug <slug>
# Updates Tenant.ingestApiKeyHash. Substituir no agent.config.json.
```

---

## P7. "Migrations pendentes"

Sintoma: `pilot:precheck` falha em "Migrations completas" OU agent
recebe Prisma error com "column ... does not exist".

**Resolução:**

```bash
# Dry-run
npm run tenancy:migrate-all -- --only <slug> --dry-run

# Aplicar
npm run tenancy:migrate-all -- --only <slug>
```

---

## P8. "Stock negativo persistente em muitos produtos"

Sintoma: secção "Stock negativo" em `/analise-operacional` tem
dezenas de produtos.

**Causa:** o ERP da farmácia tem corrupção própria (anomalia
operacional). **Não é nosso bug.** O SaaS apenas reflecte o estado.

**Resolução:**

- Avisar o operador. Pedir para corrigir no ERP (acerto de stock).
- Aguardar próximo daily-sync para refresh.
- Se persistir > 1 semana sem correção, marcar como aceitável.

---

## P9. "Pipeline corre mas /analise-operacional aparece vazio"

Sintoma: `pipeline:health` OK, agregação corre, mas a UI mostra
"(sem dados)".

**Causa possível:**

1. Filtros de mês não bate (mês corrente vs mês com dados)
2. Farmácia incorrecta seleccionada
3. Cache de auth de tenant (raro)

**Resolução:**

- Tentar URLs explícitas:
  `?farmaciaId=<cuid>&mes=2026-05`
- Confirmar via CLI:
  `npm run report:vendamensal -- --tenant <slug> --month 2026-05`

---

## Comandos de emergência

```bash
# Parar tudo no SaaS (toggle flag — não desfaz dados)
# Vercel UI: ENABLE_AGENT_BOOTSTRAP=0 + redeploy

# Parar tudo no PC (TeamViewer + Task Scheduler → Disable)

# Backup imediato BD tenant
# Neon UI → Branches → "Create branch from current"

# Forçar agregação após correcção
npm run aggregate:vendamensal -- --tenant <slug> --month YYYY-MM --write

# Verificar tudo OK
npm run pilot:precheck -- --tenant <slug>
```

---

## Escalation

Se um problema P1/P2/P3 persiste após o playbook:

1. Capturar logs completos (Vercel + agent local)
2. Capturar snapshot dos counts (`pilot:precheck` output completo)
3. Anotar em `notes/incident-YYYY-MM-DD-<slug>.md`
4. Escalar para engenharia (criar PR de fix se conseguires reproduzir)
