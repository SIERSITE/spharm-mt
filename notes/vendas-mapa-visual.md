# Mapa de Vendas — regras do desenho visual (2026-10)

Âmbito: ecrã, PDF, impressão, Excel e email do mapa de Vendas. **Sem migrações, sem alterações ao agent, às regras de
ingestão, à sincronização diária, aos fabricantes, ao INFARMED, às margens, às encomendas ou ao inventário.**

## Causa da leitura difícil (antes)

* Larguras das colunas **fixas em %** com `overflow:hidden`: «10 000,00 €» (11 caracteres) não cabia em 7 % de uma
  página com 13 meses e o PDF mostrava «10 000,0»; o «TOTAL GERAL» (1.ª coluna, CNP) aparecia como «TOTA»; o total geral
  do custo/valor aparecia truncado.
* Ecrã sem a coluna «Vendas s/IVA», com a farmácia numa sublinha da descrição, sem colunas fixas nem barra de scroll no
  topo; PDF sem indicador de stock legível a preto e branco e com «–» nos meses sem vendas.

## Regras

| Tema | Regra |
|---|---|
| Valores monetários | Largura de cada coluna **calculada pelo seu texto mais largo** (linhas, «Total artigo» e TOTAL GERAL), com métrica conservadora (fonte larga) — `colunaPct` em `lib/reporting/adapters/vendas.ts`. As células `noClip` nunca têm reticências/`overflow:hidden`. A Descrição fica com o resto. |
| Meses | Até **13 meses**: uma coluna por mês numa só tabela. Acima: o período reparte-se em ⌈n/13⌉ **partes** de tamanho o mais igual possível (14 → 7+7; 24 → 12+12; 27 → 9+9+9), uma página nova por parte (`ReportMeta.columnBlocks`). Cada parte repete a identificação do artigo e os totais **do período completo** (Total Unid., custos, stock, Valor Vendas); o TOTAL GERAL só aparece no fim da última parte; o rodapé explica a divisão. Nunca se corta nem se esconde um mês; nunca se reduz a letra abaixo de 8 px. O ecrã e o Excel mostram sempre todos os meses. |
| Artigo | CNP + Descrição **uma vez** (rowspan no PDF; só na 1.ª linha no ecrã), uma linha por farmácia, «Total artigo» **só com 2+ farmácias** (sempre no fim do bloco). Um bloco nunca se parte entre páginas (`break-inside: avoid`); blocos com mais de 14 linhas repetem a identificação em cada linha. |
| Meses sem vendas | «·»; negativos (devoluções/anulações acima das vendas) mostram o sinal; fundo alternado por mês de ~4 % de tinta. |
| Stock | Atual (à data de geração). Positivo: número simples; zero: número em **caixa**; negativo: branco sobre **escuro** (lê-se a P&B); a cor só reforça. |
| Custos | Custo total est. = custo unit. est. × quantidade líquida (PMC/PUC atual). Sem custo: «—» e fora do total, com o total marcado **PARCIAL** e a contagem das linhas sem custo no rodapé. Nunca zero. |
| Seleção | Só ecrã (checkbox por artigo, todos por omissão, «Selecionar todos» = todo o resultado filtrado, zero selecionados bloqueia as saídas, repõe «todos» ao gerar de novo, só guarda CNP). **Nenhum controlo** (checkbox, caixa vazia, botão) sai no PDF/impressão/Excel/email: a coluna de seleção não existe no `Report`. Seleção parcial: o âmbito diz «Artigos: N de M selecionados» e o ecrã mostra «TOTAL SELECIONADO». |
| Âmbito (filtros) | Só os filtros efetivamente aplicados. «Naturezas» sempre listadas. «Apenas com vendas» + «Incluir stock sem vendas» → uma só entrada: *Artigos incluídos: com vendas no período + sem vendas mas com stock atual*; só vendas → *apenas com vendas no período*. A ordenação por cabeçalho (se ativa) prevalece sobre o selector. |
| Excel | Valores numéricos; coluna extra «Tipo de linha» (Detalhe / Total artigo) para filtrar e somar sem contar duas vezes; filtro automático; «TOTAL GERAL» = soma só do detalhe; mesma ordem do relatório; sem colunas vazias. |

## Testes

* `npm run test:vendas-mapa-visual` — regra dos meses, PDF **real** (Chromium) com valores extremos, multi-página,
  blocos, ausência de controlos, cálculos, texto do âmbito, Excel.
* `npm run e2e:vendas-mapa-visual` — browser real contra o build de produção (3 resoluções, PDF/impressão/Excel/email,
  seleção, 13 e 27 meses). Ver o cabeçalho do ficheiro para os pré-requisitos.
* Evidência (dados sintéticos): `docs/validacao-visual/2026-10-vendas-mapa/`.
