# 02 — Platform Overview

> Onde estão as fronteiras, o que atravessa cada uma, e o que nunca deve atravessar.

---

## 1. Porque existe este capítulo

O SPharm.MT parece, de fora, uma aplicação Next.js com uma base de dados. Não é. São **quatro
planos com ciclos de vida diferentes**, ligados por fronteiras estreitas e deliberadas. Quase todos
os erros de desenho que este projecto já cometeu foram atravessar uma dessas fronteiras sem reparar.

---

## 2. Vista de alto nível

```
┌──────────────── PLANO EDGE (dentro da farmácia, LAN privada) ─────────────────┐
│                                                                               │
│   SQL Server SPharm (ERP)                    Agente Windows (Node, on-prem)   │
│   ┌────────────────────┐   leitura SELECT    ┌──────────────────────────────┐ │
│   │ Stocks, Atendimento│◀───────────────────▶│ discover · bootstrap · daily │ │
│   │ StocksMov, Recepcao│   escrita: SÓ       │ sync · export-orders         │ │
│   │ Devolucao, …       │   encomendas        │ Task Scheduler, 1×/dia       │ │
│   └────────────────────┘                     └──────────────┬───────────────┘ │
└────────────────────────────────────────────────────────────┼──────────────────┘
                              HTTPS · Bearer ingestKey + X-Tenant-Slug
                              (única porta de entrada de dados operacionais)
┌────────────────────────────────────────────────────────────▼──────────────────┐
│ PLANO OPERACIONAL (cloud) — uma base por cliente                              │
│                                                                               │
│   /api/ingest/v1/*  ──▶ staging ──▶ canonicalização ──▶ modelo operacional    │
│   /api/outbox/v1/*  ◀── encomendas a exportar                                 │
│                                                                               │
│   Tenant DB: Farmacia · Produto · ProdutoFarmacia · MovimentoArtigo ·         │
│              VendaMensal · Compra · Devolucao · ListaEncomenda · OrderOutbox  │
│                                    │                                          │
│   Next.js (server components) ─────┘  dashboard · stock · encomendas ·        │
│                                       transferências · margens · relatórios   │
└───────────────┬────────────────────────────────────────┬──────────────────────┘
                │ resolve tenant                          │ consome catálogo
┌───────────────▼──────────────┐          ┌───────────────▼──────────────────────┐
│ PLANO DE CONTROLO             │          │ PLANO DE CONHECIMENTO                │
│ control plane (1 base)        │          │ catálogo                             │
│                               │          │                                      │
│ Tenant (host, credenciais     │          │ HOJE: vive dentro de cada tenant     │
│   cifradas, ingestApiKeyHash) │          │ ALVO: Catalog Store + Releases       │
│ TenantEvent · SyncRun         │          │ imutáveis (ver catalog-release-      │
│ GlobalAdmin                   │          │ system.md)                           │
└───────────────────────────────┘          └──────────────────────────────────────┘
```

**A fronteira que define o sistema** é a linha HTTPS entre o plano edge e o operacional. É a única
forma de dados operacionais entrarem, é autenticada por chave própria por cliente, e é atravessada
por iniciativa da farmácia — nunca nossa. A plataforma **não sabe** ligar-se ao SQL Server de
ninguém.

---

## 3. Os quatro planos

### 3.1 Plano edge — o agente

Um executável Node empacotado (~27 MB com runtime) que corre no PC da farmácia, agendado no Task
Scheduler do Windows. É a única peça nossa dentro da rede do cliente.

- **Lê** o SQL Server com um utilizador idealmente só de leitura.
- **Descobre** o schema dinamicamente (`sys.columns`) em vez de o assumir: instalações diferentes do
  mesmo ERP têm colunas diferentes, e uma coluna em falta tem de degradar para `NULL`, não partir
  a query. Foi aprendido a duro — três revisões do agente (rev32, rev37) foram exactamente isto.
- **Envia** em lotes, com retry, backoff e redução automática do lote em erro. A rede da farmácia
  não é fiável e isso é premissa, não excepção.
- **Puxa** encomendas pendentes a cada poucos minutos e escreve-as no ERP, com `ack`/`nack`.
- **Versionado** (`rev39`, `rev44`…): a base do agente é publicada como artefacto e o wizard injecta
  a configuração de cada farmácia.

**Fronteira:** o agente conhece o ERP e a nossa API. Não conhece o modelo de domínio da plataforma,
não decide nada, não guarda estado além de logs e do último ponto sincronizado.

### 3.2 Plano operacional — um tenant por cliente

Uma base Postgres por cliente, com o schema completo da aplicação. Contém tudo o que é da farmácia:
entidades, utilizadores, stock, vendas, movimentos, encomendas — e, hoje, também a cópia do
catálogo (ver §6).

O caminho dos dados dentro do tenant tem três degraus, e a distinção é importante:

```
   staging bruto            canónico                 read-model
   ─────────────            ────────                 ──────────
   IngestStocksMovRaw  ──▶  MovimentoArtigo    ──▶   IndicadoresProdutoFarmacia
   IngestVendaLinhaRaw ──▶  VendaMensal              (11 indicadores por produto×farmácia)
   StagingCompraRaw*   ──▶  Compra / Devolucao       Dashboard, excessos, propostas
   (fiel ao ERP,            (modelo do domínio,      (pré-calculado, recalculável
    nunca alterado)          classificado)            do zero a qualquer momento)
```

