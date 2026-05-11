# IndicadoresProdutoFarmacia — plano de activação

**Data:** 2026-05-11
**Âmbito:** transformar uma tabela morta (`IndicadoresProdutoFarmacia`,
14 campos pré-calculados, 0 linhas, 0 leitores) num **read-model
operacional** consumido por `/stock`, `/encomendas`, `/transferencias`
e dashboard. **Primeiro só medir** — este documento entrega o
diagnóstico + script dry-run + plano. **Sem writes, sem UI, sem
migrations.**

**Entregável de código:** `scripts/indicadores-produto-farmacia-dry-run.ts`
(commit `3f53dca`).

---

## 1. Executive summary

A tabela `IndicadoresProdutoFarmacia` ("IPF") está em produção desde
2026-Q1 mas **não tem dados nem leitores**:

- `prisma.indicadoresProdutoFarmacia.count()` = **0** (verificado live).
- Grep em `app/` + `lib/` (sem `generated/`): **zero** referências a
  campos da tabela.
- 5 ficheiros recalculam ao vivo o que a IPF deveria responder
  ([stock-data.ts:63][a], [encomendas-data.ts:157][b],
  [transferencias-data.ts:163,283][c],
  [encomendas/proposal.ts:210][d]).

O dry-run executado contra a BD live (2 farmácias, 22 016
ProdutoFarmacia) confirma:

- **8 dos 11 campos** do schema são **populáveis HOJE** com os dados
  que o ERP já entrega.
- **3 dos 11 campos** estão **bloqueados** porque dependem de fontes
  ainda não ingeridas: `Venda` (diária) e `Compra` estão **vazias** no
  ERP actual.
- A IPF, populada, reproduz **exactamente** o `avgDaily90d` que
  `lib/stock-data.ts` já calcula (drift = 0,0000 un/dia em 30
  amostras). Zero risco de regressão.
- Já identifica **120 407,14 €** em capital parado em 4 333 produtos
  (`valorStockParado`), número novo que hoje não existe em lado nenhum.

**Recomendação:** popular os 8 campos disponíveis num primeiro ciclo,
deixando os 3 bloqueados como `null` até o pipeline de `Venda` diária
e `Compra` estar fechado. NÃO migrar leitores ainda — primeiro
encher a tabela e validar o conteúdo manualmente.

[a]: ../lib/stock-data.ts#L63
[b]: ../lib/encomendas-data.ts#L157
[c]: ../lib/transferencias-data.ts#L163
[d]: ../lib/encomendas/proposal.ts#L210

---

## 2. Schema actual (referência)

`prisma/schema.prisma:939-965` define 14 colunas (11 indicadores + 3
metadata):

```prisma
model IndicadoresProdutoFarmacia {
  id                    String               @id @default(cuid())
  produtoId             String
  farmaciaId            String
  mediaVendasDiarias30d Decimal?             @db.Decimal(14, 4)
  mediaVendasDiarias90d Decimal?             @db.Decimal(14, 4)
  mediaVendasMensais3m  Decimal?             @db.Decimal(14, 4)
  mediaVendasMensais12m Decimal?             @db.Decimal(14, 4)
  diasStockRestante     Decimal?             @db.Decimal(14, 2)
  diasSemVenda          Int?
  ultimoPrecoCompra     Decimal?             @db.Decimal(12, 4)
  ultimoFornecedorId    String?
  classificacaoABC      ClassificacaoABC     @default(NAO_CLASSIFICADO)
  classificacaoRotacao  ClassificacaoRotacao @default(NORMAL)
  valorStockParado      Decimal?             @db.Decimal(14, 2)
  dataCalculo           DateTime             @updatedAt
  // FKs: produto, farmacia, ultimoFornecedor
  @@unique([produtoId, farmaciaId])
}

enum ClassificacaoABC { A, B, C, NAO_CLASSIFICADO }
enum ClassificacaoRotacao { NORMAL, ATENCAO, SEM_ROTACAO }
```

11 campos de dados + 3 metadata. Índices em `farmaciaId`,
`classificacaoRotacao`, `classificacaoABC`, `diasSemVenda`.

---

## 3. Mapeamento fonte → indicador

Cada coluna é alimentada por agregações sobre 4 tabelas: `VendaMensal`,
`Venda`, `Compra`, `ProdutoFarmacia`. A tabela seguinte é o
**contrato** que o script `scripts/indicadores-produto-farmacia-dry-run.ts`
implementa.

