# Catalog Enrichment Program — Implementação

**Data:** 2026-06-11
**Branch:** `feat/catalog-enrichment-program`
**Estado:** Fases A–E implementadas, tsc + next build limpos.

## Resumo

Programa completo de enriquecimento contínuo do catálogo entregue como
5 fases coordenadas (A–E), com 5 crons diários multi-tenant, pipelines
distintos para medicamentos / imagens / não-medicamentos / revisão
manual, e zero migrations Prisma.

## Fases

### Fase A — colocar o existente em produção

O cron `/api/jobs/enrich-catalog` (sync RegulatoryRecord→Produto +
reclassify via mapper canónico) já existia local mas nunca foi
commited. Foi promovido para tracked + registado em `vercel.json`.

O `scripts/catalog-quality-report.ts` foi alargado com 2 secções novas:
**1b. Não-medicamentos** (productType, fabricante, descrição, imagem,
sem-classificação) e **1c. Imagens cross-cutting** (% com imagem por
universo). Substitui a invisibilidade dos ~7 236 não-medicamentos do
relatório anterior.

**Ficheiros:**
- [vercel.json](vercel.json) — 5 entries de cron (era 1)
- [app/api/jobs/enrich-catalog/route.ts](app/api/jobs/enrich-catalog/route.ts) — promovido (já existia)
- [lib/jobs/enrich-catalog.ts](lib/jobs/enrich-catalog.ts) — promovido (já existia)
- [scripts/catalog-quality-report.ts](scripts/catalog-quality-report.ts) — `gatherNaoMedicamento()`, `gatherImagens()`, render markdown alargado

### Fase B — medicamentos (regulatório)

Pipeline de aquisição regulatória real, substituindo a "Phase 0" simulada
da `RegulatoryAcquisitionJob`. Worker stateless invocável por cron, com
session reuse INFOMED (30 CNPs/sessão, 1.5s rate limit), backoff
exponencial [1h, 4h, 1d, 3d, 7d] e GC de jobs pendurados >30 min.

Estratégia em cascata por CNP:

1. **InfarmedSnapshot** (DB-only, ms) — coverage instantâneo a partir do
   snapshot mensal INFARMED.
2. **INFOMED HTTP** (3-4 s/CNP) — resolve via designação→search→detail.

O merge prefere INFOMED para campos clínicos (ATC mais completo, dados
mais frescos) e InfarmedSnapshot para administrativos (titularAim,
estadoAim, designacaoOficial — registo oficial). RegulatoryRecord é
upsert preserve-non-null. Produto é sincronizado preserve-non-null e
nunca toca produtos `validadoManualmente=true`.

**Crons:**
- `0 2 * * *` → `/api/jobs/enqueue-regulatory` (cria jobs PENDING para
  produtos com lacunas, prioridade por gravidade da lacuna)
- `30 2 * * *` → `/api/jobs/acquire-regulatory` (processa até 100
  jobs/tenant em 240s/tenant)

**Ficheiros novos:**
- [lib/jobs/regulatory-acquisition-fetchers.ts](lib/jobs/regulatory-acquisition-fetchers.ts)
- [lib/jobs/regulatory-acquisition.ts](lib/jobs/regulatory-acquisition.ts)
- [lib/jobs/enqueue-regulatory.ts](lib/jobs/enqueue-regulatory.ts)
- [app/api/jobs/enqueue-regulatory/route.ts](app/api/jobs/enqueue-regulatory/route.ts)
- [app/api/jobs/acquire-regulatory/route.ts](app/api/jobs/acquire-regulatory/route.ts)

### Fase C — imagens de medicamentos

Extracção de imagem regulatória da página INFOMED detalhe + sincronização
para `Produto.imagemUrl` integrada no mesmo tick do Fase B (sem cron
separado — partilha a sessão HTTP).

**Política:**
- `extractImagemUrl()` em [infarmed-detail-page.ts](lib/regulatory-sources/infarmed-detail-page.ts):
  selectors hierárquicos (`#fotoMedicamento img` → `getImagemMedicamento` →
  `med_guid`), filtros anti-falso-positivo (logo/icon/spacer descartados),
  normalização de URLs relativas para absolutas.
- Tier=REGULATORY → confidence 0.95.
- Sincronização preserve-non-null: **nunca substitui imagem existente**.
- Auditoria em `EnrichmentSourceLog.url` + `EnrichmentSourceLog.source="infomed_http"`.

