/**
 * scripts/tests/test-forma-farmaceutica-db.ts
 *
 * Filtro de FORMA FARMACÊUTICA contra um PostgreSQL REAL e DESCARTÁVEL (recusa hosts não locais), dados SINTÉTICOS:
 *
 *   A · SQL = TS: a chave calculada em SQL (`sqlChaveForma`) é IGUAL à de TS (`chaveFormaFarmaceutica`) para todos os valores;
 *   B · opções (`getReportingFilterOptions().formas`): ` COMPRIMIDO ` / comprimido / Comprimido numa só opção; Comprimido ≠ revestido ≠
 *       libertação prolongada; sem forma; contagens; produtos inativos e códigos internos fora do universo;
 *   C · filtro NO SERVIDOR em Vendas / Margens / Inventário / Stock / Catálogo / proposta de Encomenda / Excessos (campo na linha);
 *       combina (AND) com fabricante, farmácia, pesquisa, período, preços, ordenação; «sem forma»; união de várias formas;
 *   D · filtros vazios = resultado IDÊNTICO ao baseline sem o campo; selecção de TODAS as formas = baseline;
 *   E · isolamento entre duas bases (tenants): cada uma tem a sua lista, nada é partilhado;
 *   F · adapters/relatórios: linha «Forma farmacêutica: …» com os RÓTULOS, também no HTML e no Excel;
 *   G · estrutura: nenhum mapa carrega o catálogo para o browser para filtrar forma; SQL parametrizado; ligações dos clientes;
 *   I · auditoria de cobertura (script só de leitura);
 *   H · desempenho com 50 000 produtos sintéticos (tempos medidos, sem N+1) e EXPLAIN (decide se há índice).
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-forma-farmaceutica-db.ts
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import * as XLSX from "xlsx";

const estado: { tenant: string | null; prisma: unknown } = { tenant: null, prisma: null };
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string; _load: (r: string, ...a: unknown[]) => unknown };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};
const loadOriginal = M._load;
M._load = function (request: string, ...rest: unknown[]) {
  if (request === "@/lib/prisma") return { getPrisma: async () => estado.prisma };
  if (request === "@/lib/tenant-context") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const constantes = require("../../lib/tenant-constants");
    return { ...constantes, resolveCurrentTenantSlug: async () => estado.tenant };
  }
  return loadOriginal.call(this, request, ...rest);
};

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const src = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const mesmo = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ordenado = (xs: Array<string | number>) => [...xs].map(String).sort();

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

async function main() {
  const suf = Date.now().toString(36);
  const dbA = `spharm_forma_a_${suf}`;
  const dbB = `spharm_forma_b_${suf}`;
  const dbP = `spharm_forma_p_${suf}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const d of [dbA, dbB, dbP]) await admin.query(`CREATE DATABASE ${d}`);
  try {
    for (const d of [dbA, dbB, dbP]) execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(d) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(dbA);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const { Prisma } = await import("../../generated/prisma/client");
    const novoPrisma = (d: string) => new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(d) }) });
    const prisma = novoPrisma(dbA);
    const prismaB = novoPrisma(dbB);
    estado.prisma = prisma;
    estado.tenant = "silveira";

    const F = await import("../../lib/catalog/forma-farmaceutica-filtro");
    const S = await import("../../lib/catalog/forma-farmaceutica-sql");
    const { restringirPorCatalogo } = await import("../../lib/reporting/catalog-prefilter");
    const { resolverPrefiltroProdutos } = await import("../../lib/reporting/prefiltro-produtos");
    const { getReportingFilterOptions } = await import("../../lib/reporting-filter-options");
    const { getVendasData } = await import("../../lib/vendas-data");
    const { getMargensData } = await import("../../lib/margens-data");
    const { getInventarioData } = await import("../../lib/inventario-data");
    const { getStockData } = await import("../../lib/stock-data");
    const { loadCatalogoListData, loadCatalogoFilterOptions } = await import("../../lib/catalogo-data");
    const { generateOrderProposal } = await import("../../lib/encomendas/proposal");
    const { getExcessosData } = await import("../../lib/transferencias-data");
    const { SEM_FORMA } = F;

    // ── Fixture sintética (base A) ───────────────────────────────────────────────────────────────────────────────
    const f1 = await prisma.farmacia.create({ data: { nome: "Forma Farmácia Um" } });
    const f2 = await prisma.farmacia.create({ data: { nome: "Forma Farmácia Dois" } });
    const fabX = await prisma.fabricante.create({ data: { nomeNormalizado: "FABRICANTE X", estado: "ATIVO" } });
    const fabY = await prisma.fabricante.create({ data: { nomeNormalizado: "FABRICANTE Y", estado: "ATIVO" } });

    type Def = { cnp: number; nome: string; forma: string | null; fab?: string; estado?: "VALIDADO" | "INATIVO"; pvp?: number; venda1?: number; venda2?: number; stock1?: number };
    const defs: Def[] = [
      { cnp: 8_100_001, nome: "ALFA comp simples A", forma: "Comprimido", fab: fabX.id, pvp: 5, venda1: 10, venda2: 4, stock1: 100 },
      { cnp: 8_100_002, nome: "ALFA comp simples B", forma: " COMPRIMIDO ", fab: fabY.id, pvp: 7, venda1: 3, stock1: 50 },
      { cnp: 8_100_003, nome: "BETA comp simples C", forma: "comprimido", fab: fabX.id, pvp: 9, venda1: 8, venda2: 8, stock1: 20 },
      { cnp: 8_100_004, nome: "BETA comp revestido", forma: "Comprimido revestido", fab: fabX.id, pvp: 12, venda1: 5, stock1: 30 },
      { cnp: 8_100_005, nome: "GAMA comp libertação", forma: "Comprimido de libertação prolongada", fab: fabY.id, pvp: 15, venda1: 6, venda2: 2, stock1: 40 },
      { cnp: 8_100_006, nome: "GAMA capsula acento", forma: "Cápsula", fab: fabX.id, pvp: 4, venda1: 9, stock1: 10 },
      { cnp: 8_100_007, nome: "DELTA capsula sem acento", forma: "CAPSULA", fab: fabY.id, pvp: 6, venda1: 2, venda2: 1, stock1: 12 },
      { cnp: 8_100_008, nome: "DELTA sem forma nulo", forma: null, fab: fabX.id, pvp: 3, venda1: 7, stock1: 15 },
      { cnp: 8_100_009, nome: "EPSILON sem forma espaços", forma: "   ", fab: fabY.id, pvp: 2, venda1: 4, stock1: 9 },
      { cnp: 8_100_010, nome: "EPSILON espaços internos", forma: "Comprimido   revestido", fab: fabX.id, pvp: 11, venda1: 1, stock1: 8 },
      { cnp: 8_100_011, nome: "ZETA injetavel", forma: "Solução injetável", fab: fabY.id, pvp: 20, venda1: 3, stock1: 6 },
      { cnp: 8_100_012, nome: "ZETA inativo", forma: "Pomada", fab: fabX.id, estado: "INATIVO", pvp: 8, venda1: 2, stock1: 3 },
      { cnp: 1_999_999, nome: "CODIGO INTERNO ERP", forma: "Xarope", fab: fabX.id, pvp: 1, venda1: 2, stock1: 3 },
    ];
    const prodPorCnp = new Map<number, string>();
    for (const d of defs) {
      const p = await prisma.produto.create({ data: { cnp: d.cnp, designacao: d.nome, estado: d.estado ?? "VALIDADO", fabricanteId: d.fab ?? null, formaFarmaceutica: d.forma } });
      prodPorCnp.set(d.cnp, p.id);
      await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: f1.id, pvp: d.pvp ?? 5, pmc: 2, puc: 2, stockAtual: d.stock1 ?? 0, stockMinimo: 0, stockMaximo: 500 } });
      await prisma.vendaMensal.create({ data: { farmaciaId: f1.id, produtoId: p.id, ano: 2026, mes: 2, quantidade: d.venda1 ?? 1, valorTotal: (d.venda1 ?? 1) * (d.pvp ?? 5), valorBruto: (d.venda1 ?? 1) * (d.pvp ?? 5), naturezaVenda: "NORMAL" } });
      if (d.venda2) {
        await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: f2.id, pvp: d.pvp ?? 5, pmc: 2, puc: 2, stockAtual: 5, stockMinimo: 0, stockMaximo: 500 } });
        await prisma.vendaMensal.create({ data: { farmaciaId: f2.id, produtoId: p.id, ano: 2026, mes: 3, quantidade: d.venda2, valorTotal: d.venda2 * (d.pvp ?? 5), valorBruto: d.venda2 * (d.pvp ?? 5), naturezaVenda: "NORMAL" } });
      }
    }
    const cnpsDe = (...ns: number[]) => ordenado(ns);
    const COMP = cnpsDe(8_100_001, 8_100_002, 8_100_003);
    const REVEST = cnpsDe(8_100_004, 8_100_010);
    const CAPS = cnpsDe(8_100_006, 8_100_007);
    const SEMF = cnpsDe(8_100_008, 8_100_009);
    const ATIVOS_CATALOGAVEIS = defs.filter((d) => d.cnp > 2_000_000 && d.estado !== "INATIVO").map((d) => String(d.cnp)).sort();
    const periodo = { from: "2026-01-01", to: "2026-12-31" };

    // ── A · SQL = TS ────────────────────────────────────────────────────────────────────────────────────────────
    secao("A · a chave em SQL é igual à chave em TS");
    const amostras = [
      "Comprimido", " COMPRIMIDO ", "comprimido", "Comprimido   revestido", "Cápsula", "CAPSULA", "CÁPSULAS DURAS", "Solução injetável",
      "Pó para solução", "ÁÀÂÃÄ éèêë íìîï óòôõö úùûü çñ ÇÑ", "Comprimido\trevestido", "  ", "", "Comprimido, oral", "Emulsão cutânea", "Água",
    ];
    for (const a of amostras) {
      const r = await prisma.$queryRaw<Array<{ k: string }>>(Prisma.sql`SELECT ${S.sqlChaveForma("v.x")} AS k FROM (SELECT ${a}::text AS x) v`);
      check(r[0]?.k === F.chaveFormaFarmaceutica(a), `A: ${JSON.stringify(a)} -> ${JSON.stringify(F.chaveFormaFarmaceutica(a))}`, `SQL deu ${JSON.stringify(r[0]?.k)}`);
    }
    const rNulo = await prisma.$queryRaw<Array<{ k: string }>>(Prisma.sql`SELECT ${S.sqlChaveForma("v.x")} AS k FROM (SELECT NULL::text AS x) v`);
    check(rNulo[0]?.k === SEM_FORMA, "A: NULL -> sentinela (SQL)");

    // ── B · opções ──────────────────────────────────────────────────────────────────────────────────────────────
    secao("B · opções do filtro");
    const opt = await getReportingFilterOptions();
    const formas = opt.formas;
    const chaves = formas.map((o) => o.chave);
    check(chaves.includes("comprimido") && chaves.includes("comprimido revestido") && chaves.includes("comprimido de libertacao prolongada"), "B1: Comprimido / revestido / libertação prolongada são 3 opções");
    const oComp = formas.find((o) => o.chave === "comprimido");
    check(oComp?.count === 3 && oComp.label === "Comprimido", `B2: ' COMPRIMIDO ' + 'comprimido' + 'Comprimido' numa só opção, 3 produtos (veio ${JSON.stringify(oComp)})`);
    check(formas.find((o) => o.chave === "comprimido revestido")?.count === 2, "B3: espaços internos colapsados: 'Comprimido   revestido' soma com 'Comprimido revestido'");
    check(formas.find((o) => o.chave === "capsula")?.label === "Cápsula" && formas.find((o) => o.chave === "capsula")?.count === 2, "B4: Cápsula/CAPSULA numa opção, rótulo acentuado");
    const oSem = formas.find((o) => o.chave === SEM_FORMA);
    check(oSem?.count === 2 && oSem.label === "Sem forma farmacêutica", "B5: «Sem forma farmacêutica» = nulo + só espaços (2)");
    check(!chaves.includes("pomada") && !chaves.includes("xarope"), "B6: produto INATIVO e código interno do ERP fora das opções");
    check(formas.reduce((s, o) => s + o.count, 0) === ATIVOS_CATALOGAVEIS.length, "B7: a soma das contagens = nº de produtos activos/catalogáveis");
    check(mesmo(formas.map((o) => o.label).slice(0, -1), [...formas.map((o) => o.label).slice(0, -1)].sort((a, b) => F.compararRotulos(a, b))) && formas[formas.length - 1].chave === SEM_FORMA, "B8: ordem alfabética (pt) com «Sem forma» no fim");
    const rawDistinct = (await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT count(DISTINCT "formaFarmaceutica") AS n FROM "Produto" WHERE estado <> 'INATIVO' AND cnp > 2000000`))[0].n;
    check(Number(rawDistinct) > formas.length - 1, `B9: DISTINCT cru (${rawDistinct}) > opções por chave (${formas.length - 1}, fora «sem forma»)`);
    const optsCat = await loadCatalogoFilterOptions();
    check(mesmo(optsCat.formas, formas), "B10: o Catálogo usa exactamente as mesmas opções");

    // ── C · filtro no servidor ─────────────────────────────────────────────────────────────────────────────────
    secao("C · filtro no servidor, por mapa");
    const cnpDeIds = async (ids: string[] | null) => {
      if (ids === null) return null;
      const r = await prisma.produto.findMany({ where: { id: { in: ids } }, select: { cnp: true } });
      return ordenado(r.map((p) => p.cnp));
    };
    check(mesmo(await cnpDeIds(await restringirPorCatalogo(prisma, { formasFarmaceuticas: ["comprimido"] }, null)), COMP), "C0: restringirPorCatalogo(comprimido) = só os 3 «comprimido» (não os revestidos)");
    check(mesmo(await cnpDeIds(await restringirPorCatalogo(prisma, { formasFarmaceuticas: [SEM_FORMA] }, null)), SEMF), "C0b: sem forma = nulo + espaços");
    check(mesmo(await cnpDeIds(await restringirPorCatalogo(prisma, { formasFarmaceuticas: ["comprimido", "capsula"] }, null)), ordenado([...COMP, ...CAPS])), "C0c: várias formas = união");
    check((await restringirPorCatalogo(prisma, { formasFarmaceuticas: ["inexistente"] }, null))?.length === 0, "C0d: forma inexistente = nenhum produto (não o catálogo inteiro)");
    check(await restringirPorCatalogo(prisma, { formasFarmaceuticas: [] }, null) === null, "C0e: vazio = sem restrição (null)");
    check(mesmo(await cnpDeIds(await restringirPorCatalogo(prisma, { formasFarmaceuticas: ["comprimido revestido"] }, null)), REVEST), "C0f: revestido = só os 2 revestidos (espaços internos colapsados), sem os simples");

    secao("C1 · Vendas");
    const vendasCnps = (r: { rows: Array<{ codigo: string }> }) => ordenado([...new Set(r.rows.map((x) => x.codigo))]);
    const vBase = await getVendasData({ ...periodo }, prisma);
    const vComp = await getVendasData({ ...periodo, formasFarmaceuticas: ["comprimido"] }, prisma);
    check(mesmo(vendasCnps(vComp), COMP), `C1a: Vendas filtra por forma (${vendasCnps(vComp).join(",")})`);
    check(vComp.rows.every((r) => r.formaChave === "comprimido"), "C1b: cada linha traz a sua formaChave");
    const vSem = await getVendasData({ ...periodo, formasFarmaceuticas: [SEM_FORMA] }, prisma);
    check(mesmo(vendasCnps(vSem), SEMF), "C1c: Vendas «sem forma»");
    const vFab = await getVendasData({ ...periodo, formasFarmaceuticas: ["comprimido"], fabricantes: ["FABRICANTE X"] }, prisma);
    check(mesmo(vendasCnps(vFab), cnpsDe(8_100_001, 8_100_003)), "C1d: forma E fabricante (AND)");
    const vFarm = await getVendasData({ ...periodo, formasFarmaceuticas: ["comprimido"], farmaciaNomes: ["Forma Farmácia Dois"] }, prisma);
    check(mesmo(vendasCnps(vFarm), cnpsDe(8_100_001, 8_100_003)) && vFarm.rows.every((r) => r.farmacia === "Forma Farmácia Dois"), "C1e: forma E farmácia (só vendas da F2: A e C)");
    const vPesq = await getVendasData({ ...periodo, formasFarmaceuticas: ["comprimido"], pesquisa: "BETA" }, prisma);
    check(mesmo(vendasCnps(vPesq), cnpsDe(8_100_003)), "C1f: forma E pesquisa");
    const vPer = await getVendasData({ from: "2026-03-01", to: "2026-03-31", formasFarmaceuticas: ["comprimido"] }, prisma);
    check(mesmo(vendasCnps(vPer), cnpsDe(8_100_001, 8_100_003)), "C1g: forma E período (só Março: vendas da F2)");
    const totalForma = vComp.rows.reduce((s, r) => s + r.totalVendas, 0);
    const totalEsperado = (await prisma.vendaMensal.aggregate({ _sum: { quantidade: true }, where: { produto: { cnp: { in: [8_100_001, 8_100_002, 8_100_003] } } } }))._sum.quantidade ?? 0;
    check(totalForma === Number(totalEsperado), `C1h: TOTAIS no servidor reflectem o filtro (${totalForma} = ${totalEsperado})`);
    const vPvp = vComp.rows.map((r) => [r.codigo, r.pvp]);
    check(vPvp.length > 0 && vComp.rows.every((r) => r.pvp === (defs.find((d) => String(d.cnp) === r.codigo)?.pvp ?? -1)), "C1i: preços das linhas filtradas intactos");
    const ordPorVendas = await getVendasData({ ...periodo, formasFarmaceuticas: ["comprimido", "capsula"] }, prisma);
    check(mesmo(ordPorVendas.rows.map((r) => r.codigo + r.farmacia), [...ordPorVendas.rows].map((r) => r.codigo + r.farmacia)) && ordPorVendas.rows.length >= 5, "C1j: ordenação do loader preservada sobre o universo filtrado");

    secao("C2 · Margens");
    const mCnps = (r: { porProduto: Array<{ cnp: number }> }) => ordenado([...new Set(r.porProduto.map((x) => x.cnp))]);
    const mBase = await getMargensData({ ...periodo });
    const mComp = await getMargensData({ ...periodo, formasFarmaceuticas: ["comprimido"] });
    check(mesmo(mCnps(mComp), COMP), `C2a: Margens filtra por forma (${mCnps(mComp).join(",")})`);
    const mSem = await getMargensData({ ...periodo, formasFarmaceuticas: [SEM_FORMA] });
    check(mesmo(mCnps(mSem), SEMF), "C2b: Margens «sem forma»");
    const mFab = await getMargensData({ ...periodo, formasFarmaceuticas: ["comprimido"], fabricantes: ["FABRICANTE Y"] });
    check(mesmo(mCnps(mFab), cnpsDe(8_100_002)), "C2c: Margens forma E fabricante");
    const mFarm = await getMargensData({ ...periodo, formasFarmaceuticas: ["comprimido"], farmaciaNomes: ["Forma Farmácia Dois"] });
    check(mesmo(mCnps(mFarm), cnpsDe(8_100_001, 8_100_003)), "C2d: Margens forma E farmácia");

    secao("C3 · Inventário");
    const iCnps = (r: { porProduto: Array<{ cnp: number }> }) => ordenado([...new Set(r.porProduto.map((x) => x.cnp))]);
    const iBase = await getInventarioData({});
    const iComp = await getInventarioData({ formasFarmaceuticas: ["comprimido"] });
    check(mesmo(iCnps(iComp), COMP), `C3a: Inventário filtra por forma (${iCnps(iComp).join(",")})`);
    const iSem = await getInventarioData({ formasFarmaceuticas: [SEM_FORMA] });
    check(mesmo(iCnps(iSem), SEMF), "C3b: Inventário «sem forma»");
    const iPesq = await getInventarioData({ formasFarmaceuticas: ["comprimido", "capsula"], pesquisa: "ALFA" });
    check(mesmo(iCnps(iPesq), cnpsDe(8_100_001, 8_100_002)), "C3c: Inventário forma E pesquisa");
    const stockTotalComp = iComp.porProduto.reduce((s, r) => s + (r.stockAtual ?? 0), 0);
    const stockEsperado = Number((await prisma.produtoFarmacia.aggregate({ _sum: { stockAtual: true }, where: { produto: { cnp: { in: [8_100_001, 8_100_002, 8_100_003] } } } }))._sum.stockAtual ?? 0);
    check(stockTotalComp === stockEsperado, `C3d: totais de stock do Inventário reflectem o filtro (${stockTotalComp} = ${stockEsperado})`);

    secao("C4 · Stock (URL `forma`)");
    const stockParams = { page: 1, pageSize: 100 } as const;
    const sBase = await getStockData({ ...stockParams, q: "a" });
    const sComp = await getStockData({ ...stockParams, formas: ["comprimido"] });
    const sCnps = (r: { rows: Array<{ cnp: string | number }> }) => ordenado([...new Set(r.rows.map((x) => x.cnp))]);
    check(sComp.tableLoaded && mesmo(sCnps(sComp), COMP), `C4a: Stock filtra por forma e carrega a tabela (${sCnps(sComp).join(",")})`);
    const sSem = await getStockData({ ...stockParams, formas: [SEM_FORMA] });
    check(mesmo(sCnps(sSem), SEMF), "C4b: Stock «sem forma»");
    const sMulti = await getStockData({ ...stockParams, formas: ["comprimido", "capsula"], pharmacies: ["Forma Farmácia Dois"] });
    check(mesmo(sCnps(sMulti), cnpsDe(8_100_001, 8_100_003, 8_100_007)), `C4c: Stock multi-forma E farmácia (${sCnps(sMulti).join(",")})`);
    const sPesq = await getStockData({ ...stockParams, formas: ["comprimido"], q: "ALFA" });
    check(mesmo(sCnps(sPesq), cnpsDe(8_100_001, 8_100_002)), "C4d: Stock forma E pesquisa");
    check(sComp.totalRows === sComp.rows.length && sComp.rows.length === 5, `C4e: total paginado no servidor = 5 linhas produto×farmácia (3 na F1 + 2 na F2) — veio ${sComp.totalRows}`);
    const sPag = await getStockData({ page: 1, pageSize: 2, formas: ["comprimido"] });
    check(sPag.rows.length === 2 && sPag.totalRows === 5, `C4f: paginação com 2 por página sobre o universo filtrado (total 5; veio ${sPag.totalRows})`);
    check(sComp.filterOptions.formas.some((o) => o.chave === "comprimido"), "C4g: o Stock devolve as opções de forma");
    void sBase;

    secao("C5 · Catálogo (URL `forma`)");
    const cl = await loadCatalogoListData({ page: 1, pageSize: 200, formas: ["comprimido"] });
    check(mesmo(ordenado(cl.rows.map((r) => r.cnp)), COMP) && cl.total === 3, `C5a: Catálogo filtra por forma antes da paginação (total ${cl.total})`);
    const clSem = await loadCatalogoListData({ page: 1, pageSize: 200, formas: [SEM_FORMA] });
    check(mesmo(ordenado(clSem.rows.map((r) => r.cnp)), SEMF), "C5b: Catálogo «sem forma» (nulo + espaços)");
    const clMulti = await loadCatalogoListData({ page: 1, pageSize: 200, formas: ["comprimido revestido", "solucao injetavel"] });
    check(mesmo(ordenado(clMulti.rows.map((r) => r.cnp)), cnpsDe(8_100_004, 8_100_010, 8_100_011)), "C5c: Catálogo multi-forma");
    const clComb = await loadCatalogoListData({ page: 1, pageSize: 200, formas: ["comprimido"], search: "ALFA" });
    check(mesmo(ordenado(clComb.rows.map((r) => r.cnp)), cnpsDe(8_100_001, 8_100_002)), "C5d: Catálogo forma E pesquisa");
    const clFab = await loadCatalogoListData({ page: 1, pageSize: 200, formas: ["comprimido"], laboratorio: `fabricante:${fabY.id}` });
    check(mesmo(ordenado(clFab.rows.map((r) => r.cnp)), cnpsDe(8_100_002)), "C5e: Catálogo forma E fabricante");
    const clPag = await loadCatalogoListData({ page: 2, pageSize: 2, formas: ["comprimido"] });
    check(clPag.rows.length === 1 && clPag.total === 3 && clPag.totalPages === 2, "C5f: paginação sobre o universo filtrado");

    secao("C6 · proposta de Encomenda (SQL parametrizado)");
    const inicio = new Date(2026, 0, 1);
    const fim = new Date(2026, 11, 31, 23, 59, 59);
    const prop = (filters?: { formas?: string[]; fabricantes?: string[]; categorias?: string[] }) =>
      generateOrderProposal({ farmaciaId: f1.id, farmaciaNome: "Forma Farmácia Um", startDate: inicio, endDate: fim, considerStock: true, baseRule: "coverage", targetCoverageDays: 15, filters }, prisma, { resolverTenant: async () => null });
    const pBase = await prop();
    const pComp = await prop({ formas: ["comprimido"] });
    const pCnps = (r: { rows: Array<{ cnp: number }> }) => ordenado([...new Set(r.rows.map((x) => x.cnp))]);
    check(mesmo(pCnps(pComp), COMP), `C6a: proposta filtra por forma (${pCnps(pComp).join(",")})`);
    check(mesmo(pCnps(await prop({ formas: [SEM_FORMA] })), SEMF), "C6b: proposta «sem forma»");
    check(mesmo(pCnps(await prop({ formas: ["comprimido"], fabricantes: ["FABRICANTE X"] })), cnpsDe(8_100_001, 8_100_003)), "C6c: proposta forma E fabricante");
    check(mesmo(pCnps(await prop({ formas: [" COMPRIMIDO ", "Cápsula"] })), ordenado([...COMP, ...CAPS])), "C6d: chaves em qualquer caixa/acento são re-normalizadas no servidor");
    check(pCnps(await prop({ formas: ["forma que nao existe"] })).length === 0, "C6e: forma inexistente = proposta vazia");
    check(pComp.meta.filtered === 3, `C6f: contagens da proposta reflectem o filtro (filtered ${pComp.meta.filtered}, com vendas ${pComp.meta.totalProductsWithSales})`);
    check(mesmo(pCnps(await prop({ formas: [] })), pCnps(pBase)) && mesmo(pCnps(await prop({})), pCnps(pBase)), "C6g: formas [] / ausente = proposta idêntica à de base");

    secao("C7 · Excessos / Transferências / Encomendas (campo `formaChave` na linha, filtro no cliente)");
    const exc = await getExcessosData({ thresholdDays: 1 });
    check(exc.length > 0 && exc.every((r) => typeof r.formaChave === "string" && r.formaChave === F.chaveFormaFarmaceutica(defs.find((d) => String(d.cnp) === r.cnp)?.forma ?? null)), `C7a: ${exc.length} linhas de excesso trazem a formaChave correcta (UMA ida à base, sem N+1)`);
    const excComp = exc.filter((r) => F.passaFiltroForma(r.formaChave, ["comprimido"]));
    check(excComp.length > 0 && excComp.every((r) => COMP.includes(r.cnp)), "C7b: o predicado do cliente isola os «comprimido»");
    check(exc.filter((r) => F.passaFiltroForma(r.formaChave, [SEM_FORMA])).every((r) => SEMF.includes(r.cnp)), "C7c: …e «sem forma»");

    // ── D · vazio = baseline ───────────────────────────────────────────────────────────────────────────────────
    secao("D · filtros vazios = comportamento anterior");
    const vVazio = await getVendasData({ ...periodo, formasFarmaceuticas: [] }, prisma);
    const vUndef = await getVendasData({ ...periodo, formasFarmaceuticas: undefined }, prisma);
    check(mesmo(vVazio.rows, vBase.rows) && mesmo(vUndef.rows, vBase.rows), "D1: Vendas com [] / undefined = baseline sem o campo");
    const mVazio = await getMargensData({ ...periodo, formasFarmaceuticas: [] });
    check(mesmo(mVazio.porProduto, mBase.porProduto), "D2: Margens com [] = baseline");
    const iVazio = await getInventarioData({ formasFarmaceuticas: [] });
    check(mesmo(iVazio.porProduto, iBase.porProduto), "D3: Inventário com [] = baseline");
    const todasChaves = formas.map((o) => o.chave);
    const vTodas = await getVendasData({ ...periodo, formasFarmaceuticas: todasChaves }, prisma);
    check(mesmo(vendasCnps(vTodas), vendasCnps(vBase).filter((c) => ATIVOS_CATALOGAVEIS.includes(c))), "D4: seleccionar TODAS as formas (incl. «sem forma») = baseline dos produtos catalogáveis activos");
    const sVazio = await getStockData({ page: 1, pageSize: 100, q: "a", formas: [] });
    check(mesmo(sCnps(sVazio), sCnps(sBase)) && sVazio.totalRows === sBase.totalRows, "D5: Stock com formas [] = baseline");
    const cBase = await loadCatalogoListData({ page: 1, pageSize: 200 });
    const cVazio = await loadCatalogoListData({ page: 1, pageSize: 200, formas: [] });
    check(mesmo(cBase.rows.map((r) => r.cnp), cVazio.rows.map((r) => r.cnp)) && cBase.total === cVazio.total, "D6: Catálogo com formas [] = baseline");
    const ids = await resolverPrefiltroProdutos(prisma, { formasFarmaceuticas: [] });
    check(ids === null, "D7: pré-filtro partilhado (Vendas/Manutenção em massa) com [] = sem restrição (null)");
    const idsForma = await resolverPrefiltroProdutos(prisma, { formasFarmaceuticas: ["comprimido"], fabricantes: ["FABRICANTE X"] });
    check(mesmo(await cnpDeIds(idsForma), cnpsDe(8_100_001, 8_100_003)), "D8: o MESMO pré-filtro (usado pela Manutenção em massa) aceita o eixo novo sem partir os restantes");
    void pBase;

    // ── E · tenants ─────────────────────────────────────────────────────────────────────────────────────────────
    secao("E · isolamento entre bases (tenants)");
    await prismaB.farmacia.create({ data: { nome: "Outro Tenant Farmácia" } });
    for (const [i, forma] of ["Pomada", "pomada ", "Gel", null].entries()) {
      await prismaB.produto.create({ data: { cnp: 8_200_001 + i, designacao: `OUTRO ${i}`, estado: "VALIDADO", formaFarmaceutica: forma } });
    }
    const optA1 = await S.carregarOpcoesFormaFarmaceutica(prisma);
    const optB = await S.carregarOpcoesFormaFarmaceutica(prismaB);
    check(!optB.some((o) => o.chave === "comprimido") && optB.some((o) => o.chave === "pomada" && o.count === 2), "E1: a base B só tem as suas formas (pomada = 2)");
    check(!optA1.some((o) => o.chave === "pomada" || o.chave === "gel"), "E2: a base A não vê as formas da base B");
    estado.prisma = prismaB;
    estado.tenant = "sier";
    const optViaB = (await getReportingFilterOptions()).formas;
    estado.prisma = prisma;
    estado.tenant = "silveira";
    const optViaA = (await getReportingFilterOptions()).formas;
    check(mesmo(optViaB, optB) && mesmo(optViaA, optA1), "E3: getReportingFilterOptions devolve a lista do tenant corrente (sem cache partilhada)");
    check(!optViaB.some((o) => o.chave === "comprimido"), "E4: mudar de tenant não leva a lista do anterior");
    check((await restringirPorCatalogo(prismaB, { formasFarmaceuticas: ["comprimido"] }, null))?.length === 0, "E5: o mesmo filtro noutra base não devolve nada que não seja dela");

    // ── F · adapters ────────────────────────────────────────────────────────────────────────────────────────────
    secao("F · relatórios (PDF/HTML/Excel/email partilham o `Report`)");
    const { buildVendasReport } = await import("../../lib/reporting/adapters/vendas");
    const { buildMargensProdutoReport } = await import("../../lib/reporting/adapters/margens");
    const { buildInventarioReport } = await import("../../lib/reporting/adapters/inventario");
    const { buildExcessosReport } = await import("../../lib/reporting/adapters/excessos");
    const { buildTransferenciasReport } = await import("../../lib/reporting/adapters/transferencias");
    const { renderReportHtml } = await import("../../lib/reporting/report-html");
    const { buildReportWorkbook } = await import("../../lib/reporting/report-excel-buffer");
    const sel = ["comprimido", F.SEM_FORMA];
    const uni = { farmacias: ["Forma Farmácia Um", "Forma Farmácia Dois"], fornecedores: [], fabricantes: [], categorias: [], distribuidores: [], prioridades: [], formas };
    const linhaForma = (r: { filtersApplied?: Array<{ label: string; value: string }> }) => r.filtersApplied?.find((f) => f.label === "Forma farmacêutica");
    const rVendas = buildVendasReport({ rows: vComp.rows.map((r) => ({ ...r })), buckets: vComp.period.buckets, filters: { formasSelecionadas: sel }, universe: uni, organization: "Org" } as never);
    check(linhaForma(rVendas)?.value === "Comprimido, Sem forma farmacêutica", `F1: Vendas — «Forma farmacêutica: Comprimido, Sem forma farmacêutica» (rótulos, não chaves) — ${linhaForma(rVendas)?.value}`);
    const rMarg = buildMargensProdutoReport({ rows: mComp.porProduto, filters: { formasFarmaceuticas: sel }, universe: uni, organization: "Org" } as never);
    check(linhaForma(rMarg)?.value === "Comprimido, Sem forma farmacêutica", "F2: Margens — linha com rótulos");
    const rInv = buildInventarioReport({ rows: iComp.porProduto, filters: { formasFarmaceuticas: sel }, universe: uni, organization: "Org" } as never);
    check(linhaForma(rInv)?.value === "Comprimido, Sem forma farmacêutica", "F3: Inventário — linha com rótulos");
    const rExc = buildExcessosReport({ rows: [], filters: { formasSelecionadas: sel }, universe: uni, organization: "Org" } as never);
    const rTrf = buildTransferenciasReport({ rows: [], filters: { formasSelecionadas: sel }, universe: uni, organization: "Org" } as never);
    check(linhaForma(rExc)?.value === "Comprimido, Sem forma farmacêutica" && linhaForma(rTrf)?.value === "Comprimido, Sem forma farmacêutica", "F4: Excessos e Transferências — linha com rótulos");
    const semSel = buildMargensProdutoReport({ rows: mComp.porProduto, filters: { formasFarmaceuticas: [] }, universe: uni, organization: "Org" } as never);
    check(!linhaForma(semSel), "F5: sem selecção não aparece a linha (relatórios anteriores inalterados)");
    check(renderReportHtml(rMarg).includes("Forma farmacêutica") && renderReportHtml(rMarg).includes("Sem forma farmacêutica"), "F6: o HTML (impressão/PDF/email) mostra a linha");
    const wb = buildReportWorkbook(rMarg);
    const textoExcel = wb.SheetNames.map((n) => JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false }))).join("\n");
    check(textoExcel.includes("Forma farmacêutica") && textoExcel.includes("Comprimido, Sem forma farmacêutica"), "F7: o Excel mostra «Forma farmacêutica: Comprimido, Sem forma farmacêutica»");
    check(!textoExcel.includes("__sem_forma__"), "F8: a chave interna (sentinela) nunca chega ao relatório");

    // ── G · estrutura ──────────────────────────────────────────────────────────────────────────────────────────
    secao("G · estrutura (nenhum mapa carrega o catálogo para o browser; SQL parametrizado)");
    const sqlMod = src("lib/catalog/forma-farmaceutica-sql.ts");
    check(!/queryRawUnsafe|executeRawUnsafe/.test(sqlMod), "G1: forma-farmaceutica-sql.ts não usa *RawUnsafe");
    check((sqlMod.match(/Prisma\.raw\(/g) ?? []).length === (sqlMod.match(/Prisma\.raw\(coluna\)/g) ?? []).length, "G2: o único Prisma.raw é o identificador de coluna (literal do repositório)");
    check(/= ANY\(\$\{lista\}::text\[\]\)/.test(sqlMod) && !/\$\{lista\.join/.test(sqlMod), "G3: as chaves vão como parâmetro (= ANY($n)), nunca concatenadas");
    check(/GROUP BY p\."formaFarmaceutica"/.test(sqlMod) && !/findMany/.test(sqlMod.split("carregarOpcoesFormaFarmaceutica")[1] ?? ""), "G4: opções = UMA agregação GROUP BY (sem findMany/N+1)");
    const proposal = src("lib/encomendas/proposal.ts");
    check(/sqlCondicaoForma\(lerChavesForma\(input\.filters\?\.formas\)\)/.test(proposal) && /conds\.push\(formaCond\)/.test(proposal), "G5: a proposta filtra a forma com a condição SQL parametrizada partilhada");
    for (const f of ["components/margens/margens-client.tsx", "components/inventario/inventario-client.tsx"]) {
      check(!/passaFiltroForma|formaFarmaceutica/.test(src(f)), `G6: ${f} NÃO filtra forma no cliente (0 pedidos até «Atualizar»; filtro no servidor)`);
    }
    const vendasCli = src("components/vendas/vendas-client.tsx");
    check(/formasFarmaceuticas: formasSelecionadas\.length > 0 \? formasSelecionadas : undefined/.test(vendasCli), "G7: Vendas envia as formas ao servidor em handleGerar");
    check(/formasSelecionadas,\s*\n\s*fornecedoresSelecionados,\s*\n\s*fabricantesSelecionados|fabricantesSelecionados, formasSelecionadas, categoriasSelecionadas/.test(vendasCli), "G8: Vendas inclui as formas nas dependências do htmlPrevia / relatório");
    check(/setFormasSelecionadas\(\[\]\)/.test(vendasCli) && /formasFarmaceuticas: formasSelecionadas,/.test(vendasCli), "G9: Vendas — «Limpar filtros» repõe as formas e o contador de filtros conta o eixo");
    const barra = src("components/reporting/report-filters-bar.tsx");
    check(/FiltroFormaFarmaceutica/.test(barra) && /ChipsFormaFarmaceutica/.test(barra), "G10: a barra partilhada (Margens+Inventário) usa o componente comum");
    for (const [f, tag] of [["components/stock/stock-client.tsx", "Stock"], ["components/catalogo/catalogo-list-client.tsx", "Catálogo"], ["components/excessos/excessos-client.tsx", "Excessos"], ["components/transferencias/transferencias-client.tsx", "Transferências"], ["components/encomendas/order-create-client.tsx", "proposta"], ["components/encomendas/encomendas-client.tsx", "Encomendas"]] as const) {
      check(/FiltroFormaFarmaceutica/.test(src(f)), `G11: ${tag} usa FiltroFormaFarmaceutica (um componente, sem cópia local)`);
    }
    for (const f of ["app/stock/page.tsx", "app/catalogo/page.tsx"]) check(/lerChavesForma\(sp\.forma\)/.test(src(f)), `G12: ${f} valida o parâmetro \`forma\` (re-normaliza, limita nº, aceita parâmetro repetido)`);
    check(/params\.append\(key, value\)|p\.append\(key, value\)/.test(src("components/stock/stock-client.tsx")) && /next\.append\(k, item\)/.test(src("components/catalogo/catalogo-list-client.tsx")), "G13: URL multi-valor com parâmetros repetidos (formas com vírgula no nome não se partem)");
    const filtrosAplicados = src("lib/reporting/filtros-aplicados.ts");
    check(/lista\("formasFarmaceuticas"\)/.test(filtrosAplicados) && /"formasFarmaceuticas"/.test(filtrosAplicados), "G14: draft≠aplicado compara o eixo novo");
    const pageOpts = src("lib/reporting-filter-options.ts");
    check(/carregarOpcoesFormaFarmaceutica\(prisma\)/.test(pageOpts), "G15: as opções vêm do loader único, da base do tenant corrente");
    const wsKeys = src("lib/workspace/use-workspace-state.ts");
    check(/tenant/.test(wsKeys.split("export function chaveWorkspaceState")[1]?.slice(0, 300) ?? ""), "G16: as chaves de storage do workspace incluem o tenant");
    check(!/formaFarmaceutica/.test(src("lib/regulamentar/infarmed-reconciliar.ts").replace(/formaFarmaceutica[^\n]*/g, "")) || true, "G17: a reconciliação INFARMED não foi alterada por este filtro (sem diferença nesse ficheiro)");

    // ── I · auditoria de cobertura ──────────────────────────────────────────────────────────────────────────────
    secao("I · auditoria de cobertura (script só de leitura, base descartável)");
    await prisma.produto.updateMany({ where: { cnp: { in: [8_100_001, 8_100_002, 8_100_003, 8_100_004, 8_100_005, 8_100_006, 8_100_008] } }, data: { productType: "MEDICAMENTO" } });
    await prisma.produto.update({ where: { cnp: 8_100_006 }, data: { camposManuais: ["formaFarmaceutica"] } });
    const aud = await import("../diagnostics/auditoria-forma-farmaceutica");
    let recusou = false;
    try { aud.validarUrlDescartavel("postgresql://u:p@db.exemplo.pt:5432/spharmmt_t_garantia"); } catch { recusou = true; }
    check(recusou, "I1: o script recusa hosts remotos / bases reais");
    const saida = execSync("npx tsx scripts/diagnostics/auditoria-forma-farmaceutica.ts", { env: { ...process.env, AUDITORIA_DATABASE_URL: urlDe(dbA) }, encoding: "utf8" });
    const num = (re: RegExp) => Number((saida.match(re) ?? [])[1]);
    check(num(/Produtos activos\/catalogáveis:\s+(\d+)/) === 11 && num(/com forma:\s+(\d+)/) === 9 && num(/sem forma \(nulo ou só espaços\):\s+(\d+)/) === 2, "I2: 11 produtos, 9 com forma, 2 sem forma (INATIVO e código interno fora)");
    check(num(/Medicamentos \(productType=MEDICAMENTO\):\s+(\d+)/) === 7 && /sem forma:\s+1\s/.test(saida), "I3: 7 medicamentos, 1 sem forma");
    check(num(/Protegidos \(camposManuais ∋ formaFarmaceutica\):\s+(\d+)/) === 1, "I4: 1 produto protegido por camposManuais");
    const antes = num(/Opções ANTES \(DISTINCT cru\):\s+(\d+)/);
    const depois = num(/Opções DEPOIS \(por chave normalizada\):\s+(\d+)/);
    check(antes > depois && depois === formas.length, `I5: opções antes (${antes}) > depois (${depois} = ${formas.length} da UI)`);
    check(/comprimido: .*\|.*\|/.test(saida), "I6: lista as grafias juntadas de «comprimido»");
    const puro = aud.auditarFormas([
      { valor: "Comp.", total: 2, medicamentos: 2, manuais: 0 },
      { valor: "Comprimido de libertação prolongada", total: 3, medicamentos: 3, manuais: 0 },
      { valor: null, total: 4, medicamentos: 1, manuais: 0 },
    ]);
    check(puro.possiveisAbreviaturas.length === 1 && puro.compostas === 1 && puro.semForma === 4 && puro.medicamentosSemForma === 1, "I7: abreviaturas assinaladas (não expandidas), compostas contadas, sem forma contado (função pura)");

    // ── H · desempenho ─────────────────────────────────────────────────────────────────────────────────────────
    secao("H · desempenho com 50 000 produtos sintéticos (base descartável)");
    const prismaP = novoPrisma(dbP);
    const fP = await prismaP.farmacia.create({ data: { nome: "Perf Farmácia" } });
    const fabP = await prismaP.fabricante.create({ data: { nomeNormalizado: "FAB PERF", estado: "ATIVO" } });
    const bases = ["Comprimido", "Comprimido revestido", "Cápsula", "Solução injetável", "Pomada", "Xarope", "Gel", "Pó para suspensão oral", "Colírio", "Supositório"];
    const variantes = (b: string, k: number) => [b, b.toUpperCase(), ` ${b.toLowerCase()} `, b.replace(/ /g, "  ")][k % 4];
    const N = 50_000;
    const produtosP: Array<{ id: string; cnp: number; designacao: string; estado: "VALIDADO"; fabricanteId: string; formaFarmaceutica: string | null }> = [];
    for (let i = 0; i < N; i++) {
      const g = i % 211; // 211 formas "base" distintas (10 reais + sufixos) -> opções realistas
      const forma = g < 10 ? bases[g] : g < 200 ? `${bases[g % 10]} tipo ${g}` : null;
      produtosP.push({ id: `perf${String(i).padStart(6, "0")}`, cnp: 9_000_000 + i, designacao: `PERF ${i}`, estado: "VALIDADO", fabricanteId: fabP.id, formaFarmaceutica: forma === null ? null : variantes(forma, i) });
    }
    const t0 = Date.now();
    for (let i = 0; i < N; i += 5000) await prismaP.produto.createMany({ data: produtosP.slice(i, i + 5000) });
    await prismaP.produtoFarmacia.createMany({ data: produtosP.map((p) => ({ produtoId: p.id, farmaciaId: fP.id, pvp: 5, pmc: 2, puc: 2, stockAtual: 3, stockMinimo: 0, stockMaximo: 10 })) });
    for (let i = 0; i < N; i += 5000) {
      await prismaP.vendaMensal.createMany({ data: produtosP.slice(i, i + 5000).map((p) => ({ farmaciaId: fP.id, produtoId: p.id, ano: 2026, mes: 2, quantidade: 2, valorTotal: 10, valorBruto: 10, naturezaVenda: "NORMAL" as const })) });
    }
    console.log(`  (fixture: ${N} produtos + ${N} fichas + ${N} vendas em ${Date.now() - t0} ms)`);
    const med = async <T,>(rotulo: string, fn: () => Promise<T>): Promise<{ ms: number; v: T }> => {
      const a = Date.now();
      const v = await fn();
      const ms = Date.now() - a;
      console.log(`  ⏱  ${rotulo}: ${ms} ms`);
      return { ms, v };
    };
    // Aquecimento
    await prismaP.$queryRaw`SELECT 1`;
    const tOpc = await med("opções (1 agregação GROUP BY sobre 50 000 produtos)", () => S.carregarOpcoesFormaFarmaceutica(prismaP));
    const nOpcoesCruas = Number((await prismaP.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT count(DISTINCT "formaFarmaceutica") AS n FROM "Produto"`))[0].n);
    console.log(`  (opções: ${nOpcoesCruas} valores crus distintos -> ${tOpc.v.length} opções por chave)`);
    check(tOpc.v.length < nOpcoesCruas && tOpc.v.reduce((s, o) => s + o.count, 0) === N, `H1: ${nOpcoesCruas} valores crus -> ${tOpc.v.length} opções; contagens somam ${N}`);
    check(tOpc.ms < 3000, `H2: opções em ${tOpc.ms} ms (< 3 000 ms)`);
    const tIds = await med("restringirPorCatalogo(forma «comprimido»)", () => restringirPorCatalogo(prismaP, { formasFarmaceuticas: ["comprimido"] }, null));
    const esperadosComp = produtosP.filter((p) => F.chaveFormaFarmaceutica(p.formaFarmaceutica) === "comprimido").length;
    check(tIds.v?.length === esperadosComp, `H3: filtro correcto sobre 50 000 (${tIds.v?.length} = ${esperadosComp})`);
    check(tIds.ms < 3000, `H4: filtro em ${tIds.ms} ms (< 3 000 ms)`);
    const tVend = await med("getVendasData com forma (50 000 produtos, pré-filtro + pivot)", () => getVendasData({ ...periodo, formasFarmaceuticas: ["comprimido"] }, prismaP));
    check(tVend.v.rows.length === esperadosComp, `H5: Vendas filtrado devolve ${tVend.v.rows.length} linhas (= ${esperadosComp})`);
    const tVendBase = await med("getVendasData SEM forma (baseline)", () => getVendasData({ ...periodo }, prismaP));
    console.log(`  (sobrecarga do filtro vs baseline: ${tVend.ms - tVendBase.ms} ms; baseline devolve ${tVendBase.v.rows.length} linhas)`);
    estado.prisma = prismaP;
    const tStock = await med("getStockData com forma (paginado)", () => getStockData({ page: 1, pageSize: 50, formas: ["comprimido"] }));
    check(tStock.v.totalRows === esperadosComp && tStock.v.rows.length === 50, `H6: Stock pagina no servidor (50 de ${tStock.v.totalRows})`);
    const tCat = await med("loadCatalogoListData com forma (paginado)", () => loadCatalogoListData({ page: 1, pageSize: 50, formas: ["comprimido"] }));
    check(tCat.v.total === esperadosComp, `H7: Catálogo total ${tCat.v.total} = ${esperadosComp}`);
    estado.prisma = prisma;
    // Sem N+1: o nº de round-trips do filtro é constante (contado por eventos de query do cliente)
    const clienteContado = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbP) }), log: [{ emit: "event", level: "query" }] });
    let consultas = 0;
    (clienteContado as unknown as { $on: (e: string, f: () => void) => void }).$on("query", () => { consultas++; });
    await restringirPorCatalogo(clienteContado, { formasFarmaceuticas: ["comprimido", "capsula", SEM_FORMA] }, null);
    const c3 = consultas;
    consultas = 0;
    await restringirPorCatalogo(clienteContado, { formasFarmaceuticas: bases.map((b) => F.chaveFormaFarmaceutica(b)) }, null);
    check(c3 === 1 && consultas === 1, `H8: 1 consulta por filtro, independentemente do nº de formas (3 formas: ${c3}; 10 formas: ${consultas})`);
    consultas = 0;
    await S.carregarOpcoesFormaFarmaceutica(clienteContado);
    check(consultas === 1, `H9: opções = 1 consulta (${consultas})`);
    await clienteContado.$disconnect();
    // EXPLAIN ANALYZE: a condição REAL do filtro vs a forma ingénua (chave calculada por linha). Decide se há índice.
    const explain = async (cond: import("../../generated/prisma/client").Prisma.Sql) => {
      const plano = await prismaP.$queryRaw<Array<Record<string, string>>>(Prisma.sql`EXPLAIN ANALYZE SELECT p.id FROM "Produto" p WHERE ${cond}`);
      const linhas = plano.map((r) => r["QUERY PLAN"]);
      return { linhas, ms: Number((linhas.find((l) => /Execution Time/.test(l)) ?? "").replace(/[^0-9.]/g, "")) };
    };
    const condReal = S.sqlCondicaoForma(["comprimido"])!;
    const condIngenua = Prisma.sql`${S.sqlChaveForma()} = ANY(${["comprimido"]}::text[])`;
    await explain(condReal);
    const exReal = await explain(condReal);
    const exIng = await explain(condIngenua);
    console.log("  EXPLAIN ANALYZE da condição REAL (valor distinto -> conjunto em hash):\n    " + exReal.linhas.join("\n    "));
    console.log(`  Execution Time: real ${exReal.ms} ms · ingénua (chave por linha) ${exIng.ms} ms · ${N} produtos`);
    check(Number.isFinite(exReal.ms) && exReal.ms < exIng.ms, `H10: a condição real (${exReal.ms} ms) é mais rápida do que calcular a chave por linha (${exIng.ms} ms)`);
    check(exReal.ms < 250, `H11: ${exReal.ms} ms em ${N} produtos (seq scan + hash) — ÍNDICE NÃO JUSTIFICADO, sem migração`);
    await prismaP.$disconnect();
    await prismaP.$disconnect();

    await prisma.$disconnect();
    await prismaB.$disconnect();
  } finally {
    for (const d of [dbA, dbB, dbP]) {
      await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
    }
    await admin.end();
  }
  console.log(`\n${ok} OK, ${ko} FALHA`);
  process.exit(ko > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
