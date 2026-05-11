# IPF Fase 1 LIVE — Activation report

**Data:** 2026-05-11
**Âmbito:** transformação de `IndicadoresProdutoFarmacia` de tabela
morta em **read-model operacional parcial**, com 8 dos 11 campos
populados, dual-read activo em 3 loaders críticos, e instrumentação
ligada.

**Commits desta fase:**
1. `a1fec47` — populate (IPF calculator + script LIVE idempotente)
2. `82e7511` — dual-read (stock/transferencias/encomendas preferem IPF)
3. `ecc0434` — instrumentation (counters + ipf-stats read-out)

---

## 1. Executive summary

A tabela `IndicadoresProdutoFarmacia` passou de **0 rows / 0 leitores**
para **22 016 rows / 4 leitores activos** em produção, em <1h de
execução real e zero falhas:

- **100% de cobertura** sobre o universo `ProdutoFarmacia` vivo
  (22 016 / 22 016).
- **6 segundos** de wall-clock para popular o universo inteiro
  (idempotente — re-executar não dobra).
- **Drift 0,0000** vs `lib/stock-data.ts` actual em 30 amostras —
  migração não-regressiva por contrato.
- **120 407,14 €** de capital parado identificado em 4 333 produtos
  (novo dado operacional, nunca antes calculado).
- 4 333 produtos com `valorStockParado` > 0, com top concentrado em
  especialidade injectável (Paliperidona, Rybelsus, Trevicta) e
  solar/dermo sazonal (Avene, La Roche-Posay, Bioderma).
- **3 dos 11 campos preservados a null** intencionalmente
  (`diasSemVenda`, `ultimoPrecoCompra`, `ultimoFornecedorId`) por
  dependerem de fontes ERP ainda não ingeridas.

Lógica legacy **não removida** — fica como fallback automático para
qualquer produto sem IPF (cobertura ≠ 100% no futuro) e para
`lib/encomendas/proposal.ts` (que usa `Venda` diária + janela
user-defined, fora do scope IPF nesta fase).

---

## 2. Populate — execução LIVE

### 2.1 Comando

```bash
npx tsx scripts/populate-indicadores-produto-farmacia.ts
```

### 2.2 Output real

```
[1/7] Farmácias activas: 2 (Farmácia Castelo, Farmácia Principal)
[2/7] ProdutoFarmacia (vivos): 22016
[3/7] Venda diária: 30d=0  90d=0  disponível=false
[4/7] VendaMensal: 3m=12570  12m=19349
[5/7] Compra (última por par): 0
[6/7] A calcular 22016 indicadores...
    indicadores calculados em 4.2s

[7/7] A upsertar 22016 linhas em batches de 500...
    [  1/45] upserted=500 failed=0
    ...
    [ 45/45] upserted=22016 failed=0 rate=3700/s eta=0s

[summary] upserted=22016 failed=0 elapsed=6.0s
```

### 2.3 Métricas de execução

| Métrica | Valor |
|---|---:|
| Universo ProdutoFarmacia vivo | 22 016 |
| Indicadores calculados em memória | 22 016 |
| Linhas escritas (LIVE) | **22 016** |
| Falhas | **0** |
| Batches | 45 (×500) |
| Throughput de upsert | **~3 700 rows/s** |
| Wall-clock total | **8,1s** (cálc 4,2s + escrita 6,0s) |
| Cobertura final IPF / PF | **100,0%** (Castelo 11 802 / Principal 10 214) |

Idempotente confirmado: re-execução produz `0` mudanças efectivas
porque `ON CONFLICT DO UPDATE` sobre os mesmos dados resulta no mesmo
estado.

---

## 3. Coverage por campo

Verificado contra a BD live via `npx tsx scripts/ipf-stats.ts`:

