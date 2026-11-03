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

    secao("transições: categoria conhecida ≠ Ético/NETT retira; o resto preserva");
    const base = 7_100_000;
    await post(fX.id, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => item(base + i, { eticoNett: i % 2 ? "ETICO" : "NETT", eticoNettCodigo: 1, eticoNettDescricao: i % 2 ? "Éticos" : "NETT" })));
    const cat = async (i: number) => (await pf(base + i, fX.id))?.eticoNett ?? null;
    check((await cat(1)) === "ETICO" && (await cat(2)) === "NETT", "pré-condição: classificados");
    const outra = (i: number, descricao: string, extra: Record<string, unknown> = {}) =>
      item(base + i, { eticoNett: null, eticoNettOutraCategoria: true, eticoNettCodigo: 3, eticoNettDescricao: descricao, ...extra });
    r = await post(fX.id, [outra(1, "Serviços"), outra(2, "Sacos L."), outra(3, "Outros")]);
    const rs = r.body.eticoNett as Record<string, number>;
    check((await cat(1)) === null && (await cat(2)) === null && (await cat(3)) === null, "ÉTICO→Serviço, NETT→Sacos, ÉTICO→Outros: ficam SEM");
    check(rs.limpos === 3 && rs.outraCategoria === 3 && rs.aplicados === 0, "contagens: 3 retirados", JSON.stringify(rs));
    const limpa = await pf(base + 1, fX.id);
    check(limpa?.eticoNettCodigoErp === 3 && limpa?.eticoNettDescricaoErp === "Serviços", "guarda o código/descrição ERP atuais (diagnóstico)");
    r = await post(fX.id, [outra(1, "Serviços")]);
    check((r.body.eticoNett as Record<string, number>).limpos === 0 && (await cat(1)) === null, "repetir é idempotente (já SEM: nada a retirar)");
    // preservar: desconhecido, lookup ausente, órfão, vazio, ambíguo (todos chegam do agent como null SEM flag), rev98, inválidos
    r = await post(fX.id, [
      item(base + 4, { eticoNett: null }), // desconhecido / lookup ausente / órfão / ambíguo
      item(base + 5, {}), // rev98
      item(base + 6, { eticoNett: null, eticoNettOutraCategoria: true, eticoNettCodigo: 3, eticoNettDescricao: "" }), // descrição vazia
      item(base + 7, { eticoNett: null, eticoNettOutraCategoria: true, eticoNettCodigo: 3, eticoNettDescricao: "Qualquer coisa nova" }), // desconhecida
      item(base + 8, { eticoNett: null, eticoNettOutraCategoria: true, eticoNettCodigo: 1, eticoNettDescricao: "Éticos" }), // flag incoerente
    ]);
    const rp = r.body.eticoNett as Record<string, number>;
    check((await cat(4)) === "NETT" && (await cat(5)) === "ETICO" && (await cat(6)) === "NETT" && (await cat(7)) === "ETICO" && (await cat(8)) === "NETT", "desconhecido / rev98 / vazio / nova descrição / incoerente: NADA é apagado");
    check(rp.naoClassificados === 1 && rp.invalidos === 3 && rp.limpos === 0, "…contados como aviso/inválidos", JSON.stringify(rp));
    // manual protegido
    const pm = await pf(base + 9, fX.id);
    await prisma.produtoFarmacia.update({ where: { id: pm!.id }, data: { eticoNettManual: true } });
    r = await post(fX.id, [outra(9, "Serviços")]);
    check((await cat(9)) === "ETICO" && (r.body.eticoNett as Record<string, number>).ignoradosManual === 1, "classificação manual nunca é retirada");

    secao("Produto existe no MT mas ainda não tem ProdutoFarmacia desta farmácia");
    const so = await prisma.produto.create({ data: { cnp: 7_200_001, designacao: "SO NO CATALOGO", origemDados: "FARMACIA" } });
    check((await prisma.produtoFarmacia.count({ where: { produtoId: so.id } })) === 0, "pré-condição: Produto sem nenhuma ProdutoFarmacia");
    const nProd2 = await prisma.produto.count();
    r = await post(fY.id, [item(7_200_001, { eticoNett: "NETT", eticoNettCodigo: 7, eticoNettDescricao: "NETT" })]);
    const novaPf = await pf(7_200_001, fY.id);
    check(novaPf?.eticoNett === "NETT" && (await prisma.produto.count()) === nProd2 && (await prisma.produtoFarmacia.count({ where: { produtoId: so.id } })) === 1,
      "o upsert normal do item (universo que o agent já enviava) cria a associação da farmácia que o enviou; o Produto não é duplicado");
    check((await prisma.produtoFarmacia.count({ where: { produtoId: so.id, farmaciaId: fX.id } })) === 0, "…e NÃO cria associação em nenhuma outra farmácia");

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
