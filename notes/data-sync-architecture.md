# Data Sync Architecture — Estado Actual + Plano Incremental

**Data:** 2026-05-11
**Fase:** análise apenas (zero writes, zero migrations)
**Scope:** mapear como dados externos entram no SPharm.MT, identificar
lacunas operacionais, propor plano de sync incremental.

## 1. Resumo executivo

5 fontes externas alimentam o sistema, via 8 scripts manuais e 2 workers
Phase-0. Há **sem scheduler visível** (cron/Vercel), **sem observabilidade
centralizada de "última sincronização por fonte"**, e **duplicação possível
em 4 tabelas transacionais** (Venda/Compra/Devolucao/AjusteStock).
Idempotência está bem-resolvida no catálogo (Produto/RegulatoryRecord/
ProdutoFarmacia/VendaMensal/HistoricoStock) mas frágil na ingestão
transacional diária. A tabela `LoteIngestao` está desenhada para suportar
batches mas não está plenamente exercitada em todos os scripts.

## 2. Fontes externas mapeadas

| Fonte | Formato | Frequência (real/inferida) | Target | Estado |
|---|---|---|---|---|
| ERP da farmácia (vendas, stock) | Excel (`MapaEvolucaoVendas.xlsx`, `stock_Atual.xlsx`) | Mensal (vendas) + diário (stock)? | Produto, ProdutoFarmacia, VendaMensal | manual via `import-excel.ts` |
| INFARMED snapshot regulatório | CSV/XLSX manual | Mensal (assumido) | InfarmedSnapshot | manual via `import-infarmed-snapshot.ts` |
| CEDIME-ANF (cache designacao+titular+estado) | CSV/XLSX | ad-hoc, ~trimestral? | RegulatoryRecord | manual via `import-regulatory-record.ts --source=cedime_anf_*` |
| INFOMED (crawler enriquecimento clínico) | HTTP scraping (P9 Fase 1+2) | ad-hoc, on-demand | RegulatoryRecord + Produto via sync | manual via `browse-infomed-listagem.ts` + `fetch-details-by-medid.ts` |
| Conectores web (Open*Facts, retail, etc.) | HTTP fetch | runtime durante enrich | EnrichmentSourceLog (auditoria) + Produto | `enrich-products.ts`, workers |

**Sem fontes**: encomendas suppliers (manual), preço de retalho competitivo
(manual), inventários físicos (LinhaInventario, sem importer).

## 3. Tabelas-target + idempotência

### Catálogo central (global por CNP)

| Tabela | Idempotência | Mecanismo | Política merge |
|---|---|---|---|
| `Produto` | ✅ Forte | `@@unique(cnp)` | `createMany skipDuplicates` (Excel); upsert (enrich) |
| `InfarmedSnapshot` | ✅ Forte | `@@unique(cnp)` | upsert per CNP, versionado por `snapshotVersion` |
| `RegulatoryRecord` | ✅ Forte | `cnp @id` | upsert, **preserve-non-null** por defeito; `--force` overrides |
| `Fabricante` + `FabricanteAlias` | ✅ Forte | uniques por normalized name | get-or-create no caminho de enriquecimento |
| `Classificacao` | ✅ Forte | seed-driven via `lib/catalog-taxonomy.ts` | idempotente; nunca apaga |

### Per-farmácia (transacional)

| Tabela | Idempotência | Mecanismo | Risco |
|---|---|---|---|
| `ProdutoFarmacia` | ✅ Forte | `@@unique(produtoId, farmaciaId)` | OK |
| `VendaMensal` | ✅ Forte | `@@unique(farmaciaId, produtoId, ano, mes)` | OK (delete+reinsert) |
| `HistoricoStock` | ✅ Forte | `@@unique(farmaciaId, produtoId, dataFotografia)` | OK |
| `LinhaEncomenda` | ✅ Forte | `@@unique(listaEncomendaId, produtoId)` | OK |
| **`Venda`** | ⚠ Fraca | `@@index(farmaciaId, data)` apenas; sem unique | **duplicação se re-ingerido** |
| **`Compra`** | ⚠ Fraca | `@@index` apenas | **duplicação** |
| **`Devolucao`** | ⚠ Fraca | `@@index` apenas | **duplicação** |
| **`AjusteStock`** | ⚠ Fraca | `@@index` apenas | **duplicação** |
| `LinhaInventario` | ⚠ Sem importer | — | sem flow definido |

**Decisão de design observada:** as 4 transacionais usam `createMany`
acopladas a `LoteIngestao` (cabeçalho de batch com `hashConteudo`). A
deduplicação real depende do caller verificar `hashConteudo` antes de
chamar `createMany` — não é forçada pelo schema.

