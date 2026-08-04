# Catálogo Mestre — export, import e auditoria

**Data:** 2026-08-04 · **Contexto:** migração para VPS sem migração de dados operacionais.

Na VPS, Silveira e Garantia começam do zero: stock, vendas, movimentos, compras e devoluções
são reimportados pelos agentes a partir do ERP de cada farmácia. O único activo que **não se
reconstrói sozinho** é o catálogo enriquecido — classificação canónica, ATC/DCI, forma/dosagem/
embalagem, fabricantes normalizados, imagens e a camada regulamentar. Estas três ferramentas
extraem esse catálogo de uma base existente, semeiam-no numa base nova e provam que chegou lá
inteiro.

```
  base actual ──catalog:export──▶ bundle (NDJSON + manifest + checksums) ──catalog:import──▶ base nova
                                                                                   │
                                                                          catalog:audit --expect
```

---

## 1. Inventário de tabelas

### 1.1 O que É catálogo (migra)

Regra: catálogo é tudo o que é verdade sobre um **produto** independentemente da farmácia que
o vende. Ordem da tabela = ordem topológica das foreign keys = ordem de export **e** de import.

| # | Tabela | Chave natural | FK de saída | Porque migra |
|---|---|---|---|---|
| 1 | `Classificacao` | `(nome, tipo, classificacaoPaiId)` | auto-referência (`classificacaoPaiId`) | Árvore canónica N1/N2. Exportada ordenada por profundidade para o pai existir sempre antes do filho. |
| 2 | `Fabricante` | `nomeNormalizado` | — | Deduplicação de fabricantes, trabalho não reconstruível. |
| 3 | `FabricanteAlias` | `(fabricanteId, aliasNome)` | → `Fabricante` | Variantes de nome que alimentam o matching no ingest. |
| 4 | `Produto` | `cnp` | → `Fabricante`, → `Classificacao` ×2 | Núcleo: ATC, DCI, forma, dosagem, embalagem, imagem, flags regulamentares, classificação, `validadoManualmente`. |
| 5 | `RegulatoryRecord` | `cnp` (PK) | — (junta a `Produto` por CNP) | Camada regulamentar v2 — cara de reconstruir (283 337 linhas na base legacy). |
| 6 | `InfarmedSnapshot` | `cnp` | — | Fallback do conector regulatório quando não há `RegulatoryRecord`. |
| 7 | `ProdutoVerificacaoHistorico` | `id` | → `Produto` | **Opcional** (`--include-history`): trilho de auditoria das verificações. É histórico, não estado. |
| 8 | `TipoDocumentoClassificacao` | `tipoDocumento` (PK) | — | **Opcional** (`--include-tipodoc`): mapa ERP `tipoDocumento`→classe. Configuração de ingest reutilizável entre tenants do mesmo ERP. |

### 1.2 O que NÃO é catálogo (não migra)

Cada exclusão está declarada em `EXCLUDED_TABLES` (`scripts/catalog-master/_shared.ts`) e é
copiada para dentro do próprio manifest, para o bundle ser auto-explicativo.

| Grupo | Tabelas | Motivo |
|---|---|---|
| Identidade e acesso | `Farmacia`, `Utilizador`, `UtilizadorFarmacia`, `EmailConfig`, `AuditLog` | Recriadas no onboarding. `EmailConfig` tem segredos cifrados. |
| Operacional por farmácia | `ProdutoFarmacia`, `ProdutoInterno`, `Venda`, `VendaMensal`, `Compra`, `Devolucao`, `HistoricoStock`, `AjusteStock`, `Inventario`, `LinhaInventario`, `IndicadoresProdutoFarmacia`, `MovimentoArtigo`, `ListaEncomenda`, `LinhaEncomenda`, `OrderOutbox`, `OrderExportAudit` | Reimportado pelos agentes ou recalculado. |
| Fornecedores | `Fornecedor`, `FornecedorAlias`, `FornecedorErpRef` | Relação comercial da farmácia, não atributo do produto. |
| Ingestão / raw | `LoteIngestao`, `IngestVendaLinhaRaw`, `IngestStocksMovRaw`, `StagingCompraRawLine`, `StagingDevolucaoFornecedorRawLine` | Staging descartável. |
| Jobs, filas e logs | `RegulatoryAcquisitionJob`, `EnriquecimentoFila`, `FilaRevisao`, `EnrichmentSourceLog`, `PipelineRun` | Estado de trabalho, recriado pelos pipelines. |
| Control plane | `Tenant`, `TenantEvent`, `SyncRun`, `GlobalAdmin`, `GlobalAdminTenant` | Outra base, outro ciclo de vida. |

