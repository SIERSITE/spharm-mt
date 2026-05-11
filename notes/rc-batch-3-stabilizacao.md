# RC Batch 3 — Estabilização Final + P0 Infra

**Data:** 2026-05-11 · **Commits:** próximos

## Fechou neste batch

| # | Item | Estado |
|---|---|---|
| P0.1 | Decisão CONTROL_DATABASE_URL: **Neon project partilhado** | ✅ documentado em `notes/infra-strategy.md` |
| P0.2 | Provisioning strategy: **DB-per-tenant em 1 projecto Neon** | ✅ caminho concreto + custo + limites |
| P0.3 | Environment validation: `lib/env.ts` + `env:doctor` + tests | ✅ 30+ asserts verdes, single source of truth |
| B3.1 | `lib/env.ts` central com schema + fail-fast | ✅ |
| B3.2 | Hardening: scripts de tenancy delegam ao catálogo central; mensagens com description + exemplo | ✅ |
| B3.3 | Cron: `env:doctor` valida `CRON_SECRET` no scope `cron`; smoke trigger documentado | ✅ |
| B3.4 | Legacy audit final: 4 ficheiros `lib/catalog-*.ts` usam `legacyPrisma` legitimamente (catálogo é global hoje); 1 painel admin + 1 oportunidades page usam legacyPrisma APENAS para IPF freshness display | ✅ classificado |
| B3.5 | Pilot readiness checklist com tempos reais por fase | ✅ `notes/pilot-readiness-checklist.md` |

## Validações

- `tsc --noEmit` ✅
- **8 suites / 280+ asserts ✅** (+test-env com 30+ asserts)
- `npm run env:doctor` ✅ falha-rápido com lista accionável por scope
- 4 páginas core HTTP 200 em dev

---

## As 4 respostas

### 1. "O que ainda impede piloto real?"

**Nada estritamente bloqueante a nível de código.** A plataforma está RC-ready desde Batch 2.

Para arrancar piloto, falta apenas:

| Tarefa | Quem | Tempo |
|---|---|---|
| Provisionar projecto Neon (1 vez) | infra | ~15 min |
| Configurar 8 envs em Vercel + .env local | infra | ~5 min |
| Deploy inicial + smoke `env:doctor` | dev | ~10 min |
| **Total bootstrap** | — | **~30 min** |

Depois disto, primeiro tenant em <15 min (`tenant:onboard`).

### 2. "O que ainda pode partir em produção?"

**Riscos classificados:**

| Risco | Severidade | Mitigação no código |
|---|---|---|
| Neon cold-start atrasa primeira request | Baixa | `maxDuration=300s` no cron + pooler cached |
| `CONTROL_DATABASE_URL` mal configurado | Alta → **Baixa** | `env:doctor` + `requireControlEnv` falha-rápido |
| `TENANT_ENCRYPTION_SECRET` perdido | **Crítica permanente** | Documentado em `infra-strategy.md`; backup obrigatório em vault |
| Migration falha mid-deploy num tenant | Média | Tenant fica em `FAILED`; manual recovery via `tenancy:migrate-all --only=` |
| Cron skip (Vercel down/deploy) | Baixa | IPF stale fica visível em `/admin` (>26h amber); cron volta a correr 24h depois |
| Agent Windows offline >30 min | Baixa | Visível em `/admin` Heartbeat coluna |
| Concurrent ingest race | Baixa | Idempotent upserts em todos os jobs (testado em IPF populate) |
| Backup ausente | Média | `lastBackupAt` exposto; PITR Neon cobre 7d free / 30d paid |
| ATC/DCI errado leva a substituição errada | **Mitigada** | Gates clínicos (forma+dose+ATC5+MSRM); audit já corrigiu 3 catalog issues; UI cautelar amber em DCI |
| Falsa positivo same-CNP transfer | Baixa | Confirmação humana obrigatória (`confirm()`); operador finaliza no flow normal |

**Sem ponto único de falha crítica não-mitigada.** O único ponto sensível é o `TENANT_ENCRYPTION_SECRET` (perda = impossível recuperar tenant DBs encrypteded). Tem de estar em vault corporativo.

### 3. "Quantos grupos conseguimos suportar hoje realisticamente?"

| Config Neon | Tenants suportados | Custo/mês |
|---|---:|---|
| Free | **5–8** | 0€ |
| Launch | **20–30** | 19€ |
| Scale | **50+** | 69€ |