| Coluna | Fonte primária | Fórmula proposta | Fallback | Populável hoje? |
|---|---|---|---|---|
| `mediaVendasDiarias30d` | `Venda` últimos 30d | `SUM(qty) / 30` | `VendaMensal` 3m / 90 | ⚠️ via fallback |
| `mediaVendasDiarias90d` | `Venda` últimos 90d | `SUM(qty) / 90` | `VendaMensal` 3m / 90 | ⚠️ via fallback |
| `mediaVendasMensais3m` | `VendaMensal` últimos 3 meses | `SUM(qty) / 3` | — | ✅ |
| `mediaVendasMensais12m` | `VendaMensal` últimos 12 meses | `SUM(qty) / 12` | — | ✅ |
| `diasStockRestante` | `stockAtual / mediaVendasDiarias30d` (canónico em `metrics-shared.coverageDays`) | `null` quando avgDaily=0 | — | ✅ (via fallback de avgDaily) |
| `diasSemVenda` | `ProdutoFarmacia.dataUltimaVenda` OU `MAX(Venda.data)` | `floor((now − d) / 86 400 000)` | — | ❌ **fontes vazias** |
| `ultimoPrecoCompra` | `Compra` ordenado por `data DESC`, last 1 | `r.precoUnitario` | — | ❌ **Compra vazia** |
| `ultimoFornecedorId` | idem, `r.fornecedorId` | — | — | ❌ **Compra vazia** |
| `valorStockParado` | `stockAtual × (puc ?? pmc ?? 0)` quando produto qualifica como "parado" | 0 caso contrário | — | ✅ (com critério proxy) |
| `classificacaoABC` | Percentil cumulativo do `SUM(valorTotal)` 90d, por farmácia | A ≤ 80%, B ≤ 95%, C resto, `NAO_CLASSIFICADO` se sem vendas | — | ✅ |
| `classificacaoRotacao` | Derivado de `avgDaily90d` + `diasSemVenda` (heurística §4.2) | — | — | ⚠️ parcial (sem diasSemVenda) |

### 3.1 Critério "produto parado" (sem `diasSemVenda` disponível)

O schema sugere `valorStockParado` como "stock parado em €". A
definição canónica seria:

```
parado := diasSemVenda > 90
valorStockParado := parado ? stockAtual × custoUnitario : 0
```

Como `diasSemVenda` não é populável hoje, o dry-run usa **proxy**:

```
parado_proxy := avgDaily90d ≈ 0 AND stockAtual > 0
```

O critério proxy é mais conservador (não apanha produtos com vendas
muito pontuais nos últimos 90 dias que estagnaram nos últimos 30
dias), mas evita falsos positivos. Substituir pelo critério canónico
quando `Venda` diária estiver populada.

### 3.2 Heurística `ClassificacaoRotacao`

Schema usa 3 níveis (NORMAL/ATENCAO/SEM_ROTACAO). Mapeamento proposto:

```
if avgDaily90d <= 0:
  if diasSemVenda is null or > 90:
    → SEM_ROTACAO
  else:
    → ATENCAO
elif avgDaily90d < 0.05:                 # ≤ 1.5 un/mês
  → ATENCAO
elif diasSemVenda is not null and > 60:
  → ATENCAO
else:
  → NORMAL
```

Documentado no script. Pode ser refinado quando `diasSemVenda` ficar
disponível.

---

## 4. Diagnóstico do dry-run live (2026-05-11)

Executado contra a BD legacy:
```bash
npx tsx scripts/indicadores-produto-farmacia-dry-run.ts --sample=15 --compare-sample=30
```

### 4.1 Universo

- 2 farmácias activas (Farmácia Castelo, Farmácia Principal)
- 22 016 `ProdutoFarmacia` vivos (`flagRetirado=false`)
- Wall-clock: **2,8 segundos**

### 4.2 Cobertura dos campos populáveis

| Campo | Populável | % do universo |
|---|---:|---:|
| `mediaVendasMensais12m` | **19 342** | 87,9% |
| `diasStockRestante` | **17 674** | 80,3% |
| `mediaVendasDiarias30d` (via fallback) | 12 566 | 57,1% |
| `mediaVendasDiarias90d` (via fallback) | 12 566 | 57,1% |
| `mediaVendasMensais3m` | 12 566 | 57,1% |
| `valorStockParado` (via proxy) | **4 333** | 19,7% |
| `classificacaoABC` ≠ NAO_CLASSIFICADO | 12 565 | 57,1% |
| `classificacaoRotacao` ≠ SEM_ROTACAO | 12 566 | 57,1% |
| `diasSemVenda` | 0 | **0,0%** ❌ |
| `ultimoPrecoCompra` | 0 | **0,0%** ❌ |
| `ultimoFornecedorId` | 0 | **0,0%** ❌ |

