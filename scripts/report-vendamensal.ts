/**
 * scripts/report-vendamensal.ts
 *
 * CLI complementar do relatório `/relatorios/vendas-mensais`. Mesmos
 * loaders, output em stdout — usado para validar dados sem abrir a UI
 * e para audit/diff em CI/operações.
 *
 * Uso:
 *   npm run report:vendamensal -- --tenant demo-neon --month 2024-04
 *   npm run report:vendamensal -- --tenant demo-neon --month 2024-04 --farmacia "Farmacia X"
 *
 * Quando `--farmacia` não é dado, gera o relatório para todas as
 * farmácias do tenant, uma de cada vez (cabeçalho explícito por
 * farmácia). Para tenants com muitas farmácias, especificar `--farmacia`.
 *
 * Restrição: o loader server-side em `lib/data/vendas-mensais-report.ts`
 * importa `server-only` e usa `getPrisma()` (tenant-aware via headers
 * request context). Este script CLI **não** pode usar esse caminho —
 * fora de request não há header de tenant. Por isso replica os mesmos
 * queries SQL contra um PrismaClient construído com a connection
 * string do tenant explícito (igual padrão de
 * `scripts/aggregate-vendamensal.ts`).
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

type Args = { tenant?: string; month?: string; farmacia?: string; limit?: string };

function parseCmdArgs(): Args {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      month: { type: "string" },
      farmacia: { type: "string" },
      limit: { type: "string" },
    },
    strict: true,
  });
  return {
    tenant: values.tenant,
    month: values.month,
    farmacia: values.farmacia,
    limit: values.limit,
  };
}

function parseMonth(arg: string): { ano: number; mes: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(arg);
  if (!m) throw new Error(`--month deve ser YYYY-MM (ex: 2024-04). Recebido: ${arg}`);
  const ano = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10);
  if (mes < 1 || mes > 12) throw new Error(`Mês fora do intervalo: ${mes}`);
  return { ano, mes };
}

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

function fmtEur(n: number): string {
  return n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtQty(n: number): string {
  return n.toLocaleString("pt-PT", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function dec(v: Prisma.Decimal | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}
function decN(v: Prisma.Decimal | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

type TotalsRow = {
  produtos: bigint | number;
  qtd: string | number | null;
  vb: string | number | null;
  vu: string | number | null;
  vc: string | number | null;
  linhas: bigint | number | null;
  atend: bigint | number | null;
  produtosNegativos: bigint | number;
};

async function getTotals(prisma: PrismaClient, farmaciaId: string, ano: number, mes: number) {
  const rows = await prisma.$queryRaw<TotalsRow[]>`
    SELECT
      COUNT(*)::bigint                                          AS "produtos",
      SUM(COALESCE("quantidadeLiquida", "quantidade"))::numeric AS "qtd",
      SUM(COALESCE("valorBruto", "valorTotal"))::numeric        AS "vb",
      SUM(COALESCE("valorPagoUtente", "valorTotal"))::numeric   AS "vu",
      SUM(COALESCE("valorComparticipado", 0))::numeric          AS "vc",
      SUM(COALESCE("linhasVenda", 0))::bigint                   AS "linhas",
      SUM(COALESCE("atendimentos", 0))::bigint                  AS "atend",
      SUM(CASE WHEN COALESCE("quantidadeLiquida", "quantidade") < 0 THEN 1 ELSE 0 END)::bigint AS "produtosNegativos"
    FROM "VendaMensal"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "ano" = ${ano} AND "mes" = ${mes}
  `;
  return rows[0];
}

type TopRow = {
  produtoId: string;
  designacao: string;
  cnp: number | null;
  quantidadeLiquida: Prisma.Decimal | null;
  valorBruto: Prisma.Decimal | null;
  valorPagoUtente: Prisma.Decimal | null;
  valorComparticipado: Prisma.Decimal | null;
  linhasVenda: number | null;
  atendimentos: number | null;
  pvp: Prisma.Decimal | null;
  puc: Prisma.Decimal | null;
  stockAtual: Prisma.Decimal | null;
  stockMinimo: Prisma.Decimal | null;
  stockMaximo: Prisma.Decimal | null;
};

async function getTop(
  prisma: PrismaClient, farmaciaId: string, ano: number, mes: number,
  order: "valor" | "qtd" | "qtd-asc", limit: number, onlyNeg: boolean
) {
  const orderSql = order === "valor"
    ? Prisma.sql`COALESCE(vm."valorBruto", vm."valorTotal") DESC`
    : order === "qtd"
      ? Prisma.sql`COALESCE(vm."quantidadeLiquida", vm."quantidade") DESC`
      : Prisma.sql`COALESCE(vm."quantidadeLiquida", vm."quantidade") ASC`;
  const negClause = onlyNeg
    ? Prisma.sql`AND COALESCE(vm."quantidadeLiquida", vm."quantidade") < 0`
    : Prisma.empty;

  return prisma.$queryRaw<TopRow[]>`
    SELECT
      vm."produtoId"                                  AS "produtoId",
      p."designacao"                                  AS "designacao",
      p."cnp"                                         AS "cnp",
      COALESCE(vm."quantidadeLiquida", vm."quantidade") AS "quantidadeLiquida",
      COALESCE(vm."valorBruto", vm."valorTotal")      AS "valorBruto",
      COALESCE(vm."valorPagoUtente", vm."valorTotal") AS "valorPagoUtente",
      COALESCE(vm."valorComparticipado", 0)           AS "valorComparticipado",
      COALESCE(vm."linhasVenda", 0)                   AS "linhasVenda",
      COALESCE(vm."atendimentos", 0)                  AS "atendimentos",
      pf."pvp"                                        AS "pvp",
      pf."puc"                                        AS "puc",
      pf."stockAtual"                                 AS "stockAtual",
      pf."stockMinimo"                                AS "stockMinimo",
      pf."stockMaximo"                                AS "stockMaximo"
    FROM "VendaMensal" vm
    JOIN "Produto" p ON p."id" = vm."produtoId"
    LEFT JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
    WHERE vm."farmaciaId" = ${farmaciaId}
      AND vm."ano" = ${ano} AND vm."mes" = ${mes}
    ${negClause}
    ORDER BY ${orderSql}
    LIMIT ${limit}
  `;
}

async function getStockAnomaly(
  prisma: PrismaClient, farmaciaId: string, ano: number, mes: number,
  kind: "no-stock" | "no-bounds", limit: number
) {
  const cond = kind === "no-stock"
    ? Prisma.sql`AND (pf."stockAtual" IS NULL OR pf."stockAtual" = 0)`
    : Prisma.sql`AND (pf."stockMinimo" IS NULL OR pf."stockMaximo" IS NULL)`;
  return prisma.$queryRaw<TopRow[]>`
    SELECT
      vm."produtoId"                                    AS "produtoId",
      p."designacao"                                    AS "designacao",
      p."cnp"                                           AS "cnp",
      COALESCE(vm."quantidadeLiquida", vm."quantidade") AS "quantidadeLiquida",
      COALESCE(vm."valorBruto", vm."valorTotal")        AS "valorBruto",
      NULL::numeric                                     AS "valorPagoUtente",
      NULL::numeric                                     AS "valorComparticipado",
      NULL::int                                         AS "linhasVenda",
      NULL::int                                         AS "atendimentos",
      pf."pvp"                                          AS "pvp",
      pf."puc"                                          AS "puc",
      pf."stockAtual"                                   AS "stockAtual",
      pf."stockMinimo"                                  AS "stockMinimo",
      pf."stockMaximo"                                  AS "stockMaximo"
    FROM "VendaMensal" vm
    JOIN "Produto" p ON p."id" = vm."produtoId"
    LEFT JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
    WHERE vm."farmaciaId" = ${farmaciaId}
      AND vm."ano" = ${ano} AND vm."mes" = ${mes}
      AND COALESCE(vm."quantidadeLiquida", vm."quantidade") > 0
    ${cond}
    ORDER BY COALESCE(vm."valorBruto", vm."valorTotal") DESC
    LIMIT ${limit}
  `;
}

async function getNegativeStock(
  prisma: PrismaClient, farmaciaId: string, ano: number, mes: number, limit: number
) {
  return prisma.$queryRaw<TopRow[]>`
    SELECT
      pf."produtoId"                                    AS "produtoId",
      p."designacao"                                    AS "designacao",
      p."cnp"                                           AS "cnp",
      COALESCE(vm."quantidadeLiquida", vm."quantidade", 0) AS "quantidadeLiquida",
      COALESCE(vm."valorBruto", vm."valorTotal", 0)        AS "valorBruto",
      NULL::numeric                                     AS "valorPagoUtente",
      NULL::numeric                                     AS "valorComparticipado",
      NULL::int                                         AS "linhasVenda",
      NULL::int                                         AS "atendimentos",
      pf."pvp"                                          AS "pvp",
      pf."puc"                                          AS "puc",
      pf."stockAtual"                                   AS "stockAtual",
      pf."stockMinimo"                                  AS "stockMinimo",
      pf."stockMaximo"                                  AS "stockMaximo"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto" p ON p."id" = pf."produtoId"
    LEFT JOIN "VendaMensal" vm
      ON vm."produtoId" = pf."produtoId" AND vm."farmaciaId" = pf."farmaciaId"
     AND vm."ano" = ${ano} AND vm."mes" = ${mes}
    WHERE pf."farmaciaId" = ${farmaciaId}
      AND pf."stockAtual" IS NOT NULL AND pf."stockAtual" < 0
    ORDER BY pf."stockAtual" ASC
    LIMIT ${limit}
  `;
}

async function getMargem(
  prisma: PrismaClient, farmaciaId: string, ano: number, mes: number, limit: number
) {
  return prisma.$queryRaw<TopRow[]>`
    SELECT
      vm."produtoId"                                    AS "produtoId",
      p."designacao"                                    AS "designacao",
      p."cnp"                                           AS "cnp",
      COALESCE(vm."quantidadeLiquida", vm."quantidade") AS "quantidadeLiquida",
      COALESCE(vm."valorBruto", vm."valorTotal")        AS "valorBruto",
      COALESCE(vm."valorPagoUtente", vm."valorTotal")   AS "valorPagoUtente",
      COALESCE(vm."valorComparticipado", 0)             AS "valorComparticipado",
      COALESCE(vm."linhasVenda", 0)                     AS "linhasVenda",
      COALESCE(vm."atendimentos", 0)                    AS "atendimentos",
      pf."pvp"                                          AS "pvp",
      pf."puc"                                          AS "puc",
      pf."stockAtual"                                   AS "stockAtual",
      pf."stockMinimo"                                  AS "stockMinimo",
      pf."stockMaximo"                                  AS "stockMaximo"
    FROM "VendaMensal" vm
    JOIN "Produto" p ON p."id" = vm."produtoId"
    JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = vm."produtoId" AND pf."farmaciaId" = vm."farmaciaId"
    WHERE vm."farmaciaId" = ${farmaciaId}
      AND vm."ano" = ${ano} AND vm."mes" = ${mes}
      AND pf."pvp" IS NOT NULL AND pf."pvp" > 0
      AND pf."puc" IS NOT NULL
      AND COALESCE(vm."quantidadeLiquida", vm."quantidade") > 0
    ORDER BY ((pf."pvp" - pf."puc") / pf."pvp") * COALESCE(vm."quantidadeLiquida", vm."quantidade") DESC
    LIMIT ${limit}
  `;
}

function renderTopTable(label: string, rows: TopRow[], opts?: { margin?: boolean }) {
  console.log(`▶ ${label} (${rows.length})`);
  if (rows.length === 0) {
    console.log("  (sem dados)\n");
    return;
  }
  const showMargem = opts?.margin === true;
  const head = showMargem
    ? "  #  CNP        Designacao                                       Qtd        ValorBruto   Margem%  ValorMargem"
    : "  #  CNP        Designacao                                       Qtd        ValorBruto   Stock";
  console.log(head);
  console.log("  " + "─".repeat(head.length - 2));
  rows.forEach((r, i) => {
    const cnp = String(r.cnp ?? "—").padStart(7);
    const desc = (r.designacao ?? "(?)").slice(0, 48).padEnd(48);
    const qtd = fmtQty(dec(r.quantidadeLiquida)).padStart(10);
    const vb = fmtEur(dec(r.valorBruto)).padStart(12);
    if (showMargem) {
      const pvp = decN(r.pvp);
      const puc = decN(r.puc);
      let mPct = "—".padStart(7);
      let mVal = "—".padStart(12);
      if (pvp !== null && pvp > 0 && puc !== null) {
        const m = (pvp - puc) / pvp;
        mPct = fmtPct(m * 100).padStart(7);
        mVal = fmtEur(m * dec(r.quantidadeLiquida) * pvp).padStart(12);
      }
      console.log(`  ${String(i + 1).padStart(2)} ${cnp}  ${desc}  ${qtd}  ${vb} ${mPct}  ${mVal}`);
    } else {
      const stock = decN(r.stockAtual);
      const stockStr = stock === null ? "—" : fmtQty(stock);
      console.log(`  ${String(i + 1).padStart(2)} ${cnp}  ${desc}  ${qtd}  ${vb} ${stockStr.padStart(8)}`);
    }
  });
  console.log("");
}

async function runForFarmacia(
  prisma: PrismaClient,
  farmacia: { id: string; nome: string },
  ano: number,
  mes: number,
  limit: number
) {
  console.log("═".repeat(90));
  console.log(`Farmácia: ${farmacia.nome}  (${farmacia.id})`);
  console.log(`Período: ${MESES[mes - 1]} ${ano}`);
  console.log("═".repeat(90));
  console.log("");

  const t = await getTotals(prisma, farmacia.id, ano, mes);
  if (!t || Number(t.produtos) === 0) {
    console.log("(sem dados em VendaMensal para esta combinação)\n");
    return;
  }
  console.log("Totais mensais:");
  console.log(`  produtos distintos          : ${Number(t.produtos)}`);
  console.log(`  quantidade líquida (Σ)      : ${fmtQty(Number(t.qtd ?? 0))}`);
  console.log(`  valor bruto (Σ)             : ${fmtEur(Number(t.vb ?? 0))} EUR`);
  console.log(`  valor pago utente (Σ)       : ${fmtEur(Number(t.vu ?? 0))} EUR`);
  console.log(`  valor comparticipado (Σ)    : ${fmtEur(Number(t.vc ?? 0))} EUR`);
  console.log(`  linhas de venda (Σ)         : ${Number(t.linhas ?? 0)}`);
  console.log(`  atendimentos (Σ)            : ${Number(t.atend ?? 0)}`);
  console.log(`  produtos c/ devolução líq.  : ${Number(t.produtosNegativos)}`);
  console.log("");

  const [topValor, topQty, devolucoes, semStock, stockNeg, semBounds, margem] = await Promise.all([
    getTop(prisma, farmacia.id, ano, mes, "valor", limit, false),
    getTop(prisma, farmacia.id, ano, mes, "qtd", limit, false),
    getTop(prisma, farmacia.id, ano, mes, "qtd-asc", limit, true),
    getStockAnomaly(prisma, farmacia.id, ano, mes, "no-stock", limit),
    getNegativeStock(prisma, farmacia.id, ano, mes, limit),
    getStockAnomaly(prisma, farmacia.id, ano, mes, "no-bounds", limit),
    getMargem(prisma, farmacia.id, ano, mes, limit),
  ]);

  renderTopTable(`Top ${limit} produtos por valorBruto DESC`, topValor);
  renderTopTable(`Top ${limit} produtos por quantidade DESC`, topQty);
  renderTopTable(`Devoluções líquidas (qtd liq < 0)`, devolucoes);
  renderTopTable(`Vendeu mas hoje stock=0/null`, semStock);
  renderTopTable(`Stock negativo (anomalia)`, stockNeg);
  renderTopTable(`Vendeu mas sem stockMin/stockMax`, semBounds);
  renderTopTable(`Top ${limit} margem aproximada`, margem, { margin: true });
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
  const { ano, mes } = parseMonth(args.month);
  const limit = args.limit ? Math.max(1, Math.min(100, parseInt(args.limit, 10))) : 20;

  const tenant = await getTenantBySlug(args.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${args.tenant}" não existe.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant em estado ${tenant.estado}.`);
    process.exit(1);
  }
  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    const farmacias = await prisma.farmacia.findMany({
      where: { estado: "ATIVO" },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    });
    const filtered = args.farmacia
      ? farmacias.filter((f) => f.nome.toLowerCase() === args.farmacia!.toLowerCase() || f.id === args.farmacia)
      : farmacias;
    if (filtered.length === 0) {
      console.error(`✗ Sem farmácias activas (ou nenhuma match para "${args.farmacia ?? "—"}").`);
      process.exit(1);
    }
    for (const f of filtered) {
      await runForFarmacia(prisma, f, ano, mes, limit);
    }
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
