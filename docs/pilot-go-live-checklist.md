# Pilot Go-Live Checklist

Checklist único para validar que um tenant piloto está pronto para
produção real. Todas as verificações em **modo read-only**. Re-correr
quantas vezes for preciso.

## 0. Pré-check automatizado

Antes de qualquer trabalho manual:

```bash
npm run pilot:precheck -- --tenant <slug>
```

Output ✓/✗ com exit code = nº de falhas. Cobre items 1-7 do checklist
abaixo. Re-correr ao fim para confirmar.

---

## 1. ENV vars Vercel obrigatórias

No projecto Vercel correspondente, em **Settings → Environment Variables**:

| Variável | Scope | Obrigatório | Notas |
|---|---|---|---|
| `DATABASE_URL` | Production | ✓ | Tenant default ou control plane DB (caminho de fallback) |
| `CONTROL_DATABASE_URL` | Production | ✓ | Connection string do control plane Neon |
| `TENANT_ENCRYPTION_SECRET` | Production | ✓ | AES-256 hex 64 chars. **Nunca rodar sem migrar BDs cifradas.** |
| `ENABLE_AGENT_BOOTSTRAP` | Production | ✓ | Tem de estar a `1` ou `true`. Sem isto agent recebe 503. |
| `TENANT_DB_HOST` | Production | recommended | Host shared do Neon p/ provisioning automatizado |
| `RESEND_API_KEY` | Production | recommended | Apenas se SMTP via Resend |

Confirmar via `npm run env:doctor` (com `.env.production` local ou via
Vercel CLI `vercel env pull`).

## 2. Migrations por tenant

```bash
# Audit pendências
npm run tenancy:migrate-all -- --only <slug> --dry-run

# Aplicar (idempotente)
npm run tenancy:migrate-all -- --only <slug>
```

A última migration esperada em piloto:

```
20260514160000_add_pipeline_run
```

Se aparecerem `migrations pendentes` no dry-run, parar e aplicar antes
de prosseguir.

## 3. Task Scheduler instalado (PC da farmácia)

Verificar no PC on-prem:

1. ZIP `SPharmMT-Agent-YYYY-MM-DD-revN.zip` extraído em `C:\spharmmt\agent\`
2. `agent.config.json` presente (não o `.example.json`), com:
   - `saasEndpoint` apontando ao domínio de produção
   - `tenantSlug` correcto
   - `ingestKey` correspondente ao hash em `Tenant.ingestApiKeyHash`
   - `farmacia` (nome ou cuid) válido
3. Task Scheduler tem task `SPharm.MT — Daily Pipeline`:
   - Trigger diário às 03:00 (ou hora combinada)
   - Action: `C:\spharmmt\agent\run-daily-pipeline-auto.bat`
   - **Start in**: `C:\spharmmt\agent\`
   - "Do not start a new instance" se já corre

Detalhes em [docs/daily-pipeline-task-scheduler.md](daily-pipeline-task-scheduler.md).

Teste manual: **right-click → Run** no Task Scheduler. Confirma:
- ✓ `logs\pipeline-YYYY-MM-DD.log` criado
- ✓ Última linha contém `DAILY PIPELINE OK`
- ✓ Exit code 0

## 4. Daily pipeline health

```bash
npm run pipeline:health -- --tenant <slug>
```

Confirma:
- Último daily-pipeline (auto): status **OK** em < 24h
- UNKNOWN no staging: **0**
- Operational orphans no staging: **0**
- Mês mais recente agregado: o **mês corrente**
- Falhas recentes: **(nenhuma)** ou explicáveis

Exit codes semânticos:
- `0` → tudo OK
- `2` → último daily-pipeline não OK
- `3` → UNKNOWN presente
- `4` → operational orphans presentes

## 5. /admin/pipeline (UI)

Aceder a `https://<slug>.<domain>/admin/pipeline` (logged-in como
platform admin):

- ✓ "Métricas globais" mostra `UNKNOWN=0`, `Operational orphans=0`
- ✓ "Últimas execuções": daily-pipeline OK em verde
- ✓ "Últimas 10 execuções": tabela com runs recentes
- ✓ "Últimas falhas": tabela vazia (ideal) ou só warnings esperados

Confirma também: mudar de PC + voltar → estado consistente (não há
cache local).

## 6. /relatorios/vendas-mensais (UI)

Aceder a `https://<slug>.<domain>/relatorios/vendas-mensais`:

- ✓ Filtros de farmácia + mês funcionais
- ✓ Mês corrente aparece como default
- ✓ Pelo menos 10 produtos na "Top por valor bruto"
- ✓ Totais não nulos (qtd, valor bruto, atendimentos)
- ✓ Links de produtos clicáveis → `/catalogo/artigo/<cnp>`

## 7. /analise-operacional (UI)

Aceder a `https://<slug>.<domain>/analise-operacional`:

- ✓ "Resumo do mês" mostra candidatos a ruptura/excesso (números)
- ✓ Banner vermelho "Candidatos a ruptura" preenchido OU vazio
  (vazio é ok no 1º mês)
- ✓ Banner amarelo "Candidatos a excesso" preenchido OU vazio
- ✓ Cobertura de stock — primeira linha tem nº de dias razoável
- ✓ Margem aproximada — pelo menos uma linha (a não ser que PUC seja
  null para todos os produtos vendidos)

## 8. Plano de rollback

Documentado em [docs/pilot-rollback-plan.md](pilot-rollback-plan.md).
Confirma que:

- Sabes onde está o último commit estável (`git log --oneline | head`)
- Tens acesso ao Vercel project (para toggle `ENABLE_AGENT_BOOTSTRAP=0`)
- Sabes como desligar a Task Scheduler no PC remoto (TeamViewer / RDP)
- Tens contacto directo do operador da farmácia

## 9. Plano de suporte agent falha

Documentado em [docs/pilot-support-runbook.md](pilot-support-runbook.md).

Confirma que:

- Operador sabe onde estão os logs (`C:\spharmmt\agent\logs\`)
- Operador sabe que comando usar para diagnose (`run-health.bat`)
- Há canal directo operador → admin (telefone / email)

## 10. Documentação operador

Entregar ao operador (ficheiro PDF ou impresso):
- [docs/pilot-operator-guide.md](pilot-operator-guide.md)

Cobre o ciclo diário sem precisar de admin presente.

---

## Quando estiver pronto

Re-correr o pré-check:

```bash
npm run pilot:precheck -- --tenant <slug>
```

Status esperado: `✓ GO-LIVE READY` (0 fails, 0 warnings).

Anotar:
- Data go-live
- Tenant slug
- Commit hash do main no momento
- Operador responsável

E avisar o stakeholder.