Porquê três e não um: o staging permite reprocessar sem voltar a incomodar a farmácia; o canónico
permite mudar de ERP sem mudar o domínio; o read-model permite responder em milissegundos sem
recalcular. **Um degrau nunca escreve para trás.**

### 3.3 Plano de controlo — o control plane

Uma base separada que sabe **que clientes existem** e como lhes chegar: host, base, utilizador,
password cifrada (AES-256-GCM), hash da chave de ingestão, estado, heartbeat do agente, histórico
de eventos e execuções (`SyncRun`).

É deliberadamente minúsculo e deliberadamente separado. Se o control plane cair, nenhum tenant
perde dados — perde-se a capacidade de **resolver** tenants novos. É o registo, não o caminho
crítico dos dados.

### 3.4 Plano de conhecimento — o catálogo

O que é verdade sobre um **produto** independentemente de quem o vende: designação canónica,
classificação, ATC, DCI, forma, dosagem, embalagem, fabricante, imagem, dados regulamentares.

Hoje vive **dentro de cada tenant** — o que significa que o mesmo produto é enriquecido N vezes com
N resultados divergentes. É a incoerência estrutural mais séria do sistema actual e a razão de ser
do [Catalog Release System](./catalog-release-system.md), já aprovado: um Catalog Store próprio,
releases imutáveis e versionados, tenants como consumidores.

---

## 4. Módulos da aplicação e o que os liga

```
                        ┌──────────────────────────┐
                        │   CATÁLOGO (transversal) │
                        │ Produto · Classificação  │
                        │ Fabricante · ATC/DCI     │
                        └────────────┬─────────────┘
                                     │ todos os módulos leem daqui
    ┌────────────────┬───────────────┼───────────────┬────────────────┐
    ▼                ▼               ▼               ▼                ▼
┌─────────┐   ┌────────────┐  ┌─────────────┐  ┌──────────┐   ┌────────────┐
│ Stock   │   │  Vendas    │  │  Margens    │  │ Extrato  │   │ Devoluções │
│ por     │   │ VendaMensal│  │ preço·custo │  │ movimento│   │            │
│ farmácia│   │            │  │ ·IVA        │  │ 1:1 ERP  │   │            │
└────┬────┘   └─────┬──────┘  └─────────────┘  └──────────┘   └────────────┘
     │              │
     └──────┬───────┘
            ▼
   ┌──────────────────┐      ┌──────────────────┐      ┌────────────────────┐
   │ IndicadoresProdu-│─────▶│  Excessos e      │─────▶│  Encomendas        │
   │ toFarmacia (IPF) │      │  Oportunidades   │      │  motor de propostas│
   │ read-model       │      │                  │      │  TRANSF|COMPRAR|   │
   └──────────────────┘      └────────┬─────────┘      │  AGUARDAR|ADEQUADO │
                                      │                └──────────┬─────────┘
                                      ▼                           ▼
                             ┌──────────────────┐        ┌────────────────┐
                             │ Transferências   │        │ OrderOutbox    │
                             │ + substituição   │        │ → agente → ERP │
                             │   por DCI/marca  │        └────────────────┘
                             └──────────────────┘
                                      │
                             ┌────────▼─────────┐
                             │ Dashboard        │  consolida tudo
                             │ Relatórios       │  Report → HTML/PDF/Excel/email
                             └──────────────────┘
```

**O que este diagrama mostra e importa reter:** o catálogo está em cima e todos dependem dele — por
isso a sua qualidade limita o valor de tudo o resto; e o único caminho de volta ao ERP sai das
encomendas, através do outbox.

---

## 5. Fronteiras do sistema

| Fronteira | Atravessa | Nunca atravessa | Garantia |
|---|---|---|---|
| ERP ↔ agente | leitura de tabelas do ERP; escrita de encomendas | qualquer outra escrita | utilizador de BD dedicado; comandos explícitos |
| Agente ↔ plataforma | HTTPS com `Bearer ingestKey` + `X-Tenant-Slug` | ligação directa ao Postgres | bcrypt contra `ingestApiKeyHash`; cliente Prisma construído a partir do registo do tenant, **nunca** do header do middleware |
| Tenant ↔ tenant | **nada** | tudo | base física distinta por cliente |
| Catálogo → tenant | conhecimento de produto | dados operacionais | (alvo) releases imutáveis, unidireccional |
| Tenant → catálogo | (futuro) observações: CNPs novos | preço, stock, vendas, fornecedor | ainda por implementar |
| Servidor ↔ cliente (browser) | dados já filtrados por sessão e farmácia | Prisma, segredos, connection strings | `import "server-only"`; sessão validada por tenant |
| Plataforma → exterior | pedidos de enriquecimento (INFARMED, OFF/OBF), email SMTP | dados de clientes | saída apenas; sem webhooks de entrada |

