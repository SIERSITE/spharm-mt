# SPharm ERP → SPharm.MT — Canonical Mapping

**Versão:** v0.9 · **Data:** 2026-05-14 · **Status:** classifier de TipoDocumento server-side (modelo `TipoDocumentoClassificacao` + scripts `classify-tipodoc` / `reclassify-ingest-vendas`); endpoint `/bootstrap/sales-lines` prefere lookup server-side, payload do agent fica como fallback

Documento operacional que liga as tabelas observadas no **SPharm ERP
(Softreis, SQL Server 2008 R2)** às entidades canónicas do **SPharm.MT**.
Vive isolado em `docs/` porque é a fonte de verdade que tanto o agent
(`agent/`) como o SaaS (rotas `/api/ingest/v1/*`) consultam durante o
piloto.

> **Read-only.** Este documento não justifica nenhum `INSERT` /
> `UPDATE` / `DELETE` no SQL Server da farmácia. O fluxo é sempre
> ERP → agent → SaaS; nunca o inverso.

## 1. Regras invariantes

1. **Compatibilidade SQL Server 2008 R2.** Nenhum probe ou query
   pode usar `OFFSET/FETCH`, `STRING_AGG`, `STRING_SPLIT`, `TRY_CAST`,
   `IIF`, `THROW` ou `FORMAT`. Apenas `TOP N`, `CASE WHEN`, `CAST`,
   `CONVERT`, `COALESCE`, `ISNULL` e `sys.*`.
2. **Sem ORM.** Queries são SQL explícito construído no source. Sem
   query-builder. Identifiers (schema/tabela/coluna) só vêm de listas
   conhecidas (output do discovery) ou de argumentos validados (regex
   `^[A-Za-z0-9_ ]{1,128}$` — espaços aceites para
   `[Atendimento Detalhe]`, `[Fornecedor ID]`, etc.). Brackets `[ ]`
   nunca são input — são adicionados pelo wrapper de quoting.
3. **TOP fixo:**
   - **TOP 5** em probes de exploração (`discover-products`,
     `discover-stock`, `discover-sales`, `probe-table`).
   - **TOP 20** em previews operacionais (`products-preview`,
     `stock-preview`, `sales-preview`).
   - Nunca `SELECT *` sem `TOP`. Nunca cursors.
4. **Sem persistência.** Probes e previews imprimem para `stdout`
   apenas — nenhum ficheiro é escrito. Excepção: `discover` continua
   a gravar JSON+MD em `agent/output/` (introspecção de metadata).
5. **Sem ingest SaaS ainda.** Nenhum dos comandos envia HTTP para a
   SaaS. Não usa `SaasClient`. Mapping validado manualmente antes da
   primeira ingestão.
6. **Sem escrita em Neon, sem bootstrap histórico, sem sync
   incremental, sem projections finais.** Tudo isso vive em iterações
   posteriores ao mapping consolidado.

## 2. Tabelas Softreis confirmadas (2026-05-13)

Validadas via `probe-table` em condições reais. Esta é a fonte de
verdade dos mappings; tudo o que se segue (§3, §4) deriva daqui.

| Papel canónico | Tabela ERP | Granularidade | Observações |
|---|---|---|---|
| Master de produtos | `dbo.Stocks` | 1 linha por produto | PK `CodigoID`. Origem dos campos catálogo (designação, PVP, PMC, PUC). |
| Stock por armazém | `dbo.ArmazensStocks` | 1 linha por `ArmazemID × CodigoID` | Existência efectiva. Sem stock corrente em `Stocks` master. |
| Armazéns / lojas | `dbo.Armazens` | 1 linha por armazém | Resolve `ArmazemID` → descrição legível. |
| Cabeçalho de venda | `dbo.Atendimento` | 1 linha por documento | Tem `[Data Venda]`, `[Fim Venda]`, `[Tipo Documento]`. |
| Linhas de venda | `dbo.Atendimento Detalhe` | 1 linha por produto-no-documento | FK implícita `[Atendimento ID]` → `Atendimento`. Sem data própria. |
| Fornecedores | `dbo.Fornecedores` | 1 linha por fornecedor | PK `[Fornecedor ID]`. Referenciado por `ArmazensStocks.[Fornecedor Habitual]`. |

### 2.1 Joins canónicos

Validados visualmente nos outputs `probe-table`. FKs **não** estão
declaradas no schema (Softreis põe as relações no app code); o agent
trata-as como implícitas mas estáveis.

```text
                    ┌─────────────────────┐
                    │   dbo.Stocks (s)    │   master de produtos
                    │   PK: CodigoID      │
                    └──────────┬──────────┘
                               │ CodigoID
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
┌──────────────────────┐  ┌─────────────────────┐
│ dbo.ArmazensStocks   │  │ dbo.Atendimento     │
│ (ars)                │  │ Detalhe (d)         │
│ FK: CodigoID         │  │ FK: CodigoID        │
│     ArmazemID        │  │     [Atendimento ID]│
│     [Fornecedor      │  └──────────┬──────────┘
│      Habitual]       │             │ [Atendimento ID]
└──┬──────────────────┬┘             ▼
   │                  │     ┌──────────────────┐
   │ ArmazemID        │     │ dbo.Atendimento  │
   │                  │     │ (a)              │
   ▼                  ▼     │ PK: [Atendimento │
┌──────────────┐  ┌──────────────────┐ ID]      │
│ dbo.Armazens │  │ dbo.Fornecedores │└──────────┘
│ PK: ArmazemID│  │ PK: [Fornecedor  │
└──────────────┘  │      ID]         │
                  └──────────────────┘
```

Edges (com keys exactas):

| Origem | Coluna | Destino | Coluna | Tipo |
|---|---|---|---|---|
| `dbo.ArmazensStocks` | `CodigoID` | `dbo.Stocks` | `CodigoID` | N:1, implícita |
| `dbo.ArmazensStocks` | `ArmazemID` | `dbo.Armazens` | `ArmazemID` | N:1, implícita |
| `dbo.ArmazensStocks` | `[Fornecedor Habitual]` | `dbo.Fornecedores` | `[Fornecedor ID]` | N:1, implícita, opcional |
| `dbo.Atendimento Detalhe` | `[Atendimento ID]` | `dbo.Atendimento` | `[Atendimento ID]` | N:1, implícita |
| `dbo.Atendimento Detalhe` | `CodigoID` | `dbo.Stocks` | `CodigoID` | N:1, implícita |

## 3. Entidades canónicas e tabelas-alvo no SPharm.MT

Modelos finais em `prisma/schema.prisma`. Cada um descreve **um
contrato de payload** que o agent vai enviar quando o ingest começar.

| Canonical | Modelo SPharm.MT | Granularidade | Idempotência |
|---|---|---|---|
| produto (catálogo global) | `Produto` | global por CNP | `@@unique(cnp)` — forte |
| produto-farmácia | `ProdutoFarmacia` | par produto×farmácia | `@@unique(produtoId, farmaciaId)` — forte |
| stock corrente | `ProdutoFarmacia.stockAtual` (campo) | snapshot mais recente | sobrescreve por par |
| stock histórico | `HistoricoStock` | par × data | `@@unique(farmaciaId, produtoId, dataFotografia)` |
| venda diária | `Venda` | linha agregada produto×dia×farmácia | fraca — via `LoteIngestao.hashConteudo` |
| venda mensal | `VendaMensal` | par × ano × mês | `@@unique(farmaciaId, produtoId, ano, mes)` |

