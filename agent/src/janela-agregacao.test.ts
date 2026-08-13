/**
 * agent/src/janela-agregacao.test.ts
 *
 * A fronteira entre o `--to` inclusivo do agent e o `to` exclusivo dos
 * endpoints de agregação.
 *
 * ── O que aconteceu na Silveirense a 2026-08-12 ───────────────────
 *
 * O ciclo diário chama `compras-upload --from D --to D`. A ingestão
 * aceita — `janela.ts` traduz para `>= D 00:00:00 AND < D+1 00:00:00`,
 * o dia inteiro. Mas o `aggregate-compras` que corre a seguir recebia
 * `from=D, to=D` e o servidor filtra `dataRecepcao >= from AND < to` —
 * uma janela VAZIA. O endpoint recusa:
 *
 *     400 invalid_window: from/to YYYY-MM-DD; from < to
 *
 * Resultado: 200 linhas de compras de 2026-08-12 ficaram em
 * `StagingCompraRawLine` e nunca chegaram a `Compra`.
 *
 * ── O caso pior, que não dá erro nenhum ───────────────────────────
 *
 * O mesmo defeito no histórico não grita: `--from A --to B` passa a
 * validação (A < B) e o dia B fica silenciosamente de fora. O full-sync
 * terminava "sem erros" com o último dia da janela por agregar. É esse
 * o caso que estes testes fixam com mais cuidado — o outro denuncia-se
 * sozinho.
 *
 * Uso: npx tsx agent/src/janela-agregacao.test.ts
 */
import { diaSeguinte, fimExclusivoDoDia, janela } from "./janela.js";

