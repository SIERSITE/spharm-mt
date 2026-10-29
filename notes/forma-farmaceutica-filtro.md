# Filtro «Forma farmacêutica» nos mapas e listagens de produtos

Estado: implementado (sem commit). Todos os tenants. Não afirma cobertura real de produção: os números abaixo vêm de
bases sintéticas descartáveis.

## 1. Fonte do dado e o que a reconcilia

`Produto.formaFarmaceutica` (String?, `prisma/schema.prisma`). Auditado por amostragem:

| Quem escreve | Como | Protecção |
|---|---|---|
| `lib/regulamentar/infarmed-reconciliar.ts` (+ `infarmed-aplicar.ts`) | texto cru do INFARMED («Comprimido revestido por película»), `NULLIF(btrim(...), '')` | `Produto.camposManuais ∋ 'formaFarmaceutica'` (contador `ignoradosManual`) |
| `lib/jobs/regulatory-acquisition.ts` | só se a forma actual é `null` | — (nunca sobrepõe) |
| `lib/catalog/knowledge-enrichment*.ts`, `lib/catalog-normalizers.ts`, `lib/catalog/formas-farmaceuticas.ts` | Title case / minúsculas / vocabulário fechado | — |

Lacunas encontradas (documentadas, **não corrigidas** — fora do âmbito e o enunciado proíbe alterar o valor guardado ou a reconciliação):

* **`camposManuais` nunca é preenchido com `formaFarmaceutica`**: nenhum caminho de UI põe esse campo; `validadoManualmente`
  não protege. Na prática a protecção existe no código mas não há nada protegido.
* **Três convenções na mesma coluna** (INFARMED cru, Title case, minúsculas). É isto que o filtro tem de absorver.

## 2. Normalização (módulo único)

`lib/catalog/forma-farmaceutica-filtro.ts` (puro, importável no browser) + `lib/catalog/forma-farmaceutica-sql.ts` (lado SQL).

* **Chave** = aparar + colapsar espaços/tabs + retirar acentos (lista explícita de letras, maiúsculas e minúsculas) + minúsculas.
  Idêntica em TS e SQL (`translate`, sem extensão `unaccent`, sem NFD); o teste de BD compara as duas sobre 16 valores.
* **Sem fuzzy, sem taxonomia, sem abreviaturas, sem plural**: «Comprimido» ≠ «Comprimido revestido» ≠ «Comprimido de libertação
  prolongada» ≠ «Comprimidos» ≠ «Comp.». O valor na BD nunca é alterado.
* **Sentinela** `__sem_forma__` = `formaFarmaceutica` nula, vazia ou só espaços; rótulo «Sem forma farmacêutica» (no fim da lista).
* **Opção** `{ chave, label, count }`: rótulo = variante mais frequente do grupo (empate: a acentuada, depois a alfabética) em
  sentence-case; ordenada por rótulo (pt, sem acentos). A chave é o que viaja (estado, URL, contexto de rascunho); o rótulo só se mostra.
* Opções por UMA agregação (`GROUP BY "formaFarmaceutica"` sobre produtos `estado <> 'INATIVO' AND cnp > 2 000 000`), agrupadas por
  chave em memória (centenas de linhas). Cada tenant tem a sua base — o `prisma` recebido já é o do tenant; nada é partilhado/cacheado.

## 3. Onde se aplica e como (por mapa)