## 4. Mapping coluna→campo (resolução híbrida)

Algumas colunas são **conhecidas exactamente** (validadas em probes —
PKs e FKs com nomes que o operador identificou). Outras são
**resolvidas heuristicamente** em runtime, via `classifyColumns` sobre
`sys.columns` da tabela. Os comandos preview combinam as duas:
qualifiam o que sabem, descobrem o resto.

### 4.1 produto (a partir de `dbo.Stocks`)

| SPharm.MT | Coluna ERP | Resolução |
|---|---|---|
| `cnp` ou código interno | `CodigoID` | **fixa** — PK confirmada |
| `designacao` | `[Nome Comercial]` | **fixa** — confirmada nos previews |
| `pvp` | `[Preco Venda Publico_EUR]` | **fixa** — PVP **comercial** |
| `pmc` | `[Preco Medio Compra_EUR]` | **fixa** — preço médio de compra |
| `puc` | `[Preco Ultima Compra_EUR]` | **fixa** — preço da última compra. **Não** confundir com `[Preco Ultima Devolucao_EUR]` (devolução, não custo) |
| `dataUltimaVenda` | `[Data Ultima Venda]` | **fixa** — usada como ordering preview |
| `flagMSRM` / `flagGenerico` | (pendente) | requerem decodificação (`Tipo Documento` ou flags próprias) |

> **PVP comercial vs. regulatório.** `[Preco Venda Publico_EUR]` é
> o PVP operacional praticado pela farmácia. `PVPMaxSNS` e
> `PVPInfarmed` (se existirem) são **regulatórios** (tetos legais ou
> referência SNS) e **não devem substituir** o PVP comercial — só
> servem como contexto adicional do lado SaaS.
> Esta correcção foi feita em 2026-05-13 após a heurística inicial
> ter caído em `PVPMaxSNS`.

> **PUC = última compra, não devolução.** O Softreis tem dois campos
> superficialmente parecidos: `[Preco Ultima Compra_EUR]` é o custo
> da última compra; `[Preco Ultima Devolucao_EUR]` é o preço de uma
> linha de devolução. Apenas o primeiro entra como PUC canónico —
> a heurística inicial caiu em "devolucao" porque o token "preco
> ultima" matchou ambos.

> Stock corrente **não vem de Stocks** — vem de `ArmazensStocks`
> (per-armazém). O master `Stocks` tem só preços, identificação e
> flags operacionais.

#### Filtro operacional Stocks (aplicado a TODAS as queries downstream)

| Coluna | Tipo | Filtro | Razão |
|---|---|---|---|
| `[Retirado]` | bit/int | `= 0` | Exclui produtos descontinuados |
| `[Processa_Stocks]` | bit/int | `<> 0` | Exclui artigos "técnicos" (serviços, etiquetas, brindes) que não circulam por stock |

Estas duas colunas combinadas dão a vista "operacional" de produtos —
o que efectivamente vende, repõe e movimenta. Aplicado em
`products-preview` e `stock-preview`; aplicável também ao futuro
`bootstrap` para o filtro de catálogo enviado ao SaaS.

### 4.2 stock-por-armazém (a partir de `dbo.ArmazensStocks`)

| SPharm.MT | Coluna ERP | Resolução |
|---|---|---|
| chave produto | `CodigoID` | **fixa** — FK → Stocks |
| chave armazém | `ArmazemID` | **fixa** — FK → Armazens |
| chave fornecedor habitual | `[Fornecedor Habitual]` | **fixa** — FK → Fornecedores |
| `stockAtual` | `[Existencia Actual]` | **fixa** — confirmada nos previews |
| `stockMinimo` | `[Stock Minimo]` | **fixa** |
| `stockMaximo` | `[Stock Maximo/Reposicao]` | **fixa** — barra "/" é literal no nome da coluna (single identifier Softreis) |

### 4.3 venda (header `dbo.Atendimento` + linhas `dbo.Atendimento Detalhe`)

**Atendimento (cabeçalho):**

| SPharm.MT | Coluna ERP | Resolução |
|---|---|---|
| chave documento | `[Atendimento ID]` | **fixa** — PK confirmada |
| `data` | `[Data Venda]` | **fixa** |
| filtro "finalizado" | `[Fim Venda] = 'S'` | **fixa** — só vendas concluídas entram |
| `tipoVenda` | `[Tipo Documento]` | **fixa** — decodificação pendente. `TipoDoc = 77` parece venda real, mas a caracterização completa fica para depois do preview validar os tipos observados |

**Atendimento Detalhe (linhas) — TODAS confirmadas em 2026-05-13:**

| SPharm.MT preview | Coluna ERP | Notas |
|---|---|---|
| `DetalheID` | `[Detalhe ID]` | PK da linha de detalhe — necessária para distinguir duplicados |
| `Sequencia` | `[Sequencia]` | Ordem da linha dentro do atendimento — tiebreaker estável |
| `AtendID` | `[Atendimento ID]` | FK → Atendimento.[Atendimento ID] |
| `CodigoID` | `[CodigoID]` | FK → Stocks.CodigoID |
| `Qtd` | `[Quantidade]` | Quantidade vendida |
| `PVPUnitario` | `[Preco Venda Publico_EUR]` | PVP unitário no momento da venda |
| `ValorLinha` | `[Valor_EUR]` | Valor total da linha |
| `IVAValor` | `[Val_IVA_EUR]` | IVA da linha |
| `DescontoValor` | `[Val_Desc_EUR]` | Desconto aplicado na linha |
| `Comparticipacao1` | `[PrComp_EUR]` | Comparticipação principal (entidade primária) |
| `Comparticipacao2` | `[PrComp_EUR2]` | Comparticipação secundária |
| `EntidadeID` | `[Entidade ID]` | Identificador da entidade comparticipadora |

> **Linhas duplicadas no mesmo atendimento podem ser legítimas.** Dois
> registos com o mesmo `[Atendimento ID]` e `[CodigoID]` distinguem-se
> por `[Detalhe ID] + [Sequencia]`. Não agregar no preview — operador
> precisa de ver linhas separadas para validar o significado real.

> **Não filtrar por `[Tipo Documento]` ainda.** O preview mostra-o no
> SELECT mas mantém-no fora do WHERE; lista de tipos técnicos a
> excluir só fica fechada depois do operador caracterizar os tipos
> observados em condições reais.

## 5. Comandos do agent (estado actual)

| Comando | Categoria | Output | Read-only? |
|---|---|---|---|
| `discover` | introspecção | JSON + MD em `agent/output/` | ✅ só `sys.*` + MIN/MAX de datas |
| `discover-products` | probe categorizado | stdout, TOP 5 | ✅ TOP 5 |
| `discover-stock` | probe categorizado | stdout, TOP 5 + sumário stock | ✅ TOP 5 + 3 `COUNT(*)` |
| `discover-sales` | probe categorizado | stdout, TOP 5 + dias top | ✅ TOP 5 + 1 `GROUP BY` |
| `probe-table` | probe genérico dirigido | stdout, PK/FKs/datas/TOP 5 | ✅ TOP 5 |
| `products-preview` | preview operacional | stdout, TOP 20 com JOINs | ✅ TOP 20 |
| `stock-preview` | preview operacional | stdout, TOP 20 com JOINs | ✅ TOP 20 |
| `sales-preview` | preview operacional | stdout, TOP 20 com JOINs + filtros | ✅ TOP 20 + `WHERE` indexed |

