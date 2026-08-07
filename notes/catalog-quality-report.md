# Catalog Quality Report

**Gerado em:** 2026-06-23T11:10:39.282Z
**Origem:** read-only snapshot de `Produto` + `RegulatoryRecord` + `Classificacao`

## 1. Totais

| Métrica | Valor |
|---|---:|
| Produto vivos (estado ≠ INATIVO) | 14 762 |
| MEDICAMENTO (todos) | 7526 |
| MEDICAMENTO vivos | 7526 |
| MEDICAMENTO em "Outros Medicamentos" | 2491 (33.1%) |
| MEDICAMENTO com codigoATC | 3977 (52.8%) |
| MEDICAMENTO com dci | 3980 (52.9%) |
| MEDICAMENTO com formaFarmaceutica | 3980 (52.9%) |
| MEDICAMENTO com dosagem | 3980 (52.9%) |
| MEDICAMENTO com embalagem | 3980 (52.9%) |
| MEDICAMENTO com imagemUrl | 1784 (23.7%) |
| MEDICAMENTO validadoManualmente=true | 0 (0.0%) |

## 1b. Não-medicamentos (cosmética, suplementos, dispositivos, alimentar, OUTRO)

| Métrica | Valor |
|---|---:|
| Total não-medicamento vivos | 7236 |
| Com classificação N2 | 3974 (54.9%) |
| Com fabricante/marca | 5346 (73.9%) |
| Com designação rica (>30 chars) | 5612 (77.6%) |
| Com imagem | 2626 (36.3%) |
| **Sem classificação** (productType OU N2 NULL) | **3324** (45.9%) |
| Validado manualmente | 0 (0.0%) |

### Distribuição por productType

| productType | N | % |
|---|---:|---:|
| (NULL) | 1921 | 26.5% |
| DERMOCOSMETICA | 1668 | 23.1% |
| OUTRO | 1441 | 19.9% |
| SUPLEMENTO | 641 | 8.9% |
| PUERICULTURA | 537 | 7.4% |
| HIGIENE_CUIDADO | 314 | 4.3% |
| DISPOSITIVO_MEDICO | 301 | 4.2% |
| ORTOPEDIA | 249 | 3.4% |
| VETERINARIA | 164 | 2.3% |

## 1c. Imagens (cross-cutting)

| Métrica | Valor |
|---|---:|
| Total Produto vivo | 14 762 |
| Com imagem | 4410 (29.9%) |
| **Sem imagem** | **10 352** (70.1%) |
| Com imagem — MEDICAMENTO | 1784 |
| Com imagem — não-medicamento | 2626 |

## 2. Regulatory coverage

| Métrica | Valor |
|---|---:|
| Total RegulatoryRecord | 283 337 |
| RR com codigoATC | 15 994 (5.6%) |
| RR com dci | 16 003 (5.6%) |
| RR com formaFarmaceutica | 16 003 (5.6%) |
| RR com dosagem | 16 003 (5.6%) |
| RR com embalagem | 16 003 (5.6%) |
| RR com grupoTerapeutico | 15 999 (5.6%) |
| RR com titularAim | 280 266 (98.9%) |
| RR com estadoAim | 282 506 (99.7%) |
| **RegulatoryRecord ∩ Produto vivos (cnp match)** | **12 621** |
| **Produto vivos com RR clínico (ATC ou DCI)** | **4171** |

## 3. Qualidade da classificação

### Distribuição MEDICAMENTO vivos por nivel2