**A fronteira tenant↔tenant é absoluta.** Não há agregação cross-cliente, nem anonimizada, nem para
métricas internas. O único conhecimento que atravessa é o catálogo, e só no sentido plataforma →
cliente.

---

## 6. Papel do catálogo

O catálogo é **transversal e de leitura**. Nenhum módulo operacional lhe escreve: quem escreve é o
pipeline de enriquecimento. Um artigo sem catálogo continua a vender, a contar para o stock e a
aparecer nos movimentos — só não pode ser analisado por categoria, substância ou fabricante.

Consequência a interiorizar: **a qualidade do catálogo é o tecto de valor de toda a plataforma.**
Com 30 % de cobertura de classificação, 70 % das análises por categoria são inconclusivas. Investir
no catálogo é investir em todos os módulos ao mesmo tempo — é a razão pela qual ele foi promovido a
subsistema com arquitectura própria.

---

## 7. Papel dos tenants

Um tenant é um **grupo de farmácias**, não uma farmácia. Dentro do tenant há N `Farmacia`, e é
precisamente a comparação entre elas que gera o valor (excedentes, transferências, consolidação).

- **Isolamento:** base de dados própria. Não é *schema*-per-tenant nem discriminador por coluna —
  uma query mal escrita não consegue ver outro cliente porque a ligação é a outra base.
- **Resolução:** subdomínio → `x-tenant-slug` → cliente Prisma do registo. Com fallback por
  `?__tenant=` + cookie enquanto não houver DNS wildcard.
- **Provisionamento:** script idempotente; cria base, aplica migrações, semeia, activa.
- **Ciclo de vida:** `PROVISIONING → ACTIVE → SUSPENDED → DEACTIVATED`.

**Incoerência conhecida, registada aqui porque é a mais perigosa do sistema:** quando o slug não
resolve, `getTenantPrismaOrLegacy()` **cai silenciosamente na base legacy** em vez de falhar. Foi
pensado para conveniência em desenvolvimento e é, em produção, um caminho para ler — ou escrever —
na base errada sem qualquer sinal. Ver [princípio P10](./04-architecture-principles.md).

---

## 8. Papel dos agentes

O agente é **a plataforma dentro da farmácia** e o componente com o pior ambiente de execução:
Windows não gerido, rede caseira, SQL Server de versão desconhecida, PC que hiberna.

Consequências no desenho, todas obrigatórias:

1. **Descoberta dinâmica de schema** — nunca assumir colunas.
2. **Idempotência ponta-a-ponta** — `ingestRunId` + UPSERT set-based; reenviar o mesmo lote não
   duplica nada.
3. **Degradação em vez de falha** — coluna ausente vira `NULL`; tabela ausente desactiva o pipeline
   dela e deixa os outros correr.
4. **Auto-ajuste** — lote de 500 → 100 → 25 conforme os erros.
5. **Versão visível** — `lastAgentVersion` e `lastAgentHeartbeatAt` no control plane. Sem isto não
   se sabe se o silêncio de um cliente é "está tudo bem" ou "está parado há dois meses".

Este último ponto tem prova prática: a 2026-08-04, os heartbeats mais recentes eram de 2026-05-20.

---

## 9. Dependências externas

| Dependência | Para quê | Se falhar | Substituível |
|---|---|---|---|
| PostgreSQL | tudo | plataforma parada | não (é a fundação) |
| SQL Server do cliente | origem dos dados | sem dados novos | não (é o ERP) |
| INFARMED / INFOMED | dados regulamentares | catálogo estagna | difícil (é a autoridade) |
| Open Food/Beauty Facts | enriquecimento retail | menos cobertura não-medicamento | sim |
| SMTP do cliente | envio de relatórios | relatórios só por download | sim |
| Object storage | distribuir base do agente | não se geram agentes novos | sim (ficheiro estático) |
| Chromium (Puppeteer) | PDF | sem PDF; Excel e HTML mantêm-se | sim |

Nenhuma dependência externa está no caminho crítico da operação diária. Todas as integrações são de
**saída**; não há webhooks de entrada além do agente.

---

## 10. Como deve evoluir

1. **Catálogo para fora do tenant** — Catalog Store + releases (aprovado, faseado).
2. **Enriquecimento executado uma vez** — hoje corre por tenant, N vezes o mesmo trabalho.
3. **Canal de observações tenant → catálogo** — CNPs novos vistos pelos agentes voltam ao Store.
4. **Read-models explícitos e vigiados** — o IPF é o primeiro; a frescura tem de ser visível na UI.
5. **Fronteira servidor/cliente auditável** — regra automática, não revisão manual.

## 11. O que nunca deve ser feito

1. **Ligar a plataforma directamente ao SQL Server de um cliente.** O agente existe para isso.
2. **Partilhar base entre clientes**, em qualquer forma.
3. **Escrever no staging a partir do domínio.** O fluxo é sempre bruto → canónico → read-model.
4. **Fazer o catálogo depender de um tenant** (é o erro que estamos a corrigir).
5. **Introduzir uma segunda porta de entrada de dados operacionais.** Uma porta, uma auth, um log.
6. **Cair em silêncio para outra base quando a resolução de tenant falha.**
