/**
 * scripts/tests/test-transferencias-manutencao-escopo-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL. Prova, contra dados reais, o isolamento
 * por farmácia de `loadTransferenciasManutencao`
 * (lib/transferencias/manutencao-data.ts) — e cobre especificamente uma
 * regressão real encontrada por e2e: o escopo por farmácia
 * (`farmaciaOrigemId`/`farmaciaDestinoId`) e a pesquisa por número
 * partilhavam o MESMO array `where.OR`, o que tornava as duas condições
 * uma disjunção ("origem=X OU destino=X OU número~termo") em vez de uma
 * conjunção — um utilizador restrito a uma farmácia conseguia encontrar
 * a transferência de OUTRA farmácia bastando pesquisar pelo número
 * exacto. Corrigido para `AND` de cláusulas independentes.
 *
 *   docker run -d --name spharm-manut-escopo-test-pg -e POSTGRES_PASSWORD=test -p 55446:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55446/postgres npx tsx scripts/tests/test-transferencias-manutencao-escopo-db.ts
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55446/postgres";
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
  const dbNome = `spharm_manutescopo_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbNome}`);

  try {
    const out = execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbNome) }, encoding: "utf8" });
    check(/successfully applied|No pending migrations/i.test(out), "A1: migrations aplicadas sem erro");

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbNome) }) });
    const { criarTransferenciaComLinhas } = await import("../../lib/transferencias/criar-transferencia");
    const { loadTransferenciasManutencao } = await import("../../lib/transferencias/manutencao-data");

    const farmA = await prisma.farmacia.create({ data: { nome: "Farmácia A (utilizador restrito)" } });
    const farmB = await prisma.farmacia.create({ data: { nome: "Farmácia B (outra, sem acesso)" } });
    const farmC = await prisma.farmacia.create({ data: { nome: "Farmácia C (outra, sem acesso)" } });
    const utilizador = await prisma.utilizador.create({ data: { email: "u@escopo.pt", nome: "U", perfil: "GESTOR_FARMACIA", farmaciaId: farmA.id } });
    const produto = await prisma.produto.create({ data: { cnp: 9990001, designacao: "Produto Escopo" } });

    // Transferência da farmácia do utilizador (A) — deve ser sempre visível.
    const propria = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: farmA.id, farmaciaDestinoId: farmB.id, criadoPorId: utilizador.id,
      finalize: true, linhas: [{ produtoId: produto.id, quantidade: 1 }],
    });
    // Transferência ENTRE OUTRAS DUAS farmácias (B→C) — o utilizador de A
    // nunca deveria conseguir vê-la, nem por pesquisa de número exacto.
    const alheia = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: farmB.id, farmaciaDestinoId: farmC.id, criadoPorId: utilizador.id,
      finalize: true, linhas: [{ produtoId: produto.id, quantidade: 2 }],
    });

    const scope = { irrestrito: false as const, farmaciaId: farmA.id };

    console.log("\nA · sem pesquisa — só a transferência da própria farmácia é visível");
    {
      const data = await loadTransferenciasManutencao(prisma, { scope, page: 1, pageSize: 25 });
      check(data.transferencias.some((t) => t.id === propria.transferenciaId), "A1: a transferência da própria farmácia aparece");
      check(!data.transferencias.some((t) => t.id === alheia.transferenciaId), "A2: a transferência alheia (B→C) NÃO aparece");
    }

    console.log("\nB · pesquisa pelo número EXACTO da transferência ALHEIA — regressão real (Ponto 9a do e2e)");
    {
      const data = await loadTransferenciasManutencao(prisma, { scope, search: alheia.numero!, page: 1, pageSize: 25 });
      check(
        data.transferencias.length === 0,
        "B1: pesquisar pelo número exacto de uma transferência de OUTRA farmácia devolve ZERO resultados — nunca escapa ao escopo",
        `obtido: ${JSON.stringify(data.transferencias.map((t) => t.id))}`
      );
    }

    console.log("\nC · pesquisa pelo número da PRÓPRIA transferência continua a funcionar");
    {
      const data = await loadTransferenciasManutencao(prisma, { scope, search: propria.numero!, page: 1, pageSize: 25 });
      check(data.transferencias.length === 1 && data.transferencias[0]!.id === propria.transferenciaId, "C1: pesquisa pelo próprio número real continua a encontrar a transferência certa");
    }

    console.log("\nD · administrador (escopo irrestrito) continua a ver ambas");
    {
      const data = await loadTransferenciasManutencao(prisma, { scope: { irrestrito: true }, page: 1, pageSize: 25 });
      check(
        data.transferencias.some((t) => t.id === propria.transferenciaId) && data.transferencias.some((t) => t.id === alheia.transferenciaId),
        "D1: sem escopo, ambas as transferências reais são visíveis"
      );
    }

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbNome} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
