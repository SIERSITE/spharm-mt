/**
 * scripts/tests/test-etico-nett-ecras-db.ts
 *
 * Filtro Ético/NETT em TODOS os ecrãs, contra PostgreSQL REAL e DESCARTÁVEL (recusa hosts não locais), dados SINTÉTICOS.
 *
 *   Fixture: 230 artigos «cedo» SEM classificação que enchem o topo dos Excessos + 9 artigos «tarde», DEPOIS da posição 200:
 *     k0..k2  ETICO nas duas farmácias            (excesso 37+40+43 = 120)
 *     k3..k4  NETT  nas duas farmácias            (46+49 = 95)
 *     k5..k6  DIVERGENTE: F1 = ETICO, F2 = NETT   (52+55 = 107)
 *     k7..k8  SEM classificação                   (58+61 = 119)
 *
 *   · Excessos: corte de 200 linhas e totais — o filtro corre ANTES (um filtro só no cliente daria 0 linhas);
 *   · Vendas / Margens / Inventário / Stock / Catálogo / proposta de Encomenda / lista de Encomendas;
 *   · combinação (E) com outros eixos, âmbito por farmácia, vazio = baseline;
 *   · exportações (PDF/Excel/email partilham o mesmo Report): a linha «Ético/NETT: …» dos filtros aplicados.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-etico-nett-ecras-db.ts
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
  const db = `spharm_en_ecras_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(db);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
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
    const { buildExcessosReport } = await import("../../lib/reporting/adapters/excessos");

    // ── Fixture ──────────────────────────────────────────────────────────────────────────────────────────────
    const f1 = await prisma.farmacia.create({ data: { nome: "EN Farmácia Um" } });
    const f2 = await prisma.farmacia.create({ data: { nome: "EN Farmácia Dois" } });
    const user = await prisma.utilizador.create({ data: { email: "en@t.pt", nome: "EN", perfil: "ADMINISTRADOR" } });
    const fabA = await prisma.fabricante.create({ data: { nomeNormalizado: "EN ALFA FAB", estado: "ATIVO" } });
    const fabB = await prisma.fabricante.create({ data: { nomeNormalizado: "EN BETA FAB", estado: "ATIVO" } });
    const forn = await prisma.fornecedor.create({ data: { nomeNormalizado: "EN FORN", estado: "ATIVO" } });

    const N_CEDO = 230;
    type Cls = "ETICO" | "NETT" | null;
    const TARDE: Array<{ k: number; f1: Cls; f2: Cls; fab: { id: string } }> = [
      { k: 0, f1: "ETICO", f2: "ETICO", fab: fabA },
      { k: 1, f1: "ETICO", f2: "ETICO", fab: fabA },
      { k: 2, f1: "ETICO", f2: "ETICO", fab: fabB },
      { k: 3, f1: "NETT", f2: "NETT", fab: fabA },
      { k: 4, f1: "NETT", f2: "NETT", fab: fabA },
      { k: 5, f1: "ETICO", f2: "NETT", fab: fabA },
      { k: 6, f1: "ETICO", f2: "NETT", fab: fabA },
      { k: 7, f1: null, f2: null, fab: fabA },
      { k: 8, f1: null, f2: null, fab: fabA },
    ];
    const cnpCedo = (i: number) => 8_600_000 + i;
    const cnpTarde = (k: number) => 8_650_000 + k;
    const sTarde = (k: number) => 40 + 3 * k;

    await prisma.produto.createMany({
      data: [
        ...Array.from({ length: N_CEDO }, (_, i) => ({ cnp: cnpCedo(i), designacao: `EN cedo ${i}`, estado: "VALIDADO" as const, fabricanteId: fabB.id })),
        ...TARDE.map((t) => ({ cnp: cnpTarde(t.k), designacao: `EN tarde ${t.k}`, estado: "VALIDADO" as const, fabricanteId: t.fab.id })),
      ],
    });
    const prodId = new Map<number, string>();
    for (const p of await prisma.produto.findMany({ select: { id: true, cnp: true } })) prodId.set(Number(p.cnp), p.id);
    const classeDe = new Map(TARDE.map((t) => [cnpTarde(t.k), t]));
    const pf = [];
    const vendas = [];
    for (const cnp of [...Array.from({ length: N_CEDO }, (_, i) => cnpCedo(i)), ...TARDE.map((t) => cnpTarde(t.k))]) {
      const e = cnp < 8_650_000;
      const idx = e ? cnp - 8_600_000 : cnp - 8_650_000;
      const produtoId = prodId.get(cnp)!;
      const t = classeDe.get(cnp);
      pf.push({ produtoId, farmaciaId: f1.id, pvp: 5, pmc: 4, puc: 2, stockAtual: e ? 500 + idx : sTarde(idx), stockMinimo: 0, stockMaximo: 9999, fornecedorHabitualId: forn.id, eticoNett: t?.f1 ?? null });
      pf.push({ produtoId, farmaciaId: f2.id, pvp: 5, pmc: 4, puc: 2, stockAtual: e ? 2 : 10, stockMinimo: 0, stockMaximo: 9999, fornecedorHabitualId: forn.id, eticoNett: t?.f2 ?? null });
      vendas.push({ farmaciaId: f1.id, produtoId, ano: 2026, mes: 2, quantidade: 9, valorTotal: 45, valorBruto: 45, naturezaVenda: "NORMAL" as const });
      vendas.push({ farmaciaId: f2.id, produtoId, ano: 2026, mes: 2, quantidade: 90, valorTotal: 450, valorBruto: 450, naturezaVenda: "NORMAL" as const });
    }
    await prisma.produtoFarmacia.createMany({ data: pf });
    await prisma.vendaMensal.createMany({ data: vendas });

    const OPC = { thresholdDays: 60, targetDays: 30, dataInicio: "2026-01-01", dataFim: "2026-03-31" } as const;
    const kc = (...ks: number[]) => ks.map((k) => String(cnpTarde(k)));
    const ETICO = kc(0, 1, 2);
    const NETT = kc(3, 4);
    const DIVERG = kc(5, 6);
    const SEMT = kc(7, 8);
    const TODOS_TARDE = kc(0, 1, 2, 3, 4, 5, 6, 7, 8);
    const EXC = { etico: 120, nett: 95, div: 107, sem: 119 };
    const porLinha = 20;
    const periodo = { from: "2026-01-01", to: "2026-12-31" };

    // ═══ E · Excessos (corte de 200 linhas) ═══
    secao("E · Excessos: o filtro corre ANTES do corte de 200 e dos totais");
    const cnpsDe = (rows: Array<{ cnp: string }>) => ordenado(rows.map((r) => r.cnp));
    const exc = (eticoNett?: string[], extra: Record<string, unknown> = {}) => getExcessosData({ ...OPC, ...(eticoNett ? { eticoNett } : {}), ...extra });
    const trf = (eticoNett?: string[]) => getTransferenciasData({ ...OPC, ...(eticoNett ? { eticoNett } : {}) });
    const tot = (rows: Awaited<ReturnType<typeof exc>>) => ({
      linhas: rows.length,
      excesso: soma(rows.map((r) => r.excessoOrigem)),
      sugerida: soma(rows.map((r) => r.quantidadeSugerida)),
      custo: soma(rows.map((r) => r.valorCustoExcesso ?? 0)),
    });
    const e0 = await exc();
    check(e0.length === 200 && !e0.some((r) => TODOS_TARDE.includes(r.cnp)), "E1: sem filtro só 200 linhas e nenhum dos 9 «tarde» — um filtro só no cliente não os veria", `n=${e0.length}`);
    const eE = await exc(["ETICO"]);
    check(mesmo(cnpsDe(eE), ordenado(ETICO)) && tot(eE).excesso === EXC.etico, `E2: ÉTICO aparece (3 linhas, ${EXC.etico} unidades)`, JSON.stringify(tot(eE)));
    check(tot(eE).custo === 4 * EXC.etico && tot(eE).sugerida === 3 * porLinha, "E3: custo e unidades sugeridas exactos (4×120, 3×20)", JSON.stringify(tot(eE)));
    const eN = await exc(["NETT"]);
    check(mesmo(cnpsDe(eN), ordenado(NETT)) && tot(eN).excesso === EXC.nett, `E4: NETT (2 linhas, ${EXC.nett} unidades)`);
    const eD = await exc(["DIVERGENTE"]);
    check(mesmo(cnpsDe(eD), ordenado(DIVERG)) && tot(eD).excesso === EXC.div, `E5: DIVERGENTE (Ético numa farmácia, NETT noutra) = 2 linhas, ${EXC.div} unidades`);
    const eS = await exc(["SEM"]);
    check(eS.length === 200 && TODOS_TARDE.every((c) => !cnpsDe(eS).includes(c) || SEMT.includes(c)), "E6: SEM não traz nenhum classificado (Ético/NETT/Divergente) e respeita o corte de 200");
    const eU = await exc(["ETICO", "NETT"]);
    check(mesmo(cnpsDe(eU), ordenado([...ETICO, ...NETT])) && tot(eU).excesso === EXC.etico + EXC.nett, "E7: união Ético+NETT = 5 linhas (sem divergentes)");
    const eAll = await exc(["ETICO", "NETT", "DIVERGENTE"]);
    check(eAll.length === 7 && tot(eAll).excesso === EXC.etico + EXC.nett + EXC.div, "E8: Ético+NETT+Divergente = 7 linhas, 322 unidades");
    check(mesmo(cnpsDe(await exc([])), cnpsDe(e0)) && mesmo(cnpsDe(await exc(undefined)), cnpsDe(e0)), "E10: [] / ausente = baseline");
    check(mesmo(cnpsDe(await exc(["ETICO", "lixo", "x"])), ordenado(ETICO)), "E11: valores inválidos são descartados (nunca SQL)");
    check((await exc(["lixo"])).length === 200, "E12: só valores inválidos = sem filtro (como vazio)");
    const tN = await trf(["NETT"]);
    check(mesmo(ordenado([...new Set(tN.map((r) => r.cnp))]), ordenado(NETT)), "E13: Transferências filtra por NETT no servidor");
    const tD = await trf(["DIVERGENTE"]);
    check(mesmo(ordenado([...new Set(tD.map((r) => r.cnp))]), ordenado(DIVERG)), "E14: Transferências filtra por DIVERGENTE");

    // ═══ V · Vendas / Margens / Inventário ═══
    secao("V · Vendas, Margens, Inventário");
    const vCnps = (r: { rows: Array<{ codigo: string }> }) => ordenado([...new Set(r.rows.map((x) => x.codigo))]);
    const vBase = await getVendasData({ ...periodo }, prisma);
    const vE = await getVendasData({ ...periodo, eticoNett: ["ETICO"] }, prisma);
    check(mesmo(vCnps(vE), ordenado(ETICO)), `V1: Vendas filtra por ÉTICO (${vCnps(vE).length} produtos)`);
    const vD = await getVendasData({ ...periodo, eticoNett: ["DIVERGENTE"] }, prisma);
    check(mesmo(vCnps(vD), ordenado(DIVERG)), "V2: Vendas DIVERGENTE");
    const vTot = vE.rows.reduce((s, r) => s + r.totalVendas, 0);
    check(vTot === 3 * (9 + 90), `V3: totais de Vendas reflectem o filtro (${vTot} = 297)`);
    const vFab = await getVendasData({ ...periodo, eticoNett: ["ETICO"], fabricantes: ["EN BETA FAB"] }, prisma);
    check(mesmo(vCnps(vFab), kc(2)), "V4: Ético E fabricante (AND)");
    // âmbito por farmácia: só a F2 → o divergente passa a ser NETT para a F2
    const vF2 = await getVendasData({ ...periodo, eticoNett: ["NETT"], farmaciaNomes: ["EN Farmácia Dois"] }, prisma);
    check(mesmo(vCnps(vF2), ordenado([...NETT, ...DIVERG])), "V5: com a farmácia Dois seleccionada, NETT inclui os 'divergentes' (para ela são NETT)");
    const vF1 = await getVendasData({ ...periodo, eticoNett: ["ETICO"], farmaciaNomes: ["EN Farmácia Um"] }, prisma);
    check(mesmo(vCnps(vF1), ordenado([...ETICO, ...DIVERG])), "V6: com a farmácia Um seleccionada, ÉTICO inclui os 'divergentes' (para ela são Ético)");
    const vVazio = await getVendasData({ ...periodo, eticoNett: [] }, prisma);
    check(mesmo(vVazio.rows, vBase.rows), "V7: [] = baseline");

    const mCnps = (r: { porProduto: Array<{ cnp: number }> }) => ordenado([...new Set(r.porProduto.map((x) => x.cnp))]);
    const mN = await getMargensData({ ...periodo, eticoNett: ["NETT"] });
    check(mesmo(mCnps(mN), ordenado(NETT)), "M1: Margens filtra por NETT");
    check(mesmo(mCnps(await getMargensData({ ...periodo, eticoNett: ["DIVERGENTE"] })), ordenado(DIVERG)), "M2: Margens DIVERGENTE");
    const mBase = await getMargensData({ ...periodo });
    check(mesmo((await getMargensData({ ...periodo, eticoNett: [] })).porProduto, mBase.porProduto), "M3: Margens [] = baseline");

    const iCnps = (r: { porProduto: Array<{ cnp: number }> }) => ordenado([...new Set(r.porProduto.map((x) => x.cnp))]);
    const iE = await getInventarioData({ eticoNett: ["ETICO"] });
    check(mesmo(iCnps(iE), ordenado(ETICO)), "I1: Inventário filtra por ÉTICO");
    const stockEsperado = ETICO.reduce((s, c) => s + 2 * 0 + sTarde(Number(c) - 8_650_000) + 10, 0);
    const stockTotal = iE.porProduto.reduce((s, r) => s + (r.stockAtual ?? 0), 0);
    check(stockTotal === stockEsperado, `I2: totais de stock do Inventário reflectem o filtro (${stockTotal} = ${stockEsperado})`);
    const iBase = await getInventarioData({});
    check(mesmo((await getInventarioData({ eticoNett: [] })).porProduto, iBase.porProduto), "I3: Inventário [] = baseline");

    // ═══ S · Stock / Catálogo ═══
    secao("S · Stock e Catálogo (parâmetro de URL `eticoNett`)");
    const sCnps = (r: { rows: Array<{ cnp: string | number }> }) => ordenado([...new Set(r.rows.map((x) => x.cnp))]);
    const sE = await getStockData({ page: 1, pageSize: 100, eticoNett: ["ETICO"] });
    check(sE.tableLoaded && mesmo(sCnps(sE), ordenado(ETICO)), `S1: Stock filtra por ÉTICO (${sCnps(sE).length})`);
    check(sE.totalRows === 6, `S2: total paginado no servidor = 6 linhas (3 produtos × 2 farmácias) — veio ${sE.totalRows}`);
    const sPag = await getStockData({ page: 1, pageSize: 2, eticoNett: ["ETICO"] });
    check(sPag.rows.length === 2 && sPag.totalRows === 6, "S3: paginação (2 por página) sobre o universo filtrado");
    check(mesmo(sCnps(await getStockData({ page: 1, pageSize: 100, eticoNett: ["DIVERGENTE"] })), ordenado(DIVERG)), "S4: Stock DIVERGENTE");
    const sF2 = await getStockData({ page: 1, pageSize: 100, eticoNett: ["NETT"], pharmacies: ["EN Farmácia Dois"] });
    check(mesmo(sCnps(sF2), ordenado([...NETT, ...DIVERG])), "S5: Stock NETT com a farmácia Dois: inclui os 'divergentes'");
    check(sE.filterOptions.eticoNett.map((o) => o.valor).join() === "ETICO,NETT,SEM,DIVERGENTE", "S6: Stock devolve as 4 opções");
    const sOpt = Object.fromEntries(sE.filterOptions.eticoNett.map((o) => [o.valor, o.count]));
    check(sOpt.ETICO === 3 && sOpt.NETT === 2 && sOpt.DIVERGENTE === 2 && sOpt.SEM === N_CEDO + 2, "S7: contagens das opções (3/2/2/232)", JSON.stringify(sOpt));

    const cl = await loadCatalogoListData({ page: 1, pageSize: 200, eticoNett: ["ETICO"] });
    check(mesmo(ordenado(cl.rows.map((r) => r.cnp)), ordenado(ETICO)) && cl.total === 3, `C1: Catálogo filtra por ÉTICO antes da paginação (total ${cl.total})`);
    const clPag = await loadCatalogoListData({ page: 2, pageSize: 2, eticoNett: ["ETICO"] });
    check(clPag.rows.length === 1 && clPag.total === 3 && clPag.totalPages === 2, "C2: paginação sobre o universo filtrado");
    check(mesmo(ordenado((await loadCatalogoListData({ page: 1, pageSize: 200, eticoNett: ["DIVERGENTE"] })).rows.map((r) => r.cnp)), ordenado(DIVERG)), "C3: Catálogo DIVERGENTE");
    const clSem = await loadCatalogoListData({ page: 1, pageSize: 500, eticoNett: ["SEM"] });
    check(clSem.total === N_CEDO + 2, `C4: Catálogo SEM = ${N_CEDO + 2} (cedo + k7,k8)`, `total=${clSem.total}`);
    const clComb = await loadCatalogoListData({ page: 1, pageSize: 200, eticoNett: ["ETICO", "NETT"], search: "tarde 3" });
    check(mesmo(ordenado(clComb.rows.map((r) => r.cnp)), kc(3)), "C5: Catálogo Ético/NETT E pesquisa");
    const clBase = await loadCatalogoListData({ page: 1, pageSize: 200 });
    const clVazio = await loadCatalogoListData({ page: 1, pageSize: 200, eticoNett: [] });
    check(mesmo(clBase.rows.map((r) => r.cnp), clVazio.rows.map((r) => r.cnp)) && clBase.total === clVazio.total, "C6: [] = baseline");
    const catOpt = await loadCatalogoFilterOptions();
    check(mesmo(catOpt.eticoNett, sE.filterOptions.eticoNett), "C7: Catálogo e Stock usam as mesmas opções");

    // ═══ P · proposta e lista de Encomendas ═══
    secao("P · proposta de Encomenda e lista de Encomendas");
    const inicio = new Date(2026, 0, 1);
    const fim = new Date(2026, 11, 31, 23, 59, 59);
    const prop = (filters?: { eticoNett?: string[]; fabricantes?: string[] }) =>
      generateOrderProposal({ farmaciaId: f1.id, farmaciaNome: "EN Farmácia Um", startDate: inicio, endDate: fim, considerStock: true, baseRule: "coverage", targetCoverageDays: 15, filters }, prisma, { resolverTenant: async () => null });
    const pCnps = (r: { rows: Array<{ cnp: number }> }) => ordenado([...new Set(r.rows.map((x) => x.cnp))]);
    check(mesmo(pCnps(await prop({ eticoNett: ["ETICO"] })), ordenado([...ETICO, ...DIVERG])), "P1: proposta da farmácia Um filtra por ÉTICO com a classificação DA FARMÁCIA UM (os «divergentes» são Ético nela)");
    check(mesmo(pCnps(await prop({ eticoNett: ["DIVERGENTE"] })), []), "P2: DIVERGENTE não existe numa proposta de uma só farmácia");
    check(mesmo(pCnps(await prop({ eticoNett: ["NETT"], fabricantes: ["EN ALFA FAB"] })), ordenado(NETT)), "P3: proposta NETT E fabricante");
    check(mesmo(pCnps(await prop({ eticoNett: [] })), pCnps(await prop())), "P4: [] = proposta de base");
    check((await prop({ eticoNett: ["NETT"] })).meta.filtered === 2, "P5: contagens da proposta reflectem o filtro");

    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 40; i++) {
      const alvo = i < 3 ? [prodId.get(cnpTarde(i))!, prodId.get(cnpCedo(i))!] : i === 3 ? [prodId.get(cnpTarde(5))!] : [prodId.get(cnpCedo(10 + i))!];
      await prisma.listaEncomenda.create({
        data: {
          nome: `EN Enc ${String(i).padStart(2, "0")}`,
          estado: "FINALIZADA",
          farmaciaId: i % 2 === 0 ? f1.id : f2.id,
          criadoPorId: user.id,
          dataCriacao: new Date(base + i * 86_400_000),
          linhas: { create: alvo.map((produtoId) => ({ produtoId, quantidadeAjustada: 1 })) },
        },
      });
    }
    const lista = (eticoNett: string[] | undefined, pageSize = 25, page = 1) => loadOrderListData(prisma, { page, pageSize, ...(eticoNett ? { eticoNett } : {}) } as Parameters<typeof loadOrderListData>[1]);
    const nomes = (d: Awaited<ReturnType<typeof lista>>) => d.orders.map((o) => o.nome).sort();
    const o0 = await lista(undefined);
    check(o0.total === 40 && o0.totalPages === 2, "O1: sem filtro 40 encomendas em 2 páginas");
    const oE = await lista(["ETICO"]);
    check(oE.total === 3 && mesmo(nomes(oE), ["EN Enc 00", "EN Enc 01", "EN Enc 02"]), "O2: ÉTICO na página 1 mostra as 3 encomendas (antes só havia na página 1 por acaso — total reflecte o filtro)", `total=${oE.total}`);
    check(oE.orders.every((o) => o.linhasCount === 2), "O3: a encomenda aparece INTEIRA (2 linhas)");
    const oD = await lista(["DIVERGENTE"]);
    check(oD.total === 0, "O4: DIVERGENTE = nenhuma encomenda (cada uma é de uma só farmácia)");
    const oN = await lista(["NETT"]);
    check(oN.total === 1 && mesmo(nomes(oN), ["EN Enc 03"]), "O5: NETT = Enc 03 (farmácia Dois, onde o k5 é NETT)");
    const oSem = await lista(["SEM"]);
    check(oSem.total === 39, `O6: SEM = 39 (todas menos a Enc 03, cuja única linha é NETT na farmácia Dois) — veio ${oSem.total}`);
    const oVazio = await lista([]);
    check(oVazio.total === 40, "O7: [] = baseline");

    // ═══ X · exportações ═══
    secao("X · PDF/Excel/email: a linha de filtros aplicados");
    const rep = buildExcessosReport({
      rows: eE.map((r) => ({ ...r })) as never,
      filters: { ...OPC, eticoNettSelecionados: ["ETICO", "DIVERGENTE"] } as never,
      universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [], prioridades: [] },
      organization: "EN",
    });
    const linha = (rep.filtersApplied ?? []).find((f) => f.label === "Ético/NETT");
    check(linha?.value === "Ético, Divergente", "X1: o Report de Excessos (base de PDF, impressão, Excel e email) leva «Ético/NETT: Ético, Divergente»", JSON.stringify(rep.filtersApplied ?? []));
    check(rep.rows.length === eE.length, "X2: o Report leva exactamente as linhas filtradas");
    const repSem = buildExcessosReport({ rows: e0 as never, filters: { ...OPC } as never, universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [], prioridades: [] }, organization: "EN" });
    check(!(repSem.filtersApplied ?? []).some((f) => f.label === "Ético/NETT"), "X3: sem filtro não há linha Ético/NETT");

    // ═══ O · opções e pré-filtro partilhado ═══
    secao("O · opções do filtro e pré-filtro partilhado");
    const opt = (await getReportingFilterOptions()).eticoNett;
    check(opt.length === 4 && opt.find((o) => o.valor === "DIVERGENTE")?.count === 2, "O8: getReportingFilterOptions devolve as 4 opções com contagem");
    const idsE = await resolverPrefiltroProdutos(prisma, { eticoNett: ["ETICO"], formasFarmaceuticas: [] });
    check(idsE?.length === 3, "O9: o pré-filtro partilhado (Vendas/Manutenção) aceita o eixo novo");
    check(await resolverPrefiltroProdutos(prisma, { eticoNett: [] }) === null, "O10: [] = sem restrição (null)");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${ok} OK, ${ko} FALHA(S)`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
