# P9 Spike — `pesquisa-avancada.xhtml` investigation

**Data:** 2026-05-11
**Fase:** investigação apenas (zero writes, zero crawler massivo)
**Veredito:** **P9 VIABLE — Cenário C CONFIRMADO via spike v4 (~30× speedup expectável)**

## Achados-chave (1-linha)

1. **9656 medicamentos** acessíveis via listagem completa do INFOMED (autorizado + comercializado, defaults do form)
2. **Cada row da listagem JÁ contém 6 campos clínicos** (nome, DCI, forma, dosagem, titular, estado) — não precisamos detail-page para esses
3. **`codigoATC`, `embalagem`, `CNPs` NÃO estão na listagem** — continuam a requerer click-row + detail page
4. **Pagination funciona** server-side, default 10 rows/page (rppDD aparentemente capado a 10)
5. **Form aceita filtros simples** para titular (text) — útil para crawl por fabricante
6. **ATC filter é autocomplete** — requer selecionar sugestão do dropdown (não filtra só por digitar texto)
7. **Reproduzível HTTP-only** — capturámos formato exacto do POST (`javax.faces.partial.ajax=true`)

## Endpoint capturado

```
URL:     POST https://extranet.infarmed.pt/INFOMED-fo/pesquisa-avancada.xhtml
Headers: Cookie: JSESSIONID=<sessao bootstrapada via GET>
         Faces-Request: partial/ajax
         X-Requested-With: XMLHttpRequest
         Content-Type: application/x-www-form-urlencoded
Form data:
  javax.faces.ViewState        = <obtido via GET pesquisa-avancada.xhtml>
  javax.faces.partial.ajax     = true
  javax.faces.partial.execute  = mainForm:pnlCriterios mainForm:btnDoSearch
  javax.faces.partial.render   = messages minLenghtMessage mainForm:dt-medicamentos ...
  javax.faces.source           = mainForm:btnDoSearch
  mainForm                     = mainForm
  mainForm:btnDoSearch         = mainForm:btnDoSearch
  mainForm:dt-medicamentos_rppDD = 10
  mainForm:estado-aim_input    = REF_EST_AIM:001         ← default "Autorizado"
  mainForm:estado-comercializacao_input = REF_EST_COMERC:001  ← default "Comercializado"
  mainForm:taim_input          = "Bayer"                  ← se filtrar por titular
```

Response: `partial-response` XML com `<update id="mainForm:dt-medicamentos">` contendo o HTML completo da datatable (10 rows + paginator updated).

## Schema de cada row da listagem

| # | Coluna | Conteúdo |
|---|---|---|
| 0 | MED ID | 37119 (id interno INFARMED, **não** med_guid) |
| 1 | Nome | "Aspirina Direkt" |
| 2 | DCI | "Ácido acetilsalicílico" |
| 3 | Forma | "Granulado" |
| 4 | Dosagem | "500 mg" |
| 5 | Titular | "Bayer Portugal, Lda." |
| 6 | Comercialização | (icon) |
| 7 | Estado AIM | "1" (=Autorizado) |
| 8 | Documentos | (icon) |

**Faltam:** `codigoATC`, `grupoTerapeutico`, `embalagem`, `CNPs` (lista de Códigos Nacionais por embalagem) — só disponíveis no detail page.

## Row link / resolução de med_guid

Cada nome de medicamento é um `PrimeFaces.ab(...)` remote command, **não** uma URL com med_guid:

```html
<a id="mainForm:dt-medicamentos:0:linkNome" href="#"
   onclick='PrimeFaces.ab({s:"mainForm:dt-medicamentos:0:linkNome",f:"mainForm",p:"mainForm:dt-medicamentos:0:linkNome"});return false;'>
  Aspirina Direkt
</a>
```

Click → POST partial-ajax → server actualiza session → GET `detalhes-medicamento.xhtml` (sem query string) usa session state.
**Mesmo fluxo que o nosso resolver actual** — não há atalho na URL.

**Hipótese a testar:** será que `detalhes-medicamento.xhtml?med_id=37119` funciona directamente? Se sim, dispensamos o click + session-state. **Não testado nesta spike** — vale a pena follow-up de ~15min.

## Pagination

- Default: 10 rows / page
- Total: até 9656 medicamentos = **966 pages**
- Paginator é PrimeFaces partial-ajax: click no `.ui-paginator-next` → POST com `mainForm:dt-medicamentos_first=N` ou similar
- `rppDD` capado a 10 visível inicialmente (provavelmente fixo)
- Cada page-fetch é **~1 POST** (~500ms-1s)

## Throughput projectado

### Cenário A — paginação completa da listagem

```
966 pages × ~1s/page = ~16 minutos para enumerar 9656 medicamentos
```

