/**
 * scripts/tests/test-vendas-loader-pvp-stock-db.ts
 *
 * O carregador do mapa de Vendas (`getVendasData`) contra um PostgreSQL REAL e DESCARTÁVEL:
 *   · `existenciaConhecida` — stock nulo NÃO é convertido silenciosamente em zero (a linha diz que é desconhecido);
 *   · `pvpConhecido` — o PVP real da ficha (sem a cascata para o PMC que alimenta `pvp`);
 *   · `pvpPorFarmacia` — o PVP real de TODAS as farmácias carregadas, mesmo as que não venderam o artigo;
 *   · o filtro «PVP diferente entre farmácias» (regra pura) sobre estes dados, e o Stock total comparado matematicamente com a BD.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-vendas-loader-pvp-stock-db.ts
 */
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import Module from "node:module";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? ` — ${detalhe}` : ""}`); }
}
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
  const db = `spharm_vend_loader_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(db);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const { getVendasData } = await import("../../lib/vendas-data");
    const { codigosComPvpDiferente } = await import("../../lib/reporting/vendas-pvp-diferente");
    const { stockTotalDoRelatorio } = await import("../../lib/reporting/adapters/vendas");

    const alfa = await prisma.farmacia.create({ data: { nome: "Farmácia Alfa" } });
    const beta = await prisma.farmacia.create({ data: { nome: "Farmácia Beta" } });
    const gama = await prisma.farmacia.create({ data: { nome: "Farmácia Gama" } });
    const prod = (cnp: number) => prisma.produto.create({ data: { cnp, designacao: `Produto ${cnp}` } });
    const pf = (produtoId: string, farmaciaId: string, d: { pvp?: number | null; pmc?: number | null; stock?: number | null; forn?: string }) =>
      prisma.produtoFarmacia.create({ data: { produtoId, farmaciaId, pvp: d.pvp ?? null, pmc: d.pmc ?? null, stockAtual: d.stock === undefined ? null : d.stock, fornecedorOrigem: d.forn ?? null } });
    const venda = (produtoId: string, farmaciaId: string, mes: number, q: number) =>
      prisma.vendaMensal.create({ data: { produtoId, farmaciaId, ano: 2026, mes, quantidade: q, quantidadeLiquida: q, valorTotal: q * 10, valorBruto: q * 10 } });

    // P1: só a Alfa vendeu, mas a Beta tem PVP diferente (10 ≠ 12) · stock 4 + 7
    const p1 = await prod(9300001);
    await pf(p1.id, alfa.id, { pvp: 10, stock: 4 }); await pf(p1.id, beta.id, { pvp: 12, stock: 7 });
    await venda(p1.id, alfa.id, 1, 3);
    // P2: PVP da Alfa em falta (só PMC 5), stock da Alfa desconhecido (nulo) · Beta 8 com stock 2
    const p2 = await prod(9300002);
    await pf(p2.id, alfa.id, { pvp: null, pmc: 5, stock: null }); await pf(p2.id, beta.id, { pvp: 8, stock: 2 });
    await venda(p2.id, alfa.id, 1, 2);
    // P3: PVP igual nas duas · vende nas duas
    const p3 = await prod(9300003);
    await pf(p3.id, alfa.id, { pvp: 6.5, stock: 0 }); await pf(p3.id, beta.id, { pvp: 6.5, stock: -2 });
    await venda(p3.id, alfa.id, 1, 1); await venda(p3.id, beta.id, 2, 1);
    // P4: diferença de 1 cêntimo · terceira farmácia sem ficha
    const p4 = await prod(9300004);
    await pf(p4.id, alfa.id, { pvp: 9.99, stock: 1 }); await pf(p4.id, beta.id, { pvp: 10, stock: 1 });
    await venda(p4.id, beta.id, 3, 5);
    // P5: ficha só na Alfa
    const p5 = await prod(9300005);
    await pf(p5.id, alfa.id, { pvp: 3, stock: 5, forn: "Distribuidor X" });
    await venda(p5.id, alfa.id, 1, 1);

    secao("1 · Campos novos do carregador");
    const r = await getVendasData({ from: "2026-01-01", to: "2026-03-31" }, prisma);
    const linhaDe = (cnp: number, farm: string) => r.rows.find((x) => x.codigo === String(cnp) && x.farmacia === farm);
    const l1 = linhaDe(9300001, "Farmácia Alfa");
    check(!!l1 && l1.existenciaConhecida === true && l1.existencia === 4 && l1.pvpConhecido === 10, "P1/Alfa: stock 4 conhecido, PVP real 10");
    check(JSON.stringify(l1?.pvpPorFarmacia) === JSON.stringify({ "Farmácia Alfa": 10, "Farmácia Beta": 12 }), "P1/Alfa: `pvpPorFarmacia` inclui a Beta (que não vendeu) com 12", JSON.stringify(l1?.pvpPorFarmacia));
    check(!linhaDe(9300001, "Farmácia Beta"), "P1: a Beta não tem linha de vendas (não vendeu)");
    const l2 = linhaDe(9300002, "Farmácia Alfa");
    check(!!l2 && l2.existenciaConhecida === false && l2.existencia === 0, "P2/Alfa: stock NULO → desconhecido (existenciaConhecida=false), com existencia 0 só para ordenar");
    check(!!l2 && l2.pvpConhecido === null && l2.pvp === 5, "P2/Alfa: sem PVP real (pvpConhecido=null) mas `pvp` mostra o PMC (5) como sempre");
    check(JSON.stringify(l2?.pvpPorFarmacia) === JSON.stringify({ "Farmácia Alfa": null, "Farmácia Beta": 8 }), "P2: pvpPorFarmacia marca a Alfa sem PVP (null) — nunca usa o PMC");
    const l3 = linhaDe(9300003, "Farmácia Beta");
    check(!!l3 && l3.existenciaConhecida === true && l3.existencia === -2, "P3/Beta: stock negativo conhecido (−2) entra com sinal");
    check(linhaDe(9300003, "Farmácia Alfa")?.existencia === 0 && linhaDe(9300003, "Farmácia Alfa")?.existenciaConhecida === true, "P3/Alfa: stock 0 é conhecido (zero), não desconhecido");
    check(JSON.stringify(linhaDe(9300005, "Farmácia Alfa")?.pvpPorFarmacia) === JSON.stringify({ "Farmácia Alfa": 3 }), "P5: só uma farmácia com ficha → pvpPorFarmacia só com ela");

    secao("2 · Filtro «PVP diferente entre farmácias» sobre os dados reais");
    const sel2 = ["Farmácia Alfa", "Farmácia Beta"];
    const cods = codigosComPvpDiferente(r.rows, sel2);
    check(cods.has("9300001"), "P1 entra (10 ≠ 12), apesar de só a Alfa ter linha de vendas");
    check(!cods.has("9300002"), "P2 fica fora (um só PVP conhecido: o da Alfa é desconhecido)");
    check(!cods.has("9300003"), "P3 fica fora (6,50 = 6,50)");
    check(cods.has("9300004"), "P4 entra (9,99 ≠ 10,00 — diferença de 1 cêntimo)");
    check(!cods.has("9300005"), "P5 fica fora (uma só farmácia associada)");
    check(codigosComPvpDiferente(r.rows, ["Farmácia Alfa"]).size === 0, "com uma só farmácia selecionada nenhum artigo entra");

    secao("3 · Farmácias carregadas e distribuidor");
    const soAlfa = await getVendasData({ from: "2026-01-01", to: "2026-03-31", farmaciaNomes: ["Farmácia Alfa"] }, prisma);
    check(soAlfa.rows.every((x) => !("Farmácia Beta" in (x.pvpPorFarmacia ?? {}))), "carregando só a Alfa, `pvpPorFarmacia` só tem a Alfa (âmbito carregado)");
    const dist = await getVendasData({ from: "2026-01-01", to: "2026-03-31", distribuidores: ["Distribuidor X"] }, prisma);
    check(dist.rows.length === 1 && dist.rows[0].codigo === "9300005", "filtro de distribuidor continua a restringir as linhas");
    const todos = await getVendasData({ from: "2026-01-01", to: "2026-03-31" }, prisma);
    check(JSON.stringify(todos.rows.map((x) => x.codigo + x.farmacia)) === JSON.stringify(r.rows.map((x) => x.codigo + x.farmacia)), "o carregador é determinista (mesma ordem em duas chamadas)");

    secao("4 · «Apenas com stock» (linhas só de stock) e Stock total contra a BD");
    const comStock = await getVendasData({ from: "2026-01-01", to: "2026-03-31", apenasComStock: true }, prisma);
    const sT = stockTotalDoRelatorio(comStock.rows);
    // Esperado calculado diretamente na BD: Σ stockAtual dos pares presentes nas linhas (nulos fora e contados à parte)
    const pares = new Set(comStock.rows.map((x) => `${x.codigo}|${x.farmacia}`));
    const bd = await prisma.produtoFarmacia.findMany({ include: { produto: true, farmacia: true } });
    let esperado = 0, desconhecidas = 0;
    for (const x of bd) {
      if (!pares.has(`${x.produto.cnp}|${x.farmacia.nome}`)) continue;
      if (x.stockAtual === null) desconhecidas++; else esperado += Number(x.stockAtual);
    }
    check(sT.total === esperado && sT.desconhecidas === desconhecidas, `Stock total do relatório (${sT.total}, ${sT.desconhecidas} desconhecida) = soma direta na BD (${esperado}, ${desconhecidas})`);
    check(comStock.rows.filter((x) => x.totalVendas === 0).every((x) => x.existenciaConhecida === true && x.existencia > 0), "as linhas só de stock têm stock conhecido e positivo");
    // Soma por artigo (TOTAL ARTIGO): P1 → 4 + 7 só conta o que está nas linhas; com a Beta fora do relatório a soma é só a da Alfa (sem inventar)
    const p1Linhas = comStock.rows.filter((x) => x.codigo === "9300001");
    check(p1Linhas.reduce((s, x) => s + x.existencia, 0) === 11, "P1 com «Apenas com stock»: Alfa 4 + Beta 7 = 11 (cada combinação contada uma vez)");
    void gama;
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
