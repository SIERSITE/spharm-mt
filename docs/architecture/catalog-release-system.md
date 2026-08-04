# Catalog Release System — Arquitectura

**Estado:** APROVADO (direcção arquitectural) · **Data:** 2026-08-04 · **Versão do documento:** 2.0
**Âmbito de implementação aprovado:** fases A–H (§11). Update Engine, rollback campo-a-campo, UI de
releases, promoção automática de canais, centralização dos pipelines e automação de publicação
ficam **explicitamente adiados**.
**Restrição transversal:** a migração para VPS **não espera** por este sistema.

**Relacionados:** [`docs/catalog-master.md`](../catalog-master.md) (ferramentas transitórias, commit `156716d`),
[`notes/vps-migration-audit-2026-08-04.md`](../../notes/vps-migration-audit-2026-08-04.md).

---

## 1. Decisões aprovadas

| # | Decisão | Consequência estrutural |
|---|---|---|
| D1 | Existe um **Catalog Store** dedicado, única fonte permanente de conhecimento de catálogo. | Base de dados própria, schema próprio, ciclo de vida próprio. |
| D2 | Legacy e Grupo Silveira entram **uma única vez**, por harvest. | O harvest é código descartável por desenho, mas auditável para sempre via `Observation`. |
| D3 | Tenants operacionais **não são fontes permanentes**; no futuro só emitem observações. | O canal de observações é fase futura; a fase 1 não o implementa. |
| D4 | Regras de fusão sobre **tier, confiança, completude, recência, relevância e proveniência** — nunca sobre o nome da base. | Uma fonte nova é uma linha em `CatalogSource` + um adapter. |
| D5 | `InfarmedSnapshot` **fora** do Release e fora dos tenants. | Vive só no Store, como staging da fonte INFARMED. |
| D6 | `ProdutoVerificacaoHistorico` **fora** do Release. | Substituído por proveniência por campo. |
| D7 | `RegulatoryRecord` **completo no Store**; o Release leva apenas a projecção dos produtos incluídos. | Artefacto separado e versionado dentro do bundle. |
| D8 | `TipoDocumentoClassificacao` **fora do catálogo** — é configuração de ingestão. | Futuro "ERP Profile Pack", fora deste sistema. |
| D9 | **Proveniência por campo** é obrigatória. | `CatalogFieldProvenance` no Store + `catalogProvenance` compacto no tenant. |
| D10 | **Matriz explícita de propriedade** de campos entre catálogo e tenant. | §7 — é contrato, não convenção. |
| D11 | Releases **imutáveis**; CalVer para humanos, `contentHash` como identidade real. | Dois builds com a mesma versão e hashes diferentes = erro, recusado pelo registo. |
| D12 | **Harvest com autoridade derivada por campo** (§6), nunca um tier único por origem. | Requer confirmação contra fonte regulamentar antes de atribuir `REGULATORY`. |
| D13 | **IDs determinísticos** para entidades canónicas, via chave canónica com namespace e tipo de identificador. | §4. Não se aplica a entidades operacionais. |
| D14 | Produtos apenas internos do ERP **não entram** no Release; ficam locais ao tenant. | Regra de admissão explícita (§4.4). |
| D15 | IDs de entidades operacionais (farmácias, vendas, stocks, movimentos, utilizadores, jobs) **não são alterados**. | O sistema nunca escreve nessas tabelas. |

### 1.1 Uma correcção pedida a D13

A chave-exemplo `MEDICAMENTO:CNP:<cnp>` faz o **namespace depender do `productType`** — que é um
atributo **resolvido e mutável**. Um produto reclassificado de `RETAIL` para `MEDICAMENTO` mudaria
de chave canónica e portanto de id, e todos os tenants instalados passariam a ter **duas linhas
para o mesmo produto**. A identidade não pode depender de nada que o pipeline possa mudar.

**Proposta:** o namespace é a **autoridade emissora do identificador**, não a natureza do produto:

```
   PT:CNP:1234567          Código Nacional do Produto (autoridade: INFARMED/PT)
   GS1:EAN:5601234567890   European Article Number (autoridade: GS1)
   TAX:PATH:medicamentos/analgesicos-e-anti-inflamatorios
   MFR:NAME:laboratorios-vitoria
```

Mantém a estrutura pedida (`namespace : tipo-de-identificador : valor`), fica imune a
reclassificação, e admite naturalmente novos tipos de identificador. O `productType` continua a
ser um **atributo** do produto, resolvido pelo merge — nunca parte da sua identidade.

---

## 2. Componentes

