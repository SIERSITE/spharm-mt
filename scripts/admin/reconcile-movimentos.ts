/**
 * scripts/admin/reconcile-movimentos.ts
 *
 * Block C2 — Reconciliação server-side entre `MovimentoArtigo` (canónico,
 * StocksMov-derived) e os modelos legacy `VendaMensal` / `Compra` /
 * `Devolucao` para uma janela `[from, to)` num tenant.
 *
 * Agrega por (mês, tipo) ambos os lados e reporta diff. Não escreve nada.
 * Critério de aceitação para activar `useMovimentosCanonical=true`:
 *   diff ≤ 1 % por bucket relevante.
 *
 * Uso:
 *   npx tsx scripts/admin/reconcile-movimentos.ts \
 *     --tenant grupo-silveira --from 2025-06-01 --to 2026-06-01
 *
 * Saída: tabela markdown ao stdout (`gh issue create --body-file` friendly).
 *
 * Não toca em dashboard, vendas, compras, devoluções, agent. Read-only.
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

type FarmaciaRow = { id: string; nome: string };

type MovBucket = {
  ano: number;
  mes: number;
  tipo: string;
  qtAbs: number;
  rows: number;
};

type LegacyBucket = {
  ano: number;
  mes: number;
  source: "VENDA" | "COMPRA" | "DEVOLUCAO_FORNECEDOR";
  qtAbs: number;
  rows: number;
};

async function aggregateCanonico(
  prisma: PrismaClient,
  farmaciaId: string,
  from: Date,
  to: Date,
): Promise<MovBucket[]> {
  return prisma.$queryRaw<MovBucket[]>(Prisma.sql`
    SELECT
      EXTRACT(YEAR FROM "dataMovimento")::int AS ano,
      EXTRACT(MONTH FROM "dataMovimento")::int AS mes,
      "tipo"::text                            AS tipo,
      SUM(ABS("quantidade"))::float           AS "qtAbs",
      COUNT(*)::int                           AS rows
    FROM "MovimentoArtigo"
    WHERE "farmaciaId" = ${farmaciaId}
      AND "dataMovimento" >= ${from}
      AND "dataMovimento" <  ${to}
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `);
}

async function aggregateLegacyVenda(
  prisma: PrismaClient,
  farmaciaId: string,
  from: Date,
  to: Date,
): Promise<LegacyBucket[]> {
  // Vendas: VendaMensal.quantidadeLiquida quando populado, senão quantidade legado.
  // Tomamos ABS para alinhar com canónico (que guarda assinado).
  return prisma.$queryRaw<LegacyBucket[]>(Prisma.sql`
    SELECT
      ano,
      mes,
      'VENDA'::text                                                                         AS source,
      SUM(ABS(COALESCE("quantidadeLiquida", "quantidade")))::float                           AS "qtAbs",
      COUNT(*)::int                                                                          AS rows
    FROM "VendaMensal"
    WHERE "farmaciaId" = ${farmaciaId}
      AND make_date(ano, mes, 1) >= ${from}
      AND make_date(ano, mes, 1) <  ${to}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
}

async function aggregateLegacyCompra(
  prisma: PrismaClient,
  farmaciaId: string,
  from: Date,
  to: Date,
): Promise<LegacyBucket[]> {
  return prisma.$queryRaw<LegacyBucket[]>(Prisma.sql`
    SELECT
      EXTRACT(YEAR FROM data)::int   AS ano,
      EXTRACT(MONTH FROM data)::int  AS mes,
      'COMPRA'::text                 AS source,
      SUM(ABS(quantidade))::float    AS "qtAbs",
      COUNT(*)::int                  AS rows
    FROM "Compra"
    WHERE "farmaciaId" = ${farmaciaId}
      AND data >= ${from}
      AND data <  ${to}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
}

async function aggregateLegacyDevolucao(
  prisma: PrismaClient,
  farmaciaId: string,
  from: Date,
  to: Date,
): Promise<LegacyBucket[]> {
  return prisma.$queryRaw<LegacyBucket[]>(Prisma.sql`
    SELECT
      EXTRACT(YEAR FROM data)::int          AS ano,
      EXTRACT(MONTH FROM data)::int         AS mes,
      'DEVOLUCAO_FORNECEDOR'::text          AS source,
      SUM(ABS(quantidade))::float           AS "qtAbs",
      COUNT(*)::int                         AS rows
    FROM "Devolucao"
    WHERE "farmaciaId" = ${farmaciaId}
      AND tipo = 'FORNECEDOR'
      AND data >= ${from}
      AND data <  ${to}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
}

type Diff = {
  ano: number;
  mes: number;
  bucket: "VENDA" | "COMPRA" | "DEVOLUCAO_FORNECEDOR";
  canonicoQt: number;
  legacyQt: number;
  diffPct: number;
};

function reconcile(
  canonico: MovBucket[],
  legacy: LegacyBucket[],
): Diff[] {
  // Para cada (ano, mes) presente em qualquer lado, computa diff por bucket.
  type Key = string;
  const canMap = new Map<Key, number>(); // ano-mes-tipo → qt
  for (const c of canonico) canMap.set(`${c.ano}-${c.mes}-${c.tipo}`, c.qtAbs);
  const legMap = new Map<Key, number>();
  for (const l of legacy) legMap.set(`${l.ano}-${l.mes}-${l.source}`, l.qtAbs);

  const months = new Set<string>();
  for (const c of canonico) months.add(`${c.ano}-${c.mes}`);
  for (const l of legacy) months.add(`${l.ano}-${l.mes}`);

  const out: Diff[] = [];
  for (const ym of Array.from(months).sort()) {
    const [a, m] = ym.split("-").map(Number);
    for (const bucket of ["VENDA", "COMPRA", "DEVOLUCAO_FORNECEDOR"] as const) {
      const canonicoQt = canMap.get(`${a}-${m}-${bucket}`) ?? 0;
      const legacyQt = legMap.get(`${a}-${m}-${bucket}`) ?? 0;
      // Diff% = |c-l| / max(c, l, 1). Evita div-zero quando ambos = 0.
      const denom = Math.max(canonicoQt, legacyQt, 1);
      const diffPct = (Math.abs(canonicoQt - legacyQt) / denom) * 100;
      if (canonicoQt === 0 && legacyQt === 0) continue;
      out.push({ ano: a, mes: m, bucket, canonicoQt, legacyQt, diffPct });
    }
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      farmacia: { type: "string" }, // optional filter
    },
    strict: true,
  });
  if (!values.tenant || !values.from || !values.to) {
    console.error("✗ --tenant <slug> --from YYYY-MM-DD --to YYYY-MM-DD obrigatórios.");
    process.exit(1);
  }
  const from = new Date(`${values.from}T00:00:00Z`);
  const to = new Date(`${values.to}T00:00:00Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    console.error("✗ --from/--to inválidos.");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe.`);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  try {
    const farmacias: FarmaciaRow[] = await prisma.farmacia.findMany({
      where: {
        estado: "ATIVO",
        nome: { not: "Farmácia Teste" },
        ...(values.farmacia ? { nome: values.farmacia } : {}),
      },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    });

    console.log(`# Reconciliação MovimentoArtigo vs legacy`);
    console.log();
    console.log(`- tenant: \`${values.tenant}\``);
    console.log(`- janela: ${values.from} → ${values.to} (to exclusivo)`);
    console.log(`- farmácias activas: ${farmacias.length}`);
    console.log();

    let allWithin1Pct = true;
    let bucketsCompared = 0;
    let bucketsAbove1Pct = 0;

    for (const f of farmacias) {
      const [canonico, vendas, compras, devolucoes] = await Promise.all([
        aggregateCanonico(prisma, f.id, from, to),
        aggregateLegacyVenda(prisma, f.id, from, to),
        aggregateLegacyCompra(prisma, f.id, from, to),
        aggregateLegacyDevolucao(prisma, f.id, from, to),
      ]);
      const legacy = [...vendas, ...compras, ...devolucoes];
      const diffs = reconcile(canonico, legacy);
      const canonicoTotal = canonico.reduce((s, c) => s + c.rows, 0);

      console.log(`## ${f.nome}`);
      console.log();
      console.log(`- MovimentoArtigo rows total: ${canonicoTotal}`);
      console.log(`- VendaMensal/Compra/Devolucao buckets agregados: ${legacy.length}`);
      console.log();

      if (diffs.length === 0) {
        console.log(`_Sem dados em nenhum dos lados._`);
        console.log();
        continue;
      }

      console.log(`| Mês | Bucket | Canónico (qt) | Legacy (qt) | Diff % |`);
      console.log(`|---|---|---:|---:|---:|`);
      for (const d of diffs) {
        const flag = d.diffPct > 1 ? " ⚠" : "";
        console.log(
          `| ${d.ano}-${String(d.mes).padStart(2, "0")} | ${d.bucket} | ${d.canonicoQt.toFixed(0)} | ${d.legacyQt.toFixed(0)} | ${d.diffPct.toFixed(2)}%${flag} |`,
        );
        bucketsCompared++;
        if (d.diffPct > 1) {
          bucketsAbove1Pct++;
          allWithin1Pct = false;
        }
      }
      console.log();
    }

    console.log(`## Sumário tenant`);
    console.log();
    console.log(`- Buckets comparados: ${bucketsCompared}`);
    console.log(`- Buckets > 1 % diff: ${bucketsAbove1Pct}`);
    console.log(
      allWithin1Pct
        ? `- ✅ Tudo dentro do alvo (≤1 %). Pronto para activar \`useMovimentosCanonical=true\` por farmácia.`
        : `- ⚠ ${bucketsAbove1Pct} buckets fora do alvo. NÃO activar a flag ainda — investigar.`,
    );

    process.exit(allWithin1Pct ? 0 : 1);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
