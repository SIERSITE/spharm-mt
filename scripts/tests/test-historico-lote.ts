/**
 * scripts/tests/test-historico-lote.ts
 *
 * Ponto 1 — histórico de 12 meses em LOTE (N produtos de uma vez):
 * `buildHistoricoLote` (lib/encomendas/historico-produto-tipos.ts), a
 * parte pura de `getHistoricoProdutosEmLote`
 * (lib/encomendas/historico-produto.ts).
 *
 *   A. cada produto recebe a SUA série, sem vazamento de movimentos/stock
 *      de outro produto (o ponto central de risco de agregar em lote —
 *      uma partição errada por `produtoId` misturava tudo);
 *   B. um produto SEM nenhuma linha de movimento/stock no lote continua a
 *      aparecer no Map, com séries zero-preenchidas (mesmo comportamento
 *      de "farmácia sem linha" em `buildHistoricoSeries`, um nível acima);
 *   C. o resultado é idêntico a chamar `buildHistoricoSeries` directamente
 *      por produto — não é uma segunda forma de agregar, é a MESMA;
 *   D. `nomeById`/`ledgerById`/`farmaciaIds` são partilhados por todos os
 *      produtos do lote (não precisam de ser repetidos por produto);
 *   E. lote vazio (`produtos: []`) devolve um Map vazio, sem lançar;
 *   F. wiring — `getHistoricoProdutosEmLote` usa `buildHistoricoLote` (não
 *      reimplementa a partição), a query SQL faz `ANY`+`GROUP BY
 *      "produtoId"`, e a server action devolve um `Record` (não um `Map`,
 *      que não atravessa a fronteira cliente/servidor).
 *
 * Corre com:  npx tsx scripts/tests/test-historico-lote.ts
 */
import { readFileSync } from "node:fs";
import {
  buildHistoricoLote,
  buildHistoricoSeries,
  periodKey,
  type HistoricoMovRowLote,
  type HistoricoStockRowLote,
} from "../../lib/encomendas/historico-produto-tipos";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), l, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

const src = (p: string) => readFileSync(p, "utf8");

const PERIOD_END_KEY = periodKey(2026, 9); // Setembro/2026, exclusivo — janela Set/25..Ago/26
const FA = "farmacia-a";
const FB = "farmacia-b";

const nomeById = new Map([[FA, "Farmácia A"], [FB, "Farmácia B"]]);
const ledgerById = new Map([[FA, true], [FB, true]]);
const farmaciaIds = [FA, FB];

const produtos = [
  { id: "p1", cnp: 111, designacao: "Produto Um" },
  { id: "p2", cnp: 222, designacao: "Produto Dois" },
  { id: "p3", cnp: 333, designacao: "Produto Três — sem nenhuma linha" },
];

const movRows: HistoricoMovRowLote[] = [
  { produtoId: "p1", farmaciaId: FA, ano: 2026, mes: 8, compras: 10, vendas: 50 },
  { produtoId: "p1", farmaciaId: FB, ano: 2026, mes: 8, compras: 0, vendas: 5 },
  { produtoId: "p2", farmaciaId: FA, ano: 2026, mes: 8, compras: 999, vendas: 999 }, // valores bem diferentes — se vazar para p1, o teste A apanha
  { produtoId: "p2", farmaciaId: FB, ano: 2026, mes: 7, compras: 3, vendas: 20 },
  // p3: nenhuma linha — testa B
];
const stockRows: HistoricoStockRowLote[] = [
  { produtoId: "p1", farmaciaId: FA, stockAtual: 100 },
  { produtoId: "p2", farmaciaId: FA, stockAtual: 500 }, // valor bem diferente do de p1 — se vazar, o teste A apanha
  // p1/FB, p2/FB, p3/* — sem ficha (testa fallback null)
];

const resultado = buildHistoricoLote({
  produtos, farmaciaIds, movRows, stockRows, nomeById, ledgerById, periodEndKey: PERIOD_END_KEY,
});

// ═════════════════════════════════════════════════════════════════════
// A · Sem vazamento entre produtos
// ═════════════════════════════════════════════════════════════════════
console.log("\nA · cada produto recebe a SUA série — sem vazamento de movimentos/stock\n");
{
  const p1 = resultado.get("p1")!;
  const p1FA = p1.farmacias.find((f) => f.farmaciaId === FA)!;
  const ago26 = p1FA.meses.find((m) => m.ano === 2026 && m.mes === 8)!;
  eq(ago26.compras, 10, "p1/FA Ago26: compras da SUA linha (10), não a de p2 (999)");
  eq(ago26.vendas, 50, "p1/FA Ago26: vendas da SUA linha (50), não a de p2 (999)");
  eq(p1FA.stockAtual, 100, "p1/FA: stock da SUA ficha (100), não a de p2 (500)");

  const p2 = resultado.get("p2")!;
  const p2FA = p2.farmacias.find((f) => f.farmaciaId === FA)!;
  const p2Ago26 = p2FA.meses.find((m) => m.ano === 2026 && m.mes === 8)!;
  eq(p2Ago26.compras, 999, "p2/FA Ago26: as SUAS 999, intactas");
  eq(p2FA.stockAtual, 500, "p2/FA: stock 500, intacto");

  const p1FB = p1.farmacias.find((f) => f.farmaciaId === FB)!;
  eq(p1FB.stockAtual, null, "p1/FB: sem ficha no lote → null, não herda o stock de FA (100)");
}