```
┌──────────────────────── PLANO DE CONHECIMENTO (escrita) ───────────────────────┐
│                                                                                │
│  Fontes            Adapters                Catalog Store (base própria)        │
│  ──────            ────────                ──────────────────────────          │
│  harvest legacy ─┐                        ┌──────────────────────────────┐     │
│  harvest silveira├─▶ Observation[] ──────▶│ CatalogSource                │     │
│  INFARMED (fut.) │   (append-only)        │ Observation      (append-only)│    │
│  INFOMED  (fut.) │                        │ CatalogProduct               │     │
│  OFF/OBF  (fut.) ┘                        │ CatalogFieldProvenance ◀── D9 │    │
│                       Merge Engine ──────▶│ CatalogTaxonomyNode          │     │
│                       (D4: tier,          │ CatalogManufacturer(+Alias)  │     │
│                        confiança,         │ RegulatorySourceRecord (D7)  │     │
│                        completude,        │ MergeConflict                │     │
│                        recência,          │ CatalogRelease               │     │
│                        relevância)        └───────────────┬──────────────┘     │
└───────────────────────────────────────────────────────────┼────────────────────┘
                                                            │ build determinístico
┌───────────────────────── PLANO DE DISTRIBUIÇÃO ───────────▼────────────────────┐
│  Release 2026.09.1+sha256:9f3a…   (imutável, verificável, auto-descritivo)      │
│  manifest.json · checksums.sha256 · data/*.ndjson                              │
│  Registo da instalação: control plane → TenantCatalogInstallation              │
└───────────────────────────────────────────────────────────┬────────────────────┘
                                        bootstrap idempotente (fase G)
┌───────────────────────────── PLANO OPERACIONAL ───────────▼────────────────────┐
│  tenant silveira · tenant garantia · …                                         │
│  Produto (campos do Release + campos do tenant, matriz §7)                     │
│  ProdutoFarmacia, Venda, MovimentoArtigo, … ← agentes; nunca no Release        │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Modelo de dados mínimo (fase 1)

Schema do Catalog Store — `catalog/store/schema.prisma`, base `catalog_store`, cliente gerado em
`generated/catalog`. Só o necessário para A–H; o que ficou de fora está no fim da secção.

```prisma
/// Fonte de conhecimento. Adicionar uma fonte = inserir uma linha + escrever um adapter.
model CatalogSource {
  id              String   @id            // "harvest-legacy", "infarmed-opendata"
  nome            String
  tier            String                  // SourceTier: REGULATORY|MANUFACTURER|DISTRIBUTOR|RETAIL|INTERNAL_INFERRED|MANUAL
  confiancaBase   Float                   // usada quando a observação não traz confiança própria
  enabled         Boolean  @default(true)
  descricao       String?
  lastSyncAt      DateTime?
  observations    Observation[]
  provenance      CatalogFieldProvenance[]
}

/// Facto bruto observado. APPEND-ONLY: nunca é actualizado nem apagado.
/// É a matéria-prima de que o Store inteiro é reconstruível.
model Observation {
  id            String   @id                       // det.: uuidv5(NS_OBS, sourceId|canonicalKey|field|observedAt)
  sourceId      String
  canonicalKey  String                             // "PT:CNP:1234567"
  field         String                             // "codigoATC", "imagemUrl", …
  value         String?                            // sempre serializado como texto
  confidence    Float
  tierClaimed   String                             // tier atribuído pelo adapter (§6)
  evidence      Json?                              // {confirmedBy, regulatorySource, rawRef, …}
  observedAt    DateTime
  batchId       String                             // lote de harvest/ingest — permite reverter uma corrida
  source        CatalogSource @relation(fields: [sourceId], references: [id])
  @@index([canonicalKey, field])
  @@index([batchId])
}

/// Produto canónico. Uma linha por identidade canónica, para toda a plataforma.
model CatalogProduct {
  id                String   @id                   // uuidv5(NS_CATALOG, canonicalKey) — §4
  canonicalKey      String   @unique               // "PT:CNP:1234567"
  cnp               Int?     @unique               // desnormalizado para joins e projecção
  designacaoCanonica String?
  codigoATC         String?
  dci               String?
  formaFarmaceutica String?
  dosagem           String?
  embalagem         String?
  imagemUrl         String?
  grupoHomogeneo    String?
  productType       String?
  flagGenerico      Boolean  @default(false)
  flagMSRM          Boolean  @default(false)
  flagMNSRM         Boolean  @default(false)
  flagMnsrmNCompart Boolean  @default(false)
  manufacturerId    String?
  taxonomyN1Id      String?
  taxonomyN2Id      String?
  status            String   @default("PUBLISHED") // DRAFT | PUBLISHED | DEPRECATED
  firstReleasedIn   String?
  lastChangedIn     String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  provenance        CatalogFieldProvenance[]
  @@index([status])
  @@index([taxonomyN2Id])
}

/// D9 — o valor vencedor de cada campo e a razão por que venceu.
model CatalogFieldProvenance {
  productId         String
  field             String
  value             String?
  sourceId          String
  tier              String
  confidence        Float
  /// MIGRATED_UNVERIFIED quando veio de harvest sem confirmação (§6).
  state             String   @default("RESOLVED")  // RESOLVED | MIGRATED_UNVERIFIED | CONFLICTED
  evidence          Json?
  observedAt        DateTime
  decidedAt         DateTime @default(now())
  releaseIntroduced String?
  product           CatalogProduct @relation(fields: [productId], references: [id], onDelete: Cascade)
  source            CatalogSource  @relation(fields: [sourceId], references: [id])
  @@id([productId, field])
  @@index([state])
  @@index([tier])
}

/// Conflito não resolvido — explícito por decisão (D4), não silenciado.
model MergeConflict {
  id          String   @id
  productId   String
  field       String
  candidates  Json                                  // [{value, sourceId, tier, confidence, evidence}]
  detectedAt  DateTime @default(now())
  status      String   @default("OPEN")             // OPEN | RESOLVED | IGNORED
  resolvedAt  DateTime?
  resolvedBy  String?
  resolution  String?
  @@unique([productId, field])
  @@index([status])
}

model CatalogTaxonomyNode {
  id           String  @id                          // uuidv5(NS_CATALOG, "TAX:PATH:<path>")
  canonicalKey String  @unique
  nivel        Int                                  // 1 | 2
  nome         String
  paiId        String?
  ordem        Int?
  estado       String  @default("ATIVO")
  @@index([paiId])
}

model CatalogManufacturer {
  id              String @id                        // uuidv5(NS_CATALOG, "MFR:NAME:<slug>")
  canonicalKey    String @unique
  nomeNormalizado String @unique
  paisOrigem      String?
  aliases         CatalogManufacturerAlias[]
}