## 4. Multi-tenant data path

Modelo actual = **híbrido** entre dois conceitos:

1. **Tenant scoping por `farmaciaId`** (tabelas Venda/Compra/etc todas têm
   FK para `farmaciaId` ⇒ shared DB com filtros aplicacionais)
2. **Tenant DBs separadas via `lib/tenant-registry.ts` + control plane**
   (`getPrisma()` async resolve `x-tenant-slug` header, devolve Prisma
   client distinto por tenant; control plane em `CONTROL_DATABASE_URL`)

Scripts CLI atuais usam `legacyPrisma` (singleton ligado a `DATABASE_URL`)
— não respeitam tenant scoping. Isto funciona em single-tenant
ou tenant-default; em multi-tenant real, scripts precisam de adopção do
tenant context.

**Implicação para sync:** se evoluímos para "1 DB por farmácia/grupo",
scripts actuais (import-excel, import-infarmed-snapshot, etc.) precisam
de aceitar `--tenant=<slug>` e usar `getPrisma()` com esse slug. Hoje
todos assumem single DB.

## 5. Lacunas identificadas

### L1. Sem scheduler / sem timing de sincronização
- Nenhum cron, Vercel scheduled task, ou worker daemon visível
- Workers (`enrichment-worker.ts`, `regulatory-acquisition-worker.ts`) e
  jobs (`daily-enrich.ts`, `weekly-reverify.ts`) são rodáveis manualmente
- Sem garantia de cadência: "diária" e "semanal" no nome ≠ executado

### L2. Sem indicador "last sync per source/farmácia"
- Falta uma tabela `SyncRun` ou `ImportLedger` que indique "fonte X, tenant Y,
  última execução em Z, resultado, próxima execução em W"
- `LoteIngestao` existe e é boa para isto, mas só cobre ingestão transacional;
  não cobre RegulatoryRecord/InfarmedSnapshot

### L3. Idempotência transacional frágil (Venda/Compra/Devolucao/AjusteStock)
- Sem `@@unique` natural — re-ingestão duplica
- Defesa actual: caller verifica `LoteIngestao.hashConteudo` antes de
  inserir. Não está enforçado.
- Risco: dois batches Excel com hash diferente mas overlap de linhas →
  duplicação garantida

### L4. Sem conflict resolution per-field
- `RegulatoryRecord.source` é per-row (uma tag global)
- Quando 2 fontes contribuem campos diferentes, perde-se a origem por campo
- `EnrichmentSourceLog` tem o detalhe mas é log, não source-of-truth
- Implicação: se quero saber "de onde veio este ATC?" tenho de cruzar
  EnrichmentSourceLog + RegulatoryRecord — não há campo `dci_source`,
  `atc_source` no Produto

### L5. ERP Excel format não documentado
- Mapeamento de colunas é reverse-engineered em `lib/importer.ts`
- Sem schema versioning — se o ERP muda colunas, importer falha silenciosamente
- Sem validação preview pre-import

### L6. Phase 0 RegulatoryAcquisitionJob = simulador
- A queue + worker existem mas o "simulateOutcome" é deterministic por CNP
- Pipeline real (INFOMED P9) corre em scripts separados, fora da queue
- Decisão necessária: integrar P9 na queue ou eliminar queue

### L7. Observabilidade scattered
- Logs em `scripts/data/logs/*.log` — sem rotação, sem agregação
- Sem dashboard de "saúde do sync": quantos records importados/dia, taxa
  de falha por fonte, drift entre fontes
- `EnrichmentSourceLog` e `LoteIngestao` são tabelas ricas mas
  subutilizadas por queries de monitoring

## 6. Riscos de duplicação concretos

| Risco | Probabilidade | Severidade | Mitigação actual |
|---|---|---|---|
| Re-import do mesmo `MapaEvolucaoVendas.xlsx` cria VendaMensal duplicada | baixa | alta | delete+reinsert (idempotente by design) |
| Re-import de stock diário cria HistoricoStock duplicada | baixa | média | `@@unique(farmaciaId, produtoId, dataFotografia)` |
| Re-ingest de lote de Venda duplica linhas | **média** | alta | nenhuma — depende do caller verificar `loteIngestaoId` |
| RegulatoryRecord do mesmo CNP via 2 imports CEDIME diferentes | baixa | baixa | preserve-non-null preserva o primeiro; campos novos ganham se vazios |
| INFOMED detail page fetched 2× via P9 → embalagens/CNPs duplicados | baixa | baixa | actualmente sem persistência (só JSON staging) |
| ERP Excel com colunas mudadas → import silenciosamente errado | **média** | alta | nenhuma; importer hard-coded |

