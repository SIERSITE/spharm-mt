import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
import { runEnrichCycle } from "@/lib/jobs/enrich-catalog";
async function main() {
  const slug = process.argv[2] ?? "grupo-silveira";
  const p = await getTenantPrismaOrLegacy(slug);
  const t0 = Date.now();
  const s = await runEnrichCycle({ prisma: p, syncLimit: 10_000, reclassifyLimit: 5_000 });
  console.log(`enrich-catalog para ${slug} — ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`  sync:      updated=${s.sync.updated}  errors=${s.sync.errors}`);
  console.log(`  reclassify: updated=${s.reclassify.updated}  errors=${s.reclassify.errors}`);
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