model CatalogManufacturerAlias {
  id             String @id
  manufacturerId String
  alias          String
  sourceId       String?
  manufacturer   CatalogManufacturer @relation(fields: [manufacturerId], references: [id], onDelete: Cascade)
  @@unique([manufacturerId, alias])
}

/// D7 — registo regulamentar COMPLETO. Nunca sai inteiro para um tenant.
model RegulatorySourceRecord {
  cnp               Int      @id
  designacaoOficial String?
  dci               String?
  codigoATC         String?
  formaFarmaceutica String?
  dosagem           String?
  embalagem         String?
  grupoTerapeutico  String?
  titularAim        String?
  estadoAim         String?
  source            String
  importedAt        DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@index([codigoATC])
  @@index([dci])
}

/// D11 — cada build registado, imutável.
model CatalogRelease {
  version         String   @id                      // "2026.09.1"
  contentHash     String   @unique                  // "sha256:…"
  createdAt       DateTime @default(now())
  builderVersion  String
  channel         String   @default("dev")
  previousVersion String?
  manifest        Json                              // o manifest completo, tal como emitido
  productCount    Int
  notes           String?
}
```

**Deliberadamente fora da fase 1:** `CurationDecision` (não existe curadoria manual — zero
`validadoManualmente=true` em todas as bases), `ProvenanceHistory` (a `Observation` já é o
substrato de auditoria e permite reconstruir o histórico), tabelas de ingestão específicas por
fonte (INFARMED/INFOMED entram quando os adapters existirem).

**Uma tabela nova no control plane** (D11):

```prisma
model TenantCatalogInstallation {
  id             String   @id @default(cuid())
  tenantSlug     String
  releaseVersion String
  contentHash    String
  mode           String                              // BOOTSTRAP  (UPDATE fica para a fase adiada)
  status         String                              // OK | PARTIAL | FAILED
  installedAt    DateTime @default(now())
  engineVersion  String
  counts         Json?
  reportUri      String?
  @@index([tenantSlug, installedAt])
}
```

---

## 4. Algoritmo de identidade determinística (D13)

### 4.1 Chave canónica

```
canonicalKey := <NAMESPACE> ":" <ID_TYPE> ":" <VALUE_NORMALIZADO>
```

| Entidade | Chave | Normalização |
|---|---|---|
| Produto (PT) | `PT:CNP:<cnp>` | inteiro sem zeros à esquerda |
| Produto (retail com EAN) | `GS1:EAN:<ean>` | dígitos apenas; EAN-13 com check digit validado |
| Taxonomia | `TAX:PATH:<n1-slug>[/<n2-slug>]` | minúsculas, sem acentos, não-alfanuméricos → `-`, colapsar repetidos |
| Fabricante | `MFR:NAME:<slug>` | mesma slugificação sobre `nomeNormalizado` |

### 4.2 Derivação do id

```
NS_CATALOG = "b7c1f0e2-5a34-4f8e-9c21-0d6a3e8b41f7"   // UUID fixo, parte do contrato
id = uuidv5(NS_CATALOG, canonicalKey)                  // RFC 4122 §4.3 (SHA-1)
```

`uuidv5` é implementável em ~20 linhas sobre `node:crypto` — sem dependência nova. `NS_CATALOG` e
o algoritmo ficam declarados no manifest (`idStrategy`) e são **imutáveis**: mudá-los invalida
todos os tenants instalados e exige `manifestVersion` novo.

### 4.3 Propriedades exigidas

1. **Estabilidade** — a chave só depende de identificadores emitidos por autoridades externas,
   nunca de atributos resolvidos pelo pipeline (§1.1).
2. **Reprodutibilidade** — qualquer máquina, qualquer altura, mesmo id.
3. **Convergência** — um produto criado localmente por um agente com CNP `X` recebe o mesmo id que
   o Release lhe dará. A adopção é automática, não é deduplicação.
4. **Não-aplicação a operacionais** (D15) — `Farmacia`, `Utilizador`, `Venda`, `MovimentoArtigo`,
   `ProdutoFarmacia`, `LoteIngestao`, jobs: mantêm `cuid()`. O sistema nunca lhes toca.

### 4.4 Regra de admissão ao Release (D14)

Um produto só entra se **todas** se verificarem:

- tem chave canónica derivável de identificador externo (hoje: CNP com 7 dígitos);
- o CNP passa a validação de formato (`1000000 ≤ cnp ≤ 9999999`);
- tem pelo menos um campo de catálogo resolvido (não é uma casca vazia).

Tudo o resto — códigos internos do ERP, serviços, taxas, artigos locais — **fica no tenant**, com
`catalogProvenance = null`, e nunca é exportado. Medição de hoje: 14 761/14 762 (legacy) e
28 100/28 102 (Silveira) dos CNPs têm 7 dígitos. Os **3 outliers** vão para quarentena
(`data/rejected.ndjson`) com motivo — não são silenciosamente descartados.

---

## 5. Regras de fusão (D4)

Centralizadas em `catalog/merge/rules.ts` como dados. Uma regra é
`(candidato, instalado, contexto) → { action: "accept" | "reject" | "conflict", reason }`.
Primeira que decide, decide:

| # | Regra | Fundamento |
|---|---|---|
| R1 | Campo irrelevante para o `productType` nunca é escrito. | Já é regra do resolver actual; inviolável. |
| R2 | Valor com proveniência `MANUAL` só cede a outro `MANUAL` mais recente. | O trabalho humano é o activo mais caro. |
| R3 | `fabricante`, `dci`, `codigoATC` só aceitam `REGULATORY`/`MANUFACTURER`. | Herdado de `catalog-persistence.ts` (`AUTHORITATIVE_FIELDS`). |
| R4 | Candidato nulo/vazio é sempre rejeitado. | "Nunca apagar dados válidos". |
| R5 | Instalado vazio aceita candidato acima do threshold (0,50). | Cobre a maioria dos casos. |
| R6 | Tier estritamente superior vence. | `SOURCE_TIER_RANK` existente. |
| R7 | Tier igual: confiança superior **por margem ≥ 0,10** vence. | A margem evita oscilação entre releases por ruído. |
| R8 | Empate: **mais completo** vence (registos compostos — ver abaixo). | "Só substitui quando for mais completo". |
| R9 | Empate persistente: **mais recente** vence se `observedAt` diferir > 30 dias. | Recência desempata, nunca domina. |
| R10 | Caso contrário: `conflict` — mantém o instalado, abre `MergeConflict`. | Conflitos explícitos (D4). |

**Métrica de completude (R8)** para o registo regulamentar de um CNP: número de campos não-nulos
em `{designacaoOficial, dci, codigoATC, formaFarmaceutica, dosagem, embalagem, grupoTerapeutico,
titularAim, estadoAim}`. Um candidato só substitui se `completude(candidato) > completude(instalado)`
**e** nenhum campo não-nulo instalado ficar nulo — a substituição é sempre por união, nunca por
troca cega.

---

## 6. Regras do harvest (D12)

O harvest não atribui um tier por origem. Para **cada campo de cada produto**, deriva a autoridade
a partir de evidência.

```
             valor no tenant/legacy
                      │
     ┌────────────────┴────────────────┐
     │ o campo é regulamentado?         │  {codigoATC, dci, formaFarmaceutica,
     │ (lista fechada)                  │   dosagem, embalagem, fabricante}
     └───────┬─────────────────┬────────┘
            sim               não
             │                 │
   ┌─────────▼──────────┐      └──▶ deriva do classificationSource (tabela 6.2)
   │ existe valor no    │
   │ RegulatoryRecord?  │
   └──┬────────┬────────┘
      │        │
     não      sim
      │        │
      │   ┌────▼─────────────┐
      │   │ valores iguais    │──sim──▶ tier=REGULATORY, conf=0.95
      │   │ (normalizados)?   │          evidence={confirmedBy:"regulatory-record", cnp}
      │   └────┬─────────────┘
      │        └──não──▶ NÃO sobrescreve. Observação registada com
      │                  tier=INTERNAL_INFERRED, state=CONFLICTED
      │                  + MergeConflict aberto (D4)
      │
      └──▶ tier=INTERNAL_INFERRED, conf=0.40, state=MIGRATED_UNVERIFIED
           (preservado, mas nunca sobrepõe uma fonte regulamentar futura)