## 7. Observabilidade — gap analysis

**Existe (mas subutilizado):**
- `LoteIngestao` — cabeçalho de batch per-farmacia (totalRecords, status, mensagemErro, hashConteudo)
- `EnrichmentSourceLog` — append-only de cada conector × tentativa (matchedBy, fieldsReturned, durationMs)
- `ProdutoVerificacaoHistorico` — snapshot de cada verificação per-produto
- `OrderExportAudit` — auditoria de exports de encomendas
- `AuditLog` — genérico de acções de utilizador

**Falta:**
- `SyncRun` cross-source: "fonte X tentou ingerir Y rows em Z timestamp,
  resultado A; próximo run B"
- Métricas agregadas: rows/source/day, error rate/source/week, drift entre
  Produto.designacao e RegulatoryRecord.designacaoOficial
- Alertas para falhas (ex.: 0 imports em 24h quando esperado diariamente)
- Dashboard operacional (HUD para o admin)

## 8. Plano incremental (Fase A → C)

### Fase A — Hardening idempotente (1-2 dias, sem migrations destrutivas)

**Foco:** fechar L3 (transacional frágil) sem mudar comportamento existente.

A.1. **Add `@@unique` virtual via `LoteIngestao.hashConteudo`**
   - Adicionar `loteIngestaoId` como obrigatório a Venda/Compra/Devolucao/
     AjusteStock (já existe; tornar NOT NULL via migration aditiva)
   - Compute `hashConteudo` em todos os importers transacionais antes de
     `createMany`
   - Reject re-import se `LoteIngestao` com mesmo (farmaciaId, tipo,
     hashConteudo) já existe

A.2. **`SyncRun` table** — cross-source ledger
   - Schema: `{id, source: string, tenantSlug: string|null, startedAt,
     finishedAt, status: SUCCESS|FAILED|PARTIAL, rowsProcessed,
     rowsRejected, errorSummary, metaJson}`
   - Cada script (import-*, sync-*, browse-*) escreve um row no início
     e fim do run
   - Indexa por (source, startedAt desc) para "última sync"

A.3. **Conflito resolution per-field (RegulatoryRecord)**
   - Adicionar opcional `<field>_source: string` em RegulatoryRecord
     (ex.: `dci_source`, `codigoATC_source`)
   - Update importers para popular ao escrever
   - Compatível com schema actual (nullable, defaults)

### Fase B — Scheduler + observabilidade (3-5 dias)

**Foco:** fechar L1, L2, L7. Não toca em fontes externas.

B.1. **Vercel cron ou daemon**
   - Para SaaS: `vercel.json` com `crons: [...]`
   - Para self-hosted: container com cron + worker entrypoint
   - Definir cadência por fonte:
     - ERP: trigger-on-upload (webhook ou manual)
     - INFOMED browse: mensal
     - RegulatoryAcquisitionJob worker: a cada 1h
     - daily-enrich: diário
     - weekly-reverify: semanal

B.2. **Dashboard interno `/admin/sync-health`**
   - Lista `SyncRun` ordenado por desc, agrupado por source
   - "Última sync OK há X dias" por fonte/tenant
   - Falhas recentes (24h, 7d) com link para logs

B.3. **Alerting básico**
   - Se `SyncRun` para uma fonte com cadência semanal não corre há 14 dias
     → email/log warning
   - Se `error rate > 5%` num run → flag

### Fase C — Multi-tenant data plane (5-10 dias)

**Foco:** fechar L4 (parcial), preparar fonte plurais por tenant.

C.1. **Adoptar `getPrisma(tenantSlug)` em scripts**
   - Migrar `import-excel.ts`, `import-infarmed-snapshot.ts`, etc. para
     aceitar `--tenant=<slug>` e usar `getPrisma()`
   - Manter `legacyPrisma` como fallback durante transição

C.2. **DB-per-tenant para dados transacionais grandes (opcional)**
   - Decisão: vale a pena para >50 farmácias?
   - Pros: isolamento, performance, restore granular
   - Contras: ops complexity, scripts replicados N×
   - Sem decisão necessária agora — análise para depois

C.3. **ERP format spec + dry-run preview**
   - Documentar formato dos Excels do ERP em `notes/erp-import-spec.md`
   - Adicionar `--dry-run` ao `import-excel.ts` que mostra colunas
     reconhecidas/desconhecidas antes de inserir
   - Falhar fast (não silenciosamente) se colunas obrigatórias faltam

## 9. Tabelas afectadas pelo plano

