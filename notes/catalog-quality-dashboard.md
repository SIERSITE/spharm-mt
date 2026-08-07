# Catalog Quality Dashboard — Conceptual Draft

**Data:** 2026-05-11
**Fase:** draft conceptual (sem UI, sem código, sem migrations)
**Audiência:** owners do catálogo, admins de plataforma, equipa data-quality
**Objectivo:** definir KPIs, secções, drill-downs, alertas e workflows
operacionais ANTES de qualquer design visual.

## 1. Princípios

Este NÃO é um dashboard SaaS genérico (gráficos bonitos, métricas
descontextualizadas). É uma **vista operacional executiva** com 4 critérios:

1. **Cada métrica tem owner e action.** Se um número está vermelho, há uma
   tarefa concreta atribuível.
2. **Drill-down em 1 click.** Da agregação ao registo individual em ≤2 níveis.
3. **Multi-tenant nativo.** Vista global do operador SPharm.MT + vista
   per-tenant para owners de farmácia/grupo.
4. **Cadência clara.** Cada KPI tem refresh interval declarado (real-time,
   horária, diária).

Métricas não-actionáveis ficam de fora. "Total de produtos no catálogo" só
aparece se desviou inesperadamente.

## 2. Audiências

| Persona | Vista | KPIs primários |
|---|---|---|
| **Owner SPharm.MT** (operador da plataforma) | global cross-tenant | tenant health, custo/tenant, sync health agregado, qualidade média do catálogo |
| **Admin do grupo de farmácias** (1 tenant) | tenant view | cobertura clínica do tenant, classificação, encomendas pendentes, alertas operacionais |
| **Gestor de farmácia individual** | farmácia view | stock, vendas, encomendas, transferências sugeridas |
| **Data quality team** | drill-down catálogo | productType ambíguos, ATC manuais, conflitos multi-fonte, validadoManualmente queue |

Este draft foca os 3 primeiros perfis. Stock/vendas operacionais (perfil 3
detalhado) ficam para encomendas-operational-analysis.md.

## 3. Top-line KPIs

Limite **8 KPIs** na vista executiva. Mais que isso, dispersão.

### Para owner SPharm.MT (global)

| KPI | Valor exemplo | Fonte | Refresh | Alerta se |
|---|---|---|---|---|
| Tenants ACTIVE | 5 / 7 total | Tenant table | horária | < expected, ou downgrade súbito |
| Tenants com sync OK 24h | 5/5 | SyncRun (Fase A data-sync) | 5min | qualquer um sem run há > 26h |
| Cobertura clínica média (% MEDICAMENTO com ATC+DCI) | 47% | aggregated per tenant | diária | desce > 5pp em 7 dias |
| "Outros Medicamentos" (% médio dos MEDICAMENTO) | 33% | per tenant | diária | sobe > 3pp em 7 dias |
| Custo Neon mensal estimado | 38€ | Neon API + Tenant table | horária | excede budget +20% |
| Imports falhados últimas 24h | 0 | SyncRun + LoteIngestao | 5min | ≥ 1 não-resolvido |
| Backups OK últimas 24h | 5/5 | Tenant.lastBackupAt | horária | qualquer tenant sem backup há > 26h |
| Anti-bot incidents (INFOMED crawl) | 0 | crawler logs | quando aplicável | crawler em curso com 503 rate > 10% |

### Para admin do grupo (1 tenant)

| KPI | Valor exemplo | Refresh | Alerta se |
|---|---|---|---|
| MEDICAMENTO classificados (não-Outros) | 4 821 / 7 526 (64%) | diária | desce > 3pp |
| MEDICAMENTO com ATC | 4 168 (55%) | diária | — |
| MEDICAMENTO com imagem | 1 784 (24%) | diária | desce |
| Produtos pendentes de revisão manual | 47 | real-time | > 100 |
| Encomendas em rascunho | 3 | real-time | > 10 |
| Stock fora de cobertura segura (< 7d) | 215 produtos | horária | spike |
| Vendas mês actual vs mês passado | +3.2% | diária | < -10% |
| Última importação ERP | há 6h ✓ | 5min | há > 26h |

## 4. Secções (vista executiva)

### S1. Header de saúde
Linha única: cor (verde/amarelo/vermelho) + 1 frase resumo + timestamp última actualização. Ex:
> 🟢 Plataforma OK · 5/5 tenants saudáveis · cobertura clínica média 47% · last update 2min ago

### S2. Quality Coverage (catálogo)
- Cobertura clínica por tenant (barras horizontais comparativas)
- Drill-down: clique num tenant → vista per-tenant da S2
- Tooltip: composição (ATC / DCI / forma / dosagem / imagem) com data source
- **Action:** se tenant < threshold, botão "agendar enrichment run"

