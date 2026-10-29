# Classificação ERP dos produtos — PENDENTE de auditoria real

Branch `feat/classificacao-erp-produtos`, construído sobre a rev98 do agent (resiliência). **Nada daqui deve ser
instalado em produção** (migration, servidor ou agent) até a auditoria real de uma farmácia fixar o modelo.

## Estado: o que está provado e o que não está

| Conceito | Coluna do ERP | Provado? | O que existe no código |
| --- | --- | --- | --- |
| Genérico | `dbo.Stocks.[Generico]` | **Sim** (o agent já a lê e envia como `generico`, `boolean \| null`) | `Produto.genericoErp` (tri-estado), ingestão, ficha, filtro `cls` |
| Ético | desconhecida | **Não** | nada (sem coluna, sem filtro, sem configuração) |
| NETT | desconhecida | **Não** | nada |
| Serviço | desconhecida (hoje: `Processa_Stocks = 0` fica fora do payload de produtos) | **Não** | nada; só o comando de auditoria reporta como os serviços aparecem |

Não se sabe se Ético/NETT/Serviço são booleanos independentes, uma categoria única (uma só coluna com códigos),
valores de uma tabela de lookup ou outra coisa. A primeira versão desta funcionalidade (commit `b4d9bef`, branch
`feat/garantia-catalogo-classificacao-margens`) assumia três booleanos independentes e um mapeamento configurável em
`agent.config.json`: foi **retirada** — colunas, configuração e filtros especulativos não ficam no repositório.

## O que ficou (mínimo, PROVISÓRIO)

- Migration `20261028120000_produto_classificacao_erp`: **uma** coluna, `Produto.genericoErp BOOLEAN` anulável, sem
  DEFAULT. Marcada PROVISÓRIA no próprio SQL. Aditiva; ignorada por qualquer versão anterior do código.
- Justificação (porque não basta `flagGenerico`): `flagGenerico` é `NOT NULL DEFAULT false` e a ingestão lê
  `asBoolOrFalse(raw.generico)`, por isso **não distingue «não genérico» de «desconhecido»** (NULL do ERP vira
  `false`). `genericoErp` distingue-os. Se a auditoria mostrar que essa distinção não interessa, **basta apagar a
  migration** e os poucos ficheiros listados abaixo (nada mais depende dela).
- `lib/ingest/classificacao-erp.ts`: lê a chave `generico` do payload **que os agents já enviam** (por isso esta
  entrega **não altera nenhum ficheiro de pipeline do agent**) e aplica-a com um único `UPDATE … FROM (VALUES …)`.
- `lib/catalogo/classificacao-erp.ts`: `genericoEfetivo` (= `genericoErp ?? flagGenerico`), `rotuloTri`, filtro `cls`.
- UI: ficha do artigo (Catálogo e Stock) mostra Genérico Sim / Não / «—»; lista do Catálogo tem o filtro
  «Genérico (ERP)» (`?cls=generico|nao_generico|generico_desconhecido`). Fichas antigas continuam a mostrar o que
  mostravam (cai para `flagGenerico` enquanto `genericoErp` for NULL).
- Teste: `npm run test:classificacao-erp-db` (PostgreSQL descartável, 97 verificações).

### Semântica do Genérico (testada)

| Valor no payload (`generico`) | Resultado em `genericoErp` |
| --- | --- |
| chave ausente / `undefined` (agent que não a envia) | **não toca** na coluna (nunca apaga) |
| `true`, `1`, `"1"`, `"true"` | `true` (genérico) |
| `false`, `0`, `"0"`, `"false"` | `false` (não genérico) |
| `null`, `""` | `NULL` (desconhecido) — **nunca `false`** |
| outro texto/número (`2`, `"S"`, objeto) | `NULL` e conta em `valoresDesconhecidos`; o lote não falha |

Nota: o agent já reduz o valor SQL com `boolOrNull` (número ≠ 0 → `true`, `0` → `false`, bit → boolean, texto → `null`).

Garantias testadas: idempotente (`IS DISTINCT FROM`: um reenvio não escreve — `xmin` igual, `dataAtualizacao` não é
tocada); protegido por `camposManuais` (`"genericoErp"`); não altera designação, fabricante, `flagGenerico`,
MSRM/MNSRM, DCI, ATC nem `camposManuais`; a política da Silveirense (designação autoritativa / `SO_CRIACAO`) e a
regra `LEGACY` da garantia continuam como antes; uma falha da classificação não derruba o lote (vai em
`classificacaoErp.erro` na resposta).

## Auditoria real (READ-ONLY) — pacote de DIAGNÓSTICO (fase 1)

**Não é uma revisão do agent.** É um pacote separado, `spharmmt-agent-classification-audit.zip` (id `classification-audit`,
versão `diag-<data>`, base **rev98**, `diagnostico: true`, `instalavel: false`), para executar à mão numa farmácia ao lado da
rev98 (que não é tocada). O `AGENT_REV` operacional continua `98`; `npm run agent:package` continua a produzir exatamente a
rev98 (o `cli.ts` e o `build.mjs` não conhecem este comando). O pacote tem **entry point próprio** (`agent/src/audit-cli.ts`):
o bundle só contém o comando `classification-audit` e 10 módulos (lista fechada, conferida pelo build) — sem cliente HTTP,
sem lock, sem pipelines, sem nenhum comando de escrita.

