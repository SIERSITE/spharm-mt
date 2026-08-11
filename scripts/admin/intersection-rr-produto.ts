import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
async function main() {
  const slug = process.argv[2] ?? "grupo-silveira";
  const p = await getTenantPrismaOrLegacy(slug);

  const rows = await p.$queryRaw<{ label: string; count: bigint }[]>`
    WITH med AS (
      SELECT "cnp", "codigoATC", "dci"
      FROM "Produto"
      WHERE "productType" = 'MEDICAMENTO' AND "estado" != 'INATIVO' AND "cnp" > 2000000
    )
    SELECT 'Total medicamentos vivos' AS label, COUNT(*)::bigint AS count FROM med
    UNION ALL
    SELECT 'Com CNP em RegulatoryRecord', COUNT(*)::bigint
      FROM med m INNER JOIN "RegulatoryRecord" r ON r.cnp = m.cnp
    UNION ALL
    SELECT 'Com CNP em RR + ATC', COUNT(*)::bigint
      FROM med m INNER JOIN "RegulatoryRecord" r ON r.cnp = m.cnp
      WHERE r."codigoATC" IS NOT NULL
    UNION ALL
    SELECT 'Sem CNP em RR (missing snapshot)', COUNT(*)::bigint
      FROM med m LEFT JOIN "RegulatoryRecord" r ON r.cnp = m.cnp
      WHERE r.cnp IS NULL
    UNION ALL
    SELECT 'Sem ATC em Produto mas ATC em RR (sync pendente)', COUNT(*)::bigint
      FROM med m INNER JOIN "RegulatoryRecord" r ON r.cnp = m.cnp
      WHERE m."codigoATC" IS NULL AND r."codigoATC" IS NOT NULL
  `;
  console.log(`\nIntersecção Produto ↔ RegulatoryRecord em ${slug}:\n`);
  for (const r of rows) console.log(`  ${r.label.padEnd(52)} ${String(r.count).padStart(6)}`);
  console.log();
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
