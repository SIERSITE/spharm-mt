# Scale Throughput Design — INFOMED enrichment Phase 2

**Data:** 2026-05-11
**Fase:** design arquitectural (sem implementação)
**Objectivo:** sair de ~10 CNP/min para 50–150 CNP/min sustentável, atingir
10k+ mappings, manter 0 falhas finais, sem partir o INFOMED.

## 1. Estado actual quantificado

Baseline do overnight run (5163 CNPs, 8h03m):

| Métrica | Valor | Bottleneck |
|---|---|---|
| Throughput | 10.7 CNP/min | rate-limit fixo 1500ms + step count |
| Direct match rate | 6.5% (404/6183) | qualidade das designações no ERP |
| Sibling amplification | ×3.03 mappings por match | já optimizado |
| Mapping yield | 18.6% (1153/6183) | derivado do anterior |
| HTTP 503 rate | 60% por sessão (130/215 sessões) | anti-bot agressivo |
| Falhas finais | 0 | backoff resiliente |
| Tempo por CNP médio | ~5.6s | (3.5s rede + 1.5s rate-limit + overhead) |

Mapping a `10000` mappings = `~50000` searches necessários (mantendo o yield).
A nossa cohort `outros-medicamentos` já está esgotada. Cohortes adjacentes
(MEDICAMENTO geral, novos CNPs) terão yield provavelmente menor (5–10%)
porque os fáceis já foram capturados — assumir **yield realista 8–12%**
para o próximo trabalho.

Projecção naïve do throughput actual:
- 50000 searches @ 10.7/min = **78h** (≈10 noites)
- Insustentável operacionalmente.

Targets desta fase:
- **50 CNP/min** = single-worker optimizado → 50000 searches em **17h** (~2 noites)
- **100 CNP/min** = 2 workers + endpoints de browse → **8h** (uma noite)
- **150 CNP/min** = 2-3 workers + browse + adaptive pacing → **5.5h**

## 2. Análise por prioridade

### P1. Cache persistente designacao/dci/titular → med_guid

**Estado actual:** mapping file é staging por CNP. Não há lookup reverso
por designacao/dci/titular. Cada CNP repete uma full search mesmo quando
o produto já é conhecido por outro CNP da mesma marca.

**Proposta:**

Nova tabela `InfomedDiscoveryCache` (ou cache em ficheiro JSON adicional):

```sql
-- medGuid: PK, único por medicamento INFOMED
-- normalizedDesignacao: índice (busca exact)
-- dci: índice
-- titularAim: índice
-- lastSeenAt, source
```

Lookups derivados:
- `designacao → med_guid` (exact match, 1:1)
- `dci → med_guid[]` (1:N — várias dosagens/formas partilham DCI)
- `titular → med_guid[]` (1:M — todos os medicamentos do titular)

**Negative cache:**
- `NotFoundSearchCache(searchTerm, lastTriedAt, attemptCount)` — evita
  re-pesquisar termos que falharam permanentemente
- TTL configurável (7 dias default, refresh on demand)

**Impacto estimado:**
- Cohorts subsequentes: 30–60% das designações têm overlap com mappings já feitos
  → 30–60% das searches são short-circuit (lookup em ms, sem hit HTTP)
- Real para nova cohort: assumir 20% short-circuit conservador
- Ganho: 25% throughput (50 CNP/min em vez de 40)
- Bonus: torna parallelism seguro (workers não duplicam trabalho)

**Risco:** cache stale se INFOMED actualizar. Mitigação: TTL + revalidate-on-error.

---

### P2. Session reuse agressivo

**Estado actual:** `maxSearchesPerSession=30`, `cooldown=30000ms`. Rotação a cada
30 searches dá 60% taxa de 503 por sessão (forçando rotation extra). Cada
nova sessão é 1 GET `index.xhtml` (~500–800ms) + parse ViewState.

**Proposta:**

1. **Aumentar `maxSearchesPerSession` para 60–80** (em vez de 30)
   - Estudar comportamento: o anti-bot dispara por IP+sessão ou por sessão?
   - Hipótese: anti-bot age por contador de requests/IP; sessão maior reduz GETs ao `index.xhtml` mas não muda a contagem global
2. **Eliminar `refreshIndexViewState` quando possível**
   - O ViewState do `pesquisa-avancada.xhtml` (Step 3) já é fresco e pode ser
     usado para o click row (Step 4)
   - Cada Step 3 dá-nos um ViewState válido por ~5min
   - Saltar Step 1 (GET index.xhtml) em todos os ciclos excepto o primeiro
