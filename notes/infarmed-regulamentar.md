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

Migrations desta fase (aditivas): `20261014110000_infarmed_importacao_upload` (tenants: `InfarmedImportacao.bytes` e `.utilizadorEmail`) e, no control plane,
`20261014100000_infarmed_atualizacao` (`InfarmedExecucao` — ledger global das execuções — e `InfarmedAlerta` — um alerta por mês, com o estado da notificação).

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

## 7. Atualização mensal (dia 1, Europe/Lisbon)

### Download

O portal público «Pesquisa do medicamento» do INFARMED (o iframe), em
`https://extranet.infarmed.pt/CITS-pesquisamedicamento-fo/pesquisaMedicamento.jsf`, cria sozinho uma sessão HTTP **anónima**
(cookie `JSESSIONID`) e um `javax.faces.ViewState` no 1.º GET; o botão `form:export-all-button` é um `type="submit"` e o POST do formulário
devolve `allPackages.xls` (Excel 97-2003, ≈ 4,6 MB, 20 915 linhas — as mesmas contagens do ficheiro de referência).
`lib/regulamentar/infarmed-jsf.ts` faz exatamente isso, em HTTP simples:

1. `GET` da página → recolhe cookies e **todos** os campos do formulário (incluindo o ViewState) e o botão;
2. `POST` do formulário com o botão, na mesma sessão;
3. valida o resultado (não vazio, não HTML, assinatura OLE2, ≤ 60 MB) e depois `lerFicheiroInfarmed` (folha, 13 colunas, `Preço (PVP)`, limites).

Sem browser, sem credenciais, sem valores de sessão fixos. O portal responde por vezes `503`: tentam-se até 5 vezes com espera crescente **só**
perante 5xx/rede; se a estrutura da página mudar (formulário/botão/ViewState em falta) ou a resposta não for Excel, falha logo, sem contornar.
`INFARMED_ALLPACKAGES_URL` (opcional) substitui o portal por um GET direto a esse URL https; `INFARMED_PESQUISA_URL` (opcional) muda a página do formulário.

Verificado uma vez contra o portal real (13/10/2026): `200 application/vnd.ms-excel`, `allPackages.xls`, 20 915 linhas / 20 896 CNP /
19 rejeitadas / 3 325 «preço livre». Os ensaios automáticos usam um portal simulado (sem rede).

### Agendamento e idempotência

O scheduler tem `timezone` por job: `infarmed-regulamentar` corre **dia 1 às 03:30 Europe/Lisbon** (03:30Z no inverno, 02:30Z no verão), uma
vez por mês. O ficheiro é descarregado **uma só vez** e aplicado a cada tenant ATIVO (lista vinda do control plane a cada execução, nunca fixa);
cada tenant mantém as suas associações, contagens e histórico, isolados. A mesma versão (SHA-256) não se repete (`JA_PROCESSADA`). Uma falha num
tenant não afeta os outros e fica disponível para repetição.

### Se falhar (download, validação ou algum tenant)

* a versão ativa de cada tenant fica **intacta** (aplicação atómica; nada parcial); a falha fica no histórico do tenant (`FALHADA`) e no ledger global;
* a execução fica `FALHADA`/`PARCIAL` — o mês **não** fica marcado como concluído — e abre-se um **alerta** (um por mês) no control plane;
* é enviado **um** email (assunto «[SPharm.MT] Atualização mensal do INFARMED não foi possível (AAAA-MM)»; corpo: motivo resumido, tenants com falha,
  garantia de que a versão ativa foi mantida e a ligação para `/admin/infarmed`);
* **sem duplicados:** repetir a mesma falha só incrementa as tentativas; um novo email exige um motivo diferente (ex.: de «download» para «ficheiro
  inválido»), ou um alerta reaberto depois de resolvido, ou o reenvio quando a notificação anterior não chegou a sair (uma tentativa por execução,
  nunca em ciclo);
