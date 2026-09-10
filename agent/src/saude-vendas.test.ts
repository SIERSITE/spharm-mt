/**
 * agent/src/saude-vendas.test.ts
 *
 * Os dois defeitos de 2026-09-09, fixados como asserções.
 *
 * ── 1. O TIPO QUE NÃO ESTAVA DECLARADO ───────────────────────────────
 *
 * A farmácia Principal mudou as vendas de balcão de `Tipo Documento 7`
 * para `77` a 2024-03-04. O 77 tinha sido retirado de `CLASSIFICACAO`
 * por "nunca ter sido observado" — numa amostra de UMA farmácia. Desde
 * então o agente recusou ~1 100 linhas por dia, dois anos e meio, e o
 * total do dia ficava negativo porque as devoluções continuavam a
 * chegar.
 *
 * ── 2. A RECUSA QUE NÃO TINHA CONSEQUÊNCIA ───────────────────────────
 *
 * Nada mentiu: o agente contou as recusas em `salesSkipped` e escreveu o
 * tipo no log local. Mas `salesErrors` era zero — uma linha recusada não
 * é um erro, é uma decisão — e o dia fechava OK. O catch-up dava-o por
 * feito e nunca mais o propunha.
 *
 * O teste que interessa mais neste ficheiro é o do LIMIAR, e não o do
 * 77: o 77 é um número numa lista e corrige-se em dez segundos; o limiar
 * é o que faz com que o PRÓXIMO tipo por declarar — que virá, porque os
 * ERP das farmácias mudam — se anuncie em vez de se somar em silêncio.
 *
 * Uso: npx tsx agent/src/saude-vendas.test.ts
 */
import {
  avaliarSaudeVendas,
  LIMIAR_SKIPPED_FRACCAO,
  MINIMO_SKIPPED_ABSOLUTO,
} from "./saude-vendas.js";
import { classificarDocumento, CLASSIFICACAO, NAMESPACES } from "./vendas-fontes.js";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

const D = "─".repeat(70);
const G = NAMESPACES.ATENDIMENTO_DETALHE;
const S = NAMESPACES.ATENDIMENTO_SUSP_DETALHE;

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n1. Tipo 77 — venda de balcão da Principal\n${D}`);

check(
  classificarDocumento(77, G, 1) === "VENDA",
  "77 no circuito G → VENDA",
  "é o tipo das 1 090 linhas/dia que a Principal perdia",
);
check(
  CLASSIFICACAO[G].venda.has(77),
  "77 está declarado em CLASSIFICACAO[ATENDIMENTO_DETALHE].venda",
);
// A classe é propriedade do TIPO e não do sinal: uma venda com
// quantidade negativa (estorno de linha) continua a ser venda, e é o
// `assinarQuantidade` que trata do sinal.
check(
  classificarDocumento(77, G, -1) === "VENDA",
  "77 com quantidade negativa continua VENDA (a classe é do tipo, não do sinal)",
);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n2. O que já funcionava continua a funcionar\n${D}`);

check(classificarDocumento(7, G, 1) === "VENDA", "7 → VENDA (as outras quatro farmácias)");
check(classificarDocumento(2, G, 1) === "VENDA", "2 → VENDA");
check(classificarDocumento(104, G, -1) === "DEVOLUCAO_ANULACAO", "104 → DEVOLUCAO_ANULACAO");
check(classificarDocumento(27, G, -1) === "DEVOLUCAO_ANULACAO", "27 → DEVOLUCAO_ANULACAO");
// O 104 chega negativo do ERP mas a classe não depende disso — se
// dependesse, um 104 positivo virava venda e somava na direcção errada.
check(
  classificarDocumento(104, G, 5) === "DEVOLUCAO_ANULACAO",
  "104 positivo continua reversão (a classe ignora o sinal)",
);
check(
  !CLASSIFICACAO[G].venda.has(104) && !CLASSIFICACAO[G].venda.has(27),
  "104 e 27 não entraram na lista de vendas por descuido",
);

// O circuito suspenso decide pelo sinal, e isso não pode mudar: o mesmo
// tipo serve a factura e a sua anulação.
check(classificarDocumento(107, S, 3) === "VENDA", "107 suspenso, quantidade > 0 → VENDA");
check(classificarDocumento(107, S, -3) === "DEVOLUCAO_ANULACAO", "107 suspenso, quantidade < 0 → reversão");
check(classificarDocumento(102, S, 1) === "VENDA", "102 suspenso, quantidade > 0 → VENDA");
check(classificarDocumento(102, S, 0) === null, "102 com quantidade zero → recusado (não é venda nem anulação)");
check(classificarDocumento(102, S, null) === null, "102 sem quantidade legível → recusado");
// O 77 é do circuito G. Declará-lo no suspenso seria ler a mesma venda
// duas vezes, que é o erro simétrico do que se está a corrigir.
check(
  classificarDocumento(77, S, 1) === null,
  "77 NÃO é aceite no circuito suspenso",
  "o 77 é do circuito G; aceitá-lo aqui duplicava a venda",
);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n3. Um tipo desconhecido continua a ser recusado\n${D}`);

check(classificarDocumento(999, G, 1) === null, "tipo 999 → recusado (não vira VENDA por defeito)");
check(classificarDocumento(null, G, 1) === null, "tipo nulo → recusado");
check(classificarDocumento(999, S, 1) === null, "tipo 999 no suspenso → recusado");
// Esta é a invariante que o ficheiro de regras defende por escrito:
// devolver VENDA para o desconhecido faria cada nota de crédito por
// declarar somar em vez de subtrair.
check(
  classificarDocumento(105, G, -2) === null,
  "um tipo de nota de crédito por declarar é recusado, não tratado como venda",
);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n4. Um dia com recusas anormais não pode fechar OK\n${D}`);

