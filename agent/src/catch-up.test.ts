/**
 * agent/src/catch-up.test.ts
 *
 * Os dias que o pipeline diário deve à farmácia.
 *
 * ── O defeito que estes testes impedem de voltar ──────────────────
 *
 * O diário processava `ontem` e mais nada. Um PC desligado às 03:00
 * perdia um dia para sempre: a corrida seguinte calculava "ontem" outra
 * vez, que já era outro dia, e ninguém procurava o que faltava. O sinal
 * era um "Last Run Result: 0" no Task Scheduler do PC da farmácia — ou
 * seja, nenhum sinal.
 *
 * O caso que mais custa a apanhar não é o dia perdido no fim: é o
 * BURACO NO MEIO. Se o dia 10 falha e os dias 11 e 12 correm, um cursor
 * do tipo "último dia OK" fica em 12 e dá o 10 por feito. É por isso
 * que a fonte de verdade é o conjunto dos dias concluídos e não um
 * ponteiro.
 *
 * Uso: npx tsx agent/src/catch-up.test.ts
 */
import {
  deslocarDia,
  diasEntre,
  janelaConsulta,
  planearCatchUp,
} from "./catch-up.js";
import { PIPELINES_DIARIOS_EXTRA } from "./commands/daily-pipeline.js";

