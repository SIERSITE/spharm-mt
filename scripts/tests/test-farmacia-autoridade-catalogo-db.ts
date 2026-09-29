/**
 * scripts/tests/test-farmacia-autoridade-catalogo-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (mesmo padrão dos outros testes -db.ts
 * deste repositório). Prova, contra uma base real, o caso concreto
 * relatado: tenant com duas farmácias (Silveirense/Segurado), a
 * Silveirense marcada como autoridade de catálogo, CNP 5589312,
 * "GENERIS DIRECTO" a resolver por alias para o Fabricante canónico
 * "Generis Farmacêutica, S.A. Portugal".
 *
 *   docker run -d --name spharm-fab-auth-test-pg -e POSTGRES_PASSWORD=test -p 55434:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55434/postgres npx tsx scripts/tests/test-farmacia-autoridade-catalogo-db.ts
 *
 * Guarda de segurança: recusa correr se o host não for localhost/127.0.0.1.
 * Cria uma base temporária e apaga-a no fim.
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55434/postgres";
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
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { applyErpCatalogFields } = await import("../../lib/ingest/catalog-from-erp");
  const { setFarmaciaAutoridadeCatalogo, getFarmaciaAutoridadeCatalogo } = await import("../../lib/farmacia-catalogo");

  const sufixo = Date.now().toString(36);
  const dbNome = `spharm_farmauth_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbNome}`);

  try {
    console.log("\nA · migrations desde base vazia");
    const out = execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbNome) }, encoding: "utf8" });
    check(/successfully applied|No pending migrations/i.test(out), "A1: migrations aplicadas sem erro numa base vazia");

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbNome) }) });

    console.log("\nB · configurar a farmácia autoritativa (ferramenta administrativa real)");
    const silveirense = await prisma.farmacia.create({ data: { nome: "Farmácia Silveirense" } });
    const segurado = await prisma.farmacia.create({ data: { nome: "Farmácia Segurado" } });
    await setFarmaciaAutoridadeCatalogo(prisma, silveirense.id);
    const autoridade = await getFarmaciaAutoridadeCatalogo(prisma);
    check(autoridade?.id === silveirense.id, "B1: a Silveirense fica marcada como autoridade de catálogo", JSON.stringify(autoridade));

    console.log("\nC · caso real: CNP 5589312, alias GENERIS DIRECTO → canónico Generis Farmacêutica S.A. Portugal");
    const canonico = await prisma.fabricante.create({ data: { nomeNormalizado: "GENERIS FARMACEUTICA S A PORTUGAL" } });
    await prisma.fabricanteAlias.create({ data: { fabricanteId: canonico.id, aliasNome: "GENERIS DIRECTO" } });
    const antigo = await prisma.fabricante.create({ data: { nomeNormalizado: "OUTRO FABRICANTE ANTIGO LDA" } });
    const produto = await prisma.produto.create({
      data: { cnp: 5589312, designacao: "Cetirizina Aurobindo - 10 Mg 20 Comp", fabricanteId: antigo.id },
    });

    const linha = { cnp: 5589312, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: "Generis Directo" };

    // 2/3/4/5/6 — Silveirense (autoridade) sincroniza.
    const r1 = await applyErpCatalogFields(prisma, [linha], silveirense.id);
    check(r1.preenchidos.fabricante + r1.substituidos.fabricante === 1, "C1 (regra 6): contador fabricantesAlterados = 1", JSON.stringify(r1));
    const produtoDb1 = await prisma.produto.findUnique({ where: { id: produto.id }, select: { fabricanteId: true } });
    check(produtoDb1?.fabricanteId === canonico.id, "C2 (regra 4): Produto.fabricanteId real actualizado para o canónico Generis", produtoDb1?.fabricanteId ?? "null");
    const fabricantesDb = await prisma.fabricante.findMany({ select: { nomeNormalizado: true } });
    check(!fabricantesDb.some((f) => f.nomeNormalizado === "GENERIS DIRECTO"), "C3 (regra 3): nunca criou um Fabricante literal 'GENERIS DIRECTO' — resolveu por alias real", JSON.stringify(fabricantesDb));
    check(fabricantesDb.length === 2, "C4: continuam a existir só os 2 Fabricante que já existiam (canónico + antigo) — nenhum a mais");

    // 7 — repetição idempotente.
    const r2 = await applyErpCatalogFields(prisma, [linha], silveirense.id);
    check(r2.preenchidos.fabricante + r2.substituidos.fabricante === 0, "C5 (regra 7): repetição do payload é idempotente — zero alterações reais em Postgres", JSON.stringify(r2));

    // 8/9 — Segurado envia um fabricante diferente.
    const linhaSegurado = { ...linha, fabricante: "Outro Fabricante Segurado Real Lda" };
    const r3 = await applyErpCatalogFields(prisma, [linhaSegurado], segurado.id);
    check(r3.preenchidos.fabricante + r3.substituidos.fabricante === 0, "C6 (regra 9): Segurado nunca conta como alteração", JSON.stringify(r3));
    const produtoDb2 = await prisma.produto.findUnique({ where: { id: produto.id }, select: { fabricanteId: true } });
    check(produtoDb2?.fabricanteId === canonico.id, "C7 (regra 9): Produto.fabricanteId real continua Generis — Segurado não o alterou");
    const pfSeguradoDb = await prisma.produtoFarmacia.findUnique({ where: { produtoId_farmaciaId: { produtoId: produto.id, farmaciaId: segurado.id } }, select: { fabricanteErpAtual: true } });
    check(pfSeguradoDb?.fabricanteErpAtual === "OUTRO FABRICANTE SEGURADO REAL LDA", "C8 (regra 9): valor ERP da Segurado gravado em ProdutoFarmacia real (informação local)", pfSeguradoDb?.fabricanteErpAtual ?? "null");

    // 10 — nova sincronização da Silveirense continua a prevalecer, mesmo
    // depois de uma alteração directa (ex.: acção administrativa).
    await prisma.produto.update({ where: { id: produto.id }, data: { fabricanteId: antigo.id } });
    const r4 = await applyErpCatalogFields(prisma, [linha], silveirense.id);
    check(r4.preenchidos.fabricante + r4.substituidos.fabricante === 1, "C9 (regra 10): Silveirense reafirma o valor — conta como alteração real");
    const produtoDb3 = await prisma.produto.findUnique({ where: { id: produto.id }, select: { fabricanteId: true } });
    check(produtoDb3?.fabricanteId === canonico.id, "C10 (regra 10): Produto.fabricanteId real volta a Generis");

    console.log("\nD · campos manuais continuam protegidos, mesmo contra a autoridade (regra 12)");
    {
      const produtoManual = await prisma.produto.create({
        data: { cnp: 5589320, designacao: "Produto Validado Manualmente", fabricanteId: antigo.id, validadoManualmente: true },
      });
      const r5 = await applyErpCatalogFields(prisma, [{ ...linha, cnp: 5589320 }], silveirense.id);
      check(r5.preenchidos.fabricante + r5.substituidos.fabricante === 0, "D1: validadoManualmente bloqueia mesmo a autoridade de catálogo, contra Postgres real");
      const produtoManualDb = await prisma.produto.findUnique({ where: { id: produtoManual.id }, select: { fabricanteId: true } });
      check(produtoManualDb?.fabricanteId === antigo.id, "D2: Produto.fabricanteId real permanece intocado");
    }

    console.log("\nE · sem autoridade configurada (outro tenant) — comportamento histórico simétrico inalterado");
    {
      await setFarmaciaAutoridadeCatalogo(prisma, null);
      const farmA = await prisma.farmacia.create({ data: { nome: "Farmácia Qualquer A" } });
      const farmB = await prisma.farmacia.create({ data: { nome: "Farmácia Qualquer B" } });
      const produtoSimetrico = await prisma.produto.create({ data: { cnp: 6100200, designacao: "Produto Sem Autoridade" } });
      const rA = await applyErpCatalogFields(prisma, [{ ...linha, cnp: 6100200, fabricante: "Fabricante Simetrico Lda" }], farmA.id);
      check(rA.preenchidos.fabricante === 1, "E1: sem autoridade — farmácia A escreve normalmente contra Postgres real");
      const rB = await applyErpCatalogFields(prisma, [{ ...linha, cnp: 6100200, fabricante: "Fabricante Simetrico Lda" }], farmB.id);
      check(rB.preenchidos.fabricante + rB.substituidos.fabricante === 0, "E2: 2ª farmácia, mesmo valor — baseline dela própria também está vazio no 1º ciclo, mas o campo já não está vazio (protecção histórica de sempre, inalterada)");
      void produtoSimetrico;
    }

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbNome} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