### 5.1 `discover` e `discover-*`

Já documentados em §4 da versão v0.1. Sem alterações na semântica;
auto-pick `candidates[0]` removido em 2026-05-13 (a heurística falha
demasiado).

### 5.2 `probe-table`

Probe dirigido genérico. Dump de PK, FKs IN/OUT declaradas, índices,
MIN/MAX das primeiras 3 colunas-data, TOP 5 amostras. Uso típico:

```text
probe-table --table dbo.Stocks
probe-table --table "dbo.Atendimento Detalhe"
```

### 5.3 `products-preview`

Todas as colunas-preço fixas. Apenas `<nome>` de Fornecedores fica
heurístico (operador ainda não confirmou).

```sql
SELECT TOP 20
  s.CodigoID,
  s.[Nome Comercial]            AS Designacao,
  s.[Preco Venda Publico_EUR]   AS PVP,
  s.[Preco Medio Compra_EUR]    AS PMC,
  s.[Preco Ultima Compra_EUR]   AS PUC,
  s.[Data Ultima Venda]         AS DataUltVenda,
  ars.ArmazemID,
  ars.[Existencia Actual]       AS Stock,
  ars.[Fornecedor Habitual]     AS FornHabID,
  f.<nome>                      AS Fornecedor
FROM [dbo].[Stocks] s
LEFT JOIN [dbo].[ArmazensStocks] ars ON ars.CodigoID = s.CodigoID
LEFT JOIN [dbo].[Fornecedores] f ON f.[Fornecedor ID] = ars.[Fornecedor Habitual]
WHERE s.[Retirado] = 0
  AND s.[Processa_Stocks] <> 0
ORDER BY s.[Data Ultima Venda] DESC, s.CodigoID
```

Notas:
- Filtro operacional `[Retirado]=0 AND [Processa_Stocks]<>0` — vide
  §4.1.
- `ORDER BY [Data Ultima Venda] DESC` — mostra primeiro os produtos
  mais "vivos" (vendidos recentemente). NULLs vão para o fundo
  (default DESC NULL-last em SQL Server).
- LEFT JOIN com `ArmazensStocks` mantém-se — operador precisa de ver
  produtos sem presença em armazém (raro mas diagnóstico útil).
- Um produto com N armazéns aparece N vezes (até ao limite TOP 20).

### 5.4 `stock-preview`

```sql
SELECT TOP 20
  s.CodigoID,
  s.[Nome Comercial]              AS Designacao,
  ars.ArmazemID,
  a.<nome_armazem>                AS Armazem,
  ars.[Existencia Actual]         AS Existencia,
  ars.[Stock Minimo]              AS StockMin,
  ars.[Stock Maximo/Reposicao]    AS StockMax
FROM [dbo].[Stocks] s
JOIN [dbo].[ArmazensStocks] ars ON ars.CodigoID = s.CodigoID
LEFT JOIN [dbo].[Armazens] a ON a.ArmazemID = ars.ArmazemID
WHERE s.[Retirado] = 0
  AND s.[Processa_Stocks] <> 0
ORDER BY ars.[Existencia Actual] DESC, s.CodigoID
```

Notas:
- INNER JOIN com `ArmazensStocks` — stock-preview por definição mostra
  produtos com presença em armazém.
- LEFT JOIN com `Armazens` — `ArmazemID` órfão é diagnóstico útil.
- Filtro operacional Stocks aplicado igual ao products-preview.
- `ORDER BY [Existencia Actual] DESC` — operador vê primeiro o que
  tem mais stock; útil para confirmar magnitudes plausíveis.

### 5.5 `sales-preview`

Requer `--from YYYY-MM-DD` e `--to YYYY-MM-DD`. **Todas as colunas
fixas** — sem heurística.

```sql
SELECT TOP 20
  d.[Detalhe ID]                AS DetalheID,
  d.[Sequencia]                 AS Sequencia,
  a.[Atendimento ID]            AS AtendID,
  a.[Data Venda]                AS DataVenda,
  a.[Tipo Documento]            AS TipoDoc,
  d.[CodigoID]                  AS CodigoID,
  s.[Nome Comercial]            AS Designacao,
  d.[Quantidade]                AS Qtd,
  d.[Preco Venda Publico_EUR]   AS PVPUnitario,
  d.[Valor_EUR]                 AS ValorLinha,
  d.[Val_IVA_EUR]               AS IVAValor,
  d.[Val_Desc_EUR]              AS DescontoValor,
  d.[PrComp_EUR]                AS Comparticipacao1,
  d.[PrComp_EUR2]               AS Comparticipacao2,
  d.[Entidade ID]               AS EntidadeID
FROM [dbo].[Atendimento] a
JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]
WHERE a.[Fim Venda] = 'S'
  AND a.[Data Venda] BETWEEN @from AND @to
ORDER BY a.[Data Venda] DESC, a.[Atendimento ID], d.[Sequencia]
```

Notas:
- 15 colunas — linha-a-linha, **sem agregação**. Operador precisa de
  ver duplicados legítimos no mesmo atendimento (`Detalhe ID +
  Sequencia` distinguem-nos).
- `[Fim Venda] = 'S'` hardcoded — vendas concluídas apenas.
- `[Tipo Documento]` no SELECT, fora do WHERE — caracterização
  pendente. `TipoDoc = 77` parece venda real (validado em preview)
  mas a lista completa de tipos a excluir só fecha na próxima
  iteração.
- INNER JOIN em `Stocks` — uma linha de venda sem `CodigoID` em
  `Stocks` é um problema de dados (logged depois, no bootstrap).
- `BETWEEN @from AND @to` — parametrizado via `mssql.NVarChar` com
  formato `YYYY-MM-DD HH:MM:SS` (from às 00:00:00, to às 23:59:59).
- ORDER BY estabiliza a saída: data mais recente primeiro, depois
  AtendID, depois Sequencia. Reproduce-se entre execuções.

### 5.6 `sales-summary-preview`

Preview agregado para caracterizar a semântica das vendas. Duas
queries no mesmo intervalo `[from, to]`.

**Query 1 — GROUP BY `[Tipo Documento]`, `[Entidade ID]`:**

```sql
SELECT
  a.[Tipo Documento]                                  AS TipoDoc,
  d.[Entidade ID]                                     AS EntidadeID,
  COUNT(*)                                            AS Linhas,
  COUNT(DISTINCT a.[Atendimento ID])                  AS Atendimentos,
  CAST(SUM(d.[Quantidade]) AS DECIMAL(18,3))          AS QtdTotal,
  CAST(SUM(d.[Valor_EUR]) AS DECIMAL(18,2))           AS ValorEUR,
  CAST(SUM(d.[Preco Venda Publico_EUR] * d.[Quantidade]) AS DECIMAL(18,2)) AS PVPCalculado,
  CAST(SUM(ISNULL(d.[PrComp_EUR], 0)) AS DECIMAL(18,2))    AS Comp1,
  CAST(SUM(ISNULL(d.[PrComp_EUR2], 0)) AS DECIMAL(18,2))   AS Comp2,
  MIN(a.[Data Venda])                                 AS DataMin,
  MAX(a.[Data Venda])                                 AS DataMax
FROM [dbo].[Atendimento] a
JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]
WHERE a.[Fim Venda] = 'S'
  AND a.[Data Venda] BETWEEN @from AND @to
GROUP BY a.[Tipo Documento], d.[Entidade ID]
ORDER BY a.[Tipo Documento], d.[Entidade ID]
```

