/**
 * agent/src/pipelines-diarios.test.ts
 *
 * Prova que todos os pipelines transaccionais entram no ciclo diário, e
 * que os históricos usam a mesma fronteira.
 *
 * O defeito que isto fixa não se vê a ler nenhum ficheiro isolado: o
 * `daily-pipeline` cobria produtos, stock e vendas, e ninguém reparava
 * que compras, devoluções e movimentos ficavam congelados no dia do
 * bootstrap — o pipeline terminava OK todos os dias.
 *
 * Testa o CÓDIGO-FONTE, não o comportamento em execução, porque o que
 * está em causa é estrutural: um pipeline que desapareça do ciclo, ou um
 * `BETWEEN` que volte a aparecer numa query histórica.
 *
 * Uso: npx tsx agent/src/pipelines-diarios.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ler = (rel: string) => readFileSync(path.join(AQUI, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { pass++; console.log(`  [OK]    ${label}`); }
  else { fail++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

const dailyPipeline = ler("commands/daily-pipeline.ts");

console.log("=== o ciclo diário cobre todos os pipelines transaccionais ===");
// produtos, stock e vendas vêm do daily-sync (in-proc).
ok("produtos, stock e vendas via daily-sync", /runPipelineForDay/.test(dailyPipeline));
for (const cmd of ["compras-upload", "devolucoes-fornecedor-upload", "stocksmov-upload"]) {
  ok(`${cmd} entra no ciclo`, dailyPipeline.includes(cmd));
}
// A janela dos extras tem de ser o dia do pipeline, não outra coisa.
ok(
  "os extras correm com --from/--to no dia do pipeline",
  /"--from", date, "--to", date/.test(dailyPipeline),
);

console.log("\n=== o dia é o da farmácia, não UTC ===");
ok("usa ontemNaFarmacia", /ontemNaFarmacia/.test(dailyPipeline));
// A regressão provável: alguém repõe o cálculo em UTC por parecer mais
// simples. Em Lisboa no Verão isso atrasa o dia em 24h entre a meia-noite
// e a uma da manhã.
ok(
  "não voltou a calcular ontem em UTC",
  !/getUTCDate\(\)[\s\S]{0,200}24 \* 60 \* 60 \* 1000/.test(dailyPipeline),
);

console.log("\n=== fronteira única em todos os históricos ===");
const historicos: Array<[string, string]> = [
  ["vendas (bootstrap)", "commands/bootstrap-upload.ts"],
  ["vendas (daily-sync)", "commands/daily-sync.ts"],
  ["compras", "commands/compras.ts"],
  ["devoluções", "commands/devolucoes-fornecedor.ts"],
  ["movimentos", "commands/stocksmov.ts"],
];
for (const [label, rel] of historicos) {
  const src = ler(rel);
  ok(`${label}: usa a janela partilhada`, /janela\(|janelaDoDia\(/.test(src));
  // `BETWEEN @from AND @to` com fim a 23:59:59 perde o último segundo do
  // dia e volta a divergir dos outros pipelines.
  ok(`${label}: sem BETWEEN na janela temporal`, !/BETWEEN @from AND @to/.test(src));
  // Nenhum deve voltar a ligar datas como sql.DateTime a partir de um
  // instante UTC: em Lisboa no Verão a meia-noite UTC é 01:00 local, e a
  // primeira hora do dia caía do lado errado da fronteira.
  ok(
    `${label}: sem sql.DateTime com T00:00:00Z`,
    !/sql\.DateTime, new Date\(`\$\{(from|to)\}T00:00:00Z`\)/.test(src),
  );
}

console.log("\n=== o histórico recusa o dia aberto ===");
const fullSync = ler("commands/full-sync.ts");
ok("full-sync verifica se o dia ainda está aberto", /diaAindaAberto/.test(fullSync));
ok("existe escape explícito", /incluir-hoje/.test(fullSync));
// O escape tem de avisar: incluir hoje grava um dia parcial.
ok("o escape avisa que o dia está aberto", /INCOMPLETAS|ainda está aberto/.test(fullSync));

console.log("\n=== stock continua snapshot ===");
const bootstrap = ler("commands/bootstrap-upload.ts");
const stockSlice = bootstrap.slice(bootstrap.indexOf("runStockPipeline"));
// Limitar o stock a uma janela transformaria um snapshot num delta e
// deixaria o SaaS com existências desactualizadas para o resto.
ok(
  "o pipeline de stock não filtra por data",
  !/ArmazensStocks[\s\S]{0,400}(@from|@to|DataMov)/.test(stockSlice.slice(0, 3000)),
);

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
