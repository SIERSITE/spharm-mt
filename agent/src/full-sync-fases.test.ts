/**
 * agent/src/full-sync-fases.test.ts
 *
 * O onboarding: ordem das fases, retoma, skip e --force.
 *
 * ── O defeito que motivou a fase 7 ────────────────────────────────
 *
 * O full-sync terminava "9/9 sem erros" e o extrato de artigo ficava
 * VAZIO. Nenhuma das nove fases escrevia em `MovimentoArtigo` — as
 * primeiras seis alimentam agregados e as últimas três agregam-nos. A
 * farmácia via KPIs certos e um extrato em branco, e o relatório dizia
 * que estava tudo bem. Um teste que só contasse fases não apanhava
 * isto; o que o apanha é exigir que a ingestão dos movimentos exista e
 * receba a mesma janela das outras.
 *
 * ── Porque é que a retoma se testa aqui ───────────────────────────
 *
 * Verificar a retoma à mão exige uma corrida interrompida a meio e
 * outra a seguir, sobre uma base real. Como `decidirFase` é pura, cada
 * regra passa a ser uma linha — incluindo as que só aparecem depois de
 * uma falha, que são precisamente as que ninguém consegue reproduzir
 * quando precisa.
 *
 * Uso: npx tsx agent/src/full-sync-fases.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PHASE_ORDER,
  decidirFase,
  type PhaseId,
} from "./commands/full-sync.js";

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

const ids = PHASE_ORDER.map((p) => p.id);
const base = { halted: false, dryRun: false, force: false };

// ── 1. A fase existe e está no sítio certo ─────────────────────────

console.log("=== a ingestão de movimentos é uma fase do onboarding ===");
ok("existe a fase 'movimentos'", ids.includes("movimentos"));
eq("o onboarding tem 10 fases", ids.length, 10);
eq("nenhuma fase repetida", new Set(ids).size, ids.length);

// ÚLTIMA. É a posição que faz a diferença entre "uma falha no histórico
// de movimentos custa as agregações todas" e "custa só ela própria".
eq("movimentos é a última fase", ids[ids.length - 1], "movimentos");
for (const agg of ["agg-vendamensal", "agg-compras", "agg-devolucoes"] as PhaseId[]) {
  ok(`vem DEPOIS de ${agg}`, ids.indexOf("movimentos") > ids.indexOf(agg));
}
// Produtos primeiro: o canónico resolve produtoId via
// ProdutoFarmacia.externalProductId, e sem catálogo tudo fica órfão.
ok("produtos antes de movimentos", ids.indexOf("produtos") < ids.indexOf("movimentos"));

// A ordem completa, fixada. Uma fase inserida no meio sem pensar parte
// aqui — que é o sítio onde deve partir.
eq(
  "ordem exacta",
  ids.join(" → "),
  [
    "produtos",
    "stock",
    "vendas",
    "fornecedores",
    "compras",
    "devolucoes",
    "agg-vendamensal",
    "agg-compras",
    "agg-devolucoes",
    "movimentos",
  ].join(" → "),
);

// ── 2. O código da fase, lido do ficheiro ──────────────────────────
//
// Estas asserções leem o source em vez de invocar a fase, porque
// invocá-la exigiria um SQL Server e um SaaS. O que se está a fixar é o
// contrato: que comando é chamado e com que argumentos.

const fonte = readFileSync(
  path.join(import.meta.dirname, "commands", "full-sync.ts"),
  "utf8",
);
const faseMovimentos = fonte.slice(fonte.indexOf('await execPhase("movimentos"'));
ok("a fase existe no corpo do full-sync", fonte.includes('await execPhase("movimentos"'));
// A execução tem de estar DEPOIS das agregações no corpo, não só na
// PHASE_ORDER: é a ordem das chamadas que decide o que corre primeiro.
ok(
  "é executada depois da agregação de devoluções",
  fonte.indexOf('await execPhase("movimentos"') >
    fonte.indexOf('await execPhase("agg-devolucoes"'),
);

console.log("");
console.log("=== dry-run e upload usam os comandos provados ===");
ok("upload chama stocksmov-upload", /"stocksmov-upload"/.test(faseMovimentos));
ok("dry-run chama stocksmov-dry-run", /"stocksmov-dry-run"/.test(faseMovimentos));
// O mesmo padrão de compras/devoluções: o dry-run não é um caminho
// próprio, é o mesmo caminho com outro comando.
ok("a escolha é pelo dryRun", /dryRun \? "stocksmov-dry-run" : "stocksmov-upload"/.test(faseMovimentos));

console.log("");
console.log("=== a janela é a mesma das outras fases históricas ===");
// Passar `from`/`to` verbatim é o que garante que as seis fases cobrem
// o mesmo intervalo. Uma variável diferente aqui — `fromMov`, `ontem` —
// dava um extrato com outra janela sem ninguém dar por isso.
ok("passa --from", /"--from",\s*\n?\s*from,/.test(faseMovimentos));
ok("passa --to", /"--to",\s*\n?\s*to,/.test(faseMovimentos));
ok("não inventa outra janela", !/--since-id|hojeNaFarmacia|ontemNaFarmacia/.test(faseMovimentos));

console.log("");
console.log("=== stock snapshot e StocksMov continuam separados ===");
// O snapshot (fase 2) não tem janela temporal; os movimentos têm. Se um
// dia alguém passar --from/--to ao stock, ou tirar a janela aos
// movimentos, os dois conceitos voltam a misturar-se.
const faseStock = fonte.slice(
  fonte.indexOf('await execPhase("stock"'),
  fonte.indexOf('await execPhase("vendas"'),
);
ok("a fase stock não recebe janela", !/--from|--to|\bfrom\b|\bto\b/.test(faseStock));
ok("a fase stock usa runStockPipeline", /runStockPipeline/.test(faseStock));
ok("a fase movimentos NÃO usa runStockPipeline", !/runStockPipeline/.test(faseMovimentos));

// ── 3. Skip ───────────────────────────────────────────────────────

console.log("");
console.log("=== --only corre uma fase e salta as outras ===");
eq(
  "--only movimentos corre movimentos",
  decidirFase("movimentos", { ...base, only: "movimentos" }).correr,
  true,
);
const outra = decidirFase("vendas", { ...base, only: "movimentos" });
eq("--only movimentos salta vendas", outra.correr, false);
eq("… com o motivo certo", outra.correr === false ? outra.motivo : "", "--only outra fase");
// O halt continua a aplicar-se depois do --only. Na prática é
// inalcançável — com `--only X` as outras fases saem no primeiro
// return e nunca chegam a falhar, portanto `halted` nunca fica true.
// Fixado aqui para que a ordem das regras não mude por acidente.
eq(
  "--only não desliga o halt",
  decidirFase("movimentos", { ...base, only: "movimentos", halted: true }).correr,
  false,
);
eq(
  "--only da própria fase corre quando não há halt",
  decidirFase("movimentos", { ...base, only: "movimentos" }).correr,
  true,
);

console.log("");
console.log("=== halt-on-error trava as seguintes ===");
const travada = decidirFase("movimentos", { ...base, halted: true });
eq("fase seguinte não corre", travada.correr, false);
eq("… e diz porquê", travada.correr === false ? travada.motivo : "", "fase anterior falhou");
// O halt vem ANTES do estado: depois de uma falha nem se consulta o
// ficheiro.
eq(
  "halt ganha ao estado DONE",
  decidirFase("movimentos", { ...base, halted: true, estadoPersistido: "DONE" }).correr,
  false,
);

// ── 4. Retoma ─────────────────────────────────────────────────────

console.log("");
console.log("=== retoma: DONE salta, FAILED repete ===");
eq(
  "fase DONE não repete",
  decidirFase("movimentos", { ...base, estadoPersistido: "DONE" }).correr,
  false,
);
// A regra que faz a retoma ser retoma: a fase que ficou a meio volta a
// correr, as anteriores não.
eq(
  "fase FAILED volta a correr",
  decidirFase("movimentos", { ...base, estadoPersistido: "FAILED" }).correr,
  true,
);
eq(
  "fase sem estado corre",
  decidirFase("movimentos", { ...base, estadoPersistido: undefined }).correr,
  true,
);
// ── O cenário que motivou pôr a fase em último ────────────────────
//
// Onboarding longo: as nove primeiras correm, a décima morre a meio de
// meio milhão de linhas (rede, timeout, reinício da máquina). É o caso
// realista, e é o que decide se o operador perde uma noite de trabalho
// ou vinte minutos.

console.log("");
console.log("=== falha na fase 10: o que fica gravado ===");
type Estado = Partial<Record<PhaseId, "DONE" | "FAILED">>;

/** O ficheiro de estado depois de uma corrida que morreu na fase 10. */
const aposFalha: Estado = {
  produtos: "DONE",
  stock: "DONE",
  vendas: "DONE",
  fornecedores: "DONE",
  compras: "DONE",
  devolucoes: "DONE",
  "agg-vendamensal": "DONE",
  "agg-compras": "DONE",
  "agg-devolucoes": "DONE",
  movimentos: "FAILED",
};

