/**
 * scripts/admin/import-regulatory-record-from-legacy.ts
 * Copia RegulatoryRecord de neondb (legacy) para a BD dum tenant, em batches.
 * Preserva o existente (skip-on-conflict).
 * Uso: npx tsx --env-file=.env --env-file=.env.local scripts/admin/import-regulatory-record-from-legacy.ts grupo-silveira [--dry-run]
 */
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";

const BATCH = 500;

async function main() {
  const slug = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!slug) {
    console.error("Uso: import-regulatory-record-from-legacy.ts <tenantSlug> [--dry-run]");
    process.exit(2);
  }

  const legacyUrl = process.env.DATABASE_URL;
  if (!legacyUrl) throw new Error("DATABASE_URL em falta.");
  const legacy = new PrismaClient({ adapter: new PrismaPg({ connectionString: legacyUrl }) });
  const tenant = await getTenantPrismaOrLegacy(slug);

  const legacyTotal = await legacy.regulatoryRecord.count();
  const tenantBefore = await tenant.regulatoryRecord.count();
  console.log(`\n═══ Import RegulatoryRecord → tenant=${slug} ${dryRun ? "(DRY-RUN)" : ""} ═══`);
  console.log(`  Legacy total:   ${legacyTotal}`);
  console.log(`  Tenant before:  ${tenantBefore}`);

  // Só copia os que interessam ao pipeline — com pelo menos 1 campo clínico
  // útil, filtrando lixo. Escolha explícita.
  const source = await legacy.regulatoryRecord.findMany({
    where: {
      OR: [
        { codigoATC: { not: null } },
        { dci: { not: null } },
        { formaFarmaceutica: { not: null } },
        { dosagem: { not: null } },
        { embalagem: { not: null } },
      ],
    },
    orderBy: { cnp: "asc" },
  });
  console.log(`  Legacy útil (≥1 campo clínico): ${source.length}`);

  // CNPs que já existem no tenant — para skip
  const existingRows = await tenant.regulatoryRecord.findMany({ select: { cnp: true } });
  const existing = new Set(existingRows.map((r) => r.cnp));
  const toInsert = source.filter((r) => !existing.has(r.cnp));
  console.log(`  A inserir (não colidem): ${toInsert.length}`);

  if (dryRun) {
    console.log("\nDRY-RUN — nenhuma escrita. Fim.");
    await legacy.$disconnect();
    return;
  }

  let inserted = 0;
  let failed = 0;
  const t0 = Date.now();
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const chunk = toInsert.slice(i, i + BATCH);
    const rows = chunk.map((r) => ({
      cnp: r.cnp,
      designacaoOficial: r.designacaoOficial,
      dci: r.dci,
      codigoATC: r.codigoATC,
      formaFarmaceutica: r.formaFarmaceutica,
      dosagem: r.dosagem,
      embalagem: r.embalagem,
      grupoTerapeutico: r.grupoTerapeutico,
      titularAim: r.titularAim,
      estadoAim: r.estadoAim,
      source: `imported_from_neondb_${new Date().toISOString().slice(0, 10)}`,
    }));
    try {
      const res = await tenant.regulatoryRecord.createMany({ data: rows, skipDuplicates: true });
      inserted += res.count;
    } catch (err) {
      failed += chunk.length;
      console.error(`  batch ${i}: erro`, err instanceof Error ? err.message : err);
    }
    if (i % (BATCH * 10) === 0) {
      process.stdout.write(`  ...${i + chunk.length}/${toInsert.length}  inserted=${inserted}  failed=${failed}\r`);
    }
  }
  console.log(`\n\nInseridos: ${inserted}   Falhados: ${failed}   Duração: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const tenantAfter = await tenant.regulatoryRecord.count();
  const atcAfter = await tenant.regulatoryRecord.count({ where: { codigoATC: { not: null } } });
  console.log(`  Tenant after: total=${tenantAfter}  com ATC=${atcAfter}`);
  await legacy.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