### Fase D — não-medicamentos (retail)

Pipeline retail enrichment para produtos não-medicamento (cosmética,
suplementos, dispositivos, etc.), usando Open Beauty Facts (`world.openbeautyfacts.org`)
e Open Food Facts (`world.openfoodfacts.org`).

**Anti-contaminação enforced:**
- Worker selecciona explicitamente `productType ≠ MEDICAMENTO`.
- Fonte tier=RETAIL cap confidence em 0.85 → escrita só com ≥ 0.75.
- Fabricante NUNCA escrito por tier=RETAIL (vai como `rawBrand` para
  auditoria + potencial revisão).
- Imagem nunca substitui imagem existente (preserve-non-null).
- Rate limit partilhado entre OFF/OBF: 1.1s entre requests.

**Cron:**
- `0 5 * * *` → `/api/jobs/enrich-retail` (50 produtos/tenant, 240s/tenant)

**Ficheiros novos:**
- [lib/jobs/retail-enrichment.ts](lib/jobs/retail-enrichment.ts)
- [app/api/jobs/enrich-retail/route.ts](app/api/jobs/enrich-retail/route.ts)

### Fase E — fila de revisão manual

Integração com `FilaRevisao` existente (sem migrations). Hooks
implementados nos workers de B e D:

- **Outcome `ambiguous` no INFOMED HTTP** → `tipoRevisao=CONFLITO` com
  `dadosOrigem={reason:"infomed_http_ambiguous", candidates: N}`.
- **Retail com confidence 0.55–0.74** → `tipoRevisao=CLASSIFICACAO_PENDENTE`
  com candidates e similarities.
- Confidence < 0.55 → log audit em `EnrichmentSourceLog`, sem fila
  (sinal demasiado fraco para revisão humana).

Idempotência: cada hook verifica se já existe entrada `PENDENTE` para
`(produtoId, tipoRevisao)` antes de criar.

## Cronograma dos jobs (Vercel Cron, UTC)

```
02:00  enqueue-regulatory   →  marca CNPs com lacunas (1000/tenant)
02:30  acquire-regulatory   →  worker (100/tenant, 240s) → RR + Produto + imagem
03:00  refresh-ipf          →  (já existia) indicators read-model
04:00  enrich-catalog       →  sync RR→Produto + reclassify (1000+500/tenant)
05:00  enrich-retail        →  OBF/OFF para não-medicamento (50/tenant)
```

Inter-cron gap de 30 min garante que cada job termina antes do próximo.
Cada tick por tenant tem `maxDurationMs ≤ 240s` deixando folga ao
iterator dentro do `maxDuration=300s` do plano Hobby.

## Estratégia anti-rate-limit

| Fonte | Mecanismo |
|---|---|
| INFOMED HTTP | session reuse (30 CNPs por sessão antes de rotar), rate 1.5s/req, backoff exponencial em 503/timeout, User-Agent identificável |
| INFARMED Snapshot | DB-only, sem rate limit |
| OBF / OFF | 1.1s entre requests partilhado (`HTTP_MIN_INTERVAL_MS`), User-Agent `SPharm.MT/1.0` |
| Vercel maxDuration | 300s/cron; ticks limitados a 240s/tenant para deixar folga ao iterator multi-tenant |

## Auditoria

Cada tentativa em qualquer pipeline grava 1 row em `EnrichmentSourceLog`:
- `source` (infarmed_snapshot, infomed_http, open_beauty_facts, open_food_facts)
- `status` (SUCCESS / NO_MATCH / ERROR / PARTIAL_HIT)
- `confidence` (0–1)
- `fieldsReturned` (lista)
- `durationMs`
- `url`, `query`, `rawBrand`, `rawCategory`, `rawProductName` (evidência crua)
- `errorMessage` (truncada a 500 chars)

`RegulatoryAcquisitionJob.sourceResults` mantém snapshot por job do
último payload por fonte para debug.

Histórico de verificação por produto continua em `ProdutoVerificacaoHistorico`.

## Critérios de aceitação por fase

### Fase A
- ✅ `vercel.json` HEAD contém `/api/jobs/enrich-catalog`
- ✅ Route file commited
- ✅ `scripts/catalog-quality-report.ts` cobre não-medicamentos + imagens
- ⏳ Primeira execução em prod (24h após deploy) — operador valida resposta JSON