```

### 6.1 O que isto dá com os dados de hoje (medido, 2026-08-04)

| Base | ATC confirmável | ATC divergente | ATC sem registo regulamentar |
|---|---:|---:|---:|
| legacy | **4 166** | 2 | 0 |
| grupo-silveira | **5 755** | 2 | 0 |

Ou seja: **99,96 % do ATC existente sobrevive com tier `REGULATORY`**, e apenas **4 produtos** no
total abrem conflito para decisão humana. A preocupação de que a regra R3 destruísse o
enriquecimento existente não se materializa — mas só porque a confirmação é feita campo a campo.
Com um tier único de origem, ou se perdiam 9 921 valores bons, ou se promoviam 4 maus.

### 6.2 Campos não regulamentados

| Sinal na origem | Tier atribuído | Confiança | Estado |
|---|---|---|---|
| `validadoManualmente = true` | `MANUAL` | 1,00 | `RESOLVED` |
| `classificationSource = "EXTERNAL"` | `RETAIL` | 0,60 | `RESOLVED` |
| `classificationSource = "ATC_CODE"` | `INTERNAL_INFERRED` | 0,70 | `RESOLVED` — derivado de dado regulamentar |
| `classificationSource = "TEXT_PATTERN"` | `INTERNAL_INFERRED` | 0,50 | `MIGRATED_UNVERIFIED` |
| `classificationSource = null` | `INTERNAL_INFERRED` | 0,40 | `MIGRATED_UNVERIFIED` |
| `imagemUrl` (sem proveniência registada) | `RETAIL` | 0,50 | `MIGRATED_UNVERIFIED` |

Distribuição real: legacy `TEXT_PATTERN=7 689 · ATC_CODE=3 966 · EXTERNAL=1 186 · null=1 921`;
Silveira `null=19 694 · TEXT_PATTERN=4 213 · ATC_CODE=3 693 · EXTERNAL=502`.

### 6.3 Invariantes do harvest

1. Nenhum dado de tenant é promovido a `REGULATORY` sem confirmação — nunca, sem excepção nem flag.
2. Nada é descartado por não ser confirmável: fica com autoridade baixa e estado explícito.
3. Todo o valor observado gera uma `Observation`, mesmo o que perde. O harvest é reconstruível.
4. Conflitos são materializados em `MergeConflict`, não resolvidos por ordem de processamento.
5. O harvest é idempotente por `batchId`: reexecutar o mesmo lote não duplica observações.

---

## 7. Matriz de propriedade dos campos (D10)

Contrato entre o Release e o tenant, sobre a tabela `Produto` actual.

| Campo em `Produto` | Dono | Bootstrap | Update (fase adiada) |
|---|---|---|---|
| `cnp` | Identidade | escreve | imutável |
| `id` | Release (determinístico) | escreve | imutável |
| `codigoATC`, `dci`, `formaFarmaceutica`, `dosagem`, `embalagem` | **Release** | escreve | aplica pelas regras §5 |
| `imagemUrl`, `grupoHomogeneo`, `productType`, `productTypeConfidence` | **Release** | escreve | aplica |
| `flagGenerico`, `flagMSRM`, `flagMNSRM`, `flagMnsrmNCompart` | **Release** | escreve | aplica |
| `fabricanteId`, `classificacaoNivel1Id`, `classificacaoNivel2Id` | **Release** | escreve | aplica |
| `classificationSource`, `classificationVersion` | **Release** | escreve | aplica |
| `verificationStatus`, `lastVerifiedAt`, `externallyVerified` | **Release** | escreve | aplica |
| `designacaoCanonica` *(campo novo)* | **Release** | escreve | aplica |
| `designacao` | **Tenant** (vem do ERP) | escreve só se vazio | **nunca** |
| `externalProductId` | **Tenant** | nunca | **nunca** |
| `estado`, `origemDados` | **Tenant** | valor por omissão | **nunca** |
| `validadoManualmente`, `needsManualReview`, `manualReviewReason` | **Tenant, com precedência local** | não escreve | **nunca**; bloqueia o Release nesse campo |
| `lastVerificationAttemptAt` | **Tenant** | nunca | nunca |
| `catalogProvenance` *(campo novo, JSONB)* | **Release** | escreve | aplica |
| `catalogReleaseVersion` *(campo novo)* | **Release** | escreve | aplica |
| `dataCriacao`, `dataAtualizacao` | **Tenant** | por omissão | nunca |

Regra de ouro: **o que não estiver nesta tabela é do tenant.** Um campo novo no schema é do tenant
até alguém o declarar aqui.

**Dívida técnica assumida:** a fronteira é lógica, não física. A alternativa correcta —
`CatalogProduto` (read-only) + `ProdutoLocal` (overlay) + vista — obriga a reescrever todas as
queries do runtime. Fica registada e reavaliada quando o Update Engine entrar.

---

## 8. Contratos do Release

### 8.1 Estrutura do bundle

```
releases/2026.09.1/
├── manifest.json                        contrato (8.2)
├── checksums.sha256                     verificável com `sha256sum -c`
└── data/
    ├── taxonomy.ndjson                  CatalogTaxonomyNode
    ├── manufacturer.ndjson              CatalogManufacturer
    ├── manufacturer-alias.ndjson        CatalogManufacturerAlias
    ├── product.ndjson                   CatalogProduct + catalogProvenance compacto
    ├── regulatory-projection.ndjson     D7 — só os CNPs do Release
    └── rejected.ndjson                  admissão recusada (§4.4), com motivo
