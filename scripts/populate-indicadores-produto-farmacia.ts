/**
 * scripts/populate-indicadores-produto-farmacia.ts
 *
 * LIVE upsert dos 11 indicadores em `IndicadoresProdutoFarmacia`.
 * Idempotente — re-executar sobre a mesma BD não dobra dados.
 *
 * Política:
 *   · Popula APENAS os 8 campos hoje disponíveis. Os 3 bloqueados
 *     (`diasSemVenda`, `ultimoPrecoCompra`, `ultimoFornecedorId`) ficam
 *     a null no DB.
 *   · `valorStockParado` usa proxy "avgDaily90d ≤ 0 AND stock > 0"
 *     enquanto `diasSemVenda` não estiver disponível.
 *   · Bulk INSERT ... ON CONFLICT DO UPDATE em batches de 500 (raw SQL).
 *   · `dataCalculo = NOW()` em cada upsert.
 *
 * Tenant-safe: `--tenant=<slug>` resolve via control plane; default
 * `legacyPrisma`. Observabilidade: `--record-sync-run` escreve linha em
 * SyncRun (control plane). Ver `notes/fase1-execution-progress.md`.
 *
 * Uso:
 *   # Dry-run (mostra plano, não escreve):
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts --dry-run
 *
 *   # Live (escreve):
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts
 *
 *   # Live + observabilidade:
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts --record-sync-run
 *
 *   # Tenant-aware:
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts --tenant=castelo
 *
 *   # Filtrar a uma farmácia:
 *   npx tsx scripts/populate-indicadores-produto-farmacia.ts --farmacia=<id>
 */

import "dotenv/config";
import { nanoid } from "nanoid";
import { legacyPrisma } from "../lib/prisma";
import type { PrismaClient } from "../generated/prisma/client";
import { Prisma } from "../generated/prisma/client";
import {
  assignAbcInPlace,
  computeIpfRow,
  type IpfOutput,
} from "../lib/operational/ipf-calculator";

// Tenant-safe: prisma resolvido em main()
let prisma: PrismaClient = legacyPrisma;
let runId: string | null = null;

const UPSERT_BATCH_SIZE = 500;

type Args = {
  dryRun: boolean;
  tenantSlug: string | null;
  recordSyncRun: boolean;
  farmaciaId: string | null;
  /**
   * Threshold de cobertura (em dias) para classificar produtos parados.
   * Default 90. Pode ser ajustado para experimentar.
   */
  paradoThresholdDays: number;
};

