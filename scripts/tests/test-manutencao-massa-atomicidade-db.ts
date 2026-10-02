/**
 * scripts/tests/test-manutencao-massa-atomicidade-db.ts
 *
 * ~36 000 produtos num PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55494/postgres npx tsx scripts/tests/test-manutencao-massa-atomicidade-db.ts
 *
 * Prova que a aplicação (e a reversão) em massa continuam ATÓMICAS depois de passarem a
 * instruções set-based, mesmo com dezenas de milhares de alvos:
 *
 *   S  sucesso: 36 000 FABRICANTE e 2×36 000 FORNECEDOR aplicados, auditados 1:1 e revertidos,
 *      com `dataAtualizacao` actualizada (o `@updatedAt` do Prisma não corre em SQL directo);
 *   F  FALHA A MEIO — injectada com um trigger de teste na base descartável:
 *        F1  durante o UPDATE do 2.º grupo de valores anteriores;
 *        F2  durante a inserção da auditoria (já com os UPDATEs feitos);
 *        F3  FORNECEDOR: na 2.ª farmácia, depois de a 1.ª já estar alterada;
 *        F4  na REVERSÃO (nada fica meio revertido);
 *      em todos: zero produtos alterados, zero operações, zero itens de auditoria órfãos e
 *      nenhum Fabricante/Fornecedor «novo» criado a meio;
 *   L  tecto de alvos por operação.
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
const urlDe = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};
const N = Number(process.env.ATOM_N ?? 36_000);

async function main() {
  const db = `spharm_atom_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const pg = new Client({ connectionString: urlDe(db) });
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    await pg.connect();
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const M2 = await import("../../lib/catalogo/manutencao-massa");

    const user = await prisma.utilizador.create({ data: { email: "atom@t.pt", nome: "Atom", perfil: "ADMINISTRADOR" } });
    const fA = await prisma.farmacia.create({ data: { nome: "Atom Silveirense" } });
    const fB = await prisma.farmacia.create({ data: { nome: "Atom Segurado" } });
    const [fab1, fab2, fabDest] = await Promise.all(["ATOM FAB 1", "ATOM FAB 2", "ATOM FAB DESTINO"].map((n) => prisma.fabricante.create({ data: { nomeNormalizado: n, estado: "ATIVO" } })));
    const [for1, for2, forDest] = await Promise.all(["ATOM FORN 1", "ATOM FORN 2", "ATOM FORN DESTINO"].map((n) => prisma.fornecedor.create({ data: { nomeNormalizado: n, nome: n, estado: "ATIVO" } })));
    const cat = await prisma.classificacao.create({ data: { nome: "Atom Cat", tipo: "NIVEL_1" } });

    // Semente por SQL set-based (muito mais rápida do que createMany). Produtos pares → fab1, ímpares → fab2.
    const tSeed = Date.now();
    await pg.query(
      `INSERT INTO "Produto" (id, cnp, designacao, estado, "classificacaoNivel1Id", "fabricanteId", "dataAtualizacao")
       SELECT 'atom-p-' || g, 8000000 + g, 'Atom ' || g, 'VALIDADO', $1, CASE WHEN g % 2 = 0 THEN $2 ELSE $3 END, now()
       FROM generate_series(0, $4::int - 1) g`,
      [cat.id, fab1.id, fab2.id, N]
    );
    await pg.query(
      `INSERT INTO "ProdutoFarmacia" (id, "produtoId", "farmaciaId", "fornecedorHabitualId", "dataAtualizacao")
       SELECT 'atom-pf-' || f.n || '-' || g, 'atom-p-' || g, f.id, CASE WHEN g % 2 = 0 THEN $3 ELSE $4 END, now() - interval '1 day'
       FROM generate_series(0, $5::int - 1) g, (VALUES (1, $1::text), (2, $2::text)) AS f(n, id)`,
      [fA.id, fB.id, for1.id, for2.id, N]
    );
    await pg.query('ANALYZE "Produto"');
    await pg.query('ANALYZE "ProdutoFarmacia"');
    console.log(`  semente: ${N} produtos e ${2 * N} ProdutoFarmacia em ${Date.now() - tSeed} ms`);

    const filtroF = { categorias: [cat.nome] };
    const filtroP = { categorias: [cat.nome], farmaciaIds: [fA.id, fB.id] };

    const q = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows;
    const estadoFab = async () => JSON.stringify(await q(`SELECT "fabricanteId" AS v, count(*)::int AS n FROM "Produto" GROUP BY 1 ORDER BY 1 NULLS FIRST`));
    const estadoForn = async () => JSON.stringify(await q(`SELECT "farmaciaId" AS f, "fornecedorHabitualId" AS v, count(*)::int AS n FROM "ProdutoFarmacia" GROUP BY 1, 2 ORDER BY 1, 2`));
    const contagens = async () => {
      const [r] = await q(`SELECT (SELECT count(*)::int FROM "CatalogoManutencaoOperacao") AS ops, (SELECT count(*)::int FROM "CatalogoManutencaoOperacaoItem") AS itens, (SELECT count(*)::int FROM "Fabricante") AS fabs, (SELECT count(*)::int FROM "Fornecedor") AS forns`);
      return r as { ops: number; itens: number; fabs: number; forns: number };
    };

    // ═══ S · sucesso ═══════════════════════════════════════════════════════
    console.log(`\nS · sucesso em grande escala (${N} produtos; ${2 * N} pares produto×farmácia)`);
    const pvF = await M2.previewOperacao(prisma, "FABRICANTE", filtroF, { modo: "existente", id: fabDest.id }, { modo: "todos" });
    if (!pvF.ok) throw new Error("setup S preview F");
    const aF = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: filtroF, destino: { modo: "existente", id: fabDest.id }, selecao: { modo: "todos" }, snapshotHash: pvF.snapshotHash, utilizadorId: user.id });
    check(aF.ok && aF.quantidadeAlterada === N, `S1: FABRICANTE — ${N} produtos alterados`, JSON.stringify(aF).slice(0, 200));
    if (!aF.ok) throw new Error("setup S apply F");
    console.log(`        tempos: ${JSON.stringify(aF.tempos)}`);
    check(aF.tempos.transacaoMs < 120_000 && aF.tempos.totalMs < 120_000, `S2: dentro do limite da transacção (120 s): ${aF.tempos.transacaoMs} ms`);
    const [cF] = await q(`SELECT count(*)::int AS n FROM "Produto" WHERE "fabricanteId" = $1`, [fabDest.id]);
    check(cF.n === N, "S3: todos têm o destino");
    const [itF] = await q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE "valorNovoId" = $2)::int AS dest, count(*) FILTER (WHERE "valorAnteriorId" IN ($3, $4))::int AS ant FROM "CatalogoManutencaoOperacaoItem" WHERE "operacaoId" = $1`, [aF.operacaoId, fabDest.id, fab1.id, fab2.id]);
    check(itF.n === N && itF.dest === N && itF.ant === N, "S4: auditoria completa e exacta (1 item por produto, com o valor anterior e o novo)");
    const [recent] = await q(`SELECT count(*)::int AS n FROM "Produto" WHERE "dataAtualizacao" > now() - interval '10 minutes' AND "fabricanteId" = $1`, [fabDest.id]);
    check(recent.n === N, "S5: Produto.dataAtualizacao foi actualizada (replica o @updatedAt)");
    const rF = await M2.reverterOperacao(prisma, aF.operacaoId, user.id);
    check(rF.ok && rF.revertidos === N, "S6: reversão repõe os 36 000", JSON.stringify(rF).slice(0, 160));
    const [par] = await q(`SELECT count(*) FILTER (WHERE "fabricanteId" = $1 AND substring(id from 8)::int % 2 = 0)::int AS a, count(*) FILTER (WHERE "fabricanteId" = $2 AND substring(id from 8)::int % 2 = 1)::int AS b FROM "Produto"`, [fab1.id, fab2.id]);
    check(par.a + par.b === N, "S7: cada produto voltou ao SEU fabricante anterior (não a um valor único)");

    const pvP = await M2.previewOperacao(prisma, "FORNECEDOR", filtroP, { modo: "existente", id: forDest.id }, { modo: "todos" });
    if (!pvP.ok) throw new Error("setup S preview P");
    const aP = await M2.aplicarManutencaoMassa(prisma, { tipo: "FORNECEDOR", filtro: filtroP, destino: { modo: "existente", id: forDest.id }, selecao: { modo: "todos" }, snapshotHash: pvP.snapshotHash, utilizadorId: user.id });
    check(aP.ok && aP.quantidadeAlterada === 2 * N && aP.operacoes.length === 2, `S8: FORNECEDOR — ${2 * N} pares em 2 operações (uma por farmácia)`, JSON.stringify(aP).slice(0, 200));
    if (!aP.ok) throw new Error("setup S apply P");
    console.log(`        tempos: ${JSON.stringify(aP.tempos)}`);
    check(aP.tempos.transacaoMs < 120_000, `S9: dentro do limite da transacção: ${aP.tempos.transacaoMs} ms`);
    const [pfDest] = await q(`SELECT count(*)::int AS n FROM "ProdutoFarmacia" WHERE "fornecedorHabitualId" = $1`, [forDest.id]);
    const [pfRec] = await q(`SELECT count(*)::int AS n FROM "ProdutoFarmacia" WHERE "fornecedorHabitualId" = $1 AND "dataAtualizacao" > now() - interval '10 minutes'`, [forDest.id]);
    check(pfDest.n === 2 * N && pfRec.n === 2 * N, "S10: todos os pares têm o destino e ProdutoFarmacia.dataAtualizacao foi actualizada");
    for (const o of aP.operacoes) {
      const r = await M2.reverterOperacao(prisma, o.operacaoId, user.id);
      check(r.ok && r.revertidos === N, `S11: reversão da operação de uma farmácia (${N})`);
    }
    check((await estadoForn()) === JSON.stringify(await q(`SELECT "farmaciaId" AS f, "fornecedorHabitualId" AS v, count(*)::int AS n FROM "ProdutoFarmacia" GROUP BY 1, 2 ORDER BY 1, 2`)) && (await q(`SELECT count(*)::int AS n FROM "ProdutoFarmacia" WHERE "fornecedorHabitualId" = $1`, [forDest.id]))[0].n === 0, "S12: nenhum par ficou com o destino");

    // ═══ F · falha a meio ═══════════════════════════════════════════════════
    console.log("\nF · falha injectada a meio — zero alterações, zero auditoria órfã");
    const antesFab = await estadoFab();
    const antesForn = await estadoForn();
    const antesCont = await contagens();
    const novoNome = "Atom Fabricante Novo";

    // F1 — o UPDATE falha para um produto de cada grupo; um dos dois grupos corre primeiro e já escreveu.
    await pg.query(`CREATE OR REPLACE FUNCTION atom_falha_produto() RETURNS trigger AS $$ BEGIN IF NEW.cnp = 8000010 OR NEW.cnp = 8000011 THEN RAISE EXCEPTION 'falha injectada (Produto)'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pg.query(`CREATE TRIGGER atom_falha_produto BEFORE UPDATE OF "fabricanteId" ON "Produto" FOR EACH ROW EXECUTE FUNCTION atom_falha_produto()`);
    for (const rotulo of ["F1a", "F1b"]) {
      // só um dos dois cnp falha de cada vez, para que a falha caia ora no 1.º ora no 2.º grupo de valores anteriores
      await pg.query(`CREATE OR REPLACE FUNCTION atom_falha_produto() RETURNS trigger AS $$ BEGIN IF NEW.cnp = ${rotulo === "F1a" ? 8000010 : 8000011} THEN RAISE EXCEPTION 'falha injectada (Produto)'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      const pv = await M2.previewOperacao(prisma, "FABRICANTE", filtroF, { modo: "novo", nome: novoNome }, { modo: "todos" });
      if (!pv.ok) throw new Error("setup F1 preview");
      const r = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: filtroF, destino: { modo: "novo", nome: novoNome }, selecao: { modo: "todos" }, snapshotHash: pv.snapshotHash, utilizadorId: user.id });
      check(!r.ok && /nada foi alterado/.test(r.error) && !/Invalid|prisma/i.test(r.error), `${rotulo}: a operação falha com mensagem limpa («${r.ok ? "?" : r.error}»)`);
      check((await estadoFab()) === antesFab, `${rotulo}: ZERO produtos alterados (distribuição de fabricantes idêntica)`);
      const c = await contagens();
      check(c.ops === antesCont.ops && c.itens === antesCont.itens, `${rotulo}: zero operações e zero itens de auditoria órfãos`);
      check(c.fabs === antesCont.fabs, `${rotulo}: o Fabricante «novo» criado a meio foi revertido (não ficou órfão)`);
    }
    await pg.query(`DROP TRIGGER atom_falha_produto ON "Produto"`);

    // F2 — falha na auditoria, depois de todos os UPDATEs já terem corrido
    await pg.query(`CREATE OR REPLACE FUNCTION atom_falha_item() RETURNS trigger AS $$ BEGIN IF NEW."produtoId" = 'atom-p-' || ${N - 1} THEN RAISE EXCEPTION 'falha injectada (auditoria)'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pg.query(`CREATE TRIGGER atom_falha_item BEFORE INSERT ON "CatalogoManutencaoOperacaoItem" FOR EACH ROW EXECUTE FUNCTION atom_falha_item()`);
    {
      const pv = await M2.previewOperacao(prisma, "FABRICANTE", filtroF, { modo: "novo", nome: novoNome }, { modo: "todos" });
      if (!pv.ok) throw new Error("setup F2 preview");
      const r = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: filtroF, destino: { modo: "novo", nome: novoNome }, selecao: { modo: "todos" }, snapshotHash: pv.snapshotHash, utilizadorId: user.id });
      check(!r.ok, "F2: a operação falha na auditoria");
      check((await estadoFab()) === antesFab, "F2: ZERO produtos alterados — os UPDATEs já feitos foram revertidos");
      const c = await contagens();
      check(c.ops === antesCont.ops && c.itens === antesCont.itens && c.fabs === antesCont.fabs, "F2: zero operações, zero itens, zero fabricantes criados");
    }

    // F3 — FORNECEDOR: falha na 2.ª farmácia; a 1.ª já estava alterada e auditada
    await pg.query(`CREATE OR REPLACE FUNCTION atom_falha_pf() RETURNS trigger AS $$ BEGIN IF NEW."farmaciaId" = '${fB.id}' AND NEW."produtoId" = 'atom-p-5' THEN RAISE EXCEPTION 'falha injectada (ProdutoFarmacia)'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pg.query(`CREATE TRIGGER atom_falha_pf BEFORE UPDATE OF "fornecedorHabitualId" ON "ProdutoFarmacia" FOR EACH ROW EXECUTE FUNCTION atom_falha_pf()`);
    {
      const pv = await M2.previewOperacao(prisma, "FORNECEDOR", filtroP, { modo: "novo", nome: "Atom Fornecedor Novo" }, { modo: "todos" });
      if (!pv.ok) throw new Error("setup F3 preview");
      const r = await M2.aplicarManutencaoMassa(prisma, { tipo: "FORNECEDOR", filtro: filtroP, destino: { modo: "novo", nome: "Atom Fornecedor Novo" }, selecao: { modo: "todos" }, snapshotHash: pv.snapshotHash, utilizadorId: user.id });
      check(!r.ok, "F3: a operação falha na 2.ª farmácia");
      check((await estadoForn()) === antesForn, "F3: ZERO pares alterados em AMBAS as farmácias (a 1.ª, já alterada, foi revertida)");
      const c = await contagens();
      check(c.ops === antesCont.ops && c.itens === antesCont.itens && c.forns === antesCont.forns, "F3: zero operações, zero itens, nenhum Fornecedor «novo» órfão");
    }
    await pg.query(`DROP TRIGGER atom_falha_pf ON "ProdutoFarmacia"`);
    await pg.query(`DROP TRIGGER atom_falha_item ON "CatalogoManutencaoOperacaoItem"`);

    // F4 — reversão que falha a meio não deixa nada meio revertido
    {
      const pv = await M2.previewOperacao(prisma, "FABRICANTE", filtroF, { modo: "existente", id: fabDest.id }, { modo: "todos" });
      if (!pv.ok) throw new Error("setup F4 preview");
      const ap = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: filtroF, destino: { modo: "existente", id: fabDest.id }, selecao: { modo: "todos" }, snapshotHash: pv.snapshotHash, utilizadorId: user.id });
      if (!ap.ok) throw new Error("setup F4 apply");
      const depoisAplicar = await estadoFab();
      const contAp = await contagens();
      await pg.query(`CREATE OR REPLACE FUNCTION atom_falha_produto() RETURNS trigger AS $$ BEGIN IF NEW.cnp = 8000011 THEN RAISE EXCEPTION 'falha injectada (reversão)'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await pg.query(`CREATE TRIGGER atom_falha_produto BEFORE UPDATE OF "fabricanteId" ON "Produto" FOR EACH ROW EXECUTE FUNCTION atom_falha_produto()`);
      const rv = await M2.reverterOperacao(prisma, ap.operacaoId, user.id);
      check(!rv.ok, "F4: a reversão falha a meio");
      check((await estadoFab()) === depoisAplicar, "F4: nada ficou meio revertido (continua tudo no estado aplicado)");
      const c = await contagens();
      check(c.ops === contAp.ops && c.itens === contAp.itens, "F4: nenhuma operação de reversão nem itens órfãos");
      await pg.query(`DROP TRIGGER atom_falha_produto ON "Produto"`);
      const rv2 = await M2.reverterOperacao(prisma, ap.operacaoId, user.id);
      check(rv2.ok && rv2.revertidos === N && (await estadoFab()) === antesFab, "F4: sem a falha, a reversão completa-se e repõe o estado inicial exacto");
    }

    // ═══ L · tecto ═══════════════════════════════════════════════════════════
    console.log("\nL · tecto de alvos por operação");
    check(M2.LIMITE_ALVOS_POR_OPERACAO === 150_000, "L1: o tecto está definido (150 000)");
    // L2 — acima do tecto: preview e apply recusam, com mensagem clara, sem escrever nada.
    const catL = await prisma.classificacao.create({ data: { nome: "Atom Cat Limite", tipo: "NIVEL_1" } });
    await pg.query(
      `INSERT INTO "Produto" (id, cnp, designacao, estado, "classificacaoNivel1Id", "dataAtualizacao")
       SELECT 'atom-l-' || g, 20000000 + g, 'Atom L ' || g, 'VALIDADO', $1, now() FROM generate_series(0, $2::int) g`,
      [catL.id, M2.LIMITE_ALVOS_POR_OPERACAO] // LIMITE + 1 produtos
    );
    const estadoAntesL = await estadoFab();
    const contAntesL = await contagens();
    const pvL = await M2.previewOperacao(prisma, "FABRICANTE", { categorias: [catL.nome] }, { modo: "existente", id: fabDest.id }, { modo: "todos" });
    check(!pvL.ok && /150.000|150 000|150000/.test(pvL.error) && /Restrinja os filtros/.test(pvL.error), `L2: preview acima do tecto é recusado — «${pvL.ok ? "?" : pvL.error}»`);
    const apL = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: { categorias: [catL.nome] }, destino: { modo: "existente", id: fabDest.id }, selecao: { modo: "todos" }, snapshotHash: "irrelevante", utilizadorId: user.id });
    check(!apL.ok && /Restrinja os filtros/.test(apL.error), "L3: o apply acima do tecto também é recusado");
    check((await estadoFab()) === estadoAntesL && JSON.stringify(await contagens()) === JSON.stringify(contAntesL), "L4: nada foi escrito (nem produtos, nem operações, nem auditoria)");
    const pvDentro = await M2.previewOperacao(prisma, "FABRICANTE", filtroF, { modo: "existente", id: fabDest.id }, { modo: "todos" });
    check(pvDentro.ok, "L5: dentro do tecto (36 000) o preview continua a funcionar");

    await prisma.$disconnect();
  } finally {
    await pg.end().catch(() => undefined);
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
