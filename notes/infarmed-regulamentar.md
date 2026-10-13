# Dados regulamentares do INFARMED — catálogo, Margens e CNPEM

Branch `feat/margens-cnpe-cabecalhos-anuladas`, a partir de `aa94dcca` (produção).

## 1. O que é e o que NÃO é

Uma camada **separada** que guarda, por versão, o que o ficheiro público do INFARMED
(«allPackages», Excel 97-2003, folha `Medicamentos`, 13 colunas) diz de cada produto
**que já existe** na base do tenant. Alimenta:

* a secção «Informação regulamentar — INFARMED» da ficha do Catálogo;
* as colunas «Margem unitária», «Preço utente — regime geral» e «Preço utente — regime especial» de Margens;
* a comparação por **CNPEM** (expansão de uma linha de Margens).

Não faz GH, não agrupa por DCI/designação/semelhança, não cria produtos e **nunca escreve** em
`Produto`, `ProdutoFarmacia`, vendas, stocks, encomendas, custos ou preços praticados.
`Produto.designacao` (e a regra da designação autoritativa da Silveirense) não é lida nem tocada.

## 2. Modelo (migration `20261013100000_infarmed_regulamentar`, aditiva)

| Tabela | Papel |
|---|---|
| `InfarmedImportacao` | uma linha por tentativa (`CARGA_INICIAL`/`MENSAL`/`MANUAL`): sha256, URL, contagens, `estado` (`EM_CURSO`/`APLICADA`/`REVERTIDA`/`FALHADA`), `ativa`, `versaoAnteriorId`, erro, relatório JSON |
| `ProdutoRegulamentar` | os dados **por versão** e por produto (`@@unique(importacaoId, produtoId)`); `presenteNoFicheiro=false` quando o CNP deixou de constar |

* Índice único **parcial** `InfarmedImportacao_uma_ativa_idx (…) WHERE ativa`: no máximo uma versão ativa (trava de base de dados).
* Porquê duas tabelas e não campos novos em `Produto`: os campos de `Produto` (`dci`, `formaFarmaceutica`, `dosagem`, `embalagem`, `flagGenerico`) são a ficha curada, com proteção de campos manuais e regras de proveniência. Gravar lá os valores do INFARMED reinterpretaria dados existentes; aqui ficam como **cópia fiel, versionada e com proveniência**, e o rollback é só trocar a versão ativa (sem reescrever dados nem restaurar a base).
* `RegulatoryRecord` (v2, 283 mil linhas do CEDIME/ANF) não foi reutilizado: é «o último import vence», sem versões, e o seu conteúdo é outra fonte.

### Mapeamento das 13 colunas (pelo NOME do cabeçalho, não pela posição)

| Coluna do ficheiro | Campo | Notas |
|---|---|---|
| Nº registo | `Produto.cnp` (ligação) / `ProdutoRegulamentar.cnp` | texto → inteiro; zeros à esquerda ⇒ linha **rejeitada** (identidade não representável) |
| Substância Ativa/DCI | `substanciaAtiva` | |
| Nome do medicamento | `nomeMedicamento` | **não** substitui `Produto.designacao` |
| Forma farmacêutica | `formaFarmaceutica` | |
| Dosagem | `dosagem` | |
| Tamanho da embalagem | `tamanhoEmbalagem` | |
| CNPEM | `cnpem` (texto) | identificador, nunca número |
| Preço (PVP) | `pvp` + `precoLivre` | número → `pvp`; «preço livre» → `precoLivre=true`, `pvp` NULL; vazio → ambos vazios |
| PVP Notificado | `pvpNotificado` | |
| Preço Utente | `precoUtenteGeral` | regime geral |
| Preço Pensionistas | `precoUtenteEspecial` | regime especial |
| Comerc. | `estadoComercializacao` | |
| Genérico | `generico` | Sim/Não |

**Preços:** «preço livre» nunca é 0; célula vazia nunca é 0. Um **zero genuíno** do ficheiro (preço
utente 0 € — medicamento totalmente comparticipado; há 216 no regime geral e 1 005 no especial) é
preservado como 0, distinto de NULL.

