/**
 * scripts/tests/test-operational-metrics.ts
 *
 * Testes unitários puros para `lib/operational/metrics-shared.ts`.
 * Sem rede, sem BD, sem Prisma — só lógica determinística.
 *
 * Cobre todos os casos extremos exigidos pelo plano da Fase 1 WS-A:
 *   · zero sales · ruptura · stock excessivo · produto novo
 *   · sazonalidade simples · inputs não-finitos
 *
 * Correr:
 *   npx tsx scripts/tests/test-operational-metrics.ts
 */

import {
  avgDaily,
  coverageDays,
  monthlyVelocity,
  rotationClass,
  stockRuptureRisk,
  suggestedOrderQty,
  computeProductMetrics,
  WINDOW_90D,
} from "../../lib/operational/metrics-shared";

const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function eq(actual: unknown, expected: unknown, msg: string): void {
  assert(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function eqNum(actual: number, expected: number, tol: number, msg: string): void {
  const diff = Math.abs(actual - expected);
  assert(diff <= tol, `${msg} — expected ${expected} ±${tol}, got ${actual}`);
}

// ─── avgDaily ──────────────────────────────────────────────────────────────

console.log("\navgDaily:");
eq(avgDaily(0, 90), 0, "zero sales → 0");
eq(avgDaily(90, 90), 1, "90 sales / 90 days → 1");
eq(avgDaily(45, 90), 0.5, "45 sales / 90 days → 0.5");
eq(avgDaily(10, 7), 10 / 7, "10 sales / 7 days → 10/7");
eq(avgDaily(100, 0), 0, "windowDays=0 → 0 (no divide by zero)");
eq(avgDaily(100, -5), 0, "negative window → 0");
eq(avgDaily(-10, 90), 0, "negative sales → 0");
eq(avgDaily(NaN, 90), 0, "NaN sales → 0");
eq(avgDaily(Infinity, 90), 0, "Infinity sales → 0");
eq(avgDaily(100, NaN), 0, "NaN window → 0");

// ─── coverageDays ──────────────────────────────────────────────────────────

console.log("\ncoverageDays:");
eq(coverageDays(0, 1), 0, "stock=0 → 0 (em rotura)");
eq(coverageDays(10, 1), 10, "stock=10, avg=1 → 10 dias");
eq(coverageDays(10, 0), null, "stock=10, avg=0 → null (sem demanda)");
eq(coverageDays(0, 0), 0, "stock=0, avg=0 → 0 (rotura tem precedência)");
eq(coverageDays(-5, 1), 0, "stock negativo → 0");
eq(coverageDays(10, -0.1), null, "avg negativa → null");
eq(coverageDays(NaN, 1), 0, "stock NaN → 0");
eq(coverageDays(10, NaN), null, "avg NaN → null");
eq(coverageDays(100, 2), 50, "stock=100, avg=2 → 50 dias");

// ─── monthlyVelocity ───────────────────────────────────────────────────────

console.log("\nmonthlyVelocity:");
eq(monthlyVelocity(0), 0, "avg=0 → 0");
eq(monthlyVelocity(1), 30, "avg=1 → 30 un/mês");
eq(monthlyVelocity(0.5), 15, "avg=0.5 → 15");
eq(monthlyVelocity(0.1), 3, "avg=0.1 → 3");
eq(monthlyVelocity(0.123), 3.7, "avg=0.123 → 3.7 (arredondado 1 casa)");
eq(monthlyVelocity(-1), 0, "avg negativa → 0");
eq(monthlyVelocity(NaN), 0, "avg NaN → 0");

// ─── rotationClass ─────────────────────────────────────────────────────────

console.log("\nrotationClass:");
eq(rotationClass(0.6, null), "alta", "avg=0.6 → alta");
eq(rotationClass(0.51, null), "alta", "avg=0.51 → alta");
eq(rotationClass(0.5, null), "media", "avg=0.5 (não estritamente >0.5) → media");
eq(rotationClass(0.2, null), "media", "avg=0.2 → media");
eq(rotationClass(0.11, null), "media", "avg=0.11 → media");
eq(rotationClass(0.1, null), "baixa", "avg=0.1 → baixa");
eq(rotationClass(0.05, null), "baixa", "avg=0.05 → baixa");
eq(rotationClass(0, null), "baixa", "avg=0 com daysSince=null → baixa");
eq(rotationClass(0, 30), "baixa", "avg=0 com daysSince=30 → baixa");
eq(rotationClass(0, 91), "estagnada", "avg=0 com daysSince=91 → estagnada");
eq(rotationClass(0, 365), "estagnada", "avg=0 com daysSince=365 → estagnada");

// ─── stockRuptureRisk ──────────────────────────────────────────────────────

console.log("\nstockRuptureRisk:");
eq(stockRuptureRisk(0, 1, 15), "rotura", "stock=0 → rotura");
eq(stockRuptureRisk(10, 0, 15), "indeterminado", "avg=0 → indeterminado");
eq(stockRuptureRisk(5, 1, 15), "baixa", "cov=5 < target/2=7.5 → baixa");
eq(stockRuptureRisk(7, 1, 15), "baixa", "cov=7 < target/2=7.5 → baixa");
eq(stockRuptureRisk(8, 1, 15), "estavel", "cov=8 > target/2=7.5 → estavel");
eq(stockRuptureRisk(15, 1, 15), "estavel", "cov=15 == target → estavel");
eq(stockRuptureRisk(45, 1, 15), "estavel", "cov=45 == target*3 → estavel (não excede)");
eq(stockRuptureRisk(50, 1, 15), "excesso", "cov=50 > target*3=45 → excesso");
eq(stockRuptureRisk(100, 0.1, 15), "excesso", "cov=1000 → excesso");
eq(stockRuptureRisk(0, 0, 15), "rotura", "stock=0 e avg=0 → rotura (precedência)");

// ─── suggestedOrderQty ─────────────────────────────────────────────────────

console.log("\nsuggestedOrderQty:");
eq(suggestedOrderQty(0, 0, 15), 0, "produto novo (stock=0, vel=0) → 0");
eq(suggestedOrderQty(10, 30, 15), 5, "stock=10, vel=30un/mês, target=15d → 5");
eq(suggestedOrderQty(30, 30, 15), 0, "stock=30, vel=30, target=15 (stock>alvo) → 0");
eq(suggestedOrderQty(0, 30, 15), 15, "stock=0, vel=30, target=15 → 15");
eq(suggestedOrderQty(0, 30, 30), 30, "stock=0, vel=30, target=30 → 30");
eq(suggestedOrderQty(0, 0, 15), 0, "vel=0, qualquer stock=0 → 0 (sem demanda)");
eq(suggestedOrderQty(100, 0, 15), 0, "stock excessivo, vel=0 → 0");
eq(suggestedOrderQty(-5, 30, 15), 15, "stock negativo trata como 0 → 15");
eq(suggestedOrderQty(0, 30, 0), 1, "target=0 promove-se para 1 (mín) → ceil(30/30 × 1)=1");

// ─── computeProductMetrics ─────────────────────────────────────────────────

console.log("\ncomputeProductMetrics:");
{
  const m = computeProductMetrics({
    produtoId: "p1",
    farmaciaId: "f1",
    windowDays: WINDOW_90D,
    salesQty: 90,
    stockAtual: 30,
    dataUltimaVenda: new Date(),
  });
  eq(m.avgDaily, 1, "salesQty=90, window=90 → avgDaily=1");
  eq(m.coverageDays, 30, "stock=30, avg=1 → coverage=30");
  eq(m.monthlyVelocity, 30, "vel=30");
  eq(m.rotationClass, "alta", "alta (>0.5)");
}
{
  // Produto novo: nunca vendeu, sem stock
  const m = computeProductMetrics({
    produtoId: "p2",
    farmaciaId: "f1",
    windowDays: WINDOW_90D,
    salesQty: 0,
    stockAtual: 0,
    dataUltimaVenda: null,
  });
  eq(m.avgDaily, 0, "produto novo → avgDaily=0");
  eq(m.coverageDays, 0, "produto novo (stock=0) → coverage=0");
  eq(m.monthlyVelocity, 0, "vel=0");
  eq(m.rotationClass, "baixa", "produto novo sem daysSince → baixa");
  eq(m.daysSinceLastSale, null, "daysSinceLastSale=null");
}
{
  // Stock excessivo + venda lenta
  const m = computeProductMetrics({
    produtoId: "p3",
    farmaciaId: "f1",
    windowDays: WINDOW_90D,
    salesQty: 9, // 0.1/dia
    stockAtual: 90,
    dataUltimaVenda: new Date(Date.now() - 5 * 86_400_000),
  });
  eq(m.avgDaily, 0.1, "9/90=0.1");
  eq(m.coverageDays, 900, "stock=90, avg=0.1 → 900 dias");
  eq(m.monthlyVelocity, 3, "vel=3");
  eq(m.rotationClass, "baixa", "avg=0.1 → baixa (não estritamente >0.1)");
  eq(m.daysSinceLastSale, 5, "5 dias desde venda");
}
{
  // Ruptura iminente
  const m = computeProductMetrics({
    produtoId: "p4",
    farmaciaId: "f1",
    windowDays: WINDOW_90D,
    salesQty: 180, // 2/dia
    stockAtual: 8,
    dataUltimaVenda: new Date(),
  });
  eq(m.avgDaily, 2, "180/90=2");
  eq(m.coverageDays, 4, "stock=8, avg=2 → 4 dias");
  eq(m.rotationClass, "alta", "avg=2 → alta");
  const risk = stockRuptureRisk(m.stockAtual, m.avgDaily, 15);
  eq(risk, "baixa", "cov=4 < target/2 → baixa risk");
}
{
  // Produto estagnado (sem vendas há muito tempo)
  const m = computeProductMetrics({
    produtoId: "p5",
    farmaciaId: "f1",
    windowDays: WINDOW_90D,
    salesQty: 0,
    stockAtual: 20,
    dataUltimaVenda: new Date(Date.now() - 200 * 86_400_000),
  });
  eq(m.avgDaily, 0, "sem vendas → avg=0");
  eq(m.coverageDays, null, "stock>0 mas avg=0 → null (sem demanda)");
  eq(m.rotationClass, "estagnada", "200d sem venda → estagnada");
  eq(m.daysSinceLastSale, 200, "daysSince=200");
}

// ─── Sazonalidade simples (curva crescente vs decrescente) ─────────────────

console.log("\nsazonalidade simples:");
{
  // Mesmo produto, dois períodos comparáveis: 30d antes vs 30d depois.
  // avgDaily deve ser sensível à fonte e à janela.
  const inverno = avgDaily(180, 30); // 6/dia (ex.: antigripal, Out-Dez)
  const verao = avgDaily(30, 30); // 1/dia (Jun-Ago)
  eq(inverno, 6, "inverno: 180/30=6/dia");
  eq(verao, 1, "verão: 30/30=1/dia");
  const coberturaInverno = coverageDays(30, inverno);
  const coberturaVerao = coverageDays(30, verao);
  eq(coberturaInverno, 5, "stock=30 sob procura de inverno → 5d");
  eq(coberturaVerao, 30, "stock=30 sob procura de verão → 30d");
  // Resultado operacional: o stock que dá 30d no verão dá apenas 5d no
  // inverno. A cobertura-alvo deveria ser ajustada pela sazonalidade.
  assert(
    coberturaInverno !== null &&
      coberturaVerao !== null &&
      coberturaInverno < coberturaVerao,
    "cobertura no inverno < cobertura no verão",
  );
}

// ─── Equivalência com o cálculo antigo (regressão) ─────────────────────────

console.log("\nregressão vs cálculo antigo:");
{
  // Cenário típico de encomendas-data: 90 vendas em 90 dias, stock=30
  // Antigo: avgDaily = 90/90 = 1; rotacaoMedia = round(1 * 30 * 10)/10 = 30
  //         cobertura = avgDaily>0 ? round(30/1) : (stock>0?999:0) = 30
  // Novo:   avgDaily(90, 90) = 1; monthlyVelocity(1) = 30
  //         coverageDays(30, 1) = 30; null → 999 no boundary
  const ad = avgDaily(90, 90);
  const rm = monthlyVelocity(ad);
  const cov = coverageDays(30, ad);
  const cobLegada = cov === null ? 999 : Math.round(cov);
  eq(ad, 1, "avgDaily=1");
  eq(rm, 30, "rotacaoMedia=30");
  eq(cobLegada, 30, "coberturaLegada=30");
}
{
  // Sem demanda (regression do fallback 999)
  const ad = avgDaily(0, 90);
  const cov = coverageDays(30, ad);
  const cobLegada = cov === null ? 999 : Math.round(cov);
  eq(cobLegada, 999, "sem demanda + stock>0 → 999 (legacy)");
}
{
  // Sem demanda e sem stock
  const ad = avgDaily(0, 90);
  const cov = coverageDays(0, ad);
  const cobLegada = cov === null ? 999 : Math.round(cov);
  eq(cobLegada, 0, "sem demanda e sem stock → 0");
}
{
  // Cenário transferencias-data: a Infinity-mask antiga
  const ad = avgDaily(0, 90);
  const cov = coverageDays(50, ad);
  const covInf = cov === null ? Infinity : cov;
  assert(!Number.isFinite(covInf), "cov sem demanda mapeia para Infinity (transferencias legacy)");
}

// ─── Resultado ─────────────────────────────────────────────────────────────

console.log("\n" + "─".repeat(60));
if (errors.length === 0) {
  console.log(`✅ Todos os testes passaram.`);
  process.exit(0);
} else {
  console.error(`❌ ${errors.length} falhas:`);
  for (const e of errors) console.error("   - " + e);
  process.exit(1);
}