```

### 8.2 Manifest — `manifestVersion: 2`

```jsonc
{
  "manifestVersion": 2,
  "release": {
    "version": "2026.09.1",
    "contentHash": "sha256:9f3ab2…",     // cobre data/*, NÃO cobre createdAt nem builderVersion
    "createdAt": "2026-09-01T10:12:33Z",
    "builderVersion": "catalog-builder/1.0.0",
    "previousVersion": null,
    "channel": "dev"
  },
  "identity": {
    "idStrategy": "uuidv5",
    "namespace": "b7c1f0e2-5a34-4f8e-9c21-0d6a3e8b41f7",
    "keyFormats": ["PT:CNP:<cnp>", "GS1:EAN:<ean>", "TAX:PATH:<path>", "MFR:NAME:<slug>"]
  },
  "compatibility": {
    "tenantSchemaMin": "20260601120000_produto_farmacia_taxa_iva",
    "tenantSchemaRequires": ["Produto.catalogProvenance", "Produto.designacaoCanonica"],
    "minBootstrapEngine": "1.0.0",
    "regulatoryProjectionVersion": "2026.09.1"
  },
  "sources": [
    { "id": "harvest-legacy",   "tier": "mixed", "batchId": "hv-2026-09-01-a",
      "observations": 40122, "fieldsWon": 12907,
      "byTier": { "REGULATORY": 8337, "RETAIL": 2144, "INTERNAL_INFERRED": 2426 } },
    { "id": "harvest-silveira", "tier": "mixed", "batchId": "hv-2026-09-01-b",
      "observations": 31880, "fieldsWon": 6011,
      "byTier": { "REGULATORY": 5755, "INTERNAL_INFERRED": 256 } }
  ],
  "tables": [
    { "name": "product", "file": "data/product.ndjson", "rows": 15423,
      "sha256": "…", "bytes": 10482331 }
  ],
  "counts":   { "products": 15423, "manufacturers": 1104, "taxonomyNodes": 192,
                "regulatoryProjection": 15423, "rejected": 3 },
  "coverage": { "atc": 0.412, "dci": 0.413, "formaDoseEmbalagem": 0.389, "image": 0.286,
                "manufacturer": 0.874, "taxonomyN2": 0.803, "manuallyCurated": 0.0,
                "migratedUnverified": 0.318 },
  "provenanceSummary": { "REGULATORY": 14092, "MANUFACTURER": 0, "DISTRIBUTOR": 0,
                         "RETAIL": 4410, "INTERNAL_INFERRED": 9938, "MANUAL": 0 },
  "conflicts": { "open": 4, "threshold": 100, "file": "data/conflicts.ndjson" },
  "validations": [
    { "gate": "G1-referential",  "status": "pass" },
    { "gate": "G2-determinism",  "status": "pass", "rebuildHash": "sha256:9f3ab2…" },
    { "gate": "G4-domain",       "status": "pass", "rejected": 3 },
    { "gate": "G5-conflicts",    "status": "pass", "open": 4 }
  ],
  "excludes": {
    "operational": ["Farmacia","Utilizador","ProdutoFarmacia","Venda","VendaMensal","Compra",
                    "Devolucao","MovimentoArtigo","Ingest*","Staging*","LoteIngestao",
                    "PipelineRun","OrderOutbox","Fornecedor*","EmailConfig","AuditLog"],
    "byDesign":    ["InfarmedSnapshot","ProdutoVerificacaoHistorico","TipoDocumentoClassificacao"]
  }
}
```

**O que faz disto contrato e não documentação:** `compatibility` é verificado antes de escrever,
`validations` são gates executados com resultado gravado, e `contentHash` é recalculável por quem
receber o bundle. Um manifest que mente é detectável em segundos.

### 8.3 Determinismo (exigência de D11)

| Fonte de não-determinismo | Eliminação |
|---|---|
| IDs aleatórios | §4 — determinísticos. |
| Ordem de linhas | `ORDER BY canonicalKey` em todas as tabelas. |
| Ordem de chaves em JSON | serializador canónico (`stableStringify`, já existe). |
| Timestamps de execução | fora do hash. |
| Fusos/precisão | UTC ISO-8601; decimais com escala fixa. |
| Concorrência no Store | snapshot `REPEATABLE READ` + watermark por fonte no manifest. |

Aceitação (G2): dois builds da mesma watermark ⇒ `contentHash` idêntico, verificado em CI.

---

## 9. Bootstrap idempotente (fase G)

```
tenant novo, migrado, vazio
  1. resolver Release (versão explícita — nunca "a mais recente" implícita)
  2. verificar bundle: checksums + contentHash + compatibility
  3. pré-voo: destino sem Produto? (senão recusa — Update é fase adiada)
  4. inserir por ordem topológica: taxonomy → manufacturer → alias → product →
     regulatory-projection, com INSERT … ON CONFLICT (id) DO NOTHING
  5. gates G1 + G7
  6. registar em TenantCatalogInstallation
  7. relatório: contagens, cobertura, duração, rejeitados, avisos
