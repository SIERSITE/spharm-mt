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

## Auditoria real (READ-ONLY) — como correr

Comando novo do agent (rev99 de desenvolvimento): `classification-audit`, wrapper `run-classification-audit.bat`.

```
run-classification-audit.bat --out run\auditoria-classificacao.json
run-classification-audit.bat --out run\auditoria-classificacao.md --cnps 1234567,7654321
run-classification-audit.bat --cnps-ficheiro cnps-conhecidos.txt --top 20 --max-colunas 60
```

Argumentos: `--out <f>.json|.md` (sem `--out` grava `run\classification-audit-<ts>.md` e `.json`), `--cnps a,b` e/ou
`--cnps-ficheiro f.txt` (só dígitos, máx. 200; o resto é ignorado e contado), `--top N` (valores mais frequentes de
texto livre, omissão 15), `--max-colunas N` (omissão 40), `--timeout-segundos N` (por pedido, omissão 60),
`--max-minutos N` (orçamento total, omissão 10), `--out-dir`.

Garantias: só `SELECT` (cada query passa por `validarSomenteSelect` + `sql-validador.ts` antes de executar; qualquer
DML/DDL/EXEC/`SELECT INTO`/vários statements/comentários é recusado); ligação com `readOnlyIntent`
(ApplicationIntent=ReadOnly); leituras a `dbo.Stocks` com `WITH (NOLOCK)`; não imprime credenciais, anfitrião nem
connection string; colunas/tabelas cujo nome sugere dado pessoal (nome, NIF, morada, contacto, cliente, utente, médico…)
nunca são lidas; valores com e-mail/telefone/≥9 dígitos saem como `[omitido]`; amostras só com CNP/código; relatório
com data/hora UTC, rev do agent e a frase «gerado em modo read-only».

Conteúdo do relatório (factos, sem conclusões): versão e nome da base (`@@VERSION` 1.ª linha, `DB_NAME()`); colunas
candidatas em **todas** as tabelas de utilizador (etico/ético, nett, servic, generic, tipo, natur, categ, famil, classe,
grupo, receita, msrm, mnsrm, comparticip, processa, retirado) com tipo e nº de linhas da tabela; FKs de `dbo.Stocks`;
valores distintos + contagens por coluna (lista completa até 50 distintos, senão top-N) e contagem por categoria
(NULL / vazio / 0 / 1 / outros); amostras CNP/código por valor; secção Genérico; tabulações cruzadas entre pares de
colunas de `dbo.Stocks` (SQL agregado; + `Processa_Stocks` e `Retirado`); serviços (`Processa_Stocks = 0` vs `<> 0` vs
NULL, colunas/valores observados só de um lado, exemplos CNP/código de cada lado, e o aviso de que o filtro
`Processa_Stocks <> 0` do agent NÃO prova que 0 = serviço); classificação de CNPs conhecidos (`--cnps`).

**Nunca foi corrido contra um ERP real** (os testes usam um ERP falso com dados sintéticos). Rever o relatório antes de
o partilhar. Depois de analisado com quem conhece o SPharm, decidir o modelo (e só então escrever a migration/UI
definitiva, ou apagar `genericoErp`).

## Ordem de instalação (quando o modelo estiver fixado — NÃO agora)

1. Fixar o modelo com base no relatório da auditoria; rever/ajustar a migration.
2. Aplicar a migration a todos os tenants (`tenancy:migrate-all`) **antes** de instalar o código desta branch (o
   cliente Prisma passa a selecionar `Produto.genericoErp`; sem a coluna, as queries de `Produto` falham).
3. Agents: nenhum agent novo é necessário para o Genérico (já enviam `generico`). A rev99 só acrescenta o comando de
   auditoria e **não é empacotada** (`AGENT_REV = "99"` é valor de desenvolvimento; rev97 e rev98 já têm outro
   conteúdo em produção/preparação).

## Rollback

Código: seguro a qualquer momento (coluna anulável sem DEFAULT, ignorada por versões anteriores). Migration: não é
preciso revertê-la; `DROP COLUMN "genericoErp"` só apaga o tri-estado, que o reenvio do catálogo repõe.