* se o email falhar (`FALHOU`) ou não houver destinatário/SMTP (`NAO_CONFIGURADA`), a falha original continua registada, o erro do envio fica à
  parte (`notificacaoErro`) e os dados não são tocados;
* o alerta fica **resolvido** (com quem e quando) quando uma execução bem-sucedida cobre todos os tenants (automática ou upload manual); uma
  repetição parcial só resolve os alertas cujos tenants falhados ficaram todos atualizados.

### Email: reutilização, não um segundo motor

Usa o `EmailConfig` (SMTP global ativo) e o nodemailer de `lib/email-config.ts` (`resolveEmailConfig` passou a aceitar um cliente explícito, para
uso fora de pedidos web). Destinatários: `INFARMED_IMPORT_ALERT_EMAIL` (lista separada por vírgulas) — se não existir, os administradores da
plataforma (`PLATFORM_ADMIN_EMAILS`, a configuração de alertas operacionais já existente). SMTP: o primeiro tenant ativo com configuração global
ativa (ou `INFARMED_ALERT_SMTP_TENANT`). Nenhum endereço fixo no código.

## 8. Página administrativa `/admin/infarmed`

* Acesso **exclusivo a platform admins** (`isPlatformAdminSession`: ADMINISTRADOR, fora de tenant, email em `PLATFORM_ADMIN_EMAILS`). O layout de
  `/admin` valida a sessão no servidor e **cada ação** volta a validá-la — esconder o link não é autorização. Menu «INFARMED» na consola de
  administração, com um ponto discreto quando há um alerta por resolver (só aparece aqui, nunca aos utilizadores comuns).
* Mostra: alerta pendente (motivo, tentativas, estado da notificação), versão ativa por tenant (data, origem, SHA-256, produtos associados), último
  download automático, último erro, histórico recente e a última tentativa de cada tenant.
* **Upload manual em dois passos:** (1) *Validar* — o mesmo contrato do automático (extensão **e** assinatura OLE2, ≤ 12 MB, folha, 13 cabeçalhos,
  `Preço (PVP)`, CNP, CNPEM, preços, linhas inválidas, duplicados, conflitos, ficheiro já processado); mostra o resumo e o resultado esperado
  **por tenant**, sem escrever nada. (2) *Aplicar* — só depois de escrever «APLICAR»; o servidor volta a ler o ficheiro, confere o SHA-256 validado e
  aplica pelo **mesmo** `aplicarVersaoInfarmed`, com origem `UPLOAD_MANUAL`, utilizador, nome, tamanho e SHA-256 guardados no histórico de cada tenant.
* **O ficheiro nunca toca no disco** (nem área temporária): é validado e aplicado a partir da memória, pelo que não há caminhos, nada para limpar e
  nada que outro utilizador possa ler; o nome é só um rótulo sanitizado. Por isso o browser reenvia o ficheiro no passo 2 (não fica nada guardado
  entre os passos).
* *Repetir* um tenant falhado: «Repetir nos tenants falhados» (novo download, um só, só para esses tenants) ou repetir o upload só nesses tenants.
  «Descarregar agora» corre a atualização completa.
* `next.config.ts`: `serverActions.bodySizeLimit = 16mb` (o limite por omissão, 1 MB, não chega para o ficheiro).

## 9. Instruções

Convenção na VPS (como em `notes/instalacao-designacao-silveira.md`): `DC` = `sudo docker compose -p spharmmt --profile tools --env-file
/opt/spharmmt/docker/env/platform.env --env-file /opt/spharmmt/docker/env/stack.env`, a partir de `/opt/spharmmt/docker/compose`.

**9.1 Migrations — em TODOS os tenants e no control plane** (aditivas; os dados do INFARMED são nacionais, não da Silveira):

```bash
$DC build migrate
$DC run --rm migrate npm run tenancy:migrate-all -- --dry-run     # confirma o que falta, em todos os tenants
$DC run --rm migrate npm run tenancy:migrate-all                  # aplica a TODOS os tenants ativos (sem --only)
$DC run --rm migrate npm run control:migrate:deploy               # control plane: InfarmedExecucao / InfarmedAlerta
```

