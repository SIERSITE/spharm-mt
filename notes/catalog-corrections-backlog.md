# Catalog Corrections — Backlog (não aplicar até autorização)

**Origem:** audit `notes/dci-atc-divergence-audit.md` (2026-05-11).
**Estado:** identificadas, **não aplicadas**. Aguardam decisão para
executar como tarefa de qualidade de dados isolada.

Estas 3 correcções são consequência directa do audit de divergência
ATC. Cada uma destranca estruturalmente pares no detector
DCI-equivalente, mas no snapshot actual nenhuma gera candidato
imediato (stock/sales não convergem). Justifica-se aplicar para
correcção do catálogo, não para uplift operacional imediato.

---

## 1. Psodermil pomada (CNP 9774109) — DCI incorrecta

| Campo | Valor actual | Valor proposto |
|---|---|---|
| `Produto.cnp` | 9774109 | (inalterado) |
| `Produto.designacao` | "Psodermil, 30/0,5 mg/g x 30 pomada" | (inalterado) |
| `Produto.dci` | **`Betametasona + Ácido salicílico`** | `Ácido salicílico` (a confirmar) |
| `Produto.codigoATC` | `D01AE12` | (inalterado — D01AE12 é coerente com monosubstance) |

**Razão:** o ATC D01AE12 (outros antifúngicos / queratolíticos para
psoríase) sugere que Psodermil contém apenas ácido salicílico. A DCI
"Betametasona + Ácido salicílico" foi provavelmente herdada por
similaridade textual com Diprosalic (CNP 9458323) durante o
enrichment. Diprosalic SIM tem betametasona; Psodermil aparenta NÃO
ter.

**Pré-requisito antes de corrigir:** verificar o folheto INFARMED de
Psodermil (CNP 9774109) para confirmar a composição real.

---

## 2. Momendol 100 Mg/g Gel (CNP 5359567) — ATC incorrecto

| Campo | Valor actual | Valor proposto |
|---|---|---|
| `Produto.cnp` | 5359567 | (inalterado) |
| `Produto.designacao` | "Momendol 100 Mg/g Gel" | (inalterado) |
| `Produto.dci` | `Naproxeno` | (inalterado) |
| `Produto.codigoATC` | **`M01AE02`** (oral) | `M02AA12` (tópico) |
| `Produto.formaFarmaceutica` | "Gel" | (inalterado — já coerente com tópico) |

**Razão:** Momendol gel está classificado com o código ATC do
naproxeno oral (M01AE02). Por ser uma forma gel, o código correcto é
M02AA12 (preparações tópicas anti-inflamatórias) — coincidente com
Reuxen gel (CNP 2173599), o outro produto naproxeno tópico do
catálogo. Os outros 11 Momendol/Reuxen orais continuam com M01AE02
correctamente.

**Impacto:** destranca pair Momendol gel ↔ Reuxen gel. Snapshot
actual: 0 candidato imediato (Momendol stock=0, Reuxen sales90d=4).

---

## 3. Vibrocil Actilongprotect (CNP 5752811) — ATC incorrecto

| Campo | Valor actual | Valor proposto |
|---|---|---|
| `Produto.cnp` | 5752811 | (inalterado) |
| `Produto.designacao` | "Vibrocil Actilongprotect 1 Mg/ml + 50 Mg/ml Sol. Para Pulv." | (inalterado) |
| `Produto.dci` | `Xilometazolina + Dexpantenol` | (inalterado) |
| `Produto.codigoATC` | **`D03AX03`** (cicatrizantes cutâneos) | `R01AB06` (descongestionantes nasais simpaticomiméticos) |
| `Produto.formaFarmaceutica` | "Solução para pulverização nasal" | (inalterado — coerente com R01) |

**Razão:** D03AX03 é categoria de cicatrizantes cutâneos, não tem
relação com uma solução de pulverização nasal. Septanazal e Nasex
Duo (mesma DCI, mesma forma, mesma dose) estão correctamente
classificados com R01AB06. Erro de catalogação INFARMED ou import
incorrecto.

**Impacto:** destranca pairs Vibrocil ↔ Septanazal e Vibrocil ↔ Nasex
(2 pares). Snapshot actual: 0 candidato imediato (nenhum dos 3
produtos em ruptura simultânea com excesso em outro).

---

## Execução proposta (quando autorizado)

1. Script idempotente `scripts/apply-catalog-corrections-2026-05.ts`
   com modo `--dry-run`:
   - Read `Produto` actual para cada CNP
   - Comparar com valores propostos
   - Em `--dry-run`, imprimir diff sem escrever
   - Em modo live, fazer `UPDATE` por CNP individual
   - Log JSON com cada mudança (campo, before, after, source)
2. Verificação pós-update: re-correr `audit-dci-atc-divergence.ts`
   e confirmar que os 4 pares (1 + 1 + 2) desaparecem do output.
3. Re-correr probe de encomendas integrado para confirmar 0 mudança
   nos candidatos finais (esperado).
4. Note manual no log que correcções vieram de audit operacional,
   não de fonte INFARMED — porque a fonte original ainda continha o
   erro.

**Esforço estimado:** ~30 min.

---

_Não aplicar sem autorização explícita. Aceitação do audit
recomendou tratar estas correcções como tarefa de qualidade de dados
isolada, fora do escopo da integração DCI-equivalente em encomendas._
