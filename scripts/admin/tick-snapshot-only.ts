import { runAcquisitionTick } from "@/lib/jobs/regulatory-acquisition";
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
async function main() {
  const slug = process.argv[2] ?? "grupo-silveira";
  const jobs = parseInt(process.argv[3] ?? "20", 10);
  const p = await getTenantPrismaOrLegacy(slug);
  const t0 = Date.now();
  const s = await runAcquisitionTick({
    prisma: p, maxJobs: jobs, maxDurationMs: 300_000, skipInfomedHttp: true,
  });
  console.log(`SNAPSHOT-ONLY tick — ${jobs} jobs, sem HTTP:`);
  console.log(`  duração:    ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  processed:  ${s.processed}`);
  console.log(`  done:       ${s.outcomes.done}`);
  console.log(`  partial:    ${s.outcomes.partial}`);
  console.log(`  failed:     ${s.outcomes.failed}`);
  console.log(`  snapshotHits:   ${s.bySource.snapshotHits}`);
  console.log(`  snapshotMisses: ${s.bySource.snapshotMisses}`);
  console.log(`  produtoFieldsFilled: ${s.produtoUpdates.fieldsFilled}`);
  console.log(`  rrUpserts:  ${s.regulatoryRecordUpserts}`);
  console.log(`  taxa match: ${s.processed ? (((s.outcomes.done + s.outcomes.partial) / s.processed) * 100).toFixed(1) : "0.0"}%`);
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