Build (a partir de um commit selado; recusa árvore suja): `npm run agent:package-audit` → `dist-agent/spharmmt-agent-classification-audit.zip`
(não versionado). Scripts PowerShell (`agent/audit/`): `Install-ClassificationAudit.ps1` (instala lado a lado, com
pré-condições), `Run-ClassificationAudit.ps1`, `Collect-ClassificationAuditReport.ps1`, `Remove-ClassificationAudit.ps1`.

```
.\node.exe agent.cjs classification-audit --out .\output\auditoria-classificacao.json     (grava .json E .md)
.\Run-ClassificationAudit.ps1 -Cnps 1234567,7654321        (opcional: -CnpsFicheiro cnps.txt)
```

Argumentos: `--out <f>.json|.md` (grava sempre os dois), `--cnps a,b` e/ou `--cnps-ficheiro f.txt` (opcionais; só dígitos, máx.
200), `--top N` (omissão 15), `--max-colunas N` (omissão 40), `--timeout-segundos N` (omissão 60), `--max-minutos N` (omissão 10),
`--out-dir`. Exige `agent.config.json` na pasta (não cai para `.env`) e nunca o altera.

Garantias: só `SELECT` — cada query passa por `sql-somente-leitura.ts` (primeira palavra SELECT, sem `;`, sem comentários,
sem palavras de escrita/EXEC/INTO/xp_/sp_, só funções permitidas) **e** por `sql-validador.ts` (intacto) antes de sair; ligação
com `readOnlyIntent` (ApplicationIntent=ReadOnly — só tem efeito em Always On), isolamento READ UNCOMMITTED, `appName`
identificável e `WITH (NOLOCK)`; o SQL Server **não tem transação read-only**, por isso a barreira real é o validador (e,
recomendado, um login só de leitura — o relatório mostra as permissões efetivas do login em `dbo.Stocks`); não adquire o
lock operacional, não usa o cliente HTTP, não fala com o SaaS; não imprime credenciais/anfitrião/connection string;
colunas/tabelas cujo nome sugere dado pessoal ou monetário (nome, NIF, morada, cliente, utente, preço, custo, valor…) nunca
são lidas; valores com e-mail/telefone/≥9 dígitos saem como `[omitido]`; amostras só com CNP/código.

Conteúdo do relatório (factos, sem conclusões): cabeçalho «pacote de DIAGNÓSTICO (base rev98), modo read-only, não instalável»
com data/hora UTC; versão/edição/compatibilidade do SQL Server, nome da base e permissões do login; tabelas-chave
(Stocks, StocksMov, Atendimento, Fornecedores, Armazens…) presentes/ausentes com nº de linhas; tabelas de versão/parâmetros do
SPharm; colunas e tabelas candidatas em todas as tabelas de utilizador (etico, nett, servic, generic, tipo, natur, categ,
famil, classe, receita, msrm, mnsrm, comparticip, produto, artigo, stock…) com tipo de dados; tabelas de domínio pequenas
(conteúdo) e lookups ligados a `dbo.Stocks` por FK (código ↔ descrição ↔ nº de artigos); valores distintos e contagens por
coluna (NULL / vazio / 0 / 1 / outros); auditoria própria do `Stocks.Generico`; tabulações cruzadas em SQL agregado
(candidatas × `Processa_Stocks` / `Retirado` e entre si); serviços e o filtro do agent (`Processa_Stocks <> 0`,
`daily-sync-runner.ts`; `Retirado = 0 AND Processa_Stocks <> 0`, `bootstrap-upload.ts`) — artigos incluídos/excluídos e quantos
candidatos a serviço ficam fora; CNPs conhecidos; «leitura assistida» (hipóteses campos independentes / categoria única /
tabela relacionada / propriedade derivada / inexistente, suportadas ou contraditas pelos números, **a confirmar por humano**);
e o texto de todas as queries executadas. Nada assume que Ético/NETT/Serviço são booleanos.

**Nunca foi corrido contra um SQL Server real** (os testes usam um ERP falso com dados sintéticos). Rever o relatório antes de
o partilhar. Depois de analisado com quem conhece o SPharm, decidir o modelo (e só então escrever a migration/UI
definitiva, ou apagar `genericoErp`). Esta fase NÃO instala migrations, NÃO altera o servidor e NÃO prepara um agent novo.

## Ordem de instalação (quando o modelo estiver fixado — NÃO agora)

1. Fixar o modelo com base no relatório da auditoria; rever/ajustar a migration.
2. Aplicar a migration a todos os tenants (`tenancy:migrate-all`) **antes** de instalar o código desta branch (o
   cliente Prisma passa a selecionar `Produto.genericoErp`; sem a coluna, as queries de `Produto` falham).
3. Agents: nenhum agent novo é necessário para o Genérico (já enviam `generico`). O pacote de diagnóstico é separado da
   rev98 e **não é uma revisão do agent** (`AGENT_REV` continua `98`).

## Rollback

Código: seguro a qualquer momento (coluna anulável sem DEFAULT, ignorada por versões anteriores). Migration: não é
preciso revertê-la; `DROP COLUMN "genericoErp"` só apaga o tri-estado, que o reenvio do catálogo repõe.