**Sem migrations destrutivas em nenhuma fase.**

| Tabela | Fase A | Fase B | Fase C |
|---|---|---|---|
| `Venda`, `Compra`, `Devolucao`, `AjusteStock` | `loteIngestaoId` NOT NULL | — | — |
| `LoteIngestao` | já tem `hashConteudo`; enforcer no caller | — | — |
| `RegulatoryRecord` | + `<field>_source` opcional | — | — |
| `SyncRun` | NOVO (cross-source ledger) | usado por dashboard | usado por scripts tenant-aware |
| `Produto`, `Fabricante`, `Classificacao` | inalteradas | — | — |
| `ProdutoFarmacia`, `VendaMensal`, `HistoricoStock` | inalteradas | — | — |
| `EnrichmentSourceLog`, `ProdutoVerificacaoHistorico` | inalteradas (sources of truth detalhadas) | leitura agregada | — |
| `AuditLog`, `OrderExportAudit` | inalteradas | — | — |

## 10. Estratégia idempotente recomendada

**Princípio:** cada import tem 3 garantias mínimas:

1. **Source identity:** cada batch tem `(source, hashConteudo)` único.
   Re-tentativa do mesmo input retorna no-op.
2. **Row identity:** cada row destino tem unique constraint que captura a
   sua identidade natural (CNP, (farmaciaId, produtoId, periodo), etc.).
3. **State machine:** estado do batch é `RECEBIDO → EM_PROCESSAMENTO →
   {PROCESSADO, FALHOU}` (já existe em `LoteIngestao`); estado do row
   é gerido pela tabela target (e.g., `Produto.estado`).

**Quando há conflito multi-fonte:**
- Preserve-non-null como default (igual a `RegulatoryRecord` actual)
- `--force` override apenas com auditoria explícita
- Per-field source quando possível (Fase A.3)

**Quando há ordem entre fontes:**
- Hoje: ad-hoc (último import vence)
- Recomendado: precedência declarada no código (REGULATORY > MANUFACTURER >
  RETAIL > INTERNAL) — já implementado parcialmente em
  `lib/catalog-connectors.ts` via `SourceTier`

## 11. Observabilidade — recomendação cumulativa

| Métrica | Fase | Fonte de dados |
|---|---|---|
| "Última sync OK por fonte/tenant" | A.2 | `SyncRun` |
| "Rows ingeridos/dia por source" | B.2 | `SyncRun` + agregação |
| "Error rate por source (7d rolling)" | B.2 | `SyncRun` |
| "Drift entre Produto.designacao e RegulatoryRecord.designacaoOficial" | B (extra) | query cruzada |
| "Idade média do enrichment por nivel1" | B (extra) | `Produto.lastVerifiedAt` |
| "Coverage clínico: % MEDICAMENTO com ATC+DCI" | B (extra) | `scripts/catalog-quality-report.ts` (existe!) |
| Per-field provenance | A.3 | RegulatoryRecord new cols |

## 12. Riscos do próprio plano

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Migrations de Fase A bloqueiam imports existentes | baixa | aditivas only (NULL→NOT NULL com default backfill primeiro) |
| `SyncRun` cria contention em runs paralelos | baixa | tabela append-only, índices apropriados |
| Vercel cron tem limite plan-dependente | média | documentar limites; fallback para self-host daemon |
| Multi-tenant rewrite em scripts quebra single-tenant existente | média | manter `legacyPrisma` fallback até confidence alta |
| Per-field source duplica espaço em RegulatoryRecord | baixa | 6 campos × ~tag de 32 chars = 200 bytes/row × 283k rows = ~57MB — aceitável |

## 13. Não-objectivos desta fase

- Não tocar em UI (sync-health dashboard fica para depois)
- Não tocar no pipeline INFOMED em curso
- Não tocar em transferências, stock, encomendas operacionais
- Não introduzir nova fonte externa
- Não fazer migrations destrutivas em nenhuma fase

## 14. Decisões pendentes (aguardo direção)

1. **Avançar com Fase A** (hardening idempotente, 1-2 dias)?
   Foco: fechar duplicação em Venda/Compra/Devolucao + `SyncRun` ledger.
2. **Fase B (scheduler)** depende de plataforma — Vercel cron ou
   self-host? Decisão de produto.
3. **Phase 0 acquisition queue** — manter (integrar P9 dentro) ou
   eliminar (P9 vive nos seus scripts)?
4. **Per-field provenance** vale o trade-off de schema bloat?

---

_Análise read-only. Sem código que altere BD. Aguardo direção sobre qual
das 3 fases priorizar primeiro._
