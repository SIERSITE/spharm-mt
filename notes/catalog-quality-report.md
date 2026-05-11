# Catalog Quality Report

**Gerado em:** 2026-05-11T07:56:30.048Z
**Origem:** read-only snapshot de `Produto` + `RegulatoryRecord` + `Classificacao`

## 1. Totais

| Métrica | Valor |
|---|---:|
| Produto vivos (estado ≠ INATIVO) | 14 762 |
| MEDICAMENTO (todos) | 7526 |
| MEDICAMENTO vivos | 7526 |
| MEDICAMENTO em "Outros Medicamentos" | 5805 (77.1%) |
| MEDICAMENTO com codigoATC | 438 (5.8%) |
| MEDICAMENTO com dci | 438 (5.8%) |
| MEDICAMENTO com formaFarmaceutica | 438 (5.8%) |
| MEDICAMENTO com dosagem | 438 (5.8%) |
| MEDICAMENTO com embalagem | 438 (5.8%) |
| MEDICAMENTO com imagemUrl | 1784 (23.7%) |
| MEDICAMENTO validadoManualmente=true | 0 (0.0%) |

## 2. Regulatory coverage

| Métrica | Valor |
|---|---:|
| Total RegulatoryRecord | 283 129 |
| RR com codigoATC | 1153 (0.4%) |
| RR com dci | 1153 (0.4%) |
| RR com formaFarmaceutica | 1153 (0.4%) |
| RR com dosagem | 1153 (0.4%) |
| RR com embalagem | 1153 (0.4%) |
| RR com grupoTerapeutico | 1153 (0.4%) |
| RR com titularAim | 279 950 (98.9%) |
| RR com estadoAim | 282 298 (99.7%) |
| **RegulatoryRecord ∩ Produto vivos (cnp match)** | **12 595** |
| **Produto vivos com RR clínico (ATC ou DCI)** | **449** |

## 3. Qualidade da classificação

### Distribuição MEDICAMENTO vivos por nivel2

| Nivel2 | N | % |
|---|---:|---:|
| Outros Medicamentos | 5805 | 77.1% |
| Cardiovascular | 539 | 7.2% |
| Sistema Nervoso | 265 | 3.5% |
| Analgésicos e Anti-inflamatórios | 170 | 2.3% |
| Sistema Digestivo | 146 | 1.9% |
| Diabetes | 81 | 1.1% |
| (sem nivel2) | 62 | 0.8% |
| Urológicos | 61 | 0.8% |
| Constipação, Tosse e Gripe | 50 | 0.7% |
| Respiratório | 48 | 0.6% |
| Outros Puericultura e Bebé | 48 | 0.6% |
| Oftálmicos | 47 | 0.6% |
| Pastas Dentífricas | 34 | 0.5% |
| Dermatológicos | 24 | 0.3% |
| Alergias | 23 | 0.3% |
| Alimentação do Bebé | 23 | 0.3% |
| Ginecológicos | 16 | 0.2% |
| Outros Capilar | 13 | 0.2% |
| Vitaminas e Minerais | 12 | 0.2% |
| Outros Saúde Natural | 11 | 0.1% |
| Antisséticos e Desinfetantes | 11 | 0.1% |
| Solar Adulto | 9 | 0.1% |
| Outros Veterinária | 6 | 0.1% |
| Digestão e Probióticos | 4 | 0.1% |
| Elixires | 4 | 0.1% |
| Outros Suplementos | 3 | 0.0% |
| Gatos | 2 | 0.0% |
| Otológicos | 2 | 0.0% |
| Nebulizadores | 2 | 0.0% |
| Desparasitação | 2 | 0.0% |
| Outros Dermocosmética | 1 | 0.0% |
| Imunidade | 1 | 0.0% |
| Outros Cosmética | 1 | 0.0% |

### Top 20 ATC prefixes (MEDICAMENTO vivos com ATC)

| ATC prefix | N | Nivel2 dominante (N) |
|---|---:|---|
| N05 | 62 | Sistema Nervoso (62) |
| N02 | 60 | Analgésicos e Anti-inflamatórios (60) |
| C09 | 47 | Cardiovascular (47) |
| C10 | 32 | Cardiovascular (32) |
| N06 | 30 | Sistema Nervoso (30) |
| B01 | 18 | Cardiovascular (18) |
| M01 | 18 | Analgésicos e Anti-inflamatórios (18) |
| N03 | 16 | Sistema Nervoso (16) |
| J02 | 12 | Outros Medicamentos (12) |
| H02 | 10 | Outros Medicamentos (10) |
| J01 | 10 | Outros Medicamentos (10) |
| G04 | 9 | Urológicos (9) |
| C03 | 7 | Cardiovascular (7) |
| A02 | 6 | Sistema Digestivo (6) |
| N04 | 6 | Sistema Nervoso (6) |
| N07 | 5 | Sistema Nervoso (5) |
| H03 | 5 | Outros Medicamentos (5) |
| A03 | 5 | Sistema Digestivo (5) |
| G03 | 5 | Ginecológicos (5) |
| M04 | 5 | Analgésicos e Anti-inflamatórios (5) |

### Rule gaps — MEDICAMENTO em "Outros Medicamentos" com ATC (total: 48)

| ATC prefix | N | Tipo | Sample DCI/designação |
|---|---:|---|---|
| J02 | 12 | known | Fluconazol |
| H02 | 10 | **NEW** | Metilprednisolona |
| J01 | 10 | known | Clindamicina |
| H03 | 5 | known | Levotiroxina sódica |
| P02 | 3 | **NEW** | Mebendazol |
| J05 | 3 | known | Aciclovir |
| A11 | 2 | known | Alfacalcidol |
| M05 | 2 | known | Ácido alendrónico + Colecalciferol |
| N01 | 1 | known | Lidocaína + Prilocaína |

## 4. Before / after vs baseline

| | Valor |
|---|---:|
| Baseline "Outros Medicamentos" (pré-pipeline) | 6195 |
| Actual "Outros Medicamentos" (live) | 5805 |
| Delta absoluto | -390 |
| Delta percentual | -6.3% |

---

_Regenerar este relatório: `npx tsx scripts/catalog-quality-report.ts`_
