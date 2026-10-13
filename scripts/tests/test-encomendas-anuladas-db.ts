/**
 * scripts/tests/test-encomendas-anuladas-db.ts
 *
 * Filtro «Mostrar encomendas anuladas» da listagem de encomendas, contra um
 * PostgreSQL REAL e DESCARTÁVEL (a exclusão, as contagens, a paginação e os
 * restantes filtros são todos da consulta do servidor):
 *
 *   docker run -d --name spharm-mg-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-encomendas-anuladas-db.ts
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
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
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
  const dbName = `spharm_anul_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbName) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbName) }) });
    const { loadOrderListData, condicaoEstadoLista } = await import("../../lib/encomendas/orders-data");

    const u = await prisma.utilizador.create({ data: { email: "a@spharm.test", nome: "Admin", perfil: "ADMINISTRADOR" } });
    const f1 = await prisma.farmacia.create({ data: { nome: "Farmácia Um" } });
    const f2 = await prisma.farmacia.create({ data: { nome: "Farmácia Dois" } });
    const base = Date.parse("2026-09-01T10:00:00Z");
    let n = 0;
    const mk = async (nome: string, estado: "RASCUNHO" | "FINALIZADA" | "EXPORTADA" | "ANULADA" | "ELIMINADA", farmaciaId: string, dia: number) =>
      prisma.listaEncomenda.create({
        data: { nome, estado, farmaciaId, criadoPorId: u.id, dataCriacao: new Date(base + dia * 86_400_000 + n++) },
      });
    await mk("Alfa fin 1", "FINALIZADA", f1.id, 1);
    await mk("Alfa fin 2", "FINALIZADA", f2.id, 2);
    await mk("Beta exp", "EXPORTADA", f1.id, 3);
    await mk("Gama rasc", "RASCUNHO", f1.id, 4);
    await mk("Alfa anulada 1", "ANULADA", f1.id, 5);
    await mk("Beta anulada 2", "ANULADA", f2.id, 6);
    await mk("Delta anulada 3", "ANULADA", f1.id, 7);
    await mk("Eliminada", "ELIMINADA", f1.id, 8);
    const antes = await prisma.listaEncomenda.groupBy({ by: ["estado"], _count: true });

    const lista = (f: Partial<Parameters<typeof loadOrderListData>[1]> = {}) =>
      loadOrderListData(prisma, { page: 1, pageSize: 25, ...f });
    const nomes = (d: Awaited<ReturnType<typeof lista>>) => d.orders.map((o) => o.nome).sort();

    secao("A · regra pura");
    check(JSON.stringify(condicaoEstadoLista({})) === JSON.stringify({ notIn: ["ELIMINADA", "ANULADA"] }), "omissão: exclui ELIMINADA e ANULADA");
    check(JSON.stringify(condicaoEstadoLista({ mostrarAnuladas: true })) === JSON.stringify({ notIn: ["ELIMINADA"] }), "mostrarAnuladas: só exclui ELIMINADA");
    check(condicaoEstadoLista({ estado: "FINALIZADA", mostrarAnuladas: true }) === "FINALIZADA", "estado explícito prevalece (sem regras contraditórias)");
    check(condicaoEstadoLista({ estado: "ANULADA" }) === "ANULADA", "estado ANULADA explícito mostra anuladas");

    secao("B · desligado (omissão): as anuladas não aparecem");
    const d0 = await lista();
    check(!nomes(d0).some((x) => /anulada/i.test(x)) && !nomes(d0).includes("Eliminada"), "nenhuma anulada nem eliminada na lista");
    check(d0.total === 4 && d0.orders.length === 4, `total e linhas calculados DEPOIS da exclusão (${d0.total}/${d0.orders.length})`);
    const d0p = await lista({ pageSize: 3 });
    check(d0p.total === 4 && d0p.totalPages === 2 && d0p.orders.length === 3, "paginação calculada depois da exclusão (4 → 2 páginas de 3)");
    const d0p2 = await lista({ pageSize: 3, page: 2 });
    check(d0p2.orders.length === 1 && !nomes(d0p2).some((x) => /anulada/i.test(x)), "2.ª página sem anuladas");

    secao("C · ligado: as anuladas juntam-se às restantes");
    const d1 = await lista({ mostrarAnuladas: true });
    check(d1.total === 7 && d1.orders.length === 7, `7 encomendas (sem a eliminada) — ${d1.total}`);
    check(d1.orders.filter((o) => o.estado === "ANULADA").length === 3, "as 3 anuladas trazem o estado ANULADA (para a UI as identificar)");
    check(!nomes(d1).includes("Eliminada"), "ELIMINADA continua fora");
    const d1p = await lista({ mostrarAnuladas: true, pageSize: 3 });
    check(d1p.total === 7 && d1p.totalPages === 3, "paginação com anuladas: 7 → 3 páginas de 3");
    const ordem = d1.orders.map((o) => o.dataCriacao.getTime());
    check(ordem.every((v, i) => i === 0 || ordem[i - 1] >= v), "ordenação (mais recentes primeiro) mantida com anuladas");

    secao("D · combinação com os restantes filtros");
    const pesq = await lista({ mostrarAnuladas: true, search: "alfa" });
    check(nomes(pesq).join() === ["Alfa anulada 1", "Alfa fin 1", "Alfa fin 2"].join() && pesq.total === 3, "pesquisa + anuladas");
    const pesq0 = await lista({ search: "alfa" });
    check(nomes(pesq0).join() === ["Alfa fin 1", "Alfa fin 2"].join() && pesq0.total === 2, "pesquisa sem anuladas");
    const farm = await lista({ mostrarAnuladas: true, farmaciaId: f2.id });
    check(nomes(farm).join() === ["Alfa fin 2", "Beta anulada 2"].join(), "farmácia + anuladas");
    const farm0 = await lista({ farmaciaId: f2.id });
    check(nomes(farm0).join() === ["Alfa fin 2"].join(), "farmácia sem anuladas");
    const per = await lista({ mostrarAnuladas: true, dateFrom: new Date(base + 5 * 86_400_000 - 3600_000), dateTo: new Date(base + 7 * 86_400_000 + 3600_000) });
    check(per.total === 3 && per.orders.every((o) => o.estado === "ANULADA"), "período + anuladas");
    const per0 = await lista({ dateFrom: new Date(base + 5 * 86_400_000 - 3600_000), dateTo: new Date(base + 7 * 86_400_000 + 3600_000) });
    check(per0.total === 0, "o mesmo período sem anuladas: vazio");
    const est = await lista({ estado: "FINALIZADA", mostrarAnuladas: true });
    check(est.total === 2 && est.orders.every((o) => o.estado === "FINALIZADA"), "estado FINALIZADA + anuladas: só FINALIZADA (sem contradição)");
    const soAnul = await lista({ estado: "ANULADA" });
    check(soAnul.total === 3 && soAnul.orders.every((o) => o.estado === "ANULADA"), "estado ANULADA: só as 3 anuladas");
    const soAnulPag = await lista({ estado: "ANULADA", pageSize: 2 });
    check(soAnulPag.totalPages === 2, "…com paginação coerente");
    const exp = await lista({ mostrarAnuladas: true, estadoExport: "PENDENTE", farmaciaId: f1.id, search: "a" });
    check(exp.total === exp.orders.length && exp.orders.every((o) => o.farmaciaId === f1.id), "filtro de exportação + farmácia + pesquisa + anuladas coerentes");

    secao("E · nada é alterado");
    const depois = await prisma.listaEncomenda.groupBy({ by: ["estado"], _count: true });
    const chave = (g: typeof antes) => JSON.stringify(g.map((x) => [x.estado, x._count]).sort());
    check(chave(antes) === chave(depois), "as encomendas (e os estados) ficam exatamente como estavam");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
