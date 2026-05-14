/**
 * scripts/backfill-non-stock-services.ts
 *
 * Marca rows existentes em `IngestVendaLinhaRaw` como
 * `isNonStockService = true` para um conjunto de `externalProductId`
 * (CodigoID Softreis) confirmados como serviços/taxas sem produto
 * operacional.
 *
 * Uso típico (após `inspect-codigoid` confirmar que são serviços):
 *
 *   npm run ingest:backfill-services -- \
 *     --tenant demo-neon \
 *     --ids 35023,12551,34972,34993,38555 \
 *     --write
 *
 * Default sem `--write` é dry-run: mostra quantas rows seriam afectadas
 * sem alterar. `--write` confirma o UPDATE.
 *
 * Apenas afecta rows com `produtoId IS NULL` (o lookup ao Produto falhou).
 * Rows com `produtoId` definido não são tocadas — isso é uma situação
 * inconsistente que pede investigação separada.
 *
 * Idempotente: re-run com a mesma lista produz 0 rows alteradas (já
 * marcadas). Não fala em alterações de schema — só `UPDATE`.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function parseIds(raw: string): number[] {
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) throw new Error("--ids está vazio");
  if (parts.length > 500) throw new Error(`--ids tem ${parts.length} valores; máximo 500`);
  const ids: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) throw new Error(`--ids contém valor não-inteiro: "${p}"`);
    const n = parseInt(p, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--ids contém valor inválido: "${p}"`);
    ids.push(n);
  }
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      ids: { type: "string" },
      write: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }
  if (!values.ids) {
    console.error("✗ --ids <CSV de CodigoIDs> obrigatório.");
    process.exit(1);
  }
  const ids = parseIds(values.ids);
  const mode: "dry-run" | "write" = values.write ? "write" : "dry-run";

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant "${values.tenant}" em estado ${tenant.estado}. Aborta.`);
    process.exit(1);
  }

  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log("─".repeat(70));
    console.log(`backfill-non-stock-services — ${values.tenant} · ${mode.toUpperCase()}`);
    console.log("─".repeat(70));
    console.log(`IDs (${ids.length}): ${ids.join(", ")}`);
    console.log("");

    // Diagnose: quantas rows estão a apontar para cada ID
    const breakdown = await prisma.ingestVendaLinhaRaw.groupBy({
      by: ["externalProductId", "isNonStockService", "produtoId"],
      where: { externalProductId: { in: ids } },
      _count: { _all: true },
    });

    const byId = new Map<number, { withProduto: number; orphanService: number; orphanNotService: number }>();
    for (const id of ids) byId.set(id, { withProduto: 0, orphanService: 0, orphanNotService: 0 });
    for (const r of breakdown) {
      const slot = byId.get(r.externalProductId)!;
      if (r.produtoId !== null) slot.withProduto += r._count._all;
      else if (r.isNonStockService) slot.orphanService += r._count._all;
      else slot.orphanNotService += r._count._all;
    }

    console.log("Breakdown por externalProductId:");
    console.log("  extId    com_produto  já_marcado_service  por_marcar");
    console.log("  " + "─".repeat(60));
    let candidatesTotal = 0;
    for (const id of ids) {
      const s = byId.get(id)!;
      candidatesTotal += s.orphanNotService;
      console.log(
        `  ${String(id).padStart(7)}  ${String(s.withProduto).padStart(11)}  ${String(s.orphanService).padStart(18)}  ${String(s.orphanNotService).padStart(10)}${s.withProduto > 0 ? "  ⚠ tem produto resolvido (não afectado)" : ""}`
      );
    }
    console.log("");
    console.log(`Rows candidatas a marcar (produtoId IS NULL E isNonStockService=false): ${candidatesTotal}`);
    console.log("");

    if (candidatesTotal === 0) {
      console.log("✓ Nada a fazer.");
      await prisma.$disconnect();
      return;
    }

    if (mode === "dry-run") {
      console.log("─".repeat(70));
      console.log("DRY-RUN — nada alterado. Para aplicar:");
      console.log(`  npm run ingest:backfill-services -- --tenant ${values.tenant} --ids ${ids.join(",")} --write`);
      await prisma.$disconnect();
      return;
    }

    // WRITE: UPDATE scoped — apenas orphans não-marcados.
    const r = await prisma.ingestVendaLinhaRaw.updateMany({
      where: {
        externalProductId: { in: ids },
        produtoId: null,
        isNonStockService: false,
      },
      data: { isNonStockService: true },
    });

    console.log("─".repeat(70));
    console.log(`✓ WRITE concluído. Rows actualizadas: ${r.count}`);
    console.log("");
    console.log("Próximo passo: re-correr `npm run aggregate:vendamensal` para verificar");
    console.log("que `operationalOrphans` baixou e `nonStockServices` subiu.");
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
