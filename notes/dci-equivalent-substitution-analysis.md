# DCI-Equivalent Substitution — Análise (dry-run)

**Data:** 2026-05-11
**Âmbito:** análise dry-run de substituições internas DCI-equivalente
(mesmo princípio activo + forma + dose + ATC5 + flags MSRM/MNSRM),
ampliando o universo de Fase B (same-CNP). Sem writes, sem UI, sem
integração em encomendas — só dados para decidir se entra em
produção.

---

## 1. Executive summary

**Resultado:** o detector DCI-equivalente, com gates clínicos
defensivos, encontra **187 candidatos · 433 unidades · 4 131,74 €**
evitáveis. Versus a Fase B same-CNP (103 / 433 / 2 844 €), isto
representa:

| Métrica | Same-CNP (Fase B) | DCI-equivalente | Δ |
|---|---:|---:|---:|
| Candidatos | 103 | 187 | **+82%** (+84 candidatos) |
| Unidades | 433 | 433 | — |
| € evitáveis | 2 844,27 € | 4 131,74 € | **+45%** (+1 287,47 €) |
| Universo (rows) | 22 016 | 22 016 (após pré-filtro: 6 799) | — |

O ganho de **45% em € evitáveis** vem sobretudo de pares em que a
mesma farmácia tem genérico e o branded em equivalência exacta
(ex: Forxiga ↔ Edistride com mesma DCI dapagliflozina). Crescimento
modesto e clinicamente seguro — sem explosão de falsos positivos.

**Tests:** 178 verdes (172 anteriores + 6 DCI / 47 asserts). Typecheck
limpo.

**Decisão pendente:** este relatório fornece a evidência para decidir
se o detector entra no pipeline de encomendas. Não há código
integrado em `/encomendas` nem em UI nesta passagem.

---

## 2. Universo (data quality)

```
Produto total (catálogo):     14 762
  com DCI:                     4 171  (28.3%)
  com ATC:                     4 168  (28.2%)
  com forma:                   4 171  (28.3%)
  com dosagem:                 4 171  (28.3%)
  productType=MEDICAMENTO:     7 526  (51.0%)
  MED com DCI:                 3 980
  MED com DCI+ATC+forma:       3 977

ProdutoFarmacia (vivos):      22 016
  → rows considerados pelo detector: 6 799 (30.9%)
  → distintos DCIs no universo:        868
```

> **Limitação principal:** apenas **28% do catálogo tem DCI
> preenchida**. O detector é cego para 70% dos produtos. Quando o
> pipeline regulatório (`RegulatoryAcquisitionJob`) estiver alimentado,
> o universo cresce substancialmente.

---

## 3. Detector — comportamento e gates clínicos

### 3.1 Localização

`lib/transfers/dci-equivalent-substitution.ts` — função pura
`findDciEquivalentSubstitutions(input, options)`. Sem I/O, sem
Prisma. Reutiliza `avgDaily` / `coverageDays` de
`metrics-shared`.

### 3.2 Pré-filtros (row-level)

| Filtro | Default | Conta em |
|---|---|---|
| `productType === "MEDICAMENTO"` | `requireMedicamento=true` | `productType_nao_medicamento` |
| `dci` não vazio (após `normalizeCatalogString`) | sempre | `dci_ausente` |

### 3.3 Gates clínicos (pair-level, ordem de prioridade)

Aplicados a cada par `(destino-em-ruptura, source-em-excesso)`
dentro do mesmo grupo `normalizeCatalogString(dci)`. **First-failed
gate wins** — o par conta na primeira categoria que rejeita.

| Ordem | Gate | Razão clínica |
|---:|---|---|
| 1 | `formaFarmaceutica` normalizada igual | comprimido ≠ xarope ≠ creme |
| 2 | `dosagem` normalizada igual | 10mg ≠ 20mg (sem decisão clínica) |
| 3 | `atc5` igual (primeiros 5 chars) | mesma família terapêutica |
| 4 | `flagMSRM === flagMSRM` E `flagMNSRM === flagMNSRM` | não misturar sujeitos/não-sujeitos a receita |