| Mapa | Onde corre o filtro | Estado do filtro |
|---|---|---|
| Vendas | **servidor**: `resolverPrefiltroProdutos` → `restringirPorCatalogo` (antes dos totais). Refinamento client-side com `row.formaChave` | `criterios.formasSelecionadas` do workspace (por tenant:utilizador:workspace); `handleGerar`, `limparFiltros`, contador e `htmlPrevia` ligados |
| Margens | **servidor**: `restringirPorCatalogo` (o pré-filtro inline já o usava) | `filters.formasFarmaceuticas` (draft) vs `filtrosResultado` (aplicado); entra em `normalizarFiltros` ⇒ «alterações por aplicar» |
| Inventário | **servidor**: idem | idem |
| Stock | **servidor**: `restringirPorCatalogo` antes da paginação; URL `forma` (repetido) | URL |
| Catálogo | **servidor**: `wherePrismaPorFormas` (valores crus ⇒ `formaFarmaceutica IN (...)`, evita `IN` de dezenas de milhares de ids) | URL `forma` (repetido) |
| Proposta de Encomenda | **servidor**: `sqlCondicaoForma` no SQL da proposta (antes do corte de linhas) | `selFormas` (`useEstadoSeparador`) + `PropostaContexto.filters.formas` (opcional; rascunhos v1 sem o campo ⇒ `[]`) |
| Excessos / Transferências | **cliente** sobre `row.formaChave` (ver abaixo) | `formasSelecionadas` no critério e no `snapshot` (aplicado) |
| Encomendas (`/encomendas`, mapa por farmácia) | **cliente** sobre `row.formaChave` | `useState` local, como os restantes filtros dessa página |

**Excessos/Transferências — decisão.** O servidor só recebe datas e devolve todas as linhas; todos os outros eixos (categoria,
utilização, distribuidor…) já filtram no cliente sobre essas linhas, e o fabricante (garantia) resolve-se por CNP. A forma segue o
padrão dos eixos de catálogo: `formaChave` vai **na linha** (`loadPfAndSales` ganha `p."formaFarmaceutica"` no SELECT que já
existia — sem consulta nova, sem N+1; a chave calcula-se em TS com a MESMA função). Impacto de payload: ≈ 20–40 bytes por linha
(`"formaChave":"comprimido revestido"`), ~+1,5 MB por 50 000 linhas antes de compressão; as listas reais (Excessos/Transferências) são
muito menores. Não há carregamento extra de produtos para o browser. Alternativa descartada: resolver CNPs no servidor (obrigava a
um round-trip novo por mudança de filtro num ecrã que hoje só chama o servidor ao «Gerar»).

**Vendas — refinamento client-side.** O servidor filtra (totais e linhas); `formaChave` na linha serve só para o mesmo
refinamento instantâneo que os outros eixos já têm sobre as linhas recebidas (seleccionar outra forma sem esperar pelo «Gerar»
mostra zero linhas antigas em vez de linhas que contrariam o filtro).

**Devoluções e Manutenção em massa do catálogo** foram acrescentadas depois (cliente e servidor, respectivamente) — ver
`notes/forma-farmaceutica-matriz.md`, que lista TODAS as áreas, o que está aplicado e o motivo técnico das restantes.
**Não abrangidos:** históricos de documentos finalizados e detalhe imutável de encomendas/transferências (são registos; mudariam o
que foi emitido), pickers de adição de linhas, ficha de artigo, dashboard, oportunidades e a consola de plataforma (cross-tenant).

## 4. Mapas com arquitectura própria — como foram alinhados

Sem sistema isolado: um só módulo de chave/rótulo/opções, um só componente (`FiltroFormaFarmaceutica`, sobre o
`SearchableMultiSelect` partilhado, agora com `labelOf`/`countOf` opcionais — retrocompatível), um só ponto de pré-filtro no
servidor (`restringirPorCatalogo`/`temFiltroCatalogo`), um só predicado cliente (`passaFiltroForma`) e uma só linha de relatório
(`filtroFormaFarmaceuticaLinha`). Cada mapa liga o seu estado ao que já usava (workspace, `useEstadoSeparador`, URL, contexto).
Chaves de storage do workspace já incluem tenant e utilizador (`chaveWorkspaceState`), e as de `useEstadoSeparador` o
escopo `tenant:utilizador` — mudar de tenant não leva estado.

URL multi-valor: parâmetros **repetidos** (`?forma=a&forma=b`), nunca separados por vírgula — há formas com vírgula no nome
(«comprimido revestido, oral»). `lerChavesForma` re-normaliza, deduplica e limita a 60 chaves (um URL forjado só pode produzir
uma comparação de igualdade parametrizada).

## 5. Relatórios

PDF / impressão / Excel / email partilham o `Report`; cada adapter (`vendas`, `margens`, `inventario`, `excessos`,
`transferencias`) acrescenta «Forma farmacêutica: A, B» com os **rótulos** («Sem forma farmacêutica» incluído), nunca a chave.
Margens e Inventário usam `filtrosResultado` (aplicados); Excessos/Transferências usam o `snapshot` (aplicado) — o resto desses
dois relatórios continua a ler o rascunho (comportamento anterior, não alterado). Sem selecção não aparece linha nenhuma.

