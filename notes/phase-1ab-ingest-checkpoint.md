# Fase 1a + 1b — Ingest checkpoint

**Data**: 2026-05-18
**Estado**: ambas as fases fechadas e validadas em `demo-neon`.
**Próxima fase**: 1c (aggregation `Compra` + `Devolucao` final) — **NÃO autorizada**.

## 1. Commits finais

| Hash | Mensagem | Fase |
|---|---|---|
| `c24b1b1` | Phase 1a: Fornecedores ingest pipeline (SaaS + agent rev24/rev25) | 1a |
| `083aaba` | fix(agent): include referenced discovery command files | 1a (hotfix Vercel build) |
| `12ccfa3` | feat(staging): add compras devolucoes raw staging schema | 1b.1 |
| `145a55e` | feat(ingest): add compras staging bootstrap endpoint | 1b.2 |
| `c50227d` | feat(ingest): add devolucoes-fornecedor staging bootstrap endpoint | 1b.3 |
| `2132a55` | feat(agent): add compras dry-run + upload commands | 1b.5 |
| `ccbe806` | feat(agent): add devolucoes-fornecedor dry-run + upload commands | 1b.6 |
| `d5af51c` | build(agent): bump rev26 + add compras/devolucoes BAT wrappers | 1b.7 |

Todos em `origin/main`.

## 2. Endpoints criados (production)

| Método | Path | Tabela escrita | Idempotência |
|---|---|---|---|
| POST | `/api/ingest/v1/bootstrap/fornecedores` | `Fornecedor` + `FornecedorErpRef` (+`FornecedorAlias` additive) | `(farmaciaId, externalFornecedorId)` |
| POST | `/api/ingest/v1/bootstrap/compras` | `StagingCompraRawLine` | `(farmaciaId, externalLineId)` |
| POST | `/api/ingest/v1/bootstrap/devolucoes-fornecedor` | `StagingDevolucaoFornecedorRawLine` | `(farmaciaId, externalLineId)` |

Comuns a todos:
- `withIntegrationAuth` (Bearer + `X-Tenant-Slug`)
- Gate `ENABLE_AGENT_BOOTSTRAP=1` → 503 quando off
- Max 500 linhas/batch (`bootstrap/compras` e `devolucoes-fornecedor`); fornecedores aceita até `BOOTSTRAP_MAX_BATCH_SIZE=1000`
- Coercers defensivos (`asIntOrNull`, `asDecimalOrNull`, `asIsoDateOrNull`, `cleanStringOrNull` que trata `"NULL"`/`"null"` literal como null)
- UPSERT via `findUnique` + `create`/`update` (matches pattern dos bootstrap pré-existentes)
- Response operacional standardizada (`accepted`, `upserted`, `created`, `updated`, `skipped[]`, `errors[]`, `durationMs`) + extensões por endpoint

## 3. Tabelas staging (schema Prisma)

| Modelo | Tabela | Migration | Granularidade |
|---|---|---|---|
| `Fornecedor` | `Fornecedor` (existente, extended com `nome` + `nif`) | `20260515170000_add_fornecedor_erp_ref` | 1 row por fornecedor canónico (per-tenant) |
| `FornecedorErpRef` | `FornecedorErpRef` | `20260515170000_add_fornecedor_erp_ref` | 1 row por `(farmaciaId, externalFornecedorId)` |
| `StagingCompraRawLine` | `StagingCompraRawLine` | `20260518150000_add_compras_devolucoes_staging` | 1 row por `dbo.[Recepcao Detalhe]` linha |
| `StagingDevolucaoFornecedorRawLine` | `StagingDevolucaoFornecedorRawLine` | `20260518150000_add_compras_devolucoes_staging` | 1 row por `dbo.[Devolucao Detalhe]` linha |

Indexes operacionais (resumo):
- Unique idempotência em todas
- `(farmaciaId, data*)` — queries temporais
- `(farmaciaId, externalCodigoId, data*)` — agregação por produto
- `(farmaciaId, externalFornecedorId, data*)` — agregação por fornecedor
- `(farmaciaId, ingestBatchId)` — cleanup direccionado por batch
- Devoluções extra: `(farmaciaId, devolucaoSituacaoId)` — listagem por estado

Tabelas aplicadas apenas em `demo-neon`. `grupo-silveira` **não migrado**.

## 4. Agent rev26 ZIP