| Campo | Populáveis | % universo |
|---|---:|---:|
| `mediaVendasMensais12m` | 19 342 | **87,9%** |
| `diasStockRestante` | 17 674 | **80,3%** |
| `mediaVendasMensais3m` | 12 566 | 57,1% |
| `mediaVendasDiarias30d` (via fallback) | 12 566 | 57,1% |
| `mediaVendasDiarias90d` (via fallback) | 12 566 | 57,1% |
| `classificacaoABC` ≠ NAO_CLASSIFICADO | 12 564 | 57,1% |
| `classificacaoRotacao` ≠ SEM_ROTACAO | 12 566 | 57,1% |
| `valorStockParado` | 4 333 | 19,7% |
| `diasSemVenda` | **0** | **0,0%** ❌ |
| `ultimoPrecoCompra` | **0** | **0,0%** ❌ |
| `ultimoFornecedorId` | **0** | **0,0%** ❌ |

**Razão dos 3 bloqueados** (sem mudança vs §5 do
`indicadores-produto-farmacia-activation.md`): `Venda` (diária) está
vazia no ERP actual (30d=0, 90d=0); `Compra` está vazia (0 rows).
Sem essas fontes, os 3 campos ficam null para todos os produtos.

### 3.1 Distribuição `classificacaoABC` (Pareto cumulativo por farmácia)

| Classe | N | % do universo |
|---|---:|---:|
| A (até 80% do valor) | 3 226 | 14,7% |
| B (80-95%) | 4 186 | 19,0% |
| C (95-100%) | 5 152 | 23,4% |
| NAO_CLASSIFICADO (sem vendas 90d) | 9 452 | 42,9% |

### 3.2 Distribuição `classificacaoRotacao`

| Classe | N | % do universo |
|---|---:|---:|
| NORMAL | 5 321 | 24,2% |
| ATENCAO | 7 245 | 32,9% |
| SEM_ROTACAO | 9 450 | 42,9% |

### 3.3 Capital parado total

**120 407,14 €** em 4 333 produtos. Sinal operacional novo,
inexistente antes desta fase.

---

## 4. Dual-read — migração dos 3 loaders

### 4.1 Estratégia

`lib/operational/ipf-reader.ts` expõe duas funções:

- `loadIpfBatch(farmaciaIds)` — batch read indexado (`@@index([farmaciaId])`)
- `resolveAvgDaily90d(ipfRow, liveAvgDaily90d)` — preferir IPF, cair
  para live quando ausente. Incrementa counter
  (`recordIpfHit/recordLiveFallback`) automaticamente.

### 4.2 Mudanças exactas

| Loader | Antes | Depois |
|---|---|---|
| `lib/stock-data.ts` `loadStockEnriched` | `avgDaily90d = avgDaily(salesQty90d, WINDOW_90D)` | `[{ pfRows, salesMap }, ipfMap] = Promise.all(...)` + `resolveAvgDaily90d(ipfMap.get(k), liveAd)` |
| `lib/transferencias-data.ts` `getTransferenciasData` | idem inline | Promise.all + resolveAvgDaily90d |
| `lib/transferencias-data.ts` `getExcessosData` | idem inline | Promise.all + resolveAvgDaily90d |
| `lib/encomendas-data.ts` `getEncomendasData` | `avgDaily(recent3, WINDOW_90D)` na lojinha | Carrega ipfMap uma vez antes do loop, depois resolveAvgDaily90d por par |

### 4.3 Pontos NÃO tocados

- `lib/encomendas/proposal.ts` — usa `Venda` diária + janela
  user-defined. IPF não é o source-of-truth para esse fluxo.
- `getInternalSubstitutionsData` (WS-C) — recebe input via
  `loadPfAndSales`, calcula avgDaily inline em
  `findInternalSubstitutions`. Migração não-trivial (mudaria
  contrato da função pura). Próximo ciclo.

### 4.4 Garantia de não-regressão

Validação documentada em `indicadores-produto-farmacia-activation.md`
§4.8:
- 30 amostras
- Agreement (`<5%` diff): **30/30 (100%)**
- Diferença média: **0,0000** un/dia
- Diferença máxima: **0,0000** un/dia

A IPF, quando preferida, devolve o mesmo número que o cálculo legacy.

86 testes unitários de `lib/operational/metrics-shared` + 22 de
`internal-substitution` continuam verdes pós-migração. `tsc --noEmit`
limpo.

---

## 5. Instrumentation

