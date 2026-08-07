# Operational Intelligence Plan

**Data:** 2026-05-11
**Âmbito:** plano integrado para usar o sinal clínico do INFOMED P9 (3 977
medicamentos com ATC, 3 980 com DCI) como motor das decisões operacionais
do grupo — encomendas, transferências, excessos, dashboard. Faz a ponte
entre o catálogo enriquecido e a vista do gestor de farmácia.
**Estado:** análise read-only. Zero código. Zero migrations. Zero writes.
**Não duplica:** estende
[notes/encomendas-operational-analysis.md](encomendas-operational-analysis.md),
[notes/catalog-quality-dashboard.md](catalog-quality-dashboard.md),
[notes/data-sync-architecture.md](data-sync-architecture.md),
[notes/multi-tenant-db-strategy.md](multi-tenant-db-strategy.md),
[notes/infomed-pipeline-final-report.md](infomed-pipeline-final-report.md).

---

## 1. Executive Summary

- **Quatro implementações independentes do mesmo cálculo `avgDaily × coverage`**
  existem hoje em produção
  ([encomendas-data.ts:157](../lib/encomendas-data.ts#L157),
  [stock-data.ts:63](../lib/stock-data.ts#L63),
  [transferencias-data.ts:163](../lib/transferencias-data.ts#L163) e
  [transferencias-data.ts:283](../lib/transferencias-data.ts#L283),
  [encomendas/proposal.ts:210](../lib/encomendas/proposal.ts#L210)). O
  conceito é o mesmo, os fallbacks são `999 / Infinity / null / 0`, e o
  cliente em
  [encomendas-client.tsx:184-187](../components/encomendas/encomendas-client.tsx#L184)
  reaplica um **factor mágico de período** (×1.08, ×1.04, ×1, ×0.96, ×0.93)
  por cima do `rotacaoMedia` server-side — ou seja, o número que o
  utilizador vê não é o que está na BD.

- **`IndicadoresProdutoFarmacia` existe na base e tem 14 campos
  pré-calculados** (`mediaVendasDiarias30d/90d`, `mediaVendasMensais3m/12m`,
  `diasStockRestante`, `diasSemVenda`, `classificacaoABC`,
  `classificacaoRotacao`, `valorStockParado`, `ultimoPrecoCompra`,
  `ultimoFornecedorId`) e **é completamente ignorada pelo runtime web**.
  Grep confirma: zero referências em `app/` ou `lib/` fora do client
  gerado. Confirmação directa contra a BD: `0 rows`. Tem `@@unique +
  @@index` mas não há job que a popule nem leitor que a consuma.

- **Encomendas e Transferências são silos.** Hoje uma sugestão de
  encomenda nunca consulta excesso noutra farmácia do grupo. Queries
  read-only contra a BD real mostram **16 pares (deficit ↔ excesso)
  same-CNP** e **58 pares DCI-equivalente** que existiriam HOJE como
  candidatos a transferência ANTES de gerar pedido a fornecedor. Sobre um
  universo de **168 produto-farmácia em rotura iminente** (cobertura <
  7d com vendas), isso é **44% de candidatos a substituição** sem custo
  de aquisição.

- **DCI/ATC enriquecidos pelo P9 ainda não tocam código operacional.**
  Grep confirma que `codigoATC` e `dci` aparecem em 12 ficheiros, todos do
  pipeline de catálogo/enrichment ([catalog-connectors.ts](../lib/catalog-connectors.ts),
  [catalog-resolution-engine.ts](../lib/catalog-resolution-engine.ts),
  [catalog-classifier.ts](../lib/catalog-classifier.ts), etc.) — nunca em
  `encomendas-data`, `stock-data`, `transferencias-data` ou `dashboard`.
  **3 977 produtos com ATC estão prontos para uso operacional zero**.

- **A "regra base" coverage é configurável pelo utilizador para encomendas
  manuais** ([proposal.ts:42-50](../lib/encomendas/proposal.ts#L42)) mas
  **estática para o report de encomendas** (factor mágico no client). Há
  duas regras de sugestão em paralelo. Sem owner único.

- **Plano em 4 fases (A→D, ~25 dias)** com 5 quick wins de <1 dia que
  remetem para mudanças incrementais sobre a lib existente, sem
  migrations e sem big bang.

---

## 2. A1. Unificação de métricas

### 2.1 Inventário completo de implementações

Grep contra a codebase, todos os hits relevantes (excluí `generated/` que
é Prisma client) — usa o termo, calcula a métrica, ou consome o output.

| # | Ficheiro:linha | Símbolo | Janela | Fonte | Fallback (avgDaily=0, stock>0) | Consumidores |
|---|---|---|---|---|---|---|
| 1 | [lib/encomendas-data.ts:157](../lib/encomendas-data.ts#L157) | `avgDaily = recent3 / 90` | 3 meses (filtra VendaMensal pelos últimos 3m do período 6m) | `VendaMensal` | `999` (mascara como cobertura) | `getEncomendasData()` → [app/encomendas/actions.ts:6](../app/encomendas/actions.ts#L6) → [encomendas-client.tsx:144](../components/encomendas/encomendas-client.tsx#L144) |
| 2 | [lib/encomendas-data.ts:158](../lib/encomendas-data.ts#L158) | `rotacaoMedia = avgDaily * 30` (un./mês) | idem | idem | `0` | idem; cliente depois multiplica por factor mágico ×1.08/×1.04/×1/×0.96/×0.93 |
| 3 | [lib/stock-data.ts:63](../lib/stock-data.ts#L63) | `avgDaily90d = salesQty90d / 90` | 3 meses (`loadPfAndSales` em transferencias-data) | `VendaMensal` 3m | `null` (coverage = `null` quando avgDaily=0) | `loadStockEnriched()` → `/stock`, dashboard, peer-coverage map |
| 4 | [lib/stock-data.ts:127](../lib/stock-data.ts#L127) | `rotation = "Alta"/"Média"/"Baixa"` | 90d | derivado de `avgDaily90d` | "Baixa" | UI /stock |
| 5 | [lib/transferencias-data.ts:163](../lib/transferencias-data.ts#L163) | `avgDaily = qty3m / 90` | 3 meses | `VendaMensal` | `Infinity` (excluído depois) | `getTransferenciasData()` → `/transferencias`, dashboard |
| 6 | [lib/transferencias-data.ts:191](../lib/transferencias-data.ts#L191) | `avgDaily = (origem.avgDaily + destino.avgDaily) / 2` | (derivado) | — | — | cálculo de qty a transferir |
| 7 | [lib/transferencias-data.ts:283](../lib/transferencias-data.ts#L283) | `avgDaily = qty3m / 90` | 3 meses | `VendaMensal` | `Infinity` | `getExcessosData()` → `/excessos`, dashboard |
| 8 | [lib/encomendas/proposal.ts:210](../lib/encomendas/proposal.ts#L210) | `avgDailySales = salesQty / numDays` | janela definida pelo utilizador (start/end date inclusivos) | `Venda` (diária, NÃO `VendaMensal`) | `0` | `generateOrderProposal()` → [app/encomendas/nova/actions.ts:115](../app/encomendas/nova/actions.ts#L115) |
| 9 | [components/encomendas/encomendas-client.tsx:91-94](../components/encomendas/encomendas-client.tsx#L91) | `stockAlvo = rotacaoMedia × coberturaAlvoDias`; `sugestao = max(0, ceil(stockAlvo − stockAtual))` | 7/15/30/60/90d, escolha do utilizador | input do server | sempre ≥0 | UI /encomendas (lista) |
| 10 | [components/encomendas/encomendas-client.tsx:184-189](../components/encomendas/encomendas-client.tsx#L184) | `rotacaoAjustada = rotacaoMedia × fatorPeriodo` (factores 1.08/1.04/1/0.96/0.93) | depende do período UI | — | — | sobreposição **client-only** que reescreve a rotação server-side |

Notas:
- `IndicadoresProdutoFarmacia.mediaVendasDiarias30d` / `90d` existe no
  schema ([prisma/schema.prisma:943-944](../prisma/schema.prisma#L943))
  mas tabela tem **0 linhas** (verificado via `prisma.indicadoresProdutoFarmacia.count() == 0`).
- `IndicadoresProdutoFarmacia.diasStockRestante` (semantic igual a
  `coverage`) também está vazio.
- `loadPfAndSales()` em
  [transferencias-data.ts:77](../lib/transferencias-data.ts#L77) é
  utilitário partilhado por stock e transferências/excessos — mas o
  CÁLCULO da métrica a partir do output continua duplicado nos 3 sítios.
- Encomendas-data usa janela 3m de vendas + 6m de movimentos para
  display (linha 154-156).
- `Venda` (diária) é usado APENAS em `proposal.ts`. `VendaMensal` é a
  fonte de TUDO o resto. Inconsistente.

### 2.2 Divergências reais observáveis

| Cenário | encomendas-data | stock-data | transferencias-data | proposal.ts | Encomendas-client (sobre rot.) |
|---|---|---|---|---|---|
| stock=10, vendas3m=0 | cobertura=999 (mostra "999d") | coverage=null (mostra "∞") | coverage=Infinity (não entra em pares) | avgDaily=0 (sugestão=0 se rule="coverage") | herda 999 do server |
| stock=10, vendas3m=90 (avgDaily=1) | cobertura=10 | coverage=10 | coverage=10 | depende de janela utilizador | varia de 9.3 a 10.8 conforme período |
| stock=0, vendas3m=90 | cobertura=0 | coverage=0 | coverage=0 (excluído depois) | — | 0 |
| **rotacao mostrada ao utilizador para o MESMO produto** | (un./mês server) | rotation label | avgDaily | avgDailySales | server × 1.08/1.04/.../0.93 |

A consequência operacional: um produto pode aparecer como **estável em
`/stock`** (`coverage = null` → fora do filtro `at-risk`), ao mesmo
tempo que aparece com **cobertura 999 em `/encomendas`** (sugestão = 0
porque stock×0=0 mas o número 999 mascara o sinal real).

### 2.3 API proposta — `lib/operational-metrics.ts` (assinaturas, NÃO implementação)

Localização proposta: `lib/operational-metrics.ts` (server-only),
companion `lib/operational-metrics-shared.ts` para tipos puros e
fallback semantics (importável por client).

```ts
// lib/operational-metrics-shared.ts (pure types, sem I/O)

export type MetricsWindow = 7 | 14 | 30 | 60 | 90;

/**
 * Convenção canónica para fallbacks. NÃO usa 999/Infinity/0 —
 * deixa null e a UI decide como mostrar ("—", "∞", "sem demanda").
 */
export type ProductMetrics = {
  produtoId: string;
  farmaciaId: string;
  windowDays: MetricsWindow;
  /** Soma de vendas (un.) na janela. */
  salesQty: number;
  /** salesQty / windowDays. null quando windowDays=0. */
  avgDaily: number | null;
  /** stockAtual / avgDaily. null quando avgDaily=0 (sem demanda
   *  mensurável) ou stock=null. NUNCA 999, NUNCA Infinity. */
  coverageDays: number | null;
  /** avgDaily * 30, arredondado a 1 casa. null quando avgDaily=null. */
  monthlyVelocity: number | null;
  /** Bucket A/B/C derivado de Σ valor de venda na janela. */
  abcClass: "A" | "B" | "C" | null;
  /** "alta" | "media" | "baixa" | "estagnada" derivado de avgDaily +
   *  diasSemVenda. */
  rotationClass: "alta" | "media" | "baixa" | "estagnada" | null;
  /** Dias desde dataUltimaVenda. null se nunca houve venda. */
  daysSinceLastSale: number | null;
};

// lib/operational-metrics.ts (server-only, batch-orientado)

export type MetricsInput = {
  produtoIds?: string[];          // opcional — sem filtro = tudo
  farmaciaIds: string[];          // obrigatório (multi-farm preferred)
  window: MetricsWindow;          // default 90
  /** Se true, usa IndicadoresProdutoFarmacia pré-calculado quando
   *  disponível. Default true. Fallback automático para cálculo ao
   *  vivo se IPF estiver vazio ou stale (> 24h). */
  preferCached?: boolean;
};

/**
 * Calcula ProductMetrics em batch para um conjunto de
 * (produto, farmácia). Source of truth:
 *  1. IndicadoresProdutoFarmacia se preferCached && fresh (dataCalculo
 *     dentro das 24h)
 *  2. Fallback: agregação em VendaMensal × ProdutoFarmacia
 *
 * Cache: in-memory por request via React cache(). Job periódico
 * popula IndicadoresProdutoFarmacia.
 */
export async function getProductMetrics(
  input: MetricsInput,
): Promise<Map<string, ProductMetrics>>;

/**
 * Helper para um único (produto, farmácia). NÃO chamar em loop — usa o
 * batch acima.
 */
export async function getProductMetricsOne(
  produtoId: string,
  farmaciaId: string,
  window?: MetricsWindow,
): Promise<ProductMetrics | null>;
```

Convenções a forçar:
- **windowDays é a unidade canónica.** Não mais "3m", "6 meses",
  "trimestre". `MetricsWindow = 7 | 14 | 30 | 60 | 90`.
- **`null` é o fallback canónico** para "sem dado". Eliminar `999`,
  `Infinity`, `0`-mascarado.
- **`VendaMensal`** é a fonte primária para windows ≥30d.
  **`Venda` (diária)** é a fonte para windows ≤14d e para janelas
  user-defined no `proposal.ts`. Documentar onde cada qual entra.
- **Cliente NUNCA recalcula.** O server entrega `ProductMetrics`
  pronto. Remover o factor mágico ×1.08/×0.93.

### 2.4 Estratégia de migração incremental

**Princípio: 1 consumer de cada vez, output numérico invariante.**

| Step | Acção | Consumer migrado | Risco | Verificação |
|---|---|---|---|---|
| 1 | Criar `lib/operational-metrics-shared.ts` (tipos puros, fallbacks) | — | nenhum | tsc passa |
| 2 | Criar `lib/operational-metrics.ts` com cálculo ao vivo (sem IPF ainda) | — | nenhum | unit test compara output vs encomendas-data e stock-data para 50 produtos |
| 3 | Migrar `getStockData/loadStockEnriched` (mais isolado) | /stock + dashboard at-risk | baixo | snapshot test: rows.length, baixaCobertura unchanged |
| 4 | Migrar `getTransferenciasData` + `getExcessosData` | /transferencias, /excessos, dashboard | médio | snapshot test contra fixture de farmácias |
| 5 | Migrar `getEncomendasData` | /encomendas | médio | snapshot test + manualmente comparar 5 produtos |
| 6 | Remover factor mágico no client + reescrever `calcularSugestao` para usar `monthlyVelocity` directo | encomendas-client.tsx | baixo | comparar 5 produtos antes/depois |
| 7 | Migrar `generateOrderProposal` (mantém janela user-defined) | /encomendas/nova | baixo | unit test |
| 8 | Job periódico popula `IndicadoresProdutoFarmacia` | — | baixo | timestamp visível em dashboard |
| 9 | Activar `preferCached=true` no metrics layer | todos | baixo | A/B comparison contra cálculo ao vivo |

Steps 1-2 são **prep zero-risk** que podem entrar a qualquer momento.
Steps 3-7 são o refactor propriamente dito (1 PR cada).

---

## 3. A2. Encomendas + Transferências

### 3.1 Fluxo actual de sugestões para encomenda

Encomendas no SPharm.MT tem **dois fluxos paralelos** que NÃO se
conhecem:

**Fluxo 1 — Página /encomendas (relatório):**
- Entrypoint: [app/encomendas/page.tsx](../app/encomendas/page.tsx) →
  client [encomendas-client.tsx:131](../components/encomendas/encomendas-client.tsx#L131)
- Action: [app/encomendas/actions.ts:6](../app/encomendas/actions.ts#L6) →
  `getEncomendasData()` em [lib/encomendas-data.ts:54](../lib/encomendas-data.ts#L54)
- Dados: stockAtual + rotacaoMedia (3m) + movimentos 6m + fornecedor + categoria
- Sugestão: **calculada client-side** com `calcularSugestao(stock,
  rotacao, coberturaAlvo)` em
  [encomendas-client.tsx:91](../components/encomendas/encomendas-client.tsx#L91)
- Acção do utilizador: editar quantidades, exportar (gera ListaEncomenda
  via `createOrderAction` em [app/encomendas/nova/actions.ts:42](../app/encomendas/nova/actions.ts#L42))
- **Sem persistir sugestão** — desaparece após reload da página

**Fluxo 2 — Página /encomendas/nova (proposta server-side):**
- Entrypoint: [app/encomendas/nova/page.tsx](../app/encomendas/nova/page.tsx)
- Action: `generateProposalAction` em [app/encomendas/nova/actions.ts:91](../app/encomendas/nova/actions.ts#L91)
- Dados: agregação `Venda` (diária) no período definido pelo
  utilizador, com filtros opcionais (fabricante/fornecedor/categoria/productType)
- Sugestão: server-side via
  [lib/encomendas/proposal.ts:112](../lib/encomendas/proposal.ts#L112)
- Acção: utilizador revê em UI ([order-create-client.tsx](../components/encomendas/order-create-client.tsx)),
  finaliza → cria `ListaEncomenda` + `LinhaEncomenda` + `OrderOutbox`
  via `createEncomendaWithOutbox` em [lib/ingest/orders.ts](../lib/ingest/orders.ts)

**Verificado contra DB:** `ListaEncomenda.count() = 0` e
`LinhaEncomenda.count() = 0`. Nenhuma encomenda foi ainda criada em
produção. Os fluxos existem mas não geraram dados de utilização real.

**Sinais clínicos ATC/DCI:** ausentes nos dois fluxos. `productType` é
o sinal mais clínico que `proposal.ts` aceita como filtro.

### 3.2 Fluxo actual de transferências

- Entrypoint: [app/transferencias/page.tsx](../app/transferencias/page.tsx)
  + [app/excessos/page.tsx](../app/excessos/page.tsx)
- Loaders: `getTransferenciasData()` (pares deficit/excesso de **mesmo
  CNP em 2 farmácias**) e `getExcessosData(thresholdDays)` (qualquer
  produto com cobertura > threshold)
- Critério transferência ([transferencias-data.ts:186-189](../lib/transferencias-data.ts#L186)):
  - origem coverage ≥ 20d
  - destino coverage < 20d
  - ratio origem/destino ≥ 2.5:1
- **Sem persistência** — sem `Transferencia` no schema. É vista
  read-only. Acção pertence ao utilizador (manual no terreno).

### 3.3 Substituição operacional inteligente — desenho

Hoje, quando o gestor vai criar uma encomenda para a Farmácia A, o
sistema só sabe que A precisa do produto X. Não sabe que:

- (a) **Mesmo CNP, outra farmácia tem excesso** — transferir é mais
  rápido e zero custo. Já temos a query em `getTransferenciasData`.
- (b) **Outro CNP, outra farmácia tem excesso e tem o MESMO DCI**
  (substituto genérico) — pode resolver a necessidade clínica do
  utente sem encomendar.

**Algoritmo proposto (pseudocódigo):**

```
function suggestSubstitutions(produtoId, farmaciaId, qtyNeeded):
  metrics = getProductMetrics({ produtoIds: [produtoId],
                                 farmaciaIds: ALL, window: 90 })

  # 1. Mesmo CNP, excesso noutra farmácia
  sameCnpCandidates = []
  for fid in OTHER_FARMACIAS:
    m = metrics.get(produtoId, fid)
    if m.coverageDays > 60 and stockAtual(produtoId, fid) > qtyNeeded:
      sameCnpCandidates.push({
        type: "TRANSFER_SAME_CNP",
        farmaciaOrigem: fid,
        qtyAvailable: max(0, stockAtual - 20 * m.avgDaily),
        priority: m.coverageDays
      })

  # 2. DCI-equivalente: outro CNP com mesma DCI+dosagem+forma
  produto = Produto.findUnique(produtoId)
  if produto.dci and produto.dosagem and produto.formaFarmaceutica:
    equivalents = Produto.findMany({
      dci: produto.dci,
      dosagem: produto.dosagem,
      formaFarmaceutica: produto.formaFarmaceutica,
      id: { not: produtoId }
    })
    for eq in equivalents:
      for fid in ALL_FARMACIAS:
        m = getProductMetrics(eq.id, fid)
        if m.coverageDays > 60:
          sameCnpCandidates.push({
            type: "TRANSFER_DCI_EQUIVALENT",
            farmaciaOrigem: fid,
            produtoSubstitutoId: eq.id,
            qtyAvailable: ...,
            priority: m.coverageDays - 100  # lower than same-CNP
          })

  return candidates.sortByPriority()
```

**SQL de exemplo (em uso real seria preparado statement):**

```sql
-- Same-CNP candidates para um produto em rotura na farmácia A
WITH metrics AS (
  SELECT pf."produtoId", pf."farmaciaId",
         pf."stockAtual"::float AS stock,
         COALESCE(s.qty3m, 0) / 90.0 AS avg_daily,
         CASE WHEN s.qty3m > 0
              THEN pf."stockAtual"::float / (s.qty3m / 90.0)
              ELSE NULL END AS coverage
  FROM "ProdutoFarmacia" pf
  LEFT JOIN (SELECT "produtoId", "farmaciaId", SUM(quantidade)::float AS qty3m
             FROM "VendaMensal"
             WHERE (ano*12+mes) >= /* periodStart */
             GROUP BY 1,2) s ON s."produtoId"=pf."produtoId" AND s."farmaciaId"=pf."farmaciaId"
  WHERE pf."flagRetirado" = false
)
SELECT m_b."farmaciaId" AS origem,
       m_b.stock - GREATEST(20 * m_b.avg_daily, 0) AS qty_available,
       m_b.coverage
FROM metrics m_a   -- farmácia em deficit
JOIN metrics m_b ON m_b."produtoId" = m_a."produtoId"
                 AND m_b."farmaciaId" <> m_a."farmaciaId"
WHERE m_a."produtoId" = $1 AND m_a."farmaciaId" = $2
  AND m_a.coverage < 7
  AND m_b.coverage > 60
ORDER BY m_b.coverage DESC;

-- DCI-equivalent: para o mesmo (DCI, dosagem, forma), procurar excesso
-- em qualquer outro CNP em qualquer outra farmácia
WITH target AS (
  SELECT dci, dosagem, "formaFarmaceutica"
  FROM "Produto" WHERE id = $1
)
SELECT p.id AS substitutoId, p.cnp, p.designacao,
       m."farmaciaId", m.stock, m.coverage
FROM "Produto" p
JOIN target t ON p.dci = t.dci
              AND p.dosagem = t.dosagem
              AND p."formaFarmaceutica" = t."formaFarmaceutica"
JOIN metrics m ON m."produtoId" = p.id
WHERE p.id <> $1
  AND m.coverage > 60
  AND t.dci IS NOT NULL;
```

### 3.4 Impacto real hoje — números medidos contra a BD de produção

Universo:
- **2 farmácias activas** (Farmácia Castelo, Farmácia Principal —
  excluída a Farmácia Teste)
- **22 016 rows em `ProdutoFarmacia`** (todas vivas, nenhum flagRetirado)
- **14 922 produto-farmácia com stock > 0**
- **5 637 desses** (37,8%) **têm `codigoATC`** (universo onde
  substituição clínica é possível)

Sinais (janela 3 meses, querido em
`scripts/_tmp-explore-operational-intel.ts`, executado e removido):

| Métrica | Valor |
|---|---:|
| Produtos em rotura iminente (cobertura < 7d, com vendas) | **168** |
| Produtos com excesso de stock (cobertura > 60d) | **5 252** |
| **Pares (deficit ↔ excesso) same-CNP em farmácia diferente** | **16** |
| **Pares DCI-equivalente (deficit ↔ excesso outro CNP, outra farmácia)** | **58** |

Interpretação:

- **16 / 168 = 9,5%** das ruturas iminentes têm o EXACTAMENTE mesmo
  produto em excesso noutra farmácia do grupo. Estes são pares de
  transferência puros (sem encomenda).
- **58 / 168 = 34,5%** das ruturas têm um substituto DCI-equivalente em
  excesso. Estes requerem decisão clínica/comercial mas evitam
  aquisição.
- **Total: ~44% das ruturas têm alternativa interna detectável**.
- Universo `ListaEncomenda = 0` confirma que **não há histórico operacional**
  contra o qual comparar — estes números são potencial puro, e a
  primeira encomenda real será informativa.

Limitação dos números: estamos com 2 farmácias apenas. À medida que o
grupo cresce para 4+ farmácias, espera-se que estes ratios subam
significativamente (cada nova farmácia adiciona N produtos × hipóteses
de substituição).

### 3.5 Onde encaixar a substituição na UX actual

Sem mudar a estrutura de páginas — apenas ampliar:

| Localização | Mudança | Esforço |
|---|---|---|
| `EncomendaBaseRow` (output de `getEncomendasData`) | adicionar `substitutos: SubstitutionCandidate[]` opcional | 1 dia |
| `encomendas-client.tsx` linha de produto | quando há candidato, mostrar chip "↻ transferir de Farmácia B (excesso)" + CTA | 1 dia |
| `proposal.ts` (encomendas/nova) | filtrar linhas onde `substitutos.length > 0` ou marcar como "antes de encomendar" | 1 dia |
| Dashboard | KPI "Encomendas evitáveis por transferência" — count de candidatos | 0,5 dia |

---

## 4. A3. IndicadoresProdutoFarmacia

### 4.1 Inventário de campos pré-calculados

Tabela definida em
[prisma/schema.prisma:939-965](../prisma/schema.prisma#L939). 14 campos
de dados + 4 metadata.

| Campo | Tipo | Semântica | Onde DEVERIA ser usado | Onde é re-calculado em runtime |
|---|---|---|---|---|
| `mediaVendasDiarias30d` | Decimal(14,4) | avgDaily janela 30d | encomendas, stock, transferências, dashboard | **NÃO LIDO em lado nenhum** |
| `mediaVendasDiarias90d` | Decimal(14,4) | avgDaily janela 90d | idem | **NÃO LIDO**. Re-calculado em `stock-data.ts:63`, `encomendas-data.ts:157`, `transferencias-data.ts:163,283` |
| `mediaVendasMensais3m` | Decimal(14,4) | velocity mensal 3m | encomendas (rotacaoMedia) | **NÃO LIDO**. Re-calculado em `encomendas-data.ts:158` |
| `mediaVendasMensais12m` | Decimal(14,4) | velocity mensal 12m (baseline anual) | sazonalidade detection | **NÃO LIDO** |
| `diasStockRestante` | Decimal(14,2) | coverage em dias | encomendas, stock, transferências, dashboard | **NÃO LIDO**. Re-calculado em 5+ sítios |
| `diasSemVenda` | Int | dias desde última venda | "parado" detection, status | **NÃO LIDO**. `stock-data.ts:127` deriva ao vivo de `dataUltimaVenda` |
| `ultimoPrecoCompra` | Decimal(12,4) | preço da última compra | benchmarking, condições fornecedor | **NÃO LIDO** |
| `ultimoFornecedorId` | String? | FK Fornecedor da última compra | sugestão automática de fornecedor | **NÃO LIDO**. `fornecedorSugeridoId` em `LinhaEncomenda` é manual |
| `classificacaoABC` | Enum (A/B/C/NAO_CLASSIFICADO) | classe ABC por valor | priorização em encomendas | **NÃO LIDO**, nem em nenhum lado, nem mesmo o enum (grep negativo) |
| `classificacaoRotacao` | Enum (alta/media/baixa/estagnada/NORMAL) | rotação | "Alta/Média/Baixa" em UI stock | **NÃO LIDO**. `stock-data.ts:127` calcula `rotation` ao vivo |
| `valorStockParado` | Decimal(14,2) | stockAtual × custo para produtos sem rotação | dashboard "stock parado" | **NÃO LIDO**. `dashboard.ts:266-287` agrega ao vivo via $queryRaw |
| `dataCalculo` | DateTime @updatedAt | quando foi populado | freshness check | **N/A — vazio** |

**Resumo:** dos 14 campos de dados, **0 estão a ser lidos pelo runtime
web**, e o cálculo ao vivo correspondente existe em pelo menos 5
ficheiros diferentes. **A tabela é redundância pura** até que um job a
popule e os loaders a consumam.

Confirmação directa: `prisma.indicadoresProdutoFarmacia.count() = 0`
contra a BD live (a tabela tem migration mas zero rows).

### 4.2 Plano de consolidação

**Princípio: IPF é cache + source of truth para metrics, não substituto
do cálculo.**

1. **Job periódico** `scripts/jobs/refresh-indicadores-produto-farmacia.ts`
   (não existe ainda). Corre diariamente (cron Vercel quando estiver
   disponível, ver
   [data-sync-architecture.md](data-sync-architecture.md)). Por
   farmácia activa:
   - Agrega vendas 30d, 90d, 3m, 12m de `VendaMensal`
   - Calcula `diasStockRestante` = stockAtual / avgDaily30d
   - Calcula `valorStockParado` para PFs com `diasSemVenda > 90`
   - Calcula `classificacaoABC` por percentis cumulativos sobre
     valorVenda 90d
   - Calcula `classificacaoRotacao` a partir de avgDaily90d +
     diasSemVenda
   - Faz upsert em `IndicadoresProdutoFarmacia`. Idempotente (`@@unique
     [produtoId, farmaciaId]`)

2. **Loader único** `getProductMetrics()` (proposto em §2.3) lê IPF
   primeiro, cai para cálculo ao vivo se:
   - row não existe
   - `dataCalculo` > 24h
   - input pede `preferCached: false`

3. **Migração dos consumers**: cada consumer (encomendas-data,
   stock-data, transferencias-data, dashboard) passa a chamar
   `getProductMetrics()` em vez de fazer query própria. O cálculo ao
   vivo dentro do loader único garante zero break enquanto IPF está
   vazio.

4. **Eliminação de cálculo duplicado**: depois de 1 sprint estável,
   remover as agregações inline em `encomendas-data.ts:153-161`,
   `stock-data.ts:62-64`, `transferencias-data.ts:163-164,283-284`,
   `dashboard.ts:266-287` (stockParado). Cada ficheiro fica ~30 linhas
   mais curto.

---

## 5. A4. ATC-driven operational intelligence

5 capabilities concretas que ATC/DCI desbloqueiam, todas viáveis após
P9. Esforço em dias-pessoa. Impacto qualitativo (a quantificação real
exige histórico operacional que ainda não existe — `ListaEncomenda = 0`).

### 5.1 Sazonalidade por classe terapêutica

**Capability:** ajustar a sugestão de encomenda em função do mês do ano,
usando o sinal de classe ATC (1ª letra) ou subclasse (3 chars).

**Dados necessários:**
- `Produto.codigoATC` (3 977 produtos vivos, já populado)
- `VendaMensal` últimos 24 meses para calcular curva sazonal real
- Tabela curated `AtcSeasonality` (NOVA, ~50 entries): ATC3 → 12
  coeficientes mensais

**Joins/queries:**
```sql
-- Sinal real: vendas por (ATC3, mês) últimos 24m
SELECT LEFT(p."codigoATC", 3) AS atc3, vm.mes,
       SUM(vm.quantidade)::float / SUM(SUM(vm.quantidade)::float) OVER (PARTITION BY LEFT(p."codigoATC", 3)) AS share
FROM "VendaMensal" vm
JOIN "Produto" p ON p.id = vm."produtoId"
WHERE p."codigoATC" IS NOT NULL
  AND (vm.ano * 12 + vm.mes) >= (period_now - 24)
GROUP BY 1, 2;
```

**Esforço:** **4 dias** (curated table + import script + integração na
sugestão).

**Impacto esperado:** alto — anti-histamínicos R06 com pico Mar-Mai,
antigripais R05 com pico Out-Dez. Hoje a sugestão é janela fixa, ignora
mês.

**Exemplo concreto:** ATC R06 (anti-histamínicos sistémicos) — em Abril,
um produto com cobertura de 15d pode ser na verdade insuficiente porque
a procura está a subir; sazonalidade aplicar factor 1.4 → sugestão de
21d.

**Distribuição actual ATC1 no nosso universo (verified):**
N=1482, C=1069, A=612, G=477, R=469, D=365, M=353, J=262, S=195, B=173.
O top 3 (N=neurológico/psiquiátrico, C=cardiovascular, A=digestivo)
**não tem sazonalidade forte**. Sazonalidade pega em R (respiratório) e
J (anti-infeccioso) que somam ~730 produtos.

### 5.2 Ruptura por classe terapêutica

**Capability:** detectar "perdi todos os IBP" — quando uma classe ATC
fica simultaneamente em rotura em várias farmácias.

**Dados necessários:**
- `Produto.codigoATC` (sub-classe a 4 chars, ex: A02BC = IBP)
- `ProductMetrics.coverageDays` por (produto, farmácia)

**Query:**
```sql
SELECT LEFT(p."codigoATC", 4) AS atc4, pf."farmaciaId",
       COUNT(*) FILTER (WHERE coverage < 7) AS at_risk_count,
       COUNT(*) AS total_in_class,
       COUNT(*) FILTER (WHERE coverage < 7) * 100.0 / NULLIF(COUNT(*), 0) AS pct_at_risk
FROM "ProdutoFarmacia" pf
JOIN "Produto" p ON p.id = pf."produtoId"
LEFT JOIN /* metrics CTE */ m ON m."produtoId" = pf."produtoId" AND m."farmaciaId" = pf."farmaciaId"
WHERE p."codigoATC" IS NOT NULL AND pf."flagRetirado" = false
GROUP BY 1, 2
HAVING COUNT(*) >= 5 AND COUNT(*) FILTER (WHERE coverage < 7) * 100.0 / COUNT(*) > 50;
```

**Esforço:** **2 dias** (query + dashboard tile + drill-down).

**Impacto esperado:** alto. UX hoje obriga o gestor a olhar 168
ruturas individuais — esta capability colapsa para 2-5 alertas de
classe.

**Exemplo concreto:** Farmácia Castelo, classe A02BC (IBP), 8 produtos
totais, 6 em rotura iminente. Alerta: "85% dos IBP em risco em Castelo —
problema de fornecedor ou pico sazonal?".

### 5.3 Cobertura por classe ATC

**Capability:** dias de stock agregados a nível de classe — em vez de
"posso ficar sem omeprazol", "tenho IBP suficiente para os próximos N
dias".

**Dados necessários:**
- `ProductMetrics.coverageDays`, `avgDaily`, `salesQty`
- `Produto.codigoATC`

**Cálculo:**
```
coverage_class(atc3, farmacia) = Σ stockAtual(p) / Σ avgDaily(p)
                                  para p ∈ class
```

Substitutos genéricos são fungíveis dentro da classe — esta agregação
faz sentido clínico para o gestor.

**Esforço:** **2 dias**.

**Impacto esperado:** médio. Útil para o admin do grupo (não para o
balcão) — vista executiva da resiliência clínica.

**Exemplo:** "Cobertura média por classe ATC nas farmácias do grupo —
A02BC (IBP): 32d · C09 (antagonistas RAS): 47d · R05 (tosse): 12d ⚠️".

### 5.4 Compras excessivas por grupo ATC

**Capability:** quando o histórico de `Compra` estiver populado, alertar
"este mês gastei +40% em N02 vs mediana 12m".

**Dados necessários:**
- `Compra.precoUnitario × Compra.quantidade` (existe; volume real
  desconhecido — `Compra.count()` não medido aqui mas o schema está
  pronto)
- `Produto.codigoATC`
- Baseline: mediana 12m por classe + farmácia

**Query:**
```sql
SELECT LEFT(p."codigoATC", 1) AS atc1, c."farmaciaId",
       DATE_TRUNC('month', c.data) AS mes,
       SUM(c."valorTotal") AS gasto_mes
FROM "Compra" c
JOIN "Produto" p ON p.id = c."produtoId"
WHERE p."codigoATC" IS NOT NULL
GROUP BY 1, 2, 3;
-- depois comparar mes_corrente vs mediana(meses anteriores)
```

**Esforço:** **3 dias** (requer assumir que `Compra` está populado —
hoje não confirmado, mas o pipeline ERP devia trazer).

**Impacto esperado:** médio-alto. É a vista financeira que o admin do
grupo quer mensalmente.

**Exemplo:** "Maio 2026: gasto em N (sistema nervoso) +38% vs mediana —
investigar se foi promoção do fornecedor ou pico real".

### 5.5 Dependência de fornecedor por ATC

**Capability:** detectar concentração de risco — "95% dos antibióticos
J01 vêm de um único fornecedor".

**Dados necessários:**
- `Compra.fornecedorId` (FK normalizada existe)
- `Produto.codigoATC`
- Agregação por (ATC1 ou ATC3, fornecedor) últimos 90d

**Query:**
```sql
WITH compras_por_atc_fornecedor AS (
  SELECT LEFT(p."codigoATC", 3) AS atc3, c."fornecedorId",
         SUM(c."valorTotal") AS valor_compra
  FROM "Compra" c
  JOIN "Produto" p ON p.id = c."produtoId"
  WHERE p."codigoATC" IS NOT NULL
    AND c.data >= NOW() - INTERVAL '90 days'
    AND c."fornecedorId" IS NOT NULL
  GROUP BY 1, 2
),
totais AS (
  SELECT atc3, SUM(valor_compra) AS total FROM compras_por_atc_fornecedor GROUP BY atc3
)
SELECT a.atc3, f.id AS fornecedor_id, fab.nomeNormalizado /* ou similar */,
       a.valor_compra, t.total, a.valor_compra * 100.0 / t.total AS share
FROM compras_por_atc_fornecedor a
JOIN totais t ON t.atc3 = a.atc3
JOIN "Fornecedor" f ON f.id = a."fornecedorId"
WHERE a.valor_compra * 100.0 / t.total > 60  -- concentração alta
ORDER BY share DESC;
```

**Esforço:** **2 dias**.

**Impacto esperado:** baixo-médio. Vista de risco / negociação. O grupo
SPharm.MT é pequeno — provavelmente já sabe quem vende o quê. Mas
quando o grupo escala para 4+ farmácias e múltiplos grossistas, esta
métrica é o input directo para negociações.

---

## 6. Plano faseado

### Fase 1 — Foundation metrics (5-7 dias)

Pré-requisito de tudo o resto. Sem novas features visíveis.

| Item | Ficheiros tocados | Dias |
|---|---|---|
| 1.1 `lib/operational-metrics-shared.ts` (tipos + fallback semantics) | NOVO | 0,5 |
| 1.2 `lib/operational-metrics.ts` (cálculo ao vivo, sem IPF) | NOVO | 1,5 |
| 1.3 Migrar `loadStockEnriched` | `lib/stock-data.ts` | 1 |
| 1.4 Migrar `getTransferenciasData` + `getExcessosData` | `lib/transferencias-data.ts` | 1 |
| 1.5 Migrar `getEncomendasData` + remover factor mágico no client | `lib/encomendas-data.ts`, `components/encomendas/encomendas-client.tsx` | 1,5 |
| 1.6 Migrar `generateOrderProposal` | `lib/encomendas/proposal.ts` | 1 |
| 1.7 Job `refresh-indicadores-produto-farmacia.ts` + activar `preferCached` | NOVO + loader único | 1 |

**Deliverable:** todos os consumers de metrics passam por
`getProductMetrics()`. IPF tem rows. Cálculo ao vivo elimina-se nos 5
sítios duplicados.

### Fase 2 — Substituição inteligente (4-5 dias)

Depende da Fase 1.

| Item | Ficheiros tocados | Dias |
|---|---|---|
| 2.1 `lib/substitution-engine.ts` (same-CNP + DCI-equivalent) | NOVO | 1,5 |
| 2.2 Adicionar `substitutos` a `EncomendaBaseRow` | `lib/encomendas-data.ts` | 0,5 |
| 2.3 UI chip "↻ transferir" + CTA na linha | `components/encomendas/encomendas-client.tsx` | 1 |
| 2.4 Integração com `/encomendas/nova` (filtrar linhas com substituto) | `lib/encomendas/proposal.ts`, `order-create-client.tsx` | 1 |
| 2.5 Dashboard KPI "Encomendas evitáveis" | `lib/dashboard.ts`, `components/dashboard/dashboard-sections.tsx` | 0,5 |

**Deliverable:** o utilizador, ao gerar encomenda, vê alternativas
internas ANTES de chegar ao fornecedor. Métrica de impacto inicialmente:
58+16 = 74 candidatos identificados HOJE.

### Fase 3 — Capabilities ATC (8-10 dias)

| Item | Esforço |
|---|---|
| 3.1 Sazonalidade por ATC3 (§5.1) | 4 dias |
| 3.2 Ruptura por classe (§5.2) | 2 dias |
| 3.3 Cobertura por ATC (§5.3) | 2 dias |
| 3.4 Compras excessivas por ATC (§5.4) | 3 dias *(depende de Compra populada)* |

3.4 fica dependente do estado real da tabela `Compra` — pode ser que o
import ERP ainda não a popule sistematicamente; nesse caso é blocked.

### Fase 4 — Fornecedor inteligente (5-7 dias)

| Item | Ficheiros tocados | Dias |
|---|---|---|
| 4.1 Backfill `ProdutoFarmacia.fornecedorHabitualId` (FK normalizada) | NOVO script | 1 |
| 4.2 Sugestão automática `LinhaEncomenda.fornecedorSugeridoId` via último Compra + fallback `fornecedorHabitualId` | `lib/ingest/orders.ts` | 1,5 |
| 4.3 Concentração de fornecedor por ATC (§5.5) | `lib/dashboard.ts` (tile) | 2 |
| 4.4 `ultimasCompras` populadas no `EncomendaBaseRow` (resolve TODO L8 de encomendas-operational-analysis.md) | `lib/encomendas-data.ts` | 2 |

**Total Fases 1+2+3+4:** ~25 dias-pessoa. Dependências: Fase 2 depende
de 1. Fase 3 e 4 podem correr em paralelo após Fase 1.

---

## 7. Quick wins (<1 dia, impacto imediato)

Sem refactor, valor visível.

| # | Acção | Ficheiro | Esforço |
|---|---|---|---|
| Q1 | Aplicar `IndicadoresProdutoFarmacia` populate-only para 1 farmácia como teste-piloto (sem leitura ainda) — valida que o job está OK e dá baseline para QA da Fase 1 | NOVO script | 0,5 dia |
| Q2 | Adicionar campos `codigoATC`, `dci`, `productType` ao SELECT de `getEncomendasData` (ainda sem feature, mas o output passa a transportar o sinal) | `lib/encomendas-data.ts` | 0,3 dia |
| Q3 | Dashboard tile "Cobertura clínica por farmácia": % MEDICAMENTO com ATC no universo PF da farmácia (pinta a foundation do operacional) — re-utiliza queries existentes em `lib/admin/enrichment-metrics.ts` | `lib/dashboard.ts` | 0,5 dia |
| Q4 | Remover o factor mágico ×1.08/×0.93 do client; documentar que o que se vê é o que está calculado | `components/encomendas/encomendas-client.tsx:184-189` | 0,2 dia |
| Q5 | KPI "Encomendas evitáveis HOJE": `getTransferenciasData()` já dá pares same-CNP (transferências sugeridas); contar quantos coincidem com produtos at-risk em farmácia destino | `lib/dashboard.ts` | 0,5 dia |

---

## 8. Risk register

| # | Risco | Probabilidade | Severidade | Mitigação |
|---|---|---|---|---|
| R1 | Refactor `operational-metrics` muda valores numéricos visíveis ao utilizador (factor mágico foi calibrado ao olho) | média | médio | snapshot test com 100 produtos em fixture; release com feature flag por farmácia |
| R2 | `IndicadoresProdutoFarmacia` populate-job falha silenciosamente → metrics ficam stale | média | alto | timestamp `dataCalculo` visível no dashboard; alert se mais que 1 farmácia com `MAX(dataCalculo) > 26h` |
| R3 | Substituição DCI-equivalente sugere produto que não é clinicamente equivalente (ex: dosagens diferentes mas filtramos só por DCI) | baixa | médio | filtrar por `(dci, dosagem, formaFarmaceutica)` exact match; mostrar comparativo de dosagem ao utilizador; flag manual override |
| R4 | Sazonalidade ATC requer curated table — fica stale sem owner | média | baixo | review trimestral atribuída a data-quality team; default coefficient = 1.0 quando ATC3 não tem entrada |
| R5 | `Compra` não está populada → capabilities §5.4 e §4.2-4.4 ficam bloqueadas | alta | médio | medir `Compra.count()` antes de iniciar Fase 4; se vazia, priorizar import do histórico antes do refactor |

---

## 9. Cross-refs com notas existentes (não duplicar)

- **encomendas-operational-analysis.md §5 (avgDaily/coverage divergentes):**
  esta nota expande para **4 implementações** (não 3) — adiciona
  `proposal.ts` que usa `Venda` diária em vez de `VendaMensal`, e o
  factor mágico do client é uma 5ª camada não documentada.
- **encomendas-operational-analysis.md §11 Fase A:** mantém-se válido.
  Esta nota integra-o como **Fase 1 (Foundation metrics)** e expande
  com a estratégia step-by-step de migração.
- **catalog-quality-dashboard.md §3 KPIs admin grupo:** "MEDICAMENTO
  classificados" / "MEDICAMENTO com ATC" são pré-requisito de toda a
  inteligência operacional aqui descrita. O Quick Win Q3 fecha o loop
  entre catálogo e operacional.
- **data-sync-architecture.md §6 (scheduling):** o job de IPF (Fase 1.7)
  é o primeiro caso de uso real do scheduler que falta. Esta nota
  reforça a necessidade.
- **multi-tenant-db-strategy.md §6 (jobs/workers):** o IPF refresh tem
  de ser tenant-aware (cada tenant tem `legacyPrisma` próprio quando
  scripts forem migrados); incluir tenant-iteration desde o início.
- **infomed-pipeline-final-report.md §5 (3 977 produtos com ATC):** é a
  fonte do enabler. Esta nota responde "e agora, o que se faz com
  esses 3 977?".

---

## 10. Não-objectivos desta nota

- Sem alterações de código ou UI
- Sem migrations
- Sem implementação dos jobs descritos
- Sem alterações ao pipeline INFOMED
- Sem decisões de priorização (a priorização entre Quick Wins e Fases é
  matéria de gestão, não desta análise)
- Sem deploy

---

## 11. Decisões pendentes

1. **Ordem entre Quick Wins (Q1-Q5) e Fase 1.** Q1+Q3 servem de
   baseline para Fase 1; Q2+Q4+Q5 são independentes.
2. **Owner do refactor `operational-metrics`** — tocou em 4 ficheiros
   críticos do operacional. Quem assina?
3. **Owner das curated tables** (sazonalidade, defaults por ATC) — data
   quality team ou produto?
4. **Decisão sobre `Compra` ingestion**: o pipeline ERP popula `Compra`?
   Se não, capabilities §5.4 e Fase 4 ficam bloqueadas em backfill.
5. **DCI-equivalente match policy**: matcham só `(dci, dosagem,
   formaFarmaceutica)` ou também `embalagem`? Decisão clínica.

---

_Análise read-only. Sem código. Sem migrations. Sem writes. Os números
contra a BD foram obtidos via script `_tmp-explore-operational-intel.ts`
que foi executado uma vez e removido após captura dos valores._