Output: dataset com `{MED_ID, nome, DCI, forma, dosagem, titular, estado}` × 9656.

**Ganho relativo ao approach search-by-CNP actual:**
- Hoje: 9.4 CNP/min × 6183 CNPs = 11h para cobrir 6.5% match rate
- Pagination: **~16 min para cobrir 100% do universo INFOMED, em dataset estruturado**
- Speedup: **~40× wall-clock**, ~250× requisições

### Cenário B — detail page para subset cruzado com ERP

Após Cenário A:
1. Cross-match `nome + DCI` da listagem ↔ produtos do ERP em "Outros Medicamentos" (5805)
2. Match rate esperado: 30–60% (medicamentos hospitalares e oncológicos do INFOMED não estão no ERP de retalho)
3. Subset a buscar detail: ~2000–3500 medicamentos
4. Detail page (click-per-row + GET detail): ~1.5s/produto
5. Total: **~50–90 min**

**Total Cenário A + B:** ~1.2–2h para ATC/embalagens/CNPs de todos os produtos relevantes.

### Cenário C (otimista) — se `detalhes-medicamento.xhtml?med_id=X` funcionar

Bypass do click + session state:
1. Listagem completa: 16 min
2. GET por MED_ID: paralelizável, ~300ms cada × 3500 = **~17 min**

**Total Cenário C:** **~35 min** para o universo todo. **Decisivo se confirmado** — vale ~15 min de follow-up.

## Risco anti-bot

- Pagination: ~1 POST/s sustentado. Padrão similar a uso humano (paginar resultados). **Risco baixo.**
- Detail clicks: mesmo padrão que o crawler actual (~2-3s entre clicks). **Risco igual ao actual.**
- Total POSTs num run completo de Cenário A+B: ~5000. Distribuídos por ~2h. Provavelmente OK com 1-2 sessões e backoff.
- Estratégia conservadora: rate-limit ~500ms entre pagination requests, ~1500ms entre detail clicks (igual ao actual).

## Comparação directa com fase actual

| Aspecto | Search-by-CNP (actual) | Browse-pagination (P9) |
|---|---|---|
| Wall-clock para enumeração total | ~11h | **~16 min** |
| Yield (mappings por unit-time) | 9.4 CNP/min, 18.6% mapping yield | 600 medicamentos/min via listagem |
| Cobertura | 6.5% direct match × 3× siblings = 19% | **100% do universo INFOMED** |
| Anti-bot pressão | 130 503/run de 8h | provável ~10-30 503/run de 2h |
| Detail page requests | proporcional a matches | proporcional a cross-match com ERP |
| Cross-runs cache utility | alto (P1+P5) | médio (dataset é estável) |

## Recomendação final

**P9 é VIABLE e VENCEDORA.** A estratégia híbrida `pagination + detail-by-MED_ID` deve substituir o approach search-by-CNP como caminho primário.

### Próximos passos propostos (não executar agora)

1. **Spike v4 — 15 min** (último para fechar a investigação):
   - Confirmar se `detalhes-medicamento.xhtml?med_id=37119` funciona directamente (Cenário C)
   - Confirmar se rppDD pode ir acima de 10 (talvez 25 ou 50 hidden)
   - Capturar o exact POST de pagination (page 2, page 3)

2. **Implementação Fase 1 — 1-2 dias:**
   - `scripts/browse-infomed-listagem.ts` — paginação completa + extracção de listagem
   - Output: `scripts/data/infomed-listagem-full.json` (~9656 entries)
   - Tempo de execução: **~16 min**

3. **Implementação Fase 2 — 1-2 dias:**
   - Cross-match listagem ↔ Produto ERP
   - Identificar subset cross-matched que precisa de detail (ATC/CNP)
   - `scripts/fetch-details-by-medid.ts` (Cenário C) ou `click-and-fetch.ts` (Cenário B)
   - Tempo de execução: ~30–90 min

4. **Substituição do search-by-CNP** como caminho primário; manter como fallback para CNPs que não cruzam.

5. **Re-avaliar P1-P8 do design original** — muitos itens (P2, P4, P7, P8) deixam de ser bottleneck crítico:
   - P1 cache continua relevante (cache de MED_ID → detail)
   - P5 DB intelligence continua relevante (cross-run state)
   - P3 multi-stage continua relevante (separar pagination/detail/import)
   - P2 session aggressive: marginal (pagination usa 1 session por horas)
   - P7 adaptive: marginal (rate é constante e baixo)
   - P8 parallelism: marginal (16 min sequencial é OK)

### Esforço total

- Spike v4: 15 min
- Implementação: 2-4 dias
- Throughput target inicial: **8000+ mappings em 2h** (vs 1153 em 11h hoje)