3. **Pre-warm pool**
   - Manter 2 sessões em standby; quando uma é "queimada", a outra continua
   - O cooldown de 30s não bloqueia o crawler

**Impacto estimado:**
- −500ms por CNP em sessões maduras (skip GET index)
- +15% throughput
- Cooldown não-bloqueante: −5–10% de tempo morto durante rotações
- **Combinado: +20% throughput** (50 → 60 CNP/min)

**Risco:** sessão maior pode acumular mais anti-bot triggers se o INFOMED
tracker for por-sessão (não por-IP). Mitigação: monitorizar 503 rate e
backoff dinâmico em P7.

---

### P3. Multi-stage pipeline

**Estado actual:** crawler monolítico faz discovery (search→guid) +
detail fetch + persistência no JSON staging numa única passagem por CNP.

**Proposta:** quatro stages independentes, cada um com a sua cadência ideal:

```
Stage 1: DISCOVERY    (CNP → med_guid)              ← rate-limited (anti-bot)
Stage 2: DETAIL       (med_guid → clinical fields)  ← detail page NÃO é anti-bot-filtered
Stage 3: IMPORT       (JSON staging → RegulatoryRecord)
Stage 4: SYNC         (RegulatoryRecord → Produto)
Stage 5: REPROCESS    (Produto → classificacaoNivel2)
```

**Vantagens:**
- Stage 2 (detail) corre em paralelo com stage 1 sem rate-limit
  (`detalhes-medicamento.xhtml?med_guid=...` não tem anti-bot — confirmado em notes/infomed-investigation.md)
- Stage 1 morre? Stage 2/3/4/5 ainda processam o que está no staging
- Checkpoints intermédios: med_guid harvested mas ainda sem clinical fields
  ficam num estado "pending detail"
- Idempotência: cada stage pode re-correr sem efeitos colaterais

**Impacto estimado:**
- Discovery e detail em paralelo: o detail por CNP é hoje ~1s; movendo-o
  para fora do rate-limited path liberta ~1s/CNP
- +25% throughput discovery
- **Combinado com P2: +40% (50 → 70 CNP/min)**

**Risco:** complexidade operacional. Mitigação: stages são scripts
separados, cada um corre standalone (`scripts/discover-med-guids.ts`,
`scripts/fetch-details.ts`, etc.). Compatibilidade com pipeline actual.

---

### P4. Batch detail harvesting

**Estado actual:** quando o resolver encontra um med_guid no Step 5
(detail page), extrai todos os CNPs siblings e regista-os no mapping
file. Esta parte já está implementada.

**Refinamento proposto:**
- Quando um CNP é descoberto via sibling, marcar imediatamente em
  `processed_cnps` set (em memória + persistido a cada checkpoint)
- Cohort loader filtra CNPs no `processed_cnps` antes de tentar pesquisar
- Combinar com P1 (cache): sibling lookup ANTES de criar nova search

**Impacto estimado:**
- Já parcialmente activo (resume skip mapped). Refinamento marginal.
- +5% throughput em cohorts com muita redundância (vários CNPs do mesmo medicamento)

**Risco:** mínimo.

---

### P5. Persistent crawl intelligence (DB)

**Estado actual:** estado vive no JSON staging. Não há tabela para:
- Sessions queimadas (anti-bot triggered)
- Cooldown windows globais
- Search fingerprints (que termos retornam zero, que retornam ambiguous)

**Proposta:** novas tabelas:

```sql
InfomedMedGuid            -- med_guid → designacao, dci, titular, ATC, etc.
InfomedSearchFingerprint  -- searchTerm → outcome (found|not_found|ambiguous), lastTried
InfomedAntiBotEvent       -- timestamp, sessionId, statusCode, recoveryTimeMs
```

**Vantagens:**
- Parallelism seguro: workers consultam DB para evitar duplicar trabalho
- Cooldown global: se 503 dispara, todos os workers param (não só o que
  detectou)
- Telemetria: análise post-hoc do comportamento anti-bot do INFOMED

**Impacto estimado:**
- Throughput directo: +5% (skip de cooldown desnecessário)
- Habilitador para P8 (parallelism) — sem isto, parallelism é unsafe
- Reduz duplicação em re-runs após erro

**Risco:** mais migrations + writes na DB. Mitigação: tabelas separadas,
sem FK a produção; bag-of-data.

---

### P6. Throughput instrumentation

**Estado actual:** o crawler imprime resumo no fim (sessions created,
503 count, etc.). Não há observabilidade em tempo real.

**Proposta:**

