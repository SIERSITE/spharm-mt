# Auditoria e entrega — pesquisa de produtos, impressão de Vendas e designação da Silveirense

Base: `4b6396abc628f8f7571b901d5fec3da5cbd7aea7` (revisão em produção).
Branch: `feat/pesquisa-impressao-designacao-silveirense`. Sem PR, merge, deploy, VPS nem bases reais.

---

## 1. Causa raiz de cada problema

### 1.1 `parace ciclum` devolve zero resultados

Havia **dois** filtros em série, ambos a procurar a frase inteira como subcadeia contígua:

1. **Servidor** — `lib/reporting/pesquisa-produto.ts::construirCondicaoPesquisa` construía
   `unaccent_immutable(p.designacao) ILIKE unaccent_immutable('%parace ciclum%')`. A frase
   `parace ciclum` não existe contígua em `PARACETAMOL CICLUM` (entre `parace` e `ciclum` há
   `TAMOL `), logo zero linhas.
2. **Cliente** — `components/vendas/vendas-client.tsx` (4 sítios: `baseFiltered`,
   `reportByFarmacia`, `groupRows`, comparativo) refinava as linhas já carregadas com
   `normalizarOpcao(codigo + descricao).includes(normalizarOpcao(artigo))` — a mesma frase
   contígua. Corrigir só o servidor deixava o cliente a esconder tudo outra vez.

Pesquisas equivalentes com o mesmo defeito: Inventário (`ILIKE %q%`), Stock (`ILIKE %q%` em 5
campos), picker de Encomendas (`contains: q`), Catálogo e fila de revisão (`contains: q`).
Margens e o picker da Manutenção de vendas já usavam a função partilhada (corrigidos de graça).

### 1.2 Impressão/PDF do Relatório de Vendas sem hierarquia

"Imprimir" (`report-print.ts`, iframe) e "PDF" (`report-pdf-server.ts`, Puppeteer) chamam ambos
`renderReportHtml` — **o mesmo HTML/CSS** (provado em `test-vendas-impressao-hierarquia.ts`).
No CSS compacto (`report-html.ts`), blocos alternados `#f8fafc`/transparente, subtotal `#e9eef4`
com bordas `#b7c4d4` de 1px e cabeçalho `#eef2f7`: diferenças de 2–6 % de luminosidade. Em
cinzentos/preto e branco colapsam; nada na hierarquia dependia de borda, peso ou espaçamento.

### 1.3 A Segurado reverte a designação

Único escritor de `Produto.designacao` na ingestão: `bulkUpsertProdutosByCnp` (e o caminho de
recurso por linha), chamado só por `POST /api/ingest/v1/bootstrap/products`. O
`ON CONFLICT … SET designacao = COALESCE(NULLIF(btrim(EXCLUDED.designacao),''), actual)`
(+ protecção `camposManuais`) escreve a designação **da última farmácia a sincronizar**, sem
qualquer noção de origem. Com duas farmácias a enviar o mesmo CNP, o resultado depende da ordem
de execução. Segunda causa: o «Sincronizar agora» (`sync-now.ts`) e o passo 1 do diário só leem
produtos com actividade **no dia** (`buildProductsSql(scope:"date")`), por isso a designação da
Silveirense de um produto parado nunca era comparada nesses caminhos; só o refresh operacional
nocturno (catálogo activo inteiro) chegava lá, e só para activos.

Auditoria dos restantes escritores de `Produto.designacao` (varredura de `app/ lib/ components/`):
`lib/importer.ts` (Excel, só `createMany skipDuplicates`), `app/produtos/criar` e
`lib/produtos/criar-produto.ts` (criação manual) — todos só criam. Enriquecimentos e jobs
(`catalog-enrichment`, `catalog-persistence`, `catalog-from-erp`, `enrich-catalog`,
`regulatory-acquisition`, `retail-enrichment`) só **leem** a designação. A manutenção em massa
só escreve `fabricanteId`/`fornecedorHabitualId`. Não existe segundo caminho que reponha a
designação da Segurado.

---

## 2. Ficheiros alterados