**Query 2 — TOP 10 documentos por `SUM([Valor_EUR])` DESC:**

```sql
SELECT TOP 10
  a.[Atendimento ID]                                  AS AtendID,
  a.[Data Venda]                                      AS DataVenda,
  a.[Tipo Documento]                                  AS TipoDoc,
  CAST(SUM(d.[Valor_EUR]) AS DECIMAL(18,2))           AS TotalValorLinha,
  CAST(SUM(d.[Preco Venda Publico_EUR] * d.[Quantidade]) AS DECIMAL(18,2)) AS TotalPVP,
  CAST(SUM(ISNULL(d.[PrComp_EUR], 0) + ISNULL(d.[PrComp_EUR2], 0)) AS DECIMAL(18,2)) AS TotalCompart
FROM [dbo].[Atendimento] a
JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]
WHERE a.[Fim Venda] = 'S'
  AND a.[Data Venda] BETWEEN @from AND @to
GROUP BY a.[Atendimento ID], a.[Data Venda], a.[Tipo Documento]
ORDER BY SUM(d.[Valor_EUR]) DESC
```

#### Heurística de interpretação

Comparando `ValorEUR` com `PVPCalculado`, `Comp1+Comp2` por combo
TipoDoc/EntidadeID, é possível inferir:

| Padrão observado | Interpretação provável |
|---|---|
| `ValorEUR ≈ PVPCalculado − (Comp1 + Comp2)` | `[Valor_EUR]` = **pago utente** |
| `ValorEUR ≈ PVPCalculado` | `[Valor_EUR]` = **total linha** (PVP × qtd) |
| `ValorEUR ≈ 0`, `Comp1+Comp2 ≈ PVPCalculado` | TipoDoc é venda 100% comparticipada |
| `Linhas = Atendimentos` | Possível documento técnico (uma linha por doc) |
| `EntidadeID = 0` (ou similar) | Venda sem comparticipação / utente particular |

A decisão final sobre a semântica de `[Valor_EUR]` faz parte da
caracterização de TipoDoc antes do bootstrap. Sem esta clarificação
o agent não consegue mapear `Venda.valorTotal` vs.
`Venda.valorPagoUtente` correctamente.

### 5.7 `bootstrap-dry-run`

Preview da **primeira ingestão controlada**. Transforma os dados ERP
em payloads canónicos SPharm.MT, conta tudo, imprime amostras +
alertas. **Sem chamadas SaaS, sem escrita em Neon, sem bootstrap
real.** Stdout only.

Requer `--from YYYY-MM-DD` e `--to YYYY-MM-DD` (intervalo das vendas).

#### Pipeline 1 — PRODUTOS

Fonte: `dbo.Stocks` (OUTER APPLY `dbo.ArmazensStocks` para
fornecedor habitual + LEFT JOIN `dbo.Fornecedores` para nome).

Filtro: `s.[Retirado] = 0 AND s.[Processa_Stocks] <> 0`.

```typescript
type ProductPayload = {
  externalProductId:      number | null;  // Stocks.CodigoID
  cnp:                    number | null;  // Stocks.[Codigo]
  designacao:             string | null;  // Stocks.[Nome Comercial]
  pvp:                    number | null;  // Stocks.[Preco Venda Publico_EUR]
  pmc:                    number | null;  // Stocks.[Preco Medio Compra_EUR]
  puc:                    number | null;  // Stocks.[Preco Ultima Compra_EUR]
  dataUltimaVenda:        string | null;  // ISO da Stocks.[Data Ultima Venda]
  dataUltimaCompra:       string | null;  // ISO da Stocks.[Data Ultima Compra]
  retirado:               boolean | null; // Stocks.[Retirado]
  generico:               boolean | null; // Stocks.[Generico]
  mnsrmNCompart:          boolean | null; // Stocks.[MNSRM_NCompart]
  fornecedorHabitualId:   number | null;  // ArmazensStocks.[Fornecedor Habitual] (TOP 1 ArmazemID)
  fornecedorHabitualNome: string | null;  // Fornecedores.[Nome Abreviado]
};
```

`OUTER APPLY` resolve o fornecedor habitual via 1 row por
`CodigoID` (menor `ArmazemID`) — evita cartesian explosion sem
agregação em JS.

#### Pipeline 2 — STOCK

Fonte: `dbo.ArmazensStocks` JOIN `dbo.Stocks` (filtro idêntico).

```typescript
type StockPayload = {
  externalProductId:   number | null;  // ArmazensStocks.CodigoID
  externalWarehouseId: number | null;  // ArmazensStocks.ArmazemID
  stockAtual:          number | null;  // ars.[Existencia Actual]
  stockMinimo:         number | null;  // ars.[Stock Minimo]
  stockMaximo:         number | null;  // ars.[Stock Maximo/Reposicao]
  stockEncomenda:      number | null;  // ars.[Existencia Encomenda]
  stockReserva:        number | null;  // ars.[Existencia Reserva]
};
```

#### Pipeline 3 — VENDAS LINHA-A-LINHA

Fonte: `dbo.Atendimento` JOIN `dbo.Atendimento Detalhe`. **Sem**
JOIN com `dbo.Stocks` (para contar orphans).

Filtros: `a.[Fim Venda] = 'S' AND a.[Data Venda] BETWEEN @from AND @to`.

```typescript
type SaleLinePayload = {
  externalSaleId:        number | null;
  externalSaleLineId:    number | null;
  dataVenda:             string | null;          // ISO
  tipoDocumento:         number | null;          // raw
  tipoDocumentoClass:    "VENDA" | "DEVOLUCAO_ANULACAO" | "UNKNOWN";
  externalProductId:     number | null;
  quantidade:            number | null;
  pvpUnitario:           number | null;
  valorLinha:            number | null;
  ivaValor:              number | null;
  descontoValor:         number | null;
  comparticipacao1:      number | null;
  comparticipacao2:      number | null;
  entidadeId:            number | null;
};
```

**Classificação inicial de `[Tipo Documento]`:**

| Raw value | Class | Notas |
|---|---|---|
| `77` | `VENDA` | Venda real (validado em previews) |
| `104` | `DEVOLUCAO_ANULACAO` | Linhas negativas; tratamento pendente |
| `2` | `UNKNOWN` | Incluído nas contagens; **não** marcado como venda ainda |
| outro | `UNKNOWN` | Listado em quality alert para caracterizar |

A classificação é **JS-side** após o fetch — o SQL não filtra por
TipoDoc para que os alerts vejam tudo.

#### Output (3 blocos)

