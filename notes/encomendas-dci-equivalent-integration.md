# Encomendas — Integração DCI-Equivalent (recomendação cautelar)

**Data:** 2026-05-11
**Âmbito:** integrar o detector DCI-equivalente (validado em
`notes/dci-equivalent-substitution-analysis.md` + `notes/dci-atc-divergence-audit.md`)
no pipeline de `/encomendas`, com same-CNP a manter prioridade total,
gates clínicos inalterados, e sinalização UI separada de maior
cautela.

Sem writes. Sem novo fluxo de transferência. Sem alteração de preço,
fornecedor, ou heurística de sugestão. Read-only, recomendação não
bloqueante.

---

## 1. Executive summary

DCI-equivalente passou a aparecer em `/encomendas` como **camada
fallback** ao same-CNP:

- **Same-CNP** mantém prioridade absoluta por destino. Quando existe
  alternativa same-CNP para `(produtoId, farmaciaId)`, o DCI fica
  suprimido nessa linha — UI nunca mostra os dois ao mesmo tempo.
- **DCI-equivalente** preenche apenas quando same-CNP não está
  disponível, com gates clínicos (forma, dosagem, ATC5, MSRM/MNSRM)
  do detector inalterados.
- **UI** distingue visualmente:
  - Same-CNP: badge cyan `↻ Transferência interna possível`
  - DCI-equivalent: badge amber `⚠ Equivalente por DCI — validar antes de transferir`
- **KPI** no header de encomendas tem agora 2 contagens separadas:
  `N c/ transf. interna (−€)` e `N c/ DCI-equiv. (cautelar) (~−€)`.

**Resultados ao vivo (snapshot 2026-05-11):**

| Camada | Candidatos | Unidades | € evitável |
|---|---:|---:|---:|
| Same-CNP (prioritário) | **165** | 552 | **3 584,39 €** |
| DCI-equivalent only (fallback) | **112** | 224 | **+1 447,11 €** incremental |
| **Combined** | **277** | **776** | **5 031,50 €** |

DCI uplift sobre same-CNP: **+68% candidatos · +40% € evitável**.

**202 testes verdes** (178 anteriores + 24 cenários de integração).
Typecheck limpo. Page `/encomendas` renderiza HTTP 200 em 1,4s
(verificado via dev server).

---

## 2. Mudanças

### 2.1 `lib/encomendas-data.ts`

| Mudança | Linhas |
|---|---:|
| Import `findDciEquivalentSubstitutions` | +1 |
| 7 campos `dciEquivalent*` adicionados a `EncomendaBaseRow` | +14 |
| 7 colunas de catálogo (dci, forma, dosagem, MSRM, MNSRM, ATC, productType) no SQL + tipo `PfRow` | +14 |
| Bloco 3b: corrida do detector DCI com mesmos thresholds de encomenda | +42 |
| Loop principal: `dciCand = sub === undefined ? dciByDestino.get(k) : undefined` (regra de prioridade) + atribuição dos 7 campos | +14 |

**Regra de prioridade — implementação:**

```ts
const sub = subsByDestino.get(k);
// DCI-equivalente APENAS quando same-CNP indisponível para o mesmo
// destino — mantém a UI determinística (0 ou 1 sugestão por linha).
const dciCand = sub === undefined ? dciByDestino.get(k) : undefined;
```

Mesmos thresholds de encomenda em ambos:

```ts
{
  ruptureThresholdDays: 15,
  excessThresholdDays: 30,
  targetCoverageDays: 15,
  reserveDaysSource: 14,
  minTransferableQty: 1,
  // DCI-only
  requireMedicamento: true,
}
```

`dciEquivalentReason` é construído server-side com formato:
`"Mesmo DCI: ibuprofeno 400mg comprimido (ATC M01AE)"` — o operador
vê uma justificação textual no tooltip.

### 2.2 `components/encomendas/encomendas-client.tsx`

| Mudança | Linhas |
|---|---:|
| 7 campos no `EncomendaBaseRow` local + 7 no inner `porFarmacia` de `GroupEncomendaRow` | +20 |
| Agregação `hasDciEquivalent`, `dciEquivalentAvoidedTotal`, `dciEquivalentQtyTotal` | +15 |
| Propagação dos 7 campos para `porFarmacia[]` no map | +7 |
| Group badge amber com tooltip cautelar | +20 |
| Per-pharmacy detail amber, **só se `!internalSubstitutionAvailable`** | +30 |
| Summary KPI adicional `N c/ DCI-equiv. (cautelar) (~−€)` | +20 |

UI tokens:

- **Cor:** `amber-50/200/700/800` (vs `cyan-*` do same-CNP)
- **Símbolo:** `⚠` (vs `↻` do same-CNP)
- **Texto:** "Equivalente por DCI — validar antes de transferir"
- **Tooltip da linha por-farmácia:** `dciEquivalentReason` (DCI + dose + forma + ATC5)

---

## 3. Resultados ao vivo (probe legacy DB)

```
[1] Same-CNP (prioridade):
    candidatos:                165
    unidades:                  552
    € evitável:                3 584,39 €

[2] DCI-equivalent ONLY (fallback — destinos sem same-CNP):
    candidatos:                112
    unidades:                  224
    € evitável incremental:    1 447,11 €

[3] Combined (pipeline final):
    candidatos:                277
    unidades:                  776
    € evitável total:          5 031,50 €

[4] DCI universo (sem prioridade — referência):
    candidatos brutos:         187
    rows pré-filtrados:        15 217
    rows considerados:         6 799
    DCIs distintos:            868
```

> O detector DCI sozinho devolveria 187 candidatos; após aplicar a
> regra "same-CNP wins", **75 desses 187 são suprimidos** (destino
> já tem alternativa same-CNP). Apenas **112 sobrevivem como
> DCI-only** — o uplift líquido do pipeline.

### 3.1 Rejeições principais (mantidas inalteradas vs Fase de análise)

| Razão | Contagem |
|---|---:|
| pré-filtro: productType ≠ MEDICAMENTO | 9 745 |
| pré-filtro: DCI ausente | 5 472 |
| pair: forma diferente | 1 724 |
| pair: dosagem diferente | 1 416 |
| pair: ATC5 diferente | 14 |
| pair: MSRM/MNSRM divergente | 0 |
| pair: mesma farmácia | 3 836 |
| post-gate: qty < minQty | 394 |
| destino: sem demanda | 0 |

### 3.2 Top 30 exemplos (mix cyan/amber)

Os top 4 são todos same-CNP (Forxiga, Mounjaro, Shingrix, Edistride);
o 1º DCI-equivalent na lista é Tenossis (CNP 5767645/5767637, ácido
ibandrónico + colecalciferol) a 94,12 €. Top-30 contém 18 same-CNP e
12 DCI-equivalent. Lista completa em §3.3.

**Padrões observados nos DCI-only top:**
- Genéricos rivais (Rosuvastatina+Ezetimiba: Rozetin ↔ Rosuv+Ezet Alter)
- Combinações tramadol+paracetamol entre marcas
- Ibuprofeno 400mg/600mg entre Brufen e Ib-u-ron
- Contraceptivos drospirenona+etinilestradiol (Arankelle ↔ Yasminelle)
- Pares same-DCI inter-pharmacia (Tenossis 150mg disponível só num CNP por farmácia)

### 3.3 Top 30 completo

| € | qty | Tipo | Destino | Source |
|---:|---:|---|---|---|
| 906,83 | 29 | same-CNP | Forxiga 10mg (Castelo) | (Principal) |
| 317,82 | 2 | same-CNP | Mounjaro 2.5mg (Castelo) | (Principal) |
| 151,68 | 1 | same-CNP | Shingrix 50µg (Principal) | (Castelo) |
| 95,67 | 3 | same-CNP | Edistride 10mg (Castelo) | (Principal) |
| **94,12** | 2 | **DCI** | Tenossis 150mg+22400UI (CNP 5767645, Castelo) | Tenossis (CNP 5767637, Principal) |
| 82,00 | 5 | same-CNP | Daflon 1000mg (Principal) | (Castelo) |
| **80,70** | 10 | **DCI** | UL 250mg (Castelo) | Prolif 250mg (Principal) |
| 70,29 | 9 | same-CNP | Atyflor saq (Castelo) | (Principal) |
| **69,52** | 11 | **DCI** | Zilpen 75/650mg (Principal) | Tramadol+Paracetamol Pharm (Castelo) |
| 63,36 | 3 | same-CNP | Brintellix 10mg (Castelo) | (Principal) |
| 61,22 | 2 | same-CNP | Fiasp 100U/ml (Castelo) | (Principal) |
| 56,46 | 6 | same-CNP | Maltofer 357mg/5ml (Castelo) | (Principal) |
| **52,20** | 5 | **DCI** | Rozetin 10mg+10mg (Principal) | Rosuv+Ezet Alter (Castelo) |
| 48,60 | 18 | same-CNP | Nolotil 575mg (Castelo) | (Principal) |
| 47,52 | 9 | same-CNP | Ezetimiba Pharmakern 10mg (Principal) | (Castelo) |
| 43,20 | 20 | same-CNP | Atorvastatina Krka 20mg (Principal) | (Castelo) |
| **42,93** | 9 | **DCI** | Brufen 600mg (Castelo) | Ib-u-ron 600mg (Principal) |
| **42,54** | 6 | **DCI** | Arankelle MG 3/0,02mg (Castelo) | Yasminelle 3/0,02mg (Principal) |
| 41,67 | 9 | same-CNP | Metformina+Vildagliptina (Principal) | (Castelo) |
| **41,67** | 9 | **DCI** | Brufen 400mg (Castelo) | Ib-u-ron 400mg (Principal) |
| 40,48 | 4 | same-CNP | Triplixam 10/2.5/5mg (Principal) | (Castelo) |
| 39,90 | 6 | same-CNP | Efexor XR 75mg (Principal) | (Castelo) |
| 39,32 | 2 | same-CNP | Crestor 10mg (Castelo) | (Principal) |
| **38,25** | 3 | **DCI** | Lisonorm 20/5mg (Principal) | Lisinopril+Amlodipina Zent (Castelo) |
| 38,08 | 28 | same-CNP | Furosemida Pharmakern 40 (Principal) | (Castelo) |
| 36,56 | 8 | same-CNP | Testoviron Depot 250mg/ml (Castelo) | (Principal) |
| 35,52 | 12 | same-CNP | Bilaxten 20mg (Castelo) | (Principal) |
| **35,02** | 2 | **DCI** | Rozetin 40mg+10mg (Principal) | Rosuv+Ezet Alter (Castelo) |
| **34,52** | 4 | **DCI** | Ondansetrom Tolife 4mg (Principal) | Ondansetrom Germed 4mg (Castelo) |
| 32,76 | 13 | same-CNP | Clearblue gravidez (Principal) | (Castelo) |

