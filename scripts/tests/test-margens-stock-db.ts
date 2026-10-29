/**
 * scripts/tests/test-margens-stock-db.ts
 *
 * Stock em Margens — TODOS os modos (produto, categoria, farmácia, grupo, fabricante) contra um PostgreSQL REAL e
 * DESCARTÁVEL, com o motor verdadeiro (`getMargensData`): o stock de cada modo sai da MESMA consulta, cada par
 * (produto × farmácia) conta UMA vez — mesmo com vários meses de vendas, várias farmácias e a expansão CNPEM.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-margens-stock-db.ts
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}
const eq = <T,>(a: T, b: T, msg: string) => check(JSON.stringify(a) === JSON.stringify(b), msg, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
const ordenado = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const secao = (t: string) => console.log(`\n── ${t}`);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const db = `spharm_mstk_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(db);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const { getMargensData } = await import("../../lib/margens-data");
    const { buildMargensAggReport, buildMargensProdutoReport, stockDaLinhaAgregada } = await import("../../lib/reporting/adapters/margens");

    const f1 = await prisma.farmacia.create({ data: { nome: "Farmácia Um" } });
    const f2 = await prisma.farmacia.create({ data: { nome: "Farmácia Dois" } });
    const f3 = await prisma.farmacia.create({ data: { nome: "Farmácia Três" } });
    const catA = await prisma.classificacao.create({ data: { nome: "Cat A", tipo: "NIVEL_1" } });
    const catB = await prisma.classificacao.create({ data: { nome: "Cat B", tipo: "NIVEL_1" } });
    const grA = await prisma.classificacao.create({ data: { nome: "Grupo A1", tipo: "NIVEL_2", classificacaoPaiId: catA.id } });
    const grB = await prisma.classificacao.create({ data: { nome: "Grupo B1", tipo: "NIVEL_2", classificacaoPaiId: catB.id } });
    const fabX = await prisma.fabricante.create({ data: { nomeNormalizado: "FAB X" } });
    const fabY = await prisma.fabricante.create({ data: { nomeNormalizado: "FAB Y" } });

    type PF = { f: string; stock: number | null };
    type VM = { f: string; ano: number; mes: number; qty: number };
    const mk = async (cnp: number, cat: { id: string }, gr: { id: string }, fab: { id: string }, pfs: PF[], vendas: VM[]) => {
      const p = await prisma.produto.create({ data: { cnp, designacao: `PROD ${cnp}`, classificacaoNivel1Id: cat.id, classificacaoNivel2Id: gr.id, fabricanteId: fab.id } });
      for (const pf of pfs) await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: pf.f, pvp: 9, pmc: 6, puc: 0, taxaIvaPercent: 23, stockAtual: pf.stock } });
      for (const v of vendas) await prisma.vendaMensal.create({ data: { farmaciaId: v.f, produtoId: p.id, ano: v.ano, mes: v.mes, quantidade: v.qty, valorTotal: v.qty * 12.3, valorBruto: v.qty * 12.3 } });
      return p;
    };
    const meses = (f: string, n: number): VM[] => Array.from({ length: n }, (_, i) => ({ f, ano: 2026, mes: i + 1, qty: 3 }));

    // 1: mesmo produto em F1 e F2, 6 MESES de vendas em cada — stock 4 e 6 (nunca ×6 nem ×2)
    await mk(8000001, catA, grA, fabX, [{ f: f1.id, stock: 4 }, { f: f2.id, stock: 6 }], [...meses(f1.id, 6), ...meses(f2.id, 6)]);
    await mk(8000002, catB, grB, fabY, [{ f: f1.id, stock: 0 }], meses(f1.id, 3)); // zero
    await mk(8000003, catB, grB, fabY, [{ f: f1.id, stock: -3 }], meses(f1.id, 2)); // negativo
    await mk(8000004, catB, grB, fabX, [{ f: f2.id, stock: null }], meses(f2.id, 4)); // desconhecido
    await mk(8000005, catA, grA, fabY, [{ f: f3.id, stock: 9 }], meses(f3.id, 1));
    // 6: tem stock mas NÃO vendeu no período (fora do universo do mapa): não entra em nenhum modo
    await mk(8000006, catA, grA, fabX, [{ f: f1.id, stock: 100 }], [{ f: f1.id, ano: 2024, mes: 5, qty: 1 }]);

    const filtros = { from: "2026-01-01", to: "2026-12-31" };
    const r = await getMargensData(filtros);
    const somaProduto = r.porProduto.reduce((s, l) => s + (l.stockAtual ?? 0), 0);

    secao("modo produto: 1 linha por par, independentemente dos meses");
    eq(r.porProduto.length, 6, "6 pares produto×farmácia com vendas (o produto 6 não vendeu no período)");
    eq(r.porProduto.filter((l) => l.cnp === 8000001).map((l) => [l.farmacia, l.stockAtual, l.qtdVendida]).sort(), [["Farmácia Dois", 6, 18], ["Farmácia Um", 4, 18]], "produto 1: stock 4 e 6 (6 meses de vendas não multiplicam), qtd 18 em cada");
    eq(somaProduto, 16, "Σ stock das linhas = 4 + 6 + 0 − 3 + 9 = 16 (desconhecido fora; produto sem vendas fora)");
    const prod = buildMargensProdutoReport({ rows: r.porProduto, filters: filtros, universe: { farmacias: ["Farmácia Um", "Farmácia Dois", "Farmácia Três"], categorias: [], fabricantes: [], distribuidores: [] }, organization: "Grupo" });
    eq(prod.summary?.find((s) => s.label === "Stock total")?.value, 16, "Report por produto: Stock total = 16");

    secao("modos agregados: valores exatos e Σ = total");
    const modos = {
      categoria: { dados: r.porCategoria, esperado: { "Cat A": 19, "Cat B": -3 }, semStock: { "Cat A": 0, "Cat B": 1 } },
      farmacia: { dados: r.porFarmacia, esperado: { "Farmácia Um": 1, "Farmácia Dois": 6, "Farmácia Três": 9 }, semStock: { "Farmácia Um": 0, "Farmácia Dois": 1, "Farmácia Três": 0 } },
      grupo: { dados: r.porGrupo, esperado: { "Grupo A1": 19, "Grupo B1": -3 }, semStock: { "Grupo A1": 0, "Grupo B1": 1 } },
      fabricante: { dados: r.porFabricante, esperado: { "FAB X": 10, "FAB Y": 6 }, semStock: { "FAB X": 1, "FAB Y": 0 } },
    } as const;
    for (const [dim, m] of Object.entries(modos)) {
      const obtido = Object.fromEntries(m.dados.map((a) => [a.key, a.stockTotal]));
      eq(ordenado(obtido), ordenado(m.esperado as Record<string, number>), `${dim}: stock por linha`);
      eq(ordenado(Object.fromEntries(m.dados.map((a) => [a.key, a.linhasSemStock]))), ordenado(m.semStock as Record<string, number>), `${dim}: linhas sem stock conhecido`);
      eq(m.dados.reduce((s, a) => s + a.stockTotal, 0), 16, `${dim}: Σ = 16 (igual ao modo produto: sem dupla contagem)`);
      eq(m.dados.reduce((s, a) => s + a.linhas, 0), 6, `${dim}: Σ linhas = 6 pares`);
      const rel = buildMargensAggReport({ rows: m.dados, filters: filtros, universe: { farmacias: [], categorias: [], fabricantes: [], distribuidores: [] }, organization: "Grupo", groupBy: dim as "categoria" });
      eq(rel.summary?.find((s) => s.label === "Stock total")?.value, 16, `${dim}: Report — Stock total = 16`);
    }
    eq(r.totals.stockTotal, 16, "totals.stockTotal = 16");
    eq(r.totals.linhasSemStock, 1, "totals.linhasSemStock = 1");
    // Um agregado cujos pares são todos desconhecidos mostra «—», não 0.
    const soDesc = await getMargensData({ ...filtros, farmaciaNomes: ["Farmácia Dois"], pesquisa: "8000004" });
    eq(soDesc.porFarmacia.map((a) => [a.key, a.stockTotal, stockDaLinhaAgregada(a)]), [["Farmácia Dois", 0, null]], "agregado só com desconhecidos: stockDaLinhaAgregada = null («—»)");

    secao("uma farmácia e várias farmácias");
    const so1 = await getMargensData({ ...filtros, farmaciaNomes: ["Farmácia Um"] });
    eq(so1.totals.stockTotal, 1, "só Farmácia Um: 4 + 0 − 3 = 1");
    const so12 = await getMargensData({ ...filtros, farmaciaNomes: ["Farmácia Um", "Farmácia Dois"] });
    eq(so12.totals.stockTotal, 7, "Um + Dois: 4 + 6 + 0 − 3 = 7");
    eq(so12.porCategoria.reduce((s, a) => s + a.stockTotal, 0), 7, "…e Σ por categoria = 7");

    secao("vários períodos: o stock não muda com o período");
    const curto = await getMargensData({ from: "2026-01-01", to: "2026-01-31" });
    const longo = await getMargensData({ from: "2026-01-01", to: "2026-12-31" });
    eq(curto.porProduto.filter((l) => l.cnp === 8000001).map((l) => l.stockAtual).sort(), longo.porProduto.filter((l) => l.cnp === 8000001).map((l) => l.stockAtual).sort(), "produto 1: mesmo stock com 1 mês e com 12 meses");

    secao("expansão CNPEM não contamina (a comparação é outra consulta; os totais vêm só de porProduto)");
    const depois = await getMargensData(filtros);
    eq(depois.totals.stockTotal, 16, "totals.stockTotal inalterado");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