let pass = 0;
let fail = 0;
const eq = (label: string, obtido: unknown, esperado: unknown) => {
  if (obtido === esperado) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}: obtido "${String(obtido)}", esperado "${String(esperado)}"`);
  }
};
const ok = (label: string, cond: boolean) => eq(label, cond, true);

/** A validação do servidor, copiada de app/api/admin/pipeline/aggregate-*. */
function servidorAceita(from: string, to: string): boolean {
  return Date.parse(`${from}T00:00:00Z`) < Date.parse(`${to}T00:00:00Z`);
}

/** O filtro do servidor: `data >= from AND data < to`. */
function servidorInclui(dia: string, from: string, to: string): boolean {
  const d = Date.parse(`${dia}T00:00:00Z`);
  return d >= Date.parse(`${from}T00:00:00Z`) && d < Date.parse(`${to}T00:00:00Z`);
}

// ── 1. Janela de UM ÚNICO DIA (o ciclo diário) ────────────────────

console.log("=== janela de um único dia ===");
const D = "2026-08-12";
eq("o dia seguinte é o fim exclusivo", fimExclusivoDoDia(D), "2026-08-13");
// Sem a tradução, o servidor recusava.
ok("SEM tradução o servidor recusa", !servidorAceita(D, D));
ok("COM tradução o servidor aceita", servidorAceita(D, fimExclusivoDoDia(D)));
ok("e o dia D fica DENTRO", servidorInclui(D, D, fimExclusivoDoDia(D)));
ok("o dia seguinte fica FORA", !servidorInclui("2026-08-13", D, fimExclusivoDoDia(D)));
ok("o dia anterior fica FORA", !servidorInclui("2026-08-11", D, fimExclusivoDoDia(D)));

// ── 2. Compras com linhas nesse dia ───────────────────────────────

console.log("");
console.log("=== compras: as 200 linhas de 2026-08-12 ===");
// Reproduz o caso real. As linhas estão em staging com dataRecepcao=D.
const linhasCompras = Array.from({ length: 200 }, () => ({ dataRecepcao: D }));
const janelaSemFix = { from: D, to: D };
const janelaComFix = { from: D, to: fimExclusivoDoDia(D) };
eq(
  "sem a correcção: 0 linhas agregadas (e 400 antes disso)",
  linhasCompras.filter((l) => servidorInclui(l.dataRecepcao, janelaSemFix.from, janelaSemFix.to)).length,
  0,
);
eq(
  "com a correcção: as 200 entram",
  linhasCompras.filter((l) => servidorInclui(l.dataRecepcao, janelaComFix.from, janelaComFix.to)).length,
  200,
);

// ── 3. Devoluções: zero linhas e com linhas ───────────────────────

console.log("");
console.log("=== devoluções: zero linhas ===");
// Um dia sem devoluções não pode ser um erro. A janela é válida, a
// agregação corre e devolve zero — que é diferente de "falhou".
const semDevolucoes: Array<{ dataDevolucao: string }> = [];
ok("a janela continua válida", servidorAceita(D, fimExclusivoDoDia(D)));
eq(
  "zero linhas agregadas, sem erro",
  semDevolucoes.filter((l) => servidorInclui(l.dataDevolucao, D, fimExclusivoDoDia(D))).length,
  0,
);

console.log("");
console.log("=== devoluções: com linhas ===");
const comDevolucoes = [
  { dataDevolucao: "2026-08-11" }, // véspera — fora
  { dataDevolucao: D },
  { dataDevolucao: D },
  { dataDevolucao: "2026-08-13" }, // dia seguinte — fora
];
eq(
  "só as do dia entram",
  comDevolucoes.filter((l) => servidorInclui(l.dataDevolucao, D, fimExclusivoDoDia(D))).length,
  2,
);

// ── 4. Janela histórica: o último dia deixa de se perder ──────────

console.log("");
console.log("=== janela histórica: o último dia entra ===");
const A = "2026-08-01";
const B = "2026-08-11";
// O bug silencioso: a validação passava e o dia B ficava de fora.
ok("sem tradução o servidor ACEITA (não grita)", servidorAceita(A, B));
ok("...mas o dia B ficava FORA", !servidorInclui(B, A, B));
ok("com tradução o dia B entra", servidorInclui(B, A, fimExclusivoDoDia(B)));
ok("e B+1 continua fora", !servidorInclui("2026-08-12", A, fimExclusivoDoDia(B)));
// Todos os dias pedidos entram, nenhum a mais.
const pedidos = ["2026-08-01", "2026-08-05", "2026-08-10", "2026-08-11"];
eq(
  "a janela cobre o intervalo inteiro",
  pedidos.filter((d) => servidorInclui(d, A, fimExclusivoDoDia(B))).length,
  pedidos.length,
);

// ── 5. Uma regra só, não duas ─────────────────────────────────────

console.log("");
console.log("=== a conversão não é uma segunda regra ===");
// `fimExclusivoDoDia` e o `fimExclusivo` da `janela()` têm de descrever
// a mesma fronteira. Se divergirem, a ingestão e a agregação passam a
// cobrir intervalos diferentes — e isso não dá erro, dá números
// diferentes.
for (const dia of ["2026-08-12", "2026-01-31", "2026-02-28", "2024-02-29", "2026-12-31"]) {
  const daJanela = janela(dia, dia).fimExclusivo.slice(0, 10);
  eq(`${dia}: a mesma fronteira que janela()`, fimExclusivoDoDia(dia), daJanela);
}
eq("é o mesmo que diaSeguinte", fimExclusivoDoDia("2026-08-12"), diaSeguinte("2026-08-12"));

// Fronteiras de calendário.
eq("fim do mês", fimExclusivoDoDia("2026-01-31"), "2026-02-01");
eq("fim do ano", fimExclusivoDoDia("2026-12-31"), "2027-01-01");
eq("ano bissexto", fimExclusivoDoDia("2024-02-28"), "2024-02-29");
eq("29 de Fevereiro", fimExclusivoDoDia("2024-02-29"), "2024-03-01");
// Data inválida não passa em silêncio.
let rejeitou = false;
try {
  fimExclusivoDoDia("2026-02-30");
} catch {
  rejeitou = true;
}
ok("data inexistente é recusada", rejeitou);

console.log("");
console.log(`${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