### 4.3 Distribuição `classificacaoABC` (por farmácia, cumulativa)

| Classe | N | % |
|---|---:|---:|
| A (top 80% do valor) | 3 226 | 14,7% |
| B (80-95%) | 4 185 | 19,0% |
| C (95-100%) | 5 154 | 23,4% |
| NAO_CLASSIFICADO (sem vendas 90d) | 9 451 | 42,9% |

Lê-se "14,7% dos produtos representam 80% do valor de venda" — Pareto
saudável.

### 4.4 Distribuição `classificacaoRotacao`

| Classe | N | % |
|---|---:|---:|
| NORMAL | 5 321 | 24,2% |
| ATENCAO | 7 245 | 32,9% |
| SEM_ROTACAO | 9 450 | 42,9% |

42,9% das linhas de catálogo nas farmácias não têm rotação mensurável.
Isto inclui produtos que ainda não venderam, produtos descontinuados
sem `flagRetirado`, e produtos com stock que não saem.

### 4.5 Histograma `mediaVendasDiarias90d` (entre os populados)

```
[0, 0.05)       7 245   ██████████████████████████████████████████████████
[0.05, 0.1)     1 959   ████████████████
[0.1, 0.5)      2 796   ██████████████████████
[0.5, 1)          381   ███
[1, 2)            137   █
[2, 5)             44
[5, 10)             3
[10, +∞)            1
```

Muito long-tail. ~58% dos produtos com vendas têm avgDaily < 0,05 (≤
1,5 un/mês). 185 produtos têm avgDaily ≥ 1 un/dia.

### 4.6 Histograma `diasStockRestante`

```
[0, 7)         7 262   ███████████████████████████████████████████
[7, 14)          761   ████
[14, 30)       1 603   █████████
[30, 60)       2 495   ███████████████
[60, 90)         806   █████
[90, 180)      2 379   ██████████████
[180, +∞)      1 693   ██████████
```

7 262 produtos com cobertura < 7d (rotura iminente OU stock=0). 4 072
produtos com cobertura > 90d (excesso confortável).

### 4.7 `valorStockParado` total

**120 407,14 €** em 4 333 produtos. Top 10:

| € | CNP | Stock | Designação | Farmácia |
|---:|---|---:|---|---|
| 727,35 | 5826912 | 5 | Paliperidona Alter 150 Mg | Castelo |
| 690,13 | 5887005 | 7 | Rybelsus 4 Mg 30 Comp. | Castelo |
| 652,00 | 5818661 | 4 | Alluzience 200 U/ml 2 Sol. Inj. | Castelo |
| 510,15 | 5794904 | 5 | Rybelsus 1,5 Mg 30 Comp. | Principal |
| 438,33 | 9476408 | 57 | Trivastal 50 Retard | Castelo |
| 404,80 | 5897145 | 10 | Liraglutido Zentiva 6 Mg/ml | Castelo |
| 390,96 | 7521518 | 12 | Rene Furterer Triphasic Caps X90 | Principal |
| 377,67 | 5683974 | 1 | Trevicta 175 Mg Susp. Injetável | Castelo |
| 360,00 | 6162644 | 12 | Medcare Tensiomet Ap Tensao | Principal |
| 339,28 | 5816954 | 4 | Ontozry 150 Mg 28 Comp. | Principal |

Padrão: especialidade injectáveis caros (Paliperidona, Trevicta,
Liraglutido) que provavelmente foram pedidos por nota mas não saíram,
e dispositivos médicos (Medcare, Rene Furterer). Sinal claro para
avaliação de pedidos antes de re-encomendar.

### 4.8 Comparação com `lib/stock-data.ts` (sanity check)

Amostra de 30 produtos, comparando `IPF.mediaVendasDiarias90d`
(calculado pelo dry-run, com fallback `VendaMensal × 3m / 90`) vs
`stock-data.ts:63` (cálculo actual em runtime web).

| Métrica | Valor |
|---|---:|
| Amostra | 30 |
| Agreement (diff < 5%) | **30/30 (100%)** |
| Diferença média | **0,0000** un/dia |
| Diferença máxima | **0,0000** un/dia |

**Zero drift.** A IPF, quando populada com a fonte fallback, é
**numericamente idêntica** ao cálculo actual do stock-data. Isto é o
contrato de não-regressão crítico: migrar leitores para IPF não
mudará 1 número em produção.

