/**
 * scripts/tests/test-criar-transferencia-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (mesmo padrão dos outros testes -db.ts
 * deste repositório). Prova, contra uma base real,
 * `lib/transferencias/criar-transferencia.ts`:
 *   A. criação simples nasce FINALIZADA com número TR-###### e
 *      designacaoSnapshot capturado por linha.
 *   B. clique repetido com a MESMA clientIdempotencyKey devolve a MESMA
 *      transferência (nenhuma segunda row criada).
 *   C. a mesma chave com um pedido DIFERENTE lança IdempotencyConflictError.
 *   D. duas transferências sem chave (undefined) nunca colidem entre si.
 *   E. finalizarTransferencia é idempotente sobre um RASCUNHO existente.
 *
 *   docker run -d --name spharm-criar-transf-test-pg -e POSTGRES_PASSWORD=test -p 55436:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55436/postgres npx tsx scripts/tests/test-criar-transferencia-db.ts
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55436/postgres";
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
  const {
    criarTransferenciaComLinhas,
    finalizarTransferencia,
    IdempotencyConflictError,
  } = await import("../../lib/transferencias/criar-transferencia");

  const sufixo = Date.now().toString(36);
  const dbNome = `spharm_criartransf_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbNome}`);

  try {
    console.log("\nA · migrations desde base vazia");
    const out = execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbNome) }, encoding: "utf8" });
    check(/successfully applied|No pending migrations/i.test(out), "A1: migrations aplicadas sem erro numa base vazia");

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbNome) }) });

    const origem = await prisma.farmacia.create({ data: { nome: "Farmácia Origem" } });
    const destino = await prisma.farmacia.create({ data: { nome: "Farmácia Destino" } });
    const utilizador = await prisma.utilizador.create({
      data: { email: "user@teste.local", nome: "Utilizador Teste", passwordHash: "x", perfil: "ADMINISTRADOR" },
    });
    const produto = await prisma.produto.create({ data: { cnp: 1234567, designacao: "Produto Teste 500mg" } });

    console.log("\nB · criação simples nasce FINALIZADA com número e snapshot");
    const r1 = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: origem.id,
      farmaciaDestinoId: destino.id,
      criadoPorId: utilizador.id,
      finalize: true,
      linhas: [{ produtoId: produto.id, quantidade: 5 }],
    });
    check(/^TR-\d{6}$/.test(r1.numero ?? ""), "B1: número no formato TR-######", r1.numero ?? "null");
    const t1Db = await prisma.transferencia.findUniqueOrThrow({
      where: { id: r1.transferenciaId },
      include: { linhas: true },
    });
    check(t1Db.estado === "FINALIZADA", "B2: estado real gravado é FINALIZADA");
    check(t1Db.dataFinalizacao !== null, "B3: dataFinalizacao real preenchida");
    check(t1Db.linhas[0]?.designacaoSnapshot === "Produto Teste 500mg", "B4: designacaoSnapshot real capturado", t1Db.linhas[0]?.designacaoSnapshot ?? "null");

    console.log("\nC · clique repetido com a MESMA chave não duplica");
    const chave = "chave-idempotencia-teste-1";
    const r2a = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: origem.id,
      farmaciaDestinoId: destino.id,
      criadoPorId: utilizador.id,
      finalize: true,
      linhas: [{ produtoId: produto.id, quantidade: 10 }],
      clientIdempotencyKey: chave,
    });
    const r2b = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: origem.id,
      farmaciaDestinoId: destino.id,
      criadoPorId: utilizador.id,
      finalize: true,
      linhas: [{ produtoId: produto.id, quantidade: 10 }],
      clientIdempotencyKey: chave,
    });
    check(r2a.transferenciaId === r2b.transferenciaId, "C1: mesma chave devolve a MESMA transferência real");
    const totalComChave = await prisma.transferencia.count({ where: { clientIdempotencyKey: chave } });
    check(totalComChave === 1, "C2: só existe 1 row real com esta chave em Postgres", String(totalComChave));

    console.log("\nD · mesma chave, pedido diferente → IdempotencyConflictError");
    let lancou = false;
    try {
      await criarTransferenciaComLinhas(prisma, {
        farmaciaOrigemId: origem.id,
        farmaciaDestinoId: destino.id,
        criadoPorId: utilizador.id,
        finalize: true,
        linhas: [{ produtoId: produto.id, quantidade: 999 }], // quantidade diferente
        clientIdempotencyKey: chave,
      });
    } catch (e) {
      lancou = e instanceof IdempotencyConflictError;
    }
    check(lancou, "D1: pedido diferente sob a mesma chave lança IdempotencyConflictError real");
    const totalComChaveDepois = await prisma.transferencia.count({ where: { clientIdempotencyKey: chave } });
    check(totalComChaveDepois === 1, "D2: continua a existir só 1 row — o pedido em conflito NÃO foi aplicado");

    console.log("\nE · duas transferências sem chave nunca colidem");
    const r3a = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: origem.id, farmaciaDestinoId: destino.id, criadoPorId: utilizador.id,
      finalize: true, linhas: [{ produtoId: produto.id, quantidade: 1 }],
    });
    const r3b = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: origem.id, farmaciaDestinoId: destino.id, criadoPorId: utilizador.id,
      finalize: true, linhas: [{ produtoId: produto.id, quantidade: 1 }],
    });
    check(r3a.transferenciaId !== r3b.transferenciaId, "E1: sem chave, dois pedidos reais criam duas transferências distintas");
    check(r3a.numero !== r3b.numero, "E2: números reais distintos e sequenciais", `${r3a.numero} vs ${r3b.numero}`);

    console.log("\nF · finalizarTransferencia é idempotente sobre um RASCUNHO");
    const rascunho = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: origem.id, farmaciaDestinoId: destino.id, criadoPorId: utilizador.id,
      finalize: false, linhas: [{ produtoId: produto.id, quantidade: 2 }],
    });
    check(rascunho.numero === null, "F1: RASCUNHO real não tem número atribuído");
    const fin1 = await finalizarTransferencia(prisma, rascunho.transferenciaId);
    const fin2 = await finalizarTransferencia(prisma, rascunho.transferenciaId);
    check(fin1.numero !== null, "F2: 1ª finalização real atribui número");
    check(fin1.numero === fin2.numero, "F3: 2ª finalização (no-op) devolve o MESMO número real, não atribui outro");

    await prisma.$disconnect();
    console.log("\nG · concorrência REAL — numeração nunca colide sob corridas em paralelo (Promise.all, não sequencial)");
    {
      const N = 8;
      const resultados = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          criarTransferenciaComLinhas(prisma, {
            farmaciaOrigemId: origem.id,
            farmaciaDestinoId: destino.id,
            criadoPorId: utilizador.id,
            finalize: true,
            linhas: [{ produtoId: produto.id, quantidade: i + 1 }],
          })
        )
      );
      const numeros = resultados.map((r) => r.numero);
      const numerosUnicos = new Set(numeros);
      check(numerosUnicos.size === N, `G1: ${N} criações REALMENTE em paralelo (Promise.all) geram ${N} números distintos — zero colisão`, JSON.stringify(numeros));
      check(numeros.every((n) => /^TR-\d{6}$/.test(n ?? "")), "G2: todos no formato TR-######");
    }

    console.log("\nH · duas operações simultâneas com a MESMA chave — corrida real, não dois chamadas sequenciais");
    {
      const chaveCorrida = `corrida-real-${Date.now()}`;
      const payload = {
        farmaciaOrigemId: origem.id,
        farmaciaDestinoId: destino.id,
        criadoPorId: utilizador.id,
        finalize: true,
        linhas: [{ produtoId: produto.id, quantidade: 42 }],
        clientIdempotencyKey: chaveCorrida,
      };
      // As DUAS chamadas arrancam ao mesmo tempo (sem await entre elas) —
      // isto é o que reproduz de facto um duplo-clique real, ao contrário
      // de duas chamadas sequenciais (uma só depois da outra já ter
      // commitado, que nunca exercitaria o retry em P2002).
      const [rA, rB] = await Promise.all([
        criarTransferenciaComLinhas(prisma, payload),
        criarTransferenciaComLinhas(prisma, payload),
      ]);
      check(rA.transferenciaId === rB.transferenciaId, "H1: as DUAS chamadas em corrida real resolvem para a MESMA transferência", `${rA.transferenciaId} vs ${rB.transferenciaId}`);
      const totalComChave = await prisma.transferencia.count({ where: { clientIdempotencyKey: chaveCorrida } });
      check(totalComChave === 1, "H2: só existe 1 row real na base apesar da corrida genuína", String(totalComChave));
    }

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
