/**
 * scripts/list-orphan-products.ts
 *
 * Lista `externalProductId` órfãos (sem `produtoId` resolvido) em
 * `IngestVendaLinhaRaw` para um tenant. Pretende auxiliar diagnose
 * antes de decidir `--allow-orphans` na agregação.
 *
 * Uso:
 *   npm run ingest:list-orphans -- --tenant demo-neon
 *   npm run ingest:list-orphans -- --tenant demo-neon --month 2024-04
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

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      month: { type: "string" },
    },
    strict: true,
  });
  if (!values.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }

  let monthFilter: { from: Date; to: Date } | null = null;
  if (values.month) {
    const m = /^(\d{4})-(\d{2})$/.exec(values.month);
    if (!m) {
      console.error(`✗ --month deve ser YYYY-MM (ex: 2024-04). Recebido: ${values.month}`);
      process.exit(1);
    }
    const ano = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10);
    monthFilter = {
      from: new Date(Date.UTC(ano, mes - 1, 1)),
      to: new Date(Date.UTC(ano, mes, 1)),
    };
  }

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe.`);
    process.exit(1);
  }

  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log(`─ tenant: ${values.tenant}${monthFilter ? ` · month: ${values.month}` : " · (todos os meses)"}`);
    console.log("");

    const rows = monthFilter
      ? await prisma.$queryRaw<
          Array<{
            externalProductId: number;
            rows_count: bigint | number;
            primeira_venda: Date | null;
            ultima_venda: Date | null;
            classes: string;
          }>
        >`
          SELECT
            "externalProductId",
            COUNT(*)                                       AS rows_count,
            MIN("dataVenda")                               AS primeira_venda,
            MAX("dataVenda")                               AS ultima_venda,
            STRING_AGG(DISTINCT "tipoDocumentoClass", ',') AS classes
          FROM "IngestVendaLinhaRaw"
          WHERE "produtoId" IS NULL
            AND "dataVenda" >= ${monthFilter.from}
            AND "dataVenda" <  ${monthFilter.to}
          GROUP BY "externalProductId"
          ORDER BY COUNT(*) DESC, "externalProductId"
        `
      : await prisma.$queryRaw<
          Array<{
            externalProductId: number;
            rows_count: bigint | number;
            primeira_venda: Date | null;
            ultima_venda: Date | null;
            classes: string;
          }>
        >`
          SELECT
            "externalProductId",
            COUNT(*)                                       AS rows_count,
            MIN("dataVenda")                               AS primeira_venda,
            MAX("dataVenda")                               AS ultima_venda,
            STRING_AGG(DISTINCT "tipoDocumentoClass", ',') AS classes
          FROM "IngestVendaLinhaRaw"
          WHERE "produtoId" IS NULL
          GROUP BY "externalProductId"
          ORDER BY COUNT(*) DESC, "externalProductId"
        `;

    if (rows.length === 0) {
      console.log("Sem órfãos — todos os externalProductId resolvem para Produto.id.");
      return;
    }

    console.log(`${rows.length} externalProductId órfãos:`);
    console.log("");
    console.log("  externalProductId  rows  primeira_venda          ultima_venda            classes");
    console.log("  " + "─".repeat(95));
    for (const r of rows) {
      const id = String(r.externalProductId).padStart(17);
      const cnt = String(Number(r.rows_count)).padStart(4);
      const first = (r.primeira_venda?.toISOString().slice(0, 19) ?? "null").padEnd(22);
      const last = (r.ultima_venda?.toISOString().slice(0, 19) ?? "null").padEnd(22);
      console.log(`  ${id}  ${cnt}  ${first}  ${last}  ${r.classes}`);
    }

    console.log("");
    console.log("Próximo passo (no PC da farmácia, agent rev11+):");
    console.log(
      `  run-inspect-codigoid.bat → cola: ${rows.map((r) => r.externalProductId).join(",")}`
    );
    console.log("");
    console.log("Ou via cmd directo:");
    console.log(
      `  node.exe agent.cjs inspect-codigoid --ids ${rows.map((r) => r.externalProductId).join(",")}`
    );
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
