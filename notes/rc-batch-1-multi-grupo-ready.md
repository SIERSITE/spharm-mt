# RC Batch 1 — Multi-Grupo Ready

**Data:** 2026-05-11 · **Commits:** próximo

## Fechou

| # | Item | Estado |
|---|---|---|
| 1 | Tenant Operations Pack: `forEachActiveTenant` com `parallelLimit` (commit anterior `f21e665`) + comando único `npm run tenant:onboard` (provision + smoke + checklist) | ✅ |
| 2 | Admin Tenant Health: tabela `/admin` com Slug · Nome · Estado · DB · **Last sync** · **Backup** · Heartbeat · Key — sem charts decorativos | ✅ |
| 3 | Provisioning simplificado: `npm run tenant:onboard` encadeia provision-tenant.ts + smoke-test-resolver.ts; imprime checklist accionável de 6 passos manuais restantes | ✅ |
| 4 | Backup visibility: `lastBackupAt` surfaced na admin table, amber se >2 dias ou sem registo | ✅ |

## Impacto operacional directo

- **1 comando para criar grupo novo.** `npm run tenant:onboard -- --slug X --nome Y --admin-email Z` cria role+db+schema+admin+activa+smoke-tests + lista os 6 passos manuais que faltam (key, agent config, heartbeat check, health, backup, comunicação). Documentado em `notes/tenant-onboarding.md`.
- **Visibilidade operacional única na `/admin`.** Em uma linha por tenant: estado, último sync (idade colorida por status), idade do backup (amber/vermelho se stale), heartbeat, key — sem precisar abrir 5 ferramentas.
- **Failure modes mapeados.** Cada modo de falha de onboarding tem recovery documentada (Tenant em FAILED, role já existe, smoke-test falha, etc.).

## Validações

- `tsc --noEmit` ✅ limpo
- 7 suites / 252 asserts ✅ verdes
- Onboard wrapper testado em dry-pattern (execução real requer `CONTROL_DATABASE_URL` + `TENANT_DB_HOST` configurados — não disponíveis nesta env)

## Blockers reais

| Bloqueio | Severidade | Decisão necessária |
|---|---|---|
| `CONTROL_DATABASE_URL` não provisionado | **P0 — bloqueia tudo multi-tenant** | Provisionar BD control plane (Neon ou self-hosted). Sem isto, `/admin` 500, `tenant:onboard` falha-rápido. |
| `TENANT_DB_HOST` + `PGADMIN_*` não configurados | **P0** | Onde se hospedam as BDs por tenant? Decisão de infra (Neon Project per tenant vs schema-per-tenant numa BD partilhada vs server dedicado). |
| Cron real para backups | **P1** | `lastBackupAt` está pronto para ser preenchido mas não há job que escreva. Aceita-se manual no provider Neon nesta fase. |
| `RegulatoryAcquisitionJob` fetchers reais | **P2** | Stub existe; sem fetchers, catálogo fica em 28% coverage e DCI-equivalent escala mal. Independente de multi-grupo. |

## "Isto já pode ser usado por um grupo real de farmácias?"

**Tecnicamente sim** — com o caveat operacional:

- ✅ Provisionar tenant via 1 comando
- ✅ Migrar schema, criar admin, validar resolver
- ✅ Painel admin com saúde por tenant
- ✅ Ingest API funcional (sem alterações nesta batch)
- ✅ `/encomendas` + `/stock` + `/transferências` + dashboard prontos com ATC/DCI + DCI-equivalent
- ✅ Scheduler IPF diário (Vercel Cron)
- ❌ **MAS** requer `CONTROL_DATABASE_URL` + `TENANT_DB_HOST` provisionados primeiro.

Uma vez essas duas envs configuradas, o caminho `tenant:onboard → operar` está pronto para piloto real.

## ETA próximo batch (Batch 2 — Comunicação entre farmácias)

Estimativa: **0.5–1 dia útil**, dependente de:

1. CTA "Criar transferência" pré-preenchido a partir das sugestões (same-CNP + DCI). Precisa de saber qual endpoint actual cria uma transferência (existe `LinhaEncomenda` mas não há ainda transferência inter-pharmacy formal — pode ser uma encomenda com origem interna). **Pequena investigação de scope no início** para confirmar o modelo de dados.
2. Inbox de oportunidades — feed unificado consumindo loaders já existentes (`getInternalSubstitutionsData` + DCI equivalent). Sem chat.
3. Dashboard alerts — cards accionáveis (não BI). Reaproveita `dashboard-sections` existente.

Se o modelo de transferência inter-pharmacy não existir como entidade, o CTA pode emitir uma encomenda interna ou uma anotação tipo "transferência sugerida #N" — confirmar com utilizador antes de implementar.

---

_1 comando · 1 checklist · 1 página admin · pronto para piloto assim que infra envs estiverem configuradas._
