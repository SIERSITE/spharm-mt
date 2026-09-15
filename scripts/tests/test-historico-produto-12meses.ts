/**
 * scripts/tests/test-historico-produto-12meses.ts
 *
 * Bloco A — histórico de 12 meses por linha da encomenda.
 *
 * ── O que isto fixa ───────────────────────────────────────────────────
 *
 * `buildHistoricoSeries` (lib/encomendas/historico-produto.ts) é a parte
 * PURA da agregação — recebe linhas mensais já somadas (o que viria do
 * `$queryRaw` sobre `MovimentoArtigo`) e produz as séries por farmácia
 * que o modal mostra: 12 meses zero-preenchidos, `avgDaily` /
 * `monthlyVelocity` / `coverageDays` CANÓNICOS (lib/operational/
 * metrics-shared.ts, não reimplementados), e o flag `temLedger` que
 * distingue "sem movimento real" de "sem ledger ingerido nesta
 * farmácia".
 *
 * Cobre com fixtures sintéticas:
 *   A. classificação compras (só COMPRA) vs vendas líquidas
 *      (VENDA − DEVOLUCAO_CLIENTE, podendo ser negativa);
 *   B. janela de 12 meses — meses fora da janela (antes do início, e o
 *      mês corrente parcial) NÃO contaminam os buckets nem a média;
 *   C. zero-preenchimento — mês sem linha aparece a 0, não desaparece;
 *   D. por farmácia — cada farmácia tem a sua série, sem vazamento
 *      entre farmácias nem de farmácias não pedidas;
 *   E. `temLedger` por farmácia, `stockAtual` null quando sem ficha,
 *      `avgDaily`/`monthlyVelocity`/`coverageDays` batem com as fórmulas
 *      canónicas chamadas directamente (mesmos inputs);
 *   F. round-trip de `periodKey`/`keyToAnoMes`;
 *   G. wiring — auth (mesmo padrão das outras actions de encomendas),
 *      componentes ligados nos dois ecrãs (criação e detalhe), e que o
 *      modal não navega nem é pré-carregado em massa.
 *
 * Sem base de dados e sem rede — `buildHistoricoSeries` é pura; o
 * `$queryRaw`/Prisma de `getHistoricoProduto12Meses` não é exercitado
 * aqui (precisa de Postgres — ver nota no relatório final sobre
 * acessibilidade da BD neste ambiente).
 *
 * Uso: npx tsx scripts/tests/test-historico-produto-12meses.ts
 */
import { readFileSync } from "node:fs";
import {
  avgDaily,
  coverageDays,
  monthlyVelocity,
  WINDOW_90D,
} from "../../lib/operational/metrics-shared";
import {
  buildHistoricoSeries,
  keyToAnoMes,
  periodKey,
  type HistoricoMovRow,
} from "../../lib/encomendas/historico-produto-tipos";

