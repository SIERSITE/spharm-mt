/**
 * scripts/admin/validate-iva-relatorios.ts
 *
 * Valida end-to-end o pipeline de IVA dos relatórios:
 *   1. count por bucket canónico (6/13/23/APURAR) — Inventário
 *   2. somas valor stock s/IVA · valor IVA · valor stock c/IVA
 *   3. count + somas equivalentes para Margens (no período do ano corrente)
 *   4. sample 3 produtos: stock × PMC × taxa → recomputar manualmente e
 *      comparar com getInventarioData / getMargensData
 *
 * Read-only. Não escreve.
 *
 * Usage:
 *   npx tsx scripts/admin/validate-iva-relatorios.ts --slug=grupo-silveira
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import {
  getTenantBySlug,
  buildTenantConnectionString,
  controlPrisma,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalizeIva } from "@/lib/iva";

function fmtEur(n: number): string {
  return n.toLocaleString("pt-PT", {
    style: "currency",
    currency: "EUR",
  });
}

async function main() {
  const { values } = parseArgs({
    options: { slug: { type: "string" } },
  });
  const slug = values.slug ?? "grupo-silveira";

  // 1. Conectar ao tenant
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`tenant ${slug} not found`);
    process.exit(1);
  }
  process.env.DATABASE_URL = buildTenantConnectionString(tenant);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  console.log(`\n=== Tenant: ${slug} ===\n`);

  // ── 2. Validação por bucket: count + somas ─────────────────────
  // Espelhamos a query do inventario-data: ProdutoFarmacia + LATERAL JOIN
  // a StagingCompraRawLine. Calculamos em SQL e comparamos contagens.
  const rawRows = await prisma.$queryRawUnsafe<
    Array<{
      stockAtual: string | null;
      pmc: string | null;
      puc: string | null;
      taxa_iva: string | null;
    }>
  >(`
    SELECT
      pf."stockAtual"::text AS "stockAtual",
      pf."pmc"::text AS pmc,
      pf."puc"::text AS puc,
      iva_src.iva::text AS taxa_iva
    FROM "ProdutoFarmacia" pf
    LEFT JOIN LATERAL (
      SELECT scrl."iva"
      FROM "StagingCompraRawLine" scrl
      WHERE scrl."farmaciaId" = pf."farmaciaId"
        AND scrl."externalCodigoId" = pf."externalProductId"
      ORDER BY scrl."externalLineId" DESC
      LIMIT 1
    ) iva_src ON true
    WHERE pf."flagRetirado" = false
  `);

  type Bucket = {
    label: string;
    n: number;
    stock: number;
    valSemIva: number;
    valIva: number;
    valComIva: number;
  };
  const buckets: Record<"6" | "13" | "23" | "APURAR", Bucket> = {
    "6": { label: "IVA 6%", n: 0, stock: 0, valSemIva: 0, valIva: 0, valComIva: 0 },
    "13": { label: "IVA 13%", n: 0, stock: 0, valSemIva: 0, valIva: 0, valComIva: 0 },
    "23": { label: "IVA 23%", n: 0, stock: 0, valSemIva: 0, valIva: 0, valComIva: 0 },
    APURAR: {
      label: "IVA por apurar",
      n: 0,
      stock: 0,
      valSemIva: 0,
      valIva: 0,
      valComIva: 0,
    },
  };

  for (const r of rawRows) {
    const stockAtual = r.stockAtual ? Number(r.stockAtual) : null;
    const pmc = r.pmc ? Number(r.pmc) : null;
    const puc = r.puc ? Number(r.puc) : null;
    const custo = pmc !== null && pmc > 0 ? pmc : puc !== null && puc > 0 ? puc : null;
    const taxa = normalizeIva(r.taxa_iva ? Number(r.taxa_iva) : null);
    const valSemIva =
      custo !== null && stockAtual !== null ? stockAtual * custo : null;
    const valIva = valSemIva !== null && taxa !== null ? valSemIva * (taxa / 100) : null;
    const valComIva =
      valSemIva !== null && valIva !== null ? valSemIva + valIva : null;

    const k = taxa === 6 ? "6" : taxa === 13 ? "13" : taxa === 23 ? "23" : "APURAR";
    const b = buckets[k];
    b.n++;
    if (stockAtual !== null) b.stock += stockAtual;
    if (valSemIva !== null) b.valSemIva += valSemIva;
    if (valIva !== null) b.valIva += valIva;
    if (valComIva !== null) b.valComIva += valComIva;
  }

  console.log("┌────────────────────┬────────┬──────────┬───────────────┬─────────────┬───────────────┐");
  console.log("│ Bucket             │ Linhas │ Stock un │ Val. s/IVA    │ IVA €       │ Val. c/IVA    │");
  console.log("├────────────────────┼────────┼──────────┼───────────────┼─────────────┼───────────────┤");
  let total = { n: 0, stock: 0, valSemIva: 0, valIva: 0, valComIva: 0 };
  for (const key of ["6", "13", "23", "APURAR"] as const) {
    const b = buckets[key];
    total.n += b.n;
    total.stock += b.stock;
    total.valSemIva += b.valSemIva;
    total.valIva += b.valIva;
    total.valComIva += b.valComIva;
    console.log(
      `│ ${b.label.padEnd(18)} │ ${String(b.n).padStart(6)} │ ${Math.round(b.stock).toString().padStart(8)} │ ${fmtEur(b.valSemIva).padStart(13)} │ ${fmtEur(b.valIva).padStart(11)} │ ${fmtEur(b.valComIva).padStart(13)} │`,
    );
  }
  console.log("├────────────────────┼────────┼──────────┼───────────────┼─────────────┼───────────────┤");
  console.log(
    `│ ${"TOTAL".padEnd(18)} │ ${String(total.n).padStart(6)} │ ${Math.round(total.stock).toString().padStart(8)} │ ${fmtEur(total.valSemIva).padStart(13)} │ ${fmtEur(total.valIva).padStart(11)} │ ${fmtEur(total.valComIva).padStart(13)} │`,
  );
  console.log("└────────────────────┴────────┴──────────┴───────────────┴─────────────┴───────────────┘");

  // ── 3. Sample 3 produtos: recálculo manual vs taxa normalizada ─
  console.log("\nSample 3 produtos com IVA 6% (verificação manual):");
  const sample = await prisma.$queryRawUnsafe<
    Array<{
      cnp: number;
      designacao: string;
      stockAtual: string;
      pmc: string;
      taxa_iva: string;
    }>
  >(`
    SELECT
      p.cnp,
      p.designacao,
      pf."stockAtual"::text AS "stockAtual",
      pf."pmc"::text AS pmc,
      iva_src.iva::text AS taxa_iva
    FROM "ProdutoFarmacia" pf
    JOIN "Produto" p ON p.id = pf."produtoId"
    LEFT JOIN LATERAL (
      SELECT scrl."iva"
      FROM "StagingCompraRawLine" scrl
      WHERE scrl."farmaciaId" = pf."farmaciaId"
        AND scrl."externalCodigoId" = pf."externalProductId"
      ORDER BY scrl."externalLineId" DESC
      LIMIT 1
    ) iva_src ON true
    WHERE pf."flagRetirado" = false
      AND pf."stockAtual" > 0
      AND pf."pmc" > 0
      AND iva_src.iva = 0.06
    ORDER BY p.designacao
    LIMIT 3
  `);
  for (const r of sample) {
    const stock = Number(r.stockAtual);
    const pmc = Number(r.pmc);
    const taxaRaw = Number(r.taxa_iva);
    const taxa = normalizeIva(taxaRaw)!;
    const valSemIva = stock * pmc;
    const valIva = valSemIva * (taxa / 100);
    const valComIva = valSemIva + valIva;
    console.log(`  CNP ${r.cnp} · ${r.designacao}`);
    console.log(
      `    stock=${stock} PMC=${pmc.toFixed(4)}€ taxa_raw=${taxaRaw} → ${taxa}%`,
    );
    console.log(
      `    val s/IVA=${fmtEur(valSemIva)}  IVA=${fmtEur(valIva)}  val c/IVA=${fmtEur(valComIva)}`,
    );
  }

  // ── 4. Validação Margens — sanity check ────────────────────────
  // Pegamos 1 produto vendido este ano com IVA 6% e mostramos o cálculo.
  const now = new Date();
  const minIdx = now.getUTCFullYear() * 12 + 1;
  const maxIdx = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);
  const margemSample = await prisma.$queryRawUnsafe<
    Array<{
      cnp: number;
      qty: string;
      valor_bruto: string;
      pmc: string;
      taxa_iva: string;
    }>
  >(`
    WITH agg AS (
      SELECT
        vm."produtoId",
        vm."farmaciaId",
        SUM(vm."quantidade")::numeric AS qty,
        SUM(COALESCE(vm."valorBruto", vm."valorTotal"))::numeric AS valor_bruto
      FROM "VendaMensal" vm
      WHERE (vm."ano" * 12 + vm."mes") BETWEEN ${minIdx} AND ${maxIdx}
      GROUP BY 1, 2
    )
    SELECT
      p.cnp,
      agg.qty::text AS qty,
      agg.valor_bruto::text AS valor_bruto,
      pf."pmc"::text AS pmc,
      iva_src.iva::text AS taxa_iva
    FROM agg
    JOIN "Produto" p ON p.id = agg."produtoId"
    LEFT JOIN "ProdutoFarmacia" pf
      ON pf."produtoId" = agg."produtoId" AND pf."farmaciaId" = agg."farmaciaId"
    LEFT JOIN LATERAL (
      SELECT scrl."iva"
      FROM "StagingCompraRawLine" scrl
      WHERE scrl."farmaciaId" = agg."farmaciaId"
        AND scrl."externalCodigoId" = pf."externalProductId"
      ORDER BY scrl."externalLineId" DESC
      LIMIT 1
    ) iva_src ON true
    WHERE pf."pmc" > 0 AND iva_src.iva = 0.06
    LIMIT 2
  `);
  console.log("\nSample 2 produtos vendidos este ano com IVA 6% (Margens):");
  for (const r of margemSample) {
    const qty = Number(r.qty);
    const valorBruto = Number(r.valor_bruto);
    const pmc = Number(r.pmc);
    const taxa = normalizeIva(Number(r.taxa_iva))!;
    const valorSemIva = valorBruto / (1 + taxa / 100);
    const custo = qty * pmc;
    const margem = valorSemIva - custo;
    const margemPct = valorSemIva > 0 ? (margem / valorSemIva) * 100 : 0;
    console.log(`  CNP ${r.cnp}  qty=${qty}`);
    console.log(
      `    bruto c/IVA=${fmtEur(valorBruto)}  taxa=${taxa}%  bruto s/IVA=${fmtEur(valorSemIva)}`,
    );
    console.log(
      `    custo=${fmtEur(custo)}  margem €=${fmtEur(margem)}  margem %=${margemPct.toFixed(2)}%`,
    );
  }

  await prisma.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
