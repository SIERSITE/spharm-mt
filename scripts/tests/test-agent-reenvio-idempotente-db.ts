/**
 * scripts/tests/test-agent-reenvio-idempotente-db.ts
 *
 * O agent rev98 REPETE o mesmo lote quando a resposta se perde. Isto prova, contra PostgreSQL REAL e
 * DESCARTÁVEL, que as escritas do servidor por trás dos endpoints do daily-pipeline são idempotentes: aplicar
 * o MESMO lote duas (ou três) vezes deixa a base exatamente igual — sem duplicar produtos, stock, linhas de
 * venda nem PipelineRun.
 *
 *   docker run -d --name spharm-mg-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-agent-reenvio-idempotente-db.ts
 *
 * Usa as MESMAS funções de escrita que os route handlers (`lib/ingest/bulk.ts`); o `pipeline/record`
 * reproduz o upsert por `idempotencyKey` do handler.
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
const check = (c: boolean, m: string) => { if (c) { passed++; console.log(`  [OK]    ${m}`); } else { failed++; console.log(`  [FALHA] ${m}`); } };
const secao = (t: string) => console.log(`\n── ${t}`);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") { console.error(`RECUSADO: ${host} não é uma base local descartável.`); process.exit(2); }
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

async function main() {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const bulk = await import("../../lib/ingest/bulk");

  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const db = `spharm_idem_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const farm = await prisma.farmacia.create({ data: { nome: "Idem" } });

    const estado = async () => ({
      produtos: JSON.stringify(await prisma.$queryRawUnsafe(`SELECT cnp, designacao, "flagGenerico" FROM "Produto" ORDER BY cnp`)),
      pf: JSON.stringify(await prisma.$queryRawUnsafe(`SELECT "produtoId", pvp::text, pmc::text, puc::text, "stockAtual"::text, "stockMinimo"::text, "flagRetirado" FROM "ProdutoFarmacia" ORDER BY "produtoId"`)),
      vendas: JSON.stringify(await prisma.$queryRawUnsafe(`SELECT "externalSaleLineId", quantidade::text, "valorLinha"::text FROM "IngestVendaLinhaRaw" ORDER BY "externalSaleLineId"`)),
      n: {
        produtos: await prisma.produto.count(),
        pf: await prisma.produtoFarmacia.count(),
        vendas: await prisma.ingestVendaLinhaRaw.count(),
      },
    });

    // ── produtos + ProdutoFarmacia (campos de produto) ──
    secao("produtos: o mesmo lote duas vezes");
    const produtos = Array.from({ length: 50 }, (_, i) => ({ cnp: 6100000 + i, externalProductId: 9000 + i, designacao: `ARTIGO ${i}`, flagGenerico: i % 2 === 0, flagMnsrmNCompart: false }));
    const mapa1 = await bulk.bulkUpsertProdutosByCnp(prisma, produtos);
    const pfRows = (m: Map<number, string>) => produtos.map((p) => ({
      produtoId: m.get(p.cnp)!, farmaciaId: farm.id, externalProductId: p.externalProductId, pvp: 10 + (p.cnp % 5), pmc: 5, puc: 4,
      dataUltimaVenda: null, dataUltimaCompra: null, flagRetirado: false, fornecedorExternalId: null, fornecedorOrigem: null, taxaIvaPercent: 23,
    }));
    await bulk.bulkUpsertProdutoFarmaciaProducts(prisma, pfRows(mapa1));
    const e1 = await estado();
    const mapa2 = await bulk.bulkUpsertProdutosByCnp(prisma, produtos);          // resposta perdida → repetição exata
    await bulk.bulkUpsertProdutoFarmaciaProducts(prisma, pfRows(mapa2));
    const e2 = await estado();
    check(e1.n.produtos === 50 && e2.n.produtos === 50 && e2.n.pf === 50, "50 produtos e 50 ProdutoFarmacia — sem duplicados");
    check(e1.produtos === e2.produtos && e1.pf === e2.pf, "conteúdo idêntico depois da repetição");
    check([...mapa1].every(([cnp, id]) => mapa2.get(cnp) === id), "os ids (RETURNING) são os mesmos — nada foi recriado");

    // ── stock ──
    secao("stock: repetição substitui, não acumula");
    const stockRows = produtos.map((p) => ({ produtoId: mapa1.get(p.cnp)!, farmaciaId: farm.id, externalProductId: p.externalProductId, stockAtual: 7, stockMinimo: 2, stockMaximo: 20, stockEncomenda: 0, stockReserva: 0 }));
    await bulk.bulkUpsertProdutoFarmaciaStock(prisma, stockRows);
    const s1 = await estado();
    await bulk.bulkUpsertProdutoFarmaciaStock(prisma, stockRows);
    await bulk.bulkUpsertProdutoFarmaciaStock(prisma, stockRows);
    const s2 = await estado();
    check(s1.pf === s2.pf && s2.n.pf === 50, "stock idêntico após 3 aplicações (stockAtual continua 7, não 21)");
    check(JSON.parse(s2.pf)[0].stockAtual === "7.000" || String(JSON.parse(s2.pf)[0].stockAtual).startsWith("7"), "stockAtual = 7");

    // ── linhas de venda ──
    secao("sales-lines: ON CONFLICT (farmácia, origem, id da linha)");
    const linhas = Array.from({ length: 80 }, (_, i) => ({
      farmaciaId: farm.id, sourceNamespace: "ATENDIMENTO_DETALHE", externalSaleId: 500 + Math.floor(i / 4), externalSaleLineId: 70000 + i, serie: "G", documento: `G/${500 + Math.floor(i / 4)}`, sequencia: i,
      dataVenda: new Date("2026-10-14T10:00:00Z"), tipoDocumento: 1, tipoDocumentoClass: "VENDA", naturezaVenda: "NORMAL", externalProductId: 9000 + (i % 50), produtoId: mapa1.get(6100000 + (i % 50))!,
      isNonStockService: false, quantidade: 1 + (i % 3), pvpUnitario: 10, valorLinha: 10 * (1 + (i % 3)), ivaValor: 2.3, descontoValor: 0, comparticipacao1: 0, comparticipacao2: 0, entidadeId: null, rawJson: { i },
    }));
    await bulk.bulkUpsertSalesLines(prisma, linhas);
    const v1 = await estado();
    await bulk.bulkUpsertSalesLines(prisma, linhas); // o servidor processou e a resposta perdeu-se
    await bulk.bulkUpsertSalesLines(prisma, linhas);
    const v2 = await estado();
    check(v1.n.vendas === 80 && v2.n.vendas === 80 && v1.vendas === v2.vendas, "80 linhas de venda, sem duplicados e com os mesmos valores");

    // ── PipelineRun por idempotencyKey (como o handler /api/admin/pipeline/record) ──
    secao("PipelineRun: upsert por idempotencyKey");
    const key = `daily-pipeline:${farm.id}:2026-10-14:2026-10-15T02:00:00.000Z`;
    const dados = (status: string) => ({ farmaciaId: farm.id, kind: "daily-pipeline", status, startedAt: new Date("2026-10-15T02:00:00Z"), finishedAt: new Date("2026-10-15T02:03:00Z"), durationMs: 180000, dateRef: "2026-10-14", errorMessage: null, triggeredBy: "agent", idempotencyKey: key, details: { dailyDate: "2026-10-14" } });
    const gravar = (status: string) => prisma.pipelineRun.upsert({
      where: { idempotencyKey: key }, create: dados(status),
      update: { status, finishedAt: new Date("2026-10-15T02:03:00Z"), durationMs: 180000, errorMessage: null, details: { dailyDate: "2026-10-14" } },
      select: { id: true, createdAt: true, updatedAt: true },
    });
    const r1 = await gravar("OK");
    const r2 = await gravar("OK");
    const r3 = await gravar("OK");
    check((await prisma.pipelineRun.count({ where: { idempotencyKey: key } })) === 1 && r1.id === r2.id && r2.id === r3.id, "a repetição do registo reutiliza a MESMA linha (1 PipelineRun)");
    // uma execução independente (outra hora de arranque) é outro registo — o audit log preserva-se
    await prisma.pipelineRun.create({ data: { ...dados("ERROR"), idempotencyKey: `daily-pipeline:${farm.id}:2026-10-14:2026-10-15T03:00:00.000Z` } });
    check((await prisma.pipelineRun.count()) === 2, "execuções independentes continuam a ter registos distintos");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