### Ficheiro entregue (`allPackages-original.xls`, sha256 `058c7010…ea07`)

20 915 linhas de dados · 20 896 CNP válidos e distintos · **19 rejeitadas** (`Nº registo` vazio) ·
0 duplicados · 0 conflitos · 3 325 «preço livre» · 17 238 PVP numérico · CNPEM vazio em 128 das 20 915 linhas.

## 3. Correspondência e idempotência

* Ligação **exclusivamente** `Nº registo` = `Produto.cnp` (igualdade). Nunca por designação, DCI, laboratório ou CNPEM.
* Duplicado idêntico: conta-se e mantém-se 1. Duplicado com conteúdo diferente = **conflito**: o CNP é excluído por inteiro.
* A mesma versão (sha256) não se repete. Se já foi aplicada **e depois revertida**, não é reaplicada pelo job (só com `--forcar`).
* Mesma versão que a ativa ⇒ só **completa** os produtos entretanto criados na base (sem nova versão).
* Aplicação numa **transação**, com `pg_advisory_xact_lock` por base: duas execuções concorrentes ⇒ uma aplica, a outra sai `JA_PROCESSADA`. Qualquer falha antes do fim não deixa nada (a versão anterior continua ativa); fica uma linha `FALHADA` no histórico.
* Um CNP que deixa de constar do ficheiro **não se apaga**: a nova versão copia os dados da anterior com `presenteNoFicheiro=false` (a ficha mostra o aviso).
* O relatório compara contagens e *checksums* de `Produto`/`ProdutoFarmacia` antes e depois (`operacionalIntacto`).

## 4. Margens

* **Margem unitária** = margem total ÷ `qtdVendida` (a quantidade que o próprio mapa usa, já com devoluções/anulações assinadas — `SUM(VendaMensal.quantidade)`), calculada a partir de valores **sem arredondar** (`valorBruto/(1+IVA) − qtd × custo unitário`). `null` («—») quando não há margem calculável (IVA ou custo desconhecidos) **ou a quantidade líquida é ≤ 0** (zero ou negativa). Nunca se soma nos totais. Não existe uma 2.ª fórmula de margem em `lib/margens-data.ts`.
* Os preços do utente vêm da versão ativa e **não entram** em nenhum cálculo de margem.
* **Comparação por CNPEM** (`getMargensData(filters, { comparacaoCnpem })`): o CNPEM é resolvido **no servidor** a partir do CNP. O universo é `ProdutoFarmacia` (a relação canónica «este produto existe nesta farmácia») ⨝ CNPEM da versão ativa ⨝ farmácias selecionadas. Só o período, as farmácias e os dois interruptores de naturezas se mantêm; **os filtros de seleção de produtos (pesquisa, categoria, fabricante, lista de CNP…) ficam de fora** — se escondessem os restantes artigos do CNPEM a comparação perdia o sentido. Um artigo sem vendas no período aparece (qtd 0, margens `null`). Um CNP que só existe no ficheiro nunca aparece. Retirados aparecem com a etiqueta «Retirado».
* O relatório (PDF/Excel) ganhou as 3 colunas; o PDF de Margens usa a mesma hierarquia forte que Vendas (`meta.hierarchy:"strong"`).

## 5. Cabeçalhos fixos e linhas

Classe `.tabela-fixa` em `app/globals.css`: o contentor faz scroll (vertical e horizontal) e o `thead th` é `sticky top:0; z-index:30` com fundo opaco e linha inferior grossa. Um `overflow-x:auto` sozinho tornaria o `sticky` inútil (resolve-se contra o antepassado com scroll), por isso o contentor tem `max-height: calc(100dvh − 5.5rem)`.