### S3. Outros Medicamentos (a métrica que mais importa)
- Trend 90 dias do count "Outros Medicamentos"
- Composição por motivo de permanência:
  - sem signal (productType=OUTRO ou ATC null)
  - rule gap (tem ATC mas sem regra no mapper)
  - validadoManualmente
- Drill-down: lista de rule gaps por ATC prefix → link directo para
  `notes/taxonomy-gap-analysis.md` actualizado

### S4. Data Sources Health
Para cada fonte (ERP, INFOMED, CEDIME-ANF, conectores):
- Última sync com sucesso
- Taxa de erro últimos 7 dias
- Cadência observada vs cadência esperada
- Volume ingerido último período
- Drill-down: SyncRun detail + LoteIngestao para imports transacionais

### S5. Tenant Health (global only)
Tabela com 1 row por tenant:
- slug, estado, lastHealthCheckAt, lastBackupAt, last sync OK
- storage, compute, custo estimado mensal
- alerts count (aberto)
- Drill-down: per-tenant view completa (S2-S4 filtradas)

### S6. Pipeline INFOMED enrichment (status operacional)
- Crawler INFOMED: estado actual (idle / running / failed / blocked anti-bot)
- Última corrida: pages processadas, médias, falhas
- Próxima corrida agendada
- Cobertura: MED_IDs no INFOMED vs CNPs no ERP (cross-coverage)
- Drill-down: details file stats, divergencies pendentes auditoria

### S7. Alerts feed
- Linha por alerta: severity, ts, fonte, descrição, link drill-down, owner
- Ack/snooze/resolve actions inline
- Filtros: by tenant, by severity, by source

### S8. Performance & cost
- Tabelas com:
  - Throughput por job (rows/s histórico)
  - Wall-clock por job
  - Custo aproximado em € (cálculo: storage × compute × tempo)
- Drill-down: por tenant, por mês

## 5. Drill-downs e workflows

### Workflow W1 — "Tenant X tem coverage clínica a cair"
1. Owner vê S2 com tenant X em amarelo
2. Click → vista per-tenant filtrada para X
3. Vê: produtos novos importados sem enrichment (count + lista)
4. Action: "agendar daily-enrich agora" → submete job
5. Audit: TenantEvent regista action

### Workflow W2 — "Há rule gap novo após import"
1. Reprocess corre, regista 50 produtos "Outros Medicamentos" com ATC
   prefix `X##` ainda sem mapping
2. Alerta dispara em S7
3. Click → drill-down mostra os 50 produtos + ATC prefix + sample DCIs
4. Action: "abrir taxonomy-gap-analysis update" (template pre-filled)
5. Owner do catálogo decide criar nova nivel2 ou reusar

### Workflow W3 — "Import ERP falhou para tenant X"
1. LoteIngestao para tenant X com estado=FALHOU
2. Alerta em S4 + S7
3. Drill-down: mensagemErro, hash do conteúdo, totalRejeitados
4. Action: "abrir ficheiro" (Vercel Blob URL) + "rerun com --force"
5. Audit: actor que reiniciou

### Workflow W4 — "Catalog quality report mensal"
1. Cron mensal corre `scripts/catalog-quality-report.ts` para cada tenant
2. Output: notes/per-tenant/quality-report-YYYY-MM.md
3. Diff vs mês anterior → resumo executivo
4. Email aos owners com link para drill-downs

### Workflow W5 — "Produto suspeito de mismatch"
1. Detectado: ERP `designacao` diverge de INFOMED ≥ 60% (heuristic)
2. Adicionado a fila `produtos_suspeitos` (não bloqueia import)
3. Drill-down: comparação lado-a-lado ERP vs INFOMED
4. Action: keep ERP / replace by INFOMED / mark validadoManualmente
5. Decisão regista em ProdutoVerificacaoHistorico

## 6. Métricas per-tenant

Para CADA tenant, o dashboard mantém:

### Snapshot (refresh diário)
- Total Produto (vivos + INATIVO)
- Total MEDICAMENTO + breakdown (com ATC / com DCI / com forma / com dosagem / com imagem)
- Distribuição nivel2 (top 10 + "outros")
- Top 10 ATC prefixes
- Rule gaps activos (count por prefix, link para notas)
- Validados manualmente (count + última semana adicionados)
- Verificação automática (taxa últimos 30d)

### Health (refresh horária)
- Última sync por fonte (ERP, INFOMED, etc.)
- Storage Neon (MB)
- Connection count (real-time)
- Backup status (lastBackupAt)

### Operacional (refresh real-time)
- Encomendas em rascunho / pendentes
- Outbox state (export pending / failed / leasing)
- Sessões activas (utilizadores)

### Custo (mensal)
- Storage × dias × preço/GB
- Compute hours estimado
- Custo total mês corrente
- Trend 6 meses

## 7. Alertas

Severidades: **critical** (action imediata), **high** (24h), **medium** (7d), **low** (info).

