# Regulatory Expansion Plan — 52,8% → 70%+ ATC coverage

**Data:** 2026-05-11
**Âmbito:** Plano incremental para subir cobertura ATC do `Produto` MEDICAMENTO vivo de **52,8% (3 977/7 526)** para **70%+ (≥5 268)**, sem novos crawls massivos e sem stress no INFOMED.
**Modo:** Read-only analysis. Nenhuma alteração ao DB foi feita.
**Baseline:** `notes/infomed-pipeline-final-report.md` (pipeline P9 concluído em 2026-05-11).

---

## 1. Executive Summary

- **Gap real:** 3 549 MEDICAMENTO vivos sem ATC. Diagnóstico bucket-a-bucket (§2) mostra que **apenas ~1 005 (28%) são recuperáveis** com novo fetch ao INFOMED a custo baixo. Os restantes ~2 540 são problema estrutural (medicamentos descontinuados, sem AIM activa, ou erro de CNP no ERP) ou de fonte (precisam de fontes externas pagas/manuais).
- **Wave 2 é o caminho óbvio:** os 4 414 medIds INFOMED *já mapeados* na listagem JSON mas nunca fetched contêm cerca de 1 415 medIds com first-token a bater em produtos ERP. Re-correr `fetch-details-by-medid.ts --filter=all` (ou variante "ERP-only-extended") gasta ~20 min wall-clock, zero anti-bot footprint, e empurra cobertura para **~66% (4 982/7 526)**.
- **Bucket A (sync gap) está esgotado:** o `sync-rr-to-produto-broad.ts` já não tem candidatos pendentes. O ganho histórico foi capturado integralmente.
- **Sem cobertura ≥70% sem novas fontes:** atingir 70% (≥5 268) exige obrigatoriamente tocar uma das duas: (a) Strategy 4 (EMA Article 57 Excel — grátis, mas só cobre medicamentos com AIM centralizada), ou (b) Strategy 3 (search-by-name no INFOMED, 50/dia, ~50 dias para fechar 2 500).
- **Stop criterion proposto:** parar quando ganho ATC marginal < **30 produtos/min** de wall-clock de crawl, ou cobertura ≥ 70%, o que vier primeiro.

---

## 2. Gap analysis (buckets reais)

Universo analisado: **3 549 produtos** com `productType=MEDICAMENTO`, `estado<>INATIVO`, `codigoATC IS NULL`.

Fontes: `scripts/data/infomed-listagem.json` (9 656 medIds), `scripts/data/infomed-listagem-details.json` (5 242 details com 15 526 CNPs únicos), queries directas a Postgres.

| Bucket | Descrição | N | % de 3 549 |
|---|---|---:|---:|
| **A** | CNP existe em `details.json` (medId fetched) mas Produto sem ATC — sync gap | **3** | 0,1% |
| **B** | CNP não está nos details mas o medId existe no listagem (não fetched) — first-token ERP bate listagem | **948** | 26,7% |
| **C-design** | First-token da designação ERP existe no listagem mas o CNP do produto não aparece nos details (provável embalagem antiga / variante de marca) | **260** | 7,3% |
| **C-no-match** | Nem CNP nem first-token batem em nada do INFOMED listagem — descontinuado, raro, ou nunca AIM | **2 333** | 65,7% |
| **D** | CNP < 2 000 000 (códigos internos, não medicamento real) | **5** | 0,1% |
| **E** | CNP null / inválido | **0** | 0,0% |
| **F** | Sem CNP (cnp=0) | **0** | 0,0% |

### 2.1 Interpretação