Tenants de teste `demo-neon` e `piloto-demo` estão em blocklist no código
(`BLOCKED_TENANT_SLUGS`) — nem como origem nem como destino, salvo `--allow-test-tenant`.

### 1.3 Campos por tenant que ficam de fora

Removidos de `Produto` no export (`PRODUTO_TENANT_FIELDS`):

| Campo | Motivo |
|---|---|
| `externalProductId` | `Stocks.CodigoID` do ERP local. É um namespace por farmácia e o ERP recicla valores — levá-lo para outro tenant produz colisões silenciosas. |
| `lastVerificationAttemptAt` | Estado transitório do worker de verificação. |
| `dataAtualizacao` | `@updatedAt` — regenerado pelo destino. |

`designacao` **é** exportada, mas no import só preenche destinos vazios: a designação do
destino vem do ERP daquela farmácia e é a verdade local.

---

## 2. IDs: o que se preserva e o que se remapeia

| Entidade | Estratégia |
|---|---|
| `Classificacao` | ID preservado **se** estiver livre no destino. Se já existir uma linha com a mesma chave natural (caso típico: taxonomia semeada no provisionamento com cuids novos), **o id do destino ganha** e todas as FKs de `Produto` são remapeadas. |
| `Fabricante` | Igual, por `nomeNormalizado`. |
| `Produto` | ID preservado quando o CNP é novo no destino. Se o CNP já existir, o id do destino mantém-se — só os campos são fundidos. |
| `FabricanteAlias` | Id novo; a identidade é `(fabricanteId remapeado, aliasNome)`. |
| `RegulatoryRecord`, `InfarmedSnapshot`, `TipoDocumentoClassificacao` | Chave natural é o próprio CNP / `tipoDocumento` — nada a remapear. |
| `ProdutoVerificacaoHistorico` | Id preservado; linhas cujo `produtoId` não exista no destino são ignoradas e contadas. |

Preservar IDs de `Produto` entre tenants é deliberado: dois tenants semeados do mesmo bundle
ficam com os mesmos ids de catálogo, o que torna comparações e diagnósticos cruzados triviais.

---

## 3. Regras de fusão (nunca destrutivas)

Aplicadas campo a campo por `buildProdutoPatch` — a função está isolada e testada:

1. **Origem nula nunca escreve.** Não se apaga informação.
2. **Destino vazio aceita sempre.** É o caso do bootstrap numa base nova.
3. **Destino preenchido só cede a origem estritamente mais forte** — isto é, `validadoManualmente=true`
   na origem quando o destino não está validado.
4. **Destino validado à mão é intocável.**
5. **N1 "Outros Medicamentos" nunca substitui** uma classificação existente (é fallback fraco).
6. **`designacao` do destino nunca é sobreposta.**
7. `RegulatoryRecord` e `InfarmedSnapshot` seguem *preserve-non-null*: só preenchem buracos.

Consequência: correr o import duas vezes não muda nada na segunda (idempotência), e correr
dois bundles em sequência (ex.: legacy e depois Silveira) acumula sem destruir.

---

## 4. Ferramentas

### 4.1 `npm run catalog:export`

Origem **sempre explícita** — `DATABASE_URL` nunca é usada por omissão.

```bash
# dry-run (default): conta, mede cobertura, não escreve nada
npm run catalog:export -- --source-tenant grupo-silveira

# escrever o bundle
npm run catalog:export -- --source-url-env DATABASE_URL \
    --out exports/catalogo-mestre-2026-08-04 --apply
```

| Opção | Default | Efeito |
|---|---|---|
| `--source-tenant <slug>` | — | Resolve a base pelo control plane. |
| `--source-url-env <ENV>` | — | Lê a connection string dessa env. Mutuamente exclusiva com a anterior. |
| `--out <dir>` | — | Obrigatória com `--apply`. |
| `--filter enriched\|all` | `enriched` | `enriched` exporta só produtos que carregam valor de catálogo (validados à mão, verificados, ou com pelo menos um campo enriquecido). |
| `--regulatory all\|referenced\|none` | `all` | `referenced` limita `RegulatoryRecord` aos CNPs exportados. |
| `--include-history` | off | Inclui `ProdutoVerificacaoHistorico`. |
| `--include-tipodoc` | off | Inclui `TipoDocumentoClassificacao`. |
| `--limit <n>` | — | Corta cada tabela. Só para ensaios — bundles com `--limit` falham o pré-voo do import. |
| `--apply` | off | Sem isto é dry-run. |