// ═════════════════════════════════════════════════════════════════════
// B · Produto sem nenhuma linha continua no Map, zero-preenchido
// ═════════════════════════════════════════════════════════════════════
console.log("\nB · produto sem nenhuma linha de movimento/stock ainda aparece, zero-preenchido\n");
{
  eq(resultado.size, 3, "os 3 produtos pedidos aparecem no Map, incluindo p3");
  const p3 = resultado.get("p3")!;
  check(!!p3, "p3 existe no resultado");
  eq(p3.farmacias.length, 2, "p3: uma série por farmácia pedida (2), na mesma");
  check(
    p3.farmacias.every((f) => f.meses.every((m) => m.compras === 0 && m.vendas === 0) && f.stockAtual === null),
    "p3: todos os meses a 0, stock null em ambas as farmácias",
  );
  eq(p3.cnp, 333, "p3: cnp vem do `produtos` de entrada, não de nenhuma linha");
  eq(p3.designacao, "Produto Três — sem nenhuma linha", "p3: designação vem de `produtos`");
}

// ═════════════════════════════════════════════════════════════════════
// C · Idêntico a chamar buildHistoricoSeries directamente por produto
// ═════════════════════════════════════════════════════════════════════
console.log("\nC · o lote não reimplementa a agregação — chama buildHistoricoSeries por produto\n");
{
  const p1Rows = movRows.filter((r) => r.produtoId === "p1").map(({ farmaciaId, ano, mes, compras, vendas }) => ({ farmaciaId, ano, mes, compras, vendas }));
  const p1StockById = new Map<string, number | null>([[FA, 100]]); // FB sem ficha
  const esperado = buildHistoricoSeries({
    farmaciaIds, movRows: p1Rows, nomeById, stockById: p1StockById, ledgerById, periodEndKey: PERIOD_END_KEY,
  });
  eq(resultado.get("p1")!.farmacias, esperado, "p1: série IDÊNTICA à chamada directa de buildHistoricoSeries com os mesmos inputs");
}

// ═════════════════════════════════════════════════════════════════════
// D · nomeById/ledgerById/farmaciaIds partilhados
// ═════════════════════════════════════════════════════════════════════
console.log("\nD · nomeById/ledgerById/farmaciaIds são os MESMOS para todos os produtos do lote\n");
{
  const p1 = resultado.get("p1")!;
  const p2 = resultado.get("p2")!;
  eq(p1.farmacias.map((f) => f.farmaciaNome), ["Farmácia A", "Farmácia B"], "p1: nomes do mapa partilhado");
  eq(p2.farmacias.map((f) => f.farmaciaNome), ["Farmácia A", "Farmácia B"], "p2: MESMOS nomes, mesmo mapa");
  check(p1.farmacias.every((f) => f.temLedger) && p2.farmacias.every((f) => f.temLedger), "ledger partilhado: true para ambas as farmácias, em ambos os produtos");
}

// ═════════════════════════════════════════════════════════════════════
// E · Lote vazio não rebenta
// ═════════════════════════════════════════════════════════════════════
console.log("\nE · produtos: [] devolve Map vazio\n");
{
  const vazio = buildHistoricoLote({
    produtos: [], farmaciaIds, movRows: [], stockRows: [], nomeById, ledgerById, periodEndKey: PERIOD_END_KEY,
  });
  eq(vazio.size, 0, "Map vazio, sem lançar");
}

// ═════════════════════════════════════════════════════════════════════
// F · Wiring
// ═════════════════════════════════════════════════════════════════════
console.log("\nF · as pontas estão ligadas\n");
{
  const lib = src("lib/encomendas/historico-produto.ts");
  check(lib.includes("export async function getHistoricoProdutosEmLote"), "getHistoricoProdutosEmLote existe e é exportada");
  check(lib.includes("buildHistoricoLote"), "usa buildHistoricoLote — não reimplementa a partição por produto");
  check(
    /"produtoId" = ANY\(\$\{idsExistentes\}\)/.test(lib) && /GROUP BY "produtoId", "farmaciaId", ano, mes/.test(lib),
    "a query SQL do lote agrupa também por produtoId, com ANY() em vez de igualdade",
  );
  check(lib.includes("getCoberturaMovimentos(farmaciaIds)"), "reutiliza a MESMA cobertura de ledger — uma só chamada para o lote inteiro");

  const actions = src("app/encomendas/actions.ts");
  check(actions.includes("export async function getHistoricoProdutosLoteAction"), "a server action de lote existe");
  check(/requirePermission\("reports\.write"\)/.test(actions), "MESMA gate de permissão da acção de um único produto");
  check(actions.includes("canAccessFarmaciaSync"), "farmácias pedidas filtradas por canAccessFarmaciaSync");
  check(
    actions.includes("Object.fromEntries(mapa)"),
    "a acção devolve um Record (Object.fromEntries), não o Map — o Map não atravessa a fronteira cliente/servidor",
  );

  const cliente = src("components/encomendas/order-create-client.tsx");
  check(cliente.includes("getHistoricoProdutosLoteAction"), "order-create-client.tsx chama a acção em lote");
  check(
    !/getHistoricoProdutosLoteAction\(\{[\s\S]{0,80}?produtoIds: \[l\.produtoId\]/.test(cliente),
    "não é chamada uma vez por linha (produtoIds: [l.produtoId]) — o pedido é para o conjunto de produtos",
  );
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