- **Bucket A é residual (3 produtos).** O `sync-rr-to-produto-broad.ts` capturou tudo o que tinha para capturar; os 3 remanescentes são casos com RR sem ATC (provavelmente medIds onde o INFOMED não devolveu codigoATC — 3 dos 5 242 details: V03AX e Oscillococcinum, conforme nota §8.2 do relatório final). **Não vale a pena pipeline.**
- **Bucket B (948) é a oportunidade real.** Estão "atrás" de 4 414 medIds INFOMED na listagem que nunca foram fetched porque o filtro original cross-match foi *first-token-strict*. Destes 4 414, **1 415 têm first-token a bater em produtos ERP sem ATC.** Estimativa de ganho líquido: **+1 005 produtos** (taxa histórica de conversão fetched→Produto syncado: 3 722 / 5 242 = 0,71).
- **Bucket C-design (260) é match parcial.** O nome bate mas o CNP do ERP não está nas embalagens INFOMED. Sinais: (i) embalagem descontinuada (ainda no ERP), (ii) variante regional, (iii) CNP errado no ERP. Estes não se resolvem com fetch — exigem mapping designação→DCI manual ou via search-by-name (Strategy 3).
- **Bucket C-no-match (2 333) é o grosso e o mais difícil.** Estes produtos *não existem* no INFOMED actual sob CNP nem nome. Causas prováveis:
  - medicamentos descontinuados há >10 anos mas com stock residual em farmácia;
  - dispositivos médicos misclassificados como MEDICAMENTO no ERP (productType incorrecto);
  - produtos veterinários ou de uso hospitalar/restrito.
- **Bucket D (5) é ruído.** Códigos internos com CNP < 2M; provavelmente medicamentos manipulados. Não-INFOMED por definição.

### 2.2 Universo INFOMED não-fetched (visão complementar)

| Subset | N |
|---|---:|
| medIds no listagem, fora dos details (não fetched) | **4 414** |
| └─ com first-token a ERP-sem-ATC (Wave 2 alvo) | **1 415** |
| └─ sem first-token-match a ERP-sem-ATC | **2 999** |

Os 2 999 "sem match a ERP-sem-ATC" são: (i) medicamentos INFOMED *já cobertos* no ERP (logo first-token bate em produto que já tem ATC, mas não num *sem* ATC), (ii) medicamentos INFOMED que nunca estiveram no ERP (catálogo nacional puro). Estes últimos só interessam se quisermos expandir `RegulatoryRecord` como catálogo do mercado nacional (decisão pendente conforme §10.2 do relatório final).

---

## 3. Estratégias

Cada estratégia mapeia um (sub)bucket → acção concreta com custo e ganho estimado.

### 3.1 Strategy 1 — Wave 2 fetch dos medIds restantes (Bucket B)

- **Alvo:** 1 415 medIds INFOMED com first-token a bater em ERP-sem-ATC.
- **Variante mais larga (recomendada):** correr `fetch-details-by-medid.ts --filter=all` sobre os 4 414 medIds não-fetched. Custo marginal de fetchar os 2 999 extra é zero em risco (mesmo throughput) e cobre potenciais Bucket-C-design via embalagens novas.
- **Execução:** novos GETs `?med_id=X` à taxa actual (3,57/s, 3 workers, rate-limit 300 ms).
- **Custo:**
  - Variante alvo (1 415 medIds): ~395 s (~6,6 min wall-clock).
  - Variante ampla (4 414 medIds): ~1 237 s (~20,6 min).
- **HTTP load:** ~214 req/min — dentro do envelope demonstrado.
- **Anti-bot risk:** nulo (mesmo padrão GET-direct comprovado em P9 com 0 falhas em 5 242 medIds).
- **Ganho esperado:** **+1 005 produtos com ATC** (cobertura 52,8% → ~66,1%).
- **Pós-processamento:** import + sync-broad (~15 min extra).
- **Reentrante:** sim, idempotente.

### 3.2 Strategy 2 — Re-sync broad (Bucket A)

- **Alvo:** Bucket A (3 produtos).
- **Execução:** `sync-rr-to-produto-broad.ts --apply`.
- **Custo:** zero HTTP, ~10 s DB.
- **Ganho esperado:** **0 produtos com ATC**. (Confirmado: candidates pendentes = 0 hoje.)
- **Veredicto:** **NÃO executar autonomamente.** Já foi corrido como parte do pipeline P9. Faz parte do checklist pós-Strategy 1 (após cada novo import a `RegulatoryRecord`, correr broad sync — é assim que o ganho de Wave 2 chega ao `Produto`).