**Pesquisa:** `lib/reporting/pesquisa-termos.ts` (novo, regra pura), `pesquisa-produto.ts`,
`components/vendas/vendas-client.tsx`, `lib/inventario-data.ts`, `lib/stock-data.ts`,
`app/encomendas/nova/search.ts`, `lib/catalogo-data.ts`, `lib/admin/catalog-review-data.ts`.

**Impressão:** `lib/reporting/report-html.ts`, `report-types.ts` (`meta.hierarchy`),
`adapters/vendas.ts` (activa-o). Excel intocado.

**Designação:** `lib/ingest/designacao-silveira.ts` (novo), `designacao-silveira-admin.ts` (novo),
`bulk.ts`, `lib/tenant-constants.ts`, `app/api/ingest/v1/bootstrap/products/route.ts`,
`…/products/designacoes/route.ts` (novo), `lib/sync-request/estado.ts`, `lib/pipeline/types.ts`,
`components/stock/sync-now-widget.tsx`, agent (`daily-sync-runner.ts`, `sync-now.ts`,
`daily-pipeline.ts`, `http-client.ts`).

**Ferramentas:** `scripts/diagnostics/designacao-silveira-diagnostico.ts`,
`scripts/admin/definir-codigo-farmacia-designacao.ts`, geradores/rasterizador de validação visual.

**Testes:** ver §8. **Sem migration.**

---

## 3. Decisões de arquitectura

* **Uma regra de pesquisa, uma só fonte** (`pesquisa-termos.ts`, client-safe): o predicado SQL, o
  espelho client-side e os `where` do Prisma partem dela. Onde só há `where` do Prisma (sem
  `unaccent`) os termos **mantêm os acentos** — tirá-los faria «Avène» deixar de ser
  encontrado por «avène».
* **Hierarquia de impressão é opt-in** (`meta.hierarchy:"strong"`), só Vendas a pede; os outros
  relatórios compactos ficam byte-a-byte iguais.
* **Designação: a decisão é do servidor.** O agent nunca sabe quem é a Silveirense; pergunta
  (`GET …/products/designacoes`). Isto evita um segundo sítio de configuração e garante que um
  agent antigo, ou um reprocessamento, passa pela mesma regra no único ponto de escrita.
* **Sem migration:** a farmácia é identificada por `Farmacia.codigoANF` (coluna existente),
  comparada com `SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF`. Uma coluna nova do tipo
  «autoridade» seria exactamente o mecanismo `autoridadeCatalogo` abandonado.
* **Modo seguro:** configuração que não identifique **exactamente uma** farmácia activa
  (`NAO_CONFIGURADO`/`NAO_ENCONTRADA`/`AMBIGUA`/`INATIVA`) ⇒ ninguém altera designações
  existentes; criação de produtos novos continua; o erro vai na resposta e no log.
* **Passo leve** (`POST …/products/designacoes`): `sync-now` não pode reenviar o catálogo inteiro
  pelo endpoint de produtos (lotes de 50, com enriquecimento; excederia os 8 min locais). O
  passo leve envia só (cnp, designação), em lotes de 1000, e aplica a **mesma** regra em SQL
  set-based, escrevendo apenas onde o valor difere. Nunca cria produtos.

---

## 4. Regra exacta da pesquisa

1. `NFD`, remove marcas combinantes (`\p{M}`), minúsculas.
2. Tudo o que não é letra/dígito (`[^\p{L}\p{N}]+`: pontuação, barras, hífens, NBSP, tabs,
   espaços múltiplos) separa termos; termos repetidos colapsam.
3. Cada termo é **obrigatório** (`AND`) e procura-se **separadamente** como subcadeia da
   designação (`unaccent_immutable(designacao) ILIKE unaccent_immutable('%termo%')`, índice GIN
   trigram existente) — logo «parace» casa «PARACETAMOL».
4. Termo só de dígitos: também casa `cnp::text LIKE '%termo%'` (CNP exacto ou parcial) — se for o
   **único** termo (qualquer comprimento) ou, com vários termos, se tiver **4+ dígitos**
   (`8500 ciclum`). Um número curto junto de palavras (`omega 3`, `ciclum 650`) é só designação:
   o `3` está no CNP de metade do catálogo e transformaria cada pedido numa lista de ruído.