Tabelas tratadas: Margens «Detalhe por produto» e «Totais por…»; Encomendas — proposta de encomenda (modos Farmácia, Grupo e consolidação — a mesma tabela), detalhe da encomenda, listagem de encomendas. `components/encomendas/encomendas-client.tsx` **não está montado em nenhuma rota** (código morto) e não foi alterado. As tabelas pequenas (condições do fornecedor, histórico de 12 meses, linhas de transferência) não fazem scroll e ficaram de fora.

Linhas: zebra, separador horizontal, *hover*, seleção (`data-selecionada`, com barra à esquerda), produto/subordinadas (`data-tabela-linha="grupo|subordinada"`), subtotal/total — por películas `background-image` que não pisam estados coloridos nem as colunas fixas. Não depende só da cor: cabeçalho com linha grossa, seleção com barra e *checkbox*, totais a negrito com linha dupla/forte.

**Achado (anterior a este trabalho):** a barra superior da aplicação tem `sticky top-0` mas **não fica colada ao topo**, porque o contorno da shell (`components/layout/app-shell.tsx`) tem `overflow-hidden`, que a torna o contentor de sticky. Não foi alterado (fora do âmbito, afeta todas as páginas). O contentor da tabela isola o seu `z-index` (`isolation:isolate`) e a reserva (`--tabela-fixa-reserva`, 5,5 rem) já contempla uma barra de 4 rem, pelo que o cabeçalho da tabela continua correto se a barra passar a colar.

**Impressão do mapa de Margens:** o cabeçalho repete-se em todas as páginas (`thead{display:table-header-group}`), cada artigo tem borda superior forte, blocos alternados em tons distintos, TOTAL ARTIGO escuro (`tr.subtotal-row{break-before:avoid}`).

## 6. Encomendas anuladas

`?anuladas=1`. Regra única `condicaoEstadoLista` (usada pelo `findMany` **e** pelo `count`): sem estado ⇒ tudo menos `ELIMINADA` e, salvo pedido, menos `ANULADA`; com estado explícito ⇒ exatamente esse estado (o filtro fica desativado, sem regras contraditórias; «Anulada» passou a ser um estado válido na URL — antes a opção existia no ecrã mas o servidor ignorava-a). Contagens, paginação e totais são calculados na base de dados. A listagem não tem filtro por fornecedor.

## 7. O ponto de download do INFARMED (evidência)

Capturado em browser real (Chromium) em `https://extranet.infarmed.pt/INFOMED-fo/pesquisa-avancada.xhtml`:

* A «seta» é `mainForm:dt-medicamentos:btnExpExcel` (`<a>` PrimeFaces, `title` «Exportar para Excel»): faz **`POST pesquisa-avancada.xhtml;jsessionid=…`** com o formulário inteiro (`mainForm=…`, critérios, `javax.faces.ViewState`, `mainForm:dt-medicamentos:btnExpExcel=…`).
* Precisa de **sessão** (`JSESSIONID`) e de **`ViewState`** obtidos num GET anterior, e de uma **pesquisa feita antes** (o export serve o resultado da pesquisa). Os critérios por omissão trazem `estado-aim=REF_EST_AIM:001` e `estado-comercializacao=REF_EST_COMERC:001`, que dão **9 648** registos — não os 20 915 do ficheiro entregue (que inclui «Não comercializado»).
* Repetindo o fluxo por HTTP (GET → pesquisa → export, sem browser) a resposta foi `200` com `lista_infomed.xlsx` (`Content-Type: …spreadsheetml.sheet`, `.xlsx`), **não** o `allPackages-original.xls` (Excel 97-2003, folha `Medicamentos`, 13 colunas) entregue; a mesma ação no browser, depois de uma pesquisa real, devolveu `503` (53 bytes). Não foi possível, por este caminho, obter o ficheiro `allPackages`.

**Conclusão:** não há um endpoint estático e estável para o ficheiro `allPackages` .xls; o fluxo observado é um formulário JSF com estado, que seria *scraping* frágil. Por isso o URL **não está fixo no código**: o job lê `INFARMED_ALLPACKAGES_URL` (https). Sem URL, `GET /api/jobs/infarmed-regulamentar` responde `NAO_CONFIGURADO` e não toca em nada. A **carga manual segura** (secção 8) é o caminho garantido; quando o INFARMED (ou a ANF) disponibilizar um URL estável para o ficheiro, basta configurá-lo.

