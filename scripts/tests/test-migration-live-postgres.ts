/**
 * scripts/tests/test-migration-live-postgres.ts
 *
 * Validação REAL das migrations mais recentes (versao/contextoJson) contra
 * um PostgreSQL descartável real (container Docker efémero, nunca a VPS,
 * nunca uma base de produção). Ao contrário de test-encomenda-autosave.ts
 * (que usa um Prisma FALSO em memória para testar a lógica pura), este
 * ficheiro liga-se a Postgres a sério via DATABASE_URL e exercita:
 *
 *   1. aplicar todas as migrations a partir de uma base vazia (feito por
 *      `prisma migrate deploy` antes de correr este script — ver comando
 *      abaixo, não repetido aqui)
 *   2. `versao` NOT NULL DEFAULT 0
 *   3. criar um rascunho
 *   4. actualizar com a versão correcta
 *   5. rejeitar uma versão desactualizada
 *   6. confirmar que nenhuma linha pré-existente foi corrompida
 *
 * Uso:
 *   docker run -d --name spharm-migration-test -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_USER=test -e POSTGRES_DB=spharm_migration_test \
 *     -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://test:test@localhost:55432/spharm_migration_test \
 *     npx prisma migrate deploy
 *   DATABASE_URL=postgresql://test:test@localhost:55432/spharm_migration_test \
 *     npx tsx scripts/tests/test-migration-live-postgres.ts
 */
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { salvarAutosaveEncomenda, ConflitoVersaoError } from "../../lib/encomendas/autosave";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}
function eq(a: unknown, b: unknown, msg: string) {
  check(JSON.stringify(a) === JSON.stringify(b), `${msg} (esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)})`);
}

