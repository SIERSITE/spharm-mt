/**
 * scripts/tests/test-produto-run.ts
 *
 * Fixa as duas defesas do sweep que marca produtos como retirados.
 *
 * O cenário que isto impede, e que é a razão de tudo o resto: o agent
 * enviava um `runStartedAt` gerado no relógio da máquina da farmácia. Um
 * PC sem NTP adiantado alguns minutos punha esse corte à frente da hora
 * a que a base escreveu as linhas — e o sweep marcava como retirados os
 * 18 416 produtos que a corrida acabara de carregar, respondendo
 * `ok: true`. Sem erro, sem log suspeito, sem nada.
 *
 * Uso: npx tsx scripts/tests/test-produto-run.ts
 */
import {
  avaliarSweep,
  corridaAbandonada,
  MINUTOS_ATE_ABANDONO,
  SWEEP_MAX_FRACCAO,
  SWEEP_MIN_ABSOLUTO,
} from "../../lib/ingest/produto-run";

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string, d?: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); }
};

console.log("=== o caso real: corrida completa, nada a retirar ===");
check(
  avaliarSweep({ candidatos: 0, activosAntes: 18416, produtosRecebidos: 18416 }).permitir,
  "0 candidatos passa sempre",
);
check(
  avaliarSweep({ candidatos: 12, activosAntes: 18416, produtosRecebidos: 18416 }).permitir,
  "12 retirados em 18 416 é plausível",
);

console.log("\n=== corrida que morreu a meio não pode varrer o catálogo ===");
// 500 produtos entregues de 18 416: as 17 916 linhas não tocadas seriam
// marcadas como retiradas. É este o desastre silencioso.
const r = avaliarSweep({ candidatos: 17916, activosAntes: 18416, produtosRecebidos: 500 });
check(!r.permitir, "sweep de 97% é recusado");
check(r.motivo.includes("97"), "o motivo diz a percentagem", r.motivo);
check(r.motivo.includes("500"), "o motivo diz quantos produtos a corrida entregou", r.motivo);

console.log("\n=== corrida vazia não conclui nada ===");
// Ausência de observação não é observação de ausência.
check(
  !avaliarSweep({ candidatos: 100, activosAntes: 1000, produtosRecebidos: 0 }).permitir,
  "corrida sem produtos entregues é recusada",
);

console.log("\n=== os dois limiares têm de falhar juntos ===");
check(
  avaliarSweep({ candidatos: SWEEP_MIN_ABSOLUTO - 1, activosAntes: 600, produtosRecebidos: 100 }).permitir,
  `abaixo de ${SWEEP_MIN_ABSOLUTO} passa, mesmo em fracção alta (farmácia pequena)`,
);
check(
  avaliarSweep({ candidatos: 5000, activosAntes: 100000, produtosRecebidos: 95000 }).permitir,
  "fracção baixa passa, mesmo com muitos candidatos (limpeza real numa farmácia grande)",
);
check(
  !avaliarSweep({ candidatos: 600, activosAntes: 1000, produtosRecebidos: 400 }).permitir,
  "acima dos dois limiares é recusado",
);

console.log("\n=== fronteira exacta dos limiares ===");
const naFronteira = Math.floor(1000 * SWEEP_MAX_FRACCAO); // 200 = exactamente o limite
check(
  avaliarSweep({ candidatos: naFronteira, activosAntes: 1000, produtosRecebidos: 800 }).permitir,
  `${(SWEEP_MAX_FRACCAO * 100).toFixed(0)}% exactos passam (a recusa é > e não >=)`,
);

console.log("\n=== corridas abandonadas ===");
const base = new Date("2026-08-12T10:00:00Z");
const corrida = (minutosDesdeUltimoBatch: number) => ({
  id: "x",
  estado: "ABERTA",
  startedAtServer: base,
  lastBatchAtServer: new Date(base.getTime() - minutosDesdeUltimoBatch * 60_000),
});
check(!corridaAbandonada(corrida(1), base), "1 minuto sem batch continua viva");
check(!corridaAbandonada(corrida(MINUTOS_ATE_ABANDONO), base), "no limite ainda está viva");
check(corridaAbandonada(corrida(MINUTOS_ATE_ABANDONO + 1), base), "passado o limite é abandonada");
// Sem isto, uma corrida pendurada de ontem dava um corte antigo e o sweep
// deixava de detectar produtos retirados — falha silenciosa ao contrário.
check(corridaAbandonada(corrida(24 * 60), base), "de ontem é abandonada");

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
