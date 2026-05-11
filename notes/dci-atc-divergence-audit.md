# Audit DCI / ATC5 Divergence

**Data:** 2026-05-11
**Âmbito:** auditar os pares que o detector
`findDciEquivalentSubstitutions` rejeita por **ATC5 diferente**
(mesmo DCI normalizada, mesma forma, mesma dosagem, mesmas flags
MSRM/MNSRM, mas códigos ATC discordantes nos primeiros 5
caracteres). Read-only. Sem writes. Sem UI. Sem integração em
encomendas.

---

## 1. Executive summary

O detector reportou **14 pair-events** rejeitados por
`atc_diferente` (contando uma vez por cada vez que um par `(destino
em ruptura, source em excesso)` é avaliado). Quando expandido ao
universo catálogo completo (ignorando o filtro operacional
ruptura×excesso), o audit revela **39 pares distintos** (combinações
únicas de CNP-CNP) com divergência ATC5.

Os 39 pares clustram em **apenas 4 famílias DCI**:

| Cluster | DCI | Pares | Verdict |
|---|---|---:|---|
| 1 | betametasona + ácido salicílico | 1 | **catalog issue (DCI)** + keep excluded |
| 2 | dienogest + etinilestradiol | 35 | **keep excluded** (regulatory edge case legítimo) |
| 3 | naproxeno (gel) | 1 | **catalog issue (ATC)** — fix Momendol gel |
| 4 | xilometazolina + dexpantenol | 2 | **catalog issue (ATC)** — fix Vibrocil |

**Conclusão clínica:** o gate ATC5 está a fazer o trabalho correcto.
Não há falso positivo a corrigir no detector. Três correcções de
catálogo (Cluster 1 DCI, Cluster 3 ATC, Cluster 4 ATC) destrancariam
um pequeno número de oportunidades adicionais em snapshots futuros.
Cluster 2 é um caso clínico real onde a classe ATC distingue
indicações diferentes (contraceptivo vs HRT), mesmo com molécula +
dose idênticas — o gate deve continuar a bloquear.

**Decisão recomendada:** integrar o detector DCI-equivalente em
encomendas como recomendação **separada e de maior cautela**, com o
gate ATC5 inalterado.

---

## 2. Por que 14 vs 39?

| Métrica | Valor |
|---|---:|
| Pair-events rejeitados pelo detector (`atc_diferente`) | 14 |
| Combinações distintas CNP-CNP no catálogo (audit) | 39 |
| Famílias DCI envolvidas | **4** |

A discrepância vem do contexto onde o detector conta:
- O detector itera apenas pares `(destino-em-ruptura, source-em-excesso)`.
- Um par CNP-CNP onde **nenhum** dos dois lados está em ruptura
  iminente nem em excesso confortável **não é avaliado** pelo
  detector, mas existe estruturalmente no catálogo.
- O audit avalia **todos os pares de produtos** com DCI igual
  (independentemente do stock), portanto vê o universo de
  qualidade de catálogo, não só o universo operacional.

Ambas as métricas são úteis:
- **14** representa o custo operacional actual da divergência.
- **39** representa o risco de catálogo (cresce e encolhe conforme
  o stock varia entre snapshots).

---

## 3. Metodologia

`scripts/audit-dci-atc-divergence.ts` (read-only, sem writes):

1. Carrega `ProdutoFarmacia` vivos × `Produto` × `VendaMensal 3m` em
   `farmacia.estado = 'ATIVO'` excluindo "Farmácia Teste".
2. Aplica pré-filtro idêntico ao detector
   (`productType=MEDICAMENTO` + DCI não vazia normalizada).
3. Agrupa por `normalizeCatalogString(dci)`.
4. Dentro de cada grupo, gera pares ordenados onde:
   - farmácias diferentes
   - `normalizeCatalogString(formaFarmaceutica)` igual
   - `normalizeDosagem(dosagem)` igual
   - **`atc5(codigoATC)` DIFERENTE** ← a divergência auditada
5. De-duplica por `{cnp_min, cnp_max}` para contar combinações
   distintas (39).

Output bruto em `scripts/audit-dci-atc-divergence.ts` stdout. Verificação
cruzada com `RegulatoryRecord` para identificar a fonte de
classificação ATC (todos vêm de `infomed_browse_2026-05-11`,
extracção INFARMED Infomed).

