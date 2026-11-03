/**
 * scripts/tests/test-etico-nett-rota-db.ts
 *
 * O endpoint REAL `POST /api/ingest/v1/bootstrap/products` (handler importado tal como está; só a autenticação é
 * substituída por um contexto sintético) contra PostgreSQL DESCARTÁVEL, com payloads de agent rev98 e rev99:
 *
 *   · rev98 (sem os campos novos): produtos entram/atualizam como sempre, classificação existente NÃO é tocada;
 *   · rev99: ETICO/NETT gravados por farmácia, com código/descrição ORIGINAIS; reenvio idempotente;
 *   · null / Serviço-como-null / valor inválido: contam aviso e NÃO alteram nem apagam;
 *   · duas farmácias com códigos ERP diferentes; nenhuma sobrescreve a outra;
 *   · a resposta traz o resumo `eticoNett` só quando há campos novos (rev98 recebe a resposta de sempre);
 *   · o produto novo vem do lote do agent (universo dele) — a classificação nunca cria produtos por si.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-etico-nett-rota-db.ts
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const estado: { prisma: unknown; slug: string } = { prisma: null, slug: "garantia" };
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string; _load: (r: string, ...a: unknown[]) => unknown };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};
const loadOriginal = M._load;
M._load = function (request: string, ...rest: unknown[]) {
  if (request === "@/lib/integracao/auth") {
    return {
      withIntegrationAuth: (handler: (ctx: unknown, req: unknown) => Promise<Response>) => async (req: unknown) =>
        handler({ prisma: estado.prisma, tenant: { slug: estado.slug } }, req),
    };
  }
  return loadOriginal.call(this, request, ...rest);
};

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);

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
  const db = `spharm_en_rota_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(db);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    process.env.ENABLE_AGENT_BOOTSTRAP = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    estado.prisma = prisma;
    const { POST } = await import("../../app/api/ingest/v1/bootstrap/products/route");

    const fX = await prisma.farmacia.create({ data: { nome: "Rota X" } });
    const fY = await prisma.farmacia.create({ data: { nome: "Rota Y" } });

    const item = (cnp: number, extra: Record<string, unknown> = {}) => ({
      externalProductId: cnp, cnp, designacao: `ROTA PRODUTO ${cnp}`, pvp: 10, pmc: 5, puc: 4, dataUltimaVenda: null, dataUltimaCompra: null,
      retirado: false, generico: false, mnsrmNCompart: false, fornecedorHabitualId: null, fornecedorHabitualNome: null, taxaIva: null,
      dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: null, ...extra,
    });
    const post = async (farmaciaId: string, items: unknown[]) => {
      const req = new Request("http://localhost/api/ingest/v1/bootstrap/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ farmaciaId, items }),
      });
      const res = await (POST as unknown as (r: Request) => Promise<Response>)(req);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const pf = async (cnp: number, farmaciaId: string) => {
      const p = await prisma.produto.findUnique({ where: { cnp } });
      return p ? prisma.produtoFarmacia.findFirst({ where: { produtoId: p.id, farmaciaId } }) : null;
    };

    secao("rev98: payload sem os campos novos");
    let r = await post(fX.id, [item(7_000_001), item(7_000_002)]);
    check(r.status === 200 && r.body.upserted === 2, "rev98 cria os produtos como sempre", JSON.stringify(r.body).slice(0, 200));
    check(!("eticoNett" in r.body), "a resposta a um rev98 não traz o bloco eticoNett");
    check((await pf(7_000_001, fX.id))?.eticoNett === null, "sem classificação por omissão");

    secao("rev99: ETICO / NETT gravados por farmácia");
    r = await post(fX.id, [
      item(7_000_001, { eticoNett: "ETICO", eticoNettCodigo: 1, eticoNettDescricao: "Éticos" }),
      item(7_000_002, { eticoNett: "NETT", eticoNettCodigo: 2, eticoNettDescricao: "NETT" }),
      item(7_000_003, { eticoNett: null }),
      item(7_000_004, { eticoNett: "SERVICO" }),
      item(7_000_005),
    ]);
    const resumo = r.body.eticoNett as Record<string, number> | undefined;
    check(r.status === 200 && resumo?.candidatos === 4 && resumo.aplicados === 2 && resumo.naoClassificados === 1 && resumo.invalidos === 1,
      "resposta: 4 candidatos, 2 aplicados, 1 não classificado, 1 inválido", JSON.stringify(r.body.eticoNett));
    const a = await pf(7_000_001, fX.id);
    check(a?.eticoNett === "ETICO" && a.eticoNettCodigoErp === 1 && a.eticoNettDescricaoErp === "Éticos" && a.eticoNettObservadoEm !== null, "ÉTICO com código e descrição originais");
    check((await pf(7_000_002, fX.id))?.eticoNett === "NETT", "NETT");
    check((await pf(7_000_003, fX.id))?.eticoNett === null && (await pf(7_000_004, fX.id))?.eticoNett === null && (await pf(7_000_005, fX.id))?.eticoNett === null,
      "null / inválido / sem campo: sem classificação");
    check(r.body.upserted === 5, "os 5 produtos do lote foram upserted normalmente (a classificação não afecta o contrato)");

    secao("idempotência e rev98 depois do rev99");
    const antes = JSON.stringify(await prisma.$queryRawUnsafe(`SELECT "produtoId","eticoNett","eticoNettCodigoErp" FROM "ProdutoFarmacia" ORDER BY "produtoId","farmaciaId"`));
    const nProd = await prisma.produto.count();
    const lote = [
      item(7_000_001, { eticoNett: "ETICO", eticoNettCodigo: 1, eticoNettDescricao: "Éticos" }),
      item(7_000_002, { eticoNett: "NETT", eticoNettCodigo: 2, eticoNettDescricao: "NETT" }),
    ];
    await post(fX.id, lote);
    await post(fX.id, lote);
    const depois = JSON.stringify(await prisma.$queryRawUnsafe(`SELECT "produtoId","eticoNett","eticoNettCodigoErp" FROM "ProdutoFarmacia" ORDER BY "produtoId","farmaciaId"`));
    check(antes === depois && (await prisma.produto.count()) === nProd, "reenvio (2x) idempotente: nada muda, nenhum produto novo");
    await post(fX.id, [item(7_000_001, { pvp: 12 }), item(7_000_002, { pvp: 13 })]);
    check((await pf(7_000_001, fX.id))?.eticoNett === "ETICO" && Number((await pf(7_000_001, fX.id))?.pvp) === 12, "um agent rev98 a seguir atualiza o preço e PRESERVA a classificação");
    await post(fX.id, [item(7_000_001, { eticoNett: null })]);
    check((await pf(7_000_001, fX.id))?.eticoNett === "ETICO", "eticoNett:null não apaga");

    secao("duas farmácias, códigos ERP diferentes");
    r = await post(fY.id, [
      item(7_000_001, { eticoNett: "ETICO", eticoNettCodigo: 9, eticoNettDescricao: "ETICO" }),
      item(7_000_002, { eticoNett: "ETICO", eticoNettCodigo: 9, eticoNettDescricao: "ETICO" }),
    ]);
    check((await pf(7_000_001, fY.id))?.eticoNettCodigoErp === 9 && (await pf(7_000_001, fX.id))?.eticoNettCodigoErp === 1, "cada farmácia guarda o seu código ERP");
    check((await pf(7_000_002, fX.id))?.eticoNett === "NETT" && (await pf(7_000_002, fY.id))?.eticoNett === "ETICO", "NETT numa e ÉTICO noutra: nenhuma sobrescreve a outra");
    const { idsProdutosPorEticoNett } = await import("../../lib/classificacao/etico-nett-sql");
    const div = await idsProdutosPorEticoNett(prisma, ["DIVERGENTE"], null);
    const p2 = await prisma.produto.findUnique({ where: { cnp: 7_000_002 } });
    check(div?.length === 1 && div[0] === p2?.id, "consolidado: o 7000002 é DIVERGENTE; o 7000001 (Ético nas duas) não");

    secao("descrição incoerente com a categoria");
    r = await post(fX.id, [item(7_000_005, { eticoNett: "ETICO", eticoNettCodigo: 3, eticoNettDescricao: "Serviços" })]);
    check((r.body.eticoNett as Record<string, number>).invalidos === 1 && (await pf(7_000_005, fX.id))?.eticoNett === null, "ETICO com descrição «Serviços» é recusado (inválido)");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${ok} OK, ${ko} FALHA(S)`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