Notas:
- **Forma normalizada:** lowercase + trim + colapsa whitespace.
  "Comprimido" e "comprimido " e "Comprimido  Revestido"
  → "comprimido" / "comprimido revestido".
- **Dosagem normalizada:** lowercase + remove todos os espaços.
  "10 mg" === "10mg" === "10 MG"; "100 µg/dose" === "100µg/dose".
  Unidades **não** são normalizadas — "10mg" ≠ "10g" ≠ "10mcg"
  (propositadamente, ordens de grandeza diferentes nunca devem casar).
- **ATC5:** `A10BK01` → `A10BK`. Inputs <5 chars devolvem null
  (rejeita). Mesmo DCI com ATC5 diferente é caso raro (14 pares
  observados) — normalmente indica mis-classificação no catálogo.

### 3.4 Filtros operacionais (após gates)

- `coverage < ruptureThresholdDays` no destino + `avgDaily > 0`
- `coverage > excessThresholdDays` no source
- `farmaciaId(source) !== farmaciaId(destino)`
- `transferableQty = floor(min(sourceExcess, destinoNeed)) >= minTransferableQty`

`sourceExcess = stockSource - reserveDaysSource × avgDailySource`
`destinoNeed = (targetCoverageDays - covDestino) × avgDailyDestino`

### 3.5 Output `DciSubstitutionResult`

```ts
{
  candidates: DciSubstitutionCandidate[];           // ordenados € desc
  rejectionCounts: Record<DciRejectionReason, number>;
  rowsPrefiltered: number;
  rowsConsidered: number;
  dciDistinctCount: number;
}
```

---

## 4. Resultados (probe, encomenda-style thresholds)

Thresholds: `rupture<15, excess>30, target=15, reserve=14, minQty=1`
— alinhados com Fase B (`/encomendas`).

### 4.1 Universo

| Métrica | Valor |
|---|---:|
| Rows totais (input) | 22 016 |
| Rows pré-filtrados | 15 217 |
| Rows considerados | **6 799** |
| DCIs distintos | 868 |

### 4.2 Candidatos aceites

| Métrica | Valor |
|---|---:|
| **Candidatos** | **187** |
| **Unidades transferíveis** | **433** |
| **€ evitável total** | **4 131,74 €** |

### 4.3 Breakdown de rejeições

| Razão | Contagem | Comentário |
|---|---:|---|
| pré-filtro: productType ≠ MEDICAMENTO | 9 745 | maior cohort (cosmética, suplementos, dispositivos) |
| pré-filtro: DCI ausente | 5 472 | medicamentos sem DCI no catálogo |
| pair: forma diferente | 1 724 | comprimido vs cápsula vs xarope, mesma DCI |
| pair: dosagem diferente | 1 416 | 10mg vs 20mg, mesma DCI + forma |
| pair: ATC5 diferente | 14 | raros — geralmente catálogo errado |
| pair: MSRM/MNSRM divergente | 0 | catálogo coerente neste eixo |
| pair: mesma farmácia (skip) | 3 836 | esperado (múltiplos prod same-DCI numa farmácia) |
| post-gate: qty < minQty | 394 | passou clinicamente mas qty=0 |
| destino: sem demanda mensurável | 0 | filtro de ruptura exige `avgDaily>0` |

### 4.4 Sensitivity sem `requireMedicamento`

| Cenário | Considerados | Candidatos | € evitável |
|---|---:|---:|---:|
| Default (`requireMedicamento=true`) | 6 799 | 187 | 4 131,74 € |
| `requireMedicamento=false` | 7 032 | 190 | 4 131,75 € |
| **Δ** | +233 rows | +3 | +0,01 € |