```

Idempotência por construção: com IDs determinísticos, a segunda corrida escreve **zero** linhas —
não depende de comparar campo a campo (que é como o `catalog-master` actual a obtém).

---

## 10. Validação e auditoria (fase F)

| Gate | Verifica | Falha ⇒ |
|---|---|---|
| **G1** referencial | toda a FK resolve dentro do bundle; sem ciclos na taxonomia | build/instalação aborta |
| **G2** determinismo | rebuild ⇒ mesmo `contentHash` | build aborta |
| **G3** não-regressão | nenhuma métrica de cobertura desce face ao Release anterior | build aborta (`--allow-regression` exige justificação) |
| **G4** domínio | formato de ATC, CNP, URL de imagem; taxonomia dentro do canónico | linha rejeitada → `rejected.ndjson` |
| **G5** conflitos | conflitos abertos abaixo do limiar | acima do limiar, build aborta |
| **G6** compatibilidade | `compatibility` cobre o schema do destino | instalação recusada |
| **G7** pós-instalação | contagens e cobertura no tenant ≥ manifest; zero órfãos | instalação `FAILED` |

G3 é o gate que impede o modo de falha mais provável e mais caro: um Release novo pior que o anterior.
Na fase 1, com um único Release, G3 fica inactivo (não há anterior) mas o código é escrito.

---

## 11. Critérios de aceitação da fase 1 (A–H)

| Fase | Entrega | Critério de aceitação **verificável** |
|---|---|---|
| **A** Catalog Store mínimo | schema + migrations + cliente gerado | `catalog:store:migrate` corre contra base descartável; `catalog:store:status` verde; zero tabelas operacionais no schema (teste automático sobre a lista de modelos). |
| **B** Harvest Legacy + Silveira | adapters `harvest-tenant` | ≥ 40 000 observações da legacy e ≥ 31 000 da Silveira; **100 % dos ATC/DCI confirmáveis com tier `REGULATORY`** (esperado: 4 166 + 5 755); nenhum valor promovido sem evidência (teste); reexecução do mesmo `batchId` ⇒ 0 novas observações. |
| **C** Regras de merge centralizadas | `catalog/merge/rules.ts` + engine | Todas as regras R1–R10 com teste unitário próprio; zero decisões de merge fora do módulo (verificado por lint/grep em CI); os 4 conflitos ATC conhecidos aparecem como `MergeConflict`, não são resolvidos em silêncio. |
| **D** Proveniência por campo | `CatalogFieldProvenance` populada | 100 % dos campos não-nulos de `CatalogProduct` têm linha de proveniência (query de auditoria = 0 órfãos); `state=MIGRATED_UNVERIFIED` presente e contabilizado no manifest. |
| **E** Primeiro Release imutável | `2026.xx.1` no canal `dev` | `productCount ≥ 15 423` (união medida); build 2× ⇒ mesmo `contentHash` (G2); registo em `CatalogRelease` recusa segundo build com versão igual e hash diferente. |
| **F** Manifest, checksums, auditoria | manifest v2 + `catalog:verify` + `catalog:audit` | `sha256sum -c checksums.sha256` passa; `catalog:verify` detecta bundle adulterado (teste com ficheiro modificado); auditoria reproduz as contagens do manifest. |
| **G** Bootstrap idempotente | `catalog:bootstrap` | Base vazia → contagens = manifest (G7); **segunda corrida escreve 0 linhas**; base com produtos → recusa com mensagem accionável. |
| **H** Teste completo em Postgres descartável na VPS | ensaio ponta-a-ponta | A→G corridos numa base descartável; relatório com contagens, cobertura e duração; **zero escritas em produção** demonstrado por logs. |

---

## 12. Riscos de compatibilidade com o schema actual

| # | Risco | Avaliação | Mitigação |
|---|---|---|---|
| C1 | `Produto` precisa de 3 campos novos (`designacaoCanonica`, `catalogProvenance`, `catalogReleaseVersion`) | Migração em **todos** os tenants | Campos nullable, sem default caro, sem índice na primeira migração — `ALTER TABLE ADD COLUMN` sem reescrita de tabela em PG≥11. Aplicada por `tenancy:migrate-all`. |
| C2 | Tenants existentes têm `Produto.id` em `cuid()` | Os ids determinísticos **não convergem** retroactivamente | O bootstrap só se aplica a bases novas (Silveira/Garantia na VPS). Bases antigas continuam a casar por `cnp`. Documentado, não "corrigido". |
| C3 | `Classificacao` é semeada por `scripts/seed-taxonomy.ts` com `cuid()` | Colisão de chave natural com ids determinísticos | Em bases novas, **a taxonomia passa a vir do Release** e o seed deixa de correr no provisionamento. Ordem no `provision-tenant` tem de mudar. |
| C4 | `RegulatoryRecord` existe no tenant e o cron `enrich-catalog` lê-o lá | Se a projecção não for instalada, o cron deixa de ter dados | A projecção é instalada pelo bootstrap. A tabela mantém-se no schema do tenant nesta fase. |
| C5 | `InfarmedSnapshot` continua no schema do tenant (D5 diz que não entra, não que a tabela cai já) | Tabela vazia sem consumidor | Não é removida na fase 1 (dropar coluna/tabela é irreversível). Fica marcada como deprecated no schema e removida numa fase posterior. |
| C6 | Enum `TipoClassificacao`/`EntidadeEstado` no tenant vs strings no Store | Conversão na fronteira | O Release serializa strings; o bootstrap converte e valida contra o enum do destino (G4). |
| C7 | 3 produtos com CNP fora do formato | Rejeição silenciosa seria perda | `rejected.ndjson` + contagem no manifest. |
| C8 | `lib/catalog-*` é importado pelo runtime web e por 20+ scripts | Mover ficheiros parte imports | Migração por re-export (§13), nunca por movimento directo. |
| C9 | Prisma 7 exige config própria por schema | Terceiro `*.config.ts` e terceiro cliente gerado | Já há precedente: `prisma-control.config.ts`. Replicar exactamente esse padrão. |
| C10 | `generated/catalog` aumenta o tempo de build | +1 `prisma generate` | Aceitável; o cliente do Store não entra no bundle do Next (só CLI). |

---

## 13. Plano de migração progressiva de `lib/catalog-*`

Nenhum ficheiro é movido de uma vez. Cada passo é um commit que mantém o runtime verde.

| Passo | Acção | Verificação |
|---|---|---|
| M1 | Criar `catalog/contracts/` com os tipos partilhados (`SourceTier`, `SOURCE_TIER_RANK`, `ProductType`, `ResolvedField`). `lib/catalog-types.ts` passa a **re-exportar** de lá. | `typecheck` + `lint` verdes; zero alterações noutros ficheiros. |
| M2 | Criar `catalog/merge/rules.ts` com R1–R10 extraídas de `catalog-persistence.ts` (`AUTHORITATIVE_FIELDS`, thresholds) e do resolver. `catalog-persistence.ts` passa a chamar as regras em vez de as ter inline. | Testes existentes do resolver continuam a passar; testes novos por regra. |
| M3 | `catalog/merge/engine.ts` embrulha `lib/catalog-resolution-engine.ts` sem o alterar. | Comparação A/B: mesmo input, mesmo output do resolver actual. |
| M4 | `lib/catalog-taxonomy.ts` → `catalog/contracts/taxonomy.ts` com re-export. | idem M1. |
| M5 | Depois de A–H estáveis: mover fisicamente os ficheiros e apagar os re-exports, um por commit. | `grep` por imports antigos = 0. |
| M6 | `scripts/catalog-master/*`: `export-catalog.ts` → `catalog/sources/harvest-tenant.ts`; `audit-catalog.ts` → `catalog/audit/`; `import-catalog.ts` fica como está até o bootstrap novo o substituir. | As ferramentas da VPS continuam a funcionar durante toda a transição. |

**Princípio:** o runtime web nunca fica dependente de código do Catalog Release System. A relação é
unidireccional — o sistema lê os contratos, o runtime não importa o builder.

---

## 14. Ficheiros e migrations

### 14.1 Ficheiros novos

```
catalog/contracts/{index,source-tier,manifest,release,observation,identity}.ts
catalog/store/schema.prisma                     + migrations/
catalog/sources/{registry,harvest-tenant}.ts
catalog/merge/{rules,engine,provenance,completeness}.ts
catalog/builder/{build,freeze,emit,seal,report}.ts
catalog/release/{writer,reader,checksums,verify}.ts
catalog/bootstrap/{bootstrap,preflight,validate}.ts
catalog/validation/gates/{g1..g7}.ts
catalog/audit/{coverage,orphans,compare}.ts
catalog/cli/{build,inspect,verify,bootstrap,audit,harvest}.ts
catalog/identity/{canonical-key,uuidv5}.ts
catalog.config.ts                               (padrão de prisma-control.config.ts)
docs/architecture/catalog-release-system.md     (este documento)
```

### 14.2 Ficheiros alterados

| Ficheiro | Alteração | Risco |
|---|---|---|
| `prisma/schema.prisma` | +3 campos em `Produto` (C1) | baixo |
| `prisma-control/schema.prisma` | +`TenantCatalogInstallation` | baixo |
| `package.json` | scripts `catalog:store:*`, `catalog:harvest`, `catalog:build`, `catalog:verify`, `catalog:bootstrap`, `catalog:audit` | nulo |
| `lib/catalog-types.ts` | passa a re-exportar de `catalog/contracts` (M1) | baixo |
| `lib/catalog-persistence.ts` | passa a consumir `catalog/merge/rules` (M2) | **médio** — é código do runtime de enriquecimento |
| `lib/catalog-taxonomy.ts` | re-export (M4) | baixo |
| `scripts/tenancy/provision-tenant.ts` | deixa de semear taxonomia em bases novas (C3) | médio |
| `.gitignore` | `generated/catalog`, `releases/` | nulo |

### 14.3 Migrations

| Base | Migration | Conteúdo | Reversível |
|---|---|---|---|
| Catalog Store (nova) | `0001_init_catalog_store` | todos os modelos do §3 | sim (drop database) |
| Control plane | `0005_tenant_catalog_installation` | tabela nova | sim |
| Tenant (todos) | `20260901000000_produto_catalog_fields` | `ADD COLUMN designacaoCanonica TEXT NULL`, `catalogProvenance JSONB NULL`, `catalogReleaseVersion TEXT NULL` | sim (colunas nullable) |

Nenhuma migration apaga ou altera colunas existentes. Nenhuma toca em tabelas operacionais.

---

## 15. Estimativa de complexidade

| Fase | Complexidade | Esforço | Principal fonte de risco |
|---|---|---|---|
| A — Store mínimo | Baixa | 1–2 dias | Terceiro schema Prisma (padrão já existe) |
| B — Harvest | **Alta** | 3–4 dias | A derivação de autoridade por campo (§6) é a lógica mais subtil do sistema |
| C — Regras centralizadas | Média | 2–3 dias | Extrair sem alterar comportamento do enriquecimento actual (M2) |
| D — Proveniência | Média | 1–2 dias | Volume de escrita (≈ 60 k linhas) |
| E — Release imutável | **Alta** | 2–3 dias | Determinismo é frágil: um `ORDER BY` implícito chega para o quebrar |
| F — Manifest/checksums/auditoria | Baixa | 1–2 dias | Reaproveita `catalog-master` |
| G — Bootstrap | Média | 2–3 dias | Conversão de enums e ordem topológica |
| H — Ensaio na VPS | Baixa | 1 dia | Depende da VPS estar de pé |
| | | **13–20 dias** | |

---

## 16. Riscos

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Determinismo quebra silenciosamente | média | alto | G2 em CI a cada commit, não como verificação manual |
| Harvest promove dados fracos a `REGULATORY` | baixa | **crítico** | Confirmação obrigatória por campo + teste que falha se algum valor sem `evidence.confirmedBy` sair com tier `REGULATORY` |
| Regressão no enriquecimento ao extrair as regras (M2) | média | alto | A/B contra o resolver actual antes de trocar; M3 embrulha em vez de reescrever |
| `NS_CATALOG` ou formato de chave mudarem depois de instalados | baixa | **crítico** | Declarados no manifest e tratados como imutáveis; mudança exige `manifestVersion` novo |
| Store torna-se ponto único de falha | média | alto | Backups próprios + reconstruível a partir de `Observation` (append-only) |
| Over-engineering para 2 tenants | **alta** | médio | Âmbito cortado em A–H; tudo o resto adiado por decisão explícita |
| Fase B atrasa a VPS | baixa | médio | Desacoplado: a VPS usa `catalog-master` (`156716d`) e adopta o Release quando G existir |
| 3 CNPs rejeitados escondem um problema maior | baixa | baixo | `rejected.ndjson` + contagem no manifest + revisão manual na fase H |

---

## 17. Sequência segura de implementação

```
 0. VPS avança em paralelo, sem dependência deste sistema  ─────────────────▶
 1. M1 (contratos) + A (Store)          ← sem impacto no runtime
 2. B (harvest) contra CÓPIA das bases  ← nunca contra produção
 3. C (regras) + M2/M3 com A/B          ← o passo de maior risco de regressão
 4. D (proveniência)                    ← materializa o resultado de B+C
 5. E (Release) + G2 em CI              ← determinismo antes de qualquer instalação
 6. F (manifest, verify, auditoria)
 7. Migration dos 3 campos no tenant    ← só agora, quando há Release para os preencher
 8. G (bootstrap) contra base descartável
 9. H (ensaio ponta-a-ponta na VPS)
10. Só depois: bootstrap real de Silveira e Garantia
```

**Regras de segurança durante toda a fase 1:**

- O harvest lê de **cópias** das bases de produção (`pg_dump`/restore), nunca das originais.
- Nenhuma escrita em produção. A Neon não é alterada.
- `demo-neon` e `piloto-demo` continuam em blocklist.
- Cada fase é um commit verde (`typecheck`, `lint`, testes) e reversível isoladamente.

---

## 18. Questões em aberto (não bloqueiam a fase A)

1. **Taxonomia: código ou dado?** Hoje `CANONICAL_TAXONOMY` é código. Proposta: passa a dado
   versionado no Release, com o código a validar contra ele. Decidir antes de E.
2. **`designacaoCanonica` na UI** — mostrar o nome canónico ou o do ERP? Afecta a UI, não o Store.
3. **Onde vive o `catalog_store` na VPS** — mesma instância Postgres do control plane, base
   separada. Confirmar do ponto de vista de backup.
4. **Retenção de `Observation`** — append-only cresce sem limite. Proposta: sem retenção na fase 1
   (≈ 72 k linhas é irrelevante); revisitar acima de 10 M.
