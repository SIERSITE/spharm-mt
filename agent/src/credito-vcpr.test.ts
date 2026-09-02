/**
 * agent/src/credito-vcpr.test.ts
 *
 * A série `VCPR` da Farmácia Principal é venda a crédito, e o tipo 18
 * classifica-se pelo sinal. Estes testes fixam as duas coisas contra os
 * números que a auditoria mediu, para que uma alteração futura tenha de
 * as contradizer explicitamente em vez de as apagar por descuido.
 *
 * Auditoria da Principal (SPharm_Pais_Moreira), 2024-01-01 → 2026-09-01:
 *
 *     serie VCPR · Tipo Documento ID 18
 *     199 documentos · 331 linhas · 1076 unidades líquidas
 *     estado C : 175 docs · 285 linhas · +1076
 *     estado A :            23 linhas · +121
 *                           23 linhas · −121   → saldo 0
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFICACAO,
  NAMESPACES,
  classificarDocumento,
  naturezaDe,
  namespaceDaSerieCredito,
} from "./vendas-fontes.js";

test("VCPR encaminha para VENDAS_CREDITO, e não para transferências", () => {
  assert.equal(namespaceDaSerieCredito("VCPR"), NAMESPACES.VENDAS_CREDITO);
  assert.equal(namespaceDaSerieCredito("vcpr"), NAMESPACES.VENDAS_CREDITO, "insensível a maiúsculas");
  assert.equal(namespaceDaSerieCredito(" VCPR "), NAMESPACES.VENDAS_CREDITO, "tolera espaços");
  assert.equal(naturezaDe(NAMESPACES.VENDAS_CREDITO), "CREDITO");
});

test("as séries de transferência ficam onde estavam", () => {
  // Este trabalho não toca em VCG_1/VCC_1. Se alguém os mudar ao mexer
  // no crédito, falha aqui.
  assert.equal(namespaceDaSerieCredito("VCG_1"), NAMESPACES.GUIAS_TRANSFERENCIA);
  assert.equal(namespaceDaSerieCredito("VCC_1"), NAMESPACES.GUIAS_TRANSFERENCIA);
});

test("uma série por declarar continua a ser recusada", () => {
  // O fail-closed é o desenho, não um efeito secundário. Declarar VCPR
  // não pode abrir a porta a tudo o resto.
  assert.equal(namespaceDaSerieCredito("VOG"), null);
  assert.equal(namespaceDaSerieCredito(""), null);
  assert.equal(namespaceDaSerieCredito(null), null);
});

test("tipo 18 classifica-se pelo sinal", () => {
  const NS = NAMESPACES.VENDAS_CREDITO;
  assert.equal(classificarDocumento(18, NS, 5), "VENDA");
  assert.equal(classificarDocumento(18, NS, -5), "DEVOLUCAO_ANULACAO");
  // Zero não é venda nem anulação: é uma linha sem operação.
  assert.equal(classificarDocumento(18, NS, 0), null);
  // Sem quantidade não há sinal, e sem sinal não há classe.
  assert.equal(classificarDocumento(18, NS, null), null);
});

test("o par anulado do estado A anula-se exactamente", () => {
  // 23 linhas a +121 e 23 a −121. Com `peloSinal`, as duas metades
  // classificam-se sozinhas e o saldo é zero — sem olhar para o estado
  // nem para `Fim Venda`, que já foi refutado como classificador.
  const NS = NAMESPACES.VENDAS_CREDITO;
  const positivas = classificarDocumento(18, NS, 121);
  const negativas = classificarDocumento(18, NS, -121);
  assert.equal(positivas, "VENDA");
  assert.equal(negativas, "DEVOLUCAO_ANULACAO");
  assert.notEqual(positivas, negativas, "as duas metades não podem cair na mesma classe");
});

test("nenhum outro tipo entra no crédito por arrasto", () => {
  const NS = NAMESPACES.VENDAS_CREDITO;
  for (const tipo of [4, 7, 2, 27, 38, 102, 104, 107]) {
    assert.equal(
      classificarDocumento(tipo, NS, 5),
      null,
      `o tipo ${tipo} não está declarado em VENDAS_CREDITO e tem de ser recusado`,
    );
  }
});

test("o circuito de crédito declara exactamente um tipo, e é pelo sinal", () => {
  const r = CLASSIFICACAO[NAMESPACES.VENDAS_CREDITO];
  assert.deepEqual([...r.peloSinal], [18]);
  assert.equal(r.venda.size, 0, "18 é pelo sinal, não venda fixa");
  assert.equal(r.reversao.size, 0);
});

test("os outros circuitos ficam intactos", () => {
  // Guias de transferência: tipo 38, pelo sinal. Não foi tocado.
  assert.deepEqual([...CLASSIFICACAO[NAMESPACES.GUIAS_TRANSFERENCIA].peloSinal], [38]);
  // Suspensas: 107 e 102, pelo sinal. Não foi tocado.
  assert.deepEqual(
    [...CLASSIFICACAO[NAMESPACES.ATENDIMENTO_SUSP_DETALHE].peloSinal].sort((a, b) => a - b),
    [102, 107],
  );
  // Circuito G: a classe é propriedade do tipo, e o 4 continua por
  // declarar — ver a nota no relatório desta revisão.
  const g = CLASSIFICACAO[NAMESPACES.ATENDIMENTO_DETALHE];
  assert.deepEqual([...g.venda].sort((a, b) => a - b), [2, 7]);
  assert.deepEqual([...g.reversao].sort((a, b) => a - b), [27, 104]);
  assert.equal(classificarDocumento(4, NAMESPACES.ATENDIMENTO_DETALHE, 1), null);
});