async function principal() {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.includes("55432")) {
    console.error(
      "DATABASE_URL tem de apontar para o Postgres descartável da porta 55432 — recusa correr contra outra coisa."
    );
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log("A · migrations aplicadas — schema tem as colunas esperadas");
    const versaoCol = await prisma.$queryRawUnsafe<{ column_default: string | null; is_nullable: string }[]>(
      `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'ListaEncomenda' AND column_name = 'versao'`
    );
    check(versaoCol.length === 1, "A1: coluna versao existe");
    eq(versaoCol[0]?.is_nullable, "NO", "A2: versao é NOT NULL");
    check((versaoCol[0]?.column_default ?? "").includes("0"), "A3: versao tem DEFAULT 0");

    const contextoCol = await prisma.$queryRawUnsafe<{ is_nullable: string }[]>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'ListaEncomenda' AND column_name = 'contextoJson'`
    );
    check(contextoCol.length === 1, "A4: coluna contextoJson existe");
    eq(contextoCol[0]?.is_nullable, "YES", "A5: contextoJson é nullable (nenhum backfill necessário)");

    // ── Seed mínimo: farmácia + utilizador + produto pré-existentes ──────
    console.log("\nB · seed de dados pré-existentes (para confirmar que a migration não os tocou)");
    const farmacia = await prisma.farmacia.create({
      data: { id: "farm-1", nome: "Farmácia Teste Migração", dataAtualizacao: new Date() },
    });
    const utilizador = await prisma.utilizador.create({
      data: {
        id: "user-1",
        email: "migracao@teste.local",
        nome: "Utilizador Teste",
        perfil: "ADMINISTRADOR",
        dataAtualizacao: new Date(),
      },
    });
    const produtoA = await prisma.produto.create({
      data: { id: "prod-a", cnp: 111111, designacao: "Produto A", dataAtualizacao: new Date() },
    });
    const produtoB = await prisma.produto.create({
      data: { id: "prod-b", cnp: 222222, designacao: "Produto B", dataAtualizacao: new Date() },
    });
    // Uma linha "antiga" pré-existente, simulando dados que já estavam na
    // base ANTES desta migration correr — para provar que sobrevive intacta.
    const listaPreExistente = await prisma.listaEncomenda.create({
      data: {
        id: "lista-preexistente",
        farmaciaId: farmacia.id,
        criadoPorId: utilizador.id,
        nome: "Encomenda pré-existente",
        estado: "FINALIZADA",
        dataAtualizacao: new Date(),
        linhas: { create: [{ produtoId: produtoA.id, quantidadeAjustada: 7, origem: "PROPOSTA" }] },
      },
      include: { linhas: true },
    });
    eq(listaPreExistente.versao, 0, "B1: lista pré-existente nasce com versao=0 (o DEFAULT, sem eu ter dito nada)");
    eq(listaPreExistente.contextoJson, null, "B2: lista pré-existente nasce com contextoJson=NULL");

    console.log("\nC · criar um rascunho (#3 do pedido)");
    const rascunho = await prisma.listaEncomenda.create({
      data: {
        id: "lista-rascunho-1",
        farmaciaId: farmacia.id,
        criadoPorId: utilizador.id,
        nome: "Rascunho novo",
        estado: "RASCUNHO",
        dataAtualizacao: new Date(),
        contextoJson: JSON.stringify({ mode: "farmacia", coverageDays: 15 }),
        linhas: { create: [{ produtoId: produtoA.id, quantidadeAjustada: 3, origem: "PROPOSTA" }] },
      },
    });
    eq(rascunho.versao, 0, "C1: rascunho novo começa em versao=0");
    eq(rascunho.contextoJson, JSON.stringify({ mode: "farmacia", coverageDays: 15 }), "C2: contextoJson gravado tal como enviado");

    console.log("\nD · actualizar com a versão correcta (#4)");
    const r1 = await salvarAutosaveEncomenda(prisma, {
      listaEncomendaId: rascunho.id,
      versaoEsperada: 0,
      linhas: [{ produtoId: produtoB.id, quantidadeAjustada: 5, origem: "MANUAL" }],
    });
    eq(r1.versao, 1, "D1: versão incrementa para 1 depois da 1ª gravação real em Postgres");
    const linhasAposD = await prisma.linhaEncomenda.findMany({ where: { listaEncomendaId: rascunho.id } });
    eq(linhasAposD.length, 2, "D2: agora existem 2 linhas reais na base (upsert real, não simulado)");

    console.log("\nE · rejeitar uma versão desactualizada (#5)");
    let apanhouConflito = false;
    try {
      await salvarAutosaveEncomenda(prisma, {
        listaEncomendaId: rascunho.id,
        versaoEsperada: 0, // já é 1 — desactualizada de propósito
        linhas: [{ produtoId: produtoA.id, quantidadeAjustada: 999 }],
      });
    } catch (err) {
      apanhouConflito = err instanceof ConflitoVersaoError;
    }
    check(apanhouConflito, "E1: ConflitoVersaoError lançado por Postgres real, não só pelo mock");
    const linhaA = await prisma.linhaEncomenda.findFirst({ where: { listaEncomendaId: rascunho.id, produtoId: produtoA.id } });
    eq(linhaA?.quantidadeAjustada?.toString(), "3", "E2: a tentativa recusada não escreveu 999 — valor original (3) intacto");

    console.log("\nF · estado lógico pré-existente não foi corrompido pela migration (#6)");
    const releituraPreExistente = await prisma.listaEncomenda.findUniqueOrThrow({
      where: { id: listaPreExistente.id },
      include: { linhas: true },
    });
    eq(releituraPreExistente.versao, 0, "F1: lista pré-existente continua com versao=0 (nunca tocada por esta migration)");
    eq(releituraPreExistente.contextoJson, null, "F2: lista pré-existente continua com contextoJson=NULL");
    eq(releituraPreExistente.estado, "FINALIZADA", "F3: estado da lista pré-existente intacto");
    eq(releituraPreExistente.linhas.length, 1, "F4: linha pré-existente não duplicada nem perdida");
    eq(releituraPreExistente.linhas[0]?.quantidadeAjustada?.toString(), "7", "F5: quantidade da linha pré-existente intacta");
  } finally {
    // Cleanup — deixa a base descartável limpa para uma próxima corrida,
    // mas nunca apaga o container em si (isso é responsabilidade de quem
    // o criou via `docker run`/`docker rm`, fora deste script).
    await prisma.linhaEncomenda.deleteMany({});
    await prisma.orderOutbox.deleteMany({});
    await prisma.listaEncomenda.deleteMany({});
    await prisma.produto.deleteMany({});
    await prisma.utilizador.deleteMany({});
    await prisma.farmacia.deleteMany({});
    await prisma.$disconnect();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

principal();