let pass = 0;
let fail = 0;
const ok = (l: string) => {
  pass++;
  console.log(`  [OK]    ${l}`);
};
const bad = (l: string, d?: string) => {
  fail++;
  console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`);
};
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), l, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

const src = (p: string) => readFileSync(p, "utf8");

// ═════════════════════════════════════════════════════════════════════
// F. periodKey / keyToAnoMes — round-trip
// ═════════════════════════════════════════════════════════════════════
console.log("\nF. periodKey/keyToAnoMes\n");

for (const [ano, mes] of [
  [2026, 1],
  [2026, 9],
  [2026, 12],
  [2025, 1],
  [2000, 6],
]) {
  const key = periodKey(ano, mes);
  eq(keyToAnoMes(key), { ano, mes }, `round-trip (${ano}-${String(mes).padStart(2, "0")})`);
}
eq(periodKey(2026, 9) - periodKey(2025, 9), 12, "um ano de diferença = 12 chaves");

// ═════════════════════════════════════════════════════════════════════
// Fixture comum: "agora" = Setembro/2026 → janela Set/25..Ago/26
// ═════════════════════════════════════════════════════════════════════
const PERIOD_END_KEY = periodKey(2026, 9); // mês corrente, exclusivo

const FA = "farmacia-a";
const FB = "farmacia-b";
const FC = "farmacia-c"; // pedida mas sem nenhuma linha/stock/ledger
const FX = "farmacia-nao-pedida"; // tem linhas mas não está em farmaciaIds

const movRows: HistoricoMovRow[] = [
  // fA — dentro da janela
  { farmaciaId: FA, ano: 2025, mes: 9, compras: 10, vendas: 5 }, // primeiro mês da janela
  { farmaciaId: FA, ano: 2026, mes: 7, compras: 0, vendas: 80 },
  { farmaciaId: FA, ano: 2026, mes: 8, compras: 50, vendas: 120 }, // último mês completo

  // fA — FORA da janela, não pode contaminar nada
  { farmaciaId: FA, ano: 2025, mes: 8, compras: 999, vendas: 999 }, // antes do início
  { farmaciaId: FA, ano: 2026, mes: 9, compras: 777, vendas: 777 }, // mês corrente parcial

  // fB — mais devoluções que vendas no mês: net negativo
  { farmaciaId: FB, ano: 2026, mes: 8, compras: 0, vendas: -10 },

  // fX — farmácia que não foi pedida
  { farmaciaId: FX, ano: 2026, mes: 8, compras: 500, vendas: 500 },
];

const nomeById = new Map([
  [FA, "Farmácia A"],
  [FB, "Farmácia B"],
  // FC deliberadamente ausente — testa fallback "—"
]);
const stockById = new Map<string, number | null>([
  [FA, 100],
  [FB, 0],
  // FC ausente — testa fallback null
]);
const ledgerById = new Map([
  [FA, true],
  [FB, false],
  // FC ausente — testa fallback false
]);

const series = buildHistoricoSeries({
  farmaciaIds: [FA, FB, FC],
  movRows,
  nomeById,
  stockById,
  ledgerById,
  periodEndKey: PERIOD_END_KEY,
});

const byId = new Map(series.map((s) => [s.farmaciaId, s]));
const a = byId.get(FA)!;
const b = byId.get(FB)!;
const c = byId.get(FC)!;

// ═════════════════════════════════════════════════════════════════════
// A. Classificação: compras (só COMPRA) vs vendas líquidas
// ═════════════════════════════════════════════════════════════════════
console.log("\nA. Compras vs vendas líquidas\n");

{
  const ago26 = a.meses.find((m) => m.ano === 2026 && m.mes === 8)!;
  eq(ago26.compras, 50, "Ago/26 fA: compras = tipo COMPRA");
  eq(ago26.vendas, 120, "Ago/26 fA: vendas = VENDA − DEVOLUCAO_CLIENTE (aqui só VENDA)");
}
{
  const ago26b = b.meses.find((m) => m.ano === 2026 && m.mes === 8)!;
  eq(ago26b.compras, 0, "Ago/26 fB: sem compras");
  eq(ago26b.vendas, -10, "Ago/26 fB: net NEGATIVO preservado — mais devolução que venda");
}

// ═════════════════════════════════════════════════════════════════════
// B. Janela de 12 meses — não vaza para fora
// ═════════════════════════════════════════════════════════════════════
console.log("\nB. A janela de 12 meses exclui o que é anterior e o mês corrente\n");

{
  eq(a.meses.length, 12, "12 buckets exactos, nem 13 nem 11");
  eq(a.meses[0], { ano: 2025, mes: 9, label: "Set 25", compras: 10, vendas: 5 }, "primeiro mês da janela é Set/25 — Ago/25 (999/999) NÃO entra");
  eq(a.meses[a.meses.length - 1], { ano: 2026, mes: 8, label: "Ago 26", compras: 50, vendas: 120 }, "último mês é Ago/26 — Set/26 (777/777), parcial, NÃO entra");
  check(
    !a.meses.some((m) => m.compras === 999 || m.compras === 777 || m.vendas === 999 || m.vendas === 777),
    "nenhum valor da linha fora-da-janela aparece nos buckets",
  );
}

// ═════════════════════════════════════════════════════════════════════
// C. Zero-preenchimento
// ═════════════════════════════════════════════════════════════════════
console.log("\nC. Mês sem linha aparece a 0, não desaparece\n");

{
  const semLinha = a.meses.filter((m) => !(m.ano === 2025 && m.mes === 9) && !(m.ano === 2026 && m.mes === 7) && !(m.ano === 2026 && m.mes === 8));
  eq(semLinha.length, 9, "9 dos 12 meses de fA não têm linha na fixture");
  check(semLinha.every((m) => m.compras === 0 && m.vendas === 0), "…e todos aparecem com compras=0, vendas=0");
  eq(c.meses.length, 12, "fC (sem nenhuma linha) tem os 12 meses na mesma");
  check(c.meses.every((m) => m.compras === 0 && m.vendas === 0), "…todos a zero");
}

// ═════════════════════════════════════════════════════════════════════
// D. Por farmácia — sem vazamento
// ═════════════════════════════════════════════════════════════════════
console.log("\nD. Cada farmácia tem a sua série; farmácia não pedida fica de fora\n");

{
  eq(series.length, 3, "uma série por farmácia PEDIDA (3), não 4");
  check(!series.some((s) => s.farmaciaId === FX), "fX (não pedida) não aparece no resultado");
  check(
    a.meses.every((m) => m.vendas !== 500 && m.compras !== 500),
    "os 500/500 de fX não vazam para fA",
  );
}

// ═════════════════════════════════════════════════════════════════════
// E. Métricas canónicas — reutilizadas, não reinventadas
// ═════════════════════════════════════════════════════════════════════
console.log("\nE. avgDaily/monthlyVelocity/coverageDays batem com as fórmulas canónicas\n");

{
  // Últimos 3 dos 12 meses = Jun/26 (sem linha=0) + Jul/26 (80) + Ago/26 (120) = 200
  const recentVendasA = 0 + 80 + 120;
  const adEsperado = avgDaily(recentVendasA, WINDOW_90D);
  eq(a.avgDaily, adEsperado, "avgDaily de fA == avgDaily(200, WINDOW_90D) chamado directamente");
  eq(a.monthlyVelocity, monthlyVelocity(adEsperado), "monthlyVelocity de fA == monthlyVelocity(avgDaily) canónico");
  eq(a.coverageDays, coverageDays(100, adEsperado), "coverageDays de fA == coverageDays(stock, avgDaily) canónico");
  eq(a.stockAtual, 100, "stockAtual de fA vem do map passado");
  eq(a.temLedger, true, "fA tem ledger");
}
{
  // fB: só Ago/26 = -10 nos últimos 3 meses → net negativo
  const adEsperado = avgDaily(-10, WINDOW_90D);
  eq(adEsperado, 0, "avgDaily satura negativo a 0 (sanitização já existe em metrics-shared)");
  eq(b.avgDaily, 0, "fB: avgDaily 0 — devoluções não geram demanda negativa");
  eq(b.stockAtual, 0, "fB: stockAtual 0 (existe na ficha, é zero)");
  eq(b.coverageDays, coverageDays(0, 0), "fB: coverageDays == coverageDays(0,0) canónico (rotura, não null)");
  eq(b.temLedger, false, "fB: sem ledger canónico ainda (flag/ingestão não confirmada)");
}
{
  eq(c.avgDaily, 0, "fC sem nenhuma linha: avgDaily 0");
  eq(c.monthlyVelocity, 0, "fC: monthlyVelocity 0");
  eq(c.stockAtual, null, "fC: sem ficha ProdutoFarmacia — null, não 0");
  eq(c.coverageDays, coverageDays(0, 0), "fC: coverageDays trata null como 0 no boundary, == canónico(0,0)");
  eq(c.temLedger, false, "fC: default false quando ausente do map de cobertura");
  eq(c.farmaciaNome, "—", "fC: sem nome no map → fallback em travessão");
}

// ═════════════════════════════════════════════════════════════════════
// G. Wiring — auth, UI, lazy-loading
// ═════════════════════════════════════════════════════════════════════
console.log("\nG. As pontas estão ligadas\n");

{
  const actions = src("app/encomendas/actions.ts");
  check(
    /requirePermission\("reports\.write"\)/.test(actions),
    "getHistoricoProdutoAction usa a MESMA permissão das outras actions de encomendas",
  );
  check(
    actions.includes("canAccessFarmaciaSync"),
    "farmácias pedidas são filtradas por canAccessFarmaciaSync — sem isto, um pedido forjado veria farmácias de outra farmácia/tenant",
  );
  check(
    /export async function getHistoricoProdutoAction/.test(actions),
    "a action é exportada com o nome esperado pelo componente",
  );
}
{
  const lib = src("lib/encomendas/historico-produto.ts");
  check(lib.includes('WHEN tipo = \'COMPRA\''), "SQL: compras filtra por tipo=COMPRA");
  check(
    lib.includes("WHEN tipo = 'VENDA'") && lib.includes("WHEN tipo = 'DEVOLUCAO_CLIENTE'"),
    "SQL: vendas líquidas distingue VENDA de DEVOLUCAO_CLIENTE",
  );
  check(
    /"produtoId" = \$\{produto\.id\}/.test(lib) && /"dataMovimento" >= \$\{periodStartDate\}/.test(lib),
    "o filtro usa produtoId + intervalo de dataMovimento — aproveita o índice (produtoId, dataMovimento)",
  );
  check(lib.includes("getCoberturaMovimentos"), "reutiliza a cobertura do ledger já existente em lib/movimentos-data.ts");

  const tipos = src("lib/encomendas/historico-produto-tipos.ts");
  check(
    tipos.includes("avgDaily") && tipos.includes("metrics-shared"),
    "a agregação importa as fórmulas canónicas de metrics-shared — não reimplementa média/cobertura",
  );
  check(
    !tipos.includes('"server-only"') && !tipos.includes("@/lib/prisma") && !tipos.includes("@/generated/prisma"),
    "a parte pura não importa Prisma/server-only — corre num tsx standalone sem BD (mesma regra de lib/movimentos-tipos.ts)",
  );
}
{
  const modal = src("components/encomendas/historico-produto-modal.tsx");
  check(
    modal.includes("useEffect") && /if \(open\)|\{open &&/.test(modal),
    "o pedido só é feito quando o modal está aberto — lazy, não pré-carregado",
  );
  check(!/router\.push|useRouter|<Link\b/.test(modal), "o modal NUNCA navega para fora da página da encomenda");
  check(modal.includes("getHistoricoProdutoAction"), "chama a server action, não uma API route pública");
}
{
  const create = src("components/encomendas/order-create-client.tsx");
  check(create.includes("HistoricoProdutoButton"), "order-create-client.tsx tem o botão de histórico por linha");
  check(
    /farmaciaIds=\{[\s\S]{0,200}?isGroupMode/.test(create),
    "em modo grupo, quando a linha não tem farmácia própria, cai para as farmácias visíveis do grupo",
  );
}
{
  const detail = src("components/encomendas/order-detail-client.tsx");
  check(detail.includes("HistoricoProdutoButton"), "order-detail-client.tsx tem o botão de histórico por linha");
  check(
    /farmaciaIds=\{\[detail\.farmaciaId\]\}/.test(detail),
    "no detalhe (farmácia única), passa sempre a farmácia da própria encomenda",
  );
}
{
  // encomendas-client.tsx é código morto sem rota — não deve ganhar a funcionalidade nova.
  const morto = src("components/encomendas/encomendas-client.tsx");
  check(
    !morto.includes("HistoricoProdutoButton"),
    "o componente morto (sem rota) NÃO foi tocado — a funcionalidade vive só nos componentes ao vivo",
  );
}
{
  const schema = src("prisma/schema.prisma");
  check(
    /@@index\(\[produtoId, dataMovimento\]\)/.test(schema),
    "o índice de que a agregação depende já existe — nenhuma migration foi necessária",
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