Produz:

```
exports/catalogo-mestre-2026-08-04/
  manifest.json          contagens, cobertura, checksums, opções, exclusões
  checksums.sha256       sha256 por ficheiro (formato sha256sum)
  data/classificacao.ndjson
  data/fabricante.ndjson
  data/fabricante-alias.ndjson
  data/produto.ndjson
  data/regulatory-record.ndjson
  data/infarmed-snapshot.ndjson
```

O bundle não contém credenciais: a origem aparece mascarada (`ep-polis***/neondb`).

### 4.2 `npm run catalog:import`

```bash
# dry-run (default): decide tudo, reporta, não escreve
npm run catalog:import -- --from exports/catalogo-mestre-2026-08-04 --target-tenant silveira

# escrever
npm run catalog:import -- --from exports/catalogo-mestre-2026-08-04 --target-tenant silveira --apply
```

| Opção | Efeito |
|---|---|
| `--from <dir>` | Bundle a importar (obrigatória). |
| `--target-tenant <slug>` / `--target-url-env <ENV>` | Destino explícito, mutuamente exclusivas. |
| `--allow-schema-drift` | Deixa passar divergência entre o schema do bundle e o do destino. |
| `--skip-checksums` | Salta a verificação de integridade (não usar em produção). |
| `--apply` | Sem isto é dry-run. |

Três pré-voos antes de qualquer escrita, todos com falha explícita:

1. **Integridade** — todos os ficheiros batem certo com os sha256 do manifest.
2. **Schema** — a última migração do destino é a mesma do bundle.
3. **Dependências** — todas as FKs referenciadas por `produto.ndjson` e
   `fabricante-alias.ndjson` existem dentro do bundle, e a contagem de linhas bate com o manifest.

No fim (com `--apply`) valida que todos os CNPs do bundle existem no destino e que não há
`fabricanteId` órfão; se falhar, sai com código 1.

### 4.3 `npm run catalog:audit`

Read-only. Serve para escolher a fonte antes do export, para validar depois do import e para
vigiar em rotina.

```bash
npm run catalog:audit -- --tenant grupo-silveira
npm run catalog:audit -- --url-env DATABASE_URL --json
npm run catalog:audit -- --tenant silveira --expect exports/catalogo-mestre-2026-08-04
```

Reporta totais, cobertura (ATC, DCI, forma/dose/embalagem, imagens, fabricante, N1/N2,
verificados, validados à mão) e integridade referencial. Com `--expect` compara com o manifest
e devolve exit code 1 se o destino tiver menos cobertura do que o bundle — é o gate para runbooks.

---

## 5. Estado real das fontes candidatas (medido a 2026-08-04)

| Métrica | Base legacy (`DATABASE_URL`) | `grupo-silveira` |
|---|---:|---:|
| Produtos | 14 762 | 28 102 |
| Produtos com valor de catálogo | **13 514** | 10 447 |
| Com ATC / DCI | 4 168 / 4 171 | **5 757 / 5 760** |
| Com forma+dose+embalagem | 4 171 | **5 207** |
| Com imagem | **4 410** | 0 |
| Com fabricante | **12 579 (85 %)** | 8 241 (29 %) |
| Com classificação N1/N2 | **11 438 (78 %)** | 8 386 (30 %) |
| Fabricantes / aliases | **1 031 / 1 019** | 858 / 0 |
| Classificações (N1/N2) | **192 (27/165)** | 103 (15/88) |
| `RegulatoryRecord` | **283 337** | 16 006 |
| `InfarmedSnapshot` | **41 368** | 0 |
| Validados manualmente | **0** | **0** |
| Órfãos referenciais | 0 | 0 |

Sobreposição de CNPs enriquecidos: 8 538 comuns, 1 909 exclusivos da Silveira, **união 15 423**.

Duas leituras que mudam o plano:

- **Não existe nenhum produto com `validadoManualmente=true` em nenhuma base.** O valor a
  preservar é o enriquecimento automático e a camada regulamentar, não validações humanas. As
  regras de fusão continuam a proteger validações manuais — só que hoje não há nenhuma para
  proteger. Se houve validação manual feita por outra via (ex.: correcções aplicadas por script
  sem levantar a flag), isso não é distinguível no schema e deve ser confirmado antes do export.
- **A legacy é a melhor fonte** em tudo excepto ATC/DCI/forma-dose-embalagem, onde a Silveira
  ganha. Daí o plano de duas camadas abaixo.

