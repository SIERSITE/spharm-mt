# Encomendas — Substituição interna same-CNP

**Data:** 2026-05-11
**Âmbito:** integrar a detecção de substituição interna same-CNP no
loader e UI de `/encomendas`, para que o gestor veja "transferência
interna possível" ANTES de sugerir compra ao fornecedor.

**Constraints respeitadas:**
- Only same-CNP nesta fase (DCI-equivalente fica para próxima
  iteração).
- Substituição é **recomendação**, não bloqueio — encomenda
  continua disponível para a quantidade total mesmo quando há
  transferência possível.
- Fallback seguro: se IPF não existir, cálculo cai para live (path
  da Fase 1 dual-read mantém-se).
- Sem writes. Sem alteração de pricing/fornecedor logic.

---

## 1. Executive summary

Integração entregue em **1 commit único** com:
- **`lib/encomendas-data.ts`**: 6 novos campos opcionais por row, +
  detecção embutida via `findInternalSubstitutions` com thresholds
  adaptados a encomendas (`rupture<15d`, `excess>30d`,
  `target=15d`, `reserve=14d`).
- **`components/encomendas/encomendas-client.tsx`**: badge agregado
  no header do produto, nota inline na linha por-farmácia, KPI no
  resumo ("X c/ transf. interna · −Y €").
- **`scripts/tests/test-encomendas-substitution.ts`**: 15 testes
  unitários verdes em 7 cenários (thresholds encomenda vs default,
  lookup key, mesma-farmácia, fallback sem demanda, reserve cap,
  puc fallback, ordenação).
- **`scripts/probe-encomendas-substitution.ts`**: probe read-only
  para medir impacto operacional. Output reproducible.

**Impacto medido live** (2026-05-11, target=15d, 2 farmácias):

| Métrica | Valor |
|---|---:|
| Universo ProdutoFarmacia vivo | 14 922 |
| Pares ProdutoFarmacia × VendaMensal 3m | 12 570 |
| Candidatos de substituição (encomenda thresholds) | **103** |
| Linhas de encomenda com transferência interna possível | **103** |
| Unidades transferíveis totais | **433** |
| Valor de compra evitável total | **2 844,27 €** |
| Top 1 produto (Forxiga 10 Mg) | **906,83 €** evitáveis |
| Wall-clock do probe | 3,1s |

**Sem regressão funcional.** 156 testes unitários verdes (86
metrics-shared + 22 internal-substitution + 33 ipf-freshness + 15
encomendas-substitution). `tsc --noEmit` limpo.

---

## 2. Alterações no loader

### 2.1 Shape público (`EncomendaBaseRow`)

6 novos campos opcionais — clientes legados não-cientes destes
campos continuam a funcionar:

```ts
type EncomendaBaseRow = {
  // ...campos existentes...
  internalSubstitutionAvailable: boolean;
  substitutionSourceFarmacia?: string;
  substitutionQtySuggested?: number;
  substitutionAvoidedPurchaseValue?: number;
  substitutionCoverageOrigin?: number;
  substitutionCoverageDestination?: number;
};
```

`internalSubstitutionAvailable` é sempre boolean. Os 5 detalhes
ficam `undefined` quando não há candidato.

### 2.2 Pipeline novo

```
ProdutoFarmacia (com puc) ──┐
                            ├─→ substitutionInput
VendaMensal 3m (recent3) ───┘                ↓
                                  findInternalSubstitutions
                                  (rupture<15, excess>30,
                                   target=15, reserve=14)
                                             ↓
                                  Map<produtoId:destinoFarmaciaId, sub>
                                             ↓
              main loop por row:  → 6 campos populated quando há match
```

### 2.3 Thresholds adaptados

| Parâmetro | /transferencias (default) | /encomendas (este) | Razão |
|---|---|---|---|
| `ruptureThresholdDays` | 7 | **15** | encomenda dispara abaixo da cobertura-alvo canónica (15d), não só em rotura iminente |
| `excessThresholdDays` | 30 | 30 | sem mudança — origem precisa de excesso confortável |
| `targetCoverageDays` | 15 | 15 | alinhado com cobertura-alvo encomenda |
| `reserveDaysSource` | 14 | 14 | mantém origem ≥ 14d pós-transferência |
| `minTransferableQty` | 1 | 1 | aceita transferência mínima |