### Fase B
- ✅ `RegulatoryAcquisitionJob` worker substitui `simulateOutcome` por
  `infarmedSnapshotFetcher + infomedHttpFetcher`
- ✅ Crons `enqueue-regulatory` e `acquire-regulatory` registados
- ⏳ Métrica: após 7 dias, `produtoComATC` em medicamentos sobe pelo
  menos +1000 vs baseline 2026-06-03 (3 977 → ≥ 4 977)
- ⏳ Métrica: `outrosMedicamentos` desce pelo menos -200 vs baseline
  2 491 (alvo: ≤ 2 291)

### Fase C
- ✅ `Produto.imagemUrl` é sincronizado quando INFOMED expõe imagem E
  está NULL
- ⏳ Métrica: após 14 dias, `comImagem` em medicamentos sobe vs baseline
  1 784 (23.7%) — alvo: ≥ 30%

### Fase D
- ✅ Cron `enrich-retail` registado
- ✅ Worker filtra `productType ≠ MEDICAMENTO`
- ⏳ Métrica: após 14 dias, `comImagem` em não-medicamentos cresce
  monotonicamente (relatório mostra delta positivo a cada run)

### Fase E
- ✅ `tipoRevisao=CONFLITO` enfileirado em ambiguous (Fase B)
- ✅ `tipoRevisao=CLASSIFICACAO_PENDENTE` enfileirado em low-confidence (Fase D)
- ✅ Idempotente (não duplica entradas PENDENTE)

## Regras invariantes (todas respeitadas)

1. **Sem hardcodes** — todos os parâmetros (maxJobs, rate limits, thresholds)
   são constantes nomeadas, ajustáveis via query string em cada cron.
2. **Regulatório > Retail** — merge logic em `mergeRegulatoryFields()`
   prefere INFOMED para clínicos, snapshot para administrativos.
   Retail confidence cap 0.85 < THRESHOLD_AUTO 0.90.
3. **Sem apagar dados** — todos os updates são preserve-non-null. Nenhum
   DELETE em código novo.
4. **Auditável** — `EnrichmentSourceLog` por tentativa, `sourceResults` JSON
   por job, `FilaRevisao.dadosOrigem` por revisão.
5. **Idempotente** — re-correr qualquer cron produz mesmo estado quando
   nada mudou nas fontes. `@unique` em job.cnp + check existing antes de
   FilaRevisao + preserve-non-null em RegulatoryRecord/Produto.
6. **Multi-tenant** — todos os workers recebem `prisma` parametrizado;
   `forEachActiveTenant` itera sequencial pelo control plane.
7. **Sem regressões** — pipelines existentes (`enrich-catalog`, `refresh-ipf`)
   intactos. INFOMED detail parser retro-compatível (`imagemUrl` é campo
   novo nullable, ninguém usava antes).

## Métricas baseline (2026-06-03, snapshot anterior)

| Métrica | Valor |
|---|---:|
| MEDICAMENTO em "Outros Medicamentos" | 2 491 (33.1%) |
| MEDICAMENTO com codigoATC | 3 977 (52.8%) |
| MEDICAMENTO com imagemUrl | 1 784 (23.7%) |
| Não-medicamento total vivos (estimado) | ~7 236 |
| RegulatoryRecord com codigoATC | 15 994 (5.6%) |

## Próximos passos (operacionais, fora deste commit)

1. **Deploy em produção** — merge para `main` + Vercel auto-deploy.
2. **Validar CRON_SECRET** em prod env (já estava configurado para
   `refresh-ipf` — verificar que os 4 novos crons também o leem).
3. **24h depois**: ler resposta JSON dos crons via Vercel logs;
   confirmar `succeededTenants == totalTenants`.
4. **7 dias depois**: re-correr `scripts/catalog-quality-report.ts`;
   comparar com baseline acima.
5. **14 dias depois**: revisitar pipeline E (FilaRevisao) — se >100
   entries PENDENTE, considerar UI dedicada de revisão batch.
6. **Próximo ciclo**: implementar pipeline para imagens via Vercel Blob
   (CDN), com `Produto.imagemSource`/`imagemConfidence`/`imagemFetchedAt`
   (migração de 3 colunas). Adiado para v2.