5. A ordem dos termos é irrelevante; texto sem termos ⇒ sem condição.
6. Os restantes filtros combinam por `AND` (a condição entra na mesma cláusula).

Consequência assumida: «F-» é o termo «f» (a pontuação separa). O teste de reversão da
manutenção em massa, que usava «F-» como prefixo literal, passou a usar um termo único.

---

## 5. Prova visual (impressão/PDF)

`docs/validacao-visual/2026-10-vendas-impressao/` — gerado com o adapter real
(`buildVendasReport` → `renderReportHtml` → Puppeteer): 2 farmácias, 36 artigos, 100 linhas, 4
páginas A4 horizontal, linhas com vendas / sem vendas / stock / artigo numa só farmácia.

| ficheiro | conteúdo |
|---|---|
| `antes-vendas.pdf` / `depois-vendas.pdf` | PDFs reais |
| `{antes,depois}-p1-cor.png` | página 1 a cores (PDF rasterizado, PyMuPDF) |
| `{antes,depois}-p1-cinza.png` | escala de cinzentos |
| `{antes,depois}-p1-pb.png` | preto e branco puro (limiar 160 — pior caso) |
| `comparativo-cinza.png`, `comparativo-pb.png` | antes (cima) / depois (baixo), pág. 2 |
| `{antes,depois}-preview-print.png` | pré-visualização `@media print` no Chromium |

Mudanças: cabeçalho escuro (`#1f2937`, branco, bold); borda de 2 px no início de cada artigo;
blocos alternados branco ↔ `#e5e7eb`; farmácias subordinadas (peso normal, separador ponteado);
`TOTAL ARTIGO` em bold, fundo `#b9c4d0`, bordas de 2 px; `break-before: avoid` no subtotal e
`break-inside: avoid` por artigo (já existia); cabeçalho repete (`table-header-group`).

---

## 6. A autoridade da designação — descrição exacta

* **Âmbito:** tenant `silveira` (`TENANT_DESIGNACAO_AUTORITATIVA`), campo `Produto.designacao`.
  Nada mais (fabricante, fornecedor, fornecedor habitual, preços, stock, vendas, classificações).
  Outros tenants: modo `LEGACY`, SQL e comportamento inalterados (testado em `garantia` e `sier`).
* **Silveirense** (modo `AUTORITATIVA`): designação recebida não vazia, normalizada
  (`trim` + espaços/NBSP/tabs/quebras → 1 espaço; capitalização e pontuação intactas) e diferente
  da actual ⇒ substitui. Em **cada** sincronização, sem depender de «alterado no ERP».
* **Outra farmácia** (modo `SO_CRIACAO`): só escreve a designação ao **criar** o produto;
  num produto existente nunca a altera.
* Vazia/só espaços: nunca substitui, em nenhum modo.
* **Ficha manual** (`camposManuais ∋ "designacao"`): continua protegida, mesmo da Silveirense —
  é a protecção que já existia; fica visível em `ignoradasManual`. *Decisão a confirmar: se a
  Silveirense deve também sobrepor fichas manuais, é uma linha em `decidirDesignacao` + o `CASE`
  do SQL.*
* **Identificação:** `Farmacia.codigoANF` (sem espaços exteriores, sem maiúsculas) =
  `SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF`. Nunca o nome, nunca um id, nunca «a primeira».
* **Ordem/concorrência:** o `ON CONFLICT` da Segurado devolve a designação existente; o da
  Silveirense substitui. Seja qual for a ordem (25 rondas concorrentes testadas), fica a da
  Silveirense.
* **Idempotência:** segunda passagem ⇒ `alteradas=0`, `jaIguais=N`; no passo leve o `UPDATE`
  só toca linhas onde `designacao IS DISTINCT FROM` o novo valor (`xmin` inalterado nas iguais).
* **Observabilidade** (bloco `designacoes` na resposta, só quando a regra se aplica; logs só com
  contagens): `criadas`, `verificadas`, `alteradas`, `jaIguais`, `ignoradasOrigemNaoAutoritativa`,
  `ignoradasVazias`, `ignoradasManual`, `erros`, `erroConfiguracao`. O botão mostra
  «Designações alteradas: N» apenas quando o contador existe.