Consequência: encomendas detectam **mais candidatos** que
/transferencias porque o limiar de "need" no destino é mais
generoso. Validado no probe — 103 candidatos vs 33 com thresholds
default.

### 2.4 Reuso da camada IPF (Fase 1)

`avgDaily` ainda passa por `resolveAvgDaily90d` para usar IPF
quando disponível. A detecção de substituição usa `salesQty =
recent3` (VendaMensal × 3m), que é numericamente equivalente à
fonte do IPF (drift 0,0000 validado em Fase 1). Os dois caminhos
agregam.

Quando IPF está vazio, ambos os caminhos caem para o cálculo live
sem regressão.

---

## 3. UI mínima

Sem redesign. 3 zonas afectadas:

### 3.1 Coluna "Produto" (agregado por grupo)

Badge compacto abaixo do CNP quando o grupo tem pelo menos uma
linha com substituição:

```
[●] Forxiga 10 Mg
    CNP 5487228
    ↻ Transferência interna possível · −907 €
```

`title` (tooltip) mostra valor evitável formatado.

### 3.2 Coluna "Distribuição por farmácia" (detalhe por farmácia)

Nota inline em cada linha por-farmácia onde há substituição E
sugestão a encomendar:

```
Farmácia Castelo     stock 1 · cob. 6 d · sug. 29
↻ Transferir 29 un. de Farmácia Principal · evita 906,83 €
```

### 3.3 Header de resumo

Adicionado KPI agregado entre "críticos" e "estimados":

```
N artigos · M críticos · K c/ transf. interna (−€) · V € estimados
```

Só aparece quando há pelo menos 1 artigo com substituição.

### 3.4 Filosofia

Substituição **não bloqueia** o input de "Encomendar grupo". O
gestor pode:
- Aceitar a transferência → reduzir manualmente o valor de
  "Encomendar grupo".
- Ignorar e encomendar ao fornecedor mesmo assim.
- Encomendar parcial e transferir parcial.

A UI mostra informação; a decisão fica humana. Sem fluxo
automático de criação de transferência nesta fase.

---

## 4. Testes

### 4.1 Unitários (`scripts/tests/test-encomendas-substitution.ts`)

15 assertivas / 7 cenários:

1. **Threshold encomenda vs default** — com `rupture<15`,
   produto a cov=10d é candidato; com `rupture<7` (default
   transferências), não é.
2. **Lookup key** — `Map<${produtoId}:${destinoFarmaciaId}, sub>`
   alinha com `pf:farmacia` da row.
3. **Mesma farmácia não conta** — sem peer pharmacy, zero
   candidatos.
4. **Sem demanda no destino** — `avgDaily=0` elimina destino.
5. **Reserve cap** — origem stock=20 com reserve=14×ad → max 6 un.
   transferíveis.
6. **`avoidedPurchaseEstimate`** — `qty × pucDestino` com fallback
   pucOrigem.
7. **Ordenação** — desc por € poupados.

### 4.2 Smoke check

`scripts/probe-encomendas-substitution.ts` reproduz exactamente o
pipeline do `getEncomendasData()`. Output confere com o esperado.

### 4.3 Regressão

| Suite | Antes | Depois |
|---|---:|---:|
| `test-operational-metrics.ts` (86) | ✅ | ✅ |
| `test-internal-substitution.ts` (22) | ✅ | ✅ |
| `test-ipf-freshness.ts` (33) | ✅ | ✅ |
| `test-encomendas-substitution.ts` (15, NEW) | — | ✅ |
| **Total** | 141 | **156** |

`tsc --noEmit` passa limpo.

---

## 5. Métricas reais — probe live (2026-05-11)

### 5.1 Resumo geral

```bash
$ npx tsx scripts/probe-encomendas-substitution.ts --top=20
[1] Farmácias activas: 2
[2] ProdutoFarmacia vivos: 14922
[3] VendaMensal 3m pares: 12570
[4] candidatos: 103
[5] linhas encomenda com substituição: 103
    unidades transferíveis (sum):  433
    valor de compra evitável (sum): 2 844,27 €
```

### 5.2 Distribuição por farmácia destino

| Farmácia destino | Linhas | Unidades | € evitável |
|---|---:|---:|---:|
| Farmácia Castelo | 53 | 249 | **2 129,91 €** |
| Farmácia Principal | 50 | 184 | 714,36 € |

Castelo é o destino mais beneficiado, o que faz sentido — tem mais
stocks baixos que Principal tipicamente cobre com excessos.