- **Bundle**: `dist-agent/SPharmMT-Agent-2026-05-18-rev26.zip` (26.55 MB)
- **Banner**: `Agent: rev26 commit ccbe806 built 2026-05-18T10:05:12Z`
- **27 BAT wrappers** (4 novos da Fase 1b somam aos 23 da rev25)
- **node.exe**: v20.18.0 portable (Windows x64)
- **agent.cjs**: 3.5 MB bundle CJS (esbuild)

## 5. Comandos do agent disponíveis (Fase 1a + 1b)

| Comando | BAT | Fase | Propósito |
|---|---|---|---|
| `fornecedores-dry-run` | `run-fornecedores-dry-run.bat` | 1a | TOP 20 amostra + distribuição por tipo. Sem POST |
| `fornecedores-upload` | `run-fornecedores-upload.bat` | 1a | UPSERT em `Fornecedor` + `FornecedorErpRef` |
| `compras-dry-run` | `run-compras-dry-run.bat` | 1b | Contagens + reconciliação + orphans locais. Sem POST |
| `compras-upload` | `run-compras-upload.bat` | 1b | UPSERT em `StagingCompraRawLine`. Confirmação CONFIRMO |
| `devolucoes-fornecedor-dry-run` | `run-devolucoes-fornecedor-dry-run.bat` | 1b | Estados P/E/R/X + reconciliação. Sem POST |
| `devolucoes-fornecedor-upload` | `run-devolucoes-fornecedor-upload.bat` | 1b | UPSERT em `StagingDevolucaoFornecedorRawLine`. Confirmação CONFIRMO |

## 6. Validações executadas em `demo-neon`

### Fase 1a — Fornecedores
- `prisma validate` OK
- `npx tsc --noEmit` OK
- Migration `20260515170000_add_fornecedor_erp_ref` aplicada
- Smoke script schema: `FornecedorErpRef=0`, `Fornecedor=0` pré-upload
- Upload contra `SPHARM_Batalha`: 138 fornecedores lidos, 138 aceites
  - Fornecedor `created=138`, `updated=0`
  - FornecedorErpRef `created=138`, `updated=0`
  - Aliases adicionados: 151
  - Skipped: 0; Errors: 0
- Smoke post-upload: `FornecedorErpRef count = 138`, `Fornecedor count = 138`
- Idempotência (re-run com `--batch-size 50`): `c=0 u=138`, errors=0

### Fase 1b — Staging compras + devoluções
- `prisma validate` OK
- `npx tsc --noEmit` OK
- Migration `20260518150000_add_compras_devolucoes_staging` aplicada
- Smoke script schema: ambas as tabelas presentes
  - `StagingCompraRawLine`: 6 indexes (PK + unique + 4 operacionais)
  - `StagingDevolucaoFornecedorRawLine`: 7 indexes (PK + unique + 5 operacionais — extra para `devolucaoSituacaoId`)
- Endpoints deployed em Vercel (verificação manual operador via curl 401)
- Builds agent rev26 OK localmente
- **Dry-runs e uploads reais contra SPHARM_Batalha**: pendentes do lado do operador. Endpoint pronto, comandos prontos, ZIP entregue.

## 7. Critérios de aceitação cumpridos

| Critério | Estado |
|---|---|
| Schema staging não-destrutivo | ✓ Migrations additive-only, zero alterações a tabelas existentes |
| Endpoint production-safe | ✓ Auth, gate, validação, upsert idempotente |
| Idempotência explícita por `(farmaciaId, externalLineId)` | ✓ Unique constraints + UPSERT pattern |
| Sem consumidores downstream | ✓ Nenhum código consome `StagingCompraRawLine`/`StagingDevolucaoFornecedorRawLine` |
| Dry-run obrigatório antes de uploads | ✓ Comandos `*-dry-run` disponíveis |
| Reconciliação per-header | ✓ `SUM(qt × valorEurUnit)` (compras) e `SUM(valorEurTotal)` (devoluções) vs `headerTotalIncidenciaEur`, tolerância 0.02€ |
| Observabilidade | ✓ Logs estruturados start+done, `ingestBatchId` em cada linha, `elapsedMs` por batch |
| Rollback simples | ✓ Migrations revertíveis (DROP TABLE), `DELETE WHERE ingestBatchId=?` por batch |
| Zero alterações dashboard/vendas/export-orders/aggregation/UI | ✓ Confirmado por scope review em cada commit |
| Zero alterações `grupo-silveira` | ✓ Apenas `demo-neon` migrado |

