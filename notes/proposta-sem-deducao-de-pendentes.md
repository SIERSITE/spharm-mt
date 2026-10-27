# Proposta de encomenda sem dedução de encomendas pendentes

Base: `fix/vendas-separador-artigos` @ fa419780fe8710d039a4e17f245af4dbd5ed2454. **Sem migrations.** Agent, `OrderOutbox` e exportação para o ERP intocados.

## Regra anterior
`lib/encomendas/proposal.ts` (CTE `pending`) somava, por farmácia e produto, as linhas de encomendas `FINALIZADA` com `estadoExport` em
`PENDENTE`/`EM_EXPORTACAO` (a quantidade original, sem limite de datas) e **deduzia-as**:

```
sugerida = max(0, ceil(alvo − stock − PENDENTE))
estado   = AGUARDAR  se sugerida ≤ 0 e PENDENTE > 0   (única origem do estado «Aguardar»)
```

O «pendente» só desaparece quando o agent confirma a exportação (ACK) — não por receção, sincronização ou conclusão no ERP.
Uma encomenda nunca confirmada (agent sem exportar encomendas) deixava o artigo em «Aguardar» com sugestão zero para sempre
(foi o que se observou em produção: 121 artigos).

## Regra nova
```
sugerida = max(0, ceil(alvo − stock))          // calcularQuantidadeSugerida({ target, stock, considerStock })
estado   = sugerida > 0 ? COMPRAR : ADEQUADO   // computeEstado(sugerida); depois, em grupo, TRANSFERÊNCIA pelas regras atuais
```
- O alvo (`salesQty` na regra «total», ou média diária × cobertura), os arredondamentos, mínimos/máximos, fornecedor habitual e a
  transferência entre farmácias (stock de OUTRAS farmácias) **não mudam**.
- `calcularQuantidadeSugerida` e `computeEstado` não têm parâmetro de pendente; um teste estrutural garante que nenhuma linha que
  calcula a sugestão ou o estado menciona o pendente e que decisão de grupo, consolidação, multi-fornecedor, finalização e
  exportação nunca leem `pendingQty`.
- Vale para farmácia, grupo, consolidação (usa as propostas por farmácia), divisão por fornecedor, regeneração, filtros e reabertura
  (os campos informativos do rascunho são recalculados a partir de uma proposta fresca).

## «Pendente» = informação
- `ProposalRow.pendingQty` mantém-se **só para apresentação** (mesma consulta, agora com o detalhe das encomendas na MESMA agregação
  SQL — sem N+1, por farmácia): `pendentes[]` com número, nome, fornecedor, estado de exportação, quantidade e data. A soma do
  detalhe coincide por construção com a coluna.
- Na tabela: valor em itálico/cinzento; tooltip «Informativo: existem X unidades noutras encomendas. Este valor não interfere na
  sugestão atual.»; clicável/expansível com todas as encomendas e ligação para abrir cada uma (`/encomendas/<id>`, novo separador).
- O motivo da linha acrescenta «Informativo: X unidades já constam de outras encomendas; não foram consideradas no cálculo desta
  proposta.» — substitui «Encomenda pendente: X und. — cobre a necessidade».
- O que conta no valor informativo continua a ser o que sempre contou: encomendas `FINALIZADA` da mesma farmácia ainda por exportar
  (não conta rascunho, anulada, eliminada, rascunho-pai dividido, exportada nem falhada).

## Estado «Aguardar»
Auditado: `AGUARDAR` só era produzido por `computeEstado` quando `pendingQty > 0` (nenhuma outra utilização independente). Foi
**removido** (tipo `ProposalEstado`, `ProposalStats.aguardar`, cartão de resumo, badge, cor, prioridade, texto do aviso, decisão de
grupo). Estados que restam: `COMPRAR`, `ADEQUADO`, `TRANSFERÊNCIA` (este só no modo grupo, por excedente real noutra farmácia).

## Risco consciente: encomenda duplicada
Se o utilizador gerar e finalizar uma nova proposta enquanto outra encomenda do mesmo artigo ainda não foi recebida, o artigo volta a
ser sugerido e a compra pode duplicar-se. É a decisão funcional: a coluna «Pendente» (informativa) e o detalhe existem para o
utilizador ver e decidir; a quantidade final continua editável.

## Impacto nos 121 artigos atuais
Nada é limpo nem reprocessado. Depois do deploy, uma proposta NOVA recalcula estes artigos só por vendas e stock: com necessidade
passam a «A comprar», com stock suficiente a «Adequado»; nunca ficam em «Aguardar». Encomendas já finalizadas/exportadas e propostas
históricas não são tocadas; `OrderOutbox`, estados de exportação e o agent também não.

## Testes
`test-proposta-sem-deducao-db` (PostgreSQL descartável: sem encomenda, FINALIZADA/PENDENTE, EM_EXPORTACAO, EXPORTADA, vários
fornecedores, outra farmácia, mesma farmácia, grupo, consolidação, transferência, coluna «Pendente», cenários idênticos com/sem
encomendas, artigos que antes ficavam em «Aguardar»), `test-proposta-pending-qty-db` (o valor informativo), `e2e
proposta-pendente-informativo-browser` (build de produção, farmácia e grupo, tooltip, detalhe, edição, separador, finalização, Excel).
