/**
 * scripts/tests/test-catalogo-massa-silveira-ingest-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL — nunca uma base verdadeira.
 *
 *   docker run -d --name spharm-ws-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55432/postgres npx tsx scripts/tests/test-catalogo-massa-silveira-ingest-db.ts
 *
 * Guarda de segurança: recusa correr se o host não for localhost/127.0.0.1.
 *
 * Cobre as regras de ingestão EXCLUSIVAS do tenant silveira introduzidas
 * pela manutenção em massa + fornecedor por linha:
 *   A · resolverOuCriarFornecedor — exacto / alias / alias ambíguo / criação
 *   B · applyFornecedorPreferencialSilveira — preenche vazio, NUNCA
 *       sobrescreve depois de definido, mesmo que o nome ERP mude
 *   C · applyErpCatalogFields(modoNuncaReescreverFabricante) — mesma regra
 *       para Produto.fabricanteId, ponta-a-ponta contra a BD real
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
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
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

async function main() {
  const sufixo = Date.now().toString(36);
  const dbName = `spharm_cms_ing_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  try {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: urlDe(dbName) },
      encoding: "utf8",
    });

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbName) }) });
    const { resolverOuCriarFornecedor } = await import("../../lib/catalogo/resolver-fornecedor");
    const { applyFornecedorPreferencialSilveira } = await import("../../lib/ingest/fornecedor-preferencial-silveira");
    const { applyErpCatalogFields } = await import("../../lib/ingest/catalog-from-erp");

    console.log("\nA · resolverOuCriarFornecedor");
    {
      const f1 = await resolverOuCriarFornecedor(prisma, "MEPHA - Investimento e Desenvolvimento Farmacêutico, Lda");
      check(f1.status === "resolvido" && f1.criado === true, "A1: cria quando não existe");
      const idCriado = f1.status === "resolvido" ? f1.fornecedorId : null;

      const f2 = await resolverOuCriarFornecedor(prisma, "MEPHA - Investimento e Desenvolvimento Farmacêutico, Lda");
      check(f2.status === "resolvido" && f2.criado === false && f2.fornecedorId === idCriado, "A2: mesma grafia resolve pelo canónico exacto, não recria");

      await prisma.fornecedorAlias.create({ data: { fornecedorId: idCriado!, aliasNome: "MEPHA DIRECTO" } });
      const f3 = await resolverOuCriarFornecedor(prisma, "MEPHA DIRECTO");
      check(f3.status === "resolvido" && f3.fornecedorId === idCriado, "A3: resolve por alias inequívoco");

      const outro = await prisma.fornecedor.create({ data: { nomeNormalizado: "UDIFAR", estado: "ATIVO" } });
      await prisma.fornecedorAlias.create({ data: { fornecedorId: outro.id, aliasNome: "DISTRIBUIDOR X" } });
      await prisma.fornecedorAlias.create({ data: { fornecedorId: idCriado!, aliasNome: "DISTRIBUIDOR X" } });
      const f4 = await resolverOuCriarFornecedor(prisma, "DISTRIBUIDOR X");
      check(f4.status === "ambiguo", "A4: alias que aponta para 2 fornecedores nunca resolve sozinho");

      const f5 = await resolverOuCriarFornecedor(prisma, "  ", { criarSeInexistente: true });
      check(f5.status === "invalido", "A5: nome vazio/inválido nunca cria nada");
    }

    console.log("\nB · applyFornecedorPreferencialSilveira — nunca sobrescreve depois de definido");
    {
      const farmacia = await prisma.farmacia.create({ data: { nome: "Silveirense" } });
      const produto = await prisma.produto.create({ data: { cnp: 5601234, designacao: "Ben-u-ron 1000mg" } });
      const cnpToId = new Map([[5601234, produto.id]]);

      const r1 = await applyFornecedorPreferencialSilveira(
        prisma,
        [{ cnp: 5601234, fornecedorNome: "Distribuidora Alfa" }],
        farmacia.id,
        cnpToId,
      );
      check(r1.preenchidos === 1 && r1.preservados === 0, "B1: primeiro ciclo preenche o vazio");
      const pf1 = await prisma.produtoFarmacia.findUnique({
        where: { produtoId_farmaciaId: { produtoId: produto.id, farmaciaId: farmacia.id } },
        include: { fornecedorHabitual: true },
      });
      check(pf1?.fornecedorHabitual?.nomeNormalizado === "DISTRIBUIDORA ALFA", "B2: fornecedorHabitual gravado correctamente");
      const idOriginal = pf1!.fornecedorHabitualId;

      const r2 = await applyFornecedorPreferencialSilveira(
        prisma,
        [{ cnp: 5601234, fornecedorNome: "Distribuidora Beta — nome totalmente diferente" }],
        farmacia.id,
        cnpToId,
      );
      check(r2.preenchidos === 0 && r2.preservados === 1, "B3: ciclo seguinte com nome ERP diferente NÃO reescreve");
      const pf2 = await prisma.produtoFarmacia.findUnique({
        where: { produtoId_farmaciaId: { produtoId: produto.id, farmaciaId: farmacia.id } },
      });
      check(pf2?.fornecedorHabitualId === idOriginal, "B4: fornecedorHabitualId continua o mesmo — decisão manual/ingest anterior protegida");

      const produto2 = await prisma.produto.create({ data: { cnp: 5602345, designacao: "Brufen 600mg" } });
      const r3 = await applyFornecedorPreferencialSilveira(
        prisma,
        [{ cnp: 5602345, fornecedorNome: null }],
        farmacia.id,
        new Map([[5602345, produto2.id]]),
      );
      check(r3.candidatos === 0, "B5: linha sem nome de fornecedor não é candidata");
    }

    console.log("\nC · applyErpCatalogFields(modoNuncaReescreverFabricante) — mesma regra para fabricante");
    {
      const farmS = await prisma.farmacia.create({ data: { nome: "Silveirense-C" } });
      const farmG = await prisma.farmacia.create({ data: { nome: "Segurado-C" } });
      const produto = await prisma.produto.create({ data: { cnp: 5603456, designacao: "Voltaren Emulgel" } });

      const c1 = await applyErpCatalogFields(
        prisma,
        [{ cnp: 5603456, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: "Novartis Portugal" }],
        farmS.id,
        { modoNuncaReescreverFabricante: true },
      );
      check(c1.preenchidos.fabricante === 1, "C1: primeiro ciclo (silveira) preenche fabricante vazio");
      const p1 = await prisma.produto.findUnique({ where: { id: produto.id }, include: { fabricante: true } });
      check(p1?.fabricante?.nomeNormalizado === "NOVARTIS PORTUGAL", "C2: fabricante gravado correctamente");

      const c2 = await applyErpCatalogFields(
        prisma,
        [{ cnp: 5603456, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: "GSK PORTUGAL" }],
        farmS.id,
        { modoNuncaReescreverFabricante: true },
      );
      check(c2.preservados.fabricante === 1 && c2.preenchidos.fabricante === 0, "C3: ERP muda de fabricante — silveira NUNCA reescreve automaticamente");
      const p2 = await prisma.produto.findUnique({ where: { id: produto.id }, include: { fabricante: true } });
      check(p2?.fabricante?.nomeNormalizado === "NOVARTIS PORTUGAL", "C4: fabricanteId continua o original");

      // Snapshot de divergência: produto ISOLADO (nunca tocado pelo ciclo
      // "nunca reescreve" acima) em que as DUAS farmácias reportam valores
      // diferentes via ProdutoFarmacia.fabricanteErpAtual.
      const produtoDiv = await prisma.produto.create({ data: { cnp: 5609999, designacao: "Produto Divergência" } });
      await applyErpCatalogFields(
        prisma,
        [{ cnp: 5609999, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: "Novartis Portugal" }],
        farmS.id,
        { modoNuncaReescreverFabricante: true },
      );
      await applyErpCatalogFields(
        prisma,
        [{ cnp: 5609999, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: "GSK PORTUGAL" }],
        farmG.id,
        { modoNuncaReescreverFabricante: true },
      );
      const { temFabricanteDivergenteEntreFarmacias } = await import("../../lib/ingest/catalog-from-erp");
      const pfs = await prisma.produtoFarmacia.findMany({
        where: { produtoId: produtoDiv.id },
        select: { farmaciaId: true, fabricanteErpAtual: true },
      });
      check(pfs.length === 2, "C5: snapshot ERP gravado para as 2 farmácias");
      check(
        temFabricanteDivergenteEntreFarmacias(pfs) === true,
        "C6: divergência detectada entre Silveirense (Novartis) e Segurado (GSK) — nunca resolvida automaticamente",
      );

      // Retry enquanto vazio: um produto novo cujo 1º ciclo não trouxe
      // fabricante (r.fabricante null) continua livre para preencher assim
      // que o ERP finalmente o reportar.
      const produtoVazio = await prisma.produto.create({ data: { cnp: 5604567, designacao: "Augmentin" } });
      await applyErpCatalogFields(
        prisma,
        [{ cnp: 5604567, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: null }],
        farmS.id,
        { modoNuncaReescreverFabricante: true },
      );
      const semFab = await prisma.produto.findUnique({ where: { id: produtoVazio.id } });
      check(semFab?.fabricanteId === null, "C7: ciclo sem valor do ERP não escreve nada");
      const c3 = await applyErpCatalogFields(
        prisma,
        [{ cnp: 5604567, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: "GSK PORTUGAL" }],
        farmS.id,
        { modoNuncaReescreverFabricante: true },
      );
      check(c3.preenchidos.fabricante === 1, "C8: ciclo seguinte com valor finalmente disponível — preenche (retry enquanto vazio)");
    }

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