let pass = 0;
let fail = 0;
const eq = (label: string, obtido: unknown, esperado: unknown) => {
  const a = JSON.stringify(obtido);
  const b = JSON.stringify(esperado);
  if (a === b) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}: obtido ${a}, esperado ${b}`);
  }
};
const ok = (label: string, cond: boolean) => eq(label, cond, true);

const ONTEM = "2026-08-12";

// ── Aritmética de dias ─────────────────────────────────────────────

console.log("=== aritmética civil de dias ===");
eq("dia seguinte", deslocarDia("2026-08-12", 1), "2026-08-13");
eq("dia anterior", deslocarDia("2026-08-12", -1), "2026-08-11");
eq("atravessa o mês", deslocarDia("2026-08-01", -1), "2026-07-31");
eq("atravessa o ano", deslocarDia("2026-01-01", -1), "2025-12-31");
eq("ano bissexto", deslocarDia("2024-02-28", 1), "2024-02-29");
// A mudança da hora em Portugal: 29-03-2026 tem 23 h e 25-10-2026 tem
// 25 h. Com aritmética em hora local, uma soma de 24 h saltava ou
// repetia o dia — e o catch-up pedia o dia errado duas vezes por ano.
eq("dia de 23 horas (março)", deslocarDia("2026-03-29", 1), "2026-03-30");
eq("dia de 25 horas (outubro)", deslocarDia("2026-10-25", 1), "2026-10-26");
eq("intervalo inclusivo", diasEntre("2026-08-10", "2026-08-12"), ["2026-08-10", "2026-08-11", "2026-08-12"]);
eq("intervalo de um dia", diasEntre(ONTEM, ONTEM), [ONTEM]);
eq("intervalo invertido é vazio", diasEntre("2026-08-12", "2026-08-10"), []);

// ── 1. Execução normal: só ontem ───────────────────────────────────

console.log("");
console.log("=== execução normal (nada em atraso) ===");
const normal = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-09", "2026-08-10", "2026-08-11"],
  maxDias: 7,
});
eq("corre só ontem", normal.dias, [ONTEM]);
eq("nada adiado", normal.adiados, []);
ok("o resumo diz que é normal", normal.resumo.includes("Corrida normal"));

console.log("");
console.log("=== nada a fazer (ontem já concluído) ===");
const nada = planearCatchUp({ ontem: ONTEM, diasOk: [ONTEM, "2026-08-11"], maxDias: 7 });
eq("não corre nada", nada.dias, []);
ok("diz que está concluído", nada.resumo.includes("Nada a recuperar"));

// ── 2. Um dia em falta ─────────────────────────────────────────────

console.log("");
console.log("=== 1 dia em falta (PC desligado numa noite) ===");
const umDia = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-09", "2026-08-10"],
  maxDias: 7,
});
eq("corre o dia perdido e ontem", umDia.dias, ["2026-08-11", ONTEM]);
// Cronológica: o dia 11 antes do 12. A agregação mensal é reescrita a
// cada dia, e correr por ordem inversa deixaria o mês com o penúltimo
// dia por cima do último.
eq("por ordem cronológica", umDia.dias, [...umDia.dias].sort());

// ── 3. Vários dias em falta ────────────────────────────────────────

console.log("");
console.log("=== vários dias em falta (férias / avaria) ===");
// O PC esteve desligado de 07 a 11. O ultimo registo e de 06.
const varios = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-05", "2026-08-06"],
  maxDias: 7,
});
eq("recupera os 6 dias em falta", varios.dias, [
  "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", ONTEM,
]);
eq("ordenado", varios.dias, [...varios.dias].sort());
eq("nada adiado (cabe no limite)", varios.adiados, []);

console.log("");
console.log("=== sem histórico nenhum: nao inventa trabalho ===");
// `diasOk` vazio depois de olhar 90 dias para tras significa instalacao
// nova ou farmacia parada ha muito. Ancorar em `ontem - maxDias` fazia
// uma instalacao nova reprocessar uma semana na primeira noite, e uma
// farmacia saudavel repeti-lo todas as noites enquanto o historico
// fosse mais curto do que o limite.
const semHistorico = planearCatchUp({ ontem: ONTEM, diasOk: [], maxDias: 7 });
eq("corre so ontem", semHistorico.dias, [ONTEM]);
ok("e explica porque", semHistorico.resumo.includes("Sem registo"));
ok("aponta o caminho manual", semHistorico.resumo.includes("--date"));

console.log("");
console.log("=== a recuperacao comeca no historico, nao no limite ===");
// Farmacia saudavel cujo registo so existe desde 11 (o endpoint de
// record so passou a funcionar entao). Nao deve propor 06-10.
const historicoCurto = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-11"],
  maxDias: 7,
});
eq("so ontem", historicoCurto.dias, [ONTEM]);
ok("nao propoe dias anteriores ao historico", !historicoCurto.dias.includes("2026-08-06"));

console.log("");
console.log("=== o BURACO NO MEIO (o caso que um cursor não vê) ===");
// Um cursor "último dia OK" ficaria em 12 e o dia 10 nunca mais era
// processado. O conjunto vê-o.
const buraco = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-09", "2026-08-11", ONTEM],
  maxDias: 7,
});
eq("apanha o dia do meio", buraco.dias, ["2026-08-10"]);
ok("não repete os que estão OK", !buraco.dias.includes("2026-08-11"));
ok("nem ontem", !buraco.dias.includes(ONTEM));

console.log("");
console.log("=== limite por execução, sem perder dias em silêncio ===");
// 6 dias em falta, limite de 3.
const limitado = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-05", "2026-08-06"],
  maxDias: 3,
});
eq("corre o máximo", limitado.dias.length, 3);
eq("os mais antigos primeiro", limitado.dias, ["2026-08-07", "2026-08-08", "2026-08-09"]);
eq("adia os restantes", limitado.adiados, ["2026-08-10", "2026-08-11", ONTEM]);
// NUNCA em silêncio: o resumo conta-os e nomeia as pontas.
ok("diz quantos ficaram", limitado.resumo.includes("MAIS 3 dia(s)"));
ok("nomeia o primeiro adiado", limitado.resumo.includes("2026-08-10"));
ok("e o ultimo", limitado.resumo.includes(ONTEM));
// Nenhum dia se perde entre os dois grupos.
eq(
  "processados + adiados = todos os que faltam",
  [...limitado.dias, ...limitado.adiados],
  ["2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", ONTEM],
);
// A corrida seguinte apanha os adiados.
const seguinte = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-05", "2026-08-06", ...limitado.dias],
  maxDias: 3,
});
eq("a seguinte continua onde parou", seguinte.dias, limitado.adiados);

// ── 4. Falha no dia intermédio ─────────────────────────────────────

console.log("");
console.log("=== falha no dia intermédio: pára, não salta ===");
// Simula o que o comando faz: percorre o plano e pára no primeiro erro.
function correrPlano(dias: string[], diaQueFalha: string): { corridos: string[]; parouEm: string | null } {
  const corridos: string[] = [];
  for (const d of dias) {
    if (d === diaQueFalha) return { corridos, parouEm: d };
    corridos.push(d);
  }
  return { corridos, parouEm: null };
}
const plano = planearCatchUp({ ontem: ONTEM, diasOk: ["2026-08-07"], maxDias: 5 }).dias;
eq("plano de 5 dias", plano, ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", ONTEM]);
const exec = correrPlano(plano, "2026-08-10");
eq("processou os anteriores", exec.corridos, ["2026-08-08", "2026-08-09"]);
eq("parou no que falhou", exec.parouEm, "2026-08-10");
ok("NÃO saltou para os seguintes", !exec.corridos.includes("2026-08-11") && !exec.corridos.includes(ONTEM));

// A corrida seguinte: os dois primeiros já estão OK no SaaS, portanto
// retoma exactamente no que falhou.
const retoma = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-07", "2026-08-08", "2026-08-09"],
  maxDias: 5,
});
eq("retoma no dia que falhou", retoma.dias[0], "2026-08-10");
eq("e continua até ontem", retoma.dias, ["2026-08-10", "2026-08-11", ONTEM]);

// ── 5. Idempotência ────────────────────────────────────────────────

console.log("");
console.log("=== repetir o catch-up é seguro ===");
// Depois de uma corrida bem sucedida, os dias ficam OK no SaaS e a
// corrida seguinte não os repete. É isto que torna a tarefa do Windows
// segura de disparar as vezes que forem precisas.
const antes = planearCatchUp({ ontem: ONTEM, diasOk: ["2026-08-09"], maxDias: 7 });
const depois = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-09", ...antes.dias],
  maxDias: 7,
});
eq("segunda corrida não faz nada", depois.dias, []);
// E uma terceira também não.
const terceira = planearCatchUp({
  ontem: ONTEM,
  diasOk: ["2026-08-09", ...antes.dias],
  maxDias: 7,
});
eq("terceira também não", terceira.dias, []);
// O planeamento é puro: os mesmos dados dão o mesmo plano.
eq("determinístico", planearCatchUp({ ontem: ONTEM, diasOk: ["2026-08-07"], maxDias: 4 }).dias,
   planearCatchUp({ ontem: ONTEM, diasOk: ["2026-08-07"], maxDias: 4 }).dias);

console.log("");
console.log("=== a janela consultada cobre o que o plano considera ===");
// Se a consulta pedisse menos dias do que o plano considera, os dias
// não devolvidos passavam por "não concluídos" e voltavam a correr.
for (const max of [1, 3, 7, 30]) {
  const j = janelaConsulta(ONTEM, max);
  const considerados = planearCatchUp({
    ontem: ONTEM,
    diasOk: ["2026-07-20"],
    maxDias: max,
  }).dias;
  ok(
    `max=${max}: a consulta cobre o plano`,
    considerados.every((d) => d >= j.from && d <= j.to),
  );
}
eq("a janela termina em ontem", janelaConsulta(ONTEM, 7).to, ONTEM);
// O lookback e independente do limite de processamento: uma janela
// curta faria uma farmacia parada ha duas semanas parecer instalacao
// nova, e o planeador escolheria o caminho conservador quando havia
// mesmo dias a recuperar.
eq("lookback fixo de 90 dias", janelaConsulta(ONTEM, 7).from, deslocarDia(ONTEM, -89));
eq("nao depende de maxDias", janelaConsulta(ONTEM, 1).from, janelaConsulta(ONTEM, 30).from);

// ── 6. Fornecedores antes das compras ──────────────────────────────

console.log("");
console.log("=== fornecedor novo entra antes da compra que o usa ===");
const labels = PIPELINES_DIARIOS_EXTRA.map((p) => p.label);
ok("fornecedores corre no diário", labels.includes("fornecedores"));
// A ordem é a correcção: a agregação de compras resolve fornecedorId
// via FornecedorErpRef. Um fornecedor criado no ERP depois do
// onboarding não tem essa referência, e a primeira compra que lhe seja
// feita fica órfã — sem erro visível, porque o pipeline termina OK.
ok(
  "ANTES das compras",
  labels.indexOf("fornecedores") < labels.indexOf("compras"),
);
ok(
  "antes das devoluções (mesma resolução de fornecedor)",
  labels.indexOf("fornecedores") < labels.indexOf("devoluções"),
);
eq("é o primeiro dos extra", labels[0], "fornecedores");

// O catálogo de fornecedores é um snapshot, não um intervalo: um
// fornecedor criado ontem e usado hoje tem de entrar. Passar-lhe
// --from/--to não seria sequer ignorado — o parseArgs corre com
// strict:true e rebentava com "unknown option".
const fornecedores = PIPELINES_DIARIOS_EXTRA.find((p) => p.label === "fornecedores");
eq("fornecedores sem janela", fornecedores?.janela, false);
for (const p of PIPELINES_DIARIOS_EXTRA.filter((x) => x.label !== "fornecedores")) {
  ok(`${p.label} com janela do dia`, p.janela === true);
}
eq("comando certo", fornecedores?.cmd, "fornecedores-upload");

console.log("");
console.log(`${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