// 1-9 continuam DONE. A falha da última não lhes toca — cada fase
// persiste o seu próprio resultado, não há estado global de corrida.
const noveDone = ids
  .filter((id) => id !== "movimentos")
  .every((id) => aposFalha[id] === "DONE");
ok("as 9 primeiras ficam DONE", noveDone);
eq("a fase 10 fica FAILED", aposFalha.movimentos, "FAILED");

console.log("");
console.log("=== a corrida seguinte retoma SÓ a fase 10 ===");
const retomadas = ids.filter(
  (id) => decidirFase(id, { ...base, estadoPersistido: aposFalha[id] }).correr,
);
eq("corre exactamente uma fase", retomadas.length, 1);
eq("… e é a dos movimentos", retomadas[0], "movimentos");
// O ponto todo de a fase ser a última: as agregações não se repetem.
ok(
  "nenhuma agregação se repete",
  !retomadas.some((id) => id.startsWith("agg-")),
);
ok(
  "nenhuma ingestão anterior se repete",
  !retomadas.some((id) => ["produtos", "stock", "vendas", "fornecedores", "compras", "devolucoes"].includes(id)),
);

// O contraste que justifica a posição: se a fase estivesse ANTES das
// agregações, o halt-on-error teria impedido as três — nenhuma chegava
// a DONE, e a retoma teria de as correr outra vez.
console.log("");
console.log("=== contraste: a mesma falha se a fase fosse a 7ª ===");
const seFosseSetima: PhaseId[] = [
  "produtos", "stock", "vendas", "fornecedores", "compras", "devolucoes",
  "movimentos", "agg-vendamensal", "agg-compras", "agg-devolucoes",
];
let travadoDali = false;
const estadoHipotetico: Estado = {};
for (const id of seFosseSetima) {
  if (travadoDali) continue; // halt-on-error: nem chegam a correr
  if (id === "movimentos") { estadoHipotetico[id] = "FAILED"; travadoDali = true; }
  else estadoHipotetico[id] = "DONE";
}
const aggsQuePerdiamos = ["agg-vendamensal", "agg-compras", "agg-devolucoes"].filter(
  (id) => estadoHipotetico[id as PhaseId] !== "DONE",
);
eq("as 3 agregações ficariam por correr", aggsQuePerdiamos.length, 3);
// Na ordem real isso não acontece.
eq(
  "na ordem real ficam todas DONE",
  ["agg-vendamensal", "agg-compras", "agg-devolucoes"].filter(
    (id) => aposFalha[id as PhaseId] !== "DONE",
  ).length,
  0,
);