## 8. Instruções

Convenção na VPS (como em `notes/instalacao-designacao-silveira.md`): `DC` = `sudo docker compose -p spharmmt --profile tools --env-file /opt/spharmmt/docker/env/platform.env --env-file /opt/spharmmt/docker/env/stack.env`, a partir de `/opt/spharmmt/docker/compose`.

**8.1 Migrations** (aditivas; nenhuma tabela existente é tocada). `deploy-app.sh` recusa-se a correr com migrations, por isso:

```bash
$DC build migrate                                                     # imagem de tools com o comando novo
$DC run --rm migrate npm run tenancy:migrate-all -- --dry-run         # confirma a migration pendente
$DC run --rm migrate npm run tenancy:migrate-all -- --only silveira   # aplica (e depois os outros tenants)
```

**8.2 Dry-run da carga inicial** (nada é escrito; grava o relatório JSON). O ficheiro e a pasta de relatórios montam-se no contentor:

```bash
mkdir -p /opt/spharmmt/relatorios/infarmed
$DC run --rm -v /caminho/allPackages-original.xls:/dados/allPackages.xls:ro -v /opt/spharmmt/relatorios/infarmed:/relatorios \
  migrate npm run ops:infarmed-carga -- --tenant=silveira --file=/dados/allPackages.xls
```

Conferir no resumo: `sha256` = `058c70101d71cecba99806be3882f117929821de210d429f34f327f535d2ea07`, 20 915 linhas, 19 rejeitadas, `CNP não encontrados` (a maioria — o ficheiro tem todo o mercado) e `operacional intacto`.

**8.3 Aplicar:** o mesmo comando com `--apply`. Uma 2.ª execução deve dar `JA_PROCESSADA`.

**8.4 Validar:** `… ops:infarmed-carga -- --tenant=silveira --listar` (uma versão `APLICADA` e `ATIVA`); abrir uma ficha no Catálogo (secção «Informação regulamentar — INFARMED»); em Margens, gerar e expandir uma linha com CNPEM.

**8.5 Job mensal:** definir `INFARMED_ALLPACKAGES_URL=https://…` em `platform.env` (o `install-platform.sh` preserva-o), recriar `web`/`worker`, e garantir `SCHEDULER_ENABLED=1` com o job `infarmed-regulamentar` em `SCHEDULER_JOBS` (ou vazio = todos). Dia 2, 03:30 UTC (03:30/04:30 em Lisboa; o scheduler só suporta UTC). Execução manual: `node scripts/workers/scheduler.mjs --once infarmed-regulamentar` ou `GET /api/jobs/infarmed-regulamentar?dryRun=1` (Bearer `CRON_SECRET`; `?forcar=1`, `?onlySlugs=a,b`). Se o scheduler estiver parado no dia 2, o mês é falhado — correr à mão.

**8.6 Rollback** (volta à versão anterior sem tocar em mais nada; os dados da revertida ficam):

```bash
… ops:infarmed-carga -- --tenant=silveira --reverter            # dry-run
… ops:infarmed-carga -- --tenant=silveira --reverter --apply
```

Reverter a primeira versão deixa o tenant sem versão ativa (a ficha e Margens deixam de mostrar dados regulamentares; nada mais muda).

## 9. Limitações

* O download automático depende de um URL que o INFARMED não publica de forma estável (secção 7).
* `xlsx` 0.18.5 (SheetJS) lê o ficheiro; defesas: assinatura OLE2, limite de 60 MB e 100 000 linhas, URL https configurado por quem opera. Não se aceitam ficheiros de origem arbitrária.
* Um produto criado depois da importação só ganha dados regulamentares na execução seguinte (a mesma versão **completa** os novos; o job mensal ou `--apply` manual).
* O ficheiro não inclui produtos fora do circuito do medicamento (parafarmácia): ficam «sem dados regulamentares».
