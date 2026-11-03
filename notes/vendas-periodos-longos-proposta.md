# Mapa de Vendas: períodos que não cabem numa página A4 legível — análise e proposta

Estado: **proposta, sem decisão**. Nada disto está implementado. O que está em produção de código (branch `feat/vendas-tabela-unica-sem-blocos`)
é só o comportamento seguro enquanto não houver decisão: acima da capacidade do A4 a 8 pt **não se gera PDF, impressão, PDF do email nem
pré-visualização truncados**; mostra-se a mensagem

> O período de N meses não cabe numa página A4 legível (máximo M meses com estas opções). Reduza o período, retire preços ou use o Excel.

(o servidor responde HTTP 422 com o mesmo texto em `/api/reports/pdf` e `/api/reports/email`). O Excel e a tabela do ecrã não têm limite.

## 1. Restrições (do utilizador)

- A4 horizontal (297 × 210 mm) **sempre**; sem A3 automático; legível impresso diretamente, sem ampliação.
- Corpo da tabela (meses incluídos) a 8,25 pt e cabeçalhos a 8 pt (piso 8 pt). Nunca reduzir a letra para caber colunas.
- Nada de blocos temporais, de artigos repetidos por blocos nem de «Parte i de n».
- Tabela principal: CNP · Descrição · Farmácia · PVP* · Custo unit.* · meses · Total unid. · Stock (*conforme as opções de preços).

## 2. Medidas reais (função `capacidadeA4`, lib/reporting/layout-largura.ts)

Largura útil: 297 − 2 × 6,5 = **284 mm**. Larguras mínimas (mm) com os dados do PDF do cliente (pad 2 px, Arial/Liberation Sans 8 pt, medidas
de glifo reais): CNP 12,8 · Farmácia 23,4 · PVP 11,1 · Custo unit. 13,0 · Total unid. 10,8 · Stock 10,0 · **cada mês 11,4** (o rótulo «Nov/26» a
negrito de 8 pt é o que manda: 35 px; o corpo é de 8,25 pt) · Descrição ≥ 32 mm. Fixos com tudo: 81,1 mm; o resto (284 − 1 − 81,1 − 32 = 169,9 mm) divide-se por 11,4 mm/mês.

| Preços de venda | Preços de compra | Máx. meses (dados do cliente) | Máx. meses (valores extremos¹) |
|---|---|---|---|
| sim | sim | **14** | 10 |
| sim | não | 16 | 11 |
| não | sim | 15 | 11 |
| não | não | 17 | 12 |

¹ 123 456 unidades por mês, −12 345, PVP/custo de 12 345,67 €, total de unidades de 1 234 567. A capacidade depende dos DADOS (nº de dígitos do
maior valor mensal): por isso a mensagem diz «máximo M meses com estas opções» e M varia um pouco com o resultado selecionado.

**24 e 27 meses não cabem em nenhuma combinação** (nem com dados moderados, nem com extremos).

## 3. Opções (medidas com os mesmos dados do cliente)

| # | Opção | Meses que cabem (todos os preços → sem preços) | 24 / 27 meses? | Prós | Contras / o que implica |
|---|---|---|---|---|---|
| A | **Agrupar as colunas por trimestre** (T4/25, T1/26, …) com total trimestral, no PDF/impressão/email; detalhe mensal no Excel | 18–21 trimestres = **54–63 meses** (extremos: 13–15 trimestres = 39–45 meses) | Sim, de longe (24 m = 8 trimestres; 27 m = 9) | Mantém UMA tabela A4, a 8 pt, sem blocos; cada artigo uma vez; resposta direta à pergunta «quanto vendi por trimestre». Valores maiores (3 meses somados) cabem na mesma | Perde-se o detalhe mensal no papel (fica no Excel e no ecrã). Trimestres incompletos nos extremos do período (p.ex. 2025-10-01 a 2026-11-02 → T4/25 completo, T4/26 só 2 meses): marcar «parcial» ou alinhar os grupos ao início do período («Out–Dez/25»). Implica: modo de agregação no adapter (`m_YYYYMM` → `q_YYYYQn`, soma a partir dos buckets já existentes — sem tocar em cálculos), rótulos, interruptor na UI (só quando excede), testes de somas = totais; o Excel não muda |
| B | **Relatório por farmácia** (uma tabela por farmácia, sem coluna Farmácia nem TOTAL ARTIGO) | 17–19 meses (+3) | Não | Útil em si (cada farmácia lê o seu); poupa 23,4 mm | Insuficiente sozinho para 24/27; um artigo aparece uma vez **por farmácia** (deixa de haver visão conjunta/TOTAL ARTIGO); muda a estrutura pedida |
| C | **Permitir escolher o conjunto de colunas** (p.ex. sem PVP/custo/stock) | sem preços e sem Stock/Farmácia: 17 (o limite vem dos meses) | Não | O utilizador decide o que sacrificar | Ganho pequeno: o limite vem dos meses (11,4 mm cada), não das colunas fixas; mais controlos na UI e mais combinações para testar |
| D | **Aumentar a largura útil** removendo PVP/custo (é o C com preços desligados) | 15–17 | Não | Já existe: «Incluir preços de venda/compra» | +1 a +3 meses apenas |
| E | **Transposição** (meses em linhas, artigos em colunas) | só serve com poucos artigos (≤ ~20 colunas de 11 mm) | Só para listas curtas | Escala bem em meses | O relatório típico tem 300+ artigos → inviável; muda por completo a leitura. **Descartada** |
| F | **12 meses de detalhe + uma coluna «Anteriores»** | 12 + 1 | Sim (24/27) | Mantém o recente mensal | Perde-se o detalhe dos meses antigos no papel; semântica pouco clara para o utilizador; difícil de justificar vs. A |
| G | **A3 apenas por escolha explícita do utilizador** (não automático) | 25 meses a 8,25 pt | 24 sim; 27 não | Mantém o mensal em papel | O utilizador rejeitou o A3 como solução; 27 meses continuam sem caber; impressoras A3 não são universais. **Não recomendada** |
| H | Repartir por páginas/blocos (a solução original) | n/a | Sim | — | **Rejeitada** pelo utilizador (artigos repetidos, «Parte i de n») |

## 4. Recomendação

1. **Agora** (já implementado): mensagem + 422 + Excel/ecrã sem limite — falha segura, nunca um PDF ilegível.
2. **Próximo passo (A)**: «Agrupar por trimestre (PDF/impressão/email)» como alternativa oferecida **na própria mensagem de excesso** («… ou agrupe por
   trimestre»), ativa só quando o período excede. Cabe qualquer período realista (54–63 meses), mantém o desenho aprovado (uma tabela, a 8 pt, cada
   artigo uma vez) e o Excel continua mensal e idêntico. Decidir só o tratamento dos trimestres incompletos (recomendado: calendário civil com a marca
   «parcial» no rótulo, p.ex. «T4/26 (2 m)»).
3. **Opcional depois (B)**: «PDF por farmácia» para quem quer o detalhe mensal de uma farmácia (+3 meses) — só se houver pedido.

Estimativa de A: 1 adapter (agregação sobre `buckets`), 1 opção em `ReportMeta`/`buildVendasReport`, reutilização integral de `capacidadeA4`
(só muda `rotulosMes`/textos), 1 interruptor em `vendas-client.tsx`, ~40 testes novos (somas trimestrais = soma dos meses; TOTAL GERAL; Excel inalterado;
capacidade trimestral). Nada nos cálculos, filtros, seleção ou Excel.