console.log("");
console.log("=== --force depois da falha repete as 10 ===");
const comForce = ids.filter(
  (id) => decidirFase(id, { ...base, force: true, estadoPersistido: aposFalha[id] }).correr,
);
eq("--force corre as 10", comForce.length, 10);
eq("… incluindo a que falhou", comForce.includes("movimentos"), true);
eq("… e as 9 que estavam DONE", comForce.filter((id) => id !== "movimentos").length, 9);

// ── 5. --force ────────────────────────────────────────────────────

console.log("");
console.log("=== --force re-corre o que já estava DONE ===");
eq(
  "--force ignora DONE",
  decidirFase("movimentos", { ...base, force: true, estadoPersistido: "DONE" }).correr,
  true,
);
const todasComForce = ids.filter(
  (id) => decidirFase(id, { ...base, force: true, estadoPersistido: "DONE" }).correr,
);
eq("--force corre todas", todasComForce.length, ids.length);
// --force não desfaz o halt: uma falha continua a parar o pipeline.
eq(
  "--force não passa por cima do halt",
  decidirFase("movimentos", { ...base, force: true, halted: true }).correr,
  false,
);
// Nem por cima do --only.
eq(
  "--force não passa por cima do --only",
  decidirFase("vendas", { ...base, force: true, only: "movimentos" }).correr,
  false,
);

// ── 6. Dry-run ────────────────────────────────────────────────────

console.log("");
console.log("=== dry-run corre sempre tudo ===");
// Um preview que saltasse fases não seria um preview. O dry-run nem lê
// nem escreve o ficheiro de estado.
eq(
  "dry-run ignora DONE",
  decidirFase("movimentos", { dryRun: true, force: false, halted: false, estadoPersistido: "DONE" }).correr,
  true,
);
const todasEmDryRun = ids.filter(
  (id) => decidirFase(id, { dryRun: true, force: false, halted: false, estadoPersistido: "DONE" }).correr,
);
eq("dry-run corre todas", todasEmDryRun.length, ids.length);
eq(
  "dry-run respeita o halt",
  decidirFase("movimentos", { dryRun: true, force: false, halted: true }).correr,
  false,
);

// ── 7. O relatório mostra a fase nova ─────────────────────────────

console.log("");
console.log("=== o relatório não deixa cair nenhuma fase ===");
// printReport itera PHASE_ORDER (e não o que correu), portanto uma fase
// nunca alcançada aparece como SKIPPED em vez de desaparecer.
const relatorio = fonte.slice(fonte.indexOf("function printReport"));
ok("o relatório itera PHASE_ORDER", /for \(let i = 0; i < PHASE_ORDER\.length; i\+\+\)/.test(relatorio));
ok("… e não a lista do que correu", !/for \(const r of report\)/.test(relatorio));
ok("a fase tem rótulo legível", (PHASE_ORDER.find((p) => p.id === "movimentos")?.label ?? "").length > 0);
ok(
  "o rótulo diz de onde vêm os dados",
  /StocksMov/.test(PHASE_ORDER.find((p) => p.id === "movimentos")?.label ?? ""),
);

console.log("");
console.log(`${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