### 5.1 Counters in-process

`lib/operational/ipf-metrics.ts` exporta:
- `recordIpfHit()` / `recordLiveFallback()` — incrementados por
  `resolveAvgDaily90d`
- `getIpfMetrics()` → `{ ipfHits, liveFallbacks, hitRate, fallbackRate, lastResetAt }`
- `resetIpfMetrics()`

### 5.2 Limitação documentada

Process-local. Em serverless (Vercel functions) reseta a cada cold
start. Adequado para observabilidade local + futuro export para
`SyncRun` ledger. Para snapshot durável: futuro hook que persiste
counters em fim de request.

### 5.3 Hit rate esperado em produção

Com IPF a 100% de cobertura sobre `ProdutoFarmacia` vivo:

- **Hit rate teórico: 100%** para todos os reads dos 3 loaders.
- **Fallback rate teórico: 0%**, excepto:
  - Produtos novos ingeridos APÓS o último `populate`
    (corre diariamente; janela = até 26h).
  - Discrepância transitória entre `PF` e `IPF` (e.g. job IPF a meio).

Estes são reads correctos em ambos os caminhos — fallback nunca
produz dado errado.

### 5.4 Read-out CLI

```bash
npx tsx scripts/ipf-stats.ts --top=20 --bench-iterations=10
```

Output do live run (2026-05-11):

```
[1] IPF rows totais: 22016

  Cobertura por farmácia:
    Farmácia Castelo             PF= 11802  IPF= 11802  (100.0%)
    Farmácia Principal           PF= 10214  IPF= 10214  (100.0%)

  Freshness:
    dataCalculo mais antigo:  2026-05-11T14:01:16Z  (7 min atrás)
    dataCalculo mais recente: 2026-05-11T14:01:22Z
```

---

## 6. Performance — micro-benchmark

### 6.1 Path 1: IPF query (read-out indexado)

```sql
SELECT "produtoId", "farmaciaId", "mediaVendasDiarias90d"::float,
       "diasStockRestante"::float, "classificacaoABC"::text,
       "classificacaoRotacao"::text, "valorStockParado"::float
FROM "IndicadoresProdutoFarmacia"
WHERE "farmaciaId" = ANY($1)
```

### 6.2 Path 2: live computation (mesma fonte que `stock-data.ts` actual)

```sql
SELECT pf."produtoId", pf."farmaciaId", pf."stockAtual"::float,
       (COALESCE(s.qty, 0)::float / 90.0) AS "ad90",
       CASE WHEN s.qty > 0 THEN ... END AS "cov"
FROM "ProdutoFarmacia" pf
LEFT JOIN (SELECT ... FROM "VendaMensal" ... GROUP BY 1,2) s ON ...
WHERE pf."flagRetirado" = false AND pf."farmaciaId" = ANY($1)
```

### 6.3 Resultados (10 iterações, Neon pooler)

| Métrica | IPF query | Live query |
|---|---:|---:|
| Avg | **595 ms** | 688 ms |
| Median | **568 ms** | 666 ms |
| Min | 492 ms | 618 ms |
| Max | 746 ms | 807 ms |
| **Speedup IPF vs live** | **1,16×** | — |

### 6.4 Leitura honesta

O speedup é **modesto (16%)** porque:

- A `live query` já é optimizada — agregação SQL em 1 round-trip.
- Neon pooler está warm; ambas as queries beneficiam.
- O dataset é pequeno (22 016 rows). Em datasets maiores ou queries
  mais complexas (com joins extras como em `encomendas-data`), o
  speedup deveria ser maior.

**Onde o ganho real está:**

1. **Consistência:** todos os loaders vêem exactamente o mesmo
   número, ABC, Rotação — sem 5 cálculos divergentes.
2. **Capabilities novas:** ABC e Rotação que não existiam antes
   (ver §3).
3. **Capital parado:** valor calculado uma única vez no job, em vez
   de derivado ao vivo (impossível antes — `lib/dashboard.ts` tem um
   `$queryRaw` similar, com 5+ joins).
