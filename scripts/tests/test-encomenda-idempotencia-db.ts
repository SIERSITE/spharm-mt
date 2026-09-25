/**
 * scripts/tests/test-encomenda-idempotencia-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL — nunca uma base verdadeira.
 *
 *   docker run -d --name spharm-ws-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:encomenda-idempotencia-db
 *
 * Guarda de segurança: recusa correr se o host não for localhost/127.0.0.1.
 * Cria bases temporárias (spharm_idem_*) e apaga-as no fim.
 *
 * Cobre: migrations desde base vazia (via `prisma migrate deploy`), a coluna/índice
 * da migration nova, migração incremental com dados pré-existentes, idempotência
 * (mesmo pedido / pedido diferente / outro utilizador ou farmácia), optimistic
 * locking do autosave e a consolidação transaccional (3 farmácias).
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}
async function rejeita(fn: () => Promise<unknown>, teste: (e: unknown) => boolean = () => true): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return teste(e); }
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

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const NOVA = "20260925140000_lista_encomenda_client_idempotency_key";

async function main() {
  const sufixo = Date.now().toString(36);
  const dbCompleta = `spharm_idem_${sufixo}`;
  const dbIncremental = `spharm_idem_inc_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbCompleta}`);
  await admin.query(`CREATE DATABASE ${dbIncremental}`);

  try {
    // ── 1 · migrations desde uma base vazia ─────────────────────────
    console.log("\nA · migrations desde base vazia (prisma migrate deploy)");
    const out = execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: urlDe(dbCompleta) },
      encoding: "utf8",
    });
    const nMig = readdirSync(MIGRATIONS).filter((d) => !d.includes(".")).length;
    check(/successfully applied/i.test(out), `A1: ${nMig} migrations aplicadas sem erro numa base vazia`);

    const db = new Client({ connectionString: urlDe(dbCompleta) });
    await db.connect();

    // ── 2-3 · coluna nullable + índice único ────────────────────────
    console.log("\nB · estrutura da migration nova");
    const col = await db.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name='ListaEncomenda' AND column_name IN ('clientIdempotencyKey','clientRequestHash')`
    );
    check(col.rowCount === 2 && col.rows.every((r) => r.is_nullable === "YES"), "B1: clientIdempotencyKey e clientRequestHash existem e são nullable");
    const idx = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename='ListaEncomenda' AND indexname='ListaEncomenda_clientIdempotencyKey_key'`
    );
    check(idx.rowCount === 1 && /UNIQUE/i.test(idx.rows[0].indexdef), "B2: índice UNIQUE em clientIdempotencyKey");

    // ── Dados base ──────────────────────────────────────────────────
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbCompleta) }) });
    const { createEncomendaWithOutbox, createConsolidatedOrdersWithOutbox, IdempotencyConflictError } =
      await import("../../lib/ingest/orders");
    const { salvarAutosaveEncomenda, ConflitoVersaoError } = await import("../../lib/encomendas/autosave");

    const farms: Array<{ id: string }> = [];
    for (const n of ["F1", "F2", "F3"]) farms.push(await prisma.farmacia.create({ data: { nome: n } }));
    const u1 = await prisma.utilizador.create({ data: { email: "u1@t.pt", nome: "U1", perfil: "ADMINISTRADOR" } });
    const u2 = await prisma.utilizador.create({ data: { email: "u2@t.pt", nome: "U2", perfil: "ADMINISTRADOR" } });
    const prods: Array<{ id: string }> = [];
    for (let i = 1; i <= 3; i++) prods.push(await prisma.produto.create({ data: { cnp: 1000 + i, designacao: `P${i}` } }));
    const [p1, p2, p3] = prods;

    const base = (over: Record<string, unknown> = {}) => ({
      farmaciaId: farms[0].id, criadoPorId: u1.id, nome: "Enc", finalize: false,
      linhas: [
        { produtoId: p1.id, quantidadeAjustada: 5, origem: "PROPOSTA" as const },
        { produtoId: p2.id, quantidadeAjustada: 2, notas: "x", origem: "MANUAL" as const },
      ],
      contexto: '{"version":1}',
      ...over,
    });

    // ── 4-5 · NULLs múltiplos vs. chaves duplicadas ─────────────────
    console.log("\nC · unicidade");
    await createEncomendaWithOutbox(prisma, "t", base());
    await createEncomendaWithOutbox(prisma, "t", base());
    const nulls = await db.query(`SELECT count(*)::int AS n FROM "ListaEncomenda" WHERE "clientIdempotencyKey" IS NULL`);
    check(nulls.rows[0].n === 2, "C1: vários registos com clientIdempotencyKey NULL coexistem");
    const dupSql = await rejeita(() =>
      db.query(`UPDATE "ListaEncomenda" SET "clientIdempotencyKey"='dup' WHERE "clientIdempotencyKey" IS NULL`)
    );
    check(dupSql, "C2: duas chaves iguais são rejeitadas pelo índice único");

    // ── 6-8 · idempotência ──────────────────────────────────────────
    console.log("\nD · idempotência (rascunho individual)");
    const k1 = "k1".repeat(12);
    const a = await createEncomendaWithOutbox(prisma, "t", base({ clientIdempotencyKey: k1 }));
    const b = await createEncomendaWithOutbox(prisma, "t", base({ clientIdempotencyKey: k1 }));
    check(a.listaEncomendaId === b.listaEncomendaId, "D1: mesma chave + mesmo pedido devolve o mesmo rascunho");
    const conta = await prisma.listaEncomenda.count({ where: { clientIdempotencyKey: k1 } });
    check(conta === 1, "D2: continua a existir uma só lista com essa chave");
    const linhasDif = base({
      clientIdempotencyKey: k1,
      linhas: [{ produtoId: p1.id, quantidadeAjustada: 9, origem: "PROPOSTA" as const }],
    });
    check(
      await rejeita(() => createEncomendaWithOutbox(prisma, "t", linhasDif), (e) => e instanceof IdempotencyConflictError),
      "D3: mesma chave + linhas diferentes → IdempotencyConflictError"
    );
    check(
      await rejeita(() => createEncomendaWithOutbox(prisma, "t", base({ clientIdempotencyKey: k1, nome: "Outro" })), (e) => e instanceof IdempotencyConflictError),
      "D4: mesma chave + nome diferente → conflito"
    );
    check(
      await rejeita(() => createEncomendaWithOutbox(prisma, "t", base({ clientIdempotencyKey: k1, contexto: '{"version":2}' })), (e) => e instanceof IdempotencyConflictError),
      "D5: mesma chave + contexto diferente → conflito"
    );
    check(
      await rejeita(() => createEncomendaWithOutbox(prisma, "t", base({ clientIdempotencyKey: k1, criadoPorId: u2.id })), (e) => e instanceof IdempotencyConflictError),
      "D6: mesma chave + outro utilizador → conflito"
    );
    check(
      await rejeita(() => createEncomendaWithOutbox(prisma, "t", base({ clientIdempotencyKey: k1, farmaciaId: farms[1].id })), (e) => e instanceof IdempotencyConflictError),
      "D7: mesma chave + outra farmácia → conflito"
    );
    const ordemDif = base({ clientIdempotencyKey: k1, linhas: [...base().linhas].reverse() });
    const c = await createEncomendaWithOutbox(prisma, "t", ordemDif);
    check(c.listaEncomendaId === a.listaEncomendaId, "D8: a ordem das linhas não altera a impressão digital");
    const semConflitoApp = await prisma.listaEncomenda.findUnique({ where: { id: a.listaEncomendaId }, include: { linhas: true } });
    check(semConflitoApp?.linhas.length === 2 && semConflitoApp.linhas.find((l) => l.produtoId === p1.id)?.quantidadeAjustada?.toString() === "5",
      "D9: os conflitos não alteraram o rascunho original");

    // corrida real: 8 pedidos simultâneos, mesma chave
    const kRace = "race".repeat(6);
    const rs = await Promise.all(Array.from({ length: 8 }, () => createEncomendaWithOutbox(prisma, "t", base({ clientIdempotencyKey: kRace }))));
    check(new Set(rs.map((r) => r.listaEncomendaId)).size === 1, "D10: 8 pedidos concorrentes com a mesma chave → 1 só rascunho");
    check((await prisma.listaEncomenda.count({ where: { clientIdempotencyKey: kRace } })) === 1, "D11: 1 linha na BD");

    // ── 9 · optimistic locking ──────────────────────────────────────
    console.log("\nE · optimistic locking do autosave");
    const s1 = await salvarAutosaveEncomenda(prisma, { listaEncomendaId: a.listaEncomendaId, versaoEsperada: 0, linhas: [{ produtoId: p1.id, quantidadeAjustada: 7 }] });
    check(s1.versao === 1, "E1: autosave com versão certa avança a versão");
    check(
      await rejeita(() => salvarAutosaveEncomenda(prisma, { listaEncomendaId: a.listaEncomendaId, versaoEsperada: 0, linhas: [{ produtoId: p1.id, quantidadeAjustada: 8 }] }), (e) => e instanceof ConflitoVersaoError),
      "E2: versão desactualizada → ConflitoVersaoError"
    );
    const rep = await createEncomendaWithOutbox(prisma, "t", base({ clientIdempotencyKey: k1 }));
    check(rep.listaEncomendaId === a.listaEncomendaId, "E3: recuperar o rascunho por retry continua a funcionar depois de o autosave o ter editado (hash é do pedido de CRIAÇÃO)");

    // ── Consolidação ────────────────────────────────────────────────
    console.log("\nF · consolidação transaccional (3 farmácias)");
    const lotes = (qtd = 3) => farms.map((f, i) => ({
      farmaciaId: f.id,
      linhas: [
        { produtoId: p1.id, quantidadeAjustada: qtd + i, origem: "PROPOSTA" as const },
        { produtoId: p3.id, quantidadeAjustada: 1, notas: `n${i}`, origem: "MANUAL" as const },
      ],
    }));
    const cons = (over: Record<string, unknown> = {}) => ({
      batchKey: "batch".repeat(5), criadoPorId: u1.id, nome: "Cons", finalize: true, contexto: '{"version":1,"mode":"consolidacao"}', lotes: lotes(), ...over,
    });
    const nListas = async () => prisma.listaEncomenda.count({ where: { nome: { startsWith: "Cons" } } });
    const nOutbox = async () => prisma.orderOutbox.count({ where: { listaEncomenda: { nome: { startsWith: "Cons" } } } });

    // falha na 2.ª farmácia (produto inexistente) → rollback das 3
    const comFalha = cons({
      lotes: lotes().map((l, i) => i === 1 ? { ...l, linhas: [{ produtoId: "produto-inexistente", quantidadeAjustada: 1 }] } : l),
    });
    check(await rejeita(() => createConsolidatedOrdersWithOutbox(prisma, "t", comFalha)), "F1: falha na 2.ª farmácia rejeita o lote");
    check((await nListas()) === 0 && (await nOutbox()) === 0, "F2: rollback das 3 farmácias — nenhuma lista nem outbox gravada");

    // retry após rollback cria as três
    const r1 = await createConsolidatedOrdersWithOutbox(prisma, "t", cons());
    check(r1.listas.length === 3 && !r1.reutilizado, "F3: depois do rollback, o retry cria as 3");
    check((await nListas()) === 3 && (await nOutbox()) === 3, "F4: 3 listas e 3 outbox (finalize) — sem parciais");
    const todas = await prisma.listaEncomenda.findMany({ where: { nome: { startsWith: "Cons" } }, include: { linhas: true }, orderBy: { farmaciaId: "asc" } });
    const esperado = lotes();
    const ok = esperado.every((lote) => {
      const l = todas.find((x) => x.farmaciaId === lote.farmaciaId);
      return !!l && l.linhas.length === 2 && lote.linhas.every((el) => {
        const g = l.linhas.find((x) => x.produtoId === el.produtoId);
        return !!g && Number(g.quantidadeAjustada) === el.quantidadeAjustada && (g.notas ?? null) === (el.notas ?? null);
      });
    });
    check(ok, "F5: todas as linhas gravadas correspondem ao payload actual");
    check(todas.every((l) => l.contextoJson === '{"version":1,"mode":"consolidacao"}'), "F6: contexto persistido em todas");

    // retry igual
    const idsAntes = todas.map((l) => `${l.id}:${l.versao}`).sort();
    const r2 = await createConsolidatedOrdersWithOutbox(prisma, "t", cons());
    const depois = await prisma.listaEncomenda.findMany({ where: { nome: { startsWith: "Cons" } } });
    check(r2.reutilizado && (await nListas()) === 3 && (await nOutbox()) === 3, "F7: retry igual não duplica (listas nem outbox)");
    check(JSON.stringify(depois.map((l) => `${l.id}:${l.versao}`).sort()) === JSON.stringify(idsAntes) &&
      r2.listas.every((l) => todas.some((t) => t.id === l.listaEncomendaId)), "F8: IDs e versões mantêm-se");

    // payload diferente, mesma chave
    check(
      await rejeita(() => createConsolidatedOrdersWithOutbox(prisma, "t", cons({ lotes: lotes(99) })), (e) => e instanceof IdempotencyConflictError),
      "F9: payload diferente com a mesma chave é rejeitado (conflito explícito)"
    );
    check((await nListas()) === 3, "F10: o conflito não alterou nem acrescentou nada");
    check(
      await rejeita(() => createConsolidatedOrdersWithOutbox(prisma, "t", cons({ criadoPorId: u2.id })), (e) => e instanceof IdempotencyConflictError),
      "F11: mesma chave de lote noutro utilizador é rejeitada"
    );
    check(
      await rejeita(() => createConsolidatedOrdersWithOutbox(prisma, "t", cons({ lotes: lotes().slice(0, 2) })), (e) => e instanceof IdempotencyConflictError),
      "F12: mesmo lote com menos farmácias sob a mesma chave é rejeitado"
    );
    check((await nListas()) === 3 && (await nOutbox()) === 3, "F13: nada mudou depois das rejeições");

    // chave diferente → nova consolidação com as edições
    const r3 = await createConsolidatedOrdersWithOutbox(prisma, "t", cons({ batchKey: "batch2".repeat(4), lotes: lotes(99) }));
    check(!r3.reutilizado && (await nListas()) === 6, "F14: chave diferente permite nova consolidação");
    const nova = await prisma.listaEncomenda.findMany({ where: { id: { in: r3.listas.map((l) => l.listaEncomendaId) } }, include: { linhas: true } });
    check(nova.every((l) => l.linhas.some((x) => x.produtoId === p1.id && Number(x.quantidadeAjustada) >= 99)), "F15: a operação nova reflecte as edições (nunca o payload antigo)");

    // lote misto: 1 farmácia já existente sob a chave, as outras novas → rejeita e faz rollback
    const kMisto = "misto".repeat(5);
    await createConsolidatedOrdersWithOutbox(prisma, "t", cons({ batchKey: kMisto, lotes: lotes().slice(0, 1), nome: "Cons-misto" }));
    check(
      await rejeita(() => createConsolidatedOrdersWithOutbox(prisma, "t", cons({ batchKey: kMisto, nome: "Cons-misto" })), (e) => e instanceof IdempotencyConflictError),
      "F16: lote parcialmente existente sob a mesma chave nunca é aceite como sucesso"
    );
    check((await prisma.listaEncomenda.count({ where: { nome: "Cons-misto" } })) === 1, "F17: e o rollback deixa só a lista pré-existente");

    await prisma.$disconnect();
    await db.end();

    // ── 10 · migrations anteriores + incremental com dados pré-existentes ─────
    console.log("\nG · migração incremental com dados pré-existentes");
    const dirs = readdirSync(MIGRATIONS).filter((d) => !d.includes(".")).sort();
    const idxNova = dirs.indexOf(NOVA);
    check(idxNova === dirs.length - 1 || idxNova >= 0, "G0: a migration nova existe");
    const inc = new Client({ connectionString: urlDe(dbIncremental) });
    await inc.connect();
    for (const d of dirs.slice(0, idxNova)) {
      await inc.query(readFileSync(join(MIGRATIONS, d, "migration.sql"), "utf8"));
    }
    check(true, `G1: as ${idxNova} migrations anteriores aplicam-se em sequência`);
    const cols = await inc.query(`SELECT 1 FROM information_schema.columns WHERE table_name='ListaEncomenda' AND column_name='clientIdempotencyKey'`);
    check(cols.rowCount === 0, "G2: antes da migration nova a coluna não existe");
    await inc.query(`INSERT INTO "Farmacia"(id,nome,"dataAtualizacao") VALUES ('f1','FF',now())`);
    await inc.query(`INSERT INTO "Utilizador"(id,email,nome,perfil,"dataAtualizacao") VALUES ('u1','x@y.pt','X','ADMINISTRADOR',now())`);
    await inc.query(`INSERT INTO "ListaEncomenda"(id,"farmaciaId","criadoPorId",nome,"dataAtualizacao") VALUES ('l1','f1','u1','antiga',now())`);
    await inc.query(readFileSync(join(MIGRATIONS, NOVA, "migration.sql"), "utf8"));
    const antiga = await inc.query(`SELECT "clientIdempotencyKey" k, "clientRequestHash" h FROM "ListaEncomenda" WHERE id='l1'`);
    check(antiga.rows[0].k === null && antiga.rows[0].h === null, "G3: lista pré-existente fica com NULL/NULL após a migration");
    await inc.end();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbCompleta} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${dbIncremental} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