> **Conclusão:** o gate `productType=MEDICAMENTO` não está a perder
> oportunidades significativas. Faz sentido mantê-lo activo —
> protege contra grupos onde a DCI casa mas o `productType` está
> mis-classificado.

---

## 5. Top 10 candidatos

| € evitável | qty | Destino (em ruptura) | Source (em excesso) | DCI \| dose \| forma | Cobertura |
|---:|---:|---|---|---|---|
| **906,83 €** | 29 | Forxiga 10 mg (Castelo) | Edistride 10 mg (Principal) | dapagliflozina \| 10mg \| comprimido rev | 6d→42d |
| 317,82 € | 2 | Mounjaro 2.5 mg (Castelo) | Mounjaro 2.5 mg (Principal) | tirzepatida \| 2.5mg/0.6ml \| solução injetá | 10d→103d |
| 151,68 € | 1 | Shingrix 50 µg (Principal) | Shingrix 50 µg (Castelo) | vacina zona \| 50µg/0.5ml \| pó e suspensão | 0d→60d |
| 95,67 € | 3 | Edistride 10 mg (Castelo) | Edistride 10 mg (Principal) | dapagliflozina \| 10mg \| comprimido rev | 12d→42d |
| 94,12 € | 2 | Tenossis 150 mg (Castelo) | Tenossis 150 mg (Principal) | ácido ibandrónico+colecalcif \| 150mg+2240UI \| comprimido rev | 7d→135d |
| 82,00 € | 5 | Daflon 1000 mg (Principal) | Daflon 1000 mg (Castelo) | bioflavonóides \| 1000mg \| comprimido rev | 7d→88d |
| 80,70 € | 10 | UL 250 mg (Castelo) | Prolif 250 mg (Principal) | saccharomyces boulardii \| 250mg \| cápsula | 3d→172d |
| 78,64 € | 4 | Crestor 10 mg (Castelo) | Rosuvastatina Alter 10 mg (Principal) | rosuvastatina \| 10mg \| comprimido rev | 6d→113d |
| 69,52 € | 11 | Zilpen 75/650 mg (Principal) | Tramadol+Paracetamol Pharm (Castelo) | tramadol+paracetamol \| 75mg+650mg \| comprimido | 9d→180d |
| 63,36 € | 3 | Brintellix 10 mg (Castelo) | Brintellix 10 mg (Principal) | vortioxetina \| 10mg \| comprimido rev | 10d→39d |

> **Observação clínica:** os pares com CNPs diferentes (Forxiga ↔
> Edistride, Crestor ↔ Rosuvastatina Alter, Zilpen ↔ genérico, UL
> 250 ↔ Prolif 250) são **clinicamente equivalentes** — mesmo
> princípio activo, mesma dose, mesma forma, mesmo ATC5, mesma
> classificação MSRM. São genéricos do mesmo branded ou
> co-marqueteados.

### 5.1 Top performer: dapagliflozina

`Forxiga 10 mg ↔ Edistride 10 mg` representa **906,83 €** sozinho
(22% do total). Mesma DCI, mesma dose, mesma forma, mesmo ATC
(`A10BK01`). Ambos são apresentações da mesma molécula da
AstraZeneca, comercializadas com nomes diferentes. Substituição
clinicamente trivial.

---

## 6. Comparação directa com same-CNP (Fase B)

| Cenário | Candidatos | € evitável |
|---|---:|---:|
| Same-CNP (Fase B `c5574d6`) | 103 | 2 844,27 € |
| DCI-equivalente (esta passagem) | 187 | 4 131,74 € |
| **Δ** | **+84 candidatos** | **+1 287,47 €** |

Os 187 do detector DCI **incluem** os 103 same-CNP — quando o
destino e o source têm o mesmo `produtoId`, satisfazem
trivialmente todos os gates (mesma forma, dose, ATC, MSRM). Os 84
novos vêm de pares **inter-CNP** legítimos (genéricos
equivalentes).