```text
══ Pipeline 1: PRODUTOS ══
Contagem total: 12345 produtos elegíveis
Quality alerts:
  · sem stock row em ArmazensStocks: N
  · com stock < 0 em algum armazém:  N
TOP 10 payloads (ordenados por [Data Ultima Venda] DESC):
  [ 1] {"externalProductId":...,"cnp":...,...}

══ Pipeline 2: STOCK ══
Contagem total: 45678 stock rows
Quality alerts:
  · rows com Existencia Actual < 0:  N
TOP 10 payloads (ordenados por [Existencia Actual] DESC):
  [ 1] {"externalProductId":...,"externalWarehouseId":...,...}

══ Pipeline 3: VENDAS LINHA-A-LINHA ══
Métricas agregadas:
  Total linhas, atendimentos
  SUM(valorLinha), SUM(pvp*qtd), SUM(comp1+comp2)
Contagem por TipoDoc × EntidadeID (tabela)
Quality alerts:
  · linhas com produto não-encontrado em Stocks: N
  · TipoDocs desconhecidos (fora de 77/104/2):
      · TipoDoc 99 → N linhas
TOP 20 payloads
```

#### Princípios

- **Não calcula vendas agregadas finais.** O bootstrap real vai
  precisar de decidir entre `valorTotal` vs `valorPagoUtente` —
  decisão pendente da caracterização de `[Valor_EUR]` em
  `sales-summary-preview` (§5.6).
- **Preserva todos os campos brutos.** O dry-run não normaliza
  comparticipações, não infere flags, não calcula DCI/ATC.
- **Batching defensivo (forward-looking).** TOP/sample agora;
  quando o bootstrap real for entregue, chunkará 5k linhas por
  chamada a `/api/ingest/v1/*`.
- **Schema check fail-fast.** `assertColumnsExist` cobre todas as
  colunas usadas em qualquer pipeline; um rename Softreis lança erro
  diagnóstico antes de qualquer query data-side.

## 6. Convenção de output dos previews

Cada preview imprime:

```text
──────────────────────────────────────────────────────────────────────
<command> — preview operacional
──────────────────────────────────────────────────────────────────────
Database         : <DB>@<host>:<port>
Tabelas          : dbo.Stocks, dbo.ArmazensStocks, dbo.Fornecedores
Filtros          : <hardcoded + flags>
Colunas resolvidas:
  Designacao      ← Stocks.Descricao
  PVP             ← Stocks.PVP
  …
TOP 20 linhas:
  AtendID  DataVenda   TipoDoc  CodigoID  …
  -----    ---------   -------  --------  …
  …
──────────────────────────────────────────────────────────────────────
Sem persistência — copia o bloco acima.
```

Render horizontal com cells truncadas a 24 chars. Operador precisa de
janela cmd com >=180 chars de largura — instrução em INSTALL_WINDOWS.

## 7. Ordem de progressão operacional

1. ✅ Operador correu `run-discover.bat` (gerou `output/spharm-sqlserver-discovery.json`)
2. ✅ Operador validou tabelas com `run-probe-table.bat` (confirmou §2)
3. ✅ Operador correu os 3 `*-preview` para validar dados reais
4. ✅ Operador correu `sales-summary-preview` para caracterizar TipoDoc/EntidadeID
5. ✅ Operador correu `bootstrap-dry-run` — payloads canónicos validados
6. ✅ Endpoints SaaS `/api/ingest/v1/bootstrap/*` entregues (§8 abaixo)
7. ✅ `ENABLE_AGENT_BOOTSTRAP=1` activo no SaaS (Vercel env var)
8. ✅ Migration `20260513150000_add_agent_bootstrap_staging` aplicada em demo-neon
9. ✅ `bootstrap-upload` 1-dia validado em demo-neon (rev8, batch 50/100/200)
10. ✅ `daily-sync` + `daily-sync-dry-run` entregues (§9 acima)
11. ⏳ Validar `daily-sync-dry-run` para o dia seguinte ao bootstrap inicial
12. ⏳ Validar `daily-sync` real → verificar idempotência (counts não duplicam)
13. ⏳ Agendar `daily-sync` automático via Task Scheduler (.bat com --date=ontem)
14. ✅ Classifier server-side de TipoDocumento entregue (§10):
    - Modelo `TipoDocumentoClassificacao` + migration 20260514100000
    - Scripts `classify-tipodoc` + `reclassify-ingest-vendas`
    - Endpoint `sales-lines` prefere server-side; payload do agent é fallback
15. ⏳ Caracterizar TipoDoc 7 com `sales-summary-preview` para 2024-01-01
16. ⏳ Caracterizar TipoDoc 2 (data ainda não vista)
17. ⏳ Fechar semântica de `[Valor_EUR]` (pago utente vs. total linha)
18. ⏳ Implementar agregação `IngestVendaLinhaRaw` → `VendaMensal` (script + idempotência)
19. ⏳ Refresh IPF + projections finais (lado SaaS, fora do agent)

Passos 15–19 são **iterações posteriores**. Este documento lock-in os
passos 1–14.

## 8. Endpoints SaaS `/api/ingest/v1/bootstrap/*` (v0.6)

Endpoints para a **1ª ingestão real**. Gated por feature flag, idempotentes,
additive (sem deletes). Auth via `withIntegrationAuth` — mesmo padrão dos
outros `/api/ingest/v1/*`: header `Authorization: Bearer <key>` +
`X-Tenant-Slug: <slug>`.

### 8.1 Regras invariantes dos endpoints

1. **Feature flag obrigatória.** `ENABLE_AGENT_BOOTSTRAP=1` (env Vercel).
   Sem isto, todos os 3 endpoints respondem **HTTP 503** com
   `{ error: "feature_disabled" }`. Defesa contra activação acidental.
2. **`withIntegrationAuth`.** O tenant é resolvido pelo slug + key
   (mesmo padrão de `/heartbeat`, `/snapshot/stock`, etc.). `ctx.prisma`
   já vem apontado à BD do tenant; impossível escrever no tenant errado.
3. **Validação de `farmaciaId`.** O endpoint confirma que a farmácia
   existe na BD do tenant e está em estado `ATIVO`. 404 / 409 quando não.
4. **Batch limit.** `BOOTSTRAP_MAX_BATCH_SIZE = 1000` items por request.
   Acima → HTTP 413. Agent particiona client-side.
5. **Idempotência forte.** Reupload do mesmo batch produz mesmo estado.
   Chaves de upsert:
   - products: `Produto.cnp` (unique global no tenant)
   - stock: `(produtoId, farmaciaId)` (`@@unique` em `ProdutoFarmacia`)
   - sales-lines: `(farmaciaId, externalSaleLineId)` (`@@unique` em
     `IngestVendaLinhaRaw`)
6. **Additive upsert.** `undefined`/null no payload **não apaga** o valor
   existente. Apenas sobrescreve quando há valor concreto.
7. **Sem agregação ainda.** `sales-lines` entram em **staging raw** em
   `IngestVendaLinhaRaw`. **Nada é escrito em `Venda`, `VendaMensal`,
   `HistoricoStock` ou similar.** Dashboards continuam intactos.

### 8.2 POST `/api/ingest/v1/bootstrap/products`

**Body:**
```typescript
{
  farmaciaId: string,
  items: ProductPayload[]  // ver §5.7 para shape
}
```