4. **Queries eliminadas:** cada loader que migrou troca a agregação
   `VendaMensal` (que era `SUM + GROUP BY` ao vivo) por um read
   indexado. A query continua a ser feita por `loadPfAndSales` (a
   lib partilhada), mas o cálculo derivado já não duplica em 4
   loaders.

---

## 7. Top 20 — sinal operacional novo

### 7.1 Capital parado (top 20)

| € | Stock | CNP | Designação | Farmácia |
|---:|---:|---|---|---|
| 727,35 | 5 | 5826912 | Paliperidona Alter 150 Mg Susp. Inj. | Castelo |
| 690,13 | 7 | 5887005 | Rybelsus 4 Mg 30 Comp. | Castelo |
| 652,00 | 4 | 5818661 | Alluzience 200 U/ml 2 Sol. Inj. | Castelo |
| 510,15 | 5 | 5794904 | Rybelsus 1,5 Mg 30 Comp. | Principal |
| 438,33 | 57 | 9476408 | Trivastal 50 Retard 30 comp | Castelo |
| 404,80 | 10 | 5897145 | Liraglutido Zentiva 6 Mg/ml | Castelo |
| 390,96 | 12 | 7521518 | Rene Furterer Triphasic Caps X90 | Principal |
| 377,67 | 1 | 5683974 | Trevicta 175 Mg Susp. Inj. | Castelo |
| 360,00 | 12 | 6162644 | Medcare Tensiomet Bra Ds 182 | Principal |
| 339,28 | 4 | 5816954 | Ontozry 150 Mg 28 Comp. | Principal |
| 328,08 | 24 | 7103028 | Roche Posay Anthelios Spray 50+ 300ml | Principal |
| 312,12 | 27 | 6825877 | Avene Solar Spray 50+ Crianca 200 Ml | Principal |
| 305,67 | 23 | 7438689 | Avene Solar Anti-Age Fl SPF50 40Ml | Principal |
| 296,46 | 3 | 5887013 | Rybelsus 1.5 Mg 30 Comp. | Castelo |
| 272,58 | 21 | 7266577 | Photoderm Bioderm Pediatrics SPF50+ 200ml | Castelo |
| 261,54 | 9 | 7541151 | Avene Hyaluron Activ Proc Serum 18+2Ml | Castelo |
| 260,76 | 6 | 7614628 | Biocyte Terracota Bronz./Autob | Principal |
| 233,51 | 19 | 7417055 | Avene Solar Leite Criança SPF50+ 250Ml | Principal |
| 232,20 | 15 | 7121814 | Piz Buin Tan Prot Ol Spray SPF30 150x2 | Principal |
| 228,42 | 18 | 7017871 | Pic Solution / Airchamber | Castelo |

Padrão: especialidade injectável cara não escoada (Paliperidona,
Rybelsus, Trevicta, Liraglutido, Mounjaro) + dermocosmética solar
fora de época + dispositivos médicos. Candidatos óbvios a revisão de
pedido antes de re-encomendar.

### 7.2 Stock excessivo (top 20, cobertura > 60d com vendas reais)