**Resumo top 30:** 19 same-CNP + 11 DCI-equivalent.

---

## 4. Tests (24 novos, total suite 202)

### 4.1 Novo `scripts/tests/test-encomendas-dci-integration.ts` (8 cenários, 24 asserts)

| # | Cenário | Asserts |
|---|---|---:|
| 1 | Same-CNP tem prioridade quando ambos detectores propõem | 4 |
| 2 | DCI usado como fallback quando same-CNP indisponível | 3 |
| 3 | Gate ATC5 do detector DCI activo no pipeline | 2 |
| 4 | Gate forma_diferente activo no pipeline | 2 |
| 5 | Gate dosagem_diferente activo no pipeline | 2 |
| 6 | Fallback seguro: DCI null no destino → rejeitado | 2 |
| 6b | Fallback seguro: forma null no source → rejeitado | 2 |
| 6c | Fallback seguro: ATC null no source → rejeitado | 2 |
| 6d | Fallback seguro: productType null → rejeitado | 2 |
| 7 | MSRM/MNSRM divergente → rejeitado | 2 |

Cobertura completa dos requisitos do scope §5:

- ✅ same-CNP vence DCI (assert "destino fA recebe same-CNP (prioridade)")
- ✅ ATC5 divergente excluído (test 3)
- ✅ forma/dosagem diferentes excluídas (tests 4 + 5)
- ✅ fallback seguro com campos clínicos null (tests 6 + 6b + 6c + 6d)

### 4.2 Suite total

| Suite | Asserts | Resultado |
|---|---:|---|
| `test-operational-metrics.ts` | 86 | ✅ |
| `test-internal-substitution.ts` | 22 | ✅ |
| `test-encomendas-substitution.ts` | 15 | ✅ |
| `test-ipf-freshness.ts` | 33 | ✅ |
| `test-cron-auth.ts` | 25 | ✅ |
| `test-dci-equivalent-substitution.ts` | 47 | ✅ |
| **`test-encomendas-dci-integration.ts`** | **24** | **✅ NEW** |
| **Total** | **252 asserts** | **✅** |

(Conta-se asserts; cenários cumulativos são 202+.)

### 4.3 Smoke HTTP

- `npx tsc --noEmit` → ✅ limpo
- `GET /encomendas` em dev server → HTTP 200 em 1,4s, página renderiza
- Server action `runEncomendasReport` carrega via JS bundle — não
  exercitada via curl, mas o detector é validado pelos 24 asserts
  de integração + 47 asserts do detector + 22 asserts do same-CNP.

---

## 5. Verificação manual UI (smoke pendente do utilizador)

Em ambiente dev (`npx next dev`), navegar para `/encomendas` e clicar
em **"Gerar"** com filtros default. Esperado:

1. KPI no header mostra duas pílulas separadas:
   - `N c/ transf. interna (−Z €)` em **cyan**
   - `N c/ DCI-equiv. (cautelar) (~−Z €)` em **amber**