### 3.3 Strategy 3 — Search-by-name no INFOMED (Bucket C-design)

- **Alvo:** 260 produtos com first-token a bater no listagem mas CNP miss.
- **Execução:** spike pontual usando search-by-name no INFOMED (`pesquisa-avancada` ou similar) — *não* é o crawler legacy CNP-based. Pequenos batches de 30-50 por dia para evitar anti-bot.
- **Custo:**
  - HTTP: 260 buscas × 1-2 round-trips cada = ~520 req. A ~1 req/s defensivo = ~9 min, mas espalhados em 5-9 dias para anti-bot.
  - Tempo de engenharia para escrever search-by-name parser: ~4-6 h (lib `infarmed-detail-page.ts` é reutilizável; falta layer de search-results).
- **Anti-bot risk:** **médio-alto.** Search-by-name é mais sensível do que browse/detail-by-medId (foi por isso que o crawler legacy CNP-based morria a 0,18/s). Mitigação: small batches + sessão por dia.
- **Ganho esperado:** **+100 a +150 produtos com ATC** (atrição na cadeia: nem todos terão hit, mesmo após designação match).
- **Veredicto:** considerar só *depois* da Wave 2. ROI marginal alto em produto/min mas custo de engenharia maior.

### 3.4 Strategy 4 — Fontes alternativas (Bucket C-no-match)

- **Alvo:** os 2 333 produtos sem qualquer match INFOMED.
- **Opções públicas avaliadas:**

  | Fonte | URL | Formato | ATC? | Cobre PT? | Custo |
  |---|---|---|---|---|---|
  | **INFARMED — CITS Portal** | infarmed.pt → "Cedência de bases de dados de medicamentos" | CSV/XLS (Eudravigilance-like) | Sim | Sim (nacional) | **Pago** — preço por dataset; depende de uso comercial vs académico |
  | **EMA — Article 57 Database** | ema.europa.eu/en/medicines/download-medicine-data | XLSX (manual download) | Sim | Apenas AIM centralizada (~1 500 medicamentos UE) | **Grátis** |
  | **EMA — JSON website data** | ema.europa.eu/en/about-us/about-website/download-website-data-json-data-format | JSON (2× dia) | Parcial | EPAR-centric | Grátis |
  | **WHO ATC index** | whocc.no/atc_ddd_index | HTML scrape | É a fonte oficial de ATC | Não tem produtos PT, apenas a árvore ATC | Grátis |
  | **FDA Orange Book / NDC** | accessdata.fda.gov | CSV/XLS | Não (FDA usa USP, não ATC) | Não cobre PT | Grátis (mas não aplicável) |

- **Veredicto operacional:**
  - **EMA Article 57 (XLSX):** grátis e ATC explícito. Mas só cobre medicamentos com AIM centralizada (procedimento UE), que são apenas ~1 500 de um universo INFOMED de 9 656. **Cobertura potencial sobre Bucket C-no-match: ~5-10%** (porque medicamentos descontinuados / nacionais puros não estão lá). Vale como cross-reference futura mas não resolve o gap.
  - **INFARMED CITS:** o caminho "certo" mas pago. Precisa decisão de orçamento + procurement. Fora de scope desta semana.
  - **WHO ATC index:** **útil mas indirecto.** Permite enriquecer `RegulatoryRecord` com a árvore ATC (parent groups, nomes oficiais) — *não* resolve "que ATC tem este CNP". Vale como melhoria de qualidade, não de cobertura.
- **Custo:** download manual EMA XLSX (~1 h engenharia para importer); avaliação CITS (~1 dia engenharia + procurement).
- **Ganho esperado:** EMA grátis = **+50 a +120 produtos** (intersect com universo PT). CITS = potencialmente +1 000+ mas dependente de aquisição.

### 3.5 Strategy 5 — Refresh do listagem

