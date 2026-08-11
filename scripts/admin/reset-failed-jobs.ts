/**
 * scripts/admin/reset-failed-jobs.ts — reset jobs FAILED para PENDING
 * (útil após importar snapshot que agora cobre CNPs que antes falhavam).
 */
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";

async function main() {
  const slug = process.argv[2] ?? "grupo-silveira";
  const p = await getTenantPrismaOrLegacy(slug);
  const res = await p.regulatoryAcquisitionJob.updateMany({
    where: { status: "FAILED" },
    data: { status: "PENDING", nextAttemptAt: new Date(), attempts: 0, lastError: null },
  });
  console.log(`Reset FAILED → PENDING para ${slug}: ${res.count} jobs`);
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
