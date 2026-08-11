/**
 * scripts/admin/sweep-flag-retirado.ts
 *
 * Reconciliação one-shot de `ProdutoFarmacia.flagRetirado` num tenant
 * existente, sem precisar de re-correr `products-upload` no agent.
 *
 * Modelo canónico (fecho 2026-06): produtos que existem em
 * `ProdutoFarmacia` mas que o ERP **já não envia** devem ficar com
 * `flagRetirado=true`.
 *
 * Critério conservador aplicado por farmácia:
 *
 *   `flagRetirado = false AND taxaIvaSource IS NULL`
 *
 * São linhas que:
 *   · existem em ProdutoFarmacia (resíduo histórico),
 *   · nunca foram cobertas por STOCKS_MESTRE (último products-upload
 *     não as enviou — não passaram o filtro `Retirado=0 AND
 *     Processa_Stocks<>0` no ERP),
 *   · não têm rastro em StagingCompraRawLine (caso contrário teriam
 *     `taxaIvaSource='STAGING_COMPRA'`),
 *   · não têm rastro em StagingDevolucaoFornecedorRawLine,
 *   · não têm rastro em IngestVendaLinhaRaw com IVA derivável.
 *
 * O critério propositadamente **não usa** uma janela temporal: PF com
 * `taxaIvaSource='STAGING_COMPRA'/'STAGING_DEVOLUCAO'` (mesmo que
 * "antigas") têm rastro transaccional e ficam intocadas. Estas serão
 * reactivadas naturalmente no próximo `products-upload` que as cubra
 * (UPSERT no endpoint repõe `flagRetirado=false`) ou ficam como
 * candidatos legítimos a próxima corrida.
 *
 * Modo `--dry-run` (default) preview; `--apply` aplica.
 *
 * Idempotente. Re-correr não duplica nem reverte produtos que voltaram
 * ao ERP (esses serão reactivados pelo próximo `products-upload`).
 *
 * Em corridas futuras do products-upload, o agent chama
 * `POST /bootstrap/products/finalize` com `runStartedAt` capturado no
 * início. Esse endpoint usa critério temporal (`dataAtualizacao <
 * runStartedAt`) — mais preciso porque o agent garante que **todas** as
 * linhas válidas foram tocadas na corrida. Este script é necessário
 * apenas para reconciliar tenants em que ainda não correu uma corrida
 * com finalize.
 *
 * Usage:
 *   npx tsx scripts/admin/sweep-flag-retirado.ts --slug=grupo-silveira
 *   npx tsx scripts/admin/sweep-flag-retirado.ts --slug=grupo-silveira --apply
 *   npx tsx scripts/admin/sweep-flag-retirado.ts --slug=grupo-silveira --farmacia="Farmácia Silveirense" --apply
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import {
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

type FarmaciaStat = {
  id: string;
  nome: string;
  candidatos: number;
  jaRetirados: number;
  total: number;
};

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      farmacia: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const slug = values.slug ?? "grupo-silveira";
  const apply = values.apply ?? false;
  const farmaciaFilter = values.farmacia;

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`tenant ${slug} not found`);
    process.exit(1);
  }
  process.env.DATABASE_URL = buildTenantConnectionString(tenant);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  console.log(`\n=== Sweep flagRetirado — tenant ${slug} ${apply ? "(APPLY)" : "(DRY-RUN)"} ===\n`);

  const farmaciasWhere: Prisma.FarmaciaWhereInput = {
    estado: "ATIVO",
    ...(farmaciaFilter ? { nome: farmaciaFilter } : {}),
  };
  const farmacias = await prisma.farmacia.findMany({
    where: farmaciasWhere,
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });

  if (farmacias.length === 0) {
    console.log(
      farmaciaFilter
        ? `Nenhuma farmácia activa com nome="${farmaciaFilter}" no tenant.`
        : "Nenhuma farmácia activa no tenant.",
    );
    await prisma.$disconnect();
    return;
  }

  const stats: FarmaciaStat[] = [];

  for (const farm of farmacias) {
    // Critério canónico: `taxaIvaSource IS NULL` — não tem rastro em
    // nenhuma das 4 fontes (STOCKS_MESTRE / STAGING_COMPRA /
    // STAGING_DEVOLUCAO / VENDA_DERIVADA). Estes são os zumbis puros.
    const counts = await prisma.$queryRaw<
      Array<{ total: bigint; ja_retirados: bigint; candidatos: bigint }>
    >`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE "flagRetirado" = true)::bigint AS ja_retirados,
        COUNT(*) FILTER (
          WHERE "flagRetirado" = false
            AND "taxaIvaSource" IS NULL
        )::bigint AS candidatos
      FROM "ProdutoFarmacia"
      WHERE "farmaciaId" = ${farm.id}
    `;
    const c = counts[0];

    stats.push({
      id: farm.id,
      nome: farm.nome,
      candidatos: Number(c.candidatos),
      jaRetirados: Number(c.ja_retirados),
      total: Number(c.total),
    });
  }

  // ── Render preview ──────────────────────────────────────────────
  console.log("Farmácia                       | total PF | já retirados | candidatos");
  console.log("-".repeat(80));
  for (const s of stats) {
    console.log(
      `${s.nome.padEnd(30)} | ${String(s.total).padStart(8)} | ${String(s.jaRetirados).padStart(12)} | ${String(s.candidatos).padStart(10)}`,
    );
  }
  const totalCandidatos = stats.reduce((s, x) => s + x.candidatos, 0);
  console.log("-".repeat(80));
  console.log(`TOTAL candidatos: ${totalCandidatos}`);

  if (!apply) {
    console.log("\nDry-run — nenhuma mudança aplicada. Re-corre com --apply para escrever.");
    await prisma.$disconnect();
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────
  console.log("\n▶ A aplicar UPDATEs…\n");
  let appliedTotal = 0;
  for (const s of stats) {
    if (s.candidatos === 0) continue;
    const result = await prisma.$executeRaw(Prisma.sql`
      UPDATE "ProdutoFarmacia"
      SET "flagRetirado" = true,
          "dataAtualizacao" = NOW()
      WHERE "farmaciaId" = ${s.id}
        AND "flagRetirado" = false
        AND "taxaIvaSource" IS NULL
    `);
    const n = Number(result) || 0;
    appliedTotal += n;
    console.log(`  ${s.nome.padEnd(30)}  ${String(n).padStart(7)} linhas → flagRetirado=true`);
  }
  console.log(`\n✓ Aplicado em ${appliedTotal} linha(s) ProdutoFarmacia.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