## 8. Decisões de mapping ERP (validadas)

| Domínio | Tabela SPharm | Filtros | Idempotency key | Notas |
|---|---|---|---|---|
| Fornecedores | `dbo.Fornecedores` LEFT JOIN `dbo.Tbl_Tipo_Fornecedores` | nenhum (inactivos incluídos) | `(farmaciaId, [Fornecedor ID])` | `[Inactivo]=1` → `Fornecedor.estado=INATIVO` no SaaS. Aliases gerados de `[Nome Abreviado]` + `[Nome Fornecedor]` |
| Compras header | `dbo.Recepcao` | `RecepcaoSituacaoID = 'N'`, `[Data Recepcao]` BETWEEN | (denormalizado) | `[NRecepcao]` interno + `[Fornecedor_NDoc]` externo capturados |
| Compras linha | `dbo.[Recepcao Detalhe]` | (via header) | `(farmaciaId, [Detalhe  Recp ID])` (dois espaços!) | `[Valor_EUR]` é **UNITÁRIO** (PVF c/desconto, sem IVA). Total linha = `Quantidade × Valor_EUR` |
| Devoluções header | `dbo.Devolucao` | `DevolucaoSituacaoID <> 'A'`, `[Data Devolucao]` BETWEEN | (denormalizado) | Sempre AO fornecedor (FK declarada). Estados aceites: P/E/R/X |
| Devoluções linha | `dbo.[Devolucao Detalhe]` | (via header) | `(farmaciaId, [Devolucao Detalhe ID])` | `[Valor]` é **TOTAL DA LINHA** (`Qt Enviada × PVF_EUR`). Nota: semântica diferente de compras |
| Mapping tipo fornecedor | `Tbl_Tipo_Fornecedores` ID → `FornecedorTipo` enum | n/a | n/a | 1=DISTRIBUIDOR, 2=LABORATORIO_DIRETO, 4=DISTRIBUIDOR, 5=COOPERATIVA, resto=OUTRO |

## 9. Limites conhecidos (production)

1. **Data quality — string literal `"NULL"`**: o ERP tem casos onde operador digita a string `"NULL"` em vez de deixar o campo vazio. Mitigado por `cleanStringOrNull` em ambos os endpoints. Observado em `Fornecedor.nif` (ASTRAZENECA na 1ª passagem).
2. **Reconciliação cross-batch**: se um header (Recepção ou Devolução) ficar split entre dois batches, a soma per-batch é parcial e dispara falso warning. Agent mitiga ordenando por `[Data]`+`[Detalhe ID]` ascendente, mas não garante atomicidade.
3. **Timeout client-side rev25 → rev26**: rev25 tinha `BATCH_TIMEOUT_MS=60_000` para fornecedores (causou abort no re-run idempotência). rev26 alinhou compras/devoluções com `120_000` (pattern bootstrap-upload). Fornecedores rev25 continua a 60s; operador usa `--batch-size 50` como mitigação.
4. **Pré-2017 dados sintéticos**: `dbo.Recepcao` antes de 2017 tem entries sintéticas (`[NRecepcao]` em formato YYYYMM, `[Data Recepcao]` fim-de-mês 23:59:59). Filtro `[Data Recepcao] >= @from` no agent deixa o operador escolher a data-corte explicitamente.
5. **Multi-armazém**: rev24 inspection mostrou 100% `ArmazemID=1`. Esquema captura `armazemId` mas não foi testado com múltiplos armazéns na mesma farmácia.
6. **`Recepcao_Origem` (devoluções)**: texto livre tipo "Factura A.FAC24174295". Capturado mas não JOIN à recepção original — auditoria de custo-de-origem fica deferida.
7. **`Tipo Documento` para compras**: `bootstrap/compras` aceita qualquer `externalTipoDocumentoId` (capturado raw). Filtragem por tipo canónico (FT, G/Remessa, G/Transporte) será decisão da Fase 1c na agregação.
8. **Devoluções pendentes (`P`) mutam após resolução**: `quantidadeRecebida` muda 0→>0 e `devolucaoSituacaoId` muda P→R. Capturado via UPSERT (mesma PK), mas requer re-sync da janela. Sem cleanup automatic de stale rows na Fase 1b.
9. **`grupo-silveira` não migrado**: schema + endpoints + agent funcionam em qualquer tenant que tenha a migration aplicada. Apply explícito necessário antes de usar contra esse tenant.

