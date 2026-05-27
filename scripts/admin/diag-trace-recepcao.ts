/**
 * scripts/admin/diag-trace-recepcao.ts
 *
 * Trace ponta-a-ponta de uma receção: ERP → Agent → Staging → Compra → Extrato.
 * Read-only. Output estruturado por etapa. NÃO depende do ERP — investiga o
 * lado SaaS (staging/Compra/ProdutoFarmacia) e infere o ponto de quebra.
 *
 *   npx tsx scripts/admin/diag-trace-recepcao.ts \
 *     --tenant grupo-silveira --cnp 8168518 \
 *     --target-date 2026-05-14 --target-doc 62428
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const j = (rows: unknown) =>
  JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2);

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      cnp: { type: "string" },
      "target-date": { type: "string" },
      "target-doc": { type: "string" },
    },
    strict: true,
  });
  const slug = values.tenant ?? "grupo-silveira";
  const cnp = Number(values.cnp ?? "8168518");
  const targetDate = values["target-date"] ?? "2026-05-14";
  const targetDoc = values["target-doc"] ? Number(values["target-doc"]) : null;

  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`tenant ${slug} não existe`);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  try {
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`TRACE  tenant=${slug}  cnp=${cnp}  targetDate=${targetDate}  doc=${targetDoc ?? "—"}`);
    console.log(`══════════════════════════════════════════════════════════════════════\n`);

    // ── ETAPA 0 : produto + mapping ProdutoFarmacia ─────────────────
    const prod = await prisma.$queryRaw<Array<{ id: string; designacao: string }>>(
      Prisma.sql`SELECT id, designacao FROM "Produto" WHERE cnp = ${cnp}`,
    );
    if (prod.length === 0) {
      console.log("✗ Produto não existe — abortar.");
      return;
    }
    const produtoId = prod[0].id;
    console.log(`▶ ETAPA 0 — Produto canónico:`);
    console.log(`  produtoId=${produtoId}  designacao="${prod[0].designacao}"\n`);

    const pfs = await prisma.$queryRaw<
      Array<{ farmaciaId: string; farmacia: string; extId: number | null; ultCompra: Date | null; stock: number | null }>
    >(Prisma.sql`
      SELECT pf."farmaciaId", f.nome AS farmacia, pf."externalProductId" AS "extId",
             pf."dataUltimaCompra" AS "ultCompra", pf."stockAtual"::float AS stock
      FROM "ProdutoFarmacia" pf JOIN "Farmacia" f ON f.id = pf."farmaciaId"
      WHERE pf."produtoId" = ${produtoId} ORDER BY f.nome`);
    console.log(`  ProdutoFarmacia (mapping CodigoID ↔ canónico):`);
    for (const p of pfs) {
      console.log(`    ${p.farmacia.padEnd(22)} extId=${String(p.extId).padEnd(5)} ` +
        `stock=${p.stock ?? "—"}  ultCompra(ERP scalar)=${p.ultCompra?.toISOString().slice(0,10) ?? "—"}`);
    }
    const extIds = [...new Set(pfs.map((p) => p.extId).filter((x): x is number => x != null))];
    console.log(`  externalProductId(s)=${extIds.join(", ")}\n`);

    // ── ETAPA 1 : ERP (não acessível directo daqui) ─────────────────
    console.log(`▶ ETAPA 1 — ERP (SPharm SQL Server):`);
    console.log(`  Inacessível directamente daqui. Evidência operador: docs 62010/62162/62271/62428`);
    console.log(`  em 20/04, 29/04, 06/05, 14/05 de 2026. (Confirmação tem que sair do agent dry-run.)\n`);

    // ── ETAPA 2 : Staging — visão GLOBAL da ingestão ─────────────────
    console.log(`▶ ETAPA 2 — StagingCompraRawLine (visão global):`);
    const stagingGlobal = await prisma.$queryRaw<
      Array<{ n: number; minD: Date; maxD: Date; minIng: Date; maxIng: Date; nBatches: number }>
    >(Prisma.sql`
      SELECT COUNT(*)::int n,
             MIN("dataRecepcao") "minD", MAX("dataRecepcao") "maxD",
             MIN("ingestedAt") "minIng", MAX("ingestedAt") "maxIng",
             COUNT(DISTINCT "ingestBatchId")::int "nBatches"
      FROM "StagingCompraRawLine"`);
    console.log(`  rows=${stagingGlobal[0].n}  batches=${stagingGlobal[0].nBatches}`);
    console.log(`  dataRecepcao  : ${stagingGlobal[0].minD?.toISOString().slice(0,10)} → ${stagingGlobal[0].maxD?.toISOString().slice(0,10)}`);
    console.log(`  ingestedAt    : ${stagingGlobal[0].minIng?.toISOString().slice(0,19)} → ${stagingGlobal[0].maxIng?.toISOString().slice(0,19)}\n`);

    const stagingByFarm = await prisma.$queryRaw<
      Array<{ farmacia: string; n: number; minD: Date; maxD: Date }>
    >(Prisma.sql`
      SELECT f.nome AS farmacia, COUNT(*)::int n,
             MIN(s."dataRecepcao") "minD", MAX(s."dataRecepcao") "maxD"
      FROM "StagingCompraRawLine" s JOIN "Farmacia" f ON f.id = s."farmaciaId"
      GROUP BY 1 ORDER BY 1`);
    console.log(`  Por farmácia:`);
    for (const r of stagingByFarm) {
      console.log(`    ${r.farmacia.padEnd(22)} rows=${String(r.n).padEnd(6)} ` +
        `${r.minD?.toISOString().slice(0,10)} → ${r.maxD?.toISOString().slice(0,10)}`);
    }
    console.log("");

    const batches = await prisma.$queryRaw<
      Array<{ batchId: string; n: number; minD: Date; maxD: Date; ingAt: Date }>
    >(Prisma.sql`
      SELECT "ingestBatchId" AS "batchId", COUNT(*)::int n,
             MIN("dataRecepcao") "minD", MAX("dataRecepcao") "maxD",
             MIN("ingestedAt") "ingAt"
      FROM "StagingCompraRawLine"
      GROUP BY 1 ORDER BY "ingAt" DESC LIMIT 10`);
    console.log(`  Últimos batches (mais recentes em cima):`);
    for (const b of batches) {
      console.log(`    ${b.batchId.padEnd(28)} rows=${String(b.n).padEnd(6)} ` +
        `${b.minD?.toISOString().slice(0,10)}→${b.maxD?.toISOString().slice(0,10)} ` +
        `(ingerido em ${b.ingAt?.toISOString().slice(0,19)})`);
    }
    console.log("");

    // Staging > 2024-10-29 globalmente? (qualquer produto)
    const stagingPost = await prisma.$queryRaw<Array<{ n: number; maxD: Date | null }>>(Prisma.sql`
      SELECT COUNT(*)::int n, MAX("dataRecepcao") "maxD"
      FROM "StagingCompraRawLine" WHERE "dataRecepcao" >= '2024-11-01'`);
    console.log(`  Linhas de staging com dataRecepcao ≥ 2024-11-01 (QUALQUER produto): ${stagingPost[0].n}`);
    console.log(`  → ${stagingPost[0].n === 0 ? "ZERO. Confirma que o agent nunca leu pós-Out/2024." : "EXISTE — investigar."}\n`);

    // ── ETAPA 3 : Staging para o CNP/extIds — coverage ───────────────
    console.log(`▶ ETAPA 3 — StagingCompraRawLine PARA CNP ${cnp} (extIds=${extIds.join(",")}):`);
    if (extIds.length > 0) {
      const stagingProd = await prisma.$queryRaw<
        Array<{ farmacia: string; n: number; minD: Date; maxD: Date }>
      >(Prisma.sql`
        SELECT f.nome AS farmacia, COUNT(*)::int n,
               MIN(s."dataRecepcao") "minD", MAX(s."dataRecepcao") "maxD"
        FROM "StagingCompraRawLine" s JOIN "Farmacia" f ON f.id = s."farmaciaId"
        WHERE s."externalCodigoId" = ANY(${extIds})
        GROUP BY 1 ORDER BY 1`);
      for (const r of stagingProd) {
        console.log(`    ${r.farmacia.padEnd(22)} rows=${String(r.n).padEnd(4)} ` +
          `${r.minD?.toISOString().slice(0,10)} → ${r.maxD?.toISOString().slice(0,10)}`);
      }

      // 4 receções específicas: 62010, 62162, 62271, 62428 (NRecepcao OU Recepcao ID)
      const docs = [62010, 62162, 62271, 62428];
      const stagingDocs = await prisma.$queryRaw<
        Array<{ recId: number; nRec: number; dataR: Date; codId: number; qt: number }>
      >(Prisma.sql`
        SELECT "externalReceptionId" AS "recId", "externalNRecepcao" AS "nRec",
               "dataRecepcao" AS "dataR", "externalCodigoId" AS "codId", quantidade AS qt
        FROM "StagingCompraRawLine"
        WHERE ("externalReceptionId" = ANY(${docs}) OR "externalNRecepcao" = ANY(${docs}))
           AND "externalCodigoId" = ANY(${extIds})
        ORDER BY "dataRecepcao"`);
      console.log(`  Receções específicas (62010/62162/62271/62428) p/ este produto:`);
      console.log(`  → ${stagingDocs.length === 0 ? "NENHUMA encontrada em staging." : j(stagingDocs)}\n`);
    }

    // ── ETAPA 4 : Compra final — visão por produto ───────────────────
    console.log(`▶ ETAPA 4 — Compra (final, agregada) p/ produtoId canónico:`);
    const compraGlobal = await prisma.$queryRaw<Array<{ n: number; minD: Date; maxD: Date }>>(
      Prisma.sql`SELECT COUNT(*)::int n, MIN(data) "minD", MAX(data) "maxD" FROM "Compra"`);
    console.log(`  Visão global: rows=${compraGlobal[0].n} ` +
      `${compraGlobal[0].minD?.toISOString().slice(0,10)} → ${compraGlobal[0].maxD?.toISOString().slice(0,10)}`);
    const compraProd = await prisma.$queryRaw<
      Array<{ farmacia: string; n: number; minD: Date; maxD: Date }>
    >(Prisma.sql`
      SELECT f.nome AS farmacia, COUNT(*)::int n,
             MIN(c.data) "minD", MAX(c.data) "maxD"
      FROM "Compra" c JOIN "Farmacia" f ON f.id = c."farmaciaId"
      WHERE c."produtoId" = ${produtoId}
      GROUP BY 1 ORDER BY 1`);
    console.log(`  P/ CNP ${cnp} (produtoId canónico):`);
    for (const r of compraProd) {
      console.log(`    ${r.farmacia.padEnd(22)} rows=${String(r.n).padEnd(4)} ` +
        `${r.minD?.toISOString().slice(0,10)} → ${r.maxD?.toISOString().slice(0,10)}`);
    }
    console.log("");

    // ── ETAPA 5 : Extrato — o que o loader vai ver para a janela default
    console.log(`▶ ETAPA 5 — getMovimentosProduto janela default (últimos 30d, today=${new Date().toISOString().slice(0,10)}):`);
    const win30 = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT COUNT(*)::int n FROM "Compra"
      WHERE "produtoId" = ${produtoId} AND data >= ${new Date(Date.now() - 30*86400000)}`);
    console.log(`  Compra count na janela: ${win30[0].n} (esperado 0 enquanto não houver re-ingest)\n`);

    // ── DIAGNÓSTICO FINAL ────────────────────────────────────────────
    console.log(`══════════════════════════════════════════════════════════════════════`);
    console.log(`DIAGNÓSTICO`);
    console.log(`══════════════════════════════════════════════════════════════════════`);
    const lastStagingD = stagingGlobal[0].maxD?.toISOString().slice(0,10);
    const lastStagingIng = stagingGlobal[0].maxIng?.toISOString().slice(0,19);
    const lastCompraD = compraGlobal[0].maxD?.toISOString().slice(0,10);
    console.log(`  Último dataRecepcao em staging      : ${lastStagingD}`);
    console.log(`  Último ingestedAt em staging        : ${lastStagingIng}`);
    console.log(`  Último data em Compra (agregado)    : ${lastCompraD}`);
    console.log(`  Linhas staging pós-2024-10-29       : ${stagingPost[0].n}`);
    console.log(``);
    if (stagingPost[0].n === 0) {
      console.log(`  → QUEBRA NA ETAPA 2 (Agent → Staging).`);
      console.log(`     O agent compras-upload nunca correu com janela cobrindo > ${lastStagingD}.`);
      console.log(`     ERP tem os dados; SaaS aceitaria-os; agent não os leu/enviou.`);
      console.log(``);
      console.log(`  CORREÇÃO OPERACIONAL (no posto do operador, agent local):`);
      console.log(`     run-compras-upload.bat --from 2024-10-30 --to ${new Date().toISOString().slice(0,10)}`);
      console.log(`     (depois aggregate-compras dispara automático; ou via SaaS endpoint)`);
    } else {
      console.log(`  → INVESTIGAR: há staging recente mas não chegou a Compra final.`);
      console.log(`     Pode ser orphan (extId não mapeia a produtoId) ou tipoDocumento excluído.`);
    }
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
