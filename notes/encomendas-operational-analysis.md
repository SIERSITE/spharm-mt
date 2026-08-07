# Encomendas — Análise Operacional + Plano

**Data:** 2026-05-11
**Fase:** análise apenas (zero código, zero migrations, zero UI)
**Scope:** auditar [lib/encomendas-data.ts](../lib/encomendas-data.ts) e operações
adjacentes, identificar lacunas, propor plano faseado para encomendas
inteligentes.

## 1. Resumo executivo

Encomendas hoje é **data-driven simples**: stock + vendas dos últimos 3 meses,
sem feedback-loop, sem IA, sem benchmarking cross-farm. A ATC/DCI enriquecida
(P9 acabou de adicionar ~3700 produtos com sinal clínico) **ainda não está
incorporada** — encomendas só conhece designação, fabricante, classificação
nivel1/nivel2. Há **3 implementações divergentes** do cálculo `avgDaily/coverage`
(encomendas vs stock vs transferências) — refactor para `lib/metrics-shared.ts`
é manageable e fecha drift. **Sem queue, sem retry, sem alertas** — UX
operacional depende de o utilizador olhar e agir.

## 2. Anatomia de `lib/encomendas-data.ts`

**Função principal:** `getEncomendasData()` ([lib/encomendas-data.ts:54-196](../lib/encomendas-data.ts#L54)).

**Retorna:** `Promise<EncomendaBaseRow[]>` — uma linha por (cnp, farmácia, período).

**Tipos chave:**
- `EncomendaBaseRow` ([linha 32-45](../lib/encomendas-data.ts#L32))
- `EncomendaMonthlyMovement` ([linha 18](../lib/encomendas-data.ts#L18))
- `EncomendaPurchaseHistory` ([linha 19-24](../lib/encomendas-data.ts#L19))
- `EncomendaSupplierCondition` ([linha 25-30](../lib/encomendas-data.ts#L25))

**Queries (raw SQL, linhas 83-107):**
- JOIN: `ProdutoFarmacia` × `Produto` × `Farmacia` × `Fabricante` × `Classificacao`
- Campos lidos: `pf.stockAtual`, `pf.fornecedorOrigem`, `pf.categoriaOrigem`, `pf.subcategoriaOrigem`, `p.designacao`, `p.cnp`, `f.nomeNormalizado` (fabricante), `cl_n1.nome`, `cl_n2.nome`
- Agregação `VendaMensal` últimos 6 meses ([linha 124-137](../lib/encomendas-data.ts#L124))

**Output shape — campos populados:**
- `stockAtual`, `coberturaAtual`, `rotacaoMedia` (calculados)
- `nomeNormalizado` (fabricante), `categoriaOrigem`/`subcategoriaOrigem` (ERP raw)
- `nivel1Nome`, `nivel2Nome` (canónico)
- `movimentos6M` — vendas mensais ([linha 164-170](../lib/encomendas-data.ts#L164))

**Output shape — campos VAZIOS por design:**
- `movimentos6M[].compras = 0` sempre ([linha 168](../lib/encomendas-data.ts#L168))
- `ultimasCompras = []` ([linha 190](../lib/encomendas-data.ts#L190); TODO no comentário: requer agregação de Compra + JOIN a Fornecedor)
- `condicoesFornecedor = []` ([linha 191](../lib/encomendas-data.ts#L191); TODO: requer model `CampanhaFornecedor` inexistente)

**Quem chama:**
- [app/encomendas/actions.ts:5-7](../app/encomendas/actions.ts) → `runEncomendasReport()`
- [components/encomendas/encomendas-client.tsx:21,144](../components/encomendas/encomendas-client.tsx) → `EncomendasClient`
- Client recomputa sugestão por período (7/15/30/60/90d) em `useMemo` ([linha 181-202](../components/encomendas/encomendas-client.tsx#L181))

## 3. Tabelas envolvidas (estado actual)

| Tabela | Linha schema | Campos chave | Lifecycle |
|---|---|---|---|
| `ListaEncomenda` | [968-992](../prisma/schema.prisma#L968) | farmaciaId, estado (RASCUNHO→FINALIZADA→EXPORTADA), estadoExport | enum `EstadoListaEncomenda` + `OrderExportState` |
| `LinhaEncomenda` | [995-1011](../prisma/schema.prisma#L995) | listaEncomendaId, produtoId, quantidadeSugerida, quantidadeAjustada, fornecedorSugeridoId | unique(listaEncomendaId, produtoId) |
| `OrderOutbox` | [1110-1167](../prisma/schema.prisma#L1110) | payloadJson, idempotencyKey, state, attemptCount, nextAttemptAt | retry [1m, 5m, 30m, 2h, 8h, 24h] |
| `OrderExportAudit` | [1173-1193](../prisma/schema.prisma#L1173) | outboxId, attempt, status, message, httpStatus | append-only imutável |

**Não existe** `RegraEncomenda` no schema — a "regra" é lógica em
[lib/encomendas/proposal.ts](../lib/encomendas/proposal.ts) com `baseRule` ("total"
ou "avgDaily × targetCoverageDays").

## 4. Sinais usados HOJE — inventário

### Usados

- **`Produto.designacao`, `Produto.cnp`** — identificação
- **`Produto.fabricanteId`** → JOIN para `Fabricante.nomeNormalizado` — UI mostra agrupamento por fabricante
- **`ProdutoFarmacia.stockAtual`** — input crítico
- **`ProdutoFarmacia.fornecedorOrigem`** (text livre!) — exibido, não normalizado
- **`ProdutoFarmacia.categoriaOrigem`, `subcategoriaOrigem`** — ERP raw fallback
- **`Classificacao.nome`** (nivel1, nivel2) — agrupamento canónico
- **`VendaMensal.quantidade`** — base de rotação (3m) e movimentos (6m)

### Disponíveis mas IGNORADOS

| Origem | Campo | Potencial |
|---|---|---|
| `Produto` | `codigoATC`, `dci`, `formaFarmaceutica`, `dosagem`, `embalagem` | agrupar substitutos, alertar variantes |
| `Produto` | `grupoHomogeneo`, `flagGenerico`, `flagMSRM`, `flagMNSRM` | filtrar por tipo de receita |
| `Produto` | `productType`, `productTypeConfidence`, `verificationStatus` | confidence scoring |
| `RegulatoryRecord` | `grupoTerapeutico`, `titularAim`, `estadoAim` | sazonalidade, titular vs grossista clarificado |
| `IndicadoresProdutoFarmacia` | `mediaVendasDiarias30d/90d`, `mediaVendasMensais3m/12m` | pré-calculado em vez de recalcular per-request |
| `IndicadoresProdutoFarmacia` | `diasStockRestante`, `diasSemVenda`, `classificacaoABC`, `classificacaoRotacao` | curated, single-source-of-truth |
| `IndicadoresProdutoFarmacia` | `ultimoPrecoCompra`, `ultimoFornecedorId` | preço esperado, fornecedor histórico |
| `Compra` | `precoUnitario`, `descontoBonificacao`, `fornecedorId`, `numeroDocumento` | benchmark de preço, histórico real de fornecedor |
| `ProdutoFarmacia` | `fornecedorHabitualId` (FK normalizado!) | substitui `fornecedorOrigem` text livre |
| `ProdutoFarmacia` | `stockMinimo` | safety floor obrigatório |
| `HistoricoStock` | trend (snapshot diário) | detectar pico/queda recente |

## 5. Cobertura/rotação/stock — implementações divergentes

**Três sítios calculam quase-a-mesma-coisa:**

| Ficheiro | avgDaily | coverage | Janela | Fallback |
|---|---|---|---|---|
| [encomendas-data.ts:153-161](../lib/encomendas-data.ts#L153) | `(v3m/90)` | `stock/avgDaily` | 3m vendas + 6m movimentos | 999 / 0 |
| [transferencias-data.ts:161-167](../lib/transferencias-data.ts#L161) | `qty3m/90` | `stock/avgDaily` | 3m | Infinity |
| [stock-data.ts:61-80](../lib/stock-data.ts#L61) | `salesQty90d/90` | `stock/avgDaily90d` | 3m (chamado de 90d mas usa VendaMensal) | null |

**Diferenças observáveis:**
- 3 valores diferentes para o mesmo conceito de "stock sem vendas" (999 / Infinity / null)
- Janela "3m" usada de três formas distintas
- Encomendas mistura 3m (rotação) + 6m (movimentos) sem documentar porquê
- Sem média móvel ponderada — última venda há 90 dias pesa igual a venda de ontem

**Cálculo do sugestão (cliente):**
- [encomendas-client.tsx:91-94](../components/encomendas/encomendas-client.tsx#L91): `ceil(rotacao × targetDias - stock)`
- [encomendas/proposal.ts:210-222](../lib/encomendas/proposal.ts#L210): `target = baseRule === "total" ? sum : avgDaily × targetCoverageDays`; `suggested = target - stock - pending`
- **Sem usar `stockMinimo`** — campo existe em ProdutoFarmacia mas não é considerado

## 6. Fornecedor e fabricante — confusão actual

**Nomenclatura no schema:**
- `Fabricante` = titular AIM (Bayer, Pfizer) — **quem fabrica/regista o medicamento**
- `Fornecedor` = grossista (Empifarma, OCP, Alliance) — **quem entrega à farmácia**
- `ProdutoFarmacia.fornecedorOrigem` = texto livre vindo do ERP (não normalizado)
- `ProdutoFarmacia.fornecedorHabitualId` = FK para `Fornecedor` normalizado (existe! mas não usado em encomendas)

**Estado actual:**
- Encomendas mostra `fornecedorOrigem` (text livre) na UI
- `LinhaEncomenda.fornecedorSugeridoId` é **hardcoded 0** ou manual — **sem lógica de sugestão automática**
- Sem fallback se fornecedor habitual indisponível
- Sem rotação de fornecedor por categoria/produto

**Caminho óbvio:** trocar `fornecedorOrigem` por `fornecedorHabitualId` (FK normalizado) — campo existe mas não está populado em todas as rows. Requer backfill primeiro.

## 7. Transferências vs encomendas — duplicação de lógica

**Lógica de transferência existe:** [lib/transferencias-data.ts:146-246](../lib/transferencias-data.ts#L146).

Critérios actuais:
- Produto existe em duas farmácias do mesmo grupo
- Cobertura origem >> 20d E destino < 20d E ratio ≥ 2.5:1
- Quantidade: `max(1, round((cov_origem - 20) × avgDaily × 0.5))`

**Encomendas não consulta transferências.** Logo, podemos estar a sugerir "encomendar produto X" quando farmácia gémea tem excesso.

**Lacuna concreta:** sem prioridade entre "transferir" e "encomendar". UX manual.

**Caminho:** quando UI sugere encomenda para farmácia A, consultar transferências disponíveis para o mesmo CNP — mostrar "podes receber de farmácia B (excesso 30d)" como alternativa **antes** de gerar pedido ao fornecedor.

## 8. Onde ATC/DCI enriquecido (P9 recente) entra

**Oportunidades concretas após P9 Fase 1+2:**

### O1. Agrupamento por DCI (substituição genéricos)
- Mesmo DCI + mesma forma + mesma dosagem ≈ produto substituível
- Hoje encomendas vê 5 paracetamóis diferentes como 5 linhas independentes
- **Proposta:** opcional toggle UI "agrupar por DCI" → mostrar `total_qty necessária` e permitir escolher SKU
- Requer: `Produto.dci`, `Produto.dosagem`, `Produto.formaFarmaceutica` (3719 produtos vão ter após P9 sync)

### O2. Sazonalidade por classe terapêutica
- Anti-histamínicos têm pico Mar-Mai (pólens), antigripais Out-Dez
- Hoje encomendas usa janela fixa de 3 meses — não detecta sazonalidade
- **Proposta:** classe ATC (3 chars) → curva sazonal indicativa → ajustar `targetCoverageDays` por mês actual
- Requer: tabela de seasonality coefficients per ATC prefix (curated, ~50 entries)

### O3. Sugestão de stock mínimo por classe
- Medicamentos crónicos (C09 hipertensão, A10 diabetes) → cobertura conservadora
- OTC pontuais (R05 tosse) → cobertura agressiva
- **Proposta:** default `stockMinimo` derivado de `(classN2, classATC3)` se não definido
- Requer: tabela de defaults por categoria (curated)

### O4. Alerta de embalagem alternativa
- Mesmo produto vem em "20 comp" e "60 comp" — utilizador encomenda 60 comp em 3 caixas vs 20 comp em 9 caixas
- **Proposta:** mostrar variantes do mesmo (DCI, dosagem) com diff de preço/unidade
- Requer: `Produto.embalagem` ou cluster por (DCI, dosagem, forma) presents in catalog

### O5. Cross-farm benchmarking de preço
- `Compra.precoUnitario` existe mas não é consultado em encomendas
- Médias por DCI cross-farm permitem alertar "este preço está acima da mediana 15%"
- Requer: agregação de Compra (não há ainda no SQL de `encomendas-data`)

## 9. Lacunas e pontos fracos actuais

Numerados para referência no plano:

- **L1.** Produtos novos sem histórico tratados como "infinite coverage" (não avisa)
- **L2.** Produtos descontinuados não sinalizados (sem `dataCancelamento`)
- **L3.** Promoções não detectadas (sem `tipoEvento` em VendaMensal)
- **L4.** Manipulados (`ProdutoInterno`) não detectados em encomendas
- **L5.** Embalagens distintas do mesmo medicamento tratadas como SKUs independentes
- **L6.** Janela de 3 meses hardcoded — sem fallback para slow movers
- **L7.** `stockMinimo` (campo existe) **não é usado** no cálculo de sugestão
- **L8.** `ultimasCompras` e `condicoesFornecedor` **vazias por design** (TODOs nunca implementados)
- **L9.** Fornecedor sugerido = manual; lógica de sugestão automática inexistente
- **L10.** Sem integração com transferências (sugere encomenda quando há excesso noutra farmácia)
- **L11.** ATC/DCI/grupoTerapeutico do P9 **ainda não consultados**
- **L12.** Indicadores pré-calculados em `IndicadoresProdutoFarmacia` ignorados (re-calcula ao vivo)
- **L13.** Três implementações de avgDaily/coverage com fallbacks divergentes

## 10. Como evitar duplicar lógica com stock/transferências

**Refactor proposto — `lib/metrics-shared.ts`** (não criar ainda, apenas plano):

Funções a extrair:
```ts
calculateAvgDaily(salesQuantity: number, windowDays: number): number
calculateCoverage(stock: number, avgDaily: number): number | null
calculateRotacao(salesQuantity: number, windowDays: number, targetMonthLength = 30): number
classifyRotation(rotacaoMensal: number): "alta" | "media" | "baixa" | "estagnada"
classifyABC(valorVenda: number, percentiles: { a: number; b: number }): "A" | "B" | "C"
```

Convenções a padronizar:
- Window unit = **dias** sempre (não meses)
- Fallback coverage stock>0+vendas=0 → `null` (semantic: "indeterminado"), display "—" na UI
- `VendaMensal` é única fonte para análise mensal/trend (não mix com `Venda`)

**Consumers a actualizar:** [encomendas-data.ts](../lib/encomendas-data.ts),
[stock-data.ts](../lib/stock-data.ts),
[transferencias-data.ts](../lib/transferencias-data.ts),
[encomendas/proposal.ts](../lib/encomendas/proposal.ts),
[encomendas-client.tsx](../components/encomendas/encomendas-client.tsx) (UI usa
o mesmo cálculo).

**Risco:** mínimo. Refactor mecânico, output numérico inalterado se mantermos
as mesmas janelas. UI render não muda.

## 11. Plano faseado para encomendas inteligentes

Sem código agora — apenas dimensionamento.

### Fase A — Foundation (sem novas features visíveis, 2-3 dias)

A.1. Extrair `lib/metrics-shared.ts` com funções normalizadas; migrar os 4 consumers (resolve L13)
A.2. Popular `IndicadoresProdutoFarmacia` via job periódico; consumers passam a consultar pré-calculado (resolve L12)
A.3. Adicionar `stockMinimo` ao cálculo de sugestão (`max(target, stockMinimo) - stock`) — resolve L7
A.4. Detectar produtos novos (`venda30d == 0 && lastSeenInVendas == null`) e descontinuados (`ProdutoFarmacia.flagRetirado`) — flag na UI, não bloqueia (resolve L1, L2)

### Fase B — Enriquecimento clínico (depois do P9 import live, 3-5 dias)

B.1. Adicionar ATC/DCI/forma/dosagem ao output `EncomendaBaseRow` (campos já existem em Produto após sync P9)
B.2. UI toggle "agrupar por DCI" — mostra qty total por DCI, deixa user escolher SKU (resolve O1)
B.3. Alerta de embalagem alternativa (mesma DCI+dosagem+forma, diff embalagem) — flag na linha (resolve O4, L5)
B.4. Default `stockMinimo` por (classN2, ATC3) quando não definido — curated table (resolve O3)

### Fase C — Decisão melhorada (5-10 dias)

C.1. **Integração com transferências** — antes de propor encomenda, consultar excesso noutra farmácia do grupo; mostrar "podes transferir" como opção primária (resolve L10)
C.2. **Sugestão automática de fornecedor** — `fornecedorHabitualId` se populado, senão último Compra com sucesso, senão fornecedor por défault da categoria (resolve L9)
C.3. **Histórico de compras populado** — implementar `ultimasCompras` no SQL agregando Compra + Fornecedor (resolve L8 parcial)

### Fase D — Inteligência avançada (10+ dias, depende de B+C)

D.1. **Sazonalidade ATC-based** — coeficientes curated por ATC3, ajustar targetCoverage por mês (resolve O2)
D.2. **Cross-farm preço benchmarking** — alertar "este preço está acima da mediana" (resolve O5)
D.3. **Detecção de promoção** via spike-detection em VendaMensal — avisar "vendas de Dez 2026 estão 3× acima do esperado, considerar se foi promoção" (resolve L3 parcial)

## 12. Tabelas afectadas pelo plano

**Sem migrations destrutivas em nenhuma fase.**

| Tabela | Fase A | Fase B | Fase C | Fase D |
|---|---|---|---|---|
| `EncomendaBaseRow` (tipo) | + sinalização novo/descontinuado | + atc/dci/forma/dosagem | + alternativa transferência | + sazonalidade hint |
| `IndicadoresProdutoFarmacia` | populado via job | leitura | leitura | leitura |
| `ListaEncomenda`, `LinhaEncomenda` | sem mudanças | sem mudanças | + fornecedorSugeridoId autopopulated | + tipoSugestao (TRANSFER/ENCOMENDA) |
| `RegraEncomenda` (NOVA opcional) | — | — | — | sazonalidade rules table |
| `Compra` | — | — | leitura agregada | leitura |
| `Fornecedor` | — | — | leitura (resolução) | leitura |

## 13. Riscos do plano

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Refactor `metrics-shared` rompe valores antigos | baixa | testes assert-based comparando antes/depois para sample de 100 produtos |
| `IndicadoresProdutoFarmacia` staleness se job falha | média | timestamp + alert em B.2 dashboard |
| Curated tables (sazonalidade, defaults por categoria) ficam stale | média | review trimestral, owner explícito |
| UI complexity cresce demais (toggle DCI + transferências) | média | progressive disclosure; default modo simples |
| Cross-farm benchmarking exige multi-tenant aware queries | alta | depende de Fase C do `data-sync-architecture.md` |

## 14. Não-objectivos desta análise

- Sem alterações de código ou UI
- Sem migrations
- Sem mudanças no pipeline INFOMED em curso
- Sem tocar em transferências ou stock operacional
- Sem deploy

## 15. Decisões pendentes

1. **Avançar com Fase A** depois do INFOMED import live + sync + reprocess?
2. **Refactor `metrics-shared.ts` standalone** ou bundle com Fase A?
3. **Curated tables** (sazonalidade, defaults) — quem é dono? Como manter?
4. **Integração transferências** (C.1) — desejável mas requer alinhamento operacional com a equipa que faz a gestão multi-farmácia.

---

_Análise read-only. Sem código, sem migrations. Aguardo direção sobre qual fase priorizar e quando._
