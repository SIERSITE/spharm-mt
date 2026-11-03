/**
 * scripts/tests/test-etico-nett-db.ts
 *
 * Classificação Ético/NETT contra PostgreSQL REAL e DESCARTÁVEL (recusa hosts não locais), dados SINTÉTICOS:
 *
 *   A · migration aditiva: colunas novas, DEFAULTs, dados existentes intactos;
 *   B · ingestão (as MESMAS funções do route handler): aplica ETICO/NETT; reenvio idempotente; agent rev98 (sem os
 *       campos) NÃO apaga nem altera; null/inválido NÃO apagam; manual protegido; produto/associação inexistente NÃO é criado;
 *   C · duas farmácias com lookups de códigos diferentes (já resolvidos pelo agent) -> uma linha por farmácia;
 *   D · consolidação em SQL: concordam -> valor; divergem -> DIVERGENTE (sem «última a sincronizar ganha», nos dois sentidos);
 *       sem informação -> SEM; âmbito por farmácia;
 *   E · filtro server-side `restringirPorCatalogo`: Ético/NETT/Sem/Divergente, união, E com outros eixos, lista vazia;
 *   F · opções (contagens) e leitura da ficha (por farmácia + consolidado);
 *   G · isolamento entre duas bases (tenants).
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-etico-nett-db.ts
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

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const ordenado = (xs: string[]) => [...xs].sort();
const mesmo = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
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

async function main() {
  const suf = Date.now().toString(36);
  const dbA = `spharm_en_a_${suf}`;
  const dbB = `spharm_en_b_${suf}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const d of [dbA, dbB]) await admin.query(`CREATE DATABASE ${d}`);
  try {
    for (const d of [dbA, dbB]) execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(d) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const { bulkUpsertProdutosByCnp, bulkUpsertProdutoFarmaciaProducts } = await import("../../lib/ingest/bulk");
    const { prepararEticoNett, aplicarEticoNett } = await import("../../lib/ingest/etico-nett");
    const { restringirPorCatalogo } = await import("../../lib/reporting/catalog-prefilter");
    const { carregarOpcoesEticoNett, carregarEticoNettDoProduto, idsProdutosPorEticoNett } = await import("../../lib/classificacao/etico-nett-sql");

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbA) }) });
    const prismaB = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbB) }) });
    const farmX = await prisma.farmacia.create({ data: { nome: "Farmácia X" } });
    const farmY = await prisma.farmacia.create({ data: { nome: "Farmácia Y" } });

    // CNPs sintéticos (7 dígitos > MIN_CNP_CATALOGAVEL)
    const CNP = { a: 5000001, b: 5000002, c: 5000003, d: 5000004, e: 5000005, f: 5000006 };
    const idProd = new Map<number, string>();
    const semear = async (db: typeof prisma, farmaciaId: string, cnps: number[]) => {
      const up = await bulkUpsertProdutosByCnp(
        db,
        cnps.map((cnp) => ({ cnp, externalProductId: cnp, designacao: `PRODUTO SINTETICO ${cnp}`, flagGenerico: false, flagMnsrmNCompart: false })),
      );
      const pfRows = cnps.map((cnp) => ({
        produtoId: up.get(cnp)!, farmaciaId, externalProductId: cnp, pvp: 10, pmc: null, puc: 5, dataUltimaVenda: null,
        dataUltimaCompra: null, flagRetirado: false, fornecedorExternalId: null, fornecedorOrigem: null, taxaIvaPercent: null,
      }));
      await bulkUpsertProdutoFarmaciaProducts(db, pfRows);
      for (const [cnp, id] of up) idProd.set(cnp, id);
    };
    const enviar = async (db: typeof prisma, farmaciaId: string, itens: Array<{ cnp: number; raw: Record<string, unknown> }>) => {
      const prep = prepararEticoNett(itens.map((i) => ({ produtoId: idProd.get(i.cnp), raw: i.raw })));
      return aplicarEticoNett(db, farmaciaId, prep.aplicar, prep.resumo);
    };
    const pf = async (cnp: number, farmaciaId: string) =>
      prisma.produtoFarmacia.findFirstOrThrow({ where: { produtoId: idProd.get(cnp)!, farmaciaId } });

    secao("A · migration aditiva");
    const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string; column_default: string | null }>>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name='ProdutoFarmacia' AND column_name LIKE 'eticoNett%' ORDER BY column_name`,
    );
    check(cols.length === 5, "5 colunas eticoNett* em ProdutoFarmacia", JSON.stringify(cols.map((c) => c.column_name)));
    check(cols.find((c) => c.column_name === "eticoNett")?.is_nullable === "YES", "eticoNett é NULL por omissão (sem classificação)");
    check(String(cols.find((c) => c.column_name === "eticoNettManual")?.column_default) === "false", "eticoNettManual default false");
    await semear(prisma, farmX.id, [CNP.a, CNP.b, CNP.c, CNP.d, CNP.e]);
    const antes = await pf(CNP.a, farmX.id);
    check(antes.eticoNett === null && antes.eticoNettManual === false && Number(antes.pvp) === 10, "linhas já existentes ficam sem classificação, dados intactos");

    secao("B · ingestão");
    let r = await enviar(prisma, farmX.id, [
      { cnp: CNP.a, raw: { eticoNett: "ETICO", eticoNettCodigo: 1, eticoNettDescricao: "Éticos" } },
      { cnp: CNP.b, raw: { eticoNett: "NETT", eticoNettCodigo: 2, eticoNettDescricao: "NETT" } },
      { cnp: CNP.c, raw: { eticoNett: null } },
      { cnp: CNP.d, raw: {} },
      { cnp: CNP.e, raw: { eticoNett: "SERVICO" } },
    ]);
    check(r.candidatos === 4 && r.aplicados === 2 && r.naoClassificados === 1 && r.invalidos === 1, "contagens: 4 candidatos, 2 aplicados, 1 não classificado, 1 inválido", JSON.stringify(r));
    let a = await pf(CNP.a, farmX.id);
    check(a.eticoNett === "ETICO" && a.eticoNettCodigoErp === 1 && a.eticoNettDescricaoErp === "Éticos" && a.eticoNettObservadoEm !== null, "ÉTICO com código e descrição originais");
    check((await pf(CNP.b, farmX.id)).eticoNett === "NETT", "NETT aplicado");
    check((await pf(CNP.c, farmX.id)).eticoNett === null && (await pf(CNP.d, farmX.id)).eticoNett === null && (await pf(CNP.e, farmX.id)).eticoNett === null,
      "null / ausente / inválido não classificam");

    const snapshot = async () => JSON.stringify(await prisma.$queryRawUnsafe(
      `SELECT "produtoId","eticoNett","eticoNettCodigoErp","eticoNettDescricaoErp","eticoNettManual" FROM "ProdutoFarmacia" ORDER BY "produtoId","farmaciaId"`));
    const s1 = await snapshot();
    const n1 = await prisma.produtoFarmacia.count();
    await enviar(prisma, farmX.id, [
      { cnp: CNP.a, raw: { eticoNett: "ETICO", eticoNettCodigo: 1, eticoNettDescricao: "Éticos" } },
      { cnp: CNP.b, raw: { eticoNett: "NETT", eticoNettCodigo: 2, eticoNettDescricao: "NETT" } },
    ]);
    await enviar(prisma, farmX.id, [{ cnp: CNP.a, raw: { eticoNett: "ETICO", eticoNettCodigo: 1, eticoNettDescricao: "Éticos" } }]);
    check((await snapshot()) === s1 && (await prisma.produtoFarmacia.count()) === n1, "reenvio do mesmo lote (2x) é idempotente");

    // agent rev98: o lote NÃO traz os campos -> nada muda
    r = await enviar(prisma, farmX.id, [{ cnp: CNP.a, raw: {} }, { cnp: CNP.b, raw: {} }]);
    check(r.candidatos === 0 && (await snapshot()) === s1, "agent rev98 (sem campos) não apaga nem altera a classificação existente");
    // …mesmo passando pelo upsert de produto do próprio endpoint (que não conhece os campos novos)
    await bulkUpsertProdutoFarmaciaProducts(prisma, [{
      produtoId: idProd.get(CNP.a)!, farmaciaId: farmX.id, externalProductId: CNP.a, pvp: 11, pmc: null, puc: 5, dataUltimaVenda: null,
      dataUltimaCompra: null, flagRetirado: false, fornecedorExternalId: null, fornecedorOrigem: null, taxaIvaPercent: null,
    }]);
    a = await pf(CNP.a, farmX.id);
    check(a.eticoNett === "ETICO" && Number(a.pvp) === 11, "o upsert de produto (rev98) atualiza o preço e preserva a classificação");
    // agent novo diz «não classificado» (ex.: ERP passou a Serviço): mantém o que existia
    await enviar(prisma, farmX.id, [{ cnp: CNP.a, raw: { eticoNett: null } }]);
    check((await pf(CNP.a, farmX.id)).eticoNett === "ETICO", "null do agent novo não apaga a classificação existente");
    // mudança real no ERP (Ético -> NETT) aplica-se
    await enviar(prisma, farmX.id, [{ cnp: CNP.a, raw: { eticoNett: "NETT", eticoNettCodigo: 2, eticoNettDescricao: "NETT" } }]);
    check((await pf(CNP.a, farmX.id)).eticoNett === "NETT", "mudança real Ético -> NETT aplica-se");
    await enviar(prisma, farmX.id, [{ cnp: CNP.a, raw: { eticoNett: "ETICO", eticoNettCodigo: 1, eticoNettDescricao: "Éticos" } }]);

    // manual protegido
    await prisma.produtoFarmacia.update({ where: { id: (await pf(CNP.b, farmX.id)).id }, data: { eticoNett: "ETICO", eticoNettManual: true } });
    r = await enviar(prisma, farmX.id, [{ cnp: CNP.b, raw: { eticoNett: "NETT", eticoNettCodigo: 2, eticoNettDescricao: "NETT" } }]);
    check((await pf(CNP.b, farmX.id)).eticoNett === "ETICO" && r.aplicados === 0 && r.ignoradosManual === 1, "classificação manual nunca é substituída pelo ERP", JSON.stringify(r));
    await prisma.produtoFarmacia.update({ where: { id: (await pf(CNP.b, farmX.id)).id }, data: { eticoNett: "NETT", eticoNettManual: false } });

    // CNP inexistente / sem associação com a farmácia: não cria nada
    const nProd = await prisma.produto.count();
    const nPf = await prisma.produtoFarmacia.count();
    idProd.set(CNP.f, "id-que-nao-existe");
    r = await enviar(prisma, farmX.id, [{ cnp: CNP.f, raw: { eticoNett: "ETICO", eticoNettCodigo: 1 } }]);
    check(r.aplicados === 0 && (await prisma.produto.count()) === nProd && (await prisma.produtoFarmacia.count()) === nPf, "CNP inexistente: nenhum Produto/ProdutoFarmacia criado");
    const prodSoNoCatalogo = await prisma.produto.create({ data: { cnp: CNP.f, designacao: "SO NO CATALOGO", origemDados: "FARMACIA" } });
    idProd.set(CNP.f, prodSoNoCatalogo.id);
    r = await enviar(prisma, farmX.id, [{ cnp: CNP.f, raw: { eticoNett: "NETT" } }]);
    check(r.aplicados === 0 && (await prisma.produtoFarmacia.count()) === nPf, "produto sem associação com a farmácia: não se cria ProdutoFarmacia");

    secao("C · duas farmácias, lookups de códigos diferentes");
    // Y tem os mesmos CNPs (a,b,c) mas o ERP dela usa outros códigos (ETICO=9, NETT=7): o agent já resolveu por descrição.
    await semear(prisma, farmY.id, [CNP.a, CNP.b, CNP.c, CNP.d]);
    await enviar(prisma, farmY.id, [
      { cnp: CNP.a, raw: { eticoNett: "ETICO", eticoNettCodigo: 9, eticoNettDescricao: "ETICO" } },
      { cnp: CNP.b, raw: { eticoNett: "ETICO", eticoNettCodigo: 9, eticoNettDescricao: "ETICO" } },
      { cnp: CNP.c, raw: { eticoNett: "NETT", eticoNettCodigo: 7, eticoNettDescricao: "nett" } },
    ]);
    const ya = await pf(CNP.a, farmY.id);
    const xa = await pf(CNP.a, farmX.id);
    check(ya.eticoNettCodigoErp === 9 && xa.eticoNettCodigoErp === 1 && ya.eticoNett === xa.eticoNett, "mesmo ÉTICO, códigos ERP diferentes guardados por farmácia (9 vs 1)");
    check((await pf(CNP.a, farmX.id)).eticoNett === "ETICO", "a farmácia Y não altera a X");

    secao("D · consolidação (sem «última farmácia ganha»)");
    // estado: a: X=ETICO Y=ETICO · b: X=NETT Y=ETICO (diverge) · c: X=null Y=NETT · d: nenhuma · e: nenhuma
    const todos = (v: string[]) => idsProdutosPorEticoNett(prisma, v, null).then((x) => ordenado(x ?? []));
    const ids = (...cnps: number[]) => ordenado(cnps.map((c) => idProd.get(c)!));
    check(mesmo(await todos(["ETICO"]), ids(CNP.a)), "ETICO: só o produto em que as duas concordam");
    check(mesmo(await todos(["NETT"]), ids(CNP.c)), "NETT: produto com informação só numa farmácia");
    check(mesmo(await todos(["DIVERGENTE"]), ids(CNP.b)), "DIVERGENTE: Ético numa farmácia, NETT noutra");
    check((await todos(["SEM"])).includes(idProd.get(CNP.d)!) && (await todos(["SEM"])).includes(idProd.get(CNP.e)!) && !(await todos(["SEM"])).includes(idProd.get(CNP.a)!), "SEM: produtos sem nenhuma informação");
    // ordem de sincronização inversa não muda o resultado
    await enviar(prisma, farmX.id, [{ cnp: CNP.b, raw: { eticoNett: "NETT", eticoNettCodigo: 2, eticoNettDescricao: "NETT" } }]);
    await enviar(prisma, farmY.id, [{ cnp: CNP.b, raw: { eticoNett: "ETICO", eticoNettCodigo: 9, eticoNettDescricao: "ETICO" } }]);
    check(mesmo(await todos(["DIVERGENTE"]), ids(CNP.b)), "ressincronizar noutra ordem mantém DIVERGENTE (sem last-write-wins)");
    check(mesmo(await idsProdutosPorEticoNett(prisma, ["ETICO"], null, [farmY.id]).then((x) => ordenado(x ?? [])), ids(CNP.a, CNP.b)), "âmbito só Y: b é ETICO para Y");
    check(mesmo(await idsProdutosPorEticoNett(prisma, ["NETT"], null, [farmX.id]).then((x) => ordenado(x ?? [])), ids(CNP.b)), "âmbito só X: b é NETT para X");
    check(mesmo(await todos(["ETICO", "NETT"]), ids(CNP.a, CNP.c)), "união ETICO+NETT exclui divergentes e sem classificação");
    check((await idsProdutosPorEticoNett(prisma, [], null)) === null, "sem valores -> sem restrição (null)");

    secao("E · filtro server-side (restringirPorCatalogo)");
    check(mesmo(ordenado((await restringirPorCatalogo(prisma, { eticoNett: ["DIVERGENTE"] }, null)) ?? []), ids(CNP.b)), "Divergente via pré-filtro");
    check(mesmo(ordenado((await restringirPorCatalogo(prisma, { eticoNett: ["ETICO"] }, ids(CNP.a, CNP.c, CNP.d))) ?? []), ids(CNP.a)), "combina (E) com ids já restringidos por outro eixo");
    check(mesmo(await restringirPorCatalogo(prisma, { eticoNett: ["NETT"] }, ids(CNP.a)), []), "nenhum produto corresponde -> lista vazia (não «todos»)");
    check(mesmo(ordenado((await restringirPorCatalogo(prisma, { eticoNett: ["ETICO"], farmaciaNomes: ["Farmácia Y"] }, null)) ?? []), ids(CNP.a, CNP.b)), "âmbito por nome de farmácia");
    check(mesmo(await restringirPorCatalogo(prisma, { eticoNett: ["ETICO"], farmaciaNomes: ["Não Existe"] }, null), []), "farmácia inexistente -> vazio");
    const base = await restringirPorCatalogo(prisma, { eticoNett: [] }, null);
    check(base === null, "eticoNett vazio = comportamento anterior (sem restrição)");

    secao("F · opções e ficha");
    const op = await carregarOpcoesEticoNett(prisma);
    const por = Object.fromEntries(op.map((o) => [o.valor, o.count]));
    check(por.ETICO === 1 && por.NETT === 1 && por.DIVERGENTE === 1 && por.SEM === 3, "contagens ETICO=1 NETT=1 DIVERGENTE=1 SEM=3", JSON.stringify(por));
    const ficha = await carregarEticoNettDoProduto(prisma, idProd.get(CNP.b)!);
    check(ficha.consolidado === "DIVERGENTE" && ficha.porFarmacia.length === 2, "ficha: divergente com as 2 farmácias");
    check(ficha.porFarmacia.find((p) => p.farmaciaNome === "Farmácia X")?.categoria === "NETT" && ficha.porFarmacia.find((p) => p.farmaciaNome === "Farmácia Y")?.categoria === "ETICO", "ficha: categoria por farmácia");
    const fichaSem = await carregarEticoNettDoProduto(prisma, idProd.get(CNP.d)!);
    check(fichaSem.consolidado === "SEM" && fichaSem.porFarmacia.length === 0, "ficha: sem classificação (nada inventado)");

    secao("G · isolamento entre tenants");
    const farmB = await prismaB.farmacia.create({ data: { nome: "Farmácia B" } });
    const upB = await bulkUpsertProdutosByCnp(prismaB, [{ cnp: CNP.a, externalProductId: CNP.a, designacao: "OUTRO TENANT", flagGenerico: false, flagMnsrmNCompart: false }]);
    await bulkUpsertProdutoFarmaciaProducts(prismaB, [{
      produtoId: upB.get(CNP.a)!, farmaciaId: farmB.id, externalProductId: CNP.a, pvp: 1, pmc: null, puc: 1, dataUltimaVenda: null,
      dataUltimaCompra: null, flagRetirado: false, fornecedorExternalId: null, fornecedorOrigem: null, taxaIvaPercent: null,
    }]);
    await aplicarEticoNett(prismaB, farmB.id, [{ produtoId: upB.get(CNP.a)!, categoria: "NETT", codigoErp: 2, descricaoErp: "NETT" }], { candidatos: 1, aplicados: 0, naoClassificados: 0, invalidos: 0, ignoradosManual: 0 });
    const opB = Object.fromEntries((await carregarOpcoesEticoNett(prismaB)).map((o) => [o.valor, o.count]));
    check(opB.NETT === 1 && opB.ETICO === 0 && opB.DIVERGENTE === 0, "tenant B vê só o seu NETT", JSON.stringify(opB));
    check((await pf(CNP.a, farmX.id)).eticoNett === "ETICO", "tenant A não foi afetado pelo B (mesmo CNP, outra base)");

    await prisma.$disconnect();
    await prismaB.$disconnect();
  } finally {
    for (const d of [dbA, dbB]) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${ok} OK, ${ko} FALHA(S)`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