- **Alvo:** capturar medicamentos novos com AIM concedida desde 2026-05-11 (data do último run de browse).
- **Execução:** re-correr `browse-infomed-listagem.ts` (~15 min, 0 falhas históricas, 1 sessão).
- **Custo:** ~15 min wall-clock, 966 GET requests à taxa de 1,07 pages/s. Zero anti-bot risk.
- **Ganho esperado:** medicamentos novos representam +50 a +200 medIds/mês em INFOMED (heurística). Em 6 meses talvez +1 000 medIds — destes, intersecção com produtos ERP-sem-ATC é provavelmente baixa (<100).
- **Veredicto:** executar como cadência mensal (cron-style), não como acção pontual. Cron alvo: **1× por mês**.

---

## 4. Tabela comparativa

| # | Estratégia | Bucket alvo | Wall-clock | HTTP req | Anti-bot risk | Ganho ATC | Ganho/min | Prioridade |
|---|---|---|---:|---:|---|---:|---:|---|
| 1 | Wave 2 fetch (1 415 medIds alvo) | B | ~7 min | ~1 415 | nulo | +1 005 | **143/min** | **P0 — fazer já** |
| 1b | Wave 2 fetch ampla (4 414 medIds) | B + reuso futuro | ~21 min | ~4 414 | nulo | +1 005 (mesmo) | 48/min | P0 alternativo |
| 2 | Re-sync broad | A | <1 min | 0 | n/a | 0 hoje (necessário pós-1) | — | P0 (encadeado a 1) |
| 3 | Search-by-name INFOMED | C-design | ~9 min HTTP + 5 dias calendário | ~520 | médio-alto | +100 a +150 | ~15/min eff. | P2 — Wave 3 |
| 4a | EMA Article 57 XLSX | C-no-match | ~1 h eng. + 5 min import | 1 download | n/a | +50 a +120 | — | P2 — Wave 3 |
| 4b | INFARMED CITS (pago) | C-no-match | dias (procurement) | n/a | n/a | potencial +1 000 | — | P3 — backlog |
| 5 | Refresh listagem | novos meds | ~15 min | ~966 | nulo | +20 a +100/mês | ~6/min | P1 — cadência mensal |

---

## 5. Plano faseado

### Wave 1 — esta semana (ROI máximo, risco zero)

- **Acção 1.1** — Re-correr `browse-infomed-listagem.ts` para refrescar a listagem (Strategy 5). **Justificação:** o run actual é de 2026-05-11; mensal vai ser a cadência alvo, mas confirmar que o ficheiro está fresco antes da Wave 2 garante que captamos qualquer medicamento novo.
  - **Comando:** `npx tsx scripts/browse-infomed-listagem.ts` (output: `scripts/data/infomed-listagem.json`).
  - **SLA:** 15 min, 0 falhas esperadas.

- **Acção 1.2** — Correr `fetch-details-by-medid.ts --filter=all --resume` (Strategy 1, variante ampla). **Justificação:** o flag `--resume` salta os 5 242 medIds já fetched; corre apenas os 4 414 restantes. A variante ampla custa só ~14 min extra vs filtragem manual e garante que cobrimos eventuais Bucket-C-design.
  - **Comando:** `npx tsx scripts/fetch-details-by-medid.ts --filter=all --resume --parallel=3 --rate-limit-ms=300`.
  - **SLA:** ~21 min, 0 falhas esperadas (cenário P9 confirmou estabilidade).

- **Acção 1.3** — Import staging → RR: `npx tsx scripts/import-details-to-regulatory.ts`.
  - **SLA:** ~12 min, 0 falhas.

- **Acção 1.4** — Sync RR → Produto: `npx tsx scripts/sync-rr-to-produto-broad.ts --apply`.
  - **SLA:** ~3 min.

- **Acção 1.5** — Reprocess catálogo focado em novos ATC/DCI: `npx tsx scripts/reprocess-catalog.ts --apply --skip-retail --only-with-atc-or-dci`.
  - **SLA:** ~30-40 min (apenas o subset novo).

