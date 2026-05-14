/**
 * scripts/aggregate-vendamensal.ts
 *
 * CLI thin wrapper sobre `lib/aggregate/vendamensal.ts`. A lógica de
 * preflight + agregação + write vive na lib partilhada para ser
 * reutilizada pelo endpoint /api/admin/pipeline/aggregate-month.
 *
 * Responsabilidades deste ficheiro:
 *   · parse CLI args
 *   · resolver tenant via control-plane + construir PrismaClient
 *   · chamar `aggregateMonth(prisma, opts)`
 *   · render preflight + top products + sample raw-vs-agg + totals
 *
 * Uso:
 *   npm run aggregate:vendamensal -- --tenant demo-neon --month 2024-01 --dry-run
 *   npm run aggregate:vendamensal -- --tenant demo-neon --month 2024-01 --write
 *   (default sem flag = --dry-run)
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
import {
  AggregateAbortError,
  ORIGEM_AGREGACAO,
  aggregateMonth,
  parseMonth,
  type AggRow,
  type MonthRange,
  type PreflightStats,
} from "@/lib/aggregate/vendamensal";

type Args = {
  tenant?: string;
  month?: string;
  dryRun: boolean;
  write: boolean;
  allowOrphans: boolean;
};

function parseCmdArgs(): Args {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      month: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      "allow-orphans": { type: "boolean", default: false },
    },
    strict: true,
  });
  return {
    tenant: values.tenant,
    month: values.month,
    dryRun: values["dry-run"] ?? false,
    write: values.write ?? false,
    allowOrphans: values["allow-orphans"] ?? false,
  };
}

type OrphanSample = {
  externalProductId: number;
  rows: number;
  classes: string[];
};

async function topOrphanProducts(
  prisma: PrismaClient,
  range: MonthRange,
  isNonStockService: boolean,
  limit = 10
): Promise<OrphanSample[]> {
  const rows = await prisma.$queryRaw<
    Array<{ externalProductId: number; rows: bigint | number; classes: string }>
  >`
    SELECT
      "externalProductId",
      COUNT(*) AS "rows",
      STRING_AGG(DISTINCT "tipoDocumentoClass", ',') AS "classes"
    FROM "IngestVendaLinhaRaw"
    WHERE "produtoId" IS NULL
      AND "isNonStockService" = ${isNonStockService}
      AND "dataVenda" >= ${range.fromInclusive}
      AND "dataVenda" <  ${range.toExclusive}
    GROUP BY "externalProductId"
    ORDER BY COUNT(*) DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    externalProductId: Number(r.externalProductId),
    rows: Number(r.rows),
    classes: (r.classes ?? "").split(",").filter((s) => s !== ""),
  }));
}

function renderOrphanSamples(label: string, samples: OrphanSample[]): void {
  if (samples.length === 0) return;
  console.log(`  ${label}:`);
  for (const s of samples) {
    const classes = s.classes.length > 0 ? ` [${s.classes.join(",")}]` : "";
    console.log(`    extId=${String(s.externalProductId).padStart(7)}  rows=${String(s.rows).padStart(3)}${classes}`);
  }
}

async function renderPreflight(
  prisma: PrismaClient,
  range: MonthRange,
  stats: PreflightStats
): Promise<void> {
  console.log("Counts raw no mês:");
  console.log(`  raw lines             : ${stats.rawLines}`);
  console.log(`  produtos distintos    : ${stats.produtosDistinct}`);
  console.log(`  atendimentos distintos: ${stats.atendimentosDistinct}`);
  console.log(`  farmácias distintas   : ${stats.farmaciasDistinct}`);
  console.log(`  UNKNOWN               : ${stats.unknowns}`);
  console.log("");
  console.log("Rows com produtoId IS NULL:");
  console.log(`  total                       : ${stats.orphans}`);
  console.log(`  ├─ non-stock services       : ${stats.nonStockServices}   (excluídos auto da agregação)`);
  console.log(`  └─ operational orphans      : ${stats.operationalOrphans}   (bloqueia agregação sem --allow-orphans)`);
  if (stats.nonStockServices > 0 || stats.operationalOrphans > 0) {
    const [nonStockTop, opOrphanTop] = await Promise.all([
      topOrphanProducts(prisma, range, true),
      topOrphanProducts(prisma, range, false),
    ]);
    console.log("");
    renderOrphanSamples("non-stock services (top)", nonStockTop);
    renderOrphanSamples("operational orphans (top)", opOrphanTop);
  }
  console.log("");
  console.log("Distribuição por tipoDocumentoClass:");
  for (const [k, v] of Object.entries(stats.byClass).sort()) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log("");
}

function fmtMoney(n: Prisma.Decimal | number): string {
  const v = typeof n === "number" ? n : n.toNumber();
  return v.toFixed(2).padStart(12, " ");
}

function fmtQty(n: Prisma.Decimal | number): string {
  const v = typeof n === "number" ? n : n.toNumber();
  return v.toFixed(3).padStart(10, " ");
}

async function renderTopProducts(prisma: PrismaClient, rows: AggRow[]): Promise<void> {
  const top = rows.slice(0, 20);
  const ids = top.map((r) => r.produtoId);
  const produtos = await prisma.produto.findMany({
    where: { id: { in: ids } },
    select: { id: true, cnp: true, designacao: true },
  });
  const byId = new Map(produtos.map((p) => [p.id, p]));

  console.log("Top 20 produtos por valorBruto DESC:");
  console.log("  #   CNP       Designacao                                       Qtd     ValorBruto  ValorPagoUtente  Comp        Linhas Atendimentos");
  console.log("  " + "─".repeat(120));
  for (const [i, r] of top.entries()) {
    const p = byId.get(r.produtoId);
    const desc = (p?.designacao ?? "(?)").slice(0, 48).padEnd(48);
    const cnp = String(p?.cnp ?? "?").padStart(7);
    console.log(
      `  ${String(i + 1).padStart(2)}  ${cnp}   ${desc}  ${fmtQty(r.quantidadeLiquida)} ${fmtMoney(r.valorBruto)} ${fmtMoney(r.valorPagoUtente)} ${fmtMoney(r.valorComparticipado)} ${String(r.linhasVenda).padStart(6)} ${String(r.atendimentos).padStart(12)}`
    );
  }
  console.log("");
}

async function renderSampleRawVsAgg(
  prisma: PrismaClient,
  range: MonthRange,
  rows: AggRow[]
): Promise<void> {
  const sample = rows.length <= 5 ? rows : [
    ...rows.slice(0, 2),
    ...rows.slice(Math.floor(rows.length / 2), Math.floor(rows.length / 2) + 1),
    ...rows.slice(-2),
  ];
  const ids = sample.map((r) => r.produtoId);
  const produtos = await prisma.produto.findMany({
    where: { id: { in: ids } },
    select: { id: true, cnp: true, designacao: true },
  });
  const byId = new Map(produtos.map((p) => [p.id, p]));

  console.log("Sample raw-vs-agregado (5 produtos):");
  for (const a of sample) {
    const p = byId.get(a.produtoId);
    console.log(`\n  produtoId=${a.produtoId}  cnp=${p?.cnp ?? "?"}  ${(p?.designacao ?? "?").slice(0, 50)}`);
    const rawByClass = await prisma.ingestVendaLinhaRaw.groupBy({
      by: ["tipoDocumentoClass"],
      where: {
        produtoId: a.produtoId,
        farmaciaId: a.farmaciaId,
        dataVenda: { gte: range.fromInclusive, lt: range.toExclusive },
      },
      _count: { _all: true },
    });
    console.log(`    RAW: ${rawByClass.map((r) => `${r.tipoDocumentoClass}=${r._count._all}`).join(", ") || "(none)"}`);
    console.log(
      `    AGG: qtd=${a.quantidadeLiquida.toFixed(3)} valorBruto=${a.valorBruto.toFixed(2)} valorPagoUtente=${a.valorPagoUtente.toFixed(2)} comp=${a.valorComparticipado.toFixed(2)} linhas=${a.linhasVenda} atend=${a.atendimentos}`
    );
  }
  console.log("");
}

function renderTotals(totals: {
  quantidadeLiquida: number;
  valorBruto: number;
  valorPagoUtente: number;
  valorComparticipado: number;
  linhasVenda: number;
  atendimentos: number;
}, rowCount: number): void {
  console.log("Totals agregados (mês):");
  console.log(`  rows VendaMensal a escrever : ${rowCount}`);
  console.log(`  quantidadeLiquida (Σ)       : ${totals.quantidadeLiquida.toFixed(3)}`);
  console.log(`  valorBruto         (Σ)       : ${totals.valorBruto.toFixed(2)} EUR`);
  console.log(`  valorPagoUtente    (Σ)       : ${totals.valorPagoUtente.toFixed(2)} EUR`);
  console.log(`  valorComparticipado (Σ)      : ${totals.valorComparticipado.toFixed(2)} EUR`);
  console.log(`  linhasVenda        (Σ)       : ${totals.linhasVenda}`);
  console.log(`  atendimentos       (Σ)       : ${totals.atendimentos}  (nota: contagem global, não distintos por produto)`);
  console.log("");
}

async function main() {
  const args = parseCmdArgs();
  if (!args.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }
  if (!args.month) {
    console.error("✗ --month YYYY-MM obrigatório.");
    process.exit(1);
  }
  if (args.dryRun && args.write) {
    console.error("✗ --dry-run e --write são mutuamente exclusivos.");
    process.exit(1);
  }
  const mode: "dry-run" | "write" = args.write ? "write" : "dry-run";

  let range: MonthRange;
  try {
    range = parseMonth(args.month);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const tenant = await getTenantBySlug(args.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${args.tenant}" não existe.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant "${args.tenant}" em estado ${tenant.estado}.`);
    process.exit(1);
  }
  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  const t0 = Date.now();
  try {
    console.log("─".repeat(70));
    console.log(`aggregate-vendamensal — ${args.tenant} · ${args.month} · ${mode.toUpperCase()}`);
    console.log("─".repeat(70));
    console.log(`Intervalo: [${range.fromInclusive.toISOString().slice(0, 10)}, ${range.toExclusive.toISOString().slice(0, 10)})`);
    console.log(`Origem agregacao: ${ORIGEM_AGREGACAO}`);
    console.log("");

    let outcome;
    try {
      outcome = await aggregateMonth(prisma, {
        range,
        write: mode === "write",
        allowOrphans: args.allowOrphans,
      });
    } catch (err) {
      if (err instanceof AggregateAbortError) {
        console.error(`✗ Aborta [${err.code}]: ${err.message}`);
        if (err.code === "unknowns_present") {
          console.error(`  Caracteriza TipoDocs em falta via:`);
          console.error(`    npm run ingest:classify-tipodoc -- --tenant ${args.tenant} --tipo <N> --classe <classe>`);
          console.error(`    npm run ingest:reclassify-vendas -- --tenant ${args.tenant}`);
        }
        if (err.code === "operational_orphans_present") {
          console.error(`  Opções:`);
          console.error(`    a) Investigar com 'npm run ingest:list-orphans -- --tenant ${args.tenant}'`);
          console.error(`    b) Inspeccionar no ERP com 'run-inspect-codigoid.bat'`);
          console.error(`    c) Marcar IDs comprovadamente sem produto:`);
          console.error(`         npm run ingest:backfill-services -- --tenant ${args.tenant} --ids <csv> --write`);
          console.error(`    d) Passar --allow-orphans para ignorar`);
        }
        await prisma.$disconnect();
        process.exit(1);
      }
      throw err;
    }

    await renderPreflight(prisma, range, outcome.preflight);

    if (outcome.preflight.nonStockServices > 0) {
      console.log(`ℹ ${outcome.preflight.nonStockServices} linhas non-stock services excluídas auto da agregação.`);
    }
    if (outcome.preflight.operationalOrphans > 0 && args.allowOrphans) {
      console.log(`⚠ --allow-orphans: ${outcome.preflight.operationalOrphans} operational orphans vão ficar fora.\n`);
    }

    console.log(`▶ Agregação SQL: ${outcome.aggRows.length} (farmaciaId, produtoId) pairs\n`);
    renderTotals(outcome.totals, outcome.aggRows.length);
    if (outcome.aggRows.length > 0) {
      await renderTopProducts(prisma, outcome.aggRows);
      await renderSampleRawVsAgg(prisma, range, outcome.aggRows);
    }

    const wallMs = Date.now() - t0;
    if (mode === "dry-run") {
      console.log("─".repeat(70));
      console.log(`✓ DRY-RUN concluído em ${(wallMs / 1000).toFixed(1)}s. Nada escrito.`);
      console.log(`  Para aplicar: re-corre com --write em vez de --dry-run.`);
      await prisma.$disconnect();
      return;
    }
    console.log("─".repeat(70));
    console.log(`✓ WRITE concluído em ${(wallMs / 1000).toFixed(1)}s.`);
    console.log(`  deleted (origem=${ORIGEM_AGREGACAO}, ano=${range.ano}, mes=${range.mes}): ${outcome.deleted}`);
    console.log(`  inserted                                                : ${outcome.inserted}`);
    console.log("");
    console.log(`Próximo passo: validar visualmente o dashboard ou correr SQL`);
    console.log(`  SELECT COUNT(*), SUM("valorBruto"), SUM("linhasVenda")`);
    console.log(`    FROM "VendaMensal" WHERE ano=${range.ano} AND mes=${range.mes}`);
    console.log(`      AND "origemAgregacao" = '${ORIGEM_AGREGACAO}';`);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
