/**
 * scripts/tests/test-consolidacao-multi-fornecedor-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL. Valida o motor central
 * (`lib/encomendas/consolidacao-multi-fornecedor.ts`) isoladamente, ANTES
 * da integração com o serviço/UI de consolidação — 2 farmácias, cada uma
 * com um rascunho real já persistido (criado directamente via
 * `createEncomendaWithOutbox`, como a integração fará), cada um com
 * linhas de mais de um fornecedor.
 *
 *   docker run -d --name spharm-cmf-test-pg -e POSTGRES_PASSWORD=test -p 55491:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55491/postgres npx tsx scripts/tests/test-consolidacao-multi-fornecedor-db.ts
 */
import Module from "node:module";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { execSync } from "node:child_process";

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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55491/postgres";
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
  const sufixo = Date.now().toString(36);
  const dbName = `spharm_cmf_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbName) }, encoding: "utf8" });

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbName) }) });
    const { createEncomendaWithOutbox } = await import("../../lib/ingest/orders");
    const { deriveFarmaciaIdempotencyKey } = await import("../../lib/ingest/orders");
    const { finalizarConsolidacaoMultiFornecedor, LinhasSemFornecedorError } = await import(
      "../../lib/encomendas/consolidacao-multi-fornecedor"
    );

    const u = await prisma.utilizador.create({ data: { email: "u@t.pt", nome: "U", perfil: "ADMINISTRADOR" } });
    const fA = await prisma.farmacia.create({ data: { nome: "Farmácia A" } });
    const fB = await prisma.farmacia.create({ data: { nome: "Farmácia B" } });
    const fornX = await prisma.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR X", nome: "Fornecedor X" } });
    const fornY = await prisma.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR Y", nome: "Fornecedor Y" } });
    const fornZ = await prisma.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR Z", nome: "Fornecedor Z" } });
    const produtos = await Promise.all(
      Array.from({ length: 5 }, (_, i) => prisma.produto.create({ data: { cnp: 8000000 + i, designacao: `Produto ${i}` } }))
    );

    console.log("\nA · rascunhos reais por farmácia (2 fornecedores em A, 1 em B)");
    const batchKey = "batch-cmf-teste-1";
    const draftA = await createEncomendaWithOutbox(
      prisma,
      "e2e",
      {
        farmaciaId: fA.id,
        criadoPorId: u.id,
        nome: "Consolidação · Farmácia A",
        finalize: false,
        linhas: [
          { produtoId: produtos[0].id, quantidadeAjustada: 10, fornecedorSugeridoId: fornX.id },
          { produtoId: produtos[1].id, quantidadeAjustada: 5, fornecedorSugeridoId: fornY.id },
        ],
        clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchKey, fA.id),
      },
      "consolidacao"
    );
    const draftB = await createEncomendaWithOutbox(
      prisma,
      "e2e",
      {
        farmaciaId: fB.id,
        criadoPorId: u.id,
        nome: "Consolidação · Farmácia B",
        finalize: false,
        linhas: [{ produtoId: produtos[2].id, quantidadeAjustada: 8, fornecedorSugeridoId: fornZ.id }],
        clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchKey, fB.id),
      },
      "consolidacao"
    );
    check(!!draftA.listaEncomendaId && !!draftB.listaEncomendaId, "A1: os dois rascunhos foram criados");

    console.log("\nB · finalizar a consolidação inteira");
    const resultado = await finalizarConsolidacaoMultiFornecedor(prisma, "e2e", {
      batchKey,
      farmaciaIds: [fA.id, fB.id],
    });
    check(resultado.reutilizado === false, "B1: primeira chamada não é replay");
    check(resultado.documentos.length === 3, "B2: 3 documentos no total (2 de A + 1 de B)", `obtido=${resultado.documentos.length}`);
    check(resultado.porFarmacia.find((f) => f.farmaciaId === fA.id)?.documentos.length === 2, "B3: farmácia A gerou 2 documentos");
    check(resultado.porFarmacia.find((f) => f.farmaciaId === fB.id)?.documentos.length === 1, "B4: farmácia B gerou 1 documento");
    const numeros = resultado.documentos.map((d) => d.numero);
    check(numeros.every((n) => n !== null && /^EN-\d{6}$/.test(n!)), "B5: os 3 números são reais EN-######");
    check(new Set(numeros).size === 3, "B6: os 3 números são distintos");

    const filhos = await prisma.listaEncomenda.findMany({
      where: { id: { in: resultado.documentos.map((d) => d.listaEncomendaId) } },
      select: { id: true, farmaciaId: true, estado: true, outbox: { select: { id: true } } },
    });
    check(filhos.length === 3 && filhos.every((f) => f.estado === "FINALIZADA"), "B7: os 3 nasceram FINALIZADA");
    check(filhos.every((f) => f.outbox !== null), "B8: os 3 têm o seu próprio OrderOutbox");
    check(
      filhos.filter((f) => f.farmaciaId === fA.id).length === 2 && filhos.filter((f) => f.farmaciaId === fB.id).length === 1,
      "B9: cada documento pertence à farmácia correcta — nenhuma mistura"
    );

    const draftsDepois = await prisma.listaEncomenda.findMany({
      where: { id: { in: [draftA.listaEncomendaId, draftB.listaEncomendaId] } },
      select: { estado: true, loteDivididoEm: true },
    });
    check(
      draftsDepois.every((d) => d.estado === "RASCUNHO" && d.loteDivididoEm !== null),
      "B10: os 2 rascunhos originais ficaram marcados como divididos (loteDivididoEm), estado continua RASCUNHO"
    );

    console.log("\nC · retry — nunca duplica");
    const retry = await finalizarConsolidacaoMultiFornecedor(prisma, "e2e", { batchKey, farmaciaIds: [fA.id, fB.id] });
    check(retry.reutilizado === true, "C1: retry reconhecido como replay");
    check(
      new Set(retry.documentos.map((d) => d.listaEncomendaId)).size === 3 &&
        retry.documentos.every((d) => resultado.documentos.some((o) => o.listaEncomendaId === d.listaEncomendaId)),
      "C2: o replay devolve EXACTAMENTE os mesmos 3 documentos"
    );
    const contagemDepoisRetry = await prisma.listaEncomenda.count({ where: { loteOrigemId: { in: [draftA.listaEncomendaId, draftB.listaEncomendaId] } } });
    check(contagemDepoisRetry === 3, "C3: continuam a existir exactamente 3 documentos filhos — retry não duplicou");

    console.log("\nD · linha sem fornecedor bloqueia a farmácia inteira, sem escrever nada");
    const fC = await prisma.farmacia.create({ data: { nome: "Farmácia C" } });
    const batchKey2 = "batch-cmf-teste-2";
    const draftC = await createEncomendaWithOutbox(
      prisma,
      "e2e",
      {
        farmaciaId: fC.id,
        criadoPorId: u.id,
        nome: "Consolidação · Farmácia C",
        finalize: false,
        linhas: [
          { produtoId: produtos[3].id, quantidadeAjustada: 3, fornecedorSugeridoId: fornX.id },
          { produtoId: produtos[4].id, quantidadeAjustada: 1, fornecedorSugeridoId: null },
        ],
        clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchKey2, fC.id),
      },
      "consolidacao"
    );
    let erroD: unknown = null;
    try {
      await finalizarConsolidacaoMultiFornecedor(prisma, "e2e", { batchKey: batchKey2, farmaciaIds: [fC.id] });
    } catch (e) {
      erroD = e;
    }
    check(erroD instanceof LinhasSemFornecedorError, "D1: rejeitado com LinhasSemFornecedorError");
    const draftCDepois = await prisma.listaEncomenda.findUnique({ where: { id: draftC.listaEncomendaId }, select: { loteDivididoEm: true, estado: true } });
    check(draftCDepois?.loteDivididoEm === null && draftCDepois?.estado === "RASCUNHO", "D2: o rascunho C continua intacto, não dividido");
    const filhosC = await prisma.listaEncomenda.count({ where: { loteOrigemId: draftC.listaEncomendaId } });
    check(filhosC === 0, "D3: nenhum documento filho foi criado para C");

    console.log("\nE · rollback total quando uma farmácia falha a meio (mistura com um grupo válido)");
    const fD = await prisma.farmacia.create({ data: { nome: "Farmácia D" } });
    const fE = await prisma.farmacia.create({ data: { nome: "Farmácia E" } });
    const batchKey3 = "batch-cmf-teste-3";
    const draftDValid = await createEncomendaWithOutbox(
      prisma,
      "e2e",
      {
        farmaciaId: fD.id,
        criadoPorId: u.id,
        nome: "Consolidação · Farmácia D",
        finalize: false,
        linhas: [{ produtoId: produtos[0].id, quantidadeAjustada: 2, fornecedorSugeridoId: fornX.id }],
        clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchKey3, fD.id),
      },
      "consolidacao"
    );
    // Farmácia E: sem rascunho nenhum criado — força a falha "sem rascunho".
    let erroE: unknown = null;
    try {
      await finalizarConsolidacaoMultiFornecedor(prisma, "e2e", { batchKey: batchKey3, farmaciaIds: [fD.id, fE.id] });
    } catch (e) {
      erroE = e;
    }
    check(erroE instanceof Error, "E1: a chamada falha (farmácia E sem rascunho)");
    const draftDDepois = await prisma.listaEncomenda.findUnique({ where: { id: draftDValid.listaEncomendaId }, select: { loteDivididoEm: true } });
    check(draftDDepois?.loteDivididoEm === null, "E2: a farmácia D (válida) NÃO ficou dividida — rollback total, não parcial");
    const filhosD = await prisma.listaEncomenda.count({ where: { loteOrigemId: draftDValid.listaEncomendaId } });
    check(filhosD === 0, "E3: nenhum documento foi criado para D apesar de ser válida — tudo ou nada");

    console.log("\nF · 8 chamadas concorrentes com a mesma chave — um único lote de documentos");
    const fF = await prisma.farmacia.create({ data: { nome: "Farmácia F" } });
    const batchKey4 = "batch-cmf-teste-4";
    const draftF = await createEncomendaWithOutbox(
      prisma,
      "e2e",
      {
        farmaciaId: fF.id,
        criadoPorId: u.id,
        nome: "Consolidação · Farmácia F",
        finalize: false,
        linhas: [
          { produtoId: produtos[0].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornX.id },
          { produtoId: produtos[1].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornY.id },
        ],
        clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchKey4, fF.id),
      },
      "consolidacao"
    );
    const concorrentes = await Promise.allSettled(
      Array.from({ length: 8 }, () => finalizarConsolidacaoMultiFornecedor(prisma, "e2e", { batchKey: batchKey4, farmaciaIds: [fF.id] }))
    );
    const sucessos = concorrentes.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof finalizarConsolidacaoMultiFornecedor>>> => r.status === "fulfilled");
    check(sucessos.length === 8, "F1: as 8 chamadas concorrentes tiveram sucesso (idempotência, não erro)", `sucessos=${sucessos.length}`);
    const idsUnicos = new Set(sucessos.flatMap((s) => s.value.documentos.map((d) => d.listaEncomendaId)));
    check(idsUnicos.size === 2, "F2: só 2 documentos filhos reais existem (nunca 16)", `obtido=${idsUnicos.size}`);
    const filhosFReal = await prisma.listaEncomenda.count({ where: { loteOrigemId: draftF.listaEncomendaId } });
    check(filhosFReal === 2, "F3: confirmado directamente em Postgres — só 2 filhos reais");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