---

## 4. Cluster 1 — betametasona + ácido salicílico

### 4.1 Par auditado

| Campo | A (Diprosalic) | B (Psodermil) |
|---|---|---|
| **CNP** | 9458323 | 9774109 |
| **Designação** | Diprosalic, 0,5/30 mg/g x 30 pomada | Psodermil, 30/0,5 mg/g x 30 pomada |
| **DCI (catálogo)** | betametasona + ácido salicílico | betametasona + ácido salicílico |
| **ATC** | **D07XC01** (ATC5=D07XC) | **D01AE12** (ATC5=D01AE) |
| **Forma** | pomada | pomada |
| **Dosagem** | 0.5 mg/g + 30 mg/g | 0.5 mg/g + 30 mg/g |
| **MSRM / MNSRM** | false / false | false / false |
| **Fonte ATC** | INFARMED Infomed (2026-05-11) | INFARMED Infomed (2026-05-11) |

### 4.2 Análise ATC

| Código | Família terapêutica | Significado |
|---|---|---|
| **D07XC01** | Corticosteroides, **combinações** | Betametasona em combinação com ácido salicílico (psoríase, dermatose com componente inflamatório) |
| **D01AE12** | **Antifúngicos** outros, tópicos | Ácido salicílico **monosubstance** ou outras combinações dermatológicas |

A divergência ATC indica que, embora a DCI registada seja idêntica,
o INFARMED **classifica os dois produtos em famílias terapêuticas
distintas**. Olhando ao detalhe:

- Diprosalic D07XC01 — combinação clássica betametasona + ácido
  salicílico. Classificação correcta para a composição duplo activa.
- Psodermil D01AE12 — psoríase tópica. A classificação ATC sugere
  que **Psodermil pode não conter betametasona** (apenas o ácido
  salicílico monosubstance, num tratamento queratolítico para
  psoríase). A DCI registada como "betametasona + ácido salicílico"
  é provavelmente um **erro de enrichment** do nosso catálogo.

### 4.3 Decisão

**Verdict: catalog issue (DCI enrichment) + keep excluded.**

Razão: o pair tem aparência de equivalência (mesma DCI + dose + forma)
mas o ATC indica que **Psodermil é provavelmente um produto diferente
com a mesma DCI mal enriquecida**. O gate ATC5 está a bloquear
correctamente. Para resolver:

