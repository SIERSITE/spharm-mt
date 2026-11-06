/**
 * scripts/tests/test-generico-db.ts
 *
 * Filtro «Genérico» (Produto.flagGenerico) em TODOS os ecrãs, contra PostgreSQL DESCARTÁVEL (recusa hosts não locais), dados SINTÉTICOS.
 *
 *   Fixture: 230 artigos «cedo» NÃO genéricos (enchem o topo dos Excessos) + 9 «tarde» (depois da posição 200):
 *      k  forma         Ético/NETT (F1/F2)   genérico     excesso
 *      0  Comprimido    ETICO/ETICO          sim            37
 *      1  Comprimido    ETICO/ETICO          não            40
 *      2  Comprimido    NETT/NETT            sim            43
 *      3  Cápsula       ETICO/ETICO          sim            46
 *      4  Cápsula       NETT/NETT            não            49
 *      5  Comprimido    ETICO/NETT (diverg.) sim            52
 *      6  (sem forma)   —                    não            55
 *      7  Comprimido    —                    sim            58
 *      8  Comprimido    —                    não            61
 *
 *   A · valores nulos: a coluna é NOT NULL; o ingest transforma nulo/ausente em false (= «não genérico»);
 *   B · filtro server-side ANTES do corte de 200 e dos totais (Excessos/Transferências);
 *   C · Vendas / Margens / Inventário / Stock / Catálogo / proposta / lista de Encomendas;
 *   D · combinação com Ético/NETT, forma farmacêutica, fabricante, farmácia, pesquisa;
 *   E · partição: GENERICO ∪ NAO_GENERICO = baseline, linha a linha (nenhum cálculo muda); Todos/undefined = baseline;
 *   F · exportação: linha «Genérico: …» dos filtros aplicados (a base de PDF/impressão/Excel/email);
 *   G · isolamento entre bases (tenants).
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-generico-db.ts
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

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
  if (request === "@/lib/integracao/auth") {
    return {
      withIntegrationAuth: (handler: (ctx: unknown, req: unknown) => Promise<Response>) => async (req: unknown) =>
        handler({ prisma: estado.prisma, tenant: { slug: "garantia" } }, req),
    };
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
const ordenado = (xs: Iterable<string | number>) => [...xs].map(String).sort();
const mesmo = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const soma = (xs: number[]) => xs.reduce((s, n) => s + n, 0);

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
  const dbA = `spharm_gen_a_${suf}`;
  const dbB = `spharm_gen_b_${suf}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const d of [dbA, dbB]) await admin.query(`CREATE DATABASE ${d}`);
  try {
    for (const d of [dbA, dbB]) execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(d) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(dbA);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    process.env.ENABLE_AGENT_BOOTSTRAP = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbA) }) });
    const prismaB = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbB) }) });
    estado.prisma = prisma;
    estado.tenant = "silveira";

    const { getVendasData } = await import("../../lib/vendas-data");
    const { getMargensData } = await import("../../lib/margens-data");
    const { getInventarioData } = await import("../../lib/inventario-data");
    const { getStockData } = await import("../../lib/stock-data");
    const { loadCatalogoListData, loadCatalogoFilterOptions } = await import("../../lib/catalogo-data");
    const { generateOrderProposal } = await import("../../lib/encomendas/proposal");
    const { getExcessosData, getTransferenciasData } = await import("../../lib/transferencias-data");
    const { loadOrderListData } = await import("../../lib/encomendas/orders-data");
    const { getReportingFilterOptions } = await import("../../lib/reporting-filter-options");
    const { resolverPrefiltroProdutos } = await import("../../lib/reporting/prefiltro-produtos");
    const { restringirPorCatalogo } = await import("../../lib/reporting/catalog-prefilter");
    const { buildExcessosReport } = await import("../../lib/reporting/adapters/excessos");
    const { carregarOpcoesGenerico } = await import("../../lib/catalog/generico-sql");

    const f1 = await prisma.farmacia.create({ data: { nome: "GEN Farmácia Um" } });
    const f2 = await prisma.farmacia.create({ data: { nome: "GEN Farmácia Dois" } });
    const user = await prisma.utilizador.create({ data: { email: "gen@t.pt", nome: "GEN", perfil: "ADMINISTRADOR" } });
    const fabA = await prisma.fabricante.create({ data: { nomeNormalizado: "GEN ALFA FAB", estado: "ATIVO" } });
    const fabB = await prisma.fabricante.create({ data: { nomeNormalizado: "GEN BETA FAB", estado: "ATIVO" } });
    const forn = await prisma.fornecedor.create({ data: { nomeNormalizado: "GEN FORN", estado: "ATIVO" } });

    const N_CEDO = 230;
    type Cls = "ETICO" | "NETT" | null;
    const TARDE: Array<{ k: number; forma: string | null; c1: Cls; c2: Cls; g: boolean; fab: { id: string } }> = [
      { k: 0, forma: "Comprimido", c1: "ETICO", c2: "ETICO", g: true, fab: fabA },
      { k: 1, forma: "Comprimido", c1: "ETICO", c2: "ETICO", g: false, fab: fabA },
      { k: 2, forma: "Comprimido", c1: "NETT", c2: "NETT", g: true, fab: fabB },
      { k: 3, forma: "Cápsula", c1: "ETICO", c2: "ETICO", g: true, fab: fabA },
      { k: 4, forma: "Cápsula", c1: "NETT", c2: "NETT", g: false, fab: fabA },
      { k: 5, forma: "Comprimido", c1: "ETICO", c2: "NETT", g: true, fab: fabA },
      { k: 6, forma: null, c1: null, c2: null, g: false, fab: fabA },
      { k: 7, forma: "Comprimido", c1: null, c2: null, g: true, fab: fabA },
      { k: 8, forma: "Comprimido", c1: null, c2: null, g: false, fab: fabA },
    ];
    const cnpCedo = (i: number) => 8_700_000 + i;
    const cnpTarde = (k: number) => 8_750_000 + k;
    const sTarde = (k: number) => 40 + 3 * k;
    await prisma.produto.createMany({
      data: [
        ...Array.from({ length: N_CEDO }, (_, i) => ({ cnp: cnpCedo(i), designacao: `GEN cedo ${i}`, estado: "VALIDADO" as const, fabricanteId: fabB.id, formaFarmaceutica: "Xarope", flagGenerico: false })),
        ...TARDE.map((t) => ({ cnp: cnpTarde(t.k), designacao: `GEN tarde ${t.k}`, estado: "VALIDADO" as const, fabricanteId: t.fab.id, formaFarmaceutica: t.forma, flagGenerico: t.g })),
      ],
    });
    const prodId = new Map<number, string>();
    for (const p of await prisma.produto.findMany({ select: { id: true, cnp: true } })) prodId.set(Number(p.cnp), p.id);
    const def = new Map(TARDE.map((t) => [cnpTarde(t.k), t]));
    const pf = [];
    const vendas = [];
    for (const cnp of [...Array.from({ length: N_CEDO }, (_, i) => cnpCedo(i)), ...TARDE.map((t) => cnpTarde(t.k))]) {
      const e = cnp < 8_750_000;
      const idx = e ? cnp - 8_700_000 : cnp - 8_750_000;
      const produtoId = prodId.get(cnp)!;
      const t = def.get(cnp);
      pf.push({ produtoId, farmaciaId: f1.id, pvp: 5, pmc: 4, puc: 2, stockAtual: e ? 500 + idx : sTarde(idx), stockMinimo: 0, stockMaximo: 9999, fornecedorHabitualId: forn.id, eticoNett: t?.c1 ?? null });
      pf.push({ produtoId, farmaciaId: f2.id, pvp: 5, pmc: 4, puc: 2, stockAtual: e ? 2 : 10, stockMinimo: 0, stockMaximo: 9999, fornecedorHabitualId: forn.id, eticoNett: t?.c2 ?? null });
      vendas.push({ farmaciaId: f1.id, produtoId, ano: 2026, mes: 2, quantidade: 9, valorTotal: 45, valorBruto: 45, naturezaVenda: "NORMAL" as const });
      vendas.push({ farmaciaId: f2.id, produtoId, ano: 2026, mes: 2, quantidade: 90, valorTotal: 450, valorBruto: 450, naturezaVenda: "NORMAL" as const });
    }
    await prisma.produtoFarmacia.createMany({ data: pf });
    await prisma.vendaMensal.createMany({ data: vendas });

    const kc = (...ks: number[]) => ks.map((k) => String(cnpTarde(k)));
    const G = kc(0, 2, 3, 5, 7);
    const NG_TARDE = kc(1, 4, 6, 8);
    const TODOS_TARDE = kc(0, 1, 2, 3, 4, 5, 6, 7, 8);
    const exc = (k: number) => 37 + 3 * k;
    const OPC = { thresholdDays: 60, targetDays: 30, dataInicio: "2026-01-01", dataFim: "2026-03-31" } as const;
    const periodo = { from: "2026-01-01", to: "2026-12-31" };

    // ═══ A · valores nulos ═══
    secao("A · valores nulos");
    let rejeitou = false;
    try { await prisma.$executeRawUnsafe(`UPDATE "Produto" SET "flagGenerico" = NULL WHERE cnp = ${cnpTarde(0)}`); } catch { rejeitou = true; }
    check(rejeitou, "a coluna é NOT NULL: a base recusa NULL (não há «sem classificação» a tratar)");
    const { POST } = await import("../../app/api/ingest/v1/bootstrap/products/route");
    const item = (cnp: number, extra: Record<string, unknown>) => ({
      externalProductId: cnp, cnp, designacao: `ING ${cnp}`, pvp: 1, pmc: 1, puc: 1, dataUltimaVenda: null, dataUltimaCompra: null, retirado: false,
      mnsrmNCompart: false, fornecedorHabitualId: null, fornecedorHabitualNome: null, taxaIva: null, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: null, ...extra,
    });
    const farmIng = await prisma.farmacia.create({ data: { nome: "GEN Ingest" } });
    const req = new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      farmaciaId: farmIng.id,
      items: [item(8_800_001, { generico: true }), item(8_800_002, { generico: false }), item(8_800_003, { generico: null }), item(8_800_004, {})],
    }) });
    const resp = await (POST as unknown as (r: Request) => Promise<Response>)(req);
    check(resp.status === 200, "o ingest aceita o lote com generico true/false/null/ausente");
    const flags = Object.fromEntries((await prisma.produto.findMany({ where: { cnp: { in: [8_800_001, 8_800_002, 8_800_003, 8_800_004] } } })).map((p) => [Number(p.cnp), p.flagGenerico]));
    check(flags[8_800_001] === true && flags[8_800_002] === false && flags[8_800_003] === false && flags[8_800_004] === false, "nulo/ausente do ERP ou de um agent antigo -> false (= não genérico)");
    const idsNG = await restringirPorCatalogo(prisma, { generico: "NAO_GENERICO" }, null);
    const cnpsNG = (await prisma.produto.findMany({ where: { id: { in: idsNG ?? [] } }, select: { cnp: true } })).map((p) => Number(p.cnp));
    check(cnpsNG.includes(8_800_003) && cnpsNG.includes(8_800_004) && cnpsNG.includes(8_800_002) && !cnpsNG.includes(8_800_001), "«Apenas não genéricos» inclui os artigos sem informação do ERP (decisão documentada)");
    // Os 4 artigos do ingest saem do universo dos ecrãs seguintes (apagam-se com a associação à farmácia).
    await prisma.produtoFarmacia.deleteMany({ where: { farmaciaId: farmIng.id } });
    await prisma.produto.deleteMany({ where: { cnp: { in: [8_800_001, 8_800_002, 8_800_003, 8_800_004] } } });

    // ═══ B · Excessos / Transferências ═══
    secao("B · Excessos e Transferências: o filtro corre ANTES do corte de 200 e dos totais");
    const cnpsDe = (rows: Array<{ cnp: string }>) => ordenado(rows.map((r) => r.cnp));
    const excD = (generico?: string, extra: Record<string, unknown> = {}) => getExcessosData({ ...OPC, ...(generico ? { generico } : {}), ...extra });
    const trf = (generico?: string) => getTransferenciasData({ ...OPC, ...(generico ? { generico } : {}) });
    const tot = (rows: Awaited<ReturnType<typeof excD>>) => ({ linhas: rows.length, excesso: soma(rows.map((r) => r.excessoOrigem)), custo: soma(rows.map((r) => r.valorCustoExcesso ?? 0)) });
    const e0 = await excD();
    check(e0.length === 200 && !e0.some((r) => TODOS_TARDE.includes(r.cnp)), "sem filtro só 200 linhas e nenhum «tarde» (um filtro só no cliente não os veria)", `n=${e0.length}`);
    const eG = await excD("GENERICO");
    check(mesmo(cnpsDe(eG), ordenado(G)), "GENERICO: os 5 genéricos «tarde», e nenhum dos 230 não genéricos", cnpsDe(eG).join(","));
    check(tot(eG).excesso === soma([0, 2, 3, 5, 7].map(exc)) && tot(eG).custo === 4 * soma([0, 2, 3, 5, 7].map(exc)), `totais exactos de GENERICO (excesso ${soma([0, 2, 3, 5, 7].map(exc))}, custo ×4)`, JSON.stringify(tot(eG)));
    const eN = await excD("NAO_GENERICO");
    check(eN.length === 200 && cnpsDe(eN).every((c) => !G.includes(c)), "NAO_GENERICO: 200 linhas (corte) sem nenhum genérico");
    const eNTarde = await excD("NAO_GENERICO", { eticoNett: ["ETICO"] });
    check(mesmo(cnpsDe(eNTarde), ordenado(kc(1))), "NAO_GENERICO E ÉTICO = só o k1");
    const eGE = await excD("GENERICO", { eticoNett: ["ETICO"] });
    check(mesmo(cnpsDe(eGE), ordenado(kc(0, 3))), "GENERICO E ÉTICO = k0 e k3 (o k5 é divergente no tenant)");
    const eGDiv = await excD("GENERICO", { eticoNett: ["DIVERGENTE"] });
    check(mesmo(cnpsDe(eGDiv), ordenado(kc(5))), "GENERICO E DIVERGENTE = k5");
    const eGForma = await excD("GENERICO", { formasFarmaceuticas: ["capsula"] });
    check(mesmo(cnpsDe(eGForma), ordenado(kc(3))), "GENERICO E forma «Cápsula» = k3");
    const eGFormaE = await excD("GENERICO", { formasFarmaceuticas: ["comprimido"], eticoNett: ["NETT"] });
    check(mesmo(cnpsDe(eGFormaE), ordenado(kc(2))), "GENERICO E Comprimido E NETT = k2");
    check(mesmo(cnpsDe(await excD("lixo")), cnpsDe(e0)) && mesmo(cnpsDe(await excD("")), cnpsDe(e0)), "valor inválido/vazio = Todos (nunca SQL)");
    const tG = await trf("GENERICO");
    check(mesmo(ordenado([...new Set(tG.map((r) => r.cnp))]), ordenado(G)), "Transferências: GENERICO no servidor");

    // ═══ C · Vendas / Margens / Inventário ═══
    secao("C · Vendas, Margens, Inventário");
    const vCnps = (r: { rows: Array<{ codigo: string }> }) => ordenado([...new Set(r.rows.map((x) => x.codigo))]);
    const vBase = await getVendasData({ ...periodo }, prisma);
    const vG = await getVendasData({ ...periodo, generico: "GENERICO" }, prisma);
    check(mesmo(vCnps(vG), ordenado(G)), "Vendas GENERICO: só os 5 genéricos");
    check(vG.rows.reduce((s, r) => s + r.totalVendas, 0) === 5 * (9 + 90), "totais de Vendas reflectem o filtro (5 × 99)");
    const vNG = await getVendasData({ ...periodo, generico: "NAO_GENERICO" }, prisma);
    check(vCnps(vNG).length === N_CEDO + NG_TARDE.length && NG_TARDE.every((c) => vCnps(vNG).includes(c)) && G.every((c) => !vCnps(vNG).includes(c)), "Vendas NAO_GENERICO: os 230 + k1,k4,k6,k8");
    const vGE = await getVendasData({ ...periodo, generico: "GENERICO", eticoNett: ["ETICO"], farmaciaNomes: ["GEN Farmácia Um"] }, prisma);
    check(mesmo(vCnps(vGE), ordenado(kc(0, 3, 5))), "GENERICO E ÉTICO com só a farmácia Um (k5 é Ético para a Um)");
    const vGFab = await getVendasData({ ...periodo, generico: "GENERICO", fabricantes: ["GEN BETA FAB"] }, prisma);
    check(mesmo(vCnps(vGFab), ordenado(kc(2))), "GENERICO E fabricante (BETA) = k2");
    const vGPesq = await getVendasData({ ...periodo, generico: "GENERICO", pesquisa: "tarde 7" }, prisma);
    check(mesmo(vCnps(vGPesq), ordenado(kc(7))), "GENERICO E pesquisa");
    const vGPer = await getVendasData({ from: "2026-03-01", to: "2026-03-31", generico: "GENERICO" }, prisma);
    check(vG.rows.length > 0 && vGPer.rows.length === 0, "GENERICO E período (sem vendas em Março) = vazio");
    check(mesmo((await getVendasData({ ...periodo, generico: undefined }, prisma)).rows, vBase.rows), "Todos (undefined) = baseline");

    const mCnps = (r: { porProduto: Array<{ cnp: number }> }) => ordenado([...new Set(r.porProduto.map((x) => x.cnp))]);
    check(mesmo(mCnps(await getMargensData({ ...periodo, generico: "GENERICO" })), ordenado(G)), "Margens GENERICO");
    check(mesmo(mCnps(await getMargensData({ ...periodo, generico: "GENERICO", eticoNett: ["NETT"] })), ordenado(kc(2))), "Margens GENERICO E NETT");
    const iG = await getInventarioData({ generico: "GENERICO" });
    check(mesmo(mCnps(iG as never), ordenado(G)), "Inventário GENERICO");
    const stockEsperado = [0, 2, 3, 5, 7].reduce((s, k) => s + sTarde(k) + 10, 0);
    check(iG.porProduto.reduce((s, r) => s + (r.stockAtual ?? 0), 0) === stockEsperado, `totais de stock do Inventário (${stockEsperado})`);

    // ═══ D · Stock / Catálogo ═══
    secao("D · Stock e Catálogo (parâmetro de URL `generico`)");
    const sCnps = (r: { rows: Array<{ cnp: string | number }> }) => ordenado([...new Set(r.rows.map((x) => x.cnp))]);
    const sG = await getStockData({ page: 1, pageSize: 100, generico: "GENERICO" });
    check(sG.tableLoaded && mesmo(sCnps(sG), ordenado(G)) && sG.totalRows === 10, `Stock GENERICO: 5 produtos × 2 farmácias = 10 linhas (total no servidor ${sG.totalRows})`);
    const sPag = await getStockData({ page: 2, pageSize: 4, generico: "GENERICO" });
    check(sPag.rows.length === 4 && sPag.totalRows === 10, "Stock: paginação sobre o universo filtrado");
    check(mesmo(sCnps(await getStockData({ page: 1, pageSize: 100, generico: "GENERICO", eticoNett: ["ETICO"], pharmacies: ["GEN Farmácia Um"] })), ordenado(kc(0, 3, 5))), "Stock GENERICO E ÉTICO (farmácia Um)");
    check(sG.filterOptions.generico?.genericos === 5, "Stock devolve as contagens (5 genéricos)");

    const cl = await loadCatalogoListData({ page: 1, pageSize: 200, generico: "GENERICO" });
    check(mesmo(ordenado(cl.rows.map((r) => r.cnp)), ordenado(G)) && cl.total === 5, `Catálogo GENERICO antes da paginação (total ${cl.total})`);
    const clPag = await loadCatalogoListData({ page: 2, pageSize: 2, generico: "GENERICO" });
    check(clPag.rows.length === 2 && clPag.total === 5 && clPag.totalPages === 3, "Catálogo: paginação sobre o universo filtrado");
    const clNG = await loadCatalogoListData({ page: 1, pageSize: 500, generico: "NAO_GENERICO" });
    check(clNG.total === N_CEDO + 4, `Catálogo NAO_GENERICO = ${N_CEDO + 4}`, `total=${clNG.total}`);
    const clComb = await loadCatalogoListData({ page: 1, pageSize: 200, generico: "GENERICO", eticoNett: ["ETICO"], formas: ["comprimido"] });
    check(mesmo(ordenado(clComb.rows.map((r) => r.cnp)), ordenado(kc(0))), "Catálogo GENERICO E ÉTICO E Comprimido = k0");
    const opt = await loadCatalogoFilterOptions();
    check(opt.generico.genericos === 5 && opt.generico.naoGenericos === N_CEDO + 4, "Catálogo: contagens das opções");

    // ═══ E · proposta e lista de Encomendas ═══
    secao("E · proposta de Encomenda e lista de Encomendas");
    const inicio = new Date(2026, 0, 1);
    const fim = new Date(2026, 11, 31, 23, 59, 59);
    const prop = (filters?: { generico?: "GENERICO" | "NAO_GENERICO"; eticoNett?: string[] }) =>
      generateOrderProposal({ farmaciaId: f1.id, farmaciaNome: "GEN Farmácia Um", startDate: inicio, endDate: fim, considerStock: true, baseRule: "coverage", targetCoverageDays: 15, filters }, prisma, { resolverTenant: async () => null });
    const pc = (r: { rows: Array<{ cnp: number }> }) => ordenado([...new Set(r.rows.map((x) => x.cnp))]);
    check(mesmo(pc(await prop({ generico: "GENERICO" })), ordenado(G)), "proposta GENERICO (antes do corte de linhas)");
    check(mesmo(pc(await prop({ generico: "GENERICO", eticoNett: ["ETICO"] })), ordenado(kc(0, 3, 5))), "proposta GENERICO E ÉTICO (classificação da farmácia Um)");
    check(mesmo(pc(await prop({ generico: undefined })), pc(await prop())), "proposta Todos = base");
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 12; i++) {
      const alvo = i === 0 ? [prodId.get(cnpTarde(0))!, prodId.get(cnpCedo(0))!] : i === 1 ? [prodId.get(cnpTarde(1))!] : [prodId.get(cnpCedo(10 + i))!];
      await prisma.listaEncomenda.create({ data: { nome: `GEN Enc ${String(i).padStart(2, "0")}`, estado: "FINALIZADA", farmaciaId: i % 2 === 0 ? f1.id : f2.id, criadoPorId: user.id, dataCriacao: new Date(base + i * 86_400_000), linhas: { create: alvo.map((produtoId) => ({ produtoId, quantidadeAjustada: 1 })) } } });
    }
    const lista = (generico?: "GENERICO" | "NAO_GENERICO", extra: Record<string, unknown> = {}) => loadOrderListData(prisma, { page: 1, pageSize: 25, ...(generico ? { generico } : {}), ...extra } as Parameters<typeof loadOrderListData>[1]);
    const nomes = (d: Awaited<ReturnType<typeof lista>>) => d.orders.map((o) => o.nome).sort();
    check(mesmo(nomes(await lista("GENERICO")), ["GEN Enc 00"]) && (await lista("GENERICO")).total === 1, "lista GENERICO: a encomenda com um genérico (inteira, 2 linhas)");
    check((await lista("GENERICO")).orders[0].linhasCount === 2, "…aparece INTEIRA (linhasCount do documento)");
    check((await lista("NAO_GENERICO")).total === 12 && (await lista()).total === 12, "lista NAO_GENERICO = 12 (todas têm um não genérico); Todos = 12");
    check(mesmo(nomes(await lista("GENERICO", { eticoNett: ["NETT"] })), []), "lista GENERICO E NETT (farmácia da encomenda) sem resultados");

    // ═══ F · exportação ═══
    secao("F · exportações: linha «Genérico: …» dos filtros aplicados");
    const rep = buildExcessosReport({
      rows: eG.map((r) => ({ ...r })) as never,
      filters: { ...OPC, genericoSelecionado: "GENERICO", eticoNettSelecionados: ["ETICO"] } as never,
      universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [], prioridades: [] },
      organization: "GEN",
    });
    const linha = (rep.filtersApplied ?? []).find((f) => f.label === "Genérico");
    check(linha?.value === "Apenas genéricos", "o Report (base de PDF, impressão, Excel e email) leva «Genérico: Apenas genéricos»", JSON.stringify(rep.filtersApplied ?? []));
    check(rep.rows.length === eG.length, "…com exactamente as linhas filtradas");
    const repN = buildExcessosReport({ rows: e0 as never, filters: { ...OPC, genericoSelecionado: "NAO_GENERICO" } as never, universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [], prioridades: [] }, organization: "GEN" });
    check((repN.filtersApplied ?? []).find((f) => f.label === "Genérico")?.value === "Apenas não genéricos", "«Apenas não genéricos»");
    const repT = buildExcessosReport({ rows: e0 as never, filters: { ...OPC } as never, universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [], prioridades: [] }, organization: "GEN" });
    check(!(repT.filtersApplied ?? []).some((f) => f.label === "Genérico"), "Todos não tem linha");

    // ═══ P · partição e nenhum cálculo alterado ═══
    secao("P · GENERICO ∪ NAO_GENERICO = baseline, linha a linha (nenhum cálculo muda)");
    const chave = (r: { codigo: string; farmacia?: string }) => `${r.codigo}|${r.farmacia ?? ""}`;
    const uniao = [...vG.rows, ...vNG.rows].sort((a, b) => chave(a).localeCompare(chave(b)));
    const baseOrd = [...vBase.rows].sort((a, b) => chave(a).localeCompare(chave(b)));
    check(mesmo(uniao, baseOrd.filter((r) => uniao.some((u) => chave(u) === chave(r)))) && uniao.length === baseOrd.length, "Vendas: as linhas de G e NG, juntas, são idênticas às do baseline (mesmos valores)");
    check(soma(vG.rows.map((r) => r.totalVendas)) + soma(vNG.rows.map((r) => r.totalVendas)) === soma(vBase.rows.map((r) => r.totalVendas)), "Vendas: G + NG somam o total do baseline");
    const eUn = [...eG, ...(await excD("NAO_GENERICO"))];
    check(eG.every((r) => { const b = e0.concat(eG).find((x) => x.cnp === r.cnp && x.farmaciaOrigem === r.farmaciaOrigem); return b ? b.excessoOrigem === r.excessoOrigem && b.quantidadeSugerida === r.quantidadeSugerida : true; }) && eUn.length >= eG.length, "Excessos: os valores por linha são os de sempre");
    const opcoes0 = (await getReportingFilterOptions()).generico;
    check(opcoes0.genericos === 5 && opcoes0.naoGenericos === N_CEDO + 4, "getReportingFilterOptions devolve as contagens");
    check((await resolverPrefiltroProdutos(prisma, { generico: "GENERICO" }))?.length === 5 && (await resolverPrefiltroProdutos(prisma, {})) === null, "pré-filtro partilhado: GENERICO = 5 ids; sem filtro = null");

    // ═══ G · tenants ═══
    secao("G · isolamento entre tenants");
    await prismaB.farmacia.create({ data: { nome: "GEN Outro Tenant" } });
    await prismaB.produto.create({ data: { cnp: 8_900_001, designacao: "OUTRO TENANT G", estado: "VALIDADO", flagGenerico: true } });
    await prismaB.produto.create({ data: { cnp: 8_900_002, designacao: "OUTRO TENANT NG", estado: "VALIDADO", flagGenerico: false } });
    const oB = await carregarOpcoesGenerico(prismaB as never);
    check(oB.genericos === 1 && oB.naoGenericos === 1, "a base B só vê os seus 1+1");
    const oA = await carregarOpcoesGenerico(prisma as never);
    check(oA.genericos === 5, "a base A não vê os da B");
    estado.prisma = prismaB; estado.tenant = "sier";
    const optB = (await getReportingFilterOptions()).generico;
    estado.prisma = prisma; estado.tenant = "silveira";
    check(optB.genericos === 1 && optB.naoGenericos === 1, "getReportingFilterOptions respeita o tenant");

    await prisma.$disconnect();
    await prismaB.$disconnect();
  } finally {
    for (const d of [dbA, dbB]) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${ok} OK, ${ko} FALHA(S)`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
