# Onboarding de farmácia real — v1

Fluxo end-to-end para preparar e activar uma farmácia (ou grupo de
farmácias) em produção. Todos os passos são CLI. Sem UI necessária.
Cada comando é idempotente excepto onde indicado.

---

## Modelo mental

```
Tenant (= grupo)            ─┐
  ├── BD própria (Neon)      │  npm run tenancy:create
  ├── ingest key             │
  └── Farmácias              │  npm run tenancy:add-farmacia (Nx)
        └── Agent ZIP          npm run admin:package-agent     (1x por farmácia)
              └── PC on-prem    instalação + Task Scheduler
                    └── Pipeline diário                       (auto)
```

**Regra**: 1 tenant = 1 BD. As farmácias do mesmo grupo vivem **na mesma
BD** (mesma tabela `Farmacia`, registos separados). Cada farmácia tem o
seu agent + ZIP + PC.

---

## Pré-requisitos do admin

1. Acesso ao terminal com o repo clonado + `.env.local` com:
   - `CONTROL_DATABASE_URL`
   - `TENANT_ENCRYPTION_SECRET`
   - `NEON_API_KEY` + `NEON_PROJECT_ID` (se `--provider neon`)
2. Build base do agent actual: `npm run agent:package`
   (cria `dist-agent/SPharmMT-Agent/` com o `agent.cjs` mais recente)
3. Acesso remoto ao PC da farmácia (TeamViewer / Anydesk / RDP)
4. (Opcional, recomendado) Conta Healthchecks.io free com 1 check por
   farmácia para dead-man switch

---

## Passo 1 — Criar tenant + BD

```bash
npm run tenancy:create -- \
  --slug grupo-pilot \
  --name "Grupo Piloto, Lda" \
  --admin-email admin@grupopilot.pt \
  --provider neon
```

O que acontece (em ~10s):

1. Valida slug + admin-email
2. Cria BD via Neon API (role + database)
3. Persiste o tenant em `Tenant` (estado=PROVISIONING)
4. Aplica TODAS as migrations Prisma à BD nova
5. Cria utilizador admin com password gerada
6. Emite ingest key
7. Smoke test à BD
8. Marca tenant ACTIVE
9. Imprime credenciais **UMA VEZ**:
   - Admin email + password (para login UI)
   - Ingest key (para o agent)

**Anota imediatamente.** Não recuperável.

Opções úteis:
- `--farmacias "Farmácia X,Farmácia Y"` — cria farmácias iniciais na mesma chamada
- `--admin-password X` — força password específica (omite para gerar)
- `--dry-run` — valida plano sem side-effects
- `--json` — output JSON para piping
- `--provider manual --database-url "postgres://..."` — quando já tens BD pré-criada

### Verificação imediata

```bash
npm run tenancy:status -- --tenant grupo-pilot
```

Deve mostrar `Status global: ✓ OK` (ou `exit=4` se nenhuma farmácia
foi criada — o que é normal se não passaste `--farmacias`).

---

## Passo 2 — Adicionar farmácias (1 ou várias)

Para cada farmácia do grupo:

```bash
npm run tenancy:add-farmacia -- \
  --tenant grupo-pilot \
  --nome "Farmácia Internacional" \
  --codigo "FI001"

npm run tenancy:add-farmacia -- \
  --tenant grupo-pilot \
  --nome "Farmácia do Norte" \
  --codigo "FN001"
```

Args opcionais: `--morada "..."`, `--contacto "..."`.

O comando:
- Valida que o tenant existe e está ACTIVE
- Verifica duplicado por nome (exit code 2 se já existe)
- Cria `Farmacia` com estado ATIVO
- Lista todas as farmácias no fim

**Multi-farmácia note**: cada farmácia precisa do **seu próprio** agent
(passo 4) — porque cada uma tem um ERP separado no PC dela. Mas o
tenant + ingest key são partilhados pelo grupo.

---

## Passo 3 — (Opcional) Criar healthchecks.io check

Para cada farmácia individualmente, ir a https://healthchecks.io e
criar um check com schedule "Daily" e grace 1h. Anotar a URL
(formato: `https://hc-ping.com/<uuid>`).

Não é obrigatório mas **fortemente recomendado** em produção.

---

## Passo 4 — Gerar pacote do agent (1 ZIP por farmácia)

```bash
npm run admin:package-agent -- \
  --tenant grupo-pilot \
  --farmacia "Farmácia Internacional" \
  --endpoint https://app.spharmmt.app \
  --healthcheck-url https://hc-ping.com/<uuid-internacional> \
  --rotate
```

O comando:
1. Resolve tenant
2. Roda nova ingest key (se `--rotate`; ou usa `--key=<hex>` se já tens)
3. Copia `dist-agent/SPharmMT-Agent/` para `dist-agent/clients/<slug>-<date>-<rand>/`
4. Escreve `agent.config.json` preenchido com tenant + farmácia + key + endpoint + healthcheck (opcional)
5. Zipa e devolve caminho do ZIP
6. Imprime key em claro **UMA VEZ**

⚠ `--rotate` **invalida a key anterior do tenant**. Se já tens outro
agent em produção neste tenant, vai começar a receber 401. Para cada
farmácia adicional do mesmo grupo, ou:
- **Usa `--key=<hex>` com a key emitida no passo 1** (não rodar)
- Ou roda uma vez no final e re-instala todos os agents do grupo

