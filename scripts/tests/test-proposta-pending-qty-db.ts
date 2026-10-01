/**
 * scripts/tests/test-proposta-pending-qty-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55494/postgres npx tsx scripts/tests/test-proposta-pending-qty-db.ts
 *
 * Audita a origem de `pendingQty` (CTE `pending` em lib/encomendas/proposal.ts,
 * partilhada pelos modos farmácia, grupo e consolidação — a consolidação usa
 * `generateGroupProposal`, que chama `generateOrderProposal` por farmácia).
 *
 * REGRA ANTIGA: contava TODA a ListaEncomenda da farmácia com
 * `estadoExport IN ('PENDENTE','EM_EXPORTACAO')`. Como `estadoExport` nasce
 * PENDENTE por omissão em QUALQUER estado, contavam também RASCUNHOS (de
 * outras análises/consolidações), o rascunho-PAI já dividido por fornecedor
 * (duplicando os seus documentos filhos) e encomendas ANULADA/ELIMINADA —
 * um rascunho de outra consolidação transformava a segunda proposta em
 * AGUARDAR/quantidade zero.
 *
 * REGRA NOVA: só `estado = 'FINALIZADA'` e `estadoExport IN (PENDENTE,
 * EM_EXPORTACAO)` — compromisso real por exportar.
 *
 * O teste imprime, por estado, a contribuição ANTES (query antiga, corrida
 * aqui) e DEPOIS (query real), e prova que os três modos devolvem o mesmo.
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55493/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
function urlDe(db: string) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

async function main() {
  const db = `spharm_pend_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const { generateOrderProposal, generateGroupProposal } = await import("../../lib/encomendas/proposal");

    const user = await prisma.utilizador.create({ data: { email: "u@t.pt", nome: "U", perfil: "ADMINISTRADOR" } });
    const fA = await prisma.farmacia.create({ data: { nome: "Farmácia A" } });
    const fB = await prisma.farmacia.create({ data: { nome: "Farmácia B" } });
    const p1 = await prisma.produto.create({ data: { cnp: 9200001, designacao: "Produto Com Compromissos", estado: "VALIDADO" } });
    const p2 = await prisma.produto.create({ data: { cnp: 9200002, designacao: "Produto So Rascunhos", estado: "VALIDADO" } });
    const hoje = new Date();
    for (const f of [fA, fB]) {
      for (const p of [p1, p2]) {
        await prisma.produtoFarmacia.create({
          data: { produtoId: p.id, farmaciaId: f.id, stockAtual: 0, stockMinimo: 0, stockMaximo: 10, pvp: 10, pmc: 9, puc: 5, taxaIvaPercent: 23 },
        });
        for (let m = 1; m <= 3; m++) {
          const d = new Date(hoje.getFullYear(), hoje.getMonth() - m, 1);
          await prisma.vendaMensal.create({
            data: { farmaciaId: f.id, produtoId: p.id, ano: d.getFullYear(), mes: d.getMonth() + 1, quantidade: 3000, valorTotal: 30000, naturezaVenda: "NORMAL" },
          });
        }
      }
    }

    // ── listas em A, uma por estado, quantidade DISTINTA para identificar a contribuição ──
    type Estado = "RASCUNHO" | "FINALIZADA" | "EXPORTADA" | "ELIMINADA" | "ANULADA";
    type Exp = "PENDENTE" | "EM_EXPORTACAO" | "EXPORTADO" | "FALHADO" | "CANCELADO";
    async function lista(farmaciaId: string, nome: string, estado: Estado, estadoExport: Exp, qty: number, produtoId: string, extra: { loteDivididoEm?: Date; loteOrigemId?: string } = {}) {
      const l = await prisma.listaEncomenda.create({
        data: { farmaciaId, nome, estado, estadoExport, criadoPorId: user.id, ...extra, linhas: { create: [{ produtoId, quantidadeAjustada: qty, origem: "MANUAL" }] } },
      });
      return l;
    }
    const contrib: Array<{ rotulo: string; qty: number; conta: boolean; contavaAntes: boolean }> = [];
    async function criar(rotulo: string, estado: Estado, exp: Exp, qty: number, conta: boolean, extra: { loteDivididoEm?: Date; loteOrigemId?: string } = {}) {
      const l = await lista(fA.id, rotulo, estado, exp, qty, p1.id, extra);
      contrib.push({ rotulo, qty, conta, contavaAntes: exp === "PENDENTE" || exp === "EM_EXPORTACAO" });
      return l;
    }
    await criar("RASCUNHO de outra análise (PENDENTE)", "RASCUNHO", "PENDENTE", 100, false);
    const pai = await criar("RASCUNHO-pai já dividido (PENDENTE)", "RASCUNHO", "PENDENTE", 40, false, { loteDivididoEm: new Date() });
    await criar("FINALIZADA filha do pai (PENDENTE)", "FINALIZADA", "PENDENTE", 40, true, { loteOrigemId: pai.id });
    await criar("ELIMINADA (PENDENTE)", "ELIMINADA", "PENDENTE", 300, false);
    await criar("ANULADA (PENDENTE)", "ANULADA", "PENDENTE", 400, false);
    await criar("FINALIZADA (EM_EXPORTACAO)", "FINALIZADA", "EM_EXPORTACAO", 7, true);
    await criar("FINALIZADA (PENDENTE)", "FINALIZADA", "PENDENTE", 5, true);
    await criar("EXPORTADA (EXPORTADO)", "EXPORTADA", "EXPORTADO", 1000, false);
    await criar("FINALIZADA (FALHADO)", "FINALIZADA", "FALHADO", 2000, false);
    // p2 só tem rascunhos (de outras consolidações) em A — nunca compromisso real.
    await lista(fA.id, "RASCUNHO consolidação 1", "RASCUNHO", "PENDENTE", 100000, p2.id);
    await lista(fA.id, "RASCUNHO consolidação 2", "RASCUNHO", "PENDENTE", 100000, p2.id);
    // B: um rascunho (não conta) e uma finalizada (conta) — isolamento por farmácia.
    await lista(fB.id, "RASCUNHO B", "RASCUNHO", "PENDENTE", 77, p1.id);
    await lista(fB.id, "FINALIZADA B", "FINALIZADA", "PENDENTE", 9, p1.id);

    // ── ANTES: a query antiga, corrida tal e qual ──
    const antes = await prisma.$queryRawUnsafe<Array<{ produtoId: string; farmaciaId: string; qty: number }>>(`
      SELECT le."produtoId", l."farmaciaId", SUM(COALESCE(le."quantidadeAjustada", le."quantidadeSugerida", 0))::float AS qty
      FROM "LinhaEncomenda" le JOIN "ListaEncomenda" l ON l.id = le."listaEncomendaId"
      WHERE l."estadoExport" IN ('PENDENTE', 'EM_EXPORTACAO')
      GROUP BY le."produtoId", l."farmaciaId"`);
    const antesDe = (f: string, p: string) => antes.find((a) => a.farmaciaId === f && a.produtoId === p)?.qty ?? 0;

    console.log("\nContribuição por estado ao pendingQty de A (produto com compromissos)");
    console.log("  estado                                     qty   ANTES  DEPOIS");
    for (const c of contrib) console.log(`  ${c.rotulo.padEnd(42)} ${String(c.qty).padStart(5)}   ${c.contavaAntes ? "conta" : "  —  "}   ${c.conta ? "conta" : "  —  "}`);

    const esperadoDepoisA = contrib.filter((c) => c.conta).reduce((s, c) => s + c.qty, 0); // 40 + 7 + 5
    const input = {
      startDate: new Date(hoje.getFullYear(), hoje.getMonth() - 6, 1),
      endDate: hoje,
      considerStock: true,
      baseRule: "total" as const,
      targetCoverageDays: 30,
    };

    // ── MODO NORMAL (farmácia) ──
    console.log("\nModo normal (farmácia)");
    const pa = await generateOrderProposal({ ...input, farmaciaId: fA.id, farmaciaNome: "A" }, prisma);
    const rowA1 = pa.rows.find((r) => r.produtoId === p1.id)!;
    const rowA2 = pa.rows.find((r) => r.produtoId === p2.id)!;
    check(antesDe(fA.id, p1.id) === 892, "ANTES (query antiga): pendingQty de A/P1 = 892 (inclui rascunhos, pai, ELIMINADA, ANULADA)", `obtido=${antesDe(fA.id, p1.id)}`);
    check(rowA1.pendingQty === esperadoDepoisA && esperadoDepoisA === 52, "DEPOIS: pendingQty de A/P1 = 52 (filha 40 + EM_EXPORTACAO 7 + PENDENTE 5)", `obtido=${rowA1.pendingQty}`);
    check(antesDe(fA.id, p2.id) === 200000 && rowA2.pendingQty === 0, "P2 (só rascunhos de outras consolidações): ANTES 200000 → DEPOIS 0");

    const pb = await generateOrderProposal({ ...input, farmaciaId: fB.id, farmaciaNome: "B" }, prisma);
    const rowB1 = pb.rows.find((r) => r.produtoId === p1.id)!;
    const rowB2 = pb.rows.find((r) => r.produtoId === p2.id)!;
    check(antesDe(fB.id, p1.id) === 86 && rowB1.pendingQty === 9, "B/P1: ANTES 86 (rascunho 77 + finalizada 9) → DEPOIS 9 — isolada por farmácia");
    check(rowA2.estado === "COMPRAR" && rowA2.suggestedQty > 0, "A/P2: a proposta é COMPRAR com quantidade > 0", `estado=${rowA2.estado} sug=${rowA2.suggestedQty}`);
    check(rowA2.suggestedQty === rowB2.suggestedQty && rowB2.pendingQty === 0, "A/P2 sugere exactamente o mesmo que B/P2 (B não tem listas) — rascunhos não alteram a proposta");
    const antesEstadoA2 = antesDe(fA.id, p2.id) > 0;
    check(antesEstadoA2, "…e a regra antiga contava mesmo esses rascunhos (confirma a causa)");

    // ── MODO GRUPO e CONSOLIDAÇÃO (mesma função, ver cabeçalho) ──
    console.log("\nModo grupo / consolidação (generateGroupProposal)");
    const g = await generateGroupProposal({ ...input, farmaciaIds: [fA.id, fB.id], farmaciaNames: { [fA.id]: "A", [fB.id]: "B" } }, prisma);
    const gA1 = g.rows.find((r) => r.farmaciaId === fA.id && r.produtoId === p1.id)!;
    const gB1 = g.rows.find((r) => r.farmaciaId === fB.id && r.produtoId === p1.id)!;
    const gA2 = g.rows.find((r) => r.farmaciaId === fA.id && r.produtoId === p2.id)!;
    check(gA1.pendingQty === 52 && gB1.pendingQty === 9, "grupo: pendingQty de A/P1 = 52 e de B/P1 = 9 (igual ao modo normal)");
    check(gA2.estado === "COMPRAR" && gA2.suggestedQty === rowA2.suggestedQty, "grupo: A/P2 continua COMPRAR com a mesma quantidade do modo normal");

    // ── Compromisso real continua a contar (regra preservada) ──
    console.log("\nCompromisso real preservado");
    const finalizadaA = await prisma.listaEncomenda.findFirstOrThrow({ where: { farmaciaId: fA.id, nome: "FINALIZADA (PENDENTE)" } });
    await prisma.listaEncomenda.update({ where: { id: finalizadaA.id }, data: { estadoExport: "EXPORTADO", estado: "EXPORTADA" } });
    const pa2 = await generateOrderProposal({ ...input, farmaciaId: fA.id, farmaciaNome: "A" }, prisma);
    check(pa2.rows.find((r) => r.produtoId === p1.id)!.pendingQty === 47, "uma finalizada que passa a EXPORTADA deixa de contar (52 → 47), como antes");
    await prisma.listaEncomenda.update({ where: { id: finalizadaA.id }, data: { estadoExport: "PENDENTE", estado: "ANULADA" } });
    const pa3 = await generateOrderProposal({ ...input, farmaciaId: fA.id, farmaciaNome: "A" }, prisma);
    check(pa3.rows.find((r) => r.produtoId === p1.id)!.pendingQty === 47, "uma finalizada ANULADA deixa de contar (compromisso desfeito)");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