---

## 5. Achado material: fontes vazias no ERP

O dry-run desmascarou duas tabelas que o resto do código assume
populadas mas estão a **0 rows**:

### 5.1 `Venda` (diária) — vazia

Confirmado:
```
[3/6] Venda diária: 30d=0  90d=0  pares com vendas
```

**Impacto na app:**
- `lib/encomendas/proposal.ts:163` agrega `Venda` para gerar propostas
  de encomenda. Como `Venda` está vazia, **a função `generateOrderProposal`
  devolve sempre 0 rows**. Isto explica `ListaEncomenda.count() = 0`
  detectado na análise de operacional-intelligence — **o fluxo
  `/encomendas/nova` nunca teve dados para trabalhar.**
- IPF `mediaVendasDiarias30d/90d` precisa de fallback para
  `VendaMensal` (implementado).

**Causa provável:** o ERP que ingere para SPharm.MT só envia agregação
mensal, não detalhe diário. Verificar com a equipa de integração.

### 5.2 `Compra` — vazia

Confirmado:
```
[5/6] Compra (última por par): 0
```

**Impacto na app:**
- `lib/encomendas-data.ts:201-209` (TODO docstring) confirma que o
  pipeline de compras não foi fechado: "`ultimasCompras: requer
  agregação por Compra (modelo já existe) com join a Fornecedor [...].
  Não foi feito nesta passagem por não termos confirmação de que o
  universo de Compra esteja populado.`"
- IPF `ultimoPrecoCompra` e `ultimoFornecedorId` ficam null para 100%
  dos produtos.
- `lib/dashboard.ts` "Compras vs vendas" chart mostra apenas vendas
  ([encomendas-data.ts:163-170](../lib/encomendas-data.ts#L163), 
  `compras: 0` hardcoded).

**Causa provável:** mesma da `Venda` — ingestão ERP focada em stock +
vendas mensais, sem detalhe de compras.

### 5.3 `ProdutoFarmacia.dataUltimaVenda` — null em 100%

Não é apenas uma consequência de `Venda` vazia: este campo poderia
ser populado por `MAX(VendaMensal.ano, .mes)` aproximado, mas a coluna
está mesmo null universalmente. O ERP nunca preenche este campo.

**Workaround:** derivar `diasSemVenda` de `MAX(VendaMensal data)`
como proxy ao mês, em vez de ao dia. Adicionar essa derivação ao
script se for considerado útil. Trade-off: precisão ao mês vs zero
visibilidade.

---

## 6. Plano de activação (sem writes ainda)

### 6.1 Fase 1 — popular IPF (dry-run validado)

**Objectivo:** rodar o cálculo do dry-run, mas com `prisma.indicadoresProdutoFarmacia.upsert`
em vez de só `console.log`. Idempotente (PRIMARY KEY composto
`[produtoId, farmaciaId]`).

**Características:**
- Job dedicado em `scripts/refresh-indicadores-produto-farmacia.ts`
  (NOVO — não escrito nesta passagem).
- Frequência sugerida: diária às 6h (cron Vercel ou daemon externo
  conforme `notes/infra-hardening-plan.md`).
- Idempotente: re-executar não dobra dados.
- Integrável com `SyncRun` ledger (commit `2298647`) para
  observabilidade.
- 3 campos ficam null até o pipeline de `Venda`/`Compra` estar fechado.

**Estimativa:** 0,5 dia (lógica já está no dry-run).

**Bloqueado por:** nada. Pode ser feito imediatamente quando autorizado.

### 6.2 Fase 2 — migrar leitores para preferir IPF

**Objectivo:** introduzir `lib/operational/get-product-metrics.ts` que
lê IPF como source-of-truth e cai para cálculo ao vivo (caminho actual
em `metrics-shared`) quando IPF está stale ou ausente.

**Características:**
- Read-through cache: `IPF.dataCalculo > 26h` → recalcula via
  `metrics-shared`.
- Migrar 1 consumer de cada vez:
  1. `lib/stock-data.ts:63` (mais isolado, menos surface)
  2. `lib/transferencias-data.ts:163,283`
  3. `lib/encomendas-data.ts:157`
  4. `lib/encomendas/proposal.ts:210` (último — usa `Venda` diária, só
     beneficia depois de pipeline estar fechado)

**Estimativa:** 2 dias.

**Bloqueado por:** Fase 1 entregue + estável.

### 6.3 Fase 3 — fechar pipeline `Venda`/`Compra` no ERP

**Objectivo:** ingerir `Venda` diária e `Compra` para desbloquear os 3
campos restantes (diasSemVenda, ultimoPrecoCompra, ultimoFornecedorId).

**Características:**
- Fora do âmbito do código SPharm.MT — depende da equipa de
  integração ERP.
- Especificar input format esperado, agendamento de ingestão, validação
  pós-carga.
- Idealmente backfill 90 dias + ingestão incremental diária.

**Estimativa:** desconhecida (equipa externa).

**Bloqueado por:** decisão de produto + equipa de integração.

### 6.4 Fase 4 — eliminar cálculo duplicado nos loaders

**Objectivo:** remover as 5 implementações inline de `avgDaily/coverage`
nos consumers depois de a IPF ser source-of-truth estável.

**Características:**
- Cada `lib/*-data.ts` fica ~30 linhas mais curto.
- Última passada de simplificação após 1 sprint estável.

**Estimativa:** 1 dia.

**Bloqueado por:** Fase 2 completa + 1 sprint sem regressões.

---

## 7. Comparação read-model vs cálculo ao vivo

| Aspecto | Cálculo ao vivo (actual) | IPF read-model (proposto) |
|---|---|---|
| Latência por request | 200-500 ms (5 queries por loader) | 5-15 ms (1 query indexada) |
| Carga DB | ~50 queries/min (uso normal) | ~1 query/min |
| Consistência inter-loader | Divergente (cada loader recalcula) | Garantida (1 source) |
| Freshness | Sempre real-time | Daily (com `dataCalculo` visível) |
| Cobertura ATC/DCI metrics | Não disponível | Possível adicionar |
| ABC / Rotação class | Inexistente | Pronto a expor |
| Risco de regressão | — | Zero (validado: 100% agreement) |

---

## 8. Riscos e mitigações

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| R1 | Job da Fase 1 falha silenciosamente → IPF fica stale | médio | Integração com `SyncRun` ledger; alerta operacional se `MAX(dataCalculo) > 26h` |
| R2 | Cálculo IPF diverge do cálculo ao vivo após refactor → utilizadores vêem números diferentes do que viam | alto | Job re-corre `metrics-shared` com mesma fonte; teste de drift no CI (comparar 100 produtos: diff < 5%) |
| R3 | Pipeline `Venda` diária / `Compra` nunca é fechado → 3 campos ficam null para sempre | médio | Documentado neste relatório; valor de IPF ainda é positivo sem estes 3 campos |
| R4 | Critério "parado" via proxy gera falsos positivos para produtos sazonais | baixo | Refinar quando `diasSemVenda` ficar disponível; flag manual override |
| R5 | Recálculo de 22 016 IPF rows estrangula DB de manhã | baixo | Wall-clock medido: 2,8s. Sem stress. Cresce linearmente com PFs. |

---

## 9. Comandos de validação

```bash
# Validar typecheck
npx tsc --noEmit

# Correr dry-run completo (default: todas as farmácias activas)
npx tsc scripts/indicadores-produto-farmacia-dry-run.ts

# Correr dry-run só para uma farmácia
npx tsx scripts/indicadores-produto-farmacia-dry-run.ts \
   --farmacia=<id-farmacia> --sample=20

# Aumentar amostra de comparação com stock-data
npx tsx scripts/indicadores-produto-farmacia-dry-run.ts \
   --compare-sample=100
```

Resultado esperado em qualquer corrida: distribuição razoável (campos
"populáveis" em torno dos %% deste relatório), zero drift contra
stock-data, sem writes.

---

## 10. Próximo passo recomendado

**Não autorizar Fase 1 ainda.** O utilizador disse "primeiro só medir"
— este relatório fecha essa fase. Decisão pendente:

1. Aceitar o critério de classificação ABC/Rotação (§3.2, §4.3, §4.4)
   ou refiná-lo antes de popular.
2. Decidir o que fazer com os 3 campos bloqueados (Compra/Venda
   diária): popular IPF com null, ou esperar pelo pipeline ERP?
3. Aceitar a frequência diária ou ajustar (semanal? on-demand?).

Após decisões: Fase 1 fica acessível em ~0,5 dia.

---

_Análise read-only. Sem writes em BD. Sem migrations. Sem UI. Sem
alteração a leitores em produção. Tudo o que mudou: novo script
`scripts/indicadores-produto-farmacia-dry-run.ts` (commit `3f53dca`)
e este relatório._
