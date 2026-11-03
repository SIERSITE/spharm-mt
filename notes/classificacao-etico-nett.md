# Classificação Ético / NETT (Entrega B)

## O que é

Cada farmácia classifica os artigos em `dbo.Stocks.Etico_NETT` (FK para `dbo.Etico_NETT.Codigo`, descrição em `Tipo`). O SPharm.MT guarda
essa classificação **por farmácia** (`ProdutoFarmacia`) e mostra um valor **consolidado** por produto.

Só `ÉTICO` e `NETT` são implementados. Serviço, Sacos, Outros e qualquer categoria desconhecida ficam fora (contam-se como aviso).

## Modelo (migration `20261103100000_produto_farmacia_etico_nett`, aditiva)

| Coluna (`ProdutoFarmacia`) | Significado |
| --- | --- |
| `eticoNett` (`ClassificacaoEticoNett?` = `ETICO` \| `NETT`) | classificação desta farmácia; `NULL` = sem classificação conhecida |
| `eticoNettCodigoErp` | código original no ERP desta farmácia (diagnóstico, não decide nada) |
| `eticoNettDescricaoErp` | descrição original do lookup (diagnóstico) |
| `eticoNettObservadoEm` | última vez que o agent a observou |
| `eticoNettManual` (default `false`) | `true` ⇒ a sincronização nunca a substitui |

`Genérico` continua a ser `Produto.flagGenerico` (vem de `Stocks.Generico`). **Não** existe segunda classificação de genérico.

## Âmbito e consolidação (nunca «a última farmácia ganha»)

Entre as farmácias **em âmbito** que têm informação: 0 ⇒ `SEM` · uma só categoria ⇒ essa · duas categorias ⇒ `DIVERGENTE`. Uma farmácia sem
informação não vota. O âmbito depende do ecrã:

| Ecrã | Âmbito |
| --- | --- |
| Vendas, Margens, Inventário, Stock | as farmácias seleccionadas (sem selecção, todas) |
| Proposta de Encomenda | **a farmácia da proposta** (DIVERGENTE nunca existe) |
| Lista de Encomendas | **a farmácia de cada encomenda** (DIVERGENTE nunca existe) |
| Mapa de Encomendas | linhas por farmácia; o cliente consolida só as farmácias seleccionadas |
| Excessos, Transferências | as farmácias do grupo que o loader recebe |
| Catálogo | o tenant inteiro (nível de catálogo) |
| Ficha do artigo | consolidado do tenant + uma linha por farmácia (com a divergência explicada) |

## Contrato de ingestão (`POST /api/ingest/v1/bootstrap/products`, campos opcionais por item)

| Payload | Efeito |
| --- | --- |
| campos ausentes (agent ≤ rev98) | **nada** é tocado |
| `eticoNett: "ETICO" \| "NETT"` (+ `eticoNettCodigo`, `eticoNettDescricao`) | grava na `ProdutoFarmacia` **já existente** (UPDATE; nunca INSERT) |
| `eticoNett: null` + `eticoNettOutraCategoria: true` (+ código, descrição «Serviços»/«Sacos»/«Outros») | **retira só a classificação automática** (fica SEM); só se a descrição confirmar uma categoria conhecida |
| `eticoNett: null` (lookup ausente, código órfão, descrição vazia/desconhecida/ambígua) | aviso (`naoClassificados`); **não altera nem apaga** |
| valor inválido, ou descrição que não confirma a categoria | `invalidos`, nada é escrito |
| `eticoNettManual = true` | `ignoradosManual`, nada é alterado nem retirado |

Reenvios são idempotentes. A resposta traz `eticoNett: { candidatos, aplicados, limpos, outraCategoria, naoClassificados, invalidos,
ignoradosManual }` só quando o lote trazia os campos novos. A classificação **não cria produtos**: o universo é o do lote que o agent já
enviava. Se o Produto já existe no MT e a farmácia ainda não tem `ProdutoFarmacia`, é o upsert normal desse item (o mesmo de sempre) que a
cria **antes** deste passo, só para a farmácia que enviou o artigo; o passo da classificação nunca faz INSERT.

## Agent rev99 (em cima da rev98; rev98 intacta)

* Lê `Stocks.Etico_NETT` (mais uma coluna do SELECT existente) e o lookup `dbo.Etico_NETT` **da própria farmácia** (só SELECT, `TOP 200`).
* A categoria decide-se pela **descrição normalizada** (sem acentos, minúsculas, pontuação removida) contra um conjunto fechado
  (`etico`/`eticos`, `nett`/`netts`). Nunca por códigos fixos. Ambiguidade (mesmo código com 2 categorias, ou 2 códigos para a mesma
  categoria) ⇒ nada se classifica.
* Universo, `Processa_Stocks`, fabricante, designação, forma farmacêutica e genérico: **inalterados** (testado: o `WHERE` gerado é idêntico).
* Bootstrap, `products-upload`, `full-sync`, `daily-sync`/`daily-pipeline` (passo de produtos) e `sync-now` partilham os dois pontos de código alterados
  (`bootstrap-upload.ts`, `daily-sync-runner.ts`).
* Logs: só estrutura e contagens (nunca o lookup, descrições, servidor ou credenciais).
* Lock único, heartbeat, identidade do processo, guarda de escrita, retoma HTTP/SQL e catch-up: não foram tocados.

## Filtro nos ecrãs

Valores: `ETICO`, `NETT`, `SEM`, `DIVERGENTE`; união dentro do eixo, E lógico com os restantes. Aplicado **no servidor**, antes de paginação,
cortes e totais, em: Catálogo, Stock (URL `eticoNett`), Vendas, Margens, Inventário (`SharedReportFilters.eticoNett` → `restringirPorCatalogo`),
Excessos e Transferências (antes do corte de 200 linhas), proposta e lista de Encomendas. Estado por separador pelo mecanismo de workspace já
existente. PDF/impressão/Excel/email partilham o `Report` e levam a linha «Ético/NETT: …» dos filtros aplicados.

## Limitações conhecidas

* O sync diário só relê os artigos que se moveram no dia (e o refresh operacional diário o catálogo activo): uma mudança de classificação no ERP sem
  movimento chega no refresh operacional ou no `full-sync`.
* Uma classificação que passe no ERP a uma categoria **desconhecida/ambígua** (ou com lookup em falta) não apaga a anterior; só Serviço, Sacos e Outros (lista fechada) a retiram.
* O mapa de Encomendas faz uma consulta extra (uma linha por farmácia com classificação) em cada carga.