| Trigger | Severidade | Owner default |
|---|---|---|
| Tenant DB inacessível > 5min | critical | platform ops |
| Backup falhou ou stale > 26h | critical | platform ops |
| Import ERP falhou para tenant | high | tenant admin |
| Catálogo clínico cobertura desceu > 5pp 7d | high | data quality |
| Outros Medicamentos subiu > 3pp 7d | high | data quality |
| Crawler INFOMED anti-bot rate > 10% | medium | platform ops |
| 50+ produtos pendentes revisão manual | medium | tenant admin |
| Custo Neon > +20% vs previsto | medium | platform finance |
| Novo rule gap ATC com > 10 produtos | medium | data quality |
| Designações divergentes ERP/INFOMED para CNP existente | low | data quality |

**Alert routing:**
- critical: Slack + email + SMS (se configurado)
- high: Slack + email
- medium: Slack
- low: feed only

Storage de alertas: tabela nova `Alert` no control plane (ou per-tenant para tenant-specific) com fields `(severity, source, message, tenantSlug, createdAt, ackBy, ackAt, resolvedAt, metaJson)`.

## 8. Prioridades operacionais

Ordem sugerida de implementação (independente do plano técnico do dashboard):

### P1. Crítico (semana 1-2)
- Pipeline INFOMED enrichment estável (já feito)
- Métricas básicas: cobertura clínica + Outros Medicamentos count (existe via [scripts/catalog-quality-report.ts](../scripts/catalog-quality-report.ts))
- Alertas para imports falhados

### P2. Importante (semana 3-4)
- Vista per-tenant da S2 + S3
- Drill-down rule gaps
- Workflows W1, W3 (operações mais frequentes)

### P3. Útil (semana 5-8)
- Trends 90d, snapshot mensal
- Per-tenant cost
- Workflow W2 (rule gaps) automatizado

### P4. Polish (depois)
- Workflow W4 (relatório mensal automático)
- Performance benchmarks históricos
- Predictive alerts (cobertura tendência negativa)

## 9. Data sources (mapeamento KPI → tabela)

| KPI | Tabela / Script | Cadência fonte |
|---|---|---|
| Cobertura clínica | `Produto` (read-only count) | real-time |
| Outros Medicamentos | `Produto` × `Classificacao` | real-time |
| Rule gaps | `Produto` filtrados + lookup em `lib/catalog-taxonomy-map.ts` | real-time |
| Sync health | `SyncRun` (Fase A data-sync) | real-time |
| LoteIngestao | `LoteIngestao` | real-time |
| Backup status | `Tenant.lastBackupAt` (control plane) | horária |
| Tenant health | `Tenant.lastHealthCheckAt` + script cron | horária |
| Custo Neon | Neon API + `TenantUsageMonthly` (nova) | diária |
| Alerts feed | `Alert` table (nova) | real-time |
| Enrichment performance | `EnrichmentSourceLog` agregado | horária |

## 10. Não-objectivos do dashboard

- **Não substitui o BI/analytics** (relatórios de vendas, P&L, etc.) — esse vive noutro lado
- **Não é app móvel** — uso desktop primário
- **Não é multi-language** numa primeira versão (PT only)
- **Não tem self-service customisation** — KPIs e secções são fixos pelo owner do produto

## 11. Considerações técnicas (preview do design subsequente)

Sem entrar em UI, alguns constraints operacionais:

- **Server-rendered** (Next.js app router) — não SPA pesado
- **Refresh strategies:**
  - real-time via polling (5min) ou SSE
  - horária via cron + cache
  - diária via job offline
- **Permissions:**
  - Owner SPharm.MT (global admin): vê tudo cross-tenant
  - Admin do tenant: vê só o seu tenant
  - Outros papéis (operador, gestor farmácia): vista mais restrita
- **Caching:** materialised views ou tabela de snapshot diário para KPIs caros

## 12. Métricas de sucesso do dashboard

Como saberemos se o dashboard cumpre o objectivo?

1. **Time-to-decision:** mediana de "ver KPI → tomar action" < 2min
2. **Stale alerts:** alertas abertos > 7d ≤ 5% do total
3. **Adopção:** owner abre dashboard ≥ 3× / semana
4. **Cobertura de workflows:** 80% das operações comuns têm drill-down 1-click
5. **Time-to-onboard:** novo admin entende dashboard em < 15min

## 13. Decisões pendentes (para depois do INFOMED fechar)

1. **Owner do dashboard:** quem é responsável por design + manutenção?
2. **Tooling:** Next.js app pages (mais integrado), Tableau, Metabase, Grafana (separado mas pronto)?
3. **Refresh budget:** real-time tem custo (DB queries) — quanto se está disposto a gastar?
4. **Alerting routing:** Slack channel partilhado ou notifications integradas?
5. **Self-service KPIs:** algum subset deve ser configurável pelos admins?

---

_Draft conceptual. Sem UI, sem código, sem migrations. Aguardo direção sobre
priorização (após o pipeline INFOMED fechar)._