### Configuração operacional (obrigatória antes de activar)

1. Diagnóstico read-only: `npm run diag:designacao-silveira -- --tenant=silveira`.
   Mostra farmácias (id, nome, codigoANF, estado), o valor da variável **no ambiente do
   processo**, e qual resolve — ou porque falha, com o que fazer.
2. Se a Silveirense **já tem** `codigoANF`: usar esse valor no passo 4.
3. Se **não tem**: `npm run admin:definir-codigo-farmacia-designacao -- --tenant=silveira
   --farmacia-id=<id> --codigo=<ANF>` (dry-run) e repetir com `--apply`. Idempotente; recusa
   código já usado por outra farmácia ou substituir um código existente sem `--forcar`.
4. Definir no ambiente da app `SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF=<código>` e reiniciar.
5. Repetir o passo 1 (no mesmo ambiente da app): tem de dizer **VÁLIDA**.

> **Sem os passos 3–4 o tenant fica em modo seguro: nenhuma farmácia altera designações
> existentes (nem a Silveirense).** Isto é uma mudança face a hoje («a última escreve»).

---

## 7. Diário vs «Atualizar agora»

| | Diário (`daily-pipeline`) | «Atualizar agora» (`sync-now`) |
|---|---|---|
| produtos do dia (`scope:"date"`) → endpoint de produtos (regra) | sim | sim |
| refresh operacional (catálogo activo inteiro → endpoint de produtos) | sim | **não** (sem alteração) |
| passo de designações (catálogo **inteiro**, activos e retirados, só cnp+nome) | sim (passo `designacoes`; falha ⇒ `PARTIAL`) | sim (falha ⇒ pedido `FALHOU`) |
| resultado | log do pipeline | `designacoesAlteradas`/`Verificadas` no ack → botão + `PipelineRun.details` |

Em ambos: o passo só corre se `GET …/designacoes` disser `autoritativa:true`; fora disso é um
único GET. A regra é a mesma (servidor).

---

## 8. Testes

Comandos e resultados completos: ver a mensagem de entrega (e `npm run test:*` abaixo).

* Pesquisa: `test:pesquisa-termos` (puro), `test:pesquisa-termos-db`, `test:pesquisa-produto`,
  `test:pesquisa-produto-live`, `test:e2e-pesquisa-vendas` (browser).
* Impressão: `test:vendas-impressao-hierarquia` + imagens.
* Designação: `test:designacao-silveira` (puro/estático, inclui item 15),
  `test:designacao-silveira-db` (itens 1–14 + configuração + ferramentas),
  `test:e2e-atualizar-agora-designacao` (botão real).

## 9. Limitações restantes

* **Agent:** o passo de designações do catálogo inteiro e o contador exigem uma nova revisão do
  agent (não publicada nem versionada aqui). Sem ela, o servidor já impede a reversão pela
  Segurado e aplica a regra aos produtos que o agent antigo envia (do dia + refresh nocturno),
  mas «Atualizar agora» não compara o catálogo inteiro nem mostra o contador.
* A leitura no ERP do passo leve não foi exercida contra um SQL Server real (o ERP é a única
  peça simulada nos ensaios).
* Produtos **retirados** só são observados pelo passo leve (agent novo); o endpoint de
  produtos não os recebe no refresh.
* Fichas manuais mantêm a designação (decisão acima).
* `pdf-parse` (dependência declarada) não está no `node_modules` do repositório principal desta
  máquina; 5 ficheiros de teste antigos que o importam não compilam em `tsc` e os testes que o
  usam falham aí com `ERR_MODULE_NOT_FOUND` (pré-existente, igual na revisão de produção). Na
  worktree desta entrega foi instalado à parte (`--no-save`) só para poder fazer `next build`.
* Os testes `test-ordenacao-tabelas`, `test-sync-on-demand`, `test-pipeline…`, etc. que já
  falhavam na revisão de produção continuam a falhar exactamente nos mesmos pontos (ver §8).
