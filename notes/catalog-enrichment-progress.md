# Catalog Enrichment — Progress Report

**Data:** 2026-05-11
**Pipeline:** INFOMED HTTP-only crawler → RegulatoryRecord → Produto sync → catalog reprocess
**Estado:** validado end-to-end em produção, 0 falhas

## Resultado em uma linha

`6195 → 5805` produtos em "Outros Medicamentos" (**−390 / ~6.3%**), com 393
produtos a ganhar nivel2 clínico real (Sistema Nervoso, Cardiovascular,
Analgésicos, Dermatológicos, Sistema Digestivo, etc.) via mappings INFOMED
extraídos sem Playwright em runtime.

## Métricas globais

| | Valor |
|---|---:|
| Baseline inicial: produtos em "Outros Medicamentos" | **6195** |
| Estado final: produtos em "Outros Medicamentos" | **5805** |
| Redução absoluta | **−390** |
| Redução relativa | **~6.3%** |
| Mappings INFOMED em RegulatoryRecord | **1153** |
| Produtos com 5 campos clínicos populados (codigoATC, dci, formaFarmaceutica, dosagem, embalagem) | **449** |
| Produtos efectivamente reclassificados (saíram de "Outros Medicamentos") | **393** |
| Produtos `validadoManualmente=true` tocados | **0** (preservados por política) |
| Falhas em todo o pipeline | **0** |

## Pipeline executado

```
INFOMED (público)
  │
  ▼ scripts/crawl-infomed-search.ts (HTTP-only, session-reuse, backoff)
  │
  ▼ 1153 mappings (CNP → designacao/dci/codigoATC/forma/dosagem/embalagem/grupoTerapeutico/titularAim/estadoAim)
  │  · 381 direct matches, 772 siblings
  │  · 8h03m crawl overnight
  │
  ▼ scripts/import-mapping-to-regulatory-record.ts
  │  · upsert por CNP com política preserve-non-null
  │  · 7 inserts + 787 updates + 359 unchanged
  │
  ▼ RegulatoryRecord (cache regulatório multi-fonte, 283129 rows totais)
  │
  ▼ scripts/sync-regulatory-to-produto.ts (--apply)
  │  · só copia se Produto.<campo> == null
  │  · nunca sobrescreve
  │  · ignora validadoManualmente=true
  │  · 449 produtos hidratados, 0 falhas
  │
  ▼ Produto.codigoATC / .dci / .formaFarmaceutica / .dosagem / .embalagem
  │
  ▼ scripts/reprocess-catalog.ts --skip-retail --only-with-atc-or-dci
  │  · 1904 processados (PASS 1 + PASS 2 + PASS 3 com filtro)
  │  · 315 reclassificações de nivel2 (98.7% via ATC prefix 3 chars)
  │
  ▼ Produto.classificacaoNivel2Id (Sistema Nervoso, Cardiovascular, ...)
```

## Distribuição final dos 449 produtos sincronizados

| Nivel2 | N | % |
|---|---:|---:|
| Sistema Nervoso | 122 | 27.2% |
| Cardiovascular | 116 | 25.8% |
| Analgésicos e Anti-inflamatórios | 87 | 19.4% |
| Outros Medicamentos (rule gaps) | 48 | 10.7% |
| Sistema Digestivo | 20 | 4.5% |
| Dermatológicos | 18 | 4.0% |
| Urológicos | 9 | 2.0% |
| (sem nivel2 — fora do scope reprocess) | 8 | 1.8% |
| Ginecológicos | 7 | 1.6% |
| Diabetes | 4 | 0.9% |
| Outros Dispositivos Médicos | 3 | 0.7% |
| Constipação, Tosse e Gripe | 3 | 0.7% |
| Respiratório | 2 | 0.4% |
| Alergias | 2 | 0.4% |

## Rule gaps activos

Os 48 produtos que continuam em "Outros Medicamentos" apesar de terem ATC
válido caem em prefixos sem regra no `ATC_PREFIX_TO_NIVEL2`. Não é bug —
é gap de taxonomia.

### Known gaps (by design)

| ATC | N | Categoria clínica |
|---|---:|---|
| J02 | 12 | Antifúngicos sistémicos |
| J01 | 10 | Antibióticos sistémicos |
| H03 | 5 | Hormonas tiróide / antitiroideus |
| J05 | 3 | Antivirais sistémicos |
| A11 | 2 | Vitaminas (forma farmacêutica) |
| M05 | 2 | Bifosfonatos / doenças ósseas |
| N01 | 1 | Anestésicos |

### NEW gaps descobertos neste reprocess