1. **Métricas tempo-real escritas a um JSONL append-only:**
   ```
   scripts/data/metrics/run-<timestamp>.jsonl
   ```
   Linha por evento: `{ts, type: "search|detail|503|rotation|checkpoint", duration, sessionId}`

2. **Live dashboard (opcional):** `scripts/watch-crawler.ts` que tail-follows o JSONL e mostra rolling 5min averages

3. **Métricas a capturar:**
   - searches/min (rolling 1m + 5m + 30m)
   - details/min (separado de searches)
   - mappings/min (incluindo siblings)
   - siblings ratio (siblings/match) — detecta degradação
   - anti-bot frequency (503/total)
   - avg session lifespan (em searches)
   - cache hit ratio (P1)

**Impacto estimado:**
- Throughput directo: zero
- Operacional: diagnóstico rápido de degradação, parar antes de queimar 9h num run sub-óptimo

**Risco:** mínimo. JSONL write é barato.

---

### P7. Anti-bot adaptive

**Estado actual:** `rateLimitMs=1500` fixo. Backoff exponencial só dispara
em 503. Sem jitter.

**Proposta — token bucket adaptativo:**

```
Estado: { tokensAvailable, refillRatePerSec, currentSlowdownFactor }

Por cada search:
  - Esperar até ter token disponível (await tokensAvailable >= 1)
  - Decrementar token
  - Após N searches sem 503: incrementar refillRate (ramp-up até max)
  - Após 503: decrementar refillRate (×0.5), adicionar 30–90s cooldown global
  - Jitter ±150ms entre searches (random)

Defaults:
  - Start: refillRate = 0.4/s (≈ 1500ms entre searches) — actual
  - Min: 0.2/s (≈ 5000ms — pós-503 cooldown)
  - Max: 2.0/s (≈ 500ms entre searches — se INFOMED tolera)
```

**Impacto estimado:**
- Períodos "saudáveis" sobem para 2–3 searches/s
- Períodos pós-503 abrandam automaticamente
- **+30–50% throughput médio** (50 → 65–75 CNP/min)
- Jitter reduz detectability de pattern → menos 503 ao todo (estimativa
  −20% 503 rate)

**Risco:** se a max rate for demasiado agressiva, anti-bot fica permanente.
Mitigação: cap conservador (max 1.5/s no início), ajustar após observação.

---

### P8. Parallelism seguro

**Estado actual:** single worker, single session.

**Proposta:** 2 workers cooperativos:

```
Worker A: cohort partition 1 (CNPs com cnp % 2 == 0)
Worker B: cohort partition 2 (CNPs com cnp % 2 == 1)

Compartilham:
- Cache P1 (read-only durante o run, escritas via merge no fim)
- Token bucket global (P7) — rate budget partilhado
- DB intelligence P5 — cooldown global, fingerprints

Não compartilham:
- JSESSIONIDs (cada worker tem o seu pool — 2 sessões)
- ViewState
```

**Impacto estimado:**
- Throughput: 1.7× (não 2×, devido a partilhar token budget)
- 50 CNP/min single → 85 CNP/min 2-worker
- **Combinado com P1+P2+P3+P7: chegamos a 100–120 CNP/min**

**Risco:**
- Anti-bot pode escalar contra IP, não sessão. Se sim, 2 workers triggam mais.
- 3 workers: investigar mas só ligar se P5 estiver maduro

---

### P9. Discovery acceleration — endpoints de browse

**Esta é a wildcard de maior potencial.** Se o INFOMED expõe listagens
browseáveis, podemos colher centenas de med_guids por GET.

**Pistas identificadas (notes/infomed-investigation.md):**

1. **`pesquisa-avancada-form`** existe como form alternativo no
   `pesquisa-avancada.xhtml` com botão `#pesquisa-avancada-form:btnPesquisar`.
   Pode aceitar filtros por:
   - ATC (group, subgroup)
   - DCI
   - Forma farmacêutica
   - Dosagem
   - Titular AIM

   **Não foi inspeccionado em detalhe.** É a primeira coisa a investigar.

2. **`detalhes-medicamento.xhtml`** — confirmado HTTP-only sem anti-bot.
   Se conseguirmos enumerar med_guids alfabéticos sequenciais
   (ex.: GUIDs incrementais), poderíamos sondar em sequência.

3. **`listagem.xhtml`** — confirmado 404 em GET directo. Mas pode existir
   acessível pós-search via session.

**Estratégia proposta — investigação em 3 passos:**

1. **Capturar `pesquisa-avancada-form` interactivamente** (Playwright one-shot):
   - Submeter com filtro ATC=C09 (IECA, ~30 medicamentos)
   - Capturar request HTTP, resposta, ViewState
