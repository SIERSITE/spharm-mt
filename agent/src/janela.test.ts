/**
 * agent/src/janela.test.ts
 *
 * Fixa o contrato temporal da ingestão.
 *
 * O defeito que estes testes impedem de voltar: o mesmo `--to`
 * significava coisas diferentes conforme o pipeline. As vendas usavam
 * `BETWEEN … 23:59:59` e incluíam o dia; compras, devoluções e
 * movimentos usavam `< to` e excluíam-no. Uma corrida `--from 2026-08-01
 * --to 2026-08-11` gravava 11 dias de vendas e 10 de compras — e nenhum
 * dos dois estava "errado" isoladamente, que é o que fazia isto passar
 * despercebido.
 *
 * Uso: npx tsx agent/src/janela.test.ts
 */
import {
  diaAindaAberto,
  diaSeguinte,
  hojeNaFarmacia,
  janela,
  janelaDoDia,
  ontemNaFarmacia,
} from "./janela.js";

let pass = 0;
let fail = 0;
const eq = (label: string, obtido: unknown, esperado: unknown) => {
  if (obtido === esperado) { pass++; console.log(`  [OK]    ${label} (${String(obtido)})`); }
  else { fail++; console.log(`  [FALHA] ${label}: obtido "${String(obtido)}", esperado "${String(esperado)}"`); }
};
const ok = (label: string, cond: boolean) => eq(label, cond, true);

console.log("=== --to é inclusivo, e a fronteira é meio-aberta ===");
const j = janela("2026-08-01", "2026-08-11");
eq("início", j.inicio, "2026-08-01 00:00:00");
// A prova do contrato: o fim é o dia SEGUINTE ao pedido, exclusivo. É
// isto que faz o dia 11 entrar inteiro em TODOS os pipelines.
eq("fim exclusivo = dia seguinte", j.fimExclusivo, "2026-08-12 00:00:00");
// Uma venda às 23:59:59.500 do dia 11 cai dentro. Com BETWEEN … 23:59:59
// ficava de fora, e ninguém a procurava.
ok("o último segundo do dia 11 está dentro", "2026-08-11 23:59:59.500" < j.fimExclusivo);
ok("a meia-noite do dia 12 está fora", !("2026-08-12 00:00:00" < j.fimExclusivo));

console.log("\n=== um único dia ===");
const d = janelaDoDia("2026-08-11");
eq("início", d.inicio, "2026-08-11 00:00:00");
eq("fim", d.fimExclusivo, "2026-08-12 00:00:00");

console.log("\n=== mudança de mês e de ano ===");
eq("fim de mês (31 dias)", janela("2026-08-01", "2026-08-31").fimExclusivo, "2026-09-01 00:00:00");
eq("fim de mês (30 dias)", janela("2026-04-01", "2026-04-30").fimExclusivo, "2026-05-01 00:00:00");
eq("fim de ano", janela("2026-12-01", "2026-12-31").fimExclusivo, "2027-01-01 00:00:00");
eq("Fevereiro não-bissexto", diaSeguinte("2026-02-28"), "2026-03-01");
eq("Fevereiro bissexto", diaSeguinte("2028-02-28"), "2028-02-29");
eq("29 de Fevereiro bissexto", diaSeguinte("2028-02-29"), "2028-03-01");

console.log("\n=== horário de verão e de inverno em Portugal ===");
// As fronteiras são datas civis, não instantes: a mudança da hora não
// pode encolher nem esticar um dia da janela. Em 2026 o DST começa a
// 29/03 e acaba a 25/10.
eq("dia da mudança para a hora de verão", janelaDoDia("2026-03-29").fimExclusivo, "2026-03-30 00:00:00");
eq("dia da mudança para a hora de inverno", janelaDoDia("2026-10-25").fimExclusivo, "2026-10-26 00:00:00");

// O que interessa mesmo: "hoje" e "ontem" na farmácia, não em UTC.
// 00:30 locais de 12/08 (Verão, UTC+1) são 23:30 UTC de 11/08. Em UTC o
// "hoje" seria 11 e o "ontem" 10 — um dia inteiro atrasado.
const madrugadaVerao = new Date("2026-08-11T23:30:00Z");
eq("hoje às 00:30 locais de Agosto", hojeNaFarmacia(madrugadaVerao), "2026-08-12");
eq("ontem às 00:30 locais de Agosto", ontemNaFarmacia(madrugadaVerao), "2026-08-11");

// No Inverno Lisboa está em UTC, portanto os dois coincidem.
const madrugadaInverno = new Date("2026-01-11T23:30:00Z");
eq("hoje às 23:30 locais de Janeiro", hojeNaFarmacia(madrugadaInverno), "2026-01-11");
eq("ontem às 23:30 locais de Janeiro", ontemNaFarmacia(madrugadaInverno), "2026-01-10");

// Fronteira do próprio dia da mudança de hora.
eq("01:30 UTC de 29/03 já é 02:30 local", hojeNaFarmacia(new Date("2026-03-29T01:30:00Z")), "2026-03-29");
eq("ontem no dia da mudança", ontemNaFarmacia(new Date("2026-03-29T01:30:00Z")), "2026-03-28");

console.log("\n=== hoje é recusado ===");
const agora = new Date("2026-08-12T10:00:00Z"); // 11:00 em Lisboa
ok("hoje está aberto", diaAindaAberto("2026-08-12", agora));
ok("ontem está fechado", !diaAindaAberto("2026-08-11", agora));
// Uma data futura é ainda mais aberta do que hoje.
ok("amanhã está aberto", diaAindaAberto("2026-08-13", agora));
// À 00:30 local, "hoje" já mudou de dia — a recusa acompanha.
ok("00:30 locais: o dia novo já está aberto", diaAindaAberto("2026-08-12", new Date("2026-08-11T23:30:00Z")));

console.log("\n=== entradas inválidas não passam em silêncio ===");
for (const [label, fn] of [
  ["from posterior a to", () => janela("2026-08-11", "2026-08-01")],
  ["formato errado", () => janela("11-08-2026", "2026-08-11")],
  ["dia inexistente", () => diaSeguinte("2026-13-01")],
] as const) {
  let atirou = false;
  try { fn(); } catch { atirou = true; }
  ok(label, atirou);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