## Decisão pendente

Aprovas:
1. **Spike v4 (~15 min, Playwright)** para confirmar Cenário C (`?med_id=` direct)?
2. Caso confirmado, avançar para implementação Fase 1 + Fase 2?

Ou queres avaliar este relatório primeiro e só depois decidir o spike v4?

---

## ADENDUM v4 — confirmações decisivas (2026-05-11)

Spike v4 testou as duas alavancas que poderiam mudar throughput.

### 1. `detalhes-medicamento.xhtml?med_id=X` — **CONFIRMADO ✅**

10 MED_IDs distintos extraídos da listagem Bayer (37119 Aspirina Direkt,
29131 Aspirina GR, 593221 Aspirina Xpress, 55377 Aspirina Xpress, 32695
Migraspirina, 641 Aspirina C, 631342 Aspirina Complex, 38503 Primovist,
716764 Beyonttra, 714625 Eylea).

Resultados:

| param | status | bytes | nome extraído |
|---|---:|---:|---|
| `?med_id=37119` | 200 | 81147 | Aspirina Direkt ✓ |
| `?med_id=29131` | 200 | 114999 | Aspirina GR 100mg ✓ |
| `?med_id=593221` | 200 | 185145 | Aspirina Xpress ✓ |
| ... (10/10 sucessos) | 200 | 80-350kb | ✓ |
| `?id=`, `?med_guid=` (numeric), `?guid=`, `?medId=`, `?MED_ID=` | 200 | 21kb | ✗ (não funciona) |

**Conclusão:** `?med_id=<numeric>` é o parâmetro que funciona. Resposta é
o detail page completo (mesmo formato que `?med_guid=<UUID>`). **Bypass
total do click-per-row.**

**Implicação:** elimina o ponto mais caro da fase de detail. Cada
medicamento é agora **1 GET** sem fluxo de session-state.

### 2. `rppDD` (rows per page) — **NÃO escalável ❌**

- Após submit, `mainForm:dt-medicamentos_rppDD` não existe no DOM (`exists: false`)
- Forçar via `<select>.value = 25/50/100` + `change` event não tem efeito
- Server devolve sempre 10 rows independentemente do hint
- **Pagination está fixa em 10 rows/page server-side**

### Throughput projectado revisto (Cenário C confirmado)

**Fase 1 — Pagination listagem completa:**
- 966 POSTs × ~500ms-1s = **~8-16 min** para enumerar 9656 medicamentos
- Output: `{MED_ID, nome, DCI, forma, dosagem, titular, estado}` × 9656

**Fase 2 — Detail GETs por MED_ID:**
- 9656 GETs × ~300ms single-threaded = **~50 min** para todos
- Com cross-match filter (só ERP-relevantes): ~3000–5000 detail GETs = **~15-25 min**
- Detail page **não filtrada por anti-bot** → 3-5 workers paralelos: **~5-10 min**

**Total realista para fechar enriquecimento clínico do ERP:**

| Estratégia | Tempo total |
|---|---|
| Single-threaded, ERP subset | **30–45 min** |
| Parallel detail (3-5 workers) | **15–25 min** |
| Full universo INFOMED single-threaded | **~1h** |

**Speedup vs crawler actual:** **~20-30×**

### Verdict final v4

✅ **P9 é caminho primário aprovado tecnicamente.**

Implementação fica como:

1. **`scripts/browse-infomed-listagem.ts`** — Fase 1, output JSON staging com 9656 entries
2. **`scripts/fetch-details-by-medid.ts`** — Fase 2, paraleliza GETs por MED_ID (sem session-state)
3. **`scripts/import-listagem-to-regulatory.ts`** — UPSERT no RegulatoryRecord usando o cruzamento listagem×detail
4. **`scripts/sync-regulatory-to-produto.ts`** + **`reprocess-catalog.ts`** — já existem, só correm depois

Search-by-CNP existente (`crawl-infomed-search.ts`) fica como **fallback** apenas para CNPs que não cruzem com a listagem (raros — INFOMED tem cobertura quase total dos medicamentos comercializados).

### Artefactos v4

`scripts/data/spike-pesquisa-avancada-v4/`:
- `direct-get-results.json` — matriz de testes param×medId
- `detail-med_id-37119.html` ... — body HTML de cada response (60kb excerpt cada)
- `rows-with-attrs.json` — 10 rows com todos os data-* attrs (zero med_guid hints)
- `rpp-results.json` — confirmação que rppDD não escala
- `click-captures.json` — POSTs PrimeFaces.ab capturados (zero med_guid no payload)

---

_Spike v1-v4 completa. Pronto para Fase 1 implementation quando aprovares._
