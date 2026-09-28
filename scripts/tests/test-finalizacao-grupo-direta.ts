/**
 * scripts/tests/test-finalizacao-grupo-direta.ts
 *
 * Ponto 2/7 — a finalização de uma proposta de grupo deixou de passar por
 * um RASCUNHO que obrigasse a reabrir a encomenda noutro ecrã, e uma
 * `Transferencia` gerada deixou de ficar presa em RASCUNHO para sempre
 * (bug encontrado durante a análise — nada no código a levava a
 * FINALIZADA).
 *
 * `gerarPlanoGrupoAction` (app/encomendas/nova/actions.ts) não é
 * directamente testável isolado — depende de `requirePermission`/
 * `getPrisma()` (contexto de pedido do Next.js). Este ficheiro tem DUAS
 * partes:
 *
 *   A. Estática — confirma, no código-fonte, que a função chama
 *      `createEncomendaWithOutbox` com `finalize: true` e cria a
 *      `Transferencia` com `estado: "FINALIZADA"` (mesmo padrão de
 *      `test-vendas-stock-sempre-ativo.ts`/`test-task-bar.ts`).
 *   B. Integração REAL em Postgres descartável — reproduz exactamente o
 *      mesmo padrão de escrita que a acção agora usa (`createEncomenda-
 *      WithOutbox(..., finalize:true)` + `transferencia.create({estado:
 *      "FINALIZADA"})`) usando as MESMAS funções puras de agrupamento
 *      (`agruparParaGeracao`) e confirma o estado final na base.
 *
 *   docker run -d --name spharm-ws-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   npm run test:finalizacao-grupo-direta
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import type { DecisaoLinha } from "../../lib/encomendas/decisao-grupo";

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

console.log("\nA · gerarPlanoGrupoAction finaliza directamente (estático)");
{
  const src = readFileSync(new URL("../../app/encomendas/nova/actions.ts", import.meta.url), "utf8");
  const fnStart = src.indexOf("export async function gerarPlanoGrupoAction");
  const fnEnd = src.indexOf("\nexport ", fnStart + 10);
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
  check(fnStart > 0, "A1: encontra gerarPlanoGrupoAction");
  const encomendaBlock = fnBody.slice(fnBody.indexOf("createEncomendaWithOutbox"), fnBody.indexOf("resultadoListas.push"));
  check(/finalize:\s*true/.test(encomendaBlock), "A2: a criação de cada ListaEncomenda do grupo usa finalize:true (nunca RASCUNHO à espera de um 2º passo)");
  check(!/finalize:\s*false/.test(encomendaBlock), "A3: já não passa finalize:false nesta chamada");
  const transferBlock = fnBody.slice(fnBody.indexOf("tx.transferencia.create"), fnBody.indexOf("resultadoTransferencias.push"));
  check(/estado:\s*"FINALIZADA"/.test(transferBlock), "A4: a Transferencia do grupo nasce FINALIZADA (antes ficava presa em RASCUNHO para sempre)");
}

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55432/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

async function main() {
  const db = `spharm_grupo_direto_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const { createEncomendaWithOutbox } = await import("../../lib/ingest/orders");
    const { agruparParaGeracao } = await import("../../lib/encomendas/decisao-grupo");

    console.log("\nB · integração real — mesmo padrão de escrita, Postgres descartável");
    const [f1, f2] = await Promise.all([
      prisma.farmacia.create({ data: { nome: "F1" } }),
      prisma.farmacia.create({ data: { nome: "F2" } }),
    ]);
    const u = await prisma.utilizador.create({ data: { email: "u@t.pt", nome: "U", perfil: "GESTOR_GRUPO" } });
    const [p1, p2] = await Promise.all([
      prisma.produto.create({ data: { cnp: 9001, designacao: "P1" } }),
      prisma.produto.create({ data: { cnp: 9002, designacao: "P2" } }),
    ]);

    const decisoes: (DecisaoLinha & { produtoId: string })[] = [
      { produtoId: p1.id, acao: "ENCOMENDAR", acaoTocada: true, farmaciaEncomendaId: f1.id, quantidadeFinal: 10, farmaciaOrigemId: null, farmaciaDestinoId: null, quantidadeTransferir: 0 },
      { produtoId: p2.id, acao: "TRANSFERIR", acaoTocada: true, farmaciaEncomendaId: null, quantidadeFinal: 0, farmaciaOrigemId: f1.id, farmaciaDestinoId: f2.id, quantidadeTransferir: 5 },
    ];
    const { porFarmacia, porDirecao } = agruparParaGeracao(decisoes);

    const listaIds: string[] = [];
    for (const [farmaciaId, linhas] of porFarmacia) {
      const r = await createEncomendaWithOutbox(prisma, "t", {
        farmaciaId,
        criadoPorId: u.id,
        nome: "Grupo teste · encomendar",
        finalize: true, // ← o mesmo que gerarPlanoGrupoAction agora usa
        linhas: linhas.map((l) => ({ produtoId: l.produtoId, quantidadeAjustada: l.quantidadeFinal, origem: "PROPOSTA" })),
      }, "grupo");
      listaIds.push(r.listaEncomendaId);
    }

    const transferenciaIds: string[] = [];
    for (const [, linhas] of porDirecao) {
      const t = await prisma.transferencia.create({
        data: {
          farmaciaOrigemId: linhas[0].farmaciaOrigemId!,
          farmaciaDestinoId: linhas[0].farmaciaDestinoId!,
          criadoPorId: u.id,
          estado: "FINALIZADA", // ← o mesmo que gerarPlanoGrupoAction agora usa
          linhas: { create: linhas.map((l) => ({ produtoId: l.produtoId, quantidade: l.quantidadeTransferir })) },
        },
      });
      transferenciaIds.push(t.id);
    }

    const listas = await prisma.listaEncomenda.findMany({ where: { id: { in: listaIds } }, include: { outbox: true } });
    check(listas.length === 1, "B1: 1 ListaEncomenda criada (1 farmácia com ENCOMENDAR)");
    check(listas.every((l) => l.estado === "FINALIZADA"), "B2: nasce já FINALIZADA — nunca ficou RASCUNHO à espera de um 2º passo");
    check(listas.every((l) => l.outbox?.state === "PENDENTE"), "B3: outbox criado na mesma transacção, PENDENTE (pronto para a fila — nenhum envio externo acontece aqui)");

    const transferencias = await prisma.transferencia.findMany({ where: { id: { in: transferenciaIds } } });
    check(transferencias.length === 1, "B4: 1 Transferencia criada (1 direcção com TRANSFERIR)");
    check(transferencias.every((t) => t.estado === "FINALIZADA"), "B5: nasce FINALIZADA — corrige o bug de ficar presa em RASCUNHO para sempre");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