**9.2 Configurar** (opcional; em `platform.env`, preservado pelo `install-platform.sh`; depois recriar `web`/`worker`):

```bash
sudo SCHEDULER_ENABLED=1 INFARMED_IMPORT_ALERT_EMAIL=alguem@exemplo.pt ./install-platform.sh   # destinatário(s) do alerta
# opcional: INFARMED_ALLPACKAGES_URL=https://… (substitui o portal) · INFARMED_PESQUISA_URL · INFARMED_ALERT_SMTP_TENANT=<slug>
```

Pré-requisito do email: uma configuração SMTP global ativa num tenant (Configurações → Email) — sem ela o alerta fica visível na página com a
notificação `NAO_CONFIGURADA`.

**9.3 Descarregar manualmente (um só download):** `node scripts/workers/scheduler.mjs --once infarmed-regulamentar` (no contentor do worker) ou,
na página, «Descarregar agora». Simulação sem escrever: `GET /api/jobs/infarmed-regulamentar?dryRun=1` (Bearer `CRON_SECRET`); `?onlySlugs=a,b`
repete só esses tenants; `?forcar=1` reaplica uma versão já processada.

**9.4 Carga manual**
* Pela página: abrir `/admin/infarmed` (consola de administração, ex.: `https://app.spharmmt.com/admin/infarmed`) → escolher o `allPackages.xls` →
  **Validar** → conferir o resumo por tenant → escrever **APLICAR** → **Aplicar**. Validar o resultado: o alerta desaparece e cada tenant mostra a
  versão ativa com origem «Upload manual».
* Pela CLI (um tenant): `$DC run --rm -v /caminho/allPackages.xls:/dados/allPackages.xls:ro -v /opt/spharmmt/relatorios/infarmed:/relatorios migrate
  npm run ops:infarmed-carga -- --tenant=<slug> --file=/dados/allPackages.xls` (dry-run) e o mesmo com `--apply`; `--listar` mostra o histórico.

**9.5 Repetir um tenant falhado:** na página, «Repetir nos tenants falhados» no alerta; ou `GET /api/jobs/infarmed-regulamentar?onlySlugs=<slug>`.

**9.6 Rollback** (um tenant, volta à versão anterior sem tocar em mais nada; os dados da revertida ficam): `… ops:infarmed-carga --
--tenant=<slug> --reverter` (dry-run) e `--reverter --apply`. Reverter a primeira versão deixa o tenant sem versão ativa. A versão revertida não
é reaplicada pelo job (só com `?forcar=1`).

## 10. Limitações

* O download depende da estrutura do formulário público do INFARMED. Se mudar, a atualização falha de forma segura (sem contornar), avisa por
  email e o ficheiro carrega-se à mão. Nesta fase não há deteção proativa de alterações ao portal.
* Se o scheduler estiver parado no dia 1, o mês falha-se (não há retoma automática): correr à mão (9.3).
* O email depende de haver um destinatário e um SMTP global ativo; sem eles o alerta fica só na página (e no log).
* O ficheiro carregado na página vive só em memória e é reenviado no passo «Aplicar»; o limite é 12 MB.
* `xlsx` 0.18.5 (SheetJS) lê o ficheiro; defesas: assinatura OLE2, limites de tamanho (60 MB / 100 000 linhas no automático; 12 MB no upload) e
  origem configurada por quem opera.
* Um produto criado depois da importação só ganha dados regulamentares na execução seguinte (ou numa aplicação manual: a mesma versão
  **completa** os novos).
* O ficheiro não inclui produtos fora do circuito do medicamento (parafarmácia): ficam «sem dados regulamentares».

## 11. Reconciliação com o catálogo, ordem alfabética, custo total e seleção (Tarefa C)