| ATC | N | Categoria clínica |
|---|---:|---|
| **H02** | **10** | **Corticoides sistémicos** (ex: Medrol, Depo-Medrol — Metilprednisolona) |
| **P02** | **3** | **Antiparasitários intestinais** (vermífugos) |

Detalhe completo em [taxonomy-rule-gaps.md](taxonomy-rule-gaps.md).

## Qualidade observada

- **Mapper determinístico:** 98.7% das reclassificações via `atc_prefix`
  (3 chars), alta confiança. 1.3% via `atc_letter` (1 char). Zero via
  DCI/keyword (sinal ATC dominou).
- **Anti-bot domado:** 175 HTTP 503 totais ao longo de ~10h cumulativos
  de crawl, **todos recuperados** via backoff exponencial [10s, 30s, 90s].
  Zero falhas finais.
- **Preserve-non-null funcional:** designacao/titular/estado do CEDIME-ANF
  preservados; apenas os 6 campos clínicos (que estavam sempre a null)
  foram populados pelos dados INFOMED.
- **Match-rate:** 18.6% cumulativo (1153 mapped / 6183 searched). Cada
  match traz em média 3 siblings, amplificando cobertura.

## Decisões arquitecturais

1. **HTTP-only sem Playwright em runtime.** Reverse-engineered o JSF/PrimeFaces
   do INFOMED em 5 passos (index ViewState → submit lupa → pesquisa-avancada
   → click row → detail page). Playwright só foi usado one-shot para
   investigação inicial.
2. **Session reuse + backoff exponencial.** Anti-bot do INFOMED dispara
   ~80 sessões frescas em 5min; mantemos 30 searches/session com cooldown
   30s e backoff em 503.
3. **RegulatoryRecord como cache regulatório multi-fonte.** Tabela única
   indexada por CNP, source-tagged, upsert com preserve-non-null. Permite
   ingerir CEDIME-ANF + INFOMED + futuras fontes sem race ou perda.
4. **Sync surgical Produto.<campo>.** Em vez de refactor do `loadSnapshot`,
   uma sync one-off espelha RegulatoryRecord → Produto onde campos estão
   null. Reversível, idempotente. (Refactor para dual-read continua como
   opção arquitectural — ver "Próximos passos".)

## Próximos passos recomendados (não executar sem aprovação)

1. **Continuar acquisition** — uma nova ronda do crawler com
   `--retry-not-found` pode capturar mais matches conforme melhoramos
   `normalizeForSearch`. Os 5779 not_found são o maior poço de
   oportunidade (3.2× mais que mappings actuais).
2. **Melhorar taxonomia** para anti-infecciosos sistémicos (J01/J02/J05)
   e corticoides sistémicos (H02). Implica nivel2 dedicado em
   `lib/catalog-taxonomy.ts` + entrada em `ATC_PREFIX_TO_NIVEL2`. Pode
   converter ~30 dos 48 rule-gaps para nivel2 real.
3. **Decisão arquitectural sobre `loadSnapshot`** — passar a dual-read
   `RegulatoryRecord` directamente eliminaria a sync intermediária e
   evitaria o gap "novos mappings invisíveis até nova sync". Trade-off:
   query mais cara em reprocess vs simplicidade operacional.
4. **Imagens** — `--skip-retail` desligou enriquecimento de imagens
   neste pipeline. Próxima fase pode adicionar fonte de imagens (INFARMED
   detail page tem imagens de embalagens) sem perturbar classificação.
5. **Quality report final do catálogo** — uma vez fechados os rule-gaps,
   calcular coverage por categoria, validadoManualmente vs auto, e
   produzir snapshot que se compare em runs futuros.

## Artefactos relevantes

- Logs de execução: [scripts/data/logs/](../scripts/data/logs/)
- Mapping staging: [scripts/data/infomed-cnp-medguid-mapping.json](../scripts/data/infomed-cnp-medguid-mapping.json)
- Crawler: [scripts/crawl-infomed-search.ts](../scripts/crawl-infomed-search.ts)
- Resolver HTTP: [lib/regulatory-sources/infomed-search-resolver.ts](../lib/regulatory-sources/infomed-search-resolver.ts)
- Importer: [scripts/import-mapping-to-regulatory-record.ts](../scripts/import-mapping-to-regulatory-record.ts)
- Sync: [scripts/sync-regulatory-to-produto.ts](../scripts/sync-regulatory-to-produto.ts)
- Reprocess: [scripts/reprocess-catalog.ts](../scripts/reprocess-catalog.ts)
- Taxonomia: [lib/catalog-taxonomy-map.ts](../lib/catalog-taxonomy-map.ts)
- Rule gaps: [taxonomy-rule-gaps.md](taxonomy-rule-gaps.md)
- Investigação INFOMED: [infomed-investigation.md](infomed-investigation.md)