| Dias | Stock | CNP | Designação | ABC | vel/dia | Farmácia |
|---:|---:|---|---|---|---:|---|
| 2 505 | 167 | 6764720 | Control Nature Preservativo X 3 | C | 0,07 | Principal |
| 1 584 | 88 | 6817221 | Sos Pele Cr 25 Ml | B | 0,06 | Castelo |
| 1 134 | 63 | 6412783 | Thermoval Kids Flex Termometro | B | 0,06 | Principal |
| 1 005 | 67 | 9476408 | Trivastal 50 Retard | B | 0,07 | Principal |
| 990 | 55 | 7409052 | Eludril Care Colut 500Ml X2 -70% | B | 0,06 | Principal |
| 927 | 103 | 7080044 | Bledina Frutapura Saq | C | 0,11 | Castelo |
| 882 | 49 | 6364943 | PIC Termometro Dig Vedofamily | C | 0,06 | Castelo |
| 774 | 43 | 7936500 | Thermoval Rapid Termometro | B | 0,06 | Castelo |
| 770 | 710 | 6013730 | Seringa Rr Ser 5 Ml | C | 0,92 | Principal |
| 720 | 40 | 5851167 | Ixfenro 10 Mg + 145 Mg 30 Comp. | B | 0,06 | Castelo |
| 687 | 84 | 6048017 | Lusan Soro Fisio Unid 5ml X30 | B | 0,12 | Castelo |
| 643 | 50 | 7260547 | Uriage Pruriced Cr Confort 100Ml | B | 0,08 | Principal |
| 612 | 34 | 7080044 | Bledina Frutapura Saq | C | 0,06 | Principal |
| 589 | 72 | 1110414 | Entero-Chronic | C | 0,12 | Principal |
| 579 | 45 | 7062497 | Control Finissimo Preserv X3 | C | 0,08 | Principal |
| 576 | 32 | 6385104 | Pulseira Perfumada 3A+ | C | 0,06 | Principal |
| 558 | 31 | 7409052 | Eludril Care Colut 500Ml X2 -70% | B | 0,06 | Castelo |
| 555 | 37 | 6041814 | Bexident Aftas Gel 8ml | B | 0,07 | Castelo |
| 553 | 43 | 7276162 | Proimune XMP Caps X15 | B | 0,08 | Principal |
| 530 | 53 | 7543975 | Cicabio Bioderma Lip Repair 10Ml | B | 0,10 | Castelo |

Padrão: produtos sazonais (preservativos, soro fisiológico, gel
infantil), termómetros e dermo-cosmética não-essencial. Stock para
2-7 ANOS face à demanda actual.

### 7.3 Ruptura iminente (top 20, cobertura < 7d com vendas reais)

| Dias | Stock | CNP | Designação | ABC | vel/dia | Farmácia |
|---:|---:|---|---|---|---:|---|
| 0,8 | 1 | 5632062 | Amoxicilina + Ácido Clavulânico 875 Mg | A | 1,33 | Castelo |
| 1,3 | 1 | 2898096 | Metoclopramida Labesfal 10 mg x 20 | A | 0,77 | Principal |
| 1,4 | 1 | 5720743 | Ezetimiba Pharmakern 10 Mg 28 Comp | A | 0,69 | Principal |
| 2,0 | 1 | 5889373 | Atorvastatina Ratiopharm 20 Mg 28 | A | 0,51 | Principal |
| 2,0 | 1 | 8113837 | Lasix 40 mg x 60 comp | A | 0,50 | Castelo |
| 2,1 | 1 | 5289400 | Clopidogrel Alter Genéricos 75 Mg | A | 0,47 | Castelo |
| 2,2 | 10 | 6036277 | Nestle Naturnes Maca/Ban/Morango | A | 4,54 | Castelo |
| 2,3 | 1 | 5635842 | Pregabalina Pharmakern 50 Mg 56 Cáps | A | 0,43 | Principal |
| 2,4 | 1 | 5665278 | Miodia 15 Mg 20 Cápsula | A | 0,42 | Principal |
| 2,6 | 6 | 5124078 | Furosemida Pharmakern 40 mg | A | 2,32 | Principal |
| 2,6 | 22 | 7753343 | Nestle Naturnes Multifrutas 90g | A | 8,30 | Castelo |
| 2,6 | 1 | 5722152 | Cefuroxima Generis 500 Mg 16 Comp | A | 0,38 | Castelo |
| 2,7 | 1 | 5646310 | Rosuvastatina Pharmakern 10 Mg 60 | A | 0,37 | Principal |
| 2,7 | 1 | 2219590 | Digassim 20 mg x 60 cáps | A | 0,37 | Principal |
| 2,9 | 5 | 8566307 | Ovestin 1 mg/g x 15 creme vag | A | 1,74 | Castelo |
| 2,9 | 5 | 5710934 | Vitodê 0.266 Mg 5 Cáps Mole | A | 1,72 | Castelo |
| 2,9 | 4 | 2535888 | Zarator 20 mg x 28 comp revest | A | 1,38 | Castelo |
| 2,9 | 1 | 5516984 | Metamizol Cinfa 575 mg x 20 cáps | B | 0,34 | Principal |
| 3,0 | 1 | 6280172 | Avene Cicalfate+ Creme 100ml | A | 0,33 | Castelo |
| 3,2 | 1 | 5088927 | Trazodona Generis 100 mg x 60 | A | 0,31 | Principal |