## 6. Desempenho (medido, base sintética, PostgreSQL 16 local, 50 000 produtos)

`scripts/tests/test-forma-farmaceutica-db.ts` (secção H). 793 valores crus distintos ⇒ 201 opções por chave.

| Operação | Tempo |
|---|---|
| Opções (1 agregação `GROUP BY`) | ≈ 38–43 ms |
| `restringirPorCatalogo(forma)` — versão inicial (chave por linha) | 427–578 ms |
| `restringirPorCatalogo(forma)` — **versão final** | **≈ 47 ms** |
| `EXPLAIN ANALYZE` da condição final vs chave por linha | 47 ms vs 424 ms |
| `getVendasData` com forma (237 linhas) / baseline (50 000 linhas) | ≈ 154 ms / ≈ 3,9 s |
| `getStockData` (paginado) / `loadCatalogoListData` (paginado) | ≈ 360 ms / ≈ 75 ms |
| Round-trips do filtro | 1 por filtro, independentemente do nº de formas (3 ou 10) |

A condição final calcula a chave **uma vez por valor cru distinto** (subconsulta com `DISTINCT ... OFFSET 0`, que é a barreira
que impede o planificador de empurrar o filtro para dentro do `DISTINCT`) e compara a coluna com esse conjunto em hash.
**Não há índice nem migração**: 47 ms em 50 000 produtos (seq scan + hash) não o justifica; um índice de expressão só
mudaria um tempo já pequeno e acrescentaria uma migração em todos os tenants. Reavaliar se um tenant passar de ~10× este volume.

## 7. Auditoria de cobertura (só leitura, por tenant)

`scripts/diagnostics/auditoria-forma-farmaceutica.ts` — comando SÓ DE LEITURA para correr, depois de revisto, em UMA base de
tenant de cada vez:

```
npx tsx scripts/diagnostics/auditoria-forma-farmaceutica.ts --url postgresql://… --tenant <slug> --confirmo-read-only [--out relatorio.md|.json] [--top 25]
```

Sessão `default_transaction_read_only=on` + `BEGIN READ ONLY` + só SELECT/WITH (ROLLBACK no fim); exige `--url` explícito (não lê
`DATABASE_URL`), `--tenant` e a flag; nunca imprime a password (só `host:porta/base`, também nos erros). Reporta: total, com/sem
forma e cobertura; top N; variantes normalizadas (grafias cruas por chave, com contagens); colisões suspeitas (chave de produção
vs normalização independente NFD — deve ser zero) e pares muito parecidos NÃO agrupados (distância de edição <= 2) para revisão
humana; produtos sem correspondência INFARMED (ProdutoRegulamentar da versão ativa ou RegulatoryRecord, por CNP) e quantos desses
não têm forma; medicamentos vs não medicamentos (`productType = 'MEDICAMENTO'` OU com registo INFARMED — critério e limitação
vão no relatório). Teste: `scripts/tests/test-auditoria-forma-db.ts`. **Nenhuma base real foi medida.**

## 8. Testes

* `scripts/tests/test-forma-farmaceutica-filtro.ts` — unitário (chave, agrupamento, compostas, rótulo, ordem, sentinela, estados
  antigos, contador/limpar/draft≠aplicado, adapters/HTML/Excel).
* `scripts/tests/test-forma-farmaceutica-db.ts` — PostgreSQL descartável: SQL = TS, opções, filtro real em Vendas/Margens/Inventário/
  Stock/Catálogo/proposta/Excessos, combinações (fabricante, farmácia, pesquisa, período, preços, paginação), vazio = baseline,
  todas as formas = baseline, isolamento entre bases, estrutura (SQL parametrizado, nada carregado para o browser), auditoria,
  50 000 produtos + `EXPLAIN`.
* `scripts/e2e/forma-farmaceutica-browser.ts` (não executado) e o gancho de `margens-sem-geracao-automatica-browser.ts` (agora real).