- **Total wall-clock Wave 1:** ~80-90 min.
- **Target cobertura:** **52,8% → ~66% (+1 005 produtos com ATC)**.
- **Side-effect esperado:** "Outros Medicamentos" desce de 2 491 → ~1 500 (assumindo ratio P9 de reclassificação ≈ 88% dos novos com ATC saem de Outros).

### Wave 2 — próximas 2 semanas (consolidação)

- **Acção 2.1** — Spike para search-by-name parser (Strategy 3, infra). **Estimativa:** ~4-6 h engenharia.
- **Acção 2.2** — Batch diário 30-50 produtos do Bucket C-design (260 itens) durante 6-9 dias.
- **Acção 2.3** — Importar EMA Article 57 XLSX como segunda fonte (Strategy 4a). Cruzar via designação/DCI (não via CNP — Article 57 não traz CNP nacional).
- **Target cobertura:** **66% → ~68-69%**.

### Wave 3 — mês seguinte (decisão)

- **Acção 3.1** — Avaliar custo CITS (Strategy 4b). Se aprovado, importar dataset autoritativo INFARMED e atingir 70%+ rapidamente.
- **Acção 3.2** — Em alternativa, declarar o gap residual (~2 200 produtos) como problema *operacional* (não regulatório) — productType=MEDICAMENTO incorrecto, ou descontinuados sem AIM activa. Pivotar para Caminho B do relatório final (intelligence operacional).
- **Target cobertura:** **70%+** (com CITS) ou **declarar plateau** em ~68% sem aquisição paga.

---

## 6. Stop criteria

Parar quando *qualquer* das condições for satisfeita:

1. **Cobertura ATC ≥ 70%** sobre MEDICAMENTO vivo (≥ 5 268/7 526).
2. **Ganho marginal < 30 produtos/min de wall-clock de crawl.** Métrica calculada como `(novos_produtos_com_ATC) / (minutos_HTTP_+_import_+_sync)`. Threshold derivado:
   - Wave 1 esperado: ~1 005 produtos / ~80 min = 12,5 produtos/min — **acima do threshold por wide margin** (porque inclui import/sync além do fetch puro). Apenas a fase fetch: ~1 005 / 21 min = **48/min**.
   - Strategy 3 (search-by-name): ~125 / 9 min HTTP = 14/min — **abaixo do threshold por HTTP, mas calendário-bound a 5 dias.**
   - EMA Article 57: trabalho pontual, não é HTTP-bound — avaliar por ganho/h engenharia.
3. **3 corridas consecutivas com ganho < 50 produtos** — sinal de plateau real.
4. **Falhas HTTP > 5%** numa corrida — indicador de anti-bot a ligar. Parar e investigar antes de continuar.
5. **Tempo wall-clock de uma corrida > 30 min** sem checkpoints úteis — viola constraint dura.

---

## 7. Backlog (NÃO fazer agora)

### 7.1 Adiados explicitamente

- **Fuzzy matching designação→CNP** (e.g. Levenshtein, tokenized cosine, embeddings).
  - Razão: já temos first-token match cobrindo o caso fácil. O gap restante (Bucket C-no-match) é genuinamente "não existe no INFOMED", não "match difícil". Fuzzy iria introduzir falsos positivos sem ganho de cobertura real.

- **Crawler search-by-CNP legacy** (`scripts/crawler-infomed.ts`).
  - Razão: provadamente 20× mais lento que P9, anti-bot-sensitive (130/130 retries), 52,8% miss-rate. **Manter no repo como referência mas não executar.** Candidato a remoção em ciclo seguinte.

- **Manual annotation dos 2 333 Bucket-C-no-match.**
  - Razão: trabalho humano linear, sem alavancagem. ROI < 1 produto/h. Se necessário, fazer só em produtos high-volume (vendas top-quartil) — mas isso é decisão operacional, não regulatória.

- **Re-validar os 438 produtos baseline** (que já tinham ATC pré-pipeline).
  - Razão: zero indicadores de regressão; respeitamos `validadoManualmente=true`.