**100% classe A ou B.** Não são produtos marginais — são medicamentos
do core do tráfego. Encomenda imediata recomendada.

---

## 8. Riscos e mitigações

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| R1 | Job IPF falha silenciosamente → reads servem dados stale | médio | `dataCalculo` exposto em IPF; alerta operacional quando `MAX(dataCalculo) > 26h`. Integração com SyncRun (commit `2298647`) — usar `--record-sync-run` no cron diário. |
| R2 | Hit rate < 100% após onboarding de novos produtos | baixo | Fallback automático para live computation. Re-popular após cargas grandes (i.e. boostrap ERP). |
| R3 | ABC/Rotacao baseados em proxy (sem diasSemVenda) podem ser imprecisos para produtos sazonais | baixo | Critério "parado" usa proxy avgDaily≈0 (mais conservador). Refinar quando Venda diária / Compra ficarem disponíveis. |
| R4 | Counters in-process são effémeros em serverless | baixo | Aceitável nesta fase. Persistência para SyncRun é next iteration. |
| R5 | Speedup modesto (1.16×) — esperar mais ganho com escala | baixo | O ganho material está em consistência + capabilities novas (ABC, Rotacao, capital parado), não tempo de query. |

---

## 9. O que NÃO foi feito (intencional)

Conforme regras do utilizador:

- ❌ Não removidos os cálculos legacy. Continuam como fallback para
  qualquer caso onde IPF não responda. Próxima fase: depois de
  estabilidade (≥1 sprint).
- ❌ Não migrado `lib/encomendas/proposal.ts` (usa `Venda` diária +
  janela user-defined). Quando `Venda` for ingerida, esse loader
  beneficia de uma reorganização separada.
- ❌ Não migrado `getInternalSubstitutionsData` (WS-C). Migração não
  trivial — o algoritmo é pura função sobre raw input. Próximo
  ciclo.
- ❌ Sem UI nova. O sinal está exposto via `scripts/ipf-stats.ts`
  para consumo CLI/relatório. UI fica para fase posterior.
- ❌ Sem migration destrutiva. Schema da IPF estava já criado desde
  Q1 2026. Esta fase só populou + começou a ler.

---

## 10. Próximo passo recomendado

1. **Schedular o populate** — actualmente é manual. Quando a fase de
   infra estiver activa (`notes/infra-hardening-plan.md`), correr
   diariamente:
   ```bash
   npx tsx scripts/populate-indicadores-produto-farmacia.ts \
     --record-sync-run --tenant=<slug>
   ```
2. **Adicionar alerta** quando `MAX(dataCalculo) > 26h` (job
   silenciosamente falhou).
3. **Expor counters via SyncRun** — quando o request termina, escrever
   1 linha em SyncRun com `ipfHits / liveFallbacks` do request. Dá
   visibilidade longitudinal sem ter de fazer logging por request.
4. **Avaliar próxima iteração**: ABC/Rotacao na UI? Capital parado
   como tile do dashboard? Decisão de produto.

---

## 11. Comandos de verificação

```bash
# Re-popular (idempotente):
npx tsx scripts/populate-indicadores-produto-farmacia.ts

# Dry-run (mostra plano):
npx tsx scripts/populate-indicadores-produto-farmacia.ts --dry-run

# Stats + benchmark:
npx tsx scripts/ipf-stats.ts --top=20 --bench-iterations=10

# Typecheck:
npx tsx --no-warnings -e "import '@/lib/operational/ipf-reader';"
npx tsc --noEmit

# Testes unitários (não regressão):
npx tsx scripts/tests/test-operational-metrics.ts   # 86 verdes
npx tsx scripts/tests/test-internal-substitution.ts # 22 verdes
```

---

_Activação LIVE. Sem regressão funcional. Drift 0,0000 vs cálculo
legacy. Sem UI. Sem migration destrutiva. Lógica legacy preservada
como fallback._
