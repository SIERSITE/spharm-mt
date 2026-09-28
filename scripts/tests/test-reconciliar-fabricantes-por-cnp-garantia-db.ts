/**
 * scripts/tests/test-reconciliar-fabricantes-por-cnp-garantia-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL — nunca uma base verdadeira (mesmo
 * padrão de scripts/tests/test-encomenda-idempotencia-db.ts).
 *
 *   docker run -d --name spharm-fab-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55432/postgres npx tsx scripts/tests/test-reconciliar-fabricantes-por-cnp-garantia-db.ts
 *
 * Guarda de segurança: recusa correr se o host não for localhost/127.0.0.1.
 * Cria uma base temporária (spharm_fabcnp_*) e apaga-a no fim.
 *
 * Complementa scripts/tests/test-reconciliar-fabricantes-por-cnp-garantia.ts
 * (Prisma falso): aqui o alvo é Postgres REAL — migrations desde base
 * vazia, escrita/leitura reais (Fabricante.nomeNormalizado @unique,
 * FabricanteAlias @@unique), dry-run com sessão read-only, idempotência
 * numa segunda corrida real, e a trava de tenant contra um PrismaClient
 * verdadeiro (não um stub que já sabe recusar).
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// `server-only` só existe no build do Next — stub antes de carregar os módulos de domínio.
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55432/postgres";
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

const TITULAR_REAL = "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.";

async function main() {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { normalizarTitularAimGarantia } = await import("../../lib/catalog/fabricante-normalizacao-garantia");
  const { reconciliarFabricantesPorCnpGarantia } = await import("../../lib/catalog/reconciliar-fabricantes-por-cnp-garantia");

  const sufixo = Date.now().toString(36);
  const dbNome = `spharm_fabcnp_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbNome}`);

  try {
    console.log("\nA · migrations desde base vazia");
    const out = execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbNome) }, encoding: "utf8" });
    check(/successfully applied|No pending migrations/i.test(out), "A1: migrations aplicadas sem erro numa base vazia");

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbNome) }) });

    const normTitular = normalizarTitularAimGarantia(TITULAR_REAL)!;
    // p1: titular resolve para um Fabricante JÁ existente (nome exacto).
    const fPharmakern = await prisma.fabricante.create({ data: { nomeNormalizado: normTitular } });
    const p1 = await prisma.produto.create({ data: { cnp: 5701651, designacao: "Tadalafil Pharmakern 20 Mg 4 Comp." } });
    await prisma.regulatoryRecord.create({ data: { cnp: 5701651, titularAim: TITULAR_REAL, estadoAim: "Autorizado", source: "test" } });

    // p2: catalogável, SEM RegulatoryRecord, sem origem — deve ficar sem fonte, nunca inventado.
    const p2 = await prisma.produto.create({ data: { cnp: 8000001, designacao: "Produto Sem Registo" } });

    // p3: titular SEM Fabricante correspondente — deve criar um novo.
    const NOVO_TITULAR = "Nova Farmaceutica Real Unipessoal Lda";
    const p3 = await prisma.produto.create({ data: { cnp: 6000001, designacao: "Produto Titular Novo" } });
    await prisma.regulatoryRecord.create({ data: { cnp: 6000001, titularAim: NOVO_TITULAR, estadoAim: "Ativo", source: "test" } });

    console.log("\nB · dry-run — zero escritas reais em Postgres");
    {
      const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "todos", dryRun: true });
      check(r.resolvidosPorNomeNormalizado === 1, "B1: p1 resolvido por nome normalizado (relatório)", JSON.stringify(r));
      check(r.fabricantesCriados === 1, "B2: relatório mostra 1 fabricante que SERIA criado (p3)");
      check(r.semFonte.SEM_REGISTO_CATALOGO === 1, "B3: p2 sem fonte (SEM_REGISTO_CATALOGO)");

      const [p1Db, p3Db, fabricantesDb] = await Promise.all([
        prisma.produto.findUnique({ where: { id: p1.id }, select: { fabricanteId: true } }),
        prisma.produto.findUnique({ where: { id: p3.id }, select: { fabricanteId: true } }),
        prisma.fabricante.findMany(),
      ]);
      check(p1Db?.fabricanteId === null, "B4: p1.fabricanteId continua NULL em Postgres — dry-run não escreveu");
      check(p3Db?.fabricanteId === null, "B5: p3.fabricanteId continua NULL em Postgres");
      check(fabricantesDb.length === 1, "B6: continua a existir exactamente 1 Fabricante real (fPharmakern) — nenhum criado", `${fabricantesDb.length}`);
    }

    console.log("\nC · trava de tenant contra um PrismaClient REAL — recusa antes de qualquer query");
    {
      let mensagem = "";
      try {
        await reconciliarFabricantesPorCnpGarantia(prisma, "silveira", { tipo: "todos" });
      } catch (err) {
        mensagem = err instanceof Error ? err.message : String(err);
      }
      check(mensagem.includes("garantia"), "C1: recusado com mensagem mencionando garantia", mensagem);
      const p1Db = await prisma.produto.findUnique({ where: { id: p1.id }, select: { fabricanteId: true } });
      check(p1Db?.fabricanteId === null, "C2: p1 continua intocado depois da tentativa recusada");
    }

    console.log("\nD · corrida real (apply) — resolve, cria fabricante novo quando preciso, nunca inventa sem fonte");
    {
      const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "todos" });
      eqLog(r);

      const [p1Db, p2Db, p3Db, fabricantesDb] = await Promise.all([
        prisma.produto.findUnique({ where: { id: p1.id }, select: { fabricanteId: true } }),
        prisma.produto.findUnique({ where: { id: p2.id }, select: { fabricanteId: true } }),
        prisma.produto.findUnique({ where: { id: p3.id }, select: { fabricanteId: true } }),
        prisma.fabricante.findMany(),
      ]);
      check(p1Db?.fabricanteId === fPharmakern.id, "D1: p1.fabricanteId gravado com o Fabricante Pharmakern EXISTENTE");
      check(p2Db?.fabricanteId === null, "D2: p2 continua sem fabricante — sem fonte, nunca inventado");
      check(p3Db?.fabricanteId !== null && p3Db?.fabricanteId !== fPharmakern.id, "D3: p3.fabricanteId gravado com um Fabricante NOVO, distinto do Pharmakern");
      check(fabricantesDb.length === 2, "D4: exactamente 2 Fabricante reais agora (Pharmakern + o novo) — nenhum duplicado", `${fabricantesDb.length}`);
      const novo = fabricantesDb.find((f) => f.id === p3Db?.fabricanteId);
      check(novo?.nomeNormalizado === normalizarTitularAimGarantia(NOVO_TITULAR), "D5: o nome do Fabricante novo é o titular normalizado (nunca truncado/alterado)");
    }

    console.log("\nE · segunda corrida real consecutiva — zero escritas (idempotência)");
    {
      const antes = await prisma.fabricante.findMany();
      const r2 = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "todos" });
      check(r2.fabricantesCriados === 0, "E1: zero fabricantes criados na segunda corrida");
      check(r2.jaTinhaFabricante === 2, "E2: p1 e p3 intercetados no nível 1 (já têm fabricante)");
      const depois = await prisma.fabricante.findMany();
      check(depois.length === antes.length, "E3: nenhum Fabricante novo criado — mesma contagem antes/depois");
    }

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbNome} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

function eqLog(r: unknown): void {
  console.log(`  (relatório da corrida real: ${JSON.stringify(r)})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