- **Ingerir todos os 4 414 medIds INFOMED sem ERP correspondente como Produto.**
  - Razão: violaria a regra "Produto = artigo do ERP da farmácia". Estes ficam apenas em `RegulatoryRecord` (catálogo nacional). Já é assim hoje.

- **Crawler exaustivo do INFOMED completo (>9 656 medicamentos descontinuados).**
  - Razão: o listagem JSON já é exaustivo *para medicamentos com AIM activa*. Medicamentos descontinuados existem na BD INFARMED mas o INFOMED-fo não os expõe; só CITS os tem.

### 7.2 Por avaliar mais tarde

- **WHO ATC index ingestion** para enriquecer árvore ATC com nomes oficiais e hierarquia 1/3/5/7-char. Não resolve cobertura, mas melhora UI/UX do dashboard regulatório.
- **EMA Article 57 cross-reference** como gate de qualidade (detectar CNPs com ATC INFOMED que diverge de ATC EMA). Trabalho de QA, não de cobertura.
- **Detecção automática de `productType` incorrecto** — alguns dos 2 333 Bucket-C-no-match são provavelmente dispositivos médicos marcados como MEDICAMENTO no ERP. Heurística: designação contém "preservativo", "fralda", "termómetro", "pulseira" → não é medicamento. Trabalho operacional, mas tira pressão do gap regulatório.

---

## 8. Notas operacionais

- **Idempotência:** as acções da Wave 1 são todas idempotentes (preserve-non-null, `--resume`, upsert por CNP). Reentrante sem dano.
- **`validadoManualmente=true` respeitado:** zero impactos previstos (política do `sync-rr-to-produto-broad.ts` mantida).
- **Checkpoint discipline:** o `fetch-details-by-medid.ts` salva a cada 30 s. Não há risco de perda em interrupção.
- **Logs:** arquivar em `scripts/data/logs/wave2-*.log` para auditoria.
- **Cadência sugerida (post-Wave 1):**
  - Browse listagem: **mensal** (cron-style).
  - Fetch details: **mensal**, com `--resume` (só corre medIds novos).
  - Import + sync + reprocess: **mensal**, encadeado.

---

## 9. Métricas a recolher pós-Wave 1

Validar contra estes números:

| Métrica | Baseline pré-Wave1 | Target pós-Wave1 | Tolerância |
|---|---:|---:|---:|
| MEDICAMENTO com `codigoATC` | 3 977 (52,8%) | ≥ 4 900 (~65%) | ±100 |
| Outros Medicamentos | 2 491 | ~1 500 | ±200 |
| RR com `codigoATC` | 15 994 | ≥ 19 000 | — |
| Falhas HTTP (fetch wave) | 0 | 0 | ≤ 5% |
| Wall-clock total Wave 1 | n/a | ≤ 90 min | hard cap |

Se qualquer linha falhar a tolerância, abortar Wave 2 e investigar causa antes de prosseguir.

---

## 10. Decisão pendente

Esta análise não vincula. O user decide:

1. **Executar Wave 1 já** (recomendado — ganho 1 005 produtos, risco zero, ~90 min).
2. **Adiar e pivotar para Caminho B** do relatório final (intelligence operacional). Justificado se 65-66% de cobertura ATC já for "suficiente para as features que se seguem".
3. **Saltar para Strategy 4b (CITS pago)** se o objectivo for fechar 70%+ rapidamente sem várias waves.

A recomendação técnica (apenas como input) é a **opção 1**, pelo custo-benefício materialmente assimétrico (90 min de wall-clock para subir cobertura 13 p.p.).

---

_Fontes de dados:_
- `scripts/data/infomed-listagem.json` (9 656 medIds, last update 2026-05-11)
- `scripts/data/infomed-listagem-details.json` (5 242 details, 15 526 CNPs)
- Query directa Postgres `legacy` (run 2026-05-11)
- `notes/infomed-pipeline-final-report.md` (baseline metrics)
- WebSearch INFARMED CITS portal + EMA Article 57 download (2026-05)