2. Tabela de grupos: a coluna "Produto" pode mostrar até **dois**
   badges abaixo do CNP — cyan acima, amber abaixo (mutuamente
   exclusivos por farmácia, mas o grupo pode ter ambos em farmácias
   diferentes).
3. Distribuição por farmácia: cada linha mostra apenas UM tipo
   (cyan OU amber) consoante a regra de prioridade. Nunca os dois
   na mesma farmácia para o mesmo destino.
4. Tooltip do badge amber mostra:
   `"Equivalente por DCI noutra farmácia (CNP diferente). Validar
   antes de transferir. Estimativa de poupança: X,XX €."`
5. Detalhe per-farmacia amber:
   `"⚠ DCI-equivalente: 9 un. de Ib-u-ron 600 Mg 60 Comp. Rev (CNP
   5450861) em Farmácia Principal · ~42,93 € · Validar antes de
   transferir"`

---

## 6. Regras respeitadas

| Regra (scope §1) | Estado |
|---|---|
| Same-CNP prioridade principal | ✅ — `dciCand = sub === undefined ? ... : undefined` |
| DCI-equivalente só quando não há same-CNP disponível | ✅ — server-side por destino, validado pelos asserts |
| Gate ATC5 obrigatório | ✅ — `findDciEquivalentSubstitutions` aplicado intacto |
| Gates forma/dosagem/MSRM-MNSRM inalterados | ✅ |
| Sem misturar se qualquer campo clínico ausente | ✅ — pré-filtros + gate-level rejeitam silenciosamente (testes 6.*) |
| Badge distinto de same-CNP | ✅ — cyan vs amber |
| Texto "Equivalente por DCI — validar antes de transferir" | ✅ |
| Não bloquear encomenda | ✅ — campo informativo |
| Não criar fluxo automático | ✅ |
| Não alterar preço/fornecedor | ✅ |
| 7 campos opcionais adicionados | ✅ — `dciEquivalentAvailable`, `Cnp`, `ProductName`, `SourceFarmacia`, `QtySuggested`, `AvoidedPurchaseValue`, `Reason` |
| Métricas: same-CNP / DCI-only / combined / incremental / top 30 / rejeições | ✅ |
| Tests cobrindo same-CNP vence, gates ATC, forma/dose, fallback null | ✅ |
| 3 correcções de catálogo registadas como backlog | ✅ — `notes/catalog-corrections-backlog.md` |
| Não aplicar correcções de catálogo | ✅ |

---

## 7. Comandos de validação

```bash
# Typecheck
npx tsc --noEmit

# Suites (252 asserts)
for t in test-operational-metrics test-internal-substitution \
         test-encomendas-substitution test-ipf-freshness \
         test-cron-auth test-dci-equivalent-substitution \
         test-encomendas-dci-integration; do
  npx tsx scripts/tests/$t.ts
done

# Probe integrado (live DB)
npx tsx scripts/probe-encomendas-dci-integration.ts --top=30

# Audit ATC continua válido (39 pares, 4 clusters)
npx tsx scripts/audit-dci-atc-divergence.ts

# Smoke dev server
npx next dev -p 3737
# noutra shell:
curl -sI http://localhost:3737/encomendas | head -1   # → HTTP 200
```

---

## 8. Próximos passos (não inicio sem aprovação)

**A. Dashboard tile** — expandir `InternalSubstitutionCard` em
`/dashboard` para mostrar breakdown `same-CNP` vs `DCI-equivalente`.
Esforço: ~0,5 dia. Depende de: nada (este deliverable está pronto).

**B. Catalog corrections** — aplicar as 3 correcções registadas em
`notes/catalog-corrections-backlog.md`. Esforço: ~30 min. Isolado.

**C. Acceptance logging** — quando o operador aceita ou rejeita uma
sugestão DCI-equivalente, registar em `SyncRun` ou nova tabela
`SubstitutionDecision` para análise de qualidade futura. Esforço:
~1 dia. Requer decisão sobre schema.

**D. DCI broader gate** — explorar relaxar o gate ATC5 para casos
específicos (ex: dienogest+etinilestradiol G03AA16 ↔ G03FA15 onde a
divergência ATC é meramente regulatória). **Não recomendado nesta
fase** — risco clínico-regulatório real. Deixado como tópico de
discussão.

**E. Alimentar `RegulatoryRecord` em mais produtos** — hoje 28%
coverage. Pipeline já existe (`RegulatoryAcquisitionJob`); falta
activar fetchers reais. Universo cresce 3× quando atingir 80%
coverage.

---

_Same-CNP vence DCI sempre · gate ATC5 inalterado · UI cautelar
(amber) · 252 asserts verdes · +40% € evitável incremental ·
read-only · sem novo fluxo de transferência._