2. **HTTP-only replay** do POST para o mesmo filtro
3. **Se funcionar:** crawler por ATC group:
   - Para cada prefix ATC 3-char conhecido, 1 POST → N med_guids em 1 request
   - Estimativa: ~200 grupos ATC com volume significativo
   - 200 requests vs 50000 searches = **250x mais eficiente**

**Impacto estimado (otimista):**
- Se browse-by-ATC funciona: colher 5000–10000 med_guids em ~30min
- Skip total da fase search-por-CNP para esses casos
- **Pode ser o salto de uma noite (~9h) para 1h**

**Risco:**
- Pode não existir (endpoint não exposto ou comportamento idêntico ao search)
- Sem garantia. **Mas é a investigação de maior alavancagem.**

---

### P10. Target operacional realista

**Cenário conservador (sem P9 browse):**
- P1 cache + P2 session + P3 multi-stage + P7 adaptive + P8 parallel
- Throughput: **80–100 CNP/min sustentável**
- 50000 searches restantes → **8–10h**
- 10k+ mappings: **uma noite**

**Cenário optimista (com P9 browse funcional):**
- Browse-by-ATC dá 5000+ med_guids em 30min
- Restante via search-by-CNP optimizado
- 10k+ mappings: **2–4h**

**Cenário pessimista (P9 falha, anti-bot agressivo):**
- Cap em 30–40 CNP/min com adaptive pacing
- 50000 searches → 20h
- 10k+ mappings: **2 noites**

## 3. Sequência recomendada (sem implementar agora)

| Ordem | Item | Esforço | Ganho expectável | Habilita |
|---|---|---|---|---|
| 1 | **P9 spike** (1h Playwright investigation) | 2h | wildcard | Decisão arquitectural total |
| 2 | **P6 instrumentation** | 1 dia | 0% mas crítico | medição honesta de tudo o resto |
| 3 | **P1 cache + P5 DB** | 2 dias | +25% | P8, idempotência cross-run |
| 4 | **P3 multi-stage** | 1 dia | +25% | recoverability, P8 |
| 5 | **P2 session aggressive** | 0.5 dia | +20% | quick win |
| 6 | **P7 adaptive pacing** | 1 dia | +30–50% | maior ganho single-worker |
| 7 | **P8 parallelism 2 workers** | 1 dia | +70% (sobre single) | depende de P1+P5 |
| 8 | **P4 batch refinement** | 0.5 dia | +5% | last polish |

**Total: ~9 dias de trabalho focado, 30–50× speedup total.**

Item P9 é o **wildcard**. Se vier positivo, salta-se P2/P4/P7/P8 (ou
fica-os para fase ulterior) — uma única investigação Playwright pode mudar
toda a estratégia.

## 4. Riscos transversais

| Risco | Probabilidade | Mitigação |
|---|---|---|
| INFOMED altera anti-bot e tudo morre | baixa | P5+P6: detectar e parar; P7: backoff agressivo |
| 2 workers triggam anti-bot por IP | média | P5 cooldown global; cap em 2 antes de tentar 3 |
| Cache stale (medicamento muda titular) | baixa | TTL 7 dias, revalidate-on-mismatch |
| Browse endpoint dá rate-limit por GET-density | média | mesma estratégia adaptive de P7 |
| Discovery acelera mas detail page rate-limita | baixa (confirmado sem anti-bot) | improvável |

## 5. Não-objectivos desta fase

- Não otimizar match-rate (P1 cache ajuda mas o yield base depende do ERP)
- Não tocar em taxonomia
- Não tocar em loadSnapshot (dual-read RegulatoryRecord fica para outra altura)
- Não enriquecer imagens
- Não tocar em retail
- Não criar novas categorias

## 6. Decisão pendente

**Recomendação:** começar por **P9 spike** (investigação Playwright de
`pesquisa-avancada-form` com filtros). 2h de trabalho, mas pode mudar tudo.
Em paralelo, **P6 instrumentation** (instalável independentemente).

Se P9 spike retornar negativo, sigo a sequência conservadora P1→P3→P7→P8
que dá 80–100 CNP/min.

Aguardo direção sobre:
1. Aprovar P9 spike (2h Playwright) ou directamente para P1+P5?
2. Targets operacionais aceitáveis para 10k mappings: noite única (~10h)
   suficiente, ou queres comprimir para 2–3h via P9?
3. 2 workers ok ou queres ficar single-worker até medirmos melhor?

---

_Design read-only. Sem implementação. Aguardo aprovação para o spike._