### 5.3 Top 20 por € evitável

| € | Qty | Encomenda | Cov O→D | Produto | Sentido |
|---:|---:|---:|---|---|---|
| 906,83 | 29 | 29 | 33d→6d | Forxiga 10 Mg 28 Comp. | Principal → Castelo |
| 317,82 | 2 | 3 | 103d→10d | Mounjaro 2.5 Mg/0.6 Ml | Principal → Castelo |
| 95,67 | 3 | 4 | 42d→12d | Edistride 10 Mg 28 Comp. | Principal → Castelo |
| 82,00 | 5 | 6 | 88d→7d | Daflon 1000 30 Comp. | Castelo → Principal |
| 70,29 | 9 | 10 | 33d→6d | Atyflor Saq X10 | Principal → Castelo |
| 63,36 | 3 | 4 | 39d→10d | Brintellix 10 Mg 28 Comp. | Principal → Castelo |
| 56,46 | 6 | 7 | 36d→8d | Maltofer 357 mg/5 mL X20 | Principal → Castelo |
| 48,60 | 18 | 19 | 88d→5d | Nolotil 575 mg X20 | Principal → Castelo |
| 47,52 | 9 | 10 | 97d→1d | Ezetimiba Pharmakern 10 Mg | Castelo → Principal |
| 43,20 | 20 | 21 | 67d→7d | Atorvastatina Krka 20 Mg | Castelo → Principal |
| 41,67 | 9 | 10 | 90d→6d | Metformina+Vildagliptina | Castelo → Principal |
| 40,48 | 4 | 5 | 113d→11d | Triplixam 10/2.5/5 Mg | Castelo → Principal |
| 39,90 | 6 | 7 | 81d→4d | Efexor XR 75 mg | Castelo → Principal |
| 39,32 | 2 | 5 | 36d→6d | Crestor 10 mg X60 | Principal → Castelo |
| 38,08 | 28 | 29 | 49d→3d | Furosemida Pharmakern 40 mg | Castelo → Principal |
| 35,52 | 12 | 13 | 41d→7d | Bilaxten 20 mg X20 | Principal → Castelo |
| 32,76 | 13 | 14 | 63d→6d | Clearblue Teste 1min | Castelo → Principal |
| 31,74 | 6 | 7 | 47d→7d | Fucidine 20 mg/g | Principal → Castelo |
| 31,56 | 4 | 4 | 41d→3d | Avene Cicalfate+ Creme | Principal → Castelo |
| 27,72 | 4 | 5 | 52d→8d | Omnic 0,4 mg X30 | Principal → Castelo |

Padrão: 1 produto (Forxiga) carrega 32% do valor evitável total.
Especialidade injectável (Mounjaro, Liraglutido) + análogos GLP-1
+ cardiovascular (Crestor, Atorvastatina) + sistema digestivo
(Edistride, Ezetimiba).

### 5.4 Top 20 por unidades transferíveis

| Qty | € | vel/dia | Produto | Sentido |
|---:|---:|---:|---|---|
| 46 | 17,48 | 4,54 | Nestle Naturnes Maca Ban Morang 90g 6m | Principal → Castelo |
| 32 | 13,12 | 8,30 | Nestle Naturnes Multifrutas 90g 6m | Principal → Castelo |
| 29 | 906,83 | 3,33 | Forxiga 10 Mg | Principal → Castelo |
| 28 | 38,08 | 2,32 | Furosemida Pharmakern 40 mg | Castelo → Principal |
| 20 | 43,20 | 2,59 | Atorvastatina Krka 20 Mg | Castelo → Principal |
| 18 | 48,60 | 1,74 | Nolotil 575 mg | Principal → Castelo |
| 13 | 27,04 | 1,46 | Bilastina Pharmakern 20 Mg | Castelo → Principal |
| 13 | 32,76 | 1,44 | Clearblue Teste 1minuto | Castelo → Principal |
| 12 | 35,52 | 1,49 | Bilaxten 20 mg | Principal → Castelo |
| 10 | 18,70 | 2,10 | Tromalyt 150 mg | Castelo → Principal |
| 9 | 47,52 | 0,69 | Ezetimiba Pharmakern 10 Mg | Castelo → Principal |
| 9 | 70,29 | 1,03 | Atyflor Saq X10 | Principal → Castelo |
| 9 | 1,44 | 5,70 | Nestle Naturnes Maca Manga 90g 6m | Principal → Castelo |
| 9 | 41,67 | 1,03 | Metformina+Vildagliptina | Castelo → Principal |
| 6 | 17,58 | 1,08 | Clearblue Teste 6 Dias | Castelo → Principal |
| 6 | 39,90 | 0,57 | Efexor XR 75 mg | Castelo → Principal |
| 6 | 31,74 | 0,82 | Fucidine | Principal → Castelo |
| 6 | 56,46 | 0,96 | Maltofer | Principal → Castelo |
| 6 | 12,30 | 0,80 | Perindopril+Indapamida Krka | Principal → Castelo |
| 5 | 82,00 | 0,73 | Daflon 1000 30 Comp. | Castelo → Principal |

