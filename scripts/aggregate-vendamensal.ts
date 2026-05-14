/**
 * scripts/aggregate-vendamensal.ts
 *
 * Agrega `IngestVendaLinhaRaw` → `VendaMensal` por mês para 1 tenant.
 * Idempotente via delete-then-insertMany scoped a (ano, mes,
 * farmaciaId) em transaction.
 *
 * Regras (mapping doc §11):
 *   · Fonte única: IngestVendaLinhaRaw
 *   · Inclui apenas tipoDocumentoClass ∈ {VENDA, DEVOLUCAO_ANULACAO}
 *   · Ignora UNKNOWN, IGNORE_TECHNICAL
 *   · Sinal: VENDA=+, DEVOLUCAO_ANULACAO=− (usando ABS dos valores)
 *   · Granularidade: (farmaciaId, produtoId, ano, mes)
 *
 * Validações antes de escrever:
 *   · Aborta se houver tipoDocumentoClass='UNKNOWN' no mês
 *   · Aborta se houver produtoId IS NULL no mês (excepto --allow-orphans)
 *
 * Uso:
 *   npm run aggregate:vendamensal -- --tenant demo-neon --month 2024-01 --dry-run
 *   npm run aggregate:vendamensal -- --tenant demo-neon --month 2024-01 --write
 *   (default sem flag = --dry-run)
 *
 * NÃO faz:
 *   · update incremental linha-a-linha
 *   · merge com outras fontes (overwrite scoped por farmaciaId+ano+mes)
 *   · alteração do staging IngestVendaLinhaRaw
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

const ORIGEM_AGREGACAO = "agent-bootstrap-staging";

// ─────────────────────────────────────────────────────────────────────
// CLI args + month parsing
// ─────────────────────────────────────────────────────────────────────

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

type MonthRange = { ano: number; mes: number; fromInclusive: Date; toExclusive: Date };

function parseMonthArg(monthArg: string): MonthRange {
  const m = /^(\d{4})-(\d{2})$/.exec(monthArg);
  if (!m) {
    throw new Error(`--month deve ser YYYY-MM (ex: 2024-01). Recebido: ${monthArg}`);
  }
  const ano = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10);
  if (mes < 1 || mes > 12) {
    throw new Error(`--month ${monthArg}: mês ${mes} fora do intervalo 1..12`);
  }
  // fromInclusive = primeiro dia do mês (UTC). toExclusive = primeiro
  // dia do mês seguinte. JS Date math trata Dec→Jan automaticamente.
  const fromInclusive = new Date(Date.UTC(ano, mes - 1, 1));
  const toExclusive = new Date(Date.UTC(ano, mes, 1));
  return { ano, mes, fromInclusive, toExclusive };
}

// ─────────────────────────────────────────────────────────────────────
// Pre-flight queries (validações + counts)
// ─────────────────────────────────────────────────────────────────────

type OrphanSample = {
  externalProductId: number;
  rows: number;
  classes: string[];
};

type PreflightStats = {
  rawLines: number;
  produtosDistinct: number;
  atendimentosDistinct: number;
  farmaciasDistinct: number;
  byClass: Record<string, number>;
  /// Total de rows com `produtoId IS NULL` (inclui serviços + orphans operacionais).
  orphans: number;
  /// Rows marcadas `isNonStockService = true` — serviços/taxas sem
  /// produto operacional (Stocks.[Processa_Stocks] = 0). Excluídos
  /// da agregação sem necessidade de `--allow-orphans`.
  nonStockServices: number;
  /// Rows com `produtoId IS NULL` E `isNonStockService = false`. Estes
  /// SIM bloqueiam agregação até `--allow-orphans` ou re-bootstrap.
  operationalOrphans: number;
  unknowns: number;
  /// Top externalProductIds órfãos operacionais (para diagnose).
  operationalOrphanProducts: OrphanSample[];
  /// Top externalProductIds marcados como non-stock services.
  nonStockServiceProducts: OrphanSample[];
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

async function preflight(prisma: PrismaClient, range: MonthRange): Promise<PreflightStats> {
  const where: Prisma.IngestVendaLinhaRawWhereInput = {
    dataVenda: { gte: range.fromInclusive, lt: range.toExclusive },
  };

  const [
    rawLines,
    classDist,
    orphans,
    nonStockServices,
    operationalOrphans,
    unknowns,
  ] = await Promise.all([
    prisma.ingestVendaLinhaRaw.count({ where }),
    prisma.ingestVendaLinhaRaw.groupBy({
      by: ["tipoDocumentoClass"],
      where,
      _count: { _all: true },
    }),
    prisma.ingestVendaLinhaRaw.count({ where: { ...where, produtoId: null } }),
    prisma.ingestVendaLinhaRaw.count({
      where: { ...where, produtoId: null, isNonStockService: true },
    }),
    prisma.ingestVendaLinhaRaw.count({
      where: { ...where, produtoId: null, isNonStockService: false },
    }),
    prisma.ingestVendaLinhaRaw.count({
      where: { ...where, tipoDocumentoClass: "UNKNOWN" },
    }),
  ]);

  // produtos distintos e atendimentos distintos via groupBy
  const [produtosG, atendG, farmaciasG, opOrphanTop, nonStockTop] =
    await Promise.all([
      prisma.ingestVendaLinhaRaw.findMany({
        where: { ...where, produtoId: { not: null } },
        select: { produtoId: true },
        distinct: ["produtoId"],
      }),
      prisma.ingestVendaLinhaRaw.findMany({
        where,
        select: { externalSaleId: true },
        distinct: ["externalSaleId"],
      }),
      prisma.ingestVendaLinhaRaw.findMany({
        where,
        select: { farmaciaId: true },
        distinct: ["farmaciaId"],
      }),
      topOrphanProducts(prisma, range, false),
      topOrphanProducts(prisma, range, true),
    ]);

  const byClass: Record<string, number> = {};
  for (const r of classDist) byClass[r.tipoDocumentoClass] = r._count._all;

  return {
    rawLines,
    produtosDistinct: produtosG.length,
    atendimentosDistinct: atendG.length,
    farmaciasDistinct: farmaciasG.length,
    byClass,
    orphans,
    nonStockServices,
    operationalOrphans,
    unknowns,
    operationalOrphanProducts: opOrphanTop,
    nonStockServiceProducts: nonStockTop,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Aggregation SQL
// ─────────────────────────────────────────────────────────────────────

type AggRow = {
  farmaciaId: string;
  produtoId: string;
  quantidadeLiquida: Prisma.Decimal;
  valorBruto: Prisma.Decimal;
  valorPagoUtente: Prisma.Decimal;
  valorComparticipado: Prisma.Decimal;
  linhasVenda: number;
  atendimentos: number;
};

async function runAggregation(
  prisma: PrismaClient,
  range: MonthRange
): Promise<AggRow[]> {
  // CASE assinado: VENDA → +ABS, DEVOLUCAO_ANULACAO → −ABS. Outros
  // tipoDocumentoClass nunca chegam aqui (filtrados no WHERE).
  // valorBruto = pvpUnitario × quantidade (regra do mapping).
  // valorPagoUtente = valorLinha (semântica observada em
  // sales-summary-preview 2024-01).
  // ABS aplicado para garantir sinal correcto mesmo se ERP gravar
  // devoluções já com valor negativo (defensivo).
  const rows = await prisma.$queryRaw<
    Array<{
      farmaciaId: string;
      produtoId: string;
      quantidadeLiquida: string | number | null;
      valorBruto: string | number | null;
      valorPagoUtente: string | number | null;
      valorComparticipado: string | number | null;
      linhasVenda: bigint | number;
      atendimentos: bigint | number;
    }>
  >`
    SELECT
      "farmaciaId",
      "produtoId"::text AS "produtoId",
      SUM(
        CASE "tipoDocumentoClass"
          WHEN 'VENDA'              THEN ABS(COALESCE("quantidade", 0))
          WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("quantidade", 0))
          ELSE 0
        END
      ) AS "quantidadeLiquida",
      SUM(
        CASE "tipoDocumentoClass"
          WHEN 'VENDA'              THEN ABS(COALESCE("pvpUnitario", 0) * COALESCE("quantidade", 0))
          WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("pvpUnitario", 0) * COALESCE("quantidade", 0))
          ELSE 0
        END
      ) AS "valorBruto",
      SUM(
        CASE "tipoDocumentoClass"
          WHEN 'VENDA'              THEN ABS(COALESCE("valorLinha", 0))
          WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("valorLinha", 0))
          ELSE 0
        END
      ) AS "valorPagoUtente",
      SUM(
        CASE "tipoDocumentoClass"
          WHEN 'VENDA'              THEN ABS(COALESCE("comparticipacao1", 0) + COALESCE("comparticipacao2", 0))
          WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("comparticipacao1", 0) + COALESCE("comparticipacao2", 0))
          ELSE 0
        END
      ) AS "valorComparticipado",
      COUNT(*)                        AS "linhasVenda",
      COUNT(DISTINCT "externalSaleId") AS "atendimentos"
    FROM "IngestVendaLinhaRaw"
    WHERE "tipoDocumentoClass" IN ('VENDA', 'DEVOLUCAO_ANULACAO')
      AND "produtoId" IS NOT NULL
      AND "isNonStockService" = false
      AND "dataVenda" >= ${range.fromInclusive}
      AND "dataVenda" <  ${range.toExclusive}
    GROUP BY "farmaciaId", "produtoId"
    ORDER BY "valorBruto" DESC
  `;

  // Normaliza tipos numéricos (Postgres pode devolver Decimal como
  // string via $queryRaw em algumas configurações).
  return rows.map((r) => ({
    farmaciaId: r.farmaciaId,
    produtoId: r.produtoId,
    quantidadeLiquida: new Prisma.Decimal(r.quantidadeLiquida ?? 0),
    valorBruto: new Prisma.Decimal(r.valorBruto ?? 0),
    valorPagoUtente: new Prisma.Decimal(r.valorPagoUtente ?? 0),
    valorComparticipado: new Prisma.Decimal(r.valorComparticipado ?? 0),
    linhasVenda: Number(r.linhasVenda),
    atendimentos: Number(r.atendimentos),
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────

function renderOrphanSamples(label: string, samples: OrphanSample[]): void {
  if (samples.length === 0) return;
  console.log(`  ${label}:`);
  for (const s of samples) {
    const classes = s.classes.length > 0 ? ` [${s.classes.join(",")}]` : "";
    console.log(`    extId=${String(s.externalProductId).padStart(7)}  rows=${String(s.rows).padStart(3)}${classes}`);
  }
}

function renderPreflight(stats: PreflightStats): void {
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
  if (stats.nonStockServiceProducts.length > 0 || stats.operationalOrphanProducts.length > 0) {
    console.log("");
    renderOrphanSamples("non-stock services (top)", stats.nonStockServiceProducts);
    renderOrphanSamples("operational orphans (top)", stats.operationalOrphanProducts);
  }
  console.log("");
  console.log("Distribuição por tipoDocumentoClass:");
  for (const [k, v] of Object.entries(stats.byClass).sort()) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log("");
}

function fmtMoney(n: Prisma.Decimal): string {
  return n.toFixed(2).padStart(12, " ");
}

function fmtQty(n: Prisma.Decimal): string {
  return n.toFixed(3).padStart(10, " ");
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
  // Selecciona 5 produtos do agregado (top + random) para sanity raw-vs-agg
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
    // raw breakdown by class
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

function renderTotals(rows: AggRow[]): void {
  const t = rows.reduce(
    (acc, r) => {
      acc.qtd = acc.qtd.plus(r.quantidadeLiquida);
      acc.vb = acc.vb.plus(r.valorBruto);
      acc.vu = acc.vu.plus(r.valorPagoUtente);
      acc.vc = acc.vc.plus(r.valorComparticipado);
      acc.linhas += r.linhasVenda;
      acc.atend += r.atendimentos;
      return acc;
    },
    {
      qtd: new Prisma.Decimal(0),
      vb: new Prisma.Decimal(0),
      vu: new Prisma.Decimal(0),
      vc: new Prisma.Decimal(0),
      linhas: 0,
      atend: 0,
    }
  );
  console.log("Totals agregados (mês):");
  console.log(`  rows VendaMensal a escrever : ${rows.length}`);
  console.log(`  quantidadeLiquida (Σ)       : ${t.qtd.toFixed(3)}`);
  console.log(`  valorBruto         (Σ)       : ${t.vb.toFixed(2)} EUR`);
  console.log(`  valorPagoUtente    (Σ)       : ${t.vu.toFixed(2)} EUR`);
  console.log(`  valorComparticipado (Σ)      : ${t.vc.toFixed(2)} EUR`);
  console.log(`  linhasVenda        (Σ)       : ${t.linhas}`);
  console.log(`  atendimentos       (Σ)       : ${t.atend}  (nota: contagem global, não distintos por produto)`);
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────
// Write: DELETE scoped + INSERT MANY in transaction
// ─────────────────────────────────────────────────────────────────────

async function writeAggregation(
  prisma: PrismaClient,
  range: MonthRange,
  rows: AggRow[]
): Promise<{ deleted: number; inserted: number }> {
  if (rows.length === 0) {
    console.log("Nenhuma row a escrever (0 produtos no mês).");
    return { deleted: 0, inserted: 0 };
  }

  // Farmácias afectadas — escopo do DELETE.
  const farmaciaIds = Array.from(new Set(rows.map((r) => r.farmaciaId)));

  const result = await prisma.$transaction(async (tx) => {
    // DELETE scoped: ano + mes + farmacias afectadas + apenas
    // origem 'agent-bootstrap-staging' (preserva rows legadas
    // Excel-import com origemAgregacao IS NULL).
    const del = await tx.vendaMensal.deleteMany({
      where: {
        ano: range.ano,
        mes: range.mes,
        farmaciaId: { in: farmaciaIds },
        origemAgregacao: ORIGEM_AGREGACAO,
      },
    });

    // INSERT MANY. Popula tanto campos NOVOS (nullable) como LEGADOS
    // (NOT NULL) para preservar dashboard. quantidade=quantidadeLiquida,
    // valorTotal=valorBruto.
    const data = rows.map((r) => ({
      farmaciaId: r.farmaciaId,
      produtoId: r.produtoId,
      ano: range.ano,
      mes: range.mes,
      // Legados (NOT NULL)
      quantidade: r.quantidadeLiquida,
      valorTotal: r.valorBruto,
      mesCompleto: true,
      origemBootstrap: false,
      // Novos (nullable, populados pela agg)
      quantidadeLiquida: r.quantidadeLiquida,
      valorBruto: r.valorBruto,
      valorPagoUtente: r.valorPagoUtente,
      valorComparticipado: r.valorComparticipado,
      linhasVenda: r.linhasVenda,
      atendimentos: r.atendimentos,
      origemAgregacao: ORIGEM_AGREGACAO,
    }));

    const ins = await tx.vendaMensal.createMany({ data });
    return { deleted: del.count, inserted: ins.count };
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

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
  // Default: dry-run
  const mode: "dry-run" | "write" = args.write ? "write" : "dry-run";

  let range: MonthRange;
  try {
    range = parseMonthArg(args.month);
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
    console.error(`✗ Tenant "${args.tenant}" em estado ${tenant.estado}. Aborta.`);
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

    // 1) Preflight + validações
    const stats = await preflight(prisma, range);
    renderPreflight(stats);

    if (stats.unknowns > 0) {
      console.error(`✗ Aborta: ${stats.unknowns} linhas com tipoDocumentoClass='UNKNOWN' no mês.`);
      console.error(`  Caracteriza TipoDocs em falta via:`);
      console.error(`    npm run ingest:classify-tipodoc -- --tenant ${args.tenant} --tipo <N> --classe <classe>`);
      console.error(`    npm run ingest:reclassify-vendas -- --tenant ${args.tenant}`);
      await prisma.$disconnect();
      process.exit(1);
    }
    if (stats.nonStockServices > 0) {
      console.log(`ℹ ${stats.nonStockServices} linhas non-stock services excluídas auto da agregação.`);
    }
    if (stats.operationalOrphans > 0 && !args.allowOrphans) {
      console.error(`✗ Aborta: ${stats.operationalOrphans} linhas operational orphans no mês.`);
      console.error(`  (produtoId IS NULL E isNonStockService=false — produtos legítimos missing)`);
      console.error(`  Opções:`);
      console.error(`    a) Investigar com 'npm run ingest:list-orphans -- --tenant <slug> --month <mm-yyyy>'`);
      console.error(`    b) Inspeccionar no ERP com 'run-inspect-codigoid.bat'`);
      console.error(`    c) Re-run bootstrap-upload products para CNPs cobertos`);
      console.error(`    d) Marcar IDs comprovadamente sem produto via:`);
      console.error(`         npm run ingest:backfill-services -- --tenant ${args.tenant} --ids <csv>`);
      console.error(`    e) Passar --allow-orphans para ignorar (rows orphan ficam fora)`);
      await prisma.$disconnect();
      process.exit(1);
    }
    if (stats.operationalOrphans > 0 && args.allowOrphans) {
      console.log(`⚠ --allow-orphans: ${stats.operationalOrphans} operational orphans vão ficar fora da agregação.\n`);
    }

    // 2) Agregação
    console.log("▶ A correr agregação SQL…");
    const aggRows = await runAggregation(prisma, range);
    console.log(`  ${aggRows.length} (farmaciaId, produtoId) pairs agregados\n`);

    renderTotals(aggRows);
    if (aggRows.length > 0) {
      await renderTopProducts(prisma, aggRows);
      await renderSampleRawVsAgg(prisma, range, aggRows);
    }

    // 3) Mode-specific
    if (mode === "dry-run") {
      const wallMs = Date.now() - t0;
      console.log("─".repeat(70));
      console.log(`✓ DRY-RUN concluído em ${(wallMs / 1000).toFixed(1)}s. Nada escrito.`);
      console.log(`  Para aplicar: re-corre com --write em vez de --dry-run.`);
      await prisma.$disconnect();
      return;
    }

    // 4) Write
    console.log("▶ A escrever (DELETE scoped + INSERT MANY em transaction)…");
    const r = await writeAggregation(prisma, range, aggRows);
    const wallMs = Date.now() - t0;
    console.log("─".repeat(70));
    console.log(`✓ WRITE concluído em ${(wallMs / 1000).toFixed(1)}s.`);
    console.log(`  deleted (origem=${ORIGEM_AGREGACAO}, ano=${range.ano}, mes=${range.mes}): ${r.deleted}`);
    console.log(`  inserted                                                : ${r.inserted}`);
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