function parseArgs(): Args {
  const out: Args = {
    dryRun: false,
    tenantSlug: null,
    recordSyncRun: false,
    farmaciaId: null,
    paradoThresholdDays: 90,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--record-sync-run") out.recordSyncRun = true;
    else if (a.startsWith("--tenant=")) out.tenantSlug = a.split("=")[1] ?? null;
    else if (a.startsWith("--farmacia=")) out.farmaciaId = a.split("=")[1] ?? null;
    else if (a.startsWith("--parado-threshold=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0) out.paradoThresholdDays = n;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const args = parseArgs();
  const t0 = Date.now();

  // Tenant resolution
  if (args.tenantSlug) {
    const { getTenantPrismaOrLegacy } = await import("../lib/tenant-registry");
    prisma = await getTenantPrismaOrLegacy(args.tenantSlug);
  }
  const slugForLedger = args.tenantSlug ?? "legacy";

  // SyncRun observability
  if (args.recordSyncRun) {
    const { startSyncRun } = await import("../lib/sync/sync-run");
    const handle = await startSyncRun({
      tenantSlug: slugForLedger,
      source: "ipf-populate",
      meta: {
        dryRun: args.dryRun,
        farmaciaId: args.farmaciaId,
        paradoThresholdDays: args.paradoThresholdDays,
      },
    });
    runId = handle.id;
  }

  console.log("─".repeat(78));
  console.log(`Populate IndicadoresProdutoFarmacia (${args.dryRun ? "DRY-RUN" : "LIVE"})`);
  console.log("─".repeat(78));
  console.log(`  tenant:               ${args.tenantSlug ?? "(legacy)"}`);
  console.log(`  farmacia:             ${args.farmaciaId ?? "(todas activas)"}`);
  console.log(`  paradoThresholdDays:  ${args.paradoThresholdDays}`);
  if (runId) console.log(`  syncRunId:            ${runId}`);

  // ── 1. Farmácias activas ───────────────────────────────────────────────
  const farmacias = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: { not: "Farmácia Teste" },
      ...(args.farmaciaId ? { id: args.farmaciaId } : {}),
    },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length === 0) {
    console.log("Nenhuma farmácia activa. Sair.");
    return;
  }
  console.log(`\n[1/7] Farmácias activas: ${farmaciaIds.length} (${farmacias.map((f) => f.nome).join(", ")})`);

  // ── 2. ProdutoFarmacia ─────────────────────────────────────────────────
  type PfRow = {
    produtoId: string;
    farmaciaId: string;
    stockAtual: number;
    puc: number | null;
    pmc: number | null;
    dataUltimaVenda: Date | null;
  };
  const pfRows = await prisma.$queryRaw<PfRow[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      pf."stockAtual"::float AS "stockAtual",
      pf.puc::float          AS puc,
      pf.pmc::float          AS pmc,
      pf."dataUltimaVenda"
    FROM "ProdutoFarmacia" pf
    WHERE pf."flagRetirado" = false
      AND pf."farmaciaId" = ANY(${farmaciaIds})
  `);
  console.log(`[2/7] ProdutoFarmacia (vivos): ${pfRows.length}`);

  // ── 3. Venda diária 30d / 90d (provavelmente vazio) ────────────────────
  type SalesD = { produtoId: string; farmaciaId: string; qty: number; valor: number };
  const sales30dVenda = await prisma.$queryRaw<SalesD[]>(Prisma.sql`
    SELECT v."produtoId", v."farmaciaId",
           SUM(v.quantidade)::float AS qty,
           SUM(v."valorTotal")::float AS valor
    FROM "Venda" v
    WHERE v.data >= NOW() - INTERVAL '30 days'
      AND v."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY v."produtoId", v."farmaciaId"
  `);
  const sales90dVenda = await prisma.$queryRaw<SalesD[]>(Prisma.sql`
    SELECT v."produtoId", v."farmaciaId",
           SUM(v.quantidade)::float AS qty,
           SUM(v."valorTotal")::float AS valor
    FROM "Venda" v
    WHERE v.data >= NOW() - INTERVAL '90 days'
      AND v."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY v."produtoId", v."farmaciaId"
  `);
  const vendaDiariaDisponivel = sales90dVenda.length > 0;
  console.log(`[3/7] Venda diária: 30d=${sales30dVenda.length}  90d=${sales90dVenda.length}  disponível=${vendaDiariaDisponivel}`);

  // ── 4. VendaMensal 3m / 12m ────────────────────────────────────────────
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const period3m = periodEnd - 3;
  const period12m = periodEnd - 12;

  type SalesM = { produtoId: string; farmaciaId: string; qty: number; valor: number };
  const sales3m = await prisma.$queryRaw<SalesM[]>(Prisma.sql`
    SELECT vm."produtoId", vm."farmaciaId",
           SUM(vm.quantidade)::float AS qty,
           SUM(vm."valorTotal")::float AS valor
    FROM "VendaMensal" vm
    WHERE (vm.ano * 12 + vm.mes) >= ${period3m}
      AND (vm.ano * 12 + vm.mes) < ${periodEnd}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."produtoId", vm."farmaciaId"
  `);
  const sales12m = await prisma.$queryRaw<SalesM[]>(Prisma.sql`
    SELECT vm."produtoId", vm."farmaciaId",
           SUM(vm.quantidade)::float AS qty,
           SUM(vm."valorTotal")::float AS valor
    FROM "VendaMensal" vm
    WHERE (vm.ano * 12 + vm.mes) >= ${period12m}
      AND (vm.ano * 12 + vm.mes) < ${periodEnd}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."produtoId", vm."farmaciaId"
  `);
  console.log(`[4/7] VendaMensal: 3m=${sales3m.length}  12m=${sales12m.length}`);

  // ── 5. Compra (última por par) — provavelmente vazio ───────────────────
  type LastCompra = { produtoId: string; farmaciaId: string; precoUnitario: number | null; fornecedorId: string | null };
  const lastCompra = await prisma.$queryRaw<LastCompra[]>(Prisma.sql`
    WITH ranked AS (
      SELECT c."produtoId", c."farmaciaId",
             c."precoUnitario"::float AS "precoUnitario",
             c."fornecedorId",
             ROW_NUMBER() OVER (PARTITION BY c."produtoId", c."farmaciaId" ORDER BY c.data DESC) AS rn
      FROM "Compra" c
      WHERE c."farmaciaId" = ANY(${farmaciaIds})
    )
    SELECT "produtoId", "farmaciaId", "precoUnitario", "fornecedorId"
    FROM ranked WHERE rn = 1
  `);
  console.log(`[5/7] Compra (última por par): ${lastCompra.length}`);

  // ── 6. Construir indicators via calculator ─────────────────────────────
  const k = (p: string, f: string) => `${p}:${f}`;
  const idx30 = new Map(sales30dVenda.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idx90 = new Map(sales90dVenda.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idx3m = new Map(sales3m.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idx12m = new Map(sales12m.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idxCompra = new Map(lastCompra.map((r) => [k(r.produtoId, r.farmaciaId), r]));

  console.log(`[6/7] A calcular ${pfRows.length} indicadores...`);
  const rows: IpfOutput[] = [];
  for (const pf of pfRows) {
    const key = k(pf.produtoId, pf.farmaciaId);
    const s30 = idx30.get(key);
    const s90 = idx90.get(key);
    const s3 = idx3m.get(key);
    const s12 = idx12m.get(key);
    const compra = idxCompra.get(key);
    const custo = pf.puc ?? pf.pmc ?? 0;

    rows.push(
      computeIpfRow(
        {
          produtoId: pf.produtoId,
          farmaciaId: pf.farmaciaId,
          stockAtual: toF(pf.stockAtual),
          custoUnitario: custo,
          vendaQty30dDiaria: s30 ? toF(s30.qty) : 0,
          vendaQty90dDiaria: s90 ? toF(s90.qty) : 0,
          vendaValor90dDiaria: s90 ? toF(s90.valor) : 0,
          vendaMensalQty3m: s3 ? toF(s3.qty) : 0,
          vendaMensalQty12m: s12 ? toF(s12.qty) : 0,
          vendaMensalValor3m: s3 ? toF(s3.valor) : 0,
          dataUltimaVenda: pf.dataUltimaVenda,
          ultimoPrecoCompra: compra?.precoUnitario ?? null,
          ultimoFornecedorId: compra?.fornecedorId ?? null,
        },
        {
          vendaDiariaDisponivel,
          paradoThresholdDays: args.paradoThresholdDays,
        },
      ),
    );
  }
  assignAbcInPlace(rows);
  console.log(`    indicadores calculados em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── 7. Upsert em batches via raw SQL ───────────────────────────────────
  if (args.dryRun) {
    console.log(`\n[7/7] DRY-RUN — sem writes. Plano:`);
    console.log(`        - linhas a upsertar:  ${rows.length}`);
    console.log(`        - batches (${UPSERT_BATCH_SIZE}/lote): ${Math.ceil(rows.length / UPSERT_BATCH_SIZE)}`);
    summarize(rows);
    if (runId) {
      const { completeSyncRun } = await import("../lib/sync/sync-run");
      await completeSyncRun(runId, { recordsRead: rows.length });
    }
    console.log(`\n[end] DRY-RUN concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    return;
  }

  console.log(`\n[7/7] A upsertar ${rows.length} linhas em batches de ${UPSERT_BATCH_SIZE}...`);
  let upserted = 0;
  let failed = 0;
  const tWrite = Date.now();

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
    try {
      await upsertBatch(chunk);
      upserted += chunk.length;
    } catch (err) {
      failed += chunk.length;
      console.warn(
        `    [erro batch i=${i}] ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
    const done = upserted + failed;
    const rate = done / Math.max(1, (Date.now() - tWrite) / 1000);
    const eta = (rows.length - done) / Math.max(0.001, rate);
    console.log(
      `    [${String(Math.ceil(done / UPSERT_BATCH_SIZE)).padStart(3)}/${Math.ceil(rows.length / UPSERT_BATCH_SIZE)}]` +
        ` upserted=${upserted} failed=${failed} rate=${rate.toFixed(0)}/s eta=${eta.toFixed(0)}s`,
    );
  }

  console.log(`\n[summary] upserted=${upserted} failed=${failed} elapsed=${((Date.now() - tWrite) / 1000).toFixed(1)}s`);
  summarize(rows);

  if (runId) {
    const { completeSyncRun } = await import("../lib/sync/sync-run");
    await completeSyncRun(runId, {
      recordsRead: pfRows.length,
      recordsInserted: upserted, // primeira corrida; subsequentes serão maioritariamente updates
      recordsFailed: failed,
    });
  }

  console.log(`\n[end] LIVE concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

/**
 * Upsert idempotente via raw SQL: bulk INSERT ... ON CONFLICT
 * (produtoId, farmaciaId) DO UPDATE. cuids gerados client-side via
 * nanoid; só usados quando a row é nova (caso contrário o ON CONFLICT
 * mantém o id existente).
 *
 * Política: campos null em IpfOutput são gravados como NULL (não
 * preservam valor anterior). Isto é deliberado: representa o cálculo
 * actual da fonte. Quando a fonte estiver vazia (Venda/Compra), o
 * campo continuará null em re-execuções.
 */
async function upsertBatch(rows: IpfOutput[]): Promise<void> {
  if (rows.length === 0) return;
  // VALUES dinâmicos via Prisma.sql array join. Tipos numéricos com
  // null preservado; enums via cast explícito.
  const valuesSql = rows.map((r) => {
    const id = "ipf_" + nanoid(14);
    return Prisma.sql`(
      ${id},
      ${r.produtoId},
      ${r.farmaciaId},
      ${r.mediaVendasDiarias30d},
      ${r.mediaVendasDiarias90d},
      ${r.mediaVendasMensais3m},
      ${r.mediaVendasMensais12m},
      ${r.diasStockRestante},
      ${r.diasSemVenda},
      ${r.ultimoPrecoCompra},
      ${r.ultimoFornecedorId},
      ${r.classificacaoABC}::"ClassificacaoABC",
      ${r.classificacaoRotacao}::"ClassificacaoRotacao",
      ${r.valorStockParado},
      NOW()
    )`;
  });

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "IndicadoresProdutoFarmacia" (
      "id", "produtoId", "farmaciaId",
      "mediaVendasDiarias30d", "mediaVendasDiarias90d",
      "mediaVendasMensais3m",  "mediaVendasMensais12m",
      "diasStockRestante",     "diasSemVenda",
      "ultimoPrecoCompra",     "ultimoFornecedorId",
      "classificacaoABC",      "classificacaoRotacao",
      "valorStockParado",      "dataCalculo"
    )
    VALUES ${Prisma.join(valuesSql)}
    ON CONFLICT ("produtoId", "farmaciaId") DO UPDATE SET
      "mediaVendasDiarias30d" = EXCLUDED."mediaVendasDiarias30d",
      "mediaVendasDiarias90d" = EXCLUDED."mediaVendasDiarias90d",
      "mediaVendasMensais3m"  = EXCLUDED."mediaVendasMensais3m",
      "mediaVendasMensais12m" = EXCLUDED."mediaVendasMensais12m",
      "diasStockRestante"     = EXCLUDED."diasStockRestante",
      "diasSemVenda"          = EXCLUDED."diasSemVenda",
      "ultimoPrecoCompra"     = EXCLUDED."ultimoPrecoCompra",
      "ultimoFornecedorId"    = EXCLUDED."ultimoFornecedorId",
      "classificacaoABC"      = EXCLUDED."classificacaoABC",
      "classificacaoRotacao"  = EXCLUDED."classificacaoRotacao",
      "valorStockParado"      = EXCLUDED."valorStockParado",
      "dataCalculo"           = NOW()
  `);
}

function summarize(rows: IpfOutput[]): void {
  const populaveis = {
    mediaVendasDiarias30d: rows.filter((r) => r.mediaVendasDiarias30d !== null).length,
    mediaVendasDiarias90d: rows.filter((r) => r.mediaVendasDiarias90d !== null).length,
    mediaVendasMensais3m: rows.filter((r) => r.mediaVendasMensais3m !== null).length,
    mediaVendasMensais12m: rows.filter((r) => r.mediaVendasMensais12m !== null).length,
    diasStockRestante: rows.filter((r) => r.diasStockRestante !== null).length,
    diasSemVenda: rows.filter((r) => r.diasSemVenda !== null).length,
    ultimoPrecoCompra: rows.filter((r) => r.ultimoPrecoCompra !== null).length,
    ultimoFornecedorId: rows.filter((r) => r.ultimoFornecedorId !== null).length,
    valorStockParado: rows.filter((r) => (r.valorStockParado ?? 0) > 0).length,
  };
  const total = rows.length;
  console.log(`\n  Campos populáveis (não-null):`);
  for (const [campo, n] of Object.entries(populaveis)) {
    const pct = total > 0 ? (n / total) * 100 : 0;
    console.log(`    ${campo.padEnd(28)} ${String(n).padStart(6)}  (${pct.toFixed(1)}%)`);
  }

  const abc = { A: 0, B: 0, C: 0, NAO_CLASSIFICADO: 0 };
  for (const r of rows) abc[r.classificacaoABC]++;
  console.log(`\n  classificacaoABC: A=${abc.A}  B=${abc.B}  C=${abc.C}  NAO_CLASSIFICADO=${abc.NAO_CLASSIFICADO}`);

  const rot = { NORMAL: 0, ATENCAO: 0, SEM_ROTACAO: 0 };
  for (const r of rows) rot[r.classificacaoRotacao]++;
  console.log(`  classificacaoRotacao: NORMAL=${rot.NORMAL}  ATENCAO=${rot.ATENCAO}  SEM_ROTACAO=${rot.SEM_ROTACAO}`);

  const totalParado = rows.reduce((s, r) => s + (r.valorStockParado ?? 0), 0);
  console.log(`  valorStockParado total: ${totalParado.toFixed(2)} € em ${populaveis.valorStockParado} produtos`);
}

main()
  .catch(async (err) => {
    console.error("[fatal]", err);
    if (runId) {
      try {
        const { failSyncRun } = await import("../lib/sync/sync-run");
        await failSyncRun(runId, err);
      } catch (closeErr) {
        console.error("[fatal] failSyncRun também falhou:", closeErr);
      }
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