**Comportamento:**
1. Upsert `Produto` by `cnp` (key canónica). `externalProductId`,
   `designacao`, `flagGenerico`, `flagMnsrmNCompart` são actualizados.
   `dci`, `codigoATC`, `fabricanteId`, `formaFarmaceutica` — **NÃO
   tocados** (vêm de RegulatoryRecord / INFARMED).
2. Upsert `ProdutoFarmacia` by `(produtoId, farmaciaId)`. Set:
   `pvp`, `pmc`, `puc`, `dataUltimaVenda`, `dataUltimaCompra`,
   `flagRetirado`, `fornecedorExternalId`, `fornecedorOrigem`.
   **NÃO** toca em `stockAtual`/`stockMinimo`/`stockMaximo` (esses
   vêm do endpoint /stock).
3. Items sem `cnp` ou sem `designacao` → skipped (não erro).

**Response 200:**
```json
{
  "ok": true,
  "accepted": 200,
  "upserted": 198,
  "skipped": [{ "index": 5, "reason": "missing_cnp", "externalId": 12345 }],
  "errors": [],
  "durationMs": 1234
}
```

### 8.3 POST `/api/ingest/v1/bootstrap/stock`

**Body:** `{ farmaciaId, items: StockPayload[] }`

**Comportamento:**
1. Agregar por `externalProductId` (SUM): produto com N armazéns →
   1 row em `ProdutoFarmacia` com soma dos stocks. Granularidade
   do payload preserva-se (per armazém) para audit; persistência
   é per-produto.
2. Resolver `externalProductId → produtoId` via `Produto.externalProductId`
   (1 query batch).
3. Upsert `ProdutoFarmacia` setando `stockAtual`, `stockMinimo`,
   `stockMaximo`, `stockEncomenda`, `stockReserva`.
4. Produtos não-encontrados em `Produto` → skipped (correr
   `/bootstrap/products` antes).

**Response:** mesma shape de products + `aggregated: N` (nº de produtos
distintos após agregação).

### 8.4 POST `/api/ingest/v1/bootstrap/sales-lines`

**Body:** `{ farmaciaId, items: SaleLinePayload[] }`

**Comportamento:**
1. Coerce + validar shape (`externalSaleId`, `externalSaleLineId`,
   `externalProductId` obrigatórios; resto opcional).
2. `tipoDocumentoClass` validado contra `["VENDA", "DEVOLUCAO_ANULACAO",
   "UNKNOWN"]`; valores desconhecidos → forçado a `"UNKNOWN"`.
3. Resolver `externalProductId → produtoId` via `Produto.externalProductId`
   (best-effort — `produtoId` pode ficar null se produto não
   existir).
4. Upsert `IngestVendaLinhaRaw` by `(farmaciaId, externalSaleLineId)`.
   Inclui `rawJson` com o payload original (forensic).
5. **Nenhuma agregação para `VendaMensal`.** Linhas ficam em staging.

**Response:** mesma shape + `orphanProductLines: N` (linhas sem produto
resolvido — diagnóstico de data quality, não erro).

### 8.5 Comando agent `bootstrap-upload`

```text
bootstrap-upload --from YYYY-MM-DD --to YYYY-MM-DD
```

Sequência (halt-on-error):
1. **products** — keyset por `CodigoID`, batch 200, POST `/bootstrap/products`
2. **stock** — keyset por `CodigoID` com `GROUP BY` SQL-side (SUM), batch
   200, POST `/bootstrap/stock`
3. **sales-lines** — keyset por `[Detalhe ID]`, batch 500, POST
   `/bootstrap/sales-lines`

Cada pipeline pagina por keyset (`WHERE keyId > @lastId ORDER BY keyId`)
para SQL Server 2008 R2 sem `OFFSET/FETCH`. Total memory footprint
limitado ao batch size × dimensão do payload.

Cada batch reporta no stdout: `read=X accepted=Y upserted=Z
skipped=N errors=M`. Erros parciais não interrompem batches; erros do
endpoint inteiro (HTTP 5xx) interrompem o pipeline.

**Activação operacional:**
- `run-bootstrap-upload.bat` no ZIP do agent (Windows) pede datas E
  uma confirmação explícita (`CONFIRMO`) — diferente dos dry-run /
  previews que correm sem confirmação.

### 8.6 Schema novo — `IngestVendaLinhaRaw`

Tabela staging das linhas de venda. **Não é** `Venda` — é raw
forensic-ready. Migration:
`prisma/migrations/20260513150000_add_agent_bootstrap_staging`.

Colunas-chave:
- `farmaciaId + externalSaleLineId` (`@@unique` para idempotência)
- `tipoDocumentoClass: "VENDA" | "DEVOLUCAO_ANULACAO" | "UNKNOWN"` (string)
- `rawJson: Json` (payload completo para reprocessamento)
- `produtoId: String?` (resolvido best-effort, nullable)

Reverse relations adicionadas a:
- `Farmacia.ingestVendasLinhasRaw IngestVendaLinhaRaw[]`
- `Produto.ingestVendasLinhasRaw IngestVendaLinhaRaw[]`

### 8.7 Boundary com loaders existentes

| Loader / endpoint | Toca `Produto`? | Toca `ProdutoFarmacia`? | Conflito com bootstrap? |
|---|---|---|---|
| `import-excel.ts` (legacy) | ✅ upsert por cnp | ✅ upsert por par | **Concorrência aceitável** — additive em ambos; `dataAtualizacao` distingue origem |
| `import-infarmed-snapshot.ts` | ✅ upsert por cnp | ❌ | Sem conflito — toca campos regulatórios distintos |
| `/api/ingest/v1/snapshot/stock` | — | ✅ via importer | **Concorrência aceitável** — additive; ambos partilham `Produto.externalProductId` mapping |
| `/api/ingest/v1/bootstrap/products` | ✅ NOVO | ✅ NOVO | (próprio) |

Nenhum endpoint pré-existente foi alterado. Nenhum loader foi
modificado. Dashboards não veem `IngestVendaLinhaRaw` (não tem queries).

## 9. Sync incremental diário (v0.7)

Após bootstrap inicial validado, o sync incremental diário usa os
**mesmos** endpoints `/api/ingest/v1/bootstrap/*` mas com SQL filtrado
para um único dia. Sem novos endpoints, sem novo modelo de dados,
sem nova feature flag. Idempotência continua garantida pelos mesmos
unique constraints.

### 9.1 Granularidade incremental — filtros SQL

**PRODUTOS** — Stocks alterados em `@date`:

```sql
WHERE s.[Retirado] = 0
  AND s.[Processa_Stocks] <> 0
  AND s.CodigoID > @lastId
  AND (
    CAST(s.[Data Ultima Venda] AS DATE) = @date
    OR CAST(s.[Data Ultima Compra] AS DATE) = @date
    OR CAST(s.[Data_Actualiz] AS DATE) = @date   -- opcional
  )
```

`[Data_Actualiz]` é Softreis-version-dependent. O agent detecta em
runtime via `sys.columns` e inclui no filtro só se existir. Se não
existir, ficamos com `[Data Ultima Venda]` + `[Data Ultima Compra]`,
que ainda é conservador: qualquer venda ou compra no dia → produto
incluído.

**STOCK** — produtos movimentados em `@date`, **uma linha por
armazém** (snapshot actual). Agregação por `externalProductId` é
feita server-side.