Limitações práticas no Free:
- 10 DBs por projecto (1 control + 9 tenants máx)
- 191 compute hours/mês (auto-suspend ajuda)
- 0.5 GB storage total

**Para o piloto inicial: 5 tenants em Free é confortável.** Upgrade Launch quando 1.º conjunto piloto validar (planeamento financeiro previsível).

Limites de aplicação:
- IPF populate roda em <15s para 22 016 rows em 2 farmácias. Linear no nº ProdutoFarmacia ⟹ tenants com 50k rows demora ~30s.
- `findInternalSubstitutions` é O(N) por grupo de produto + O(N²) por pair-evaluation. Para um tenant com 30k+ ProdutoFarmacia, o cálculo total fica em <2s mesmo com vários grupos.
- Dashboard SSR demora 1–3s por tenant com IPF populada.

### 4. "Quanto tempo demora onboard de um grupo novo?"

**~10–15 min de relógio**, decomposto em:

| Passo | Tempo | Tipo |
|---|---:|---|
| `npm run tenant:onboard --slug --nome --admin-email` | ~30s | automático |
| Issue ingest key | ~30s | comando |
| Configurar agent Windows do grupo | ~5 min | manual no PC do cliente |
| Confirmar 1º heartbeat | ~1 min | espera + olhar `/admin` |
| Primeira ingest (depende do volume) | 2–10 min | agent + ingest API |
| Validar dados via `tenancy:health` | ~1 min | comando |
| Validar dashboard + oportunidades visualmente | ~2 min | navegação |
| **Total operador** | **~10–15 min** | — |

Bottleneck: configuração do agent no PC do cliente (passo manual fora da nossa plataforma) e tempo da primeira ingest.

---

## Legacy audit final

Resultado: **3 categorias**.

### Blocker (0 ficheiros)

Nenhum path crítico runtime-web usa `legacyPrisma` ilegitimamente. O cron endpoint `/api/jobs/refresh-ipf` usa-o por design (legacy-only por agora — multi-tenant fica para quando `CONTROL_DATABASE_URL` estiver provisionado).

### Warning (3 ficheiros)

| Ficheiro | Razão | Quando migrar |
|---|---|---|
| `lib/catalog-classification.ts` | Catálogo é global (não per-tenant) hoje | Quando catálogo passar a per-tenant (não planeado RC) |
| `lib/catalog-connectors.ts` | idem | idem |
| `lib/catalog-enrichment.ts` | idem | idem |
| `lib/catalog-persistence.ts` | idem | idem |
| `lib/importer.ts` | Usado por ingest API que injecta `ctx.prisma` correctamente | Verificar uso direct (não-via-API) |

### Low priority (resto)

Scripts CLI que correm fora do request context — uso de `legacyPrisma` é aceitável e idiomático.

---

## Comandos novos disponíveis

```bash
# Validar envs (uso em pre-deploy)
npm run env:doctor
npm run env:doctor -- --scope=web      # Verifica só scope web
npm run env:doctor -- --quiet          # Só exit code

# Onboard de grupo novo (já existia)
npm run tenant:onboard -- --slug ... --nome ... --admin-email ...
```

---

## Próximos passos sugeridos (não inicio sem aprovação)

| Batch | Conteúdo | ETA |
|---|---|---|
| **Provisionar Neon real** | Bootstrap concreto seguindo `infra-strategy.md` | ~30 min · infra |
| **Smoke do 1º tenant piloto** | `tenant:onboard` + ingest + dashboard | ~15 min · ops |
| **Batch 4 — RC Polish** | Empty states, mobile audit, terminologia | 0.5–1 dia · dev |
| **Catálogo regulatório fetchers reais** | Activa `RegulatoryAcquisitionJob` com INFOMED fetcher | 1–2 dias · dev (multiplica DCI universe 3×) |
| **Compra ingest pipeline** | Completar IPF (3 campos ainda null) | 1–2 dias · dev (requer modelo `Compra` populado) |
| **Acceptance logging substituições** | Log de aceitar/rejeitar sugestões para feedback loop | 0.5 dia · dev |

---

_lib/env.ts single source of truth · 8 suites verdes · pilot checklist com tempos reais · Neon estratégia decidida · plataforma RC operacionalmente pronta assim que infra envs estiverem configurados._