| Nivel2 | N | % |
|---|---:|---:|
| Outros Medicamentos | 2491 | 33.1% |
| Cardiovascular | 1252 | 16.6% |
| Sistema Nervoso | 1042 | 13.8% |
| Analgésicos e Anti-inflamatórios | 521 | 6.9% |
| Sistema Digestivo | 354 | 4.7% |
| Dermatológicos | 222 | 2.9% |
| Ginecológicos | 215 | 2.9% |
| Diabetes | 205 | 2.7% |
| Urológicos | 184 | 2.4% |
| Anti-infecciosos | 179 | 2.4% |
| Oftálmicos | 162 | 2.2% |
| Respiratório | 158 | 2.1% |
| Constipação, Tosse e Gripe | 151 | 2.0% |
| Alergias | 72 | 1.0% |
| (sem nivel2) | 62 | 0.8% |
| Hormonas e Corticoides | 53 | 0.7% |
| Outros Puericultura e Bebé | 48 | 0.6% |
| Pastas Dentífricas | 34 | 0.5% |
| Alimentação do Bebé | 23 | 0.3% |
| Antisséticos e Desinfetantes | 19 | 0.3% |
| Outros Capilar | 13 | 0.2% |
| Vitaminas e Minerais | 12 | 0.2% |
| Outros Saúde Natural | 11 | 0.1% |
| Solar Adulto | 9 | 0.1% |
| Otológicos | 8 | 0.1% |
| Outros Veterinária | 6 | 0.1% |
| Digestão e Probióticos | 4 | 0.1% |
| Elixires | 4 | 0.1% |
| Outros Suplementos | 3 | 0.0% |
| Gatos | 2 | 0.0% |
| Nebulizadores | 2 | 0.0% |
| Desparasitação | 2 | 0.0% |
| Outros Dermocosmética | 1 | 0.0% |
| Imunidade | 1 | 0.0% |
| Outros Cosmética | 1 | 0.0% |

### Top 20 ATC prefixes (MEDICAMENTO vivos com ATC)

| ATC prefix | N | Nivel2 dominante (N) |
|---|---:|---|
| N06 | 345 | Sistema Nervoso (342) |
| C09 | 287 | Cardiovascular (287) |
| N05 | 270 | Sistema Nervoso (270) |
| N02 | 239 | Analgésicos e Anti-inflamatórios (239) |
| C10 | 236 | Cardiovascular (236) |
| G03 | 167 | Ginecológicos (166) |
| N03 | 157 | Sistema Nervoso (154) |
| M01 | 155 | Analgésicos e Anti-inflamatórios (155) |
| G04 | 144 | Urológicos (144) |
| A10 | 128 | Diabetes (128) |
| J01 | 127 | Anti-infecciosos (127) |
| R03 | 126 | Respiratório (123) |
| S01 | 115 | Oftálmicos (115) |
| B01 | 95 | Cardiovascular (95) |
| A02 | 74 | Sistema Digestivo (74) |
| N07 | 63 | Sistema Nervoso (63) |
| N04 | 52 | Sistema Nervoso (52) |
| R06 | 51 | Alergias (51) |
| D01 | 49 | Dermatológicos (49) |
| M02 | 47 | Analgésicos e Anti-inflamatórios (47) |

### Rule gaps — MEDICAMENTO em "Outros Medicamentos" com ATC (total: 180)

| ATC prefix | N | Tipo | Sample DCI/designação |
|---|---:|---|---|
| L04 | 34 | **NEW** | Ciclosporina |
| A11 | 22 | known | Carbonato de cálcio + Colecalciferol |
| B03 | 20 | known | Ácido fólico |
| M05 | 19 | known | Ácido alendrónico + Colecalciferol |
| L02 | 16 | **NEW** | Anastrozol |
| J07 | 16 | known | Vacina contra a hepatite A e a hepatite B |
| H01 | 15 | **NEW** | Desmopressina |
| A12 | 10 | known | Carbonato de cálcio |
| P01 | 6 | known | Mefloquina |
| V03 | 5 | known | N/A |
| P03 | 3 | known | Permetrina |
| B05 | 3 | **NEW** | Cloreto de sódio |
| H05 | 3 | **NEW** | Teriparatida |
| L01 | 2 | known | Metotrexato |
| B02 | 2 | known | Ácido aminocapróico |
| A16 | 2 | known | Levocarnitina |
| H04 | 1 | **NEW** | Glucagom |
| N01 | 1 | known | Benzocaína |

## 4. Before / after vs baseline

| | Valor |
|---|---:|
| Baseline "Outros Medicamentos" (pré-pipeline) | 6195 |
| Actual "Outros Medicamentos" (live) | 2491 |
| Delta absoluto | -3704 |
| Delta percentual | -59.8% |

---

_Regenerar este relatório: `npx tsx scripts/catalog-quality-report.ts`_