```sql
SELECT
  ars.CodigoID                AS externalProductId,
  ars.ArmazemID               AS externalWarehouseId,  -- preserva audit
  ars.[Existencia Actual]     AS stockAtual,
  ars.[Stock Minimo]          AS stockMinimo,
  ars.[Stock Maximo/Reposicao] AS stockMaximo,
  ars.[Existencia Encomenda]  AS stockEncomenda,
  ars.[Existencia Reserva]    AS stockReserva
FROM [dbo].[ArmazensStocks] ars
INNER JOIN (
  -- Pega nos próximos N CodigoIDs distintos com movimento no dia
  SELECT DISTINCT TOP (@n) sub_ars.CodigoID
  FROM [dbo].[ArmazensStocks] sub_ars
  JOIN [dbo].[Stocks] s ON s.CodigoID = sub_ars.CodigoID
  WHERE s.[Retirado] = 0
    AND s.[Processa_Stocks] <> 0
    AND sub_ars.CodigoID > @lastId
    AND EXISTS (
      SELECT 1 FROM [dbo].[StocksMov] sm
      WHERE sm.CodigoID = sub_ars.CodigoID
        AND CAST(sm.[DataMov] AS DATE) = @date
    )
  ORDER BY sub_ars.CodigoID
) batch_codigos ON batch_codigos.CodigoID = ars.CodigoID
JOIN [dbo].[Stocks] s ON s.CodigoID = ars.CodigoID
WHERE s.[Retirado] = 0
  AND s.[Processa_Stocks] <> 0
ORDER BY ars.CodigoID, ars.ArmazemID
```

`StocksMov` é a tabela de movimentos individuais (vendas, compras,
ajustes). Filtro por `DataMov` identifica os `CodigoID` movimentados;
o snapshot retorna **TODAS** as linhas `ArmazensStocks` desses
produtos (mesmo armazéns sem movimento próprio — para captar o
estado completo). `dbo.StocksMov` é **obrigatório**.

> **Crítico do batching:** a subquery `TOP N DISTINCT CodigoID` +
> `JOIN` para expandir garante que **todos os armazéns do mesmo
> CodigoID ficam no mesmo HTTP batch**. Se um produto fosse repartido
> entre batches, o `SUM` server-side seria parcial e o último batch
> sobrescreveria `stockAtual` com soma incompleta. `STOCK_BATCH=100`
> conta produtos distintos; rows na resposta ≈ produtos ×
> armazéns/produto (típico 100–300 rows/batch, dentro do limite
> server de 1000).

> **`externalWarehouseId`:** preservado no payload por traceability.
> O endpoint server-side continua a agregar por `externalProductId`
> via `SUM` (a granularidade canónica de `ProdutoFarmacia` é
> `(produtoId, farmaciaId)`, sem dimensão de armazém). Resultado em
> DB é o mesmo que com payload pre-agregado, mas o operador consegue
> ver no Vercel logs / forensic JSON qual armazém contribuiu.

> **Diferença vs. bootstrap-upload:** `bootstrap-upload` agrega
> SQL-side (`GROUP BY CodigoID + SUM`) e envia `externalWarehouseId:
> null`. Inconsistência conhecida — daily-sync ganhou traceability
> per-armazém em rev10 mas bootstrap-upload manteve agregação inicial.
> Se simetria for desejável, fixar em iteração futura (sem impacto
> em dados já escritos, idempotência mantém-se).

**SALES-LINES** — Atendimentos do dia:

```sql
WHERE a.[Fim Venda] = 'S'
  AND a.[Data Venda] BETWEEN @date 00:00:00 AND @date 23:59:59
  AND d.[Detalhe ID] > @lastId
```

Idêntico ao bootstrap-upload sales pipeline com `from=to=@date`.

### 9.2 Idempotência transversal

Re-correr `daily-sync --date X` é seguro independentemente do estado
da BD:

| Cenário | Comportamento |
|---|---|
| 1ª corrida (clean state) | upsert normal de todos os items |
| 2ª corrida (mesmo dia) | re-upsert: rows existentes actualizam (`dataAtualizacao` muda, valores iguais), nada é duplicado |
| Run parcial (abortado) | retry: rows escritos antes do abort são re-actualizados; restantes são inseridos |
| Dia já processado pelo bootstrap | upsert: rows do bootstrap são re-confirmados; sem corrupção |

A garantia vem dos unique constraints DB-side, não da lógica
aplicacional. Mesmo bug no agent não pode causar duplicates.

### 9.3 Trade-off do feature flag

Reusamos `ENABLE_AGENT_BOOTSTRAP=1` para o daily-sync — sem flag
separada. Justificação:

- **Pró:** menos superfície (1 flag, 3 endpoints). Operacionalmente
  mais simples.
- **Pró:** auth e payload shape são idênticos — o servidor não
  consegue (nem deve) distinguir.
- **Con:** se quiseres pausar daily-sync sem pausar bootstrap, tens
  que parar o Task Scheduler do agent (não o flag SaaS).

Quando o operador quer **kill switch global**: pôr a flag a "0",
todos os endpoints respondem 503. Ambos bootstrap-upload e
daily-sync param. É o caminho honesto.

Para pausar **apenas** daily-sync mantendo capacidade de retry
bootstrap: parar o agendamento Windows / cron no PC da farmácia.
Não há gate SaaS-side para isto e não precisa de existir.

### 9.4 Comando agent — invocação

```bash
# Dry-run primeiro
daily-sync-dry-run --date 2024-04-02

# Se counts/amostras OK
daily-sync --date 2024-04-02
```

Output do `daily-sync` mostra contagens por pipeline + erros
individuais (até 3 por batch). Wall time típico para 1 dia de
farmácia média: 30–90s.

### 9.5 Não escreve `VendaMensal`

Linhas continuam a entrar em `IngestVendaLinhaRaw` (staging). A
agregação para `VendaMensal` é uma iteração subsequente (server-side
job a correr depois de `[Tipo Documento]` estar caracterizado e a
semântica de `[Valor_EUR]` consolidada). **Dashboards continuam
intactos** — não há queries a `IngestVendaLinhaRaw` em loaders
operacionais.

### 9.6 Agendamento Windows (próxima iteração)

Sugestão (NÃO implementado neste sprint):

```
Task Scheduler: SPharmMT-DailySync
Trigger:        02:00 daily
Action:         <pasta-do-zip>\run-daily-sync-auto.bat
                (variante que calcula --date = ontem automaticamente)
```

O `.bat` actual (`run-daily-sync.bat`) pede `--date` interactivamente;
para agendamento automático precisa-se de variante sem prompt que
deriva a data do `Get-Date -Format yyyy-MM-dd` menos um dia. Está em
backlog para próximo sprint.

### 9.7 Boundary com bootstrap-upload

| Comando | Quando |
|---|---|
| `bootstrap-upload` | **Uma única vez** por farmácia, no onboarding. Carrega histórico do intervalo `--from --to`. |
| `daily-sync` | **Recorrente**. Carrega 1 dia (`--date`). Pode rodar agendado ou manual. |

Os dois podem rodar em qualquer ordem — idempotência cross-comando:
- bootstrap depois de daily-sync: bootstrap re-confirma o que daily-sync escreveu
- daily-sync depois de bootstrap: daily-sync confirma rows do bootstrap; adiciona novos do dia se houver