// O dia real. Este é o teste que dá nome ao ficheiro.
const principal0909 = avaliarSaudeVendas({
  salesRead: 1200,
  salesSkipped: 1117,
  tiposPorClassificar: [{ sourceNamespace: G, tipoDocumento: 77, linhas: 1090 }],
});
check(!principal0909.saudavel, "Principal 2026-09-09 (1117/1200) → NÃO saudável");
check(
  principal0909.motivo.includes("77"),
  "o motivo nomeia o tipo por declarar",
  `motivo: ${principal0909.motivo}`,
);
check(
  principal0909.motivo.includes("1117") && principal0909.motivo.includes("1200"),
  "o motivo traz as contagens dos dois lados",
);
check(
  Math.abs(principal0909.fraccaoSkipped - 1117 / 1200) < 1e-9,
  "a fracção é exacta e não arredondada para a decisão",
);

// Os cinco dias anteriores da mesma farmácia, todos igualmente perdidos.
for (const [lidas, recusadas] of [[780, 756], [885, 854], [701, 662], [922, 891], [1051, 1002]] as const) {
  check(
    !avaliarSaudeVendas({ salesRead: lidas, salesSkipped: recusadas }).saudavel,
    `Principal ${recusadas}/${lidas} → NÃO saudável`,
  );
}

// E os dias reais das farmácias saudáveis, que TÊM de continuar a fechar.
for (const [lidas, recusadas] of [[1342, 0], [1362, 1], [1492, 2], [743, 0], [681, 0]] as const) {
  check(
    avaliarSaudeVendas({ salesRead: lidas, salesSkipped: recusadas }).saudavel,
    `farmácia saudável ${recusadas}/${lidas} → fecha OK`,
  );
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n5. As fronteiras, e o que elas protegem\n${D}`);

check(
  avaliarSaudeVendas({ salesRead: 30, salesSkipped: 1 }).saudavel,
  "dia pequeno: 1 recusa em 30 (3,3%) fecha na mesma — piso absoluto",
  "sem o piso, cada sábado curto virava um falso alarme",
);
check(
  avaliarSaudeVendas({ salesRead: 100, salesSkipped: MINIMO_SKIPPED_ABSOLUTO - 1 }).saudavel,
  `${MINIMO_SKIPPED_ABSOLUTO - 1} recusas fecham (abaixo do piso), mesmo a 9%`,
);
check(
  !avaliarSaudeVendas({ salesRead: 100, salesSkipped: MINIMO_SKIPPED_ABSOLUTO }).saudavel,
  `${MINIMO_SKIPPED_ABSOLUTO} recusas em 100 (10%) já não fecham`,
);
// Exactamente no limiar fecha; um acima não. A fronteira é inclusiva.
check(
  avaliarSaudeVendas({ salesRead: 2000, salesSkipped: 20 }).saudavel,
  `exactamente ${(LIMIAR_SKIPPED_FRACCAO * 100).toFixed(0)}% (20/2000) → fecha`,
);
check(
  !avaliarSaudeVendas({ salesRead: 2000, salesSkipped: 21 }).saudavel,
  "um acima do limiar (21/2000) → não fecha",
);
check(
  avaliarSaudeVendas({ salesRead: 0, salesSkipped: 0 }).saudavel,
  "dia sem vendas nenhumas (feriado) → fecha, sem divisão por zero",
);
check(
  avaliarSaudeVendas({ salesRead: 1000, salesSkipped: 0 }).motivo === "nenhuma linha recusada",
  "dia limpo tem motivo explícito",
);
// Uma recusa dentro do limiar não degrada o dia, mas o tipo tem de
// aparecer na mesma — é assim que se apanha um tipo novo no início, com
// duas linhas, em vez de o apanhar dois anos depois com um milhão.
const toleradoComTipo = avaliarSaudeVendas({
  salesRead: 1400,
  salesSkipped: 12,
  tiposPorClassificar: [{ sourceNamespace: G, tipoDocumento: 88, linhas: 12 }],
});
check(toleradoComTipo.saudavel, "12 recusas em 1400 (0,86%) → fecha");
check(
  toleradoComTipo.motivo.includes("88"),
  "…e mesmo assim nomeia o tipo 88 no relatório",
  `motivo: ${toleradoComTipo.motivo}`,
);
// Tipo nulo é um caso real: o ERP pode devolver a coluna vazia.
check(
  avaliarSaudeVendas({
    salesRead: 500,
    salesSkipped: 400,
    tiposPorClassificar: [{ sourceNamespace: S, tipoDocumento: null, linhas: 400 }],
  }).motivo.includes("(nulo)"),
  "um tipo nulo é reportado como (nulo) e não desaparece",
);

console.log(`\n${D}`);
console.log(`${pass} passaram · ${fail} falharam`);
console.log(D);
process.exit(fail === 0 ? 0 : 1);