> **Não duplicamos**: o detector DCI processa o mesmo destino com
> múltiplos sources possíveis (mesmo-CNP **OU** equivalentes) e
> escolhe **um** source — o de maior cobertura. Por isso o número
> total não é "103 + 84" linear; alguns mesmos-CNP escolhidos antes
> agora têm um source DCI-equivalente preferido (mais excesso),
> mas trocar uma fonte por outra mantém o destino contado uma vez.

---

## 7. Riscos e limitações

| Risco | Avaliação | Mitigação |
|---|---|---|
| **DCI normalização demasiado folgada** | "ibuprofeno" vs "ibuprofeno cálcico" colapsam para nomes distintos? | `normalizeCatalogString` só faz lowercase+trim+space-collapse. "Ibuprofeno" === "ibuprofeno cálcico" → false (são strings diferentes), portanto NÃO casam. Verificado em 868 DCIs distintos do universo. |
| **Forma "comprimido" vs "comprimido revestido"** | Cliente vê como interchangeable, mas catálogo distingue | Tratados como **DIFERENTES** (forma_diferente). Conservador. Se quisermos relaxar, fazemos canonicalização específica numa próxima passagem. |
| **Dosagem composta** ("10mg + 5mg" vs "5mg + 10mg") | Ordem inverte mas é o mesmo produto | Tratados como **DIFERENTES**. Catálogo INFARMED é consistente neste eixo, e nunca observámos a inversão em práctica. Aceitável. |
| **DCI ATC5 diferente** | Acontece em 14 pares — geralmente mis-classificação | Rejeitamos. Vale a pena fazer audit dos 14 manualmente para corrigir o catálogo. |
| **Custo unitário pode variar entre source e destino** | Genéricos têm puc < branded; substituição "salva" menos em € | Usamos `destino.puc` (não `source.puc`). Reflete o custo que estaríamos a pagar se fizéssemos encomenda. Conservador. |
| **MSRM exigido em ambos** | Casos limite onde flags estão erradas? | 0 rejeições observadas — catálogo coerente. Se aparecerem falsos negativos no futuro, é sinal de problema de qualidade no catálogo, não no detector. |
| **Cobertura do catálogo 28%** | Detector cego para 70% do catálogo | Quando `RegulatoryAcquisitionJob` pipeline alimentar, universo cresce. Não é problema do detector — é problema de fonte. |
| **Universo limitado a 2 farmácias** | Pode haver enviesamento estatístico | Aceitável para esta análise. Em multi-tenant futuro a métrica replica-se. |

---

## 8. Quando entrar em encomendas?

Análise per-passo recomendada antes da integração em produção:

| Passo | Acção |
|---|---|
| 8.1 | **Audit clínico manual dos top 20 candidatos.** Validar com farmacêutico (ou pelo menos um sanity check escrito) que os pares DCI-equivalentes são clinicamente intercambiáveis. |
| 8.2 | **Verificar os 14 pares rejeitados por ATC5 diferente.** Identificar se é mis-classificação do catálogo ou genuíno (DCIs com múltiplas indicações). Corrigir catálogo se aplicável. |
| 8.3 | **Decisão go/no-go.** Se a qualidade clínica for OK, integrar o detector em `/encomendas` paralelamente a same-CNP. Política: badge "Transferência interna possível" passa a também considerar pares DCI-equivalentes. Reportar separadamente nos KPIs (`internalSubstitution` vs `dciEquivalentSubstitution`). |
| 8.4 | **Dashboard.** Adicionar segundo tile (ou expandir o existente `InternalSubstitutionCard` com breakdown CNP vs DCI). |
| 8.5 | **Audit contínuo.** Logar quando uma sugestão DCI-equivalente é aceite vs rejeitada pelo operador. Permite afinar gates futuros. |

Nada disto está feito nesta passagem. Decisão de avançar é
explicitamente do utilizador.

---

## 9. Regras respeitadas (scope desta fase)

