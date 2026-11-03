/**
 * scripts/tests/test-etico-nett-ambito-db.ts
 *
 * ÂMBITO da classificação: a origem é a farmácia; o consolidado só considera as farmácias EM ÂMBITO.
 * Tenant sintético com TRÊS farmácias (A, B, C), base PostgreSQL descartável:
 *
 *            A       B       C        tenant      A+B          só A    só B    só C
 *   p1     ETICO   ETICO   NETT     DIVERGENTE  ETICO        ETICO   ETICO   NETT
 *   p2     NETT    ETICO   ETICO    DIVERGENTE  DIVERGENTE   NETT    ETICO   ETICO
 *   p3     —       ETICO   —        ETICO       ETICO        SEM     ETICO   SEM
 *
 *   · análise de uma só farmácia (proposta, lista de encomendas, Vendas, Stock);
 *   · grupo de duas farmácias seleccionadas; terceira divergente FORA da selecção não conta;
 *   · duas seleccionadas com classificações divergentes -> DIVERGENTE;
 *   · DIVERGENTE nunca existe num âmbito de uma só farmácia;
 *   · mapa de Encomendas: linhas por farmácia + consolidação no cliente sobre o âmbito.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-etico-nett-ambito-db.ts
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
  const db = `spharm_en_ambito_${Date.now().toString(36)}`;
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
    const { getStockData } = await import("../../lib/stock-data");
    const { generateOrderProposal } = await import("../../lib/encomendas/proposal");
    const { loadOrderListData } = await import("../../lib/encomendas/orders-data");
    const { getEncomendasData } = await import("../../lib/encomendas-data");
    const { getExcessosData } = await import("../../lib/transferencias-data");
    const { restringirPorCatalogo } = await import("../../lib/reporting/catalog-prefilter");
    const { consolidarEticoNett } = await import("../../lib/classificacao/etico-nett");

    const fA = await prisma.farmacia.create({ data: { nome: "Âmbito A" } });
    const fB = await prisma.farmacia.create({ data: { nome: "Âmbito B" } });
    const fC = await prisma.farmacia.create({ data: { nome: "Âmbito C" } });
    const user = await prisma.utilizador.create({ data: { email: "amb@t.pt", nome: "AMB", perfil: "ADMINISTRADOR" } });
    type Cls = "ETICO" | "NETT" | null;
    const defs: Array<{ cnp: number; a: Cls; b: Cls; c: Cls }> = [
      { cnp: 8_800_001, a: "ETICO", b: "ETICO", c: "NETT" },
      { cnp: 8_800_002, a: "NETT", b: "ETICO", c: "ETICO" },
      { cnp: 8_800_003, a: null, b: "ETICO", c: null },
    ];
    const P: Record<string, string> = {};
    for (const d of defs) {
      const p = await prisma.produto.create({ data: { cnp: d.cnp, designacao: `AMB ${d.cnp}`, estado: "VALIDADO" } });
      P[String(d.cnp)] = p.id;
      for (const [f, cls] of [[fA, d.a], [fB, d.b], [fC, d.c]] as const) {
        await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: f.id, pvp: 5, pmc: 4, puc: 2, stockAtual: 10, stockMinimo: 0, stockMaximo: 999, eticoNett: cls } });
        await prisma.vendaMensal.create({ data: { farmaciaId: f.id, produtoId: p.id, ano: 2026, mes: 2, quantidade: 9, valorTotal: 45, valorBruto: 45, naturezaVenda: "NORMAL" } });
      }
    }
    const c = (...ns: number[]) => ordenado(ns);
    const [p1, p2, p3] = [8_800_001, 8_800_002, 8_800_003];
    const cnpDeIds = async (ids: string[] | null) => ordenado((await prisma.produto.findMany({ where: { id: { in: ids ?? [] } }, select: { cnp: true } })).map((p) => p.cnp));

    secao("1 · pré-filtro por âmbito de farmácias");
    const pf = (eticoNett: string[], farmaciaNomes?: string[]) => restringirPorCatalogo(prisma, { eticoNett, farmaciaNomes }, null).then(cnpDeIds);
    check(mesmo(await pf(["DIVERGENTE"]), c(p1, p2)), "tenant inteiro (A+B+C): p1 e p2 são DIVERGENTE");
    check(mesmo(await pf(["DIVERGENTE"], ["Âmbito A", "Âmbito B"]), c(p2)), "grupo A+B: só p2 é divergente (Nett em A, Ético em B); p1 NÃO — a divergência de C está fora da selecção");
    check(mesmo(await pf(["ETICO"], ["Âmbito A", "Âmbito B"]), c(p1, p3)), "grupo A+B: ÉTICO = p1 (A e B concordam) e p3 (só B tem informação)");
    check(mesmo(await pf(["NETT"], ["Âmbito A", "Âmbito B"]), c()), "grupo A+B: NETT = nenhum (o NETT de p1 está em C, fora do âmbito)");
    check(mesmo(await pf(["ETICO"], ["Âmbito A"]), c(p1)), "só A: ÉTICO = p1");
    check(mesmo(await pf(["NETT"], ["Âmbito A"]), c(p2)), "só A: NETT = p2");
    check(mesmo(await pf(["SEM"], ["Âmbito A"]), c(p3)), "só A: SEM = p3 (A não classifica p3, mesmo que B classifique)");
    check(mesmo(await pf(["DIVERGENTE"], ["Âmbito A"]), c()), "só A: DIVERGENTE nunca existe");
    check(mesmo(await pf(["NETT"], ["Âmbito C"]), c(p1)) && mesmo(await pf(["SEM"], ["Âmbito C"]), c(p3)), "só C: p1 NETT; p3 SEM");
    check(mesmo(await pf(["DIVERGENTE"], ["Âmbito B", "Âmbito C"]), c(p1)), "grupo B+C: só p1 diverge (Ético em B, Nett em C); p2 não (ambas Ético)");

    secao("2 · análise de UMA farmácia: Vendas e Stock");
    const vCnps = (r: { rows: Array<{ codigo: string }> }) => ordenado([...new Set(r.rows.map((x) => x.codigo))]);
    const periodo = { from: "2026-01-01", to: "2026-12-31" };
    check(mesmo(vCnps(await getVendasData({ ...periodo, eticoNett: ["ETICO"], farmaciaNomes: ["Âmbito A"] }, prisma)), c(p1)), "Vendas só A: ÉTICO = p1");
    check(mesmo(vCnps(await getVendasData({ ...periodo, eticoNett: ["DIVERGENTE"], farmaciaNomes: ["Âmbito A", "Âmbito B"] }, prisma)), c(p2)), "Vendas A+B: DIVERGENTE = p2");
    const sc = (r: { rows: Array<{ cnp: string | number }> }) => ordenado([...new Set(r.rows.map((x) => x.cnp))]);
    check(mesmo(sc(await getStockData({ page: 1, pageSize: 100, eticoNett: ["ETICO"], pharmacies: ["Âmbito A"] })), c(p1)), "Stock só A: ÉTICO = p1");
    check(mesmo(sc(await getStockData({ page: 1, pageSize: 100, eticoNett: ["DIVERGENTE"], pharmacies: ["Âmbito A", "Âmbito B"] })), c(p2)), "Stock A+B: DIVERGENTE = p2");

    secao("3 · proposta de Encomenda (uma farmácia)");
    const inicio = new Date(2026, 0, 1);
    const fim = new Date(2026, 11, 31, 23, 59, 59);
    const prop = (f: { id: string; nome: string }, eticoNett: string[]) =>
      generateOrderProposal({ farmaciaId: f.id, farmaciaNome: f.nome, startDate: inicio, endDate: fim, considerStock: true, baseRule: "coverage", targetCoverageDays: 15, filters: { eticoNett } }, prisma, { resolverTenant: async () => null });
    const pc = (r: { rows: Array<{ cnp: number }> }) => ordenado([...new Set(r.rows.map((x) => x.cnp))]);
    check(mesmo(pc(await prop(fA, ["ETICO"])), c(p1)), "farmácia A: ÉTICO = p1 (a classificação de A, não a do tenant)");
    check(mesmo(pc(await prop(fA, ["NETT"])), c(p2)), "farmácia A: NETT = p2");
    check(mesmo(pc(await prop(fC, ["NETT"])), c(p1)), "farmácia C: NETT = p1");
    check(mesmo(pc(await prop(fB, ["ETICO"])), c(p1, p2, p3)), "farmácia B: ÉTICO = p1, p2, p3");
    check(mesmo(pc(await prop(fA, ["SEM"])), c(p3)), "farmácia A: SEM = p3");
    check(mesmo(pc(await prop(fA, ["DIVERGENTE"])), c()), "farmácia A: DIVERGENTE = nenhum (âmbito de uma só farmácia)");

    secao("4 · lista de Encomendas (cada encomenda usa a farmácia dela)");
    const mk = async (nome: string, f: { id: string }, produtos: string[]) =>
      prisma.listaEncomenda.create({
        data: { nome, estado: "FINALIZADA", farmaciaId: f.id, criadoPorId: user.id, dataCriacao: new Date(), linhas: { create: produtos.map((id) => ({ produtoId: id, quantidadeAjustada: 1 })) } },
      });
    await mk("ENC-A1", fA, [P[p1]]); // A: ETICO
    await mk("ENC-A2", fA, [P[p2]]); // A: NETT
    await mk("ENC-A3", fA, [P[p3]]); // A: SEM
    await mk("ENC-C2", fC, [P[p2]]); // C: ETICO
    await mk("ENC-C1", fC, [P[p1]]); // C: NETT
    const lista = (eticoNett: string[], extra: Record<string, unknown> = {}) => loadOrderListData(prisma, { page: 1, pageSize: 50, eticoNett, ...extra } as Parameters<typeof loadOrderListData>[1]);
    const nomes = (d: Awaited<ReturnType<typeof lista>>) => d.orders.map((o) => o.nome).sort();
    check(mesmo(nomes(await lista(["ETICO"])), ["ENC-A1", "ENC-C2"]), "ÉTICO: ENC-A1 (p1 é Ético em A) e ENC-C2 (p2 é Ético em C); NÃO ENC-C1 (p1 é NETT em C)");
    check(mesmo(nomes(await lista(["NETT"])), ["ENC-A2", "ENC-C1"]), "NETT: ENC-A2 (p2 é NETT em A) e ENC-C1 (p1 é NETT em C)");
    check(mesmo(nomes(await lista(["SEM"])), ["ENC-A3"]), "SEM: só ENC-A3 (p3 não está classificado em A)");
    check(mesmo(nomes(await lista(["DIVERGENTE"])), []), "DIVERGENTE: nenhuma encomenda (cada uma tem uma só farmácia)");
    check(mesmo(nomes(await lista(["ETICO", "NETT"], { farmaciaId: fA.id })), ["ENC-A1", "ENC-A2"]), "combina com o filtro de farmácia da lista");
    check((await lista(["ETICO"])).total === 2, "o total reflecte o filtro (paginação no servidor)");

    secao("5 · mapa de Encomendas: linhas POR FARMÁCIA; o cliente consolida só o âmbito");
    const mapa = await getEncomendasData();
    const linha = (cnp: number, f: { nome: string }) => mapa.find((r) => String(r.cnp) === String(cnp) && r.farmacia === f.nome)?.eticoNett ?? null;
    check(linha(p1, fA) === "ETICO" && linha(p1, fC) === "NETT" && linha(p3, fA) === null && linha(p3, fB) === "ETICO", "cada linha leva a classificação da PRÓPRIA farmácia");
    const consolidado = (cnp: number, farmacias: string[]) =>
      consolidarEticoNett(mapa.filter((r) => String(r.cnp) === String(cnp) && farmacias.includes(r.farmacia)).map((r) => r.eticoNett));
    check(consolidado(p1, ["Âmbito A", "Âmbito B", "Âmbito C"]) === "DIVERGENTE", "âmbito A+B+C: p1 DIVERGENTE");
    check(consolidado(p1, ["Âmbito A", "Âmbito B"]) === "ETICO", "âmbito A+B: p1 ÉTICO (C está fora)");
    check(consolidado(p2, ["Âmbito A", "Âmbito B"]) === "DIVERGENTE", "âmbito A+B: p2 DIVERGENTE");
    check(consolidado(p3, ["Âmbito A"]) === "SEM", "âmbito A: p3 SEM");

    secao("6 · Excessos/Transferências: âmbito = as farmácias do grupo que o loader recebe");
    const exc = await getExcessosData({ thresholdDays: 1, eticoNett: ["DIVERGENTE"] });
    check(Array.isArray(exc), "carrega com o filtro (o âmbito são as farmácias activas do grupo)");

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