### 11.1 Reconciliação INFARMED → `Produto`
Motor único `lib/regulamentar/infarmed-reconciliar.ts`, usado pelo download mensal,
pelo upload manual `/admin/infarmed` e pelo comando sobre a versão ativa.

| INFARMED | `Produto` |
| --- | --- |
| Forma farmacêutica | `formaFarmaceutica` |
| Dosagem | `dosagem` |
| Tamanho da embalagem | `embalagem` |
| Substância Ativa/DCI | `dci` |

- Associação só por `Nº registo = Produto.cnp`; só linhas `presenteNoFicheiro`.
- Valor INFARMED vazio: nunca apaga (contado «ignorado por vazio»).
- Campo em `camposManuais`: nunca substituído (contado «ignorado por manual»).
- Campo vazio no catálogo: preenchido; preenchido e diferente (não manual): atualizado; igual: nada.
- Só escreve as 4 colunas e `dataAtualizacao`. `Produto.designacao` (incluindo a regra da Silveirense),
  preços, custos, stock, fabricante e fornecedor nunca são lidos nem escritos.
- Transacional, idempotente (2.ª execução = 0 alterações) e set-based (um UPDATE).
- Contadores por campo: analisados, associados, preenchidos, atualizados, ignorados por manual,
  ignorados por vazio, já iguais, sem correspondência.

Comando (sobre a versão ativa; não descarrega, não altera SHA/histórico):

```
# pré-visualização (nada é escrito)
$DC run --rm migrate npm run ops:infarmed-carga -- --reconciliar --tenant=<slugA>,<slugB>,<slugC>
# aplicação
$DC run --rm migrate npm run ops:infarmed-carga -- --reconciliar --apply --tenant=<slugA>,<slugB>,<slugC>
```
(`--todos` em vez de `--tenant=` percorre todos os tenants.) Relatório JSON `infarmed-reconciliacao-<ts>-<modo>.json`.

### 11.2 Comparação CNPEM (Margens)
Por defeito só entram artigos com vendas no período OU stock atual > 0 numa das farmácias selecionadas;
o produto analisado aparece sempre. A opção «Mostrar todos os artigos do mesmo CNPEM» (desligada por
omissão) mostra os restantes. A contagem reflete o apresentado e indica quantos estão ocultos.

### 11.3 Ordem alfabética por omissão
Designação sem maiúsculas/acentos → CNP → farmácia (`lib/ordenacao-artigos.ts`; SQL: `SQL_ORDEM_ARTIGOS`).
Ecrãs: Vendas, Margens (e expansão CNPEM), Inventário, proposta de encomenda (farmácia, grupo, consolidação),
detalhe de encomenda e de transferência (e documentos). Listagens históricas continuam cronológicas.
Uma ordenação escolhida num cabeçalho prevalece; «Limpar filtros» repõe a alfabética. O corte da proposta
(`MAX_LINHAS_PROPOSTA`, por vendas) não muda: só a ordem de apresentação.

### 11.4 Vendas: custo total estimado
`Custo total est.` = custo unitário estimado × quantidade líquida (mesma regra do loader). Subtotal por artigo,
total geral e resumo. Sem custo: «—», fora da soma; o resumo mostra o nº de linhas sem custo e o rodapé
assinala «Custo total PARCIAL». Vendas, IVA e margem não são alterados.

### 11.5 Vendas: seleção de artigos a imprimir
Checkbox por artigo (todos marcados por omissão), «selecionar todos» sobre todo o resultado filtrado,
indicador «N de M artigos selecionados para impressão». Afeta impressão, PDF e exportações do relatório
(totais recalculados); o ecrã não esconde linhas. Novo resultado ⇒ nova seleção; mudar filtros não alarga
a seleção; zero selecionados bloqueia a saída com mensagem. O estado guarda só códigos.

Testes: `npm run test:infarmed-reconciliacao-db`, `test:margens-cnpem-db`, `test:ordenacao-custo-selecao`.
Sem migrations novas nesta tarefa.