## 10. Próximos passos bloqueados (não autorizados)

| Item | Bloqueio | Notas |
|---|---|---|
| Aggregation `StagingCompraRawLine` → `Compra` final | Sem autorização Fase 1c | Modelo `Compra` existe em `prisma/schema.prisma:851` mas continua vazio |
| Aggregation `StagingDevolucaoFornecedorRawLine` → `Devolucao` final | Sem autorização Fase 1c | Modelo `Devolucao` existe `prisma/schema.prisma:878` mas continua vazio |
| UI/dashboard para compras/devoluções | Sem autorização | `/devolucoes` e `/stock/artigo/[cnp]` consomem `Compra`/`Devolucao` finais via `lib/movimentos-data.ts` e `lib/devolucoes-data.ts` — continuam a mostrar zero |
| Daily-sync compras/devoluções (incremental rolling window) | Sem autorização | Comandos actuais são bootstrap (range `--from`/`--to`). Daily-sync teria de capturar mutações P→R nas devoluções |
| Apply migration + agent em `grupo-silveira` | Sem autorização | Sequência idêntica à de `demo-neon` quando autorizada |
| Cleanup job para devoluções stale (P sem mais resolução) | Sem autorização | Limite #8 acima |
| Smoke script estendido com reconciliation cross-check pós-upload | Sem autorização | Smoke actual valida só counts + schema |

## 11. Ficheiros relevantes (mapa rápido)

### SaaS
- [app/api/ingest/v1/bootstrap/fornecedores/route.ts](../app/api/ingest/v1/bootstrap/fornecedores/route.ts)
- [app/api/ingest/v1/bootstrap/compras/route.ts](../app/api/ingest/v1/bootstrap/compras/route.ts)
- [app/api/ingest/v1/bootstrap/devolucoes-fornecedor/route.ts](../app/api/ingest/v1/bootstrap/devolucoes-fornecedor/route.ts)
- [prisma/schema.prisma](../prisma/schema.prisma) — modelos `Fornecedor` (extended), `FornecedorErpRef`, `StagingCompraRawLine`, `StagingDevolucaoFornecedorRawLine`
- [prisma/migrations/20260515170000_add_fornecedor_erp_ref/migration.sql](../prisma/migrations/20260515170000_add_fornecedor_erp_ref/migration.sql)
- [prisma/migrations/20260518150000_add_compras_devolucoes_staging/migration.sql](../prisma/migrations/20260518150000_add_compras_devolucoes_staging/migration.sql)
- [lib/integracao/auth.ts](../lib/integracao/auth.ts) (reutilizado)
- [lib/ingest/bootstrap.ts](../lib/ingest/bootstrap.ts) (helpers partilhados)

### Agent (rev26)
- [agent/src/commands/fornecedores.ts](../agent/src/commands/fornecedores.ts)
- [agent/src/commands/compras.ts](../agent/src/commands/compras.ts)
- [agent/src/commands/devolucoes-fornecedor.ts](../agent/src/commands/devolucoes-fornecedor.ts)
- [agent/src/http-client.ts](../agent/src/http-client.ts) — `bootstrapFornecedores`, `bootstrapCompras`, `bootstrapDevolucoesFornecedor`
- [agent/src/cli.ts](../agent/src/cli.ts) — registo dos 6 comandos
- [agent/build.mjs](../agent/build.mjs) — `AGENT_REV="26"` + 4 BATs novos

### Smoke / admin
- [scripts/admin/smoke-fornecedor-schema.ts](../scripts/admin/smoke-fornecedor-schema.ts)
- [scripts/admin/smoke-compras-devolucoes-staging.ts](../scripts/admin/smoke-compras-devolucoes-staging.ts)
- [scripts/tenancy/migrate-all-tenants.ts](../scripts/tenancy/migrate-all-tenants.ts) (reutilizado, `--only <slug>`)

## 12. Estado de produção (snapshot 2026-05-18)

- **demo-neon**: schema migrated, endpoints deployed, fornecedores populated (138 rows). Compras/devoluções staging tables vazias até primeiro upload.
- **grupo-silveira**: schema **não migrated**, endpoints disponíveis mas tables não existem nessa BD. Não tocar até autorização.
- **piloto-demo**: tenant existente mas fora deste scope.