Padrão: alimentação infantil Naturnes (Castelo precisa, Principal
tem excesso) + medicamentos com alta rotação que Castelo está a
quase rebentar (Furosemida vel=2,32/d, cov=3d).

---

## 6. Caveats e decisões

| # | Caveat | Mitigação |
|---|---|---|
| C1 | Substituição não considera diferenças de PVP/margem (Forxiga: mesmo preço em ambas; mas em produtos com PVP por farmacia, transferir afecta margem) | Aceitável nesta fase; flag manual override existe (gestor decide quantidade final) |
| C2 | Não respeita campanhas/bonificações de fornecedor (encomenda pode ter preço promocional que transferência elimina) | Sem dados de campanhas hoje. Documentado em `encomendas-data.ts` (`condicoesFornecedor: []`). Refinar quando dados existirem. |
| C3 | DCI-equivalente fora do scope — não detecta alternativas genéricas | Spec explícito — próxima iteração |
| C4 | `puc` pode ser null em ProdutoFarmacia → `avoidedPurchaseEstimate=0` | Fallback automático para puc da origem; quando ambos null, fica 0 € (informativo, não-bloqueante) |
| C5 | Reserve de 14d na origem pode ser excessiva para produtos de rotação alta (cov 33d - 14d = 19d transferível) | Configurável via threshold; default conservador |

---

## 7. O que NÃO foi feito (intencional)

- ❌ DCI-equivalente — fora do scope.
- ❌ Fluxo de criação de transferência — só recomendação visual.
- ❌ Alteração de pricing / fornecedor logic — preservado.
- ❌ Scheduler / job de refresh — Fase 1.5 já entregou; sem cron real.
- ❌ Remoção da legacy logic — `findInternalSubstitutions` é
  reutilizado, não duplicado. Fallback live continua activo.

---

## 8. Próxima decisão

Após este commit, há 3 caminhos naturais:

**A. Expor "Encomendas evitáveis" no dashboard.** Tile com
"X € evitáveis hoje · N artigos com transferência interna",
linkando para encomenda filtrada. Esforço: ~0,5 dia.

**B. DCI-equivalente.** Estender o detector para considerar
substitutos genéricos (mesmo `dci + dosagem + formaFarmaceutica`).
Maior impacto (mais candidatos), mas requer revisão clínica e novo
ciclo de testes. Esforço: ~1,5-2 dias.

**C. Fluxo de criação de transferência.** Botão "Criar
transferência" na linha → cria draft de movimento entre farmácias
(modelo `Transferencia` ainda não existe — precisaria de schema
addição). Esforço: ~2-3 dias + migration.

Recomendação técnica (não decisão): **A → B → C**. A torna o sinal
visível ao gestor sem precisar de abrir /encomendas. B amplia o
universo de oportunidades. C fecha o ciclo operacional. Não inicio
nada sem aprovação.

---

## 9. Comandos de validação

```bash
# Testes unitários (156 verdes)
npx tsx scripts/tests/test-encomendas-substitution.ts
npx tsx scripts/tests/test-internal-substitution.ts
npx tsx scripts/tests/test-operational-metrics.ts
npx tsx scripts/tests/test-ipf-freshness.ts

# Probe live (métricas operacionais)
npx tsx scripts/probe-encomendas-substitution.ts --top=20

# Probe com cobertura-alvo custom
npx tsx scripts/probe-encomendas-substitution.ts --target=30 --top=10

# Typecheck
npx tsc --noEmit
```

---

_Same-CNP only. Recomendação não-bloqueante. Sem writes. Sem
alteração de pricing/fornecedor logic. Lógica legacy preservada
como fallback._