Args opcionais para pré-preencher SQL Server (se já sabes):
```
--sql-host SQLBOX --sql-port 1433 --sql-database SPHARM \
--sql-user spharm_readonly --sql-password "..."
```
Sem estes, o config tem placeholder `COMPLETAR_PASSWORD_NO_PC_DA_FARMACIA`
que o operador completa após extrair.

---

## Passo 5 — Instalar no PC da farmácia

Via TeamViewer/RDP:

1. Copiar o ZIP para `C:\spharmmt\agent\` (criar pasta se necessário)
2. Extrair conteúdo (overwrite se já havia uma versão anterior — `logs/`
   e `run/` ficam preservados se já existirem)
3. Editar `agent.config.json` apenas se há placeholders:
   - `sqlServer.password` (sempre, se não passaste `--sql-password`)
   - Outros campos só se SQL Server não está em localhost com config default
4. Smoke test:
   ```
   run-test-connection.bat
   ```
   Deve mostrar:
   - ✓ SQL Server reachable
   - ✓ SaaS heartbeat OK
5. Bootstrap inicial (1ª vez apenas) — carrega histórico:
   ```
   run-bootstrap-upload.bat
   # pergunta intervalo --from / --to + CONFIRMO
   ```
   Para piloto, 1 mês de histórico é suficiente.
6. Configurar Task Scheduler:
   - Criar task "SPharm.MT — Daily Pipeline"
   - Trigger: Daily às 03:00
   - Action: `C:\spharmmt\agent\run-daily-pipeline-auto.bat`
   - **Start in**: `C:\spharmmt\agent\` (CRÍTICO)
   - "Do not start a new instance" + "Stop task if longer than 30min"
   - Detalhes em [daily-pipeline-task-scheduler.md](daily-pipeline-task-scheduler.md)
7. Teste manual: **right-click → Run** na task. Confirma:
   - `logs\pipeline-YYYY-MM-DD.log` criado
   - Última linha `DAILY PIPELINE OK`
   - Healthchecks.io recebeu ping (se configurado)

---

## Passo 6 — Validar do lado do SaaS

```bash
npm run tenancy:status -- --tenant grupo-pilot
```

Esperado após 1ª daily-pipeline correr:
- `daily-pipeline (auto)` com status OK e idade < 24h
- `aggregate-month` com status OK
- VendaMensal com pelo menos 1 mês agregado
- staging UNKNOWN = 0, operational orphans = 0

Em paralelo, abrir no navegador:
- `https://<slug>.spharmmt.app/admin/pipeline` — última run + métricas
- `https://<slug>.spharmmt.app/relatorios/vendas-mensais` — totais reais
- `https://<slug>.spharmmt.app/analise-operacional` — accionáveis

---

## Repetir para mais farmácias

Para a 2ª farmácia do mesmo grupo:
1. **Não** correr `tenancy:create` outra vez
2. `tenancy:add-farmacia` com `--nome "<nova>"`
3. `admin:package-agent` com `--farmacia "<nova>"` e a **mesma key** (ou `--rotate` + re-instalar agents existentes)
4. Instalar no PC da nova farmácia (passo 5)

Para um **grupo novo** (tenant diferente):
- Começa de novo no passo 1 com um slug diferente

---

## Failure modes comuns

| Sintoma | Causa | Resolução |
|---|---|---|
| `tenancy:create` falha em `apply-migrations` | Connection string inválida ou pre-condition | Ver erro, ler logs, `npm run tenancy:cleanup-failed -- --slug X --confirm` |
| `tenancy:add-farmacia` exit 2 | Farmácia com mesmo nome já existe | OK — confirmar id mostrado, ou usar nome diferente |
| `admin:package-agent` falha em `Build base em falta` | `dist-agent/SPharmMT-Agent/` não existe | Correr `npm run agent:package` primeiro |
| `run-test-connection.bat` falha SaaS | Key errada (rotação) ou endpoint errado | Ver `agent.config.json`, regenerar pacote com nova key |
| `run-test-connection.bat` falha SQL | Password SQL errada ou serviço down | Editar `agent.config.json`, confirmar com `sqlcmd` no PC |
| Task Scheduler "Last Run Result" ≠ 0 | Ver `logs/pipeline-*.log` no PC | Aplicar troubleshooting de [pilot-support-runbook.md](pilot-support-runbook.md) |

---

## Comandos de referência rápida

```bash
# Criar grupo + BD
npm run tenancy:create -- --slug X --name "..." --admin-email a@b.pt --provider neon

# Adicionar farmácia
npm run tenancy:add-farmacia -- --tenant X --nome "..." --codigo "..."

# Estado completo
npm run tenancy:status -- --tenant X

# Pacote agent (1 por farmácia)
npm run admin:package-agent -- --tenant X --farmacia "..." --rotate

# Saúde pipeline (após instalação)
npm run pipeline:health -- --tenant X

# Pré-check completo go-live
npm run pilot:precheck -- --tenant X

# Listar todos os tenants
npm run tenancy:list

# Aplicar migrations pendentes a 1 tenant
npm run tenancy:migrate-all -- --only X
```

---

## Limites conhecidos v1

- **1 key por tenant** (não por farmácia). Se rodas a key, todos os
  agents do grupo precisam de reinstalação. Para isolation forte por
  farmácia, criar tenants separados.
- **Sem update-farmacia**. Para alterar nome ou estado de uma farmácia,
  SQL directo na BD do tenant.
- **Sem delete-farmacia automatizado**. Cascading deletes existem mas
  destrutivo manual ainda é o caminho.
- **Sem CLI para renomear tenant**. Slug é imutável.

Estes ficam para v2 se aparecerem como problema real durante o piloto.