---

## 6. Plano de bootstrap recomendado

1. `catalog:audit` nas duas fontes (feito — §5) para congelar o ponto de partida.
2. `catalog:export --source-url-env DATABASE_URL --include-history --apply` → **bundle base**
   (classificação, fabricantes+aliases, imagens, RegulatoryRecord, InfarmedSnapshot).
3. `catalog:export --source-tenant grupo-silveira --apply` → **bundle complementar**
   (os 1 909 CNPs exclusivos e a melhor cobertura ATC/DCI).
4. Na base nova, já migrada (`prisma migrate deploy`) e com a taxonomia semeada:
   `catalog:import --from <bundle base> --target-tenant silveira` (dry-run) → rever → `--apply`.
5. `catalog:import --from <bundle complementar> --target-tenant silveira` (dry-run) → `--apply`.
   As regras de fusão garantem que a segunda passagem só preenche buracos.
6. `catalog:audit --tenant silveira --expect <bundle base>` → tem de passar.
7. Repetir 4–6 para `garantia` a partir dos **mesmos** bundles — é isso que torna o catálogo
   "mestre": as duas farmácias arrancam com ids de catálogo idênticos.
8. Só depois ligar os agentes para a ingestão operacional.

---

## 7. Riscos

| Risco | Mitigação |
|---|---|
| **Importar para o tenant errado** | Destino sempre explícito; sem default para `DATABASE_URL`; blocklist de tenants de teste; o dry-run é o modo por omissão e imprime o destino resolvido antes de tudo. |
| **Sobrescrever trabalho bom com dados fracos** | Regras de fusão (§3), testadas. Nada é apagado: só se preenchem buracos, salvo origem validada à mão. |
| **Colisão de IDs com a taxonomia semeada** | Remapeamento por chave natural — o id do destino ganha e as FKs são reescritas. |
| **Bundle corrompido ou truncado** | sha256 por ficheiro no manifest + `checksums.sha256`; verificação obrigatória antes de escrever; contagem de linhas confrontada com o manifest. |
| **Bundle parcial (`--limit`) importado por engano** | O pré-voo compara linhas reais com o manifest e aborta. |
| **Schema divergente entre bundle e destino** | Comparação da última migração; aborta sem `--allow-schema-drift`. |
| **Fuga de segredos no bundle** | Nenhuma connection string é escrita; a origem vai mascarada; `EmailConfig`, `Utilizador` e control plane estão fora do inventário. Coberto por teste. |
| **`externalProductId` cruzado entre farmácias** | Removido no export — é namespace local do ERP. |
| **Produto sem `RegulatoryRecord` correspondente** | Reportado como informativo pela auditoria; não bloqueia (o pipeline regulatório preenche depois). |
| **Import ainda não exercitado contra base real** | Ver §8 — é o primeiro passo a fazer na VPS, contra uma base descartável. |

---

## 8. Plano de validação

| # | Verificação | Como | Estado |
|---|---|---|---|
| 1 | Funções puras de decisão (fusão, força, profundidade, máscara, inventário) | `npm run test:catalog-master` — 50 asserções | ✅ passa |
| 2 | Round-trip do bundle em disco + detecção de corrupção e de ficheiro em falta | idem (usa directório temporário) | ✅ passa |
| 3 | `typecheck` e `lint` | `npm run typecheck`, `npx eslint scripts/catalog-master` | ✅ limpos |
| 4 | Export dry-run contra as duas fontes reais | `catalog:export --source-*` sem `--apply` | ✅ corrido, read-only |
| 5 | Auditoria contra as duas fontes reais | `catalog:audit` | ✅ corrido, read-only |
| 6 | **Export com `--apply` para ficheiro** | numa máquina com espaço; verificar `checksums.sha256` com `sha256sum -c` | ⏳ por fazer |
| 7 | **Import dry-run contra base vazia migrada** | primeira base na VPS | ⏳ por fazer |
| 8 | **Import `--apply` + idempotência** (segunda corrida = 0 inserts, 0 updates) | idem | ⏳ por fazer |
| 9 | **`catalog:audit --expect`** contra o destino | idem | ⏳ por fazer |
| 10 | Ingestão de um agente por cima do catálogo semeado, confirmando que `ProdutoFarmacia` liga aos `Produto` importados por CNP | após 7–9 | ⏳ por fazer |

Os passos 6–10 exigem uma base de destino descartável e não foram executados: por instrução,
nada foi exportado nem importado a partir de produção, e a Neon não foi alterada.