## 10. Classifier server-side de TipoDocumento (v0.9)

Decisão arquitectural 2026-05-14: a classificação de
`Atendimento.[Tipo Documento]` vive **server-side** numa tabela
lookup (`TipoDocumentoClassificacao`), **não** hardcoded no agent.

### 10.1 Razões

| Pró server-side | Detalhe |
|---|---|
| Reclassificação retroactiva | UPDATE em `IngestVendaLinhaRaw` sem reupload do agent |
| Sem rebuild ZIP por TipoDoc novo | Operador edita tabela; alteração imediata para uploads seguintes |
| Centraliza regras | Mesma tabela seedada via migration em todos os tenants — política consistente |
| Auditável | `classifiedBy` + `classifiedAt` rastreiam decisão |

Trade-off: o agent continua a enviar `tipoDocumentoClass` no payload
(legacy). O endpoint **prefere** a lookup server-side; o valor do
agent só é usado quando o TipoDoc não está em
`TipoDocumentoClassificacao`. Agent rev10 não precisa de update.

### 10.2 Modelo `TipoDocumentoClassificacao`

Tenant-DB (não control plane). Cada tenant tem a sua tabela; seeds
idênticos via migration `20260514100000_add_tipo_documento_classificacao`.

```typescript
model TipoDocumentoClassificacao {
  tipoDocumento Int      @id   // raw do ERP
  classe        String         // "VENDA" | "DEVOLUCAO_ANULACAO"
                               // | "UNKNOWN" | "IGNORE_TECHNICAL"
  descricao     String?
  notas         String?
  classifiedBy  String?        // operator email | "system" | "cli"
  classifiedAt  DateTime
  updatedAt     DateTime
  @@index([classe])
}
```

Classes válidas:

| Classe | Significado | Comportamento na agregação futura |
|---|---|---|
| `VENDA` | Venda comercial | Entra em `VendaMensal` com sinal positivo |
| `DEVOLUCAO_ANULACAO` | Devolução / anulação | Entra com sinal negativo |
| `UNKNOWN` | Caracterização pendente | Linha conservada em staging, **ignorada** na agregação |
| `IGNORE_TECHNICAL` | Documento técnico (consulta, anulação interna) | Linha conservada, **ignorada** explicitamente |

### 10.3 Seeds defaults (aplicados pela migration)

```sql
INSERT INTO "TipoDocumentoClassificacao" VALUES
  (77,  'VENDA',              'Venda comercial (default Softreis)', ...),
  (104, 'DEVOLUCAO_ANULACAO', 'Devolução / anulação (default Softreis)', ...),
  (2,   'UNKNOWN',            'Caracterização pendente (default cautelar)', ...),
  (7,   'UNKNOWN',            'Caracterização pendente — detectado 2024-01-01 sample', ...)
ON CONFLICT ("tipoDocumento") DO NOTHING;
```

`ON CONFLICT DO NOTHING` protege contra over-write de classificações
já editadas pelo operador. Re-correr a migration é seguro.

### 10.4 Endpoint behaviour — `/api/ingest/v1/bootstrap/sales-lines`

```typescript
// 0) Pre-fetch (1 query por request)
const classifierMap = new Map(...) // tipoDocumento → classe

// Por item:
const tipoRaw = asIntOrNull(item.tipoDocumento);
let tipoDocumentoClass;
if (tipoRaw && classifierMap.has(tipoRaw)) {
  tipoDocumentoClass = classifierMap.get(tipoRaw)!;  // server wins
} else {
  // Fallback legacy — agent rev10 envia classe; se mapeada → usa.
  const clientClass = item.tipoDocumentoClass ?? "UNKNOWN";
  tipoDocumentoClass = KNOWN_CLASSES.has(clientClass) ? clientClass : "UNKNOWN";
}
```

Log da distribuição por classe é emitido no `done` log de cada batch
para observabilidade:

```text
[bootstrap/sales-lines] done {
  "received":200, "upserted":200,
  "classDist":{"VENDA":180,"UNKNOWN":15,"DEVOLUCAO_ANULACAO":5},
  "classifierTableSize":4,
  ...
}
```

### 10.5 Workflow operacional

Cenário típico: caracterização de novo TipoDoc.

```bash
# 1. Operador identifica TipoDoc desconhecido via sales-summary-preview
#    ou via classDist nos logs Vercel

# 2. Caracteriza com SQL ERP / sales-summary-preview (§5.6)

# 3. Insere/actualiza classificação
npm run ingest:classify-tipodoc -- \
  --tenant demo-neon \
  --tipo 7 \
  --classe VENDA \
  --descricao "Venda OTC sem receita" \
  --by "bruno@spharm.mt"

# 4. Propaga ao staging existente (dry-run primeiro)
npm run ingest:reclassify-vendas -- --tenant demo-neon --dry-run
npm run ingest:reclassify-vendas -- --tenant demo-neon

# 5. Uploads subsequentes (daily-sync ou bootstrap-upload retry)
#    automaticamente aplicam a nova regra — endpoint lê classifier
#    em cada request.
```

### 10.6 Scripts entregues

| Script | NPM script | Função |
|---|---|---|
| `scripts/classify-tipodoc.ts` | `npm run ingest:classify-tipodoc` | Upsert numa entrada `TipoDocumentoClassificacao`. Audit via `classifiedBy`. |
| `scripts/reclassify-ingest-vendas.ts` | `npm run ingest:reclassify-vendas` | Aplica regras correntes ao staging. `--dry-run` para preview. Idempotente. |

### 10.7 Boundary com Fase B (agregação `VendaMensal`)

A agregação `IngestVendaLinhaRaw` → `VendaMensal` (ainda futura)
filtra implicitamente por classe:

```sql
-- pseudocódigo da agregação futura
SELECT
  farmaciaId, produtoId, YEAR(dataVenda), MONTH(dataVenda),
  SUM(CASE tipoDocumentoClass
        WHEN 'VENDA' THEN quantidade
        WHEN 'DEVOLUCAO_ANULACAO' THEN -quantidade
        ELSE 0   -- UNKNOWN, IGNORE_TECHNICAL: ignorados
      END) AS quantidade,
  ...
FROM "IngestVendaLinhaRaw"
WHERE produtoId IS NOT NULL
  AND tipoDocumentoClass IN ('VENDA', 'DEVOLUCAO_ANULACAO')
GROUP BY 1,2,3,4
```

**Pré-requisito para correr a agregação:** `COUNT(*) WHERE
tipoDocumentoClass IN ('UNKNOWN')` = 0, ou justificado. O classifier
server-side é o gate disso — operador caracteriza cada TipoDoc
desconhecido antes de avançar.

## 11. Referências cruzadas

- Plano de execução SQL Server: [`../notes/local-agent-sqlserver-plan.md`](../notes/local-agent-sqlserver-plan.md)
- Arquitectura geral: [`../notes/local-agent-architecture.md`](../notes/local-agent-architecture.md)
- Segurança do agent: [`../agent/SECURITY.md`](../agent/SECURITY.md)
- Discovery canónico: [`../agent/src/commands/discover.ts`](../agent/src/commands/discover.ts)
- Schema canónico: [`../prisma/schema.prisma`](../prisma/schema.prisma)