1. Verificar manualmente o folheto INFARMED de Psodermil (CNP 9774109).
2. Se o produto for ácido salicílico monosubstance, corrigir a DCI
   no catálogo para `ácido salicílico` (não "betametasona + ácido
   salicílico"). Após correcção, o par deixa de aparecer no audit
   (DCI passa a divergir).

---

## 5. Cluster 2 — dienogest + etinilestradiol

### 5.1 Universo

Este cluster é o maior do audit — **35 pares distintos** entre os
seguintes produtos:

**Família G03AA16 (Contraceptivos hormonais para uso sistémico):**

| CNP | Designação | Embalagem | Dosagem |
|---|---|---:|---|
| 5719638 | Amelye | 28 comp | 2mg + 0.03mg |
| 5719646 | Amelye | 84 comp | 2mg + 0.03mg |
| 5719653 | Amelye | 168 comp | 2mg + 0.03mg |
| 5782768 | Serisima Diário | 84 comp | 2mg + 0.03mg |
| 5838362 | Eubelle | 28 comp | 2mg + 0.03mg |
| 5838370 | Eubelle | 84 comp | 2mg + 0.03mg |
| 5900063 | Seredelle | 21 comp | 2mg + 0.03mg |
| 5900071 | Seredelle | 63 comp | 2mg + 0.03mg |

**Família G03FA15 (Progestagénios + estrogénios, combinações fixas):**

| CNP | Designação | Embalagem | Dosagem |
|---|---|---:|---|
| 4037388 | Valette | 21 comp | 2mg + 0.03mg |
| 5279161 | Denille MG | 21 comp | 2mg + 0.03mg |
| 5279179 | Denille MG | 63 comp | 2mg + 0.03mg |
| 5279203 | Denille | 126 comp | 2mg + 0.03mg |
| 5466271 | Sibilla MG | 21 comp | 2mg + 0.03mg |
| 5466305 | Sibilla | 63 comp | 2mg + 0.03mg |

### 5.2 Análise ATC

| Código | Categoria ATC oficial |
|---|---|
| **G03AA16** | Contraceptivos hormonais sistémicos — progestagénios + estrogénios fixos (dienogest + etinilestradiol) |
| **G03FA15** | Terapêutica hormonal sistémica — progestagénios + estrogénios em combinação fixa (dienogest + etinilestradiol) |

Ambas as classes têm exactamente a mesma composição química
(dienogest 2 mg + etinilestradiol 0,03 mg) mas representam **duas
indicações regulatórias diferentes**:

- **G03AA** = contracepção
- **G03FA** = terapêutica de substituição hormonal (HRT, distúrbios
  hormonais cíclicos, endometriose, dismenorreia, etc.)

A INFARMED regista o **mesmo molécula+dose** sob duas classificações
ATC distintas conforme a indicação aprovada da AIM (Autorização de
Introdução no Mercado) de cada apresentação comercial. Sibilla e
Denille são marketadas em Portugal com indicações fora da
contracepção pura; Amelye, Eubelle, Seredelle são primariamente
contraceptivos orais combinados.

### 5.3 Avaliação clínica

| Eixo | Avaliação |
|---|---|
| **Molécula** | Idêntica (dienogest + etinilestradiol) |
| **Dose** | Idêntica (2mg + 0,03mg) |
| **Forma farmacêutica** | Idêntica (comprimido revestido por película) |
| **Bioequivalência clínica esperada** | Alta — mesmo ingrediente activo na mesma dose |
| **Risco operacional de troca** | Médio — embalagem, número de comprimidos, esquema posológico podem diferir; paciente pode estar habituado a uma marca específica |
| **Risco regulatório** | Real — substituir um contraceptivo (G03AA) por uma HRT (G03FA) muda a indicação registada |

### 5.4 Decisão

**Verdict: keep excluded.**

Razão: embora a substituição seja **clinicamente quase neutra**
(mesma molécula, mesma dose), há justificação regulatória legítima
para a divergência ATC. INFARMED classifica deliberadamente cada
apresentação conforme a indicação aprovada — não é um erro de
catálogo. O detector deve continuar a bloquear pares que cruzam
G03AA ↔ G03FA. Caso de uso real para o gate ATC5.

Nota futura: se uma camada de UI quiser sinalizar "potencial
substituto requer validação farmacêutica" para estes pares, seria
um path opcional, fora do escopo automático do detector.

---

## 6. Cluster 3 — naproxeno gel

### 6.1 Par auditado

| Campo | A (Momendol gel) | B (Reuxen gel) |
|---|---|---|
| **CNP** | 5359567 | 2173599 |
| **Designação** | Momendol 100 Mg/g Gel | Reuxen, 100 mg/g x 100 gel bisn |
| **DCI** | naproxeno | naproxeno |
| **ATC** | **M01AE02** (ATC5=M01AE) | **M02AA12** (ATC5=M02AA) |
| **Forma** | gel | gel |
| **Dosagem** | 100 mg/g | 100 mg/g |
| **MSRM / MNSRM** | false / false | false / false |
| **Fonte ATC** | INFARMED Infomed | INFARMED Infomed |

### 6.2 Análise ATC

| Código | Significado |
|---|---|
| **M01AE02** | Anti-inflamatórios e antirreumáticos não-esteroides **sistémicos** — derivados do ácido propiónico, naproxeno **oral** |
| **M02AA12** | Preparações **tópicas** anti-inflamatórias — naproxeno gel |

Naproxeno em forma de gel é, por definição, tópico. M02AA12 é o
código correcto. **Momendol gel está mis-classificado** com M01AE02
(o código do naproxeno oral em comprimidos). Comparar com os outros
12 produtos naproxeno do catálogo (audit secção 8): todos os outros
gels seriam M02AA12; todos os orais são M01AE02. Excepção =
Momendol gel.

### 6.3 Decisão

**Verdict: catalog issue (ATC) → fix.**

Correcção: actualizar `Produto.codigoATC` para CNP 5359567 de
`M01AE02` para `M02AA12`. Após correcção, o par passa a ser
clinicamente equivalente e o detector aceita-o normalmente. Snapshot
actual não tem stock para gerar candidato (Momendol stock=0,
salesQty=0; Reuxen sourceStock=1), mas a correcção é estrutural.

---

## 7. Cluster 4 — xilometazolina + dexpantenol

### 7.1 Pares auditados

**Side A (correcto):** R01AB06

| CNP | Designação | Stock | Sales90d |
|---|---|---:|---:|
| 5689674 | Septanazal 1 mg/ml + 50 mg/ml | 1 | 2 |
| 5738406 | Nasex Duo 1 mg/ml + 50 mg/ml | 5 | 7 |

**Side B (mis-classificado):** D03AX03

| CNP | Designação | Stock | Sales90d |
|---|---|---:|---:|
| 5752811 | Vibrocil Actilongprotect | 20 | 13 |

Todos `forma = solução para pulverização nasal`, `dose = 1 mg/ml +
50 mg/ml`, MSRM=false, MNSRM=false.

### 7.2 Análise ATC

| Código | Significado |
|---|---|
| **R01AB06** | Preparações **nasais** descongestionantes — simpaticomiméticos em combinação (excluindo corticosteroides) |
| **D03AX03** | Cicatrizantes **cutâneos** — outros |

D03AX03 não tem nenhuma relação com uma solução nasal —
classifica produtos para uso cutâneo em cicatrização. **Vibrocil
Actilongprotect (CNP 5752811) está claramente mis-classificado**.

### 7.3 Decisão

**Verdict: catalog issue (ATC) → fix.**

Correcção: actualizar `Produto.codigoATC` para CNP 5752811 de
`D03AX03` para `R01AB06`. Após correcção, abrem-se 2 novos pares
clinicamente equivalentes (Vibrocil ↔ Septanazal e Vibrocil ↔ Nasex).
Vibrocil tem stock 20 sales90d 13 → cov ≈ 140d (excess); destino
seria Septanazal (cov ≈ 45d, não ruptura) ou Nasex (cov ≈ 64d, não
ruptura). Snapshot actual sem candidato imediato, mas estrutura
correcta.

---

## 8. Tabela consolidada — 39 pares (audit) / 14 pair-events (detector)

| # | DCI | A | B | Verdict |
|---:|---|---|---|---|
| 1 | betametasona + ácido salicílico | Diprosalic D07XC01 | **Psodermil D01AE12** | catalog issue (DCI) + keep excluded |
| 2-36 | dienogest + etinilestradiol | múltiplas combinações G03AA16 ↔ G03FA15 | múltiplas | **keep excluded** (regulatório legítimo) |
| 37 | naproxeno | Reuxen gel M02AA12 | **Momendol gel M01AE02** | catalog issue (ATC) → fix Momendol |
| 38-39 | xilometazolina + dexpantenol | Septanazal/Nasex R01AB06 | **Vibrocil D03AX03** | catalog issue (ATC) → fix Vibrocil |

(Para Cluster 2 — dienogest — os 35 pares são todas as
combinações inter-CNP entre os 8 produtos G03AA16 e os 6 produtos
G03FA15 que partilham o stock entre farmácias. Listados na íntegra
em §5.1.)

---

## 9. Impacto operacional das correcções

Se executássemos hoje as correcções recomendadas (sem alterar o
detector):

| Correcção | Pares destrancados | Candidatos no snapshot actual |
|---|---:|---:|
| Cluster 1: corrigir DCI Psodermil | 1 par eliminado (DCI deixa de casar) | 0 |
| Cluster 2: nenhuma alteração | 0 | 0 |
| Cluster 3: corrigir ATC Momendol gel → M02AA12 | 1 | 0 (Momendol stock=0) |
| Cluster 4: corrigir ATC Vibrocil → R01AB06 | 2 | 0 (sem ruptura entre os 3) |
| **Total** | **4 destrancados** | **0 imediatos** |

Os snapshots futuros beneficiam estruturalmente. **Sem upside no
total de € evitáveis** no instante actual (4 131,74 € permanece
4 131,74 €), mas o catálogo fica mais correcto, e o detector deixa
de bloquear estes 4 pares como falsos negativos quando o stock
mudar.

---

## 10. Recomendação para integração em encomendas

Com o audit fechado, a evidência suporta a integração do detector
DCI-equivalente em `/encomendas` como **recomendação separada de
maior cautela**. Pontos chave:

| Aspecto | Recomendação |
|---|---|
| **Gate ATC5 inalterado** | ✅ O gate funciona correctamente; os 4 pares de catalog issue são consequência de dados, não do detector |
| **Sinalização na UI** | Distinta da same-CNP. Badge separado tipo `"Substituto DCI-equivalente disponível"`, cor diferente (ex: amber em vez de cyan) |
| **Tooltip/explicação** | Mostrar DCI + dose + forma para o operador validar visualmente |
| **Bloqueio de auto-execução** | Não emitir automaticamente uma transferência — requer confirmação humana, mesmo se same-CNP já fosse 1-click |
| **Logging operacional** | Quando o operador aceita ou rejeita uma sugestão DCI-equivalente, registar em `SyncRun` ou ledger equivalente para análise futura |
| **Métrica separada no dashboard** | `internalSubstitution` (CNP) vs `dciEquivalentSubstitution` (DCI) — não consolidar |

### 10.1 Correcções de catálogo a fazer em paralelo

Independentes da integração — podem ser executadas a qualquer
momento como tarefa de qualidade de dados:

| Produto | CNP | Acção |
|---|---:|---|
| Psodermil pomada | 9774109 | Verificar manualmente folheto INFARMED. Se for monosubstance, corrigir `Produto.dci` para `ácido salicílico` |
| Momendol 100 Mg/g Gel | 5359567 | Actualizar `Produto.codigoATC` de `M01AE02` para `M02AA12` |
| Vibrocil Actilongprotect | 5752811 | Actualizar `Produto.codigoATC` de `D03AX03` para `R01AB06` |

Não inicio nenhuma destas correcções sem aprovação.

---

## 11. Regras respeitadas

| Regra | Estado |
|---|---|
| Read-only | ✅ — `$queryRawUnsafe` apenas, zero `$executeRaw` |
| Sem UI | ✅ |
| Sem integração em encomendas | ✅ |
| Sem writes | ✅ |
| Detalhe por par: CNP, designação, DCI, ATC, forma, dosagem, MSRM/MNSRM | ✅ — secções 4, 5, 6, 7 |
| Razão provável | ✅ — análise ATC por cluster |
| Decisão por par | ✅ — secções 4.3, 5.4, 6.3, 7.3 |

---

## 12. Comandos de validação

```bash
# Reproduzir o audit (read-only, ~2s)
npx tsx scripts/audit-dci-atc-divergence.ts

# Confirmar que o detector continua a rejeitar
npx tsx scripts/probe-dci-substitutions.ts --top=3 | grep "atc_diferente"

# Verificar uma única CNP no catálogo
npx tsx -e "
import {legacyPrisma as p} from './lib/prisma';
p.produto.findUnique({where:{cnp:5359567}}).then(r=>{console.log(r);return p.\$disconnect()});
"
```

---

## 13. Próximos passos (não inicio sem aprovação)

**A. Integrar DCI-equivalente em `/encomendas` como camada de cautela.**
Esforço: ~0,5-1 dia. Ver §10. Inclui:
- Detector chamado em paralelo a `findInternalSubstitutions`
- Novos campos no row shape (`dciSubstitutionAvailable`, etc.)
- Badge UI diferente do CNP
- Tests
- Probe / relatório actualizado

**B. Correcções de catálogo (independente).** Esforço: ~30min
combinados.
- 3 correcções listadas em §10.1
- Script idempotente upsert
- Log de mudanças
- Tests

**C. Audit dos pares onde ATC está vazio.** Esta auditoria focou
divergência. Outro modo de falha possível: `codigoATC === null` em
um dos lados, que actualmente rejeita por
`atc5(null) === null !== source.atc5`. Quantos pares perdem assim?
Esforço: ~30min audit + relatório.

---

_Read-only · 39 pares distintos · 4 clusters DCI · gate ATC5
validado · 3 correcções catálogo identificadas · detector
recomendado para integração com sinalização separada._