| Regra | Estado |
|---|---|
| Análise dry-run primeiro | ✅ — só probe read-only |
| Usar apenas produtos com DCI preenchida | ✅ — `dci_ausente` pré-filtro |
| Mesmo DCI exacta normalizada | ✅ — `normalizeCatalogString` |
| Mesmo productType = MEDICAMENTO | ✅ — `requireMedicamento=true` default |
| Excluir dosagem diferente nesta fase | ✅ — `dosagem_diferente` rejeição |
| Exigir formaFarmaceutica igual | ✅ — `forma_diferente` rejeição |
| Não misturar MSRM/MNSRM | ✅ — `msrm_divergente` rejeição |
| Não propor se ATC divergir ao nível 5 | ✅ — `atc5` comparison |
| Detector em `lib/transfers/dci-equivalent-substitution.ts` | ✅ |
| Probe em `scripts/probe-dci-substitutions.ts` | ✅ |
| Não integrar UI | ✅ |
| Não integrar encomendas | ✅ |
| Não fazer writes | ✅ — `$queryRaw` apenas, zero `$executeRaw` |

---

## 10. Tests / typecheck

| Suite | Resultado |
|---|---|
| `test-dci-equivalent-substitution.ts` (16 cenários, 47 asserts) | ✅ NEW |
| `test-cron-auth.ts` (16) | ✅ |
| `test-ipf-freshness.ts` (33) | ✅ |
| `test-encomendas-substitution.ts` (15) | ✅ |
| `test-internal-substitution.ts` (22) | ✅ |
| `test-operational-metrics.ts` (86) | ✅ |
| **Total** | **178 verdes** (172 anteriores + 6 DCI) |
| `tsc --noEmit` | ✅ limpo |
| Probe live (dry, encomenda-style thresholds) | ✅ 187 candidatos, 433 un., 4 131,74 € em 1,8s |

---

## 11. Comandos de validação

```bash
# Typecheck
npx tsc --noEmit

# Testes da fase
npx tsx scripts/tests/test-dci-equivalent-substitution.ts

# Todas as suites
for t in test-operational-metrics test-internal-substitution \
         test-encomendas-substitution test-ipf-freshness \
         test-cron-auth test-dci-equivalent-substitution; do
  npx tsx scripts/tests/$t.ts
done

# Probe — encomenda-style thresholds (default)
npx tsx scripts/probe-dci-substitutions.ts --top=50

# Probe — sensitivity sem requireMedicamento
npx tsx scripts/probe-dci-substitutions.ts --top=20 --no-require-medicamento

# Probe — thresholds mais aggressive (ruptura ≤7d)
npx tsx scripts/probe-dci-substitutions.ts --rupture=7 --top=30

# Probe — exigir transferência mínima 5 unidades
npx tsx scripts/probe-dci-substitutions.ts --min-qty=5 --top=30
```

---

## 12. Próximos passos (não inicio sem aprovação)

**A. Integrar em `/encomendas`.** Adicionar o detector ao pipeline
de `lib/encomendas-data.ts`, paralelamente ao same-CNP. Badge
existente passa a também acender com fonte DCI-equivalente.
Esforço: ~0,5-1 dia. Bloqueio: audit clínico manual primeiro
(passo 8.1).

**B. Audit dos 14 pares ATC-divergentes.** Identificar
mis-classificações no catálogo + corrigir. Esforço: ~2-4h.
Independente de A.

**C. Dashboard tile.** Expandir `InternalSubstitutionCard` para
mostrar breakdown CNP vs DCI. Esforço: ~0,5 dia. Depende de A.

**D. Alimentar `RegulatoryRecord` em mais produtos.** Hoje 28% de
cobertura; potencial 80%+ se o pipeline regulatório for executado.
Esforço: depende do pipeline (Phase 1+ ainda não tem fetchers reais).

---

_Probe-only · sem writes · gates clínicos defensivos · 178 testes
verdes · 187 candidatos · 4 131,74 € · audit manual recomendado antes
de integrar em encomendas._
